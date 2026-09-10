/**
 * DIAGNOSTIKA — TESTLAR (`/diagnostic-tests`).
 *
 * ⚠️ `/me` YO'LI RUXSAT TALAB QILMAYDI va bu ATAYLAB: o'quvchi o'ziga
 * ochiq testlar ro'yxatini ko'rishi kerak, lekin unga `diagnostics.view`
 * berilmaydi (bu ruxsat butun boshqaruv bo'limini ochib yuborardi). Yo'l
 * faqat `protect` bilan himoyalangan va HAR DOIM `req.user.id` bo'yicha
 * ishlaydi — boshqa odamning ro'yxatini so'rash imkoni yo'q.
 */

const express = require("express");
const router = express.Router();

const {
  getTests,
  getTest,
  getAvailability,
  createTest,
  updateTest,
  updateTestStatus,
  deleteTest,
  getMyTests,
} = require("../controllers/diagnosticTest.controller");

const {
  protect,
  authorizePermission,
  authorizeSection,
} = require("../middleware/auth.middleware");
const { PERMISSIONS, SECTIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");

router.use(protect);

// O'QUVCHI YO'LI — bo'lim darvozasidan OLDIN turishi shart.
router.get("/me", getMyTests);

// Boshqarish yo'llari — bo'lim darvozasi ortida.
router.use(authorizeSection(SECTIONS.DIAGNOSTICS));

router.get("/", authorizePermission(PERMISSIONS.DIAGNOSTICS_VIEW), getTests);
router.get(
  "/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_VIEW),
  getTest,
);
router.get(
  "/:id/availability",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_VIEW),
  getAvailability,
);

router.post("/", authorizePermission(PERMISSIONS.DIAGNOSTICS_CREATE), createTest);
router.put(
  "/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_UPDATE),
  updateTest,
);
router.patch(
  "/:id/status",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_UPDATE),
  updateTestStatus,
);
router.delete(
  "/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_DELETE),
  deleteTest,
);

module.exports = router;
