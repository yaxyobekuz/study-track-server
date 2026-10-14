const express = require("express");
const router = express.Router();

const {
  createSchedule,
  getSchedules,
  updateSchedule,
  stopSchedule,
  resumeSchedule,
  deleteSchedule,
} = require("../controllers/taskSchedule.controller");
const {
  protect,
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

// Qoidaning namuna fayllari — topshiriq fayllari bilan AYNI chegara
const upload = createMultiFileUpload({
  fieldName: "files",
  categories: ["image", "video", "document"],
  maxFiles: 10,
});

router.use(protect);

// Doira — topshiriqlar bo'limi bilan AYNI (`taskScope.service.js`):
// `tasks.view` butun filial, `tasks.team` faqat o'z bo'limi.
router.use(
  asyncHandler(async (req, _res, next) => {
    req.taskScope = await resolveTaskScope(req.user);
    next();
  }),
);

// Ko'rish — topshiriqlar ro'yxatini ko'rish huquqi bilan bir xil
router.get(
  "/",
  authorizeAnyPermission([PERMISSIONS.TASKS_VIEW, PERMISSIONS.TASKS_TEAM]),
  getSchedules,
);

// Amallar topshiriqlar bo'limidagi AYNI kalitlar ortida: qoida yaratish —
// topshiriq berish, tahrirlash/to'xtatish — tahrirlash, o'chirish —
// o'chirish. ⚠️ Hammasi bitta `tasks.create` ga tayangan edi: topshiriq
// bera oladigan odam birovning doimiy qoidasini o'chira ham olardi.
// `tasks.team` — bo'lim rahbari uchun (doira service'da tekshiriladi).
const CAN = (permission) => authorizeAnyPermission([permission, PERMISSIONS.TASKS_TEAM]);

router.post("/", CAN(PERMISSIONS.TASKS_CREATE), upload, handleFileUploadError, createSchedule);
router.put(
  "/:id",
  validateObjectId("id"),
  CAN(PERMISSIONS.TASKS_UPDATE),
  upload,
  handleFileUploadError,
  updateSchedule,
);
router.put("/:id/stop", validateObjectId("id"), CAN(PERMISSIONS.TASKS_UPDATE), stopSchedule);
router.put("/:id/resume", validateObjectId("id"), CAN(PERMISSIONS.TASKS_UPDATE), resumeSchedule);
router.delete("/:id", validateObjectId("id"), CAN(PERMISSIONS.TASKS_DELETE), deleteSchedule);

module.exports = router;
