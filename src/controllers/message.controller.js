const prisma = require("../config/prisma");

const { ROLES } = require("../utils/constants");
const { hasRole } = require("../utils/permissions");
// Services
const messageQueueService = require("../services/messageQueue.service");
const fileStorage = require("../services/fileStorage.service");

// Node
const path = require("path");

const asyncHandler = require("../middleware/async.middleware");
const { BadRequestError, NotFoundError, ForbiddenError } = require("../utils/errors");

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

/**
 * Send message to recipients
 * POST /api/messages
 */
const sendMessage = asyncHandler(async (req, res) => {
  const { messageText, recipientType, classId, studentId } = req.body;
  const file = req.file;

  // Validate message text
  if (!messageText || !messageText.trim()) {
    throw new BadRequestError("Xabar matni majburiy");
  }

  // Validate recipient type
  if (!["all", "class", "student"].includes(recipientType)) {
    throw new BadRequestError("Noto'g'ri qabul qiluvchi turi");
  }

  // Check permissions
  const isOwner = req.user.role === "owner";
  // Ko'p rollilik — darvoza qo'shimcha rolni ham o'tkazadi, cheklov ham
  // AYNAN SHU savolga javob berishi kerak (`grade.controller.js` dagi izoh)
  const isTeacher = hasRole(req.user, ROLES.TEACHER);

  if (!isOwner && !isTeacher) {
    throw new ForbiddenError("Ruxsat berilmagan");
  }

  // Owner can send to all, class, or student
  // Teacher can only send to class or student
  if (isTeacher && recipientType === "all") {
    throw new ForbiddenError("O'qituvchi barchaga xabar yubora olmaydi");
  }

  // Guard against accidental duplicate submits: reject an identical message
  // (same sender + same text) created within the last few seconds.
  const duplicateWindowMs = 5000;
  const recentDuplicate = await prisma.message.findFirst({
    where: {
      sentBy: req.user.id,
      messageText: messageText.trim(),
      recipientType,
      createdAt: { gte: new Date(Date.now() - duplicateWindowMs) },
    },
    select: { id: true },
  });

  if (recentDuplicate) {
    throw new BadRequestError("Bu xabar hozirgina yuborildi. Iltimos, biroz kuting.");
  }

  let recipientIds = [];
  let recipients = [];
  let messageClassId = null;
  let messageStudentId = null;

  // Get recipients based on type
  if (recipientType === "all") {
    // Get all users with telegram IDs
    recipients = await prisma.user.findMany({
      where: {
        telegramIds: { isEmpty: false },
        role: { in: ["teacher", "student"] },
      },
      select: { id: true, telegramIds: true, firstName: true, lastName: true },
    });

    recipientIds = recipients.reduce((acc, user) => {
      return [...acc, ...user.telegramIds];
    }, []);
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
      select: { id: true, telegramIds: true, firstName: true, lastName: true },
    });

    recipientIds = recipients.reduce((acc, user) => {
      return [...acc, ...user.telegramIds];
    }, []);

    messageClassId = classId;
  } else if (recipientType === "student") {
    if (!studentId) {
      throw new BadRequestError("O'quvchi ID majburiy");
    }

    // Check if student exists
    const student = await prisma.user.findUnique({
      where: { id: studentId },
      select: { id: true, telegramIds: true, firstName: true, lastName: true },
    });
    if (!student) {
      throw new NotFoundError("O'quvchi topilmadi");
    }

    if (!student.telegramIds || student.telegramIds.length === 0) {
      throw new BadRequestError("O'quvchining telegram ID si mavjud emas");
    }

    recipients = [student];
    recipientIds = student.telegramIds;
    messageStudentId = studentId;
  }

  if (recipientIds.length === 0) {
    throw new BadRequestError("Qabul qiluvchilar topilmadi yoki ularning telegram ID lari mavjud emas");
  }

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
      messageText: messageText.trim(),
      sentBy: req.user.id,
      recipientType,
      recipientIds,
      classId: messageClassId,
      studentId: messageStudentId,
      totalRecipients: recipientIds.length,
      deliveryStatus: { create: deliveryStatus },
    },
  });

  // Upload file to DO Spaces and determine file type
  let fileUrl = null;
  let fileType = null;
  if (file) {
    const imageTypes = ["image/jpeg", "image/jpg", "image/png", "image/gif"];
    fileType = imageTypes.includes(file.mimetype) ? "photo" : "document";

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
      messageText: messageText.trim(),
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

  res.status(201).json({
    success: true,
    message: "Xabar navbatga qo'shildi va tez orada yuboriladi",
    data: message,
  });
});

/**
 * Get all messages (with filters and pagination)
 * GET /api/messages
 */
const getMessages = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, sentBy, classId, recipientType, startDate, endDate } = req.query;

  // Build query
  const query = {};

  // If teacher, only show their own messages
  if (hasRole(req.user, ROLES.TEACHER)) {
    query.sentBy = req.user.id;
  }

  // If owner, can filter by sentBy
  if (req.user.role === "owner" && sentBy) {
    query.sentBy = sentBy;
  }

  if (classId) {
    query.classId = classId;
  }

  if (recipientType) {
    query.recipientType = recipientType;
  }

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) {
      query.createdAt.gte = new Date(startDate);
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query.createdAt.lte = end;
    }
  }

  // Pagination
  const pageNum = parseInt(page, 10) || 1;
  const pageLimit = parseInt(limit, 10) || 20;
  const skip = (pageNum - 1) * pageLimit;

  // Get messages
  const [rawMessages, total] = await Promise.all([
    prisma.message.findMany({
      where: query,
      include: { deliveryStatus: { orderBy: { position: "asc" } } },
      orderBy: { createdAt: "desc" },
      skip,
      take: pageLimit,
    }),
    prisma.message.count({ where: query }),
  ]);

  // sentBy, classId, studentId — soft ref (relation YO'Q), qo'lda yuklaymiz
  const messages = await attachMessageRefs(rawMessages);

  // Calculate statistics for each message
  const messagesWithStats = messages.map((message) => {
    const totalSent = message.deliveryStatus.filter((d) => d.status === "sent").length;
    const totalFailed = message.deliveryStatus.filter((d) => d.status === "failed").length;
    const totalPending = message.deliveryStatus.filter((d) => d.status === "pending").length;

    return {
      ...message,
      stats: {
        totalSent,
        totalFailed,
        totalPending,
      },
    };
  });

  const totalPages = Math.ceil(total / pageLimit);

  res.json({
    success: true,
    data: messagesWithStats,
    pagination: {
      page: pageNum,
      limit: pageLimit,
      total,
      totalPages,
      hasNextPage: pageNum < totalPages,
      hasPrevPage: pageNum > 1,
    },
  });
});

/**
 * Get message by ID
 * GET /api/messages/:id
 */
const getMessageById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const rawMessage = await prisma.message.findUnique({
    where: { id },
    include: { deliveryStatus: { orderBy: { position: "asc" } } },
  });

  if (!rawMessage) {
    throw new NotFoundError("Xabar topilmadi");
  }

  // Check permissions (sentBy hali scalar id)
  if (
    hasRole(req.user, ROLES.TEACHER) &&
    rawMessage.sentBy.toString() !== req.user.id.toString()
  ) {
    throw new ForbiddenError("Ruxsat berilmagan");
  }

  // sentBy, classId, studentId — soft ref, qo'lda yuklaymiz
  const message = await attachMessageRefs(rawMessage);

  // deliveryStatus.userId — soft ref, har bir yozuvga user obyektini biriktiramiz
  const dsUserIds = [
    ...new Set(message.deliveryStatus.map((d) => d.userId).filter(Boolean)),
  ];
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

  // Calculate statistics
  const totalSent = message.deliveryStatus.filter((d) => d.status === "sent").length;
  const totalFailed = message.deliveryStatus.filter((d) => d.status === "failed").length;
  const totalPending = message.deliveryStatus.filter((d) => d.status === "pending").length;

  res.json({
    success: true,
    data: {
      ...message,
      stats: {
        totalSent,
        totalFailed,
        totalPending,
      },
    },
  });
});

/**
 * Cancel a message's pending deliveries
 * PATCH /api/messages/:id/cancel
 */
const cancelMessage = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const message = await prisma.message.findUnique({
    where: { id },
    select: { sentBy: true },
  });
  if (!message) {
    throw new NotFoundError("Xabar topilmadi");
  }

  // Owner can cancel any message; teacher can cancel only their own
  if (
    hasRole(req.user, ROLES.TEACHER) &&
    message.sentBy.toString() !== req.user.id.toString()
  ) {
    throw new ForbiddenError("Ruxsat berilmagan");
  }

  const cancelledCount = await messageQueueService.cancelMessage(id);

  res.json({
    success: true,
    message:
      cancelledCount > 0
        ? `${cancelledCount} ta navbatdagi xabar to'xtatildi`
        : "To'xtatish uchun navbatda xabar qolmagan",
    data: { cancelledCount },
  });
});

module.exports = {
  sendMessage,
  getMessages,
  getMessageById,
  cancelMessage,
};
