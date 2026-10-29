/**
 * BOT FOYDALANUVCHILARI — "UMUMIY KO'RINISH" (BARCHA FILIALLAR BIRGA).
 *
 * Bitta filial hisobotining ko'zgusi: AYNI savol tarmoq darajasida —
 * "butun tarmoqda nechta ota-ona ulangan, qaysi filialda qamrov past".
 *
 * ──────────────────────────────────────────────────────────────────────
 * NIMA UCHUN UMUMIY BIRLASHTIRUVCHIDAN O'TMAYDI (`anchor` rejimi)
 * ──────────────────────────────────────────────────────────────────────
 *
 * `attendanceStatsNetwork.service.js` bilan AYNI uch sabab:
 *
 *  1. FOIZ. Birlashtiruvchi foizni filiallar bo'yicha OG'IRLIKSIZ
 *     o'rtachalaydi: 344 o'quvchili filial bilan 12 o'quvchili filial
 *     teng tortsa, "tarmoq qamrovi" ma'nosiz raqam bo'lardi.
 *  2. REYTING. Sinflar ro'yxati butun tarmoq bo'yicha QAYTA saralanishi
 *     kerak — har filialning eng pasti ketma-ket ulansa, bu reyting
 *     bo'lmasdi.
 *  3. WORD FAYLI. Ikkilik hujjat birlashtirilmaydi.
 *
 * ⚠️ OTA-ONA IKKI FILIALDA BO'LISHI MUMKIN (bolalari boshqa-boshqa
 * filialda o'qiydi) va `telegram_id` filial ichida yagona. Shuning uchun
 * "bog'langan hisoblar" QO'SHILADI: bu "nechta bog'lanish bor" degan
 * savol, "nechta odam" degan emas — `user.service.js` dagi xodim
 * sanoqchisidan farqi aynan shunda va u hujjatda ochiq yoziladi.
 */

const { mapBranches } = require("../helpers/branchIterator");
const { getBotReport, rate, TOP_UNLINKED, TOP_SILENT } = require("./botReport.service");

/**
 * Har filialda bajaradi; yiqilganini YO'QOTMAYDI, lekin JIM ham qoldirmaydi.
 *
 * ⚠️ HAMMASI yiqilgan bo'lsa — ASL xato qaytadi, bo'sh hisobot EMAS:
 * "0 ta bog'lanish" degan jadval nosozlikni falokat qilib ko'rsatardi.
 */
const runPerBranch = async (branches, fn) => {
  const results = await mapBranches(fn, { branches, label: "[BotReport]" });

  const ok = results.filter((row) => !row.error);
  if (!ok.length) throw results.find((row) => row.error).error;

  return {
    ok: ok.map((row) => ({ branch: row.branch, report: row.value })),
    partial: results.filter((row) => row.error).map((row) => row.branch.name),
  };
};

const tagOf = (branch) => ({ branchId: branch.id, branchName: branch.name });

const tagged = (reports, pick) =>
  reports.flatMap(({ branch, report }) =>
    (pick(report) ?? []).map((item) => ({ ...item, ...tagOf(branch) })),
  );

const sumOf = (reports, pick) =>
  reports.reduce((total, { report }) => total + (pick(report) ?? 0), 0);

/**
 * DINAMIKA — bo'laklar KALIT bo'yicha birlashtiriladi.
 *
 * ⚠️ Indeks bo'yicha EMAS: davr har filialda bir xil so'ralsa ham,
 * tartibga tayangan kod keyingi o'zgarishda jimgina boshqa kunni
 * qo'shib yuborardi.
 */
const mergeTrend = (reports) => {
  const map = new Map();

  for (const { report } of reports) {
    for (const row of report.trend) {
      if (!map.has(row.day)) map.set(row.day, { ...row, bot: 0 });
      map.get(row.day).bot += row.bot ?? 0;
    }
  }

  return [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
};

/**
 * FILIALLAR KESIMI — "qaysi filialda qamrov past".
 *
 * ⚠️ Tarmoq jamisi savolning faqat yarmiga javob beradi: 42% ning
 * orqasida bitta filial 95%, boshqasi 10% bo'lishi mumkin va ish aynan
 * o'sha filialda bajariladi. Qamrov foizi bo'yicha O'SISH tartibida.
 */
const branchRows = (reports) =>
  reports
    .map(({ branch, report }) => ({
      ...tagOf(branch),
      students: report.totals.students,
      linked: report.totals.linked,
      linkedStudents: report.totals.linkedStudents,
      unlinked: report.totals.unlinked,
      coverage: report.totals.coverage,
      todayActive: report.totals.todayActive,
      activeInPeriod: report.totals.activeInPeriod,
      notificationsOff: report.totals.notificationsOff,
    }))
    .sort(
      (a, b) =>
        (a.coverage ?? 101) - (b.coverage ?? 101) ||
        a.branchName.localeCompare(b.branchName, "uz"),
    );

/**
 * ⚠️ SOF FUNKSIYA — bazaga ham, filial kontekstiga ham tegmaydi:
 * birlashtirish qoidalari (foiz yig'indidan, reyting qayta saralanadi,
 * kunlar kalit bo'yicha) aynan shu yerda sinovdan o'tadi.
 */
const combineBotReports = ({ reports: ok, partial = [] }) => {
  const first = ok[0].report;

  const sum = (pick) => sumOf(ok, pick);

  const students = sum((r) => r.totals.students);
  const linked = sum((r) => r.totals.linked);
  const linkedStudents = sum((r) => r.totals.linkedStudents);
  const todayActive = sum((r) => r.totals.todayActive);
  const activeInPeriod = sum((r) => r.totals.activeInPeriod);

  const totals = {
    linked,
    students,
    linkedStudents,
    unlinked: sum((r) => r.totals.unlinked),
    coverage: rate(linkedStudents, students),
    todayActive,
    todayRate: rate(todayActive, linked),
    activeInPeriod,
    activeRate: rate(activeInPeriod, linked),
    silent: sum((r) => r.totals.silent),
    notificationsOff: sum((r) => r.totals.notificationsOff),
    newLinks: sum((r) => r.totals.newLinks),
  };

  const broadcastTotal = sum((r) => r.delivery?.broadcast?.total ?? 0);
  const broadcastSent = sum((r) => r.delivery?.broadcast?.sent ?? 0);
  const reportsSent = sum((r) => r.delivery?.reports?.sent ?? 0);
  const reportsFailed = sum((r) => r.delivery?.reports?.failed ?? 0);

  return {
    kind: "bot",
    period: first.period,
    branch: null,
    isNetwork: true,
    branches: ok.map(({ branch }) => ({ id: branch.id, name: branch.name })),
    partial,
    generatedAt: new Date(),
    // Birorta filialda tarix yig'ilmagan bo'lsa ham buni aytamiz
    collecting: ok.some(({ report }) => report.collecting),
    sinceLabel: first.sinceLabel,
    todayLabel: first.todayLabel,
    withRoster: ok.every(({ report }) => report.withRoster),
    totals,
    trend: mergeTrend(ok),
    byBranch: branchRows(ok),
    // ⚠️ QAYTA SARALANADI: har filialning ro'yxati o'z ichida saralangan,
    // tarmoq ro'yxati esa butun tarmoq bo'yicha eng past qamrovni bermasa
    // "qaysi sinfda qolib ketgan" degan savolga javob bo'lmasdi.
    classes: tagged(ok, (r) => r.classes).sort(
      (a, b) =>
        (a.rate ?? 101) - (b.rate ?? 101) ||
        b.students - a.students ||
        a.branchName.localeCompare(b.branchName, "uz"),
    ),
    unlinkedStudents: tagged(ok, (r) => r.unlinkedStudents)
      .sort(
        (a, b) =>
          a.branchName.localeCompare(b.branchName, "uz") ||
          a.className.localeCompare(b.className, "uz") ||
          a.name.localeCompare(b.name, "uz"),
      )
      .slice(0, TOP_UNLINKED),
    unlinkedTotal: sum((r) => r.unlinkedTotal),
    silentParents: tagged(ok, (r) => r.silentParents)
      .sort((a, b) => (b.daysSince ?? 9999) - (a.daysSince ?? 9999))
      .slice(0, TOP_SILENT),
    silentTotal: sum((r) => r.silentTotal),
    delivery: {
      broadcast: {
        total: broadcastTotal,
        sent: broadcastSent,
        failed: sum((r) => r.delivery?.broadcast?.failed ?? 0),
        pending: sum((r) => r.delivery?.broadcast?.pending ?? 0),
        cancelled: sum((r) => r.delivery?.broadcast?.cancelled ?? 0),
        rate: rate(broadcastSent, broadcastTotal),
      },
      reports: {
        sent: reportsSent,
        failed: reportsFailed,
        rate: rate(reportsSent, reportsSent + reportsFailed),
      },
    },
  };
};

const getNetworkBotReport = async (query = {}, branches = [], options = {}) => {
  const { ok, partial } = await runPerBranch(branches, () =>
    getBotReport(query, options),
  );

  return combineBotReports({ reports: ok, partial });
};

module.exports = { getNetworkBotReport, combineBotReports, mergeTrend, branchRows };
