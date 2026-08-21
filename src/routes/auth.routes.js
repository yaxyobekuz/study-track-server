// Express
const express = require("express");
const router = express.Router();

// Middlewares
const { protect } = require("../middleware/auth.middleware");

// Controllers
const { login, getMe, switchBranch } = require("../controllers/auth.controller");

// Public routes
router.post("/login", login);

// Protected routes
router.get("/me", protect, getMe);

// Filial almashtirish — ruxsat tekshiruvi service ichida (owner yoki
// `branches.switch`), chunki qoida `getMe` javobidagi `canSwitchBranch`
// bilan bir manbadan kelishi kerak.
router.post("/switch-branch", protect, switchBranch);

module.exports = router;
