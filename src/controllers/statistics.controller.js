const asyncHandler = require("../middleware/async.middleware");
const { ForbiddenError } = require("../utils/errors");

const ExcelService = require("../services/excel.service");
const statisticsService = require("../services/statistics.service");
const { STATISTICS_PERIODS } = require("../helpers/statistics.helpers");

/**
 * So'rovdagi davr: "day" | "week" | "month".
 *
 * ⚠️ NOMA'LUM QIYMAT RAD ETILMAYDI, HAFTALIKKA tushadi: davr — ko'rsatish
 * filtri, ma'lumot emas. `period` umuman yubormaydigan eski mijoz (student
 * paneli, bot, monitor) ham avvalgi javobni oladi.
 */
const periodOf = (req) => String(req.query.period || "week");

/** Davrning o'zbekcha nomi ("Kunlik" / "Haftalik" / "Oylik"). */
const periodTitle = (key) =>
  (STATISTICS_PERIODS[key] || STATISTICS_PERIODS.week).title;

/**
 * Excel varag'ining nomi — 31 belgidan uzun bo'lsa ExcelJS rad etadi
 * (uzun sinf nomi bilan eksport jimgina yiqilardi).
 */
const sheetTitle = (text) =>
  text.length <= 31 ? text : `${text.slice(0, 30)}…`;

/**
 * Bitta o'quvchining joriy hafta statistikasi (grade jadvalidan hisoblanadi)
 * GET /api/statistics/weekly/current/:studentId
 * @access Private (Owner yoki student o'zini)
 */
exports.getStudentWeeklyStatistics = asyncHandler(async (req, res) => {
  const { studentId } = req.params;

  if (req.user.role === "student" && req.user.id !== studentId) {
    throw new ForbiddenError(
      "Siz faqat o'z statistikangizni ko'rishingiz mumkin",
    );
  }

  const data = await statisticsService.getStudentWeekly(
    studentId,
    periodOf(req),
  );
  return res.json({ success: true, data });
});

/**
 * Sinf bo'yicha reyting (grade jadvalidan, barcha sinf o'quvchilari)
 * GET /api/statistics/weekly/class/:classId/rankings
 * @access Private (Owner only)
 */
exports.getClassRankings = asyncHandler(async (req, res) => {
  const { classId } = req.params;
  const { page = 1, limit = 20 } = req.query;

  const { data, pagination } = await statisticsService.getClassRankings(
    classId,
    { page, limit, period: periodOf(req) },
  );
  return res.json({ success: true, data, pagination });
});

/**
 * Maktab bo'yicha reyting (grade jadvalidan, barcha faol o'quvchilar)
 * GET /api/statistics/weekly/school/rankings
 * @access Private (Owner only)
 */
exports.getSchoolRankings = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;

  const { data, pagination } = await statisticsService.getSchoolRankings({
    page,
    limit,
    period: periodOf(req),
  });
  return res.json({ success: true, data, pagination });
});

/**
 * O'quvchining barcha haftalik statistikasi (tarix — grafik uchun)
 * GET /api/statistics/weekly/student/:studentId/all
 * @access Private (Owner yoki student o'zini)
 */
exports.getAllStudentWeeklyStats = asyncHandler(async (req, res) => {
  const { studentId } = req.params;

  if (req.user.role === "student" && req.user.id !== studentId) {
    throw new ForbiddenError(
      "Siz faqat o'z statistikangizni ko'rishingiz mumkin",
    );
  }

  const data = await statisticsService.getStudentAllWeeks(studentId);
  return res.json({ success: true, data });
});

/**
 * Haftalik reytingni Excel formatida export qilish
 * GET /api/statistics/weekly/export
 * @access Private (Owner only)
 */
exports.exportWeeklyStatistics = asyncHandler(async (req, res) => {
  const { type = "school", classId } = req.query;
  const period = periodOf(req);
  // Fayl nomidagi davr: "kunlik_reyting_maktab_2026-10-29.xlsx"
  const periodSlug = periodTitle(period).toLowerCase();

  let data = [];
  let sheetName = sheetTitle(`${periodTitle(period)} reyting`);
  let baseFileName = `${periodSlug}_reyting_maktab`;
  let columns;

  if (type === "class" && classId) {
    const { classDoc, rows } = await statisticsService.getClassRankingRows(
      classId,
      period,
    );

    data = rows.map((r) => ({
      rank: r.rank,
      fullName: r.student.fullName,
      totalSum: r.totalSum,
      totalGrades: r.totalGrades,
    }));

    sheetName = sheetTitle(`${periodTitle(period)} — ${classDoc.name}`);
    baseFileName = `${periodSlug}_reyting_${classDoc.name}`;
    columns = [
      { header: "O'rin", key: "rank", width: 8 },
      { header: "O'quvchi", key: "fullName", width: 30 },
      { header: "Umumiy ball", key: "totalSum", width: 15 },
      { header: "Baholar soni", key: "totalGrades", width: 15 },
    ];
  } else {
    const { rows } = await statisticsService.getSchoolRankingRows(period);

    data = rows.map((r) => ({
      rank: r.rank,
      fullName: r.student.fullName,
      classes:
        r.classes && r.classes.length > 0
          ? r.classes.map((c) => c.name).join(", ")
          : "-",
      totalSum: r.totalSum,
      totalGrades: r.totalGrades,
    }));

    columns = [
      { header: "O'rin", key: "rank", width: 8 },
      { header: "O'quvchi", key: "fullName", width: 30 },
      { header: "Sinflar", key: "classes", width: 20 },
      { header: "Umumiy ball", key: "totalSum", width: 15 },
      { header: "Baholar soni", key: "totalGrades", width: 15 },
    ];
  }

  const workbook = ExcelService.createExcel({
    sheetName,
    columns,
    data,
    headerStyle: {
      bgColor: ExcelService.COLORS.HEADER_BLUE,
    },
  });

  const filename = ExcelService.generateFileName(baseFileName);
  await ExcelService.sendWorkbook(res, workbook, filename);
});
