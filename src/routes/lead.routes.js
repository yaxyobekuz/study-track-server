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
const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// All routes require authentication
router.use(protect);

// --- Lead Sources (Owner + Reception) ---
router
  .route("/sources")
  .get(authorizePermission(PERMISSIONS.LEADS, ROLES.RECEPTION), getAllSources)
  .post(authorizePermission(PERMISSIONS.LEADS, ROLES.RECEPTION), createSource);

router
  .route("/sources/:id")
  .all(validateObjectId("id"))
  .put(authorizePermission(PERMISSIONS.LEADS, ROLES.RECEPTION), updateSource)
  .delete(authorizePermission(PERMISSIONS.LEADS, ROLES.RECEPTION), deleteSource);

// --- Lead Directions (Owner + Reception) ---
router
  .route("/directions")
  .get(authorizePermission(PERMISSIONS.LEADS, ROLES.RECEPTION), getAllDirections)
  .post(authorizePermission(PERMISSIONS.LEADS, ROLES.RECEPTION), createDirection);

router
  .route("/directions/:id")
  .all(validateObjectId("id"))
  .put(authorizePermission(PERMISSIONS.LEADS, ROLES.RECEPTION), updateDirection)
  .delete(authorizePermission(PERMISSIONS.LEADS, ROLES.RECEPTION), deleteDirection);

// --- Lead Categories (Owner + Reception) ---
router
  .route("/categories")
  .get(authorizePermission(PERMISSIONS.LEADS, ROLES.RECEPTION), getAllCategories)
  .post(authorizePermission(PERMISSIONS.LEADS, ROLES.RECEPTION), createCategory);

router
  .route("/categories/:id")
  .all(validateObjectId("id"))
  .put(authorizePermission(PERMISSIONS.LEADS, ROLES.RECEPTION), updateCategory)
  .delete(authorizePermission(PERMISSIONS.LEADS, ROLES.RECEPTION), deleteCategory);

// --- Analytics (Owner only) ---
router.get("/analytics/overview", authorizePermission(PERMISSIONS.LEADS), getAnalyticsOverview);
router.get("/analytics/sources", authorizePermission(PERMISSIONS.LEADS), getSourceAnalytics);
router.get("/analytics/conversion", authorizePermission(PERMISSIONS.LEADS), getConversionFunnel);
router.get("/analytics/trends", authorizePermission(PERMISSIONS.LEADS), getTrendAnalytics);
router.get("/analytics/directions", authorizePermission(PERMISSIONS.LEADS), getDirectionAnalytics);
router.get("/analytics/categories", authorizePermission(PERMISSIONS.LEADS), getCategoryAnalytics);

// --- Leads CRUD (Owner + Reception) ---
router
  .route("/")
  .get(authorizePermission(PERMISSIONS.LEADS, ROLES.RECEPTION), getAllLeads)
  .post(authorizePermission(PERMISSIONS.LEADS, ROLES.RECEPTION), createLead);

router
  .route("/:id")
  .all(validateObjectId("id"))
  .get(authorizePermission(PERMISSIONS.LEADS, ROLES.RECEPTION), getLeadById)
  .put(authorizePermission(PERMISSIONS.LEADS, ROLES.RECEPTION), updateLead)
  .delete(authorizePermission(PERMISSIONS.LEADS, ROLES.RECEPTION), deleteLead);

router.put("/:id/status", validateObjectId("id"), authorizePermission(PERMISSIONS.LEADS, ROLES.RECEPTION), updateLeadStatus);

// --- Lead Activities (Owner + Reception) ---
router
  .route("/:id/activities")
  .all(validateObjectId("id"))
  .get(authorizePermission(PERMISSIONS.LEADS, ROLES.RECEPTION), getLeadActivities)
  .post(authorizePermission(PERMISSIONS.LEADS, ROLES.RECEPTION), createLeadActivity);

module.exports = router;
