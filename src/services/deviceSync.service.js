/**
 * QURILMA BILAN ALOQA — profil, heartbeat va kunlik hisobot.
 *
 * Bu yerdagi HAMMA yo'lni O'QUVCHINING O'ZI chaqiradi (telefonidagi
 * ilova uning hisobi bilan kirgan).
 *
 * ⚠️ `studentId` HAR DOIM TOKENDAN — so'rov tanasidan EMAS
 * (`/grade-analysis/my` bilan bir xil qoida). Aks holda bitta o'quvchi
 * boshqasining profilini so'rab, uning qoidalarini va ekran vaqtini
 * ko'rib olardi.
 *
 * ⚠️ QURILMA KUN YAKUNINI TO'LIQ YUBORADI (`reportUsage`), qo'shimcha
 * emas: server o'sha kunning qatorlarini ALMASHTIRADI. Shu sababli
 * takroriy yuborish xavfsiz — tarmoq uzilganda ilova qayta urinadi va
 * qo'sh hisob paydo bo'lmaydi.
 *
 * ⚠️ SERVER HISOBI — MASLAHAT. Qurilma o'z hisobini yuritadi va
 * ikkalasidan KICHIGINI oladi: aks holda internetni o'chirib qo'yish
 * cheklovni nolga tushirardi.
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError, ForbiddenError } = require("../utils/errors");
const logger = require("../utils/logger");
const { ROLES } = require("../utils/constants");
const { hasRole } = require("../utils/permissions");
const {
  buildDeviceProfile,
  tashkentDayDate,
  MINUTES_PER_DAY,
} = require("../helpers/devicePolicy.helpers");
const { getDeviceSettings } = require("./settings.service");
const devicePolicyService = require("./devicePolicy.service");
const deviceAppService = require("./deviceApp.service");

/** Bir so'rovda qabul qilinadigan ilova qatorlari. */
const MAX_USAGE_ENTRIES = 300;

/** Hisobot ko'pi bilan shuncha kun orqaga yuborilishi mumkin. */
const MAX_BACKFILL_DAYS = 7;

/**
 * Qurilmani `deviceUid` bo'yicha topadi va EGASINI tekshiradi.
 *
 * ⚠️ Egalik tekshiruvi MAJBURIY: `deviceUid` sir emas (u telefonda
 * turadi), shuning uchun uni bilgan boshqa o'quvchi begona qurilmaning
 * hisobotini yozib, chekovni chalg'itishi mumkin edi.
 */
async function requireOwnDevice(user, deviceUid) {
  const uid = String(deviceUid || "").trim();
  if (!uid) throw new BadRequestError("deviceUid majburiy");

  const device = await prisma.studentDevice.findUnique({ where: { deviceUid: uid } });
  if (!device) throw new NotFoundError("Qurilma biriktirilmagan");
  if (device.studentId !== user.id) throw new ForbiddenError("Bu qurilma sizga tegishli emas");

  return device;
}

/** Faqat o'quvchi — xodimning telefoni bu modulga kirmaydi. */
function requireStudent(user) {
  if (!hasRole(user, ROLES.STUDENT)) {
    throw new ForbiddenError("Bu bo'lim faqat o'quvchilar uchun");
  }
}

/**
 * O'quvchining BUGUNGI foydalanishi — barcha qurilmalari bo'yicha yig'ma.
 *
 * ⚠️ QURILMALAR BO'YICHA YIG'ILADI: "YouTube uchun 1 soat" bir kunda
 * bitta soat degani, telefon uchun bir soat + planshet uchun yana bir
 * soat degani emas. Aks holda chekovni ikkinchi qurilma bilan ikki
 * barobarga oshirib bo'lardi.
 */
async function todayUsageMap(studentId, now = new Date()) {
  const rows = await prisma.deviceUsageDay.findMany({
    where: { studentId, day: tashkentDayDate(now) },
    select: { appKey: true, minutes: true },
  });

  const map = new Map();
  for (const row of rows) {
    const prev = map.get(row.appKey)?.minutes || 0;
    map.set(row.appKey, { minutes: prev + (row.minutes || 0) });
  }
  return map;
}

/**
 * O'quvchining amaldagi ochishlari.
 * ⚠️ `endsAt` bo'yicha ham filtrlanadi — supurgi kechikkan bo'lsa ham
 * muddati o'tgan ochish qo'llanmaydi.
 */
function loadUnlocks(studentId, now = new Date()) {
  return prisma.deviceUnlock.findMany({
    where: { studentId, status: "active", endsAt: { gt: now } },
    select: {
      id: true,
      kind: true,
      appId: true,
      extraMinutes: true,
      deviceId: true,
      startsAt: true,
      endsAt: true,
      reason: true,
      status: true,
    },
  });
}

/**
 * PROFIL — qurilmaga yuboriladigan yagona haqiqat.
 *
 * @param {object} student - `{ id }`
 * @param {{ platform?: string, deviceId?: string|null }} options
 */
async function buildProfileFor(student, { platform = "android", deviceId = null } = {}) {
  const now = new Date();

  const [settings, resolved, usageByKey, unlocks] = await Promise.all([
    getDeviceSettings(),
    devicePolicyService.resolveForStudent(student.id),
    todayUsageMap(student.id, now),
    loadUnlocks(student.id, now),
  ]);

  return buildDeviceProfile({
    policy: resolved.policy,
    settings,
    platform,
    usageByKey,
    unlocks,
    deviceId,
    now,
    resolution: resolved,
  });
}

/**
 * `GET /devices/me/policy` — qurilma profilni so'raydi.
 *
 * ⚠️ `deviceUid` IXTIYORIY: ilova hali biriktirilmagan bo'lsa ham
 * "hozircha cheklov yo'q" degan javob olishi kerak, aks holda ekran
 * xato bilan qolib ketardi.
 */
async function getProfile(user, query = {}) {
  requireStudent(user);

  let device = null;
  if (query.deviceUid) {
    device = await requireOwnDevice(user, query.deviceUid);
  }

  const profile = await buildProfileFor(user, {
    platform: device?.platform || query.platform || "android",
    deviceId: device?.id || null,
  });

  // ⚠️ To'xtatilgan qurilmada cheklov ISHLAMAYDI, lekin qator ro'yxatda
  // qoladi: "to'xtatish" — vaqtinchalik qaror, "olib tashlash" emas.
  if (device && device.status !== "active") {
    return {
      ...profile,
      enforced: false,
      apps: [],
      windows: [],
      reason:
        device.status === "paused"
          ? "Cheklov vaqtincha to'xtatilgan"
          : "Qurilma chekovdan chiqarilgan",
    };
  }

  if (device) {
    // ⚠️ "Yetkazildi" belgisi: qurilmada qaysi versiya turganini panel
    // shundan biladi. Kutilmaydi — profilni qaytarish bunga bog'liq emas.
    prisma.studentDevice
      .update({
        where: { id: device.id },
        data: {
          lastSyncAt: new Date(),
          lastSeenAt: new Date(),
          appliedPolicyVersion: profile.version || null,
        },
      })
      .catch((error) => logger.warn(`[devices] sync belgisi yozilmadi: ${error.message}`));
  }

  return profile;
}

/**
 * `POST /devices/me/heartbeat` — qurilma tirikligini va CHEKLOV
 * HAQIQATDA ISHLAYOTGANINI aytadi.
 *
 * ⚠️ `enforcing` ni faqat qurilma biladi. Server buni taxmin QILMAYDI:
 * o'quvchi OS ruxsatini qaytarib olsa, panel buni YASHIRMASLIGI kerak
 * (`devices.md` §0).
 */
async function heartbeat(user, payload = {}) {
  requireStudent(user);
  const device = await requireOwnDevice(user, payload.deviceUid);

  const data = {
    lastSeenAt: new Date(),
    enforcing: Boolean(payload.enforcing),
    enforcementNote: String(payload.enforcementNote || "").trim().slice(0, 300),
  };

  if (payload.appVersion) data.appVersion = String(payload.appVersion).trim().slice(0, 32);
  if (payload.osVersion) data.osVersion = String(payload.osVersion).trim().slice(0, 32);
  if (payload.batteryLevel !== undefined) {
    const level = Number(payload.batteryLevel);
    data.batteryLevel = Number.isFinite(level)
      ? Math.max(0, Math.min(100, Math.round(level)))
      : null;
  }

  const updated = await prisma.studentDevice.update({
    where: { id: device.id },
    data,
    select: { id: true, status: true, enforcing: true, appliedPolicyVersion: true },
  });

  const profile = await buildProfileFor(user, {
    platform: device.platform,
    deviceId: device.id,
  });

  // Qurilma har heartbeat'da profil versiyasini taqqoslaydi — push
  // yetmagan bo'lsa ham yangi qoidani shu yerdan biladi.
  return {
    device: updated,
    policyVersion: profile.version,
    stale: updated.appliedPolicyVersion !== profile.version,
  };
}

/**
 * `POST /devices/me/usage` — KUN YAKUNI (to'liq suratga olish).
 *
 * ⚠️ O'SHA KUNNING QATORLARI ALMASHTIRILADI (delete + createMany):
 * qo'shish bo'lsa, qayta yuborilgan hisobot vaqtni ikki barobar
 * ko'rsatardi. Bu ikki so'rov — qatorlar soni qancha bo'lishidan qat'i
 * nazar.
 */
async function reportUsage(user, payload = {}) {
  requireStudent(user);
  const device = await requireOwnDevice(user, payload.deviceUid);

  const day = parseReportDay(payload.day);
  const entries = normalizeUsageEntries(payload.entries);

  if (entries.length === 0) {
    await prisma.deviceUsageDay.deleteMany({ where: { deviceId: device.id, day } });
    return { saved: 0, day };
  }

  // Katalogdagi id larni bog'laymiz — hisobotda ilova nomi chiqishi uchun.
  const field = device.platform === "ios" ? "iosBundleId" : "androidPackage";
  const known = await prisma.deviceApp.findMany({
    where: { [field]: { in: entries.map((e) => e.appKey) } },
    select: { id: true, [field]: true },
  });
  const appIdByKey = new Map(known.map((row) => [row[field], row.id]));

  await prisma.$transaction([
    prisma.deviceUsageDay.deleteMany({ where: { deviceId: device.id, day } }),
    prisma.deviceUsageDay.createMany({
      data: entries.map((entry) => ({
        deviceId: device.id,
        studentId: user.id,
        day,
        appKey: entry.appKey,
        appId: appIdByKey.get(entry.appKey) || null,
        minutes: entry.minutes,
        opens: entry.opens,
        blocked: entry.blocked,
      })),
    }),
    prisma.studentDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    }),
  ]);

  return { saved: entries.length, day };
}

/**
 * `POST /devices/me/apps` — o'rnatilgan ilovalar ro'yxati (katalog uchun).
 *
 * ⚠️ Bu RO'YXAT, kuzatuv emas: faqat ilova nomi va identifikatori
 * yuboriladi, ishlatish vaqti bilan bog'lanmaydi. Admin paket nomini
 * yoddan yoza olmaydi — katalogni shu yo'l to'ldiradi.
 */
async function reportApps(user, payload = {}) {
  requireStudent(user);
  const device = await requireOwnDevice(user, payload.deviceUid);

  const result = await deviceAppService.syncDiscovered(payload.apps, device.platform);

  await prisma.studentDevice
    .update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })
    .catch(() => {});

  return result;
}

/**
 * `GET /devices/me/status` — O'QUVCHI O'ZIGA QO'LLANGAN QOIDANI KO'RADI.
 *
 * ⚠️ BU EKRAN MODULNING ETIK ASOSI (`devices.md` §0.1). Yashirin nazorat
 * qilmaymiz: bola qaysi qoida, qaysi ilovalar, qancha vaqt va kim
 * biriktirganini bilishi kerak. Shuning uchun bu yo'l HECH QACHON
 * ruxsat kaliti ortiga yashirilmaydi.
 */
async function getMyStatus(user) {
  requireStudent(user);

  const [devices, profile, settings] = await Promise.all([
    prisma.studentDevice.findMany({
      where: { studentId: user.id, status: { not: "removed" } },
      select: {
        id: true,
        label: true,
        platform: true,
        status: true,
        enforcing: true,
        lastSeenAt: true,
      },
      orderBy: { enrolledAt: "desc" },
    }),
    buildProfileFor(user),
    getDeviceSettings(),
  ]);

  const usage = await todayUsageMap(user.id);
  const usedToday = [...usage.values()].reduce((sum, row) => sum + (row.minutes || 0), 0);

  return {
    enabled: settings.enabled,
    devices,
    profile,
    today: {
      usedMinutes: Math.min(usedToday, MINUTES_PER_DAY),
      remainingMinutes: profile.remainingMinutes,
    },
  };
}

/* ─────────────────────── VALIDATSIYA ─────────────────────── */

/**
 * Hisobot kuni.
 *
 * ⚠️ KELAJAK KUN RAD ETILADI va orqaga ham `MAX_BACKFILL_DAYS` gacha:
 * telefon soatini o'zgartirib, "ertaga" ga hisobot yozish bugungi
 * chegarani bo'shatib qo'yardi.
 */
function parseReportDay(value) {
  const today = tashkentDayDate(new Date());
  if (!value) return today;

  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new BadRequestError("Kun «YYYY-MM-DD» ko'rinishida bo'lishi kerak");
  }

  const day = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime())) throw new BadRequestError("Kun noto'g'ri");
  if (day > today) throw new BadRequestError("Kelajak kuni uchun hisobot qabul qilinmaydi");

  const diffDays = Math.round((today - day) / 86400000);
  if (diffDays > MAX_BACKFILL_DAYS) {
    throw new BadRequestError(`Hisobot ko'pi bilan ${MAX_BACKFILL_DAYS} kun orqaga yuboriladi`);
  }

  return day;
}

function normalizeUsageEntries(entries) {
  if (entries === undefined || entries === null) return [];
  if (!Array.isArray(entries)) throw new BadRequestError("entries massiv bo'lishi kerak");
  if (entries.length > MAX_USAGE_ENTRIES) {
    throw new BadRequestError(`Ko'pi bilan ${MAX_USAGE_ENTRIES} ta ilova yuboriladi`);
  }

  const byKey = new Map();

  for (const entry of entries) {
    const appKey = deviceAppService.normalizeIdentifierSafe(entry?.appKey ?? entry?.package);
    if (!appKey) continue;

    // ⚠️ Chegara 1440: bir kunda undan ko'p daqiqa bo'lishi mumkin emas.
    // Buzuq (yoki soxta) mijoz hisobotni cheksiz katta yuborsa,
    // hisobotlar ma'nosiz bo'lib qolardi.
    const minutes = clampInt(entry?.minutes, 0, MINUTES_PER_DAY);
    const opens = clampInt(entry?.opens, 0, 10000);
    const blocked = clampInt(entry?.blocked, 0, 10000);

    // Bir kalit ikki marta kelsa — qo'shamiz (ilova ikki profilda
    // ishlagan bo'lishi mumkin), lekin baribir kunlik chegaraga siqamiz.
    const prev = byKey.get(appKey);
    if (prev) {
      prev.minutes = Math.min(MINUTES_PER_DAY, prev.minutes + minutes);
      prev.opens += opens;
      prev.blocked += blocked;
    } else {
      byKey.set(appKey, { appKey, minutes, opens, blocked });
    }
  }

  return [...byKey.values()];
}

function clampInt(value, min, max) {
  const num = Math.round(Number(value) || 0);
  if (!Number.isFinite(num)) return min;
  return Math.max(min, Math.min(max, num));
}

module.exports = {
  MAX_USAGE_ENTRIES,
  MAX_BACKFILL_DAYS,
  buildProfileFor,
  getProfile,
  heartbeat,
  reportUsage,
  reportApps,
  getMyStatus,
  todayUsageMap,
  requireOwnDevice,
};
