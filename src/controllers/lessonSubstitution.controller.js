/**
 * DARS O'RINBOSARLIGI — controller (yupqa, mantiq service'da).
 */

const asyncHandler = require("../middleware/async.middleware");
const substitutionService = require("../services/lessonSubstitution.service");

// O'rinbosarlik tanlovi uchun o'qituvchilar ro'yxati (haftalik soati bilan)
const getTeacherOptions = asyncHandler(async (req, res) => {
  const data = await substitutionService.getTeacherOptions();
  res.json({ success: true, data });
});

const getSubstitutions = asyncHandler(async (req, res) => {
  const data = await substitutionService.getSubstitutions(req);
  res.json({ success: true, ...data });
});

const getSubstitution = asyncHandler(async (req, res) => {
  const data = await substitutionService.getSubstitution(req.params.id);
  res.json({ success: true, data });
});

// Tanlov ekrani: o'qituvchining shu davrda ko'chirish mumkin bo'lgan darslari
const getAvailableLessons = asyncHandler(async (req, res) => {
  const data = await substitutionService.getAvailableLessons(
    req.params.teacherId,
    req.query,
  );
  res.json({ success: true, data });
});

const createSubstitution = asyncHandler(async (req, res) => {
  const data = await substitutionService.createSubstitution(req.body, req.user.id);
  res.status(201).json({
    success: true,
    data,
    message: "Darslar o'rinbosarga biriktirildi",
  });
});

const cancelSubstitution = asyncHandler(async (req, res) => {
  const data = await substitutionService.cancelSubstitution(
    req.params.id,
    req.body.reason,
    req.user.id,
  );
  res.json({ success: true, data, message: "O'rinbosarlik bekor qilindi" });
});

module.exports = {
  getTeacherOptions,
  getSubstitutions,
  getSubstitution,
  getAvailableLessons,
  createSubstitution,
  cancelSubstitution,
};
