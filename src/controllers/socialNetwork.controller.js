// Models
const SocialNetwork = require("../models/socialNetwork.model");

// Services
const telegramService = require("../services/telegram.service");

const asyncHandler = require("../middleware/async.middleware");
const { BadRequestError, NotFoundError } = require("../utils/errors");

/**
 * Barcha ijtimoiy tarmoqlarni olish
 * GET /api/social-networks
 */
const getSocialNetworks = asyncHandler(async (req, res) => {
  const socialNetworks = await SocialNetwork.find()
    .populate("createdBy", "firstName lastName")
    .sort({ createdAt: -1 });

  res.json({
    success: true,
    data: socialNetworks,
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

  const socialNetwork = await SocialNetwork.create({
    platform: platform || "telegram",
    name,
    chatId,
    username,
    isActive: isActive !== undefined ? isActive : true,
    createdBy: req.user._id,
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

  const socialNetwork = await SocialNetwork.findByIdAndUpdate(id, req.body, {
    new: true,
    runValidators: true,
  });

  if (!socialNetwork) {
    throw new NotFoundError("Ijtimoiy tarmoq topilmadi");
  }

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

  const socialNetwork = await SocialNetwork.findByIdAndDelete(id);

  if (!socialNetwork) {
    throw new NotFoundError("Ijtimoiy tarmoq topilmadi");
  }

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

  const channels = await SocialNetwork.find({
    platform: "telegram",
    isActive: true,
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
