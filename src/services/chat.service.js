/**
 * CHAT — xodimlar yozishmasi, guruhlar va sinf guruhlari.
 *
 * Qoida bitta jumlada:
 *
 * > Xabar REST orqali ham, socket orqali ham kelishi mumkin, lekin ikkalasi
 * > HAM shu fayldagi `sendMessage` ni chaqiradi. Socket — tez yetkazish
 * > kanali; HAQIQAT MANBAI — baza va `seq`.
 *
 * ⚠️ IKKI YO'L, BITTA MANTIQ. Socket uchun alohida nusxa yozilsa, biriga
 * qo'shilgan shart (e'lon rejimi, ovozsiz qilish, sekin rejim, tezlik
 * chegarasi) ikkinchisida tushib qolardi — ya'ni socket tugma orqali
 * qoidani chetlab o'tish yo'li bo'lardi.
 *
 * ⚠️ `seq` — `UPDATE conversation SET last_seq = last_seq + 1 RETURNING`
 * bilan olinadi. Bu BITTA QATORLI QULF: ikki parallel xabar bir xil raqam
 * olishi strukturaviy imkonsiz. `COUNT(*) + 1` bo'lsa, poyga ikkita
 * 7-xabar yozib, biri yo'qolardi (unique indeks esa ikkinchisini xato
 * bilan qaytarardi).
 *
 * ⚠️ `clientId` IDEMPOTENTLIK KALITI (`@@unique([senderId, clientId])`):
 * tarmoq uzilib ilova qayta yuborsa, server O'SHA xabarni qaytaradi va
 * 201 emas, 200 beradi. Usiz "yubordim, ko'rinmadi, yana bosdim" har
 * safar ikkita xabar bo'lardi.
 *
 * ⚠️ O'QILDI — BITTA SON (`lastReadSeq`) va u ORQAGA KETMAYDI
 * (`GREATEST`): ikki telefonli odamda eski ekran yangisini "o'qilmagan"
 * holatga qaytarib yuborardi.
 */

const platformPrisma = require("../config/platformPrisma");
const mediaService = require("./mediaUpload.service");
const socialAccess = require("./socialAccess.service");
const chatAccess = require("./chatAccess.service");
const pushService = require("./push.service");
const emitter = require("../realtime/emitter");
const logger = require("../utils/logger");
const { config } = require("../config/env.config");
const { quoteIdent } = require("../helpers/crossSchema.helpers");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} = require("../utils/errors");
const {
  MESSAGE_TEXT_MAX,
  PREVIEW_MAX,
  cleanText,
} = require("../helpers/socialMedia.helpers");
const {
  chatMessagePush,
  chatReadPush,
  messagePreview,
  isQuietHours,
} = require("../helpers/socialPush.helpers");
const { containsProfanity } = require("../helpers/profanity.helpers");

/** Guruhdagi a'zolar chegarasi. */
const MAX_GROUP_MEMBERS = 200;
/** Tahrirlash / o'chirish oynasi — xodim uchun. */
const EDIT_WINDOW_MS = 48 * 3600 * 1000;
/** O'quvchi o'z xabarini shu muddat ichida o'chiradi. */
const STUDENT_DELETE_WINDOW_MS = 10 * 60 * 1000;
/** Ro'yxat sahifasi. */
const PAGE = 50;
const PAGE_MAX = 100;
/** Pinlangan suhbatlar chegarasi — ro'yxatning birinchi bloki. */
const MAX_PINNED = 50;

/** Xabar turlari — matn/media mosligi tekshiriladi. */
const MEDIA_TYPES = Object.freeze({ image: "image", video: "video", voice: "voice", file: "file" });

/** Platforma jadvalining to'liq nomi — xom SQL uchun. */
const table = (name) => `${quoteIdent(config.platformSchema)}.${quoteIdent(name)}`;

/* ═══════════════════════ SUHBATLAR RO'YXATI ═══════════════════════ */

/**
 * SUHBATLAR RO'YXATI.
 *
 * ⚠️ PINLANGANLAR ALOHIDA BLOKDA qaytadi, ro'yxatning tepasiga
 * ARALASHTIRILMAYDI. Sabab arifmetik: kursor bilan sahifalash ORDER BY
 * ustunlariga tayanadi, pinlangan suhbat esa eski bo'lishi mumkin —
 * "pinlanganlar tepada, qolganlari vaqt bo'yicha" degan tartibda kursor
 * ikkinchi sahifada xabarni tushirib qoldirardi yoki takrorlardi.
 * Pinlanganlar soni kichik (≤ 50), shuning uchun ular to'liq beriladi.
 *
 * @param {{actor: object, cursor?: string, limit?: number, archived?: boolean}} input
 */
async function listConversations({ actor, cursor, limit, archived = false }) {
  const take = clampPage(limit);
  const userId = String(actor.id);

  /**
   * ⚠️ SHARTLAR BITTA `some` ICHIDA YIG'ILADI, ikkita `members` kaliti
   * bilan EMAS: obyektda bir xil kalit ikki marta yozilsa, ikkinchisi
   * birinchisini bosib ketadi — ya'ni arxiv filtri jimgina yo'qolardi
   * va arxivlangan suhbatlar asosiy ro'yxatda ko'rinardi.
   */
  const mine = (extra = {}) => ({
    members: {
      some: {
        userId,
        leftAt: null,
        ...(archived ? { archivedAt: { not: null } } : { archivedAt: null }),
        ...extra,
      },
    },
  });

  const pinnedRows = cursor
    ? []
    : await platformPrisma.conversation.findMany({
        where: mine({ pinnedAt: { not: null } }),
        orderBy: { lastMessageAt: "desc" },
        take: MAX_PINNED,
      });

  const pinnedIds = new Set(pinnedRows.map((r) => r.id));

  const rows = await platformPrisma.conversation.findMany({
    where: mine({ pinnedAt: null }),
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(cursor ? { cursor: { id: String(cursor) }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;

  const all = [...pinnedRows, ...page.filter((r) => !pinnedIds.has(r.id))];
  const items = await presentConversations(all, userId);

  return {
    pinned: items.filter((i) => i.pinned),
    items: items.filter((i) => !i.pinned),
    pagination: { nextCursor: hasMore ? page[page.length - 1].id : null, hasMore },
  };
}

/**
 * Suhbatlar ro'yxatini javob shakliga keltiradi.
 *
 * ⚠️ BITTA SO'ROV BILAN: a'zolar va sherik kartochkalari oldindan
 * yig'iladi. Har suhbat uchun alohida so'rov yuborilsa, 40 suhbatli
 * ro'yxat 80 so'rov bo'lardi.
 */
async function presentConversations(conversations, userId) {
  if (conversations.length === 0) return [];

  const ids = conversations.map((c) => c.id);
  const members = await platformPrisma.conversationMember.findMany({
    where: { conversationId: { in: ids }, leftAt: null },
  });

  const byConv = new Map();
  for (const m of members) {
    if (!byConv.has(m.conversationId)) byConv.set(m.conversationId, []);
    byConv.get(m.conversationId).push(m);
  }

  // 1:1 da sarlavha — SHERIKNING ismi, shuning uchun kartochka kerak.
  const partnerIds = [];
  for (const conv of conversations) {
    if (conv.type !== "direct") continue;
    for (const m of byConv.get(conv.id) || []) {
      if (m.userId !== userId) partnerIds.push(m.userId);
    }
  }
  const cards = await socialAccess.loadUserCards(partnerIds);

  return conversations.map((conv) => {
    const list = byConv.get(conv.id) || [];
    const me = list.find((m) => m.userId === userId);
    const partner = conv.type === "direct" ? list.find((m) => m.userId !== userId) : null;

    return {
      id: conv.id,
      type: conv.type,
      title: conv.type === "direct" ? cards.get(partner?.userId)?.fullName || "Xodim" : conv.title,
      partner: partner ? cards.get(partner.userId) || null : null,
      classId: conv.classId,
      branchId: conv.branchId,
      memberCount: list.length,
      lastSeq: conv.lastSeq,
      lastMessageAt: conv.lastMessageAt ? conv.lastMessageAt.toISOString() : null,
      lastPreview: conv.lastPreview,
      // ⚠️ `lastSeq - lastReadSeq`, `COUNT(*)` EMAS: o'qilmaganlar soni
      // ikki sondan chiqadi, ya'ni jadvalni sanash kerak emas.
      unreadCount: Math.max(0, conv.lastSeq - (me?.lastReadSeq ?? 0)),
      onlyStaffPost: conv.onlyStaffPost,
      slowModeSec: conv.slowModeSec,
      closedAt: conv.closedAt ? conv.closedAt.toISOString() : null,
      myRole: me?.role || null,
      pinned: Boolean(me?.pinnedAt),
      archived: Boolean(me?.archivedAt),
      mutedUntil: me?.mutedUntil ? me.mutedUntil.toISOString() : null,
      postBannedUntil: me?.postBannedUntil ? me.postBannedUntil.toISOString() : null,
    };
  });
}

/* ═══════════════════════ SUHBAT OCHISH ═══════════════════════ */

/**
 * 1:1 SUHBAT — mavjudini qaytaradi yoki yangisini ochadi.
 *
 * ⚠️ `directKey` = "kichikId:kattaId" va u YAGONA: ikki odam bir vaqtda
 * bir-biriga yozsa ham BITTA suhbat chiqadi. Kalitni tartiblamasak,
 * "A:B" va "B:A" ikki alohida suhbat bo'lib, ikkalasi ham yarim
 * yozishma bilan qolardi.
 *
 * ⚠️ FAQAT XODIM ↔ XODIM: o'quvchi bilan shaxsiy yozishma YO'Q (biznes
 * qarori) — sherikning roli KATALOGDAN tekshiriladi, chunki u boshqa
 * filialda bo'lishi mumkin.
 */
async function openDirect({ actor, userId }) {
  const me = String(actor.id);
  const other = String(userId || "").trim();
  if (!other) throw new BadRequestError("Xodim tanlanmagan");
  if (other === me) throw new BadRequestError("O'zingiz bilan yozishma ochilmaydi");

  await socialAccess.assertDirectoryStaff(other);

  const [a, b] = [me, other].sort();
  const directKey = `${a}:${b}`;

  const conversation = await platformPrisma.$transaction(async (tx) => {
    const existing = await tx.conversation.findUnique({ where: { directKey } });
    if (existing) return existing;

    return tx.conversation.create({
      data: {
        type: "direct",
        directKey,
        createdBy: me,
        members: {
          create: [
            { userId: a, role: "member", source: "manual" },
            { userId: b, role: "member", source: "manual" },
          ],
        },
      },
    });
  });

  const [presented] = await presentConversations([conversation], me);

  // Sherikda suhbat DARHOL paydo bo'lishi kerak (hali xabar bo'lmasa ham):
  // aks holda u birinchi xabarni "qayerdan keldi" deb ko'rardi.
  emitter.emitToUser(other, "conversation:updated", { conversationId: conversation.id });

  return presented;
}

/**
 * XODIMLAR GURUHI — `chat.groupCreate` ruxsati bilan.
 *
 * ⚠️ RUXSAT KERAK (spamni cheklash): har kim 200 kishilik guruh ochib
 * yuborsa, bo'lim bir hafta ichida ishlatib bo'lmaydigan holatga tushardi.
 */
async function createGroup({ actor, body = {} }) {
  if (!socialAccess.canCreateGroup(actor)) {
    throw new ForbiddenError("Guruh yaratish huquqi sizda yo'q");
  }

  const title = cleanText(body.title, 80);
  if (!title) throw new BadRequestError("Guruh nomi kiritilmagan");

  const me = String(actor.id);
  const memberIds = [...new Set((body.memberIds || []).filter(Boolean).map(String))].filter(
    (id) => id !== me,
  );
  if (memberIds.length === 0) throw new BadRequestError("A'zolar tanlanmagan");
  if (memberIds.length + 1 > MAX_GROUP_MEMBERS) {
    throw new BadRequestError(`Guruhda ko'pi bilan ${MAX_GROUP_MEMBERS} a'zo bo'ladi`);
  }

  // ⚠️ HAR A'ZO KATALOGDAN TEKSHIRILADI: o'quvchi yoki arxivlangan odam
  // guruhga tushib qolmasin (ro'yxat eskirgan ekrandan kelishi mumkin).
  for (const id of memberIds) {
    // eslint-disable-next-line no-await-in-loop
    await socialAccess.assertDirectoryStaff(id);
  }

  const conversation = await platformPrisma.conversation.create({
    data: {
      type: "group",
      title,
      createdBy: me,
      members: {
        create: [
          { userId: me, role: "owner", source: "manual" },
          ...memberIds.map((id) => ({ userId: id, role: "member", source: "manual" })),
        ],
      },
    },
  });

  emitter.emitToUsers([me, ...memberIds], "conversation:updated", {
    conversationId: conversation.id,
  });

  const [presented] = await presentConversations([conversation], me);
  return presented;
}

/**
 * Guruh sozlamalari: nom, rasm, e'lon rejimi, sekin rejim.
 *
 * ⚠️ SINF GURUHINING NOMI O'ZGARMAYDI — u sinf nomidan keladi
 * (`classChat.service.js` har sinxronda tiklaydi). Qo'lda o'zgartirilsa,
 * kechasi eski nom qaytib kelardi va admin "saqlanmadi" deb o'ylardi.
 */
async function updateConversation({ actor, id, body = {} }) {
  const { conversation, member } = await chatAccess.assertMember(id, actor);
  chatAccess.assertCanManage({ conversation, member, user: actor });

  const data = {};
  if (body.title !== undefined) {
    if (conversation.type === "class") {
      throw new BadRequestError("Sinf guruhining nomi sinf nomidan olinadi");
    }
    if (conversation.type === "direct") {
      throw new BadRequestError("Shaxsiy yozishmaning nomi o'zgartirilmaydi");
    }
    const title = cleanText(body.title, 80);
    if (!title) throw new BadRequestError("Guruh nomi bo'sh");
    data.title = title;
  }
  if (body.onlyStaffPost !== undefined) data.onlyStaffPost = Boolean(body.onlyStaffPost);
  if (body.slowModeSec !== undefined) {
    const sec = parseInt(body.slowModeSec, 10) || 0;
    if (sec < 0 || sec > 3600) throw new BadRequestError("Sekin rejim 0..3600 sekund");
    data.slowModeSec = sec;
  }

  if (Object.keys(data).length === 0) {
    const [presented] = await presentConversations([conversation], String(actor.id));
    return presented;
  }

  const updated = await platformPrisma.conversation.update({ where: { id: conversation.id }, data });
  await notifyConversationUpdated(updated.id);

  const [presented] = await presentConversations([updated], String(actor.id));
  return presented;
}

/** A'zo qo'shish (faqat xodimlar guruhi). */
async function addMembers({ actor, id, userIds = [] }) {
  const { conversation, member } = await chatAccess.assertMember(id, actor);
  chatAccess.assertMembershipEditable(conversation);
  chatAccess.assertCanManage({ conversation, member, user: actor });

  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (ids.length === 0) throw new BadRequestError("A'zolar tanlanmagan");

  const current = await platformPrisma.conversationMember.count({
    where: { conversationId: conversation.id, leftAt: null },
  });
  if (current + ids.length > MAX_GROUP_MEMBERS) {
    throw new BadRequestError(`Guruhda ko'pi bilan ${MAX_GROUP_MEMBERS} a'zo bo'ladi`);
  }

  for (const userId of ids) {
    // eslint-disable-next-line no-await-in-loop
    await socialAccess.assertDirectoryStaff(userId);
    // ⚠️ `upsert`: ilgari chiqib ketgan odam QAYTA qo'shiladi (`leftAt`
    // tozalanadi), yangi qator yozilmaydi — tarixi bitta qatorda qoladi.
    // eslint-disable-next-line no-await-in-loop
    await platformPrisma.conversationMember.upsert({
      where: { conversationId_userId: { conversationId: conversation.id, userId } },
      create: { conversationId: conversation.id, userId, role: "member", source: "manual" },
      update: { leftAt: null, source: "manual" },
    });
  }

  await addSystemMessage(conversation.id, { addedIds: ids, actorId: String(actor.id) });
  await notifyConversationUpdated(conversation.id);
  return { added: ids.length };
}

/** A'zoni chiqarish (faqat xodimlar guruhi). */
async function removeMember({ actor, id, userId }) {
  const { conversation, member } = await chatAccess.assertMember(id, actor);
  chatAccess.assertMembershipEditable(conversation);
  chatAccess.assertCanManage({ conversation, member, user: actor });

  const target = String(userId || "");
  if (!target) throw new BadRequestError("A'zo tanlanmagan");

  const { count } = await platformPrisma.conversationMember.updateMany({
    where: { conversationId: conversation.id, userId: target, leftAt: null },
    data: { leftAt: new Date() },
  });
  if (count === 0) throw new NotFoundError("A'zo topilmadi");

  await addSystemMessage(conversation.id, { removedIds: [target], actorId: String(actor.id) });
  await notifyConversationUpdated(conversation.id);
  return { removed: true };
}

/**
 * O'ZIM CHIQAMAN.
 *
 * ⚠️ SINF GURUHIDAN CHIQIB BO'LMAYDI (faqat ovozsiz qilish): o'quvchi
 * chiqib ketsa, e'lon va uyga vazifa unga yetmasdi — a'zolik esa
 * baribir kechasi sinxron bilan qaytarilardi, ya'ni tugma "ishlamayapti"
 * bo'lib ko'rinardi.
 */
async function leave({ actor, id }) {
  const { conversation } = await chatAccess.assertMember(id, actor);
  if (conversation.type === "class") {
    const error = new ForbiddenError(
      "Sinf guruhidan chiqib bo'lmaydi — bildirishnomani o'chirishingiz mumkin",
    );
    error.details = { code: chatAccess.CODES.CLASS_GROUP_IMMUTABLE };
    throw error;
  }
  if (conversation.type === "direct") {
    throw new ForbiddenError("Shaxsiy yozishmadan chiqib bo'lmaydi");
  }

  await platformPrisma.conversationMember.update({
    where: { conversationId_userId: { conversationId: conversation.id, userId: String(actor.id) } },
    data: { leftAt: new Date() },
  });

  await addSystemMessage(conversation.id, {
    removedIds: [String(actor.id)],
    actorId: String(actor.id),
    selfLeave: true,
  });
  await notifyConversationUpdated(conversation.id);
  return { left: true };
}

/**
 * SHAXSIY sozlamalar: ovozsiz, pin, arxiv, tarixni tozalash.
 *
 * ⚠️ `clearedSeq` FAQAT O'ZIMGA ta'sir qiladi: xabarlar bazada qoladi va
 * boshqalarda ko'rinadi. "Hamma uchun o'chirish" boshqa amal
 * (`deleteMessage`).
 */
async function updateMyState({ actor, id, body = {} }) {
  const { conversation, member } = await chatAccess.assertMember(id, actor);

  const data = {};
  if (body.mutedUntil !== undefined) {
    data.mutedUntil = body.mutedUntil ? new Date(body.mutedUntil) : null;
  }
  if (body.pinned !== undefined) data.pinnedAt = body.pinned ? new Date() : null;
  if (body.archived !== undefined) data.archivedAt = body.archived ? new Date() : null;
  if (body.clearHistory) data.clearedSeq = conversation.lastSeq;

  const updated = await platformPrisma.conversationMember.update({
    where: { conversationId_userId: { conversationId: conversation.id, userId: member.userId } },
    data,
  });

  return {
    conversationId: conversation.id,
    pinned: Boolean(updated.pinnedAt),
    archived: Boolean(updated.archivedAt),
    mutedUntil: updated.mutedUntil ? updated.mutedUntil.toISOString() : null,
    clearedSeq: updated.clearedSeq,
  };
}

/**
 * O'QUVCHINI VAQTINCHA OVOZSIZ QILISH (yozish taqiqi).
 *
 * ⚠️ FAQAT SINF GURUHIDA va faqat O'QUVCHIGA: xodimni "ovozsiz qilish"
 * intizom chorasi bo'lib qolardi va uning joyi bu modulda emas.
 */
async function banMember({ actor, id, userId, minutes, reason }) {
  const { conversation, member } = await chatAccess.assertMember(id, actor);
  chatAccess.assertCanManage({ conversation, member, user: actor });

  if (conversation.type !== "class") {
    throw new BadRequestError("Bu amal faqat sinf guruhida");
  }

  const target = await platformPrisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: conversation.id, userId: String(userId) } },
  });
  if (!target || target.leftAt) throw new NotFoundError("A'zo topilmadi");
  if (target.role !== "member") {
    throw new BadRequestError("Ustozni ovozsiz qilib bo'lmaydi");
  }

  const mins = parseInt(minutes, 10);
  if (!Number.isFinite(mins) || mins < 0 || mins > 7 * 24 * 60) {
    throw new BadRequestError("Muddat 0 dan 1 haftagacha bo'lishi kerak");
  }
  const until = mins > 0 ? new Date(Date.now() + mins * 60000) : null;
  const banReason = cleanText(reason, 300);
  if (mins > 0 && !banReason) throw new BadRequestError("Sabab majburiy");

  await platformPrisma.conversationMember.update({
    where: { conversationId_userId: { conversationId: conversation.id, userId: String(userId) } },
    data: { postBannedUntil: until, postBanReason: until ? banReason : null },
  });

  emitter.emitToUser(String(userId), "conversation:updated", { conversationId: conversation.id });

  return {
    userId: String(userId),
    postBannedUntil: until ? until.toISOString() : null,
    reason: until ? banReason : null,
  };
}

/* ═══════════════════════════ XABARLAR ═══════════════════════════ */

/**
 * TARIX — yuqoriga varaqlash (`beforeSeq`) yoki bo'shliqni to'ldirish
 * (`afterSeq`).
 *
 * ⚠️ `clearedSeq` DAN OLDINGISI BERILMAYDI: odam "tarixni tozalash" ni
 * bosgan bo'lsa, u xabarlarni qaytadan ko'rmasligi kerak — lekin
 * boshqalarda ular joyida qoladi.
 */
async function listMessages({ actor, id, beforeSeq, afterSeq, limit }) {
  const { conversation, member, isModerator } = await chatAccess.assertMember(id, actor, {
    allowModerator: true,
  });
  const take = clampPage(limit);
  const floor = member?.clearedSeq ?? 0;

  /**
   * ⚠️ `seq` SHARTI BITTA OBYEKT BO'LIB QURILADI. Spread bilan yozilsa
   * (`{ seq: {...}, ...(beforeSeq ? { seq: {...} } : {}) }`) ikkinchi
   * kalit birinchisini bosib ketadi va `clearedSeq` poli yo'qolardi —
   * "tarixni tozalash" bosgan odam eski xabarlarni qaytadan ko'rardi.
   */
  const seqFilter = { gt: floor };
  if (afterSeq) seqFilter.gt = Math.max(floor, parseInt(afterSeq, 10) || 0);
  if (beforeSeq) seqFilter.lt = parseInt(beforeSeq, 10) || 0;

  const rows = await platformPrisma.message.findMany({
    where: { conversationId: conversation.id, seq: seqFilter },
    orderBy: { seq: afterSeq ? "asc" : "desc" },
    take: take + 1,
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  const items = await presentMessages(page, { isModerator });

  return {
    items: items.sort((a, b) => a.seq - b.seq),
    pagination: {
      nextCursor: hasMore ? String(page[page.length - 1].seq) : null,
      hasMore,
    },
  };
}

/**
 * QAYTA ULANGANDAN KEYINGI SINXRON — bitta so'rov.
 *
 * ⚠️ BU MAJBURIY QADAM, QULAYLIK EMAS: socket `message:new` ni yo'qotishi
 * mumkin (fon rejimi, tarmoq). Ilova qaytganda shu yo'ldan o'tmasa,
 * suhbatda bo'shliq qolib ketardi va u faqat qo'lda varaqlashda
 * to'ldirilardi.
 *
 * @param {{actor: object, since?: string}} input
 */
async function sync({ actor, since }) {
  const userId = String(actor.id);
  const sinceDate = since ? new Date(since) : null;
  if (since && Number.isNaN(sinceDate?.getTime())) {
    throw new BadRequestError("`since` sanasi noto'g'ri (ISO formatda bo'lishi kerak)");
  }

  const memberships = await platformPrisma.conversationMember.findMany({
    where: { userId, leftAt: null },
    select: { conversationId: true, lastReadSeq: true, clearedSeq: true },
  });
  if (memberships.length === 0) {
    return { now: new Date().toISOString(), conversations: [] };
  }

  const ids = memberships.map((m) => m.conversationId);
  const conversations = await platformPrisma.conversation.findMany({
    where: {
      id: { in: ids },
      ...(sinceDate ? { updatedAt: { gt: sinceDate } } : {}),
    },
  });

  const presented = await presentConversations(conversations, userId);
  const floors = new Map(memberships.map((m) => [m.conversationId, m.clearedSeq]));

  const result = [];
  for (const conv of presented) {
    // Har suhbatda O'ZGARGAN xabarlar: yangi, tahrirlangan va o'chirilgan.
    // eslint-disable-next-line no-await-in-loop
    const rows = await platformPrisma.message.findMany({
      where: {
        conversationId: conv.id,
        seq: { gt: floors.get(conv.id) ?? 0 },
        ...(sinceDate
          ? {
              OR: [
                { createdAt: { gt: sinceDate } },
                { editedAt: { gt: sinceDate } },
                { deletedAt: { gt: sinceDate } },
              ],
            }
          : {}),
      },
      orderBy: { seq: "asc" },
      take: 200,
    });

    result.push({
      conversation: conv,
      // eslint-disable-next-line no-await-in-loop
      messages: await presentMessages(rows, {}),
    });
  }

  return { now: new Date().toISOString(), conversations: result };
}

/**
 * XABAR YUBORISH — REST va socket uchun YAGONA yo'l.
 *
 * @param {{actor: object, conversationId: string, body: object, isStaff: boolean}} input
 * @returns {Promise<{message: object, created: boolean}>}
 */
async function sendMessage({ actor, conversationId, body = {}, isStaff }) {
  const userId = String(actor.id);
  const clientId = String(body.clientId || "").trim();
  if (!clientId || clientId.length > 36) {
    throw new BadRequestError("`clientId` majburiy (ilova yaratgan UUID)");
  }

  // ⚠️ IDEMPOTENTLIK TEKSHIRUVI BIRINCHI: qayta yuborilgan xabar
  // darvozalardan (tezlik chegarasi, sekin rejim) O'TMASLIGI kerak —
  // aks holda tarmoq uzilgan odam o'z xabarini qayta yuborib, chegaraga
  // urilib qolardi.
  const existing = await platformPrisma.message.findUnique({
    where: { senderId_clientId: { senderId: userId, clientId } },
  });
  if (existing) {
    if (existing.conversationId !== String(conversationId)) {
      throw new ConflictError("Bu `clientId` boshqa suhbatda ishlatilgan");
    }
    const [presented] = await presentMessages([existing], {});
    return { message: presented, created: false };
  }

  const { conversation, member } = await chatAccess.assertMember(conversationId, actor);
  await chatAccess.assertCanPost({ conversation, member, user: actor, isStaff });

  const type = String(body.type || "text");
  const text = cleanText(body.text, MESSAGE_TEXT_MAX);
  const uploadId = body.uploadId ? String(body.uploadId) : null;

  if (type === "text" && !text) throw new BadRequestError("Xabar matni bo'sh");
  if (MEDIA_TYPES[type] && !uploadId) throw new BadRequestError("Fayl tanlanmagan");
  if (!MEDIA_TYPES[type] && type !== "text" && type !== "story_reply") {
    throw new BadRequestError("Xabar turi noto'g'ri");
  }
  // ⚠️ MEDIA BO'LMAGAN TURGA `uploadId` YUBORILSA — ANIQ XATO, jim
  // o'tkazib yuborilmaydi: aks holda fayl `ready` holatda qolib, 24
  // soatdan keyin tozalovchi tomonidan o'chirilardi va foydalanuvchi
  // "rasmim qayerga ketdi" degan savol bilan qolardi.
  if (uploadId && !MEDIA_TYPES[type]) {
    throw new BadRequestError(`"${type}" turidagi xabarga fayl qo'shilmaydi`);
  }
  // ⚠️ O'QUVCHI VIDEO VA FAYL YUBORMAYDI — tekshiruv yuklash bosqichida
  // ham bor (`socialMedia.helpers.js`), bu ikkinchi qavat: `uploadId`
  // boshqa maqsadda olingan bo'lishi mumkin.
  if (!isStaff && (type === "video" || type === "file")) {
    throw new ForbiddenError("Video va fayl yuborish faqat ustozlar uchun");
  }

  const replyToId = body.replyToId ? String(body.replyToId) : null;
  if (replyToId) {
    const parent = await platformPrisma.message.findUnique({
      where: { id: replyToId },
      select: { conversationId: true },
    });
    if (!parent || parent.conversationId !== conversation.id) {
      throw new BadRequestError("Javob berilayotgan xabar bu suhbatda emas");
    }
  }

  const storyId = body.storyId ? String(body.storyId) : null;

  const message = await platformPrisma.$transaction(async (tx) => {
    const media = uploadId
      ? await mediaService.attachUploadInTx(tx, {
          uploadId,
          ownerId: userId,
          kind: type,
        })
      : null;

    // ⚠️ `seq` SHU YERDA tug'iladi — bitta qatorli qulf (fayl boshidagi izoh).
    const rows = await tx.$queryRawUnsafe(
      `UPDATE ${table("conversation")} SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq`,
      conversation.id,
    );
    const seq = Number(rows?.[0]?.last_seq);
    if (!Number.isFinite(seq) || seq <= 0) {
      throw new ConflictError("Xabar raqami olinmadi — qaytadan urinib ko'ring");
    }

    const created = await tx.message.create({
      data: {
        conversationId: conversation.id,
        seq,
        senderId: userId,
        clientId,
        type,
        text,
        mediaId: media?.id || null,
        replyToId,
        storyId,
        // ⚠️ Faqat BELGILAYDI (`profanity.helpers.js`): xabar baribir
        // yoziladi, sinf rahbari ro'yxatdan ko'radi.
        flagged: Boolean(text) && containsProfanity(text),
      },
    });

    await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: created.createdAt,
        lastPreview: messagePreview({ type, text }, PREVIEW_MAX),
      },
    });

    // Yuboruvchi o'z xabarini O'QIGAN hisoblanadi — aks holda o'zining
    // xabari "o'qilmagan" bo'lib badge'da turardi.
    await tx.conversationMember.update({
      where: { conversationId_userId: { conversationId: conversation.id, userId } },
      data: { lastReadSeq: seq, lastDeliveredSeq: seq },
    });

    return { ...created, media };
  });

  const [presented] = await presentMessages([message], {});
  await fanOut({ conversation, message: presented, senderId: userId, isStaff });

  return { message: presented, created: true };
}

/**
 * XABARNI A'ZOLARGA YETKAZISH: socket + push.
 *
 * ⚠️ PUSH FAQAT OFFLAYN VA OVOZSIZ QILMAGAN a'zolarga: ochiq ilovada
 * xabar socket orqali keladi, ustiga bildirishnoma chiqsa ekranda ikki
 * marta ko'rinardi.
 *
 * ⚠️ `await` QILINMAYDI (push doktrinasi): Firebase ishlamay qolsa,
 * xabar BAZAGA YOZILGAN va u yo'qolmaydi — chaqiruvchi xato ko'rmasligi
 * kerak.
 */
async function fanOut({ conversation, message, senderId, isStaff }) {
  const members = await platformPrisma.conversationMember.findMany({
    where: { conversationId: conversation.id, leftAt: null },
    select: { userId: true, mutedUntil: true },
  });

  const others = members.filter((m) => m.userId !== senderId);
  const userIds = others.map((m) => m.userId);

  emitter.emitToUsers([...userIds, senderId], "message:new", {
    conversationId: conversation.id,
    message,
  });

  const now = new Date();
  const pushable = others
    .filter((m) => !m.mutedUntil || m.mutedUntil <= now)
    .map((m) => m.userId);
  if (pushable.length === 0) return;

  try {
    const offline = await emitter.filterOffline(pushable);
    if (offline.length === 0) return;

    const senderCard = await socialAccess.loadUserCard(senderId);
    const payload = chatMessagePush({
      conversation,
      message,
      senderName: senderCard?.fullName || "Xodim",
    });

    // ⚠️ OTA-ONA TELEFONIGA TUSHMAYDI va buning uchun qo'shimcha
    // `channels` BERILMAYDI: `sendToUsers` `channels` siz chaqirilganda
    // `parent` seanslarini ALLAQACHON chiqarib tashlaydi
    // (`push.service.js` → `OPT_IN_CHANNELS`). Bu yerda
    // `channels: ["student"]` yozilsa, AYNI sinf guruhidagi USTOZLAR
    // (seansi `teacher`/`worker`) push olmay qolardi — ya'ni "ehtiyotkorlik"
    // amalda xabarni yo'qotardi.
    //
    // ⚠️ TUNGI SUKUNAT: o'quvchi xabari 22:00–07:00 da OVOZSIZ ketadi
    // (biznes qarori) — xabar yo'qolmaydi, faqat jiringlamaydi.
    const silent = conversation.type === "class" && !isStaff && isQuietHours();

    pushService.sendToUsers(offline, {
      ...payload,
      ...(silent ? { silent: true } : {}),
    });
  } catch (error) {
    logger.warn(`[chat] push yuborishda xato: ${error.message}`);
  }
}

/**
 * TAHRIRLASH — faqat matn, faqat muallif, 48 soat ichida.
 *
 * ⚠️ `seq` O'ZGARMAYDI: u suhbatdagi O'RIN. Tahrirlangan xabar ro'yxat
 * oxiriga ko'chib ketmasligi kerak.
 */
async function editMessage({ actor, messageId, text }) {
  const message = await platformPrisma.message.findUnique({ where: { id: String(messageId) } });
  if (!message || message.deletedAt) throw new NotFoundError("Xabar topilmadi");
  if (message.senderId !== String(actor.id)) {
    throw new ForbiddenError("Faqat o'z xabaringizni tahrirlaysiz");
  }
  if (message.type !== "text") throw new BadRequestError("Faqat matnli xabar tahrirlanadi");
  if (Date.now() - message.createdAt.getTime() > EDIT_WINDOW_MS) {
    throw new ForbiddenError("Tahrirlash muddati tugagan (48 soat)");
  }

  const clean = cleanText(text, MESSAGE_TEXT_MAX);
  if (!clean) throw new BadRequestError("Xabar matni bo'sh");

  await chatAccess.assertMember(message.conversationId, actor);

  const updated = await platformPrisma.message.update({
    where: { id: message.id },
    data: { text: clean, editedAt: new Date(), flagged: containsProfanity(clean) },
  });

  const [presented] = await presentMessages([updated], {});
  await notifyMessageUpdated(message.conversationId, presented);
  return presented;
}

/**
 * O'CHIRISH.
 *
 * ⚠️ SOFT DELETE (`deletedAt`): qator bazada QOLADI va `chat.moderate`
 * ruxsatli rahbar uni ko'ra oladi — haqorat yoki bezorilik bo'yicha
 * shikoyatni tekshirish uchun. Butunlay o'chirilsa, shikoyat kelganda
 * ko'rsatadigan narsa qolmasdi.
 *
 * ⚠️ MUDDAT ROLGA QARAB BOSHQA: o'quvchi 10 daqiqa, xodim 48 soat,
 * guruh admini va moderator — HAR DOIM.
 */
async function deleteMessage({ actor, messageId, isStaff }) {
  const message = await platformPrisma.message.findUnique({ where: { id: String(messageId) } });
  if (!message) throw new NotFoundError("Xabar topilmadi");
  if (message.deletedAt) return { id: message.id, deleted: true };

  const { conversation, member } = await chatAccess.assertMember(message.conversationId, actor, {
    allowModerator: true,
  });

  const me = String(actor.id);
  const isMine = message.senderId === me;
  const window = isStaff ? EDIT_WINDOW_MS : STUDENT_DELETE_WINDOW_MS;
  const inWindow = Date.now() - message.createdAt.getTime() <= window;

  const isAdmin = member?.role === "admin" || member?.role === "owner";
  const allowed =
    socialAccess.isChatModerator(actor) || isAdmin || (isMine && inWindow);

  if (!allowed) {
    throw new ForbiddenError(
      isMine
        ? `O'chirish muddati tugagan (${isStaff ? "48 soat" : "10 daqiqa"})`
        : "Bu xabarni o'chirish huquqi sizda yo'q",
    );
  }

  const updated = await platformPrisma.message.update({
    where: { id: message.id },
    data: { deletedAt: new Date(), deletedBy: me },
  });

  const [presented] = await presentMessages([updated], {});
  await notifyMessageUpdated(conversation.id, presented);
  return presented;
}

/**
 * O'QILDI.
 *
 * ⚠️ ORQAGA KETMAYDI (`GREATEST`): ikki telefonli odamda eski ekran
 * yangisini "o'qilmagan" holatga qaytarib yuborardi.
 */
async function markRead({ actor, id, seq }) {
  const { conversation, member } = await chatAccess.assertMember(id, actor);
  const target = Math.min(parseInt(seq, 10) || 0, conversation.lastSeq);
  if (target <= member.lastReadSeq) {
    return { conversationId: conversation.id, lastReadSeq: member.lastReadSeq };
  }

  const updated = await platformPrisma.conversationMember.update({
    where: { conversationId_userId: { conversationId: conversation.id, userId: member.userId } },
    data: { lastReadSeq: target, lastDeliveredSeq: Math.max(target, member.lastDeliveredSeq) },
  });

  // Suhbatdoshlarga "o'qildi" belgisi.
  const others = await platformPrisma.conversationMember.findMany({
    where: { conversationId: conversation.id, leftAt: null, userId: { not: member.userId } },
    select: { userId: true },
  });
  emitter.emitToUsers(
    others.map((o) => o.userId),
    "conversation:read",
    { conversationId: conversation.id, userId: member.userId, seq: target },
  );

  // O'SHA ODAMNING BOSHQA QURILMALARI — jim push bilan: telefondagi
  // bildirishnoma o'zi yo'qolishi kerak.
  pushService.sendToUsers([member.userId], chatReadPush({ conversationId: conversation.id, seq: target }));

  return { conversationId: conversation.id, lastReadSeq: updated.lastReadSeq };
}

/** KIM O'QIGAN (guruhda). */
async function listReaders({ actor, messageId }) {
  const message = await platformPrisma.message.findUnique({ where: { id: String(messageId) } });
  if (!message) throw new NotFoundError("Xabar topilmadi");
  await chatAccess.assertMember(message.conversationId, actor);

  const rows = await platformPrisma.conversationMember.findMany({
    where: {
      conversationId: message.conversationId,
      leftAt: null,
      lastReadSeq: { gte: message.seq },
      userId: { not: message.senderId },
    },
    select: { userId: true, lastReadSeq: true },
  });

  const cards = await socialAccess.loadUserCards(rows.map((r) => r.userId));
  return { items: rows.map((r) => ({ user: cards.get(r.userId) || null })) };
}

/** A'ZOLAR RO'YXATI. */
async function listMembers({ actor, id }) {
  const { conversation } = await chatAccess.assertMember(id, actor, { allowModerator: true });
  const rows = await platformPrisma.conversationMember.findMany({
    where: { conversationId: conversation.id, leftAt: null },
    orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
  });
  const cards = await socialAccess.loadUserCards(rows.map((r) => r.userId));

  return {
    conversationId: conversation.id,
    type: conversation.type,
    items: rows.map((row) => ({
      user: cards.get(row.userId) || null,
      role: row.role,
      source: row.source,
      postBannedUntil: row.postBannedUntil ? row.postBannedUntil.toISOString() : null,
      joinedAt: row.joinedAt.toISOString(),
    })),
  };
}

/* ═══════════════════════════ YORDAMCHI ═══════════════════════════ */

/**
 * TIZIM XABARI — "Ali guruhga qo'shildi".
 *
 * ⚠️ `seq` OLADI va suhbatda ko'rinadi: a'zolik o'zgarishi suhbatning
 * TARIXI, chetdagi jurnal emas. Shu sababli u ham xabarlar oqimiga
 * tushadi va sinxron orqali ilovaga yetib boradi.
 */
async function addSystemMessage(conversationId, { addedIds = [], removedIds = [], actorId, selfLeave = false }) {
  if (addedIds.length === 0 && removedIds.length === 0) return null;

  const cards = await socialAccess.loadUserCards([...addedIds, ...removedIds]);
  const name = (id) => cards.get(id)?.fullName || "Xodim";
  const parts = [];
  if (addedIds.length) parts.push(`${addedIds.map(name).join(", ")} guruhga qo'shildi`);
  if (removedIds.length) {
    parts.push(
      selfLeave
        ? `${removedIds.map(name).join(", ")} guruhdan chiqdi`
        : `${removedIds.map(name).join(", ")} guruhdan chiqarildi`,
    );
  }
  const text = parts.join("; ");

  try {
    return await platformPrisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE ${table("conversation")} SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq`,
        conversationId,
      );
      const seq = Number(rows?.[0]?.last_seq);

      const message = await tx.message.create({
        data: {
          conversationId,
          seq,
          senderId: String(actorId),
          // ⚠️ `clientId` SERVER tomonda hosil qilinadi va `sys:` bilan
          // boshlanadi: `senderId + clientId` yagona indeksi ilovaning
          // UUID'lari bilan to'qnashmasligi kerak.
          clientId: `sys:${seq}:${conversationId}`.slice(0, 36),
          type: "system",
          text,
        },
      });

      await tx.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: message.createdAt, lastPreview: text.slice(0, PREVIEW_MAX) },
      });

      return message;
    });
  } catch (error) {
    // ⚠️ TIZIM XABARI ASOSIY AMALNI YIQITMAYDI: a'zo allaqachon
    // qo'shilgan, uning haqida xabar yozilmay qolsa ham a'zolik to'g'ri.
    logger.warn(`[chat] tizim xabari yozilmadi: ${error.message}`);
    return null;
  }
}

/** Suhbat o'zgardi — a'zolarga xabar. */
async function notifyConversationUpdated(conversationId) {
  const members = await platformPrisma.conversationMember.findMany({
    where: { conversationId, leftAt: null },
    select: { userId: true },
  });
  emitter.emitToUsers(
    members.map((m) => m.userId),
    "conversation:updated",
    { conversationId },
  );
}

/** Xabar tahrirlandi / o'chirildi. */
async function notifyMessageUpdated(conversationId, message) {
  const members = await platformPrisma.conversationMember.findMany({
    where: { conversationId, leftAt: null },
    select: { userId: true },
  });
  emitter.emitToUsers(
    members.map((m) => m.userId),
    "message:updated",
    { conversationId, message },
  );
}

/**
 * Xabarlarni javob shakliga keltiradi.
 *
 * ⚠️ O'CHIRILGAN XABARNING MATNI BERILMAYDI (moderatordan tashqari):
 * `deletedAt` bo'lsa ilova "xabar o'chirildi" deb chizadi. Matn
 * qaytarilsa, "hamma uchun o'chirish" ma'nosini yo'qotardi.
 */
async function presentMessages(rows = [], { isModerator = false } = {}) {
  if (rows.length === 0) return [];

  const mediaIds = rows.map((r) => r.mediaId).filter(Boolean);
  const mediaRows = mediaIds.length
    ? await platformPrisma.mediaUpload.findMany({ where: { id: { in: mediaIds } } })
    : [];
  const mediaMap = new Map();
  for (const row of mediaRows) {
    // eslint-disable-next-line no-await-in-loop
    mediaMap.set(row.id, await mediaService.present(row));
  }

  const cards = await socialAccess.loadUserCards(rows.map((r) => r.senderId));

  return rows.map((row) => {
    const deleted = Boolean(row.deletedAt);
    return {
      id: row.id,
      conversationId: row.conversationId,
      seq: row.seq,
      clientId: row.clientId,
      type: row.type,
      text: deleted && !isModerator ? null : row.text,
      media: deleted && !isModerator ? null : mediaMap.get(row.mediaId) || null,
      replyToId: row.replyToId,
      storyId: row.storyId,
      forwardedFromId: row.forwardedFromId,
      flagged: row.flagged,
      sender: cards.get(row.senderId) || null,
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt ? row.editedAt.toISOString() : null,
      deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    };
  });
}

function clampPage(limit) {
  const n = parseInt(limit, 10);
  if (!Number.isFinite(n) || n <= 0) return PAGE;
  return Math.min(PAGE_MAX, n);
}

module.exports = {
  MAX_GROUP_MEMBERS,
  EDIT_WINDOW_MS,
  STUDENT_DELETE_WINDOW_MS,
  listConversations,
  openDirect,
  createGroup,
  updateConversation,
  addMembers,
  removeMember,
  leave,
  updateMyState,
  banMember,
  listMessages,
  listMembers,
  sync,
  sendMessage,
  editMessage,
  deleteMessage,
  markRead,
  listReaders,
  addSystemMessage,
  presentMessages,
  presentConversations,
};
