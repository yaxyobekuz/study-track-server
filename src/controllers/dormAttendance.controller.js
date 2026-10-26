const dormAttendance = require("../services/dormAttendance.service");
const dormAttendanceExport = require("../services/dormAttendanceExport.service");
const asyncHandler = require("../middleware/async.middleware");

// Kunlik ro'yxat — belgilash ekranining ma'lumoti (sahifalanmaydi)
const getDay = asyncHandler(async (req, res) => {
  const data = await dormAttendance.getDormDay(req.user, req.query);
  res.json({ success: true, data });
});

// "Qaysi sinfdan nechta qoldi" — sinflar kesimi va takrorsiz jami
const getClassBreakdown = asyncHandler(async (req, res) => {
  const data = await dormAttendance.getDormClassBreakdown(req.query);
  res.json({ success: true, data });
});

// Bitta sinf — kunlik ro'yxat + har o'quvchining oxirgi kunlari + kunlar kesimi
const getClassDetail = asyncHandler(async (req, res) => {
  const data = await dormAttendance.getDormClassDetail(req.user, {
    classId: req.params.classId,
    ...req.query,
  });
  res.json({ success: true, data });
});

// Bitta o'quvchining tarixi — kun-ba-kun
const getStudentHistory = asyncHandler(async (req, res) => {
  const data = await dormAttendance.getDormStudentHistory({
    studentId: req.params.studentId,
    ...req.query,
  });
  res.json({ success: true, data });
});

// Belgilash — bitta yoki bir nechta o'quvchi
const mark = asyncHandler(async (req, res) => {
  const data = await dormAttendance.markDormAttendance(req.user, req.body);
  res.json({ success: true, message: "Yotoqxona davomati saqlandi", data });
});

// Boshlanish vaqti
const getSettings = asyncHandler(async (req, res) => {
  const data = await dormAttendance.getSettings();
  res.json({ success: true, data });
});

const updateSettings = asyncHandler(async (req, res) => {
  const data = await dormAttendance.updateSettings(req.user, req.body);
  res.json({ success: true, message: "Sozlama saqlandi", data });
});

// Excel — kunlik ro'yxat + sinflar kesimi
const exportExcel = asyncHandler(async (req, res) => {
  await dormAttendanceExport.exportDormAttendance(res, req.query);
});

module.exports = {
  getDay,
  getClassBreakdown,
  getClassDetail,
  getStudentHistory,
  mark,
  getSettings,
  updateSettings,
  exportExcel,
};
