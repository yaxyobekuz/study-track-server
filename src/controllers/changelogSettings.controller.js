const asyncHandler = require("../middleware/async.middleware");
const changelogNotificationService = require("../services/changelogNotification.service");
const { normalizeDate } = require("../helpers/changelogMarkdown.helpers");
const { getTashkentDateUtc } = require("../helpers/date.helpers");

const getSettings = asyncHandler(async (req, res) => {
  const settings = await changelogNotificationService.getSettings();
  res.json({ success: true, data: settings });
});

const updateSettings = asyncHandler(async (req, res) => {
  const settings = await changelogNotificationService.updateSettings(req.body, req.user.id);
  res.json({ success: true, message: "Sozlamalar saqlandi", data: settings });
});

const getNotifications = asyncHandler(async (req, res) => {
  const result = await changelogNotificationService.listNotifications(req);
  res.json(result);
});

/**
 * Qo'lda yuborish. Tanasi:
 *   { date: "2026-08-17" }              — bitta kun
 *   { from: "2026-08-10", to: "..." }   — oraliq (haftalik yig'ma)
 * Bo'sh bo'lsa — kecha.
 *
 * DIQQAT: `dailyEnabled` bu yerda TEKSHIRILMAYDI. Tugma — insonning aniq
 * harakati, va aynan shu yo'l bilan yoqishdan oldin ko'rinishini tekshiriladi.
 */
const sendNow = asyncHandler(async (req, res) => {
  const { date, from, to } = req.body || {};

  const summary =
    from || to
      ? await changelogNotificationService.sendForRange(
          normalizeDate(from || to),
          normalizeDate(to || from),
          { kind: "manual", sentBy: req.user.id },
        )
      : await changelogNotificationService.sendForDate(
          date ? normalizeDate(date) : getTashkentDateUtc(-1),
          { kind: "manual", sentBy: req.user.id },
        );

  const message =
    summary.entryCount === 0
      ? "Bu sana uchun yozuv yo'q — hech narsa yuborilmadi"
      : `${summary.sent} ta chatga yuborildi${summary.failed ? `, ${summary.failed} ta xato` : ""}`;

  res.json({ success: true, message, data: summary });
});

module.exports = {
  getSettings,
  updateSettings,
  getNotifications,
  sendNow,
};
