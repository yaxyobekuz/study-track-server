// Express
const express = require("express");
const router = express.Router();

// Controllers
const {
  uploadTopics,
  getTopicsBySubject,
  getSubjectTopicStatus,
  exportTopics,
  deleteTopicsBySubject,
} = require("../controllers/topic.controller");

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { createSingleFileUpload, handleFileUploadError } = require("../middleware/fileUpload.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");

// Routes
router.post(
  "/upload",
  protect,
  authorizePermission(PERMISSIONS.TOPICS_IMPORT),
  createSingleFileUpload({ categories: ["document"] }),
  handleFileUploadError,
  uploadTopics
);

// ⚠️ EKSPORT — `/subject/:id` dan OLDIN: `subjectId` yo'lda emas,
// so'rov parametrida keladi (import bilan AYNI shakl) va ikki rejimni
// bitta yo'lda beradi — bitta fan yoki mavzusi bor hamma fan.
//
// ⚠️ Ruxsat — `topics.view`, alohida "export" kaliti EMAS: fayl ekranda
// ko'rinib turgan AYNI ma'lumot va u hech narsa yozmaydi. Alohida kalit
// bu yerda faqat yolg'on himoya bo'lardi (`studentSystems.export` dan
// farqi: u shaxsiy ma'lumot).
router.get("/export", protect, authorizePermission(PERMISSIONS.TOPICS_VIEW), exportTopics);

// FANLAR BO'YICHA HOLAT — "qaysi fanga mavzu yuklangan, qaysiga yo'q".
//
// ⚠️ Ro'yxat FANLAR katalogidan quriladi, mavzulardan EMAS — aks holda
// aynan javob kerak bo'lgan fan (mavzusi yo'q) ro'yxatda ko'rinmasdi.
//
// ⚠️ Ruxsat — `topics.view` (eksport bilan AYNI mulohaza): javob hech
// narsa yozmaydi va ekranda ko'rinib turgan ma'lumotning o'zi.
router.get("/subjects", protect, authorizePermission(PERMISSIONS.TOPICS_VIEW), getSubjectTopicStatus);

router.get("/subject/:id", protect, validateObjectId("id"), getTopicsBySubject);

router.delete("/subject/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.TOPICS_DELETE), deleteTopicsBySubject);

module.exports = router;
