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
  getDirectionAnalytics,
  getCategoryAnalytics,
} = require("../controllers/lead.controller");
const {
  getAllSources,
  createSource,
  updateSource,
  deleteSource,
} = require("../controllers/leadSource.controller");
const {
  getAllDirections,
  createDirection,
  updateDirection,
  deleteDirection,
} = require("../controllers/leadDirection.controller");
const {
  getAllCategories,
  createCategory,
  updateCategory,
  deleteCategory,
} = require("../controllers/leadCategory.controller");
const { protect, authorize } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// All routes require authentication
router.use(protect);

// --- Lead Sources (Owner + Reception) ---
router
  .route("/sources")
  .get(authorize(ROLES.OWNER, ROLES.RECEPTION), getAllSources)
  .post(authorize(ROLES.OWNER, ROLES.RECEPTION), createSource);

router
  .route("/sources/:id")
  .all(validateObjectId("id"))
  .put(authorize(ROLES.OWNER, ROLES.RECEPTION), updateSource)
  .delete(authorize(ROLES.OWNER, ROLES.RECEPTION), deleteSource);

// --- Lead Directions (Owner + Reception) ---
router
  .route("/directions")
  .get(authorize(ROLES.OWNER, ROLES.RECEPTION), getAllDirections)
  .post(authorize(ROLES.OWNER, ROLES.RECEPTION), createDirection);

router
  .route("/directions/:id")
  .all(validateObjectId("id"))
  .put(authorize(ROLES.OWNER, ROLES.RECEPTION), updateDirection)
  .delete(authorize(ROLES.OWNER, ROLES.RECEPTION), deleteDirection);

// --- Lead Categories (Owner + Reception) ---
router
  .route("/categories")
  .get(authorize(ROLES.OWNER, ROLES.RECEPTION), getAllCategories)
  .post(authorize(ROLES.OWNER, ROLES.RECEPTION), createCategory);

router
  .route("/categories/:id")
  .all(validateObjectId("id"))
  .put(authorize(ROLES.OWNER, ROLES.RECEPTION), updateCategory)
  .delete(authorize(ROLES.OWNER, ROLES.RECEPTION), deleteCategory);

// --- Analytics (Owner only) ---
router.get("/analytics/overview", authorize(ROLES.OWNER), getAnalyticsOverview);
router.get("/analytics/sources", authorize(ROLES.OWNER), getSourceAnalytics);
router.get("/analytics/conversion", authorize(ROLES.OWNER), getConversionFunnel);
router.get("/analytics/trends", authorize(ROLES.OWNER), getTrendAnalytics);
router.get("/analytics/directions", authorize(ROLES.OWNER), getDirectionAnalytics);
router.get("/analytics/categories", authorize(ROLES.OWNER), getCategoryAnalytics);

// --- Leads CRUD (Owner + Reception) ---
router
  .route("/")
  .get(authorize(ROLES.OWNER, ROLES.RECEPTION), getAllLeads)
  .post(authorize(ROLES.OWNER, ROLES.RECEPTION), createLead);

router
  .route("/:id")
  .all(validateObjectId("id"))
  .get(authorize(ROLES.OWNER, ROLES.RECEPTION), getLeadById)
  .put(authorize(ROLES.OWNER, ROLES.RECEPTION), updateLead)
  .delete(authorize(ROLES.OWNER, ROLES.RECEPTION), deleteLead);

router.put("/:id/status", validateObjectId("id"), authorize(ROLES.OWNER, ROLES.RECEPTION), updateLeadStatus);

// --- Lead Activities (Owner + Reception) ---
router
  .route("/:id/activities")
  .all(validateObjectId("id"))
  .get(authorize(ROLES.OWNER, ROLES.RECEPTION), getLeadActivities)
  .post(authorize(ROLES.OWNER, ROLES.RECEPTION), createLeadActivity);

module.exports = router;
