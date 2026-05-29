// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorize } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// Controller
const {
  startSession,
  getMySessions,
  getSession,
  saveAnswer,
  submitSession,
  getSessionsByTest,
} = require("../controllers/testSession.controller");

router.use(protect);

// O'qituvchi - test bo'yicha sessiyalar
router.get(
  "/by-test/:testId",
  authorize(ROLES.TEACHER),
  validateObjectId("testId"),
  getSessionsByTest,
);

// O'quvchi - sessiya boshlash (binding ID), ko'rish, javob saqlash, topshirish
router.post("/", authorize(ROLES.STUDENT), startSession);
router.get("/my", authorize(ROLES.STUDENT), getMySessions);
router.get(
  "/:id",
  authorize(ROLES.STUDENT),
  validateObjectId("id"),
  getSession,
);
router.put(
  "/:id/answers",
  authorize(ROLES.STUDENT),
  validateObjectId("id"),
  saveAnswer,
);
router.post(
  "/:id/submit",
  authorize(ROLES.STUDENT),
  validateObjectId("id"),
  submitSession,
);

module.exports = router;
