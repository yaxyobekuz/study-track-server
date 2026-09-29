/**
 * OTA-ONA NAZORATI — HODISALAR TARIXI VA OTA-ONAGA OGOHLANTIRISH.
 *
 * Hodisani kim yozmasin — qurilma (`POST /device/events`, `PUT /device/health`),
 * server (`pin/verify`, `pin/reset`) yoki cron (`offline`) — hammasi SHU
 * YERDAN o'tadi: "bu hodisa ota-onaga push bo'ladimi" degan qaror bitta joyda.
 * Ikki joyda bo'lsa, bir yo'l cheklovni unutib ota-onani push bilan ko'mib
 * tashlardi.
 *
 * ── TAKRORLANISHNI CHEKLASH ─────────────────────────────────────────────
 *
 * Qo'shimcha jadval yo'q: `ParentalEvent.alerted` (push ketdimi) va
 * `createdAt` (server vaqti) bo'yicha oxirgi yozuvlar tekshiriladi.
 * Tekshiruv + yozuv o'quvchi bo'yicha advisory lock ostida — parallel ikki
 * hodisa ikkalasi ham "hali yuborilmagan" deb o'qib, ikki push jo'natmaydi.
 *
 *   permission_revoked   — bir qurilma uchun 1 soatda 1 marta.
 *                          ⚠️ Lekin oxirgi push "himoya tiklandi" bo'lsa —
 *                          DARHOL (soat kutilmaydi): aks holda bola
 *                          "o'chir → yoq → yana o'chir" qilib, ota-onani
 *                          "tiklandi" degan eskirgan xabar bilan qoldirardi.
 *   protection_restored  — faqat oldingi push "himoya o'chirildi" bo'lsa
 *                          (juft): birinchi sozlashda "tiklandi" chiqmaydi.
 *   uninstall_attempt    — bir qurilma uchun 10 daqiqada 1 marta.
 *   wrong_pin            — 3-xatodan boshlab, o'quvchiga KUNIGA 3 marta.
 *   offline              — chaqiruvchi (`offlineAlertAt`) bir martaligini
 *                          ta'minlaydi.
 *   pin_reset            — har safar (xavfsizlik hodisasi).
 *   qolganlari           — faqat tarixda (push yo'q).
 */

const prisma = require("../config/prisma");
const { getBranch } = require("../config/branchContext");
const pushService = require("./push.service");
const parentalPush = require("../helpers/parentalPush.helpers");
const { PIN_ALERT_FROM } = require("../helpers/parentalPin.helpers");
const { currentDayDate } = require("../helpers/month.helpers");
const logger = require("../utils/logger");

const { PARENTAL_ALERT_EVENTS: EVENTS } = parentalPush;

const HOUR_MS = 60 * 60 * 1000;
const UNINSTALL_WINDOW_MS = 10 * 60 * 1000;
const WRONG_PIN_DAILY_ALERTS = 3;
const TASHKENT_OFFSET_MS = 5 * HOUR_MS;

/** "Himoya" jufti — biri ikkinchisini bekor qiladi. */
const PROTECTION_PAIR = [EVENTS.PERMISSION_REVOKED, EVENTS.PROTECTION_RESTORED];

/** Push bo'lishi mumkin bo'lgan turlar — qolganlari faqat tarixga yoziladi. */
const ALERTABLE = new Set(Object.values(EVENTS));

/** Bugungi Toshkent kunining boshi — instant (00:00 +05:00). */
const tashkentDayStart = () => new Date(currentDayDate().getTime() - TASHKENT_OFFSET_MS);

/**
 * Oxirgi push bo'lgan "himoya" hodisasi (shu qurilma bo'yicha).
 * @returns {Promise<{ type: string, createdAt: Date }|null>}
 */
function lastProtectionAlert(tx, studentId, deviceId) {
  return tx.parentalEvent.findFirst({
    where: { studentId, deviceId, alerted: true, type: { in: PROTECTION_PAIR } },
    orderBy: { createdAt: "desc" },
    select: { type: true, createdAt: true },
  });
}

/**
 * Shu hodisa ota-onaga push bo'ladimi — tepadagi jadval.
 *
 * @param {object} tx
 * @param {{ studentId: string, deviceId: string|null, type: string, attempts?: number }} input
 * @returns {Promise<boolean>}
 */
async function shouldAlert(tx, { studentId, deviceId, type, attempts }) {
  const now = Date.now();

  switch (type) {
    case EVENTS.PERMISSION_REVOKED: {
      const last = await lastProtectionAlert(tx, studentId, deviceId);
      if (!last || last.type !== EVENTS.PERMISSION_REVOKED) return true;
      return now - new Date(last.createdAt).getTime() >= HOUR_MS;
    }

    case EVENTS.PROTECTION_RESTORED: {
      const last = await lastProtectionAlert(tx, studentId, deviceId);
      return last?.type === EVENTS.PERMISSION_REVOKED;
    }

    case EVENTS.UNINSTALL_ATTEMPT: {
      const recent = await tx.parentalEvent.count({
        where: {
          studentId,
          deviceId,
          type,
          alerted: true,
          createdAt: { gte: new Date(now - UNINSTALL_WINDOW_MS) },
        },
      });
      return recent === 0;
    }

    case EVENTS.WRONG_PIN: {
      const dayStart = tashkentDayStart();

      // Serverdagi tekshiruv ketma-ket xatolar sonini o'zi beradi; qurilma
      // esa har xatoni alohida hodisa qilib yuboradi — bugungilar sanaladi
      // (shu hodisa hali yozilmagan, shuning uchun +1).
      const streak =
        attempts ??
        (await tx.parentalEvent.count({
          where: { studentId, deviceId, type, createdAt: { gte: dayStart } },
        })) + 1;
      if (streak < PIN_ALERT_FROM) return false;

      const sentToday = await tx.parentalEvent.count({
        where: { studentId, type, alerted: true, createdAt: { gte: dayStart } },
      });
      return sentToday < WRONG_PIN_DAILY_ALERTS;
    }

    case EVENTS.OFFLINE:
    case EVENTS.PIN_RESET:
      return true;

    default:
      return false;
  }
}

/**
 * Ota-onaga push — kutilmaydi, xato tashlamaydi.
 *
 * ⚠️ Faqat ota-ona telefoniga (`channels: ["parent"]` — builder qo'yadi).
 */
async function sendAlert({ studentId, studentName, type, deviceId, appKey, attempts }) {
  try {
    let name = studentName;
    if (name === undefined) {
      const student = await prisma.user.findUnique({
        where: { id: studentId },
        select: { firstName: true },
      });
      name = student?.firstName ?? null;
    }

    void pushService.sendToUsers(
      [studentId],
      parentalPush.alert({
        event: type,
        name,
        deviceId,
        appKey,
        attempts,
        branchId: getBranch()?.id ?? null,
      }),
    );
  } catch (error) {
    logger.warn(`[parental] ogohlantirish yuborilmadi (${type}): ${error.message}`);
  }
}

/**
 * HODISANI YOZADI va kerak bo'lsa ota-onaga push qiladi.
 *
 * @param {object} input
 * @param {string} input.studentId
 * @param {string|null} [input.deviceId] - `X-Device-Id`
 * @param {string} input.type
 * @param {object} [input.payload]
 * @param {Date} [input.occurredAt] - qurilmadagi vaqt (sukut: hozir)
 * @param {boolean} [input.alert=true] - `false` — faqat tarix (masalan server
 *   `wrong_pin` hali 3-xatoga yetmagan bo'lsa ham qator yoziladi)
 * @param {number} [input.attempts] - `wrong_pin`: ketma-ket xatolar soni
 * @param {string|null} [input.studentName] - push matni uchun (berilmasa o'qiladi)
 * @param {string|null} [input.clientEventId] - qurilmaning `eventId` si; takror
 *   bo'lsa yagonalik indeksi P2002 beradi (chaqiruvchi "takror" deb qabul qiladi)
 * @returns {Promise<{ id: string, alerted: boolean }>}
 */
async function recordEvent({
  studentId,
  deviceId = null,
  type,
  payload = {},
  occurredAt = new Date(),
  alert = true,
  attempts,
  studentName,
  clientEventId = null,
}) {
  const data = { studentId, deviceId, type, payload, occurredAt, clientEventId };

  // Push bo'lmaydigan hodisa — qulf va qo'shimcha o'qishsiz
  if (!alert || !ALERTABLE.has(type)) {
    const row = await prisma.parentalEvent.create({ data, select: { id: true } });
    return { id: row.id, alerted: false };
  }

  const row = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`parental_event:${studentId}`}))`;
    const alerted = await shouldAlert(tx, { studentId, deviceId, type, attempts });
    return tx.parentalEvent.create({
      data: { ...data, alerted },
      select: { id: true, alerted: true },
    });
  });

  if (row.alerted) {
    void sendAlert({
      studentId,
      studentName,
      type,
      deviceId,
      appKey: typeof payload?.appKey === "string" ? payload.appKey : null,
      attempts,
    });
  }

  return row;
}

/**
 * `recordEvent` — xato tashlamaydi. Tarix yozuvi ASOSIY AMALNI yiqitmasligi
 * kerak: PIN saqlandi-yu, tarix yozilmadi deb 500 qaytarish ota-onani
 * "PIN saqlanmadi" deb aldardi, qurilmani esa qayta yuborishga majbur qilib,
 * allaqachon qayd etilgan o'tishni (`protected`) ikkinchi marta ko'rmay qolardi.
 *
 * @param {object} input - `recordEvent` bilan bir xil
 * @returns {Promise<{ id: string|null, alerted: boolean }>}
 */
async function recordEventSafe(input) {
  try {
    return await recordEvent(input);
  } catch (error) {
    logger.warn(`[parental] hodisa yozilmadi (${input.type}): ${error.message}`);
    return { id: null, alerted: false };
  }
}

module.exports = {
  recordEvent,
  recordEventSafe,
  // test uchun
  _shouldAlert: shouldAlert,
  _tashkentDayStart: tashkentDayStart,
};
