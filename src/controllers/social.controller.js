/**
 * ISTORIYALAR, MEDIA VA SHIKOYATLAR — controller (yupqa).
 *
 * Hamma qoida servislarda: `story.service.js`, `mediaUpload.service.js`,
 * `contentReport.service.js`. Bu fayl faqat so'rovni ochadi va javobni
 * qaytaradi (loyiha konvensiyasi: "fat services, thin controllers").
 */

const asyncHandler = require("../middleware/async.middleware");
const storyService = require("../services/story.service");
const mediaService = require("../services/mediaUpload.service");
const reportService = require("../services/contentReport.service");
const avatarService = require("../services/avatar.service");
const socialAccess = require("../services/socialAccess.service");
const platformPrisma = require("../config/platformPrisma");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");
const { ForbiddenError, NotFoundError } = require("../utils/errors");

/** Har so'rovda ishlatiladigan "aktyor": id + xodimligi. */
const actorOf = (req) => ({ id: String(req.user.id), isStaff: socialAccess.isStaff(req.user) });

/* ─────────────────────────── MEDIA ─────────────────────────── */

const createUpload = asyncHandler(async (req, res) => {
  const data = await mediaService.createUpload({ actor: actorOf(req), body: req.body });
  res.status(201).json({ success: true, data });
});

const putBinary = asyncHandler(async (req, res) => {
  const data = await mediaService.putBinary({
    actor: actorOf(req),
    uploadId: req.params.id,
    file: req.file,
    isThumb: req.query.thumb === "1" || req.query.thumb === "true",
  });
  res.json({ success: true, data });
});

const completeUpload = asyncHandler(async (req, res) => {
  const data = await mediaService.completeUpload({ actor: actorOf(req), uploadId: req.params.id });
  res.json({ success: true, data });
});

/**
 * FAYLNI SERVER ORQALI BERISH.
 *
 * ⚠️ FAQAT ZAXIRA YO'L: produksiyada javobda imzolangan Spaces havolasi
 * keladi va ilova to'g'ridan-to'g'ri o'sha havolani oladi. Bu endpoint
 * lokal dev muhiti uchun (imzo yo'q) va imzo berilmagan holatlar uchun.
 *
 * ⚠️ EGALIK TEKSHIRILADI va u UCH SHOXLI: egasi → o'zi; istoriyaga
 * biriktirilgan → XODIM; xabarga biriktirilgan → shu suhbatning A'ZOSI.
 * Faqat "tokeni bor" deb berilsa, sinf guruhidagi o'quvchi `mediaId` ni
 * almashtirib boshqa suhbatning rasmini ochib olardi.
 */
const getMedia = asyncHandler(async (req, res) => {
  const thumb = req.query.thumb === "1" || req.query.thumb === "true";
  const { row, buffer, contentType } = await mediaService.readRaw(req.params.id, { thumb });

  const me = String(req.user.id);
  if (row.ownerId !== me) {
    const story = await platformPrisma.story.findUnique({
      where: { mediaId: row.id },
      select: { id: true, deletedAt: true },
    });

    if (story) {
      // Istoriya — xodimlar muhiti.
      socialAccess.assertStaff(req.user, req.sessionChannel);
    } else {
      const message = await platformPrisma.message.findFirst({
        where: { mediaId: row.id },
        select: { conversationId: true },
      });
      if (!message) throw new NotFoundError("Fayl topilmadi");

      const member = await platformPrisma.conversationMember.findUnique({
        where: {
          conversationId_userId: { conversationId: message.conversationId, userId: me },
        },
        select: { leftAt: true },
      });
      if (!member || member.leftAt) {
        throw new ForbiddenError("Bu fayl sizga ko'rinmaydi");
      }
    }
  }

  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, max-age=600");
  res.send(buffer);
});

/* ─────────────────────────── ISTORIYALAR ─────────────────────────── */

const getFeed = asyncHandler(async (req, res) => {
  const data = await storyService.getFeed({
    actor: actorOf(req),
    branchId: req.branch.id,
    scope: req.query.scope === "branch" ? "branch" : "all",
  });
  res.json({ success: true, data });
});

const getQuota = asyncHandler(async (req, res) => {
  const data = await storyService.getQuota(actorOf(req));
  res.json({ success: true, data });
});

const createStory = asyncHandler(async (req, res) => {
  const data = await storyService.createStory({
    actor: actorOf(req),
    branchId: req.branch.id,
    body: req.body,
  });
  res.status(201).json({ success: true, data });
});

const getStory = asyncHandler(async (req, res) => {
  const data = await storyService.getStory({ actor: actorOf(req), id: req.params.id });
  res.json({ success: true, data });
});

const deleteStory = asyncHandler(async (req, res) => {
  const data = await storyService.deleteStory({ actor: req.user, id: req.params.id });
  res.json({ success: true, data, message: "Istoriya o'chirildi" });
});

const recordViews = asyncHandler(async (req, res) => {
  await storyService.recordViews({ actor: actorOf(req), storyIds: req.body?.storyIds });
  // ⚠️ 204: ilova javobni o'qimaydi — bu "yozib qo'y va unut" paketi.
  res.status(204).end();
});

const likeStory = asyncHandler(async (req, res) => {
  const data = await storyService.like({ actor: actorOf(req), id: req.params.id });
  res.json({ success: true, data });
});

const unlikeStory = asyncHandler(async (req, res) => {
  const data = await storyService.unlike({ actor: actorOf(req), id: req.params.id });
  res.json({ success: true, data });
});

const listViewers = asyncHandler(async (req, res) => {
  const data = await storyService.listViewers({
    actor: req.user,
    id: req.params.id,
    cursor: req.query.cursor,
    limit: req.query.limit,
  });
  res.json({ success: true, ...data });
});

const listLikes = asyncHandler(async (req, res) => {
  const data = await storyService.listLikes({
    actor: req.user,
    id: req.params.id,
    cursor: req.query.cursor,
    limit: req.query.limit,
  });
  res.json({ success: true, ...data });
});

const listComments = asyncHandler(async (req, res) => {
  const data = await storyService.listComments({
    actor: actorOf(req),
    id: req.params.id,
    cursor: req.query.cursor,
    limit: req.query.limit,
  });
  res.json({ success: true, ...data });
});

const addComment = asyncHandler(async (req, res) => {
  const data = await storyService.addComment({
    actor: actorOf(req),
    id: req.params.id,
    text: req.body?.text,
  });
  res.status(201).json({ success: true, data });
});

const deleteComment = asyncHandler(async (req, res) => {
  const data = await storyService.deleteComment({
    actor: req.user,
    id: req.params.id,
    commentId: req.params.commentId,
  });
  res.json({ success: true, data });
});

/** PROFIL ISTORIYALARI — odamning hamma istoriyalari. */
const getUserStories = asyncHandler(async (req, res) => {
  const data = await storyService.getUserStories({
    actor: req.user,
    userId: req.params.userId,
    cursor: req.query.cursor,
    limit: req.query.limit,
  });
  res.json({ success: true, ...data });
});

/* ─────────────────────────── MODERATSIYA ─────────────────────────── */

const createReport = asyncHandler(async (req, res) => {
  const data = await reportService.create({ actor: req.user, body: req.body });
  res.status(201).json({ success: true, data, message: "Shikoyat qabul qilindi" });
});

const listReports = asyncHandler(async (req, res) => {
  const pagination = getPaginationParams(req);
  const { total, items } = await reportService.list({
    actor: req.user,
    skip: pagination.skip,
    limit: pagination.limit,
    resolved: req.query.resolved === "true",
  });
  res.json(formatPaginationResponse(items, total, pagination.page, pagination.limit));
});

const resolveReport = asyncHandler(async (req, res) => {
  const data = await reportService.resolve({
    actor: req.user,
    id: req.params.id,
    note: req.body?.note,
  });
  res.json({ success: true, data });
});

/** Nomaqbul profil rasmini moderator olib tashlaydi. */
const removeUserAvatar = asyncHandler(async (req, res) => {
  const data = await avatarService.removeByModerator({
    actor: req.user,
    userId: req.params.userId,
  });
  res.json({ success: true, data, message: "Profil rasmi olib tashlandi" });
});

module.exports = {
  createUpload,
  putBinary,
  completeUpload,
  getMedia,
  getFeed,
  getQuota,
  createStory,
  getStory,
  deleteStory,
  recordViews,
  likeStory,
  unlikeStory,
  listViewers,
  listLikes,
  listComments,
  addComment,
  deleteComment,
  getUserStories,
  createReport,
  listReports,
  resolveReport,
  removeUserAvatar,
};
