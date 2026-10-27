/**
 * KIOSK CONTROLLERLARI — QURILMA TOKENI bilan (`X-Kiosk-Token`).
 *
 * ⚠️ BU FAYLDA `req.user` YO'Q va bo'lmasligi SHART. Kiosk — odam emas,
 * qurilma: u hech kimning nomidan ish qilmaydi, faqat "kim keldi" degan
 * faktni keltiradi. Shuning uchun bu yo'llar `authorizePermission` dan
 * o'tmaydi va ularda biometrika YOZADIGAN amal YO'Q — ro'yxatga olish
 * odatiy login bilan, `/api/face-id/...` orqali ketadi
 * (`.claude/rules/face-id.md` §9).
 *
 * `req.kiosk` va `req.branch` — `middleware/kiosk.middleware.js` dan.
 */

const asyncHandler = require("../middleware/async.middleware");
const kioskService = require("../services/kiosk.service");
const faceAttendanceService = require("../services/faceAttendance.service");
const faceGalleryService = require("../services/faceGallery.service");
const faceSettingsService = require("../services/faceSettings.service");
const { getFaceSettings } = require("../services/settings.service");
const { clientIp } = require("../helpers/request.helpers");
const { ForbiddenError, UnauthorizedError } = require("../utils/errors");

/**
 * BIRIKTIRISH — PUBLIC yo'l (token hali yo'q).
 *
 * Hakam — bir martalik kod (`kiosk.service.pair`). Yo'l `index.js` da
 * alohida, qattiq rate-limit ortida: kodni terib ko'rishga urinish
 * boshqa hech qayerda to'silmaydi.
 */
const pair = asyncHandler(async (req, res) => {
  const result = await kioskService.pair(req.body, clientIp(req));
  res.status(201).json({ success: true, data: result });
});

/**
 * HEARTBEAT — kiosk tirikligini yozadi va javobida ISH UCHUN KERAKLI
 * HAMMA NARSANI qaytaradi: sozlama, galereya versiyasi, server vaqti.
 *
 * ⚠️ `serverTime` MAJBURIY: kioskdagi soat buzilgan bo'lishi mumkin
 * (BIOS batareyasi) va u oflayn qaydlarga vaqt yozadi. Kiosk shu
 * qiymat bilan o'z siljishini hisoblab, qaydlarni to'g'rilaydi —
 * aks holda kelasi yilga yozilgan davomat hisobotni buzardi.
 */
const heartbeat = asyncHandler(async (req, res) => {
  await kioskService.touch(req.kiosk.id, req.body, req.clientIp);
  const settings = await getFaceSettings();

  res.json({
    success: true,
    data: {
      kiosk: kioskService.kioskSelf(req.kiosk, req.branch),
      settings: faceSettingsService.forKiosk(settings),
      serverTime: new Date().toISOString(),
    },
  });
});

/**
 * GALEREYA — oflayn rejim uchun vektorlar.
 *
 * ⚠️ `?version=` bilan kelsa va o'zgarmagan bo'lsa `{ unchanged: true }`
 * qaytadi. Aks holda kirish eshigidagi kiosk har daqiqada 20 MB
 * yuklab olardi.
 *
 * ⚠️ `offlineGalleryEnabled` o'chirilgan filialda RAD etiladi: bu
 * sozlamaning butun ma'nosi "biometrika qurilmada yotmasin" degan
 * qarorda va uni chetlab o'tadigan yo'l qolmasligi kerak.
 */
const getGallery = asyncHandler(async (req, res) => {
  const settings = await getFaceSettings();

  if (!settings.offlineGalleryEnabled) {
    const error = new ForbiddenError(
      "Bu filialda oflayn rejim o'chirilgan — kiosk internetsiz ishlamaydi",
    );
    error.details = { reason: "offline_disabled" };
    throw error;
  }

  const requested = Number(req.query.version);
  if (Number.isFinite(requested) && requested === settings.galleryVersion) {
    return res.json({
      success: true,
      data: { unchanged: true, version: settings.galleryVersion },
    });
  }

  const data = await faceGalleryService.exportForKiosk(settings);
  return res.json({ success: true, data });
});

/** Bitta skaner — asosiy yo'l. */
const submitCheck = asyncHandler(async (req, res) => {
  const result = await faceAttendanceService.submitCheck({
    ...req.body,
    kiosk: req.kiosk,
    offline: false,
  });
  res.status(result.ok ? 201 : 200).json({ success: true, data: result });
});

/**
 * OFLAYN NAVBATNI QABUL QILADI.
 *
 * ⚠️ HTTP 200 QAYTADI, hatto ba'zi qaydlar rad etilgan bo'lsa ham:
 * kiosk javobdagi har bir natijaga qarab navbatdan o'chiradi. 4xx
 * qaytarilsa, bitta buzuq qayd butun navbatni abadiy qamab qo'yardi.
 */
const submitBulk = asyncHandler(async (req, res) => {
  const result = await faceAttendanceService.submitBulk({
    kiosk: req.kiosk,
    events: req.body?.events,
  });
  res.json({ success: true, data: result });
});

/**
 * SOZLAMA EKRANINI OCHISH — PIN tekshiruvi.
 *
 * ⚠️ Bu yo'l ONLAYN tekshiruv. Internetsiz holatda kiosk o'zi, lokal
 * keshdagi hash bilan tekshiradi (`heartbeat` javobidagi `setupPin`) —
 * ikkalasi AYNI algoritm (PBKDF2-SHA256), ya'ni natija bir xil.
 */
const verifySetupPin = asyncHandler(async (req, res) => {
  const ok = await kioskService.verifySetupPin(req.kiosk, req.body?.pin);
  if (!ok) {
    const error = new UnauthorizedError("PIN kod noto'g'ri");
    error.details = { reason: "invalid_pin" };
    throw error;
  }
  res.json({ success: true, data: { ok: true } });
});

module.exports = {
  pair,
  heartbeat,
  getGallery,
  submitCheck,
  submitBulk,
  verifySetupPin,
};
