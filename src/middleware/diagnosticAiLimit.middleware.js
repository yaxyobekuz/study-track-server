const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

/**
 * ⚠️ IP ZAXIRASI `ipKeyGenerator` ORQALI. Xom `req.ip` IPv6 da har bir
 * so'rov uchun boshqa manzil berishi mumkin (bitta /64 blokdan cheksiz
 * manzil ajratiladi) — ya'ni cheklovni oddiygina aylanib o'tib bo'lardi.
 * Kutubxonaning o'zi ham bu holatni ishga tushirishda rad etadi.
 *
 * Amalda bu tarmoq ishlamaydi: ikkala yo'l ham `protect` ortida, ya'ni
 * `req.user.id` har doim bor. Zaxira faqat kelajakda yo'l ochiq
 * qoldirilsa kalitsiz qolmaslik uchun.
 */
const keyByUser = (req, res) => req.user?.id || ipKeyGenerator(req, res);

/**
 * DIAGNOSTIKA AI CHEKLOVI.
 *
 * ⚠️ KALIT — FOYDALANUVCHI, IP EMAS. Butun maktab bitta tashqi IP ortida
 * o'tiradi (NAT): IP bo'yicha cheklov bitta o'quvchining ketma-ket
 * bosishi tufayli QOLGAN HAMMANI bloklab qo'yardi. `req.user.id`
 * `protect` dan keyin har doim mavjud.
 *
 * ⚠️ NEGA UMUMAN KERAK: bu endpointlar har chaqiruvda PULLIK model
 * so'rovini yuboradi. Global cheklov (100 so'rov/daqiqa) bu yerda juda
 * bo'sh: bitta odam daqiqasiga 100 ta model chaqiruvini yuborishi mumkin
 * edi, ya'ni tugmani ushlab turish hisobni bo'shatardi.
 *
 * Chegara ATAYLAB saxiy: repetitor bilan suhbat tabiiy ravishda tez-tez
 * bo'ladi, maqsad — suhbatni cheklash emas, avtomatlashtirilgan
 * suiiste'molni to'xtatish.
 */
const diagnosticAiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: keyByUser,
  // Chegaraga yetgan so'rov ham hisoblansin — aks holda urinishni
  // davom ettirish oynani cheksiz cho'zardi.
  skipSuccessfulRequests: false,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Juda ko'p AI so'rovi. Bir daqiqadan so'ng qayta urinib ko'ring.",
  },
});

/**
 * Og'ir amallar uchun (butun urinishni qayta tahlil qilish — bir necha
 * model chaqiruvi birdan).
 */
const diagnosticAnalysisLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  keyGenerator: keyByUser,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message:
      "Tahlil juda tez-tez so'ralmoqda. Bir necha daqiqadan so'ng urinib ko'ring.",
  },
});

module.exports = { diagnosticAiLimiter, diagnosticAnalysisLimiter };
