/**
 * MOBIL PUSH — Firebase Cloud Messaging.
 *
 * Ikki vazifa:
 *   1. Qurilma reyestri — mobil ilova login qilgach FCM tokenini yozadi,
 *      chiqishda o'chiradi (`push_devices`, platformada).
 *   2. Yuborish — `sendToUsers(userIds, message)`.
 *
 * ⚠️ PUSH HECH QACHON ASOSIY AMALNI YIQITMAYDI. Topshiriq bazaga yozilgan,
 * Firebase esa tashqi xizmat: u ishlamay qolsa foydalanuvchi "topshiriq
 * yuborilmadi" degan soxta xato ko'rmasligi kerak. Shuning uchun
 * `sendToUsers` xato TASHLAMAYDI — faqat log yozadi.
 *
 * ⚠️ `FIREBASE_SERVICE_ACCOUNT_BASE64` bo'sh bo'lsa push O'CHIQ va server
 * normal ishlaydi (OpenAI kaliti bilan bir xil yondashuv).
 */

const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");

const platformPrisma = require("../config/platformPrisma");
const { config } = require("../config/env.config");
const logger = require("../utils/logger");

const APP_NAME = "study-track-push";
const PLATFORMS = ["android", "ios"];
// FCM `sendEachForMulticast` bir chaqiruvda ko'pi bilan 500 token qabul qiladi.
const FCM_BATCH_SIZE = 500;
// Bu kodlar tokenning O'ZI yaroqsizligini bildiradi (ilova o'chirilgan,
// token yangilangan) — bunday qatorni saqlashdan foyda yo'q. Tarmoq yoki
// kvota xatolarida esa token o'chirilmaydi.
const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

// undefined — hali urinilmagan, null — o'chiq (kalit yo'q yoki yaroqsiz)
let messaging;

/**
 * Firebase client'ini birinchi kerak bo'lganda ko'taradi.
 * @returns {import("firebase-admin/messaging").Messaging|null}
 */
function getClient() {
  if (messaging !== undefined) return messaging;

  if (!config.firebaseServiceAccountBase64) {
    logger.info("[push] FIREBASE_SERVICE_ACCOUNT_BASE64 kiritilmagan — push o'chiq");
    messaging = null;
    return messaging;
  }

  try {
    const serviceAccount = JSON.parse(
      Buffer.from(config.firebaseServiceAccountBase64, "base64").toString("utf8"),
    );
    const app =
      getApps().find((a) => a.name === APP_NAME) ||
      initializeApp({ credential: cert(serviceAccount) }, APP_NAME);
    messaging = getMessaging(app);
    logger.info(`[push] Firebase ulandi (${serviceAccount.project_id})`);
  } catch (error) {
    logger.error(`[push] Firebase kaliti yaroqsiz — push o'chiq: ${error.message}`);
    messaging = null;
  }

  return messaging;
}

const isEnabled = () => Boolean(getClient());

/* ───────────────────────── Qurilma reyestri ───────────────────────── */

/**
 * Qurilmani ro'yxatga oladi yoki yangilaydi.
 *
 * ⚠️ Kalit — `token`. Shu telefonga boshqa odam kirsa qator unga KO'CHADI:
 * aks holda avvalgi egasining topshiriqlari yangi odamga ko'rinardi.
 *
 * @param {{ token: string, platform?: string|null, userId: string, branchId: string, jti?: string|null }} input
 */
async function registerDevice({ token, platform, userId, branchId, jti }) {
  const data = {
    userId,
    branchId,
    jti: jti || null,
    platform: PLATFORMS.includes(platform) ? platform : null,
  };

  return platformPrisma.pushDevice.upsert({
    where: { token },
    create: { token, ...data },
    update: data,
    select: { id: true, platform: true, updatedAt: true },
  });
}

/**
 * Qurilmani o'chiradi. Faqat O'ZINING tokenini — boshqa odamnikini
 * o'chirib uning bildirishnomalarini to'xtatib bo'lmasligi kerak.
 */
async function unregisterDevice({ token, userId }) {
  const { count } = await platformPrisma.pushDevice.deleteMany({
    where: { token, userId },
  });
  return { removed: count };
}

/**
 * Seans yopilganda (logout) shu seansga bog'langan qurilmalarni o'chiradi.
 * Ilova `DELETE /push/devices` ni chaqirmay chiqib ketsa ham telefon
 * bildirishnoma olishda davom etmasligi uchun.
 */
async function forgetSession(jti) {
  if (!jti) return { removed: 0 };
  try {
    const { count } = await platformPrisma.pushDevice.deleteMany({ where: { jti } });
    return { removed: count };
  } catch (error) {
    logger.warn(`[push] seans qurilmalari o'chirilmadi: ${error.message}`);
    return { removed: 0 };
  }
}

/**
 * Filial almashtirilganda qurilmani yangi seansga ko'chiradi.
 * ⚠️ Kutilmaydi va xato tashlamaydi — filial almashtirish push tufayli
 * yiqilmasligi kerak.
 */
function moveSession(oldJti, { jti, branchId }) {
  if (!oldJti) return;
  platformPrisma.pushDevice
    .updateMany({ where: { jti: oldJti }, data: { jti, branchId } })
    .catch((error) =>
      logger.warn(`[push] qurilma yangi seansga ko'chirilmadi: ${error.message}`),
    );
}

/**
 * Seansi TIRIK qurilmalarni qoldiradi.
 *
 * ⚠️ `auth.middleware` bilan bir xil qoida: `jti` siz qator yoki
 * `user_sessions` da topilmagan `jti` o'tadi (eski token), yopilgan yoki
 * muddati o'tgan seans o'tmaydi.
 */
async function filterLiveDevices(devices) {
  const jtis = [...new Set(devices.map((d) => d.jti).filter(Boolean))];
  if (jtis.length === 0) return devices;

  const sessions = await platformPrisma.userSession.findMany({
    where: { jti: { in: jtis } },
    select: { jti: true, endReason: true, expiresAt: true },
  });
  const now = new Date();
  const dead = new Set(
    sessions
      .filter((s) => s.endReason !== "active" || s.expiresAt <= now)
      .map((s) => s.jti),
  );

  return devices.filter((d) => !d.jti || !dead.has(d.jti));
}

/* ───────────────────────────── Yuborish ───────────────────────────── */

/**
 * FCM `data` qiymatlari faqat STRING bo'lishi mumkin — aks holda butun
 * so'rov `invalid-argument` bilan rad etiladi.
 */
function stringifyData(data = {}) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]),
  );
}

/**
 * Foydalanuvchilarning barcha tirik qurilmalariga push yuboradi.
 *
 * @param {string[]} userIds
 * @param {{ title: string, body: string, data?: object, channelId?: string }} message
 * @returns {Promise<{ sent: number, failed: number, removed: number, skipped?: string }>}
 */
async function sendToUsers(userIds, { title, body, data, channelId }) {
  const result = { sent: 0, failed: 0, removed: 0 };

  try {
    const client = getClient();
    if (!client) return { ...result, skipped: "disabled" };

    const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
    if (ids.length === 0) return { ...result, skipped: "no_users" };

    const devices = await filterLiveDevices(
      await platformPrisma.pushDevice.findMany({
        where: { userId: { in: ids } },
        select: { token: true, jti: true },
      }),
    );
    if (devices.length === 0) return { ...result, skipped: "no_devices" };

    const tokens = devices.map((d) => d.token);
    const deadTokens = [];

    for (let i = 0; i < tokens.length; i += FCM_BATCH_SIZE) {
      const batch = tokens.slice(i, i + FCM_BATCH_SIZE);
      const response = await client.sendEachForMulticast({
        tokens: batch,
        notification: { title, body },
        data: stringifyData(data),
        android: {
          priority: "high",
          notification: { sound: "default", ...(channelId ? { channelId } : {}) },
        },
        apns: { payload: { aps: { sound: "default" } } },
      });

      result.sent += response.successCount;
      result.failed += response.failureCount;

      response.responses.forEach((r, idx) => {
        if (r.success) return;
        const code = r.error?.code;
        if (DEAD_TOKEN_CODES.has(code)) deadTokens.push(batch[idx]);
        else logger.warn(`[push] yuborilmadi (${code || "noma'lum"}): ${r.error?.message}`);
      });
    }

    if (deadTokens.length > 0) {
      const { count } = await platformPrisma.pushDevice.deleteMany({
        where: { token: { in: deadTokens } },
      });
      result.removed = count;
    }
  } catch (error) {
    logger.error(`[push] yuborishda xato: ${error.message}`);
  }

  return result;
}

module.exports = {
  PLATFORMS,
  isEnabled,
  registerDevice,
  unregisterDevice,
  forgetSession,
  moveSession,
  sendToUsers,
  // test uchun
  _filterLiveDevices: filterLiveDevices,
  _stringifyData: stringifyData,
};
