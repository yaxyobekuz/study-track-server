/**
 * CHATDA KIM NIMANI QILA OLADI — darvozalar BITTA joyda.
 *
 * Qoida bitta jumlada:
 *
 * > Huquq A'ZOLIKDAN keladi: `conversation_member` qatori bo'lmasa, suhbat
 * > odam uchun MAVJUD EMAS (404 emas, 403 — "a'zo emassiz").
 *
 * ⚠️ HAR SO'ROVDA QAYTA TEKSHIRILADI (`/tutor-groups/my` doktrinasi):
 * a'zolik oraliqda olib qo'yilgan bo'lsa (sinf sinxroni o'quvchini boshqa
 * guruhga ko'chirdi), eskirgan ekran begona suhbatni o'qiy olmaydi.
 *
 * ⚠️ `conversationId` NI ALMASHTIRIB BOSHQA SUHBATNI O'QIB BO'LMAYDI va
 * buning uchun alohida test bor (`test/social/chatAccess.test.js`): butun
 * modulning eng xavfli teshigi aynan shu.
 *
 * ⚠️ TO'RT XIL TO'SIQ BOR va ularni aralashtirmang:
 *   closedAt         — SUHBAT yopilgan (sinf bitirdi): hamma uchun, o'qish
 *                      mumkin, yozish yo'q
 *   onlyStaffPost    — E'LON REJIMI: faqat o'quvchiga ta'sir qiladi
 *   postBannedUntil  — BITTA o'quvchi vaqtincha ovozsiz
 *   slowModeSec      — o'quvchi xabarlari orasidagi minimal vaqt
 */

const platformPrisma = require("../config/platformPrisma");
const { ForbiddenError, NotFoundError, TooManyRequestsError } = require("../utils/errors");
const { formatTimeUz } = require("../helpers/date.helpers");
const socialAccess = require("./socialAccess.service");

/** Xato kodlari — MOBIL ILOVA BILAN SHARTNOMA (`docs/social-api.md`). */
const CODES = Object.freeze({
  NOT_MEMBER: "NOT_MEMBER",
  POST_BANNED: "POST_BANNED",
  CONVERSATION_CLOSED: "CONVERSATION_CLOSED",
  ONLY_STAFF_POST: "ONLY_STAFF_POST",
  SLOW_MODE: "SLOW_MODE",
  RATE_LIMITED: "RATE_LIMITED",
  CLASS_GROUP_IMMUTABLE: "CLASS_GROUP_IMMUTABLE",
});

/**
 * YOZISH TEZLIGI — xodim 30 xabar/daqiqa, o'quvchi 10.
 *
 * ⚠️ XOTIRADA va bu ONGLI tanlov: chegara spamni cheklash uchun, buxgalteriya
 * uchun emas. Bazaga yozilsa, har xabar uchun qo'shimcha `INSERT` bo'lardi;
 * bir nechta nusxada esa chegara nusxaga bo'linadi — bu ham yetarli
 * (`express-rate-limit` ning standart xatti-harakati bilan AYNI).
 */
const RATE_WINDOW_MS = 60_000;
const RATE_STAFF = 30;
const RATE_STUDENT = 10;
const rateBuckets = new Map();

/**
 * Tezlik chegarasini tekshiradi va hisobga oladi.
 *
 * @param {{id: string}} user
 * @param {boolean} isStaff
 */
function assertSendRate(user, isStaff) {
  const limit = isStaff ? RATE_STAFF : RATE_STUDENT;
  const now = Date.now();
  const key = String(user.id);

  const bucket = (rateBuckets.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (bucket.length >= limit) {
    const error = new TooManyRequestsError(
      `Juda ko'p xabar yuborildi — bir daqiqada ${limit} tadan oshmaydi`,
    );
    error.details = { code: CODES.RATE_LIMITED, limit, windowSec: RATE_WINDOW_MS / 1000 };
    throw error;
  }

  bucket.push(now);
  rateBuckets.set(key, bucket);

  // Xotira o'smasligi uchun: faolsiz kalitlar tozalanadi.
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (v.every((t) => now - t >= RATE_WINDOW_MS)) rateBuckets.delete(k);
    }
  }
}

/** Test uchun: chegarani tozalaydi. */
function resetRateLimits() {
  rateBuckets.clear();
}

/* ─────────────────────────── A'ZOLIK ─────────────────────────── */

/**
 * Suhbat + MENING a'zoligim. A'zo bo'lmasam — 403.
 *
 * ⚠️ 404 EMAS, 403: "topilmadi" degan javob suhbat BORLIGINI yoki
 * YO'QLIGINI aytib berardi, ya'ni id larni tekshirib chiqish yo'li
 * bo'lardi. Moderator esa (`chat.moderate`) a'zo bo'lmasa ham ko'radi.
 *
 * @param {string} conversationId
 * @param {object} user - `req.user`
 * @param {{allowModerator?: boolean}} [options]
 * @returns {Promise<{conversation: object, member: object|null, isModerator: boolean}>}
 */
async function assertMember(conversationId, user, { allowModerator = false } = {}) {
  const conversation = await platformPrisma.conversation.findUnique({
    where: { id: String(conversationId) },
  });
  if (!conversation) throw new NotFoundError("Suhbat topilmadi");

  // ⚠️ KOMPOZIT KALIT PRISMA'DA `conversationId_userId` NOMI BILAN
  // beriladi — maydonlarni to'g'ridan-to'g'ri yozish ish vaqtida xato
  // beradi (`AtLeast<..., "conversationId_userId">`).
  const member = await platformPrisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: conversation.id, userId: String(user.id) } },
  });

  const isModerator = socialAccess.isChatModerator(user);

  if (!member || member.leftAt) {
    if (allowModerator && isModerator) return { conversation, member: null, isModerator };
    const error = new ForbiddenError("Siz bu suhbatning a'zosi emassiz");
    error.details = { code: CODES.NOT_MEMBER };
    throw error;
  }

  return { conversation, member, isModerator };
}

/* ─────────────────────────── YOZISH ─────────────────────────── */

/**
 * Yozish mumkinmi — to'rtta to'siq ketma-ket tekshiriladi.
 *
 * ⚠️ TARTIB MUHIM: avval SUHBAT holati (hamma uchun), keyin SHAXSIY
 * taqiq. Teskari bo'lsa, yopilgan sinfda ovozsiz qilingan o'quvchi
 * "siz 18:00 gacha yoza olmaysiz" degan noto'g'ri sababni ko'rardi —
 * holbuki guruh butunlay yopilgan.
 *
 * @param {{conversation: object, member: object, user: object, isStaff: boolean}} input
 */
async function assertCanPost({ conversation, member, user, isStaff }) {
  if (conversation.closedAt) {
    const error = new ForbiddenError("Bu suhbat yopilgan — faqat o'qish mumkin");
    error.details = { code: CODES.CONVERSATION_CLOSED };
    throw error;
  }

  if (!isStaff) {
    if (conversation.onlyStaffPost) {
      const error = new ForbiddenError("Bu guruhda faqat ustozlar yozadi");
      error.details = { code: CODES.ONLY_STAFF_POST };
      throw error;
    }

    if (member.postBannedUntil && member.postBannedUntil > new Date()) {
      const error = new ForbiddenError(
        `Siz ${formatTimeUz(member.postBannedUntil)} gacha yoza olmaysiz`,
      );
      error.details = {
        code: CODES.POST_BANNED,
        until: member.postBannedUntil.toISOString(),
        reason: member.postBanReason || null,
      };
      throw error;
    }

    if (conversation.slowModeSec > 0) {
      const last = await platformPrisma.message.findFirst({
        where: { conversationId: conversation.id, senderId: String(user.id) },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (last) {
        const waitMs = conversation.slowModeSec * 1000 - (Date.now() - last.createdAt.getTime());
        if (waitMs > 0) {
          const error = new TooManyRequestsError(
            `Sekin rejim: ${Math.ceil(waitMs / 1000)} sekunddan keyin yozing`,
          );
          error.details = { code: CODES.SLOW_MODE, waitSec: Math.ceil(waitMs / 1000) };
          throw error;
        }
      }
    }
  }

  assertSendRate(user, isStaff);
}

/* ─────────────────────── BOSHQARISH ─────────────────────── */

/**
 * Guruhni sozlash / a'zo qo'shish huquqi: `owner` yoki `admin`.
 *
 * ⚠️ SINF GURUHIDA A'ZOLIK QO'LDA O'ZGARMAYDI (`classChat.service.js`
 * sinxronlaydi): aks holda qo'lda chiqarilgan o'quvchi kechasi sinxron
 * bilan qaytib kelardi va admin "ishlamayapti" deb o'ylardi.
 *
 * @param {{conversation: object, member: object|null, user: object}} input
 */
function assertCanManage({ conversation, member, user }) {
  if (socialAccess.isChatModerator(user)) return;
  if (conversation.type === "class" && !socialAccess.canManageClassGroups(user)) {
    // Sinf guruhida "admin" — o'qituvchi/tyutor: u e'lon rejimini
    // yoqadi va o'quvchini ovozsiz qiladi, lekin a'zolikka tegmaydi.
    if (member?.role === "admin" || member?.role === "owner") return;
    throw new ForbiddenError("Bu guruhni sozlash huquqi sizda yo'q");
  }
  if (member?.role === "admin" || member?.role === "owner") return;
  throw new ForbiddenError("Bu guruhni sozlash huquqi sizda yo'q");
}

/** Sinf guruhida a'zolikni qo'lda o'zgartirish — har doim rad etiladi. */
function assertMembershipEditable(conversation) {
  if (conversation.type === "class") {
    const error = new ForbiddenError(
      "Sinf guruhining a'zolari avtomatik sinxronlanadi — qo'lda o'zgartirilmaydi",
    );
    error.details = { code: CODES.CLASS_GROUP_IMMUTABLE };
    throw error;
  }
  if (conversation.type === "direct") {
    throw new ForbiddenError("Shaxsiy yozishmaga a'zo qo'shilmaydi");
  }
}

module.exports = {
  CODES,
  RATE_STAFF,
  RATE_STUDENT,
  assertMember,
  assertCanPost,
  assertCanManage,
  assertMembershipEditable,
  assertSendRate,
  resetRateLimits,
};
