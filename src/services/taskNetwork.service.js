/**
 * XODIMLAR TOPSHIRIQLARI — "UMUMIY KO'RINISH" (BARCHA FILIALLAR BIRGA).
 *
 * Bu hisobot FAQAT almashtirgichdagi "Umumiy — barcha filiallar" rejimida
 * ochiladi (biznes qarori, 2026-10-27), ya'ni faqat tizim egasida: savol
 * ham aynan tarmoq darajasida beriladi — "bu oy butun tarmoqda nechta
 * topshiriq berildi, qanchasi bajarildi, qaysi filialda ish qolib
 * ketyapti". Bitta filial ichida bunday savol allaqachon javobga ega
 * (Lavozimlar markazi → Dashboard va Hisobotlar), shuning uchun u yerda
 * bo'lim UMUMAN ko'rsatilmaydi (`task.controller.js` darvozasi).
 *
 * ──────────────────────────────────────────────────────────────────────
 * NIMA UCHUN UMUMIY BIRLASHTIRUVCHIDAN O'TMAYDI (`anchor` rejimi)
 * ──────────────────────────────────────────────────────────────────────
 *
 * `studentMovementNetwork.service.js` va `studentSystemNetwork.service.js`
 * bilan AYNI uch sabab:
 *
 *  1. FOIZ. Birlashtiruvchi foizni filiallar bo'yicha OG'IRLIKSIZ
 *     o'rtachalaydi. 400 topshiriqli filial bilan 3 topshiriqli filial
 *     teng hissa qo'shsa, "tarmoqda ish qanday bajarilyapti" degan raqam
 *     ma'nosiz bo'lardi — hujjat esa aynan o'sha raqam uchun ochiladi.
 *  2. REYTING. "Yetakchilar" va "e'tibor talab qiladiganlar" — SARALANGAN
 *     ro'yxat. Har filialning birinchi beshtasini ulab qo'yish tarmoq
 *     beshtaligini bermaydi: ular qayta saralanishi shart.
 *  3. WORD FAYLI. Ikkilik hujjat birlashtirilmaydi: yo'l `unsupported`
 *     bo'lsa, umumiy ko'rinishda tugma O'CHIQ bo'lib qolardi.
 *
 * Yechim: yo'l `anchor` deb belgilanadi (birlashtiruvchi TEGMAYDI), filial
 * aylanishini esa shu servis O'ZI bajaradi. Har filial O'Z hisobotini AYNI
 * `getTaskReport` bilan quradi — ikkinchi dvigatel YO'Q — tarmoq raqamlari
 * esa yig'indidan QAYTA hisoblanadi, reytinglar esa `taskReport.service.js`
 * dagi AYNI funksiyalar bilan qayta tanlanadi.
 *
 * ⚠️ NATIJA SHAKLI BITTALIK HISOBOT BILAN BIR XIL — ekran ham, Word
 * quruvchisi ham qo'shimcha shoxlanishsiz ishlaydi; ustiga faqat
 * `byBranch` (filiallar kesimi) va har qatordagi `branchName` qo'shiladi.
 *
 * ⚠️ DOIRA (`scope`) BERILMAYDI va bu ATAYLAB: umumiy ko'rinish faqat
 * tizim egasida ochiladi (`aggregateScope.service.js`), unda esa doira
 * har doim "hammasi". Bo'lim rahbarining doirasi filialga bog'liq (bo'lim
 * a'zolari har filialda boshqa) — uni filiallar bo'ylab ko'chirish jim
 * xato bo'lardi.
 *
 * ⚠️ OQIM — RAHBAR BERGAN TOPSHIRIQLAR (`selfAssigned: false`). Xodim
 * o'ziga o'zi belgilagan ishlar jarimasiz va o'zi yopiladi: aralashsa,
 * tarmoqning intizom foizi jimgina ko'tarilib ketardi (`task.service.js`
 * dagi AYNI qoida).
 */

const { mapBranches } = require("../helpers/branchIterator");
const { getRoleOptions } = require("./role.service");
const {
  getTaskReport,
  getTaskPulse,
  rate,
  pickLeaders,
  pickAttention,
  groupByRole,
  pickCreators,
  LIVE_LIMIT,
} = require("./taskReport.service");

/** Tarmoq hisobotida oqim qat'iy: rahbar bergan topshiriqlar. */
const FLOW = { selfAssigned: false };

/**
 * Har filialda bajaradi; yiqilganini YO'QOTMAYDI, lekin JIM ham qoldirmaydi.
 *
 * ⚠️ HAMMASI yiqilgan bo'lsa — ASL xato qaytadi, bo'sh hisobot EMAS:
 * "0 topshiriq, 0 muddati o'tgan" degan jadval nosozlikni muvaffaqiyat
 * qilib ko'rsatardi (`studentMovementNetwork.service.js` bilan AYNI qoida).
 * Bir qismi yiqilsa, qolgani ko'rsatiladi va qaysi filial tushib qolgani
 * `partial` da ochiq turadi — ekranda ham, hujjatda ham.
 *
 * @param {object[]} branches
 * @param {() => Promise<any>} fn - filial konteksti ichida chaqiriladi
 * @returns {Promise<{ok: Array<{branch: object, value: any}>, partial: string[]}>}
 */
const runPerBranch = async (branches, fn) => {
  const results = await mapBranches(fn, { branches, label: "[Tasks]" });

  const ok = results.filter((row) => !row.error);
  const failed = results.filter((row) => row.error);

  if (!ok.length) throw failed[0].error;

  return { ok, partial: failed.map((row) => row.branch.name) };
};

/** Filialning hisobotdagi qisqa shakli (panel `BranchSplit` ham shuni oladi). */
const branchTag = (branch) => ({
  branchId: branch.id,
  branchName: branch.name,
  branchShortName: branch.shortName || branch.name,
});

const sumOf = (items, pick) =>
  items.reduce((acc, item) => acc + (Number(pick(item)) || 0), 0);

/**
 * OG'IRLIKLI O'RTACHA — "tarmoqda bitta topshiriq o'rtacha qancha vaqtda
 * bajarildi".
 *
 * ⚠️ Oddiy o'rtacha YARAMAYDI: 3 ta topshirig'i bor filialning o'rtachasi
 * 400 ta topshirig'i bor filialniki bilan teng vazn olardi. Maxraj —
 * o'rtachaning O'Z namunalar soni (`completionSamples` / `reviewSamples`),
 * shuning uchun natija haqiqiy o'rtachaga teng.
 *
 * ⚠️ Filial o'rtachasi butun daqiqagacha yaxlitlangani uchun natijada
 * BIR DAQIQADAN KAM yaxlitlash farqi bo'lishi mumkin — ko'rsatkich soatda
 * o'qilgani uchun bu sezilmaydi.
 */
const weightedAvg = (items, pickValue, pickWeight) => {
  let sum = 0;
  let weight = 0;

  for (const item of items) {
    const value = pickValue(item);
    const w = Number(pickWeight(item)) || 0;
    if (value == null || w <= 0) continue;
    sum += Number(value) * w;
    weight += w;
  }

  return weight > 0 ? Math.round(sum / weight) : null;
};

/**
 * Kalitli qatorlarni QO'SHADI (dinamika, hafta kunlari, topshiriq turlari).
 *
 * ⚠️ Tartib BIRINCHI filialning tartibidan olinadi: davr hamma filialda
 * bir xil, ya'ni kalitlar ham bir xil — lekin tartibga tayanadigan kod
 * (indeks bo'yicha qo'shish) keyingi o'zgarishda jimgina boshqa kunni
 * qo'shib yuborardi.
 */
const mergeKeyed = (lists, keyOf, fields) => {
  const merged = new Map();

  for (const list of lists) {
    for (const row of list || []) {
      const key = keyOf(row);
      const known = merged.get(key);

      if (!known) {
        merged.set(key, { ...row });
        continue;
      }

      for (const field of fields) {
        known[field] = (known[field] || 0) + (row[field] || 0);
      }
    }
  }

  return [...merged.values()];
};

/** Ism bo'yicha o'zbekcha tartib (hujjatdagi ro'yxatlar uchun). */
const collator = new Intl.Collator("uz", { numeric: true, sensitivity: "base" });

const byBranchThenName = (a, b) =>
  collator.compare(a.branchName || "", b.branchName || "") ||
  collator.compare(a.name || "", b.name || "");

/**
 * BUTUN TARMOQ BO'YICHA HISOBOT.
 *
 * @param {object} query - `period` (day|week|month|year) yoki `from`+`to`
 * @param {object[]} branches - `req.aggregateScope.branches`
 */
const getNetworkTaskReport = async (query = {}, branches = []) => {
  const { ok, partial } = await runPerBranch(branches, () =>
    getTaskReport({
      period: query.period,
      from: query.from,
      to: query.to,
      ...FLOW,
      // Reytinglar (yetakchilar, e'tibor, rollar, topshiriq beruvchilar)
      // kerak: yo'l `tasks.reports` ortida turibdi.
      full: true,
    }),
  );

  // ⚠️ ROL NOMI SERVERDAN. Rollar PLATFORMADA va hamma filialda AYNI
  // (`CLAUDE.md` — katalog modellari), shuning uchun bir marta o'qiladi.
  // Panel uni o'zi qidirsa, hujjatning ekrandagi nusxasi bilan Word
  // nusxasida ikki xil nom turishi mumkin edi (rol o'chirilgan bo'lsa
  // biri kalitni, ikkinchisi nomni ko'rsatardi).
  const roles = await getRoleOptions();

  return combineReports({
    reports: ok.map((row) => ({ branch: row.branch, report: row.value })),
    partial,
    roles,
  });
};

/**
 * FILIAL HISOBOTLARINI BITTA TARMOQ HISOBOTIGA BIRLASHTIRADI.
 *
 * ⚠️ SOF FUNKSIYA va bu ataylab: butun hisobotning ishonchi shu yerdagi
 * arifmetikaga tayanadi (foiz YIG'INDIDAN, o'rtacha OG'IRLIK bilan,
 * reyting QAYTA saralanib), shuning uchun u bazasiz sinaladi —
 * `test/taskNetwork.test.js`.
 *
 * @param {{reports: Array<{branch: object, report: object}>,
 *          partial?: string[],
 *          roles?: Array<{value: string, name: string}>}} input
 */
const combineReports = ({ reports, partial = [], roles = [] }) => {
  const roleName = (value) => {
    if (!value) return "Noma'lum";
    if (value === "owner") return "Ega";
    return roles.find((role) => role.value === value)?.name || value;
  };

  const all = reports.map(({ report }) => report);
  const first = all[0];

  // ── Ijrochilar: HAR FILIAL QATORI ALOHIDA ──
  //
  // ⚠️ BIR ODAMNING IKKI FILIALDAGI ISHI QO'SHILMAYDI. Topshiriq filialga
  // tegishli: uni kim bergan, kim tekshirgan va jarimasi qaysi filialda
  // yozilgani — hammasi o'sha filialniki. Qo'shib yuborilsa, "MBSI da
  // 12 tadan 11 tasini bajardi" degan fakt yo'qolib, o'rniga hech qaysi
  // rahbar tanimaydigan aralash qator qolardi (`aggregateMerge` dagi
  // "guruh kaliti birlashtirilmaydi" qoidasi bilan AYNI sabab).
  const people = reports
    .flatMap(({ branch, report }) =>
      report.people.map((row) => ({
        ...row,
        ...branchTag(branch),
        roleName: roleName(row.role),
      })),
    )
    .sort((a, b) => b.assigned - a.assigned || byBranchThenName(a, b));

  const creators = reports
    .flatMap(({ branch, report }) =>
      report.creators.map((row) => ({ ...row, ...branchTag(branch) })),
    )
    .sort((a, b) => b.created - a.created || byBranchThenName(a, b));

  // ── KPI: sanoqchilar qo'shiladi, foiz va o'rtacha QAYTA hisoblanadi ──
  const kpiKeys = [
    "total",
    "completed",
    "inProgress",
    "review",
    "stopped",
    "overdue",
    "rejected",
    "extended",
    "penalized",
    "penaltyPoints",
    "completionSamples",
    "reviewSamples",
  ];

  const kpis = Object.fromEntries(
    kpiKeys.map((key) => [key, sumOf(all, (report) => report.kpis[key])]),
  );

  const timing = {
    early: sumOf(all, (report) => report.timing.early),
    lastDay: sumOf(all, (report) => report.timing.lastDay),
    late: sumOf(all, (report) => report.timing.late),
  };

  const onTimeBase = timing.early + timing.lastDay + timing.late;

  // ⚠️ IJROCHILAR SONI — TAKRORSIZ. Ikki filialda ishlaydigan xodim bitta
  // odam: `kpis.assignees` ni qo'shib yuborilsa, u "ikki xodim" bo'lib
  // ko'rinardi (`user.controller.js` → `getStats` bilan AYNI qaror).
  // Jadvaldagi qatorlar esa baribir filial bo'yicha ajratilgan va buning
  // sababi hisobotda ochiq yoziladi.
  const assignees = new Set(people.map((row) => row.userId)).size;

  const kinds = mergeKeyed(
    all.map((report) => report.kinds),
    (row) => row.key,
    ["total", "completed", "overdue", "inProgress", "review", "stopped"],
  ).map((row) => ({ ...row, rate: rate(row.completed, row.total - row.stopped) }));

  const previousTotal = sumOf(all, (report) => report.previous.total);
  const previousCompleted = sumOf(all, (report) => report.previous.completed);
  const previousStopped = sumOf(all, (report) => report.previous.stopped);

  // ── Jonli ro'yxatlar: ulanadi, qayta saralanadi va qayta kesiladi ──
  const liveList = (key, sort) =>
    reports
      .flatMap(({ branch, report }) =>
        report.live[key].map((row) => ({ ...row, ...branchTag(branch) })),
      )
      .sort(sort)
      .slice(0, LIVE_LIMIT);

  const byDueDate = (a, b) => new Date(a.dueDate) - new Date(b.dueDate);
  const bySubmitted = (a, b) =>
    new Date(a.submittedAt || a.dueDate) - new Date(b.submittedAt || b.dueDate);

  /**
   * FILIALLAR KESIMI — "qaysi filialda ish qolib ketyapti".
   *
   * Tarmoq jamisi savolning faqat yarmiga javob beradi: "28 ta muddati
   * o'tgan" ning hammasi bitta filialda bo'lishi mumkin va qaror aynan
   * o'sha filialda qabul qilinadi.
   *
   * ⚠️ Muddati o'tganlar bo'yicha kamayish tartibida: ro'yxat yuqoridan
   * o'qiladi va eng ko'p ish qolgan filial birinchi turadi.
   */
  const byBranch = reports
    .map(({ branch, report }) => ({
      ...branchTag(branch),
      total: report.kpis.total,
      completed: report.kpis.completed,
      inProgress: report.kpis.inProgress,
      review: report.kpis.review,
      overdue: report.kpis.overdue,
      stopped: report.kpis.stopped,
      penaltyPoints: report.kpis.penaltyPoints,
      assignees: report.kpis.assignees,
      completionRate: report.kpis.completionRate,
      onTimeRate: report.kpis.onTimeRate,
      // Jonli holat — davrga bog'liq EMAS (hozir qancha ish qolgan)
      liveOverdue: report.live.counts.overdue,
      liveReview: report.live.counts.review,
    }))
    .sort(
      (a, b) =>
        b.overdue - a.overdue ||
        b.total - a.total ||
        collator.compare(a.branchName, b.branchName),
    );

  return {
    isNetwork: true,
    // ⚠️ `branch: null` — bitta filialniki emas. Hujjat sarlavhasi shunga
    // qarab "BARCHA FILIALLAR" ni yozadi: langar filialning nomi qolsa,
    // tarmoq ma'lumoti bitta filial nomi bilan sarlavhalanardi.
    branch: null,
    branches: reports.map(({ branch }) => ({ id: branch.id, name: branch.name })),
    partial,
    // Davr hamma filialda AYNI (so'rovdan hisoblanadi, ma'lumotdan emas)
    period: first.period,
    kpis: {
      ...kpis,
      assignees,
      completionRate: rate(kpis.completed, kpis.total - kpis.stopped),
      onTimeRate: rate(timing.early + timing.lastDay, onTimeBase),
      avgCompletionMinutes: weightedAvg(
        all,
        (report) => report.kpis.avgCompletionMinutes,
        (report) => report.kpis.completionSamples,
      ),
      avgReviewMinutes: weightedAvg(
        all,
        (report) => report.kpis.avgReviewMinutes,
        (report) => report.kpis.reviewSamples,
      ),
    },
    previous: {
      total: previousTotal,
      completed: previousCompleted,
      // Foiz YIG'INDIDAN qayta hisoblanadi — joriy davr bilan AYNI
      // formula (to'xtatilgani maxrajdan chiqariladi).
      completionRate: rate(previousCompleted, previousTotal - previousStopped),
    },
    // FILIALLAR KESIMI — hujjatdagi jadval va kartadagi `BranchSplit`
    // ikkalasi ham shu ro'yxatdan oziqlanadi.
    byBranch,
    breakdown: [
      { key: "completed", value: kpis.completed },
      { key: "review", value: kpis.review },
      { key: "inProgress", value: kpis.inProgress },
      { key: "overdue", value: kpis.overdue },
      { key: "stopped", value: kpis.stopped },
    ],
    timing,
    kinds,
    trend: mergeKeyed(
      all.map((report) => report.trend),
      (row) => row.key,
      ["created", "completed"],
    ),
    weekday: mergeKeyed(
      all.map((report) => report.weekday),
      (row) => row.index,
      ["created", "completed"],
    ).sort((a, b) => a.index - b.index),
    people,
    // ⚠️ REYTING QAYTA TANLANADI, ulanmaydi: har filialning birinchi
    // beshtasini ketma-ket qo'yish tarmoq beshtaligini bermaydi.
    // Qoidalar `taskReport.service.js` dagi AYNI funksiyalardan.
    leaders: pickLeaders(people),
    attention: pickAttention(people),
    byRole: groupByRole(people).map((row) => ({
      ...row,
      roleName: roleName(row.role === "unknown" ? null : row.role),
    })),
    creators: pickCreators(creators),
    live: {
      overdue: liveList("overdue", byDueDate),
      dueSoon: liveList("dueSoon", byDueDate),
      review: liveList("review", bySubmitted),
      counts: {
        overdue: sumOf(all, (report) => report.live.counts.overdue),
        dueSoon: sumOf(all, (report) => report.live.counts.dueSoon),
        review: sumOf(all, (report) => report.live.counts.review),
      },
      // ⚠️ "Muddati yaqin" chegarasi — SOZLAMA, sanoq emas: qo'shilmaydi.
      // Filiallarda boshqacha bo'lsa eng kattasi olinadi, ya'ni ro'yxatga
      // tushgan topshiriqlarning hammasi yorliqqa to'g'ri keladi.
      dueSoonHours: Math.max(...all.map((report) => report.live.dueSoonHours || 0)),
    },
    generatedAt: new Date(),
  };
};

/**
 * BOSH SAHIFA KARTASI — butun tarmoq bo'yicha tanlangan davr.
 *
 * ⚠️ Foiz bu yerda ham YIG'INDIDAN qayta hisoblanadi: kartadagi raqam
 * hujjatdagi raqam bilan bir xil formuladan chiqishi shart, aks holda
 * kartaga ishonch yo'qolardi.
 *
 * ⚠️ `byBranch` — kartaning ostidagi filiallar kesimi. Uni umumiy
 * birlashtiruvchi bermaydi (yo'l `anchor`), shuning uchun servisning o'zi
 * yozadi va panel AYNI `BranchSplit` komponentida ko'rsatadi.
 */
const getNetworkTaskPulse = async (query = {}, branches = []) => {
  const { ok, partial } = await runPerBranch(branches, () =>
    getTaskPulse({ period: query.period, from: query.from, to: query.to, ...FLOW }),
  );

  return combinePulse({
    items: ok.map((row) => ({ branch: row.branch, pulse: row.value })),
    partial,
  });
};

/**
 * KARTA RAQAMLARINI BIRLASHTIRADI — `combineReports` bilan AYNI qoida.
 *
 * ⚠️ SOF FUNKSIYA: kartadagi foiz hujjatdagi foiz bilan bir xil
 * formuladan chiqishi shart, shuning uchun u ham alohida sinaladi.
 *
 * @param {{items: Array<{branch: object, pulse: object}>, partial?: string[]}} input
 */
const combinePulse = ({ items: rows, partial = [] }) => {
  const items = rows.map((row) => row.pulse);
  const sum = (key) => sumOf(items, (item) => item[key]);

  const total = sum("total");
  const stopped = sum("stopped");
  const completed = sum("completed");

  return {
    isNetwork: true,
    period: items[0].period,
    total,
    completed,
    review: sum("review"),
    inProgress: sum("inProgress"),
    overdue: sum("overdue"),
    stopped,
    completionRate: rate(completed, total - stopped),
    byBranch: rows
      .map((row) => ({ ...branchTag(row.branch), ...row.pulse }))
      .sort(
        (a, b) =>
          b.total - a.total || collator.compare(a.branchName, b.branchName),
      ),
    branches: rows.map((row) => ({ id: row.branch.id, name: row.branch.name })),
    partial,
  };
};

module.exports = {
  getNetworkTaskReport,
  getNetworkTaskPulse,
  // Sof birlashtirish — bazasiz sinaladi (`test/taskNetwork.test.js`)
  combineReports,
  combinePulse,
};
