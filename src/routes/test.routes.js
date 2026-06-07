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

// Controllerlar
const {
  getTests,
  getTestById,
  createTest,
  updateTest,
  deleteTest,
} = require("../controllers/test.controller");

const {
  getQuestionsForTest,
  createQuestion,
  reorderQuestions,
  deleteAllQuestionsForTest,
} = require("../controllers/question.controller");

const { generateQuestions } = require("../controllers/ai.controller");

const {
  getBindingsForTest,
  createBinding,
} = require("../controllers/testBinding.controller");

const questionUpload = createMultiFileUpload({
  fieldName: "images",
  categories: ["image"],
  maxFiles: 100,
});

// AI generatsiyasi: faqat rasm (Vision) qabul qiladi
const aiUpload = createMultiFileUpload({
  fieldName: "files",
  categories: ["image"],
  maxFiles: 10,
});

router.use(protect);

// O'qituvchi - o'z testlari ro'yxati
router.get("/", authorize(ROLES.TEACHER), getTests);
router.post("/", authorize(ROLES.TEACHER), createTest);

// Bitta test
router.get(
  "/:id",
  authorize(ROLES.OWNER, ROLES.TEACHER),
  validateObjectId("id"),
  getTestById,
);

// Test sozlamalarini tahrirlash
router.put(
  "/:id",
  authorize(ROLES.TEACHER),
  validateObjectId("id"),
  updateTest,
);

router.delete(
  "/:id",
  authorize(ROLES.TEACHER),
  validateObjectId("id"),
  deleteTest,
);

// ───── Test ichidagi savollar (nested) ─────
router.get(
  "/:testId/questions",
  authorize(ROLES.TEACHER),
  validateObjectId("testId"),
  getQuestionsForTest,
);
router.post(
  "/:testId/questions",
  authorize(ROLES.TEACHER),
  validateObjectId("testId"),
  questionUpload,
  handleFileUploadError,
  createQuestion,
);
router.patch(
  "/:testId/questions/reorder",
  authorize(ROLES.TEACHER),
  validateObjectId("testId"),
  reorderQuestions,
);
router.delete(
  "/:testId/questions",
  authorize(ROLES.TEACHER),
  validateObjectId("testId"),
  deleteAllQuestionsForTest,
);

// AI yordamida savol generatsiyasi (prompt yoki rasm orqali)
router.post(
  "/:testId/questions/ai-generate",
  authorize(ROLES.TEACHER),
  validateObjectId("testId"),
  aiUpload,
  handleFileUploadError,
  generateQuestions,
);

// ───── Test biriktiruvlari (nested) ─────
router.get(
  "/:testId/bindings",
  authorize(ROLES.TEACHER),
  validateObjectId("testId"),
  getBindingsForTest,
);
router.post(
  "/:testId/bindings",
  authorize(ROLES.TEACHER),
  validateObjectId("testId"),
  createBinding,
);

module.exports = router;
