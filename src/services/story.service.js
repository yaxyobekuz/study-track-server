/**
 * ISTORIYALAR — xodimlarning kunlik rasm/video lentasi.
 *
 * Qoida bitta jumlada:
 *
 * > Xodim kuniga 3 ta istoriya qo'yadi; u 24 soat LENTADA turadi, keyin
 * > muallif PROFILIDA doimiy qoladi va faqat muallifning o'z qo'li bilan
 * > yo'qoladi.
 *
 * ⚠️ KUNLIK LIMIT POYGASIZ BO'LISHI SHART. Ikki tugmani bir vaqtda bosish
 * (yoki ikki telefon) 4-chi istoriya bermasligi kerak, shuning uchun
 * sanoq ADVISORY LOCK ichida bajariladi: `count` → tekshir → `insert`
 * ketma-ketligi qulfsiz bo'lsa, ikkala so'rov ham "2 ta bor" deb ko'rib,
 * ikkalasi ham yozib ketardi.
 *
 * ⚠️ O'CHIRILGANI HAM HISOBLANADI. Aks holda "qo'y → o'chir → qo'y"
 * bilan limitni cheksiz aylanib o'tib bo'lardi. Shuning uchun qator
 * O'CHIRILMAYDI (`deletedAt` qo'yiladi) va sanoqdan chiqmaydi.
 *
 * ⚠️ KUN — TOSHKENT KUNI (`tashkentDayKey`, `helpers/lessonHours.js`).
 * `new Date().toISOString().slice(0,10)` ISHLATILMAYDI: u UTC kuni va
 * 00:30 da qo'yilgan istoriya kechagi hisobga tushib, odamga qo'shimcha
 * imkon berardi.
 *
 * ⚠️ KO'RGANLAR VA LAYKLAR RO'YXATI — FAQAT MUALLIFGA (va moderatorga),
 * IZOHLAR esa hammaga (biznes qarori, 2026-11-26). Boshqalar faqat SONni
 * ko'radi — Telegramdagidek.
 */

const platformPrisma = require("../config/platformPrisma");
const mediaService = require("./mediaUpload.service");
const socialAccess = require("./socialAccess.service");
const pushService = require("./push.service");
const emitter = require("../realtime/emitter");
const logger = require("../utils/logger");
const { config } = require("../config/env.config");
const { tashkentDayKey } = require("../helpers/lessonHours");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  TooManyRequestsError,
} = require("../utils/errors");
const {
  STORY_CAPTION_MAX,
  STORY_COMMENT_MAX,
  cleanText,
} = require("../helpers/socialMedia.helpers");
const { storyCommentPush } = require("../helpers/socialPush.helpers");
const { containsProfanity } = require("../helpers/profanity.helpers");

/** Lentadagi umr — 24 soat. */
const FEED_TTL_MS = 24 * 3600 * 1000;

/** Bir paketda yuboriladigan ko'rishlar soni. */
const MAX_VIEW_BATCH = 50;

/** Ro'yxatlarning sahifasi. */
const LIST_LIMIT = 30;
const LIST_LIMIT_MAX = 100;

/** Xato kodi — mobil ilova shu bo'yicha oyna ko'rsatadi. */
const DAILY_LIMIT_CODE = "STORY_DAILY_LIMIT";

/* ───────────────────────────── KVOTA ───────────────────────────── */

/**
 * Toshkent kunining TUGASHI (UTC instant) — limit qachon tiklanadi.
 *
 * ⚠️ Mahalliy `setHours` ISHLATILMAYDI: server mintaqasi UTC bo'lsa ham,
 * Toshkent yarim tuni UTC da 19:00. Hisob `tashkentDayKey` bilan AYNI
 * usulda (+5 soat) olinadi.
 *
 * @param {Date} [at]
 * @returns {Date}
 */
function tashkentDayEnd(at = new Date()) {
  const shifted = new Date(at.getTime() + 5 * 3600000);
  const nextMidnightUtcShifted = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + 1,
  );
  return new Date(nextMidnightUtcShifted - 5 * 3600000);
}

/**
 * Bugun qancha qoldi.
 *
 * @param {{id: string}} actor
 * @returns {Promise<{limit: number, used: number, remaining: number, resetsAt: string}>}
 */
async function getQuota(actor) {
  const dayKey = tashkentDayKey(new Date());
  const used = await platformPrisma.story.count({
    where: { authorId: String(actor.id), dayKey },
  });
  const limit = config.storyDailyLimit;

  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resetsAt: tashkentDayEnd().toISOString(),
  };
}

/* ──────────────────────────── YARATISH ──────────────────────────── */

/**
 * Istoriya qo'yadi.
 *
 * @param {{ actor: object, branchId: string, body: {uploadId: string, caption?: string} }} input
 * @returns {Promise<object>}
 */
async function createStory({ actor, branchId, body = {} }) {
  const uploadId = String(body.uploadId || "").trim();
  if (!uploadId) throw new BadRequestError("Fayl tanlanmagan");

  const caption = cleanText(body.caption, STORY_CAPTION_MAX);
  const dayKey = tashkentDayKey(new Date());
  const limit = config.storyDailyLimit;

  const story = await platformPrisma.$transaction(async (tx) => {
    // ⚠️ QULF SANOQDAN OLDIN: izoh fayl boshida.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`story:${actor.id}`}))`;

    const used = await tx.story.count({ where: { authorId: String(actor.id), dayKey } });
    if (used >= limit) {
      const error = new TooManyRequestsError(
        `Bugun ${limit} ta istoriya qo'ydingiz — ertaga yana qo'yasiz`,
      );
      error.details = { code: DAILY_LIMIT_CODE, limit, used, resetsAt: tashkentDayEnd().toISOString() };
      throw error;
    }

    const media = await mediaService.attachUploadInTx(tx, {
      uploadId,
      ownerId: String(actor.id),
      kind: ["image", "video"],
    });

    const now = new Date();
    return tx.story.create({
      data: {
        authorId: String(actor.id),
        authorBranchId: String(branchId),
        mediaId: media.id,
        caption,
        dayKey,
        expiresAt: new Date(now.getTime() + FEED_TTL_MS),
      },
      include: { media: true },
    });
  });

  // ⚠️ YANGI ISTORIYA UCHUN PUSH YUBORILMAYDI (biznes qarori): 60 xodim
  // kuniga 3 ta qo'ysa, bu kuniga 180 bildirishnoma bo'lardi. Lentada
  // halqa yonishi yetarli — u socket orqali darhol keladi.
  const card = await socialAccess.loadUserCard(actor.id);
  emitter.emitToUsers(await staffAudience(actor.id), "story:new", {
    story: await presentStory(story, { viewerId: actor.id, isAuthor: true }),
    author: card,
  });

  return presentStory(story, { viewerId: actor.id, isAuthor: true });
}

/**
 * Hodisani kimga yuborish kerak — lentani ko'radigan BARCHA xodimlar.
 *
 * ⚠️ O'QUVCHI CHIQARIB TASHLANADI: istoriya xodimlar muhiti
 * (`socialAccess.js`). Ro'yxat katalogdan olinadi, chunki xodim bir
 * nechta filialda bo'lishi mumkin va filial bazasidan yig'ilsa
 * takrorlanib ketardi.
 *
 * @param {string} [exceptId] - o'zini chiqarib tashlash (`story:new` da)
 * @returns {Promise<string[]>}
 */
async function staffAudience(exceptId = null) {
  const rows = await platformPrisma.userDirectory.findMany({
    where: { role: { not: "student" }, isActive: true, isArchived: false },
    select: { id: true },
  });
  return rows.map((r) => r.id).filter((id) => id !== String(exceptId || ""));
}

/* ─────────────────────────────── LENTA ─────────────────────────────── */

/**
 * BOSH SAHIFADAGI LENTA — muallif bo'yicha guruhlangan aktiv istoriyalar.
 *
 * Tartib: o'zim birinchi → ko'rilmaganlar (eng yangisi tepada) →
 * ko'rilganlar. Muallif ichida eskidan yangiga (o'qish tartibi).
 *
 * ⚠️ N+1 YO'Q, lekin XOM SQL HAM YO'Q: Prisma filtrlangan relation bilan
 * DOIMIY sondagi so'rov yuboradi (istoriyalar + mening ko'rishlarim +
 * mening layklarim + katalog = 4 ta), ya'ni 300 xodimda ham so'rovlar
 * soni o'zgarmaydi. Xom SQL beshta jadvalni qo'lda joinlab, natijani
 * qo'lda shaklga solishni talab qilardi — va `media` imzolash mantiqi
 * baribir JS da qolardi.
 *
 * @param {{ actor: object, branchId: string, scope?: "all"|"branch" }} input
 */
async function getFeed({ actor, branchId, scope = "all" }) {
  const now = new Date();
  const viewerId = String(actor.id);

  const stories = await platformPrisma.story.findMany({
    where: {
      deletedAt: null,
      expiresAt: { gt: now },
      ...(scope === "branch" ? { authorBranchId: String(branchId) } : {}),
    },
    include: {
      media: true,
      views: { where: { viewerId }, select: { viewedAt: true } },
      likes: { where: { userId: viewerId }, select: { createdAt: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  if (stories.length === 0) return [];

  // ⚠️ ARXIVLANGAN / FAOLSIZ MUALLIF LENTADAN CHIQADI (o'chirilmaydi):
  // ketgan odamning istoriyasi bir kun ko'rinib turmasligi kerak.
  const cards = await socialAccess.loadUserCards(stories.map((s) => s.authorId));

  const groups = new Map();
  for (const story of stories) {
    const author = cards.get(story.authorId);
    if (!author || author.isArchived) continue;

    if (!groups.has(story.authorId)) {
      groups.set(story.authorId, { author, stories: [], hasUnseen: false, latestAt: story.createdAt });
    }
    const group = groups.get(story.authorId);
    const seen = story.views.length > 0;
    group.stories.push(
      await presentStory(story, {
        viewerId,
        isAuthor: story.authorId === viewerId,
        seen,
        liked: story.likes.length > 0,
      }),
    );
    if (!seen && story.authorId !== viewerId) group.hasUnseen = true;
    if (story.createdAt > group.latestAt) group.latestAt = story.createdAt;
  }

  const list = [...groups.values()].map((g) => ({
    author: g.author,
    hasUnseen: g.hasUnseen,
    latestAt: g.latestAt.toISOString(),
    stories: g.stories,
  }));

  // O'zim — har doim birinchi halqa ("Mening istoriyam").
  list.sort((a, b) => {
    const mineA = a.author.id === viewerId ? 0 : 1;
    const mineB = b.author.id === viewerId ? 0 : 1;
    if (mineA !== mineB) return mineA - mineB;
    if (a.hasUnseen !== b.hasUnseen) return a.hasUnseen ? -1 : 1;
    return b.latestAt.localeCompare(a.latestAt);
  });

  return list;
}

/**
 * BITTA ISTORIYA — push'dan yoki havoladan ochilganda.
 *
 * ⚠️ 24 SOATDAN O'TGANI 404 BERMAYDI: u profil istoriyasi bo'lib qoladi
 * (biznes qarori). 404 faqat O'CHIRILGANDA.
 */
async function getStory({ actor, id }) {
  const story = await loadStory(id);
  const [view, like] = await Promise.all([
    platformPrisma.storyView.findUnique({
      where: { storyId_viewerId: { storyId: story.id, viewerId: String(actor.id) } },
      select: { viewedAt: true },
    }),
    platformPrisma.storyLike.findUnique({
      where: { storyId_userId: { storyId: story.id, userId: String(actor.id) } },
      select: { createdAt: true },
    }),
  ]);

  const author = await socialAccess.loadUserCard(story.authorId);
  return {
    ...(await presentStory(story, {
      viewerId: actor.id,
      isAuthor: story.authorId === String(actor.id),
      seen: Boolean(view),
      liked: Boolean(like),
    })),
    author,
  };
}

/**
 * PROFIL ISTORIYALARI — odamning hamma istoriyalari, eng yangisi tepada.
 *
 * ⚠️ HAMMA XODIM KO'RADI va KO'RISH HAM YOZILADI (lenta bilan AYNI
 * qoida): profilni ochgan odam ham "ko'rganlar" ro'yxatiga tushadi,
 * aks holda sanoqchi haqiqatni ko'rsatmasdi.
 *
 * @param {{actor: object, userId: string, cursor?: string, limit?: number}} input
 */
async function getUserStories({ actor, userId, cursor, limit }) {
  const take = clampLimit(limit);
  const author = await socialAccess.loadUserCard(userId);
  if (!author) throw new NotFoundError("Foydalanuvchi topilmadi");

  const viewerId = String(actor.id);
  const isAuthor = String(userId) === viewerId;
  const canSeeStats = isAuthor || socialAccess.isStoryModerator(actor);

  const rows = await platformPrisma.story.findMany({
    where: { authorId: String(userId), deletedAt: null },
    include: {
      media: true,
      views: { where: { viewerId }, select: { viewedAt: true } },
      likes: { where: { userId: viewerId }, select: { createdAt: true } },
    },
    orderBy: { createdAt: "desc" },
    take: take + 1,
    ...(cursor ? { cursor: { id: String(cursor) }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;

  const items = [];
  for (const story of page) {
    items.push(
      await presentStory(story, {
        viewerId,
        isAuthor: canSeeStats,
        seen: story.views.length > 0,
        liked: story.likes.length > 0,
      }),
    );
  }

  return {
    author,
    storiesCount: await platformPrisma.story.count({
      where: { authorId: String(userId), deletedAt: null },
    }),
    items,
    pagination: { nextCursor: hasMore ? page[page.length - 1].id : null, hasMore },
  };
}

/* ─────────────────────────── O'CHIRISH ─────────────────────────── */

/**
 * Muallif yoki moderator o'chiradi.
 *
 * ⚠️ SOFT DELETE: qator qoladi (kunlik limitda hisoblanadi) va media
 * 30 kundan keyin o'chiriladi (`storyMediaPurge.job.js`) — shikoyatni
 * tekshirish uchun oyna kerak.
 */
async function deleteStory({ actor, id }) {
  const story = await loadStory(id);
  const isAuthor = story.authorId === String(actor.id);
  if (!isAuthor && !socialAccess.isStoryModerator(actor)) {
    throw new ForbiddenError("Bu istoriyani o'chirish huquqi sizda yo'q");
  }

  await platformPrisma.story.update({
    where: { id: story.id },
    data: { deletedAt: new Date(), deletedBy: String(actor.id) },
  });

  emitter.emitToUsers(await staffAudience(), "story:deleted", { storyId: story.id });

  if (!isAuthor) {
    // Moderator o'chirgan bo'lsa muallif BILISHI kerak — aks holda u
    // "istoriyam qayerga ketdi" degan savol bilan qolardi.
    pushService.sendToUsers([story.authorId], {
      title: "Istoriyangiz olib tashlandi",
      body: "Moderator istoriyangizni olib tashladi",
      data: { type: "story", event: "removed", storyId: story.id },
    });
  }

  return { id: story.id, deleted: true };
}

/* ──────────────────── KO'RISH / LAYK / IZOH ──────────────────── */

/**
 * KO'RISHLAR PAKETI — ilova 2–3 sekundda bir yuboradi, har kadrda EMAS.
 *
 * ⚠️ IDEMPOTENT: `createMany` + `skipDuplicates`, sanoqchi esa faqat
 * HAQIQATAN yozilgan qatorlar soniga oshadi. Aks holda ilovaning qayta
 * yuborishi "24 ko'rish" ni "96 ko'rish" qilib qo'yardi.
 *
 * ⚠️ MUALLIFNING O'Z KO'RISHI YOZILMAYDI (biznes qarori): statistika
 * toza qolishi kerak.
 */
async function recordViews({ actor, storyIds = [] }) {
  const ids = [...new Set(storyIds.filter(Boolean).map(String))].slice(0, MAX_VIEW_BATCH);
  if (ids.length === 0) return { recorded: 0 };

  const stories = await platformPrisma.story.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, authorId: true },
  });

  const viewerId = String(actor.id);
  const targets = stories.filter((s) => s.authorId !== viewerId);
  if (targets.length === 0) return { recorded: 0 };

  let recorded = 0;
  for (const story of targets) {
    // Har istoriya O'Z tranzaksiyasida: bittasi yiqilsa qolganlari
    // baribir yoziladi (ommaviy amallar doktrinasi, `finance.md` §5).
    // eslint-disable-next-line no-await-in-loop
    const added = await platformPrisma.$transaction(async (tx) => {
      const { count } = await tx.storyView.createMany({
        data: [{ storyId: story.id, viewerId }],
        skipDuplicates: true,
      });
      if (count === 1) {
        await tx.story.update({
          where: { id: story.id },
          data: { viewsCount: { increment: 1 } },
        });
      }
      return count;
    });

    if (added === 1) {
      recorded += 1;
      emitter.emitToUser(story.authorId, "story:viewed", { storyId: story.id, viewerId });
    }
  }

  return { recorded };
}

/** Layk qo'yish — idempotent. */
async function like({ actor, id }) {
  const story = await loadStory(id);
  const userId = String(actor.id);

  const added = await platformPrisma.$transaction(async (tx) => {
    const { count } = await tx.storyLike.createMany({
      data: [{ storyId: story.id, userId }],
      skipDuplicates: true,
    });
    if (count === 1) {
      await tx.story.update({ where: { id: story.id }, data: { likesCount: { increment: 1 } } });
    }
    return count;
  });

  if (added === 1 && story.authorId !== userId) {
    emitter.emitToUser(story.authorId, "story:liked", { storyId: story.id, userId });
    // ⚠️ PUSH BU YERDA YUBORILMAYDI — `storyLikeDigest.job.js` 10
    // daqiqada bir paket qilib yuboradi ("Ali va yana 4 kishi"):
    // mashhur istoriya egasining telefoni uzluksiz jiringlamasin.
  }

  const fresh = await platformPrisma.story.findUnique({
    where: { id: story.id },
    select: { likesCount: true },
  });
  return { liked: true, likesCount: fresh.likesCount };
}

/** Laykni olish — idempotent. */
async function unlike({ actor, id }) {
  const story = await loadStory(id);
  const userId = String(actor.id);

  const removed = await platformPrisma.$transaction(async (tx) => {
    const { count } = await tx.storyLike.deleteMany({ where: { storyId: story.id, userId } });
    if (count === 1) {
      await tx.story.update({ where: { id: story.id }, data: { likesCount: { decrement: 1 } } });
    }
    return count;
  });

  const fresh = await platformPrisma.story.findUnique({
    where: { id: story.id },
    select: { likesCount: true },
  });
  if (removed === 1) {
    emitter.emitToUser(story.authorId, "story:unliked", { storyId: story.id, userId });
  }
  return { liked: false, likesCount: fresh.likesCount };
}

/** IZOH — hammaga ko'rinadi. */
async function addComment({ actor, id, text }) {
  const story = await loadStory(id);
  const clean = cleanText(text, STORY_COMMENT_MAX);
  if (!clean) throw new BadRequestError("Izoh matni bo'sh");

  const comment = await platformPrisma.$transaction(async (tx) => {
    const row = await tx.storyComment.create({
      data: { storyId: story.id, authorId: String(actor.id), text: clean },
    });
    await tx.story.update({ where: { id: story.id }, data: { commentsCount: { increment: 1 } } });
    return row;
  });

  const author = await socialAccess.loadUserCard(actor.id);

  if (story.authorId !== String(actor.id)) {
    emitter.emitToUser(story.authorId, "story:commented", {
      storyId: story.id,
      comment: presentComment(comment, author),
    });
    const push = storyCommentPush({
      storyId: story.id,
      authorName: author?.fullName || "Xodim",
      text: clean,
    });
    pushService.sendToUsers([story.authorId], push);
  }

  return presentComment(comment, author);
}

/** Izohni o'chirish: izoh muallifi, istoriya muallifi yoki moderator. */
async function deleteComment({ actor, id, commentId }) {
  const story = await loadStory(id);
  const comment = await platformPrisma.storyComment.findUnique({
    where: { id: String(commentId) },
  });
  if (!comment || comment.storyId !== story.id || comment.deletedAt) {
    throw new NotFoundError("Izoh topilmadi");
  }

  const me = String(actor.id);
  const allowed =
    comment.authorId === me || story.authorId === me || socialAccess.isStoryModerator(actor);
  if (!allowed) throw new ForbiddenError("Bu izohni o'chirish huquqi sizda yo'q");

  await platformPrisma.$transaction(async (tx) => {
    await tx.storyComment.update({
      where: { id: comment.id },
      data: { deletedAt: new Date(), deletedBy: me },
    });
    await tx.story.update({ where: { id: story.id }, data: { commentsCount: { decrement: 1 } } });
  });

  return { id: comment.id, deleted: true };
}

/* ───────────────────────── RO'YXATLAR ───────────────────────── */

/** KO'RGANLAR — faqat muallif (va moderator). */
async function listViewers({ actor, id, cursor, limit }) {
  const story = await assertStatsAccess(actor, id);
  const take = clampLimit(limit);

  const rows = await platformPrisma.storyView.findMany({
    where: { storyId: story.id },
    orderBy: { viewedAt: "desc" },
    take: take + 1,
    ...(cursor
      ? { cursor: { storyId_viewerId: { storyId: story.id, viewerId: String(cursor) } }, skip: 1 }
      : {}),
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  const cards = await socialAccess.loadUserCards(page.map((r) => r.viewerId));
  const likes = await platformPrisma.storyLike.findMany({
    where: { storyId: story.id, userId: { in: page.map((r) => r.viewerId) } },
    select: { userId: true },
  });
  const liked = new Set(likes.map((l) => l.userId));

  return {
    items: page.map((row) => ({
      user: cards.get(row.viewerId) || null,
      viewedAt: row.viewedAt.toISOString(),
      liked: liked.has(row.viewerId),
    })),
    pagination: { nextCursor: hasMore ? page[page.length - 1].viewerId : null, hasMore },
  };
}

/** LAYK BOSGANLAR — faqat muallif (va moderator). */
async function listLikes({ actor, id, cursor, limit }) {
  const story = await assertStatsAccess(actor, id);
  const take = clampLimit(limit);

  const rows = await platformPrisma.storyLike.findMany({
    where: { storyId: story.id },
    orderBy: { createdAt: "desc" },
    take: take + 1,
    ...(cursor
      ? { cursor: { storyId_userId: { storyId: story.id, userId: String(cursor) } }, skip: 1 }
      : {}),
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  const cards = await socialAccess.loadUserCards(page.map((r) => r.userId));

  return {
    items: page.map((row) => ({
      user: cards.get(row.userId) || null,
      emoji: row.emoji,
      createdAt: row.createdAt.toISOString(),
    })),
    pagination: { nextCursor: hasMore ? page[page.length - 1].userId : null, hasMore },
  };
}

/** IZOHLAR — HAMMAGA, eskidan yangiga. */
async function listComments({ actor, id, cursor, limit }) {
  const story = await loadStory(id);
  const take = clampLimit(limit);

  const rows = await platformPrisma.storyComment.findMany({
    where: { storyId: story.id, deletedAt: null },
    orderBy: { createdAt: "asc" },
    take: take + 1,
    ...(cursor ? { cursor: { id: String(cursor) }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  const cards = await socialAccess.loadUserCards(page.map((r) => r.authorId));

  return {
    items: page.map((row) => presentComment(row, cards.get(row.authorId) || null)),
    pagination: { nextCursor: hasMore ? page[page.length - 1].id : null, hasMore },
  };
}

/* ───────────────────────── TOZALASH (cron) ───────────────────────── */

/**
 * O'CHIRILGANIGA 30 KUN BO'LGAN istoriyalarning media'si va qatori.
 *
 * ⚠️ O'CHIRILMAGAN ISTORIYA HECH QACHON O'CHMAYDI: 24 soat faqat
 * lentadan chiqaradi, profilda u doimiy (biznes qarori, 2026-11-26).
 * Shu sababli shart `deletedAt` bo'yicha, `expiresAt` bo'yicha EMAS —
 * bu ikkisini aralashtirish butun arxivni yo'q qilardi.
 *
 * ⚠️ 30 KUNLIK OYNA: shikoyat qilingan istoriyani moderator ko'rib
 * chiqishi uchun vaqt kerak. Darhol o'chirilsa, "nimaga shikoyat
 * qilingan" degan savolga javob qolmasdi.
 */
async function purgeDeleted({ olderThanDays = 30, batch = 200 } = {}) {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000);
  const rows = await platformPrisma.story.findMany({
    where: { deletedAt: { not: null, lt: cutoff } },
    include: { media: true },
    take: batch,
  });

  let purged = 0;
  for (const story of rows) {
    try {
      // Tartib: avval istoriya (media'ga FK bilan ishora qiladi), keyin fayl.
      // eslint-disable-next-line no-await-in-loop
      await platformPrisma.story.delete({ where: { id: story.id } });
      // eslint-disable-next-line no-await-in-loop
      await mediaService.destroy(story.media);
      purged += 1;
    } catch (error) {
      logger.warn(`[social] istoriyani tozalashda xato (${story.id}): ${error.message}`);
    }
  }

  return { scanned: rows.length, purged };
}

/* ───────────────────────────── YORDAMCHI ───────────────────────────── */

async function loadStory(id) {
  const story = await platformPrisma.story.findUnique({
    where: { id: String(id) },
    include: { media: true },
  });
  if (!story || story.deletedAt) throw new NotFoundError("Istoriya topilmadi");
  return story;
}

/** Ko'rganlar / layklar ro'yxati — faqat muallif va moderator. */
async function assertStatsAccess(actor, id) {
  const story = await loadStory(id);
  if (story.authorId !== String(actor.id) && !socialAccess.isStoryModerator(actor)) {
    throw new ForbiddenError("Ko'rganlar ro'yxati faqat muallifga ko'rinadi");
  }
  return story;
}

/**
 * Javob shakli.
 *
 * ⚠️ `likesCount` MUALLIFGA, `commentsCount` HAMMAGA (biznes qarori):
 * boshqalar layk SONINI ham ko'rmaydi, aks holda "kim bosdi" ni taxmin
 * qilish mumkin bo'lardi (kichik jamoada 1 layk = bitta odam).
 */
async function presentStory(story, { isAuthor = false, seen = false, liked = false } = {}) {
  return {
    id: story.id,
    media: await mediaService.present(story.media),
    caption: story.caption,
    createdAt: story.createdAt.toISOString(),
    expiresAt: story.expiresAt.toISOString(),
    // Lentadan chiqqan, lekin profilda turgan istoriya
    inFeed: story.expiresAt > new Date(),
    seen,
    liked,
    commentsCount: story.commentsCount,
    ...(isAuthor ? { viewsCount: story.viewsCount, likesCount: story.likesCount } : {}),
  };
}

function presentComment(comment, author) {
  return {
    id: comment.id,
    text: comment.text,
    createdAt: comment.createdAt.toISOString(),
    author,
    flagged: containsProfanity(comment.text),
  };
}

function clampLimit(limit) {
  const n = parseInt(limit, 10);
  if (!Number.isFinite(n) || n <= 0) return LIST_LIMIT;
  return Math.min(LIST_LIMIT_MAX, n);
}

module.exports = {
  FEED_TTL_MS,
  MAX_VIEW_BATCH,
  DAILY_LIMIT_CODE,
  tashkentDayEnd,
  getQuota,
  createStory,
  getFeed,
  getStory,
  getUserStories,
  deleteStory,
  recordViews,
  like,
  unlike,
  addComment,
  deleteComment,
  listViewers,
  listLikes,
  listComments,
  purgeDeleted,
  staffAudience,
};
