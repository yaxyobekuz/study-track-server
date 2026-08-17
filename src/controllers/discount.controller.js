const asyncHandler = require("../middleware/async.middleware");
const discountService = require("../services/discount.service");
const studentDiscountService = require("../services/studentDiscount.service");
const { PERMISSIONS, hasPermission } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");
const { ForbiddenError } = require("../utils/errors");
const { currentMonthKey, parseMonthKey } = require("../helpers/month.helpers");

const canAdjust = (req) =>
  req.user.role === ROLES.OWNER ||
  hasPermission(req.user.permissions, PERMISSIONS.FINANCE_ADJUST);

/**
 * O'tgan oydan boshlanadigan biriktirish tarixni qayta yozadi (allaqachon
 * chiqarilgan hisob-faktura arzonlashmaydi, lekin ro'yxatda chalkashlik
 * paydo bo'ladi) — shuning uchun `finance.adjust` talab qilinadi.
 * Naqsh `tariff.controller.js` dagi `force` eskalatsiyasi bilan bir xil.
 */
const assertPastAllowed = (req, startMonth) => {
  if (parseMonthKey(startMonth, "Boshlanish oyi") >= currentMonthKey()) return false;
  if (!canAdjust(req)) {
    throw new ForbiddenError(
      "O'tgan oydan boshlanadigan chegirma biriktirish uchun ruxsatingiz yo'q",
    );
  }
  return true;
};

// ── Katalog ──────────────────────────────────

const getDiscounts = asyncHandler(async (req, res) => {
  const result = await discountService.getDiscounts(req);
  res.json(result);
});

const getDiscount = asyncHandler(async (req, res) => {
  const data = await discountService.getDiscountById(req.params.id);
  res.json({ success: true, data });
});

const createDiscount = asyncHandler(async (req, res) => {
  const data = await discountService.createDiscount(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const updateDiscount = asyncHandler(async (req, res) => {
  const data = await discountService.updateDiscount(req.params.id, req.body);
  res.json({ success: true, data });
});

const archiveDiscount = asyncHandler(async (req, res) => {
  const data = await discountService.setDiscountArchived(
    req.params.id,
    req.body.isArchived !== false,
  );
  res.json({ success: true, data });
});

const deleteDiscount = asyncHandler(async (req, res) => {
  const result = await discountService.deleteDiscount(req.params.id);
  res.json({ success: true, ...result });
});

// ── Biriktirish ──────────────────────────────

const getAssignments = asyncHandler(async (req, res) => {
  const result = await studentDiscountService.getAssignments(req);
  res.json(result);
});

const getStudentDiscounts = asyncHandler(async (req, res) => {
  const data = await studentDiscountService.getStudentDiscounts(req.params.studentId);
  res.json({ success: true, data });
});

const getAssignment = asyncHandler(async (req, res) => {
  const data = await studentDiscountService.getAssignmentById(req.params.id);
  res.json({ success: true, data });
});

const createAssignment = asyncHandler(async (req, res) => {
  const allowPast = assertPastAllowed(req, req.body.startMonth);
  const data = await studentDiscountService.createAssignment(
    req.body,
    req.user.id,
    { allowPast },
  );
  res.status(201).json({ success: true, data });
});

const bulkAssign = asyncHandler(async (req, res) => {
  const allowPast = assertPastAllowed(req, req.body.startMonth);
  const result = await studentDiscountService.bulkAssign(req.body, req.user.id, {
    allowPast,
  });
  res.status(201).json({ success: true, data: result });
});

const updateAssignment = asyncHandler(async (req, res) => {
  const data = await studentDiscountService.updateAssignment(req.params.id, req.body, {
    allowPast: canAdjust(req),
  });
  res.json({ success: true, data });
});

const closeAssignment = asyncHandler(async (req, res) => {
  const data = await studentDiscountService.closeAssignment(
    req.params.id,
    req.body.endMonth,
  );
  res.json({ success: true, data });
});

const deleteAssignment = asyncHandler(async (req, res) => {
  const result = await studentDiscountService.deleteAssignment(req.params.id);
  res.json({ success: true, ...result });
});

module.exports = {
  getDiscounts,
  getDiscount,
  createDiscount,
  updateDiscount,
  archiveDiscount,
  deleteDiscount,
  getAssignments,
  getStudentDiscounts,
  getAssignment,
  createAssignment,
  bulkAssign,
  updateAssignment,
  closeAssignment,
  deleteAssignment,
};
