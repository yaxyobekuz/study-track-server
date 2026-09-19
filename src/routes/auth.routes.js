// Express
const express = require("express");
const router = express.Router();

// Middlewares
const { protect } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");

// Controllers
const {
  login,
  getMe,
  switchBranch,
  logout,
  listMySessions,
  terminateMySession,
  terminateOtherSessions,
} = require("../controllers/auth.controller");

// Public routes
router.post("/login", login);

// Protected routes
router.get("/me", protect, getMe);

// Filial almashtirish — tekshiruv service ichida: xodim faqat O'ZI
// BIRIKTIRILGAN filiallarga o'ta oladi (owner esa hammasiga). Ro'yxatning
// o'zi grant bo'lgani uchun alohida ruxsat kaliti yo'q.
router.post("/switch-branch", protect, switchBranch);

// Chiqish — seansni yopadi. `protect` bilan: qaysi seansni yopishni
// tokenning `jti` si aytadi va uni faqat tekshirilgan token beradi.
router.post("/logout", protect, logout);

// O'z seanslarim ("Qurilmalar"). Ruxsat kaliti YO'Q — faqat o'ziniki,
// identifikator tokendan. ⚠️ `/others` `/:id` dan OLDIN turadi.
router.get("/sessions", protect, listMySessions);
router.delete("/sessions/others", protect, terminateOtherSessions);
router.delete(
  "/sessions/:id",
  protect,
  validateObjectId("id"),
  terminateMySession,
);

module.exports = router;
