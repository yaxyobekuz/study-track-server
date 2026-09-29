/**
 * OTA-ONA NAZORATI — yo'llar (`/api/parental`).
 *
 * Ikki mijoz, bitta o'quvchi hisobi:
 *   - OTA-ONA ILOVASI (`X-Client: parent`) — `/parental/*`
 *   - BOLANING TELEFONI, o'quvchi ilovasi (`X-Client: student`) —
 *     `/parental/device/*`, `X-Device-Id` majburiy
 *
 * [T] — `requireParentalToken`: PIN bilan olingan `X-Parental-Token`.
 * O'qish yo'llari tokensiz — bola o'z statistikasini ko'rsa zarar yo'q
 * (nazorat YASHIRIN emas).
 *
 * ⚠️ YO'L TARTIBI: `/device/*` va `/apps` (statik) `/apps/:appId` dan OLDIN.
 */

const express = require("express");
const rateLimit = require("express-rate-limit");
const xss = require("xss-clean");

const { protect } = require("../middleware/auth.middleware");
const {
  requireStudentAccount,
  requireDeviceId,
  rejectParentChannel,
  requireParentChannel,
  requireParentalToken,
  parentalTokenIfPinSet,
} = require("../middleware/parental.middleware");
const { TooManyRequestsError } = require("../utils/errors");
const parentalController = require("../controllers/parental.controller");

const router = express.Router();

/**
 * PIN TIKLASH — HISOB PAROLINI tekshiradi, ya'ni parol terish uchun
 * ikkinchi eshik. Login'dagi kabi cheklanadi, lekin HISOB bo'yicha
 * (IP emas): bitta hisobga turli tarmoqlardan urinish ham sanaladi.
 */
const pinResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `parental-pin-reset:${req.branch?.id || "-"}:${req.user.id}`,
  handler: (req, res, next) => {
    const resetTime = req.rateLimit?.resetTime;
    const retryAfterSec = resetTime
      ? Math.max(1, Math.ceil((new Date(resetTime).getTime() - Date.now()) / 1000))
      : 15 * 60;
    const error = new TooManyRequestsError(
      "PIN tiklash urinishlari juda ko'p — 15 daqiqadan keyin qayta urinib ko'ring",
    );
    error.details = { reason: "pin_reset_rate_limited", retryAfterSec };
    next(error);
  },
});

router.use(protect, requireStudentAccount);

// ═════════════════════════════════════════════════════════════
// BOLANING TELEFONI — o'quvchi ilovasi (parental token KERAK EMAS)
// ═════════════════════════════════════════════════════════════
const device = express.Router();
device.use(requireDeviceId, rejectParentChannel);

/**
 * TANA SHU YERDA o'qiladi — `index.js` bu yo'llarni umumiy parserdan
 * o'tkazib yuboradi: katta chegara faqat autentifikatsiyadan KEYIN.
 * `xss()` umumiy zanjirdagi bilan AYNI (u yerda tana hali yo'q edi).
 *
 * ⚠️ TARTIB: `/apps` (10 MB) umumiy 3 MB parserdan OLDIN — aks holda
 * 3 MB parser tanani birinchi o'qib, katta ro'yxatni 413 bilan qaytarardi.
 */
const bodyOf = (limit) => [express.json({ limit }), xss()];

device.post("/apps", ...bodyOf("10mb"), parentalController.syncApps);
device.use(...bodyOf("3mb"));

device.post("/register", parentalController.registerDevice);
device.put("/health", parentalController.reportHealth);
device.post("/usage", parentalController.reportUsage);
device.get("/policy", parentalController.getPolicy);
device.post("/events", parentalController.reportEvents);
device.post("/unlock-request", parentalController.requestUnlock);
device.get("/unlock-request/:id", parentalController.getUnlockRequest);

router.use("/device", device);

// ═════════════════════════════════════════════════════════════
// OTA-ONA ILOVASI
// ═════════════════════════════════════════════════════════════
router.get("/status", parentalController.getStatus);

// PIN: birinchi o'rnatish tokensiz, almashtirish — [T]
router.post("/pin", requireParentChannel, parentalTokenIfPinSet, parentalController.setPin);
router.post("/pin/verify", requireParentChannel, parentalController.verifyPin);
router.post("/pin/reset", requireParentChannel, pinResetLimiter, parentalController.resetPin);

router.get("/usage", parentalController.getUsage);

router.get("/apps", parentalController.listApps);
router.put("/apps", requireParentalToken, parentalController.bulkUpdateApps);
router.put("/apps/:appId", requireParentalToken, parentalController.updateApp);

router.put("/lock-all", requireParentalToken, parentalController.setLockAll);
router.put("/settings", requireParentalToken, parentalController.updateSettings);

router.get("/events", parentalController.listEvents);

router.get("/unlock-requests", parentalController.listUnlockRequests);
router.post(
  "/unlock-requests/:id",
  requireParentalToken,
  parentalController.decideUnlockRequest,
);

module.exports = router;
