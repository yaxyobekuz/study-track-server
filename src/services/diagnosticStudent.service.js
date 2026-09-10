/**
 * DIAGNOSTIKA — O'QUVCHI KESIMI (boshqaruv paneli va zaif mavzular).
 *
 * ⚠️ BU FAYL BITTA O'QUVCHI HAQIDA. Registr kesimlari (sinf, fan, davr)
 * `diagnosticAnalytics.service.js` da — ikkalasi aralashtirilmaydi:
 * u yerda "kim orqada qolyapti", bu yerda "men nimani bilmayman".
 *
 * ⚠️ FAN VA MAVZU KESIMI JAVOB QATORLARIDAN HISOBLANADI, urinishning
 * `subjectId` sidan EMAS. Aralash test bitta "Aralash" qatorga tushib
 * qolsa, o'quvchi "ingliz tilidan qanday ketyapman" degan savolga javob
 * ololmasdi. Har savol o'z fanini va mavzusini SURAT sifatida olib
 * yuradi (`DiagnosticAttemptQuestion.subjectName/topicName`), shuning
 * uchun mavzu keyin o'chirilsa ham kesim buzilmaydi.
 *
 * ⚠️ MAXRAJ — JAVOB BERILGAN SAVOLLAR. Tashlab ketilgan savol na
 * "to'g'ri", na "xato": uni maxrajga qo'shish mavzuni bilgan-u vaqt
 * yetmagan o'quvchini "bilmaydi" deb belgilardi. Urinishning UMUMIY
 * balli esa aksincha — tashlab ketilganini ham hisoblaydi (u
 * o'zlashtirishni emas, TESTNI o'lchaydi). Ikki maxraj ataylab har xil
 * va bu farq shu yerda hujjatlashtirilgan.
 */

const prisma = require("../config/prisma");
const {
  classifyScore,
  gradeLabel,
  diagnosisTone,
  calcAverage,
  growthPoints,
} = require("../helpers/diagnostic.helpers");
const { getDiagnosticSettings } = require("./settings.service");
const { NotFoundError } = require("../utils/errors");

/** Yakunlangan urinishlar — kesimga faqat shular kiradi. */
const DONE_STATUSES = ["submitted", "evaluated", "expired"];

/**
 * ⚠️ CHEKLOV MAJBURIY. Javob qatorlari urinishlar soniga ko'paytiriladi:
 * 3 yillik tarixi bor o'quvchida bu minglab qator bo'lardi va panel
 * ochilishi sekinlashardi. Oxirgi 50 urinish o'zlashtirish manzarasini
 * to'liq beradi.
 */
const ATTEMPT_WINDOW = 50;

/** Bo'sh javob — "bilmadim" emas, "yetib bormadi". */
const scoreOf = (acc) =>
  acc.answered > 0 ? Math.round((acc.correct / acc.answered) * 1000) / 10 : null;

/**
 * O'quvchining yakunlangan urinishlari + o'sha urinishlarning javoblari.
 * Ikkala kesim ham shundan chiqadi, shuning uchun ular BIR XIL to'plamni
 * ko'radi (alohida so'rovlarda oraliq farq qilib qolardi).
 */
async function _load(studentId) {
  const attempts = await prisma.diagnosticAttempt.findMany({
    where: { studentId, status: { in: DONE_STATUSES } },
    orderBy: { submittedAt: "desc" },
    take: ATTEMPT_WINDOW,
    select: {
      id: true,
      subjectId: true,
      score: true,
      accuracy: true,
      grade: true,
      totalQuestions: true,
      correctCount: true,
      timeSpentSec: true,
      submittedAt: true,
    },
  });

  const answers = attempts.length
    ? await prisma.diagnosticAnswer.findMany({
        where: { attemptId: { in: attempts.map((a) => a.id) } },
        select: {
          attemptId: true,
          isCorrect: true,
          isSkipped: true,
          attemptQuestion: {
            select: {
              subjectId: true,
              subjectName: true,
              topicId: true,
              topicName: true,
            },
          },
        },
      })
    : [];

  // Eng eskisidan eng yangisiga — o'sish shu tartibda o'qiladi.
  return { attempts: attempts.reverse(), answers };
}

/** Fan va mavzu bo'yicha yig'ma. */
function _aggregate(answers) {
  const subjects = new Map();
  const topics = new Map();

  for (const row of answers) {
    const q = row.attemptQuestion;
    if (!q) continue;

    const subjectKey = q.subjectId || `name:${q.subjectName || "Umumiy"}`;
    const subjectName = q.subjectName || "Umumiy";

    const subject = subjects.get(subjectKey) || {
      subjectId: q.subjectId || null,
      subject: subjectName,
      correct: 0,
      answered: 0,
      total: 0,
      attempts: new Set(),
    };
    subject.total += 1;
    subject.attempts.add(row.attemptId);
    if (!row.isSkipped) {
      subject.answered += 1;
      if (row.isCorrect) subject.correct += 1;
    }
    subjects.set(subjectKey, subject);

    // ⚠️ MAVZU KALITI FAN BILAN BIRGA. "Grammatika" ingliz tilida ham,
    // rus tilida ham bo'lishi mumkin — bitta kalitda ikkalasi qo'shilib
    // ketardi.
    const topicKey = `${subjectKey}::${q.topicId || `name:${q.topicName || "Umumiy"}`}`;
    const topic = topics.get(topicKey) || {
      topicId: q.topicId || null,
      topic: q.topicName || "Umumiy",
      subjectId: q.subjectId || null,
      subject: subjectName,
      subjectKey,
      correct: 0,
      answered: 0,
      total: 0,
    };
    topic.total += 1;
    if (!row.isSkipped) {
      topic.answered += 1;
      if (row.isCorrect) topic.correct += 1;
    }
    topics.set(topicKey, topic);
  }

  return { subjects, topics };
}

/**
 * Fan bo'yicha o'sish — o'sha fanning urinishlari ikkiga bo'linadi va
 * ikkinchi yarmi birinchisi bilan taqqoslanadi.
 *
 * ⚠️ ARALASH TESTLAR HAM HISOBGA OLINADI. Tayyor loyihada o'sish faqat
 * `attempt.subject` bo'yicha o'qilardi — ya'ni faqat aralash test
 * ishlagan o'quvchida HAR BIR fanda "—" turardi. Bu yerda urinish
 * o'sha fanning savollariga ega bo'lsa hisobga kiradi, ball esa o'sha
 * urinishdagi SHU FAN javoblaridan chiqadi.
 */
function _subjectGrowth(attempts, answers) {
  const perAttempt = new Map();
  for (const row of answers) {
    const q = row.attemptQuestion;
    if (!q) continue;
    const key = `${row.attemptId}::${q.subjectId || `name:${q.subjectName || "Umumiy"}`}`;
    const entry = perAttempt.get(key) || { correct: 0, answered: 0 };
    if (!row.isSkipped) {
      entry.answered += 1;
      if (row.isCorrect) entry.correct += 1;
    }
    perAttempt.set(key, entry);
  }

  const order = new Map(attempts.map((a, i) => [a.id, i]));
  const series = new Map();
  for (const [key, entry] of perAttempt) {
    const [attemptId, subjectKey] = key.split("::");
    const score = scoreOf(entry);
    if (score == null) continue;
    const list = series.get(subjectKey) || [];
    list.push({ order: order.get(attemptId) ?? 0, score });
    series.set(subjectKey, list);
  }

  const growth = new Map();
  for (const [subjectKey, list] of series) {
    if (list.length < 2) {
      growth.set(subjectKey, null);
      continue;
    }
    list.sort((a, b) => a.order - b.order);
    const half = Math.floor(list.length / 2);
    growth.set(
      subjectKey,
      growthPoints(
        calcAverage(list.slice(half).map((x) => x.score)),
        calcAverage(list.slice(0, half).map((x) => x.score)),
      ),
    );
  }
  return growth;
}

/**
 * O'quvchining diagnostika boshqaruv paneli.
 *
 * Bitta chaqiruv — butun ekran: tavsiya, fanlar kartalari, kuchli va
 * zaif mavzular, o'sish chizig'i. Bo'laklarga bo'linsa har biri boshqa
 * oraliqni ko'rib, ekranda bir-biriga zid raqamlar turardi.
 */
async function getDashboard(studentId) {
  const settings = await getDiagnosticSettings();

  const student = await prisma.user.findFirst({
    where: { id: studentId, role: "student" },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      classes: { include: { class: { select: { id: true, name: true } } } },
    },
  });
  if (!student) throw new NotFoundError("O'quvchi topilmadi");

  const { attempts, answers } = await _load(studentId);
  const { subjects, topics } = _aggregate(answers);
  const growth = _subjectGrowth(attempts, answers);

  const scored = attempts.filter((a) => a.score != null);
  const scores = scored.map((a) => a.score);
  const average = calcAverage(scores);

  const topicList = [...topics.values()]
    .map((t) => ({
      topicId: t.topicId,
      topic: t.topic,
      subjectId: t.subjectId,
      subject: t.subject,
      subjectKey: t.subjectKey,
      questions: t.total,
      correct: t.correct,
      score: scoreOf(t),
    }))
    .filter((t) => t.score != null);

  // ⚠️ YAGONA CHEGARA (`goodScore`, sukut bo'yicha 70): mavzu YO kuchli,
  // YO zaif. Ikki xil chegara qo'yilsa oraliqdagi mavzular ikkala
  // ro'yxatdan ham tushib qolardi va o'quvchi "mavzularim qayerda?" deb
  // qolardi.
  const strongTopics = topicList
    .filter((t) => t.score >= settings.goodScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((t) => ({ ...t, subjectKey: undefined, tone: diagnosisTone(t.score) }));

  const weakTopics = topicList
    .filter((t) => t.score < settings.goodScore)
    .sort((a, b) => a.score - b.score)
    .slice(0, 5)
    .map((t) => ({ ...t, subjectKey: undefined, tone: diagnosisTone(t.score) }));

  const subjectList = [...subjects.entries()]
    .map(([key, s]) => {
      const score = scoreOf(s);
      const own = topicList.filter((t) => t.subjectKey === key);
      return {
        subjectId: s.subjectId,
        subject: s.subject,
        tests: s.attempts.size,
        questions: s.total,
        correct: s.correct,
        answered: s.answered,
        averageScore: score,
        grade:
          score != null
            ? classifyScore(score, settings.goodScore, settings.mediumScore)
            : null,
        gradeLabel:
          score != null
            ? gradeLabel(classifyScore(score, settings.goodScore, settings.mediumScore))
            : "—",
        growth: growth.get(key) ?? null,
        strongTopics: own
          .filter((t) => t.score >= settings.goodScore)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map((t) => ({ topicId: t.topicId, topic: t.topic, score: t.score })),
        weakTopics: own
          .filter((t) => t.score < settings.goodScore)
          .sort((a, b) => a.score - b.score)
          .slice(0, 3)
          .map((t) => ({ topicId: t.topicId, topic: t.topic, score: t.score })),
      };
    })
    .sort((a, b) => (a.averageScore ?? 101) - (b.averageScore ?? 101));

  const worstSubject = subjectList.find((s) => s.averageScore != null) || null;
  const bestSubject =
    [...subjectList].reverse().find((s) => s.averageScore != null) || null;

  // ⚠️ "AI TAVSIYASI" — QOIDADAN CHIQQAN MATN, model chaqiruvi EMAS.
  // Har panel ochilganda pullik so'rov yuborish mumkin emas; matn esa
  // haqiqiy raqamlarga tayanadi, ya'ni o'quvchiga yolg'on aytmaydi.
  // Urinishning AI tahlili (`insights`) natija sahifasida alohida bor.
  const worstTopic = weakTopics[0] || null;
  const recommendation = worstTopic
    ? {
        text: `So'nggi testlaringizda ${worstTopic.subject} — "${worstTopic.topic}" mavzusida natijangiz ${Math.round(worstTopic.score)}%. Shu mavzuni mustahkamlash uchun qisqa mashq tavsiya qilamiz.`,
        subjectId: worstTopic.subjectId,
        subject: worstTopic.subject,
        topicId: worstTopic.topicId,
        topic: worstTopic.topic,
      }
    : attempts.length === 0
      ? {
          text: "Birinchi diagnostikani topshiring — shundan keyin bu yerda sizga moslangan tavsiya paydo bo'ladi.",
          subjectId: null,
          subject: null,
          topicId: null,
          topic: null,
        }
      : {
          text: "Ajoyib! Barcha mavzularda natijangiz yaxshi. Qiyinroq savollar bilan bilimingizni sinab ko'ring.",
          subjectId: null,
          subject: null,
          topicId: null,
          topic: null,
        };

  return {
    student: {
      id: student.id,
      firstName: student.firstName,
      lastName: student.lastName,
      classes: student.classes.map((uc) => uc.class),
    },
    summary: {
      attempts: attempts.length,
      averageScore: average,
      grade:
        average != null
          ? classifyScore(average, settings.goodScore, settings.mediumScore)
          : null,
      gradeLabel:
        average != null
          ? gradeLabel(classifyScore(average, settings.goodScore, settings.mediumScore))
          : "—",
      lastScore: scored.length ? scored[scored.length - 1].score : null,
      bestScore: scores.length ? Math.max(...scores) : null,
      worstScore: scores.length ? Math.min(...scores) : null,
      // Birinchi yarmi bilan ikkinchi yarmi — bitta testdan keyin "o'sish"
      // ko'rsatib bo'lmaydi, shuning uchun `null`.
      growth:
        scores.length > 1
          ? growthPoints(
              calcAverage(scores.slice(Math.floor(scores.length / 2))),
              calcAverage(scores.slice(0, Math.floor(scores.length / 2))),
            )
          : null,
      totalTimeSec: attempts.reduce((n, a) => n + (a.timeSpentSec || 0), 0),
      bestSubject: bestSubject
        ? { subject: bestSubject.subject, averageScore: bestSubject.averageScore }
        : null,
      worstSubject: worstSubject
        ? { subject: worstSubject.subject, averageScore: worstSubject.averageScore }
        : null,
    },
    trend: attempts
      .filter((a) => a.score != null)
      .map((a) => ({
        attemptId: a.id,
        date: a.submittedAt,
        score: a.score,
        grade: a.grade,
      })),
    subjects: subjectList,
    strongTopics,
    weakTopics,
    recommendation,
  };
}

/**
 * Fandagi zaif mavzular — "Zaif mavzularni mashq qilish" tugmasi shuni
 * ishlatadi.
 *
 * ⚠️ MAVZU ID LARI QAYTARILADI, NOMLARI EMAS. Nom bo'yicha qidirilsa
 * bir xil nomli ikki mavzu (masalan ikki fandagi "Grammatika") bir-biriga
 * aralashib ketardi.
 */
async function weakTopicIds(studentId, { subjectId = null } = {}) {
  const settings = await getDiagnosticSettings();
  const { answers } = await _load(studentId);
  const { topics } = _aggregate(answers);

  return [...topics.values()]
    .filter((t) => t.topicId && (!subjectId || t.subjectId === subjectId))
    .map((t) => ({ topicId: t.topicId, score: scoreOf(t) }))
    .filter((t) => t.score != null && t.score < settings.goodScore)
    .sort((a, b) => a.score - b.score)
    .map((t) => t.topicId);
}

module.exports = {
  DONE_STATUSES,
  ATTEMPT_WINDOW,
  getDashboard,
  weakTopicIds,
};
