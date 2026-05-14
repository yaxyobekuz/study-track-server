const asyncHandler = require("../middleware/async.middleware");
const studentAttendanceService = require("../services/studentAttendance.service");

const mark = asyncHandler(async (req, res) => {
  const { classId, date, records } = req.body;
  const result = await studentAttendanceService.markAttendance(
    { classId, date, records },
    req.user._id
  );
  res.status(200).json({ success: true, data: result });
});

const updateRecord = asyncHandler(async (req, res) => {
  const { status, excuseReason } = req.body;
  const record = await studentAttendanceService.updateRecord(
    req.params.id,
    { status, excuseReason },
    req.user._id
  );
  res.json({ success: true, data: record });
});

const getTodayClass = asyncHandler(async (req, res) => {
  const result = await studentAttendanceService.getTodayClassAttendance(req.params.classId);
  res.json({ success: true, ...result });
});

const getClasses = asyncHandler(async (req, res) => {
  const result = await studentAttendanceService.getClassList();
  res.json({ success: true, data: result });
});

const getClassMonthRecords = asyncHandler(async (req, res) => {
  const month = req.query.month || new Date().getMonth() + 1;
  const year = req.query.year || new Date().getFullYear();
  const result = await studentAttendanceService.getClassMonthRecords(
    req.params.classId,
    month,
    year
  );
  res.json({ success: true, ...result });
});

const getStudentMonthRecords = asyncHandler(async (req, res) => {
  const month = req.query.month || new Date().getMonth() + 1;
  const year = req.query.year || new Date().getFullYear();
  const result = await studentAttendanceService.getStudentMonthRecords(
    req.params.studentId,
    month,
    year
  );
  res.json({ success: true, ...result });
});

const getAllRecords = asyncHandler(async (req, res) => {
  const result = await studentAttendanceService.getAllRecords(req);
  res.json(result);
});

module.exports = {
  mark,
  updateRecord,
  getTodayClass,
  getClasses,
  getClassMonthRecords,
  getStudentMonthRecords,
  getAllRecords,
};
