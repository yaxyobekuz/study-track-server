const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();

const { protectKiosk } = require("../middleware/kiosk.middleware");
const controller = require("../controllers/kiosk.controller");

/**
 * KIOSK YO'LLARI — QURILMA TOKENI bilan (`X-Kiosk-Token`).
 *
 * ⚠️ `protect` (odam tokeni) BU FAYLDA ISHLATILMAYDI va `req.user`
 * qo'yilmaydi. Kiosk hech kimning nomidan ish qilmaydi — u faqat "kim
 * keldi" degan faktni keltiradi. Shuning uchun bu yerda biometrika
 * YOZADIGAN amal YO'Q: ro'yxatga olish odatiy login bilan
 * `/api/face-id/profiles/:userId/samples` orqali ketadi
 * (`.claude/rules/face-id.md` §9).
 *
 * ⚠️ Bu router `routes/index.js` da `aggregateDispatch` ORQALI
 * mount qilinadi, lekin umumiy ko'rinish (`scope: "all"`) unga
 * tegmaydi: dispatcher faqat `isAggregateToken` bo'lgan so'rovni
 * fan-out qiladi va kiosk tokeni unday emas.
 */

/**
 * BIRIKTIRISH — PUBLIC va QATTIQ CHEKLANGAN.
 *
 * ⚠️ Yagona tokensiz yo'l, ya'ni yagona brute-force nishoni. Kod 31
 * belgidan 8 ta (~10^11 variant) bo'lsa ham, chegara kerak: usiz
 * kodlarni ketma-ket terib ko'rish hech qayerda to'silmasdi (umumiy
 * `/api` limiti daqiqada 100 so'rovga ruxsat beradi).
 *
 * ⚠️ `index.js` dagi login limiteri bilan ARALASHTIRILMAYDI: u
 * `username` bo'yicha xavfsizlik jurnaliga yozadi, bu yerda esa
 * username yo'q.
 */
const pairLimiter = rateLimit({
  max: 10,
  windowMs: 15 * 60 * 1000,
  message: {
    success: false,
    message: "Juda ko'p urinish. 15 daqiqadan so'ng qayta urinib ko'ring.",
  },
});
router.post("/pair", pairLimiter, controller.pair);

/**
 * PIN TEKSHIRUVI — o'z limiti.
 *
 * PIN 4 raqam (10 000 variant), ya'ni bu HAQIQIY brute-force nishoni.
 * Qurilma tokeni bo'lgani uchun hujumchi allaqachon kiosk oldida
 * turgan, lekin sozlama ekrani kamerani va filialni ochadi — chegara
 * baribir kerak.
 */
const pinLimiter = rateLimit({
  max: 10,
  windowMs: 10 * 60 * 1000,
  message: {
    success: false,
    message: "Juda ko'p urinish. 10 daqiqadan so'ng qayta urinib ko'ring.",
  },
});

// ── Tokenli yo'llar ──────────────────────────────────────────────
router.use(protectKiosk);

router.get("/me", controller.heartbeat);
router.post("/heartbeat", controller.heartbeat);
router.get("/gallery", controller.getGallery);
router.post("/checks", controller.submitCheck);
router.post("/checks/bulk", controller.submitBulk);
router.post("/setup/verify-pin", pinLimiter, controller.verifySetupPin);

module.exports = router;
