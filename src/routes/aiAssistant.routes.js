// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const {
  requirePrimaryOwner,
  chatLimiter,
  speechLimiter,
  actionLimiter,
  voiceUpload,
} = require("../middleware/aiAssistant.middleware");

// Controller
const {
  getStatus,
  listConversations,
  getConversation,
  renameConversation,
  deleteConversation,
  chat,
  getMessageAudio,
  getMessageSpeech,
  listActions,
  confirmAction,
  rejectAction,
} = require("../controllers/aiAssistant.controller");

// ⚠️ Butun bo'lim FAQAT ASOSIY EGA uchun (`requirePrimaryOwner` izohiga
// qarang). Ruxsat kaliti yo'q va berib bo'lmaydi.
router.use(protect, requirePrimaryOwner);

router.get("/status", getStatus);

// Suhbatlar
router.get("/conversations", listConversations);
router.get("/conversations/:id", validateObjectId("id"), getConversation);
router.patch("/conversations/:id", validateObjectId("id"), renameConversation);
router.delete("/conversations/:id", validateObjectId("id"), deleteConversation);

// Chat — JSON { conversationId?, text } YOKI multipart (audio, conversationId?, durationMs).
// Javob SSE oqimi. Cheklov yuklashdan OLDIN: ortiqcha so'rov faylni o'qitmasin.
router.post("/chat", chatLimiter, ...voiceUpload, chat);

// Ovoz
router.get("/messages/:id/audio", validateObjectId("id"), getMessageAudio);
router.post("/messages/:id/speech", validateObjectId("id"), speechLimiter, getMessageSpeech);

// Amallar (audit va tasdiq)
router.get("/actions", listActions);
router.post("/actions/:id/confirm", validateObjectId("id"), actionLimiter, confirmAction);
router.post("/actions/:id/reject", validateObjectId("id"), actionLimiter, rejectAction);

module.exports = router;
