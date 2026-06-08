// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorize } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// Controller
const {
  getMyResults,
  getStudentSeasonResults,
  getResultForAdmin,
  getResultById,
  getResultsByTest,
  gradeOpenAnswer,
  addExtraPoints,
  editExtraPoints,
  deleteExtraPoints,
} = require("../controllers/testResult.controller");

router.use(protect);

// O'quvchi - o'z natijalari
router.get("/my", authorize(ROLES.STUDENT), getMyResults);

// Admin (owner) - mavsumdagi o'quvchining natijalari va bitta natija (javoblar bilan)
router.get(
  "/season/:seasonId/student/:studentId",
  authorize(ROLES.OWNER),
  validateObjectId("seasonId"),
  validateObjectId("studentId"),
  getStudentSeasonResults,
);
router.get(
  "/admin/:id",
  authorize(ROLES.OWNER),
  validateObjectId("id"),
  getResultForAdmin,
);

// O'qituvchi - test bo'yicha natijalar
router.get(
  "/by-test/:testId",
  authorize(ROLES.TEACHER),
  validateObjectId("testId"),
  getResultsByTest,
);

// O'qituvchi - baholash va qo'shimcha ball
router.patch(
  "/:id/grade",
  authorize(ROLES.TEACHER),
  validateObjectId("id"),
  gradeOpenAnswer,
);
router.patch(
  "/:id/extra-points",
  authorize(ROLES.TEACHER),
  validateObjectId("id"),
  addExtraPoints,
);
router.patch(
  "/:id/extra-points/:entryId",
  authorize(ROLES.TEACHER),
  validateObjectId("id"),
  validateObjectId("entryId"),
  editExtraPoints,
);
router.delete(
  "/:id/extra-points/:entryId",
  authorize(ROLES.TEACHER),
  validateObjectId("id"),
  validateObjectId("entryId"),
  deleteExtraPoints,
);

// Bitta natija - o'quvchi (o'ziniki) yoki o'qituvchi (o'z testiniki)
router.get(
  "/:id",
  authorize(ROLES.STUDENT, ROLES.TEACHER),
  validateObjectId("id"),
  getResultById,
);

module.exports = router;
