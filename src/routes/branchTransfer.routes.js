// FILIALLARARO KO'CHIRISH — o'quvchi, xodim, sinf (`branchTransfer.service.js`).
//
// Har amal IKKI QADAM: `/preview` (hech narsa yozmaydi, reja + xesh) va
// asosiy yo'l (o'sha xesh va tasdiqlangan oqibatlar bilan). Ruxsat MAQSAD
// filialda ham tekshiriladi — service ichida (`assertActorInTarget`).

const express = require("express");
const router = express.Router();

const {
  protect,
  authorizePermission,
  authorizeAnyPermission,
  authorizeSection,
} = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS, SECTIONS } = require("../utils/permissions");

const {
  previewStudents,
  previewStaff,
  previewClasses,
  transferStudents,
  transferStaff,
  transferClasses,
  listTargetClasses,
  listTransfers,
  getUserTransfers,
  getStaffPayrollAcrossBranches,
} = require("../controllers/branchTransfer.controller");

router.use(protect);

// Odamning filiallararo tarixi va oyligi — profil kartalari uchun, o'z
// bo'limlari ruxsati bilan (ko'chirish bo'limisiz ham ko'rinsin)
router.get(
  "/users/:id",
  validateObjectId("id"),
  authorizeAnyPermission([PERMISSIONS.TRANSFERS_VIEW, PERMISSIONS.USERS_VIEW]),
  getUserTransfers,
);
router.get(
  "/users/:id/payroll",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.PAYROLL_VIEW),
  getStaffPayrollAcrossBranches,
);

router.use(authorizeSection(SECTIONS.TRANSFERS));

router.get("/", authorizePermission(PERMISSIONS.TRANSFERS_VIEW), listTransfers);
router.get(
  "/target-classes",
  authorizeAnyPermission([PERMISSIONS.TRANSFERS_STUDENTS, PERMISSIONS.TRANSFERS_CLASSES]),
  listTargetClasses,
);

router.post("/students/preview", authorizePermission(PERMISSIONS.TRANSFERS_STUDENTS), previewStudents);
router.post("/students", authorizePermission(PERMISSIONS.TRANSFERS_STUDENTS), transferStudents);

router.post("/staff/preview", authorizePermission(PERMISSIONS.TRANSFERS_STAFF), previewStaff);
router.post("/staff", authorizePermission(PERMISSIONS.TRANSFERS_STAFF), transferStaff);

router.post("/classes/preview", authorizePermission(PERMISSIONS.TRANSFERS_CLASSES), previewClasses);
router.post("/classes", authorizePermission(PERMISSIONS.TRANSFERS_CLASSES), transferClasses);

module.exports = router;
