const asyncHandler = require("../middleware/async.middleware");
const creditService = require("../services/lessonCredit.service");

/** Boshliq: kunning o'tilmagan darslari va shu kunga qo'yilgan belgilar (`?date=YYYY-MM-DD&teacherId`). */
const getDay = asyncHandler(async (req, res) => {
  const data = await creditService.getDay(req.query);
  res.json({ success: true, data });
});

/** Boshliq: belgilar registri (`?status=active|revoked&teacherId&month&date`, sahifalanadi). */
const listCredits = asyncHandler(async (req, res) => {
  const data = await creditService.listCredits(req.query);
  res.json({ success: true, ...data });
});

/** Boshliq: filtr uchun o'qituvchilar (haftalik dars soni bilan). */
const getTeacherOptions = asyncHandler(async (req, res) => {
  const data = await creditService.getTeacherOptions();
  res.json({ success: true, data });
});

/** Boshliq: darslarni "o'tildi" deb belgilash — tanlanganlar yoki kunning hammasi. */
const createCredits = asyncHandler(async (req, res) => {
  const data = await creditService.createCredits(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

/** Boshliq: belgilarni bekor qilish (`{ ids, reason }`). */
const revokeCredits = asyncHandler(async (req, res) => {
  const data = await creditService.revokeCredits(req.body, req.user.id);
  res.json({ success: true, data });
});

module.exports = { getDay, listCredits, getTeacherOptions, createCredits, revokeCredits };
