/**
 * DAVOMAT STATISTIKASI — "UMUMIY KO'RINISH" (BARCHA FILIALLAR BIRGA).
 *
 * Bitta filial hisobotining ko'zgusi: AYNI savol tarmoq darajasida
 * beriladi — "bu oy butun tarmoqda davomat qanday, qaysi filial tushdi".
 *
 * ──────────────────────────────────────────────────────────────────────
 * NIMA UCHUN UMUMIY BIRLASHTIRUVCHIDAN O'TMAYDI (`anchor` rejimi)
 * ──────────────────────────────────────────────────────────────────────
 *
 * `studentMovementNetwork.service.js` va `taskNetwork.service.js` bilan
 * AYNI uch sabab:
 *
 *  1. FOIZ. Birlashtiruvchi har `*Percent` / `percent` kalitini filiallar
 *     bo'yicha OG'IRLIKSIZ o'rtachalaydi. 344 o'quvchili filial bilan 12
 *     o'quvchili filial teng tortsa, "tarmoq davomati" ma'nosiz raqam
 *     bo'lardi — karta esa aynan o'sha raqam uchun ochiladi.
 *  2. REYTING. "Eng ko'p qoldirgan o'quvchilar" va "eng past sinflar"
 *     ro'yxatlari QAYTA saralanishi kerak: har filialning birinchi
 *     yigirmatasi ulansa, natija tarmoq reytingi bo'lmasdi.
 *  3. WORD FAYLI. Ikkilik hujjat birlashtirilmaydi.
 *
 * Yechim: yo'l `anchor` deb belgilanadi, filial aylanishini esa shu servis
 * O'ZI bajaradi. Har filial O'Z hisobotini AYNI dvigatel bilan quradi
 * (`attendanceStats.service.js`) — ikkinchi quruvchi YO'Q — tarmoq
 * raqamlari esa KUNLAR yig'indisidan QAYTA hisoblanadi.
 *
 * ⚠️ `byDay` BIRLASHTIRILADI, jami EMAS: dinamika, hafta kunlari kesimi va
 * jami — hammasi birlashtirilgan kunlardan hosil qilinadi, ya'ni ekrandagi
 * jadvallar bir-biriga qo'shiladi (`attendanceStats.service.js` dagi
 * "byDay — kanonik birlik" qoidasi).
 */

const { mapBranches } = require("../helpers/branchIterator");
const {
  getStudentAttendanceStats,
  getTeacherAttendanceStats,
  STUDENT_FIELDS,
  TEACHER_FIELDS,
  TOP_STUDENTS,
  TOP_TEACHERS,
  bucketize,
  byWeekday,
  diffOf,
  sumDays,
  sumTeacherDays,
  emptyTeacherDay,
  finalizeTeacherDay,
} = require("./attendanceStats.service");
const {
  emptyCounts,
  addCounts,
  finalizeCounts,
} = require("./attendanceReport.service");

/**
 * Har filialda bajaradi; yiqilganini YO'QOTMAYDI, lekin JIM ham qoldirmaydi.
 *
 * ⚠️ HAMMASI yiqilgan bo'lsa — ASL xato qaytadi, bo'sh hisobot EMAS:
 * "0% davomat" degan jadval nosozlikni falokat qilib ko'rsatardi
 * (`studentMovementNetwork.service.js` bilan AYNI qoida).
 */
const runPerBranch = async (branches, fn) => {
  const results = await mapBranches(fn, { branches, label: "[Attendance]" });

  const ok = results.filter((row) => !row.error);
  if (!ok.length) throw results.find((row) => row.error).error;

  return {
    ok: ok.map((row) => ({ branch: row.branch, report: row.value })),
    partial: results.filter((row) => row.error).map((row) => row.branch.name),
  };
};

const tagOf = (branch) => ({ branchId: branch.id, branchName: branch.name });

/**
 * OLDINGI DAVRNING O'QUV KUNLARI — filiallar bo'ylab BIRLASHMA.
 *
 * ⚠️ Qo'shilmaydi: 15-oktabr ikki filialda ham o'quv kuni bo'lsa, u
 * tarmoq uchun BITTA kun. Qo'shilsa "o'tgan oyda 40 o'quv kuni bo'lgan"
 * degan yozuv chiqardi. Joriy davrda bu tekin keladi (kunlar kalit
 * bo'yicha birlashtiriladi), oldingi davrda esa faqat kalitlar saqlanadi.
 */
const unionDays = (reports) =>
  new Set(reports.flatMap(({ report }) => report.previousDayKeys ?? [])).size;

/** Filial qatorlarini bitta ro'yxatga ulaydi (har qatorga filial belgisi bilan). */
const tagged = (reports, pick) =>
  reports.flatMap(({ branch, report }) =>
    (pick(report) ?? []).map((item) => ({ ...item, ...tagOf(branch) })),
  );

/**
 * KUNLAR BO'YICHA BIRLASHTIRISH.
 *
 * ⚠️ KALIT BO'YICHA, indeks bo'yicha EMAS: filiallarda o'quv kunlari
 * (bayram, ta'til, jadval) har xil bo'lishi mumkin va indeksga tayangan
 * kod 15-oktabrni 16-oktabr bilan qo'shib yuborardi.
 */
const mergeDays = (reports, { fields, finalize, blank }) => {
  const map = new Map();

  for (const { report } of reports) {
    for (const day of report.byDay) {
      if (!map.has(day.date)) map.set(day.date, blank(day.date));
      const row = map.get(day.date);
      for (const field of fields) row[field] += day[field] ?? 0;
    }
  }

  return [...map.values()].map(finalize).sort((a, b) => a.date.localeCompare(b.date));
};

const STUDENT_DAY_FIELDS = ["expected", "present", "late", "absent", "excused", "total"];

const blankStudentDay = (date) => ({ date, ...emptyCounts() });

/**
 * FILIALLAR KESIMI — "qaysi filialda davomat past".
 *
 * ⚠️ Tarmoq jamisi savolning faqat yarmiga javob beradi: 94% ning
 * orqasida bitta filial 98%, boshqasi 86% bo'lishi mumkin va qaror aynan
 * shu farqga qarab qabul qilinadi. Foiz bo'yicha O'SISH tartibida: eng
 * muammolisi birinchi turadi.
 */
const branchRows = (reports) =>
  reports
    .map(({ branch, report }) => ({
      ...tagOf(branch),
      schoolDays: report.totals.schoolDays,
      expected: report.totals.expected,
      came: report.totals.came,
      late: report.totals.late,
      absent: report.totals.absent,
      excused: report.totals.excused,
      unmarked: report.totals.unmarked,
      percent: report.totals.percent,
      previousPercent: report.previous.percent,
      percentPoints: report.change.percentPoints,
    }))
    .sort(
      (a, b) =>
        (a.percent ?? 101) - (b.percent ?? 101) ||
        a.branchName.localeCompare(b.branchName, "uz"),
    );

const shell = (reports, partial, first) => ({
  period: first.period,
  branch: null,
  isNetwork: true,
  branches: reports.map(({ branch }) => ({ id: branch.id, name: branch.name })),
  partial,
  generatedAt: new Date(),
});

/* ──────────────────────── O'QUVCHILAR DAVOMATI ──────────────────────── */

const getNetworkStudentStats = async (query = {}, branches = [], options = {}) => {
  const { detail = true } = options;

  const { ok, partial } = await runPerBranch(branches, () =>
    getStudentAttendanceStats(query, { detail }),
  );

  return combineStudentReports({ reports: ok, partial });
};

/**
 * ⚠️ SOF FUNKSIYA — bazaga ham, filial kontekstiga ham tegmaydi.
 * Birlashtirish qoidalari (foiz yig'indidan, reyting qayta saralanadi,
 * kunlar kalit bo'yicha) aynan shu yerda sinovdan o'tadi.
 *
 * @param {{reports: Array<{branch: object, report: object}>, partial: string[]}} input
 */
const combineStudentReports = ({ reports: ok, partial = [] }) => {
  const first = ok[0].report;
  const range = first.period;

  const days = mergeDays(ok, {
    fields: STUDENT_DAY_FIELDS,
    finalize: finalizeCounts,
    blank: blankStudentDay,
  });

  const previous = ok.reduce(
    (acc, { report }) => addCounts(acc, report.previous),
    emptyCounts(),
  );
  finalizeCounts(previous);
  previous.schoolDays = unionDays(ok);

  const totals = sumDays(days);

  return {
    kind: "students",
    ...shell(ok, partial, first),
    totals,
    previous,
    change: diffOf(totals, previous, ["expected", "came", "absent", "excused", "schoolDays"]),
    byDay: days,
    trend: bucketize(days, range, STUDENT_FIELDS),
    weekday: byWeekday(days, STUDENT_FIELDS),
    byBranch: branchRows(ok),
    // ⚠️ QAYTA SARALANADI: har filialning ro'yxati o'z ichida saralangan,
    // tarmoq ro'yxati esa butun tarmoq bo'yicha eng muammolisini bermasa
    // "eng ko'p qoldirganlar" degan sarlavha yolg'on bo'lardi.
    classes: tagged(ok, (r) => r.classes).sort(
      (a, b) =>
        (a.percent ?? 101) - (b.percent ?? 101) ||
        a.branchName.localeCompare(b.branchName, "uz") ||
        a.className.localeCompare(b.className, "uz"),
    ),
    students: tagged(ok, (r) => r.students)
      .sort(
        (a, b) =>
          b.expected - b.came - (a.expected - a.came) ||
          (a.percent ?? 101) - (b.percent ?? 101),
      )
      .slice(0, TOP_STUDENTS),
  };
};

/* ─────────────────────── O'QITUVCHILAR DAVOMATI ─────────────────────── */

/**
 * ⚠️ BO'SH QATOR DVIGATELDAN OLINADI (`emptyTeacherDay`), nusxa EMAS:
 * yangi sanoqchi qo'shilganda (masalan "ishda bo'lgan vaqt") bu yerdagi
 * nusxa eskirib, `undefined + son = NaN` bo'lib ketardi — jadval esa
 * "NaN" o'rniga bo'sh katak ko'rsatib, jim xato bo'lib qolardi.
 */
const blankTeacherDay = (date) => emptyTeacherDay(date);

/**
 * JONLI BLOK — "hozir dars bo'lyapti, o'qituvchi yo'q".
 *
 * ⚠️ `closed` (yakshanba / bayram / ta'til) FAQAT HAMMA FILIALDA bir xil
 * bo'lsa qoladi: bayram bitta filialda bo'lishi mumkin va "dars yo'q"
 * degan yozuv butun tarmoq uchun yolg'on bo'lib chiqardi.
 */
const mergeLive = (reports) => {
  const items = reports.map(({ branch, report }) => ({ branch, live: report.live }));
  if (items.every((item) => !item.live)) return null;

  const present = items.filter((item) => item.live);
  const first = present[0].live;
  const closedValues = new Set(present.map((item) => item.live.closed ?? null));
  const closed = closedValues.size === 1 ? first.closed : null;

  const summary = present.reduce(
    (acc, item) => {
      for (const key of Object.keys(acc)) acc[key] += item.live.summary?.[key] ?? 0;
      return acc;
    },
    {
      teachers: 0,
      lessons: 0,
      ongoingLessons: 0,
      absentTeachers: 0,
      lateTeachers: 0,
      untimedLessons: 0,
    },
  );

  return {
    date: first.date,
    dateLabel: first.dateLabel,
    nowLabel: first.nowLabel,
    closed,
    message: closed ? first.message : null,
    summary,
    teachers: present.flatMap(({ branch, live }) =>
      (live.teachers ?? []).map((row) => ({ ...row, ...tagOf(branch) })),
    ),
  };
};

const getNetworkTeacherStats = async (query = {}, branches = [], options = {}) => {
  const { detail = true } = options;

  const { ok, partial } = await runPerBranch(branches, () =>
    getTeacherAttendanceStats(query, { detail }),
  );

  return combineTeacherReports({ reports: ok, partial });
};

/** ⚠️ SOF FUNKSIYA (`combineStudentReports` bilan AYNI sabab). */
const combineTeacherReports = ({ reports: ok, partial = [] }) => {
  const first = ok[0].report;
  const range = first.period;

  const days = mergeDays(ok, {
    fields: TEACHER_FIELDS,
    finalize: finalizeTeacherDay,
    blank: blankTeacherDay,
  });

  const totals = sumTeacherDays(days);

  const previous = blankTeacherDay(null);
  for (const { report } of ok) {
    for (const field of TEACHER_FIELDS) previous[field] += report.previous[field] ?? 0;
  }
  finalizeTeacherDay(previous);
  delete previous.date;
  previous.schoolDays = unionDays(ok);
  previous.avgLateMinutes = previous.late
    ? Math.round(previous.lateMinutes / previous.late)
    : 0;
  previous.avgWorkedMinutes = previous.timedDays
    ? Math.round(previous.workedMinutes / previous.timedDays)
    : 0;

  return {
    kind: "teachers",
    ...shell(ok, partial, first),
    staffCount: ok.reduce((sum, { report }) => sum + report.staffCount, 0),
    totals,
    previous,
    change: diffOf(totals, previous, ["expected", "came", "late", "absent", "excused", "schoolDays"]),
    byDay: days,
    trend: bucketize(days, range, TEACHER_FIELDS),
    weekday: byWeekday(days, TEACHER_FIELDS),
    byBranch: branchRows(ok),
    teachers: tagged(ok, (r) => r.teachers)
      .sort(
        (a, b) =>
          (a.percent ?? 101) - (b.percent ?? 101) ||
          b.lateMinutes - a.lateMinutes ||
          a.name.localeCompare(b.name, "uz"),
      )
      .slice(0, TOP_TEACHERS),
    live: mergeLive(ok),
  };
};

module.exports = {
  getNetworkStudentStats,
  getNetworkTeacherStats,
  combineStudentReports,
  combineTeacherReports,
  mergeDays,
  mergeLive,
  branchRows,
  STUDENT_DAY_FIELDS,
  blankStudentDay,
  blankTeacherDay,
};
