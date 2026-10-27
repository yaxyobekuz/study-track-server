/**
 * O'QUVCHILAR HARAKATI — "UMUMIY KO'RINISH" (BARCHA FILIALLAR BIRGA).
 *
 * Bu hisobot FAQAT almashtirgichdagi "Umumiy — barcha filiallar" rejimida
 * ochiladi (biznes qarori, 2026-10-27), ya'ni faqat tizim egasida: savol
 * ham aynan tarmoq darajasida beriladi — "bu oy butun tarmoqda nechta bola
 * keldi, nechtasi ketdi, qaysi filial o'sdi, qaysi biri tushdi". Bitta
 * filial ichida u "o'sha filialning raqami" bo'lib, umumiy manzarani
 * bermasdi — shuning uchun u yerda bo'lim UMUMAN ko'rsatilmaydi
 * (`studentEnrollment.controller.js` darvozasi).
 *
 * ──────────────────────────────────────────────────────────────────────
 * NIMA UCHUN UMUMIY BIRLASHTIRUVCHIDAN O'TMAYDI (`anchor` rejimi)
 * ──────────────────────────────────────────────────────────────────────
 *
 * Odatda umumiy rejimda so'rov har filialda qayta bajarilib, javoblar
 * `aggregateMerge.helpers.js` bilan birlashtiriladi. Bu hisobotda esa
 * o'sha yo'l IKKI JOYDA jim xato berardi:
 *
 *  1. FOIZ. Birlashtiruvchi har `*Percent` kalitini filiallar bo'yicha
 *     OG'IRLIKSIZ o'rtachalaydi (root `CLAUDE.md`: "aniq qiymat kerak
 *     bo'lsa o'sha yo'l uchun alohida qoida yoziladi"). 344 o'quvchili
 *     filial bilan 0 o'quvchili filial teng hissa qo'shsa, "tarmoq
 *     o'sishi" ma'nosiz raqam bo'lardi — aynan shu ekran esa o'sha raqam
 *     uchun ochiladi.
 *  2. WORD FAYLI. Ikkilik hujjat birlashtirilmaydi, shuning uchun eksport
 *     `unsupported` bo'lib turardi va umumiy ko'rinishda tugma O'CHIQ edi.
 *     Holbuki "butun tarmoq bo'yicha bitta hujjat" — bo'limning maqsadi.
 *
 * Yechim: yo'l `anchor` deb belgilanadi (birlashtiruvchi TEGMAYDI), filial
 * aylanishini esa shu servis O'ZI bajaradi. Har filial O'Z hisobotini
 * AYNI `getMovementReport` bilan quradi — ikkinchi quruvchi YO'Q — tarmoq
 * raqamlari esa yig'indidan QAYTA hisoblanadi (`combineMetrics`).
 *
 * ⚠️ NATIJA SHAKLI BITTALIK HISOBOT BILAN BIR XIL. Ekran ham, Word
 * quruvchisi ham qo'shimcha shoxlanishsiz ishlaydi; ustiga faqat
 * `byBranch` (filiallar kesimi) va har qatordagi `branchName` qo'shiladi.
 */

const { mapBranches } = require("../helpers/branchIterator");
const {
  getMovementReport,
  getMovementSummary,
  combineMetrics,
  combineReasons,
  resolveRange,
} = require("./studentMovement.service");

/**
 * Har filialda bajaradi; yiqilganini YO'QOTMAYDI, lekin JIM ham qoldirmaydi.
 *
 * ⚠️ HAMMASI yiqilgan bo'lsa — ASL xato qaytadi, bo'sh hisobot EMAS:
 * "0 keldi, 0 ketdi" degan jadval nosozlikni muvaffaqiyat qilib
 * ko'rsatardi (`aggregate.middleware.js` → `fanOut` bilan AYNI qoida).
 * Bir qismi yiqilsa, qolgani ko'rsatiladi va qaysi filial tushib qolgani
 * `partial` da ochiq turadi — ekranda ham, hujjatda ham.
 *
 * @param {object[]} branches
 * @param {() => Promise<any>} fn - filial konteksti ichida chaqiriladi
 * @returns {Promise<{ok: Array<{branch: object, value: any}>, partial: string[]}>}
 */
const runPerBranch = async (branches, fn) => {
  const results = await mapBranches(fn, {
    branches,
    label: "[Movement]",
  });

  const ok = results.filter((row) => !row.error);
  const failed = results.filter((row) => row.error);

  if (!ok.length) throw failed[0].error;

  return { ok, partial: failed.map((row) => row.branch.name) };
};

/** Sana bo'yicha kamayish tartibi; teng kunlar — filial, keyin ism bo'yicha. */
const byDateDesc = (a, b) => {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.branchName !== b.branchName) return a.branchName < b.branchName ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};

/**
 * BUTUN TARMOQ BO'YICHA HISOBOT.
 *
 * @param {object} query - `month` | `year` | `from`+`to`
 * @param {object[]} branches - `req.aggregateScope.branches`
 */
const getNetworkMovementReport = async (query = {}, branches = []) => {
  // ⚠️ SO'ROV AVVAL TEKSHIRILADI. Busiz yaroqsiz oraliq har filialda
  // alohida ko'tarilib, "hammasi yiqildi" bo'lib qaytardi va foydalanuvchi
  // "Oraliq 60 oydan uzun" o'rniga tushunarsiz nosozlik ko'rardi.
  resolveRange(query);

  const { ok, partial } = await runPerBranch(branches, () =>
    getMovementReport(query),
  );

  const reports = ok.map((row) => ({ branch: row.branch, report: row.value }));
  const first = reports[0].report;

  // ⚠️ OYLAR KALIT BO'YICHA (indeks bo'yicha EMAS): oraliq so'rovdan
  // hisoblanadi, ya'ni hozir hamma filialda bir xil — lekin tartibga
  // tayanadigan kod keyingi o'zgarishda jimgina boshqa oyni qo'shib
  // yuborardi.
  const monthMaps = reports.map(
    ({ report }) => new Map(report.byMonth.map((item) => [item.month, item])),
  );

  const byMonth = first.byMonth.map((sample) => {
    const slice = monthMaps
      .map((map) => map.get(sample.month))
      .filter(Boolean);

    return {
      month: sample.month,
      label: sample.label,
      shortLabel: sample.shortLabel,
      isCurrent: sample.isCurrent,
      ...combineMetrics(slice),
      byReason: combineReasons(slice.map((item) => item.byReason)),
    };
  });

  const tagged = (key) =>
    reports
      .flatMap(({ branch, report }) =>
        report[key].map((item) => ({
          ...item,
          branchId: branch.id,
          branchName: branch.name,
        })),
      )
      .sort(byDateDesc);

  /**
   * KO'CHISH RO'YXATI — BITTA ko'chish BITTA qator.
   *
   * ⚠️ Har ko'chish IKKI filial hisobotida ko'rinadi: manbada "ko'chib
   * ketdi", maqsadda "ko'chib keldi". Tarmoq ro'yxatida ikkalasini ham
   * ko'rsatsak, bitta bola ikki marta sanalgandek bo'lardi — holbuki
   * harakat bitta. Kalit `o'quvchi + sana`: ikkala qatorda ham sana AYNI
   * ko'chish kuni (manbadagi "oxirgi kun + 1").
   *
   * Qolgani — "kelgan" tomoni: unda o'quvchining HOZIRGI sinfi turadi
   * (manbadagi qator ketish oyining suratini oladi).
   */
  const movedStudents = (() => {
    const byKey = new Map();

    for (const item of tagged("movedStudents")) {
      const key = `${item.studentId}|${item.date}`;
      const known = byKey.get(key);
      if (!known || (known.direction === "out" && item.direction === "in")) {
        byKey.set(key, item);
      }
    }

    return [...byKey.values()].sort(byDateDesc);
  })();

  /**
   * FILIALLAR KESIMI — "qaysi filial o'sdi, qaysi biri tushdi".
   *
   * Tarmoq jamisi savolning faqat yarmiga javob beradi: "+10" ning
   * orqasida bitta filial +40, boshqasi −30 bo'lishi mumkin va qaror
   * aynan shu farqga qarab qabul qilinadi.
   *
   * ⚠️ Davr OXIRIDAGI son bo'yicha kamayish tartibida: rahbar ro'yxatni
   * yuqoridan o'qiydi va eng katta filial birinchi turishi kerak.
   */
  const byBranch = reports
    .map(({ branch, report }) => ({
      branchId: branch.id,
      branchName: branch.name,
      ...report.totals,
      context: report.context,
    }))
    .sort(
      (a, b) =>
        b.closeCount - a.closeCount ||
        (a.branchName < b.branchName ? -1 : a.branchName > b.branchName ? 1 : 0),
    );

  const context = reports.reduce(
    (acc, { report }) => ({
      listed: acc.listed + report.context.listed,
      studying: acc.studying + report.context.studying,
      withoutOpenEnrollment:
        acc.withoutOpenEnrollment + report.context.withoutOpenEnrollment,
    }),
    { listed: 0, studying: 0, withoutOpenEnrollment: 0 },
  );

  return {
    range: first.range,
    isNetwork: true,
    // ⚠️ `branch: null` — bitta filialniki emas. Hujjat sarlavhasi shunga
    // qarab "BARCHA FILIALLAR" ni yozadi: langar filialning nomi qolsa,
    // tarmoq ma'lumoti bitta filial nomi bilan sarlavhalanardi.
    branch: null,
    branches: reports.map(({ branch }) => ({ id: branch.id, name: branch.name })),
    partial,
    generatedAt: new Date(),
    totals: combineMetrics(reports.map(({ report }) => report.totals)),
    byMonth,
    byReason: combineReasons(reports.map(({ report }) => report.byReason)),
    byBranch,
    joinedStudents: tagged("joinedStudents"),
    leftStudents: tagged("leftStudents"),
    movedStudents,
    context,
  };
};

/**
 * BOSH SAHIFA KARTASI — butun tarmoq bo'yicha joriy oy va joriy yil.
 *
 * ⚠️ Foiz bu yerda ham yig'indidan qayta hisoblanadi (`combineMetrics`):
 * kartadagi raqam hujjatdagi raqam bilan bir xil formuladan chiqishi
 * shart, aks holda kartaga ishonch yo'qolardi.
 */
const getNetworkMovementSummary = async (branches = []) => {
  const { ok, partial } = await runPerBranch(branches, () =>
    getMovementSummary(),
  );

  const items = ok.map((row) => row.value);
  const first = items[0];

  return {
    month: {
      monthKey: first.month.monthKey,
      label: first.month.label,
      ...combineMetrics(items.map((item) => item.month)),
    },
    year: {
      yearKey: first.year.yearKey,
      label: first.year.label,
      ...combineMetrics(items.map((item) => item.year)),
    },
    isNetwork: true,
    branches: ok.map((row) => ({ id: row.branch.id, name: row.branch.name })),
    partial,
  };
};

module.exports = { getNetworkMovementReport, getNetworkMovementSummary };
