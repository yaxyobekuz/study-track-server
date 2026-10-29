/**
 * BAHO REYTINGI — "UMUMIY KO'RINISH" (BARCHA FILIALLAR BIRGA).
 *
 * ──────────────────────────────────────────────────────────────────────
 * NIMA UCHUN UMUMIY BIRLASHTIRUVCHIDAN O'TMAYDI (`anchor` rejimi)
 * ──────────────────────────────────────────────────────────────────────
 *
 * ⚠️ REYTING BIRLASHTIRILMAYDI, QAYTA HISOBLANADI. Birlashtiruvchi har
 * filialning javobini ULAYDI: har filial o'z 1-o'rnini yuborgani uchun
 * ro'yxatda "49, 49, 1, 1, 3..." degan ketma-ketlik chiqardi va jadval
 * reyting bo'lishdan to'xtardi. O'rin — qatorning KIMLIGI emas, butun
 * ro'yxatdagi O'RNI: u faqat yakuniy ro'yxat yig'ilgandan keyin
 * beriladi.
 *
 * ⚠️ Shu sababdan sahifalash ham shu yerda: filiallar o'z ellik
 * qatorini alohida kesib yuborsa, 2-sahifada boshqa filialning eng
 * yaxshilari paydo bo'lardi.
 *
 * Yechim `attendanceStatsNetwork.service.js` bilan AYNI: yo'l `anchor`
 * deb belgilanadi (registr), filiallar bo'ylab aylanishni esa shu servis
 * O'ZI bajaradi. Har filial qatorlarini AYNI dvigatel quradi
 * (`statistics.service.js` → `buildRankingRows`) — ikkinchi quruvchi
 * YO'Q, faqat saralash va o'rin berish tarmoq darajasida takrorlanadi.
 */

const { mapBranches } = require("../helpers/branchIterator");
const { publicBranch } = require("./aggregateScope.service");
const {
  paginate,
  assignRanks,
  periodFields,
  byScoreThenName,
  buildRankingRows,
} = require("./statistics.service");

/**
 * Har filialda reyting qatorlarini quradi va bitta ro'yxatga yig'adi.
 *
 * ⚠️ HAMMASI yiqilgan bo'lsa ASL xato qaytadi, bo'sh ro'yxat EMAS:
 * "hech kimda baho yo'q" degan jadval nosozlikni ma'lumotga aylantirardi
 * (`attendanceStatsNetwork.service.js` bilan AYNI qoida).
 *
 * @param {object[]} branches
 * @param {string} period
 * @param {string} [date]
 */
const collectRows = async (branches, period, date) => {
  const results = await mapBranches(() => buildRankingRows({}, period, date), {
    branches,
    label: "[Statistika]",
  });

  const ok = results.filter((row) => !row.error);
  if (!ok.length) throw results.find((row) => row.error).error;

  // Har qatorga qaysi filialdan kelgani yoziladi — belgining nomi va
  // shakli birlashtiruvchinikidek (`_branch`), panel esa uni o'sha
  // `BranchBadge` bilan ko'rsatadi.
  const rows = ok.flatMap(({ branch, value }) =>
    value.rows.map((row) => ({ ...row, _branch: publicBranch(branch) })),
  );

  rows.sort(byScoreThenName);

  return {
    // Davr hamma filialda AYNI (sana serverda hisoblanadi), shuning uchun
    // birinchisiniki olinadi
    range: ok[0].value.range,
    rows: assignRanks(rows),
    partial: results.filter((row) => row.error).map((row) => row.branch.name),
  };
};

/**
 * Maktab reytingi — butun tarmoq bo'yicha.
 *
 * @param {{page?: number|string, limit?: number|string, period?: string, date?: string}} params
 * @param {object[]} branches - `req.aggregateScope.branches`
 */
async function getNetworkSchoolRankings(
  { page = 1, limit = 20, period, date } = {},
  branches,
) {
  const pageNum = parseInt(page, 10) || 1;
  const limitNum = parseInt(limit, 10) || 20;

  const { range, rows, partial } = await collectRows(branches, period, date);
  const { items, pagination } = paginate(rows, pageNum, limitNum);

  return {
    data: {
      ...periodFields(range),
      isNetwork: true,
      // Qaysi filial javob bermagani JIM qolmaydi
      partial,
      totalStudents: rows.length,
      rankings: items.map((row) => ({
        rank: row.rank,
        student: row.student,
        classes: row.classes,
        totalSum: row.totalSum,
        totalGrades: row.totalGrades,
        _branch: row._branch,
      })),
    },
    pagination,
  };
}

/** Eksport uchun — barcha qatorlar, sahifalanmagan. */
async function getNetworkSchoolRankingRows(period, date, branches) {
  const { range, rows } = await collectRows(branches, period, date);
  return { range, rows };
}

module.exports = {
  getNetworkSchoolRankings,
  getNetworkSchoolRankingRows,
};
