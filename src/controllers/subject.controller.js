const ExcelService = require("../services/excel.service");
const subjectService = require("../services/subject.service");
const asyncHandler = require("../middleware/async.middleware");

// Get all subjects
const getAllSubjects = asyncHandler(async (req, res) => {
  const subjects = await subjectService.getAllSubjects();

  res.json({
    success: true,
    data: subjects,
  });
});

// Create new subject (Owner only)
const createSubject = asyncHandler(async (req, res) => {
  const subject = await subjectService.createSubject(req.body, req.user.id);

  res.status(201).json({
    success: true,
    message: "Fan muvaffaqiyatli yaratildi",
    data: subject,
  });
});

// Update subject (Owner only)
const updateSubject = asyncHandler(async (req, res) => {
  const subject = await subjectService.updateSubject(req.params.id, req.body);

  res.json({
    success: true,
    message: "Fan muvaffaqiyatli yangilandi",
    data: subject,
  });
});

// Delete subject (Owner only)
const deleteSubject = asyncHandler(async (req, res) => {
  await subjectService.deleteSubject(req.params.id);

  res.json({
    success: true,
    message: "Fan muvaffaqiyatli o'chirildi",
  });
});

// Export subjects to Excel
const exportSubjects = asyncHandler(async (req, res) => {
  const data = await subjectService.getSubjectsForExport();

  const workbook = ExcelService.createExcel({
    sheetName: "Fanlar",
    columns: [
      { header: "Fan nomi", key: "name", width: 25 },
      { header: "Tavsif", key: "description", width: 40 },
      { header: "Holati", key: "status", width: 12 },
      { header: "Yaratuvchi", key: "createdBy", width: 20 },
      { header: "Yaratilgan sana", key: "createdAt", width: 15 },
    ],
    data,
    headerStyle: {
      bgColor: ExcelService.COLORS.HEADER_PURPLE,
    },
  });

  const filename = ExcelService.generateFileName("fanlar");
  await ExcelService.sendWorkbook(res, workbook, filename);
});

module.exports = {
  getAllSubjects,
  createSubject,
  updateSubject,
  deleteSubject,
  exportSubjects,
};
