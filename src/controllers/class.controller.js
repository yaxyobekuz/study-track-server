const ExcelService = require("../services/excel.service");
const classService = require("../services/class.service");
const classChangeService = require("../services/studentClassChange.service");
const { formatPaginationResponse } = require("../utils/pagination");
const asyncHandler = require("../middleware/async.middleware");
const { BadRequestError } = require("../utils/errors");

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
  const { name, capacity } = req.body;
  const data = await classService.createClass(name, req.user.id, capacity);

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

// Add existing students to class (Owner only)
const addStudentsToClass = asyncHandler(async (req, res) => {
  const { studentIds } = req.body;
  const data = await classService.addStudentsToClass(req.params.id, studentIds);

  res.json({
    success: true,
    message: "O'quvchilar sinfga qo'shildi",
    data,
  });
});

// Remove students from class — sabab majburiy, jurnalga yoziladi
const removeStudentsFromClass = asyncHandler(async (req, res) => {
  const { studentIds, all, reason } = req.body;
  const data = await classService.removeStudentsFromClass(
    req.params.id,
    { studentIds, all: all === true, reason },
    { actorId: req.user.id },
  );

  res.json({
    success: true,
    message: "O'quvchilar sinfdan chiqarildi",
    data,
  });
});

// Move students to another class — sabab majburiy, jurnalga yoziladi
const moveStudentsToClass = asyncHandler(async (req, res) => {
  const { studentIds, targetClassId, reason } = req.body;
  const data = await classService.moveStudentsToClass(
    req.params.id,
    { studentIds, targetClassId, reason },
    { actorId: req.user.id },
  );

  res.json({
    success: true,
    message: "O'quvchilar boshqa sinfga ko'chirildi",
    data,
  });
});

// Sinf o'zgarishlari jurnali — ko'chirilganlar / chiqarilganlar, sababi bilan
const getClassChanges = asyncHandler(async (req, res) => {
  const { data, total, page, limit, totals } =
    await classChangeService.listClassChanges(req.query);

  res.json({ ...formatPaginationResponse(data, total, page, limit), totals });
});

// Export class students to Excel
//
// `by=actual` — HAQIQIY SINFI shu sinf bo'lganlar (ekrandagi ikkinchi tab).
// Sukut avvalgidek: shu sinfda O'QIYOTGANLAR. Noto'g'ri qiymat JIM
// o'tkazilmaydi — admin "tanladim, lekin boshqa ro'yxat tushdi" holatiga
// tushmasligi kerak.
const CLASS_EXPORT_SCOPES = ["class", "actual"];

const exportClassStudents = asyncHandler(async (req, res) => {
  const by = req.query.by === undefined ? "class" : String(req.query.by);
  if (!CLASS_EXPORT_SCOPES.includes(by)) {
    throw new BadRequestError("Yuklash kesimi noto'g'ri");
  }

  const { classData, data } = await classService.getClassStudentsForExport(
    req.params.id,
    { by },
  );

  const workbook = ExcelService.createExcel({
    // Varaq nomi faylning O'ZIDA qaysi kesim ekanini aytadi
    sheetName:
      by === "actual" ? `${classData.name} (haqiqiy)` : classData.name,
    columns: [
      { header: "F.I.O", key: "fullName", width: 30 },
      { header: "Username", key: "username", width: 20 },
      { header: "Parol", key: "password", width: 18 },
      { header: "Rol", key: "role", width: 15 },
      { header: "Sinflar", key: "classes", width: 25 },
      // O'quvchining O'Z sinfi — ekrandagi ustun bilan AYNI
      { header: "Haqiqiy sinfi", key: "actualClass", width: 16 },
    ],
    data,
  });

  const filename = ExcelService.generateFileName(
    by === "actual"
      ? `${classData.name}_haqiqiy_sinf`
      : `${classData.name}_oquvchilar`,
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
      // Ikki sanoq ALOHIDA: "shu sinfda o'qiydi" va "aslida shu sinfniki"
      { header: "O'quvchilar soni", key: "studentCount", width: 18 },
      { header: "Haqiqiy sinfi bo'yicha", key: "actualStudentCount", width: 22 },
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
  addStudentsToClass,
  removeStudentsFromClass,
  moveStudentsToClass,
  getClassChanges,
  exportClassStudents,
  exportClasses,
};
