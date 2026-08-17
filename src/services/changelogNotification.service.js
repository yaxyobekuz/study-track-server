// ─────────────────────────────────────────────
// CHANGELOG XABARNOMALARI
// ─────────────────────────────────────────────
// Sozlamalar (kimga, qachon, yoqilganmi) + Telegram'ga yuborish + jurnal.
//
// Yuborish naqshi `premiumNotification.service.js` dan olingan: ketma-ket,
// har biridan keyin pauza, xatoda `warn` yozadi va HECH QACHON throw qilmaydi
// — bitta chat xato bersa qolganlari ketaveradi.

const prisma = require("../config/prisma");
const telegramService = require("./telegram.service");
const logger = require("../utils/logger");
const { config } = require("../config/env.config");
const { getChangelogSettings } = require("./settings.service");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");
const { BadRequestError } = require("../utils/errors");
const { decodeEntities, normalizeDate } = require("../helpers/changelogMarkdown.helpers");
const { buildChangelogMessages, formatDateUz } = require("../helpers/changelogMessage.helpers");

const SINGLETON = "singleton";

const MAX_RECIPIENTS = 20;

// "HH:mm" (00:00 – 23:59)
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Telegram: raqamli chat id (guruh uchun manfiy) yoki @username
const CHAT_ID_RE = /^(-?\d{5,20}|@[A-Za-z0-9_]{5,32})$/;

// ─────────────────────────────────────────────
// Sozlamalar
// ─────────────────────────────────────────────

/**
 * Qabul qiluvchilar ro'yxatini tekshiradi va tozalaydi.
 * Job ham, servis ham shu funksiyani ishlatadi — qoida bitta joyda.
 *
 * @param {unknown} value
 * @returns {{chatId: string, label: string, isActive: boolean}[]}
 */
function normalizeRecipients(value) {
  if (value === undefined || value === null) return [];

  if (!Array.isArray(value)) {
    throw new BadRequestError("Chat ro'yxati noto'g'ri");
  }

  if (value.length > MAX_RECIPIENTS) {
    throw new BadRequestError(`Chatlar soni ${MAX_RECIPIENTS} tadan oshmasligi kerak`);
  }

  const seen = new Set();
  const result = [];

  for (const raw of value) {
    const chatId = String(raw?.chatId ?? "").trim();

    if (!chatId) {
      throw new BadRequestError("Chat ID bo'sh bo'lmasligi kerak");
    }

    if (!CHAT_ID_RE.test(chatId)) {
      throw new BadRequestError(
        `Chat ID noto'g'ri: "${chatId}". Raqam (masalan -1001234567890) yoki @username bo'lishi kerak`,
      );
    }

    if (seen.has(chatId)) {
      throw new BadRequestError(`Chat ID takrorlangan: "${chatId}"`);
    }
    seen.add(chatId);

    // `xss-clean` req.body dagi belgilarni HTML entity'ga aylantiradi —
    // changelog.service.js dagi kabi orqaga qaytaramiz.
    const label = decodeEntities(raw?.label ?? "").trim();

    result.push({
      chatId,
      label: label || chatId,
      isActive: raw?.isActive !== false,
    });
  }

  return result;
}

async function getSettings() {
  const settings = await getChangelogSettings();
  return { ...settings, recipients: normalizeRecipients(settings.recipients) };
}

async function updateSettings(data = {}, userId = null) {
  const payload = { updatedBy: userId };

  if (data.dailyEnabled !== undefined) payload.dailyEnabled = Boolean(data.dailyEnabled);
  if (data.weeklyEnabled !== undefined) payload.weeklyEnabled = Boolean(data.weeklyEnabled);

  if (data.sendTime !== undefined) {
    const sendTime = String(data.sendTime).trim();
    if (!TIME_RE.test(sendTime)) {
      throw new BadRequestError("Vaqt HH:MM ko'rinishida bo'lishi kerak (masalan 09:00)");
    }
    payload.sendTime = sendTime;
  }

  if (data.recipients !== undefined) {
    payload.recipients = normalizeRecipients(data.recipients);
  }

  await getChangelogSettings(); // singleton mavjudligiga kafolat

  const settings = await prisma.changelogSettings.update({
    where: { id: SINGLETON },
    data: payload,
  });

  return { ...settings, recipients: normalizeRecipients(settings.recipients) };
}

// ─────────────────────────────────────────────
// Yozuvlarni olish
// ─────────────────────────────────────────────

/**
 * Berilgan sana oralig'idagi yozuvlar. Ikkala chegara ham UTC yarim tuni —
 * `Changelog.date` bilan bir xil shakl.
 */
async function collectEntries(from, to) {
  return prisma.changelog.findMany({
    where: { date: { gte: from, lte: to } },
    orderBy: [{ date: "desc" }, { panel: "asc" }],
  });
}

/**
 * Kunni "egallash" — yuborishdan OLDIN chaqiriladi.
 *
 * Bitta shartli UPDATE: `lastDailySentDate` maqsad kundan kichik bo'lsagina
 * yangilanadi. Shu sababli ikkita instans (yoki qayta ishga tushgan server)
 * bir kunni ikki marta yubormaydi — birinchisi egallaydi, ikkinchisiga
 * `count === 0` qaytadi.
 *
 * @param {Date} target
 * @returns {Promise<boolean>} egallandimi
 */
async function claimDaily(target) {
  const claimed = await prisma.changelogSettings.updateMany({
    where: {
      id: SINGLETON,
      OR: [{ lastDailySentDate: null }, { lastDailySentDate: { lt: target } }],
    },
    data: { lastDailySentDate: target, lastDailySentAt: new Date() },
  });

  return claimed.count > 0;
}

/** Haftalik yig'ma yuborilganini belgilaydi. */
async function markWeeklySent() {
  return prisma.changelogSettings.update({
    where: { id: SINGLETON },
    data: { lastWeeklySentAt: new Date() },
  });
}

// ─────────────────────────────────────────────
// Yuborish
// ─────────────────────────────────────────────

/**
 * Xabar(lar)ni qabul qiluvchilarga ketma-ket yuboradi va har biri uchun
 * jurnalga qator yozadi.
 *
 * @param {object} params
 * @param {string[]} params.messages
 * @param {object[]} params.recipients - faol qabul qiluvchilar
 * @param {string} params.kind - daily | weekly | manual
 * @param {object} params.coverage - { date } yoki { from, to }
 * @param {number} params.entryCount
 * @param {string|null} params.sentBy
 * @returns {Promise<{sent: number, failed: number, results: object[]}>}
 */
async function deliver({ messages, recipients, kind, coverage, entryCount, sentBy = null }) {
  const results = [];
  let sent = 0;
  let failed = 0;

  // `telegram.service.js` bot tokeni yo'q bo'lsa THROW qiladi — har bir
  // qabul qiluvchida bekorga otilmasligi uchun oldindan tekshiramiz.
  const hasToken = Boolean(config.telegramBotToken);
  if (!hasToken) {
    logger.warn("[ChangelogNotify] TELEGRAM_BOT_TOKEN yo'q — xabar yuborilmadi");
  }

  for (const recipient of recipients) {
    let error = null;

    if (!hasToken) {
      error = "Telegram bot tokeni sozlanmagan";
    } else {
      for (const text of messages) {
        let result;

        try {
          result = await telegramService.sendMessage(recipient.chatId, text);
        } catch (err) {
          result = { success: false, error: err.message };
        }

        if (!result.success) {
          error = result.error;
          logger.warn(
            `[ChangelogNotify] ${recipient.chatId} (${recipient.label}): ${result.error}`,
          );
          break; // bu chatga qolgan bo'laklarni yuborishning ma'nosi yo'q
        }

        // Uy naqshi: ketma-ket + pauza. 429/retry_after ishlovi repoda
        // hech qayerda yo'q — bu yerda ham ixtiro qilinmaydi.
        await telegramService.sleep(config.messageRateLimitMs);
      }
    }

    if (error) failed += 1;
    else sent += 1;

    results.push({ ...recipient, success: !error, error });

    await prisma.changelogNotification.create({
      data: {
        kind,
        status: error ? "failed" : "sent",
        coverageDate: coverage.date ?? null,
        coverageFrom: coverage.from ?? null,
        coverageTo: coverage.to ?? null,
        chatId: recipient.chatId,
        label: recipient.label,
        entryCount,
        messageCount: messages.length,
        errorMessage: error,
        sentBy,
      },
    });
  }

  return { sent, failed, results };
}

/**
 * Bir kun uchun hisobot yuboradi.
 *
 * @param {Date} date - UTC yarim tuni
 * @param {{kind?: string, sentBy?: string|null}} [options]
 */
async function sendForDate(date, options = {}) {
  const { kind = "manual", sentBy = null } = options;

  const settings = await getSettings();
  const recipients = settings.recipients.filter((r) => r.isActive);

  if (recipients.length === 0) {
    throw new BadRequestError("Faol chat ID yo'q — avval sozlamalarda qo'shing");
  }

  const entries = await collectEntries(date, date);
  const messages = buildChangelogMessages(entries, {
    heading: `${formatDateUz(date)} — tizimdagi o'zgarishlar`,
  });

  if (messages.length === 0) {
    return { entryCount: 0, messageCount: 0, sent: 0, failed: 0, results: [] };
  }

  const summary = await deliver({
    messages,
    recipients,
    kind,
    coverage: { date },
    entryCount: entries.length,
    sentBy,
  });

  return { entryCount: entries.length, messageCount: messages.length, ...summary };
}

/**
 * Sana oralig'i uchun yig'ma hisobot (haftalik).
 */
async function sendForRange(from, to, options = {}) {
  const { kind = "weekly", sentBy = null } = options;

  const settings = await getSettings();
  const recipients = settings.recipients.filter((r) => r.isActive);

  if (recipients.length === 0) {
    throw new BadRequestError("Faol chat ID yo'q — avval sozlamalarda qo'shing");
  }

  const entries = await collectEntries(from, to);
  const messages = buildChangelogMessages(entries, {
    heading: `${formatDateUz(from)} — ${formatDateUz(to)} · haftalik hisobot`,
  });

  if (messages.length === 0) {
    return { entryCount: 0, messageCount: 0, sent: 0, failed: 0, results: [] };
  }

  const summary = await deliver({
    messages,
    recipients,
    kind,
    coverage: { from, to },
    entryCount: entries.length,
    sentBy,
  });

  return { entryCount: entries.length, messageCount: messages.length, ...summary };
}

// ─────────────────────────────────────────────
// Jurnal
// ─────────────────────────────────────────────

async function listNotifications(req) {
  const { page, limit, skip } = getPaginationParams(req, 20);

  const [data, total] = await Promise.all([
    prisma.changelogNotification.findMany({
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.changelogNotification.count(),
  ]);

  return formatPaginationResponse(data, total, page, limit);
}

module.exports = {
  normalizeRecipients,
  getSettings,
  updateSettings,
  collectEntries,
  claimDaily,
  markWeeklySent,
  sendForDate,
  sendForRange,
  listNotifications,
  normalizeDate,
};
