// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getLeaders,
  getStaffClasses,
  getClassOptions,
  getMyClasses,
  assignClasses,
  updateClass,
  removeClass,
} = require("../controllers/classLeader.controller");

router.use(protect);

// ⚠️ O'ZIMNIKI — RUXSAT KALITI YO'Q, id tokendan (`/tutor-groups/my` bilan
// AYNI qoida): huquq rol belgisi va biriktirishdan keladi. `/:id` dan OLDIN
// turadi, aks holda statik `my` bo'lagi id sifatida o'qilardi.
router.get("/my", getMyClasses);

// ── Admin ──────────────────────────────────────────────────────────────
// Tanlagich `assign` bilan: u faqat biriktirish oynasida kerak
router.get("/class-options", authorizePermission(PERMISSIONS.CLASSLEADERS_ASSIGN), getClassOptions);
router.get(
  "/staff/:staffId",
  validateObjectId("staffId"),
  authorizePermission(PERMISSIONS.CLASSLEADERS_VIEW),
  getStaffClasses,
);
router.get("/", authorizePermission(PERMISSIONS.CLASSLEADERS_VIEW), getLeaders);

router.post("/", authorizePermission(PERMISSIONS.CLASSLEADERS_ASSIGN), assignClasses);
router.patch(
  "/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.CLASSLEADERS_ASSIGN),
  updateClass,
);
router.delete(
  "/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.CLASSLEADERS_ASSIGN),
  removeClass,
);

module.exports = router;
