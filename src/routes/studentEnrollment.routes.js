// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getEnrollments,
  getDepartures,
  getDepartureSummary,
  getMovement,
  getMovementSummary,
  exportMovement,
  getStudentEnrollments,
  getEnrollment,
  createEnrollment,
  updateEnrollment,
  closeEnrollment,
  previewEnrollment,
  deleteEnrollment,
} = require("../controllers/studentEnrollment.controller");

// CHIQIB KETGANLAR — yopilgan davrlar registri ("nega, qachon ketdi").
// ⚠️ `/:id` dan OLDIN: `validateObjectId` "departures" ni id deb o'qib
// yiqilardi (pastdagi `/student/:studentId` bilan AYNI tuzoq).
// Ruxsat — `enrollment.view`: ketish sababi davr sahifasida allaqachon
// ko'rinadi, registr faqat uni bitta ekranga yig'adi (alohida kalit
// kiritilsa, o'sha bitta fakt ikki xil huquq ortida qolardi).
router.get("/departures/summary", protect, authorizePermission(PERMISSIONS.ENROLLMENT_VIEW), getDepartureSummary);
router.get("/departures", protect, authorizePermission(PERMISSIONS.ENROLLMENT_VIEW), getDepartures);

// O'QUVCHILAR HARAKATI — "nechtasi keldi, nechtasi ketdi va qancha foizga
// o'zgardi" + o'sha hisobotning Word fayli.
// ⚠️ `/:id` dan OLDIN (yuqoridagi AYNI tuzoq) va `/movement` dan OLDIN
// `/movement/summary` + `/movement/export`: Express birinchi mos kelgan
// yo'lni oladi, shuning uchun aniqroq yo'l yuqorida turadi.
router.get("/movement/summary", protect, authorizePermission(PERMISSIONS.ENROLLMENT_VIEW), getMovementSummary);
router.get("/movement/export", protect, authorizePermission(PERMISSIONS.ENROLLMENT_VIEW), exportMovement);
router.get("/movement", protect, authorizePermission(PERMISSIONS.ENROLLMENT_VIEW), getMovement);

// `/student/:studentId` `/:id` dan OLDIN — aks holda "student" id sifatida
// o'qiladi va validateObjectId yiqiladi (tariff.routes.js dagi tuzoq).
router.get("/student/:studentId", protect, validateObjectId("studentId"), authorizePermission(PERMISSIONS.ENROLLMENT_VIEW), getStudentEnrollments);

router.get("/", protect, authorizePermission(PERMISSIONS.ENROLLMENT_VIEW), getEnrollments);
router.post("/", protect, authorizePermission(PERMISSIONS.ENROLLMENT_CREATE), createEnrollment);

// Yopish — "o'quvchi maktabdan ketdi". Tahrirlashdan alohida emas, chunki
// ikkalasi ham bir xil ruxsat talab qiladi, lekin UI da alohida amal.
router.patch("/:id/close", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.ENROLLMENT_UPDATE), closeEnrollment);
// Oldindan ko'rish — hech narsa yozmaydi; yopish/tahrirlash bilan AYNI ruxsat
router.post("/:id/preview", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.ENROLLMENT_UPDATE), previewEnrollment);

router.get("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.ENROLLMENT_VIEW), getEnrollment);
router.put("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.ENROLLMENT_UPDATE), updateEnrollment);
router.delete("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.ENROLLMENT_DELETE), deleteEnrollment);

module.exports = router;
