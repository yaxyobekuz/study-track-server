/**
 * Changelog Telegram xabarnomasi.
 *
 * Har kuni sozlamada ko'rsatilgan vaqtda (standart 09:00) KECHAGI kun uchun
 * yozuv bo'lsa — faol chatlarga yuboradi. Yozuv bo'lmasa hech narsa qilmaydi.
 * Dushanba kuni qo'shimcha haftalik yig'ma ham yuboriladi.
 *
 * NIMA UCHUN HAR 5 DAQIQADA, "0 9 * * *" EMAS:
 * yuborish vaqti bazada, cron ifodasi esa `cron.schedule()` chaqirilganda —
 * server ishga tushganda — qotib qoladi. Admin vaqtni 09:00 dan 18:30 ga
 * o'zgartirsa, ifodadagi "9" keyingi deploy'gacha eskirib qolardi.
 * Har 5 daqiqada tekshirish yana bir foyda beradi: server 09:00 da bir necha
 * daqiqa o'chiq bo'lsa ham, ko'tarilgach o'sha kuni xabar baribir ketadi.
 *
 * Tekshiruv `now < sendTime` (`!==` EMAS) — yuqoridagi sabab uchun.
 * Takrorlanmaslikni `lastDailySentDate` (shartli UPDATE) kafolatlaydi.
 *
 * KAFOLAT DARAJASI: at-most-once. Yuborish o'rtasida server yiqilsa o'sha kun
 * xabari qayta ketmaydi — guruh chatiga ikki marta bir xil hisobot tushgani
 * o'tkazib yuborilgandan yomonroq. Qo'lda yuborish tugmasi bu holatni qoplaydi.
 */

const cron = require("node-cron");
const logger = require("../utils/logger");
const changelogNotificationService = require("../services/changelogNotification.service");
const {
  getNowInUzbekistan,
  getTashkentDateUtc,
  timeToMinutes,
} = require("../helpers/date.helpers");

const MS_PER_DAY = 86400000;

/**
 * Bitta tekshiruv. Qo'lda ham chaqirsa bo'ladi (test uchun).
 *
 * @param {{force?: boolean}} [options] force — vaqt tekshiruvini o'tkazib yuboradi
 * @returns {Promise<object>}
 */
async function runChangelogNotificationPass(options = {}) {
  const { force = false } = options;

  const settings = await changelogNotificationService.getSettings();

  if (!settings.dailyEnabled) return { skipped: "disabled" };

  const recipients = settings.recipients.filter((r) => r.isActive);
  if (recipients.length === 0) return { skipped: "no_recipients" };

  const nowUz = getNowInUzbekistan();
  const nowMinutes = nowUz.getHours() * 60 + nowUz.getMinutes();

  if (!force && nowMinutes < timeToMinutes(settings.sendTime)) {
    return { skipped: "too_early" };
  }

  // "Kecha" — Toshkent kalendar kuni, UTC yarim tuniga keltirilgan.
  const target = getTashkentDateUtc(-1);

  const lastSent = settings.lastDailySentDate;
  if (!force && lastSent && lastSent.getTime() >= target.getTime()) {
    return { skipped: "already_sent" };
  }

  const entries = await changelogNotificationService.collectEntries(target, target);

  // MUHIM: yozuv bo'lmasa `lastDailySentDate` SILJITILMAYDI.
  // Sabab: /changelog ko'pincha kunduzi, 09:00 dan keyin ishga tushiriladi.
  // Agar 09:00 da "yozuv yo'q" deb belgilab qo'yilsa, soat 10:00 da yuklangan
  // kechagi hisobot hech qachon ketmasdi. Belgilamasak — keyingi tekshiruvda
  // topiladi va o'sha kuni yetkaziladi. Yarim tunda "kecha" siljiydi, ya'ni
  // cheksiz kutish yo'q.
  if (entries.length === 0) return { skipped: "no_entries" };

  // Yuborishdan OLDIN egallash — ikkita instans bir kunni ikki marta yubormaydi.
  if (!force && !(await changelogNotificationService.claimDaily(target))) {
    return { skipped: "claimed_elsewhere" };
  }

  const summary = await changelogNotificationService.sendForDate(target, { kind: "daily" });

  logger.info(
    `[ChangelogNotify] ${summary.entryCount} ta yozuv, ${summary.messageCount} ta xabar, ` +
      `${summary.sent} yuborildi, ${summary.failed} xato`,
  );

  return summary;
}

/**
 * Haftalik yig'ma — dushanba kuni, o'tgan 7 kun uchun.
 */
async function runChangelogWeeklyPass(options = {}) {
  const { force = false } = options;

  const settings = await changelogNotificationService.getSettings();

  if (!settings.weeklyEnabled) return { skipped: "disabled" };

  const recipients = settings.recipients.filter((r) => r.isActive);
  if (recipients.length === 0) return { skipped: "no_recipients" };

  const nowUz = getNowInUzbekistan();

  // 1 = dushanba
  if (!force && nowUz.getDay() !== 1) return { skipped: "not_monday" };

  const nowMinutes = nowUz.getHours() * 60 + nowUz.getMinutes();
  if (!force && nowMinutes < timeToMinutes(settings.sendTime)) {
    return { skipped: "too_early" };
  }

  const to = getTashkentDateUtc(-1);
  const from = new Date(to.getTime() - 6 * MS_PER_DAY);

  // Shu hafta allaqachon yuborilganmi
  const lastSent = settings.lastWeeklySentAt;
  if (!force && lastSent && lastSent.getTime() > to.getTime()) {
    return { skipped: "already_sent" };
  }

  const entries = await changelogNotificationService.collectEntries(from, to);
  if (entries.length === 0) return { skipped: "no_entries" };

  const summary = await changelogNotificationService.sendForRange(from, to, { kind: "weekly" });

  await changelogNotificationService.markWeeklySent();

  logger.info(
    `[ChangelogNotify] Haftalik: ${summary.entryCount} ta yozuv, ` +
      `${summary.sent} yuborildi, ${summary.failed} xato`,
  );

  return summary;
}

function startChangelogNotificationCron() {
  cron.schedule(
    "*/5 * * * *",
    async () => {
      // Har tikda log yozilmaydi — kuniga 288 ta yozuv jurnalni ko'mib
      // yuborardi. Faqat haqiqiy ish bo'lganda yoziladi.
      try {
        await runChangelogNotificationPass();
      } catch (error) {
        logger.error("[ChangelogNotify] Kunlik xabarnoma xatosi:", error);
      }

      try {
        await runChangelogWeeklyPass();
      } catch (error) {
        logger.error("[ChangelogNotify] Haftalik xabarnoma xatosi:", error);
      }
    },
    {
      scheduled: true,
      timezone: "Asia/Tashkent",
    },
  );

  logger.info(
    "Changelog xabarnoma cron job belgilandi: Har 5 daqiqada tekshiriladi (Asia/Tashkent)",
  );
}

module.exports = {
  startChangelogNotificationCron,
  runChangelogNotificationPass,
  runChangelogWeeklyPass,
};
