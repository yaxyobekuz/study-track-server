// Prisma
const prisma = require("../config/prisma");

// Services
const telegramService = require("../services/telegram.service");

const asyncHandler = require("../middleware/async.middleware");
const { BadRequestError, NotFoundError } = require("../utils/errors");

// createdBy — soft ref (relation yo'q), qo'lda yuklab biriktiramiz
async function attachCreators(socialNetworks) {
  const arr = Array.isArray(socialNetworks) ? socialNetworks : [socialNetworks];
  const creatorIds = [
    ...new Set(arr.map((s) => s.createdBy).filter(Boolean)),
  ];
  const creators = creatorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: creatorIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const creatorMap = new Map(creators.map((c) => [c.id, c]));

  const mapped = arr.map((s) => ({
    ...s,
    createdBy: s.createdBy ? creatorMap.get(s.createdBy) || null : null,
  }));

  return Array.isArray(socialNetworks) ? mapped : mapped[0];
}

/**
 * Barcha ijtimoiy tarmoqlarni olish
 * GET /api/social-networks
 */
const getSocialNetworks = asyncHandler(async (req, res) => {
  const socialNetworks = await prisma.socialNetwork.findMany({
    orderBy: { createdAt: "desc" },
  });

  res.json({
    success: true,
    data: await attachCreators(socialNetworks),
  });
});

/**
 * Ijtimoiy tarmoq yaratish
 * POST /api/social-networks
 */
const createSocialNetwork = asyncHandler(async (req, res) => {
  const { platform, name, chatId, username, isActive } = req.body;

  if (!name || !chatId) {
    throw new BadRequestError("Nom va Chat ID majburiy");
  }

  const socialNetwork = await prisma.socialNetwork.create({
    data: {
      platform: platform || "telegram",
      name,
      chatId,
      username,
      isActive: isActive !== undefined ? isActive : true,
      createdBy: req.user.id,
    },
  });

  res.status(201).json({
    success: true,
    data: socialNetwork,
  });
});

/**
 * Ijtimoiy tarmoqni yangilash
 * PUT /api/social-networks/:id
 */
const updateSocialNetwork = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const existing = await prisma.socialNetwork.findUnique({ where: { id } });
  if (!existing) {
    throw new NotFoundError("Ijtimoiy tarmoq topilmadi");
  }

  // Faqat schema maydonlarini yangilaymiz (stray keylardan himoya)
  const update = {};
  if (req.body.platform !== undefined) update.platform = req.body.platform;
  if (req.body.name !== undefined) update.name = req.body.name;
  if (req.body.chatId !== undefined) update.chatId = req.body.chatId;
  if (req.body.username !== undefined) update.username = req.body.username;
  if (req.body.isActive !== undefined) update.isActive = req.body.isActive;

  const socialNetwork = await prisma.socialNetwork.update({
    where: { id },
    data: update,
  });

  res.json({
    success: true,
    data: socialNetwork,
  });
});

/**
 * Ijtimoiy tarmoqni o'chirish
 * DELETE /api/social-networks/:id
 */
const deleteSocialNetwork = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const existing = await prisma.socialNetwork.findUnique({ where: { id } });
  if (!existing) {
    throw new NotFoundError("Ijtimoiy tarmoq topilmadi");
  }

  await prisma.socialNetwork.delete({ where: { id } });

  res.json({
    success: true,
    message: "Ijtimoiy tarmoq o'chirildi",
  });
});

/**
 * Telegram kanal obunasini tekshirish
 * GET /api/social-networks/check-subscription?telegramUserId=123
 */
const checkSubscription = asyncHandler(async (req, res) => {
  const { telegramUserId } = req.query;

  if (!telegramUserId) {
    throw new BadRequestError("telegramUserId majburiy");
  }

  const channels = await prisma.socialNetwork.findMany({
    where: {
      platform: "telegram",
      isActive: true,
    },
  });

  if (channels.length === 0) {
    return res.json({
      success: true,
      data: { subscribed: true, channels: [] },
    });
  }

  const results = await Promise.all(
    channels.map(async (channel) => {
      const { isMember } = await telegramService.checkMembership(
        channel.chatId,
        telegramUserId,
      );
      return {
        name: channel.name,
        username: channel.username,
        isSubscribed: isMember,
      };
    }),
  );

  const allSubscribed = results.every((r) => r.isSubscribed);

  res.json({
    success: true,
    data: {
      subscribed: allSubscribed,
      channels: results,
    },
  });
});

module.exports = {
  getSocialNetworks,
  createSocialNetwork,
  updateSocialNetwork,
  deleteSocialNetwork,
  checkSubscription,
};
