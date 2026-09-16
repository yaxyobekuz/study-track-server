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
  getMySalary,
  getLessonHours,
  createSalary,
  updateSalary,
  closeSalary,
  deleteSalary,
  getContract,
  previewContract,
  saveContract,
} = require("../controllers/staffSalary.controller");

const {
  getEntries,
  getStaffEntries,
  getMyEntries,
  getMySalaryStats,
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

// ── Oylikdan ushlab qolish ──
// ⚠️ `deduct` ALOHIDA HUQUQ: ushlab qolish pulni kamaytiradi va to'lanmagan
// muhrlangan oylikni qayta yozadi. Ro'yxatni ko'rish — `view` bilan.
// `/deductions/...` `/:id` dan OLDIN turadi (pastdagi izohga qarang).
const deductionController = require("../controllers/payrollDeduction.controller");
// O'zimniki — ruxsatsiz, faqat o'zi (`/my` bilan bir xil mulohaza)
router.get("/deductions/my", protect, deductionController.getMyDeductions);
router.get("/deductions", protect, authorizePermission(PERMISSIONS.PAYROLL_VIEW), deductionController.getDeductions);
router.get("/deductions/candidates", protect, authorizePermission(PERMISSIONS.PAYROLL_DEDUCT), deductionController.getCandidates);
router.post("/deductions/preview", protect, authorizePermission(PERMISSIONS.PAYROLL_DEDUCT), deductionController.previewDeductions);
router.post("/deductions", protect, authorizePermission(PERMISSIONS.PAYROLL_DEDUCT), deductionController.createDeductions);
router.post("/deductions/batch/:batchId/cancel", protect, validateObjectId("batchId"), authorizePermission(PERMISSIONS.PAYROLL_DEDUCT), deductionController.cancelBatch);
router.post("/deductions/batch/:batchId/apply-all", protect, validateObjectId("batchId"), authorizePermission(PERMISSIONS.PAYROLL_DEDUCT), deductionController.applyBatchToAll);
router.post("/deductions/:id/cancel", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.PAYROLL_DEDUCT), deductionController.cancelDeduction);

// ── Hisoblangan oyliklar (admin ko'rinishlari) ──
const { getStaffPayroll, getAssignCandidates, getTeacherPayroll, getAllowancesView, createBonus, deleteBonus } = require("../controllers/payrollView.controller");
router.get("/view/staff", protect, authorizePermission(PERMISSIONS.PAYROLL_VIEW), getStaffPayroll);
// Biriktirish tanlagichi — `assign` bilan (`/users/all-short` ga `users.view` kerak edi)
router.get("/view/assign-candidates", protect, authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), getAssignCandidates);
router.get("/view/teachers", protect, authorizePermission(PERMISSIONS.PAYROLL_VIEW), getTeacherPayroll);
// Ustama haq registri (Yo'nalish -> Ustama haq)
router.get("/view/allowances", protect, authorizePermission(PERMISSIONS.PAYROLL_VIEW), getAllowancesView);
// Admin ustama (PayrollBonus) — to'g'ridan-to'g'ri qo'shish/o'chirish
router.post("/bonuses", protect, authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), createBonus);
router.delete("/bonuses/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), deleteBonus);

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
// O'zimniki (xodim panelidagi profil → "Oylik" tabi). Ruxsat kaliti YO'Q:
// identifikator tokendan, o'quvchi controller'da rad etiladi.
// ⚠️ `/salaries/staff/:staffId` va `/staff/:staffId` dan OLDIN. Bu ikki yo'l
// bir marta birlashtirishda tushib qolgan va tab "yuklab bo'lmadi" deb turardi.
router.get("/salaries/my", protect, getMySalary);
router.get("/my", protect, getMyEntries);
router.get("/salaries", protect, authorizePermission(PERMISSIONS.PAYROLL_VIEW), getSalaries);
router.post("/salaries", protect, authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), createSalary);
router.get("/salaries/staff/:staffId", protect, validateObjectId("staffId"), authorizePermission(PERMISSIONS.PAYROLL_VIEW), getStaffHistory);
// Dars soati preview'i (KPI summasini oldindan ko'rsatish uchun)
router.get("/salaries/lesson-hours/:staffId", protect, validateObjectId("staffId"), authorizePermission(PERMISSIONS.PAYROLL_VIEW), getLessonHours);
// Shartnoma sharti (vedomost oynasi): qoida + toifa bir yo'la.
// ⚠️ UCHALASI HAM `assign`: o'qish ham forma qiymatlari va toifalar
// katalogini ochadi, preview esa aynan belgilash qarorining bir qismi.
router.get("/salaries/staff/:staffId/contract", protect, validateObjectId("staffId"), authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), getContract);
router.post("/salaries/staff/:staffId/contract/preview", protect, validateObjectId("staffId"), authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), previewContract);
router.put("/salaries/staff/:staffId/contract", protect, validateObjectId("staffId"), authorizePermission(PERMISSIONS.PAYROLL_ASSIGN), saveContract);
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
// O'ZIMNING oylik statistikam (teacher panel dashboardi) — ruxsatsiz,
// faqat rol tekshiruvi (controller ichida). `/staff/:staffId` dan OLDIN.
router.get("/my-stats", protect, getMySalaryStats);
router.post("/generate", protect, authorizePermission(PERMISSIONS.PAYROLL_GENERATE), generate);
router.get("/staff/:staffId", protect, validateObjectId("staffId"), authorizePermission(PERMISSIONS.PAYROLL_VIEW), getStaffEntries);
router.get("/", protect, authorizePermission(PERMISSIONS.PAYROLL_VIEW), getEntries);
router.post("/:id/cancel", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.PAYROLL_CANCEL), cancelEntry);

module.exports = router;
