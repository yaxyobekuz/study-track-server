const prisma = require("../config/prisma");
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
 * createdBy (soft ref — FK emas) uchun yaratuvchilarni qo'lda yuklab xaritalaydi.
 * @param {Array} seasons - createdBy maydoni bor mavsumlar
 * @returns {Promise<Array>} createdBy obyektga almashtirilgan mavsumlar
 */
async function attachCreators(seasons) {
  const creatorIds = [
    ...new Set(seasons.map((s) => s.createdBy).filter(Boolean)),
  ];
  if (creatorIds.length === 0) {
    return seasons.map((s) => ({ ...s, createdBy: null }));
  }
  const creators = await prisma.user.findMany({
    where: { id: { in: creatorIds } },
    select: { id: true, firstName: true, lastName: true },
  });
  const creatorMap = new Map(creators.map((c) => [c.id, c]));
  return seasons.map((s) => ({
    ...s,
    createdBy: creatorMap.get(s.createdBy) || null,
  }));
}

/**
 * Berilgan sana oralig'i bilan ustma-ust keladigan mavsumlarni topadi.
 * @param {Date} startDate - boshlanish sanasi
 * @param {Date} endDate - tugash sanasi
 * @param {string} [excludeId] - tekshiruvdan chiqariladigan mavsum ID
 * @returns {Promise<Array>} ustma-ust keladigan mavsumlar
 */
async function findOverlappingSeasons(startDate, endDate, excludeId) {
  const where = {
    startDate: { lte: endDate },
    endDate: { gte: startDate },
  };
  if (excludeId) where.id = { not: excludeId };

  return prisma.testSeason.findMany({
    where,
    select: { id: true, name: true, startDate: true, endDate: true, status: true },
  });
}

/**
 * Mavsumlar ro'yxatini sahifalash bilan oladi.
 * @param {object} req - Express request object
 * @returns {Promise<object>} sahifalangan javob
 */
async function listSeasons(req) {
  const { page, limit, skip } = getPaginationParams(req);
  const { status } = req.query;

  const where = {};
  if (status && status !== "all") where.status = status;

  const [seasons, total] = await Promise.all([
    prisma.testSeason.findMany({
      where,
      orderBy: { startDate: "desc" },
      skip,
      take: limit,
    }),
    prisma.testSeason.count({ where }),
  ]);

  const seasonsWithCreators = await attachCreators(seasons);

  return formatPaginationResponse(seasonsWithCreators, total, page, limit);
}

/**
 * Faol mavsumlarni oladi (o'qituvchi va o'quvchi UI uchun).
 * @returns {Promise<Array>} faol mavsumlar
 */
async function getActiveSeasons() {
  return prisma.testSeason.findMany({
    where: { status: "active", isActive: true },
    orderBy: { startDate: "desc" },
  });
}

/**
 * Mavsumni ID bo'yicha oladi.
 * @param {string} id - mavsum ID
 * @returns {Promise<object>} mavsum
 */
async function getSeasonById(id) {
  const season = await prisma.testSeason.findUnique({ where: { id } });
  if (!season) {
    throw new NotFoundError("Mavsum topilmadi");
  }
  const [withCreator] = await attachCreators([season]);
  return withCreator;
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

  // status sanalardan avtomatik hisoblanadi (computeSeasonStatus helper)
  const { computeSeasonStatus } = require("../helpers/seasonStatus.helper");
  const season = await prisma.testSeason.create({
    data: {
      name,
      description,
      startDate: start,
      endDate: end,
      status: computeSeasonStatus(start, end),
      createdBy,
    },
  });

  const overlapping = await findOverlappingSeasons(start, end, season.id);

  return { season, overlapping };
}

/**
 * Mavsumni yangilaydi.
 * @param {string} id - mavsum ID
 * @param {object} data - yangilash ma'lumotlari
 * @returns {Promise<object>} yangilangan mavsum va ustma-ust mavsumlar
 */
async function updateSeason(id, data) {
  const season = await prisma.testSeason.findUnique({ where: { id } });
  if (!season) {
    throw new NotFoundError("Mavsum topilmadi");
  }

  // status sanalardan avtomatik hisoblanadi (computeSeasonStatus), qo'lda o'zgartirilmaydi
  const { name, description, startDate, endDate, isActive } = data;

  const update = {};
  if (name !== undefined) update.name = name;
  if (description !== undefined) update.description = description;
  if (startDate !== undefined) update.startDate = new Date(startDate);
  if (endDate !== undefined) update.endDate = new Date(endDate);
  if (isActive !== undefined) update.isActive = isActive;

  const nextStart =
    update.startDate !== undefined ? update.startDate : season.startDate;
  const nextEnd = update.endDate !== undefined ? update.endDate : season.endDate;

  if (nextEnd <= nextStart) {
    throw new BadRequestError(
      "Tugash sanasi boshlanish sanasidan keyin bo'lishi kerak",
    );
  }

  const { computeSeasonStatus } = require("../helpers/seasonStatus.helper");
  update.status = computeSeasonStatus(nextStart, nextEnd);

  const updated = await prisma.testSeason.update({
    where: { id },
    data: update,
  });

  const overlapping = await findOverlappingSeasons(
    updated.startDate,
    updated.endDate,
    updated.id,
  );

  return { season: updated, overlapping };
}

/**
 * Mavsumni o'chiradi. Agar testlar mavjud bo'lsa, o'chirish o'rniga yopadi.
 * @param {string} id - mavsum ID
 * @returns {Promise<object>} natija ({ deleted: boolean })
 */
async function deleteSeason(id) {
  const season = await prisma.testSeason.findUnique({ where: { id } });
  if (!season) {
    throw new NotFoundError("Mavsum topilmadi");
  }

  // Testlar TestBinding orqali mavsumga bog'lanadi (season → binding)
  const testCount = await prisma.testBinding.count({ where: { seasonId: id } });
  if (testCount > 0) {
    // Testlari bor mavsumni o'chirib bo'lmaydi - faqat nofaol qilamiz
    // (status sanalardan avtomatik hisoblanadi)
    const updated = await prisma.testSeason.update({
      where: { id },
      data: { isActive: false },
    });
    return { deleted: false, season: updated };
  }

  await prisma.testSeason.delete({ where: { id } });
  return { deleted: true };
}

/**
 * Mavsumga biriktirilgan (TeacherAssignment) sinflar ro'yxatini va har sinfdagi
 * Telegramga ulangan o'quvchilar sonini qaytaradi. E'lon modalida ko'rsatish uchun.
 * @param {string} seasonId - mavsum ID
 * @returns {Promise<Array<{_id, name, studentCount}>>}
 */
async function getSeasonClasses(seasonId) {
  const season = await prisma.testSeason.findUnique({ where: { id: seasonId } });
  if (!season) throw new NotFoundError("Mavsum topilmadi");

  const assignments = await prisma.teacherAssignment.findMany({
    where: { seasonId, isActive: true },
    distinct: ["classId"],
    select: { classId: true },
  });
  const classIds = assignments.map((a) => a.classId);

  if (classIds.length === 0) return [];

  const classes = await prisma.class.findMany({
    where: { id: { in: classIds } },
    select: { id: true, name: true },
  });

  // Telegramga ulangan, faol o'quvchilarni biriktirilgan sinflar bo'yicha sanash.
  // classes M2M (UserClass) — junctiondan foydalanamiz.
  const members = await prisma.userClass.findMany({
    where: {
      classId: { in: classIds },
      user: {
        role: ROLES.STUDENT,
        isActive: { not: false },
        NOT: { telegramIds: { isEmpty: true } },
      },
    },
    select: { classId: true, userId: true },
  });

  const countMap = new Map();
  for (const m of members) {
    countMap.set(m.classId, (countMap.get(m.classId) || 0) + 1);
  }

  return classes.map((c) => ({
    _id: c.id,
    name: c.name,
    studentCount: countMap.get(c.id) || 0,
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

  const season = await prisma.testSeason.findUnique({ where: { id: seasonId } });
  if (!season) throw new NotFoundError("Mavsum topilmadi");

  // Biriktirilgan sinflar
  const assignments = await prisma.teacherAssignment.findMany({
    where: { seasonId, isActive: true },
    distinct: ["classId"],
    select: { classId: true },
  });
  const allClassIds = assignments.map((a) => a.classId);

  const excluded = new Set((excludedClassIds || []).map(String));
  const targetClassIds = allClassIds.filter((c) => !excluded.has(String(c)));

  if (targetClassIds.length === 0) {
    throw new BadRequestError("Yuboriladigan sinf yo'q (barchasi istisno qilingan yoki biriktiruv yo'q)");
  }

  // Telegramga ulangan o'quvchilar (classes M2M junction orqali)
  const memberships = await prisma.userClass.findMany({
    where: {
      classId: { in: targetClassIds },
      user: {
        role: ROLES.STUDENT,
        isActive: { not: false },
        NOT: { telegramIds: { isEmpty: true } },
      },
    },
    select: {
      user: { select: { id: true, telegramIds: true } },
    },
  });
  // O'quvchi bir nechta target sinfda bo'lsa ham bir marta olinsin
  const studentMap = new Map();
  for (const m of memberships) {
    if (m.user) studentMap.set(m.user.id, m.user);
  }
  const students = [...studentMap.values()];

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
      deliveryStatus.push({ telegramId, userId: s.id, status: "pending" });
    });
  });

  if (recipientIds.length === 0) {
    throw new BadRequestError("Telegramga ulangan o'quvchi topilmadi");
  }

  const message = await prisma.message.create({
    data: {
      messageText: text,
      sentBy,
      recipientType: "season",
      season: seasonId,
      recipientIds,
      totalRecipients: recipientIds.length,
      deliveryStatus: {
        create: deliveryStatus.map((d, position) => ({
          telegramId: d.telegramId,
          userId: d.userId,
          status: d.status,
          position,
        })),
      },
    },
  });

  await messageQueueService.addBulkToQueue(
    deliveryStatus.map((d) => ({
      messageId: message.id,
      telegramId: d.telegramId,
      userId: d.userId,
      messageText: text,
    })),
  );

  return {
    messageId: message.id,
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
  const season = await prisma.testSeason.findUnique({ where: { id: seasonId } });
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
  const users = await prisma.user.findMany({
    where: {
      id: { in: studentIds },
      NOT: { telegramIds: { isEmpty: true } },
    },
    select: { id: true, telegramIds: true },
  });
  const tgByStudent = new Map(users.map((u) => [u.id.toString(), u.telegramIds]));

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
    const message = await prisma.message.create({
      data: {
        messageText: `${season.name} - yakuniy natijalar`,
        sentBy: userId,
        recipientType: "season",
        season: seasonId,
        recipientIds,
        totalRecipients: recipientIds.length,
        deliveryStatus: {
          create: deliveryStatus.map((d, position) => ({
            telegramId: d.telegramId,
            userId: d.userId,
            status: d.status,
            position,
          })),
        },
      },
    });

    const queueItems = [];
    for (const r of schoolRows) {
      const sid = r.student._id.toString();
      const tgIds = tgByStudent.get(sid);
      const text = perStudentText.get(sid);
      if (!tgIds || !text) continue;
      for (const tgId of tgIds) {
        queueItems.push({
          messageId: message.id,
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
  const fresh = await prisma.testSeason.update({
    where: { id: seasonId },
    data: { finalizedAt: new Date(), finalizedBy: userId },
  });

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
