const TestSeason = require("../models/testSeason.model");
const Test = require("../models/test.model");
const TeacherAssignment = require("../models/teacherAssignment.model");
const Class = require("../models/class.model");
const User = require("../models/user.model");
const Message = require("../models/message.model");
const messageQueueService = require("./messageQueue.service");
const seasonRewardService = require("./seasonReward.service");
const { config } = require("../config/env.config");
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
  const { name, description, startDate, endDate } = data;

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

  // status sanalardan avtomatik hisoblanadi (pre-save hook)
  const season = await TestSeason.create({
    name,
    description,
    startDate: start,
    endDate: end,
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

  // status sanalardan avtomatik hisoblanadi (pre-save hook), qo'lda o'zgartirilmaydi
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
    // Testlari bor mavsumni o'chirib bo'lmaydi - faqat nofaol qilamiz
    // (status sanalardan avtomatik hisoblanadi)
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

/**
 * Mavsumni to'liq yakunlaydi: mukofot tangalarini tarqatadi va har bir o'quvchiga
 * bot orqali batafsil natija (maktab + sinf bo'yicha o'rin/o'rtacha + yutilgan
 * tanga) yuboradi. Xabar ostida student panelga ochiladigan WebApp tugmasi bo'ladi.
 * @param {string} seasonId
 * @param {string} userId - yakunlovchi (owner) ID
 * @returns {Promise<object>} { finalizedAt, distributed, notified }
 */
async function finalizeSeason(seasonId, userId) {
  const season = await TestSeason.findById(seasonId);
  if (!season) throw new NotFoundError("Mavsum topilmadi");
  if (season.finalizedAt) {
    throw new BadRequestError("Mavsum allaqachon to'liq yakunlangan");
  }

  // 1) Mukofot tangalarini tarqatish (idempotent - takror bermaydi)
  const distRes = await seasonRewardService.distributeCoins(seasonId, userId, {
    force: true,
  });

  // 2) Har o'quvchining yutgan tangasi (preview dan)
  const preview = await seasonRewardService.previewDistribution(seasonId);
  const coinByStudent = new Map(
    preview.students.map((s) => [s.student._id.toString(), s.totalAmount]),
  );

  // 3) Maktab va sinf reytinglari
  const schoolRows = await seasonRewardService.getSeasonStats(seasonId);
  const classRankByStudent = new Map();
  const classIds = new Set();
  for (const r of schoolRows) {
    const firstClass = (r.student.classes || [])[0];
    if (firstClass) classIds.add(firstClass._id.toString());
  }
  for (const cid of classIds) {
    const classRows = await seasonRewardService.getClassStats(seasonId, cid);
    for (const r of classRows) {
      const sid = r.student._id.toString();
      if (!classRankByStudent.has(sid)) {
        const cls = (r.student.classes || []).find(
          (c) => c._id.toString() === cid,
        );
        classRankByStudent.set(sid, {
          classRank: r.classRank,
          className: cls ? cls.name : null,
        });
      }
    }
  }

  // 4) Telegramga ulangan o'quvchilar
  const studentIds = schoolRows.map((r) => r.student._id);
  const users = await User.find({
    _id: { $in: studentIds },
    telegramIds: { $exists: true, $ne: [] },
  }).select("_id telegramIds");
  const tgByStudent = new Map(
    users.map((u) => [u._id.toString(), u.telegramIds]),
  );

  const webappUrl = `${config.studentWebappUrl.replace(/\/$/, "")}/seasons/${seasonId}/rewards`;
  const replyMarkup = {
    inline_keyboard: [
      [{ text: "📊 Batafsil statistika", web_app: { url: webappUrl } }],
    ],
  };

  // 5) Har o'quvchi uchun xabar matni va navbat elementlari
  const recipientIds = [];
  const deliveryStatus = [];
  const perStudentText = new Map();
  for (const r of schoolRows) {
    const sid = r.student._id.toString();
    const tgIds = tgByStudent.get(sid);
    if (!tgIds || tgIds.length === 0) continue;

    const classInfo = classRankByStudent.get(sid);
    const coins = coinByStudent.get(sid) || 0;

    let text = `🏁 <b>${escapeHtml(season.name)}</b> yakunlandi!\n\n`;
    text += `🏫 Maktab bo'yicha: <b>${r.rank}-o'rin</b> (o'rtacha ${r.averageScore.toFixed(2)} ball)\n`;
    if (classInfo) {
      text += `👥 Sinf bo'yicha${classInfo.className ? ` (${escapeHtml(classInfo.className)})` : ""}: <b>${classInfo.classRank}-o'rin</b>\n`;
    }
    text += `✅ Topshirilgan: ${r.resultCount}/${r.assignedCount} test`;
    if (coins > 0) {
      text += `\n\n🎁 Tabriklaymiz! Siz <b>${coins}</b> tanga yutdingiz!`;
    }

    perStudentText.set(sid, text);
    for (const tgId of tgIds) {
      recipientIds.push(tgId);
      deliveryStatus.push({
        telegramId: tgId,
        userId: r.student._id,
        status: "pending",
      });
    }
  }

  if (recipientIds.length > 0) {
    const message = await Message.create({
      messageText: `${season.name} — yakuniy natijalar`,
      sentBy: userId,
      recipientType: "season",
      season: seasonId,
      recipientIds,
      totalRecipients: recipientIds.length,
      deliveryStatus,
    });

    const queueItems = [];
    for (const r of schoolRows) {
      const sid = r.student._id.toString();
      const tgIds = tgByStudent.get(sid);
      const text = perStudentText.get(sid);
      if (!tgIds || !text) continue;
      for (const tgId of tgIds) {
        queueItems.push({
          messageId: message._id,
          telegramId: tgId,
          userId: r.student._id,
          messageText: text,
          replyMarkup,
        });
      }
    }
    await messageQueueService.addBulkToQueue(queueItems);
  }

  // 6) Mavsumni yakunlangan deb belgilash (distributedAt ni saqlab qolish uchun
  //    yangidan yuklaymiz)
  const fresh = await TestSeason.findById(seasonId);
  fresh.finalizedAt = new Date();
  fresh.finalizedBy = userId;
  await fresh.save();

  return {
    finalizedAt: fresh.finalizedAt,
    distributed: distRes.distributed,
    notified: deliveryStatus.length,
  };
}

module.exports = {
  listSeasons,
  getActiveSeasons,
  getSeasonById,
  createSeason,
  updateSeason,
  deleteSeason,
  findOverlappingSeasons,
  getSeasonClasses,
  announceSeason,
  finalizeSeason,
};
