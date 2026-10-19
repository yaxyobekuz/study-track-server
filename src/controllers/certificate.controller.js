/**
 * SERTIFIKAT REJALARI — HTTP qatlami (yupqa: mantiq xizmatlarda).
 */

const asyncHandler = require("../middleware/async.middleware");
const { formatPaginationResponse } = require("../utils/pagination");
const planService = require("../services/certificatePlan.service");
const trackService = require("../services/certificateTrack.service");
const importService = require("../services/certificateImport.service");
const statsService = require("../services/certificateStats.service");

/* ─────────────────────────── rejalar ─────────────────────────── */

const getPlans = asyncHandler(async (req, res) => {
  const { data, total, page, limit } = await planService.listPlans(req.query, {
    actorId: req.user.id,
  });

  res.json(formatPaginationResponse(data, total, page, limit));
});

const getStudentPlans = asyncHandler(async (req, res) => {
  const data = await planService.getStudentPlans(req.params.studentId, {
    actorId: req.user.id,
    includeHistory: req.query.history === "true",
  });

  res.json({ success: true, data });
});

/**
 * O'QUVCHINING O'Z REJALARI.
 *
 * ⚠️ Ruxsat kaliti YO'Q va `studentId` TOKENDAN olinadi, so'rovdan EMAS
 * (`/grade-analysis/my` va `/devices/me/*` bilan AYNI qoida). `forStudent`
 * esa forma to'ldirilgan vaqtni javobdan butunlay chiqarib tashlaydi.
 */
const getMyPlans = asyncHandler(async (req, res) => {
  const data = await planService.getStudentPlans(req.user.id, {
    actorId: req.user.id,
    forStudent: true,
  });

  res.json({ success: true, data });
});

/**
 * O'quvchini qidirib tanlash — importda va "Reja qo'shish" oynasida.
 * Ruxsat `certificates.manage` (route'da): tanlash YOZISH yo'lining qismi.
 */
const searchStudents = asyncHandler(async (req, res) => {
  const data = await planService.searchStudents(req.query);

  res.json({ success: true, data });
});

const createPlan = asyncHandler(async (req, res) => {
  const data = await planService.createPlan(req.body, { actorId: req.user.id });

  res.status(201).json({ success: true, message: "Reja qo'shildi", data });
});

const updatePlan = asyncHandler(async (req, res) => {
  const data = await planService.updatePlan(req.params.id, req.body, {
    actorId: req.user.id,
  });

  res.json({ success: true, message: "Reja yangilandi", data });
});

const cancelPlan = asyncHandler(async (req, res) => {
  const data = await planService.cancelPlan(req.params.id, req.body, { actorId: req.user.id });

  res.json({ success: true, message: "Reja bekor qilindi", data });
});

const markPlanPassed = asyncHandler(async (req, res) => {
  const data = await planService.markPassed(req.params.id, { actorId: req.user.id });

  res.json({ success: true, message: "Topshirdi deb belgilandi", data });
});

/** O'quvchining mavzular manzarasi — "nega bu foiz". */
const getStudentProgress = asyncHandler(async (req, res) => {
  const data = await planService.getStudentProgressDetail(req.params.studentId, {
    actorId: req.user.id,
  });

  res.json({ success: true, data });
});

/* ─────────────────── tyutor (guruh rahbari) ─────────────────── */

/**
 * TYUTORNING O'Z GURUHI.
 *
 * ⚠️ Ruxsat kaliti YO'Q: tyutor id si TOKENDAN olinadi va sinf uning joriy
 * guruhi bo'lishi servisda tekshiriladi (`/tutor-groups/my` bilan AYNI
 * qoida). So'rov tanasidan tyutor id si O'QILMAYDI.
 */
const getTutorGroupPlans = asyncHandler(async (req, res) => {
  const data = await planService.getTutorGroupPlans({
    actorId: req.user.id,
    classId: req.params.classId,
  });

  res.json({ success: true, data });
});

/** Tyutor rejani tahrirlaydi — faqat muddat va yo'nalish. */
const updateTutorPlan = asyncHandler(async (req, res) => {
  const { dueDate, trackId } = req.body;
  const data = await planService.updateTutorPlan(
    req.params.id,
    { dueDate, trackId },
    { actorId: req.user.id },
  );

  res.json({ success: true, message: "Reja yangilandi", data });
});

/* ─────────────────────────── yo'nalishlar ─────────────────────────── */

const getTracks = asyncHandler(async (req, res) => {
  const data = await trackService.listTracks({
    includeArchived: req.query.archived === "true",
    withUsage: req.query.usage === "true",
  });

  res.json({ success: true, data });
});

const createTrack = asyncHandler(async (req, res) => {
  const data = await trackService.createTrack(req.body, { actorId: req.user.id });

  res.status(201).json({ success: true, message: "Yo'nalish qo'shildi", data });
});

const updateTrack = asyncHandler(async (req, res) => {
  const data = await trackService.updateTrack(req.params.id, req.body);

  res.json({ success: true, message: "Yo'nalish yangilandi", data });
});

/* ─────────────────────────── import ─────────────────────────── */

const previewImport = asyncHandler(async (req, res) => {
  const data = await importService.previewImport(req.file, { actorId: req.user.id });

  res.json({ success: true, data });
});

const confirmImport = asyncHandler(async (req, res) => {
  const data = await importService.confirmImport(req.body, { actorId: req.user.id });

  res.json({
    success: true,
    message: `${data.created + data.replaced} ta reja yozildi`,
    data,
  });
});

/* ─────────────────────────── statistika ─────────────────────────── */

const getStats = asyncHandler(async (req, res) => {
  const data = await statsService.getCertificateStats(req.query);

  res.json({ success: true, data });
});

module.exports = {
  getPlans,
  getStudentPlans,
  getStudentProgress,
  getMyPlans,
  searchStudents,
  createPlan,
  updatePlan,
  cancelPlan,
  markPlanPassed,
  getTutorGroupPlans,
  updateTutorPlan,
  getTracks,
  createTrack,
  updateTrack,
  previewImport,
  confirmImport,
  getStats,
};
