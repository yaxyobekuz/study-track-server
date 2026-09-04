/**
 * MODDIY-TEXNIK BAZA — katalog, xatlov va miqdor daftari.
 *
 * Kunlik monitoring `inventoryCheck.routes.js` da, zarar va undiruv
 * `damage.routes.js` da — uchalasi uch xil mas'uliyat va uch xil ruxsat
 * bo'limi (`utils/permissions.js` dagi izohlarga qarang).
 */

const express = require("express");
const router = express.Router();

const {
  protect,
  authorizePermission,
  authorizeAnyPermission,
} = require("../middleware/auth.middleware");
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
} = require("../controllers/inventoryStock.controller");

const {
  getTransfers,
  getTransferById,
  createTransfer,
} = require("../controllers/inventoryTransfer.controller");

const {
  getSummary,
  getByLocation,
  getByItem,
  getByReason,
  getDebtors,
  getMonitoringReport,
  getSettings,
  getPaymentAccountOptions,
  updateSettings,
} = require("../controllers/inventoryReport.controller");

router.use(protect);

// ─── Ma'lumotnoma o'qishlari — uch bo'lim uchun umumiy ─────
// Inventar uchta ruxsat bo'limiga bo'lingan (`inventory` / `monitoring` /
// `damages`), lekin ularning ekranlari bir xil ma'lumotnomalarni o'qiydi:
// kunlik hisobot ochish uchun XONA tanlanadi, zarar qayd etish uchun xonadagi
// JIHOZ tanlanadi, ikkalasi ham SOZLAMALARDAN "rasm majburiymi" ni o'qiydi.
// Bu o'qishlar faqat `inventory.view` bilan qulflansa, sinf rahbari
// (`monitoring.submit`) varaq ocholmay, kassir (`damages.pay`) esa standart
// to'lov turini ko'rolmay qolardi. Shuning uchun quyidagi o'qishlar uchala
// bo'limning `view` kaliti bilan ochiladi. YOZISH amallari o'z bo'limida qoladi.
const ANY_INVENTORY_VIEW = [
  PERMISSIONS.INVENTORY_VIEW,
  PERMISSIONS.MONITORING_VIEW,
  PERMISSIONS.DAMAGES_VIEW,
];

// ─── Hisobotlar ──────────────────────────────
// `inventory.view` dan ALOHIDA emas: xatlov kesimlari xatlovning o'zi
// bilan bir xil ma'lumot. Pul kesimlari (qarzdorlar) esa `damages.reports`.
router.get("/summary", authorizePermission(PERMISSIONS.INVENTORY_VIEW), getSummary);
router.get("/reports/locations", authorizePermission(PERMISSIONS.INVENTORY_VIEW), getByLocation);
router.get("/reports/items", authorizePermission(PERMISSIONS.INVENTORY_VIEW), getByItem);
// "Nega yo'qotdik" kesimi — jihoz kesimi bilan bir xil ruxsatda: ikkalasi
// ham xatlov ma'lumoti, pul kesimi emas
router.get("/reports/reasons", authorizePermission(PERMISSIONS.INVENTORY_VIEW), getByReason);
router.get("/reports/monitoring", authorizePermission(PERMISSIONS.MONITORING_REPORTS), getMonitoringReport);
router.get("/reports/debtors", authorizePermission(PERMISSIONS.DAMAGES_REPORTS), getDebtors);

// ─── Sozlamalar ──────────────────────────────
router.get("/settings", authorizeAnyPermission(ANY_INVENTORY_VIEW), getSettings);
router.put("/settings", authorizePermission(PERMISSIONS.INVENTORY_SETTINGS), updateSettings);

// To'lov turlari — faqat id va nom (kassa qoldig'i CHIQMAYDI). Undiruv
// oynasi (`damages.pay`) va standart to'lov turi sozlamasi
// (`inventory.settings`) uchun; to'liq registr `finance.view` da qoladi.
router.get(
  "/payment-accounts",
  authorizeAnyPermission([PERMISSIONS.DAMAGES_PAY, PERMISSIONS.INVENTORY_SETTINGS]),
  getPaymentAccountOptions,
);

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
// Faol xonalar — kunlik hisobot va zarar oynalaridagi tanlagich (yuqoridagi izoh)
router.get("/locations/active", authorizeAnyPermission(ANY_INVENTORY_VIEW), getActiveLocations);
router.get("/locations/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.INVENTORY_VIEW), getLocationById);
router.post("/locations", authorizePermission(PERMISSIONS.INVENTORY_LOCATIONS), createLocation);
router.put("/locations/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.INVENTORY_LOCATIONS), updateLocation);
router.patch("/locations/:id/archive", validateObjectId("id"), authorizePermission(PERMISSIONS.INVENTORY_LOCATIONS), archiveLocation);

// ─── Xatlov ──────────────────────────────────
// ⚠️ Amallar ATAYLAB mayda: xatlovga KIRITISH (`stock`) ma'lumot to'ldirish,
// HISOBDAN CHIQARISH (`writeoff`) esa maktab mulkini hujjatdan o'chirish.
router.get("/stocks", authorizePermission(PERMISSIONS.INVENTORY_VIEW), getStocks);
// Bitta xonaning xatlovi — zarar oynasida "xonada QAYSI jihoz bor" tanlagichi
router.get(
  "/stocks/location/:locationId",
  validateObjectId("locationId"),
  authorizeAnyPermission([PERMISSIONS.INVENTORY_VIEW, PERMISSIONS.DAMAGES_VIEW]),
  getStockByLocation,
);
router.post("/stocks", authorizePermission(PERMISSIONS.INVENTORY_STOCK), addStock);
router.post("/stocks/repair", authorizePermission(PERMISSIONS.INVENTORY_REPAIR), repairStock);
router.post("/stocks/write-off", authorizePermission(PERMISSIONS.INVENTORY_WRITEOFF), writeOffStock);
router.post("/stocks/adjust", authorizePermission(PERMISSIONS.INVENTORY_ADJUST), adjustStock);

// ─── O'tkazma — TOPSHIRISH-QABUL QILISH AKTI ─
// Xatlovdan alohida hujjat: qaysi xonaga, KIMGA topshirildi va nima uchun.
// `POST /stocks/transfer` — ESKI manzil, o'sha hujjatni yaratadi va
// saqlanib qolgan (mijoz yangilanmaguncha ishlamay qolmasin).
router.get("/transfers", authorizePermission(PERMISSIONS.INVENTORY_VIEW), getTransfers);
router.get("/transfers/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.INVENTORY_VIEW), getTransferById);
router.post("/transfers", authorizePermission(PERMISSIONS.INVENTORY_TRANSFER), createTransfer);
router.post("/stocks/transfer", authorizePermission(PERMISSIONS.INVENTORY_TRANSFER), createTransfer);

// ─── Miqdor daftari (append-only registr) ────
router.get("/movements", authorizePermission(PERMISSIONS.INVENTORY_VIEW), getMovements);

module.exports = router;
