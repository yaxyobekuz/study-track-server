const asyncHandler = require("../middleware/async.middleware");
const attendanceReportService = require("../services/attendanceReport.service");

const getStudentReport = asyncHandler(async (req, res) => {
  const month = req.query.month || new Date().getMonth() + 1;
  const year = req.query.year || new Date().getFullYear();

  // Taqqoslash parametrlari IXTIYORIY: berilmasa hisobot avvalgidek,
  // taqqoslashsiz qaytadi (service ularni o'zi tekshiradi).
  const report = await attendanceReportService.getStudentReport(month, year, {
    day: req.query.day,
    compareDay: req.query.compareDay,
    compareMonth: req.query.compareMonth,
    compareYear: req.query.compareYear,
  });

  res.json({ success: true, ...report });
});

const getStaffReport = asyncHandler(async (req, res) => {
  const month = req.query.month || new Date().getMonth() + 1;
  const year = req.query.year || new Date().getFullYear();
  const report = await attendanceReportService.getStaffReport(month, year);
  res.json({ success: true, ...report });
});

module.exports = {
  getStudentReport,
  getStaffReport,
};
