const express = require("express");
const router = express.Router();
const {
  createTask,
  getTasks,
  getTaskStats,
  getTaskReport,
  getTaskSettings,
  updateTaskSettings,
  getMyTasks,
  getTaskById,
  submitCompletion,
  approveTask,
  rejectTask,
  stopTask,
  extendDeadline,
  updateTask,
  reopenTask,
  deleteTask,
} = require("../controllers/task.controller");
const {
  protect,
  authorizePermission,
  authorizeAnyPermission,
} = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const {
  createMultiFileUpload,
  handleFileUploadError,
} = require("../middleware/fileUpload.middleware");

// ⚠️ 10 — `task.service.js` dagi `COMPLETION_FILES_HARD_MAX` /
// `TASK_ATTACHMENTS_MAX` bilan bir xil. Aniq chegara (sozlamadagi min/max)
// service'da tekshiriladi: multer faqat qat'iy yuqori to'siq.
const upload = createMultiFileUpload({
  fieldName: "files",
  categories: ["image", "video", "document"],
  maxFiles: 10,
});

router.use(protect);

// ─── Ro'yxat ──────────────────────────────────────────────────────
router.get("/my", getMyTasks);
router.get("/", authorizePermission(PERMISSIONS.TASKS_VIEW), getTasks);
router.get("/stats", authorizePermission(PERMISSIONS.TASKS_VIEW), getTaskStats);

// ─── Hisobot va sozlamalar (`/:id` dan OLDIN) ─────────────────────
router.get("/reports", authorizePermission(PERMISSIONS.TASKS_REPORTS), getTaskReport);
// O'qish: yaratish formasi ham qoidalarni biladi (minimal uzunlik, jarima chegarasi)
router.get(
  "/settings",
  authorizeAnyPermission([PERMISSIONS.TASKS_VIEW, PERMISSIONS.TASKS_CREATE, PERMISSIONS.TASKS_SETTINGS]),
  getTaskSettings,
);
router.put("/settings", authorizePermission(PERMISSIONS.TASKS_SETTINGS), updateTaskSettings);

// ─── Yaratish (multipart) ─────────────────────────────────────────
router.post("/", authorizePermission(PERMISSIONS.TASKS_CREATE), upload, handleFileUploadError, createTask);

// ─── Bitta topshiriq ──────────────────────────────────────────────
router.get("/:id", validateObjectId("id"), getTaskById);

// ─── Ijrochi amallari ─────────────────────────────────────────────
router.put("/:id/submit", validateObjectId("id"), upload, handleFileUploadError, submitCompletion);

// ─── Boshqaruv amallari ───────────────────────────────────────────
router.put("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.TASKS_UPDATE), upload, handleFileUploadError, updateTask);
router.delete("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.TASKS_DELETE), deleteTask);
router.put("/:id/approve", validateObjectId("id"), authorizePermission(PERMISSIONS.TASKS_REVIEW), approveTask);
router.put("/:id/reject", validateObjectId("id"), authorizePermission(PERMISSIONS.TASKS_REVIEW), rejectTask);
router.put("/:id/stop", validateObjectId("id"), authorizePermission(PERMISSIONS.TASKS_STOP), stopTask);
router.put("/:id/extend", validateObjectId("id"), authorizePermission(PERMISSIONS.TASKS_EXTEND), extendDeadline);
router.put("/:id/reopen", validateObjectId("id"), authorizePermission(PERMISSIONS.TASKS_UPDATE), reopenTask);

module.exports = router;
