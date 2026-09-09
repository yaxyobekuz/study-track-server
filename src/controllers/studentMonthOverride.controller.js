const asyncHandler = require("../middleware/async.middleware");
const service = require("../services/studentMonthOverride.service");

/** O'quvchining oy override'lari ro'yxati. */
const getForStudent = asyncHandler(async (req, res) => {
  const data = await service.getForStudent(req.params.studentId);
  res.json({ success: true, data });
});

/** Bitta o'quvchi + oy: summa + sabab → override yozadi va hisob-fakturani qayta muhrlaydi. */
const upsert = asyncHandler(async (req, res) => {
  const result = await service.apply(req.params.studentId, req.body, req.user.id);
  res.status(201).json({ success: true, data: result });
});

/** Ommaviy: tanlangan o'quvchilar (yoki sinf) uchun bir oy bir summa. */
const bulk = asyncHandler(async (req, res) => {
  const result = await service.applyBulk(req.body, req.user.id);
  res.status(201).json({ success: true, data: result });
});

/** Override'ni olib tashlaydi va oy odatiy tarifga qaytadi. */
const remove = asyncHandler(async (req, res) => {
  const result = await service.unset(req.params.id, req.user.id);
  res.json({ success: true, data: result });
});

module.exports = {
  getForStudent,
  upsert,
  bulk,
  remove,
};
