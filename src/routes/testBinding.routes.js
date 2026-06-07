// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorize } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// Controller
const {
  updateBinding,
  deleteBinding,
  reopenSession,
  getAvailableBindings,
} = require("../controllers/testBinding.controller");

router.use(protect);

// O'quvchi - mavjud biriktiruvlar
router.get("/available", authorize(ROLES.STUDENT), getAvailableBindings);

// O'qituvchi - biriktiruv amallari
router.put(
  "/:id",
  authorize(ROLES.TEACHER),
  validateObjectId("id"),
  updateBinding,
);
router.delete(
  "/:id",
  authorize(ROLES.TEACHER),
  validateObjectId("id"),
  deleteBinding,
);
router.post(
  "/:id/reopen",
  authorize(ROLES.TEACHER),
  validateObjectId("id"),
  reopenSession,
);

module.exports = router;
