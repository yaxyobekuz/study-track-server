// Models
const Message = require("../models/message.model");
const User = require("../models/user.model");
const Class = require("../models/class.model");

// Services
const messageQueueService = require("../services/messageQueue.service");
const fileStorage = require("../services/fileStorage.service");

// Node
const fs = require("fs");
const path = require("path");

/**
 * Send message to recipients
 * POST /api/messages
 */
const sendMessage = async (req, res) => {
  try {
    const { messageText, recipientType, classId, studentId } = req.body;
    const file = req.file;

    // Validate message text
    if (!messageText || !messageText.trim()) {
      return res.status(400).json({
        success: false,
        message: "Xabar matni majburiy",
      });
    }

    // Validate recipient type
    if (!["all", "class", "student"].includes(recipientType)) {
      return res.status(400).json({
        success: false,
        message: "Noto'g'ri qabul qiluvchi turi",
      });
    }

    // Check permissions
    const isOwner = req.user.role === "owner";
    const isTeacher = req.user.role === "teacher";

    if (!isOwner && !isTeacher) {
      return res.status(403).json({
        success: false,
        message: "Ruxsat berilmagan",
      });
    }

    // Owner can send to all, class, or student
    // Teacher can only send to class or student
    if (isTeacher && recipientType === "all") {
      return res.status(403).json({
        success: false,
        message: "O'qituvchi barchaga xabar yubora olmaydi",
      });
    }

    let recipientIds = [];
    let recipients = [];
    let messageClassId = null;
    let messageStudentId = null;

    // Get recipients based on type
    if (recipientType === "all") {
      // Get all users with telegram IDs
      recipients = await User.find({
        telegramIds: { $exists: true, $ne: [] },
        role: { $in: ["teacher", "student"] },
      }).select("_id telegramIds firstName lastName");

      recipientIds = recipients.reduce((acc, user) => {
        return [...acc, ...user.telegramIds];
      }, []);
    } else if (recipientType === "class") {
      if (!classId) {
        return res.status(400).json({
          success: false,
          message: "Sinf ID majburiy",
        });
      }

      // Check if class exists
      const classDoc = await Class.findById(classId);
      if (!classDoc) {
        return res.status(404).json({
          success: false,
          message: "Sinf topilmadi",
        });
      }

      // Get all students in the class
      recipients = await User.find({
        classes: classId,
        role: "student",
        telegramIds: { $exists: true, $ne: [] },
      }).select("_id telegramIds firstName lastName");

      recipientIds = recipients.reduce((acc, user) => {
        return [...acc, ...user.telegramIds];
      }, []);

      messageClassId = classId;
    } else if (recipientType === "student") {
      if (!studentId) {
        return res.status(400).json({
          success: false,
          message: "O'quvchi ID majburiy",
        });
      }

      // Check if student exists
      const student = await User.findById(studentId).select("_id telegramIds firstName lastName");
      if (!student) {
        return res.status(404).json({
          success: false,
          message: "O'quvchi topilmadi",
        });
      }

      if (!student.telegramIds || student.telegramIds.length === 0) {
        return res.status(400).json({
          success: false,
          message: "O'quvchining telegram ID si mavjud emas",
        });
      }

      recipients = [student];
      recipientIds = student.telegramIds;
      messageStudentId = studentId;
    }

    if (recipientIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Qabul qiluvchilar topilmadi yoki ularning telegram ID lari mavjud emas",
      });
    }

    // Prepare delivery status
    const deliveryStatus = [];
    recipients.forEach((user) => {
      user.telegramIds.forEach((telegramId) => {
        deliveryStatus.push({
          telegramId,
          userId: user._id,
          status: "pending",
        });
      });
    });

    // Create message record
    const message = await Message.create({
      messageText: messageText.trim(),
      sentBy: req.user._id,
      recipientType,
      recipientIds,
      classId: messageClassId,
      studentId: messageStudentId,
      totalRecipients: recipientIds.length,
      deliveryStatus,
    });

    // Upload file to DO Spaces and determine file type
    let fileUrl = null;
    let fileType = null;
    if (file) {
      const imageTypes = ["image/jpeg", "image/jpg", "image/png", "image/gif"];
      fileType = imageTypes.includes(file.mimetype) ? "photo" : "document";

      const buffer = fs.readFileSync(file.path);
      const key = `messages/${Date.now()}-${path.basename(file.path)}`;
      const uploaded = await fileStorage.uploadBuffer({ key, buffer, contentType: file.mimetype });
      fileUrl = uploaded.url;

      fs.unlinkSync(file.path);
    }

    // Add messages to queue
    const queueItems = recipientIds.map((telegramId) => {
      const queueItem = {
        messageId: message._id,
        telegramId,
        userId: recipients.find((r) => r.telegramIds.includes(telegramId))?._id,
        messageText: messageText.trim(),
      };

      // Only add file fields if file exists
      if (fileUrl) {
        queueItem.filePath = fileUrl;
        queueItem.fileType = fileType;
      }

      return queueItem;
    });

    await messageQueueService.addBulkToQueue(queueItems);

    res.status(201).json({
      success: true,
      message: "Xabar navbatga qo'shildi va tez orada yuboriladi",
      data: message,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Xabar yuborishda xato",
      error: error.message,
    });
  }
};

/**
 * Get all messages (with filters and pagination)
 * GET /api/messages
 */
const getMessages = async (req, res) => {
  try {
    const { page = 1, limit = 20, sentBy, classId, recipientType, startDate, endDate } = req.query;

    // Build query
    let query = {};

    // If teacher, only show their own messages
    if (req.user.role === "teacher") {
      query.sentBy = req.user._id;
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
        query.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    // Pagination
    const pageNum = parseInt(page, 10) || 1;
    const pageLimit = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * pageLimit;

    // Get messages
    const [messages, total] = await Promise.all([
      Message.find(query)
        .populate("sentBy", "firstName lastName username role")
        .populate("classId", "name")
        .populate("studentId", "firstName lastName username")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageLimit)
        .lean(),
      Message.countDocuments(query),
    ]);

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
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Xabarlarni olishda xato",
      error: error.message,
    });
  }
};

/**
 * Get message by ID
 * GET /api/messages/:id
 */
const getMessageById = async (req, res) => {
  try {
    const { id } = req.params;

    const message = await Message.findById(id)
      .populate("sentBy", "firstName lastName username role")
      .populate("classId", "name")
      .populate("studentId", "firstName lastName username")
      .populate("deliveryStatus.userId", "firstName lastName username")
      .lean();

    if (!message) {
      return res.status(404).json({
        success: false,
        message: "Xabar topilmadi",
      });
    }

    // Check permissions
    if (req.user.role === "teacher" && message.sentBy._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Ruxsat berilmagan",
      });
    }

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
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Xabarni olishda xato",
      error: error.message,
    });
  }
};

module.exports = {
  sendMessage,
  getMessages,
  getMessageById,
};
