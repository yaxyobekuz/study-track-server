/**
 * FAOLLIK — YOZUV TOMONI.
 *
 * Bu fayl faqat QAYD ETADI. O'qish va yig'ish `activityDashboard.service.js`
 * da: ikkalasi bitta faylda bo'lsa, "hodisani yozish" mantiqiga hisobot
 * uchun kerak bo'lgan filtrlar asta-sekin sizib kirardi.
 *
 * ── NIMA UCHUN UMUMAN KERAK ──────────────────────────────────────────
 *
 * Bugungi kunda tizim "kim tizimdan foydalanmoqda" degan savolga JAVOB
 * BERA OLMAYDI. `TgUser.lastActivity` faqat hisob bog'langan lahzada bir
 * marta yoziladi (bot `auth.service.js`), panel tomonida esa hech narsa
 * yozilmaydi. Shu sababli "4-A sinfning 25 ta ota-onasidan 20 tasi bugun
 * botdan foydalandi" degan hisobot uchun HODISA OQIMI kerak.
 *
 * ── IKKI TEZLIK ──────────────────────────────────────────────────────
 *
 * BOT — har harakat yoziladi. Ota-ona kuniga 2-5 marta tugma bosadi va
 * har bosish MA'NOLI ("baholarni ochdi", "sozlamalarni ochdi").
 *
 * PANEL — 5 daqiqalik OYNAGA siqiladi. Xodim bitta ekranda o'nlab so'rov
 * yuboradi va ularning har biri qator bo'lsa, jadval kuniga yuz minglab
 * qator o'sardi — o'lchanayotgan narsa esa "shu odam bugun ishladimi",
 * "necha marta so'rov yubordi" emas.
 *
 * ⚠️ OYNA XOTIRADA (`Map`), bazada emas. Sabab: siqishning maqsadi —
 * BAZAGA BORMASLIK. Har so'rovda "oxirgi qachon yozgan edik" deb
 * so'rasak, tejagan yozuvimizni o'qish bilan qaytarib berardik.
 * Server qayta ishga tushganda oyna bo'shaydi va bir marta ortiqcha
 * qator yoziladi — bu zararsiz.
 *
 * ⚠️ YOZUV HECH QACHON SO'ROVNI YIQITMAYDI. Har chaqiruv `.catch()` bilan
 * o'ralgan: faollik hisoboti — kuzatuv, biznes amali emas. Uning xatosi
 * o'quvchining to'lovini yoki o'qituvchining bahosini bloklamasligi kerak.
 */

const prisma = require("../config/prisma");
const { generateId } = require("../utils/idGenerator");
const { currentDayDate } = require("../helpers/month.helpers");
const logger = require("../utils/logger");

/**
 * PANEL SIQISH OYNASI. 5 daqiqa — "shu odam hozir tizimda" degan
 * savolga yetarli aniqlik, kunlik yig'maga esa umuman ta'sir qilmaydi.
 */
const TOUCH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Xotiradagi oyna: `actorKey|channel` → oxirgi yozuv vaqti (ms).
 *
 * ⚠️ O'ZI TOZALANADI. Cheklovsiz `Map` uzoq ishlaydigan jarayonda
 * sekin-asta o'sib boradi (har yangi o'quvchi — yangi kalit), shuning
 * uchun hajm chegaradan oshganda eskirgan kalitlar o'chiriladi.
 */
const touchWindow = new Map();

/** Kalit soni shundan oshsa tozalash ishga tushadi. */
const WINDOW_LIMIT = 5000;

/**
 * Eskirgan kalitlarni tashlaydi. Faqat chegaradan oshganda chaqiriladi —
 * har so'rovda butun `Map` ni aylanib chiqish siqishdan qimmatroq bo'lardi.
 *
 * @param {number} now
 */
function sweepWindow(now) {
  for (const [key, at] of touchWindow) {
    if (now - at > TOUCH_WINDOW_MS) touchWindow.delete(key);
  }
  // Tozalashdan keyin ham to'lib tursa (juda katta filial) — hammasini
  // tashlaymiz: bitta ortiqcha qator xotira o'sishidan afzal.
  if (touchWindow.size > WINDOW_LIMIT) touchWindow.clear();
}

/**
 * Shu subyekt uchun oyna ochiqmi? Ochiq bo'lsa `true` qaytaradi VA
 * oynani yopadi (keyingi chaqiruv `false` oladi).
 *
 * @param {string} key
 * @returns {boolean} - yozish kerakmi
 */
function claimWindow(key) {
  const now = Date.now();
  const last = touchWindow.get(key);

  if (last && now - last < TOUCH_WINDOW_MS) return false;

  if (touchWindow.size > WINDOW_LIMIT) sweepWindow(now);
  touchWindow.set(key, now);
  return true;
}

/**
 * HODISANI YOZISH — bazaga tegadigan yagona nuqta.
 *
 * ⚠️ `await` QILINMAYDI (chaqiruvchi joyda ham). So'rov javobini faollik
 * yozuvi kutib turmasligi kerak: u foydalanuvchi ko'radigan tezlikka
 * qo'shilib qolardi.
 *
 * @param {object} input
 * @param {string} input.channel - `ActivityChannel`
 * @param {string} input.action - "bot.grades", "panel.request", ...
 * @param {string} [input.userId]
 * @param {string} [input.telegramId]
 * @param {string} [input.studentId]
 * @param {object} [input.meta]
 * @returns {Promise<void>}
 */
async function record({ channel, action, userId, telegramId, studentId, meta }) {
  // Subyektsiz hodisa hisobotda hech qayerga tushmaydi — yozishning ma'nosi yo'q
  const actorKey = userId ? `user:${userId}` : telegramId ? `tg:${telegramId}` : null;
  if (!actorKey) return;

  await prisma.activityEvent.create({
    data: {
      id: generateId(),
      channel,
      action: String(action).slice(0, 48),
      actorKey,
      userId: userId ?? null,
      telegramId: telegramId ?? null,
      studentId: studentId ?? null,
      day: currentDayDate(),
      meta: meta ?? undefined,
    },
  });
}

/**
 * "Yozib qo'y va unut" — xatoni yutadi.
 *
 * ⚠️ `logger.debug` EMAS, `warn`: jadval yo'q bo'lsa (migratsiya
 * qo'llanmagan) buni bilish kerak. Lekin so'rov baribir davom etadi.
 *
 * @param {object} input - `record` bilan bir xil
 * @returns {void}
 */
function fire(input) {
  record(input).catch((error) => {
    logger.warn(`[activity] hodisa yozilmadi: ${error.message}`);
  });
}

/**
 * PANEL FAOLLIGI — siqilgan.
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.channel
 * @param {string} [input.action="panel.request"]
 * @param {object} [input.meta]
 * @returns {void}
 */
function touchPanel({ userId, channel, action = "panel.request", meta }) {
  if (!userId) return;
  if (!claimWindow(`user:${userId}|${channel}`)) return;
  fire({ channel, action, userId, meta });
}

/**
 * BOT FAOLLIGI — siqilmaydi, har harakat yoziladi.
 *
 * ⚠️ `TgUser.lastActivity` HAM shu yerda yangilanadi. Ikkita yozuv, ikki
 * xil savol uchun: hodisa — TARIX ("shu oy nechta kun kirdi"),
 * `lastActivity` — JORIY HOLAT ("oxirgi marta qachon ko'rindi"). Ikkinchisini
 * hodisalardan har safar hisoblash mumkin edi, lekin u ro'yxatdagi HAR
 * QATOR uchun kerak bo'ladi va `MAX(occurred_at)` bilan yig'ish o'sha
 * ro'yxatni sekinlashtirardi.
 *
 * @param {object} input
 * @param {string} input.telegramId
 * @param {string} [input.studentId]
 * @param {string} input.action - "bot.start", "bot.grades", ...
 * @param {object} [input.meta]
 * @returns {void}
 */
function touchBot({ telegramId, studentId, action, meta }) {
  if (!telegramId) return;

  fire({ channel: "bot", action, telegramId, studentId, meta });

  prisma.tgUser
    .updateMany({
      where: { telegramId: String(telegramId) },
      data: { lastActivity: new Date() },
    })
    .catch(() => {});
}

module.exports = {
  TOUCH_WINDOW_MS,
  record,
  fire,
  touchPanel,
  touchBot,
};
