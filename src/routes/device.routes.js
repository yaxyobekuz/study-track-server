/**
 * QURILMA NAZORATI — yo'llar.
 *
 * ⚠️ YO'L TARTIBI MUHIM: `/me/*` va boshqa STATIK bo'g'inlar `/:id` dan
 * OLDIN yoziladi. Aks holda "me" id deb o'qilardi va o'quvchining o'z
 * ekrani 400 bilan yiqilardi (`payroll.routes.js` dagi `/my` bilan
 * bir xil tuzoq — u yerda bir marta shunday bo'lgan).
 *
 * ⚠️ O'QUVCHI YO'LLARI RUXSAT KALITISIZ: `studentId` tokendan olinadi va
 * servis faqat o'quvchi rolini o'tkazadi (`/grade-analysis/my` bilan bir
 * xil naqsh). Ular ruxsat darvozalaridan OLDIN turadi — o'quvchida
 * `devices.*` kalitlari yo'q va bo'lmasligi ham kerak.
 *
 * ⚠️ AMALLAR MAYDA BO'LINGAN (`devices.md` §9): siyosat YOZISH
 * (`policies`) va uni YOQISH (`assign`) alohida; qurilmalar ro'yxati
 * (`view`) va foydalanish hisoboti (`reports`) alohida.
 */

const express = require("express");
const router = express.Router();

const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

const deviceController = require("../controllers/device.controller");
const devicePolicyController = require("../controllers/devicePolicy.controller");
const deviceReportController = require("../controllers/deviceReport.controller");

router.use(protect);

// ═════════════════════════════════════════════════════════════
// O'QUVCHI — O'Z QURILMASI (ruxsat kalitisiz, id tokendan)
// ═════════════════════════════════════════════════════════════
// ⚠️ `GET /me/status` — modulning ETIK ASOSI: o'quvchi o'ziga qo'llangan
// qoidani to'liq ko'radi (`devices.md` §0.1). Hech qachon ruxsat ortiga
// yashirilmaydi.
router.get("/me/status", deviceController.getMyStatus);
router.get("/me/policy", deviceController.getMyPolicy);
router.get("/me/unlocks", deviceController.myUnlocks);
router.post("/me/enroll", deviceController.enrollMyDevice);
router.post("/me/heartbeat", deviceController.myHeartbeat);
router.post("/me/usage", deviceController.myUsage);
router.post("/me/apps", deviceController.myApps);

// ═════════════════════════════════════════════════════════════
// MANZARA VA HISOBOTLAR
// ═════════════════════════════════════════════════════════════
// Dashboard `view` bilan: u qamrov va qurilmalar holatini ko'rsatadi.
router.get(
  "/dashboard",
  authorizePermission(PERMISSIONS.DEVICES_VIEW),
  deviceReportController.getDashboard,
);

// ⚠️ FOYDALANISH HISOBOTI — ALOHIDA `reports`: bolaning qaysi ilovada
// qancha o'tirgani shaxsiy ma'lumot (`security.sessions` bilan bir xil).
router.get(
  "/reports/usage",
  authorizePermission(PERMISSIONS.DEVICES_REPORTS),
  deviceReportController.getUsageReport,
);
router.get(
  "/students/:studentId/overview",
  validateObjectId("studentId"),
  authorizePermission(PERMISSIONS.DEVICES_REPORTS),
  deviceReportController.getStudentOverview,
);

// ═════════════════════════════════════════════════════════════
// ILOVALAR KATALOGI
// ═════════════════════════════════════════════════════════════
// ⚠️ `options` — siyosat muharriri uchun; u `policies` ruxsati bilan ham
// ochilishi kerak, aks holda qoida yozadigan odam ilovalar ro'yxatini
// ko'ra olmasdi.
router.get(
  "/apps/options",
  authorizePermission(PERMISSIONS.DEVICES_POLICIES),
  devicePolicyController.appOptions,
);
router.get("/apps", authorizePermission(PERMISSIONS.DEVICES_APPS), devicePolicyController.listApps);
router.post("/apps", authorizePermission(PERMISSIONS.DEVICES_APPS), devicePolicyController.createApp);
// Ommaviy arxivlash — aniqlangan ilovalar uyumini tozalash uchun
router.post(
  "/apps/bulk-archive",
  authorizePermission(PERMISSIONS.DEVICES_APPS),
  devicePolicyController.bulkArchiveApps,
);
router.put(
  "/apps/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DEVICES_APPS),
  devicePolicyController.updateApp,
);
router.post(
  "/apps/:id/archive",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DEVICES_APPS),
  devicePolicyController.archiveApp,
);
router.post(
  "/apps/:id/restore",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DEVICES_APPS),
  devicePolicyController.restoreApp,
);

// ═════════════════════════════════════════════════════════════
// SIYOSATLAR
// ═════════════════════════════════════════════════════════════
// Ko'rish `view` bilan (qurilma qatorida siyosat nomi turadi), yozish —
// `policies`.
router.get(
  "/policies",
  authorizePermission(PERMISSIONS.DEVICES_VIEW),
  devicePolicyController.listPolicies,
);
router.post(
  "/policies",
  authorizePermission(PERMISSIONS.DEVICES_POLICIES),
  devicePolicyController.createPolicy,
);
router.get(
  "/policies/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DEVICES_VIEW),
  devicePolicyController.getPolicy,
);
router.put(
  "/policies/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DEVICES_POLICIES),
  devicePolicyController.updatePolicy,
);
router.post(
  "/policies/:id/archive",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DEVICES_POLICIES),
  devicePolicyController.archivePolicy,
);
router.post(
  "/policies/:id/restore",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DEVICES_POLICIES),
  devicePolicyController.restorePolicy,
);
// ⚠️ "Nechta o'quvchiga ta'sir qiladi" — biriktirishdan OLDIN ko'rsatiladi.
// `assign` bilan: bu raqamni biriktirmoqchi bo'lgan odam so'raydi.
router.get(
  "/policies/:id/impact",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DEVICES_ASSIGN),
  devicePolicyController.previewPolicyImpact,
);

// ═════════════════════════════════════════════════════════════
// BIRIKTIRISH
// ═════════════════════════════════════════════════════════════
router.get(
  "/assignments",
  authorizePermission(PERMISSIONS.DEVICES_VIEW),
  devicePolicyController.listAssignments,
);
router.post(
  "/assignments",
  authorizePermission(PERMISSIONS.DEVICES_ASSIGN),
  devicePolicyController.setAssignment,
);
router.delete(
  "/assignments/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DEVICES_ASSIGN),
  devicePolicyController.clearAssignment,
);

// ═════════════════════════════════════════════════════════════
// VAQTINCHALIK OCHISH
// ═════════════════════════════════════════════════════════════
router.get(
  "/unlocks",
  authorizePermission(PERMISSIONS.DEVICES_VIEW),
  deviceController.listUnlocks,
);
router.post(
  "/unlocks",
  authorizePermission(PERMISSIONS.DEVICES_UNLOCK),
  deviceController.createUnlock,
);
router.post(
  "/unlocks/:id/cancel",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DEVICES_UNLOCK),
  deviceController.cancelUnlock,
);

// ═════════════════════════════════════════════════════════════
// O'QUVCHI QIDIRUVI (oynalardagi tanlagich uchun)
// ═════════════════════════════════════════════════════════════
// ⚠️ `devices.view` bilan: `enroll`, `assign` va `unlock` ruxsatlarining
// har biri `view` ni avtomatik oladi (`normalizePermissions`), ya'ni
// uchala oyna ham ishlaydi, lekin bo'limga umuman kirmaydigan odamga
// o'quvchilar ro'yxati ochilmaydi.
router.get(
  "/students",
  authorizePermission(PERMISSIONS.DEVICES_VIEW),
  deviceController.searchStudents,
);

// ═════════════════════════════════════════════════════════════
// BIRIKTIRISH KODLARI
// ═════════════════════════════════════════════════════════════
router.post("/codes", authorizePermission(PERMISSIONS.DEVICES_ENROLL), deviceController.issueCode);
router.get(
  "/codes/:studentId",
  validateObjectId("studentId"),
  authorizePermission(PERMISSIONS.DEVICES_ENROLL),
  deviceController.getStudentCode,
);

// ═════════════════════════════════════════════════════════════
// SOZLAMALAR VA AUDIT
// ═════════════════════════════════════════════════════════════
router.get("/settings", authorizePermission(PERMISSIONS.DEVICES_VIEW), deviceController.getSettings);
router.put(
  "/settings",
  authorizePermission(PERMISSIONS.DEVICES_SETTINGS),
  deviceController.updateSettings,
);
router.get("/audit", authorizePermission(PERMISSIONS.DEVICES_VIEW), deviceController.listAudit);

// ═════════════════════════════════════════════════════════════
// QURILMALAR — `/:id` ENG OXIRIDA (statik bo'g'inlardan keyin)
// ═════════════════════════════════════════════════════════════
router.get("/", authorizePermission(PERMISSIONS.DEVICES_VIEW), deviceController.listDevices);
router.get(
  "/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DEVICES_VIEW),
  deviceController.getDevice,
);
router.post(
  "/:id/pause",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DEVICES_ENROLL),
  deviceController.pauseDevice,
);
router.post(
  "/:id/resume",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DEVICES_ENROLL),
  deviceController.resumeDevice,
);
router.delete(
  "/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DEVICES_ENROLL),
  deviceController.removeDevice,
);

module.exports = router;
