const express = require("express");
const router = express.Router();
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const {
  getStudentReport,
  getStudentTrend,
  getClassReport,
  getStaffReport,
} = require("../controllers/attendanceReport.controller");
const {
  getStudentPulse,
  getTeacherPulse,
  getStudentAttendanceDoc,
  getTeacherAttendanceDoc,
  exportStudentAttendanceDoc,
  exportTeacherAttendanceDoc,
} = require("../controllers/attendanceStats.controller");

router.use(protect, authorizePermission(PERMISSIONS.ATTENDANCE_REPORTS));

router.get("/students", getStudentReport);
// So'nggi N kundagi davomat trendi (bosh sahifadagi grafik)
router.get("/students/trend", getStudentTrend);

/**
 * DAVR KESIMIDAGI STATISTIKA — bosh sahifadagi kartalar va hujjat
 * ko'rinishidagi hisobot ("Kunlik / Haftalik / Oylik / Yillik").
 *
 * ⚠️ `:classId` dan OLDIN turadi: `"/students/classes/:classId"` shabloni
 * emas, lekin yangi yo'l qo'shilganda tartib osongina buzilardi — aniq
 * yo'llar har doim parametrli yo'ldan yuqorida.
 *
 * Ruxsat bo'lim darajasida qo'yilgan (`attendance.reports`): hisobot
 * ro'yxatlari — o'quvchilar va o'qituvchilar kesimi — "Hisobotlar"
 * huquqining o'zi bilan ochiladi.
 */
router.get("/students/pulse", getStudentPulse);
router.get("/students/report/export", exportStudentAttendanceDoc);
router.get("/students/report", getStudentAttendanceDoc);

router.get("/teachers/pulse", getTeacherPulse);
router.get("/teachers/report/export", exportTeacherAttendanceDoc);
router.get("/teachers/report", getTeacherAttendanceDoc);

router.get("/students/classes/:classId", getClassReport);
router.get("/staff", getStaffReport);

module.exports = router;
