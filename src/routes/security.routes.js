/**
 * XAVFSIZLIK — "hisobga KIM kirdi?".
 *
 * ⚠️ AMALLAR ATAYLAB MAYDA (moliya bo'limidagi bilan bir xil mantiq):
 *
 *   security.view     — manzara va raqamlar
 *   security.sessions — seanslar, urinishlar, foydalanuvchi kartasi
 *                       (IP, qurilma, kirish vaqti — shaxsiy ma'lumot)
 *   security.revoke   — BOSHQA ODAMNING ISHINI UZISH
 *   security.alerts   — ogohlantirishlarni yopish
 *
 * `revoke` alohida turishi shart: u kimningdir ochiq ishini bir bosishda
 * to'xtatadi va uni "ro'yxatni ko'rish" huquqi bilan birga berib
 * bo'lmaydi.
 *
 * ⚠️ FILIAL DARVOZASI SERVICE ICHIDA (`branchScope`), route'da emas:
 * jadvallar platformada va Prisma Proxy'si ularni filtrlab bera olmaydi.
 */

const express = require("express");
const router = express.Router();

const {
  protect,
  authorizePermission,
  authorizeSection,
} = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS, SECTIONS } = require("../utils/permissions");

const {
  getOverview,
  listSessions,
  listAlerts,
  listAttempts,
  revokeSession,
  revokeUserSessions,
  updateAlert,
  getUserSecurity,
} = require("../controllers/security.controller");

router.use(protect);
router.use(authorizeSection(SECTIONS.SECURITY));

// ── Manzara ────────────────────────────────────────────────────────
router.get("/overview", authorizePermission(PERMISSIONS.SECURITY_VIEW), getOverview);

// ── Ro'yxatlar ─────────────────────────────────────────────────────
router.get("/sessions", authorizePermission(PERMISSIONS.SECURITY_SESSIONS), listSessions);
router.get("/attempts", authorizePermission(PERMISSIONS.SECURITY_SESSIONS), listAttempts);
router.get("/alerts", authorizePermission(PERMISSIONS.SECURITY_VIEW), listAlerts);

// ── Foydalanuvchi kartasi ──────────────────────────────────────────
router.get(
  "/users/:userId",
  validateObjectId("userId"),
  authorizePermission(PERMISSIONS.SECURITY_SESSIONS),
  getUserSecurity,
);

// ── Amallar ────────────────────────────────────────────────────────
router.put(
  "/alerts/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.SECURITY_ALERTS),
  updateAlert,
);

router.delete(
  "/sessions/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.SECURITY_REVOKE),
  revokeSession,
);

// "Parol tarqalgan" holati — bitta tugma bilan hammasini yopish.
// Har seansni alohida bosish o'sha lahzada ochilgan yangisini
// qoldirib ketardi.
router.delete(
  "/users/:userId/sessions",
  validateObjectId("userId"),
  authorizePermission(PERMISSIONS.SECURITY_REVOKE),
  revokeUserSessions,
);

module.exports = router;
