/**
 * SINF RAHBARI — xodimga sinf biriktirish (admin) va xodimning o'z sinflari.
 *
 * Qoida va darvozalar servisda (`classLeader.service.js`): controller faqat
 * so'rovni ochadi va javobni qaytaradi.
 */

const asyncHandler = require("../middleware/async.middleware");
const classLeaderService = require("../services/classLeader.service");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");
const { ROLES } = require("../utils/constants");
const { ForbiddenError } = require("../utils/errors");

/** Registr — "kim qaysi sinfga rahbar" (sahifalanadi). */
const getLeaders = asyncHandler(async (req, res) => {
  const pagination = getPaginationParams(req);
  const { total, items } = await classLeaderService.getLeaders(pagination, {
    search: req.query.search,
    classId: req.query.classId,
    leaderId: req.query.leaderId,
  });

  res.json(formatPaginationResponse(items, total, pagination.page, pagination.limit));
});

/** Xodimning sinflari — admin paneldagi xodim kartasi. */
const getStaffClasses = asyncHandler(async (req, res) => {
  const data = await classLeaderService.getStaffClasses(req.params.staffId);
  res.json({ success: true, data });
});

/** Biriktirish oynasi: sinflar, o'quvchilar soni va kim band qilgani. */
const getClassOptions = asyncHandler(async (req, res) => {
  const data = await classLeaderService.getClassOptions({ leaderId: req.query.leaderId });
  res.json({ success: true, data });
});

/**
 * O'ZIMNING sinflarim — xodim/o'qituvchi paneli. Ruxsat kaliti yo'q, id
 * tokendan (`/tutor-groups/my` bilan AYNI mulohaza).
 */
const getMyClasses = asyncHandler(async (req, res) => {
  if (req.user.role === ROLES.STUDENT) {
    throw new ForbiddenError("Sinf rahbarligi faqat xodimlar uchun");
  }
  // ⚠️ TO'LIQ `req.user`, id EMAS: egalik rol belgisini ham tekshiradi
  const data = await classLeaderService.getMyClasses(req.user);
  res.json({ success: true, data });
});

/** Biriktirish — bir yoki bir nechta sinf (hammasi yoki hech narsa). */
const assignClasses = asyncHandler(async (req, res) => {
  const data = await classLeaderService.assignClasses(req.body, req.user.id);
  res.status(201).json({ success: true, data: data.items, message: data.message });
});

/** Izohni tahrirlash (sinf va rahbar o'zgarmaydi). */
const updateClass = asyncHandler(async (req, res) => {
  const data = await classLeaderService.updateClass(req.params.id, req.body, req.user.id);
  res.json({ success: true, data, message: "Izoh saqlandi" });
});

/** Biriktirishni olib tashlash. */
const removeClass = asyncHandler(async (req, res) => {
  const data = await classLeaderService.removeClass(req.params.id, req.user.id);
  res.json({ success: true, data, message: data.message });
});

module.exports = {
  getLeaders,
  getStaffClasses,
  getClassOptions,
  getMyClasses,
  assignClasses,
  updateClass,
  removeClass,
};
