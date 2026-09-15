const asyncHandler = require("../middleware/async.middleware");
const messageService = require("../services/message.service");

/**
 * Send message to recipients
 * POST /api/messages
 *
 * Mantiq `message.service.js` da — AI yordamchi ham aynan shu yo'l bilan
 * yuboradi. Controller faqat so'rov qismlarini (matn, tur, fayl) uzatadi.
 */
const sendMessage = asyncHandler(async (req, res) => {
  const { messageText, recipientType, classId, studentId } = req.body;

  const message = await messageService.sendMessage({
    actor: req.user,
    messageText,
    recipientType,
    classId,
    studentId,
    file: req.file || null,
  });

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
  const { data, pagination } = await messageService.getMessages(req.user, req.query);

  res.json({ success: true, data, pagination });
});

/**
 * Get message by ID
 * GET /api/messages/:id
 */
const getMessageById = asyncHandler(async (req, res) => {
  const data = await messageService.getMessageById(req.user, req.params.id);

  res.json({ success: true, data });
});

/**
 * Cancel a message's pending deliveries
 * PATCH /api/messages/:id/cancel
 */
const cancelMessage = asyncHandler(async (req, res) => {
  const cancelledCount = await messageService.cancelMessage(req.user, req.params.id);

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
