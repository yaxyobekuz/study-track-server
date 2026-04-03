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
const { protect, authorize } = require("../middleware/auth.middleware");
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
router.get("/", authorize(ROLES.OWNER), getTasks);

// ─── Yaratish (owner, multipart) ──────────────────────────────────
router.post("/", authorize(ROLES.OWNER), upload, handleFileUploadError, createTask);

// ─── Bitta topshiriq ──────────────────────────────────────────────
router.get("/:id", validateObjectId("id"), getTaskById);

// ─── Ijrochi amallari ─────────────────────────────────────────────
router.put("/:id/submit", validateObjectId("id"), upload, handleFileUploadError, submitCompletion);

// ─── Owner amallari ───────────────────────────────────────────────
router.put("/:id/approve", validateObjectId("id"), authorize(ROLES.OWNER), approveTask);
router.put("/:id/reject", validateObjectId("id"), authorize(ROLES.OWNER), rejectTask);
router.put("/:id/stop", validateObjectId("id"), authorize(ROLES.OWNER), stopTask);
router.put("/:id/extend", validateObjectId("id"), authorize(ROLES.OWNER), extendDeadline);

module.exports = router;
