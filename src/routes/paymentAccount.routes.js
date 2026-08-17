// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getAccounts,
  getAccount,
  createAccount,
  updateAccount,
  archiveAccount,
  adjustAccount,
  getAccountEntries,
  getReport,
  getTransfers,
  createTransfer,
  voidTransfer,
} = require("../controllers/paymentAccount.controller");

// Aniq yo'llar `/:id` dan OLDIN
router.get("/report", protect, authorizePermission(PERMISSIONS.FINANCE_VIEW), getReport);

// O'tkazmalar — kassalarni boshqarishdan ALOHIDA ruxsat: pul harakati
router.get("/transfers", protect, authorizePermission(PERMISSIONS.FINANCE_VIEW), getTransfers);
router.post("/transfers", protect, authorizePermission(PERMISSIONS.FINANCE_TRANSFER), createTransfer);
router.post("/transfers/:id/void", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_TRANSFER), voidTransfer);

router.get("/", protect, authorizePermission(PERMISSIONS.FINANCE_VIEW), getAccounts);
router.post("/", protect, authorizePermission(PERMISSIONS.FINANCE_ACCOUNTS), createAccount);

router.get("/:id/entries", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_VIEW), getAccountEntries);
// Qo'lda to'g'rilash pulni sababsiz yaratadi/yo'q qiladi — `adjust` ruxsati
router.post("/:id/adjust", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_ADJUST), adjustAccount);
router.patch("/:id/archive", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_ACCOUNTS), archiveAccount);

router.get("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_VIEW), getAccount);
router.put("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_ACCOUNTS), updateAccount);

module.exports = router;
