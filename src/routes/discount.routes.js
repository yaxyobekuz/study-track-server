// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getDiscounts,
  getDiscount,
  createDiscount,
  updateDiscount,
  archiveDiscount,
  deleteDiscount,
  getAssignments,
  getStudentDiscounts,
  getAssignment,
  createAssignment,
  bulkAssign,
  updateAssignment,
  closeAssignment,
  deleteAssignment,
} = require("../controllers/discount.controller");

// ── Biriktirishlar ───────────────────────────
// `/assignments` `/:id` dan OLDIN — aks holda "assignments" id sifatida
// o'qiladi va validateObjectId yiqiladi (tariff.routes.js dagi tuzoq).
router.get("/assignments", protect, authorizePermission(PERMISSIONS.DISCOUNTS_VIEW), getAssignments);
router.post("/assignments", protect, authorizePermission(PERMISSIONS.DISCOUNTS_ASSIGN), createAssignment);
router.post("/assignments/bulk", protect, authorizePermission(PERMISSIONS.DISCOUNTS_ASSIGN), bulkAssign);
router.get("/assignments/student/:studentId", protect, validateObjectId("studentId"), authorizePermission(PERMISSIONS.DISCOUNTS_VIEW), getStudentDiscounts);
router.get("/assignments/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.DISCOUNTS_VIEW), getAssignment);
router.put("/assignments/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.DISCOUNTS_ASSIGN), updateAssignment);
router.patch("/assignments/:id/close", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.DISCOUNTS_ASSIGN), closeAssignment);
router.delete("/assignments/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.DISCOUNTS_ASSIGN), deleteAssignment);

// ── Katalog ──────────────────────────────────
router.get("/", protect, authorizePermission(PERMISSIONS.DISCOUNTS_VIEW), getDiscounts);
router.post("/", protect, authorizePermission(PERMISSIONS.DISCOUNTS_CREATE), createDiscount);
router.get("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.DISCOUNTS_VIEW), getDiscount);
router.put("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.DISCOUNTS_UPDATE), updateDiscount);
router.patch("/:id/archive", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.DISCOUNTS_UPDATE), archiveDiscount);
router.delete("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.DISCOUNTS_DELETE), deleteDiscount);

module.exports = router;
