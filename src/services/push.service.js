/**
 * MOBIL PUSH — Firebase Cloud Messaging.
 *
 * Ikki vazifa:
 *   1. Qurilma reyestri — mobil ilova login qilgach FCM tokenini yozadi,
 *      chiqishda o'chiradi (`push_devices`, platformada).
 *   2. Yuborish — `sendToUsers(userIds, message)`.
 *   3. Tekshiruv — `probeDevices()`: ovozsiz "ping" (`pushTokenProbe.job.js`).
 *
 * ⚠️ O'LIK TOKEN SEANSNI HAM YOPISHI MUMKIN (2026-09-19). Ilova telefondan
 * o'chirilsa logout chaqirilmaydi — serverga yetadigan yagona signal
 * Firebase'ning `registration-token-not-registered` javobi. Qaror bitta
 * joyda (`dropDeadTokens`): `sendToUsers` ham, `probeDevices` ham shuni
 * chaqiradi — ikki nusxa bo'lsa "token shunchaki yangilangan" sharti
 * bittasida unutilib, ishlab turgan odam tizimdan chiqib ketardi.
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
// ⚠️ Bir tomonlama: `security.service` bu faylni import QILMAYDI (aylanma
// `require` bo'lardi) — shu sababli harakatsiz seanslarning qurilmalarini
// supurgi o'zi o'chiradi (`securitySweep.job.js`).
const securityService = require("./security.service");

const APP_NAME = "study-track-push";
const PLATFORMS = ["android", "ios"];
// FCM `sendEachForMulticast` bir chaqiruvda ko'pi bilan 500 token qabul qiladi.
const FCM_BATCH_SIZE = 500;
// Bu kodlar tokenning O'ZI yaroqsizligini bildiradi (ilova o'chirilgan,
// token yangilangan) — bunday qatorni saqlashdan foyda yo'q. Tarmoq yoki
// kvota xatolarida esa token o'chirilmaydi.
const APP_REMOVED_CODE = "messaging/registration-token-not-registered";
const DEAD_TOKEN_CODES = new Set([
  APP_REMOVED_CODE,
  // ⚠️ Token MATNI buzuq — ilova o'chirilganini BILDIRMAYDI: qator
  // o'chiriladi, lekin seans yopilmaydi.
  "messaging/invalid-registration-token",
]);

/**
 * OVOZSIZ TEKSHIRUV XABARI — faqat `data`, `notification` bloki YO'Q,
 * ya'ni foydalanuvchi hech narsa ko'rmaydi.
 *
 * ⚠️ `data.type = "ping"` — mobil ilova bilan SHARTNOMA: ilova uni jimgina
 * e'tiborsiz qoldiradi. Shuning uchun tekshiruv jobi faqat shunday ilova
 * versiyasi chiqqach yoqiladi (`PUSH_TOKEN_PROBE_ENABLED`).
 *
 * ⚠️ `dryRun` EMAS: u xabarni telefonga yetkazmaydi, Firebase esa ilova
 * o'chirilganini aynan YETKAZIB BO'LMAGAN xabardan keyin biladi.
 */
const PING_MESSAGE = Object.freeze({
  data: { type: "ping" },
  android: { priority: "normal" },
  apns: {
    headers: { "apns-push-type": "background", "apns-priority": "5" },
    payload: { aps: { contentAvailable: true } },
  },
});

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
 * Bir nechta seansning qurilmalarini BIRDAN o'chiradi — kechki supurgi
 * (`securitySweep.job.js`) harakatsiz seanslar uchun chaqiradi.
 *
 * ⚠️ `forgetSession` ni `Promise.all` bilan ming marta chaqirish EMAS:
 * birinchi supurgida 30 kunlik yig'ilgan seanslar bir yo'la yopiladi va
 * har biriga alohida so'rov ulanishlar hovuzini to'ldirardi.
 *
 * @param {string[]} jtis
 * @returns {Promise<{ removed: number }>} - xato tashlamaydi
 */
async function forgetSessions(jtis) {
  const list = [...new Set((jtis || []).filter(Boolean))];
  let removed = 0;

  for (let i = 0; i < list.length; i += 1000) {
    try {
      const { count } = await platformPrisma.pushDevice.deleteMany({
        where: { jti: { in: list.slice(i, i + 1000) } },
      });
      removed += count;
    } catch (error) {
      logger.warn(`[push] seanslar qurilmalari o'chirilmadi: ${error.message}`);
    }
  }

  return { removed };
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
 * ⚠️ `auth.middleware` bilan bir xil qoida (`isSessionLive`): `jti` siz
 * qator yoki `user_sessions` da topilmagan `jti` o'tadi (eski token),
 * yopilgan, muddati o'tgan yoki harakatsiz (`SESSION_IDLE_DAYS`) seans
 * o'tmaydi — u seans bilan kelgan so'rov baribir 401 oladi.
 */
async function filterLiveDevices(devices) {
  const jtis = [...new Set(devices.map((d) => d.jti).filter(Boolean))];
  if (jtis.length === 0) return devices;

  const sessions = await platformPrisma.userSession.findMany({
    where: { jti: { in: jtis } },
    select: { jti: true, endReason: true, expiresAt: true, lastSeenAt: true },
  });
  const dead = new Set(
    sessions.filter((s) => !securityService.isSessionLive(s)).map((s) => s.jti),
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
 * Tokenlarga 500 talik partiyalar bilan yuboradi va javoblarni saralaydi.
 *
 * ⚠️ Partiya xatosi (tarmoq, kvota) qolgan partiyalarni to'xtatadi, lekin
 * shu paytgacha yig'ilgan o'lik tokenlar YO'QOLMAYDI — chaqiruvchi ularni
 * baribir `dropDeadTokens` ga beradi.
 *
 * @param {import("firebase-admin/messaging").Messaging} client
 * @param {string[]} tokens
 * @param {object} message - `tokens` siz multicast xabari
 * @returns {Promise<{ sent: number, failed: number, dead: string[], gone: string[] }>}
 *   `dead` — o'chiriladigan tokenlar; `gone` — ulardan "ilova o'chirilgan"lari
 */
async function sendInBatches(client, tokens, message) {
  const outcome = { sent: 0, failed: 0, dead: [], gone: [] };

  try {
    for (let i = 0; i < tokens.length; i += FCM_BATCH_SIZE) {
      const batch = tokens.slice(i, i + FCM_BATCH_SIZE);
      // ⚠️ Har partiyaga YANGI nusxa: firebase-admin xabarni tekshirayotib
      // ichki obyektlarni joyida o'zgartiradi (`contentAvailable` →
      // `content-available`), keyingi partiya buzilgan xabar olmasin.
      const response = await client.sendEachForMulticast({
        ...structuredClone(message),
        tokens: batch,
      });

      outcome.sent += response.successCount;
      outcome.failed += response.failureCount;

      response.responses.forEach((r, idx) => {
        if (r.success) return;
        const code = r.error?.code;
        if (DEAD_TOKEN_CODES.has(code)) {
          outcome.dead.push(batch[idx]);
          if (code === APP_REMOVED_CODE) outcome.gone.push(batch[idx]);
        } else {
          logger.warn(`[push] yuborilmadi (${code || "noma'lum"}): ${r.error?.message}`);
        }
      });
    }
  } catch (error) {
    logger.error(`[push] yuborishda xato: ${error.message}`);
  }

  return outcome;
}

/**
 * O'LIK TOKENLARNI O'CHIRADI va ilovasi o'chirilgan seanslarni yopadi —
 * `sendToUsers` va `probeDevices` uchun YAGONA yo'l.
 *
 * Seans (`app_removed`) faqat uchala shart birga bo'lsa yopiladi:
 *   1. Firebase aynan `registration-token-not-registered` qaytargan
 *      (`invalid-registration-token` — buzuq matn, ilova tirik bo'lishi mumkin);
 *   2. o'lik tokenlar o'chirilgach shu `jti` ga BITTA HAM qator qolmagan —
 *      aks holda FCM tokenni shunchaki YANGILAGAN va ilova yangisini
 *      yozib qo'ygan: ishlab turgan odam tizimdan chiqib ketardi;
 *   3. seans oxirgi soatda so'rov yubormagan
 *      (`security.service.js` → `APP_REMOVED_QUIET_MS`).
 *
 * ⚠️ `jti` lar O'CHIRISHDAN OLDIN o'qiladi — keyin qator yo'q bo'ladi.
 * ⚠️ Faqat qatordagi `jti` ning seansi yopiladi: tokenni boshqa seansga
 * ko'chirib (`registerDevice`), birovning seansini yopdirib bo'lmaydi.
 *
 * @param {{ dead: string[], gone: string[] }} outcome - `sendInBatches` natijasi
 * @returns {Promise<{ removed: number, closed: number }>} - xato tashlamaydi
 */
async function dropDeadTokens({ dead, gone }) {
  const result = { removed: 0, closed: 0 };
  if (!dead?.length) return result;

  try {
    const owners = gone?.length
      ? await platformPrisma.pushDevice.findMany({
          where: { token: { in: gone }, jti: { not: null } },
          select: { jti: true },
        })
      : [];

    const { count } = await platformPrisma.pushDevice.deleteMany({
      where: { token: { in: dead } },
    });
    result.removed = count;

    result.closed = await closeOrphanedSessions([...new Set(owners.map((d) => d.jti))]);
  } catch (error) {
    logger.error(`[push] o'lik tokenlar tozalanmadi: ${error.message}`);
  }

  return result;
}

/**
 * Bitta ham tirik tokeni qolmagan seanslarni `app_removed` bilan yopadi.
 *
 * @param {string[]} jtis
 * @returns {Promise<number>} - nechta seans yopildi
 */
async function closeOrphanedSessions(jtis) {
  let closed = 0;

  for (const jti of jtis) {
    try {
      const left = await platformPrisma.pushDevice.count({ where: { jti } });
      if (left > 0) continue; // token shunchaki yangilangan — seans tirik
      closed += await securityService.closeAppRemovedSession(jti);
    } catch (error) {
      logger.warn(`[push] ilovasi o'chirilgan seans yopilmadi: ${error.message}`);
    }
  }

  if (closed > 0) logger.info(`[push] ${closed} ta seans yopildi — ilova o'chirilgan`);
  return closed;
}

/**
 * Foydalanuvchilarning barcha tirik qurilmalariga push yuboradi.
 *
 * @param {string[]} userIds
 * @param {{ title: string, body: string, data?: object, channelId?: string }} message
 * @returns {Promise<{ sent: number, failed: number, removed: number, closed: number, skipped?: string }>}
 */
async function sendToUsers(userIds, { title, body, data, channelId }) {
  const result = { sent: 0, failed: 0, removed: 0, closed: 0 };

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

    const outcome = await sendInBatches(
      client,
      devices.map((d) => d.token),
      {
        notification: { title, body },
        data: stringifyData(data),
        android: {
          priority: "high",
          notification: { sound: "default", ...(channelId ? { channelId } : {}) },
        },
        apns: { payload: { aps: { sound: "default" } } },
      },
    );

    result.sent = outcome.sent;
    result.failed = outcome.failed;
    Object.assign(result, await dropDeadTokens(outcome));
  } catch (error) {
    logger.error(`[push] yuborishda xato: ${error.message}`);
  }

  return result;
}

/**
 * TIRIK SEANSLI BARCHA QURILMALARGA OVOZSIZ "PING" — ilova o'chirilgan
 * telefonlarni aniqlash uchun (`pushTokenProbe.job.js`).
 *
 * ⚠️ NIMA UCHUN KERAK: o'lik token faqat XABAR YUBORILGANDA ma'lum
 * bo'ladi. Bir hafta topshiriq olmagan odamning o'chirilgan ilovasi
 * sezilmay qolardi.
 *
 * ⚠️ Kechikish: Android'da o'chirilgandan keyingi BIRINCHI xabar ko'pincha
 * "yetkazildi" bo'lib qaytadi, `not-registered` ikkinchisida keladi; iOS
 * da APNs buni soatlab-kunlab kechiktiradi. Ya'ni bu TEZLATGICH — asosiy
 * kafolat `SESSION_IDLE_DAYS`.
 *
 * @returns {Promise<{ probed: number, sent: number, failed: number, removed: number, closed: number, skipped?: string }>}
 *   xato tashlamaydi
 */
async function probeDevices() {
  const result = { probed: 0, sent: 0, failed: 0, removed: 0, closed: 0 };

  try {
    const client = getClient();
    if (!client) return { ...result, skipped: "disabled" };

    const devices = await filterLiveDevices(
      await platformPrisma.pushDevice.findMany({ select: { token: true, jti: true } }),
    );
    if (devices.length === 0) return { ...result, skipped: "no_devices" };

    result.probed = devices.length;
    const outcome = await sendInBatches(
      client,
      devices.map((d) => d.token),
      PING_MESSAGE,
    );

    result.sent = outcome.sent;
    result.failed = outcome.failed;
    Object.assign(result, await dropDeadTokens(outcome));
  } catch (error) {
    logger.error(`[push] tekshiruvda xato: ${error.message}`);
  }

  return result;
}

module.exports = {
  PLATFORMS,
  isEnabled,
  registerDevice,
  unregisterDevice,
  forgetSession,
  forgetSessions,
  moveSession,
  sendToUsers,
  probeDevices,
  PING_MESSAGE,
  // test uchun
  _filterLiveDevices: filterLiveDevices,
  _stringifyData: stringifyData,
};
