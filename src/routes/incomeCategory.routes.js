// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getCategories,
  createCategory,
  updateCategory,
  archiveCategory,
} = require("../controllers/incomeCategory.controller");

// Ro'yxatni kirim qo'shadigan har kim ko'radi (oynadagi tanlagich uchun),
// lekin katalogni O'ZGARTIRISH alohida huquq.
router.get("/", protect, authorizePermission(PERMISSIONS.INCOME_VIEW), getCategories);
router.post("/", protect, authorizePermission(PERMISSIONS.INCOME_CATEGORIES), createCategory);
router.put("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.INCOME_CATEGORIES), updateCategory);
router.patch("/:id/archive", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.INCOME_CATEGORIES), archiveCategory);

module.exports = router;
