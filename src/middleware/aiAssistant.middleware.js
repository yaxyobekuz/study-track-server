const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { ForbiddenError } = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const { RATE_LIMITS } = require("../services/aiAssistant/assistant.constants");
const {
  createSingleFileUpload,
  handleFileUploadError,
} = require("./fileUpload.middleware");

/**
 * AI YORDAMCHI — FAQAT ASOSIY EGA.
 *
 * ⚠️ `hasRole` / `authorize(ROLES.OWNER)` EMAS. `hasRole` `extraRoles` ni
 * ham ko'radi, `setExtraRoles` esa `owner` ni qo'shimcha rol sifatida
 * berishga ruxsat etadi. Yordamchi butun platforma ma'lumotini o'qiydi va
 * pul/ruxsatlarga tegadigan amallarni taklif qiladi — bu eshik faqat
 * asosiy `role === "owner"` bo'lgan bitta odam uchun. Qo'shimcha: amal
 * bajaruvchilari tayanadigan ko'p controller'lar ham aynan skalyar
 * `role === OWNER` bilan tekshiradi, ya'ni qo'shimcha-rol egasi uchun
 * natija boshqacha chiqardi.
 */
const requirePrimaryOwner = (req, res, next) => {
  if (req.user?.role !== ROLES.OWNER) {
    throw new ForbiddenError("Bu bo'lim faqat tizim egasi uchun");
  }
  next();
};

/**
 * ⚠️ IP ZAXIRASI `ipKeyGenerator` ORQALI (`diagnosticAiLimit.middleware.js`
 * dagi izohga qarang). Amalda hamma yo'l `protect` ortida — kalit doim
 * `req.user.id`.
 */
const keyByUser = (req, res) => req.user?.id || ipKeyGenerator(req, res);

/**
 * ⚠️ NEGA ALOHIDA CHEKLOV: har chat turi bir necha PULLIK model so'rovini
 * (≤ 11 raund + sarlavha) yuboradi. Global cheklov (100/daqiqa, IP bo'yicha)
 * bu yerda himoya qilmaydi.
 */
const buildLimiter = ({ windowMs, max }, message) =>
  rateLimit({
    windowMs,
    max,
    keyGenerator: keyByUser,
    // Chegaraga yetgan so'rov ham hisoblansin — aks holda urinishni
    // davom ettirish oynani cheksiz cho'zardi.
    skipSuccessfulRequests: false,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message },
  });

const chatLimiter = buildLimiter(
  RATE_LIMITS.chat,
  "AI yordamchiga juda ko'p xabar yuborildi. Bir necha daqiqadan so'ng qayta urinib ko'ring.",
);

const speechLimiter = buildLimiter(
  RATE_LIMITS.speech,
  "Ovozda o'qish juda tez-tez so'ralmoqda. Bir necha daqiqadan so'ng qayta urinib ko'ring.",
);

const actionLimiter = buildLimiter(
  RATE_LIMITS.actions,
  "Amallar juda tez-tez yuborilmoqda. Bir daqiqadan so'ng qayta urinib ko'ring.",
);

/**
 * Ovozli xabar (multipart `audio`). JSON so'rovda multer hech narsa
 * qilmaydi — bitta `/chat` yo'li ikkala shaklni ham qabul qiladi.
 * Hajm chegarasi (`LIMITS.maxVoiceBytes`) controller'da: multer chegarasi
 * butun tizim uchun umumiy (20MB).
 */
const voiceUpload = [
  createSingleFileUpload({ fieldName: "audio", categories: ["voice"] }),
  handleFileUploadError,
];

module.exports = {
  requirePrimaryOwner,
  chatLimiter,
  speechLimiter,
  actionLimiter,
  voiceUpload,
};
