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
  getLessonHours,
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

const {
  getCategories,
  getActiveCategories,
  createCategory,
  updateCategory,
  archiveCategory,
  deleteCategory,
} = require("../controllers/salaryCategory.controller");

const {
  getDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  getPositions,
  createPosition,
  updatePosition,
  deletePosition,
  assignStaff,
} = require("../controllers/department.controller");

// ── Hisoblangan oyliklar (admin ko'rinishlari) ──
const { getStaffPayroll, getTeacherPayroll } = require("../controllers/payrollView.controller");
router.get("/view/staff", protect, authorizePermission(PERMISSIONS.PAYROLL_VIEW), getStaffPayroll);
router.get("/view/teachers", protect, authorizePermission(PERMISSIONS.PAYROLL_VIEW), getTeacherPayroll);

// ── Bo'limlar (staff/teaching) ──
router.get("/departments", protect, authorizePermission(PERMISSIONS.PAYROLL_VIEW), getDepartments);
router.post("/departments", protect, authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), createDepartment);
router.put("/departments/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), updateDepartment);
router.delete("/departments/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), deleteDepartment);

// ── Lavozimlar (staff bo'lim ichida) ──
router.get("/positions", protect, authorizePermission(PERMISSIONS.PAYROLL_VIEW), getPositions);
router.post("/positions", protect, authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), createPosition);
router.put("/positions/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), updatePosition);
router.delete("/positions/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), deletePosition);

// ── Xodimni lavozim/toifaga biriktirish ──
router.patch("/staff/:staffId/assign", protect, validateObjectId("staffId"), authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), assignStaff);

// ── Malaka toifasi katalogi (soatlik KPI stavka) ──
router.get("/categories", protect, authorizePermission(PERMISSIONS.PAYROLL_VIEW), getCategories);
router.get("/categories/active", protect, authorizePermission(PERMISSIONS.PAYROLL_VIEW), getActiveCategories);
router.post("/categories", protect, authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), createCategory);
router.put("/categories/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), updateCategory);
router.patch("/categories/:id/archive", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), archiveCategory);
router.delete("/categories/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), deleteCategory);

// ── Oylik qoidalari (kimga qancha) ───────────
// `assign` ALOHIDA huquq: to'laydigan xodim oylik miqdorini o'zi
// belgilay olmasligi kerak.
router.get("/salaries", protect, authorizePermission(PERMISSIONS.PAYROLL_VIEW), getSalaries);
router.post("/salaries", protect, authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), createSalary);
router.get("/salaries/staff/:staffId", protect, validateObjectId("staffId"), authorizePermission(PERMISSIONS.PAYROLL_VIEW), getStaffHistory);
// Dars soati preview'i (KPI summasini oldindan ko'rsatish uchun)
router.get("/salaries/lesson-hours/:staffId", protect, validateObjectId("staffId"), authorizePermission(PERMISSIONS.PAYROLL_VIEW), getLessonHours);
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
