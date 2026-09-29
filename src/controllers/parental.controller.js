/**
 * OTA-ONA NAZORATI — kontroller (yupqa).
 *
 * ⚠️ `studentId` HAR DOIM `req.user` DAN, qurilma — `req.parentalDeviceId`
 * DAN (`X-Device-Id`). So'rov tanasidagi id qabul QILINMAYDI: aks holda
 * bitta o'quvchi boshqasining sozlamasini o'zgartirib olardi.
 */

const asyncHandler = require("../middleware/async.middleware");
const { getPaginationParams } = require("../utils/pagination");
const { clientDeviceId } = require("../helpers/request.helpers");
const parentalService = require("../services/parental.service");
const parentalDeviceService = require("../services/parentalDevice.service");

/* ─────────────────────── OTA-ONA ILOVASI ─────────────────────── */

const getStatus = asyncHandler(async (req, res) => {
  const data = await parentalService.getStatus(req.user);
  res.json({ success: true, data });
});

const setPin = asyncHandler(async (req, res) => {
  const data = await parentalService.setPin(req.user, req.body, {
    authorized: Boolean(req.parental),
    jti: req.tokenJti,
    branchId: req.branch?.id ?? null,
    deviceId: clientDeviceId(req),
  });
  res.json({ success: true, message: "PIN saqlandi", data });
});

const verifyPin = asyncHandler(async (req, res) => {
  const data = await parentalService.verifyPin(req.user, req.body, {
    jti: req.tokenJti,
    branchId: req.branch?.id ?? null,
    deviceId: clientDeviceId(req),
  });
  res.json({ success: true, data });
});

const resetPin = asyncHandler(async (req, res) => {
  const data = await parentalService.resetPin(req.user, req.body, {
    jti: req.tokenJti,
    branchId: req.branch?.id ?? null,
    deviceId: clientDeviceId(req),
  });
  res.json({ success: true, message: "PIN tiklandi", data });
});

const getUsage = asyncHandler(async (req, res) => {
  const data = await parentalService.getUsage(req.user, req.query);
  res.json({ success: true, data });
});

// ⚠️ `{ success, data, pagination }` — servis tayyor javob qaytaradi
const listApps = asyncHandler(async (req, res) => {
  res.json(await parentalService.listApps(req.user, req.query, getPaginationParams(req)));
});

const updateApp = asyncHandler(async (req, res) => {
  const data = await parentalService.updateApp(req.user, req.params.appId, req.body);
  res.json({ success: true, data });
});

const bulkUpdateApps = asyncHandler(async (req, res) => {
  const data = await parentalService.bulkUpdateApps(req.user, req.body);
  res.json({ success: true, data });
});

const setLockAll = asyncHandler(async (req, res) => {
  const data = await parentalService.setLockAll(req.user, req.body);
  res.json({ success: true, data });
});

const updateSettings = asyncHandler(async (req, res) => {
  const data = await parentalService.updateSettings(req.user, req.body);
  res.json({ success: true, data });
});

const listEvents = asyncHandler(async (req, res) => {
  res.json(await parentalService.listEvents(req.user, req.query, getPaginationParams(req)));
});

const listUnlockRequests = asyncHandler(async (req, res) => {
  res.json(
    await parentalService.listUnlockRequests(req.user, req.query, getPaginationParams(req)),
  );
});

const decideUnlockRequest = asyncHandler(async (req, res) => {
  const data = await parentalService.decideUnlockRequest(req.user, req.params.id, req.body);
  res.json({
    success: true,
    message: data.status === "approved" ? "Ruxsat berildi" : "So'rov rad etildi",
    data,
  });
});

/* ─────────────────────── BOLANING TELEFONI ─────────────────────── */

const registerDevice = asyncHandler(async (req, res) => {
  const data = await parentalDeviceService.register(req.user, req.parentalDeviceId, req.body);
  res.json({ success: true, data });
});

const reportHealth = asyncHandler(async (req, res) => {
  const data = await parentalDeviceService.reportHealth(req.user, req.parentalDeviceId, req.body);
  res.json({ success: true, data });
});

const syncApps = asyncHandler(async (req, res) => {
  const data = await parentalDeviceService.syncApps(req.user, req.parentalDeviceId, req.body);
  res.json({ success: true, data });
});

const reportUsage = asyncHandler(async (req, res) => {
  const data = await parentalDeviceService.reportUsage(req.user, req.parentalDeviceId, req.body);
  res.json({ success: true, data });
});

const getPolicy = asyncHandler(async (req, res) => {
  const data = await parentalDeviceService.getPolicy(req.user, req.parentalDeviceId, req.query);
  res.json({ success: true, data });
});

const reportEvents = asyncHandler(async (req, res) => {
  const data = await parentalDeviceService.reportEvents(req.user, req.parentalDeviceId, req.body);
  res.json({ success: true, data });
});

const requestUnlock = asyncHandler(async (req, res) => {
  const data = await parentalDeviceService.requestUnlock(
    req.user,
    req.parentalDeviceId,
    req.body,
  );
  res.status(201).json({ success: true, message: "So'rov ota-onaga yuborildi", data });
});

const getUnlockRequest = asyncHandler(async (req, res) => {
  const data = await parentalDeviceService.getUnlockRequest(
    req.user,
    req.parentalDeviceId,
    req.params.id,
  );
  res.json({ success: true, data });
});

module.exports = {
  getStatus,
  setPin,
  verifyPin,
  resetPin,
  getUsage,
  listApps,
  updateApp,
  bulkUpdateApps,
  setLockAll,
  updateSettings,
  listEvents,
  listUnlockRequests,
  decideUnlockRequest,
  registerDevice,
  reportHealth,
  syncApps,
  reportUsage,
  getPolicy,
  reportEvents,
  requestUnlock,
  getUnlockRequest,
};
