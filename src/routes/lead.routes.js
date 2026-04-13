const express = require("express");
const router = express.Router();
const {
  getAllLeads,
  getLeadById,
  createLead,
  updateLead,
  updateLeadStatus,
  deleteLead,
  getLeadActivities,
  createLeadActivity,
  getAnalyticsOverview,
  getSourceAnalytics,
  getConversionFunnel,
  getTrendAnalytics,
} = require("../controllers/lead.controller");
const {
  getAllSources,
  createSource,
  updateSource,
  deleteSource,
} = require("../controllers/leadSource.controller");
const { protect, authorize } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// All routes require authentication
router.use(protect);

// --- Lead Sources (Owner + Reception) ---
router
  .route("/sources")
  .get(getAllSources)
  .post(createSource);

router
  .route("/sources/:id")
  .all(validateObjectId("id"))
  .put(updateSource)
  .delete(deleteSource);

// --- Analytics (Owner only) ---
router.get("/analytics/overview", authorize(ROLES.OWNER), getAnalyticsOverview);
router.get("/analytics/sources", authorize(ROLES.OWNER), getSourceAnalytics);
router.get("/analytics/conversion", authorize(ROLES.OWNER), getConversionFunnel);
router.get("/analytics/trends", authorize(ROLES.OWNER), getTrendAnalytics);

// --- Leads CRUD ---
router.route("/").get(getAllLeads).post(createLead);

router
  .route("/:id")
  .all(validateObjectId("id"))
  .get(getLeadById)
  .put(updateLead)
  .delete(deleteLead);

router.put("/:id/status", validateObjectId("id"), updateLeadStatus);

// --- Lead Activities ---
router
  .route("/:id/activities")
  .all(validateObjectId("id"))
  .get(getLeadActivities)
  .post(createLeadActivity);

module.exports = router;
