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

// Yaratish va boshqarish — topshiriq berish huquqi bilan bir xil:
// doimiy qoida ham, oxir-oqibat, topshiriq berishdir.
const MANAGE = authorizeAnyPermission([PERMISSIONS.TASKS_CREATE, PERMISSIONS.TASKS_TEAM]);

router.post("/", MANAGE, upload, handleFileUploadError, createSchedule);
router.put("/:id", validateObjectId("id"), MANAGE, upload, handleFileUploadError, updateSchedule);
router.put("/:id/stop", validateObjectId("id"), MANAGE, stopSchedule);
router.put("/:id/resume", validateObjectId("id"), MANAGE, resumeSchedule);
router.delete("/:id", validateObjectId("id"), MANAGE, deleteSchedule);

module.exports = router;
