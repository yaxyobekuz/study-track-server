const asyncHandler = require("../middleware/async.middleware");
const tariffService = require("../services/tariff.service");
const directionService = require("../services/tariffDirection.service");
const tariffResolutionService = require("../services/tariffResolution.service");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");
const { parseMonthKey, currentMonthKey } = require("../helpers/month.helpers");
const { BadRequestError, ForbiddenError } = require("../utils/errors");
const { PERMISSIONS, hasPermission } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");

// ── Katalog ──────────────────────────────────

const getTariffs = asyncHandler(async (req, res) => {
  const result = await tariffService.getTariffs(req);
  res.json(result);
});

const getTariff = asyncHandler(async (req, res) => {
  const month = req.query.month ? parseMonthKey(req.query.month, "Oy") : null;
  const tariff = await tariffService.getTariffById(req.params.id, month);
  res.json({ success: true, data: tariff });
});

const createTariff = asyncHandler(async (req, res) => {
  const tariff = await tariffService.createTariff(req.body, req.user.id);
  res.status(201).json({ success: true, data: tariff });
});

const updateTariff = asyncHandler(async (req, res) => {
  const tariff = await tariffService.updateTariff(req.params.id, req.body);
  res.json({ success: true, data: tariff });
});

const archiveTariff = asyncHandler(async (req, res) => {
  const tariff = await tariffService.setTariffArchived(
    req.params.id,
    req.body.isArchived !== false,
  );
  res.json({ success: true, data: tariff });
});

const deleteTariff = asyncHandler(async (req, res) => {
  const result = await tariffService.deleteTariff(req.params.id);
  res.json({ success: true, ...result });
});

const getTimeline = asyncHandler(async (req, res) => {
  const timeline = await tariffService.getTariffTimeline(req.params.id);
  res.json({ success: true, data: timeline });
});

// ── Narx versiyalari ─────────────────────────

const getVersions = asyncHandler(async (req, res) => {
  const result = await tariffService.getVersions(req.params.id, req);
  res.json(result);
});

const addVersion = asyncHandler(async (req, res) => {
  const version = await tariffService.addVersion(
    req.params.id,
    req.body,
    req.user.id,
  );
  res.status(201).json({ success: true, data: version });
});

const updateVersion = asyncHandler(async (req, res) => {
  const force = req.query.force === "true";

  // Amaldagi (yoki o'tgan) versiyani majburiy tahrirlash — alohida, yuqoriroq
  // ruxsat. Route'dagi `tariffs.versions` bunga yetarli emas: oddiy narx
  // qo'shish va o'tgan oyning summasini o'zgartirish bir xil huquq emas.
  if (
    force &&
    req.user.role !== ROLES.OWNER &&
    !hasPermission(req.user.permissions, PERMISSIONS.TARIFFS_ADJUST)
  ) {
    throw new ForbiddenError(
      "Amaldagi yozuvni to'g'rilash uchun ruxsatingiz yo'q",
    );
  }

  const version = await tariffService.updateVersion(
    req.params.id,
    req.params.versionId,
    req.body,
    { force, userId: req.user.id },
  );
  res.json({ success: true, data: version });
});

const deleteVersion = asyncHandler(async (req, res) => {
  const result = await tariffService.deleteVersion(
    req.params.id,
    req.params.versionId,
  );
  res.json({ success: true, ...result });
});

// ── Narxni hal qilish ────────────────────────

const resolveForStudent = asyncHandler(async (req, res) => {
  const { studentId } = req.query;
  if (!studentId) throw new BadRequestError("O'quvchi ko'rsatilmagan");

  const month = req.query.month
    ? parseMonthKey(req.query.month, "Oy")
    : currentMonthKey();

  const result = await tariffResolutionService.resolveForStudent(studentId, month);
  res.json({ success: true, data: result });
});

/**
 * Oylik yig'ma varaqa — kim qancha to'laydi + umumiy summa.
 * Biriktirilmagan o'quvchi ham qatorda qoladi (404 emas), UI uni
 * "biriktirilmagan" deb ko'rsatadi.
 */
const resolveMonthSheet = asyncHandler(async (req, res) => {
  const month = parseMonthKey(req.params.month, "Oy");
  const { page, limit, skip } = getPaginationParams(req);

  const studentIds = req.query.studentIds
    ? String(req.query.studentIds).split(",").map((id) => id.trim()).filter(Boolean)
    : undefined;

  const { rows, total, totals } = await tariffResolutionService.buildMonthSheet(
    month,
    { classId: req.query.classId, studentIds, page, limit, skip },
  );

  res.json({
    ...formatPaginationResponse(rows, total, page, limit),
    month,
    totals,
  });
});

// ─────────────────────────────────────────────
// Yo'nalishlar (tarif ustidagi daraja)
// ─────────────────────────────────────────────

const getDirections = asyncHandler(async (req, res) => {
  const data = await directionService.getDirections(req.query);
  res.json({ success: true, ...data });
});

const createDirection = asyncHandler(async (req, res) => {
  const data = await directionService.createDirection(req.body, req.user.id);
  res.status(201).json({ success: true, message: "Yo'nalish qo'shildi", data });
});

const updateDirection = asyncHandler(async (req, res) => {
  const data = await directionService.updateDirection(req.params.id, req.body);
  res.json({ success: true, message: "Yo'nalish yangilandi", data });
});

const archiveDirection = asyncHandler(async (req, res) => {
  const data = await directionService.setDirectionArchived(
    req.params.id,
    req.body?.isArchived !== false,
  );
  res.json({ success: true, message: data.message, data });
});

module.exports = {
  getDirections,
  createDirection,
  updateDirection,
  archiveDirection,
  getTariffs,
  getTariff,
  createTariff,
  updateTariff,
  archiveTariff,
  deleteTariff,
  getTimeline,
  getVersions,
  addVersion,
  updateVersion,
  deleteVersion,
  resolveForStudent,
  resolveMonthSheet,
};
