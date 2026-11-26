/**
 * CHAT — `/api/chat/*`.
 *
 * ⚠️ O'QUVCHI HAM KIRADI, lekin FAQAT SINF GURUHIGA: a'zolik — huquqning
 * o'zi (`chatAccess.service.js`), shuning uchun ruxsat kaliti yo'q.
 * O'quvchiga yopiq amallar (shaxsiy yozishma, guruh yaratish, xodim
 * qidirish) controllerda `assertStaffOnly` bilan to'siladi — har biri
 * ALOHIDA, chunki router darajasidagi darvoza sinf guruhini ham
 * yopib qo'yardi.
 *
 * ⚠️ OTA-ONA ILOVASI KIRMAYDI: seans kanali `parent` bo'lsa sinf guruhi
 * ham ko'rinmaydi (`socialAccess.assertNotParentChannel`) — push ham
 * `channels: ["student"]` bilan ketadi, ya'ni ikkala qavat ham yopiq.
 */

const express = require("express");
const router = express.Router();

const { protect } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const socialAccess = require("../services/socialAccess.service");
const controller = require("../controllers/chat.controller");

router.use(protect);
router.use((req, res, next) => {
  socialAccess.assertEnabled(req.branch);
  socialAccess.assertNotParentChannel(req.sessionChannel);
  next();
});

/* ── STATIK YO'LLAR `/:id` DAN OLDIN ───────────────────────────────── */
router.get("/sync", controller.sync);
router.get("/users", controller.searchUsers);
router.post("/direct", controller.openDirect);
router.post("/groups", controller.createGroup);
router.post("/class-groups/resync", controller.resyncClassGroups);

/* ── SUHBATLAR ─────────────────────────────────────────────────────── */
router.get("/conversations", controller.listConversations);
router.patch("/conversations/:id", validateObjectId("id"), controller.updateConversation);
router.get("/conversations/:id/members", validateObjectId("id"), controller.listMembers);
router.post("/conversations/:id/members", validateObjectId("id"), controller.addMembers);
router.delete(
  "/conversations/:id/members/:userId",
  validateObjectId("id"),
  validateObjectId("userId"),
  controller.removeMember,
);
router.post("/conversations/:id/leave", validateObjectId("id"), controller.leaveConversation);
router.patch("/conversations/:id/me", validateObjectId("id"), controller.updateMyState);
router.post("/conversations/:id/ban", validateObjectId("id"), controller.banMember);

/* ── XABARLAR ──────────────────────────────────────────────────────── */
router.get("/conversations/:id/messages", validateObjectId("id"), controller.listMessages);
router.post("/conversations/:id/messages", validateObjectId("id"), controller.sendMessage);
router.post("/conversations/:id/read", validateObjectId("id"), controller.markRead);

router.get("/messages/:id/readers", validateObjectId("id"), controller.listReaders);
router.patch("/messages/:id", validateObjectId("id"), controller.editMessage);
router.delete("/messages/:id", validateObjectId("id"), controller.deleteMessage);

module.exports = router;
