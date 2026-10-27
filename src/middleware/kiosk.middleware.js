/**
 * FACE ID KIOSK — MARSHRUT DARVOZASI.
 *
 * FILIAL KONTEKSTI SHU YERDA YOQILADI — `auth.middleware.protect` bilan
 * AYNI naqsh, lekin hakam boshqa: foydalanuvchi tokeni emas, QURILMA
 * tokeni (`X-Kiosk-Token`).
 *
 * ⚠️ `req.user` QO'YILMAYDI va shunday bo'lishi SHART. Kiosk — odam emas,
 * qurilma: u hech kimning nomidan ish qilmaydi, faqat "kim keldi" degan
 * faktni keltiradi. `req.user` qo'yilsa, `authorizePermission` ishlatadigan
 * har qanday yo'l kiosk tokeni bilan ochilib qolardi.
 *
 * ⚠️ Shu sababli bu middleware FAQAT `/api/kiosk/*` ga mount qilinadi
 * (`routes/index.js`), ro'yxatga olish esa ODATIY login bilan ketadi
 * (`.claude/rules/face-id.md` §9) — kiosk tokeni biometrika YOZISHGA
 * yetmaydi.
 *
 * ⚠️ `next()` ATAYLAB `runWithBranch` ICHIDA chaqiriladi: undan tashqarida
 * chaqirilsa kontekst tarqamaydi va birinchi service so'rovi "Filial
 * konteksti yo'q" xatosi bilan yiqiladi.
 */

const { runWithBranch } = require("../config/branchContext");
const { verifyKioskToken } = require("../utils/jwt");
const asyncHandler = require("./async.middleware");
const { UnauthorizedError } = require("../utils/errors");
const kioskService = require("../services/kiosk.service");
const { clientIp } = require("../helpers/request.helpers");

/** Sarlavha nomi — kiosk dasturi bilan shartnoma. */
const KIOSK_TOKEN_HEADER = "x-kiosk-token";

const reject = (message, reason) => {
  const error = new UnauthorizedError(message);
  // Kiosk dasturi 401 ni MATNDAN emas, sababdan ajratadi:
  // `kiosk_token_required` / `kiosk_token_invalid` → biriktirish ekrani,
  // `kiosk_revoked` → "administratorga murojaat qiling".
  error.details = { reason };
  return error;
};

/**
 * Kiosk tokenini tekshiradi, filial kontekstini yoqadi.
 *
 * `req.kiosk` — reyestr qatori (PIN hash'i bilan), `req.branch` — filial.
 */
const protectKiosk = asyncHandler(async (req, res, next) => {
  const raw =
    req.headers[KIOSK_TOKEN_HEADER] ||
    (req.headers.authorization?.startsWith("Kiosk ")
      ? req.headers.authorization.slice(6)
      : null);

  if (!raw) throw reject("Kiosk tokeni yo'q", "kiosk_token_required");

  const decoded = verifyKioskToken(String(raw));
  if (!decoded) throw reject("Kiosk tokeni yaroqsiz", "kiosk_token_invalid");

  // Filial TOKENDAN O'QILMAYDI — reyestrdan olinadi (izoh service'da).
  const { kiosk, branch } = await kioskService.resolveKioskToken(decoded);

  return runWithBranch(branch, () => {
    req.kiosk = kiosk;
    req.branch = branch;
    req.clientIp = clientIp(req);
    next();
  });
});

module.exports = { protectKiosk, KIOSK_TOKEN_HEADER };
