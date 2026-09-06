/**
 * HAFTALIK TAHLIL UCHUN FAKTLAR — modelga beriladigan XOM RAQAMLAR.
 *
 * ⚠️ IKKI QATLAMLI TAHLILNING BIRINCHI QATLAMI. Raqamni HAR DOIM shu fayl
 * hisoblaydi, model esa faqat MATN yozadi. Shu chegara tufayli hisobotdagi
 * har bir son tekshiriladigan bo'lib qoladi: model hech qachon "davomat
 * 93%" degan raqamni o'zi topmaydi, u faqat shu yerdan berilganini takrorlaydi.
 *
 * ⚠️ SOF FUNKSIYA — `academicInsights.js` bilan bir xil qoida: bazaga
 * bormaydi, `Date` o'qimaydi, hech narsani yozmaydi. Kirish — `getOverview`
 * qaytargan bloklar, chiqish — oddiy obyekt. Shuning uchun butun tahlil
 * qatlamini bazasiz sinovda tekshirib bo'ladi.
 *
 * ⚠️ YANGI SO'ROV OCHILMAYDI. Kerakli har bir kesim `getOverview` ning
 * mavjud bloklaridan olinadi. Biror raqam yetishmasa, u `getOverview`
 * ichidagi MAVJUD so'rovga qo'shiladi (`totals.taskDone` shunday qo'shilgan),
 * chunki haftada bir marta ishlaydigan job uchun ikkinchi so'rovlar to'plami
 * ochish dashboardni ikki manbaga bo'lib yuborardi.
 *
 * ⚠️ `dataGaps` — SHU FAYLNING ENG MUHIM CHIQISHI. Model "davomat yaxshi"
 * deb yozib qo'ymasligi uchun qaysi kesimda ma'lumot yetarli emasligi
 * ochiq aytiladi. Chegaralar `academicInsights.js` dan IMPORT qilinadi:
 * nusxa ko'chirilsa, bir kun qoida "yetarli" deb, tahlil "yetarli emas"
 * deb hisoblab, ikkita bir-biriga zid matn chiqarardi.
 */

const {
  MIN_SUBJECT_GRADES,
  MIN_LEVEL_GRADES,
  MIN_ATTENDANCE_MARKS,
  MIN_TASKS,
  GOOD_ATTENDANCE_RATE,
  LEVEL_ATTENDANCE_GAP,
  LOW_TASK_COMPLETION,
  LOW_CLUB_COVERAGE,
} = require("./academicInsights");
const { ACADEMIC_METRICS } = require("./academicMetrics");

/** Reyting ro'yxatlari uzunligi — "eng past 3, eng yuqori 3". */
const RANK_LIMIT = 3;

/**
 * Haftalik rejadagi vazifalarning YUQORI chegarasi.
 *
 * ⚠️ Pastki chegara YO'Q va bu ataylab: qoidalar faqat MA'LUMOT YETARLI
 * bo'lgan kesimdan vazifa tug'diradi. "Kamida uchta bo'lsin" desak,
 * ro'yxatni to'ldirish uchun asossiz vazifa yozilardi.
 */
const MAX_ACTIONS = 5;

/** Muhimlik tartibi — ro'yxat kesilganda "high" hech qachon tushmaydi. */
const PRIORITY_ORDER = ["high", "medium", "low"];

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** Farq — 1 xonagacha (foiz punkti) yoki 2 xonagacha (ball). */
const diff = (value, base, digits = 1) =>
  isNumber(value) && isNumber(base) ? Number((value - base).toFixed(digits)) : null;

const percent = (value) => `${Number(value).toFixed(1)}%`;
const grade = (value) => Number(value).toFixed(2);
const count = (value) => `${Number(value)} ta`;

// ─────────────────────────────────────────────
// Kesimlar
// ─────────────────────────────────────────────

/**
 * KPI kartalari — qiymat, taqqoslash, o'zgarish va reja.
 *
 * Katalog (`academicMetrics.js`) bo'yicha aylanadi, `kpi` obyektining
 * kalitlari bo'yicha emas: yorliq bitta joyda turadi va reja oynasidagi
 * nom bilan tahlildagi nom hech qachon ajralib ketmaydi.
 */
const buildMetrics = (kpi = {}) =>
  ACADEMIC_METRICS.map((metric) => {
    const card = kpi[metric.key];
    if (!card) return null;

    return {
      key: metric.key,
      label: metric.label,
      unit: card.unit,
      value: card.value ?? null,
      previous: card.previous ?? null,
      change: card.change ?? null,
      changeUnit: card.changeUnit ?? null,
      plan: card.plan ?? null,
      planRate: card.planRate ?? null,
    };
  }).filter(Boolean);

/** Ma'lumoti yetarli fanlar — o'rtacha baho bo'yicha kamayish tartibida. */
const rankableSubjects = (subjects = []) =>
  subjects
    .filter((row) => isNumber(row?.average) && (row.gradeCount ?? 0) >= MIN_SUBJECT_GRADES)
    .sort((a, b) => b.average - a.average);

const subjectRow = (row) => ({
  name: row.name,
  average: row.average,
  previousAverage: row.previousAverage ?? null,
  change: diff(row.average, row.previousAverage, 2),
  gradeCount: row.gradeCount,
});

/**
 * Fanlar reytingi: eng yuqori 3 va eng past 3.
 *
 * ⚠️ Fanlar soni oltitadan kam bo'lsa ikkala ro'yxat KESISHADI va bitta
 * fan ham "eng yaxshi", ham "eng yomon" bo'lib chiqardi. Shuning uchun
 * past ro'yxati yuqori ro'yxatiga tushganlarni chiqarib tashlaydi.
 */
const buildSubjectRanking = (subjects = []) => {
  const ranked = rankableSubjects(subjects);
  const top = ranked.slice(0, RANK_LIMIT);
  const topNames = new Set(top.map((row) => row.name));

  const bottom = ranked
    .slice()
    .reverse()
    .filter((row) => !topNames.has(row.name))
    .slice(0, RANK_LIMIT);

  return {
    rankedCount: ranked.length,
    top: top.map(subjectRow),
    bottom: bottom.map(subjectRow),
  };
};

/**
 * Eng past "fan × sinf darajasi" kataklari.
 *
 * ⚠️ Daraja HAR FAN uchun o'sha fanning o'z kesimidan olinadi
 * (`buildSubjects` dagi `weakestLevel`) — umumiy eng past daraja bilan
 * almashtirilsa, ikkita bog'liq bo'lmagan fakt bitta jumlada
 * sabab-oqibatdek ko'rinib qolardi.
 */
const buildWeakCells = (subjects = []) =>
  subjects
    .filter(
      (row) =>
        row?.weakestLevel &&
        isNumber(row.weakestLevel.average) &&
        (row.weakestLevel.gradeCount ?? 0) >= MIN_LEVEL_GRADES,
    )
    .map((row) => ({
      subject: row.name,
      level: row.weakestLevel.label,
      average: row.weakestLevel.average,
      gradeCount: row.weakestLevel.gradeCount,
    }))
    .sort((a, b) => a.average - b.average)
    .slice(0, RANK_LIMIT);

/**
 * Sinf darajalari umumiy ko'rsatkichdan qancha farq qiladi.
 *
 * ⚠️ "Boshqa sinflar" (raqami o'qilmagan sinflar) CHIQARIB TASHLANADI:
 * uni ayblash hech qanday harakatga olib bormaydi, model esa "Boshqa
 * sinflarda davomat past" degan bajarib bo'lmaydigan vazifa yozardi.
 */
const buildLevelGaps = (levels = [], kpi = {}) => {
  const overallAttendance = kpi?.attendanceRate?.value ?? null;
  const overallQuality = kpi?.qualityRate?.value ?? null;

  return levels
    .filter((row) => row?.key !== "other")
    .map((row) => ({
      label: row.label,
      studentCount: row.studentCount,
      average: row.average ?? null,
      attendanceRate: row.attendanceRate ?? null,
      attendanceGap: diff(row.attendanceRate, overallAttendance),
      qualityRate: row.qualityRate ?? null,
      qualityGap: diff(row.qualityRate, overallQuality),
    }));
};

/**
 * O'qituvchilar KPI: eng yuqori 3 va eng past 3.
 *
 * ⚠️ ARXIVLANGAN o'qituvchi kirmaydi — u bilan "individual suhbat"
 * vazifasini yozib bo'lmaydi.
 * ⚠️ Balli yo'q (`score: null`) o'qituvchi ham kirmaydi: ustunlari
 * to'ldirilmagan odam ro'yxat oxirida "eng yomon" bo'lib qolardi.
 */
const buildTeacherOutliers = (teachers = []) => {
  const scored = teachers
    .filter((row) => isNumber(row?.score) && !row.isArchived)
    .sort((a, b) => b.score - a.score);

  const row = (item) => ({
    name: item.name,
    score: item.score,
    averageGrade: item.averageGrade ?? null,
    attendanceRate: item.attendanceRate ?? null,
    taskRate: item.taskRate ?? null,
    gradeCount: item.gradeCount,
    subjectNames: item.subjectNames ?? [],
  });

  const top = scored.slice(0, RANK_LIMIT);
  const topNames = new Set(top.map((item) => item.name));
  const bottom = scored
    .slice()
    .reverse()
    .filter((item) => !topNames.has(item.name))
    .slice(0, RANK_LIMIT);

  return { scoredCount: scored.length, top: top.map(row), bottom: bottom.map(row) };
};

/**
 * Topshiriq intizomi.
 *
 * ⚠️ "Bajarilmagan" soni FOIZDAN qayta hisoblanmaydi, xom sanoqdan
 * ayiriladi (`totals.taskDone`): foizdan chiqarilgan son yaxlitlash
 * tufayli bir donaga adashishi mumkin edi va reja qatorida
 * "5 ta topshiriqni yoping" o'rniga "4 ta" turib qolardi.
 */
const buildTaskDiscipline = (kpi = {}, totals = {}) => {
  const total = totals.taskTotal ?? 0;
  const done = totals.taskDone ?? null;

  return {
    completionRate: kpi?.taskCompletion?.value ?? null,
    total,
    done,
    pending: isNumber(done) ? total - done : null,
  };
};

/** To'garak qamrovi va qamrovsiz o'quvchilar soni. */
const buildClubCoverage = (clubs = {}, totals = {}) => {
  const studentTotal = totals.students ?? 0;
  const inClubs = clubs.studentCount ?? 0;

  return {
    clubCount: clubs.clubCount ?? 0,
    weeklyHours: clubs.weeklyHours ?? 0,
    studentsInClubs: inClubs,
    studentTotal,
    // "Bo'sh joy" — hech qanday to'garakka qatnashmaydigan o'quvchilar.
    // ⚠️ To'garakning SIG'IMI tizimda yuritilmaydi (`Club` da bunday
    // ustun yo'q), shuning uchun "necha o'rin bo'sh" degan raqam
    // o'ylab topilmaydi — o'lchanadigan qamrovsizlar soni beriladi.
    uncovered: Math.max(0, studentTotal - inClubs),
    coverage: clubs.coverage ?? null,
    previousCoverage: clubs.previousCoverage ?? null,
    coverageChange: clubs.coverageChange ?? null,
    topClubs: (clubs.items ?? []).slice(0, RANK_LIMIT).map((row) => ({
      name: row.name,
      memberCount: row.memberCount,
    })),
  };
};

/** Olimpiada yutuqlari — jami, darajalar kesimi va taqqoslash. */
const buildAchievementFacts = (achievements = {}, compareMonthLabel = null) => ({
  total: achievements.total ?? 0,
  previousTotal: achievements.previousTotal ?? null,
  change: achievements.change ?? null,
  compareMonthLabel,
  levels: (achievements.levels ?? [])
    .filter((row) => (row.count ?? 0) > 0 || (row.previousCount ?? 0) > 0)
    .map((row) => ({
      label: row.label,
      count: row.count ?? 0,
      previousCount: row.previousCount ?? 0,
    })),
});

/**
 * MA'LUMOT YETISHMAYDIGAN KESIMLAR.
 *
 * ⚠️ Bu ro'yxat modelga "bu haqda yozma" deb aytadi. Yo'q ma'lumotni
 * "ko'rsatkich nol" deb o'qish bo'sh jurnalni "davomat 0%" deb ayblab
 * qo'yardi va butun hisobotga ishonch yo'qolardi.
 *
 * ⚠️ HAR BIR KESIMDA IKKI MATN BOR va ular ATAYLAB ajratilgan:
 *   `message` — MODELGA buyruq ("...xulosa chiqarmang"),
 *   `task`    — ODAMGA vazifa ("Davomat qaydlari to'ldirilsin").
 * Bitta matn ikkala vazifani bajarganda zaxira reja direktorning haftalik
 * ro'yxatiga "o'rtacha baho bo'yicha xulosa chiqarmang" degan — unga
 * qaratilmagan va ma'nosiz — jumlani chiqarardi. Yangi filial ochilgan
 * birinchi haftada ekranda AYNAN shunday uchta vazifa turardi.
 */
const buildDataGaps = ({ totals, metrics, subjectRanking, teacherOutliers, clubs, levels }) => {
  const gaps = [];
  const add = (key, message, task = null) => gaps.push({ key, message, task });

  if ((totals.students ?? 0) === 0) {
    add(
      "students",
      "Shu oyda o'qish davri ochiq o'quvchi yo'q — barcha kesimlar bo'sh.",
      "O'quvchilarning o'qish davrlari tekshirilsin va ochilsin",
    );
  }

  if ((totals.gradeCount ?? 0) < MIN_SUBJECT_GRADES) {
    add(
      "grades",
      "Baholar soni tahlil uchun yetarli emas — o'rtacha baho bo'yicha xulosa chiqarmang.",
      "Baholar jurnali to'ldirilsin — tahlil uchun qaydlar yetarli emas",
    );
  }

  if (subjectRanking.rankedCount < 2) {
    add(
      "subjects",
      "Ma'lumoti yetarli fanlar soni ikkitadan kam — fanlarni taqqoslamang.",
      "Fanlar bo'yicha baho qo'yish yo'lga qo'yilsin",
    );
  }

  if ((totals.attendanceMarks ?? 0) < MIN_ATTENDANCE_MARKS) {
    add(
      "attendance",
      "Davomat qaydlari yetarli emas — davomat bo'yicha xulosa chiqarmang.",
      "Kunlik davomat belgilash yo'lga qo'yilsin — qaydlar yetarli emas",
    );
  }

  if ((totals.taskTotal ?? 0) < MIN_TASKS) {
    add(
      "tasks",
      "Muddati shu oyda tugagan topshiriqlar yetarli emas — ijro intizomi bo'yicha xulosa chiqarmang.",
      "Topshiriqlar tizimga kiritilsin va muddatlari belgilansin",
    );
  }

  if (teacherOutliers.scoredCount === 0) {
    add(
      "teachers",
      "O'qituvchilar KPI si hisoblanmagan — o'qituvchilar bo'yicha xulosa chiqarmang.",
      "O'qituvchilarga fan biriktirilsin — KPI hisoblanmayapti",
    );
  }

  if ((clubs.clubCount ?? 0) === 0) {
    add(
      "clubs",
      "Faol to'garak yo'q — to'garak qamrovi bo'yicha xulosa chiqarmang.",
      "To'garaklar ro'yxati tizimga kiritilsin",
    );
  }

  if (levels.every((row) => row.attendanceRate == null)) {
    add(
      "levels",
      "Sinf darajalari bo'yicha davomat yo'q — darajalarni taqqoslamang.",
      "Sinflar bo'yicha davomat belgilash yo'lga qo'yilsin",
    );
  }

  if (metrics.every((row) => row.plan == null)) {
    add(
      "plan",
      "Bu oyga reja belgilanmagan — rejaning bajarilishi haqida yozmang.",
      "Shu oyga oylik reja belgilansin",
    );
  }

  return gaps;
};

// ─────────────────────────────────────────────
// Kirish nuqtasi
// ─────────────────────────────────────────────

/**
 * `getOverview` bloklaridan modelga beriladigan faktlar to'plami.
 *
 * @param {object} overview `academicDashboard.service.js` → `getOverview`
 * @returns {object} XOM faktlar (JSON.stringify bilan promptga uzatiladi)
 */
const buildFacts = (overview = {}) => {
  const {
    month = null,
    monthLabel = null,
    compareMonth = null,
    compareMonthLabel = null,
    kpi = {},
    subjects = [],
    levels = [],
    teachers = [],
    achievements = {},
    clubs = {},
    totals = {},
  } = overview;

  const metrics = buildMetrics(kpi);
  const subjectRanking = buildSubjectRanking(subjects);
  const levelGaps = buildLevelGaps(levels, kpi);
  const teacherOutliers = buildTeacherOutliers(teachers);
  const clubCoverage = buildClubCoverage(clubs, totals);

  return {
    period: { month, monthLabel, compareMonth, compareMonthLabel },
    totals: {
      students: totals.students ?? 0,
      admissions: totals.admissions ?? 0,
      gradeCount: totals.gradeCount ?? 0,
      attendanceMarks: totals.attendanceMarks ?? 0,
      taskTotal: totals.taskTotal ?? 0,
    },
    metrics,
    subjectRanking,
    weakCells: buildWeakCells(subjects),
    levelGaps,
    teacherOutliers,
    taskDiscipline: buildTaskDiscipline(kpi, totals),
    clubCoverage,
    achievements: buildAchievementFacts(achievements, compareMonthLabel),
    dataGaps: buildDataGaps({
      totals,
      metrics,
      subjectRanking,
      teacherOutliers,
      clubs,
      levels: levelGaps,
    }),
  };
};

// ─────────────────────────────────────────────
// ZAXIRA REJA — model chaqirilmaganda yoki javobi rad etilganda
// ─────────────────────────────────────────────

/**
 * Faktlardan HAFTALIK VAZIFALAR — qoida asosida.
 *
 * ⚠️ Bu funksiya bo'lmasa, AI yiqilgan haftada ekranda vazifalar bo'limi
 * BO'SH turardi va foydalanuvchi "tizim buzilibdi" deb o'qirdi. Matn
 * kambag'alroq, lekin shakli AYNAN BIR XIL — frontend ikki holatni
 * ajratmasligi kerak (`source` maydonidan boshqa).
 *
 * ⚠️ Vazifa faqat MA'LUMOT YETARLI bo'lgan kesimdan tug'iladi: `dataGaps`
 * dagi kalit bo'yicha qoida o'chiriladi.
 */
const buildFallbackActions = (facts) => {
  const gapKeys = new Set((facts.dataGaps ?? []).map((row) => row.key));
  const has = (key) => !gapKeys.has(key);
  const actions = [];

  const push = (action) => actions.push({ id: `rule-${actions.length + 1}`, ...action });

  const weakCell = facts.weakCells?.[0];
  if (has("grades") && weakCell) {
    push({
      title: `${weakCell.level}da ${weakCell.subject} fanidan qo'shimcha mashg'ulot o'tkazilsin (o'rtacha ${grade(
        weakCell.average,
      )})`,
      owner: `${weakCell.subject} o'qituvchisi`,
      dueLabel: "Payshanbagacha",
      priority: "high",
    });
  }

  const attendance = facts.metrics?.find((row) => row.key === "attendanceRate");
  const weakLevel = (facts.levelGaps ?? [])
    .filter((row) => isNumber(row.attendanceGap))
    .sort((a, b) => a.attendanceGap - b.attendanceGap)[0];

  if (has("attendance") && attendance && isNumber(attendance.value)) {
    if (weakLevel && weakLevel.attendanceGap <= -LEVEL_ATTENDANCE_GAP) {
      push({
        title: `${weakLevel.label}da davomat kunlik nazoratga olinsin (${percent(
          weakLevel.attendanceRate,
        )}, maktab bo'yicha ${percent(attendance.value)})`,
        owner: `${weakLevel.label} sinf rahbarlari`,
        dueLabel: "Chorshanbagacha",
        priority: "high",
      });
    } else if (attendance.value < GOOD_ATTENDANCE_RATE) {
      push({
        title: `Davomat past (${percent(
          attendance.value,
        )}) — sabablari sinf rahbarlari bilan ko'rib chiqilsin`,
        owner: "Sinf rahbarlari",
        dueLabel: "Chorshanbagacha",
        priority: "high",
      });
    }
  }

  const tasks = facts.taskDiscipline;
  if (
    has("tasks") &&
    tasks &&
    isNumber(tasks.completionRate) &&
    tasks.completionRate < LOW_TASK_COMPLETION
  ) {
    const pending = isNumber(tasks.pending) ? ` (${count(tasks.pending)} yopilmagan)` : "";
    push({
      title: `Muddati o'tgan topshiriqlar yopilsin${pending}`,
      owner: "O'quv bo'limi",
      dueLabel: "Juma kunigacha",
      priority: "medium",
    });
  }

  const weakTeacher = facts.teacherOutliers?.bottom?.[0];
  if (has("teachers") && weakTeacher) {
    push({
      title: `${weakTeacher.name} bilan natijalar bo'yicha individual suhbat o'tkazilsin (KPI ${weakTeacher.score})`,
      owner: "O'quv bo'limi mudiri",
      dueLabel: "Seshanbagacha",
      priority: "medium",
    });
  }

  const coverage = facts.clubCoverage;
  if (has("clubs") && coverage && isNumber(coverage.coverage) && coverage.coverage < LOW_CLUB_COVERAGE) {
    push({
      title: `To'garak qamrovi past (${percent(
        coverage.coverage,
      )}) — qamrovsiz o'quvchilar ro'yxati tuzilsin`,
      owner: "To'garak rahbarlari",
      dueLabel: "Hafta oxirigacha",
      priority: "low",
    });
  }

  if ((facts.achievements?.total ?? 0) === 0) {
    push({
      title: "Kelgusi olimpiadalarga nomzod o'quvchilar belgilansin",
      owner: "Fan o'qituvchilari",
      dueLabel: "Hafta oxirigacha",
      priority: "low",
    });
  }

  // Ma'lumot yetishmasa — birinchi vazifa AYNAN SHUNI to'ldirish bo'ladi.
  //
  // ⚠️ `gap.task` olinadi, `gap.message` EMAS: `message` — MODELGA
  // yozilgan taqiq ("...xulosa chiqarmang"), uni direktorning haftalik
  // ro'yxatiga qo'yish unga qaratilmagan buyruqni o'qitish bo'lardi.
  for (const gap of facts.dataGaps ?? []) {
    if (actions.length >= MAX_ACTIONS) break;
    if (gap.key !== "attendance" && gap.key !== "tasks" && gap.key !== "grades") continue;
    if (!gap.task) continue;

    push({
      title: gap.task,
      owner: "O'quv bo'limi",
      dueLabel: "Juma kunigacha",
      priority: "high",
    });
  }

  if (actions.length === 0) {
    push({
      title: "Haftalik natijalar sinf rahbarlari bilan ko'rib chiqilsin",
      owner: "O'quv bo'limi",
      dueLabel: "Juma kunigacha",
      priority: "low",
    });
  }

  return actions
    .sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority))
    .slice(0, MAX_ACTIONS)
    .map((action, index) => ({ ...action, id: `rule-${index + 1}` }));
};

/**
 * Qoidalar tilida 1-2 jumlalik umumiy xulosa.
 *
 * ⚠️ Oy YORLIG'I tayyor holda keladi (`getOverview` → `formatMonthKey`) —
 * bu yerda sana formatlanmaydi va oy nomlari massivi yo'q (`dates.md` §2).
 */
const buildFallbackSummary = (facts) => {
  const label = facts.period?.monthLabel;
  const parts = [];

  const students = facts.totals?.students ?? 0;
  parts.push(`${label ? `${label} oyi: ` : ""}${count(students)} o'quvchi o'qiyapti`);

  const average = facts.metrics?.find((row) => row.key === "averageGrade");
  if (average && isNumber(average.value)) parts.push(`o'rtacha baho ${grade(average.value)}`);

  const attendance = facts.metrics?.find((row) => row.key === "attendanceRate");
  if (attendance && isNumber(attendance.value)) parts.push(`davomat ${percent(attendance.value)}`);

  const first = `${parts.join(", ")}.`;
  const weak = facts.weakCells?.[0];
  const second = weak
    ? ` Eng past natija — ${weak.level}da ${weak.subject} fanidan (${grade(weak.average)}).`
    : "";

  return `${first}${second}`;
};

/** Zaxira reja: xulosa + vazifalar (AI ishlamaganda shu ketadi). */
const buildFallbackPlan = (facts) => ({
  summary: buildFallbackSummary(facts),
  actions: buildFallbackActions(facts),
});

module.exports = {
  buildFacts,
  buildFallbackPlan,
  // Sinov va servis uchun ochiladi
  RANK_LIMIT,
  MAX_ACTIONS,
  PRIORITY_ORDER,
};
