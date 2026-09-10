/**
 * DIAGNOSTIKA — TAHLIL.
 *
 * ⚠️ HAR BIR KESIM AVVALGI DAVR BILAN TAQQOSLANADI. "O'rtacha 64%" degan
 * son o'z-o'zicha hech narsa aytmaydi; "64%, o'tgan oyga nisbatan +6
 * punkt" esa qaror qabul qilishga yaraydi. Avvalgi davr — AYNI
 * UZUNLIKDAGI, `from` dan darhol oldingi oraliq (`previousPeriod`).
 *
 * ⚠️ SINF KESIMI `studentSnapshot.className` BO'YICHA (`education.md` §5):
 * o'quvchini boshqa sinfga o'tkazish o'tgan davr hisobotini jimgina qayta
 * yozib yubormasligi kerak. FILTR esa joriy a'zolik bo'yicha — "5-A
 * sinfning natijalari" deganda rahbar BUGUNGI 5-A ni nazarda tutadi.
 * Ikkalasi ataylab har xil va bu farq shu yerda hujjatlashtirilgan.
 *
 * ⚠️ FOIZ HISOBLASH FORMULALARI BU YERDA YOZILMAYDI — hammasi
 * `helpers/diagnostic.helpers.js` dan olinadi. Ikkinchi nusxa paydo
 * bo'lishi bilan tahlil sahifasi natija sahifasidan boshqa raqam
 * ko'rsatardi.
 */

const prisma = require("../config/prisma");
const { BadRequestError } = require("../utils/errors");
const {
  classifyScore,
  calcAverage,
  tashkentDayStart,
  tashkentToday,
  tashkentDayKey,
  shiftDayKey,
  weekStartKey,
  growthPercent,
  growthPoints,
  categoryShares,
  previousPeriod,
  diagnosisTone,
  gradeLabel,
} = require("../helpers/diagnostic.helpers");
const { getDiagnosticSettings } = require("./settings.service");

/** Yakunlangan urinishlar — tahlilga faqat shular kiradi. */
const DONE_STATUSES = ["submitted", "evaluated", "expired"];

/**
 * Sana oralig'ini o'qiydi. Berilmasa — oxirgi 30 kun.
 *
 * ⚠️ CHEGARA TOSHKENT KUNI BO'YICHA, SERVER LOKAL VAQTI BILAN EMAS.
 * `setHours()` host taymzonasiga tayanadi: ishlab chiqish mashinasi
 * Toshkentda (+5), production konteyneri esa odatda UTC — bir xil so'rov
 * ikki joyda boshqa natija berardi va soat 00:00–05:00 orasida
 * topshirilgan urinishlar "kechagi" oraliqqa tushib qolardi
 * (`diagnostic.helpers.js` dagi izoh va `date.helpers.js` dagi
 * ogohlantirish).
 *
 * ⚠️ `to` KUNNING OXIRIGACHA kengaytiriladi. Usiz "1-sentabrdan
 * 9-sentabrgacha" so'rovi 9-sentabr kuni topshirilgan testlarni
 * TASHLAB KETARDI.
 */
function parseRange(query = {}) {
  const toKey = query.to ? String(query.to).slice(0, 10) : tashkentToday();
  const toStart = tashkentDayStart(toKey);
  if (!toStart) throw new BadRequestError("Tugash sanasi noto'g'ri");
  // Kun oxiri = keyingi kunning boshlanishidan 1 ms oldin.
  const to = new Date(toStart.getTime() + 86400000 - 1);

  const fromKey = query.from
    ? String(query.from).slice(0, 10)
    : shiftDayKey(toKey, -29);
  const from = tashkentDayStart(fromKey);
  if (!from) throw new BadRequestError("Boshlanish sanasi noto'g'ri");

  if (from > to) {
    throw new BadRequestError(
      "Boshlanish sanasi tugash sanasidan keyin bo'lishi mumkin emas",
    );
  }

  return { from, to };
}

/** Filtrlarni bitta `where` ga yig'adi. */
async function _buildWhere(query, range) {
  const where = {
    status: { in: DONE_STATUSES },
    submittedAt: { gte: range.from, lte: range.to },
  };

  if (query.subjectId) where.subjectId = query.subjectId;
  if (query.testId) where.testId = query.testId;
  if (query.mode) where.mode = query.mode;
  if (query.schoolGrade) {
    const grade = parseInt(query.schoolGrade, 10);
    if (!Number.isNaN(grade)) where.schoolGrade = grade;
  }

  if (query.classId) {
    const members = await prisma.userClass.findMany({
      where: { classId: query.classId },
      select: { userId: true },
    });
    where.studentId = { in: members.map((m) => m.userId) };
  }

  if (query.studentId) where.studentId = query.studentId;

  return where;
}

/** Bir davrning xom qatorlari — barcha kesimlar shundan hisoblanadi. */
async function _loadAttempts(where) {
  return prisma.diagnosticAttempt.findMany({
    where,
    select: {
      id: true,
      studentId: true,
      studentSnapshot: true,
      subjectId: true,
      testId: true,
      mode: true,
      score: true,
      accuracy: true,
      grade: true,
      correctCount: true,
      wrongCount: true,
      skippedCount: true,
      totalQuestions: true,
      timeSpentSec: true,
      breakdown: true,
      errorPatterns: true,
      submittedAt: true,
    },
  });
}

function _bucketGrades(rows, settings) {
  let good = 0;
  let medium = 0;
  let bad = 0;

  for (const row of rows) {
    // Muhrlangan daraja bo'lsa o'sha ishlatiladi (chegara keyin
    // o'zgargan bo'lishi mumkin — o'tgan natija qayta baholanmaydi).
    const grade =
      row.grade || classifyScore(row.score ?? 0, settings.goodScore, settings.mediumScore);
    if (grade === "GOOD") good += 1;
    else if (grade === "MEDIUM") medium += 1;
    else bad += 1;
  }

  return { good, medium, bad, shares: categoryShares(good, medium, bad) };
}

// ─────────────────────────────────────────────
// UMUMIY MANZARA
// ─────────────────────────────────────────────

/**
 * Boshqaruv paneli — KPI qatori va taqsimot.
 */
async function getSummary(query = {}) {
  const settings = await getDiagnosticSettings();
  const range = parseRange(query);
  const prevRange = previousPeriod(range.from, range.to);

  const where = await _buildWhere(query, range);
  const prevWhere = await _buildWhere(query, prevRange);

  const [rows, prevRows, totalStudents, totalClasses, bankApproved] =
    await Promise.all([
      _loadAttempts(where),
      _loadAttempts(prevWhere),
      prisma.user.count({ where: { role: "student", isArchived: false } }),
      // ⚠️ SANA FILTRIDAN MUSTAQIL. "Sinflar" va "O'quvchilar" —
      // maktabning HOZIRGI hajmi, davr ko'rsatkichi emas: ularni
      // oraliqqa bog'lash "avgustda 0 ta sinf bo'lgan" degan ma'nosiz
      // xulosaga olib kelardi.
      prisma.class.count(),
      prisma.diagnosticQuestion.count({ where: { status: "approved" } }),
    ]);

  const students = new Set(rows.map((r) => r.studentId));
  const prevStudents = new Set(prevRows.map((r) => r.studentId));

  const avg = calcAverage(rows.map((r) => r.score ?? 0));
  const prevAvg = calcAverage(prevRows.map((r) => r.score ?? 0));

  const distribution = _bucketGrades(rows, settings);
  const prevDistribution = _bucketGrades(prevRows, settings);

  // Xato sabablari — barcha urinishlar bo'ylab yig'ma.
  const errorTotals = { rushing: 0, knowledge: 0, misread: 0, wrongCount: 0 };
  for (const row of rows) {
    const p = row.errorPatterns;
    if (!p || !p.wrongCount) continue;
    errorTotals.wrongCount += p.wrongCount;
    // Foizlar emas, ULARDAN QAYTA TIKLANGAN SONLAR qo'shiladi: foizlarni
    // o'rtachalash kichik urinishga katta urinish bilan teng vazn berardi.
    errorTotals.rushing += Math.round((p.rushing / 100) * p.wrongCount);
    errorTotals.knowledge += Math.round((p.knowledge / 100) * p.wrongCount);
    errorTotals.misread += Math.round((p.misread / 100) * p.wrongCount);
  }
  const errorShares = categoryShares(
    errorTotals.rushing,
    errorTotals.knowledge,
    errorTotals.misread,
  );

  const totalTime = rows.reduce((sum, r) => sum + (r.timeSpentSec || 0), 0);

  return {
    range: { from: range.from, to: range.to },
    previousRange: { from: prevRange.from, to: prevRange.to },
    kpis: {
      attempts: {
        value: rows.length,
        previous: prevRows.length,
        growth: growthPercent(rows.length, prevRows.length),
      },
      students: {
        value: students.size,
        previous: prevStudents.size,
        growth: growthPercent(students.size, prevStudents.size),
        // Qamrov: umuman diagnostika topshirganlar ulushi.
        coverage:
          totalStudents > 0 ? Math.round((students.size / totalStudents) * 100) : 0,
        totalStudents,
      },
      averageScore: {
        value: avg,
        previous: prevAvg,
        // ⚠️ Ballda PUNKT farqi, foiz emas: "60% dan 66% ga" — 6 punkt
        // o'sish, 10% emas.
        growth: growthPoints(avg, prevAvg),
      },
      averageTime: {
        value: rows.length ? Math.round(totalTime / rows.length) : 0,
      },
      classes: { value: totalClasses },
      bank: { approvedQuestions: bankApproved },
    },
    distribution: {
      good: distribution.good,
      medium: distribution.medium,
      bad: distribution.bad,
      total: distribution.good + distribution.medium + distribution.bad,
      shares: distribution.shares,
      previousShares: prevDistribution.shares,
      /**
       * ⚠️ CHEGARALAR JAVOB BILAN BIRGA KETADI.
       *
       * Taqsimot yorlig'ida oraliq yoziladi ("Yaxshi (70–100%)"), lekin
       * chegara SOZLAMADA o'zgaradi. Uni panelda 70/40 deb qotirib
       * qo'yilsa, admin chegarani 75 ga ko'chirgan kunda ekranda
       * yolg'on oraliq turaverardi — raqamlar esa yangi chegara
       * bo'yicha hisoblangan bo'lardi.
       */
      thresholds: { good: settings.goodScore, medium: settings.mediumScore },
    },
    errorPatterns: {
      wrongCount: errorTotals.wrongCount,
      rushing: errorShares.good,
      knowledge: errorShares.medium,
      misread: errorShares.bad,
    },
  };
}

/**
 * Vaqt bo'yicha chiziq. Oraliq uzun bo'lsa hafta, qisqa bo'lsa kun.
 *
 * ⚠️ BO'SH KUNLAR ham qatorda bo'ladi (`value: null`). Ularni tashlab
 * yuborish grafikni siqib, "har kuni test bo'lgan" degan yolg'on
 * manzara chizardi.
 */
async function getTrend(query = {}) {
  const range = parseRange(query);
  const prevRange = previousPeriod(range.from, range.to);
  const [rows, prevRows] = await Promise.all([
    _buildWhere(query, range).then(_loadAttempts),
    _buildWhere(query, prevRange).then(_loadAttempts),
  ]);

  // ⚠️ `to` — kunning OXIRGI millisekundi, shuning uchun farqqa 1 ms
  // qo'shiladi. `+ 1` bilan yozilgan eski hisob bitta ORTIQCHA kun
  // chiqarardi va grafikda oxirida doim bo'sh katak turardi.
  const days = Math.round((range.to.getTime() - range.from.getTime() + 1) / 86400000);
  const weekly = days > 45;

  // ⚠️ GURUHLASH KALITI TOSHKENT KUNI BO'YICHA (`setHours`/`getDay` host
  // taymzonasiga tayanardi). Kechqurun 19:00 dan keyin topshirilgan
  // urinish UTC bo'yicha ERTANGI kunga tushib, grafikda noto'g'ri
  // nuqtaga chiqardi.
  const keyOf = (value) => {
    const day = tashkentDayKey(value);
    return weekly ? weekStartKey(day) : day;
  };

  // ⚠️ IKKALA DAVR HAM BIR XIL UZUNLIKDA VA HAR IKKALASINING KATAKLARI
  // OLDINDAN OCHILADI. Tayyor loyihada oldingi davr MASSIV INDEKSI
  // bo'yicha juftlashtirilardi: agar o'tgan oyda faqat ikki kun test
  // bo'lgan bo'lsa, o'sha ikki kun joriy oyning BIRINCHI ikki kuniga
  // qo'yilib ketardi — ya'ni punktir chiziq boshqa sanalarni ko'rsatardi.
  // Bu yerda juftlik DAVR BOSHIDAN HISOBLANGAN SILJISH bo'yicha: n-kun
  // n-kun bilan taqqoslanadi.
  const build = (list, rangeFrom) => {
    const buckets = new Map();
    const order = [];
    const firstKey = tashkentDayKey(rangeFrom.getTime() + 1000);
    for (let i = 0; i < days; i += 1) {
      const dayKey = shiftDayKey(firstKey, i);
      const key = weekly ? weekStartKey(dayKey) : dayKey;
      if (!buckets.has(key)) {
        buckets.set(key, { key, scores: [], attempts: 0 });
        order.push(key);
      }
    }
    for (const row of list) {
      if (!row.submittedAt) continue;
      const bucket = buckets.get(keyOf(row.submittedAt));
      if (!bucket) continue;
      bucket.attempts += 1;
      bucket.scores.push(row.score ?? 0);
    }
    return order.map((key) => buckets.get(key));
  };

  const current = build(rows, range.from);
  const prev = build(prevRows, prevRange.from);

  return {
    granularity: weekly ? "week" : "day",
    range: { from: range.from, to: range.to },
    previousRange: { from: prevRange.from, to: prevRange.to },
    points: current.map((b, i) => {
      const p = prev[i];
      return {
        date: b.key,
        attempts: b.attempts,
        // ⚠️ `null` — "ma'lumot yo'q", 0 emas. Grafik uzilgan chiziq
        // chizadi, nolga tushib ketmaydi.
        score: b.attempts ? calcAverage(b.scores) : null,
        previousDate: p ? p.key : null,
        previousAttempts: p ? p.attempts : 0,
        previousScore: p && p.attempts ? calcAverage(p.scores) : null,
      };
    }),
  };
}

// ─────────────────────────────────────────────
// KESIMLAR
// ─────────────────────────────────────────────

/**
 * Har qanday kesim uchun umumiy hisoblagich.
 *
 * @param {Array} rows - joriy davr urinishlari
 * @param {Array} prevRows - avvalgi davr urinishlari
 * @param {(row) => {key:string,label:string}|null} classify
 */
function _cut(rows, prevRows, classify, settings) {
  const build = (list) => {
    const map = new Map();
    for (const row of list) {
      const bucket = classify(row);
      if (!bucket) continue;
      const entry = map.get(bucket.key) || {
        key: bucket.key,
        label: bucket.label,
        scores: [],
        students: new Set(),
        attempts: 0,
        good: 0,
        medium: 0,
        bad: 0,
      };
      entry.attempts += 1;
      entry.scores.push(row.score ?? 0);
      entry.students.add(row.studentId);

      const grade =
        row.grade ||
        classifyScore(row.score ?? 0, settings.goodScore, settings.mediumScore);
      if (grade === "GOOD") entry.good += 1;
      else if (grade === "MEDIUM") entry.medium += 1;
      else entry.bad += 1;

      map.set(bucket.key, entry);
    }
    return map;
  };

  const current = build(rows);
  const previous = build(prevRows);

  return [...current.values()]
    .map((entry) => {
      const avg = calcAverage(entry.scores);
      const prev = previous.get(entry.key);
      const prevAvg = prev ? calcAverage(prev.scores) : null;
      const shares = categoryShares(entry.good, entry.medium, entry.bad);

      return {
        key: entry.key,
        label: entry.label,
        attempts: entry.attempts,
        students: entry.students.size,
        averageScore: avg,
        previousScore: prevAvg,
        growth: growthPoints(avg, prevAvg),
        good: { count: entry.good, percent: shares.good },
        medium: { count: entry.medium, percent: shares.medium },
        bad: { count: entry.bad, percent: shares.bad },
        tone: diagnosisTone(avg),
      };
    })
    .sort((a, b) => (b.averageScore ?? 0) - (a.averageScore ?? 0));
}

async function _loadPair(query) {
  const settings = await getDiagnosticSettings();
  const range = parseRange(query);
  const prevRange = previousPeriod(range.from, range.to);

  const [rows, prevRows] = await Promise.all([
    _loadAttempts(await _buildWhere(query, range)),
    _loadAttempts(await _buildWhere(query, prevRange)),
  ]);

  return { settings, range, prevRange, rows, prevRows };
}

/**
 * Urinishlarni (URINISH × FAN) juftliklariga yoyadi.
 *
 * ⚠️ FAN KESIMI SAVOLNING O'Z FANI BO'YICHA, urinishning `subjectId`
 * si bo'yicha EMAS. Aralash test bitta "Aralash" qatorga tushib qolsa,
 * "matematikadan qanday ketyapmiz" degan savolga javob bo'lmasdi — va
 * ekranda hech kimga kerak bo'lmagan "Aralash" degan ustun turardi.
 * Har savol o'z fanini SURAT sifatida olib yuradi
 * (`DiagnosticAttemptQuestion.subjectName`), shuning uchun fan keyin
 * o'chirilsa ham kesim buzilmaydi.
 *
 * ⚠️ MAXRAJ — JAVOB BERILGAN SAVOLLAR. Tashlab ketilgani na to'g'ri,
 * na xato: uni maxrajga qo'shish vaqt yetmagan o'quvchini "bilmaydi"
 * deb belgilardi. Urinishning UMUMIY balli esa aksincha, tashlab
 * ketilganini ham hisoblaydi (u testni o'lchaydi, o'zlashtirishni
 * emas) — ikki maxraj ataylab har xil.
 *
 * ⚠️ NARX: bu bitta qo'shimcha so'rov (davrdagi barcha urinishlarning
 * javob qatorlari, 4 ta kichik ustun). Kesimni urinish darajasida
 * qoldirish arzonroq bo'lardi-yu, natijasi noto'g'ri bo'lardi.
 */
async function _expandBySubject(attemptRows) {
  if (!attemptRows.length) return [];

  const answers = await prisma.diagnosticAnswer.findMany({
    where: { attemptId: { in: attemptRows.map((r) => r.id) } },
    select: {
      attemptId: true,
      isCorrect: true,
      isSkipped: true,
      attemptQuestion: {
        select: { subjectId: true, subjectName: true },
      },
    },
  });

  const attempts = new Map(attemptRows.map((r) => [r.id, r]));
  const acc = new Map();

  for (const answer of answers) {
    const question = answer.attemptQuestion;
    const attempt = attempts.get(answer.attemptId);
    if (!question || !attempt) continue;

    const subjectId = question.subjectId || null;
    const key = `${answer.attemptId}::${subjectId || `name:${question.subjectName || ""}`}`;
    const entry = acc.get(key) || {
      attemptId: answer.attemptId,
      studentId: attempt.studentId,
      subjectId,
      subjectName: question.subjectName || null,
      correct: 0,
      answered: 0,
    };
    if (!answer.isSkipped) {
      entry.answered += 1;
      if (answer.isCorrect) entry.correct += 1;
    }
    acc.set(key, entry);
  }

  return [...acc.values()]
    // Butun fan bo'yicha bitta ham javob bermagan bo'lsa, ball
    // hisoblanmaydi — 0% deb yozish "bilmaydi" degan yolg'on bo'lardi.
    .filter((e) => e.answered > 0)
    .map((e) => ({
      id: e.attemptId,
      studentId: e.studentId,
      subjectId: e.subjectId,
      subjectName: e.subjectName,
      // ⚠️ DARAJA (`grade`) ATAYLAB YO'Q: muhrlangan daraja BUTUN
      // urinishniki, bu qator esa uning bir bo'lagi. `_cut` uni shu
      // bo'lakning o'z ballidan hisoblaydi.
      score: Math.round((e.correct / e.answered) * 1000) / 10,
    }));
}

/** Fanlar kesimi. */
async function getBySubject(query = {}) {
  const { settings, range, rows, prevRows } = await _loadPair(query);

  const [current, previous] = await Promise.all([
    _expandBySubject(rows),
    _expandBySubject(prevRows),
  ]);

  const subjectIds = [
    ...new Set([...current, ...previous].map((r) => r.subjectId).filter(Boolean)),
  ];
  const subjects = subjectIds.length
    ? await prisma.subject.findMany({
        where: { id: { in: subjectIds } },
        select: { id: true, name: true },
      })
    : [];
  const names = new Map(subjects.map((s) => [s.id, s.name]));

  const data = _cut(
    current,
    previous,
    (row) => ({
      key: row.subjectId || `name:${row.subjectName || "unknown"}`,
      // Nom uchun avval jonli katalog, keyin surat: fan qayta nomlansa
      // hisobot yangi nomni ko'rsatadi, o'chirilsa esa eskisini.
      label:
        (row.subjectId ? names.get(row.subjectId) : null) ||
        row.subjectName ||
        "Noma'lum fan",
    }),
    settings,
  );

  /**
   * FANGA BIRIKTIRILGAN TESTLAR SONI.
   *
   * ⚠️ TEST IKKI YO'L BILAN FANGA TEGISHLI BO'LADI: bevosita
   * (`subjectId`) yoki savollar taqsimoti orqali (`blueprint`).
   * Faqat birinchisini sanash aralash testni ("Matematika + Ingliz
   * tili") ikkala fanda ham ko'rinmas qilardi.
   */
  const tests = await prisma.diagnosticTest.findMany({
    select: { id: true, subjectId: true, blueprint: true },
  });
  const testCount = new Map();
  for (const test of tests) {
    const ids = new Set();
    if (test.subjectId) ids.add(test.subjectId);
    if (Array.isArray(test.blueprint)) {
      for (const row of test.blueprint) if (row?.subjectId) ids.add(row.subjectId);
    }
    for (const id of ids) testCount.set(id, (testCount.get(id) || 0) + 1);
  }

  const enriched = data.map((row) => ({
    ...row,
    subjectId: row.key.startsWith("name:") ? null : row.key,
    testCount: testCount.get(row.key) || 0,
    grade:
      row.averageScore != null
        ? classifyScore(row.averageScore, settings.goodScore, settings.mediumScore)
        : null,
  }));

  /**
   * "JAMI" QATORI — USTUNLARNING YIG'INDISI.
   *
   * ⚠️ URINISHLARDAN EMAS, QATORLARDAN. Jadvaldagi "Yaxshi / O'rta /
   * Yomon" ustunlari (urinish × fan) juftliklarini sanaydi; jamini
   * urinishlardan hisoblasak, ekranda ustunlar yig'indisi jami bilan
   * to'g'ri kelmasdi — bu esa hisobotga ishonchni yo'qotadi.
   */
  const sum = (fn) => enriched.reduce((n, row) => n + fn(row), 0);
  const totalAttempts = sum((r) => r.attempts);
  const weighted = enriched.reduce(
    (n, r) => n + (r.averageScore ?? 0) * r.attempts,
    0,
  );
  const totalGood = sum((r) => r.good.count);
  const totalMedium = sum((r) => r.medium.count);
  const totalBad = sum((r) => r.bad.count);
  const shares = categoryShares(totalGood, totalMedium, totalBad);

  return {
    range,
    data: enriched,
    totals: {
      // Bitta test bir necha fanni qamrashi mumkin, shuning uchun
      // testlar TAKRORLANMAYDIGAN sanoq bo'yicha.
      testCount: tests.length,
      attempts: totalAttempts,
      students: new Set(rows.map((r) => r.studentId)).size,
      // O'rtacha — urinishlar soniga VAZNLANGAN: bitta urinishli fan
      // ellik urinishli fan bilan teng vaznga ega bo'lmasligi kerak.
      averageScore:
        totalAttempts > 0 ? Math.round((weighted / totalAttempts) * 10) / 10 : null,
      good: { count: totalGood, percent: shares.good },
      medium: { count: totalMedium, percent: shares.medium },
      bad: { count: totalBad, percent: shares.bad },
    },
    thresholds: { good: settings.goodScore, medium: settings.mediumScore },
  };
}

/**
 * Mavzular kesimi — ZAIF MAVZULAR RO'YXATI.
 *
 * ⚠️ Manba — urinishning `breakdown` MUHRI, jonli hisob emas. Mavzu nomi
 * keyin o'zgarsa yoki mavzu o'chirilsa, o'tgan hisobot buzilmaydi.
 */
async function getByTopic(query = {}) {
  const { settings, range, rows, prevRows } = await _loadPair(query);

  const build = (list) => {
    const map = new Map();
    for (const row of list) {
      for (const topic of row.breakdown || []) {
        const key = topic.topicId || `name:${topic.topic}`;
        const entry = map.get(key) || {
          key,
          topicId: topic.topicId || null,
          label: topic.topic,
          scores: [],
          questions: 0,
          correct: 0,
          skipped: 0,
          students: new Set(),
          attempts: new Set(),
        };
        entry.scores.push(topic.score);
        entry.questions += topic.questions || 0;
        entry.correct += topic.correct || 0;
        entry.skipped += topic.skipped || 0;
        entry.students.add(row.studentId);
        // ⚠️ URINISHLAR SONI — "testlar soni" ustuni. Mavzu bitta
        // urinishda bir necha savol bilan uchrashi mumkin, shuning
        // uchun sanoq TAKRORLANMAYDIGAN urinishlar bo'yicha.
        entry.attempts.add(row.id);
        map.set(key, entry);
      }
    }
    return map;
  };

  const current = build(rows);
  const previous = build(prevRows);

  /**
   * MAVZUNING FANI — jonli katalogdan.
   *
   * ⚠️ SURATDA FAN YO'Q. Urinishning `breakdown` muhri faqat mavzu
   * nomini saqlaydi, chunki natija sahifasida fan savolning o'zidan
   * olinadi. Ro'yxatda esa "qaysi fandan" degan savol asosiy:
   * "III bob" degan mavzu qaysi fanniki ekani nomidan ko'rinmaydi.
   * Mavzu o'chirilgan bo'lsa fan `null` bo'ladi — bu yolg'ondan
   * ko'ra tushunarli.
   */
  const topicIds = [...current.values()].map((e) => e.topicId).filter(Boolean);
  const topics = topicIds.length
    ? await prisma.topic.findMany({
        where: { id: { in: topicIds } },
        select: { id: true, subject: { select: { id: true, name: true } } },
      })
    : [];
  const subjectOf = new Map(topics.map((t) => [t.id, t.subject]));

  const data = [...current.values()]
    .map((entry) => {
      const avg = calcAverage(entry.scores);
      const prev = previous.get(entry.key);
      const prevAvg = prev ? calcAverage(prev.scores) : null;
      const subject = entry.topicId ? subjectOf.get(entry.topicId) : null;
      return {
        key: entry.key,
        topicId: entry.topicId,
        label: entry.label,
        subjectId: subject?.id ?? null,
        subjectName: subject?.name ?? null,
        averageScore: avg,
        previousScore: prevAvg,
        growth: growthPoints(avg, prevAvg),
        attempts: entry.attempts.size,
        questions: entry.questions,
        correct: entry.correct,
        // ⚠️ XATO ALOHIDA SAQLANMAYDI, HISOBLANADI: savol = to'g'ri +
        // xato + tashlab ketilgan. Uni ham muhrga qo'shish ikkinchi
        // haqiqat manbai bo'lardi va yig'indi bir kun to'g'ri
        // kelmasdi.
        wrong: Math.max(0, entry.questions - entry.correct - entry.skipped),
        skipped: entry.skipped,
        students: entry.students.size,
        grade:
          avg != null
            ? classifyScore(avg, settings.goodScore, settings.mediumScore)
            : null,
        tone: diagnosisTone(avg),
      };
    })
    .sort((a, b) => (a.averageScore ?? 0) - (b.averageScore ?? 0));

  /**
   * "JAMI" QATORI.
   *
   * ⚠️ O'RTACHA — QATORLARNING O'RTACHASI EMAS, umumiy to'g'ri javob
   * ulushi. Qatorlarni o'rtachalash bitta savolli mavzuga ellik
   * savolli mavzu bilan teng vazn berardi.
   *
   * ⚠️ MAXRAJ — JAVOB BERILGAN savollar (tashlab ketilgani chiqariladi):
   * mavzu kesimi o'zlashtirishni o'lchaydi, testni emas.
   */
  const sum = (fn) => data.reduce((n, row) => n + fn(row), 0);
  const totalQuestions = sum((r) => r.questions);
  const totalCorrect = sum((r) => r.correct);
  const totalSkipped = sum((r) => r.skipped);
  const answered = totalQuestions - totalSkipped;

  return {
    range,
    // Eng zaif mavzular birinchi — bu ro'yxatning butun ma'nosi.
    data,
    totals: {
      topics: data.length,
      attempts: new Set(rows.map((r) => r.id)).size,
      questions: totalQuestions,
      correct: totalCorrect,
      wrong: sum((r) => r.wrong),
      skipped: totalSkipped,
      averageScore:
        answered > 0 ? Math.round((totalCorrect / answered) * 1000) / 10 : null,
    },
    thresholds: { good: settings.goodScore, medium: settings.mediumScore },
    weakest: data.filter((t) => (t.averageScore ?? 100) < settings.weakTopicScore).slice(0, 10),
    strongest: [...data].reverse().slice(0, 5),
  };
}

/**
 * Sinflar kesimi.
 *
 * ⚠️ Guruhlash `studentSnapshot.className` bo'yicha — o'quvchi keyin
 * boshqa sinfga o'tsa ham o'tgan hisobot o'zgarmaydi.
 */
async function getByClass(query = {}) {
  const { settings, range, rows, prevRows } = await _loadPair(query);

  const data = _cut(
    rows,
    prevRows,
    (row) => {
      const name = row.studentSnapshot?.className;
      return { key: name || "__none__", label: name || "Sinfsiz" };
    },
    settings,
  );

  /**
   * Sinfning JORIY tarkibi — `classId` va o'quvchilar soni.
   *
   * ⚠️ KESIM SURATDAN, TARKIB JORIY A'ZOLIKDAN. Natijalar
   * urinishdagi `studentSnapshot.className` bo'yicha guruhlanadi
   * (`education.md` §5: o'quvchini boshqa sinfga o'tkazish o'tgan
   * hisobotni jimgina qayta yozmasligi kerak), "sinfda nechta
   * o'quvchi bor" degan savolga esa BUGUNGI ro'yxat javob beradi.
   * Ikkalasi ataylab har xil manbadan.
   *
   * ⚠️ SINF NOMI BO'YICHA BOG'LANADI, id bo'yicha emas: suratda
   * faqat nom saqlanadi. Nom `Class.name` da noyob, ya'ni bog'lanish
   * bir qiymatli.
   */
  const classes = await prisma.class.findMany({
    select: {
      id: true,
      name: true,
      _count: { select: { users: true } },
    },
  });
  const byName = new Map(classes.map((c) => [c.name, c]));

  const enriched = data.map((entry) => {
    const cls = byName.get(entry.label);
    return {
      ...entry,
      classId: cls?.id ?? null,
      studentCount: cls?._count.users ?? null,
    };
  });

  // ⚠️ URINISHI YO'Q SINFLAR HAM RO'YXATDA. Ular aynan e'tibor
  // talab qiladiganlar: "bu sinf umuman test ishlamagan" degan
  // ma'lumot ro'yxatdan tushib qolsa, ko'rinmay qolardi.
  const seen = new Set(enriched.map((e) => e.label));
  for (const cls of classes) {
    if (seen.has(cls.name)) continue;
    enriched.push({
      key: cls.name,
      label: cls.name,
      classId: cls.id,
      studentCount: cls._count.users,
      attempts: 0,
      students: 0,
      averageScore: null,
      previousScore: null,
      growth: null,
      good: { count: 0, percent: 0 },
      medium: { count: 0, percent: 0 },
      bad: { count: 0, percent: 0 },
      tone: "untested",
    });
  }

  return {
    range,
    data: enriched,
    totals: _totals(rows, settings),
    // ⚠️ CHEGARALAR JAVOB BILAN: ustun sarlavhasida oraliq yoziladi
    // ("Yaxshi (70–100%)"), chegara esa sozlamada o'zgaradi. Panelda
    // qotirib qo'yilsa, admin chegarani ko'chirgan kunda sarlavha
    // yolg'on bo'lib qolardi.
    thresholds: { good: settings.goodScore, medium: settings.mediumScore },
  };
}

/**
 * BITTA SINFNING DIAGNOSTIKA TAFSILOTI.
 *
 * Uch qism: sinf ko'rsatkichlari, sinfga biriktirilgan testlar va
 * o'quvchilar ro'yxati. Uchalasi bitta chaqiruvda — bo'lib
 * yuborilsa, ekranning bo'laklari bir-biriga zid raqam ko'rsatib
 * qolardi (biri oraliqni yangilagan, ikkinchisi hali eskisini
 * ko'rsatayotgan payt bo'ladi).
 */
async function getClassDetail(classId, query = {}) {
  const settings = await getDiagnosticSettings();
  const range = parseRange(query);

  const cls = await prisma.class.findUnique({
    where: { id: classId },
    select: { id: true, name: true, isActive: true },
  });
  if (!cls) return null;

  const members = await prisma.userClass.findMany({
    where: { classId, user: { role: "student", isArchived: false } },
    select: {
      userId: true,
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          username: true,
          profilePicture: true,
          phone: true,
          createdAt: true,
        },
      },
    },
  });
  const studentIds = members.map((m) => m.userId);

  const where = {
    status: { in: DONE_STATUSES },
    submittedAt: { gte: range.from, lte: range.to },
    ...(query.subjectId ? { subjectId: query.subjectId } : {}),
    studentId: { in: studentIds.length ? studentIds : ["__none__"] },
  };

  const [attempts, tests] = await Promise.all([
    _loadAttempts(where),
    prisma.diagnosticTest.findMany({
      where: { classes: { some: { classId } } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        subjectId: true,
        mode: true,
        status: true,
        questionCount: true,
        durationMin: true,
        availableFrom: true,
        createdAt: true,
      },
    }),
  ]);

  const subjectIds = [
    ...new Set([...attempts, ...tests].map((r) => r.subjectId).filter(Boolean)),
  ];
  const subjects = subjectIds.length
    ? await prisma.subject.findMany({
        where: { id: { in: subjectIds } },
        select: { id: true, name: true },
      })
    : [];
  const subjectName = new Map(subjects.map((x) => [x.id, x.name]));

  // ── O'QUVCHILAR ────────────────────────────
  const byStudent = new Map();
  for (const a of attempts) {
    const entry = byStudent.get(a.studentId) || { scores: [], attempts: 0, last: null };
    entry.attempts += 1;
    if (a.score != null) entry.scores.push(a.score);
    if (a.submittedAt && (!entry.last || a.submittedAt > entry.last)) {
      entry.last = a.submittedAt;
    }
    byStudent.set(a.studentId, entry);
  }

  const students = members
    .map((m) => {
      const entry = byStudent.get(m.userId);
      const average = entry ? calcAverage(entry.scores) : null;
      return {
        id: m.user.id,
        firstName: m.user.firstName,
        lastName: m.user.lastName,
        username: m.user.username,
        profilePicture: m.user.profilePicture,
        phone: m.user.phone,
        joinedAt: m.user.createdAt,
        attempts: entry?.attempts ?? 0,
        averageScore: average,
        grade:
          average != null
            ? classifyScore(average, settings.goodScore, settings.mediumScore)
            : null,
        lastAt: entry?.last ?? null,
      };
    })
    // Test ishlaganlar tepada, ular ichida eng past natija birinchi:
    // e'tibor talab qiladigan o'quvchi ro'yxat oxirida qolmasin.
    .sort((a, b) => {
      if (a.attempts !== b.attempts) return b.attempts - a.attempts;
      return (a.averageScore ?? 101) - (b.averageScore ?? 101);
    });

  // ── TESTLAR ────────────────────────────────
  const byTest = new Map();
  for (const a of attempts) {
    if (!a.testId) continue;
    const entry = byTest.get(a.testId) || { scores: [], students: new Set() };
    if (a.score != null) entry.scores.push(a.score);
    entry.students.add(a.studentId);
    byTest.set(a.testId, entry);
  }

  const testRows = tests.map((t) => {
    const entry = byTest.get(t.id);
    return {
      id: t.id,
      title: t.title,
      subjectId: t.subjectId,
      subjectName: t.subjectId ? subjectName.get(t.subjectId) || null : null,
      mode: t.mode,
      status: t.status,
      questionCount: t.questionCount,
      durationMin: t.durationMin,
      date: t.availableFrom || t.createdAt,
      averageScore: entry ? calcAverage(entry.scores) : null,
      // "2 / 14" — nechta o'quvchi ishlagani. Maxraj SINF hajmi:
      // "3 ta ishladi" degan son o'z-o'zicha ko'p yoki ozligini
      // bildirmaydi.
      completed: entry?.students.size ?? 0,
      total: studentIds.length,
    };
  });

  const scores = attempts.map((a) => a.score ?? 0);
  const average = calcAverage(scores);
  const tested = new Set(attempts.map((a) => a.studentId));

  return {
    range: { from: range.from, to: range.to },
    class: { id: cls.id, name: cls.name, isActive: cls.isActive },
    summary: {
      students: studentIds.length,
      tests: tests.length,
      attempts: attempts.length,
      testedStudents: tested.size,
      averageScore: average,
      grade:
        average != null
          ? classifyScore(average, settings.goodScore, settings.mediumScore)
          : null,
    },
    tests: testRows,
    students,
  };
}

/**
 * O'quvchilar kesimi — reyting va "e'tibor talab qiladiganlar".
 */
async function getByStudent(query = {}) {
  const { settings, range, rows, prevRows } = await _loadPair(query);

  const snapshots = new Map();
  for (const row of rows) snapshots.set(row.studentId, row.studentSnapshot);

  /**
   * Har o'quvchining xom sanoqlari — savol, to'g'ri, xato, tashlab
   * ketilgan va oxirgi faollik.
   *
   * ⚠️ BULAR FOIZNING MAXRAJI. "88%" degan son 8 savoldan chiqqanmi
   * yoki 40 savoldanmi — reytingda bu farq hal qiluvchi, aks holda
   * bitta savolga to'g'ri javob bergan o'quvchi ro'yxat boshiga
   * chiqib qolardi.
   */
  const counts = new Map();
  for (const row of rows) {
    const entry = counts.get(row.studentId) || {
      totalQuestions: 0,
      correct: 0,
      wrong: 0,
      skipped: 0,
      lastActivity: null,
    };
    entry.totalQuestions += row.totalQuestions ?? 0;
    entry.correct += row.correctCount ?? 0;
    entry.wrong += row.wrongCount ?? 0;
    entry.skipped += row.skippedCount ?? 0;
    if (row.submittedAt && (!entry.lastActivity || row.submittedAt > entry.lastActivity)) {
      entry.lastActivity = row.submittedAt;
    }
    counts.set(row.studentId, entry);
  }

  const measured = _cut(
    rows,
    prevRows,
    (row) => ({ key: row.studentId, label: row.studentId }),
    settings,
  );
  const byId = new Map(measured.map((e) => [e.key, e]));

  /**
   * ⚠️ RO'YXATDA BARCHA O'QUVCHILAR, urinishi borlari emas.
   *
   * "O'quvchilar — 576 ta" degan sarlavha ostida faqat test ishlaganlar
   * chiqsa, maxraj yolg'on bo'lardi. Test ishlamagan o'quvchi esa aynan
   * e'tibor talab qiladi — u ro'yxat oxirida, natijasiz turadi.
   */
  const students = await prisma.user.findMany({
    where: {
      role: "student",
      isArchived: false,
      ...(query.classId ? { classes: { some: { classId: query.classId } } } : {}),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      username: true,
      profilePicture: true,
      classes: { include: { class: { select: { id: true, name: true } } } },
    },
  });

  const data = students
    .map((student) => {
      const entry = byId.get(student.id);
      const count = counts.get(student.id) || {};
      const snapshot = snapshots.get(student.id) || {};
      return {
        key: student.id,
        studentId: student.id,
        label:
          [student.lastName, student.firstName].filter(Boolean).join(" ") ||
          student.username,
        username: student.username,
        profilePicture: student.profilePicture,
        // ⚠️ SINF JORIY A'ZOLIKDAN, surat esa zaxira: o'quvchi sinfdan
        // chiqarilgan bo'lsa ham u oxirgi marta qaysi sinfda test
        // ishlagani ko'rinib tursin.
        className: student.classes[0]?.class?.name || snapshot.className || null,
        attempts: entry?.attempts ?? 0,
        totalQuestions: count.totalQuestions ?? 0,
        correct: count.correct ?? 0,
        wrong: count.wrong ?? 0,
        skipped: count.skipped ?? 0,
        averageScore: entry?.averageScore ?? null,
        previousScore: entry?.previousScore ?? null,
        growth: entry?.growth ?? null,
        good: entry?.good ?? { count: 0, percent: 0 },
        medium: entry?.medium ?? { count: 0, percent: 0 },
        bad: entry?.bad ?? { count: 0, percent: 0 },
        grade:
          entry?.averageScore != null
            ? classifyScore(entry.averageScore, settings.goodScore, settings.mediumScore)
            : null,
        tone: entry?.tone ?? "untested",
        lastActivity: count.lastActivity ?? null,
      };
    })
    // Natijasi borlar tepada, ular ichida eng yuqori ball birinchi.
    .sort((a, b) => {
      if ((a.averageScore == null) !== (b.averageScore == null)) {
        return a.averageScore == null ? 1 : -1;
      }
      return (b.averageScore ?? 0) - (a.averageScore ?? 0);
    });

  /**
   * O'RIN — ZICH REYTING (dense rank).
   *
   * ⚠️ TENG BALL — TENG O'RIN va keyingi o'rin BIR POG'ONA pastga
   * tushadi (90%, 90%, 88% → 4, 4, 5). Oddiy tartib raqami ishlatilsa,
   * bir xil natijali ikki o'quvchidan biri "yuqoriroq" bo'lib
   * ko'rinardi — holbuki ular teng.
   */
  let rank = 0;
  let previous = null;
  for (const student of data) {
    if (student.averageScore == null) {
      student.rank = null;
      continue;
    }
    if (student.averageScore !== previous) {
      rank += 1;
      previous = student.averageScore;
    }
    student.rank = rank;
  }

  return {
    range,
    total: data.length,
    data,
    top: data.slice(0, 10),
    // E'tibor talab qiladiganlar: past natija YOKI natijasi tushayotganlar.
    attention: data
      .filter(
        (s) =>
          (s.averageScore ?? 100) < settings.mediumScore ||
          (s.growth != null && s.growth <= -10),
      )
      .sort((a, b) => (a.averageScore ?? 0) - (b.averageScore ?? 0))
      .slice(0, 10),
  };
}

function _totals(rows, settings) {
  const distribution = _bucketGrades(rows, settings);
  return {
    attempts: rows.length,
    students: new Set(rows.map((r) => r.studentId)).size,
    averageScore: calcAverage(rows.map((r) => r.score ?? 0)),
    good: { count: distribution.good, percent: distribution.shares.good },
    medium: { count: distribution.medium, percent: distribution.shares.medium },
    bad: { count: distribution.bad, percent: distribution.shares.bad },
  };
}

/**
 * Qamrov — kim diagnostika topshirmagan.
 *
 * ⚠️ Bu "ro'yxat", ya'ni aniq odamlar haqidagi ma'lumot: o'sha sababdan
 * u alohida ruxsat (`diagnostics.analytics`) ostida turadi va umumiy
 * foizdan ajratilgan (faollik bo'limidagi `roster` bilan bir xil mantiq).
 */
async function getParticipation(query = {}) {
  const range = parseRange(query);
  const where = await _buildWhere(query, range);

  const [rows, students] = await Promise.all([
    prisma.diagnosticAttempt.findMany({
      where,
      select: { studentId: true },
      distinct: ["studentId"],
    }),
    prisma.user.findMany({
      where: {
        role: "student",
        isArchived: false,
        ...(query.classId
          ? { classes: { some: { classId: query.classId } } }
          : {}),
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        classes: { include: { class: { select: { name: true } } } },
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    }),
  ]);

  const tested = new Set(rows.map((r) => r.studentId));
  const missing = students
    .filter((s) => !tested.has(s.id))
    .map((s) => ({
      id: s.id,
      firstName: s.firstName,
      lastName: s.lastName,
      className: s.classes[0]?.class?.name || null,
    }));

  return {
    range,
    total: students.length,
    tested: students.length - missing.length,
    percent:
      students.length > 0
        ? Math.round(((students.length - missing.length) / students.length) * 100)
        : 0,
    missing,
  };
}

/**
 * Bitta o'quvchining diagnostika tarixi — o'sish chizig'i va zaif mavzular.
 */
async function getStudentProfile(studentId, query = {}) {
  const settings = await getDiagnosticSettings();
  const range = parseRange(query);

  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      username: true,
      phone: true,
      parentPhone: true,
      profilePicture: true,
      createdAt: true,
      // ⚠️ `password` / `plainPassword` ATAYLAB YO'Q. Ma'lumotnoma
      // loyihasi profil sahifasida login va parolni ochiq ko'rsatadi;
      // bu loyihada esa maxfiy maydonlar mijozga UMUMAN chiqmaydi
      // (`server/CLAUDE.md`) — parolni ko'rsatadigan ekran o'sha
      // qoidani birinchi buzgan joy bo'lardi.
      classes: { include: { class: { select: { id: true, name: true } } } },
    },
  });
  if (!student) return null;

  const attempts = await prisma.diagnosticAttempt.findMany({
    where: {
      studentId,
      status: { in: DONE_STATUSES },
      submittedAt: { gte: range.from, lte: range.to },
    },
    orderBy: { submittedAt: "asc" },
    select: {
      id: true,
      subjectId: true,
      testId: true,
      mode: true,
      score: true,
      grade: true,
      accuracy: true,
      totalQuestions: true,
      correctCount: true,
      wrongCount: true,
      skippedCount: true,
      timeSpentSec: true,
      breakdown: true,
      errorPatterns: true,
      submittedAt: true,
    },
  });

  const topicMap = new Map();
  // ⚠️ XATO SABABLARI FOIZ EMAS, SON BO'YICHA QO'SHILADI.
  // Har urinish o'z foizlarini muhrlab qo'yadi (`errorPatterns`);
  // ularni o'rtachalash 2 ta xatosi bor urinishga 20 ta xatosi bor
  // urinish bilan TENG vazn berardi. Shuning uchun foizlar avval
  // songa qaytariladi, yig'iladi va oxirida bir marta foizga
  // aylantiriladi — `getSummary` dagi bilan AYNI usul.
  const errorTotals = { rushing: 0, knowledge: 0, misread: 0, wrongCount: 0 };

  for (const attempt of attempts) {
    for (const topic of attempt.breakdown || []) {
      const key = topic.topicId || `name:${topic.topic}`;
      const entry = topicMap.get(key) || {
        key,
        topicId: topic.topicId || null,
        label: topic.topic,
        scores: [],
        questions: 0,
        correct: 0,
        skipped: 0,
      };
      entry.scores.push(topic.score);
      // Mavzu bo'yicha jami hajm — "42% degani nechta savoldan?" degan
      // savolga javob. Usiz bitta savollik mavzu o'n savollik mavzu
      // bilan bir xil ishonch bilan ko'rinardi.
      entry.questions += topic.questions ?? 0;
      entry.correct += topic.correct ?? 0;
      entry.skipped += topic.skipped ?? 0;
      topicMap.set(key, entry);
    }

    const pattern = attempt.errorPatterns;
    if (pattern?.wrongCount) {
      errorTotals.wrongCount += pattern.wrongCount;
      errorTotals.rushing += Math.round((pattern.rushing / 100) * pattern.wrongCount);
      errorTotals.knowledge += Math.round(
        (pattern.knowledge / 100) * pattern.wrongCount,
      );
      errorTotals.misread += Math.round((pattern.misread / 100) * pattern.wrongCount);
    }
  }

  const errorShares = categoryShares(
    errorTotals.rushing,
    errorTotals.knowledge,
    errorTotals.misread,
  );

  const topics = [...topicMap.values()]
    .map((entry) => {
      const avg = calcAverage(entry.scores);
      return {
        ...entry,
        scores: undefined,
        averageScore: avg,
        attempts: entry.scores.length,
        // O'sish — birinchi va oxirgi o'lchov orasidagi farq.
        growth:
          entry.scores.length > 1
            ? growthPoints(entry.scores[entry.scores.length - 1], entry.scores[0])
            : null,
        tone: diagnosisTone(avg),
      };
    })
    .sort((a, b) => (a.averageScore ?? 0) - (b.averageScore ?? 0));

  const scores = attempts.map((a) => a.score ?? 0);
  const average = calcAverage(scores);

  return {
    student: {
      id: student.id,
      firstName: student.firstName,
      lastName: student.lastName,
      username: student.username,
      phone: student.phone,
      parentPhone: student.parentPhone,
      profilePicture: student.profilePicture,
      joinedAt: student.createdAt,
      classes: student.classes.map((uc) => uc.class),
    },
    range,
    summary: {
      attempts: attempts.length,
      // ⚠️ SAVOL VA JAVOB SANOG'I — foizning MAXRAJI. "90%" degan son
      // 10 savoldan chiqqanmi yoki 100 savoldanmi, bu butunlay boshqa
      // ishonch darajasi; usiz profil raqamni ko'rsatadi-yu, uning
      // og'irligini ko'rsatmasdi.
      totalQuestions: attempts.reduce((n, a) => n + (a.totalQuestions ?? 0), 0),
      correct: attempts.reduce((n, a) => n + (a.correctCount ?? 0), 0),
      wrong: attempts.reduce((n, a) => n + (a.wrongCount ?? 0), 0),
      skipped: attempts.reduce((n, a) => n + (a.skippedCount ?? 0), 0),
      // Daraja taqsimoti — nechta urinish qaysi darajada tugagan.
      distribution: (() => {
        const d = _bucketGrades(attempts, settings);
        return {
          good: { count: d.good, percent: d.shares.good },
          medium: { count: d.medium, percent: d.shares.medium },
          bad: { count: d.bad, percent: d.shares.bad },
        };
      })(),
      averageScore: average,
      grade: average != null
        ? classifyScore(average, settings.goodScore, settings.mediumScore)
        : null,
      gradeLabel:
        average != null
          ? gradeLabel(classifyScore(average, settings.goodScore, settings.mediumScore))
          : "—",
      first: scores[0] ?? null,
      last: scores[scores.length - 1] ?? null,
      growth:
        scores.length > 1 ? growthPoints(scores[scores.length - 1], scores[0]) : null,
      totalTimeSec: attempts.reduce((sum, a) => sum + (a.timeSpentSec || 0), 0),
    },
    trend: attempts.map((a) => ({
      attemptId: a.id,
      date: a.submittedAt,
      score: a.score,
      grade: a.grade,
    })),
    topics,
    weakTopics: topics.filter((t) => (t.averageScore ?? 100) < settings.weakTopicScore),
    /**
     * "Nima uchun xato qilyapti" — butun davr bo'yicha bitta manzara.
     *
     * ⚠️ MAXRAJ — XATO JAVOBLAR SONI, savollar soni emas. Tashlab
     * ketilgan savol xato hisoblanmaydi (unga umuman urinilmagan),
     * shuning uchun uch ulush yig'indisi har doim 100% bo'ladi.
     * `categoryShares` qoldiqni eng katta guruhga beradi.
     */
    errorPatterns: {
      wrongCount: errorTotals.wrongCount,
      rushing: errorShares.good,
      knowledge: errorShares.medium,
      misread: errorShares.bad,
    },
    attempts,
  };
}

// ─────────────────────────────────────────────
// BUGUNGI KUN
// ─────────────────────────────────────────────

/**
 * "Bugun" kartalari — sana filtridan MUSTAQIL.
 *
 * ⚠️ ATAYLAB FILTRSIZ. Rahbar oraliqni "avgust" qilib qo'ysa ham, bu
 * to'rt karta bugungi kunni ko'rsatishi kerak: ular kuzatuv paneli, davr
 * hisoboti emas. Aks holda "bugun nechta test ishlandi" degan savolga
 * javob tanlangan oraliqqa qarab o'zgarardi.
 *
 * ⚠️ KUN CHEGARASI TOSHKENT BO'YICHA (`tashkentDayStart`). `setHours`
 * ishlatilsa UTC konteynerida "bugun" soat 05:00 da boshlanardi.
 */
async function getToday() {
  const settings = await getDiagnosticSettings();
  const todayKey = tashkentToday();
  const start = tashkentDayStart(todayKey);
  const end = new Date(start.getTime() + 86400000 - 1);
  const yStart = tashkentDayStart(shiftDayKey(todayKey, -1));

  const [attemptsToday, attemptsYesterday, newStudents, evaluatedToday, lowest] =
    await Promise.all([
      prisma.diagnosticAttempt.count({
        where: { status: { in: DONE_STATUSES }, submittedAt: { gte: start, lte: end } },
      }),
      prisma.diagnosticAttempt.count({
        where: {
          status: { in: DONE_STATUSES },
          submittedAt: { gte: yStart, lt: start },
        },
      }),
      prisma.user.count({
        where: { role: "student", isArchived: false, createdAt: { gte: start, lte: end } },
      }),
      // ⚠️ "Tugatilgan" = AI TAHLILI ham tayyor bo'lgan urinish
      // (`evaluated`), shunchaki topshirilgani emas. Shu sababli bu son
      // birinchi kartadan har doim kichik yoki teng bo'ladi.
      prisma.diagnosticAttempt.count({
        where: { status: "evaluated", submittedAt: { gte: start, lte: end } },
      }),
      // ⚠️ HOLAT FILTRI MAJBURIY. Tayyor loyihada u yo'q edi va hali
      // davom etayotgan urinishning oraliq balli "bugungi eng past
      // natija" bo'lib chiqib qolardi.
      prisma.diagnosticAttempt.findFirst({
        where: {
          status: { in: DONE_STATUSES },
          submittedAt: { gte: start, lte: end },
          score: { not: null },
        },
        orderBy: { score: "asc" },
        select: {
          id: true,
          score: true,
          grade: true,
          subjectId: true,
          studentSnapshot: true,
        },
      }),
    ]);

  let lowestSubject = null;
  if (lowest?.subjectId) {
    const subject = await prisma.subject.findUnique({
      where: { id: lowest.subjectId },
      select: { name: true },
    });
    lowestSubject = subject?.name || null;
  }

  return {
    date: todayKey,
    attempts: {
      value: attemptsToday,
      previous: attemptsYesterday,
      // ⚠️ Bu YERDA foiz o'sishi (kechagi kunga nisbatan), ballda esa
      // punkt farqi. Ikkalasi har xil o'lchov: sanoq foizga, ball
      // punktga bo'linadi.
      growth: growthPercent(attemptsToday, attemptsYesterday),
    },
    newStudents,
    evaluated: evaluatedToday,
    lowest: lowest
      ? {
          attemptId: lowest.id,
          score: lowest.score,
          grade: lowest.grade,
          gradeLabel: gradeLabel(lowest.grade),
          // Aralash testda fan bitta emas — shunda "Aralash" deb turadi.
          subject: lowestSubject || (lowest.subjectId ? null : "Aralash"),
          className: lowest.studentSnapshot?.className || null,
          student:
            [lowest.studentSnapshot?.lastName, lowest.studentSnapshot?.firstName]
              .filter(Boolean)
              .join(" ") || null,
        }
      : null,
    thresholds: { good: settings.goodScore, medium: settings.mediumScore },
  };
}

// ─────────────────────────────────────────────
// SINFLAR BO'YICHA QATNASHUV VA O'ZLASHTIRISH
// ─────────────────────────────────────────────

/**
 * Har sinf uchun: nechta o'quvchi bor, nechtasi shu davrda diagnostika
 * ishladi va ularning o'rtacha natijasi.
 *
 * ⚠️ "KELDI" — DAVOMAT EMAS. Bu yerda "keldi" degani "shu davrda kamida
 * bitta diagnostika ishladi". Davomat butunlay boshqa jadvalda
 * (`StudentAttendance`) va boshqa ma'noga ega — ikkalasi bitta ekranda
 * yonma-yon tursa chalkashlik bo'lardi, shuning uchun sarlavhaning
 * o'zida ta'rif yozilishi kerak.
 *
 * ⚠️ A'ZOLIK JORIY SINF BO'YICHA (`UserClass`), urinishdagi surat
 * bo'yicha EMAS. Sabab: bu ekran "bugungi 5-A qanday ishlayapti" degan
 * savolga javob beradi. Tarixiy hisobotlar esa suratdan o'qiydi
 * (`education.md` §5) — farq ataylab.
 */
async function getClassParticipation(query = {}) {
  const settings = await getDiagnosticSettings();
  const range = parseRange(query);
  const where = await _buildWhere(query, range);

  const [classes, memberships, rows] = await Promise.all([
    prisma.class.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.userClass.findMany({
      where: { user: { role: "student", isArchived: false } },
      select: { classId: true, userId: true },
    }),
    prisma.diagnosticAttempt.findMany({
      where,
      select: { studentId: true, score: true },
    }),
  ]);

  const scoresByStudent = new Map();
  const participants = new Set();
  for (const row of rows) {
    participants.add(row.studentId);
    if (row.score == null) continue;
    const list = scoresByStudent.get(row.studentId) || [];
    list.push(row.score);
    scoresByStudent.set(row.studentId, list);
  }

  const byClass = new Map(classes.map((c) => [c.id, new Set()]));
  for (const m of memberships) byClass.get(m.classId)?.add(m.userId);

  // ⚠️ O'RTACHA — URINISHLAR BO'YICHA, o'quvchilarning o'rtachalarining
  // o'rtachasi bo'yicha EMAS. Ikkinchisida bitta test ishlagan o'quvchi
  // o'n test ishlagani bilan teng vaznga ega bo'lib qolardi.
  const averageOf = (ids) => {
    const scores = [];
    for (const id of ids) scores.push(...(scoresByStudent.get(id) || []));
    return calcAverage(scores);
  };

  const data = classes
    .map((c) => {
      const ids = [...(byClass.get(c.id) || [])];
      const came = ids.filter((id) => participants.has(id)).length;
      const average = averageOf(ids);
      return {
        classId: c.id,
        name: c.name,
        total: ids.length,
        came,
        absent: ids.length - came,
        participation: ids.length ? Math.round((came / ids.length) * 100) : 0,
        averageScore: average,
        grade:
          average != null
            ? classifyScore(average, settings.goodScore, settings.mediumScore)
            : null,
      };
    })
    // Bo'sh sinf ro'yxatni uzaytiradi-yu, hech narsa aytmaydi.
    .filter((c) => c.total > 0)
    .sort((a, b) => a.participation - b.participation);

  const allIds = new Set();
  for (const set of byClass.values()) for (const id of set) allIds.add(id);
  const total = allIds.size;
  const came = [...allIds].filter((id) => participants.has(id)).length;
  const overallAverage = averageOf([...allIds]);

  return {
    range: { from: range.from, to: range.to },
    classes: data,
    overall: {
      total,
      came,
      absent: total - came,
      participation: total ? Math.round((came / total) * 100) : 0,
      averageScore: overallAverage,
      grade:
        overallAverage != null
          ? classifyScore(overallAverage, settings.goodScore, settings.mediumScore)
          : null,
    },
  };
}

/** Excel eksporti uchun tekis qatorlar. */
async function getAttemptsForExport(query = {}) {
  const range = parseRange(query);
  const where = await _buildWhere(query, range);
  const rows = await _loadAttempts(where);

  const subjectIds = [...new Set(rows.map((r) => r.subjectId).filter(Boolean))];
  const subjects = subjectIds.length
    ? await prisma.subject.findMany({
        where: { id: { in: subjectIds } },
        select: { id: true, name: true },
      })
    : [];
  const names = new Map(subjects.map((s) => [s.id, s.name]));

  return rows
    .sort((a, b) => (b.submittedAt?.getTime() ?? 0) - (a.submittedAt?.getTime() ?? 0))
    .map((row) => ({
      student:
        [row.studentSnapshot?.lastName, row.studentSnapshot?.firstName]
          .filter(Boolean)
          .join(" ") || "—",
      className: row.studentSnapshot?.className || "—",
      subject: row.subjectId ? names.get(row.subjectId) || "—" : "Aralash",
      mode: row.mode,
      score: row.score != null ? `${Math.round(row.score)}%` : "—",
      grade: gradeLabel(row.grade),
      correct: row.correctCount ?? 0,
      wrong: row.wrongCount ?? 0,
      skipped: row.skippedCount ?? 0,
      totalQuestions: row.totalQuestions ?? 0,
      timeSpentSec: row.timeSpentSec ?? 0,
      submittedAt: row.submittedAt,
    }));
}

module.exports = {
  DONE_STATUSES,
  parseRange,
  getSummary,
  getTrend,
  getBySubject,
  getByTopic,
  getByClass,
  getClassDetail,
  getByStudent,
  getParticipation,
  getClassParticipation,
  getToday,
  getStudentProfile,
  getAttemptsForExport,
};
