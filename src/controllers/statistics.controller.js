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

/**
 * So'rovdagi ankor kun ("YYYY-MM-DD") — qaysi kun / hafta / oy.
 *
 * ⚠️ XATO FORMAT RAD ETILMAYDI, BUGUNGA tushadi (`period` bilan AYNI
 * qoida): ko'rsatish filtri uchun 400 qaytarish ekranni butunlay
 * bo'shatib qo'yardi. Tekshiruv va kelajak sanasini bugunga tushirish —
 * `getStatisticsPeriodRange` da, bitta joyda.
 */
const dateOf = (req) =>
  req.query.date ? String(req.query.date) : undefined;

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
    dateOf(req),
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
    { page, limit, period: periodOf(req), date: dateOf(req) },
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
    date: dateOf(req),
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
  const date = dateOf(req);
  // Fayl nomidagi davr: "kunlik_reyting_maktab_2026-10-29.xlsx"
  const periodSlug = periodTitle(period).toLowerCase();

  let data = [];
  let sheetName = sheetTitle(`${periodTitle(period)} reyting`);
  let baseFileName = `${periodSlug}_reyting_maktab`;
  let columns;
  // Qaysi davr yuklangani fayl nomida turadi: o'tgan hafta yuklab olinsa
  // ham nomida BUGUNGI sana bo'lsa, ikki fayl bir xil nom bilan tushardi.
  let rangeUsed = null;

  if (type === "class" && classId) {
    const { classDoc, range, rows } =
      await statisticsService.getClassRankingRows(classId, period, date);
    rangeUsed = range;

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
    const { range, rows } = await statisticsService.getSchoolRankingRows(
      period,
      date,
    );
    rangeUsed = range;

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

  // ⚠️ `generateFileName` nomga BUGUNGI sanani qo'shadi — o'tgan hafta
  // yuklab olinganda fayl nomi qaysi davr ekanini aytmasdi. Ankor kun
  // (joriy davrda u baribir bugun) aniqroq.
  const filename = rangeUsed
    ? `${baseFileName}_${rangeUsed.date}.xlsx`
    : ExcelService.generateFileName(baseFileName);
  await ExcelService.sendWorkbook(res, workbook, filename);
});
