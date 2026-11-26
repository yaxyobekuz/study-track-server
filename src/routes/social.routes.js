/**
 * ISTORIYALAR, MEDIA VA SHIKOYATLAR — `/api/social/*`.
 *
 * ⚠️ BUTUN ROUTER XODIMLAR UCHUN. Darvoza `router.use` da bir marta
 * qo'yiladi: har endpointga alohida yozilsa, keyin qo'shilgan bitta yo'l
 * jimgina o'quvchiga ochilib ketardi (`finance.md` §15 bilan AYNI
 * mulohaza — darvoza BITTA joyda).
 *
 * ⚠️ RUXSAT KALITI YO'Q (`stories.moderate` dan tashqari): huquq XODIM
 * BO'LISHDAN keladi — `/tutor-groups/my` va `/class-leaders/my` bilan
 * AYNI qoida. Kalit qo'yilsa, yangi o'qituvchi uni kimdir qo'lda
 * bergunicha lentani umuman ko'rmasdi.
 */

const express = require("express");
const rateLimit = require("express-rate-limit");
// ⚠️ IPv6 uchun MAJBURIY: `express-rate-limit` v8 xom IP'ni kalit qilib
// olishni rad etadi (bitta /64 tarmoqdan cheksiz manzil chiqarib, chegarani
// aylanib o'tish mumkin). Odam tokeni bo'lmagan holat uchun zaxira kalit.
const { ipKeyGenerator } = require("express-rate-limit");

const router = express.Router();

const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { createSingleFileUpload } = require("../middleware/fileUpload.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const socialAccess = require("../services/socialAccess.service");
const controller = require("../controllers/social.controller");

/**
 * TEZLIK CHEGARALARI — bir odamga.
 *
 * ⚠️ `keyGenerator` FOYDALANUVCHI BO'YICHA, IP bo'yicha EMAS: maktabda
 * hamma bitta NAT ortida turadi, ya'ni IP bo'yicha chegara bitta
 * o'qituvchining faolligi sababli butun maktabni to'sib qo'yardi.
 */
const perUser = (max, windowMs, message) =>
  rateLimit({
    max,
    windowMs,
    keyGenerator: (req) => (req.user?.id ? String(req.user.id) : ipKeyGenerator(req.ip)),
    message: { success: false, message },
  });

const commentLimiter = perUser(20, 60_000, "Juda ko'p izoh yozildi, biroz kuting");
const likeLimiter = perUser(60, 60_000, "Juda ko'p urinish, biroz kuting");
const viewLimiter = perUser(30, 60_000, "Juda ko'p so'rov, biroz kuting");
const uploadLimiter = perUser(30, 60_000, "Juda ko'p fayl yuklandi, biroz kuting");

router.use(protect);

// ⚠️ IKKI DARVOZA, BITTA JOYDA: bo'lim shu filialda yoqilganmi (pilot
// bayrog'i) va odam xodimmi (ota-ona kanali ham shu yerda to'siladi).
router.use((req, res, next) => {
  socialAccess.assertEnabled(req.branch);
  socialAccess.assertStaff(req.user, req.sessionChannel);
  next();
});

/* ─────────────────────────── MEDIA ─────────────────────────── */

router.post("/uploads", uploadLimiter, controller.createUpload);
router.post("/uploads/:id/complete", validateObjectId("id"), controller.completeUpload);
// LOKAL DEV: presign bo'lmaganda ilova faylni serverga yuboradi.
// ⚠️ `createSingleFileUpload` MAJBURIY (bare `multer` EMAS): u filial
// kontekstini saqlaydi (`fileUpload.middleware.js` izohi).
router.post(
  "/uploads/:id/binary",
  validateObjectId("id"),
  ...createSingleFileUpload({
    fieldName: "file",
    categories: ["image", "video", "audio", "document"],
  }),
  controller.putBinary,
);
router.get("/media/:id", validateObjectId("id"), controller.getMedia);

/* ─────────────────────────── ISTORIYALAR ─────────────────────────── */

// ⚠️ STATIK YO'LLAR `/:id` DAN OLDIN: aks holda "feed" va "quota"
// istoriya id si sifatida o'qilardi (`/class-leaders/my` bilan AYNI qoida).
router.get("/stories/feed", controller.getFeed);
router.get("/stories/quota", controller.getQuota);
router.post("/stories/views", viewLimiter, controller.recordViews);

router.post("/stories", controller.createStory);
router.get("/stories/:id", validateObjectId("id"), controller.getStory);
router.delete("/stories/:id", validateObjectId("id"), controller.deleteStory);

router.post("/stories/:id/like", validateObjectId("id"), likeLimiter, controller.likeStory);
router.delete("/stories/:id/like", validateObjectId("id"), likeLimiter, controller.unlikeStory);

router.get("/stories/:id/viewers", validateObjectId("id"), controller.listViewers);
router.get("/stories/:id/likes", validateObjectId("id"), controller.listLikes);
router.get("/stories/:id/comments", validateObjectId("id"), controller.listComments);
router.post(
  "/stories/:id/comments",
  validateObjectId("id"),
  commentLimiter,
  controller.addComment,
);
router.delete(
  "/stories/:id/comments/:commentId",
  validateObjectId("id"),
  validateObjectId("commentId"),
  controller.deleteComment,
);

/* ─────────────────────────── PROFIL ─────────────────────────── */

router.get("/users/:userId/stories", validateObjectId("userId"), controller.getUserStories);
// Nomaqbul profil rasmini olib tashlash — moderator huquqi
router.delete(
  "/users/:userId/avatar",
  validateObjectId("userId"),
  authorizePermission(PERMISSIONS.STORIES_MODERATE),
  controller.removeUserAvatar,
);

/* ─────────────────────────── SHIKOYATLAR ─────────────────────────── */

router.post("/reports", controller.createReport);
router.get(
  "/reports",
  authorizePermission(PERMISSIONS.STORIES_MODERATE),
  controller.listReports,
);
router.patch(
  "/reports/:id/resolve",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.STORIES_MODERATE),
  controller.resolveReport,
);

module.exports = router;
