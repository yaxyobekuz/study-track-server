/**
 * DIAGNOSTIKA — URINISH (test topshirish va baholash).
 *
 * ⚠️ BUTUN MODULDA BAHOLASHNING YAGONA NUSXASI SHU YERDA. Asl loyihada
 * "testni baholash" uch joyda mustaqil yozilgan edi va ular MAVZU
 * ANIQLIGINING MAXRAJIDA kelishmasdi — o'quvchi bir foizni, o'qituvchi
 * boshqa foizni ko'rardi. Bu yerda ikkita funksiya bor va ikkalasi ham
 * bitta:
 *   `_evaluateAnswer()` — BITTA javobni baholaydi,
 *   `_finalizeAttempt()` — saqlangan javoblardan yakuniy natijani yig'adi.
 * Adaptiv rejim ham, oddiy rejim ham AYNAN shu ikkitasidan o'tadi.
 *
 * ── MAXRAJ QOIDASI (bir marta aytiladi) ──────
 *
 * Har qanday foiz BALL bo'yicha hisoblanadi va maxrajga BERILGAN barcha
 * avtomat baholanadigan savollar kiradi — TASHLAB KETILGANI HAM.
 * Diagnostikada "javob bermadim" — bu "bilmayman" degani; uni maxrajdan
 * chiqarish o'quvchining darajasini sun'iy ko'tarardi va butun modulning
 * ma'nosini (haqiqiy holatni ko'rsatish) yo'q qilardi.
 */

const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} = require("../utils/errors");
const {
  LEVELS,
  LEVEL_LABELS,
  classifyScore,
  gradeLabel,
  diagnosisTone,
  sameOptionSet,
  matchesText,
  classifyError,
  errorPatternShares,
  standardError,
  confidenceBand,
  buildRoadmap,
  buildFindings,
  buildGaps,
  withProjectedGain,
  roadmapCurve,
  shuffle,
  isAutoGraded,
  resolveLevelTiers,
} = require("../helpers/diagnostic.helpers");
const { getDiagnosticSettings } = require("./settings.service");
const diagnosticTestService = require("./diagnosticTest.service");
const diagnosticStudentService = require("./diagnosticStudent.service");

// ─────────────────────────────────────────────
// ADAPTIV YADRO (1PL / Rasch)
// ─────────────────────────────────────────────

/**
 * Qiyinlik pog'onasi → savolning "og'irligi" (b, logit shkalasida).
 *
 * ⚠️ ALOHIDA USTUN EMAS, FUNKSIYA. Asl loyihada `irtB` ustun edi va uni
 * faqat seed skripti to'ldirardi — natijada haqiqiy bankda hamma savolning
 * b = 0 bo'lib, adaptiv tanlov JIMGINA ishlamay qolgan edi (tartib
 * "eng kam ishlatilgan"ga aylanardi). Funksiya bunday bo'shliqni tug'dira
 * olmaydi: qiyinlik har doim bor va u yagona manba.
 */
const LEVEL_B = { easy: -1, medium: 0, hard: 1, expert: 2 };

/** O'quvchi tanlagan daraja → boshlang'ich qobiliyat bahosi. */
const START_THETA = { beginner: -1, intermediate: 0, advanced: 1 };

/** 1PL: shu qobiliyatdagi o'quvchi shu savolga to'g'ri javob berish ehtimoli. */
function _probability(theta, b) {
  return 1 / (1 + Math.exp(-(theta - b)));
}

/**
 * Javobdan keyin qobiliyat bahosini yangilaydi (Elo uslubidagi qadam).
 *
 * `K` javoblar soni bilan kamayadi: birinchi javoblar bahoni keskin
 * suradi, keyingilari esa uni faqat aniqlashtiradi. Doimiy K bo'lsa,
 * oxirgi tasodifiy xato butun natijani buzardi.
 *
 * SE Fisher informatsiyasidan: `se = 1/√Σ p(1−p)`. Savol qobiliyatga
 * qanchalik yaqin bo'lsa, u shuncha ko'p ma'lumot beradi — adaptiv tanlov
 * aynan shuning uchun ishlaydi.
 */
function _updateAbility({ theta, answered, information }, b, isCorrect) {
  const p = _probability(theta, b);
  const k = Math.max(0.25, 1.2 / Math.sqrt(answered + 1));
  const nextTheta = Math.min(3, Math.max(-3, theta + k * ((isCorrect ? 1 : 0) - p)));
  const nextInformation = information + p * (1 - p);
  const se = Math.min(1, Math.max(0.2, 1 / Math.sqrt(Math.max(0.25, nextInformation))));
  return { theta: nextTheta, se, information: nextInformation };
}

/**
 * Adaptiv test to'xtash sharti.
 *
 * Kamida 6 savol — undan kam javob bilan qobiliyat bahosi ishonchsiz.
 * `se <= 0.35` — natija yetarlicha aniq, qo'shimcha savol endi yangi
 * ma'lumot bermaydi. 20 ta — qattiq yuqori chegara: bank bir xil
 * qiyinlikdagi savollardan iborat bo'lsa SE hech qachon 0.35 ga
 * tushmasligi mumkin va test cheksiz davom etardi.
 */
const ADAPTIVE_MIN_QUESTIONS = 6;
/**
 * ⚠️ 0.35 EMAS, 0.50 — VA BU ARIFMETIKADAN KELIB CHIQADI.
 *
 * Informatsiya `1` (boshlang'ich bilim) dan boshlanadi va har javob unga
 * ko'pi bilan `p(1−p) = 0.25` qo'shadi. `se = 1/√I`, demak `se ≤ 0.35`
 * uchun `I ≥ 8.16`, ya'ni KAMIDA 29 ta savol kerak edi — yuqori chegara
 * esa 20 ta. Natijada shart HECH QACHON bajarilmasdi va "test o'zi
 * to'xtaydi" degan va'da amalda ishlamay, har bir adaptiv test to'liq
 * 20 savolga cho'zilardi.
 *
 * `0.50` esa taxminan 12–14 savolda erishiladi: test haqiqatan ham
 * o'quvchi darajasi aniq bo'lgach to'xtaydi.
 */
const ADAPTIVE_SE_TARGET = 0.5;
const ADAPTIVE_MAX = 20;

// ─────────────────────────────────────────────
// SAVOL TANLASH
// ─────────────────────────────────────────────

const QUESTION_SELECT = {
  id: true,
  code: true,
  text: true,
  type: true,
  difficulty: true,
  points: true,
  image: true,
  estimatedTime: true,
  explanation: true,
  solution: true,
  acceptedAnswers: true,
  topicId: true,
  subjectId: true,
  topic: { select: { id: true, name: true } },
  subject: { select: { id: true, name: true } },
  options: { orderBy: { position: "asc" } },
};

/**
 * Bankdan savollar to'plamini tanlaydi (adaptiv BO'LMAGAN rejimlar).
 *
 * ⚠️ SARALASH `usageCount asc` — kam ishlatilgan savollar oldin beriladi.
 * Sabab: aks holda bankning bir qismi hech qachon chiqmasdi va o'quvchilar
 * bir-biridan javoblarni o'rganib olardi.
 *
 * ⚠️ TOR SHART KENGAYTIRILADI. Tanlangan daraja bo'yicha savol yetmasa,
 * qiyinlik filtri olib tashlanadi. "Savol topilmadi" xatosi o'quvchi uchun
 * hech narsani anglatmaydi — u nima qilishni bilmaydi.
 */
async function _pickQuestions({ subjectId, topicId, topicIds, grade, levels, count }) {
  // ⚠️ AVTOMAT TANLOVGA `essay` TUSHMAYDI. U avtomat baholanmaydi, ya'ni
  // tasodifan tushib qolgan insho o'quvchining vaqtini oladi-yu, ballga
  // umuman ta'sir qilmaydi va maxrajni jimgina kichraytiradi. Testga
  // ATAYLAB biriktirilgan insho (`DiagnosticTestQuestion`) esa qoladi —
  // u o'qituvchining ochiq qarori.
  const base = { status: "approved", type: { not: "essay" } };
  if (subjectId) base.subjectId = subjectId;
  if (topicId) base.topicId = topicId;
  if (grade) base.grade = grade;

  // ⚠️ ZAIF MAVZULARGA YO'NALTIRISH — KENGAYTIRILMAYDI.
  //
  // Quyidagi umumiy qoida "yetarli savol topilmasa shartni bo'shat"
  // deydi va bu oddiy test uchun to'g'ri: o'quvchi test topshira
  // olmay qolmasligi kerak. Lekin "zaif mavzularni mashq qilish"
  // tugmasida u TESKARI ishlardi: bankda zaif mavzulardan 12 ta savol
  // bo'lib, 15 ta so'ralsa, kengaytirilgan so'rov 15 ta savol topib
  // "yutib ketardi" — va mashqqa allaqachon o'zlashtirilgan mavzu
  // ham qo'shilib, tugmaning butun ma'nosi yo'qolardi.
  //
  // Shuning uchun: mavzular ro'yxati berilgan bo'lsa, TOPILGANI BILAN
  // cheklanamiz. So'ralganidan kam bo'lsa ham — 12 ta savollik
  // yo'naltirilgan mashq 15 ta suyultirilgan savoldan foydaliroq.
  // Umuman topilmasa (mavzular banki bo'sh), pastdagi kengaytirish
  // ishga tushadi va o'quvchi baribir mashq qila oladi.
  const focused =
    topicIds && topicIds.length && !topicId
      ? { ...base, topicId: { in: topicIds } }
      : null;

  if (focused) {
    for (const where of [
      levels && levels.length ? { ...focused, difficulty: { in: levels } } : null,
      focused,
    ].filter(Boolean)) {
      const rows = await prisma.diagnosticQuestion.findMany({
        where,
        select: QUESTION_SELECT,
        orderBy: [{ usageCount: "asc" }, { createdAt: "asc" }],
        take: count,
      });
      if (rows.length) return rows;
    }
  }

  const attempts = [
    levels && levels.length ? { ...base, difficulty: { in: levels } } : null,
    base,
    // Oxirgi chora: sinf filtrisiz (bank sinfga bo'linmagan bo'lishi mumkin).
    grade
      ? {
          status: "approved",
          type: { not: "essay" },
          ...(subjectId ? { subjectId } : {}),
        }
      : null,
  ].filter(Boolean);

  // ⚠️ ENG YAXSHI NATIJA SAQLANADI. Ilgari kengaytirilgan so'rov ham
  // yetarli savol topmasa bo'sh massiv qaytardi va tor shartda topilgan
  // 2 ta savol ham yo'qolardi — o'quvchi umuman test topshira olmasdi.
  let best = [];
  for (const where of attempts) {
    const rows = await prisma.diagnosticQuestion.findMany({
      where,
      select: QUESTION_SELECT,
      orderBy: [{ usageCount: "asc" }, { createdAt: "asc" }],
      take: count,
    });
    if (rows.length > best.length) best = rows;
    if (best.length >= count) break;
  }

  return best;
}

/**
 * Adaptiv rejim uchun KEYINGI savol: qobiliyatga eng mos qiyinlikdagi,
 * hali berilmagan savol.
 *
 * Nishon `theta + 0.3` — biroz qiyinroq savol eng ko'p ma'lumot beradi va
 * o'quvchini zeriktirmaydi.
 */
async function _pickAdaptiveQuestion({ subjectId, topicId, grade, theta, servedIds }) {
  // ⚠️ FAQAT VARIANTLI SAVOLLAR. Adaptiv tanlov har javobdan keyin
  // qobiliyat bahosini yangilaydi va buning uchun aniq "to'g'ri/xato"
  // signali kerak. Insho umuman baholanmaydi, qisqa javob esa imlo
  // tufayli noto'g'ri "xato" berishi mumkin — ikkalasi ham theta'ni
  // buzardi.
  const where = {
    status: "approved",
    type: { in: ["single", "multiple", "truefalse", "gap"] },
    ...(subjectId ? { subjectId } : {}),
    ...(topicId ? { topicId } : {}),
    ...(grade ? { grade } : {}),
    ...(servedIds.length ? { id: { notIn: servedIds } } : {}),
  };

  // Nomzodlar hovuzi — eng kam ishlatilganlaridan. Butun bankni o'qish
  // katta bazada qimmat, 60 ta esa har doim yetarli tanlov beradi.
  let pool = await prisma.diagnosticQuestion.findMany({
    where,
    select: QUESTION_SELECT,
    orderBy: [{ usageCount: "asc" }, { createdAt: "asc" }],
    take: 60,
  });

  if (!pool.length && grade) {
    pool = await prisma.diagnosticQuestion.findMany({
      where: { ...where, grade: undefined },
      select: QUESTION_SELECT,
      orderBy: [{ usageCount: "asc" }, { createdAt: "asc" }],
      take: 60,
    });
  }

  if (!pool.length) return null;

  const target = theta + 0.3;
  return pool
    .slice()
    .sort(
      (a, b) =>
        Math.abs(LEVEL_B[a.difficulty] - target) -
        Math.abs(LEVEL_B[b.difficulty] - target),
    )[0];
}

// ─────────────────────────────────────────────
// SURATGA OLISH (MUHRLASH)
// ─────────────────────────────────────────────

/**
 * Bankdagi savolni urinishga MUHRLAYDI.
 *
 * ⚠️ To'g'ri javob ham ko'chiriladi (`isCorrect`), lekin u mijozga
 * CHIQMAYDI — o'qish paytida `select` bilan kesiladi. Muhrlanishi shart,
 * chunki savol keyin tahrirlansa, o'tgan natija qayta hisoblanmasligi kerak.
 */
function _snapshotData(question, position, { shuffleOptions }) {
  const options = shuffleOptions ? shuffle(question.options) : question.options;

  return {
    questionId: question.id,
    type: question.type,
    difficulty: question.difficulty,
    text: question.text,
    image: question.image,
    points: question.points,
    topicId: question.topicId,
    topicName: question.topic?.name || null,
    subjectId: question.subjectId,
    subjectName: question.subject?.name || null,
    estimatedTime: question.estimatedTime,
    explanation: question.explanation,
    solution: question.solution,
    acceptedAnswers: question.acceptedAnswers || [],
    position,
    options: {
      create: options.map((opt, index) => ({
        optionId: opt.id,
        text: opt.text,
        image: opt.image,
        isCorrect: opt.isCorrect,
        position: index,
      })),
    },
  };
}

/** Test paytida mijozga ketadigan shakl — JAVOB KALITISIZ. */
function _publicQuestion(row) {
  return {
    id: row.id,
    questionId: row.questionId,
    type: row.type,
    difficulty: row.difficulty,
    difficultyLabel: LEVEL_LABELS[row.difficulty] || row.difficulty,
    text: row.text,
    image: row.image,
    points: row.points,
    topicId: row.topicId,
    topicName: row.topicName,
    subjectId: row.subjectId,
    subjectName: row.subjectName,
    estimatedTime: row.estimatedTime,
    position: row.position,
    options: (row.options || [])
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((opt) => ({
        id: opt.id,
        text: opt.text,
        image: opt.image,
        position: opt.position,
      })),
  };
}

/** So'rovdan kelgan sinf darajasini tekshiradi (1–11 yoki `null`). */
function _parseGrade(value) {
  if (value == null || value === "") return null;
  const grade = parseInt(value, 10);
  if (Number.isNaN(grade) || grade < 1 || grade > 11) return null;
  return grade;
}

async function _studentSnapshot(studentId) {
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      role: true,
      isArchived: true,
      classes: { include: { class: { select: { name: true } } } },
    },
  });
  if (!student) throw new NotFoundError("O'quvchi topilmadi");
  if (student.isArchived) {
    throw new BadRequestError("Arxivlangan o'quvchi test topshira olmaydi");
  }

  return {
    student,
    snapshot: {
      firstName: student.firstName,
      lastName: student.lastName,
      className: student.classes[0]?.class?.name || null,
    },
  };
}

// ─────────────────────────────────────────────
// BOSHLASH
// ─────────────────────────────────────────────

/**
 * Urinishni boshlaydi.
 *
 * Ikki yo'l bor va ikkalasi ham shu yerdan o'tadi:
 *   1. BIRIKTIRILGAN TEST (`testId`) — qoida testdan olinadi;
 *   2. MUSTAQIL MASHQ (`subjectId` + `level`) — o'quvchi o'zi boshlaydi.
 */
async function startAttempt(studentId, input = {}) {
  const settings = await getDiagnosticSettings();
  const { snapshot } = await _studentSnapshot(studentId);

  let test = null;
  let attemptNumber = 1;

  if (input.testId) {
    test = await prisma.diagnosticTest.findUnique({ where: { id: input.testId } });
    if (!test) throw new NotFoundError("Test topilmadi");
  }

  // ── TANLOV MEZONLARI ────────────────────────
  //
  // ⚠️ BIRIKTIRILGAN TESTDA SO'ROV TANASI HECH NARSAGA TA'SIR QILMAYDI.
  //
  // Ilgari `topicId` har doim so'rovdan olinardi, `grade` va daraja esa
  // testda bo'sh bo'lsa so'rovdan to'ldirilardi. Ya'ni o'quvchi
  // `POST /start {testId, topicId: "<oson mavzu>"}` deb yuborib, butun
  // fan bo'yicha mo'ljallangan testni bitta qulay mavzuga toraytira
  // olardi — natijasi esa o'sha test natijasi bo'lib qolaverardi.
  const assigned = Boolean(test);

  const mode = assigned
    ? test.mode
    : diagnosticTestService.MODES.includes(input.mode)
      ? input.mode
      : "practice";

  const subjectId = assigned ? test.subjectId : input.subjectId || null;
  const topicId = assigned ? null : input.topicId || null;

  const grade = assigned
    ? test.grade
    : _parseGrade(input.grade);

  const level = assigned
    ? test.level
    : LEVELS.includes(input.level)
      ? input.level
      : null;

  const declared = assigned ? null : input.declaredLevel;
  const tiers = resolveLevelTiers(settings.levelTiers);
  const levels = level
    ? [level]
    : declared && tiers[declared]
      ? tiers[declared]
      : null;

  // ⚠️ TIKLASH LIMIT TEKSHIRUVIDAN OLDIN TURADI VA TARTIB MUHIM.
  // Teskarisida davom etayotgan urinishning O'ZI limitni to'ldirib
  // qo'yardi: o'quvchi sahifani yangilaganda "Urinishlar tugadi" xatosini
  // olib, boshlagan testini oxiriga yetkaza olmasdi.
  //
  // Tugallanmagan urinish YANGISI BILAN ALMASHTIRILMAYDI ham: aks holda
  // brauzer yopilib qayta ochilganda birinchisi "yarim yo'lda" qolib,
  // limit behuda sarflanardi.
  //
  // ⚠️ MASHQ URINISHI MEZONLARI BO'YICHA QIDIRILADI. Faqat `testId: null`
  // bo'yicha qidirilganda, matematikadan boshlangan mashqni yopmasdan
  // fizikadan yangisini boshlamoqchi bo'lgan o'quvchiga MATEMATIKA
  // urinishi qaytarilardi — u fizika savollarini kutib, matematika
  // savollarini ko'rardi.
  const existing = await prisma.diagnosticAttempt.findFirst({
    where: {
      studentId,
      status: "in_progress",
      ...(assigned
        ? { testId: test.id }
        : { testId: null, mode, subjectId, topicId, level }),
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing && (!existing.expiresAt || existing.expiresAt > new Date())) {
    return getActiveAttempt(studentId, existing.id);
  }
  // Muddati o'tgan ochiq urinish bo'lsa — avval uni yopamiz, aks holda
  // u limitda "davom etayotgan" bo'lib turaverardi.
  if (existing) {
    await _finalizeAttempt(existing.id, { expired: true });
  }

  if (assigned) {
    ({ attemptNumber } = await diagnosticTestService.assertCanStart(test, studentId));
  }

  const questionCount = Math.min(
    100,
    Math.max(
      1,
      parseInt(
        assigned
          ? test.questionCount
          : (input.questionCount ?? settings.defaultQuestionCount),
        10,
      ) || settings.defaultQuestionCount,
    ),
  );

  // ⚠️ `parseInt` NaN qaytarsa `expiresAt` "Invalid Date" bo'lib, yozuv
  // 500 bilan yiqilardi — so'rov tanasidan kelgan har qanday qiymat
  // chegaraga solinadi.
  const durationMin = Math.min(
    300,
    Math.max(
      1,
      parseInt(
        assigned ? test.durationMin : (input.durationMin ?? settings.defaultDurationMin),
        10,
      ) || settings.defaultDurationMin,
    ),
  );

  const shuffleOptions = assigned ? test.shuffleOptions : true;
  const shuffleQuestions = assigned ? test.shuffleQuestions : true;

  // ── SAVOLLARNI TANLASH ──────────────────────
  let questions = [];

  // ⚠️ ADAPTIV REJIM BIRIKTIRILGAN RO'YXATNI OLMAYDI: qat'iy ro'yxat
  // adaptivlikning teskarisi (savollar oldindan belgilangan bo'lsa,
  // moslashadigan narsa qolmaydi). Test servisi bunday kombinatsiyani
  // yaratishga ham yo'l qo'ymaydi — bu yer ikkinchi qavat.
  if (assigned && mode !== "adaptive") {
    const pinned = await prisma.diagnosticTestQuestion.findMany({
      where: { testId: test.id },
      orderBy: { position: "asc" },
      include: { question: { select: QUESTION_SELECT } },
    });
    if (pinned.length) {
      questions = pinned.map((tq) => tq.question).filter(Boolean);
    }
  }

  // ⚠️ ZAIF MAVZULARGA YO'NALTIRISH FAQAT MUSTAQIL MASHQDA. Biriktirilgan
  // testda o'quvchi savollar to'plamini o'zgartira olmasligi kerak
  // (yuqoridagi `assigned` izohi) — aks holda u testni o'ziga qulay
  // mavzularga toraytirib olardi.
  const focusWeak = !assigned && mode !== "adaptive" && Boolean(input.focusWeak);
  const topicIds = focusWeak
    ? await diagnosticStudentService.weakTopicIds(studentId, { subjectId })
    : null;

  if (!questions.length && mode !== "adaptive") {
    questions = await _pickQuestions({
      subjectId,
      topicId,
      topicIds,
      grade,
      levels,
      count: questionCount,
    });
  }

  if (mode === "adaptive" && !questions.length) {
    const startTheta = declared ? (START_THETA[declared] ?? 0) : 0;
    const first = await _pickAdaptiveQuestion({
      subjectId,
      topicId,
      grade,
      theta: startTheta,
      servedIds: [],
    });
    if (!first) {
      throw new BadRequestError(
        "Bankda mos savol topilmadi. Administratorga murojaat qiling.",
      );
    }
    questions = [first];
  }

  if (!questions.length) {
    throw new BadRequestError(
      "Bankda mos savol topilmadi. Administratorga murojaat qiling.",
    );
  }

  const ordered =
    mode === "adaptive"
      ? questions
      : shuffleQuestions
        ? shuffle(questions)
        : questions;

  const startTheta = declared ? (START_THETA[declared] ?? 0) : 0;
  const expiresAt =
    mode === "practice" || mode === "adaptive"
      ? null
      : new Date(Date.now() + durationMin * 60 * 1000);

  const buildData = (number) => ({
    studentId,
    testId: assigned ? test.id : null,
    subjectId,
    topicId,
    schoolGrade: grade,
    mode,
    level,
    status: "in_progress",
    attemptNumber: number,
    studentSnapshot: snapshot,
    totalQuestions: mode === "adaptive" ? 0 : ordered.length,
    ability: startTheta,
    abilitySe: 1,
    expiresAt,
    questions: {
      create: ordered.map((q, index) =>
        _snapshotData(q, index, { shuffleOptions }),
      ),
    },
  });

  // ⚠️ TARTIB RAQAMI TO'QNASHUVIDA QAYTA URINILADI.
  //
  // `(testId, studentId, attemptNumber)` noyob: ikkita ochiq ilova bir
  // vaqtda "Boshlash" ni bossa, ikkalasi ham bir xil raqamni hisoblab,
  // biri P2002 bilan yiqilardi va o'quvchi tushunarsiz xato ko'rardi.
  // Endi ikkinchisi keyingi raqam bilan qayta uriniladi.
  let attempt = null;
  for (let retry = 0; retry < 3; retry += 1) {
    try {
      attempt = await prisma.diagnosticAttempt.create({
        data: buildData(attemptNumber + retry),
      });
      break;
    } catch (error) {
      if (error?.code !== "P2002" || retry === 2) throw error;
    }
  }

  return getActiveAttempt(studentId, attempt.id);
}

/**
 * Davom etayotgan urinish — javob kalitisiz.
 *
 * ⚠️ MUDDAT SHU YERDA TEKSHIRILADI. Mijozdagi taymerga ishonib bo'lmaydi:
 * sahifani qayta yuklash uni nolga qaytarardi.
 */
async function getActiveAttempt(studentId, attemptId) {
  const attempt = await prisma.diagnosticAttempt.findUnique({
    where: { id: attemptId },
    include: {
      questions: {
        orderBy: { position: "asc" },
        include: { options: { orderBy: { position: "asc" } } },
      },
      answers: true,
      test: { select: { id: true, title: true, durationMin: true, mode: true } },
    },
  });
  if (!attempt) throw new NotFoundError("Urinish topilmadi");
  if (attempt.studentId !== studentId) {
    throw new ForbiddenError("Bu urinish sizga tegishli emas");
  }

  if (attempt.status === "in_progress" && attempt.expiresAt && attempt.expiresAt <= new Date()) {
    await _finalizeAttempt(attempt.id, { expired: true });
    return getActiveAttempt(studentId, attemptId);
  }

  const answersByQuestion = new Map(
    attempt.answers.map((a) => [a.attemptQuestionId, a]),
  );

  return {
    id: attempt.id,
    status: attempt.status,
    mode: attempt.mode,
    testId: attempt.testId,
    testTitle: attempt.test?.title || null,
    subjectId: attempt.subjectId,
    attemptNumber: attempt.attemptNumber,
    startedAt: attempt.startedAt,
    expiresAt: attempt.expiresAt,
    // Adaptiv rejimda jami savol soni oldindan noma'lum — mijoz progress
    // barni shu ikki sondan chizadi.
    totalQuestions: attempt.totalQuestions,
    servedCount: attempt.questions.length,
    answeredCount: attempt.answers.filter((a) => !a.isSkipped).length,
    adaptive: attempt.mode === "adaptive",
    maxQuestions: attempt.mode === "adaptive" ? ADAPTIVE_MAX : null,
    questions: attempt.questions.map((q) => ({
      ..._publicQuestion(q),
      answer: answersByQuestion.get(q.id)
        ? {
            selectedOptionIds: answersByQuestion.get(q.id).selectedOptionIds,
            textAnswer: answersByQuestion.get(q.id).textAnswer,
            flagged: answersByQuestion.get(q.id).flagged,
            confidence: answersByQuestion.get(q.id).confidence,
          }
        : null,
    })),
  };
}


// ─────────────────────────────────────────────
// JAVOBNI BAHOLASH
// ─────────────────────────────────────────────

/**
 * BITTA javobni baholaydi — modulda yagona nusxa.
 *
 * @param {object} snapshotQuestion - `DiagnosticAttemptQuestion` (options bilan)
 * @param {object} payload - { selectedOptionIds, textAnswer, timeSpentSec, changeCount, confidence, flagged }
 */
function _evaluateAnswer(snapshotQuestion, payload = {}) {
  const selected = [...new Set((payload.selectedOptionIds || []).filter(Boolean))];
  const textAnswer =
    typeof payload.textAnswer === "string" ? payload.textAnswer.trim() : null;

  const options = snapshotQuestion.options || [];
  const validIds = new Set(options.map((o) => o.id));
  // ⚠️ BEGONA VARIANT ID JIMGINA TASHLANMAYDI, RAD ETILADI: u yoki mijoz
  // xatosi, yoki natijani buzishga urinish.
  const unknown = selected.filter((id) => !validIds.has(id));
  if (unknown.length) {
    throw new BadRequestError("Javobda noma'lum variant tanlangan");
  }

  const isOption = options.length > 0;
  const hasAnswer = isOption ? selected.length > 0 : Boolean(textAnswer);
  const autoGraded = isAutoGraded(snapshotQuestion.type);

  let isCorrect = null;
  let isSkipped = false;
  let pointsEarned = 0;
  let errorReason = null;

  if (!autoGraded) {
    // Insho — avtomat baholanmaydi. `isCorrect` null, ball 0: u yakuniy
    // foizga ham, maxrajga ham kirmaydi (AI faqat izoh yozadi).
    isSkipped = !hasAnswer;
  } else if (!hasAnswer) {
    isSkipped = true;
    isCorrect = false;
    // ⚠️ Tashlab ketilgan savolga sabab QO'YILMAYDI: "bilim yetishmasligi"
    // deb belgilash taxmin bo'lardi, "shoshilish" esa yolg'on.
  } else if (isOption) {
    const correctIds = options.filter((o) => o.isCorrect).map((o) => o.id);
    isCorrect = sameOptionSet(selected, correctIds);
    pointsEarned = isCorrect ? snapshotQuestion.points : 0;
  } else {
    isCorrect = matchesText(textAnswer, snapshotQuestion.acceptedAnswers || []);
    pointsEarned = isCorrect ? snapshotQuestion.points : 0;
  }

  if (autoGraded && isCorrect === false && !isSkipped) {
    errorReason = classifyError(
      snapshotQuestion.estimatedTime,
      payload.timeSpentSec,
      payload.changeCount || 0,
    );
  }

  return {
    selectedOptionIds: selected,
    textAnswer,
    isCorrect,
    isSkipped,
    pointsEarned,
    errorReason,
    confidence: ["low", "mid", "high"].includes(payload.confidence)
      ? payload.confidence
      : null,
    flagged: Boolean(payload.flagged),
    timeSpentSec:
      payload.timeSpentSec == null
        ? null
        : Math.max(0, Math.min(7200, parseInt(payload.timeSpentSec, 10) || 0)),
    changeCount: Math.max(0, Math.min(500, parseInt(payload.changeCount, 10) || 0)),
  };
}

/**
 * Bitta javobni saqlaydi (adaptiv rejim va avtosaqlash uchun).
 *
 * ⚠️ JAVOB MUHRLANGAN SAVOLGA (`attemptQuestionId`) BOG'LANADI, bankdagi
 * savolga emas. Shu tufayli mijoz o'ziga berilmagan savolga javob yubora
 * OLMAYDI — bu strukturaviy kafolat, tekshiruv emas.
 */
async function saveAnswer(studentId, attemptId, attemptQuestionId, payload) {
  const attempt = await prisma.diagnosticAttempt.findUnique({
    where: { id: attemptId },
    select: {
      id: true,
      studentId: true,
      status: true,
      mode: true,
      expiresAt: true,
      ability: true,
      abilitySe: true,
      subjectId: true,
      topicId: true,
      schoolGrade: true,
    },
  });
  if (!attempt) throw new NotFoundError("Urinish topilmadi");
  if (attempt.studentId !== studentId) {
    throw new ForbiddenError("Bu urinish sizga tegishli emas");
  }
  if (attempt.status !== "in_progress") {
    throw new ConflictError("Urinish yakunlangan — javob qabul qilinmaydi");
  }
  if (attempt.expiresAt && attempt.expiresAt <= new Date()) {
    await _finalizeAttempt(attempt.id, { expired: true });
    throw new ConflictError("Test vaqti tugadi");
  }

  const question = await prisma.diagnosticAttemptQuestion.findUnique({
    where: { id: attemptQuestionId },
    include: { options: { orderBy: { position: "asc" } } },
  });
  if (!question || question.attemptId !== attemptId) {
    throw new NotFoundError("Savol bu urinishda topilmadi");
  }

  const evaluated = _evaluateAnswer(question, payload);

  // ⚠️ SHU SAVOLGA BIRINCHI JAVOBMI — ADAPTIV REJIM UCHUN HAL QILUVCHI.
  //
  // `create` muvaffaqiyatli bo'lsa, bu birinchi javob. Takroriy yozuv
  // (P2002) — o'quvchi javobini o'zgartirdi yoki mijoz so'rovni qayta
  // yubordi; unda faqat javob yangilanadi.
  // ⚠️ AVVAL O'QIYMIZ, KEYIN YOZAMIZ. To'g'ridan-to'g'ri `create` qilib
  // P2002 ni ushlash ham ishlaydi, lekin javobni har o'zgartirganda
  // jurnalga xato yozilardi — oddiy foydalanuvchi harakati xatoga
  // o'xshab ko'rinardi. Poyga holati (bir vaqtda ikki so'rov) baribir
  // qolgan `catch` bilan qoplanadi.
  const existingAnswer = await prisma.diagnosticAnswer.findUnique({
    where: { attemptQuestionId },
    select: { id: true },
  });

  let isFirstAnswer = !existingAnswer;
  if (existingAnswer) {
    await prisma.diagnosticAnswer.update({
      where: { attemptQuestionId },
      data: evaluated,
    });
  } else {
    try {
      await prisma.diagnosticAnswer.create({
        data: { attemptId, attemptQuestionId, ...evaluated },
      });
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      // Parallel so'rov bizdan oldin ulgurdi — bu birinchi javob emas.
      isFirstAnswer = false;
      await prisma.diagnosticAnswer.update({
        where: { attemptQuestionId },
        data: evaluated,
      });
    }
  }

  if (attempt.mode !== "adaptive") {
    return { saved: true };
  }

  // ⚠️ TAKRORIY JAVOB YANGI SAVOL OCHMAYDI.
  //
  // Ilgari har `saveAnswer` chaqiruvi qobiliyat bahosini yangilab, YANGI
  // savol qo'shardi. Ya'ni mijoz bitta savolga javobini o'zgartirsa (yoki
  // tarmoq uzilib so'rov qayta ketsa), test har safar bir savolga
  // uzayardi va theta bir javob hisobiga IKKI marta suriladi — 6 ta
  // savolga javob bergan o'quvchi 20 tasini olishi mumkin edi.
  if (!isFirstAnswer) {
    const pending = await prisma.diagnosticAttemptQuestion.findFirst({
      where: { attemptId, answer: null },
      orderBy: { position: "asc" },
      include: { options: { orderBy: { position: "asc" } } },
    });
    return {
      saved: true,
      done: !pending,
      nextQuestion: pending ? _publicQuestion(pending) : null,
    };
  }

  return _advanceAdaptive(attempt, question, evaluated);
}

/**
 * Adaptiv rejim: qobiliyatni yangilaydi va keyingi savolni beradi.
 */
async function _advanceAdaptive(attempt, question, evaluated) {
  const served = await prisma.diagnosticAttemptQuestion.findMany({
    where: { attemptId: attempt.id },
    select: { questionId: true, position: true },
  });
  const answeredCount = await prisma.diagnosticAnswer.count({
    where: { attemptId: attempt.id },
  });

  // ⚠️ `information` ni saqlash uchun alohida ustun YO'Q: u `abilitySe`
  // dan teskari hisoblanadi (se = 1/√I). Ikkinchi ustun ikkinchi haqiqat
  // manbai bo'lardi va ular ajralib ketishi mumkin edi.
  const currentSe = attempt.abilitySe ?? 1;
  const information = 1 / Math.max(0.04, currentSe * currentSe);

  const next = _updateAbility(
    { theta: attempt.ability ?? 0, answered: answeredCount, information },
    LEVEL_B[question.difficulty] ?? 0,
    evaluated.isCorrect === true,
  );

  const enough =
    answeredCount >= ADAPTIVE_MIN_QUESTIONS &&
    (next.se <= ADAPTIVE_SE_TARGET || answeredCount >= ADAPTIVE_MAX);

  if (enough) {
    await prisma.diagnosticAttempt.update({
      where: { id: attempt.id },
      data: { ability: next.theta, abilitySe: next.se, totalQuestions: served.length },
    });
    return { saved: true, done: true, nextQuestion: null };
  }

  const picked = await _pickAdaptiveQuestion({
    subjectId: attempt.subjectId,
    topicId: attempt.topicId,
    grade: attempt.schoolGrade,
    theta: next.theta,
    servedIds: served.map((s) => s.questionId),
  });

  // Bank tugadi — test shu yerda tugaydi. Bu xato emas: shu paytgacha
  // yig'ilgan javoblar baribir natija beradi.
  if (!picked) {
    await prisma.diagnosticAttempt.update({
      where: { id: attempt.id },
      data: { ability: next.theta, abilitySe: next.se, totalQuestions: served.length },
    });
    return { saved: true, done: true, nextQuestion: null, exhausted: true };
  }

  const position = served.length;
  const created = await prisma.diagnosticAttemptQuestion.create({
    data: {
      attemptId: attempt.id,
      ..._snapshotData(picked, position, { shuffleOptions: true }),
    },
    include: { options: { orderBy: { position: "asc" } } },
  });

  await prisma.diagnosticAttempt.update({
    where: { id: attempt.id },
    data: { ability: next.theta, abilitySe: next.se, totalQuestions: position + 1 },
  });

  return {
    saved: true,
    done: false,
    nextQuestion: _publicQuestion(created),
    progress: {
      answered: answeredCount,
      min: ADAPTIVE_MIN_QUESTIONS,
      max: ADAPTIVE_MAX,
      confidence: Math.round((1 - next.se) * 100),
    },
  };
}

// ─────────────────────────────────────────────
// YAKUNLASH
// ─────────────────────────────────────────────

/**
 * Urinishni topshiradi.
 *
 * `answers` berilgan bo'lsa — avval hammasi saqlanadi (oddiy rejim), keyin
 * natija SAQLANGAN javoblardan yig'iladi. Adaptiv rejimda javoblar
 * allaqachon saqlangan va bu massiv bo'sh keladi. Ikkala yo'l ham bitta
 * yakuniy hisob-kitobdan o'tadi.
 */
/**
 * Topshirishda muddatga beriladigan yon.
 *
 * ⚠️ NOL BO'LMASLIGI KERAK: o'quvchi oxirgi soniyada "Yakunlash" ni
 * bosadi, so'rov esa tarmoqda bir necha soniya yuradi. Qat'iy chegara
 * bunday javoblarni yo'qotardi va bu HAR SAFAR eng oxirgi savolda
 * sodir bo'lardi.
 */
const SUBMIT_GRACE_MS = 60 * 1000;

async function submitAttempt(studentId, attemptId, input = {}) {
  const attempt = await prisma.diagnosticAttempt.findUnique({
    where: { id: attemptId },
    select: { id: true, studentId: true, status: true, expiresAt: true },
  });
  if (!attempt) throw new NotFoundError("Urinish topilmadi");
  if (attempt.studentId !== studentId) {
    throw new ForbiddenError("Bu urinish sizga tegishli emas");
  }
  if (attempt.status !== "in_progress") {
    throw new ConflictError("Urinish allaqachon yakunlangan");
  }

  // ⚠️ MUDDAT TOPSHIRISHDA HAM TEKSHIRILADI.
  //
  // Ilgari tekshiruv faqat `saveAnswer` da edi: o'quvchi bitta ham javob
  // saqlamasdan, vaqt tugagandan ancha keyin butun to'plamni yuborsa,
  // u qabul qilinardi — ya'ni vaqtli imtihonda vaqt aslida cheklanmagan
  // edi. Muddatdan (yon bilan) keyin kelgan javoblar QABUL QILINMAYDI,
  // urinish esa saqlangan javoblari bilan yopiladi.
  if (attempt.expiresAt && Date.now() > attempt.expiresAt.getTime() + SUBMIT_GRACE_MS) {
    await _finalizeAttempt(attemptId, { expired: true });
    throw new ConflictError(
      "Test vaqti tugagan — javoblar qabul qilinmadi, urinish yopildi",
    );
  }

  const incoming = Array.isArray(input.answers) ? input.answers : [];

  // ⚠️ 5: MASSIV CHEKLANADI. Har element uchun bitta yozuv ketadi, ya'ni
  // cheklanmagan ro'yxat bitta so'rov bilan bazani band qilib qo'yardi.
  // Amalda urinishdagi savollar sonidan ko'p javob bo'lishi mumkin emas.
  if (incoming.length > 500) {
    throw new BadRequestError("Javoblar soni juda ko'p");
  }

  if (incoming.length) {
    const questions = await prisma.diagnosticAttemptQuestion.findMany({
      where: { attemptId },
      include: { options: { orderBy: { position: "asc" } } },
    });
    const byId = new Map(questions.map((q) => [q.id, q]));

    for (const raw of incoming) {
      const question = byId.get(raw.attemptQuestionId);
      // Begona id — jimgina tashlanadi emas, rad etiladi.
      if (!question) {
        throw new BadRequestError("Javob bu urinishning savoliga tegishli emas");
      }
      const evaluated = _evaluateAnswer(question, raw);
      await prisma.diagnosticAnswer.upsert({
        where: { attemptQuestionId: question.id },
        create: { attemptId, attemptQuestionId: question.id, ...evaluated },
        update: evaluated,
      });
    }
  }

  return _finalizeAttempt(attemptId, { timeSpentSec: input.timeSpentSec });
}

/**
 * Yakuniy hisob-kitob — MODULDAGI YAGONA NUSXA.
 *
 * ⚠️ JAVOB BERILMAGAN SAVOLLARGA HAM BO'SH JAVOB YOZILADI. Usiz "javob
 * bermadi" va "savol berilmadi" holatlari bir xil ko'rinardi va maxraj
 * urinishdan urinishga o'zgarib turardi.
 */
async function _finalizeAttempt(attemptId, { expired = false, timeSpentSec } = {}) {
  const settings = await getDiagnosticSettings();

  const attempt = await prisma.diagnosticAttempt.findUnique({
    where: { id: attemptId },
    include: {
      questions: {
        orderBy: { position: "asc" },
        include: { options: true, answer: true },
      },
    },
  });
  if (!attempt) throw new NotFoundError("Urinish topilmadi");

  // Javobsiz qolgan savollarga bo'sh javob.
  const missing = attempt.questions.filter((q) => !q.answer);
  if (missing.length) {
    await prisma.diagnosticAnswer.createMany({
      data: missing.map((q) => ({
        attemptId,
        attemptQuestionId: q.id,
        selectedOptionIds: [],
        textAnswer: null,
        isCorrect: isAutoGraded(q.type) ? false : null,
        isSkipped: true,
        pointsEarned: 0,
        changeCount: 0,
      })),
      skipDuplicates: true,
    });
  }

  const rows = await prisma.diagnosticAttemptQuestion.findMany({
    where: { attemptId },
    orderBy: { position: "asc" },
    include: { answer: true },
  });

  const topicAgg = new Map();
  const errorCounts = { rushing: 0, knowledge: 0, misread: 0 };

  let correctCount = 0;
  let wrongCount = 0;
  let skippedCount = 0;
  let gradedCount = 0;
  let earnedPoints = 0;
  let maxPoints = 0;

  for (const row of rows) {
    const answer = row.answer;
    if (!isAutoGraded(row.type)) continue;

    gradedCount += 1;
    maxPoints += row.points;
    earnedPoints += answer?.pointsEarned ?? 0;

    if (answer?.isSkipped) skippedCount += 1;
    else if (answer?.isCorrect) correctCount += 1;
    else {
      wrongCount += 1;
      if (answer?.errorReason && errorCounts[answer.errorReason] !== undefined) {
        errorCounts[answer.errorReason] += 1;
      }
    }

    // Mavzusiz savollar "Umumiy" kesimida yig'iladi — ular yo'qolib
    // ketmasligi kerak, aks holda mavzular yig'indisi jami bilan
    // mos kelmasdi.
    const key = row.topicId || "__untagged__";
    const entry = topicAgg.get(key) || {
      topicId: row.topicId,
      topic: row.topicName || "Umumiy",
      correct: 0,
      total: 0,
      earned: 0,
      max: 0,
      skipped: 0,
    };
    entry.total += 1;
    entry.max += row.points;
    entry.earned += answer?.pointsEarned ?? 0;
    if (answer?.isCorrect) entry.correct += 1;
    if (answer?.isSkipped) entry.skipped += 1;
    topicAgg.set(key, entry);
  }

  const score = maxPoints > 0 ? Math.round((earnedPoints / maxPoints) * 1000) / 10 : 0;
  const accuracy = gradedCount > 0
    ? Math.round((correctCount / gradedCount) * 1000) / 10
    : 0;

  const breakdown = [...topicAgg.values()]
    .map((entry) => ({
      topicId: entry.topicId,
      topic: entry.topic,
      score: entry.max > 0 ? Math.round((entry.earned / entry.max) * 100) : 0,
      questions: entry.total,
      correct: entry.correct,
      skipped: entry.skipped,
    }))
    .sort((a, b) => a.score - b.score);

  const errorPatterns = errorPatternShares(errorCounts, wrongCount);
  // ⚠️ ISHONCH O'LCHOVI HAR DOIM BITTA SHKALADA — javoblar sonidan.
  //
  // Ilgari adaptiv rejimda `abilitySe` (logit shkalasi) yozilardi va
  // natijada bir xil 10 savollik ikkita urinish ekranda IKKI XIL aniqlik
  // ko'rsatardi (±16% va ±27%) — foydalanuvchi uchun bu tushunarsiz edi.
  // Qobiliyat bahosining xatosi (`abilitySe`) dvigatelning ichki
  // qiymati bo'lib qoladi va o'z ustunida saqlanadi.
  const seScore = standardError(gradedCount);

  const grade = classifyScore(score, settings.goodScore, settings.mediumScore);

  const elapsed =
    timeSpentSec != null
      ? Math.max(0, Math.min(60 * 60 * 8, parseInt(timeSpentSec, 10) || 0))
      : Math.round((Date.now() - attempt.startedAt.getTime()) / 1000);

  // ⚠️ COMPARE-AND-SWAP: FAQAT `in_progress` qatordan o'tadi.
  //
  // Yakunlash ikki yo'ldan kelishi mumkin — o'quvchi topshiradi va shu
  // lahzada cron muddati o'tganini ko'rib yopadi. Shartsiz `update`
  // bo'lsa ikkalasi ham o'tardi va oqibati ikkita: bank statistikasi
  // IKKI MARTA hisoblanardi (savol bir marta berilgani holda `usageCount`
  // ikkiga oshardi), hamda topshirilgan urinish "vaqti tugagan" bo'lib
  // qayta yozilardi.
  const swapped = await prisma.diagnosticAttempt.updateMany({
    where: { id: attemptId, status: "in_progress" },
    data: {
      status: expired ? "expired" : "submitted",
      submittedAt: new Date(),
      totalQuestions: rows.length,
      correctCount,
      wrongCount,
      skippedCount,
      score,
      accuracy,
      earnedPoints,
      maxPoints,
      grade,
      seScore,
      breakdown,
      errorPatterns,
      timeSpentSec: elapsed,
    },
  });

  // Boshqa jarayon bizdan oldin ulgurgan — statistika ham, javoblar ham
  // o'sha yerda yozilgan. Joriy holatni qaytaramiz, hech narsa
  // takrorlanmaydi.
  if (swapped.count !== 1) {
    return prisma.diagnosticAttempt.findUnique({ where: { id: attemptId } });
  }

  await _updateBankStats(rows);

  return prisma.diagnosticAttempt.findUnique({ where: { id: attemptId } });
}

/**
 * Bank statistikasini yangilaydi.
 *
 * ⚠️ `usageCount` — savol TOPSHIRILGAN urinishda necha marta BERILGANI
 * (tashlab ketilgani ham), `correctCount` — necha marta to'g'ri
 * javob berilgani. Shuning uchun hamma tashlab ketadigan savol ham past
 * aniqlik ko'rsatadi — bu to'g'ri signal: savol tushunarsiz bo'lishi mumkin.
 *
 * Uch so'rov: to'g'rilar, xatolar, keyin aniqlikni qayta hisoblash. Har
 * savol uchun alohida yozuv N ta so'rov bo'lardi.
 */
async function _updateBankStats(rows) {
  const graded = rows.filter((r) => isAutoGraded(r.type) && r.answer);
  if (!graded.length) return;

  const correctIds = graded
    .filter((r) => r.answer.isCorrect === true)
    .map((r) => r.questionId);
  const otherIds = graded
    .filter((r) => r.answer.isCorrect !== true)
    .map((r) => r.questionId);
  const allIds = [...new Set([...correctIds, ...otherIds])];

  try {
    await prisma.$transaction([
      ...(correctIds.length
        ? [
            prisma.diagnosticQuestion.updateMany({
              where: { id: { in: correctIds } },
              data: { usageCount: { increment: 1 }, correctCount: { increment: 1 } },
            }),
          ]
        : []),
      ...(otherIds.length
        ? [
            prisma.diagnosticQuestion.updateMany({
              where: { id: { in: otherIds } },
              data: { usageCount: { increment: 1 } },
            }),
          ]
        : []),
      prisma.$executeRaw`
        UPDATE "diagnostic_questions"
        SET "accuracy" = ROUND((("correct_count"::numeric / NULLIF("usage_count", 0)) * 100), 2)
        WHERE "id" = ANY(${allIds}::char(24)[]) AND "usage_count" > 0
      `,
    ]);
  } catch (error) {
    // ⚠️ STATISTIKA NATIJANI BLOKLAMAYDI. O'quvchi testni topshirdi va
    // uning natijasi tayyor; bank sanoqchisi yangilanmagani muammo, lekin
    // u topshirishni bekor qilishga arzimaydi.
    logger.error(`Diagnostika bank statistikasi yangilanmadi: ${error.message}`);
  }
}

// ─────────────────────────────────────────────
// NATIJA
// ─────────────────────────────────────────────

/**
 * To'liq natija.
 *
 * ⚠️ TO'G'RI JAVOBNI KIM KO'RADI — IKKI QATLAMLI QOIDA:
 *   - XODIM (`staff: true`) DOIM ko'radi. Testning `showAnswers`
 *     sozlamasi O'QUVCHIGA ko'rsatishni boshqaradi, xodimga emas — aks
 *     holda o'qituvchi o'z testining natijasini tekshira olmasdi.
 *   - O'QUVCHI test sozlamasiga qarab ko'radi (`showAnswers`, default HA:
 *     diagnostikaning maqsadi baho qo'yish emas, kamchilikni ko'rsatish).
 *
 * @param {object} opts
 * @param {boolean} opts.staff - chaqiruvchi xodimmi (ruxsat controllerda tekshirilgan)
 */
async function getResult(attemptId, { staff = false } = {}) {
  const settings = await getDiagnosticSettings();

  const attempt = await prisma.diagnosticAttempt.findUnique({
    where: { id: attemptId },
    include: {
      questions: {
        orderBy: { position: "asc" },
        include: {
          options: { orderBy: { position: "asc" } },
          answer: true,
        },
      },
      test: { select: { id: true, title: true, showAnswers: true, mode: true } },
      insights: {
        select: {
          id: true,
          kind: true,
          status: true,
          output: true,
          model: true,
          targetId: true,
          updatedAt: true,
        },
      },
    },
  });
  if (!attempt) throw new NotFoundError("Natija topilmadi");

  // ⚠️ TUGAMAGAN URINISHDA JAVOB KALITI HECH KIMGA CHIQMAYDI — xodimga ham.
  //
  // Bu ENG MUHIM chegara: o'quvchi urinishni boshlab, javob bermasdan
  // turib natija sahifasini so'rasa, u butun javob kalitini olardi
  // (`isCorrect`, `explanation`, `solution`) va keyin 100% bilan
  // topshirardi. Ya'ni butun modulning o'lchov qiymati yo'qolardi.
  //
  // Xodim uchun ham yopiq: davom etayotgan urinishning kalitini ochish
  // uchun sabab yo'q, ochiq qoldirish esa "o'qituvchi telefonidan
  // ko'rsatib yuborish" yo'lini qoldirardi.
  const isFinished = attempt.status !== "in_progress";
  const showAnswers =
    isFinished && (staff || (attempt.test ? attempt.test.showAnswers : true));

  const questions = attempt.questions.map((row) => {
    const answer = row.answer;
    const options = row.options.map((opt) => ({
      id: opt.id,
      text: opt.text,
      image: opt.image,
      position: opt.position,
      selected: (answer?.selectedOptionIds || []).includes(opt.id),
      ...(showAnswers ? { isCorrect: opt.isCorrect } : {}),
    }));

    return {
      id: row.id,
      questionId: row.questionId,
      position: row.position,
      type: row.type,
      difficulty: row.difficulty,
      difficultyLabel: LEVEL_LABELS[row.difficulty] || row.difficulty,
      text: row.text,
      image: row.image,
      points: row.points,
      topicId: row.topicId,
      topicName: row.topicName,
      subjectId: row.subjectId,
      subjectName: row.subjectName,
      estimatedTime: row.estimatedTime,
      options,
      ...(showAnswers
        ? { explanation: row.explanation, solution: row.solution }
        : {}),
      answer: answer
        ? {
            selectedOptionIds: answer.selectedOptionIds,
            textAnswer: answer.textAnswer,
            isSkipped: answer.isSkipped,
            confidence: answer.confidence,
            flagged: answer.flagged,
            timeSpentSec: answer.timeSpentSec,
            changeCount: answer.changeCount,
            // ⚠️ "TO'G'RIMI?" HAM `showAnswers` ORTIDA.
            //
            // O'qituvchi "javoblarni ko'rsatma" deganda, "3-savolni xato
            // qilding" degan ma'lumot ham berilmasligi kerak: to'rt
            // variantli savolda bu javobni bir necha urinishda ochib
            // beradi. O'quvchi baribir umumiy ballni va mavzular kesimini
            // ko'radi — natijaning MA'NOSI yo'qolmaydi, faqat kalit
            // yopiq qoladi.
            ...(showAnswers
              ? {
                  isCorrect: answer.isCorrect,
                  pointsEarned: answer.pointsEarned,
                  errorReason: answer.errorReason,
                }
              : {}),
          }
        : null,
    };
  });

  // Fanlar kesimi — savolning O'Z fani bo'yicha. Aralash test ham
  // fanlarga bo'linadi, "Aralash" degan ma'nosiz qator chiqmaydi.
  const subjectAgg = new Map();
  for (const q of questions) {
    if (!isAutoGraded(q.type)) continue;
    const key = q.subjectId || "__none__";
    const entry = subjectAgg.get(key) || {
      subjectId: q.subjectId,
      subject: q.subjectName || "Umumiy",
      correct: 0,
      total: 0,
      earned: 0,
      max: 0,
    };
    entry.total += 1;
    entry.max += q.points;
    entry.earned += q.answer?.pointsEarned ?? 0;
    if (q.answer?.isCorrect) entry.correct += 1;
    subjectAgg.set(key, entry);
  }

  const subjects = [...subjectAgg.values()]
    .map((e) => ({
      subjectId: e.subjectId,
      subject: e.subject,
      score: e.max > 0 ? Math.round((e.earned / e.max) * 100) : 0,
      questions: e.total,
      correct: e.correct,
    }))
    .sort((a, b) => b.score - a.score);

  // Oldingi urinishlar — o'sish chizig'i uchun.
  //
  // ⚠️ FAQAT SHU URINISHDAN OLDIN TOPSHIRILGANLARI. Vaqt filtri
  // qo'yilmasa, eski natijani ochganda "oldingi urinish" sifatida
  // KEYINGI, kuchliroq natija olinardi va "o'tgan testdan -41.7 ball"
  // degan teskari xulosa chiqardi. Tayyor loyihada aynan shu xato bor
  // edi (u fanni ham filtrlamasdi).
  const before = attempt.submittedAt || new Date();
  const previous = await prisma.diagnosticAttempt.findMany({
    where: {
      studentId: attempt.studentId,
      status: { in: ["submitted", "evaluated", "expired"] },
      id: { not: attemptId },
      submittedAt: { not: null, lt: before },
      ...(attempt.subjectId ? { subjectId: attempt.subjectId } : {}),
    },
    orderBy: { submittedAt: "desc" },
    take: 5,
    select: {
      id: true,
      score: true,
      grade: true,
      submittedAt: true,
      subjectId: true,
    },
  });

  const breakdown = (attempt.breakdown || []).map((row) => ({
    ...row,
    tone: diagnosisTone(row.score),
  }));

  // ⚠️ "To'g'ri: 9/10" NISBATINING MAXRAJI — BERILGAN savollar soni EMAS,
  // BAHOLANADIGAN savollar soni. Insho avtomat baholanmaydi va ballga
  // kirmaydi; uni maxrajga qo'shish "9/11" degan tushunarsiz nisbatni
  // chiqarardi (yig'indi hech qachon to'g'ri kelmasdi).
  const gradedQuestions = questions.filter((q) => isAutoGraded(q.type)).length;

  const roadmapInsight = attempt.insights.find(
    (i) => i.kind === "roadmap" && i.status === "done",
  );
  const feedbackInsight = attempt.insights.find(
    (i) => i.kind === "feedback" && i.status === "done",
  );

  const roadmap =
    roadmapInsight?.output ||
    buildRoadmap(attempt.breakdown || [], attempt.score ?? 0, settings.weakTopicScore);

  // ⚠️ TAQQOSLASH SHU FANNING O'ZI BO'YICHA. `previous` yuqorida
  // `subjectId` bilan filtrlangan: matematika natijasini ingliz tili
  // natijasi bilan taqqoslab "-30 ball" deb ko'rsatish ma'nosiz bo'lardi
  // (tayyor loyihada aynan shunday edi — u fanni umuman filtrlamasdi).
  // `previous` bu yerda hali TESKARI aylantirilmagan: [0] — eng oxirgisi.
  const previousScore = previous[0]?.score ?? null;

  return {
    attempt: {
      id: attempt.id,
      studentId: attempt.studentId,
      studentSnapshot: attempt.studentSnapshot,
      testId: attempt.testId,
      testTitle: attempt.test?.title || null,
      subjectId: attempt.subjectId,
      mode: attempt.mode,
      level: attempt.level,
      status: attempt.status,
      attemptNumber: attempt.attemptNumber,
      totalQuestions: attempt.totalQuestions,
      gradedQuestions,
      correctCount: attempt.correctCount,
      wrongCount: attempt.wrongCount,
      skippedCount: attempt.skippedCount,
      score: attempt.score,
      accuracy: attempt.accuracy,
      earnedPoints: attempt.earnedPoints,
      maxPoints: attempt.maxPoints,
      grade: attempt.grade,
      gradeLabel: gradeLabel(attempt.grade),
      seScore: attempt.seScore,
      confidence: confidenceBand(attempt.score ?? 0, attempt.seScore ?? 0.5),
      ability: attempt.ability,
      timeSpentSec: attempt.timeSpentSec,
      startedAt: attempt.startedAt,
      submittedAt: attempt.submittedAt,
    },
    breakdown,
    subjects,
    errorPatterns: attempt.errorPatterns,
    // ⚠️ AI kelmagan bo'lsa ham reja bo'ladi (heuristik zaxira).
    roadmap,
    // Bashorat egri chizig'i — bugungi ball + har haftaning bashorati.
    predictionCurve: roadmapCurve(roadmap, attempt.score ?? 0),
    // "Sizning 3 ta asosiy topilmangiz" — AI matni bo'lsa o'sha,
    // bo'lmasa qoidadan chiqqan matn. Hech qachon bo'sh emas.
    findings: buildFindings({
      breakdown,
      score: attempt.score ?? 0,
      previousScore,
      feedback: feedbackInsight?.output || null,
    }),
    // "Yopish kerak bo'lgan mavzular" — mehnat bahosi bilan.
    gaps: withProjectedGain(buildGaps(breakdown), gradedQuestions),
    questions,
    previous: previous.reverse(),
    // ⚠️ TAHLILLAR HAM `showAnswers` ORTIDA. `explain` turidagi yozuv
    // ichida TO'G'RI JAVOB MATNI bo'ladi — uni yalang'och qaytarish
    // testning "javoblarni ko'rsatma" sozlamasini chetlab o'tardi.
    insights: showAnswers
      ? attempt.insights
      : attempt.insights.filter((i) => i.kind !== "explain"),
    showAnswers,
  };
}

/**
 * Urinish KIMGA tegishli — yengil tekshiruv.
 *
 * ⚠️ To'liq natijani yuklab, keyin ruxsatni tekshirish IKKI MARTA o'qishga
 * (yoki ruxsatsiz odamga ma'lumot yuklashga) olib kelardi. Bu funksiya
 * faqat egasini qaytaradi va ruxsat shundan keyin tekshiriladi.
 */
async function getAttemptOwner(attemptId) {
  const attempt = await prisma.diagnosticAttempt.findUnique({
    where: { id: attemptId },
    select: { id: true, studentId: true, testId: true, status: true },
  });
  if (!attempt) throw new NotFoundError("Natija topilmadi");
  return attempt;
}

/**
 * O'quvchining urinishlari tarixi.
 */
async function listStudentAttempts(studentId, { limit = 20 } = {}) {
  const rows = await prisma.diagnosticAttempt.findMany({
    where: { studentId },
    orderBy: { createdAt: "desc" },
    take: Math.min(100, limit),
    include: { test: { select: { id: true, title: true } } },
  });

  const subjectIds = [...new Set(rows.map((r) => r.subjectId).filter(Boolean))];
  const subjects = subjectIds.length
    ? await prisma.subject.findMany({
        where: { id: { in: subjectIds } },
        select: { id: true, name: true },
      })
    : [];
  const subjectMap = new Map(subjects.map((s) => [s.id, s.name]));

  return rows.map((r) => ({
    id: r.id,
    testId: r.testId,
    testTitle: r.test?.title || null,
    subjectId: r.subjectId,
    subjectName: r.subjectId ? subjectMap.get(r.subjectId) || null : null,
    mode: r.mode,
    status: r.status,
    score: r.score,
    accuracy: r.accuracy,
    grade: r.grade,
    gradeLabel: gradeLabel(r.grade),
    totalQuestions: r.totalQuestions,
    correctCount: r.correctCount,
    // ⚠️ TARIX JADVALI UCHUN MAJBURIY. Usiz "Noto'g'ri" ustuni
    // `savollar - to'g'ri` deb hisoblanardi va tashlab ketilgan savollar
    // xato bo'lib ko'rinardi.
    wrongCount: r.wrongCount,
    skippedCount: r.skippedCount,
    timeSpentSec: r.timeSpentSec,
    startedAt: r.startedAt,
    submittedAt: r.submittedAt,
    createdAt: r.createdAt,
  }));
}

/**
 * Admin ro'yxati — barcha o'quvchilarning urinishlari (sahifalangan).
 */
async function listAttempts(query = {}, pagination) {
  const where = {};

  if (query.studentId) where.studentId = query.studentId;
  if (query.testId) where.testId = query.testId;
  if (query.subjectId) where.subjectId = query.subjectId;
  if (query.status) where.status = query.status;
  if (query.mode) where.mode = query.mode;
  // `grade` — NATIJA darajasi (GOOD/MEDIUM/BAD), sinf emas.
  if (query.grade) where.grade = query.grade;
  if (query.schoolGrade) {
    const schoolGrade = parseInt(query.schoolGrade, 10);
    if (!Number.isNaN(schoolGrade)) where.schoolGrade = schoolGrade;
  }

  if (query.from || query.to) {
    where.submittedAt = {};
    if (query.from) where.submittedAt.gte = new Date(query.from);
    if (query.to) {
      const to = new Date(query.to);
      to.setUTCHours(23, 59, 59, 999);
      where.submittedAt.lte = to;
    }
  }

  if (query.classId) {
    const members = await prisma.userClass.findMany({
      where: { classId: query.classId },
      select: { userId: true },
    });
    where.studentId = { in: members.map((m) => m.userId) };
  }

  const search = String(query.search || "").trim();
  if (search) {
    const students = await prisma.user.findMany({
      where: {
        role: "student",
        OR: [
          { firstName: { contains: search, mode: "insensitive" } },
          { lastName: { contains: search, mode: "insensitive" } },
        ],
      },
      select: { id: true },
      take: 200,
    });
    const ids = students.map((s) => s.id);
    where.studentId = where.studentId
      ? { in: (where.studentId.in || [where.studentId]).filter((id) => ids.includes(id)) }
      : { in: ids };
  }

  const [total, rows] = await Promise.all([
    prisma.diagnosticAttempt.count({ where }),
    prisma.diagnosticAttempt.findMany({
      where,
      orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
      skip: pagination.skip,
      take: pagination.limit,
      include: { test: { select: { id: true, title: true } } },
    }),
  ]);

  const subjectIds = [...new Set(rows.map((r) => r.subjectId).filter(Boolean))];
  const subjects = subjectIds.length
    ? await prisma.subject.findMany({
        where: { id: { in: subjectIds } },
        select: { id: true, name: true },
      })
    : [];
  const subjectMap = new Map(subjects.map((s) => [s.id, s.name]));

  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      studentId: r.studentId,
      student: r.studentSnapshot,
      testId: r.testId,
      testTitle: r.test?.title || null,
      subjectId: r.subjectId,
      subjectName: r.subjectId ? subjectMap.get(r.subjectId) || null : null,
      mode: r.mode,
      status: r.status,
      score: r.score,
      accuracy: r.accuracy,
      grade: r.grade,
      gradeLabel: gradeLabel(r.grade),
      totalQuestions: r.totalQuestions,
      correctCount: r.correctCount,
      wrongCount: r.wrongCount,
      skippedCount: r.skippedCount,
      timeSpentSec: r.timeSpentSec,
      submittedAt: r.submittedAt,
      createdAt: r.createdAt,
    })),
  };
}

/**
 * Muddati o'tgan urinishlarni yopadi (cron).
 *
 * ⚠️ AVTOMAT YOPISH SHART. Usiz "davom etmoqda" holatidagi urinish abadiy
 * qolib, o'quvchining urinish limitini band qilib turardi va u boshqa
 * hech qachon test topshira olmasdi.
 */
async function expireStaleAttempts() {
  const now = new Date();
  const stale = await prisma.diagnosticAttempt.findMany({
    where: { status: "in_progress", expiresAt: { not: null, lte: now } },
    select: { id: true },
    take: 500,
  });

  let closed = 0;
  for (const row of stale) {
    try {
      await _finalizeAttempt(row.id, { expired: true });
      closed += 1;
    } catch (error) {
      logger.error(`Diagnostika urinishi yopilmadi (${row.id}): ${error.message}`);
    }
  }

  // Vaqt chegarasi YO'Q urinishlar (mashq, adaptiv) ham abadiy ochiq
  // qolmasligi kerak — 24 soatdan keyin ular tashlab ketilgan hisoblanadi.
  const abandonedBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const abandoned = await prisma.diagnosticAttempt.findMany({
    where: {
      status: "in_progress",
      expiresAt: null,
      startedAt: { lt: abandonedBefore },
    },
    select: { id: true },
    take: 500,
  });

  for (const row of abandoned) {
    try {
      await _finalizeAttempt(row.id, { expired: true });
      closed += 1;
    } catch (error) {
      logger.error(`Tashlab ketilgan urinish yopilmadi (${row.id}): ${error.message}`);
    }
  }

  return { closed, expired: stale.length, abandoned: abandoned.length };
}

/** Urinishni bekor qilish (admin) — natija tarixdan chiqariladi. */
async function deleteAttempt(attemptId) {
  const attempt = await prisma.diagnosticAttempt.findUnique({
    where: { id: attemptId },
    select: { id: true },
  });
  if (!attempt) throw new NotFoundError("Urinish topilmadi");

  await prisma.diagnosticAttempt.delete({ where: { id: attemptId } });
  return { message: "Urinish o'chirildi" };
}

module.exports = {
  ADAPTIVE_MIN_QUESTIONS,
  ADAPTIVE_MAX,
  ADAPTIVE_SE_TARGET,
  LEVEL_B,
  startAttempt,
  getActiveAttempt,
  getAttemptOwner,
  saveAnswer,
  submitAttempt,
  getResult,
  listStudentAttempts,
  listAttempts,
  expireStaleAttempts,
  deleteAttempt,
  _evaluateAnswer,
};
