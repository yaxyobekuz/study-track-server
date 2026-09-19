const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { config } = require("../config/env.config");

/**
 * Seans identifikatori (`jti`) — token bilan `UserSession` qatorini
 * bog'laydigan YAGONA ip.
 *
 * ⚠️ `generateId()` (ObjectId) EMAS: bu ma'lumotlar bazasidagi qator
 * kaliti emas, TOKEN ichida yuradigan sir. ObjectId vaqt belgisini o'z
 * ichiga oladi va ketma-ket chiqarilgan ikkita token bir-biriga juda
 * o'xshab qolardi. `randomBytes` esa taxmin qilib bo'lmaydigan qiymat
 * beradi.
 *
 * ⚠️ 16 bayt → 32 hex belgi, `user_sessions.jti` ustuni kengligi bilan
 * bir xil.
 *
 * @returns {string}
 */
const generateJti = () => crypto.randomBytes(16).toString("hex");

/**
 * JWT token yaratish.
 *
 * Token FILIALGA bog'langan: `branchId` imzolangan yuk ichida turadi, ya'ni
 * uni mijoz tomondan o'zgartirib bo'lmaydi. Filial almashtirish — yangi token
 * olish (`POST /api/auth/switch-branch`), header emas.
 *
 * Token SEANSGA ham bog'langan: `jti` — `user_sessions` qatoriga ishora.
 * Usiz xavfsizlik bo'limidagi "seansni tugat" tugmasi ishlamasdi, chunki
 * chiqarilgan token hech qayerda ro'yxatga olinmagan bo'lardi.
 *
 * ⚠️ `jti` ni CHAQIRUVCHI beradi (`auth.service.js`), bu yerda
 * generatsiya qilinmaydi: seans qatori va token AYNI qiymatga ega
 * bo'lishi kerak, ya'ni qiymat ikkalasidan OLDIN tug'ilishi shart.
 *
 * @param {string} userId - Foydalanuvchi ID (filial schema'sidagi User.id)
 * @param {string} [branchId] - Filial ID (platforma reyestridagi Branch.id)
 * @param {string} [jti] - seans identifikatori (`generateJti`)
 * @returns {string} JWT token
 */
const generateToken = (userId, branchId, jti) => {
  const payload = { id: userId, branchId: branchId ?? null };
  if (jti) payload.jti = jti;

  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
};

/**
 * JWT token tekshirish.
 *
 * Eski (filiallashtirishdan oldingi) tokenlarda `branchId` YO'Q — ular `null`
 * qaytaradi va `auth.middleware` ularni default filialga yo'naltiradi. Shu
 * sababli joriy etish paytida hech kim tizimdan chiqib ketmaydi.
 *
 * @param {string} token - JWT token
 * @returns {object|null} Decoded token yoki null
 */
const verifyToken = (token) => {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch (error) {
    return null;
  }
};

/**
 * LOGIN TIKETI — "qurilmalar limiti to'lgan" oynasidan davom etish uchun.
 *
 * Parol to'g'ri, lekin o'qituvchining bir vaqtdagi seanslari limitda
 * (`security.service.js` → `SESSION_LIMITS`). Tiket shu holatni 5 daqiqa
 * eslab turadi: odam eski qurilmalardan birini yakunlab, parolni qayta
 * so'ralmasdan kiradi (`POST /auth/login/terminate`).
 *
 * ⚠️ ALOHIDA SIR BILAN imzolanadi va `id` maydoni YO'Q. Asosiy sir bilan
 * imzolansa, tiket `auth.middleware` dan oddiy token bo'lib o'tib ketardi —
 * ya'ni limitni chetlab o'tadigan to'liq kirish kaliti bo'lardi. Teskarisi
 * ham yopiq: oddiy token bu yerda tekshiruvdan o'tmaydi.
 *
 * `did` — tiket berilgan brauzerning qurilma identifikatori (bo'lsa).
 */
const LOGIN_TICKET_TTL = "5m";
const LOGIN_TICKET_TYPE = "login_ticket";
const loginTicketSecret = () => `${config.jwtSecret}:${LOGIN_TICKET_TYPE}`;

/**
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.branchId
 * @param {string|null} [input.deviceId]
 * @returns {string}
 */
const generateLoginTicket = ({ userId, branchId, deviceId = null }) =>
  jwt.sign(
    { typ: LOGIN_TICKET_TYPE, sub: userId, bid: branchId, did: deviceId },
    loginTicketSecret(),
    { expiresIn: LOGIN_TICKET_TTL },
  );

/**
 * @param {string} ticket
 * @returns {{ sub: string, bid: string, did: string|null }|null}
 */
const verifyLoginTicket = (ticket) => {
  try {
    const decoded = jwt.verify(String(ticket || ""), loginTicketSecret());
    return decoded?.typ === LOGIN_TICKET_TYPE && decoded.sub ? decoded : null;
  } catch (error) {
    return null;
  }
};

module.exports = {
  generateToken,
  verifyToken,
  generateJti,
  generateLoginTicket,
  verifyLoginTicket,
};
