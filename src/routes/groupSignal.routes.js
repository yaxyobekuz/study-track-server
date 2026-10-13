const express = require("express");
const router = express.Router();
const {
  protect,
  authorizePermission,
} = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const {
  getSignals,
  getCounts,
  refreshSignals,
  attachSignal,
  dismissSignal,
} = require("../controllers/groupSignal.controller");

// GURUH SIGNALLARI — "Muammolar → Guruh signallari" tabi.
//
// ⚠️ HAMMASI `issues.signals` ORTIDA, `issues.view` yetarli EMAS: bu
// yerda guruhdagi odamlarning gaplari IQTIBOS bilan turadi — muammolar
// ro'yxatidan nozikroq ma'lumot (`permissions.js` izohi).
//
// ⚠️ BIRIKTIRISH ham shu kalit bilan: u yangi MUAMMO yaratadi, lekin
// manbasini faqat shu tabni ko'ra oladigan odam baholay oladi. Alohida
// `issues.review` talab qilinsa, signalni ko'rgan odam uni ishga
// qo'ya olmay qolardi.
//
// ⚠️ `:id` — ObjectId (signal id), `telegram-groups` dagi `:chatId` dan
// FARQLI: u yerda Telegram'ning manfiy soni edi va tekshirilmasdi.

router.use(protect);

router.get("/", authorizePermission(PERMISSIONS.ISSUES_SIGNALS), getSignals);

// ⚠️ `/counts` `/:id` DAN OLDIN — aks holda "counts" id deb o'qilib,
// `validateObjectId` uni rad etardi (`issue.routes.js` dagi ayni tuzoq).
router.get(
  "/counts",
  authorizePermission(PERMISSIONS.ISSUES_SIGNALS),
  getCounts,
);

// ⚠️ `/refresh` ham `/:id/...` DAN OLDIN — "refresh" id deb o'qilmasligi
// uchun (`/counts` bilan ayni sabab).
router.post(
  "/refresh",
  authorizePermission(PERMISSIONS.ISSUES_SIGNALS),
  refreshSignals,
);

router.post(
  "/:id/attach",
  authorizePermission(PERMISSIONS.ISSUES_SIGNALS),
  validateObjectId("id"),
  attachSignal,
);

router.post(
  "/:id/dismiss",
  authorizePermission(PERMISSIONS.ISSUES_SIGNALS),
  validateObjectId("id"),
  dismissSignal,
);

module.exports = router;
