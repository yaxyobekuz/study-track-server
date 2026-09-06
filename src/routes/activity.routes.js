/**
 * FAOLLIK — "tizimdan KIM foydalanyapti?".
 *
 * ⚠️ FAQAT O'QISH. Yozadigan amal yo'q va bo'lmaydi ham: faollik
 * hodisalarini `activity.service.js` yozadi (bot va `auth.middleware`),
 * bu yerga esa "qo'lda qo'shish" tugmasi qo'yilsa, hisobotni soxtalash
 * yo'li ochilardi.
 *
 * ⚠️ `statistics` BO'LIMIDAN ALOHIDA. Statistika NATIJANI o'lchaydi
 * (baho, davomat, tushum), faollik esa JALB QILINGANLIKNI — bular ikki
 * xil qaror va ikki xil ruxsat (`utils/permissions.js` dagi izoh).
 */

const express = require("express");
const router = express.Router();

const {
  protect,
  authorizePermission,
  authorizeSection,
} = require("../middleware/auth.middleware");
const { PERMISSIONS, SECTIONS } = require("../utils/permissions");

const {
  getOverview,
  getSubject,
  getClass,
} = require("../controllers/activity.controller");
const { validateObjectId } = require("../middleware/validate.middleware");

router.use(protect);
router.use(authorizeSection(SECTIONS.ACTIVITY));

// Butun manzara. Foydalanmayotganlarning ISM-RO'YXATI faqat
// `activity.roster` bilan qo'shiladi — qaror controller'da.
router.get("/overview", authorizePermission(PERMISSIONS.ACTIVITY_VIEW), getOverview);

// Bitta odamning faollik tarixi (xodim kartasi / ota-ona kartasi)
router.get("/subject", authorizePermission(PERMISSIONS.ACTIVITY_SESSIONS), getSubject);

// Bitta sinfning kesimi — kim foydalanadi, kim yo'q.
//
// ⚠️ `ACTIVITY_ROSTER`, `ACTIVITY_VIEW` EMAS: javobda ota-onalar va
// o'quvchilarning ISMLARI bor. Umumiy foizni ko'rish huquqi bu
// ro'yxatni ochib bermasligi kerak — bo'limning butun ruxsat shakli
// shu ajratishga tayanadi.
router.get(
  "/classes/:classId",
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.ACTIVITY_ROSTER),
  getClass,
);

module.exports = router;
