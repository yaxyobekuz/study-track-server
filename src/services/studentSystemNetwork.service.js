/**
 * ERP VA KUNDALIK.COM — "UMUMIY KO'RINISH" (BARCHA FILIALLAR BIRGA).
 *
 * Bitta filial hisobotining ko'zgusi: AYNI savol tarmoq darajasida
 * beriladi — "butun tarmoqda nechta o'quvchi ERP ga kiritilmagan, qaysi
 * filialda qancha qolgan".
 *
 * ──────────────────────────────────────────────────────────────────────
 * NIMA UCHUN UMUMIY BIRLASHTIRUVCHIDAN O'TMAYDI (`anchor` rejimi)
 * ──────────────────────────────────────────────────────────────────────
 *
 * `studentMovementNetwork.service.js` bilan AYNI ikki sabab:
 *
 *  1. FOIZ. Birlashtiruvchi har `*Percent` kalitini filiallar bo'yicha
 *     OG'IRLIKSIZ o'rtachalaydi. 344 o'quvchili filial bilan 12
 *     o'quvchili filial teng hissa qo'shsa, "tarmoqning qancha qismi
 *     kiritilgan" ma'nosiz raqam bo'lardi — hujjat esa aynan o'sha
 *     raqam uchun ochiladi.
 *  2. WORD FAYLI. Ikkilik hujjat birlashtirilmaydi: yo'l `unsupported`
 *     bo'lsa, umumiy ko'rinishda tugma O'CHIQ bo'lib qolardi.
 *
 * Shuning uchun yo'l `anchor` deb belgilanadi (birlashtiruvchi TEGMAYDI),
 * filial aylanishini esa shu servis O'ZI bajaradi. Har filial O'Z
 * hisobotini AYNI `getSystemsReport` bilan quradi — ikkinchi quruvchi
 * YO'Q — tarmoq raqamlari esa yig'indidan QAYTA hisoblanadi
 * (`combineTotals`).
 *
 * ⚠️ BOSH SAHIFADAGI KARTA BU YERGA KIRMAYDI. U oddiy sanoqchi
 * (`GET /student-systems/summary`, `mode: "object"`) va umumiy
 * birlashtiruvchidan o'tadi: faqat sonlar bor, foiz yo'q — ya'ni yuqoridagi
 * birinchi sabab unga tegishli emas, filiallar kesimi (`BranchSplit`) esa
 * tekin keladi.
 */

const { mapBranches } = require("../helpers/branchIterator");
const {
  SYSTEMS,
  combineTotals,
  getSystemsReport,
  classCollator,
  nameCollator,
} = require("./studentSystemReport.service");
const { NO_CLASS, NO_CLASS_LABEL } = require("./studentSystem.service");

/**
 * Har filialda bajaradi; yiqilganini YO'QOTMAYDI, lekin JIM ham qoldirmaydi.
 *
 * ⚠️ HAMMASI yiqilgan bo'lsa — ASL xato qaytadi, bo'sh hisobot EMAS:
 * "hammasi kiritilgan" degan jadval nosozlikni muvaffaqiyat qilib
 * ko'rsatardi (`studentMovementNetwork.service.js` bilan AYNI qoida).
 *
 * @param {object[]} branches
 */
const runPerBranch = async (branches) => {
  const results = await mapBranches((branch) => getSystemsReport({ branch }), {
    branches,
    label: "[StudentSystems]",
  });

  const ok = results.filter((row) => !row.error);
  if (!ok.length) throw results.find((row) => row.error).error;

  return {
    ok: ok.map((row) => ({ branch: row.branch, report: row.value })),
    partial: results.filter((row) => row.error).map((row) => row.branch.name),
  };
};

/**
 * ⚠️ SINFSIZLAR HAR FILIAL ICHIDA ENG OXIRIDA — bitta filial hisobotida
 * ham shunday (`buildClassBreakdown`, `buildExportRows`). Busiz tarmoq
 * ro'yxati ularni alifbo o'rniga qo'yardi va bir xil hisobot ikki
 * rejimda ikki xil tartibda chiqardi.
 */
const classRank = (name, id) => (id === NO_CLASS || name === NO_CLASS_LABEL ? 1 : 0);

const byClassName = (a, b) =>
  classRank(a, null) - classRank(b, null) || classCollator.compare(a, b);

/** Sinflar kesimi: filial → sinf (tabiiy tartib: 5-A, 9-B, 10-A). */
const byBranchThenClass = (a, b) =>
  nameCollator.compare(a.branchName, b.branchName) ||
  classRank(a.name, a.id) - classRank(b.name, b.id) ||
  classCollator.compare(a.name, b.name);

/** Ro'yxatlar: filial → sinf → ism. */
const byBranchThenStudent = (a, b) =>
  nameCollator.compare(a.branchName, b.branchName) ||
  byClassName(a.className, b.className) ||
  nameCollator.compare(a.name, b.name);

/**
 * BUTUN TARMOQ BO'YICHA HISOBOT.
 *
 * @param {object[]} branches - `req.aggregateScope.branches`
 */
const getNetworkSystemsReport = async (branches = []) => {
  const { ok, partial } = await runPerBranch(branches);

  const tagged = (pick, sort) =>
    ok
      .flatMap(({ branch, report }) =>
        pick(report).map((item) => ({
          ...item,
          branchId: branch.id,
          branchName: branch.name,
        })),
      )
      .sort(sort);

  /**
   * FILIALLAR KESIMI — "qaysi filialda qancha qolgan".
   *
   * ⚠️ Tarmoq jamisi savolning faqat yarmiga javob beradi: "82 ta
   * kiritilmagan" ning hammasi bitta filialda bo'lishi mumkin va ish
   * aynan o'sha filialda bajariladi.
   *
   * Kiritilmaganlar soni bo'yicha kamayish tartibida: ro'yxat yuqoridan
   * o'qiladi va eng ko'p ish qolgan filial birinchi turadi.
   */
  const byBranch = ok
    .map(({ branch, report }) => ({
      branchId: branch.id,
      branchName: branch.name,
      ...report.totals,
    }))
    .sort(
      (a, b) =>
        b.missingAny - a.missingAny ||
        nameCollator.compare(a.branchName, b.branchName),
    );

  return {
    isNetwork: true,
    // ⚠️ `branch: null` — bitta filialniki emas. Hujjat sarlavhasi shunga
    // qarab "BARCHA FILIALLAR" ni yozadi: langar filialning nomi qolsa,
    // tarmoq ma'lumoti bitta filial nomi bilan sarlavhalanardi.
    branch: null,
    branches: ok.map(({ branch }) => ({ id: branch.id, name: branch.name })),
    partial,
    generatedAt: new Date(),
    totals: combineTotals(ok.map(({ report }) => report.totals)),
    byBranch,
    // ⚠️ SINFLAR FILIALLAR BO'YLAB BIRLASHTIRILMAYDI: ikki filialda ham
    // "5-A" bo'lishi mumkin va ular BOSHQA-BOSHQA sinf. Nom bo'yicha
    // qo'shilsa, bitta filialda bajarilgan ish ikkinchisining qatoriga
    // qo'shilib ketardi (`aggregateMerge` dagi "guruh kaliti
    // birlashtirilmaydi" qoidasi bilan AYNI sabab).
    byClass: tagged((report) => report.byClass, byBranchThenClass),
    missing: Object.fromEntries(
      SYSTEMS.map((system) => [
        system,
        tagged((report) => report.missing[system], byBranchThenStudent),
      ]),
    ),
  };
};

module.exports = { getNetworkSystemsReport };
