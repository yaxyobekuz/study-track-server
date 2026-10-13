// GLOBAL QIDIRUV — admin paneldagi sidebar qidiruvi.
//
// Ruxsat — `users.view`: natijada ism, username va rol bo'ladi, ya'ni bu
// foydalanuvchilar ro'yxatining o'zi. Qaysi FILIALLAR qidirilishi service
// ichida kesiladi (owner — hammasi, qolgan xodim — faqat o'zi kira
// oladigani), shuning uchun bu ruxsat boshqa filial ma'lumotini ochib
// bermaydi.

const express = require("express");
const router = express.Router();

const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { searchUsers } = require("../controllers/globalSearch.controller");

router.get("/users", protect, authorizePermission(PERMISSIONS.USERS_VIEW), searchUsers);

module.exports = router;
