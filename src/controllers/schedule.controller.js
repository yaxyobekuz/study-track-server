const asyncHandler = require("../middleware/async.middleware");
const ExcelService = require("../services/excel.service");
const scheduleService = require("../services/schedule.service");
const teacherWorkloadService = require("../services/teacherWorkload.service");
const { ROLES } = require("../utils/constants");
const { PERMISSIONS, hasPermission } = require("../utils/permissions");
const { ForbiddenError } = require("../utils/errors");

// Get all schedules for class
const getScheduleByClass = asyncHandler(async (req, res) => {
  const data = await scheduleService.getScheduleByClass(req.params.classId);

  res.json({ success: true, data });
});

// Get schedule for class and day
const getScheduleByDay = asyncHandler(async (req, res) => {
  const { classId, day } = req.params;
  const data = await scheduleService.getScheduleByDay(classId, day);

  res.json({ success: true, data });
});

// Create or update schedule (Owner only)
const createOrUpdateSchedule = asyncHandler(async (req, res) => {
  const data = await scheduleService.createOrUpdateSchedule(req.body, req.user.id);

  res.json({
    success: true,
    message: "Dars jadvali muvaffaqiyatli saqlandi",
    data,
  });
});

// Create or update the whole week schedule for a class (Owner only)
const saveClassSchedule = asyncHandler(async (req, res) => {
  const data = await scheduleService.saveClassSchedule(
    req.params.classId,
    req.body.schedules,
    req.user.id,
  );

  res.json({
    success: true,
    message: "Dars jadvali muvaffaqiyatli saqlandi",
    data,
  });
});

// Delete schedule (Owner only)
const deleteSchedule = asyncHandler(async (req, res) => {
  await scheduleService.deleteSchedule(req.params.id);

  res.json({
    success: true,
    message: "Dars jadvali muvaffaqiyatli o'chirildi",
  });
});

// Export schedules for class to Excel
const exportScheduleByClass = asyncHandler(async (req, res) => {
  const { classDoc, data } = await scheduleService.getScheduleForExport(req.params.classId);

  const workbook = ExcelService.createExcel({
    sheetName: classDoc.name,
    columns: [
      { header: "Kun", key: "day", width: 15 },
      { header: "Dars", key: "order", width: 8 },
      { header: "Fan", key: "subject", width: 30 },
      { header: "O'qituvchi", key: "teacher", width: 25 },
      { header: "Vaqt", key: "time", width: 15 },
    ],
    data,
    headerStyle: {
      bgColor: ExcelService.COLORS.HEADER_ORANGE,
    },
  });

  const filename = ExcelService.generateFileName(`dars_jadvali_${classDoc.name}`);
  await ExcelService.sendWorkbook(res, workbook, filename);
});

// Get all schedules for today (Owner only)
const getAllTodaySchedules = asyncHandler(async (req, res) => {
  const data = await scheduleService.getAllTodaySchedules();

  res.json({ success: true, data });
});

// Get teacher's schedule for today
const getMyTodaySchedule = asyncHandler(async (req, res) => {
  const data = await scheduleService.getMyTodaySchedule(req.user.id);

  res.json({ success: true, data });
});

// Get all classes with their current topic number for a subject (Owner only)
const getClassesBySubject = asyncHandler(async (req, res) => {
  const { classes, subject } = await scheduleService.getClassesBySubject(req.params.subjectId);

  res.json({ success: true, data: classes, subject });
});

// Update current topic number for a class+subject (Owner only)
const updateCurrentTopic = asyncHandler(async (req, res) => {
  const { classId, subjectId } = req.params;
  const { topicNumber } = req.body;
  const data = await scheduleService.updateCurrentTopic(classId, subjectId, topicNumber);

  res.json({
    success: true,
    message: "Hozirgi mavzu raqami yangilandi",
    data,
  });
});

// O'qituvchining haftalik yuklamasi — profil sahifasi uchun
//
// Oylik ma'lumoti javobga FAQAT `payroll.view` bo'lsa qo'shiladi: dars
// jadvalini ko'rish huquqi oylik summasini ochib bermasligi kerak
// (moliya bo'limlari ataylab mayda bo'lingan).
const getTeacherWorkload = asyncHandler(async (req, res) => {
  const { role, permissions = [] } = req.user;
  const withSalary =
    role === ROLES.OWNER || hasPermission(permissions, PERMISSIONS.PAYROLL_VIEW);

  const data = await teacherWorkloadService.getTeacherWorkload(
    req.params.teacherId,
    { withSalary },
  );

  res.json({ success: true, data });
});

// O'ZIMNING haftalik yuklamam — xodim panelidagi profil sahifasi.
//
// Ruxsat kaliti YO'Q: o'qituvchi o'z dars jadvalini va o'z oyligini
// ko'rishi uchun `schedules.view` (butun maktab jadvali) yoki `payroll.view`
// (butun shtat oyligi) berilishi shart emas — bu ikkalasi boshqa odamlarning
// ma'lumotini ochadi. Identifikator so'rovdan EMAS, tokendan olinadi:
// boshqa xodimning yuklamasini shu yo'l bilan ko'rib bo'lmaydi.
const getMyWorkload = asyncHandler(async (req, res) => {
  if (req.user.role === ROLES.STUDENT) {
    throw new ForbiddenError("Dars yuklamasi faqat xodimlar uchun");
  }

  const data = await teacherWorkloadService.getTeacherWorkload(req.user.id, {
    withSalary: true,
  });

  res.json({ success: true, data });
});

module.exports = {
  getScheduleByClass,
  getScheduleByDay,
  createOrUpdateSchedule,
  saveClassSchedule,
  deleteSchedule,
  getMyTodaySchedule,
  getAllTodaySchedules,
  updateCurrentTopic,
  exportScheduleByClass,
  getClassesBySubject,
  getTeacherWorkload,
  getMyWorkload,
};
