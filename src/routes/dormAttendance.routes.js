const express = require("express");
const router = express.Router();
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const {
  getDay,
  getClassBreakdown,
  mark,
  getSettings,
  updateSettings,
  exportExcel,
} = require("../controllers/dormAttendance.controller");

// YOTOQXONA DAVOMATI — kechqurun yotoqxonada kim qoldi.
//
// ⚠️ RUXSAT BO'LIMI ALOHIDA (`dormAttendance`), `attendance` ichida EMAS:
// dars davomatiga umumiy huquqi bor odam yotoqxona registrini ochib
// olmasin, tarbiyachi esa butun maktabning dars davomatini belgilay
// olmasin (`utils/permissions.js` izohiga qarang).
//
// ⚠️ O'TGAN KUNNI TO'G'RILASH alohida kalit (`update`) bilan, lekin AYNI
// yo'l orqali: ikkinchi endpoint bo'lsa, undagi tekshiruv (ro'yxat
// serverdan, holat, takror) bittasida jimgina tushib qolardi. Kun va soat
// darvozasi servisda — `resolveMarkGate`.
router.use(protect);

router.get("/", authorizePermission(PERMISSIONS.DORMATTENDANCE_VIEW), getDay);
router.get(
  "/classes",
  authorizePermission(PERMISSIONS.DORMATTENDANCE_VIEW),
  getClassBreakdown,
);
router.get(
  "/export",
  authorizePermission(PERMISSIONS.DORMATTENDANCE_EXPORT),
  exportExcel,
);

// ⚠️ `/settings` GET — `view` bilan: ekran "16:00 dan boshlanadi" deb
// yozishi uchun sozlamani o'qishi kerak. Yozish esa alohida kalit bilan.
router.get(
  "/settings",
  authorizePermission(PERMISSIONS.DORMATTENDANCE_VIEW),
  getSettings,
);
router.patch(
  "/settings",
  authorizePermission(PERMISSIONS.DORMATTENDANCE_SETTINGS),
  updateSettings,
);

router.post("/mark", authorizePermission(PERMISSIONS.DORMATTENDANCE_MARK), mark);

module.exports = router;
