/**
 * ISTORIYALAR VA MEDIA — TOZALASH PASSLARI.
 *
 * Uchta mustaqil job bitta faylda, chunki uchalasi ham AYNI domenga
 * tegishli va hech biri filial kontekstini talab qilmaydi: ma'lumot
 * PLATFORMADA (`platform.story`, `platform.media_upload`), ya'ni
 * `branchCron` KERAK EMAS. Sinf guruhlari sinxroni esa filial
 * ma'lumotidan o'qiydi — u alohida faylda (`classChatSync.job.js`).
 *
 *   04:30  storyMediaPurge      — o'chirilganiga 30 kun bo'lgan istoriyalar
 *   har soat  socialUploadCleanup — yetim (biriktirilmagan) fayllar
 *   har 10 daq storyLikeDigest   — layk push'lari PAKETI
 *
 * ⚠️ HECH BIRI JARAYONNI YIQITMAYDI (`CLAUDE.md` qoidasi): har biri o'z
 * `try/catch` ida va faqat log yozadi.
 */

const cron = require("node-cron");

const platformPrisma = require("../config/platformPrisma");
const storyService = require("../services/story.service");
const mediaService = require("../services/mediaUpload.service");
const socialAccess = require("../services/socialAccess.service");
const pushService = require("../services/push.service");
const logger = require("../utils/logger");
const { storyLikePush } = require("../helpers/socialPush.helpers");

/**
 * LAYK PAKETI — oxirgi 10 daqiqadagi layklar.
 *
 * ⚠️ NIMA UCHUN PAKET: mashhur istoriyaga daqiqada o'nlab layk tushadi.
 * Har biriga push yuborilsa, muallifning telefoni uzluksiz jiringlardi va
 * u bir kundan keyin bildirishnomani butunlay o'chirib qo'yardi — ya'ni
 * MUHIM xabarlar ham yetmay qolardi.
 *
 * ⚠️ MUALLIFNING O'Z LAYKI (nazariy hol) chiqarib tashlanadi.
 */
const DIGEST_WINDOW_MS = 10 * 60 * 1000;

async function runLikeDigest() {
  const since = new Date(Date.now() - DIGEST_WINDOW_MS);

  const likes = await platformPrisma.storyLike.findMany({
    where: { createdAt: { gte: since } },
    select: { storyId: true, userId: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });
  if (likes.length === 0) return { stories: 0, sent: 0 };

  const storyIds = [...new Set(likes.map((l) => l.storyId))];
  const stories = await platformPrisma.story.findMany({
    where: { id: { in: storyIds }, deletedAt: null },
    select: { id: true, authorId: true },
  });
  const authorOf = new Map(stories.map((s) => [s.id, s.authorId]));

  const byStory = new Map();
  for (const like of likes) {
    const authorId = authorOf.get(like.storyId);
    if (!authorId || authorId === like.userId) continue;
    if (!byStory.has(like.storyId)) byStory.set(like.storyId, []);
    byStory.get(like.storyId).push(like.userId);
  }
  if (byStory.size === 0) return { stories: 0, sent: 0 };

  const cards = await socialAccess.loadUserCards(
    [...byStory.values()].map((list) => list[0]),
  );

  let sent = 0;
  for (const [storyId, userIds] of byStory) {
    const unique = [...new Set(userIds)];
    const first = cards.get(unique[0]);
    pushService.sendToUsers([authorOf.get(storyId)], {
      ...storyLikePush({
        storyId,
        firstName: first?.firstName || "Xodim",
        othersCount: unique.length - 1,
      }),
    });
    sent += 1;
  }

  return { stories: byStory.size, sent };
}

/* ─────────────────────────── CRON LAR ─────────────────────────── */

/** O'chirilganiga 30 kun bo'lgan istoriyalarni butunlay o'chiradi (04:30). */
function startStoryMediaPurgeCron() {
  cron.schedule(
    "30 4 * * *",
    async () => {
      try {
        const result = await storyService.purgeDeleted();
        if (result.purged > 0) {
          logger.info(`[StoryPurge] ${result.purged} ta o'chirilgan istoriya tozalandi`);
        }
      } catch (error) {
        logger.error(`[StoryPurge] cron xatosi: ${error.message}`);
      }
    },
    { scheduled: true, timezone: "Asia/Tashkent" },
  );

  logger.info("Istoriya media tozalash cron job belgilandi: Har kuni 04:30 (Asia/Tashkent)");
}

/** 24 soatdan eski, biriktirilmagan yuklashlarni o'chiradi (har soat). */
function startSocialUploadCleanupCron() {
  cron.schedule(
    "7 * * * *",
    async () => {
      try {
        const result = await mediaService.cleanupStale();
        if (result.removed > 0) {
          logger.info(`[SocialUpload] ${result.removed} ta yetim fayl o'chirildi`);
        }
      } catch (error) {
        logger.error(`[SocialUpload] cron xatosi: ${error.message}`);
      }
    },
    { scheduled: true, timezone: "Asia/Tashkent" },
  );

  logger.info("Yetim fayllarni tozalash cron job belgilandi: Har soat (Asia/Tashkent)");
}

/** Layk push paketi (har 10 daqiqa). */
function startStoryLikeDigestCron() {
  cron.schedule(
    "*/10 * * * *",
    async () => {
      try {
        await runLikeDigest();
      } catch (error) {
        logger.error(`[StoryLikeDigest] cron xatosi: ${error.message}`);
      }
    },
    { scheduled: true, timezone: "Asia/Tashkent" },
  );

  logger.info("Layk bildirishnomasi paketi cron job belgilandi: Har 10 daqiqa");
}

/** Uchalasini birga belgilaydi (`index.js` dan bitta chaqiruv). */
function startSocialSweepCrons() {
  startStoryMediaPurgeCron();
  startSocialUploadCleanupCron();
  startStoryLikeDigestCron();
}

module.exports = {
  startSocialSweepCrons,
  startStoryMediaPurgeCron,
  startSocialUploadCleanupCron,
  startStoryLikeDigestCron,
  runLikeDigest,
  DIGEST_WINDOW_MS,
};
