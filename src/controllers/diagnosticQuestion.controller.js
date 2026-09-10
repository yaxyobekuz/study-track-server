const ExcelService = require("../services/excel.service");
const questionService = require("../services/diagnosticQuestion.service");
const asyncHandler = require("../middleware/async.middleware");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");

// Savollar banki ro'yxati (sahifalangan)
const getQuestions = asyncHandler(async (req, res) => {
  const pagination = getPaginationParams(req);
  const { total, totalAll, rows } = await questionService.listQuestions(
    req.query,
    pagination,
  );

  res.json({
    ...formatPaginationResponse(rows, total, pagination.page, pagination.limit),
    // ⚠️ FILTRSIZ BANK HAJMI — sahifalash `total` idan ALOHIDA.
    // Sarlavhadagi "jami N ta" filtrga qarab o'zgarmasligi kerak,
    // "Topildi: M ta" esa aynan filtrni ko'rsatadi.
    totalAll,
  });
});

// Bank manzarasi (moderatsiya ekranining yuqori qatori)
const getStats = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await questionService.getBankStats() });
});

// Fan/mavzu kesimida qamrov — "qaysi mavzuda savol yetishmayapti"
const getCoverage = asyncHandler(async (req, res) => {
  const data = await questionService.getCoverage(req.query.subjectId || null);
  res.json({ success: true, data });
});

const getQuestion = asyncHandler(async (req, res) => {
  const data = await questionService.getQuestionById(req.params.id);
  res.json({ success: true, data });
});

const createQuestion = asyncHandler(async (req, res) => {
  const data = await questionService.createQuestion(
    req.body,
    req.files,
    req.user.id,
  );

  res.status(201).json({
    success: true,
    message: "Savol qo'shildi. Tasdiqlangandan keyin testlarda ishlatiladi.",
    data,
  });
});

const updateQuestion = asyncHandler(async (req, res) => {
  const data = await questionService.updateQuestion(
    req.params.id,
    req.body,
    req.files,
  );
  res.json({ success: true, message: "Savol yangilandi", data });
});

const updateQuestionStatus = asyncHandler(async (req, res) => {
  const data = await questionService.updateStatus(req.params.id, req.body.status);
  res.json({ success: true, message: "Savol holati o'zgartirildi", data });
});

const bulkUpdateStatus = asyncHandler(async (req, res) => {
  const data = await questionService.bulkUpdateStatus(
    req.body.ids,
    req.body.status,
  );
  res.json({
    success: true,
    message: `${data.updated} ta savol o'zgartirildi${
      data.skipped.length ? `, ${data.skipped.length} tasi o'tkazib yuborildi` : ""
    }`,
    data,
  });
});

const deleteQuestion = asyncHandler(async (req, res) => {
  const data = await questionService.deleteQuestion(req.params.id);
  res.json({ success: true, message: data.message, data });
});

// Excel/CSV dan ommaviy import (`topic.service.uploadTopics` naqshi:
// faylni service o'zi o'qiydi).
const importQuestions = asyncHandler(async (req, res) => {
  const data = await questionService.importQuestions(req.file, {
    subjectId: req.body.subjectId,
    authorId: req.user.id,
    language: req.body.language || "uz",
  });

  res.json({
    success: true,
    message: `${data.created} ta savol qo'shildi${
      data.failed ? `, ${data.failed} tasida xato` : ""
    }`,
    data,
  });
});

const exportQuestions = asyncHandler(async (req, res) => {
  const data = await questionService.getQuestionsForExport(req.query);

  const workbook = ExcelService.createExcel({
    sheetName: "Savollar banki",
    columns: [
      { header: "Kod", key: "code", width: 12 },
      { header: "Fan", key: "subject", width: 18 },
      { header: "Mavzu", key: "topic", width: 22 },
      { header: "Sinf", key: "grade", width: 8 },
      { header: "Savol", key: "text", width: 55 },
      { header: "Turi", key: "type", width: 20 },
      { header: "Qiyinlik", key: "difficulty", width: 12 },
      { header: "Variantlar", key: "options", width: 45 },
      { header: "To'g'ri javob", key: "correct", width: 25 },
      { header: "Ball", key: "points", width: 8 },
      { header: "Holati", key: "status", width: 14 },
      { header: "Ishlatilgan", key: "usageCount", width: 12 },
      { header: "Aniqlik", key: "accuracy", width: 10 },
      { header: "Muallif", key: "author", width: 22 },
    ],
    data,
    headerStyle: { bgColor: ExcelService.COLORS.HEADER_PURPLE },
  });

  const filename = ExcelService.generateFileName("diagnostika_savollar");
  await ExcelService.sendWorkbook(res, workbook, filename);
});

module.exports = {
  getQuestions,
  getStats,
  getCoverage,
  getQuestion,
  createQuestion,
  updateQuestion,
  updateQuestionStatus,
  bulkUpdateStatus,
  deleteQuestion,
  importQuestions,
  exportQuestions,
};
