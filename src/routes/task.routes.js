const express = require("express");
const router = express.Router();
const {
  createTask,
  getTasks,
  getMyTasks,
  getTaskById,
  submitCompletion,
  approveTask,
  rejectTask,
  stopTask,
  extendDeadline,
} = require("../controllers/task.controller");
const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const {
  createMultiFileUpload,
  handleFileUploadError,
} = require("../middleware/fileUpload.middleware");
const { ROLES } = require("../utils/constants");

const upload = createMultiFileUpload({
  fieldName: "files",
  categories: ["image", "video", "document"],
  maxFiles: 5,
});

router.use(protect);

// ─── Ro'yxat ──────────────────────────────────────────────────────
router.get("/my", getMyTasks);
router.get("/", authorizePermission(PERMISSIONS.TASKS_VIEW), getTasks);

// ─── Yaratish (multipart) ─────────────────────────────────────────
router.post("/", authorizePermission(PERMISSIONS.TASKS_CREATE), upload, handleFileUploadError, createTask);

// ─── Bitta topshiriq ──────────────────────────────────────────────
router.get("/:id", validateObjectId("id"), getTaskById);

// ─── Ijrochi amallari ─────────────────────────────────────────────
router.put("/:id/submit", validateObjectId("id"), upload, handleFileUploadError, submitCompletion);

// ─── Boshqaruv amallari ───────────────────────────────────────────
router.put("/:id/approve", validateObjectId("id"), authorizePermission(PERMISSIONS.TASKS_REVIEW), approveTask);
router.put("/:id/reject", validateObjectId("id"), authorizePermission(PERMISSIONS.TASKS_REVIEW), rejectTask);
router.put("/:id/stop", validateObjectId("id"), authorizePermission(PERMISSIONS.TASKS_STOP), stopTask);
router.put("/:id/extend", validateObjectId("id"), authorizePermission(PERMISSIONS.TASKS_EXTEND), extendDeadline);

module.exports = router;
