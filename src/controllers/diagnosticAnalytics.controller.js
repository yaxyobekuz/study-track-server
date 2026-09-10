const ExcelService = require("../services/excel.service");
const analyticsService = require("../services/diagnosticAnalytics.service");
const { gradeLabel } = require("../helpers/diagnostic.helpers");
const aiService = require("../services/diagnosticAi.service");
const settingsService = require("../services/diagnosticSettings.service");
const studentService = require("../services/diagnosticStudent.service");
const asyncHandler = require("../middleware/async.middleware");
const { NotFoundError } = require("../utils/errors");

const getSummary = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await analyticsService.getSummary(req.query) });
});

const getTrend = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await analyticsService.getTrend(req.query) });
});

const getBySubject = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await analyticsService.getBySubject(req.query) });
});

const getByTopic = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await analyticsService.getByTopic(req.query) });
});

const getByClass = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await analyticsService.getByClass(req.query) });
});

const getByStudent = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await analyticsService.getByStudent(req.query) });
});

// Qamrov + diagnostika topshirmaganlar ro'yxati
const getParticipation = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: await analyticsService.getParticipation(req.query),
  });
});

// Bitta sinfning tafsiloti — ko'rsatkichlar, testlar va o'quvchilar
const getClassDetail = asyncHandler(async (req, res) => {
  const data = await analyticsService.getClassDetail(req.params.classId, req.query);
  if (!data) throw new NotFoundError("Sinf topilmadi");
  res.json({ success: true, data });
});

// Sinflar bo'yicha qatnashuv va o'zlashtirish ("keldi" = test ishlagan)
const getClassParticipation = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: await analyticsService.getClassParticipation(req.query),
  });
});

// "Bugun" kartalari — sana filtridan mustaqil
const getToday = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await analyticsService.getToday() });
});

/**
 * O'quvchining boshqaruv panelini XODIM ko'zi bilan ochish.
 *
 * ⚠️ MA'LUMOT O'QUVCHINIKI BILAN AYNI — bitta servisdan chiqadi. Xodim
 * "o'quvchi nimani ko'ryapti" degan savolga javob olishi kerak; ikkinchi
 * hisoblagich yozilsa, ota-onaga tushuntirishda ikki xil raqam paydo
 * bo'lardi.
 */
const getStudentDashboard = asyncHandler(async (req, res) => {
  const data = await studentService.getDashboard(req.params.studentId);
  res.json({ success: true, data });
});

// Bitta o'quvchining diagnostika profili (o'sish chizig'i, zaif mavzular)
const getStudentProfile = asyncHandler(async (req, res) => {
  const data = await analyticsService.getStudentProfile(
    req.params.studentId,
    req.query,
  );
  if (!data) throw new NotFoundError("O'quvchi topilmadi");
  res.json({ success: true, data });
});

/**
 * FANLAR KESIMINI EXCEL'GA YUKLASH.
 *
 * ⚠️ EKRANDAGI FILTR BILAN — mavzular eksporti bilan bir xil qoida.
 */
const exportSubjects = asyncHandler(async (req, res) => {
  const data = await analyticsService.getBySubject(req.query);

  const workbook = ExcelService.createExcel({
    sheetName: "Fanlar",
    columns: [
      { header: "Fan", key: "label", width: 26 },
      { header: "Testlar soni", key: "testCount", width: 13 },
      { header: "Test ishlaganlar", key: "attempts", width: 16 },
      { header: "O'rtacha natija", key: "averageScore", width: 15 },
      { header: "Yaxshi", key: "good", width: 14 },
      { header: "O'rta", key: "medium", width: 14 },
      { header: "Yomon", key: "bad", width: 14 },
      { header: "O'sish", key: "growth", width: 10 },
    ],
    data: data.data.map((row) => ({
      ...row,
      averageScore: row.averageScore != null ? `${row.averageScore}%` : "—",
      // Son VA ulush birga: 85 ta degan son o'z-o'zicha ko'p yoki
      // ozligini bildirmaydi.
      good: `${row.good.count} (${row.good.percent}%)`,
      medium: `${row.medium.count} (${row.medium.percent}%)`,
      bad: `${row.bad.count} (${row.bad.percent}%)`,
      growth: row.growth != null ? `${row.growth > 0 ? "+" : ""}${row.growth}` : "—",
    })),
    headerStyle: { bgColor: ExcelService.COLORS.HEADER_BLUE },
  });

  const filename = ExcelService.generateFileName("diagnostika_fanlar");
  await ExcelService.sendWorkbook(res, workbook, filename);
});

/**
 * MAVZULAR KESIMINI EXCEL'GA YUKLASH.
 *
 * ⚠️ FAYL EKRANDAGI FILTRNI HURMAT QILADI: `req.query` o'sha
 * `getByTopic` ga uzatiladi. Butun bazani yuklab berish "men
 * ko'rgan jadvalni yuklab oldim" degan kutilmani buzardi.
 */
const exportTopics = asyncHandler(async (req, res) => {
  const data = await analyticsService.getByTopic(req.query);

  const workbook = ExcelService.createExcel({
    sheetName: "Mavzular",
    columns: [
      { header: "Mavzu", key: "label", width: 46 },
      { header: "Fan", key: "subjectName", width: 18 },
      { header: "Testlar soni", key: "attempts", width: 13 },
      { header: "Savollar soni", key: "questions", width: 14 },
      { header: "To'g'ri javoblar", key: "correct", width: 16 },
      { header: "Noto'g'ri javoblar", key: "wrong", width: 17 },
      { header: "O'tkazib yuborilgan", key: "skipped", width: 18 },
      { header: "O'rtacha natija", key: "averageScore", width: 15 },
      { header: "Daraja", key: "grade", width: 12 },
      { header: "O'sish", key: "growth", width: 10 },
    ],
    data: data.data.map((row) => ({
      ...row,
      subjectName: row.subjectName || "—",
      averageScore: row.averageScore != null ? `${row.averageScore}%` : "—",
      grade: gradeLabel(row.grade),
      // ⚠️ O'SISH — PUNKT farqi, foiz emas (`growthPoints`).
      growth: row.growth != null ? `${row.growth > 0 ? "+" : ""}${row.growth}` : "—",
    })),
    headerStyle: { bgColor: ExcelService.COLORS.HEADER_GREEN },
  });

  const filename = ExcelService.generateFileName("diagnostika_mavzular");
  await ExcelService.sendWorkbook(res, workbook, filename);
});

// ── SOZLAMALAR ───────────────────────────────

const getSettings = asyncHandler(async (req, res) => {
  const [settings, ai] = await Promise.all([
    settingsService.getSettings(),
    aiService.getAiStatus(),
  ]);
  res.json({ success: true, data: { ...settings, ai } });
});

const updateSettings = asyncHandler(async (req, res) => {
  const data = await settingsService.updateSettings(req.body, req.user.id);
  res.json({ success: true, message: "Sozlamalar saqlandi", data });
});

// ── AI YORDAMCHILARI ─────────────────────────

const tutorTurn = asyncHandler(async (req, res) => {
  const data = await aiService.tutorTurn({
    history: req.body.history,
    topic: req.body.topic,
    message: req.body.message,
  });
  res.json({ success: true, data });
});

const essayCoach = asyncHandler(async (req, res) => {
  const data = await aiService.essayCoach(req.body.text);
  res.json({ success: true, data });
});

module.exports = {
  getSummary,
  getTrend,
  getBySubject,
  exportSubjects,
  getByTopic,
  exportTopics,
  getByClass,
  getClassDetail,
  getByStudent,
  getParticipation,
  getClassParticipation,
  getToday,
  getStudentDashboard,
  getStudentProfile,
  getSettings,
  updateSettings,
  tutorTurn,
  essayCoach,
};
