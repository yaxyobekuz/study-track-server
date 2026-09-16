const asyncHandler = require("../middleware/async.middleware");
const unlockService = require("../services/gradingUnlock.service");

/** Boshliq: oynalar ro'yxati (`?status=active|expired|revoked`, sahifalanadi). */
const listUnlocks = asyncHandler(async (req, res) => {
  const data = await unlockService.listUnlocks(req.query);
  res.json({ success: true, ...data });
});

/** Boshliq: tanlov uchun o'qituvchilar (haftalik dars soni bilan). */
const getTeacherOptions = asyncHandler(async (req, res) => {
  const data = await unlockService.getTeacherOptions();
  res.json({ success: true, data });
});

/** Boshliq: o'tgan kunlar oralig'iga baho qo'yishni ochish (hammaga yoki tanlanganlarga). */
const createUnlock = asyncHandler(async (req, res) => {
  const data = await unlockService.createUnlock(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

/** Boshliq: oynani muddatidan oldin yopish. */
const revokeUnlock = asyncHandler(async (req, res) => {
  const data = await unlockService.revokeUnlock(req.params.id, req.user.id);
  res.json({ success: true, data });
});

/**
 * O'qituvchi: baho qo'yish huquqi — bugun maktabdami, ochiq oynalar va
 * ochiq kunlardagi baho qo'yilmagan darslar.
 * Identifikator tokendan — boshqa odamning huquqini ko'rib bo'lmaydi.
 */
const getMyAccess = asyncHandler(async (req, res) => {
  const data = await unlockService.getMyAccess(req.user);
  res.json({ success: true, data });
});

module.exports = { listUnlocks, getTeacherOptions, createUnlock, revokeUnlock, getMyAccess };
