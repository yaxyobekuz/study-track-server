const asyncHandler = require("../middleware/async.middleware");
const securityDashboard = require("../services/securityDashboard.service");
const {
  hasPermission,
  hasRole,
  PERMISSIONS,
} = require("../utils/permissions");
const { ROLES } = require("../utils/constants");

/**
 * ⚠️ HAR BIR CHAQIRUVGA `actor` VA `branch` UZATILADI. Xavfsizlik
 * jadvallari platformada (barcha filiallar bir joyda), ruxsat esa har
 * filialda alohida — service o'zi filialni bila olmaydi, chunki
 * `config/prisma` Proxy'si faqat FILIAL client'ini tanlaydi, platforma
 * client'i esa har doim bitta. Filtr shuning uchun ochiq argument.
 */

const getOverview = asyncHandler(async (req, res) => {
  // ⚠️ IP, qurilma va aniq odamlar ro'yxati `security.sessions` bilan.
  // `security.view` faqat raqamlarni ochadi — mayda ruxsatlar shakli
  // (moliya bo'limidagi naqsh) aynan shu ajratishga tayanadi.
  const withDetails =
    hasRole(req.user, ROLES.OWNER) ||
    hasPermission(req.user.permissions, PERMISSIONS.SECURITY_SESSIONS);

  const data = await securityDashboard.getOverview({
    days: req.query.days,
    actor: req.user,
    branch: req.branch,
    withDetails,
  });

  res.json({ success: true, data });
});

const listSessions = asyncHandler(async (req, res) => {
  const { items, pagination } = await securityDashboard.listSessions({
    actor: req.user,
    branch: req.branch,
    status: req.query.status,
    userId: req.query.userId,
    page: req.query.page,
    limit: req.query.limit,
  });

  res.json({ success: true, data: items, pagination });
});

const listAlerts = asyncHandler(async (req, res) => {
  const { items, pagination } = await securityDashboard.listAlerts({
    actor: req.user,
    branch: req.branch,
    status: req.query.status,
    severity: req.query.severity,
    type: req.query.type,
    page: req.query.page,
    limit: req.query.limit,
  });

  res.json({ success: true, data: items, pagination });
});

const listAttempts = asyncHandler(async (req, res) => {
  const { items, pagination } = await securityDashboard.listAttempts({
    actor: req.user,
    branch: req.branch,
    success: req.query.success,
    username: req.query.username,
    page: req.query.page,
    limit: req.query.limit,
  });

  res.json({ success: true, data: items, pagination });
});

// Seansni majburan tugatish — boshqa odamning ishini uzadi
const revokeSession = asyncHandler(async (req, res) => {
  const data = await securityDashboard.revokeSession(
    req.params.id,
    req.user,
    req.branch,
  );

  res.json({ success: true, message: "Seans tugatildi", data });
});

// Foydalanuvchining BARCHA seanslarini tugatish ("parol tarqalgan" holati)
const revokeUserSessions = asyncHandler(async (req, res) => {
  const data = await securityDashboard.revokeUserSessions(
    req.params.userId,
    req.user,
    req.branch,
  );

  res.json({
    success: true,
    message: `${data.closed} ta seans tugatildi`,
    data,
  });
});

const updateAlert = asyncHandler(async (req, res) => {
  const data = await securityDashboard.updateAlert(req.params.id, {
    status: req.body.status,
    note: req.body.note,
    actor: req.user,
    branch: req.branch,
  });

  res.json({ success: true, message: "Ogohlantirish yangilandi", data });
});

const getUserSecurity = asyncHandler(async (req, res) => {
  const data = await securityDashboard.getUserSecurity(req.params.userId, {
    actor: req.user,
    branch: req.branch,
    days: req.query.days,
  });

  res.json({ success: true, data });
});

module.exports = {
  getOverview,
  listSessions,
  listAlerts,
  listAttempts,
  revokeSession,
  revokeUserSessions,
  updateAlert,
  getUserSecurity,
};
