/**
 * FACE ID — PANEL CONTROLLERLARI (odam tokeni bilan).
 *
 * ⚠️ KIOSK YO'LLARI BOSHQA FAYLDA (`kiosk.controller.js`): u qurilma
 * tokeni bilan ishlaydi va `req.user` ko'rmaydi. Ikkalasini bitta
 * faylga yig'ish "qaysi so'rov qaysi tokendan o'tgan" degan savolni
 * chalkashtirardi.
 *
 * Controllerlar YUPQA: tekshiruv va mantiq service'da.
 */

const asyncHandler = require("../middleware/async.middleware");
const kioskService = require("../services/kiosk.service");
const faceProfileService = require("../services/faceProfile.service");
const faceGalleryService = require("../services/faceGallery.service");
const faceAttendanceService = require("../services/faceAttendance.service");
const faceSettingsService = require("../services/faceSettings.service");
const prisma = require("../config/prisma");
const fileStorage = require("../services/fileStorage.service");
const { NotFoundError, BadRequestError } = require("../utils/errors");
const { hasRole } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");

/* ═══════════════════════════ KIOSKLAR ═══════════════════════════ */

/**
 * ⚠️ FILIAL FILTRI MAJBURIY: reyestr PLATFORMADA yashaydi, ya'ni filtr
 * qo'yilmasa boshqa filiallarning kioski ham chiqib ketardi. Owner
 * `?branchId=all` bilan hammasini ko'radi — qolgan hamma faqat joriy
 * filialni.
 */
const resolveBranchScope = (req) => {
  if (req.query.branchId === "all" && hasRole(req.user, ROLES.OWNER)) return "all";
  return req.branch.id;
};

const listKiosks = asyncHandler(async (req, res) => {
  const data = await kioskService.list({ ...req.query, branchId: resolveBranchScope(req) });
  res.json({ success: true, ...data });
});

const getKiosk = asyncHandler(async (req, res) => {
  const kiosk = await kioskService.getById(req.params.id);
  res.json({ success: true, data: kiosk });
});

/**
 * ⚠️ `branchId` SO'ROVDAN OLINMAYDI — har doim JORIY filial. Aks holda
 * Chilonzorda huquqi bor xodim Yunusobodga kiosk ochib qo'ya olardi
 * (ruxsatlar har filialda alohida — root `CLAUDE.md`).
 */
const createKiosk = asyncHandler(async (req, res) => {
  const result = await kioskService.create(
    { ...req.body, branchId: req.branch.id },
    req.user.id,
  );
  res.status(201).json({ success: true, data: result });
});

const updateKiosk = asyncHandler(async (req, res) => {
  const kiosk = await kioskService.update(req.params.id, req.body, req.user.id);
  res.json({ success: true, data: kiosk });
});

const issuePairingCode = asyncHandler(async (req, res) => {
  const result = await kioskService.issuePairingCode(req.params.id, req.user.id);
  res.status(201).json({ success: true, data: result });
});

const cancelPairingCode = asyncHandler(async (req, res) => {
  const kiosk = await kioskService.cancelPairingCode(req.params.id, req.user.id);
  res.json({ success: true, data: kiosk });
});

const updateSetupPin = asyncHandler(async (req, res) => {
  const kiosk = await kioskService.updateSetupPin(req.params.id, req.body.setupPin, req.user.id);
  res.json({ success: true, data: kiosk });
});

const revokeKiosk = asyncHandler(async (req, res) => {
  const kiosk = await kioskService.revoke(req.params.id, req.body?.reason, req.user.id);
  res.json({ success: true, data: kiosk });
});

const suspendKiosk = asyncHandler(async (req, res) => {
  const kiosk = await kioskService.setSuspended(
    req.params.id,
    true,
    req.body?.reason,
    req.user.id,
  );
  res.json({ success: true, data: kiosk });
});

const resumeKiosk = asyncHandler(async (req, res) => {
  const kiosk = await kioskService.setSuspended(req.params.id, false, null, req.user.id);
  res.json({ success: true, data: kiosk });
});

const deleteKiosk = asyncHandler(async (req, res) => {
  const result = await kioskService.remove(req.params.id);
  res.json({ success: true, data: result });
});

/* ═══════════════════════ YUZ PROFILLARI ═══════════════════════ */

const listPeople = asyncHandler(async (req, res) => {
  const data = await faceProfileService.listPeople(req.query);
  res.json({ success: true, ...data });
});

const getProfile = asyncHandler(async (req, res) => {
  const data = await faceProfileService.getProfile(req.params.userId);
  res.json({ success: true, data });
});

/**
 * YUZ NAMUNASINI OLISH.
 *
 * ⚠️ `source: "panel"` ATAYLAB SERVERDA belgilanadi, mijozdan
 * olinmaydi: bu yo'l odam tokeni bilan ishlaydi, ya'ni namuna panelda
 * (yoki kioskning ro'yxatga olish rejimida — u ham odam tokeni bilan)
 * olingan. Mijoz uni "import" deb yozib, audit izini jimgina
 * o'zgartirib qo'ya olmaydi.
 */
const addSample = asyncHandler(async (req, res) => {
  const result = await faceProfileService.addSample(
    req.params.userId,
    {
      ...req.body,
      source: req.body?.kioskId ? "kiosk" : "panel",
    },
    req.user.id,
  );
  res.status(201).json({ success: true, data: result });
});

const removeSample = asyncHandler(async (req, res) => {
  const result = await faceProfileService.removeSample(req.params.id, req.user.id);
  res.json({ success: true, data: result });
});

const removeProfile = asyncHandler(async (req, res) => {
  const result = await faceProfileService.removeProfile(req.params.userId, req.user.id);
  res.json({ success: true, data: result });
});

const setProfileActive = asyncHandler(async (req, res) => {
  const profile = await faceProfileService.setProfileActive(
    req.params.userId,
    req.body?.isActive,
    req.body?.note,
    req.user.id,
  );
  res.json({ success: true, data: profile });
});

/* ═══════════════════════ JURNAL VA MANZARA ═══════════════════════ */

const listEvents = asyncHandler(async (req, res) => {
  const data = await faceAttendanceService.listEvents(req.query);
  res.json({ success: true, ...data });
});

const getOverview = asyncHandler(async (req, res) => {
  const [coverage, summary, kiosks] = await Promise.all([
    faceGalleryService.getCoverage(),
    faceAttendanceService.getEventSummary(req.query),
    kioskService.list({ branchId: req.branch.id, limit: 100 }),
  ]);

  res.json({
    success: true,
    data: {
      coverage,
      summary,
      kiosks: kiosks.data,
      // ⚠️ "Oflaynda qolgan qayd" — qurilmalar bo'yicha YIG'INDI.
      // Panelda bitta raqam bo'lib turishi kerak: "14 qayd hali
      // yuborilmagan" degan holat e'tiborsiz qolmasligi lozim.
      pendingOffline: kiosks.data.reduce((sum, k) => sum + (k.pendingCount || 0), 0),
    },
  });
});

/**
 * KADR RASMINI BERADI — ruxsat tekshiruvidan o'tgan yo'l.
 *
 * ⚠️ RASM OCHIQ URL BILAN TARQATILMAYDI (`uploadPrivateBuffer`): bu
 * odamning — ko'pincha bolaning — yuzi. Havolasi qo'lga tushgan har
 * kim uni ochib ko'ra olmasligi kerak, shuning uchun yo'l
 * `faceId.events` ruxsati ortida turadi.
 *
 * ⚠️ Kalit MIJOZDAN OLINMAYDI — bazadagi qatordan o'qiladi. Mijoz kalit
 * bersa, u `../../.env` kabi qiymat yuborib bucket'ni kavlab chiqa
 * olardi.
 */
const sendSnapshot = async (res, key) => {
  if (!key) throw new NotFoundError("Rasm saqlanmagan");
  const { buffer, contentType } = await fileStorage.getObjectBuffer(key);
  res.setHeader("Content-Type", contentType || "image/jpeg");
  // Rasm o'zgarmaydi (kalit yagona), lekin PRIVATE: umumiy keshga
  // (proksi, CDN) tushmasligi kerak.
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.send(buffer);
};

const getEventSnapshot = asyncHandler(async (req, res) => {
  const event = await prisma.faceCheckEvent.findUnique({
    where: { id: req.params.id },
    select: { snapshotKey: true },
  });
  if (!event) throw new NotFoundError("Jurnal yozuvi topilmadi");
  await sendSnapshot(res, event.snapshotKey);
});

const getSampleSnapshot = asyncHandler(async (req, res) => {
  const sample = await prisma.faceSample.findUnique({
    where: { id: req.params.id },
    select: { snapshotKey: true },
  });
  if (!sample) throw new NotFoundError("Namuna topilmadi");
  await sendSnapshot(res, sample.snapshotKey);
});

/* ═══════════════════════ SOZLAMA ═══════════════════════ */

const getSettings = asyncHandler(async (req, res) => {
  const data = await faceSettingsService.get();
  res.json({ success: true, data });
});

const updateSettings = asyncHandler(async (req, res) => {
  const result = await faceSettingsService.update(req.body, req.user.id);
  res.json({ success: true, ...result });
});

const switchModel = asyncHandler(async (req, res) => {
  const result = await faceSettingsService.switchModel(req.body, req.user.id);
  res.json({ success: true, data: result });
});

module.exports = {
  listKiosks,
  getKiosk,
  createKiosk,
  updateKiosk,
  issuePairingCode,
  cancelPairingCode,
  updateSetupPin,
  revokeKiosk,
  suspendKiosk,
  resumeKiosk,
  deleteKiosk,
  listPeople,
  getProfile,
  addSample,
  removeSample,
  removeProfile,
  setProfileActive,
  listEvents,
  getOverview,
  getEventSnapshot,
  getSampleSnapshot,
  getSettings,
  updateSettings,
  switchModel,
};
