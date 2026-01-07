// Express
const express = require("express");
const router = express.Router();

// Middlewares
const { protect } = require("../middleware/auth.middleware");

// Controllers
const { login, getMe } = require("../controllers/auth.controller");

// Public routes
router.post("/login", login);

// Protected routes
router.get("/me", protect, getMe);

module.exports = router;
