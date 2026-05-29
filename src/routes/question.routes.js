// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorize } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const {
  createMultiFileUpload,
  handleFileUploadError,
} = require("../middleware/fileUpload.middleware");
const { ROLES } = require("../utils/constants");

// Controller
const {
  updateQuestion,
  deleteQuestion,
} = require("../controllers/question.controller");

// Savol va variant rasmlari uchun multipart upload (savol + 99 variant)
const upload = createMultiFileUpload({
  fieldName: "images",
  categories: ["image"],
  maxFiles: 100,
});

router.use(protect);

// Individual savol amallari (testdan tashqari)
router.put(
  "/:id",
  authorize(ROLES.TEACHER),
  validateObjectId("id"),
  upload,
  handleFileUploadError,
  updateQuestion,
);
router.delete(
  "/:id",
  authorize(ROLES.TEACHER),
  validateObjectId("id"),
  deleteQuestion,
);

module.exports = router;
