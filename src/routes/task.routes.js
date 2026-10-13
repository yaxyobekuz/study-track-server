const express = require("express");
const router = express.Router();
const {
  createTask,
  getTasks,
  getTaskStats,
  getTaskReport,
  getTaskDashboard,
  getTaskAssignees,
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
const asyncHandler = require("../middleware/async.middleware");
const { resolveTaskScope } = require("../services/taskScope.service");
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

// ⚠️ DOIRA HAR SO'ROVDA: `tasks.view` / owner uchun qo'shimcha so'rov
// bo'lmaydi (`resolveTaskScope` darhol "all" qaytaradi), `tasks.team` uchun
// esa bo'lim a'zolari bir marta o'qiladi va barcha amallar shuni ishlatadi.
// Route faqat "kalit bormi" deb tekshiradi, "bu topshiriq meniki emasligini"
// esa service hal qiladi (`taskScope.service.js`).
router.use(
  asyncHandler(async (req, _res, next) => {
    req.taskScope = await resolveTaskScope(req.user);
    next();
  }),
);

// Boshqaruv amali: butun filial (`tasks.*`) YOKI o'z bo'limi (`tasks.team`)
const MANAGE = (permission) => authorizeAnyPermission([permission, PERMISSIONS.TASKS_TEAM]);

// ─── Ro'yxat ──────────────────────────────────────────────────────
router.get("/my", getMyTasks);
router.get("/", MANAGE(PERMISSIONS.TASKS_VIEW), getTasks);
router.get("/stats", MANAGE(PERMISSIONS.TASKS_VIEW), getTaskStats);

// ─── Dashboard, hisobot va sozlamalar (`/:id` dan OLDIN) ──────────
// Dashboard — bo'limning o'z kesimi ham ochiq (`tasks.team`); hisobot esa
// butun jamoaning intizomi va avvalgidek `tasks.reports` ortida qoladi.
router.get("/dashboard", MANAGE(PERMISSIONS.TASKS_VIEW), getTaskDashboard);
// Ijrochi tanlash ro'yxati — doira bo'yicha. `users.view` talab QILINMAYDI:
// bo'lim rahbarida u bo'lmasligi mumkin, javobda esa faqat ism va rol bor.
router.get("/assignees", MANAGE(PERMISSIONS.TASKS_CREATE), getTaskAssignees);
router.get("/reports", authorizePermission(PERMISSIONS.TASKS_REPORTS), getTaskReport);
// O'qish: yaratish formasi ham qoidalarni biladi (minimal uzunlik, jarima chegarasi)
router.get(
  "/settings",
  authorizeAnyPermission([
    PERMISSIONS.TASKS_VIEW,
    PERMISSIONS.TASKS_CREATE,
    PERMISSIONS.TASKS_TEAM,
    PERMISSIONS.TASKS_SETTINGS,
  ]),
  getTaskSettings,
);
router.put("/settings", authorizePermission(PERMISSIONS.TASKS_SETTINGS), updateTaskSettings);

// ─── Yaratish (multipart) ─────────────────────────────────────────
router.post("/", MANAGE(PERMISSIONS.TASKS_CREATE), upload, handleFileUploadError, createTask);

// ─── Bitta topshiriq ──────────────────────────────────────────────
router.get("/:id", validateObjectId("id"), getTaskById);

// ─── Ijrochi amallari ─────────────────────────────────────────────
router.put("/:id/submit", validateObjectId("id"), upload, handleFileUploadError, submitCompletion);

// ─── Boshqaruv amallari ───────────────────────────────────────────
router.put("/:id", validateObjectId("id"), MANAGE(PERMISSIONS.TASKS_UPDATE), upload, handleFileUploadError, updateTask);
router.delete("/:id", validateObjectId("id"), MANAGE(PERMISSIONS.TASKS_DELETE), deleteTask);
router.put("/:id/approve", validateObjectId("id"), MANAGE(PERMISSIONS.TASKS_REVIEW), approveTask);
router.put("/:id/reject", validateObjectId("id"), MANAGE(PERMISSIONS.TASKS_REVIEW), rejectTask);
router.put("/:id/stop", validateObjectId("id"), MANAGE(PERMISSIONS.TASKS_STOP), stopTask);
router.put("/:id/extend", validateObjectId("id"), MANAGE(PERMISSIONS.TASKS_EXTEND), extendDeadline);
router.put("/:id/reopen", validateObjectId("id"), MANAGE(PERMISSIONS.TASKS_UPDATE), reopenTask);

module.exports = router;
