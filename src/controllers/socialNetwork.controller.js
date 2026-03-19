// Models
const SocialNetwork = require("../models/socialNetwork.model");

// Services
const telegramService = require("../services/telegram.service");

/**
 * Barcha ijtimoiy tarmoqlarni olish
 * GET /api/social-networks
 */
const getSocialNetworks = async (req, res) => {
  try {
    const socialNetworks = await SocialNetwork.find()
      .populate("createdBy", "firstName lastName")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: socialNetworks.length,
      data: socialNetworks,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

/**
 * Ijtimoiy tarmoq yaratish
 * POST /api/social-networks
 */
const createSocialNetwork = async (req, res) => {
  try {
    const { platform, name, chatId, username, isActive } = req.body;

    if (!name || !chatId) {
      return res.status(400).json({
        success: false,
        message: "Nom va Chat ID majburiy",
      });
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
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

/**
 * Ijtimoiy tarmoqni yangilash
 * PUT /api/social-networks/:id
 */
const updateSocialNetwork = async (req, res) => {
  try {
    const { id } = req.params;

    const socialNetwork = await SocialNetwork.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!socialNetwork) {
      return res.status(404).json({
        success: false,
        message: "Ijtimoiy tarmoq topilmadi",
      });
    }

    res.json({
      success: true,
      data: socialNetwork,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

/**
 * Ijtimoiy tarmoqni o'chirish
 * DELETE /api/social-networks/:id
 */
const deleteSocialNetwork = async (req, res) => {
  try {
    const { id } = req.params;

    const socialNetwork = await SocialNetwork.findByIdAndDelete(id);

    if (!socialNetwork) {
      return res.status(404).json({
        success: false,
        message: "Ijtimoiy tarmoq topilmadi",
      });
    }

    res.json({
      success: true,
      message: "Ijtimoiy tarmoq o'chirildi",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

/**
 * Telegram kanal obunasini tekshirish
 * GET /api/social-networks/check-subscription?telegramUserId=123
 */
const checkSubscription = async (req, res) => {
  try {
    const { telegramUserId } = req.query;

    if (!telegramUserId) {
      return res.status(400).json({
        success: false,
        message: "telegramUserId majburiy",
      });
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
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

module.exports = {
  getSocialNetworks,
  createSocialNetwork,
  updateSocialNetwork,
  deleteSocialNetwork,
  checkSubscription,
};
