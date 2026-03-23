const ExcelService = require("../services/excel.service");
const classService = require("../services/class.service");
const asyncHandler = require("../middleware/async.middleware");

// Get all classes
const getAllClasses = asyncHandler(async (req, res) => {
  const classes = await classService.getAllClasses();

  res.json({
    success: true,
    data: classes,
  });
});

// Get single class
const getClass = asyncHandler(async (req, res) => {
  const data = await classService.getClassById(req.params.id);

  res.json({
    success: true,
    data,
  });
});

// Create new class (Owner only)
const createClass = asyncHandler(async (req, res) => {
  const { name } = req.body;
  const data = await classService.createClass(name, req.user._id);

  res.status(201).json({
    success: true,
    message: "Sinf muvaffaqiyatli yaratildi",
    data,
  });
});

// Update class (Owner only)
const updateClass = asyncHandler(async (req, res) => {
  const data = await classService.updateClass(req.params.id, req.body);

  res.json({
    success: true,
    message: "Sinf muvaffaqiyatli yangilandi",
    data,
  });
});

// Delete class (Owner only)
const deleteClass = asyncHandler(async (req, res) => {
  await classService.deleteClass(req.params.id);

  res.json({
    success: true,
    message: "Sinf muvaffaqiyatli o'chirildi",
  });
});

// Export class students to Excel
const exportClassStudents = asyncHandler(async (req, res) => {
  const { classData, data } = await classService.getClassStudentsForExport(
    req.params.id,
  );

  const workbook = ExcelService.createExcel({
    sheetName: classData.name,
    columns: [
      { header: "F.I.O", key: "fullName", width: 30 },
      { header: "Username", key: "username", width: 20 },
      { header: "Parol", key: "password", width: 18 },
      { header: "Rol", key: "role", width: 15 },
      { header: "Sinflar", key: "classes", width: 25 },
    ],
    data,
  });

  const filename = ExcelService.generateFileName(
    `${classData.name}_oquvchilar`,
  );

  await ExcelService.sendWorkbook(res, workbook, filename);
});

// Export classes to Excel
const exportClasses = asyncHandler(async (req, res) => {
  const data = await classService.getAllClassesForExport();

  const workbook = ExcelService.createExcel({
    sheetName: "Sinflar",
    columns: [
      { header: "Sinf nomi", key: "name", width: 25 },
      { header: "Holati", key: "status", width: 12 },
      { header: "Yaratuvchi", key: "createdBy", width: 20 },
      { header: "Yaratilgan sana", key: "createdAt", width: 15 },
    ],
    data,
    headerStyle: {
      bgColor: ExcelService.COLORS.HEADER_GREEN,
    },
  });

  const filename = ExcelService.generateFileName("sinflar");
  await ExcelService.sendWorkbook(res, workbook, filename);
});

module.exports = {
  getAllClasses,
  getClass,
  createClass,
  updateClass,
  deleteClass,
  exportClassStudents,
  exportClasses,
};
