/**
 * CHAT — controller (yupqa). Hamma qoida `chat.service.js` va
 * `chatAccess.service.js` da.
 */

const asyncHandler = require("../middleware/async.middleware");
const chatService = require("../services/chat.service");
const classChatService = require("../services/classChat.service");
const socialAccess = require("../services/socialAccess.service");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");
const { ForbiddenError } = require("../utils/errors");

const isStaffOf = (req) => socialAccess.isStaff(req.user);

/* ───────────────────────── SUHBATLAR ───────────────────────── */

const listConversations = asyncHandler(async (req, res) => {
  const data = await chatService.listConversations({
    actor: req.user,
    cursor: req.query.cursor,
    limit: req.query.limit,
    archived: req.query.archived === "true",
  });
  res.json({ success: true, ...data });
});

const openDirect = asyncHandler(async (req, res) => {
  assertStaffOnly(req);
  const data = await chatService.openDirect({ actor: req.user, userId: req.body?.userId });
  res.json({ success: true, data });
});

const createGroup = asyncHandler(async (req, res) => {
  assertStaffOnly(req);
  const data = await chatService.createGroup({ actor: req.user, body: req.body });
  res.status(201).json({ success: true, data });
});

const updateConversation = asyncHandler(async (req, res) => {
  const data = await chatService.updateConversation({
    actor: req.user,
    id: req.params.id,
    body: req.body,
  });
  res.json({ success: true, data });
});

const addMembers = asyncHandler(async (req, res) => {
  assertStaffOnly(req);
  const data = await chatService.addMembers({
    actor: req.user,
    id: req.params.id,
    userIds: req.body?.userIds,
  });
  res.json({ success: true, data });
});

const removeMember = asyncHandler(async (req, res) => {
  assertStaffOnly(req);
  const data = await chatService.removeMember({
    actor: req.user,
    id: req.params.id,
    userId: req.params.userId,
  });
  res.json({ success: true, data });
});

const leaveConversation = asyncHandler(async (req, res) => {
  const data = await chatService.leave({ actor: req.user, id: req.params.id });
  res.json({ success: true, data });
});

const updateMyState = asyncHandler(async (req, res) => {
  const data = await chatService.updateMyState({
    actor: req.user,
    id: req.params.id,
    body: req.body,
  });
  res.json({ success: true, data });
});

const banMember = asyncHandler(async (req, res) => {
  assertStaffOnly(req);
  const data = await chatService.banMember({
    actor: req.user,
    id: req.params.id,
    userId: req.body?.userId,
    minutes: req.body?.minutes,
    reason: req.body?.reason,
  });
  res.json({ success: true, data });
});

const listMembers = asyncHandler(async (req, res) => {
  const data = await chatService.listMembers({ actor: req.user, id: req.params.id });
  res.json({ success: true, ...data });
});

/* ───────────────────────── XABARLAR ───────────────────────── */

const listMessages = asyncHandler(async (req, res) => {
  const data = await chatService.listMessages({
    actor: req.user,
    id: req.params.id,
    beforeSeq: req.query.beforeSeq,
    afterSeq: req.query.afterSeq,
    limit: req.query.limit,
  });
  res.json({ success: true, ...data });
});

/**
 * XABAR YUBORISH.
 *
 * ⚠️ IDEMPOTENT: `clientId` allaqachon yozilgan bo'lsa 200 qaytadi
 * (201 EMAS) — ilova shu bo'yicha "qayta yuborish" va "yangi xabar" ni
 * ajratadi (`docs/social-api.md`).
 */
const sendMessage = asyncHandler(async (req, res) => {
  const { message, created } = await chatService.sendMessage({
    actor: req.user,
    conversationId: req.params.id,
    body: req.body,
    isStaff: isStaffOf(req),
  });
  res.status(created ? 201 : 200).json({ success: true, data: message, created });
});

const editMessage = asyncHandler(async (req, res) => {
  const data = await chatService.editMessage({
    actor: req.user,
    messageId: req.params.id,
    text: req.body?.text,
  });
  res.json({ success: true, data });
});

const deleteMessage = asyncHandler(async (req, res) => {
  const data = await chatService.deleteMessage({
    actor: req.user,
    messageId: req.params.id,
    isStaff: isStaffOf(req),
  });
  res.json({ success: true, data });
});

const markRead = asyncHandler(async (req, res) => {
  const data = await chatService.markRead({
    actor: req.user,
    id: req.params.id,
    seq: req.body?.seq,
  });
  res.json({ success: true, data });
});

const listReaders = asyncHandler(async (req, res) => {
  const data = await chatService.listReaders({ actor: req.user, messageId: req.params.id });
  res.json({ success: true, ...data });
});

/* ───────────────────────── SINXRON VA QIDIRUV ───────────────────────── */

const sync = asyncHandler(async (req, res) => {
  const data = await chatService.sync({ actor: req.user, since: req.query.since });
  res.json({ success: true, data });
});

const searchUsers = asyncHandler(async (req, res) => {
  assertStaffOnly(req);
  const pagination = getPaginationParams(req, 20);
  const { total, items } = await socialAccess.searchStaff({
    query: req.query.q,
    skip: pagination.skip,
    limit: pagination.limit,
    excludeId: req.user.id,
  });
  res.json(formatPaginationResponse(items, total, pagination.page, pagination.limit));
});

/**
 * SINF GURUHLARINI QO'LDA QAYTA SINXRONLASH (`chat.classGroupsManage`).
 *
 * ⚠️ FAQAT JORIY FILIAL: boshqa filialning guruhlari uning o'z
 * ma'lumotidan quriladi va bu yerda filial konteksti bittasiga
 * bog'langan (`forEachBranch` faqat cron'da).
 */
const resyncClassGroups = asyncHandler(async (req, res) => {
  if (!socialAccess.canManageClassGroups(req.user)) {
    throw new ForbiddenError("Sinf guruhlarini boshqarish huquqi sizda yo'q");
  }
  const data = await classChatService.syncAllInBranch();
  res.json({ success: true, data, message: "Sinf guruhlari sinxronlandi" });
});

/**
 * O'quvchiga yopiq amallar.
 *
 * ⚠️ SERVERDA, PANELDA EMAS: o'quvchi faqat sinf guruhini ko'radi
 * (`socialAccess.service.js`), ya'ni shaxsiy yozishma ochish, guruh
 * yaratish va xodim qidirish unga umuman ochilmaydi.
 */
function assertStaffOnly(req) {
  socialAccess.assertStaff(req.user, req.sessionChannel);
}

module.exports = {
  listConversations,
  openDirect,
  createGroup,
  updateConversation,
  addMembers,
  removeMember,
  leaveConversation,
  updateMyState,
  banMember,
  listMembers,
  listMessages,
  sendMessage,
  editMessage,
  deleteMessage,
  markRead,
  listReaders,
  sync,
  searchUsers,
  resyncClassGroups,
};
