// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getExpenses,
  createExpense,
  voidExpense,
  replaceExpense,
  exportExpenses,
} = require("../controllers/expense.controller");

// Amallar ATAYLAB mayda: xarajat qo'sha oladigan xodim uni BEKOR QILA
// olmasligi kerak — bekor qilish kassa qoldig'ini oshiradi.
router.get("/", protect, authorizePermission(PERMISSIONS.EXPENSES_VIEW), getExpenses);
// Excel — registrni KO'RISH huquqi yetarli: fayl ekrandagi ro'yxatning
// nusxasi, ya'ni u yangi ma'lumot ochmaydi. Alohida ruxsat kiritilsa,
// ro'yxatni ko'ra oladigan xodim uni qog'ozga chiqara olmay qolardi.
router.get("/export", protect, authorizePermission(PERMISSIONS.EXPENSES_VIEW), exportExpenses);
router.post("/", protect, authorizePermission(PERMISSIONS.EXPENSES_CREATE), createExpense);
router.post("/:id/void", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.EXPENSES_VOID), voidExpense);
// Tahrirlash = bekor qilish + qaytadan yozish, shuning uchun IKKALA huquq
// ham talab qilinadi (oylik to'lovidagi `/payments/:id/replace` bilan bir xil)
router.post("/:id/replace", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.EXPENSES_VOID), authorizePermission(PERMISSIONS.EXPENSES_CREATE), replaceExpense);

module.exports = router;
