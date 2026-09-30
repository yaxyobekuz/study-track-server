const asyncHandler = require("../middleware/async.middleware");
const grantService = require("../services/gradingGrant.service");

/** Boshliq: ruxsatlar ro'yxati (`?status=active|upcoming|expired|revoked&teacherId&classId`, sahifalanadi). */
const listGrants = asyncHandler(async (req, res) => {
  const data = await grantService.listGrants(req.query);
  res.json({ success: true, ...data });
});

/** Boshliq: tanlov uchun o'qituvchilar va faol sinflar. */
const getOptions = asyncHandler(async (req, res) => {
  const data = await grantService.getOptions();
  res.json({ success: true, data });
});

/** Boshliq: sinfning haftalik darslari fanlar kesimida (fan va dars tanlovi). */
const getClassLessons = asyncHandler(async (req, res) => {
  const data = await grantService.getClassLessons(req.params.classId);
  res.json({ success: true, data });
});

/** Boshliq: o'qituvchiga sinf + fanga baho qo'yish ruxsatini berish. */
const createGrant = asyncHandler(async (req, res) => {
  const data = await grantService.createGrant(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

/** Boshliq: ruxsatni muddatidan oldin yopish. */
const revokeGrant = asyncHandler(async (req, res) => {
  const data = await grantService.revokeGrant(req.params.id, req.body, req.user.id);
  res.json({ success: true, data });
});

module.exports = { listGrants, getOptions, getClassLessons, createGrant, revokeGrant };
