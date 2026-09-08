/**
 * DARS SOATI VA MAOSH — controller (yupqa, mantiq service'da).
 *
 * ⚠️ `/my` endpoint'lari RUXSAT KALITISIZ: identifikator token'dan olinadi,
 * ya'ni odam faqat O'ZINING soatini ko'radi. `payroll.view` talab qilinsa,
 * o'qituvchi o'z maoshini ko'rish uchun butun maktabning qarzdorlik
 * registriga huquq olishi kerak bo'lardi (`getMySalary` bilan bir xil
 * mulohaza).
 */

const asyncHandler = require("../middleware/async.middleware");
const dashboardService = require("../services/lessonHoursDashboard.service");
const lessonHoursService = require("../services/lessonHours.service");
const substitutionService = require("../services/lessonSubstitution.service");
const { ROLES } = require("../utils/constants");
const { ForbiddenError } = require("../utils/errors");

const assertNotStudent = (user) => {
  if (user.role === ROLES.STUDENT) {
    throw new ForbiddenError("Dars soatlari faqat xodimlar uchun");
  }
};

// ── Boshliq ko'rinishi ───────────────────────

const getOverview = asyncHandler(async (req, res) => {
  const month = lessonHoursService.parseHoursMonth(req.query.month);
  const data = await dashboardService.getOverview(month);
  res.json({ success: true, data });
});

const getLedger = asyncHandler(async (req, res) => {
  const month = lessonHoursService.parseHoursMonth(req.query.month);
  const data = await dashboardService.getLedger(month, req.query);
  res.json({ success: true, data });
});

const getTeacherDetail = asyncHandler(async (req, res) => {
  const month = lessonHoursService.parseHoursMonth(req.query.month);
  const data = await dashboardService.getTeacherDetail(req.params.teacherId, month);
  res.json({ success: true, data });
});

// ── O'zimniki (o'qituvchi paneli) ────────────

const getMyHours = asyncHandler(async (req, res) => {
  assertNotStudent(req.user);

  const month = lessonHoursService.parseHoursMonth(req.query.month);
  const data = await dashboardService.getTeacherDetail(req.user.id, month);
  res.json({ success: true, data });
});

const getMySubstitutions = asyncHandler(async (req, res) => {
  assertNotStudent(req.user);

  const data = await substitutionService.getMySubstitutions(req.user.id);
  res.json({ success: true, data });
});

module.exports = {
  getOverview,
  getLedger,
  getTeacherDetail,
  getMyHours,
  getMySubstitutions,
};
