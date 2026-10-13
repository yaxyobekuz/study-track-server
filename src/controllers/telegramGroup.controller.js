// TELEGRAM GURUHLARI — admin paneldagi "Bot sozlamalari" tabi.
//
// Nozik qoidalar service'da (`telegramGroup.service.js`), bu yerda faqat
// so'rov/javob.

const asyncHandler = require("../middleware/async.middleware");
const telegramGroupService = require("../services/telegramGroup.service");
const { ValidationError } = require("../utils/errors");

/**
 * Bot ko'rgan guruhlar ro'yxati.
 * GET /api/telegram-groups
 */
const getGroups = asyncHandler(async (req, res) => {
  const data = await telegramGroupService.listGroups();
  res.json({ success: true, data });
});

/**
 * Saqlangan guruhlarni Telegram'dan qayta tekshirish.
 * POST /api/telegram-groups/refresh
 *
 * ⚠️ YANGI GURUH TOPMAYDI — service izohiga qarang. Javobda sanoqlar
 * qaytadi, panel esa shuni xabar sifatida ko'rsatadi.
 */
const refreshGroups = asyncHandler(async (req, res) => {
  const data = await telegramGroupService.refreshGroups();
  res.json({ success: true, data });
});

/**
 * "Rasmiy guruh" belgisini qo'yish / olib tashlash.
 * PATCH /api/telegram-groups/:chatId/official
 *
 * ⚠️ `chatId` — Telegram beradigan son (manfiy ham bo'ladi: "-1001234..."),
 * ObjectId EMAS. Shuning uchun route'da `validateObjectId` ishlatilmaydi.
 */
const setOfficial = asyncHandler(async (req, res) => {
  const { isOfficial } = req.body;

  if (typeof isOfficial !== "boolean") {
    throw new ValidationError("`isOfficial` mantiqiy qiymat bo'lishi kerak");
  }

  const data = await telegramGroupService.setOfficial(
    req.params.chatId,
    isOfficial,
    { userId: req.user.id, branchId: req.branch?.id },
  );

  res.json({ success: true, data });
});

module.exports = { getGroups, refreshGroups, setOfficial };
