const asyncHandler = require("../middleware/async.middleware");
const payrollViewService = require("../services/payrollView.service");

/** Staff bo'lim xodimlari + hisoblangan oylik. */
const getStaffPayroll = asyncHandler(async (req, res) => {
  const data = await payrollViewService.getStaffPayroll(req);
  res.json({ success: true, ...data });
});

/** Toifa o'qituvchilari + hisoblangan oylik. */
const getTeacherPayroll = asyncHandler(async (req, res) => {
  const data = await payrollViewService.getTeacherPayroll(req);
  res.json({ success: true, ...data });
});

/** Ustama haq registri — manba va holati bilan (Yo'nalish → Ustama haq). */
const getAllowancesView = asyncHandler(async (req, res) => {
  const data = await payrollViewService.getAllowancesView(req);
  res.json({ success: true, ...data });
});

// ── ADMIN USTAMA (PayrollBonus) ──────────────
const payrollBonusService = require("../services/payrollBonus.service");

/** Admin xodimga to'g'ridan-to'g'ri ustama qo'shadi. */
const createBonus = asyncHandler(async (req, res) => {
  const data = await payrollBonusService.createBonus(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

/** Admin qo'shgan ustamani o'chiradi. */
const deleteBonus = asyncHandler(async (req, res) => {
  const result = await payrollBonusService.deleteBonus(req.params.id, req.user.id);
  res.json({ success: true, ...result });
});

module.exports = {
  getStaffPayroll,
  getTeacherPayroll,
  getAllowancesView,
  createBonus,
  deleteBonus,
};
