// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getServices,
  createService,
  updateService,
  archiveService,
  deleteService,
  getStudentsWithServices,
  getAssignment,
  createAssignment,
  updateAssignment,
  closeAssignment,
  deleteAssignment,
} = require("../controllers/service.controller");

// ── O'quvchilar ro'yxati (xizmatlari bilan) ──
// `/students` va `/assignments` `/:id` dan OLDIN — aks holda so'z id sifatida
// o'qiladi va validateObjectId yiqiladi (discount.routes.js dagi tuzoq).
router.get("/students", protect, authorizePermission(PERMISSIONS.SERVICES_VIEW), getStudentsWithServices);

// ── Biriktirishlar ───────────────────────────
router.post("/assignments", protect, authorizePermission(PERMISSIONS.SERVICES_ASSIGN), createAssignment);
router.get("/assignments/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.SERVICES_VIEW), getAssignment);
router.put("/assignments/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.SERVICES_ASSIGN), updateAssignment);
router.patch("/assignments/:id/close", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.SERVICES_ASSIGN), closeAssignment);
router.delete("/assignments/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.SERVICES_ASSIGN), deleteAssignment);

// ── Katalog ──────────────────────────────────
router.get("/", protect, authorizePermission(PERMISSIONS.SERVICES_VIEW), getServices);
router.post("/", protect, authorizePermission(PERMISSIONS.SERVICES_CREATE), createService);
router.put("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.SERVICES_UPDATE), updateService);
router.patch("/:id/archive", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.SERVICES_UPDATE), archiveService);
router.delete("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.SERVICES_DELETE), deleteService);

module.exports = router;
