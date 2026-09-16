// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  submitRequest,
  getMyRequests,
  getAllRequests,
  reviewRequest,
} = require("../controllers/expenseLimitRequest.controller");

router.use(protect);

// ── XODIM TOMONI (xarajat kirita oladigan xodim so'rov yuboradi) ──
// `/:id` dan OLDIN
router.get("/mine", authorizePermission(PERMISSIONS.EXPENSES_CREATE), getMyRequests);
router.post("/", authorizePermission(PERMISSIONS.EXPENSES_CREATE), submitRequest);

// ── ADMIN TOMONI ──
router.get("/", authorizePermission(PERMISSIONS.EXPENSES_LIMITREVIEW), getAllRequests);
router.post("/:id/review", validateObjectId("id"), authorizePermission(PERMISSIONS.EXPENSES_LIMITREVIEW), reviewRequest);

module.exports = router;
