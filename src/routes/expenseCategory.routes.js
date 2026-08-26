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
} = require("../controllers/expenseCategory.controller");

// Ro'yxatni xarajat qo'shadigan har kim ko'radi (oynadagi tanlagich uchun),
// lekin katalogni O'ZGARTIRISH alohida huquq.
router.get("/", protect, authorizePermission(PERMISSIONS.EXPENSES_VIEW), getCategories);
router.post("/", protect, authorizePermission(PERMISSIONS.EXPENSES_CATEGORIES), createCategory);
router.put("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.EXPENSES_CATEGORIES), updateCategory);
router.patch("/:id/archive", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.EXPENSES_CATEGORIES), archiveCategory);

module.exports = router;
