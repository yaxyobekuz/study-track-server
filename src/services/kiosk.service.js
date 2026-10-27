/**
 * FACE ID KIOSKLARI — REYESTR VA QURILMA HAYOT DAVRI.
 *
 * ⚠️ PLATFORMA SERVICE'I: `platformPrisma` ishlatiladi, `config/prisma`
 * EMAS. Sabab root `CLAUDE.md` da: kiosk tokeni filial kontekstidan
 * OLDIN tekshiriladi, ya'ni "bu qurilma qaysi filialning?" degan savolga
 * javob filial schema'sida turolmaydi.
 *
 * ── BIRIKTIRISH IKKI TOMONLAMA ───────────────────────────────────────
 *
 * Kodni ADMIN beradi (`faceId.pair`), kodni kompyuterga esa O'RNATUVCHI
 * kiritadi. `deviceEnrollment.service.js` dagi qurilma biriktirish bilan
 * AYNI mulohaza: faqat admin qila olsa, masofadan noma'lum kompyuter
 * kioskka aylanardi; faqat o'rnatuvchi qila olsa, har kim o'ziga kiosk
 * ochib davomat yozdirib ketardi.
 *
 * ── KIOSK O'CHIRILMAYDI, `revoked` BO'LADI ───────────────────────────
 *
 * Ortida urinishlar jurnali va davomat qatorlari qoladi
 * (`PaymentAccount` / `Device` uslubi). O'chirish faqat HECH QACHON
 * biriktirilmagan (`pending`, bitta ham qaydi yo'q) kiosk uchun.
 */

const crypto = require("crypto");

const platformPrisma = require("../config/platformPrisma");
const branchService = require("./branch.service");
const { generateId } = require("../utils/idGenerator");
const { generateKioskToken } = require("../utils/jwt");
const { hashPin, verifyPin, isValidPin } = require("../helpers/parentalPin.helpers");
const { config } = require("../config/env.config");
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
} = require("../utils/errors");
const { formatPaginationResponse, getPaginationParams } = require("../utils/pagination");
const { isValidId } = require("../utils/objectId");
const { ROLES } = require("../utils/constants");
const logger = require("../utils/logger");

const KIOSK_STATUS = Object.freeze({
  PENDING: "pending",
  ACTIVE: "active",
  SUSPENDED: "suspended",
  REVOKED: "revoked",
});

const KIOSK_MODES = Object.freeze(["both", "staffOnly", "studentOnly"]);

/**
 * BIRIKTIRISH KODI — 8 belgi, chalkashadigan harflar OLIB TASHLANGAN.
 *
 * ⚠️ `0/O`, `1/I/L` yo'q: kodni odam ekrandan o'qib klaviaturada yozadi
 * va "nol edi, O emasmi?" degan urinish o'rnatuvchini kodni muddati
 * tugaguncha ovora qilardi.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

/** Kod 30 daqiqa yashaydi — o'rnatishga yetadi, tashlab ketilgani esa o'ladi. */
const CODE_TTL_MS = 30 * 60 * 1000;

/** `deviceUid` — kiosk dasturi beradigan barqaror identifikator. */
const DEVICE_UID_RE = /^[A-Za-z0-9_-]{16,64}$/;

const NAME_MAX = 80;
const LOCATION_MAX = 120;
const NOTE_MAX = 500;

/**
 * Panelga qaytariladigan shakl.
 *
 * ⚠️ PIN HASH, SALT VA KOD HASH'I CHIQMAYDI. Ular reyestrdagi SIR: panel
 * javobidan o'qib kiosk biriktirib olish yoki PIN'ni oflayn terish
 * mumkin bo'lmasligi kerak.
 */
const publicKiosk = (kiosk, { branchName } = {}) => ({
  id: kiosk.id,
  branchId: kiosk.branchId,
  branchName: branchName ?? kiosk.branch?.name ?? null,
  name: kiosk.name,
  location: kiosk.location,
  mode: kiosk.mode,
  status: kiosk.status,
  statusReason: kiosk.statusReason,
  note: kiosk.note,
  deviceUid: kiosk.deviceUid,
  pairedAt: kiosk.pairedAt,
  // Kod o'zi emas — faqat "kod berilgan va hali amal qiladi" fakti.
  pairingPending: Boolean(
    kiosk.pairingCodeHash && kiosk.pairingExpiresAt && kiosk.pairingExpiresAt > new Date(),
  ),
  pairingExpiresAt: kiosk.pairingExpiresAt,
  lastSeenAt: kiosk.lastSeenAt,
  lastIp: kiosk.lastIp,
  appVersion: kiosk.appVersion,
  osVersion: kiosk.osVersion,
  cameraLabel: kiosk.cameraLabel,
  pendingCount: kiosk.pendingCount,
  checkCount: kiosk.checkCount,
  lastCheckAt: kiosk.lastCheckAt,
  tokenVersion: kiosk.tokenVersion,
  createdAt: kiosk.createdAt,
  updatedAt: kiosk.updatedAt,
});

const generateCode = () => {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
};

/**
 * Kodni hash qiladi.
 *
 * ⚠️ PBKDF2 EMAS, oddiy SHA-256: kod 30 daqiqa yashaydi va 31 belgidan
 * 8 ta tanlanadi (~10^11 variant) — oflayn terish uchun ma'nosiz, lekin
 * `pair` so'rovi tez bo'lishi kerak (o'rnatuvchi kutib turadi). PIN esa
 * 4 raqam, shuning uchun u PBKDF2 dan o'tadi.
 */
const hashCode = (code) =>
  crypto.createHash("sha256").update(String(code).trim().toUpperCase()).digest("hex");

const trimTo = (value, max) => String(value ?? "").trim().slice(0, max);

const assertMode = (mode) => {
  if (mode !== undefined && !KIOSK_MODES.includes(mode)) {
    throw new BadRequestError("Kiosk rejimi noto'g'ri");
  }
};

/**
 * PIN'ni tekshiradi va hash'ini hisoblaydi.
 *
 * ⚠️ Bo'sh PIN RUXSAT ETILMAYDI: kioskdagi "Sozlamalar" ekrani kamerani,
 * filialni va ro'yxatga olish rejimini ochadi — parolsiz qoldirilsa
 * kirish eshigidagi kompyuter oldiga kelgan har kim uni qayta
 * sozlab ketardi.
 */
const buildPin = async (pin) => {
  if (!isValidPin(pin)) {
    throw new BadRequestError("Sozlama PIN kodi 4 raqamdan iborat bo'lishi kerak");
  }
  const { hash, salt, iterations } = await hashPin(pin, {
    iterations: config.parentalPinIterations,
  });
  return {
    setupPinHash: hash,
    setupPinSalt: salt,
    setupPinIterations: iterations,
    setupPinUpdatedAt: new Date(),
  };
};

/* ═══════════════════════════ PANEL AMALLARI ═══════════════════════════ */

/**
 * Kiosklar ro'yxati.
 *
 * ⚠️ Filial bo'yicha filtr MAJBURIY emas, lekin chaqiruvchi (controller)
 * har doim JORIY filialni beradi — owner esa `branchId=all` bilan
 * hammasini ko'radi. Reyestr platformada bo'lgani uchun filtr qo'yilmasa
 * barcha filiallarning kioski chiqib ketardi.
 *
 * @param {{ branchId?: string, status?: string, search?: string, page?: *, limit?: * }} query
 * @returns {Promise<object>}
 */
async function list(query = {}) {
  const { page, limit, skip } = getPaginationParams({ query });
  const where = {};

  if (query.branchId && query.branchId !== "all") where.branchId = query.branchId;
  if (query.status && query.status !== "all") where.status = query.status;

  const search = trimTo(query.search, 80);
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { location: { contains: search, mode: "insensitive" } },
    ];
  }

  const [rows, total] = await Promise.all([
    platformPrisma.kiosk.findMany({
      where,
      include: { branch: { select: { name: true } } },
      orderBy: [{ status: "asc" }, { name: "asc" }],
      skip,
      take: limit,
    }),
    platformPrisma.kiosk.count({ where }),
  ]);

  return formatPaginationResponse(
    rows.map((row) => publicKiosk(row)),
    total,
    page,
    limit,
  );
}

async function getById(id) {
  if (!isValidId(id)) throw new BadRequestError("Kiosk ID noto'g'ri");
  const kiosk = await platformPrisma.kiosk.findUnique({
    where: { id },
    include: { branch: { select: { name: true } } },
  });
  if (!kiosk) throw new NotFoundError("Kiosk topilmadi");
  return publicKiosk(kiosk);
}

/**
 * Yangi kiosk + darhol birinchi biriktirish kodi.
 *
 * ⚠️ Kod JAVOBDA FAQAT BIR MARTA qaytadi va bazada hash bilan yotadi.
 * Yo'qotilsa yangisi beriladi (`issuePairingCode`) — bu ataylab:
 * "kodni keyin ham ko'rsa bo'ladi" degan qulaylik reyestrni biriktirish
 * sirining ikkinchi nusxasiga aylantirardi.
 *
 * @param {object} data
 * @param {string} actorId
 * @returns {Promise<{ kiosk: object, pairingCode: string, expiresAt: Date }>}
 */
async function create(data = {}, actorId) {
  const name = trimTo(data.name, NAME_MAX);
  if (!name) throw new BadRequestError("Kiosk nomi kiritilmagan");

  assertMode(data.mode);

  // Filial ishga yaroqli bo'lishi shart: yarim ochilgan filialga kiosk
  // biriktirish "Filial konteksti yo'q" xatosiga olib kelardi.
  const branch = await branchService.getUsableById(data.branchId);

  const pin = await buildPin(data.setupPin);
  const code = generateCode();

  const kiosk = await platformPrisma.kiosk.create({
    data: {
      id: generateId(),
      branchId: branch.id,
      name,
      location: trimTo(data.location, LOCATION_MAX),
      note: trimTo(data.note, NOTE_MAX),
      mode: data.mode || "both",
      status: KIOSK_STATUS.PENDING,
      pairingCodeHash: hashCode(code),
      pairingExpiresAt: new Date(Date.now() + CODE_TTL_MS),
      ...pin,
      createdBy: actorId || null,
      updatedBy: actorId || null,
    },
    include: { branch: { select: { name: true } } },
  });

  logger.info(`Face ID: kiosk yaratildi — ${kiosk.name} (${branch.name})`);

  return {
    kiosk: publicKiosk(kiosk),
    pairingCode: code,
    expiresAt: kiosk.pairingExpiresAt,
  };
}

/**
 * Nomi, joyi, rejimi va izohi.
 *
 * ⚠️ `branchId` BU YERDA O'ZGARMAYDI. Kiosk filialini almashtirish —
 * uning galereyasini, jurnalini va biriktirilgan qurilmasini boshqa
 * bazaga ko'chirish degani; buning uchun eski kiosk bekor qilinib
 * yangisi ochiladi (`branchTransfer` bilan ayni mulohaza).
 */
async function update(id, data = {}, actorId) {
  await getById(id);
  assertMode(data.mode);

  const patch = { updatedBy: actorId || null };
  if (data.name !== undefined) {
    const name = trimTo(data.name, NAME_MAX);
    if (!name) throw new BadRequestError("Kiosk nomi bo'sh bo'lmaydi");
    patch.name = name;
  }
  if (data.location !== undefined) patch.location = trimTo(data.location, LOCATION_MAX);
  if (data.note !== undefined) patch.note = trimTo(data.note, NOTE_MAX);
  if (data.mode !== undefined) patch.mode = data.mode;

  const kiosk = await platformPrisma.kiosk.update({
    where: { id },
    data: patch,
    include: { branch: { select: { name: true } } },
  });
  return publicKiosk(kiosk);
}

/**
 * Yangi biriktirish kodi (qayta o'rnatish yoki kompyuter almashtirish).
 *
 * ⚠️ TOKENNI O'LDIRMAYDI: eski kompyuter kod berilgandan keyin ham
 * ishlashda davom etadi. Shunday bo'lishi kerak — kod berib qo'yib,
 * o'rnatishni ertaga qiladigan odam bugungi davomatni to'xtatmasligi
 * lozim. Qurilmani butunlay uzish — `revoke`.
 */
async function issuePairingCode(id, actorId) {
  const existing = await platformPrisma.kiosk.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Kiosk topilmadi");

  const code = generateCode();
  const kiosk = await platformPrisma.kiosk.update({
    where: { id },
    data: {
      pairingCodeHash: hashCode(code),
      pairingExpiresAt: new Date(Date.now() + CODE_TTL_MS),
      // Bekor qilingan kiosk kod bilan qaytadi — `pending` ga tushadi.
      status:
        existing.status === KIOSK_STATUS.REVOKED ? KIOSK_STATUS.PENDING : existing.status,
      statusReason: existing.status === KIOSK_STATUS.REVOKED ? null : existing.statusReason,
      updatedBy: actorId || null,
    },
    include: { branch: { select: { name: true } } },
  });

  return {
    kiosk: publicKiosk(kiosk),
    pairingCode: code,
    expiresAt: kiosk.pairingExpiresAt,
  };
}

/** Berilgan, lekin ishlatilmagan kodni bekor qiladi. */
async function cancelPairingCode(id, actorId) {
  await getById(id);
  const kiosk = await platformPrisma.kiosk.update({
    where: { id },
    data: { pairingCodeHash: null, pairingExpiresAt: null, updatedBy: actorId || null },
    include: { branch: { select: { name: true } } },
  });
  return publicKiosk(kiosk);
}

/**
 * Sozlama PIN'ini almashtiradi.
 *
 * ⚠️ TOKEN TIRIK QOLADI: PIN kioskdagi sozlama ekranini qulflaydi,
 * qurilmaning o'zini emas. PIN almashtirilgan payt davomat ishlashda
 * davom etishi kerak.
 */
async function updateSetupPin(id, pin, actorId) {
  await getById(id);
  const patch = await buildPin(pin);
  const kiosk = await platformPrisma.kiosk.update({
    where: { id },
    data: { ...patch, updatedBy: actorId || null },
    include: { branch: { select: { name: true } } },
  });
  return publicKiosk(kiosk);
}

/**
 * TOKENNI BEKOR QILADI — o'g'irlangan yoki chiqarib qo'yilgan kompyuter.
 *
 * ⚠️ `tokenVersion` oshiriladi va chiqarilgan token DARHOL o'ladi
 * (`resolveKioskToken` taqqoslaydi). Qatorni o'chirish o'rniga shu yo'l
 * tanlangan: jurnal va davomat qatorlari kioskka ishora qiladi.
 */
async function revoke(id, reason, actorId) {
  await getById(id);
  const kiosk = await platformPrisma.kiosk.update({
    where: { id },
    data: {
      status: KIOSK_STATUS.REVOKED,
      statusReason: trimTo(reason, NOTE_MAX) || null,
      tokenVersion: { increment: 1 },
      deviceUid: null,
      pairingCodeHash: null,
      pairingExpiresAt: null,
      updatedBy: actorId || null,
    },
    include: { branch: { select: { name: true } } },
  });
  logger.warn(`Face ID: kiosk tokeni bekor qilindi — ${kiosk.name}`);
  return publicKiosk(kiosk);
}

/**
 * Vaqtincha to'xtatish / qaytarish.
 *
 * ⚠️ `revoke` DAN FARQI: token TIRIK qoladi, server esa so'rovlarni rad
 * etadi. "Ta'mirga olib ketildi, ertaga qaytaradi" holati uchun — qayta
 * biriktirish kerak bo'lmaydi.
 */
async function setSuspended(id, suspended, reason, actorId) {
  const existing = await platformPrisma.kiosk.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Kiosk topilmadi");
  if (existing.status === KIOSK_STATUS.REVOKED) {
    throw new BadRequestError("Bekor qilingan kioskni to'xtatib bo'lmaydi — qayta biriktiring");
  }

  const kiosk = await platformPrisma.kiosk.update({
    where: { id },
    data: {
      status: suspended
        ? KIOSK_STATUS.SUSPENDED
        : existing.deviceUid
          ? KIOSK_STATUS.ACTIVE
          : KIOSK_STATUS.PENDING,
      statusReason: suspended ? trimTo(reason, NOTE_MAX) || null : null,
      updatedBy: actorId || null,
    },
    include: { branch: { select: { name: true } } },
  });
  return publicKiosk(kiosk);
}

/**
 * O'chirish — FAQAT hech qachon biriktirilmagan kiosk.
 *
 * ⚠️ Ishlatilgan kiosk o'chirilmaydi: urinishlar jurnalidagi
 * `kiosk_id` ishora qiladi va hisobotda "noma'lum qurilma" paydo
 * bo'lardi. Uning o'rniga — `revoke`.
 */
async function remove(id) {
  const kiosk = await platformPrisma.kiosk.findUnique({ where: { id } });
  if (!kiosk) throw new NotFoundError("Kiosk topilmadi");
  if (kiosk.pairedAt || kiosk.checkCount > 0) {
    throw new ConflictError(
      "Ishlatilgan kioskni o'chirib bo'lmaydi — uning o'rniga tokenni bekor qiling",
    );
  }
  await platformPrisma.kiosk.delete({ where: { id } });
  return { deleted: true };
}

/* ═════════════════════════ KIOSK AMALLARI ═════════════════════════ */

/**
 * BIRIKTIRISH — kod + qurilma identifikatori → uzoq muddatli token.
 *
 * ⚠️ Kod bo'yicha QIDIRILMAYDI (hash indeksi yo'q): o'rnatuvchi kiosk
 * nomini bilmaydi, lekin kod GLOBAL unique emas. Shuning uchun amal
 * qiladigan kodlar ro'yxati olinadi va hash taqqoslanadi — ro'yxat
 * doim kichik (bir vaqtda bir-ikki kiosk o'rnatiladi).
 *
 * ⚠️ `timingSafeEqual` ishlatilmaydi: taqqoslanadigan qiymat hash,
 * ya'ni uzunligi doim bir xil va sirni bayt-bayt oshkor qilish uchun
 * hujumchiga kodning O'ZI kerak bo'lardi.
 *
 * @param {{ code: string, deviceUid: string, appVersion?: string, osVersion?: string, cameraLabel?: string }} input
 * @param {string|null} ip
 * @returns {Promise<{ token: string, expiresAt: Date, kiosk: object, branch: object }>}
 */
async function pair(input = {}, ip = null) {
  const code = trimTo(input.code, 32).toUpperCase();
  const deviceUid = trimTo(input.deviceUid, 64);

  if (code.length !== CODE_LENGTH) throw new BadRequestError("Biriktirish kodi noto'g'ri");
  if (!DEVICE_UID_RE.test(deviceUid)) {
    throw new BadRequestError("Qurilma identifikatori noto'g'ri");
  }

  const hash = hashCode(code);
  const candidates = await platformPrisma.kiosk.findMany({
    where: {
      pairingCodeHash: { not: null },
      pairingExpiresAt: { gt: new Date() },
      status: { in: [KIOSK_STATUS.PENDING, KIOSK_STATUS.ACTIVE] },
    },
    select: { id: true, pairingCodeHash: true },
  });

  const hit = candidates.find((row) => row.pairingCodeHash === hash);
  if (!hit) {
    throw new UnauthorizedError("Biriktirish kodi topilmadi yoki muddati tugagan");
  }

  const kiosk = await platformPrisma.kiosk.update({
    where: { id: hit.id },
    data: {
      deviceUid,
      status: KIOSK_STATUS.ACTIVE,
      statusReason: null,
      pairedAt: new Date(),
      // ⚠️ Kod ISHLATILGANDAN KEYIN O'CHIRILADI — bir martalik.
      pairingCodeHash: null,
      pairingExpiresAt: null,
      tokenIssuedAt: new Date(),
      lastSeenAt: new Date(),
      lastIp: ip,
      appVersion: trimTo(input.appVersion, 40) || null,
      osVersion: trimTo(input.osVersion, 80) || null,
      cameraLabel: trimTo(input.cameraLabel, 120) || null,
    },
    include: { branch: { select: { id: true, name: true, code: true } } },
  });

  const { token, expiresAt } = generateKioskToken({
    kioskId: kiosk.id,
    branchId: kiosk.branchId,
    deviceUid,
    tokenVersion: kiosk.tokenVersion,
  });

  logger.info(`Face ID: kiosk biriktirildi — ${kiosk.name} (${kiosk.branch.name})`);

  return {
    token,
    expiresAt,
    kiosk: publicKiosk(kiosk),
    branch: { id: kiosk.branch.id, name: kiosk.branch.name, code: kiosk.branch.code },
  };
}

/**
 * TOKENDAN KIOSKNI TIKLAYDI — `middleware/kiosk.middleware.js` uchun.
 *
 * ⚠️ Filial TOKENDAN O'QILMAYDI, reyestrdan olinadi: token berilgandan
 * keyin filial arxivlanishi yoki kiosk boshqa holatga o'tishi mumkin.
 * `auth.middleware` dagi `getUsableById` bilan ayni mulohaza.
 *
 * ⚠️ `tokenVersion` MOS KELMASA RAD ETILADI — "Bekor qilish" tugmasini
 * HAQIQIY qiladigan yagona shart. Usiz tugma faqat reyestrdagi holatni
 * o'zgartirgan bo'lardi, token esa bir yil ishlashda davom etardi.
 *
 * @param {{ sub: string, tv: number }} decoded - `verifyKioskToken` natijasi
 * @returns {Promise<{ kiosk: object, branch: object }>}
 */
async function resolveKioskToken(decoded) {
  const kiosk = await platformPrisma.kiosk.findUnique({ where: { id: String(decoded.sub) } });
  if (!kiosk) throw new UnauthorizedError("Kiosk topilmadi — qaytadan biriktiring");

  if (Number(decoded.tv) !== kiosk.tokenVersion) {
    const error = new UnauthorizedError("Kiosk tokeni bekor qilingan — qaytadan biriktiring");
    error.details = { reason: "kiosk_revoked" };
    throw error;
  }

  if (kiosk.status === KIOSK_STATUS.REVOKED) {
    const error = new UnauthorizedError("Kiosk bekor qilingan — qaytadan biriktiring");
    error.details = { reason: "kiosk_revoked" };
    throw error;
  }

  if (kiosk.status === KIOSK_STATUS.SUSPENDED) {
    const error = new ForbiddenError(
      kiosk.statusReason
        ? `Kiosk vaqtincha to'xtatilgan: ${kiosk.statusReason}`
        : "Kiosk vaqtincha to'xtatilgan",
    );
    error.details = { reason: "kiosk_suspended" };
    throw error;
  }

  // Filial yaroqliligi — arxivlangan filial kioskidan davomat kelmasligi
  // kerak. Xato matni `branchService` dan keladi (yagona manba).
  const branch = await branchService.getUsableById(kiosk.branchId);

  return { kiosk, branch };
}

/**
 * HEARTBEAT — kiosk tirikligini va holatini yozadi.
 *
 * ⚠️ So'rovni KUTIB TURMAYDI'gan yozuv EMAS: kiosk bu javobdan sozlamani
 * va galereya versiyasini oladi, ya'ni javob baribir kerak. Faollik
 * yozuvi (`activityService.touchPanel`) bilan farqi shunda.
 *
 * @param {string} kioskId
 * @param {{ appVersion?: string, osVersion?: string, cameraLabel?: string, pendingCount?: * }} info
 * @param {string|null} ip
 */
async function touch(kioskId, info = {}, ip = null) {
  const patch = { lastSeenAt: new Date(), lastIp: ip };

  if (info.appVersion !== undefined) patch.appVersion = trimTo(info.appVersion, 40) || null;
  if (info.osVersion !== undefined) patch.osVersion = trimTo(info.osVersion, 80) || null;
  if (info.cameraLabel !== undefined) patch.cameraLabel = trimTo(info.cameraLabel, 120) || null;
  if (info.pendingCount !== undefined) {
    const pending = Number(info.pendingCount);
    patch.pendingCount = Number.isFinite(pending) ? Math.max(0, Math.min(99999, pending)) : 0;
  }

  await platformPrisma.kiosk.update({ where: { id: kioskId }, data: patch }).catch(() => {});
}

/**
 * Qayd hisoblagichi — urinish EMAS, YOZILGAN davomat.
 *
 * ⚠️ Kutib turilmaydi va yiqitmaydi: hisoblagich ko'rsatish uchun, davomat
 * esa allaqachon yozilgan. Hisoblagich yiqilsa davomat bekor bo'lib
 * qolmasligi kerak.
 */
function bumpCheckCount(kioskId) {
  if (!kioskId) return;
  platformPrisma.kiosk
    .update({
      where: { id: kioskId },
      data: { checkCount: { increment: 1 }, lastCheckAt: new Date() },
    })
    .catch(() => {});
}

/**
 * Kioskdagi "Sozlamalar" PIN'ini tekshiradi.
 *
 * ⚠️ `verifyPin` buzuq qatorda `false` qaytaradi (xato emas) — izohi
 * `parentalPin.helpers.js` da.
 *
 * @param {object} kiosk - reyestr qatori (`resolveKioskToken` dan)
 * @param {string} pin
 * @returns {Promise<boolean>}
 */
async function verifySetupPin(kiosk, pin) {
  return verifyPin(pin, {
    pinHash: kiosk.setupPinHash,
    pinSalt: kiosk.setupPinSalt,
    pinIterations: kiosk.setupPinIterations,
  });
}

/**
 * Kioskning o'ziga ko'rsatiladigan shakl — PIN hash'i bilan BIRGA.
 *
 * ⚠️ `pinHash` kioskka ATAYLAB beriladi: internet uzilganda sozlama
 * ekranini ochish uchun PIN lokal tekshirilishi kerak. Qurilmada hash
 * yotishi xavf, lekin kiosk allaqachon galereyani (biometrikani) olib
 * yuradi — ikkinchi qulf bo'lmasa, o'g'irlangan kompyuterda PIN
 * tekshiruvi mantiqsiz bo'lardi. Panelga esa bu CHIQMAYDI.
 */
const kioskSelf = (kiosk, branch) => ({
  id: kiosk.id,
  name: kiosk.name,
  location: kiosk.location,
  mode: kiosk.mode,
  status: kiosk.status,
  branch: { id: branch.id, name: branch.name, code: branch.code },
  setupPin: {
    algo: "pbkdf2-sha256",
    hash: kiosk.setupPinHash,
    salt: kiosk.setupPinSalt,
    iterations: kiosk.setupPinIterations,
    updatedAt: kiosk.setupPinUpdatedAt,
  },
});

/**
 * KIOSK REJIMI DARVOZASI — "bu qurilma shu odamni o'tkazadimi".
 *
 * ⚠️ FILIAL SOZLAMASIDAN (`FaceSettings.staffEnabled/studentEnabled`)
 * PASTDA turadi: filialda o'chirilgan bo'lsa kiosk rejimi yordam
 * bermaydi. Tekshiruv kimligi aniqlangandan KEYIN bo'ladi, shuning
 * uchun middleware'da emas, `faceAttendance.service.js` da chaqiriladi.
 *
 * ⚠️ `role !== "student"` deb tekshiriladi, `hasRole` bilan EMAS:
 * qo'shimcha "student" roli berilgan xodim xodim bo'lib qolishi kerak
 * (`parental.middleware.js` dagi `requireStudentAccount` bilan ayni
 * mulohaza).
 *
 * @param {{ mode: string }} kiosk
 * @param {string} role - odamning ASOSIY roli
 * @returns {boolean}
 */
function modeAllows(kiosk, role) {
  if (kiosk?.mode === "staffOnly") return role !== ROLES.STUDENT;
  if (kiosk?.mode === "studentOnly") return role === ROLES.STUDENT;
  return true;
}

module.exports = {
  list,
  getById,
  create,
  update,
  issuePairingCode,
  cancelPairingCode,
  updateSetupPin,
  revoke,
  setSuspended,
  remove,
  pair,
  resolveKioskToken,
  touch,
  bumpCheckCount,
  verifySetupPin,
  modeAllows,
  kioskSelf,
  publicKiosk,
  KIOSK_STATUS,
  KIOSK_MODES,
};
