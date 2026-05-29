const TestSeason = require("../models/testSeason.model");
const Test = require("../models/test.model");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");

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

module.exports = {
  listSeasons,
  getActiveSeasons,
  getSeasonById,
  createSeason,
  updateSeason,
  setSeasonStatus,
  deleteSeason,
  findOverlappingSeasons,
};
