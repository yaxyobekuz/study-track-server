/**
 * QURILMALAR, BIRIKTIRISH KODLARI, VAQTINCHALIK OCHISH, SOZLAMALAR
 * va O'QUVCHINING O'Z YO'LLARI — kontroller (yupqa).
 *
 * ⚠️ `/me/*` YO'LLARIDA `studentId` HAR DOIM `req.user` DAN. So'rov
 * tanasidagi id qabul QILINMAYDI: aks holda bitta o'quvchi boshqasining
 * profilini va ekran vaqtini ko'rib olardi (`/grade-analysis/my` bilan
 * bir xil qoida).
 */

const asyncHandler = require("../middleware/async.middleware");
const deviceEnrollmentService = require("../services/deviceEnrollment.service");
const deviceSyncService = require("../services/deviceSync.service");
const deviceUnlockService = require("../services/deviceUnlock.service");
const deviceSettingsService = require("../services/deviceSettings.service");
const deviceAudit = require("../services/deviceAudit.service");

/* ─────────────────────── QURILMALAR (admin) ─────────────────────── */

// ⚠️ `{ success, data, pagination }` — loyihaning ro'yxat shakli
// (`CLAUDE.md`): servis `formatPaginationResponse` bilan tayyor javob
// qaytaradi, kontroller uni o'rab qo'ymaydi.
const listDevices = asyncHandler(async (req, res) => {
  const result = await deviceEnrollmentService.listDevices(req.query);
  res.json(result);
});

const getDevice = asyncHandler(async (req, res) => {
  const data = await deviceEnrollmentService.getDevice(req.params.id);
  res.json({ success: true, data });
});

const pauseDevice = asyncHandler(async (req, res) => {
  const data = await deviceEnrollmentService.setStatus(
    req.params.id,
    "paused",
    req.user.id,
    req.body?.reason,
  );
  res.json({ success: true, message: "Cheklov to'xtatildi", data });
});

const resumeDevice = asyncHandler(async (req, res) => {
  const data = await deviceEnrollmentService.setStatus(req.params.id, "active", req.user.id);
  res.json({ success: true, message: "Cheklov qayta yoqildi", data });
});

const removeDevice = asyncHandler(async (req, res) => {
  const data = await deviceEnrollmentService.setStatus(
    req.params.id,
    "removed",
    req.user.id,
    req.body?.reason,
  );
  res.json({ success: true, message: "Qurilma olib tashlandi", data });
});

/* ─────────────────────── O'QUVCHI QIDIRUVI ─────────────────────── */

// ⚠️ Bo'limning O'Z qidiruvi: `/users/students` `users.view` talab qiladi
// va faqat qurilma nazoratini boshqaradigan xodim o'quvchini tanlay
// olmasdi (servisdagi izohga qarang).
const searchStudents = asyncHandler(async (req, res) => {
  const data = await deviceEnrollmentService.searchStudents(req.query);
  res.json({ success: true, data });
});

/* ─────────────────────── BIRIKTIRISH KODI ─────────────────────── */

const issueCode = asyncHandler(async (req, res) => {
  const data = await deviceEnrollmentService.issueCode(req.body?.studentId, req.user.id);
  res.status(201).json({
    success: true,
    message: "Kod berildi — o'quvchi uni o'z telefonidagi ilovaga kiritadi",
    data,
  });
});

const getStudentCode = asyncHandler(async (req, res) => {
  const data = await deviceEnrollmentService.getActiveCode(req.params.studentId);
  res.json({ success: true, data });
});

/* ─────────────────────── VAQTINCHALIK OCHISH ─────────────────────── */

const listUnlocks = asyncHandler(async (req, res) => {
  const result = await deviceUnlockService.list(req.query);
  res.json(result);
});

const createUnlock = asyncHandler(async (req, res) => {
  const data = await deviceUnlockService.create(req.body, req.user.id);
  const skipped = data.skipped ? `, ${data.skipped} tasida allaqachon bor edi` : "";
  res.status(201).json({
    success: true,
    message: `${data.created} ta o'quvchiga vaqtinchalik ruxsat berildi${skipped}`,
    data,
  });
});

const cancelUnlock = asyncHandler(async (req, res) => {
  const data = await deviceUnlockService.cancel(req.params.id, req.body?.reason, req.user.id);
  res.json({ success: true, message: "Vaqtinchalik ruxsat bekor qilindi", data });
});

/* ─────────────────────── SOZLAMALAR ─────────────────────── */

const getSettings = asyncHandler(async (req, res) => {
  const data = await deviceSettingsService.getSettings();
  res.json({ success: true, data });
});

const updateSettings = asyncHandler(async (req, res) => {
  const data = await deviceSettingsService.updateSettings(req.body, req.user.id);
  res.json({ success: true, message: "Sozlamalar saqlandi", data });
});

/* ─────────────────────── AUDIT ─────────────────────── */

const listAudit = asyncHandler(async (req, res) => {
  // `paginate=true` — to'liq registr; usiz qisqa tasma (dashboard).
  const result = await deviceAudit.list({
    ...req.query,
    paginate: req.query.paginate === "true",
  });
  res.json(Array.isArray(result) ? { success: true, data: result } : result);
});

/* ═════════════════ O'QUVCHINING O'Z YO'LLARI ═════════════════ */

/**
 * ⚠️ BU EKRAN MODULNING ETIK ASOSI: o'quvchi o'ziga qo'llangan qoidani
 * to'liq ko'radi (`devices.md` §0.1). Ruxsat kaliti ortiga
 * YASHIRILMAYDI.
 */
const getMyStatus = asyncHandler(async (req, res) => {
  const data = await deviceSyncService.getMyStatus(req.user);
  res.json({ success: true, data });
});

const getMyPolicy = asyncHandler(async (req, res) => {
  const data = await deviceSyncService.getProfile(req.user, req.query);
  res.json({ success: true, data });
});

const enrollMyDevice = asyncHandler(async (req, res) => {
  const data = await deviceEnrollmentService.enroll(req.body, req.user);
  res.status(201).json({ success: true, message: "Qurilma biriktirildi", data });
});

const myHeartbeat = asyncHandler(async (req, res) => {
  const data = await deviceSyncService.heartbeat(req.user, req.body);
  res.json({ success: true, data });
});

const myUsage = asyncHandler(async (req, res) => {
  const data = await deviceSyncService.reportUsage(req.user, req.body);
  res.json({ success: true, data });
});

const myApps = asyncHandler(async (req, res) => {
  const data = await deviceSyncService.reportApps(req.user, req.body);
  res.json({ success: true, data });
});

const myUnlocks = asyncHandler(async (req, res) => {
  const data = await deviceUnlockService.listMine(req.user.id);
  res.json({ success: true, data });
});

module.exports = {
  listDevices,
  getDevice,
  pauseDevice,
  resumeDevice,
  removeDevice,
  searchStudents,
  issueCode,
  getStudentCode,
  listUnlocks,
  createUnlock,
  cancelUnlock,
  getSettings,
  updateSettings,
  listAudit,
  getMyStatus,
  getMyPolicy,
  enrollMyDevice,
  myHeartbeat,
  myUsage,
  myApps,
  myUnlocks,
};
