/**
 * OTA-ONA NAZORATI — BOLANING TELEFONI (o'quvchi ilovasi) TOMONI.
 *
 * Ro'yxatdan o'tish, ruxsatlar holati (health), ilovalar ro'yxati,
 * kunlik statistika, policy sinxronizatsiyasi, hodisalar va "ruxsat bering"
 * so'rovi. Hammasi `X-Device-Id` bilan (`requireDeviceId`), parental
 * token TALAB QILINMAYDI — bu bolaning o'z telefoni.
 *
 * ⚠️ BLOKNI SERVER EMAS, QURILMA QO'LLAYDI. Server faqat qoidani beradi
 * (`parentalPolicy.service.js`) va qurilma aytganini qayd etadi. `protected`
 * ni server TAXMIN QILMAYDI: ruxsat olib tashlangani faqat qurilma
 * xabaridan ma'lum (`devices.md` §0 bilan bir xil halollik qoidasi).
 *
 * ⚠️ HAR QANDAY DEVICE SO'ROVI "TIRIKLIK" BELGISI: `lastSeenAt` yangilanadi
 * va `offlineAlertAt` tozalanadi (`touchDevice`) — keyingi jimlikda watchdog
 * yana bir marta ogohlantira oladi.
 *
 * ⚠️ OFLAYN NAVBATGA CHIDAMLI: statistika va hodisalar paketidagi BITTA
 * yaroqsiz qator butun paketni rad ettirmaydi (`skipped` bilan qaytadi).
 * Aks holda telefondagi navbat o'sha qatorda abadiy tiqilib qolardi.
 */

const crypto = require("crypto");
const sharp = require("sharp");

const prisma = require("../config/prisma");
const { getBranch } = require("../config/branchContext");
const { Prisma } = require("../generated/prisma");
const { generateId } = require("../utils/idGenerator");
const { PARENTAL_REQUIRED_HEALTH } = require("../utils/constants");
const logger = require("../utils/logger");
const {
  BadRequestError,
  ConflictError,
  NotFoundError,
  TooManyRequestsError,
} = require("../utils/errors");
const { isValidId } = require("../utils/objectId");
const { currentDayDate, parseDayDate } = require("../helpers/month.helpers");
const { appKeyHash } = require("../helpers/parentalPin.helpers");
const parentalPush = require("../helpers/parentalPush.helpers");
const fileStorage = require("./fileStorage.service");
const pushService = require("./push.service");
const policyService = require("./parentalPolicy.service");
const eventService = require("./parentalEvent.service");

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const PLATFORMS = ["android", "ios"];

/** Bitta so'rov chegaralari (TZ §6). */
const MAX_APPS_PER_REQUEST = 500;
const MAX_USAGE_ITEMS = 1000;
const MAX_EVENTS = 100;

/** Statistika shuncha kun orqagacha qabul qilinadi (oflayn navbat). */
const USAGE_BACKFILL_DAYS = 7;

/**
 * Ikonka: base64 PNG, dekodlangandan keyin ≤ 20 KB. Server uni QAYTA
 * KODLAYDI (sharp, ≤ 128 px): mijoz yuborgan faylni o'zgartirmasdan
 * ommaviy havolaga qo'yish — begona tarkibni tarqatish yo'li bo'lardi.
 */
const ICON_MAX_BYTES = 20 * 1024;
const ICON_SIZE_PX = 128;
const ICON_CONCURRENCY = 4;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Himoya chegaralari — soxta `X-Device-Id` / `appKey` bilan jadvalni
 * cheksiz to'ldirib bo'lmasin. Oddiy foydalanishda hech qachon yetilmaydi.
 */
const MAX_DEVICES_PER_STUDENT = 20;
const DEVICE_EVICT_AFTER_MS = 7 * DAY_MS;
const MAX_APPS_PER_STUDENT = 3000;

/** Hodisa `payload` i — kichik JSON (mazmun o'qilmaydi, faqat tafsilot). */
const PAYLOAD_MAX_BYTES = 2048;
const EVENT_PAST_MS = 30 * DAY_MS;
const EVENT_FUTURE_MS = 10 * MINUTE_MS;

/** Qurilma yubora oladigan hodisalar — qolganlarini faqat server yozadi. */
const DEVICE_EVENT_TYPES = new Set([
  "permission_revoked",
  "uninstall_attempt",
  "wrong_pin",
  "unlocked",
]);

/** Ruxsat so'rovi. */
const UNLOCK_REQUEST_MINUTES = [15, 30, 60];
const UNLOCK_REQUEST_TTL_MS = 15 * MINUTE_MS;
const UNLOCK_RATE_WINDOW_MS = 10 * MINUTE_MS;
const UNLOCK_RATE_MAX = 3;

/** Health kalitlari — qurilma yuboradi, yo'g'i `false`. */
const HEALTH_KEYS = [
  "usageAccess",
  "accessibility",
  "deviceAdmin",
  "overlay",
  "batteryOk",
  "familyControls",
];

/* ───────────────────────────── Yordamchilar ───────────────────────────── */

const deviceNotRegistered = () =>
  new ConflictError("Qurilma ro'yxatdan o'tmagan — avval /parental/device/register", {
    reason: "device_not_registered",
  });

function readPlatform(value) {
  if (!PLATFORMS.includes(value)) {
    throw new BadRequestError(`platform: ${PLATFORMS.join(" | ")}`);
  }
  return value;
}

/**
 * NUL belgisi (`\u0000`) — PostgreSQL uni matnda ham, JSONB da ham RAD
 * ETADI va so'rov 500 bilan yiqiladi. Qurilma matnlaridan olib tashlanadi:
 * aks holda oflayn navbat bitta shunday qatorda abadiy tiqilib qolardi.
 */
const stripNul = (text) => text.replace(/\u0000/g, "");

/** Ixtiyoriy matn — kesiladi, bo'sh bo'lsa `null`. */
const cleanText = (value, max) => {
  if (typeof value !== "string") return null;
  const text = stripNul(value).trim().slice(0, max);
  return text || null;
};

/** `appKey` — 1..2048 belgi (Android paket nomi yoki iOS tokeni). */
const readAppKey = (value) => {
  if (typeof value !== "string") return null;
  const key = stripNul(value).trim();
  return key.length > 0 && key.length <= 2048 ? key : null;
};

/** Hodisaning qurilma bergan identifikatori (ixtiyoriy) — `X-Device-Id` shakli, 1..64. */
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const dayKey = (date) => date.toISOString().slice(0, 10);

/** Cheklangan parallellik bilan `map` (ikonka yuklash tarmoqni to'ldirmasin). */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Qurilma "tirik" — `lastSeenAt` va `offlineAlertAt` bitta UPDATE bilan,
 * qatorning o'zi qaytadi.
 *
 * @returns {Promise<object>} - `ParentalDevice`
 * @throws {ConflictError} - `device_not_registered`
 */
async function touchDevice(studentId, deviceId) {
  const [device] = await prisma.parentalDevice.updateManyAndReturn({
    where: { studentId, deviceId },
    data: { lastSeenAt: new Date(), offlineAlertAt: null },
  });
  if (!device) throw deviceNotRegistered();
  return device;
}

/**
 * Yangi qurilma uchun joy: chegara to'lgan bo'lsa ENG ESKI va bir haftadan
 * beri jim qurilma o'chiriladi (ilova qayta o'rnatilganda eski identifikator
 * qoladi). Bo'shatadigani bo'lmasa — rad etiladi.
 */
async function makeRoomForDevice(studentId) {
  const count = await prisma.parentalDevice.count({ where: { studentId } });
  if (count < MAX_DEVICES_PER_STUDENT) return;

  const stalest = await prisma.parentalDevice.findFirst({
    where: { studentId, lastSeenAt: { lt: new Date(Date.now() - DEVICE_EVICT_AFTER_MS) } },
    orderBy: { lastSeenAt: "asc" },
    select: { id: true },
  });
  if (!stalest) {
    throw new ConflictError(
      `Bir hisobga ko'pi bilan ${MAX_DEVICES_PER_STUDENT} ta qurilma ulanadi`,
      { reason: "device_limit" },
    );
  }
  await prisma.parentalDevice.delete({ where: { id: stalest.id } });
}

/**
 * Noma'lum ilovalarni katalogga qo'shadi (statistika / so'rov / ro'yxat).
 *
 * ⚠️ `createMany({ skipDuplicates })` — parallel so'rovlar P2002 bilan
 * yiqilmaydi. `MAX_APPS_PER_STUDENT` dan oshganlari yaratilmaydi.
 *
 * @param {string} studentId
 * @param {"android"|"ios"} platform
 * @param {Array<{ hash: string, appKey: string, appName?: string|null }>} entries - hash bo'yicha yagona
 * @returns {Promise<Set<string>>} - katalogda BOR hash'lar (avvaldan yoki yangi)
 */
async function ensureAppsExist(studentId, platform, entries) {
  if (entries.length === 0) return new Set();

  const existing = await prisma.parentalApp.findMany({
    where: { studentId, appKeyHash: { in: entries.map((e) => e.hash) } },
    select: { appKeyHash: true, appName: true },
  });
  const known = new Map(existing.map((a) => [a.appKeyHash, a]));
  const available = new Set(known.keys());

  const missing = entries.filter((e) => !known.has(e.hash));
  if (missing.length > 0) {
    const total = await prisma.parentalApp.count({ where: { studentId } });
    const room = Math.max(0, MAX_APPS_PER_STUDENT - total);
    const toCreate = missing.slice(0, room);

    if (toCreate.length > 0) {
      await prisma.parentalApp.createMany({
        data: toCreate.map((e) => ({
          studentId,
          platform,
          appKey: e.appKey,
          appKeyHash: e.hash,
          appName: e.appName ?? null,
        })),
        skipDuplicates: true,
      });
      toCreate.forEach((e) => available.add(e.hash));
    }
  }

  // Nomi hali yo'q ilovaga qurilma aytgan nom
  const named = entries.filter((e) => e.appName && known.has(e.hash) && !known.get(e.hash).appName);
  for (const entry of named) {
    await prisma.parentalApp.updateMany({
      where: { studentId, appKeyHash: entry.hash, appName: null },
      data: { appName: entry.appName },
    });
  }

  return available;
}

/**
 * Ikonkani tekshiradi va qayta kodlaydi. Yaroqsiz bo'lsa `null` (ilova
 * baribir yoziladi — ikonka ixtiyoriy).
 *
 * @param {unknown} icon - base64 PNG (`data:image/png;base64,` prefiksi bilan ham)
 * @returns {Promise<Buffer|null>}
 */
async function normalizeIcon(icon) {
  if (typeof icon !== "string" || icon.length === 0) return null;

  const raw = icon.replace(/^data:image\/png;base64,/i, "").replace(/\s+/g, "");
  if (raw.length > Math.ceil((ICON_MAX_BYTES * 4) / 3) + 4) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;

  const buffer = Buffer.from(raw, "base64");
  if (buffer.length === 0 || buffer.length > ICON_MAX_BYTES) return null;
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;

  try {
    return await sharp(buffer, { limitInputPixels: 1024 * 1024 })
      .resize(ICON_SIZE_PX, ICON_SIZE_PX, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

/**
 * Ikonkani Spaces'ga yuklaydi. Xato — `null` (ilova ikonkasiz qoladi,
 * keyingi sinxronizatsiyada qayta uriniladi).
 *
 * ⚠️ Kalit O'QUVCHI BO'YICHA (umumiy emas): boshqa bolaning yuborgan
 * rasmi shu ilovaning ikonkasi bo'lib hammaning ota-onasiga ko'rinmasin.
 * Kalitda tarkib hash'i ham bor — `immutable` kesh eski rasmni ushlab qolmaydi.
 */
async function uploadIcon(studentId, hash, buffer) {
  try {
    const digest = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 12);
    const { url } = await fileStorage.uploadBuffer({
      key: `parental-icons/${studentId}/${hash.slice(0, 32)}-${digest}.png`,
      buffer,
      contentType: "image/png",
    });
    return url && url.length <= 500 ? url : null;
  } catch (error) {
    logger.warn(`[parental] ikonka yuklanmadi: ${error.message}`);
    return null;
  }
}

/* ───────────────────────────── Ro'yxatdan o'tish ───────────────────────────── */

/**
 * `POST /parental/device/register` — `{ platform, model, osVersion, appVersion }`.
 * `(studentId, deviceId)` bo'yicha upsert, sozlama qatori yaratiladi,
 * javob — to'liq policy.
 */
async function register(user, deviceId, body = {}) {
  const studentId = user.id;
  const platform = readPlatform(body.platform);
  const data = {
    platform,
    model: cleanText(body.model, 120),
    osVersion: cleanText(body.osVersion, 40),
    appVersion: cleanText(body.appVersion, 40),
  };
  const now = new Date();
  const where = { studentId_deviceId: { studentId, deviceId } };

  const existing = await prisma.parentalDevice.findUnique({ where, select: { id: true } });
  if (!existing) await makeRoomForDevice(studentId);

  try {
    await prisma.parentalDevice.upsert({
      where,
      create: { studentId, deviceId, ...data, lastSeenAt: now },
      update: { ...data, lastSeenAt: now, offlineAlertAt: null },
    });
  } catch (error) {
    // Parallel ikki ro'yxatdan o'tish — ikkinchisi shunchaki yangilaydi
    if (error?.code !== "P2002") throw error;
    await prisma.parentalDevice.update({
      where,
      data: { ...data, lastSeenAt: now, offlineAlertAt: null },
    });
  }

  await policyService.ensureSettings(studentId);
  return policyService.buildPolicy(studentId, { platform });
}

/* ───────────────────────────── Health ───────────────────────────── */

/**
 * `PUT /parental/device/health` — ruxsatlar holati.
 *
 * `protected` `PARENTAL_REQUIRED_HEALTH` bo'yicha qayta hisoblanadi.
 *   true  → false : `permission_revoked` + ota-onaga push (cheklash bilan)
 *   false → true  : `protection_restored` — faqat oldin haqiqatan o'chirilgan
 *                   bo'lsa (birinchi sozlash "tiklandi" deb yozilmaydi)
 *
 * ⚠️ COMPARE-AND-SWAP (`protected` eski qiymati): ikki parallel xabar bitta
 * o'tishni ikki marta qayd etmaydi.
 */
async function reportHealth(user, deviceId, body = {}) {
  const studentId = user.id;

  const flags = {};
  for (const key of HEALTH_KEYS) {
    const value = body?.[key];
    if (value === undefined || value === null) flags[key] = false;
    else if (typeof value !== "boolean") {
      throw new BadRequestError(`${key} true yoki false bo'lishi kerak`);
    } else flags[key] = value;
  }

  let device = await touchDevice(studentId, deviceId);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const required = PARENTAL_REQUIRED_HEALTH[device.platform] || [];
    const isProtected = required.length > 0 && required.every((key) => flags[key] === true);
    const missing = required.filter((key) => flags[key] !== true);
    const wasReported = Boolean(device.health?.reportedAt);
    const health = { ...flags, reportedAt: new Date().toISOString() };

    const { count } = await prisma.parentalDevice.updateMany({
      where: { id: device.id, protected: device.protected },
      data: { health, protected: isProtected },
    });

    if (count === 1) {
      if (wasReported && device.protected && !isProtected) {
        // ⚠️ Xavfsiz yozuv: o'tish (`protected`) allaqachon saqlangan —
        // 500 qaytsa, qayta yuborilgan xabar o'tishni endi ko'rmasdi va
        // ogohlantirish butunlay yo'qolardi.
        await eventService.recordEventSafe({
          studentId,
          deviceId,
          type: "permission_revoked",
          payload: { source: "health", missing },
          studentName: user.firstName ?? null,
        });
      } else if (wasReported && !device.protected && isProtected) {
        const lastPair = await prisma.parentalEvent.findFirst({
          where: {
            studentId,
            deviceId,
            type: { in: ["permission_revoked", "protection_restored"] },
          },
          orderBy: { createdAt: "desc" },
          select: { type: true },
        });
        if (lastPair?.type === "permission_revoked") {
          await eventService.recordEventSafe({
            studentId,
            deviceId,
            type: "protection_restored",
            payload: { source: "health" },
            studentName: user.firstName ?? null,
          });
        }
      }

      return { protected: isProtected, missing, health };
    }

    // Parallel xabar holatni o'zgartirgan — yangisini o'qib qayta hisoblaymiz
    device = await prisma.parentalDevice.findUnique({ where: { id: device.id } });
    if (!device) throw deviceNotRegistered();
  }

  throw new ConflictError("Qurilma holati o'zgardi, qayta yuboring");
}

/* ───────────────────────────── Ilovalar ───────────────────────────── */

/**
 * `POST /parental/device/apps` — `{ platform, apps: [{ appKey, appName, icon? }], full }`.
 *
 * ⚠️ IKONKA FAQAT KERAK BO'LGANDA yuklanadi: yangi ilova yoki ikonkasi hali
 * yo'q ilova. Mavjud ikonka ustidan yozilmaydi.
 *
 * ⚠️ `full = true` — ro'yxatda yo'qlar `installed = false`. Lekin o'quvchida
 * AYNI platformadagi BOSHQA faol qurilma bo'lsa qo'llanmaydi
 * (`fullApplied: false`): katalog o'quvchi bo'yicha, ya'ni ikkinchi telefondagi
 * ilova "o'chirildi" bo'lib qolardi.
 */
async function syncApps(user, deviceId, body = {}) {
  const studentId = user.id;
  const device = await touchDevice(studentId, deviceId);

  const platform = readPlatform(body.platform);
  if (platform !== device.platform) {
    throw new BadRequestError("platform ro'yxatdan o'tgan qurilma platformasiga mos emas");
  }
  if (!Array.isArray(body.apps)) throw new BadRequestError("apps ro'yxat bo'lishi kerak");
  if (body.apps.length > MAX_APPS_PER_REQUEST) {
    throw new BadRequestError(`Bir so'rovda ko'pi bilan ${MAX_APPS_PER_REQUEST} ta ilova`);
  }
  const full = body.full === undefined ? false : body.full;
  if (typeof full !== "boolean") throw new BadRequestError("full true yoki false bo'lishi kerak");

  // Hash bo'yicha yagona — takror bo'lsa oxirgisi
  const items = new Map();
  body.apps.forEach((item, index) => {
    const appKey = readAppKey(item?.appKey);
    if (!appKey) throw new BadRequestError(`apps[${index}].appKey noto'g'ri`);
    items.set(appKeyHash(appKey), {
      hash: appKeyHash(appKey),
      appKey,
      appName: cleanText(item.appName, 200),
      icon: item.icon,
    });
  });
  const list = [...items.values()];
  const hashes = list.map((item) => item.hash);

  const existing = hashes.length
    ? await prisma.parentalApp.findMany({
        where: { studentId, appKeyHash: { in: hashes } },
        select: { id: true, appKeyHash: true, appName: true, iconUrl: true, installed: true },
      })
    : [];
  const byHash = new Map(existing.map((a) => [a.appKeyHash, a]));

  // Yangi ilovalar — chegara ichida
  let fresh = list.filter((item) => !byHash.has(item.hash));
  let skippedByLimit = 0;
  if (fresh.length > 0) {
    const total = await prisma.parentalApp.count({ where: { studentId } });
    const room = Math.max(0, MAX_APPS_PER_STUDENT - total);
    skippedByLimit = Math.max(0, fresh.length - room);
    fresh = fresh.slice(0, room);
  }

  // Ikonkalar: yangi ilova yoki ikonkasi yo'q ilova
  const needIcon = [
    ...fresh,
    ...list.filter((item) => byHash.has(item.hash) && !byHash.get(item.hash).iconUrl),
  ].filter((item) => item.icon !== undefined && item.icon !== null && item.icon !== "");

  let iconsUploaded = 0;
  let iconsRejected = 0;
  const iconUrls = new Map();
  await mapLimit(needIcon, ICON_CONCURRENCY, async (item) => {
    const buffer = await normalizeIcon(item.icon);
    if (!buffer) {
      iconsRejected += 1;
      return;
    }
    const url = await uploadIcon(studentId, item.hash, buffer);
    if (url) {
      iconUrls.set(item.hash, url);
      iconsUploaded += 1;
    }
  });

  let created = 0;
  if (fresh.length > 0) {
    ({ count: created } = await prisma.parentalApp.createMany({
      data: fresh.map((item) => ({
        studentId,
        platform,
        appKey: item.appKey,
        appKeyHash: item.hash,
        appName: item.appName,
        iconUrl: iconUrls.get(item.hash) ?? null,
        installed: true,
      })),
      skipDuplicates: true,
    }));
  }

  let updated = 0;
  for (const item of list) {
    const app = byHash.get(item.hash);
    if (!app) continue;

    const data = {};
    if (item.appName && item.appName !== app.appName) data.appName = item.appName;
    if (!app.installed) data.installed = true;
    if (!app.iconUrl && iconUrls.has(item.hash)) data.iconUrl = iconUrls.get(item.hash);
    if (Object.keys(data).length === 0) continue;

    await prisma.parentalApp.update({ where: { id: app.id }, data });
    updated += 1;
  }

  let uninstalled = 0;
  let fullApplied = false;
  if (full) {
    const siblings = await prisma.parentalDevice.count({
      where: {
        studentId,
        platform,
        id: { not: device.id },
        lastSeenAt: { gte: new Date(Date.now() - DEVICE_EVICT_AFTER_MS) },
      },
    });

    if (siblings === 0) {
      ({ count: uninstalled } = await prisma.parentalApp.updateMany({
        where: {
          studentId,
          platform,
          installed: true,
          ...(hashes.length ? { appKeyHash: { notIn: hashes } } : {}),
        },
        data: { installed: false },
      }));
      fullApplied = true;
    }
  }

  return {
    received: list.length,
    created,
    updated,
    uninstalled,
    fullApplied,
    iconsUploaded,
    iconsRejected,
    skippedByLimit,
  };
}

/* ───────────────────────────── Statistika ───────────────────────────── */

/**
 * `POST /parental/device/usage` — `{ items: [{ date, appKey, appName?, minutes, openCount, minMinutes? }] }`.
 *
 * ⚠️ IDEMPOTENT — `(studentId, deviceId, date, appKeyHash)` bo'yicha USTIGA
 * YOZILADI: bir xil paketni ikki marta yuborish natijani ikki baravar
 * oshirmaydi. Bitta `INSERT … ON CONFLICT DO UPDATE` (500 qatordan) —
 * 1000 ta alohida upsert tranzaksiya muddatiga sig'masdi.
 *
 * ⚠️ `date` — Toshkent kuni, oxirgi 7 kun ichida; `minutes` 0..1440.
 * Yaroqsiz qator o'tkazib yuboriladi (`skipped`), paket rad etilmaydi.
 */
async function reportUsage(user, deviceId, body = {}) {
  const studentId = user.id;
  const device = await touchDevice(studentId, deviceId);

  if (!Array.isArray(body.items)) throw new BadRequestError("items ro'yxat bo'lishi kerak");
  if (body.items.length > MAX_USAGE_ITEMS) {
    throw new BadRequestError(`Bir so'rovda ko'pi bilan ${MAX_USAGE_ITEMS} ta qator`);
  }

  const today = currentDayDate();
  const oldest = new Date(today.getTime() - USAGE_BACKFILL_DAYS * DAY_MS);
  const skipped = [];
  const rows = new Map();

  body.items.forEach((item, index) => {
    const skip = (reason) => skipped.push({ index, reason });
    if (!item || typeof item !== "object") return skip("invalid");

    const appKey = readAppKey(item.appKey);
    if (!appKey) return skip("appKey");

    let date;
    try {
      date = parseDayDate(item.date, "date");
    } catch {
      return skip("date");
    }
    if (date < oldest || date > today) return skip("date_range");

    if (!Number.isInteger(item.minutes) || item.minutes < 0 || item.minutes > 1440) {
      return skip("minutes");
    }
    const openCount = item.openCount === undefined || item.openCount === null ? 0 : item.openCount;
    if (!Number.isInteger(openCount) || openCount < 0 || openCount > 100000) {
      return skip("openCount");
    }
    const minMinutes =
      item.minMinutes === undefined || item.minMinutes === null ? false : item.minMinutes;
    if (typeof minMinutes !== "boolean") return skip("minMinutes");

    const hash = appKeyHash(appKey);
    // Bitta paket ichida takror — oxirgisi (paket o'zi ham "ustiga yozish")
    rows.set(`${dayKey(date)}|${hash}`, {
      date: dayKey(date),
      hash,
      appKey,
      appName: cleanText(item.appName, 200),
      minutes: item.minutes,
      openCount,
      minMinutes,
      index,
    });
  });

  // Noma'lum ilova katalogga avtomatik qo'shiladi
  const apps = new Map();
  for (const row of rows.values()) {
    const prev = apps.get(row.hash);
    if (!prev || (!prev.appName && row.appName)) {
      apps.set(row.hash, { hash: row.hash, appKey: row.appKey, appName: row.appName });
    }
  }
  const available = await ensureAppsExist(studentId, device.platform, [...apps.values()]);

  const accepted = [];
  for (const row of rows.values()) {
    if (available.has(row.hash)) accepted.push(row);
    else skipped.push({ index: row.index, reason: "app_limit" });
  }

  for (let i = 0; i < accepted.length; i += 500) {
    const chunk = accepted.slice(i, i + 500);
    // ⚠️ Sana MATN sifatida (`::date`): JS `Date` parametri seans
    // mintaqasiga qarab bir kunga siljishi mumkin edi. `updated_at` — UTC
    // (Prisma `DateTime` ustunlari bilan bir xil konvensiya).
    const values = chunk.map(
      (row) => Prisma.sql`(
        ${generateId()}, ${studentId}, ${deviceId}, ${row.date}::date, ${row.hash},
        ${row.minutes}, ${row.minMinutes}, ${row.openCount}, (NOW() AT TIME ZONE 'UTC')
      )`,
    );
    await prisma.$executeRaw`
      INSERT INTO app_usage_daily
        (id, student_id, device_id, date, app_key_hash, minutes, min_minutes, open_count, updated_at)
      VALUES ${Prisma.join(values)}
      ON CONFLICT (student_id, device_id, date, app_key_hash) DO UPDATE SET
        minutes     = EXCLUDED.minutes,
        min_minutes = EXCLUDED.min_minutes,
        open_count  = EXCLUDED.open_count,
        updated_at  = EXCLUDED.updated_at
    `;
  }

  skipped.sort((a, b) => a.index - b.index);
  return {
    accepted: accepted.length,
    skippedCount: skipped.length,
    // Ro'yxat qisqartiriladi — javob 1000 qatorlik bo'lib ketmasin
    skipped: skipped.slice(0, 50),
  };
}

/* ───────────────────────────── Policy ───────────────────────────── */

/**
 * `GET /parental/device/policy?version=N` — versiya teng bo'lsa
 * `{ changed: false }` (+ `policyVersion`, `serverTime`), aks holda to'liq policy.
 */
async function getPolicy(user, deviceId, query = {}) {
  const studentId = user.id;
  const device = await touchDevice(studentId, deviceId);
  const settings = await policyService.currentSettings(studentId);

  if (query.version !== undefined && query.version !== "") {
    const version = Number(query.version);
    if (!Number.isInteger(version) || version < 0) {
      throw new BadRequestError("version butun son bo'lishi kerak");
    }
    if (version === settings.policyVersion) {
      return {
        changed: false,
        policyVersion: settings.policyVersion,
        serverTime: new Date().toISOString(),
      };
    }
  }

  return policyService.buildPolicy(studentId, { platform: device.platform, settings });
}

/* ───────────────────────────── Hodisalar ───────────────────────────── */

/** Qiymatdan (kalitlar ham) NUL belgilarini olib tashlaydi, chuqurlik cheklangan. */
function stripNulDeep(value, depth = 0) {
  if (typeof value === "string") return stripNul(value);
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => stripNulDeep(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [stripNul(key), stripNulDeep(item, depth + 1)]),
  );
}

/** Payload — faqat oddiy obyekt va kichik; aks holda `{}` / belgi. */
function normalizePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  try {
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json, "utf8") > PAYLOAD_MAX_BYTES) return { truncated: true };
    return stripNulDeep(JSON.parse(json));
  } catch {
    return {};
  }
}

/**
 * `POST /parental/device/events` — `{ events: [{ eventId?, type, payload, occurredAt }] }`, ≤ 100.
 *
 * `occurredAt` — qurilmadagi vaqt (oflayn navbat keyin keladi). Aql
 * bovar qilmaydigan vaqt (30 kundan eski yoki kelajakda — soat surilgan)
 * server vaqti bilan almashtiriladi, asli `payload.deviceTime` da qoladi.
 *
 * ⚠️ IDEMPOTENT (`eventId` bilan): paket qayta yuborilsa (javob yo'lda
 * yo'qolgan) allaqachon yozilgan hodisa `duplicate` bo'lib o'tkaziladi —
 * tarixda ikki marta chiqmaydi va push qayta ketmaydi. `eventId` siz
 * hodisa har safar yangi qator.
 *
 * ⚠️ HAR HODISA MUSTAQIL: bittasining xatosi (`skipped`, `error`)
 * qolganlarini to'xtatmaydi va paketni rad ettirmaydi.
 */
async function reportEvents(user, deviceId, body = {}) {
  const studentId = user.id;
  await touchDevice(studentId, deviceId);

  if (!Array.isArray(body.events)) throw new BadRequestError("events ro'yxat bo'lishi kerak");
  if (body.events.length > MAX_EVENTS) {
    throw new BadRequestError(`Bir so'rovda ko'pi bilan ${MAX_EVENTS} ta hodisa`);
  }

  const skipped = [];
  let accepted = 0;
  let alerted = 0;
  let duplicates = 0;

  for (let index = 0; index < body.events.length; index += 1) {
    const item = body.events[index];
    if (!item || typeof item !== "object" || !DEVICE_EVENT_TYPES.has(item.type)) {
      skipped.push({ index, reason: "type" });
      continue;
    }

    let clientEventId = null;
    if (item.eventId !== undefined && item.eventId !== null && item.eventId !== "") {
      if (typeof item.eventId !== "string" || !EVENT_ID_PATTERN.test(item.eventId)) {
        skipped.push({ index, reason: "eventId" });
        continue;
      }
      clientEventId = item.eventId;
    }

    const payload = normalizePayload(item.payload);
    let occurredAt = new Date();
    if (item.occurredAt !== undefined && item.occurredAt !== null) {
      const parsed = typeof item.occurredAt === "string" ? new Date(item.occurredAt) : null;
      if (!parsed || Number.isNaN(parsed.getTime())) {
        skipped.push({ index, reason: "occurredAt" });
        continue;
      }
      const now = Date.now();
      if (parsed.getTime() < now - EVENT_PAST_MS || parsed.getTime() > now + EVENT_FUTURE_MS) {
        payload.deviceTime = item.occurredAt;
      } else {
        occurredAt = parsed;
      }
    }

    try {
      // Takror — yozilmaydi (poyga bo'lsa yagonalik indeksi ushlaydi, pastda)
      if (clientEventId) {
        const exists = await prisma.parentalEvent.findUnique({
          where: { studentId_clientEventId: { studentId, clientEventId } },
          select: { id: true },
        });
        if (exists) {
          duplicates += 1;
          continue;
        }
      }

      const row = await eventService.recordEvent({
        studentId,
        deviceId,
        type: item.type,
        payload,
        occurredAt,
        clientEventId,
        studentName: user.firstName ?? null,
      });
      accepted += 1;
      if (row.alerted) alerted += 1;
    } catch (error) {
      if (error?.code === "P2002") {
        duplicates += 1;
        continue;
      }
      logger.warn(`[parental] qurilma hodisasi yozilmadi (${item.type}): ${error.message}`);
      skipped.push({ index, reason: "error" });
    }
  }

  return { accepted, alerted, duplicates, skipped };
}

/* ───────────────────────────── Ruxsat so'rovi ───────────────────────────── */

/**
 * `POST /parental/device/unlock-request` — `{ appKey?, appName?, minutes (15|30|60) }`.
 *
 * Bir vaqtda bitta `pending` (eskisi `expired`), 15 daqiqa amal qiladi,
 * 10 daqiqada ko'pi bilan 3 ta. Ota-onaga `parental_request` push.
 *
 * ⚠️ Cheklash va "eskisini yopish" o'quvchi bo'yicha advisory lock ostida:
 * parallel ikki so'rov ikkalasi ham `pending` bo'lib qolmasin.
 */
async function requestUnlock(user, deviceId, body = {}) {
  const studentId = user.id;
  const device = await touchDevice(studentId, deviceId);

  if (!UNLOCK_REQUEST_MINUTES.includes(body.minutes)) {
    throw new BadRequestError(`minutes: ${UNLOCK_REQUEST_MINUTES.join(" | ")}`);
  }
  const minutes = body.minutes;

  let hash = null;
  let appKey = null;
  let appName = cleanText(body.appName, 200);
  if (body.appKey !== undefined && body.appKey !== null && body.appKey !== "") {
    appKey = readAppKey(body.appKey);
    if (!appKey) throw new BadRequestError("appKey noto'g'ri");
    hash = appKeyHash(appKey);

    const available = await ensureAppsExist(studentId, device.platform, [
      { hash, appKey, appName },
    ]);
    if (!available.has(hash)) {
      throw new BadRequestError("Ilovalar soni chegarasiga yetildi");
    }
    const app = await prisma.parentalApp.findUnique({
      where: { studentId_appKeyHash: { studentId, appKeyHash: hash } },
      select: { appName: true },
    });
    appName = app?.appName ?? appName;
  }

  const now = new Date();
  const request = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`parental_unlock:${studentId}`}))`;

    const recent = await tx.parentalUnlockRequest.findMany({
      where: { studentId, createdAt: { gte: new Date(now.getTime() - UNLOCK_RATE_WINDOW_MS) } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    if (recent.length >= UNLOCK_RATE_MAX) {
      const retryAfterSec = Math.max(
        1,
        Math.ceil(
          (new Date(recent[0].createdAt).getTime() + UNLOCK_RATE_WINDOW_MS - now.getTime()) /
            1000,
        ),
      );
      const error = new TooManyRequestsError(
        "So'rovlar juda ko'p — birozdan keyin qayta urinib ko'ring",
      );
      error.details = { reason: "unlock_rate_limited", retryAfterSec };
      throw error;
    }

    await tx.parentalUnlockRequest.updateMany({
      where: { studentId, status: "pending" },
      data: { status: "expired" },
    });

    return tx.parentalUnlockRequest.create({
      data: {
        studentId,
        deviceId,
        appKeyHash: hash,
        minutes,
        status: "pending",
        expiresAt: new Date(now.getTime() + UNLOCK_REQUEST_TTL_MS),
      },
    });
  });

  await eventService.recordEventSafe({
    studentId,
    deviceId,
    type: "unlock_request",
    payload: { requestId: request.id, minutes, ...(appKey ? { appKey } : {}) },
    alert: false,
  });

  void pushService.sendToUsers(
    [studentId],
    parentalPush.unlockRequested({
      requestId: request.id,
      appId: hash,
      appKey,
      appName,
      minutes,
      name: user.firstName ?? null,
      branchId: getBranch()?.id ?? null,
    }),
  );

  return {
    requestId: request.id,
    status: request.status,
    appId: hash,
    minutes,
    expiresAt: request.expiresAt.toISOString(),
  };
}

/**
 * `GET /parental/device/unlock-request/:id` — so'rov holati.
 *
 * Push (`parental_unlock` / `parental_unlock_denied`) tezlatgich: yetib
 * bormasa ham bola ekrani javobni shu yo'l bilan oladi. Faqat O'Z so'rovi.
 */
async function getUnlockRequest(user, deviceId, id) {
  const studentId = user.id;
  if (!isValidId(id)) throw new BadRequestError("So'rov id si noto'g'ri");
  await touchDevice(studentId, deviceId);

  // Muddati o'tgan `pending` — shu yerda yopiladi (cron'ni kutmasdan)
  await prisma.parentalUnlockRequest.updateMany({
    where: { id, studentId, status: "pending", expiresAt: { lte: new Date() } },
    data: { status: "expired" },
  });

  const request = await prisma.parentalUnlockRequest.findFirst({ where: { id, studentId } });
  if (!request) throw new NotFoundError("So'rov topilmadi");

  return {
    requestId: request.id,
    status: request.status,
    appId: request.appKeyHash,
    minutes: request.minutes,
    approvedMinutes: request.approvedMinutes,
    unlockUntil: request.unlockUntil ? request.unlockUntil.toISOString() : null,
    expiresAt: request.expiresAt.toISOString(),
    decidedAt: request.decidedAt ? request.decidedAt.toISOString() : null,
    serverTime: new Date().toISOString(),
  };
}

module.exports = {
  PLATFORMS,
  register,
  reportHealth,
  syncApps,
  reportUsage,
  getPolicy,
  reportEvents,
  requestUnlock,
  getUnlockRequest,
  // test uchun
  _normalizeIcon: normalizeIcon,
  _normalizePayload: normalizePayload,
};
