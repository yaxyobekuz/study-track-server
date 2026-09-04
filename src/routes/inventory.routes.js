/**
 * MODDIY-TEXNIK BAZA — katalog, xatlov va miqdor daftari.
 *
 * Kunlik monitoring `inventoryCheck.routes.js` da, zarar va undiruv
 * `damage.routes.js` da — uchalasi uch xil mas'uliyat va uch xil ruxsat
 * bo'limi (`utils/permissions.js` dagi izohlarga qarang).
 */

const express = require("express");
const router = express.Router();

const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

const {
  getCategories,
  createCategory,
  updateCategory,
  archiveCategory,
  getItems,
  getActiveItems,
  createItem,
  updateItem,
  archiveItem,
  getLocations,
  getActiveLocations,
  getLocationById,
  createLocation,
  updateLocation,
  archiveLocation,
} = require("../controllers/inventoryCatalog.controller");

const {
  getStocks,
  getStockByLocation,
  getMovements,
  addStock,
  repairStock,
  writeOffStock,
  adjustStock,
  transferStock,
} = require("../controllers/inventoryStock.controller");

const {
  getSummary,
  getByLocation,
  getByItem,
  getDebtors,
  getMonitoringReport,
  getSettings,
  updateSettings,
} = require("../controllers/inventoryReport.controller");

router.use(protect);

// ─── Hisobotlar ──────────────────────────────
// `inventory.view` dan ALOHIDA emas: xatlov kesimlari xatlovning o'zi
// bilan bir xil ma'lumot. Pul kesimlari (qarzdorlar) esa `damages.reports`.
router.get("/summary", authorizePermission(PERMISSIONS.INVENTORY_VIEW), getSummary);
router.get("/reports/locations", authorizePermission(PERMISSIONS.INVENTORY_VIEW), getByLocation);
router.get("/reports/items", authorizePermission(PERMISSIONS.INVENTORY_VIEW), getByItem);
router.get("/reports/monitoring", authorizePermission(PERMISSIONS.MONITORING_REPORTS), getMonitoringReport);
router.get("/reports/debtors", authorizePermission(PERMISSIONS.DAMAGES_REPORTS), getDebtors);

// ─── Sozlamalar ──────────────────────────────
router.get("/settings", authorizePermission(PERMISSIONS.INVENTORY_VIEW), getSettings);
router.put("/settings", authorizePermission(PERMISSIONS.INVENTORY_SETTINGS), updateSettings);

// ─── Toifalar katalogi ───────────────────────
router.get("/categories", authorizePermission(PERMISSIONS.INVENTORY_VIEW), getCategories);
router.post("/categories", authorizePermission(PERMISSIONS.INVENTORY_CATALOG), createCategory);
router.put("/categories/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.INVENTORY_CATALOG), updateCategory);
router.patch("/categories/:id/archive", validateObjectId("id"), authorizePermission(PERMISSIONS.INVENTORY_CATALOG), archiveCategory);

// ─── Jihoz turlari katalogi ──────────────────
router.get("/items", authorizePermission(PERMISSIONS.INVENTORY_VIEW), getItems);
router.get("/items/active", authorizePermission(PERMISSIONS.INVENTORY_VIEW), getActiveItems);
router.post("/items", authorizePermission(PERMISSIONS.INVENTORY_CATALOG), createItem);
router.put("/items/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.INVENTORY_CATALOG), updateItem);
router.patch("/items/:id/archive", validateObjectId("id"), authorizePermission(PERMISSIONS.INVENTORY_CATALOG), archiveItem);

// ─── Xonalar ─────────────────────────────────
router.get("/locations", authorizePermission(PERMISSIONS.INVENTORY_VIEW), getLocations);
router.get("/locations/active", authorizePermission(PERMISSIONS.INVENTORY_VIEW), getActiveLocations);
router.get("/locations/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.INVENTORY_VIEW), getLocationById);
router.post("/locations", authorizePermission(PERMISSIONS.INVENTORY_LOCATIONS), createLocation);
router.put("/locations/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.INVENTORY_LOCATIONS), updateLocation);
router.patch("/locations/:id/archive", validateObjectId("id"), authorizePermission(PERMISSIONS.INVENTORY_LOCATIONS), archiveLocation);

// ─── Xatlov ──────────────────────────────────
// ⚠️ Amallar ATAYLAB mayda: xatlovga KIRITISH (`stock`) ma'lumot to'ldirish,
// HISOBDAN CHIQARISH (`writeoff`) esa maktab mulkini hujjatdan o'chirish.
router.get("/stocks", authorizePermission(PERMISSIONS.INVENTORY_VIEW), getStocks);
router.get("/stocks/location/:locationId", validateObjectId("locationId"), authorizePermission(PERMISSIONS.INVENTORY_VIEW), getStockByLocation);
router.post("/stocks", authorizePermission(PERMISSIONS.INVENTORY_STOCK), addStock);
router.post("/stocks/repair", authorizePermission(PERMISSIONS.INVENTORY_REPAIR), repairStock);
router.post("/stocks/write-off", authorizePermission(PERMISSIONS.INVENTORY_WRITEOFF), writeOffStock);
router.post("/stocks/adjust", authorizePermission(PERMISSIONS.INVENTORY_ADJUST), adjustStock);
router.post("/stocks/transfer", authorizePermission(PERMISSIONS.INVENTORY_TRANSFER), transferStock);

// ─── Miqdor daftari (append-only registr) ────
router.get("/movements", authorizePermission(PERMISSIONS.INVENTORY_VIEW), getMovements);

module.exports = router;
