const express = require("express");
const router = express.Router();
const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");
const teacherController = require("../controllers/studentAttendanceTeacher.controller");
const {
  mark,
  updateRecord,
  getTodayClass,
  getTodayAllStudents,
  getMarkList,
  getClasses,
  getClassMonthRecords,
  getStudentMonthRecords,
  getMyMonthRecords,
  getAllRecords,
} = require("../controllers/studentAttendance.controller");

// O'quvchining o'z davomati — ruxsatsiz, faqat rol bo'yicha (id tokendan).
// `?month=1..12&year=YYYY`, berilmasa Toshkent bo'yicha joriy oy.
router.get("/my", protect, authorize(ROLES.STUDENT), getMyMonthRecords);

// ── XODIM O'Z SINFIGA DAVOMAT (dars + SINF RAHBARLIGI) ─────────────────
// ⚠️ RUXSAT KALITI YO'Q: huquq DARS JADVALIDAN va SINF RAHBARLIGI
// biriktirishidan keladi, xodim id si esa tokendan olinadi
// (`/grades/teacher/classes` va `/tutor-groups/my` bilan AYNI qoida). Har
// so'rovda qayta tekshiriladi — darvozalar `studentAttendanceTeacher.service.js` da.
//
// ⚠️ `authorize(ROLES.TEACHER)` ATAYLAB YO'Q. Sinf rahbari roli DINAMIK
// (platforma belgisi `Role.isClassLeader`) va `teacher` bo'lishi shart emas —
// tarbiyachi ham sinf rahbari bo'ladi, ya'ni rollar ro'yxatini route'ga
// qotirib bo'lmaydi. O'quvchi servisda to'siladi (`assertStaff`), huquqning
// o'zi esa `resolveMarkableClasses` da: sinfi yo'q xodim BO'SH ro'yxat oladi.
//
// ⚠️ YO'L NOMI `/teacher/*` BO'LIB QOLDI (panel va mobil mijozlar shu nomga
// bog'langan), ma'nosi esa kengaydi — kodda `resolveMarkableClasses`.
// `/today/:classId` va `/class/:classId` dan FARQLI: statik `teacher`
// bo'lagi id sifatida o'qilmasligi uchun yuqorida turadi.
router.get("/teacher/day", protect, teacherController.getDay);
router.get(
  "/teacher/class/:classId",
  protect,
  validateObjectId("classId"),
  teacherController.getClassRoster,
);
router.post("/teacher/mark", protect, teacherController.mark);

// Reception va owner: belgilash va ko'rish
router.get("/classes", protect, authorizePermission(PERMISSIONS.ATTENDANCE_VIEW, ROLES.RECEPTION), getClasses);
router.get("/today", protect, authorizePermission(PERMISSIONS.ATTENDANCE_VIEW, ROLES.RECEPTION), getTodayAllStudents);
router.get("/today/:classId", protect, authorizePermission(PERMISSIONS.ATTENDANCE_VIEW, ROLES.RECEPTION), getTodayClass);
// Belgilash ro'yxati (sahifalanmaydi) — belgilash ruxsati bilan
router.get("/mark-list", protect, authorizePermission(PERMISSIONS.ATTENDANCE_MARK, ROLES.RECEPTION), getMarkList);
router.post("/mark", protect, authorizePermission(PERMISSIONS.ATTENDANCE_MARK, ROLES.RECEPTION), mark);
router.put("/:id", protect, authorizePermission(PERMISSIONS.ATTENDANCE_UPDATE, ROLES.RECEPTION), updateRecord);

// Faqat owner: hisobotlar
router.get("/class/:classId", protect, authorizePermission(PERMISSIONS.ATTENDANCE_VIEW), getClassMonthRecords);
router.get("/student/:studentId", protect, authorizePermission(PERMISSIONS.ATTENDANCE_VIEW), getStudentMonthRecords);
router.get("/", protect, authorizePermission(PERMISSIONS.ATTENDANCE_VIEW), getAllRecords);

module.exports = router;
