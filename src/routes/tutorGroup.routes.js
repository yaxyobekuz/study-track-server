// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { createSingleFileUpload, handleFileUploadError } = require("../middleware/fileUpload.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getStaffGroups,
  getClassOptions,
  getGroupOverview,
  getMyGroups,
  getMyGroupOverview,
  sendMyStudentsMessage,
  previewAmount,
  createGroup,
  updateGroup,
  removeGroup,
} = require("../controllers/tutorGroup.controller");

router.use(protect);

// O'zimniki — ruxsatsiz, faqat o'zi. `/:id` dan OLDIN turadi.
router.get("/my", getMyGroups);
router.get("/my/:id/overview", validateObjectId("id"), getMyGroupOverview);

// O'z guruhimdagi o'quvchilarga xabar: barchaga, `classId` bo'lsa bitta sinfga,
// `studentId` bo'lsa bitta o'quvchiga.
// Ixtiyoriy rasm/hujjat ilova qilinadi (mavjud xabar oqimi bilan bir xil).
router.post(
  "/my/message",
  createSingleFileUpload({ categories: ["image", "document"] }),
  handleFileUploadError,
  sendMyStudentsMessage,
);

// Admin
// Tanlagich `assign` bilan: u faqat biriktirish oynasida kerak
router.get("/class-options", authorizePermission(PERMISSIONS.TUTORS_ASSIGN), getClassOptions);
router.get("/staff/:staffId", validateObjectId("staffId"), authorizePermission(PERMISSIONS.TUTORS_VIEW), getStaffGroups);
router.get("/:id/overview", validateObjectId("id"), authorizePermission(PERMISSIONS.TUTORS_VIEW), getGroupOverview);

// ⚠️ `assign` — qo'shimcha oylikni belgilaydi (pul)
router.post("/preview", authorizePermission(PERMISSIONS.TUTORS_ASSIGN), previewAmount);
router.post("/", authorizePermission(PERMISSIONS.TUTORS_ASSIGN), createGroup);
router.patch("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.TUTORS_ASSIGN), updateGroup);
// Olib tashlash `effective` ni body'da oladi — DELETE body'si proksilarda
// yo'qolishi mumkin, shuning uchun POST
router.post("/:id/remove", validateObjectId("id"), authorizePermission(PERMISSIONS.TUTORS_ASSIGN), removeGroup);

module.exports = router;
