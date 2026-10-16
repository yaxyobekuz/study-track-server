const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { config } = require("../config/env.config");
const { AGGREGATE_SCOPE } = require("./constants");

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
 * ⚠️ UMUMIY KO'RINISH (`scope: "all"`) — token ichidagi UCHINCHI holat:
 * na bitta filial, na eski filialsiz token. Qiymat imzolangan yuk ichida,
 * shuning uchun mijoz o'zini umumiy rejimga sarlavha bilan o'tkazib
 * olmaydi. Bunday tokenda `branchId` ATAYLAB `null`: filial har so'rovda
 * qayta hal qilinadi (`middleware/aggregate.middleware.js`), tokendan
 * o'qilmaydi — token berilgandan keyin filial arxivlanishi yoki ruxsat
 * olib qo'yilishi mumkin.
 *
 * @param {string} userId - Foydalanuvchi ID (filial schema'sidagi User.id)
 * @param {string} [branchId] - Filial ID (platforma reyestridagi Branch.id)
 * @param {string} [jti] - seans identifikatori (`generateJti`)
 * @param {{scope?: string}} [options] - `scope: "all"` → umumiy ko'rinish
 * @returns {string} JWT token
 */
const generateToken = (userId, branchId, jti, options = {}) => {
  const payload = { id: userId, branchId: branchId ?? null };
  if (jti) payload.jti = jti;
  if (options.scope) payload.scope = options.scope;

  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
};

/**
 * UMUMIY KO'RINISH TOKENI — barcha filiallarni birga o'qish uchun.
 *
 * Oddiy access token bilan AYNI kalit va AYNI muddat: bu alohida maqsadli
 * token emas (parental / filial tanlash tokenlari kabi), balki o'sha
 * seansning filial o'rniga "hammasi" yozilgan ko'rinishi. Shu sababli
 * seans tekshiruvi, qurilma limiti va "seansni tugat" tugmasi avvalgidek
 * ishlaydi.
 *
 * @param {string} userId
 * @param {string} jti
 * @returns {string}
 */
const generateAggregateToken = (userId, jti) =>
  generateToken(userId, null, jti, { scope: AGGREGATE_SCOPE });

/**
 * Token umumiy ko'rinish uchunmi?
 *
 * ⚠️ Faqat `verifyToken` dan QAYTGAN (imzosi tekshirilgan) yuk bilan
 * chaqiriladi — `jwt.decode` natijasi bilan emas.
 *
 * @param {object|null} decoded
 * @returns {boolean}
 */
const isAggregateToken = (decoded) => decoded?.scope === AGGREGATE_SCOPE;

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

/* ───────────────────── OTA-ONA NAZORATI TOKENI ───────────────────── */

/** Parental token maqsadi — `purpose` da majburiy. */
const PARENTAL_PURPOSE = "parental";

/**
 * PARENTAL TOKEN KALITI — `JWT_SECRET` dan HOSILA, o'zi EMAS.
 *
 * ⚠️ Ikki qavatli ajratish: kalit boshqa bo'lgani uchun oddiy access token
 * parental token o'rniga (va aksincha) imzo bosqichidayoq rad etiladi,
 * `purpose` tekshiruvi esa ikkinchi qavat. Bitta kalit bo'lsa, kalit
 * tekshiruvi `purpose` ni unutgan birinchi yangi kodda teshik ochardi.
 *
 * ⚠️ Yangi env EMAS: kalit `JWT_SECRET` bilan birga aylanadi (rotatsiya),
 * alohida sirni unutib qoldirish imkonsiz.
 */
const parentalSecret = () =>
  crypto.createHmac("sha256", String(config.jwtSecret)).update("parental-token:v1").digest("hex");

/**
 * PIN bilan tasdiqlangan boshqaruv tokeni — `X-Parental-Token`.
 *
 * ⚠️ SEANSGA BOG'LANGAN (`jti`): boshqa telefondagi (boshqa seans) so'rov
 * bu token bilan o'tmaydi (`parental.middleware.js`). Filial ham yuk ichida.
 *
 * ⚠️ PIN VERSIYASIGA BOG'LANGAN (`pv` — `pinUpdatedAt`): PIN almashsa yoki
 * tiklansa, eski PIN bilan olingan tokenlar DARHOL o'ladi — PIN tarqalib
 * ketgani uchun almashtirilgan bo'lsa, tarqalgan token 15 daqiqa ishlab
 * turmasligi kerak.
 *
 * @param {{ userId: string, jti: string, branchId: string|null, pinVersion: number }} input
 * @returns {{ token: string, expiresAt: Date }}
 */
const generateParentalToken = ({ userId, jti, branchId, pinVersion }) => {
  const ttlSec = config.parentalTokenTtlMin * 60;
  const token = jwt.sign(
    {
      purpose: PARENTAL_PURPOSE,
      sub: String(userId),
      jti: String(jti),
      br: branchId ?? null,
      pv: Number(pinVersion) || 0,
    },
    parentalSecret(),
    { algorithm: "HS256", expiresIn: ttlSec },
  );
  const { exp } = jwt.decode(token);
  return { token, expiresAt: new Date(exp * 1000) };
};

/**
 * Parental tokenni tekshiradi. Imzo, muddat yoki `purpose` mos kelmasa `null`.
 *
 * @param {string} token
 * @returns {{ sub: string, jti: string, br: string|null, pv: number, exp: number }|null}
 */
const verifyParentalToken = (token) => {
  if (!token || typeof token !== "string") return null;
  try {
    const decoded = jwt.verify(token, parentalSecret(), { algorithms: ["HS256"] });
    return decoded?.purpose === PARENTAL_PURPOSE ? decoded : null;
  } catch {
    return null;
  }
};

/* ─────────────────── FILIAL TANLASH TOKENI (login) ─────────────────── */

/** Tanlov tokeni maqsadi — `purpose` da majburiy. */
const BRANCH_SELECT_PURPOSE = "branch-select";

/**
 * TANLOV TOKENI 5 DAQIQA YASHAYDI.
 *
 * ⚠️ Env'ga CHIQARILMAYDI: bu sozlama emas, oynaning umri. Uzaytirilsa
 * "parol tekshirilgan, lekin seans ochilmagan" holat uzoq turib qolardi;
 * qisqartirilsa filialni o'qib tanlayotgan odam muddatga ilinardi.
 */
const BRANCH_SELECT_TTL_SEC = 5 * 60;

/**
 * TANLOV TOKENI KALITI — `JWT_SECRET` dan HOSILA, o'zi EMAS.
 *
 * ⚠️ Parental token bilan AYNI mulohaza: kalit boshqa bo'lgani uchun
 * tanlov tokeni access token o'rniga (va aksincha) imzo bosqichidayoq rad
 * etiladi — `purpose` tekshiruvi esa ikkinchi qavat. Bitta kalit bo'lsa,
 * tanlov tokeni bilan butun API'ga kirib bo'lardi.
 */
const branchSelectSecret = () =>
  crypto
    .createHmac("sha256", String(config.jwtSecret))
    .update("branch-select-token:v1")
    .digest("hex");

/**
 * PAROL TEKSHIRILGANINING ISBOTI — filial tanlanmaguncha.
 *
 * Ko'p filialli xodimga login SEANS OCHMAYDI (`auth.service.js`): odam
 * qaysi filialda ishlashini aytmaguncha token berilmaydi. Shu oraliqni
 * ushlab turadigan narsa — aynan bu token.
 *
 * ⚠️ UY FILIALI YUK ICHIDA (`hb`): u birinchi qadamda allaqachon
 * tekshirilgan (`getUsableById`) va imzolangan, ya'ni ikkinchi qadam
 * "qaysi filialda rollar o'qiladi" degan savolni qayta hal qilmaydi va
 * mijoz uni o'zgartira olmaydi.
 *
 * ⚠️ `jti` YO'Q: bu seans emas. Seans faqat tanlovdan keyin ochiladi,
 * aks holda tashlab ketilgan oyna qurilma limitidan joy yeb turardi.
 *
 * @param {{ userId: string, homeBranchId: string }} input
 * @returns {{ token: string, expiresIn: number }}
 */
const generateBranchSelectToken = ({ userId, homeBranchId }) => {
  const token = jwt.sign(
    {
      purpose: BRANCH_SELECT_PURPOSE,
      sub: String(userId),
      hb: homeBranchId ?? null,
    },
    branchSelectSecret(),
    { algorithm: "HS256", expiresIn: BRANCH_SELECT_TTL_SEC },
  );

  return { token, expiresIn: BRANCH_SELECT_TTL_SEC };
};

/**
 * Tanlov tokenini tekshiradi. Imzo, muddat yoki `purpose` mos kelmasa `null`.
 *
 * @param {string} token
 * @returns {{ sub: string, hb: string|null, exp: number }|null}
 */
const verifyBranchSelectToken = (token) => {
  if (!token || typeof token !== "string") return null;
  try {
    const decoded = jwt.verify(token, branchSelectSecret(), {
      algorithms: ["HS256"],
    });
    return decoded?.purpose === BRANCH_SELECT_PURPOSE ? decoded : null;
  } catch {
    return null;
  }
};

module.exports = {
  generateToken,
  generateAggregateToken,
  isAggregateToken,
  verifyToken,
  generateJti,
  generateParentalToken,
  verifyParentalToken,
  PARENTAL_PURPOSE,
  generateBranchSelectToken,
  verifyBranchSelectToken,
  BRANCH_SELECT_PURPOSE,
  BRANCH_SELECT_TTL_SEC,
};
