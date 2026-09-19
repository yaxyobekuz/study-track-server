/**
 * PUSH TOKEN TEKSHIRUVI — kuniga 2 marta, 04:10 va 16:10.
 *
 * Tirik seansli barcha mobil qurilmalarga ovozsiz "ping" yuboradi
 * (`push.service.js` → `probeDevices`). Firebase o'chirilgan ilovaning
 * tokenini `registration-token-not-registered` deb qaytaradi va o'sha
 * seans `app_removed` bilan yopiladi — o'qituvchining limitdagi joyi
 * `SESSION_IDLE_DAYS` (4 kun) kutmasdan bo'shaydi.
 *
 * ⚠️ NIMA UCHUN ALOHIDA JOB: o'lik token faqat xabar yuborilganda ma'lum
 * bo'ladi. Topshiriq olmagan odamning o'chirilgan ilovasi bir hafta
 * sezilmay qolardi.
 *
 * ⚠️ KUNIGA IKKI MARTA: Android'da o'chirilgandan keyingi birinchi xabar
 * ko'pincha "yetkazildi" bo'lib qaytadi, `not-registered` ikkinchisida
 * keladi. Ikki tekshiruv bilan seans amalda ~1 kun ichida yopiladi.
 *
 * ⚠️ `PUSH_TOKEN_PROBE_ENABLED` bilan yoqiladi — mobil ilova `ping` ni
 * jimgina e'tiborsiz qoldiradigan versiyasi chiqqandan keyin. Push o'chiq
 * bo'lsa (Firebase kaliti yo'q) jimgina chiqadi.
 *
 * ⚠️ FILIAL BO'YICHA AYLANMAYDI (`branchCron` YO'Q): `push_devices` va
 * `user_sessions` platformada — bitta o'tish hammasini qamrab oladi.
 */

const cron = require("node-cron");
const pushService = require("../services/push.service");
const { config } = require("../config/env.config");
const logger = require("../utils/logger");

/**
 * Bitta tekshiruv passi. Xato tashlamaydi.
 *
 * @returns {Promise<object|null>} - `probeDevices` natijasi
 */
async function runPushTokenProbe() {
  try {
    if (!pushService.isEnabled()) return null;

    logger.info("[PushTokenProbe] boshlandi");
    const result = await pushService.probeDevices();
    logger.info(
      `[PushTokenProbe] tugadi: ${result.probed} ta qurilma tekshirildi, ` +
        `${result.removed} ta o'lik token o'chirildi, ` +
        `${result.closed} ta seans yopildi (ilova o'chirilgan)`,
    );
    return result;
  } catch (error) {
    logger.error("[PushTokenProbe] xato", error);
    return null;
  }
}

/** Cron jobni belgilaydi. Har kuni 04:10 va 16:10 (Asia/Tashkent). */
function startPushTokenProbeCron() {
  if (!config.pushTokenProbeEnabled) {
    logger.info("Push token tekshiruvi o'chiq (PUSH_TOKEN_PROBE_ENABLED)");
    return;
  }

  cron.schedule("10 4,16 * * *", runPushTokenProbe, {
    scheduled: true,
    timezone: "Asia/Tashkent",
  });

  logger.info(
    "Push token tekshiruvi cron job belgilandi: Har kuni 04:10 va 16:10 (Asia/Tashkent)",
  );
}

module.exports = { startPushTokenProbeCron, runPushTokenProbe };
