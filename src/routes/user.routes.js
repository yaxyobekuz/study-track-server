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
  archiveStudent,
  restoreStudent,
  getStats,
  exportUsersToExcel,
  getStudents,
  updateMe,
} = require("../controllers/user.controller");
const {
  protect,
  authorize,
  authorizePermission,
  authorizeSection,
} = require("../middleware/auth.middleware");
const { PERMISSIONS, SECTIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// /students route is accessible to both owner and teacher
router.get("/students", protect, authorizePermission(PERMISSIONS.USERS_VIEW, ROLES.TEACHER), getStudents);

// Own profile update - accessible to any authenticated user
router.put("/me", protect, updateMe);

// all-short - owner, teacher, reception uchun
router.get("/all-short", protect, authorizePermission(PERMISSIONS.USERS_VIEW, ROLES.TEACHER, ROLES.RECEPTION), getAllUsersShort);

// Quyidagi route'lar: bo'limga umumiy kirish + har biriga aniq amal ruxsati
router.use(protect);
router.use(authorizeSection(SECTIONS.USERS));

router.get("/stats", authorizePermission(PERMISSIONS.USERS_VIEW), getStats);
router.get("/export", authorizePermission(PERMISSIONS.USERS_EXPORT), exportUsersToExcel);

router.get("/", authorizePermission(PERMISSIONS.USERS_VIEW), getAllUsers);
router.post("/", authorizePermission(PERMISSIONS.USERS_CREATE), createUser);

router.get("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.USERS_VIEW), getUser);
router.put("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.USERS_UPDATE), updateUser);
router.delete("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.USERS_DELETE), deleteUser);

// Parol — alohida ruxsat (plainPassword ochiladi)
router.put("/:id/reset-password", validateObjectId("id"), authorizePermission(PERMISSIONS.USERS_PASSWORD), resetPassword);
router.get("/:id/password", validateObjectId("id"), authorizePermission(PERMISSIONS.USERS_PASSWORD), getUserPassword);

// Arxivlash / arxivdan qaytarish (faqat o'quvchilar uchun)
router.put("/:id/archive", validateObjectId("id"), authorizePermission(PERMISSIONS.USERS_ARCHIVE), archiveStudent);
router.put("/:id/restore", validateObjectId("id"), authorizePermission(PERMISSIONS.USERS_RESTORE), restoreStudent);

module.exports = router;
