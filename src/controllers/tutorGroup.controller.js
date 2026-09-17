const asyncHandler = require("../middleware/async.middleware");
const tutorGroupService = require("../services/tutorGroup.service");
const { ROLES } = require("../utils/constants");
const { ForbiddenError } = require("../utils/errors");

/** Xodimning tyutor guruhlari (admin, xodim sahifasi). */
const getStaffGroups = asyncHandler(async (req, res) => {
  const data = await tutorGroupService.getStaffGroups(req.params.staffId);
  res.json({ success: true, data });
});

/** Biriktirish oynasi: sinflar, o'quvchilar soni va tanlangan davrda kimga biriktirilgani. */
const getClassOptions = asyncHandler(async (req, res) => {
  const data = await tutorGroupService.getClassOptions({
    tutorId: req.query.tutorId,
    month: req.query.month,
    endMonth: req.query.endMonth,
  });
  res.json({ success: true, data });
});

/** Guruh manzarasi (admin) — istalgan guruh. */
const getGroupOverview = asyncHandler(async (req, res) => {
  const data = await tutorGroupService.getGroupOverview(
    req.params.id,
    { month: req.query.month },
    { id: req.user.id, onlyOwn: false },
  );
  res.json({ success: true, data });
});

/**
 * O'ZIMNING guruhlarim — xodim/o'qituvchi paneli. Ruxsat kaliti yo'q,
 * id tokendan (`/payroll/deductions/my` bilan bir xil mulohaza).
 */
const getMyGroups = asyncHandler(async (req, res) => {
  if (req.user.role === ROLES.STUDENT) {
    throw new ForbiddenError("Guruhlar faqat xodimlar uchun");
  }
  const data = await tutorGroupService.getMyGroups(req.user.id);
  res.json({ success: true, data });
});

/** O'z guruhimning manzarasi — faqat o'ziga biriktirilgan guruh. */
const getMyGroupOverview = asyncHandler(async (req, res) => {
  if (req.user.role === ROLES.STUDENT) {
    throw new ForbiddenError("Guruhlar faqat xodimlar uchun");
  }
  const data = await tutorGroupService.getGroupOverview(
    req.params.id,
    { month: req.query.month },
    { id: req.user.id, onlyOwn: true },
  );
  res.json({ success: true, data });
});

/** Jonli hisob — hech narsa yozilmaydi. */
const previewAmount = asyncHandler(async (req, res) => {
  const data = await tutorGroupService.previewAmount(req.body);
  res.json({ success: true, data });
});

const createGroup = asyncHandler(async (req, res) => {
  const data = await tutorGroupService.createGroup(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const updateGroup = asyncHandler(async (req, res) => {
  const data = await tutorGroupService.updateGroup(req.params.id, req.body, req.user.id);
  res.json({ success: true, data });
});

const removeGroup = asyncHandler(async (req, res) => {
  const data = await tutorGroupService.removeGroup(
    req.params.id,
    { effective: req.body?.effective },
    req.user.id,
  );
  res.json({ success: true, data });
});

module.exports = {
  getStaffGroups,
  getClassOptions,
  getGroupOverview,
  getMyGroups,
  getMyGroupOverview,
  previewAmount,
  createGroup,
  updateGroup,
  removeGroup,
};
