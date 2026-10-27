const express = require("express");
const router = express.Router();

const {
  protect,
  authorizePermission,
  authorizeSection,
} = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS, SECTIONS } = require("../utils/permissions");
const controller = require("../controllers/faceId.controller");

/**
 * FACE ID — PANEL YO'LLARI (odam tokeni).
 *
 * ⚠️ KIOSK YO'LLARI ALOHIDA (`kiosk.routes.js`, `protectKiosk`). Bu
 * yerda har so'rov odam tokeni bilan keladi va ruxsat tekshiriladi —
 * biometrika YOZADIGAN amallar faqat shu fayldan o'tadi
 * (`.claude/rules/face-id.md` §9).
 *
 * ⚠️ Bo'limga umumiy darvoza `authorizeSection`: hech bo'lmasa bitta
 * `faceId.*` amali bo'lmagan xodim butun bo'limni ko'rmaydi. Aniq amal
 * tekshiruvi har yo'lda alohida.
 */
router.use(protect, authorizeSection(SECTIONS.FACE_ID));

// ── MANZARA VA SOZLAMA (`/:id` dan OLDIN) ────────────────────────
router.get("/overview", authorizePermission(PERMISSIONS.FACEID_VIEW), controller.getOverview);
router.get("/settings", authorizePermission(PERMISSIONS.FACEID_VIEW), controller.getSettings);
router.put("/settings", authorizePermission(PERMISSIONS.FACEID_SETTINGS), controller.updateSettings);
// MODEL ALMASHTIRISH — migratsiya, sozlama emas (service izohiga qarang)
router.post("/settings/model", authorizePermission(PERMISSIONS.FACEID_SETTINGS), controller.switchModel);

// ── URINISHLAR JURNALI ───────────────────────────────────────────
//
// ⚠️ `faceId.events` — `view` DAN ALOHIDA kalit: jurnal kirish
// eshigidagi kameraning KADRLARINI ko'rsatadi (`security.sessions`
// bilan ayni mulohaza).
router.get("/events", authorizePermission(PERMISSIONS.FACEID_EVENTS), controller.listEvents);
router.get(
  "/events/:id/snapshot",
  authorizePermission(PERMISSIONS.FACEID_EVENTS),
  validateObjectId("id"),
  controller.getEventSnapshot,
);

// ── KIOSKLAR ─────────────────────────────────────────────────────
router.get("/kiosks", authorizePermission(PERMISSIONS.FACEID_VIEW), controller.listKiosks);
router.post("/kiosks", authorizePermission(PERMISSIONS.FACEID_KIOSKS), controller.createKiosk);
router.get(
  "/kiosks/:id",
  authorizePermission(PERMISSIONS.FACEID_VIEW),
  validateObjectId("id"),
  controller.getKiosk,
);
router.put(
  "/kiosks/:id",
  authorizePermission(PERMISSIONS.FACEID_KIOSKS),
  validateObjectId("id"),
  controller.updateKiosk,
);
router.put(
  "/kiosks/:id/pin",
  authorizePermission(PERMISSIONS.FACEID_KIOSKS),
  validateObjectId("id"),
  controller.updateSetupPin,
);

// ⚠️ BIRIKTIRISH VA BEKOR QILISH — `faceId.pair`, `faceId.kiosks` EMAS.
// Kod berish YANGI KOMPYUTERNI maktab davomatiga ulash huquqi, bekor
// qilish esa ishlab turgan qurilmani UZIB QO'YISH. Qurilma nomini
// tahrirlash bilan bir xil og'irlikda emas.
router.post(
  "/kiosks/:id/pairing-code",
  authorizePermission(PERMISSIONS.FACEID_PAIR),
  validateObjectId("id"),
  controller.issuePairingCode,
);
router.delete(
  "/kiosks/:id/pairing-code",
  authorizePermission(PERMISSIONS.FACEID_PAIR),
  validateObjectId("id"),
  controller.cancelPairingCode,
);
router.post(
  "/kiosks/:id/revoke",
  authorizePermission(PERMISSIONS.FACEID_PAIR),
  validateObjectId("id"),
  controller.revokeKiosk,
);
router.post(
  "/kiosks/:id/suspend",
  authorizePermission(PERMISSIONS.FACEID_KIOSKS),
  validateObjectId("id"),
  controller.suspendKiosk,
);
router.post(
  "/kiosks/:id/resume",
  authorizePermission(PERMISSIONS.FACEID_KIOSKS),
  validateObjectId("id"),
  controller.resumeKiosk,
);
router.delete(
  "/kiosks/:id",
  authorizePermission(PERMISSIONS.FACEID_KIOSKS),
  validateObjectId("id"),
  controller.deleteKiosk,
);

// ── YUZ NAMUNALARI ───────────────────────────────────────────────
router.get("/people", authorizePermission(PERMISSIONS.FACEID_VIEW), controller.listPeople);

// ⚠️ Namuna rasmi `faceId.events` bilan, `view` bilan EMAS: bu ham
// odamning yuz kadri (jurnaldagi kadr bilan bir xil maxfiylikda).
router.get(
  "/samples/:id/snapshot",
  authorizePermission(PERMISSIONS.FACEID_EVENTS),
  validateObjectId("id"),
  controller.getSampleSnapshot,
);
router.delete(
  "/samples/:id",
  authorizePermission(PERMISSIONS.FACEID_UNENROLL),
  validateObjectId("id"),
  controller.removeSample,
);

router.get(
  "/profiles/:userId",
  authorizePermission(PERMISSIONS.FACEID_VIEW),
  validateObjectId("userId"),
  controller.getProfile,
);
router.post(
  "/profiles/:userId/samples",
  authorizePermission(PERMISSIONS.FACEID_ENROLL),
  validateObjectId("userId"),
  controller.addSample,
);
// Vaqtincha o'chirish — namunani SAQLAB. `unenroll` bilan: taqqoslashdan
// chiqarish odamni kiosk oldida "tanilmadi" holatiga tushiradi.
router.patch(
  "/profiles/:userId/active",
  authorizePermission(PERMISSIONS.FACEID_UNENROLL),
  validateObjectId("userId"),
  controller.setProfileActive,
);
router.delete(
  "/profiles/:userId",
  authorizePermission(PERMISSIONS.FACEID_UNENROLL),
  validateObjectId("userId"),
  controller.removeProfile,
);

module.exports = router;
