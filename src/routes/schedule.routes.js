const express = require("express");
const router = express.Router();
const {
  deleteSchedule,
  getScheduleByDay,
  getScheduleByClass,
  getMyTodaySchedule,
  getAllTodaySchedules,
  createOrUpdateSchedule,
  saveClassSchedule,
  updateCurrentTopic,
  exportScheduleByClass,
  getClassesBySubject,
  getTeacherWorkload,
  getMyWorkload,
  getTeacherOptions,
  getScheduleDraft,
  saveScheduleDraft,
  deleteScheduleDraft,
} = require("../controllers/schedule.controller");
const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// All routes are protected
router.use(protect);

// Teacher's today schedule
router.get("/my-today", authorize(ROLES.TEACHER), getMyTodaySchedule);

// O'zimning haftalik yuklamam (xodim panelidagi profil). Ruxsat kaliti yo'q —
// identifikator tokendan olinadi, o'quvchi controller'da rad etiladi.
router.get("/my-workload", getMyWorkload);

// All today schedules (Owner only)
router.get("/all-today", authorizePermission(PERMISSIONS.SCHEDULES_VIEW), getAllTodaySchedules);

// Schedule by class (Owner and Teacher can view)
router.get(
  "/class/:classId",
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.SCHEDULES_VIEW, ROLES.TEACHER),
  getScheduleByClass,
);
router.get(
  "/class/:classId/export",
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.SCHEDULES_EXPORT, ROLES.TEACHER),
  exportScheduleByClass,
);
router.get(
  "/class/:classId/day/:day",
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.SCHEDULES_VIEW, ROLES.TEACHER),
  getScheduleByDay,
);

// Dars biriktirish uchun o'qituvchilar ma'lumotnomasi: id, ism va
// BIRIKTIRILGAN FANLAR. Forma fan tanlangandan keyin ro'yxatni shu fandan
// dars beradiganlar bilan cheklaydi.
//
// `users.view` talab qilinmaydi — javobda faqat ism va fan id'lari bor,
// dars jadvalining o'zi esa allaqachon xodimlarning ismini ko'rsatadi.
router.get("/teachers", authorizePermission(PERMISSIONS.SCHEDULES_VIEW), getTeacherOptions);

// O'qituvchining haftalik yuklamasi (profil sahifasi):
// necha soat, qaysi sinflarda, qaysi kunlari.
router.get(
  "/teacher/:teacherId",
  validateObjectId("teacherId"),
  authorizePermission(PERMISSIONS.SCHEDULES_VIEW),
  getTeacherWorkload,
);

// Get all classes by subject (Owner only)
router.get("/subject/:subjectId", validateObjectId("subjectId"), authorizePermission(PERMISSIONS.SCHEDULES_VIEW), getClassesBySubject);

// ── QORALAMA (tugallanmagan tahrirning zaxirasi) ──
//
// Ruxsat — `schedules.update`: qoralama tahrirning bir qismi, alohida
// huquq emas. Yozuv FAQAT tokendagi foydalanuvchiniki, shuning uchun
// boshqa xodimning tugallanmagan ishiga bu yo'l bilan yetib bo'lmaydi.
router.get(
  "/class/:classId/draft",
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.SCHEDULES_UPDATE),
  getScheduleDraft,
);
router.put(
  "/class/:classId/draft",
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.SCHEDULES_UPDATE),
  saveScheduleDraft,
);
router.delete(
  "/class/:classId/draft",
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.SCHEDULES_UPDATE),
  deleteScheduleDraft,
);

// CRUD operations - amal darajasidagi ruxsat bilan
router.post("/", authorizePermission(PERMISSIONS.SCHEDULES_CREATE), createOrUpdateSchedule);
router.put(
  "/class/:classId",
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.SCHEDULES_UPDATE),
  saveClassSchedule,
);
router.patch(
  "/class/:classId/subject/:subjectId/topic",
  validateObjectId("classId"),
  validateObjectId("subjectId"),
  authorizePermission(PERMISSIONS.SCHEDULES_UPDATE),
  updateCurrentTopic,
);
router.delete("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.SCHEDULES_DELETE), deleteSchedule);

module.exports = router;
