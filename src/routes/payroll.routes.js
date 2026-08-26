// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controllers
const {
  getSalaries,
  getStaffHistory,
  createSalary,
  updateSalary,
  closeSalary,
  deleteSalary,
} = require("../controllers/staffSalary.controller");

const {
  getEntries,
  getStaffEntries,
  generate,
  cancelEntry,
  previewPayment,
  createPayment,
  voidPayment,
  getPayments,
} = require("../controllers/payroll.controller");

// ── Oylik qoidalari (kimga qancha) ───────────
// `assign` ALOHIDA huquq: to'laydigan xodim oylik miqdorini o'zi
// belgilay olmasligi kerak.
router.get("/salaries", protect, authorizePermission(PERMISSIONS.PAYROLL_VIEW), getSalaries);
router.post("/salaries", protect, authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), createSalary);
router.get("/salaries/staff/:staffId", protect, validateObjectId("staffId"), authorizePermission(PERMISSIONS.PAYROLL_VIEW), getStaffHistory);
router.put("/salaries/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), updateSalary);
router.patch("/salaries/:id/close", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), closeSalary);
router.delete("/salaries/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), deleteSalary);

// ── To'lovlar ────────────────────────────────
// `/payments` `/:id` dan OLDIN turishi shart, aks holda "payments" id deb o'qilardi
router.get("/payments", protect, authorizePermission(PERMISSIONS.PAYROLL_VIEW), getPayments);
router.post("/payments/preview", protect, authorizePermission(PERMISSIONS.PAYROLL_PAY), previewPayment);
router.post("/payments", protect, authorizePermission(PERMISSIONS.PAYROLL_PAY), createPayment);
router.post("/payments/:id/void", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.PAYROLL_VOID), voidPayment);

// ── Oylik majburiyatlari ─────────────────────
router.post("/generate", protect, authorizePermission(PERMISSIONS.PAYROLL_GENERATE), generate);
router.get("/staff/:staffId", protect, validateObjectId("staffId"), authorizePermission(PERMISSIONS.PAYROLL_VIEW), getStaffEntries);
router.get("/", protect, authorizePermission(PERMISSIONS.PAYROLL_VIEW), getEntries);
router.post("/:id/cancel", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.PAYROLL_CANCEL), cancelEntry);

module.exports = router;
