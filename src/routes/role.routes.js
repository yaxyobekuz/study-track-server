const express = require("express");
const router = express.Router();
const {
  getAllRoles,
  getRoleOptions,
  createRole,
  updateRole,
  deleteRole,
} = require("../controllers/role.controller");
const {
  protect,
  authorize,
  authorizePermission,
} = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");
const { PERMISSIONS } = require("../utils/permissions");

router.use(protect);

// To'liq ro'yxat (ruxsatlar matritsasi + sanoq) — faqat owner (Rollar
// boshqaruvi sahifasi).
router.get("/", authorize(ROLES.OWNER), getAllRoles);

// Dropdown uchun yengil ro'yxat (nom + qiymat) — XODIM QO'SHISH huquqi
// bo'lgan har kim, owner har doim o'tadi (`authorizePermission` ichida):
// "Yangi xodim" formasidagi "Rol" ro'yxati chiqishi uchun. To'liq matritsa
// bu yerdan oshkor bo'lmaydi.
router.get("/options", authorizePermission(PERMISSIONS.USERS_CREATE), getRoleOptions);

// CUD operatsiyalari — faqat owner.
router.post("/", authorize(ROLES.OWNER), createRole);
router.put("/:id", authorize(ROLES.OWNER), validateObjectId("id"), updateRole);
router.delete("/:id", authorize(ROLES.OWNER), validateObjectId("id"), deleteRole);

module.exports = router;
