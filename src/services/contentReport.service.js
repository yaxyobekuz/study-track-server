/**
 * SHIKOYATLAR — istoriya, izoh va xabar ustidan.
 *
 * ⚠️ SHIKOYAT KONTENTNI O'CHIRMAYDI. U faqat moderatorning ro'yxatiga
 * qator qo'shadi: avtomatik yashirish bo'lsa, bitta odam bir necha
 * bosishda begona istoriyani lentadan olib tashlab qo'yardi.
 *
 * ⚠️ BIR ODAM BIR NISHONGA BIR MARTA (`@@unique`): takroriy bosish
 * ro'yxatni bir xil qatorlar bilan to'ldirmasin. Ikkinchi marta
 * yuborilgan shikoyat XATO EMAS — "qabul qilindi" deb qaytadi, chunki
 * foydalanuvchi uchun natija AYNI (shikoyat qilingan).
 *
 * ⚠️ MODERATORLAR JORIY FILIALDAN topiladi. Kontent butun tarmoqqa
 * ko'rinadi, lekin "kim ko'rib chiqadi" degan savol filialning ishi:
 * ruxsatlar har filialda alohida (`User.permissions`, root `CLAUDE.md`).
 * Hamma filialni skanerlash har shikoyatda N ta so'rov bo'lardi.
 */

const prisma = require("../config/prisma");
const platformPrisma = require("../config/platformPrisma");
const socialAccess = require("./socialAccess.service");
const pushService = require("./push.service");
const mediaService = require("./mediaUpload.service");
const logger = require("../utils/logger");
const { ROLES } = require("../utils/constants");
const { PERMISSIONS } = require("../utils/permissions");
const { BadRequestError, NotFoundError, ForbiddenError } = require("../utils/errors");
const { cleanText } = require("../helpers/socialMedia.helpers");
const { reportPush } = require("../helpers/socialPush.helpers");

const TARGET_TYPES = Object.freeze(["story", "story_comment", "message"]);
const REASON_MAX = 300;

/**
 * Shikoyat yozadi.
 *
 * @param {{actor: object, body: {targetType: string, targetId: string, reason: string}}} input
 */
async function create({ actor, body = {} }) {
  const targetType = String(body.targetType || "");
  if (!TARGET_TYPES.includes(targetType)) {
    throw new BadRequestError(`Nishon turi noto'g'ri — ${TARGET_TYPES.join(" / ")}`);
  }
  const targetId = String(body.targetId || "").trim();
  if (!targetId) throw new BadRequestError("Nishon ko'rsatilmagan");

  const reason = cleanText(body.reason, REASON_MAX);
  if (!reason) throw new BadRequestError("Sabab majburiy");

  await assertTargetExists(targetType, targetId);

  const existing = await platformPrisma.contentReport.findUnique({
    where: {
      reporterId_targetType_targetId: {
        reporterId: String(actor.id),
        targetType,
        targetId,
      },
    },
  });
  // ⚠️ TAKROR XATO BERMAYDI (izoh fayl boshida).
  if (existing) return { id: existing.id, created: false };

  const report = await platformPrisma.contentReport.create({
    data: { reporterId: String(actor.id), targetType, targetId, reason },
  });

  await notifyModerators(targetType, targetId);

  return { id: report.id, created: true };
}

/**
 * MODERATORLAR RO'YXATI — shikoyatlar.
 *
 * @param {{actor: object, skip: number, limit: number, resolved?: boolean}} input
 */
async function list({ actor, skip = 0, limit = 30, resolved = false }) {
  assertModerator(actor);

  const where = resolved ? { resolvedAt: { not: null } } : { resolvedAt: null };
  const [total, rows] = await Promise.all([
    platformPrisma.contentReport.count({ where }),
    platformPrisma.contentReport.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
  ]);

  const cards = await socialAccess.loadUserCards([
    ...rows.map((r) => r.reporterId),
    ...rows.map((r) => r.resolvedBy).filter(Boolean),
  ]);

  const items = [];
  for (const row of rows) {
    items.push({
      id: row.id,
      targetType: row.targetType,
      targetId: row.targetId,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
      reporter: cards.get(row.reporterId) || null,
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      resolvedBy: row.resolvedBy ? cards.get(row.resolvedBy) || null : null,
      resolveNote: row.resolveNote,
      // ⚠️ NISHONNING O'ZI HAM BERILADI: moderator "nimaga shikoyat
      // qilingan" ni ko'rmasa, qarorni qabul qila olmaydi. O'chirilgan
      // xabar matni ham ko'rinadi (`chat.moderate` doktrinasi).
      // eslint-disable-next-line no-await-in-loop
      target: await loadTarget(row.targetType, row.targetId),
    });
  }

  return { total, items };
}

/** Ko'rib chiqildi deb belgilaydi. */
async function resolve({ actor, id, note }) {
  assertModerator(actor);

  const report = await platformPrisma.contentReport.findUnique({ where: { id: String(id) } });
  if (!report) throw new NotFoundError("Shikoyat topilmadi");
  if (report.resolvedAt) return { id: report.id, resolved: true };

  await platformPrisma.contentReport.update({
    where: { id: report.id },
    data: {
      resolvedAt: new Date(),
      resolvedBy: String(actor.id),
      resolveNote: cleanText(note, REASON_MAX),
    },
  });

  return { id: report.id, resolved: true };
}

/* ───────────────────────────── YORDAMCHI ───────────────────────────── */

function assertModerator(actor) {
  if (!socialAccess.isStoryModerator(actor) && !socialAccess.isChatModerator(actor)) {
    throw new ForbiddenError("Shikoyatlarni ko'rish huquqi sizda yo'q");
  }
}

async function assertTargetExists(targetType, targetId) {
  if (targetType === "story") {
    const row = await platformPrisma.story.findUnique({ where: { id: targetId } });
    if (!row) throw new NotFoundError("Istoriya topilmadi");
    return;
  }
  if (targetType === "story_comment") {
    const row = await platformPrisma.storyComment.findUnique({ where: { id: targetId } });
    if (!row) throw new NotFoundError("Izoh topilmadi");
    return;
  }
  const row = await platformPrisma.message.findUnique({ where: { id: targetId } });
  if (!row) throw new NotFoundError("Xabar topilmadi");
}

/** Nishonning mazmuni — moderator ekrani uchun. */
async function loadTarget(targetType, targetId) {
  try {
    if (targetType === "story") {
      const row = await platformPrisma.story.findUnique({
        where: { id: targetId },
        include: { media: true },
      });
      if (!row) return null;
      return {
        kind: "story",
        caption: row.caption,
        media: await mediaService.present(row.media),
        author: await socialAccess.loadUserCard(row.authorId),
        createdAt: row.createdAt.toISOString(),
        deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
      };
    }

    if (targetType === "story_comment") {
      const row = await platformPrisma.storyComment.findUnique({ where: { id: targetId } });
      if (!row) return null;
      return {
        kind: "story_comment",
        text: row.text,
        storyId: row.storyId,
        author: await socialAccess.loadUserCard(row.authorId),
        createdAt: row.createdAt.toISOString(),
        deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
      };
    }

    const row = await platformPrisma.message.findUnique({ where: { id: targetId } });
    if (!row) return null;
    return {
      kind: "message",
      // ⚠️ O'CHIRILGAN XABAR MATNI HAM KO'RINADI: shikoyat aynan
      // o'chirilgan xabar ustidan kelishi odatiy hol.
      text: row.text,
      type: row.type,
      conversationId: row.conversationId,
      sender: await socialAccess.loadUserCard(row.senderId),
      createdAt: row.createdAt.toISOString(),
      deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    };
  } catch (error) {
    logger.warn(`[social] shikoyat nishoni o'qilmadi: ${error.message}`);
    return null;
  }
}

/**
 * Moderatorlarga push.
 *
 * ⚠️ `await` QILINMAYDI va xatosi YUTILADI: shikoyat bazaga yozilgan,
 * Firebase ishlamay qolsa foydalanuvchi "shikoyat yuborilmadi" degan
 * soxta xato ko'rmasligi kerak (push doktrinasi).
 */
async function notifyModerators(targetType, targetId) {
  try {
    const key =
      targetType === "message" ? PERMISSIONS.CHAT_MODERATE : PERMISSIONS.STORIES_MODERATE;
    const section = key.split(".")[0];

    const moderators = await prisma.user.findMany({
      where: {
        isArchived: false,
        isActive: true,
        OR: [
          { role: ROLES.OWNER },
          { extraRoles: { has: ROLES.OWNER } },
          { permissions: { has: key } },
          // Bare bo'lim kaliti bo'limning HAMMA amalini beradi (`permissions.js`)
          { permissions: { has: section } },
        ],
      },
      select: { id: true },
    });
    if (moderators.length === 0) return;

    pushService.sendToUsers(
      moderators.map((m) => m.id),
      reportPush({ targetType, targetId }),
    );
  } catch (error) {
    logger.warn(`[social] moderatorlarga xabar bermadi: ${error.message}`);
  }
}

module.exports = { TARGET_TYPES, create, list, resolve };
