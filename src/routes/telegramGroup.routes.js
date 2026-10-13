const express = require("express");
const router = express.Router();
const {
  protect,
  authorizePermission,
} = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const {
  getGroups,
  refreshGroups,
  setOfficial,
} = require("../controllers/telegramGroup.controller");

// TELEGRAM GURUHLARI — "Muammolar → Bot sozlamalari" tabi.
//
// ⚠️ UCHALASI HAM `issues.botSettings` ORTIDA, `issues.view` yetarli
// EMAS: ro'yxatda guruh nomlari va chat ID lar bor, ya'ni botning tashqi
// aloqalari manzarasi. "Muammolarni ko'rish" huquqi uni ochmasligi kerak.
//
// ⚠️ `:chatId` — Telegram beradigan son (manfiy: "-1001234..."), ObjectId
// EMAS, shuning uchun `validateObjectId` ISHLATILMAYDI — u bu qiymatni
// rad etardi.

router.use(protect);

router.get("/", authorizePermission(PERMISSIONS.ISSUES_BOTSETTINGS), getGroups);

router.post(
  "/refresh",
  authorizePermission(PERMISSIONS.ISSUES_BOTSETTINGS),
  refreshGroups,
);

router.patch(
  "/:chatId/official",
  authorizePermission(PERMISSIONS.ISSUES_BOTSETTINGS),
  setOfficial,
);

module.exports = router;
