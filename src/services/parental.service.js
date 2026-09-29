/**
 * OTA-ONA NAZORATI — OTA-ONA ILOVASI TOMONI.
 *
 * Holat, PIN (o'rnatish / tasdiqlash / tiklash), ilovalar va ularni
 * bloklash, "hammasini bloklash", foydalanish statistikasi, hodisalar va
 * bolaning ruxsat so'rovlari.
 *
 * ── HIMOYA MODELI ───────────────────────────────────────────────────────
 *
 * Ota-ona ilovasi O'QUVCHI HISOBI bilan kiradi, ya'ni oddiy access token
 * bolaning qo'lida ham bor. Shuning uchun holatni o'zgartiradigan HAR BIR
 * amal PIN bilan tasdiqlangan qisqa muddatli token talab qiladi
 * (`X-Parental-Token`, `parental.middleware.js`). O'qish (status, usage,
 * apps, events) tokensiz — bola o'z statistikasini ko'rsa zarar yo'q, va bu
 * modulning etik asosi: nazorat YASHIRIN emas (`devices.md` §0.1).
 *
 * ⚠️ PIN TIKLASH HISOB PAROLI BILAN (`resetPin`) — bola parolni bilsa,
 * PIN'ni ham tiklay oladi. Bu TZ qarori (alohida ota-ona hisobi keyingi
 * bosqich); yumshatish: har tiklashda ota-onaga ko'rinadigan push
 * (`pin_reset`) va tarixda yozuv.
 *
 * ── PIN URINISHLARI ─────────────────────────────────────────────────────
 *
 * ⚠️ TEKSHIRUV OLDIDAN "IJARA" (`VERIFY_LEASE_MS`): `lockedUntil` bitta
 * atomar UPDATE bilan band qilinadi, shundan keyingina PBKDF2 hisoblanadi.
 * Busiz 100 ta parallel so'rov hammasi "blok yo'q" deb o'qib, 100 ta PIN'ni
 * birdan tekshirib olardi — 5 xatodan keyingi blok qog'ozda qolardi.
 */

const prisma = require("../config/prisma");
const { getBranch } = require("../config/branchContext");
const { config } = require("../config/env.config");
const { generateParentalToken } = require("../utils/jwt");
const { matchPassword } = require("../utils/password");
const { isValidId } = require("../utils/objectId");
const { formatPaginationResponse } = require("../utils/pagination");
const { PARENTAL_EVENT_LABELS } = require("../utils/constants");
const {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
} = require("../utils/errors");
const { formatDateUz, formatDateTimeUz } = require("../helpers/date.helpers");
const { currentDayDate, parseDayDate } = require("../helpers/month.helpers");
const { DEVICE_ID_PATTERN } = require("../helpers/request.helpers");
const {
  PIN_MAX_ATTEMPTS,
  isValidPin,
  hashPin,
  verifyPin: verifyPinHash,
  isAppId,
  pinVersionOf,
  lockDurationMs,
} = require("../helpers/parentalPin.helpers");
const parentalPush = require("../helpers/parentalPush.helpers");
const pushService = require("./push.service");
const policyService = require("./parentalPolicy.service");
const eventService = require("./parentalEvent.service");

const DAY_MS = 24 * 60 * 60 * 1000;

/** Shuncha daqiqa ichida ko'ringan qurilma — "onlayn". */
const ONLINE_WINDOW_MS = 30 * 60 * 1000;

/**
 * Bitta PIN tekshiruvining ijarasi — parallel urinishlar navbatga turadi.
 * Tekshiruv tugashi bilan bo'shatiladi; muddat faqat jarayon yiqilgan
 * holat uchun (qotib qolgan ijara o'zi tugaydi).
 */
const VERIFY_LEASE_MS = 15000;

const UNLOCK_MINUTES = Object.freeze({ min: 5, max: 240 });
const DAILY_LIMIT = Object.freeze({ min: 5, max: 1440 });
const LOCK_ALL_MAX_MS = 7 * DAY_MS;
const USAGE_MAX_DAYS = 31;
const BULK_MAX = 500;
const SEARCH_MAX = 100;
const PAGE_MAX = 100;

const REQUEST_STATUSES = ["pending", "approved", "denied", "expired"];
const REQUEST_STATUS_LABELS = {
  pending: "Kutilmoqda",
  approved: "Ruxsat berildi",
  denied: "Rad etildi",
  expired: "Muddati o'tdi",
};

/** ISO vaqt — faqat aniq mintaqa bilan (`Z` yoki `+05:00`): mintaqasiz satr server vaqtida o'qilardi. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const EVENT_TYPE_PATTERN = /^[a-z_]{2,40}$/;

/* ───────────────────────────── Yordamchilar ───────────────────────────── */

/** Xatoga mashina o'qiydigan `details` qo'shadi (global handler uni javobga qo'yadi). */
function withDetails(error, details) {
  error.details = details;
  return error;
}

const forbidden = (message, reason) => withDetails(new ForbiddenError(message), { reason });

function readBool(value, label) {
  if (typeof value !== "boolean") {
    throw new BadRequestError(`${label} true yoki false bo'lishi kerak`);
  }
  return value;
}

function readInt(value, label, { min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BadRequestError(`${label} ${min}..${max} oralig'idagi butun son bo'lishi kerak`);
  }
  return value;
}

const has = (body, key) => Object.prototype.hasOwnProperty.call(body || {}, key);

/** Sahifalash — chegaralangan (manfiy `skip` Prisma'ni yiqitardi). */
function clampPage({ page, limit } = {}) {
  const safeLimit = Math.min(PAGE_MAX, Math.max(1, Number(limit) || 24));
  const safePage = Math.max(1, Number(page) || 1);
  return { page: safePage, limit: safeLimit, skip: (safePage - 1) * safeLimit };
}

const iso = (value) => (value ? new Date(value).toISOString() : null);
const dayKey = (date) => date.toISOString().slice(0, 10);

/** Qurilma → ota-ona ilovasidagi ko'rinish. */
function deviceDto(device, now = Date.now()) {
  const seen = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
  return {
    deviceId: device.deviceId,
    platform: device.platform,
    model: device.model,
    osVersion: device.osVersion,
    appVersion: device.appVersion,
    protected: device.protected,
    health: device.health ?? {},
    lastSeenAt: iso(device.lastSeenAt),
    lastSeenLabel: formatDateTimeUz(device.lastSeenAt),
    online: seen > 0 && now - seen <= ONLINE_WINDOW_MS,
  };
}

/** Ilova → ota-ona ilovasidagi ko'rinish. `appId` — `appKeyHash`. */
function appDto(app, todayMinutes = 0) {
  return {
    appId: app.appKeyHash,
    appKey: app.appKey,
    appName: app.appName,
    iconUrl: app.iconUrl,
    platform: app.platform,
    blocked: app.blocked,
    dailyLimitMin: app.dailyLimitMin,
    installed: app.installed,
    alwaysAllowed: policyService.isAlwaysAllowed(app.appKey),
    todayMinutes,
    firstSeenAt: iso(app.firstSeenAt),
  };
}

/** Bugungi daqiqalar (barcha qurilmalar bo'yicha yig'ma) — `appKeyHash` → daqiqa. */
async function todayMinutesByApp(studentId, hashes) {
  if (hashes.length === 0) return new Map();
  const rows = await prisma.appUsageDaily.findMany({
    where: { studentId, date: currentDayDate(), appKeyHash: { in: hashes } },
    select: { appKeyHash: true, minutes: true },
  });
  const map = new Map();
  for (const row of rows) map.set(row.appKeyHash, (map.get(row.appKeyHash) || 0) + row.minutes);
  return map;
}

/** Holatni o'zgartirgan amal javobidagi umumiy qism. */
function lockState(settings) {
  const lockAll = policyService.effectiveLockAll(settings);
  const until = lockAll ? settings.lockAllUntil : null;
  return {
    lockAll,
    lockAllUntil: iso(until),
    lockAllUntilLabel: until ? formatDateTimeUz(until) : null,
    unlockMinutes: settings.unlockMinutes,
    policyVersion: settings.policyVersion,
  };
}

/* ───────────────────────────── Holat ───────────────────────────── */

/**
 * `GET /parental/status`
 * @param {{ id: string }} user
 */
async function getStatus(user) {
  const studentId = user.id;
  const now = new Date();

  const [settings, devices, pendingRequests] = await Promise.all([
    policyService.currentSettings(studentId),
    prisma.parentalDevice.findMany({ where: { studentId }, orderBy: { lastSeenAt: "desc" } }),
    prisma.parentalUnlockRequest.count({
      where: { studentId, status: "pending", expiresAt: { gt: now } },
    }),
  ]);

  return {
    pinSet: Boolean(settings.pinHash),
    pinUpdatedAt: iso(settings.pinUpdatedAt),
    pinUpdatedAtLabel: settings.pinUpdatedAt ? formatDateTimeUz(settings.pinUpdatedAt) : null,
    ...lockState(settings),
    pendingRequests,
    devices: devices.map((d) => deviceDto(d, now.getTime())),
  };
}

/* ───────────────────────────── PIN ───────────────────────────── */

/**
 * Yangi PIN bilan boshqaruv tokeni — PIN o'zgargach eski tokenlar o'ladi
 * (`pv`), shuning uchun PIN'ni o'rnatgan/almashtirgan/tiklagan ota-ona
 * ilovasi darhol yangisini oladi (u yangi PIN'ni allaqachon biladi).
 * `jti` siz (eski) seansda — `null`.
 */
function issueToken({ studentId, jti, branchId, settings }) {
  if (!jti) return {};
  const { token, expiresAt } = generateParentalToken({
    userId: studentId,
    jti,
    branchId,
    pinVersion: pinVersionOf(settings),
  });
  return { parentalToken: token, expiresAt: expiresAt.toISOString() };
}

/** PIN'ni saqlagan amallarning umumiy javobi. */
const pinSavedDto = (row, ctx) => ({
  pinSet: true,
  pinUpdatedAt: iso(row.pinUpdatedAt),
  pinUpdatedAtLabel: formatDateTimeUz(row.pinUpdatedAt),
  policyVersion: row.policyVersion,
  ...issueToken({ studentId: row.studentId, jti: ctx.jti, branchId: ctx.branchId, settings: row }),
});

/** Yangi PIN yozuvi — o'rnatish, almashtirish va tiklash uchun AYNI. */
async function newPinData(pin) {
  const { hash, salt, iterations } = await hashPin(pin, {
    iterations: config.parentalPinIterations,
  });
  return {
    pinHash: hash,
    pinSalt: salt,
    pinIterations: iterations,
    pinUpdatedAt: new Date(),
    failedAttempts: 0,
    lockedUntil: null,
    policyVersion: { increment: 1 },
  };
}

/**
 * `POST /parental/pin` — birinchi o'rnatish yoki (token bilan) almashtirish.
 *
 * ⚠️ BIRINCHI O'RNATISH COMPARE-AND-SWAP (`pinHash: null`): tokensiz yo'l
 * FAQAT PIN hali yo'q bo'lsa ishlaydi. Middleware PIN yo'qligini ko'rgan-u,
 * oraliqda boshqa so'rov PIN qo'ygan bo'lsa ham — bu yozuv o'tmaydi.
 *
 * @param {{ id: string }} user
 * @param {{ pin: string }} body
 * @param {{ authorized: boolean, jti?: string|null, branchId?: string|null, deviceId?: string|null }} ctx
 *   `authorized`: so'rov parental token bilan tasdiqlangan (`req.parental`)
 */
async function setPin(user, body, ctx) {
  const studentId = user.id;
  const pin = body?.pin;
  if (!isValidPin(pin)) throw new BadRequestError("PIN 4 ta raqamdan iborat bo'lishi kerak");

  await policyService.ensureSettings(studentId);
  const [row] = await prisma.parentalSettings.updateManyAndReturn({
    where: ctx.authorized ? { studentId } : { studentId, pinHash: null },
    data: await newPinData(pin),
  });

  if (!row) {
    throw forbidden(
      "PIN allaqachon o'rnatilgan — almashtirish uchun avval PIN'ni tasdiqlang",
      "parental_token_required",
    );
  }

  policyService.notifyPolicy(studentId, row.policyVersion);
  await eventService.recordEventSafe({
    studentId,
    deviceId: ctx.deviceId ?? null,
    type: ctx.authorized ? "pin_changed" : "pin_set",
    alert: false,
  });

  return pinSavedDto(row, ctx);
}

/**
 * `POST /parental/pin/verify` — PIN → boshqaruv tokeni.
 *
 * Xato → 401 `{ attemptsLeft }`, blok → 429 `{ retryAfterSec }`
 * (`details` ichida, `reason` bilan: `wrong_pin` 401 ni "seans tugadi"
 * 401 idan ajratadi — ilova tizimdan chiqib ketmasligi kerak).
 *
 * ⚠️ XATOLAR ATOMAR SANALADI (`increment`), o'qilgan qiymat + 1 EMAS:
 * PBKDF2 ijaradan uzoq cho'zilsa (katta iteratsiya, band thread pool) ikki
 * tekshiruv ustma-ust tushishi mumkin — shunda ham birorta xato yo'qolmaydi.
 * Blok faqat UZAYTIRILADI (qisqasi uzunining ustidan yozilmaydi), ijara esa
 * faqat O'ZIMIZNIKI bo'lsa bo'shatiladi.
 *
 * @param {{ id: string, firstName?: string }} user
 * @param {{ pin: string }} body
 * @param {{ jti: string|null, branchId: string|null, deviceId?: string|null }} ctx
 * @returns {Promise<{ parentalToken: string, expiresAt: string }>}
 */
async function verifyPin(user, body, { jti, branchId, deviceId = null }) {
  const studentId = user.id;
  const pin = body?.pin;
  if (!isValidPin(pin)) throw new BadRequestError("PIN 4 ta raqamdan iborat bo'lishi kerak");

  // Token seansga bog'lanadi — `jti` siz (eski) token bilan bog'lab bo'lmaydi
  if (!jti) {
    throw forbidden("Qaytadan tizimga kiring", "session_required");
  }

  const now = new Date();
  const lease = new Date(now.getTime() + VERIFY_LEASE_MS);
  const [claimed] = await prisma.parentalSettings.updateManyAndReturn({
    where: {
      studentId,
      pinHash: { not: null },
      OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
    },
    data: { lockedUntil: lease },
    select: {
      pinHash: true,
      pinSalt: true,
      pinIterations: true,
      pinUpdatedAt: true,
      failedAttempts: true,
    },
  });

  if (!claimed) {
    const current = await prisma.parentalSettings.findUnique({
      where: { studentId },
      select: { pinHash: true, lockedUntil: true, failedAttempts: true },
    });
    if (!current?.pinHash) {
      throw new ConflictError("PIN hali o'rnatilmagan", { reason: "pin_not_set" });
    }

    const locked = current.failedAttempts >= PIN_MAX_ATTEMPTS;
    // Band (boshqa tekshiruv ketmoqda) — soniyalar ichida bo'shaydi
    const retryAfterSec = locked
      ? Math.max(1, Math.ceil((new Date(current.lockedUntil).getTime() - Date.now()) / 1000))
      : 1;
    throw withDetails(
      new TooManyRequestsError(
        locked
          ? `PIN ko'p marta noto'g'ri kiritildi. ${Math.ceil(retryAfterSec / 60)} daqiqadan keyin qayta urinib ko'ring`
          : "PIN tekshirilmoqda, bir oz kuting",
      ),
      { reason: locked ? "pin_locked" : "pin_busy", retryAfterSec, attemptsLeft: 0 },
    );
  }

  if (await verifyPinHash(pin, claimed)) {
    await prisma.parentalSettings.update({
      where: { studentId },
      data: { failedAttempts: 0, lockedUntil: null },
    });
    return issueToken({ studentId, jti, branchId, settings: claimed });
  }

  const [counted] = await prisma.parentalSettings.updateManyAndReturn({
    where: { studentId },
    data: { failedAttempts: { increment: 1 } },
    select: { failedAttempts: true },
  });
  const failedAttempts = counted?.failedAttempts ?? claimed.failedAttempts + 1;
  const lockMs = lockDurationMs(failedAttempts);

  if (lockMs) {
    const lockedUntil = new Date(Date.now() + lockMs);
    await prisma.parentalSettings.updateMany({
      where: {
        studentId,
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: lockedUntil } }],
      },
      data: { lockedUntil },
    });
  } else {
    await prisma.parentalSettings.updateMany({
      where: { studentId, lockedUntil: lease },
      data: { lockedUntil: null },
    });
  }

  await eventService.recordEventSafe({
    studentId,
    deviceId,
    type: "wrong_pin",
    payload: { source: "server", attempts: failedAttempts },
    attempts: failedAttempts,
    studentName: user.firstName ?? null,
  });

  if (lockMs) {
    throw withDetails(
      new TooManyRequestsError(
        `PIN ko'p marta noto'g'ri kiritildi. ${lockMs / 60000} daqiqadan keyin qayta urinib ko'ring`,
      ),
      { reason: "pin_locked", retryAfterSec: Math.ceil(lockMs / 1000), attemptsLeft: 0 },
    );
  }

  throw withDetails(new UnauthorizedError("PIN noto'g'ri"), {
    reason: "wrong_pin",
    attemptsLeft: PIN_MAX_ATTEMPTS - failedAttempts,
  });
}

/**
 * `POST /parental/pin/reset` — PIN unutilganda, HISOB PAROLI bilan.
 *
 * ⚠️ Har tiklash ota-onaga ko'rinadigan push (`pin_reset`) va tarixda
 * yozuv: bola parolni bilsa ham, bu jimgina o'tib ketmasligi kerak.
 * Eski PIN bilan olingan tokenlar o'ladi (`pv`). Urinishlar soni route
 * darajasida cheklangan (`pinResetLimiter`).
 *
 * @param {{ id: string, firstName?: string }} user
 * @param {{ password: string, pin: string }} body
 * @param {{ jti?: string|null, branchId?: string|null, deviceId?: string|null }} ctx
 */
async function resetPin(user, body, ctx = {}) {
  const studentId = user.id;
  const password = body?.password;
  const pin = body?.pin;

  if (typeof password !== "string" || password.length === 0 || password.length > 256) {
    throw new BadRequestError("Parol majburiy");
  }
  if (!isValidPin(pin)) throw new BadRequestError("PIN 4 ta raqamdan iborat bo'lishi kerak");

  const account = await prisma.user.findUnique({
    where: { id: studentId },
    select: { password: true },
  });
  if (!account?.password || !(await matchPassword(password, account.password))) {
    throw forbidden("Parol noto'g'ri", "wrong_password");
  }

  await policyService.ensureSettings(studentId);
  const row = await prisma.parentalSettings.update({
    where: { studentId },
    data: await newPinData(pin),
  });

  policyService.notifyPolicy(studentId, row.policyVersion);
  await eventService.recordEventSafe({
    studentId,
    deviceId: ctx.deviceId ?? null,
    type: "pin_reset",
    studentName: user.firstName ?? null,
  });

  return pinSavedDto(row, ctx);
}

/* ───────────────────────────── Statistika ───────────────────────────── */

/**
 * `GET /parental/usage?date=YYYY-MM-DD` yoki `?from&to` (≤ 31 kun), `?deviceId`.
 *
 * ⚠️ KUN — Toshkent kuni (`@db.Date`, UTC yarim tuni). Sukut — bugun.
 * Bir nechta qurilma bo'lsa daqiqalar QO'SHILADI: bu turli ekranlar.
 *
 * @param {{ id: string }} user
 * @param {object} query
 */
async function getUsage(user, query = {}) {
  const studentId = user.id;
  const today = currentDayDate();

  let from;
  let to;
  if (query.date) {
    from = parseDayDate(query.date, "date");
    to = from;
  } else if (query.from || query.to) {
    from = parseDayDate(query.from || query.to, "from");
    to = parseDayDate(query.to || query.from, "to");
  } else {
    from = today;
    to = today;
  }

  if (from > to) throw new BadRequestError("from sanasi to sanasidan keyin bo'lishi mumkin emas");
  const dayCount = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (dayCount > USAGE_MAX_DAYS) {
    throw new BadRequestError(`Oraliq ko'pi bilan ${USAGE_MAX_DAYS} kun bo'lishi mumkin`);
  }

  const deviceId = query.deviceId ? String(query.deviceId) : null;
  if (deviceId && !DEVICE_ID_PATTERN.test(deviceId)) {
    throw new BadRequestError("deviceId noto'g'ri");
  }

  const rows = await prisma.appUsageDaily.findMany({
    where: { studentId, date: { gte: from, lte: to }, ...(deviceId ? { deviceId } : {}) },
    select: { date: true, appKeyHash: true, minutes: true, minMinutes: true, openCount: true },
  });

  const byDay = new Map();
  const byApp = new Map();
  let totalMinutes = 0;

  for (const row of rows) {
    const key = dayKey(row.date);
    byDay.set(key, (byDay.get(key) || 0) + row.minutes);
    totalMinutes += row.minutes;

    const agg = byApp.get(row.appKeyHash) || { minutes: 0, openCount: 0, minMinutes: false };
    agg.minutes += row.minutes;
    agg.openCount += row.openCount;
    agg.minMinutes = agg.minMinutes || row.minMinutes;
    byApp.set(row.appKeyHash, agg);
  }

  const apps = byApp.size
    ? await prisma.parentalApp.findMany({
        where: { studentId, appKeyHash: { in: [...byApp.keys()] } },
        select: {
          appKeyHash: true,
          appName: true,
          iconUrl: true,
          platform: true,
          blocked: true,
        },
      })
    : [];
  const appByHash = new Map(apps.map((a) => [a.appKeyHash, a]));

  // Oraliqdagi HAR kun — bo'sh kunlar ham (0), grafik uzilmasin
  const days = [];
  for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
    const date = new Date(t);
    days.push({
      date: dayKey(date),
      dateLabel: formatDateUz(date, { utc: true }),
      totalMinutes: byDay.get(dayKey(date)) || 0,
    });
  }

  return {
    from: dayKey(from),
    to: dayKey(to),
    totalMinutes,
    days,
    apps: [...byApp.entries()]
      .map(([hash, agg]) => {
        const app = appByHash.get(hash);
        return {
          appId: hash,
          appName: app?.appName ?? null,
          iconUrl: app?.iconUrl ?? null,
          platform: app?.platform ?? null,
          minutes: agg.minutes,
          minMinutes: agg.minMinutes,
          openCount: agg.openCount,
          blocked: app?.blocked ?? false,
        };
      })
      .sort(
        (a, b) =>
          b.minutes - a.minutes ||
          b.openCount - a.openCount ||
          String(a.appName || "").localeCompare(String(b.appName || "")),
      ),
  };
}

/* ───────────────────────────── Ilovalar ───────────────────────────── */

/**
 * `GET /parental/apps?page&limit&search&blocked` — sahifalangan.
 * Tartib: o'rnatilganlari oldin, keyin nom bo'yicha (nomsiz — oxirida).
 */
async function listApps(user, query = {}, pagination = {}) {
  const studentId = user.id;
  const { page, limit, skip } = clampPage(pagination);

  const where = { studentId };
  // NUL belgisi PostgreSQL'da xato (500) beradi — olib tashlanadi
  const search = String(query.search || "").replace(/\u0000/g, "").trim().slice(0, SEARCH_MAX);
  if (search) {
    where.OR = [
      { appName: { contains: search, mode: "insensitive" } },
      { appKey: { contains: search, mode: "insensitive" } },
    ];
  }
  if (query.blocked !== undefined && query.blocked !== "") {
    if (query.blocked !== "true" && query.blocked !== "false") {
      throw new BadRequestError("blocked true yoki false bo'lishi kerak");
    }
    where.blocked = query.blocked === "true";
  }

  const [total, rows] = await Promise.all([
    prisma.parentalApp.count({ where }),
    prisma.parentalApp.findMany({
      where,
      orderBy: [
        { installed: "desc" },
        { appName: { sort: "asc", nulls: "last" } },
        { firstSeenAt: "asc" },
      ],
      skip,
      take: limit,
    }),
  ]);

  const minutes = await todayMinutesByApp(
    studentId,
    rows.map((r) => r.appKeyHash),
  );

  return formatPaginationResponse(
    rows.map((row) => appDto(row, minutes.get(row.appKeyHash) || 0)),
    total,
    page,
    limit,
  );
}

/**
 * `PUT /parental/apps/:appId` [T] — `{ blocked?, dailyLimitMin? (null | 5..1440) }`.
 *
 * ⚠️ DOIM OCHIQ ilovani (raqam terish, SMS, favqulodda) bloklash va unga
 * limit qo'yish RAD ETILADI — `PARENTAL_ALWAYS_ALLOWED` izohiga qarang.
 * O'zgarish bo'lmasa versiya oshmaydi va push ketmaydi.
 */
async function updateApp(user, appId, body = {}) {
  const studentId = user.id;
  if (!isAppId(appId)) throw new BadRequestError("appId noto'g'ri");

  const hasBlocked = has(body, "blocked");
  const hasLimit = has(body, "dailyLimitMin");
  if (!hasBlocked && !hasLimit) {
    throw new BadRequestError("blocked yoki dailyLimitMin berilishi kerak");
  }
  const blocked = hasBlocked ? readBool(body.blocked, "blocked") : undefined;
  const dailyLimitMin = !hasLimit
    ? undefined
    : body.dailyLimitMin === null
      ? null
      : readInt(body.dailyLimitMin, "dailyLimitMin", DAILY_LIMIT);

  const app = await prisma.parentalApp.findUnique({
    where: { studentId_appKeyHash: { studentId, appKeyHash: appId } },
  });
  if (!app) throw new NotFoundError("Ilova topilmadi");

  if (policyService.isAlwaysAllowed(app.appKey) && (blocked === true || dailyLimitMin != null)) {
    throw new BadRequestError(
      "Bu ilovani cheklab bo'lmaydi — qo'ng'iroq va favqulodda xizmatlar doim ochiq",
    );
  }

  const changes = {};
  if (hasBlocked && blocked !== app.blocked) changes.blocked = blocked;
  if (hasLimit && dailyLimitMin !== app.dailyLimitMin) changes.dailyLimitMin = dailyLimitMin;

  const minutes = await todayMinutesByApp(studentId, [app.appKeyHash]);

  if (Object.keys(changes).length === 0) {
    const settings = await policyService.readSettings(studentId);
    return { ...appDto(app, minutes.get(app.appKeyHash) || 0), policyVersion: settings.policyVersion };
  }

  await policyService.ensureSettings(studentId);
  const [updated, policyVersion] = await prisma.$transaction(async (tx) => {
    const row = await tx.parentalApp.update({ where: { id: app.id }, data: changes });
    return [row, await policyService.bumpPolicy(studentId, tx)];
  });
  policyService.notifyPolicy(studentId, policyVersion);

  return { ...appDto(updated, minutes.get(app.appKeyHash) || 0), policyVersion };
}

/**
 * `PUT /parental/apps` [T] — `{ appIds: [], blocked }`, ko'pi bilan 500 ta.
 * Hammasi BITTA versiya oshishi va BITTA push bilan.
 *
 * @returns {Promise<{ updated: number, skipped: string[], notFound: string[], policyVersion: number }>}
 *   `skipped` — doim ochiq ilovalar (bloklanmadi)
 */
async function bulkUpdateApps(user, body = {}) {
  const studentId = user.id;
  const blocked = readBool(body.blocked, "blocked");

  if (!Array.isArray(body.appIds) || body.appIds.length === 0) {
    throw new BadRequestError("appIds bo'sh bo'lmagan ro'yxat bo'lishi kerak");
  }
  if (body.appIds.length > BULK_MAX) {
    throw new BadRequestError(`Bir so'rovda ko'pi bilan ${BULK_MAX} ta ilova`);
  }
  if (!body.appIds.every(isAppId)) throw new BadRequestError("appIds ichida noto'g'ri appId bor");

  const ids = [...new Set(body.appIds)];
  const apps = await prisma.parentalApp.findMany({
    where: { studentId, appKeyHash: { in: ids } },
    select: { appKeyHash: true, appKey: true, blocked: true },
  });

  const found = new Set(apps.map((a) => a.appKeyHash));
  const notFound = ids.filter((id) => !found.has(id));
  const skipped = blocked
    ? apps.filter((a) => policyService.isAlwaysAllowed(a.appKey)).map((a) => a.appKeyHash)
    : [];
  const targets = apps
    .filter((a) => a.blocked !== blocked && !skipped.includes(a.appKeyHash))
    .map((a) => a.appKeyHash);

  if (targets.length === 0) {
    const settings = await policyService.readSettings(studentId);
    return { updated: 0, skipped, notFound, policyVersion: settings.policyVersion };
  }

  await policyService.ensureSettings(studentId);
  const [updated, policyVersion] = await prisma.$transaction(async (tx) => {
    const { count } = await tx.parentalApp.updateMany({
      where: { studentId, appKeyHash: { in: targets }, blocked: !blocked },
      data: { blocked },
    });
    return [count, await policyService.bumpPolicy(studentId, tx)];
  });
  policyService.notifyPolicy(studentId, policyVersion);

  return { updated, skipped, notFound, policyVersion };
}

/* ───────────────────────── Hammasini bloklash / sozlama ───────────────────────── */

/**
 * `PUT /parental/lock-all` [T] — `{ enabled, until? }`.
 * `until` — ISO (mintaqa bilan), kelajakda, ko'pi bilan 7 kun; berilmasa — muddatsiz.
 */
async function setLockAll(user, body = {}) {
  const studentId = user.id;
  const enabled = readBool(body.enabled, "enabled");
  const now = Date.now();

  let until = null;
  if (enabled && body.until != null && body.until !== "") {
    if (typeof body.until !== "string" || !ISO_INSTANT.test(body.until)) {
      throw new BadRequestError("until ISO formatda (mintaqa bilan) bo'lishi kerak");
    }
    until = new Date(body.until);
    if (Number.isNaN(until.getTime())) throw new BadRequestError("until noto'g'ri sana");
    if (until.getTime() <= now) throw new BadRequestError("until kelajakda bo'lishi kerak");
    if (until.getTime() > now + LOCK_ALL_MAX_MS) {
      throw new BadRequestError("until ko'pi bilan 7 kun keyin bo'lishi mumkin");
    }
  }

  const settings = await policyService.currentSettings(studentId);
  const sameUntil = iso(settings.lockAllUntil) === iso(until);
  if (settings.lockAll === enabled && (!enabled || sameUntil)) {
    return lockState(settings);
  }

  await policyService.ensureSettings(studentId);
  const row = await prisma.parentalSettings.update({
    where: { studentId },
    data: {
      lockAll: enabled,
      lockAllUntil: enabled ? until : null,
      policyVersion: { increment: 1 },
    },
  });
  policyService.notifyPolicy(studentId, row.policyVersion);

  return lockState(row);
}

/** `PUT /parental/settings` [T] — `{ unlockMinutes (5..240) }`. */
async function updateSettings(user, body = {}) {
  const studentId = user.id;
  const unlockMinutes = readInt(body.unlockMinutes, "unlockMinutes", UNLOCK_MINUTES);

  const settings = await policyService.currentSettings(studentId);
  if (settings.unlockMinutes === unlockMinutes) return lockState(settings);

  await policyService.ensureSettings(studentId);
  const row = await prisma.parentalSettings.update({
    where: { studentId },
    data: { unlockMinutes, policyVersion: { increment: 1 } },
  });
  policyService.notifyPolicy(studentId, row.policyVersion);

  return lockState(row);
}

/* ───────────────────────────── Hodisalar ───────────────────────────── */

/** Qurilma modeli — `deviceId` → "Samsung A54". */
async function deviceModels(studentId, deviceIds) {
  const ids = [...new Set(deviceIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const devices = await prisma.parentalDevice.findMany({
    where: { studentId, deviceId: { in: ids } },
    select: { deviceId: true, model: true },
  });
  return new Map(devices.map((d) => [d.deviceId, d.model]));
}

/**
 * `GET /parental/events?page&limit&type` — sahifalangan, eng yangisi oldin
 * (qurilmadagi vaqt bo'yicha).
 */
async function listEvents(user, query = {}, pagination = {}) {
  const studentId = user.id;
  const { page, limit, skip } = clampPage(pagination);

  const where = { studentId };
  if (query.type) {
    if (!EVENT_TYPE_PATTERN.test(String(query.type))) throw new BadRequestError("type noto'g'ri");
    where.type = String(query.type);
  }

  const [total, rows] = await Promise.all([
    prisma.parentalEvent.count({ where }),
    prisma.parentalEvent.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      skip,
      take: limit,
    }),
  ]);

  const models = await deviceModels(studentId, rows.map((r) => r.deviceId));

  return formatPaginationResponse(
    rows.map((row) => ({
      id: row.id,
      type: row.type,
      typeLabel: PARENTAL_EVENT_LABELS[row.type] ?? row.type,
      deviceId: row.deviceId,
      deviceModel: row.deviceId ? models.get(row.deviceId) ?? null : null,
      occurredAt: iso(row.occurredAt),
      occurredAtLabel: formatDateTimeUz(row.occurredAt),
      payload: row.payload ?? {},
      alerted: row.alerted,
    })),
    total,
    page,
    limit,
  );
}

/* ───────────────────────────── Ruxsat so'rovlari ───────────────────────────── */

/**
 * Muddati o'tgan `pending` so'rovlarni yopadi — ro'yxat cron'ni kutmasdan
 * to'g'ri ko'rinsin. `studentId` berilmasa — filialning hammasi (cron).
 *
 * @param {string} [studentId]
 * @returns {Promise<number>}
 */
async function expirePendingRequests(studentId) {
  const { count } = await prisma.parentalUnlockRequest.updateMany({
    where: {
      ...(studentId ? { studentId } : {}),
      status: "pending",
      expiresAt: { lte: new Date() },
    },
    data: { status: "expired" },
  });
  return count;
}

/** So'rov → ota-ona ilovasidagi ko'rinish. */
function requestDto(row, app, deviceModel) {
  return {
    id: row.id,
    requestId: row.id,
    status: row.status,
    statusLabel: REQUEST_STATUS_LABELS[row.status] ?? row.status,
    appId: row.appKeyHash,
    appKey: app?.appKey ?? null,
    appName: app?.appName ?? null,
    iconUrl: app?.iconUrl ?? null,
    minutes: row.minutes,
    approvedMinutes: row.approvedMinutes,
    unlockUntil: iso(row.unlockUntil),
    unlockUntilLabel: row.unlockUntil ? formatDateTimeUz(row.unlockUntil) : null,
    deviceId: row.deviceId,
    deviceModel: deviceModel ?? null,
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt),
    createdAtLabel: formatDateTimeUz(row.createdAt),
    decidedAt: iso(row.decidedAt),
  };
}

async function appsByHash(studentId, hashes) {
  const list = [...new Set(hashes.filter(Boolean))];
  if (list.length === 0) return new Map();
  const apps = await prisma.parentalApp.findMany({
    where: { studentId, appKeyHash: { in: list } },
    select: { appKeyHash: true, appKey: true, appName: true, iconUrl: true },
  });
  return new Map(apps.map((a) => [a.appKeyHash, a]));
}

/** `GET /parental/unlock-requests?status=pending&page&limit` */
async function listUnlockRequests(user, query = {}, pagination = {}) {
  const studentId = user.id;
  const { page, limit, skip } = clampPage(pagination);

  const where = { studentId };
  if (query.status) {
    if (!REQUEST_STATUSES.includes(query.status)) {
      throw new BadRequestError(`status: ${REQUEST_STATUSES.join(" | ")}`);
    }
    where.status = query.status;
  }

  await expirePendingRequests(studentId);

  const [total, rows] = await Promise.all([
    prisma.parentalUnlockRequest.count({ where }),
    prisma.parentalUnlockRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
  ]);

  const [apps, models] = await Promise.all([
    appsByHash(studentId, rows.map((r) => r.appKeyHash)),
    deviceModels(studentId, rows.map((r) => r.deviceId)),
  ]);

  return formatPaginationResponse(
    rows.map((row) => requestDto(row, apps.get(row.appKeyHash), models.get(row.deviceId))),
    total,
    page,
    limit,
  );
}

/**
 * `POST /parental/unlock-requests/:id` [T] — `{ approve, minutes? (5..240) }`.
 *
 * ⚠️ COMPARE-AND-SWAP (`status: pending`, `expiresAt > now`): ota-onaning
 * ikki telefonidan bir vaqtda "ha" va "yo'q" bosilsa, faqat bittasi o'tadi.
 *
 * ⚠️ TASDIQ POLICY'GA HAM TUSHADI (versiya +1, `unlocks`): push yetib
 * bormasa ham qurilma ruxsatni keyingi sinxronizatsiyada oladi.
 */
async function decideUnlockRequest(user, id, body = {}) {
  const studentId = user.id;
  if (!isValidId(id)) throw new BadRequestError("So'rov id si noto'g'ri");

  const approve = readBool(body.approve, "approve");
  const overrideMinutes =
    approve && body.minutes != null ? readInt(body.minutes, "minutes", UNLOCK_MINUTES) : null;

  const request = await prisma.parentalUnlockRequest.findFirst({ where: { id, studentId } });
  if (!request) throw new NotFoundError("So'rov topilmadi");

  const now = new Date();
  if (request.status !== "pending") {
    throw new ConflictError("So'rov allaqachon ko'rib chiqilgan", {
      reason: "already_decided",
      status: request.status,
    });
  }
  if (request.expiresAt <= now) {
    await expirePendingRequests(studentId);
    throw new ConflictError("So'rov muddati o'tgan", { reason: "expired", status: "expired" });
  }

  const minutes = approve ? overrideMinutes ?? request.minutes : null;
  const unlockUntil = approve ? new Date(now.getTime() + minutes * 60 * 1000) : null;

  if (approve) await policyService.ensureSettings(studentId);

  const policyVersion = await prisma.$transaction(async (tx) => {
    const { count } = await tx.parentalUnlockRequest.updateMany({
      where: { id, studentId, status: "pending", expiresAt: { gt: now } },
      data: {
        status: approve ? "approved" : "denied",
        decidedAt: now,
        approvedMinutes: minutes,
        unlockUntil,
      },
    });
    if (count !== 1) {
      throw new ConflictError("So'rov holati o'zgardi, ro'yxatni yangilang", {
        reason: "already_decided",
      });
    }
    return approve ? policyService.bumpPolicy(studentId, tx) : null;
  });

  const apps = await appsByHash(studentId, [request.appKeyHash]);
  const app = apps.get(request.appKeyHash);

  const pushInput = {
    requestId: request.id,
    appId: request.appKeyHash,
    appKey: app?.appKey ?? null,
    appName: app?.appName ?? null,
    branchId: getBranch()?.id ?? null,
  };
  if (approve) {
    policyService.notifyPolicy(studentId, policyVersion);
    void pushService.sendToUsers(
      [studentId],
      parentalPush.unlockGranted({ ...pushInput, minutes, until: unlockUntil }),
    );
  } else {
    void pushService.sendToUsers([studentId], parentalPush.unlockDenied(pushInput));
  }

  const updated = await prisma.parentalUnlockRequest.findUnique({ where: { id } });
  const models = await deviceModels(studentId, [request.deviceId]);
  return {
    ...requestDto(updated, app, models.get(request.deviceId)),
    ...(policyVersion ? { policyVersion } : {}),
  };
}

module.exports = {
  ONLINE_WINDOW_MS,
  VERIFY_LEASE_MS,
  getStatus,
  setPin,
  verifyPin,
  resetPin,
  getUsage,
  listApps,
  updateApp,
  bulkUpdateApps,
  setLockAll,
  updateSettings,
  listEvents,
  expirePendingRequests,
  listUnlockRequests,
  decideUnlockRequest,
};
