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
  getStudentEnrollments,
  getEnrollment,
  createEnrollment,
  updateEnrollment,
  closeEnrollment,
  deleteEnrollment,
} = require("../controllers/studentEnrollment.controller");

// `/student/:studentId` `/:id` dan OLDIN — aks holda "student" id sifatida
// o'qiladi va validateObjectId yiqiladi (tariff.routes.js dagi tuzoq).
router.get("/student/:studentId", protect, validateObjectId("studentId"), authorizePermission(PERMISSIONS.ENROLLMENT_VIEW), getStudentEnrollments);

router.get("/", protect, authorizePermission(PERMISSIONS.ENROLLMENT_VIEW), getEnrollments);
router.post("/", protect, authorizePermission(PERMISSIONS.ENROLLMENT_CREATE), createEnrollment);

// Yopish — "o'quvchi maktabdan ketdi". Tahrirlashdan alohida emas, chunki
// ikkalasi ham bir xil ruxsat talab qiladi, lekin UI da alohida amal.
router.patch("/:id/close", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.ENROLLMENT_UPDATE), closeEnrollment);

router.get("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.ENROLLMENT_VIEW), getEnrollment);
router.put("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.ENROLLMENT_UPDATE), updateEnrollment);
router.delete("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.ENROLLMENT_DELETE), deleteEnrollment);

module.exports = router;
