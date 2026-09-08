// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getAssignments,
  getStudentHistory,
  getAssignment,
  createAssignment,
  bulkAssign,
  applyDefaultTariff,
  updateAssignment,
  closeAssignment,
  changeTariff,
  deleteAssignment,
} = require("../controllers/studentTariff.controller");

// Aniq yo'llar `/:id` dan OLDIN
router.post("/bulk", protect, authorizePermission(PERMISSIONS.TARIFFS_ASSIGN), bulkAssign);
// Standart tarifni hammaga qo'llash — biriktirish amali, shuning uchun
// alohida ruxsat emas, o'sha `tariffs.assign`.
router.post("/apply-default", protect, authorizePermission(PERMISSIONS.TARIFFS_ASSIGN), applyDefaultTariff);
router.get("/student/:studentId", protect, validateObjectId("studentId"), authorizePermission(PERMISSIONS.TARIFFS_VIEW), getStudentHistory);

router.get("/", protect, authorizePermission(PERMISSIONS.TARIFFS_VIEW), getAssignments);
router.post("/", protect, authorizePermission(PERMISSIONS.TARIFFS_ASSIGN), createAssignment);

router.post("/:id/close", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.TARIFFS_ASSIGN), closeAssignment);
router.post("/:id/change-tariff", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.TARIFFS_ASSIGN), changeTariff);

router.get("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.TARIFFS_VIEW), getAssignment);
router.put("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.TARIFFS_ASSIGN), updateAssignment);
router.delete("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.TARIFFS_DELETE), deleteAssignment);

module.exports = router;
