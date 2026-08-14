// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getStatuses,
  getStudentStatuses,
  getStatus,
  createStatus,
  bulkCreateStatus,
  updateStatus,
  closeStatus,
  changeStatus,
  deleteStatus,
} = require("../controllers/studentFinanceStatus.controller");

// Aniq yo'llar `/:id` dan OLDIN
router.post("/bulk", protect, authorizePermission(PERMISSIONS.FINANCE_STATUS), bulkCreateStatus);
router.get("/student/:studentId", protect, validateObjectId("studentId"), authorizePermission(PERMISSIONS.FINANCE_VIEW), getStudentStatuses);

router.get("/", protect, authorizePermission(PERMISSIONS.FINANCE_VIEW), getStatuses);
router.post("/", protect, authorizePermission(PERMISSIONS.FINANCE_STATUS), createStatus);

router.post("/:id/close", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_STATUS), closeStatus);
router.post("/:id/change-status", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_STATUS), changeStatus);

router.get("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_VIEW), getStatus);
router.put("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_STATUS), updateStatus);
router.delete("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_STATUS), deleteStatus);

module.exports = router;
