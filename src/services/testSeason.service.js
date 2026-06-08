const TestSeason = require("../models/testSeason.model");
const Test = require("../models/test.model");
const TeacherAssignment = require("../models/teacherAssignment.model");
const Class = require("../models/class.model");
const User = require("../models/user.model");
const Message = require("../models/message.model");
const messageQueueService = require("./messageQueue.service");
const { ROLES } = require("../utils/constants");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");

/** HTML parse mode uchun maxsus belgilarni ekranlash. */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Sanani DD.MM.YYYY ko'rinishida formatlaydi. */
function formatDate(date) {
  if (!date) return "";
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${d.getFullYear()}`;
}

/**
 * Berilgan sana oralig'i bilan ustma-ust keladigan mavsumlarni topadi.
 * @param {Date} startDate - boshlanish sanasi
 * @param {Date} endDate - tugash sanasi
 * @param {string} [excludeId] - tekshiruvdan chiqariladigan mavsum ID
 * @returns {Promise<Array>} ustma-ust keladigan mavsumlar
 */
async function findOverlappingSeasons(startDate, endDate, excludeId) {
  const query = {
    startDate: { $lte: endDate },
    endDate: { $gte: startDate },
  };
  if (excludeId) query._id = { $ne: excludeId };

  return TestSeason.find(query).select("name startDate endDate status");
}

/**
 * Mavsumlar ro'yxatini sahifalash bilan oladi.
 * @param {object} req - Express request object
 * @returns {Promise<object>} sahifalangan javob
 */
async function listSeasons(req) {
  const { page, limit, skip } = getPaginationParams(req);
  const { status } = req.query;

  const filter = {};
  if (status && status !== "all") filter.status = status;

  const [seasons, total] = await Promise.all([
    TestSeason.find(filter)
      .populate("createdBy", "firstName lastName")
      .sort({ startDate: -1 })
      .skip(skip)
      .limit(limit),
    TestSeason.countDocuments(filter),
  ]);

  return formatPaginationResponse(seasons, total, page, limit);
}

/**
 * Faol mavsumlarni oladi (o'qituvchi va o'quvchi UI uchun).
 * @returns {Promise<Array>} faol mavsumlar
 */
async function getActiveSeasons() {
  return TestSeason.find({ status: "active", isActive: true }).sort({
    startDate: -1,
  });
}

/**
 * Mavsumni ID bo'yicha oladi.
 * @param {string} id - mavsum ID
 * @returns {Promise<object>} mavsum
 */
async function getSeasonById(id) {
  const season = await TestSeason.findById(id).populate(
    "createdBy",
    "firstName lastName",
  );
  if (!season) {
    throw new NotFoundError("Mavsum topilmadi");
  }
  return season;
}

/**
 * Yangi mavsum yaratadi.
 * @param {object} data - mavsum ma'lumotlari
 * @param {string} createdBy - yaratuvchi foydalanuvchi ID
 * @returns {Promise<object>} yaratilgan mavsum va ustma-ust mavsumlar
 */
async function createSeason(data, createdBy) {
  const { name, description, startDate, endDate, status } = data;

  if (!name || !startDate || !endDate) {
    throw new BadRequestError("Nom, boshlanish va tugash sanasi majburiy");
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  if (end <= start) {
    throw new BadRequestError(
      "Tugash sanasi boshlanish sanasidan keyin bo'lishi kerak",
    );
  }

  const season = await TestSeason.create({
    name,
    description,
    startDate: start,
    endDate: end,
    status: status || "draft",
    createdBy,
  });

  const overlapping = await findOverlappingSeasons(start, end, season._id);

  return { season, overlapping };
}

/**
 * Mavsumni yangilaydi.
 * @param {string} id - mavsum ID
 * @param {object} data - yangilash ma'lumotlari
 * @returns {Promise<object>} yangilangan mavsum va ustma-ust mavsumlar
 */
async function updateSeason(id, data) {
  const season = await TestSeason.findById(id);
  if (!season) {
    throw new NotFoundError("Mavsum topilmadi");
  }

  const { name, description, startDate, endDate, isActive } = data;

  if (name !== undefined) season.name = name;
  if (description !== undefined) season.description = description;
  if (startDate !== undefined) season.startDate = new Date(startDate);
  if (endDate !== undefined) season.endDate = new Date(endDate);
  if (isActive !== undefined) season.isActive = isActive;

  if (season.endDate <= season.startDate) {
    throw new BadRequestError(
      "Tugash sanasi boshlanish sanasidan keyin bo'lishi kerak",
    );
  }

  await season.save();

  const overlapping = await findOverlappingSeasons(
    season.startDate,
    season.endDate,
    season._id,
  );

  return { season, overlapping };
}

/**
 * Mavsum holatini o'zgartiradi.
 * @param {string} id - mavsum ID
 * @param {string} status - yangi holat (draft, active, closed)
 * @returns {Promise<object>} yangilangan mavsum
 */
async function setSeasonStatus(id, status) {
  if (!["draft", "active", "closed"].includes(status)) {
    throw new BadRequestError("Noto'g'ri mavsum holati");
  }

  const season = await TestSeason.findById(id);
  if (!season) {
    throw new NotFoundError("Mavsum topilmadi");
  }

  season.status = status;
  await season.save();

  return season;
}

/**
 * Mavsumni o'chiradi. Agar testlar mavjud bo'lsa, o'chirish o'rniga yopadi.
 * @param {string} id - mavsum ID
 * @returns {Promise<object>} natija ({ deleted: boolean })
 */
async function deleteSeason(id) {
  const season = await TestSeason.findById(id);
  if (!season) {
    throw new NotFoundError("Mavsum topilmadi");
  }

  const testCount = await Test.countDocuments({ season: id });
  if (testCount > 0) {
    season.status = "closed";
    season.isActive = false;
    await season.save();
    return { deleted: false, season };
  }

  await TestSeason.findByIdAndDelete(id);
  return { deleted: true };
}

/**
 * Mavsumga biriktirilgan (TeacherAssignment) sinflar ro'yxatini va har sinfdagi
 * Telegramga ulangan o'quvchilar sonini qaytaradi. E'lon modalida ko'rsatish uchun.
 * @param {string} seasonId - mavsum ID
 * @returns {Promise<Array<{_id, name, studentCount}>>}
 */
async function getSeasonClasses(seasonId) {
  const season = await TestSeason.findById(seasonId);
  if (!season) throw new NotFoundError("Mavsum topilmadi");

  const classIds = await TeacherAssignment.find({
    season: seasonId,
    isActive: true,
  }).distinct("class");

  if (classIds.length === 0) return [];

  const [classes, counts] = await Promise.all([
    Class.find({ _id: { $in: classIds } }).select("name"),
    User.aggregate([
      {
        $match: {
          role: ROLES.STUDENT,
          isActive: { $ne: false },
          classes: { $in: classIds },
          telegramIds: { $exists: true, $ne: [] },
        },
      },
      { $unwind: "$classes" },
      { $match: { classes: { $in: classIds } } },
      { $group: { _id: "$classes", count: { $sum: 1 } } },
    ]),
  ]);

  const countMap = new Map(counts.map((c) => [String(c._id), c.count]));

  return classes.map((c) => ({
    _id: c._id,
    name: c.name,
    studentCount: countMap.get(String(c._id)) || 0,
  }));
}

/**
 * Mavsum e'lonini bot orqali biriktirilgan sinflar o'quvchilariga yuboradi.
 * Avtomatik mavsum ma'lumoti + ixtiyoriy izoh. Istalgan sinflarni istisno qilish mumkin.
 * @param {string} seasonId - mavsum ID
 * @param {object} data - { note?, excludedClassIds? }
 * @param {string} sentBy - yuboruvchi foydalanuvchi ID
 * @returns {Promise<object>} { messageId, totalRecipients, studentCount, classCount }
 */
async function announceSeason(seasonId, data, sentBy) {
  const { note, excludedClassIds = [] } = data || {};

  const season = await TestSeason.findById(seasonId);
  if (!season) throw new NotFoundError("Mavsum topilmadi");

  // Biriktirilgan sinflar
  const allClassIds = await TeacherAssignment.find({
    season: seasonId,
    isActive: true,
  }).distinct("class");

  const excluded = new Set((excludedClassIds || []).map(String));
  const targetClassIds = allClassIds.filter((c) => !excluded.has(String(c)));

  if (targetClassIds.length === 0) {
    throw new BadRequestError("Yuboriladigan sinf yo'q (barchasi istisno qilingan yoki biriktiruv yo'q)");
  }

  // Telegramga ulangan o'quvchilar
  const students = await User.find({
    role: ROLES.STUDENT,
    isActive: { $ne: false },
    classes: { $in: targetClassIds },
    telegramIds: { $exists: true, $ne: [] },
  }).select("_id telegramIds");

  // E'lon matnini tuzish: avtomatik mavsum ma'lumoti + ixtiyoriy izoh
  let text = `📢 <b>${escapeHtml(season.name)}</b>\n`;
  text += `🗓 ${formatDate(season.startDate)} – ${formatDate(season.endDate)}\n\n`;
  text += "Yangi test mavsumi e'lon qilindi. Sizga biriktirilgan testlarni o'z vaqtida topshiring.";
  if (note && note.trim()) {
    text += `\n\n${escapeHtml(note.trim())}`;
  }

  // Qabul qiluvchilar (telegram ID lari) va yetkazish holati
  const recipientIds = [];
  const deliveryStatus = [];
  students.forEach((s) => {
    s.telegramIds.forEach((telegramId) => {
      recipientIds.push(telegramId);
      deliveryStatus.push({ telegramId, userId: s._id, status: "pending" });
    });
  });

  if (recipientIds.length === 0) {
    throw new BadRequestError("Telegramga ulangan o'quvchi topilmadi");
  }

  const message = await Message.create({
    messageText: text,
    sentBy,
    recipientType: "season",
    season: seasonId,
    recipientIds,
    totalRecipients: recipientIds.length,
    deliveryStatus,
  });

  await messageQueueService.addBulkToQueue(
    deliveryStatus.map((d) => ({
      messageId: message._id,
      telegramId: d.telegramId,
      userId: d.userId,
      messageText: text,
    })),
  );

  return {
    messageId: message._id,
    totalRecipients: recipientIds.length,
    studentCount: students.length,
    classCount: targetClassIds.length,
  };
}

module.exports = {
  listSeasons,
  getActiveSeasons,
  getSeasonById,
  createSeason,
  updateSeason,
  setSeasonStatus,
  deleteSeason,
  findOverlappingSeasons,
  getSeasonClasses,
  announceSeason,
};
