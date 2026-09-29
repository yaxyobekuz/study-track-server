/**
 * OTA-ONA NAZORATI — MARSHRUT DARVOZALARI.
 *
 * ── UCH QAVAT ───────────────────────────────────────────────────────────
 *
 *   1. `requireStudentAccount` — modul faqat O'QUVCHI hisobi uchun.
 *   2. KANAL (`req.sessionChannel`, login'dagi `X-Client`) — MARSHRUT:
 *      ota-ona amallari `parent` seansidan, qurilma yo'llari `parent`
 *      bo'lmagan seansdan. ⚠️ Bu HIMOYA EMAS: kanalni mijoz yozadi, bola ham
 *      `X-Client: parent` bilan kira oladi. U faqat o'quvchi ilovasini
 *      tasodifan boshqaruv amaliga yo'l qo'ymaydi.
 *   3. PIN — `requireParentalToken`: HAQIQIY himoya. Holatni o'zgartiradigan
 *      har bir amal PIN bilan olingan qisqa muddatli token talab qiladi
 *      (`X-Parental-Token`, 15 daqiqa), token esa SHU seansga (`jti`), shu
 *      filialga va PIN VERSIYASIGA bog'langan — boshqa telefondan qayta
 *      ishlatib bo'lmaydi, PIN almashsa esa darhol o'ladi.
 *
 * ⚠️ RAD JAVOBLARIDA `details.reason` — mobil ilova 403 ni matndan emas,
 * sababdan ajratadi (`parental_token_required` → PIN oynasini ochish,
 * `parent_channel_required` → bu ekran o'quvchi ilovasida yo'q).
 */

const prisma = require("../config/prisma");
const asyncHandler = require("./async.middleware");
const { verifyParentalToken } = require("../utils/jwt");
const { pinVersionOf } = require("../helpers/parentalPin.helpers");
const { clientDeviceId } = require("../helpers/request.helpers");
const { ROLES } = require("../utils/constants");
const { BadRequestError, ForbiddenError } = require("../utils/errors");

const PARENT_CHANNEL = "parent";

const reject = (ErrorClass, message, reason) => {
  const error = new ErrorClass(message);
  error.details = { reason };
  return error;
};

/**
 * Faqat o'quvchi hisobi.
 *
 * ⚠️ ASOSIY ROL (`role`), `hasRole` EMAS: qo'shimcha "student" roli
 * berilgan xodim bu modulga kirmasligi kerak (`security.service.js` →
 * `allowsMultiDevice` bilan bir xil sabab).
 */
const requireStudentAccount = (req, res, next) => {
  if (req.user?.role !== ROLES.STUDENT) {
    throw reject(
      ForbiddenError,
      "Ota-ona nazorati faqat o'quvchi hisobi uchun",
      "student_account_required",
    );
  }
  next();
};

/**
 * `X-Device-Id` majburiy — qurilma yo'llari (`/parental/device/*`).
 * Shakli `request.helpers.js` → `clientDeviceId` bilan AYNI (16..64 belgi).
 */
const requireDeviceId = (req, res, next) => {
  const deviceId = clientDeviceId(req);
  if (!deviceId) {
    throw reject(
      BadRequestError,
      "X-Device-Id sarlavhasi majburiy (16..64 belgi: harf, raqam, _ yoki -)",
      "device_id_required",
    );
  }
  req.parentalDeviceId = deviceId;
  next();
};

/**
 * Qurilma yo'llari OTA-ONA ilovasidan emas: ota-ona telefoni nazorat
 * qilinadigan qurilma emas. Aks holda u "bolaning telefoni" bo'lib
 * ro'yxatga tushar va jim qolganda soxta "oflayn" ogohlantirishi berardi.
 */
const rejectParentChannel = (req, res, next) => {
  if (req.sessionChannel === PARENT_CHANNEL) {
    throw reject(
      ForbiddenError,
      "Bu yo'l bolaning telefonidagi o'quvchi ilovasi uchun",
      "child_channel_required",
    );
  }
  next();
};

/** Ota-ona amallari faqat ota-ona ilovasi seansidan (`X-Client: parent` bilan login). */
const requireParentChannel = (req, res, next) => {
  if (req.sessionChannel !== PARENT_CHANNEL) {
    throw reject(
      ForbiddenError,
      "Bu amal faqat ota-ona ilovasidan bajariladi",
      "parent_channel_required",
    );
  }
  next();
};

const invalidToken = () =>
  reject(
    ForbiddenError,
    "PIN tasdig'i eskirgan yoki yaroqsiz — PIN'ni qayta kiriting",
    "parental_token_invalid",
  );

/**
 * `X-Parental-Token` ning SINXRON qismi: kanal, imzo, muddat, `purpose`,
 * foydalanuvchi, seans (`jti`) va filial.
 *
 * @param {import("express").Request} req
 * @returns {object} - token yuki
 * @throws {ForbiddenError}
 */
function assertParentalToken(req) {
  if (req.sessionChannel !== PARENT_CHANNEL) {
    throw reject(
      ForbiddenError,
      "Bu amal faqat ota-ona ilovasidan bajariladi",
      "parent_channel_required",
    );
  }

  const raw = req.headers?.["x-parental-token"];
  const token = String(Array.isArray(raw) ? raw[0] : raw || "").trim();
  if (!token) {
    throw reject(ForbiddenError, "PIN bilan tasdiqlash talab qilinadi", "parental_token_required");
  }

  const decoded = verifyParentalToken(token);
  const valid =
    decoded &&
    decoded.sub === req.user?.id &&
    Boolean(req.tokenJti) &&
    decoded.jti === req.tokenJti &&
    (decoded.br ?? null) === (req.branch?.id ?? null);

  if (!valid) throw invalidToken();
  return decoded;
}

/**
 * To'liq tekshiruv: sinxron qism + PIN VERSIYASI (`pv` === joriy
 * `pinUpdatedAt`). PIN almashgan yoki tiklangan bo'lsa eski token o'tmaydi.
 *
 * @param {import("express").Request} req
 * @param {{ pinHash: string|null, pinUpdatedAt: Date|null }} [settings] - o'qilgan bo'lsa
 */
async function checkParentalToken(req, settings) {
  const decoded = assertParentalToken(req);

  const current =
    settings ??
    (await prisma.parentalSettings.findUnique({
      where: { studentId: req.user.id },
      select: { pinHash: true, pinUpdatedAt: true },
    }));
  if (!current?.pinHash || decoded.pv !== pinVersionOf(current)) throw invalidToken();

  req.parental = { jti: decoded.jti, expiresAt: new Date(decoded.exp * 1000) };
}

/** [T] — holatni o'zgartiradigan ota-ona amallari. */
const requireParentalToken = asyncHandler(async (req, res, next) => {
  await checkParentalToken(req);
  next();
});

/**
 * `POST /parental/pin` uchun: PIN HALI YO'Q bo'lsa token shart emas
 * (birinchi o'rnatish), bor bo'lsa — `requireParentalToken` bilan AYNI.
 *
 * ⚠️ Bu yerdagi o'qish faqat YO'NALISH tanlaydi. PIN yo'q deb o'tkazilgan
 * so'rov servisda compare-and-swap (`pinHash: null`) bilan yoziladi —
 * oraliqda PIN qo'yilgan bo'lsa o'tmaydi.
 */
const parentalTokenIfPinSet = asyncHandler(async (req, res, next) => {
  const settings = await prisma.parentalSettings.findUnique({
    where: { studentId: req.user.id },
    select: { pinHash: true, pinUpdatedAt: true },
  });
  if (settings?.pinHash) await checkParentalToken(req, settings);
  next();
});

module.exports = {
  PARENT_CHANNEL,
  requireStudentAccount,
  requireDeviceId,
  rejectParentChannel,
  requireParentChannel,
  requireParentalToken,
  parentalTokenIfPinSet,
  // test uchun
  _assertParentalToken: assertParentalToken,
};
