const asyncHandler = require("../middleware/async.middleware");
const { ForbiddenError } = require("../utils/errors");

const ExcelService = require("../services/excel.service");
const statisticsService = require("../services/statistics.service");

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

  const data = await statisticsService.getStudentWeekly(studentId);
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
    { page, limit },
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

  let data = [];
  let sheetName = "Maktab reytingi";
  let baseFileName = "haftalik_reyting_maktab";
  let columns;

  if (type === "class" && classId) {
    const { classDoc, rows } =
      await statisticsService.getClassRankingRows(classId);

    data = rows.map((r) => ({
      rank: r.rank,
      fullName: r.student.fullName,
      totalSum: r.totalSum,
      totalGrades: r.totalGrades,
    }));

    sheetName = `${classDoc.name} reytingi`;
    baseFileName = `haftalik_reyting_${classDoc.name}`;
    columns = [
      { header: "O'rin", key: "rank", width: 8 },
      { header: "O'quvchi", key: "fullName", width: 30 },
      { header: "Umumiy ball", key: "totalSum", width: 15 },
      { header: "Baholar soni", key: "totalGrades", width: 15 },
    ];
  } else {
    const rows = await statisticsService.getSchoolRankingRows();

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
