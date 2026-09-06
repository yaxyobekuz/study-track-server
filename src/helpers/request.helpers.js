/**
 * SO'ROVDAN MIJOZ MA'LUMOTINI OLISH — faollik va xavfsizlik uchun yagona manba.
 *
 * ⚠️ Bu funksiyalar `req` dan boshqa hech narsani BILMAYDI va hech qayerga
 * yozmaydi: shuning uchun ularni login (foydalanuvchi hali noma'lum) ham,
 * `auth.middleware` (foydalanuvchi ma'lum) ham bir xil chaqiradi. Ikkita
 * mustaqil "IP ni qanday olamiz" mantiqiy bo'lsa, xavfsizlik ro'yxatidagi
 * IP bilan seansdagi IP asta-sekin bir-biridan uzoqlashardi.
 *
 * ⚠️ `app.set("trust proxy", 1)` `index.js` da yoqilgan, shuning uchun
 * `req.ip` allaqachon `X-Forwarded-For` ning birinchi qiymatini beradi.
 * Uni qo'lda ajratib olmaymiz — proxy sozlamasi bilan ikkita haqiqat
 * manbai bo'lib qolardi.
 */

const { ACTIVITY_CHANNELS } = require("../utils/constants");

/** IPv6 ga o'ralgan IPv4 ("::ffff:10.0.0.5") — ro'yxatda o'qilmaydi. */
const V4_IN_V6 = /^::ffff:/i;

/**
 * Mijoz IP manzili.
 *
 * @param {import("express").Request} req
 * @returns {string|null} - 45 belgidan uzun bo'lmagan manzil yoki `null`
 */
function clientIp(req) {
  const raw = req?.ip || req?.socket?.remoteAddress || "";
  if (!raw) return null;
  const clean = String(raw).replace(V4_IN_V6, "");
  // "::1" — localhost, ko'rsatishga yaroqli
  return clean.slice(0, 45) || null;
}

/**
 * User-Agent satri (kesilgan).
 *
 * ⚠️ 400 belgi — ustun kengligi. Ba'zi mobil brauzerlar 500+ belgili
 * satr yuboradi va kesilmasa INSERT butunlay yiqilardi.
 *
 * @param {import("express").Request} req
 * @returns {string|null}
 */
function userAgent(req) {
  const raw = req?.headers?.["user-agent"];
  if (!raw) return null;
  return String(raw).slice(0, 400);
}

/**
 * QURILMA YORLIG'I — "Chrome · Windows".
 *
 * ⚠️ TASHQI KUTUBXONA YO'Q (`ua-parser-js` va h.k.). Bizga brauzer
 * versiyasi ham, aniq model ham kerak emas: ekranda javob beriladigan
 * yagona savol — "bu MENING odatiy qurilmammi yoki boshqasimi". Uning
 * uchun oila nomi yetarli, yangi bog'liqlik esa har brauzer yangilanishida
 * yangilanib turishi kerak bo'lardi.
 *
 * ⚠️ TARTIB MUHIM: Edge o'zini "Chrome" deb ham ataydi, Chrome esa
 * "Safari" deb — shuning uchun eng aniqdan umumiygacha tekshiriladi.
 *
 * @param {string|null} ua
 * @returns {string|null} - "Chrome · Windows" yoki `null`
 */
function deviceLabel(ua) {
  if (!ua) return null;

  const s = ua.toLowerCase();

  const browser =
    (s.includes("edg/") && "Edge") ||
    (s.includes("opr/") && "Opera") ||
    (s.includes("samsungbrowser") && "Samsung Internet") ||
    (s.includes("yabrowser") && "Yandex") ||
    (s.includes("firefox") && "Firefox") ||
    (s.includes("chrome") && "Chrome") ||
    (s.includes("safari") && "Safari") ||
    (s.includes("okhttp") && "Mobil ilova") ||
    (s.includes("dart") && "Mobil ilova") ||
    (s.includes("postman") && "Postman") ||
    (s.includes("curl") && "curl") ||
    null;

  const os =
    (s.includes("android") && "Android") ||
    ((s.includes("iphone") || s.includes("ipad") || s.includes("ios")) && "iOS") ||
    (s.includes("windows") && "Windows") ||
    ((s.includes("mac os") || s.includes("macintosh")) && "macOS") ||
    (s.includes("linux") && "Linux") ||
    null;

  if (!browser && !os) return null;
  if (!os) return browser.slice(0, 120);
  if (!browser) return os.slice(0, 120);
  return `${browser} · ${os}`.slice(0, 120);
}

/**
 * QAYSI PANELDAN KELDI.
 *
 * ⚠️ BIRINCHI MANBA — `X-Client` SARLAVHASI, User-Agent emas. Barcha
 * panellar bitta brauzerdan ochiladi va UA ularni ajrata OLMAYDI:
 * o'qituvchi paneli ham, admin paneli ham "Chrome · Windows". Sarlavha
 * esa mijoz kodida qat'iy yozilgan (`shared/api/http.js`).
 *
 * ⚠️ NOMA'LUM QIYMAT `admin` GA TUSHADI, xato EMAS: sarlavhasi yo'q eski
 * mijoz (yoki API mijozi) faollik hisobotini yiqitmasligi kerak.
 *
 * @param {import("express").Request} req
 * @returns {string} - `ActivityChannel` qiymati
 */
function clientChannel(req) {
  const raw = String(req?.headers?.["x-client"] || "").trim().toLowerCase();
  if (ACTIVITY_CHANNELS.includes(raw)) return raw;
  return "admin";
}

/**
 * Uchala qiymatni birdan qaytaradi — chaqiruvchi joyda uch qator o'rniga bitta.
 *
 * @param {import("express").Request} req
 * @returns {{ ip: string|null, userAgent: string|null, device: string|null, channel: string }}
 */
function clientInfo(req) {
  const ua = userAgent(req);
  return {
    ip: clientIp(req),
    userAgent: ua,
    device: deviceLabel(ua),
    channel: clientChannel(req),
  };
}

module.exports = {
  clientIp,
  userAgent,
  deviceLabel,
  clientChannel,
  clientInfo,
};
