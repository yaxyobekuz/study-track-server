/**
 * Kunlik monitoring eslatmasi.
 *
 * Sozlamada ko'rsatilgan vaqtdan keyin (standart 17:00) hisobot bermagan
 * xonalarning MAS'UL SHAXSLARIGA Telegram xabari yuboradi. Hammasi hisobot
 * bergan bo'lsa hech narsa qilmaydi.
 *
 * NIMA UCHUN HAR 15 DAQIQADA, "0 17 * * *" EMAS:
 * yuborish vaqti bazada, cron ifodasi esa `cron.schedule()` chaqirilganda —
 * server ishga tushganda — qotib qoladi. Admin vaqtni o'zgartirsa,
 * ifodadagi soat keyingi deploy'gacha eskirib qolardi
 * (`changelogNotification.job.js` bilan aynan bir xil qaror).
 *
 * KAFOLAT DARAJASI: at-most-once kun bo'yicha. Takrorlanmaslik xotiradagi
 * "qaysi filialda qaysi kun yuborilgan" xaritasi bilan ta'minlanadi —
 * changelog job'idagi `lastDailySentDate` ustuniga o'xshash, lekin
 * yengilroq: eslatma o'tkazib yuborilsa maktab hech narsa yo'qotmaydi
 * (ertaga yana keladi), ikki marta ketsa esa xodimni bezovta qiladi.
 * Server qayta ishga tushsa o'sha kuni eslatma yana bir marta ketishi
 * mumkin — bu ataylab qabul qilingan murosa.
 */

const cron = require("node-cron");
const logger = require("../utils/logger");
const { branchCron } = require("../helpers/branchIterator");
const { getBranch } = require("../config/branchContext");
const {
  getNowInUzbekistan,
  getTashkentDateUtc,
  timeToMinutes,
} = require("../helpers/date.helpers");
const { getInventorySettings } = require("../services/settings.service");
const { getPendingLocations } = require("../services/inventoryCheck.service");
const telegramService = require("../services/telegram.service");

// filialId → "YYYY-MM-DD" (o'sha filialda eslatma yuborilgan oxirgi kun)
const sentByBranch = new Map();

/** Telegram HTML uchun ekranlash — `changelogMessage.helpers.js` bilan bir xil. */
const escapeHtml = (text) =>
  String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * Bitta tekshiruv passi. Qo'lda ham chaqirsa bo'ladi (test uchun).
 *
 * @param {{force?: boolean}} [options] force — vaqt tekshiruvini o'tkazib yuboradi
 */
async function runInventoryReminderPass(options = {}) {
  const { force = false } = options;

  const branch = getBranch();
  const branchId = branch?.id ?? "default";
  const tag = `[InventoryReminder] ${branch ? branch.name : "?"}`;

  const settings = await getInventorySettings();

  if (!settings.dailyCheckEnabled) return { skipped: "monitoring_disabled" };
  if (!settings.reminderEnabled) return { skipped: "reminder_disabled" };

  // ⚠️ `getNowInUzbekistan()` Toshkent DEVOR-SOATINI mahalliy Date sifatida
  // qaytaradi, shuning uchun soat/daqiqa `getHours()/getMinutes()` bilan
  // o'qiladi — `getUTC*` bilan EMAS (changelog job'i bilan bir xil).
  const nowUz = getNowInUzbekistan();
  // Kun kaliti esa Toshkent kalendaridan, UTC yarim tuniga keltirilgan
  // holda olinadi — `Date.now()` arifmetikasi bu yerda noto'g'ri natija
  // berardi (`.claude/rules/dates.md`, changelog "Sana tuzog'i").
  const today = getTashkentDateUtc(0).toISOString().slice(0, 10);

  if (!force) {
    // `<` (`!==` EMAS): server eslatma vaqtida bir necha daqiqa o'chiq
    // bo'lsa ham, ko'tarilgach xabar o'sha kuni baribir ketadi
    const nowMinutes = nowUz.getHours() * 60 + nowUz.getMinutes();
    if (nowMinutes < timeToMinutes(settings.reminderTime)) {
      return { skipped: "too_early" };
    }
    if (sentByBranch.get(branchId) === today) return { skipped: "already_sent" };
  }

  const pending = await getPendingLocations();

  if (pending.pendingCount === 0) {
    sentByBranch.set(branchId, today);
    logger.info(`${tag} Barcha xonalar hisobot berdi — eslatma kerak emas`);
    return { skipped: "all_submitted", ...pending };
  }

  // Mas'ul shaxs bo'yicha guruhlash: bitta odam uchta xonaga mas'ul bo'lsa,
  // unga uchta emas, BITTA xabar ketadi
  const byPerson = new Map();
  const orphanLocations = [];

  for (const location of pending.locations) {
    if (!location.responsible?.telegramIds?.length) {
      orphanLocations.push(location.name);
      continue;
    }

    const entry = byPerson.get(location.responsible.id) ?? {
      person: location.responsible,
      locations: [],
    };
    entry.locations.push(location.name);
    byPerson.set(location.responsible.id, entry);
  }

  let sent = 0;
  let failed = 0;

  for (const { person, locations } of byPerson.values()) {
    const list = locations.map((name) => `• ${escapeHtml(name)}`).join("\n");
    const text =
      `<b>Kunlik jihoz hisoboti</b>\n\n` +
      `${escapeHtml(pending.dateLabel)} uchun hisobot yuborilmagan:\n${list}\n\n` +
      `Iltimos, xonadagi jihozlar holatini kiritib, hisobotni yuboring.`;

    for (const telegramId of person.telegramIds) {
      try {
        await telegramService.sendMessage(telegramId, text);
        sent += 1;
      } catch (error) {
        failed += 1;
        logger.warn(
          `${tag} Xabar yuborilmadi: person=${person.id} tg=${telegramId} — ${error.message}`,
        );
      }
    }
  }

  sentByBranch.set(branchId, today);

  if (orphanLocations.length > 0) {
    // Mas'ulsiz xona — eslatma ketadigan manzil yo'q. Bu ma'lumot
    // to'liq emasligini bildiradi, shuning uchun logda ko'rinadi.
    logger.warn(
      `${tag} Mas'uli yoki Telegram'i yo'q xonalar: ${orphanLocations.join(", ")}`,
    );
  }

  logger.info(
    `${tag} Eslatma: ${pending.pendingCount} ta xona · ${byPerson.size} ta xodim · ` +
      `${sent} ta xabar yuborildi${failed ? `, ${failed} ta xato` : ""}`,
  );

  return { sent, failed, pendingCount: pending.pendingCount };
}

/** Cron jobni belgilaydi. Har 15 daqiqada (Asia/Tashkent). */
function startInventoryCheckReminderCron() {
  cron.schedule(
    "*/15 * * * *",
    branchCron("[InventoryReminderCron]", async (branch) => {
      try {
        await runInventoryReminderPass();
      } catch (error) {
        logger.error(`[InventoryReminder] ${branch.name}: cron xatosi`, error);
      }
    }),
    { scheduled: true, timezone: "Asia/Tashkent" },
  );

  logger.info(
    "Inventar eslatma cron job belgilandi: Har 15 daqiqada (vaqt bazadan o'qiladi)",
  );
}

module.exports = { startInventoryCheckReminderCron, runInventoryReminderPass };
