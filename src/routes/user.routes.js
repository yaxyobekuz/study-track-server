const express = require("express");
const router = express.Router();
const {
  getAllUsers,
  getAllUsersShort,
  getUser,
  createUser,
  updateUser,
  resetPassword,
  getUserPassword,
  deleteUser,
  archiveUser,
  restoreUser,
  getStats,
  getStaffReport,
  exportUsersToExcel,
  getStudents,
  updateMe,
  getUserBranches,
  attachUserToBranch,
  detachUserFromBranch,
} = require("../controllers/user.controller");
const {
  protect,
  authorize,
  authorizePermission,
  authorizeAnyPermission,
  authorizeSection,
} = require("../middleware/auth.middleware");
const { PERMISSIONS, SECTIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// /students route is accessible to both owner and teacher
router.get("/students", protect, authorizePermission(PERMISSIONS.USERS_VIEW, ROLES.TEACHER), getStudents);

// Own profile update - accessible to any authenticated user
router.put("/me", protect, updateMe);

// all-short — qisqa ma'lumotnoma (id, ism, rol). Tanlagichlar uchun:
//   - xonaga mas'ul xodim biriktirish   (`inventory.locations`)
//   - zararni aybdorga yozish           (`damages.charge`)
//   - jihozni xodimga topshirish        (`inventory.transfer`)
// Bularning hammasi `users.view` siz ham ishlashi kerak: xo'jalik mudiri
// odamni tanlash uchun butun foydalanuvchilar bo'limiga kirish huquqini
// olmasligi kerak. Ro'yxatda parol, telefon yoki ruxsatlar YO'Q.
//
// ⚠️ Bu ro'yxatga YANGI TANLAGICH qo'shilganda uning ruxsat kaliti ham shu
// yerga qo'shilishi SHART — aks holda tanlagich ekranda turadi-yu, 403
// tufayli bo'sh qoladi va foydalanuvchi sababini bilmaydi.
router.get(
  "/all-short",
  protect,
  authorizeAnyPermission(
    [
      PERMISSIONS.USERS_VIEW,
      PERMISSIONS.INVENTORY_LOCATIONS,
      PERMISSIONS.INVENTORY_TRANSFER,
      PERMISSIONS.DAMAGES_CHARGE,
    ],
    ROLES.TEACHER,
    ROLES.RECEPTION,
  ),
  getAllUsersShort,
);

// Quyidagi route'lar: bo'limga umumiy kirish + har biriga aniq amal ruxsati
router.use(protect);
router.use(authorizeSection(SECTIONS.USERS));

router.get("/stats", authorizePermission(PERMISSIONS.USERS_VIEW), getStats);
router.get("/reports", authorizePermission(PERMISSIONS.USERS_REPORTS), getStaffReport);
router.get("/export", authorizePermission(PERMISSIONS.USERS_EXPORT), exportUsersToExcel);

router.get("/", authorizePermission(PERMISSIONS.USERS_VIEW), getAllUsers);
router.post("/", authorizePermission(PERMISSIONS.USERS_CREATE), createUser);

router.get("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.USERS_VIEW), getUser);
router.put("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.USERS_UPDATE), updateUser);
router.delete("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.USERS_DELETE), deleteUser);

// Parol — alohida ruxsat (plainPassword ochiladi)
router.put("/:id/reset-password", validateObjectId("id"), authorizePermission(PERMISSIONS.USERS_PASSWORD), resetPassword);
router.get("/:id/password", validateObjectId("id"), authorizePermission(PERMISSIONS.USERS_PASSWORD), getUserPassword);

// Arxivlash / arxivdan qaytarish (o'quvchi ham, xodim ham — owner'dan tashqari)
router.put("/:id/archive", validateObjectId("id"), authorizePermission(PERMISSIONS.USERS_ARCHIVE), archiveUser);
router.put("/:id/restore", validateObjectId("id"), authorizePermission(PERMISSIONS.USERS_RESTORE), restoreUser);

// Xodimni filiallarga biriktirish.
//
// Ko'rish `users.view` bilan — xodim kartasida "qayerda ishlaydi" ko'rinishi
// kerak. BIRIKTIRISH esa `branches.assign` bilan: bu odamni butun boshqa
// bazaga kiritadi, ya'ni oddiy tahrirlashdan tubdan farq qiladi.
router.get("/:id/branches", validateObjectId("id"), authorizePermission(PERMISSIONS.USERS_VIEW), getUserBranches);
router.post("/:id/branches", validateObjectId("id"), authorizePermission(PERMISSIONS.BRANCHES_ASSIGN), attachUserToBranch);
router.delete("/:id/branches/:branchId", validateObjectId("id"), validateObjectId("branchId"), authorizePermission(PERMISSIONS.BRANCHES_ASSIGN), detachUserFromBranch);

module.exports = router;
