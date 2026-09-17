/**
 * XABARLAR (Telegram tarqatma) — yuborish, ro'yxat, bitta xabar, bekor qilish.
 *
 * Bu mantiq ilgari to'liq `message.controller.js` ichida edi. U servisga
 * AYNAN O'ZGARISHSIZ ko'chirildi: controller endi faqat HTTP qatlami
 * (fayl, status kodi, javob matni), AI yordamchi esa xuddi shu yo'l bilan
 * yuboradi. Ikkita mustaqil nusxa bo'lsa, qabul qiluvchilar qoidasi bir
 * tomonda o'zgarib, ikkinchisida eskirib qolardi.
 *
 * ⚠️ QABUL QILUVCHI SEMANTIKASI O'ZGARMAGAN. O'quvchining `telegramIds` —
 * uni botda bog'lagan ota-onalar. Tarqatma `TgUser.notificationsEnabled`
 * ni HISOBGA OLMAYDI (bildirishnomani o'chirgan ota-ona ham oladi) va
 * `isActive` bo'yicha filtrlamaydi. Bu mavjud xatti-harakat; uni bu refaktor
 * ichida "tuzatish" yuborilgan xabarlar sonini jimgina o'zgartirgan bo'lardi.
 *
 * ⚠️ ARXIVLANGANLAR esa "hammaga" tarqatmaga KIRMAYDI (biznes qarori,
 * 2026-09-17): arxivlangan o'quvchi maktabdan ketgan va joriy ro'yxatlarning
 * hech birida ko'rinmaydi — maktab e'lonlari uning ota-onasiga borishi
 * shu qoidaga zid edi. Sinf tarqatmasi ularga o'zi yetmaydi (arxivlash
 * sinfdan chiqaradi).
 *
 * ⚠️ NAVBAT JORIY FILIAL KONTEKSTIDA ishga tushadi
 * (`messageQueue.addBulkToQueue` → `startProcessing` → `getBranch()`).
 * Shuning uchun `sendMessage` faqat filial konteksti yoqilgan joydan
 * (so'rov ichida) chaqiriladi.
 */

const prisma = require("../config/prisma");
const messageQueueService = require("./messageQueue.service");
const fileStorage = require("./fileStorage.service");
const { ROLES } = require("../utils/constants");
const { hasRole } = require("../utils/permissions");
const { BadRequestError, NotFoundError, ForbiddenError } = require("../utils/errors");

/** HTTP orqali tanlanadigan qabul qiluvchi turlari (`season` — faqat test mavsumi e'lonlari). */
const RECIPIENT_TYPES = ["all", "class", "student"];

/** Tasodifiy ikki marta bosishdan himoya oynasi. */
const DUPLICATE_WINDOW_MS = 5000;

const IMAGE_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/gif"];

/**
 * sentBy / classId / studentId — soft ref (relation YO'Q), qo'lda yuklab biriktiradi.
 * Populate ekvivalenti: sentBy(firstName lastName username role), classId(name), studentId(firstName lastName username).
 */
async function attachMessageRefs(messages) {
  const arr = Array.isArray(messages) ? messages : [messages];

  const sentByIds = [...new Set(arr.map((m) => m.sentBy).filter(Boolean))];
  const classIds = [...new Set(arr.map((m) => m.classId).filter(Boolean))];
  const studentIds = [...new Set(arr.map((m) => m.studentId).filter(Boolean))];

  const [senders, classes, students] = await Promise.all([
    sentByIds.length
      ? prisma.user.findMany({
          where: { id: { in: sentByIds } },
          select: { id: true, firstName: true, lastName: true, username: true, role: true },
        })
      : [],
    classIds.length
      ? prisma.class.findMany({
          where: { id: { in: classIds } },
          select: { id: true, name: true },
        })
      : [],
    studentIds.length
      ? prisma.user.findMany({
          where: { id: { in: studentIds } },
          select: { id: true, firstName: true, lastName: true, username: true },
        })
      : [],
  ]);

  const senderMap = new Map(senders.map((s) => [s.id, s]));
  const classMap = new Map(classes.map((c) => [c.id, c]));
  const studentMap = new Map(students.map((s) => [s.id, s]));

  const mapped = arr.map((m) => ({
    ...m,
    sentBy: m.sentBy ? senderMap.get(m.sentBy) || null : null,
    classId: m.classId ? classMap.get(m.classId) || null : null,
    studentId: m.studentId ? studentMap.get(m.studentId) || null : null,
  }));

  return Array.isArray(messages) ? mapped : mapped[0];
}

/** Yetkazish holatlari bo'yicha sanoq (ro'yxat va bitta xabar uchun bir xil). */
function deliveryStats(deliveryStatus) {
  return {
    totalSent: deliveryStatus.filter((d) => d.status === "sent").length,
    totalFailed: deliveryStatus.filter((d) => d.status === "failed").length,
    totalPending: deliveryStatus.filter((d) => d.status === "pending").length,
  };
}

/**
 * Yuboruvchi shu turdagi tarqatmani yubora oladimi.
 *
 * ⚠️ `isOwner` QAT'IY `role === "owner"`, `isTeacher` esa `hasRole` —
 * ko'p rollilik darvozasi qo'shimcha rolni ham o'tkazadi, cheklov ham
 * AYNAN SHU savolga javob berishi kerak (`grade.controller.js` dagi izoh).
 * Natija: qo'shimcha roli `teacher` bo'lgan owner ham "barchaga" yubora
 * olmaydi.
 *
 * @param {object} actor - `req.user`
 * @param {string} recipientType
 * @throws {ForbiddenError}
 */
function assertCanSend(actor, recipientType) {
  const isOwner = actor.role === "owner";
  const isTeacher = hasRole(actor, ROLES.TEACHER);

  if (!isOwner && !isTeacher) {
    throw new ForbiddenError("Ruxsat berilmagan");
  }

  // Owner can send to all, class, or student
  // Teacher can only send to class or student
  if (isTeacher && recipientType === "all") {
    throw new ForbiddenError("O'qituvchi barchaga xabar yubora olmaydi");
  }
}

/**
 * Qabul qiluvchilarni aniqlaydi (faqat o'qiydi).
 *
 * @param {{ recipientType: string, classId?: string, studentId?: string }} params
 * @returns {Promise<{
 *   recipients: Array<{ id: string, telegramIds: string[], firstName: string, lastName: string, role: string, isArchived: boolean }>,
 *   recipientIds: string[],
 *   classId: string|null,
 *   studentId: string|null,
 * }>}
 * @throws {BadRequestError|NotFoundError} tur, sinf/o'quvchi yoki Telegram ID yo'q bo'lsa
 */
async function resolveRecipients({ recipientType, classId, studentId }) {
  if (!RECIPIENT_TYPES.includes(recipientType)) {
    throw new BadRequestError("Noto'g'ri qabul qiluvchi turi");
  }

  const recipientSelect = {
    id: true,
    telegramIds: true,
    firstName: true,
    lastName: true,
    role: true,
    isArchived: true,
  };

  let recipients = [];
  let messageClassId = null;
  let messageStudentId = null;

  if (recipientType === "all") {
    // Get all users with telegram IDs
    recipients = await prisma.user.findMany({
      where: {
        telegramIds: { isEmpty: false },
        role: { in: ["teacher", "student"] },
        isArchived: false,
      },
      select: recipientSelect,
    });
  } else if (recipientType === "class") {
    if (!classId) {
      throw new BadRequestError("Sinf ID majburiy");
    }

    // Check if class exists
    const classDoc = await prisma.class.findUnique({ where: { id: classId } });
    if (!classDoc) {
      throw new NotFoundError("Sinf topilmadi");
    }

    // Get all students in the class
    recipients = await prisma.user.findMany({
      where: {
        classes: { some: { classId } },
        role: "student",
        telegramIds: { isEmpty: false },
      },
      select: recipientSelect,
    });

    messageClassId = classId;
  } else if (recipientType === "student") {
    if (!studentId) {
      throw new BadRequestError("O'quvchi ID majburiy");
    }

    // Check if student exists
    const student = await prisma.user.findUnique({
      where: { id: studentId },
      select: recipientSelect,
    });
    if (!student) {
      throw new NotFoundError("O'quvchi topilmadi");
    }

    if (!student.telegramIds || student.telegramIds.length === 0) {
      throw new BadRequestError("O'quvchining telegram ID si mavjud emas");
    }

    recipients = [student];
    messageStudentId = studentId;
  }

  const recipientIds = recipients.reduce((acc, user) => [...acc, ...user.telegramIds], []);

  if (recipientIds.length === 0) {
    throw new BadRequestError("Qabul qiluvchilar topilmadi yoki ularning telegram ID lari mavjud emas");
  }

  return { recipients, recipientIds, classId: messageClassId, studentId: messageStudentId };
}

/**
 * Tarqatma yuboradi: `Message` + yetkazish holatlari yoziladi, fayl (bo'lsa)
 * Spaces'ga yuklanadi va har bir Telegram ID navbatga qo'yiladi.
 *
 * @param {object} params
 * @param {object} params.actor - `req.user`
 * @param {string} params.messageText
 * @param {string} params.recipientType - "all" | "class" | "student"
 * @param {string} [params.classId]
 * @param {string} [params.studentId]
 * @param {object|null} [params.file] - multer fayli (`buffer`, `mimetype`, `originalname`)
 * @returns {Promise<object>} yaratilgan `Message` qatori
 */
async function sendMessage({ actor, messageText, recipientType, classId, studentId, file = null }) {
  // Validate message text
  if (!messageText || !messageText.trim()) {
    throw new BadRequestError("Xabar matni majburiy");
  }

  // Validate recipient type
  if (!RECIPIENT_TYPES.includes(recipientType)) {
    throw new BadRequestError("Noto'g'ri qabul qiluvchi turi");
  }

  assertCanSend(actor, recipientType);

  const text = messageText.trim();

  // Guard against accidental duplicate submits: reject an identical message
  // (same sender + same text) created within the last few seconds.
  const recentDuplicate = await prisma.message.findFirst({
    where: {
      sentBy: actor.id,
      messageText: text,
      recipientType,
      createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
    },
    select: { id: true },
  });

  if (recentDuplicate) {
    throw new BadRequestError("Bu xabar hozirgina yuborildi. Iltimos, biroz kuting.");
  }

  const resolved = await resolveRecipients({ recipientType, classId, studentId });
  const { recipients, recipientIds } = resolved;

  // Prepare delivery status (child jadval — position massiv indeksidan)
  const deliveryStatus = [];
  recipients.forEach((user) => {
    user.telegramIds.forEach((telegramId) => {
      deliveryStatus.push({
        telegramId,
        userId: user.id,
        status: "pending",
        position: deliveryStatus.length,
      });
    });
  });

  // Create message record
  const message = await prisma.message.create({
    data: {
      messageText: text,
      sentBy: actor.id,
      recipientType,
      recipientIds,
      classId: resolved.classId,
      studentId: resolved.studentId,
      totalRecipients: recipientIds.length,
      deliveryStatus: { create: deliveryStatus },
    },
  });

  // Upload file to DO Spaces and determine file type
  let fileUrl = null;
  let fileType = null;
  if (file) {
    fileType = IMAGE_MIME_TYPES.includes(file.mimetype) ? "photo" : "document";

    const key = `messages/${Date.now()}-${file.originalname}`;
    const uploaded = await fileStorage.uploadBuffer({ key, buffer: file.buffer, contentType: file.mimetype });
    fileUrl = uploaded.url;
  }

  // Add messages to queue
  const queueItems = recipientIds.map((telegramId) => {
    const queueItem = {
      messageId: message.id,
      telegramId,
      userId: recipients.find((r) => r.telegramIds.includes(telegramId))?.id,
      messageText: text,
    };

    // Only add file fields if file exists
    if (fileUrl) {
      queueItem.filePath = fileUrl;
      queueItem.fileType = fileType;
      queueItem.fileName = file.originalname;
      queueItem.fileContentType = file.mimetype;
    }

    return queueItem;
  });

  await messageQueueService.addBulkToQueue(queueItems);

  return message;
}

/**
 * Xabarlar ro'yxati (filtr va sahifalash bilan).
 *
 * @param {object} actor - `req.user`
 * @param {object} query - { page, limit, sentBy, classId, recipientType, startDate, endDate }
 * @returns {Promise<{ data: object[], pagination: object }>}
 */
async function getMessages(actor, query = {}) {
  const { page = 1, limit = 20, sentBy, classId, recipientType, startDate, endDate } = query;

  // Build query
  const where = {};

  // If teacher, only show their own messages
  if (hasRole(actor, ROLES.TEACHER)) {
    where.sentBy = actor.id;
  }

  // If owner, can filter by sentBy
  if (actor.role === "owner" && sentBy) {
    where.sentBy = sentBy;
  }

  if (classId) {
    where.classId = classId;
  }

  if (recipientType) {
    where.recipientType = recipientType;
  }

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) {
      where.createdAt.gte = new Date(startDate);
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      where.createdAt.lte = end;
    }
  }

  // Pagination
  const pageNum = parseInt(page, 10) || 1;
  const pageLimit = parseInt(limit, 10) || 20;
  const skip = (pageNum - 1) * pageLimit;

  const [rawMessages, total] = await Promise.all([
    prisma.message.findMany({
      where,
      include: { deliveryStatus: { orderBy: { position: "asc" } } },
      orderBy: { createdAt: "desc" },
      skip,
      take: pageLimit,
    }),
    prisma.message.count({ where }),
  ]);

  // sentBy, classId, studentId — soft ref (relation YO'Q), qo'lda yuklaymiz
  const messages = await attachMessageRefs(rawMessages);

  const totalPages = Math.ceil(total / pageLimit);

  return {
    data: messages.map((message) => ({ ...message, stats: deliveryStats(message.deliveryStatus) })),
    pagination: {
      page: pageNum,
      limit: pageLimit,
      total,
      totalPages,
      hasNextPage: pageNum < totalPages,
      hasPrevPage: pageNum > 1,
    },
  };
}

/**
 * Bitta xabar — yetkazish holatlari va qabul qiluvchilar bilan.
 *
 * @param {object} actor - `req.user`
 * @param {string} id
 * @returns {Promise<object>}
 */
async function getMessageById(actor, id) {
  const rawMessage = await prisma.message.findUnique({
    where: { id },
    include: { deliveryStatus: { orderBy: { position: "asc" } } },
  });

  if (!rawMessage) {
    throw new NotFoundError("Xabar topilmadi");
  }

  // Check permissions (sentBy hali scalar id)
  if (hasRole(actor, ROLES.TEACHER) && rawMessage.sentBy.toString() !== actor.id.toString()) {
    throw new ForbiddenError("Ruxsat berilmagan");
  }

  // sentBy, classId, studentId — soft ref, qo'lda yuklaymiz
  const message = await attachMessageRefs(rawMessage);

  // deliveryStatus.userId — soft ref, har bir yozuvga user obyektini biriktiramiz
  const dsUserIds = [...new Set(message.deliveryStatus.map((d) => d.userId).filter(Boolean))];
  const dsUsers = dsUserIds.length
    ? await prisma.user.findMany({
        where: { id: { in: dsUserIds } },
        select: { id: true, firstName: true, lastName: true, username: true },
      })
    : [];
  const dsUserMap = new Map(dsUsers.map((u) => [u.id, u]));
  message.deliveryStatus = message.deliveryStatus.map((d) => ({
    ...d,
    userId: d.userId ? dsUserMap.get(d.userId) || null : null,
  }));

  return { ...message, stats: deliveryStats(message.deliveryStatus) };
}

/**
 * Xabarning navbatda turgan yetkazishlarini to'xtatadi.
 *
 * @param {object} actor - `req.user`
 * @param {string} id
 * @returns {Promise<number>} to'xtatilgan navbat qatorlari soni
 */
async function cancelMessage(actor, id) {
  const message = await prisma.message.findUnique({
    where: { id },
    select: { sentBy: true },
  });
  if (!message) {
    throw new NotFoundError("Xabar topilmadi");
  }

  // Owner can cancel any message; teacher can cancel only their own
  if (hasRole(actor, ROLES.TEACHER) && message.sentBy.toString() !== actor.id.toString()) {
    throw new ForbiddenError("Ruxsat berilmagan");
  }

  return messageQueueService.cancelMessage(id);
}

module.exports = {
  RECIPIENT_TYPES,
  assertCanSend,
  resolveRecipients,
  sendMessage,
  getMessages,
  getMessageById,
  cancelMessage,
};
