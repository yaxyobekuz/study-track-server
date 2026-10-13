// GURUH SIGNALLARI — admin paneldagi "Guruh signallari" tabi.
//
// Nozik qoidalar service'da (`groupSignal.service.js`), bu yerda faqat
// so'rov/javob.

const asyncHandler = require("../middleware/async.middleware");
const groupSignalService = require("../services/groupSignal.service");
const { runGroupSignalPass } = require("../jobs/groupSignal.job");

/**
 * AI topgan signallar ro'yxati.
 * GET /api/group-signals?status=new&kind=complaint&chatId=...
 */
const getSignals = asyncHandler(async (req, res) => {
  const data = await groupSignalService.listSignals(req.query);
  res.json({ success: true, data });
});

/**
 * Holat bo'yicha sanoq — tabdagi belgi uchun.
 * GET /api/group-signals/counts
 */
const getCounts = asyncHandler(async (req, res) => {
  const data = await groupSignalService.getSignalCounts();
  res.json({ success: true, data });
});

/**
 * Signalni muammolarga biriktirish — "tezkor" usul.
 * POST /api/group-signals/:id/attach  { categoryId }
 *
 * ⚠️ Muammo JORIY FILIALDA yaratiladi (`config/prisma.js` konteksti):
 * guruh filialga tegishli emas, muammo esa albatta tegishli bo'lishi
 * kerak — qaysi filial biriktirsa, o'sha filialning muammosi bo'ladi.
 */
const attachSignal = asyncHandler(async (req, res) => {
  const data = await groupSignalService.attach(
    req.params.id,
    req.body,
    req.user.id,
  );
  res.json({ success: true, data });
});

/**
 * "Bu muammo emas" — signalni e'tiborsiz qoldirish.
 * POST /api/group-signals/:id/dismiss
 */
const dismissSignal = asyncHandler(async (req, res) => {
  const data = await groupSignalService.dismiss(req.params.id, req.user.id);
  res.json({ success: true, data });
});

/**
 * HOZIR TEKSHIRISH — 30 daqiqalik aylanishni kutmasdan tahlil qilish.
 * POST /api/group-signals/refresh
 *
 * ⚠️ YANGI XABAR OLIB KELMAYDI: xabarlarni BOT yozadi (guruhga xabar
 * tushganda, darhol). Bu tugma faqat NAVBATDAGI xabarlarni tahlil
 * qiladi, ya'ni "signal hali chiqmagan" holatini tezlashtiradi.
 * Guruhda umuman yangi gap bo'lmasa, natija nol bo'ladi — bu normal.
 *
 * ⚠️ XATO OTMAYDI: `runGroupSignalPass` har qanday nosozlikni o'zi
 * ushlaydi va `error: true` qaytaradi, panel esa shunga qarab xabar
 * ko'rsatadi. Bu fon ishi — 500 bilan tugashi noto'g'ri bo'lardi.
 *
 * ⚠️ IKKI MARTA BOSILSA bitta aylanish ketadi: job ichida qo'riqchi bor.
 */
const refreshSignals = asyncHandler(async (req, res) => {
  const data = await runGroupSignalPass();
  res.json({ success: true, data });
});

module.exports = {
  getSignals,
  getCounts,
  refreshSignals,
  attachSignal,
  dismissSignal,
};
