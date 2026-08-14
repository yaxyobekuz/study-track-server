const asyncHandler = require("../middleware/async.middleware");
const statusService = require("../services/studentFinanceStatus.service");
const { PERMISSIONS, hasPermission } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");
const { ForbiddenError } = require("../utils/errors");
const { currentMonthKey, parseOptionalMonthKey } = require("../helpers/month.helpers");

/**
 * O'tgan oydan boshlanadigan holat — tarixni qayta yozish, shuning uchun
 * alohida `finance.adjust` ruxsati talab qilinadi (tariff.controller.js dagi
 * `force` + `TARIFFS_ADJUST` naqshi bilan bir xil).
 */
const resolveAllowPast = (req, startMonthValue) => {
  const startMonth = parseOptionalMonthKey(startMonthValue, "Boshlanish oyi");
  if (startMonth == null || startMonth >= currentMonthKey()) return false;

  const canAdjust =
    req.user.role === ROLES.OWNER ||
    hasPermission(req.user.permissions, PERMISSIONS.FINANCE_ADJUST);

  if (!canAdjust) {
    throw new ForbiddenError(
      "O'tgan oydan boshlanadigan holat qo'shish uchun ruxsatingiz yo'q",
    );
  }

  return true;
};

const getStatuses = asyncHandler(async (req, res) => {
  const result = await statusService.getStatuses(req);
  res.json(result);
});

const getStudentStatuses = asyncHandler(async (req, res) => {
  const result = await statusService.getStudentStatusHistory(req.params.studentId);
  res.json({ success: true, ...result });
});

const getStatus = asyncHandler(async (req, res) => {
  const row = await statusService.getStatusById(req.params.id);
  res.json({ success: true, data: row });
});

const createStatus = asyncHandler(async (req, res) => {
  const allowPast = resolveAllowPast(req, req.body.startMonth);
  const row = await statusService.createStatus(req.body, req.user.id, { allowPast });
  res.status(201).json({ success: true, data: row });
});

const bulkCreateStatus = asyncHandler(async (req, res) => {
  const allowPast = resolveAllowPast(req, req.body.startMonth);
  const result = await statusService.bulkCreateStatus(req.body, req.user.id, {
    allowPast,
  });
  res.status(201).json({ success: true, data: result });
});

const updateStatus = asyncHandler(async (req, res) => {
  // Amaldagi yozuvni qayta yozish ham `finance.adjust` talab qiladi
  const canAdjust =
    req.user.role === ROLES.OWNER ||
    hasPermission(req.user.permissions, PERMISSIONS.FINANCE_ADJUST);

  const row = await statusService.updateStatus(req.params.id, req.body, {
    allowPast: req.query.force === "true" && canAdjust,
  });
  res.json({ success: true, data: row });
});

const closeStatus = asyncHandler(async (req, res) => {
  const row = await statusService.closeStatus(req.params.id, req.body.endMonth);
  res.json({ success: true, data: row });
});

const changeStatus = asyncHandler(async (req, res) => {
  const result = await statusService.changeStatus(
    req.params.id,
    req.body,
    req.user.id,
  );
  res.json({ success: true, data: result });
});

const deleteStatus = asyncHandler(async (req, res) => {
  const result = await statusService.deleteStatus(req.params.id);
  res.json({ success: true, ...result });
});

module.exports = {
  getStatuses,
  getStudentStatuses,
  getStatus,
  createStatus,
  bulkCreateStatus,
  updateStatus,
  closeStatus,
  changeStatus,
  deleteStatus,
};
