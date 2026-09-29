/**
 * OTA-ONA NAZORATI — POLICY (qurilmaga boradigan yagona haqiqat).
 *
 * ⚠️ POLICY BITTA JOYDA QURILADI — `buildPolicy()`. Uni ro'yxatdan o'tish
 * (`POST /parental/device/register`), sinxronizatsiya
 * (`GET /parental/device/policy`) va ota-ona ilovasi ishlatadi. Ikkita
 * mustaqil quruvchi bo'lsa, ota-ona bir narsani ko'rib, telefon boshqasini
 * bajarardi (`devices.md` §6 bilan bir xil mulohaza).
 *
 * ⚠️ VERSIYA (`policyVersion`) — HAR O'ZGARISHDA OSHADI va bolaning
 * telefoniga JIM push ketadi (`notifyPolicy`). Push — tezlatgich: qurilma
 * baribir `?version=N` bilan o'zi so'raydi, ya'ni Firebase ishlamasa ham
 * qoida keyingi sinxronizatsiyada yetib boradi.
 *
 * ⚠️ "HAMMASINI BLOKLASH" MUDDATI SO'ROVDA HAM YECHILADI
 * (`expireLockAllIfDue`), faqat cron'da emas: aks holda muddat o'tgach
 * cron'gacha (30 daqiqagacha) versiya o'zgarmay, qurilma eski qoidada
 * qolib ketardi.
 */

const prisma = require("../config/prisma");
const { getBranch } = require("../config/branchContext");
const pushService = require("./push.service");
const parentalPush = require("../helpers/parentalPush.helpers");
const { PIN_ALGO } = require("../helpers/parentalPin.helpers");
const { PARENTAL_ALWAYS_ALLOWED } = require("../utils/constants");

/** Qator hali yo'q o'quvchi uchun sukut qiymatlar (sxemadagi `@default` bilan AYNI). */
const SETTINGS_DEFAULTS = Object.freeze({
  pinHash: null,
  pinSalt: null,
  pinIterations: 100000,
  pinUpdatedAt: null,
  failedAttempts: 0,
  lockedUntil: null,
  lockAll: false,
  lockAllUntil: null,
  unlockMinutes: 30,
  policyVersion: 1,
});

const ALWAYS_ALLOWED = new Set(PARENTAL_ALWAYS_ALLOWED);

/**
 * Ilova doim ochiqmi (raqam terish, SMS, favqulodda).
 * @param {string} appKey
 * @returns {boolean}
 */
const isAlwaysAllowed = (appKey) => ALWAYS_ALLOWED.has(String(appKey || ""));

/**
 * Sozlama qatori — bo'lmasa yaratiladi.
 *
 * ⚠️ `createMany({ skipDuplicates })` — `INSERT … ON CONFLICT DO NOTHING`:
 * parallel ikki so'rov (masalan ikki qurilma bir vaqtda ro'yxatdan o'tsa)
 * P2002 bilan yiqilmaydi va tranzaksiya ichida ham xavfsiz (`upsert` +
 * `catch` tranzaksiyani buzilgan holatda qoldirardi).
 *
 * @param {string} studentId
 * @param {object} [client] - tranzaksiya client'i
 * @returns {Promise<object>}
 */
async function ensureSettings(studentId, client = prisma) {
  const existing = await client.parentalSettings.findUnique({ where: { studentId } });
  if (existing) return existing;

  await client.parentalSettings.createMany({ data: [{ studentId }], skipDuplicates: true });
  return client.parentalSettings.findUnique({ where: { studentId } });
}

/**
 * Sozlama — YOZMASDAN o'qiladi; qator bo'lmasa sukut qiymatlar.
 * O'qish so'rovlari (status, policy) bazaga keraksiz qator yaratmasin.
 *
 * @param {string} studentId
 * @returns {Promise<object>}
 */
async function readSettings(studentId) {
  const row = await prisma.parentalSettings.findUnique({ where: { studentId } });
  return row ?? { ...SETTINGS_DEFAULTS, studentId, id: null };
}

/**
 * "Hammasini bloklash" HOZIR amaldami.
 * @param {{ lockAll: boolean, lockAllUntil: Date|null }} settings
 * @param {Date} [now]
 * @returns {boolean}
 */
const effectiveLockAll = (settings, now = new Date()) =>
  Boolean(settings?.lockAll) &&
  (!settings.lockAllUntil || new Date(settings.lockAllUntil) > now);

/**
 * Bolaning telefoniga "policy o'zgardi" JIM push — FAQAT bola telefoniga
 * (`channels: ["student"]`). Kutilmaydi va xato tashlamaydi.
 *
 * @param {string} studentId
 * @param {number} version
 */
function notifyPolicy(studentId, version) {
  const branchId = getBranch()?.id ?? null;
  void pushService.sendToUsers([studentId], parentalPush.policyChanged({ version, branchId }));
}

/**
 * Versiyani oshiradi — tranzaksiya ichida chaqiriladi (qoida yozuvi bilan
 * BIRGA). Push esa tranzaksiyadan KEYIN (`notifyPolicy`): aks holda telefon
 * push'ni olib, hali yozilmagan eski qoidani o'qib olardi.
 *
 * ⚠️ Qator oldindan mavjud bo'lishi shart (`ensureSettings`).
 *
 * @param {string} studentId
 * @param {object} [client]
 * @returns {Promise<number>} - yangi versiya
 */
async function bumpPolicy(studentId, client = prisma) {
  const row = await client.parentalSettings.update({
    where: { studentId },
    data: { policyVersion: { increment: 1 } },
    select: { policyVersion: true },
  });
  return row.policyVersion;
}

/**
 * Muddati o'tgan "hammasini bloklash" ni yechadi: `lockAll = false`,
 * versiya +1 va jim push.
 *
 * ⚠️ COMPARE-AND-SWAP (`where` da `lockAll: true` va muddat): cron va so'rov
 * bir vaqtda kelsa versiya IKKI marta oshmaydi va ikki push ketmaydi.
 *
 * @param {string} studentId
 * @param {object} settings - joriy qator (yoki sukut)
 * @returns {Promise<object>} - dolzarb sozlama
 */
async function expireLockAllIfDue(studentId, settings) {
  const now = new Date();
  if (!settings?.id || !settings.lockAll || !settings.lockAllUntil) return settings;
  if (new Date(settings.lockAllUntil) > now) return settings;

  const [row] = await prisma.parentalSettings.updateManyAndReturn({
    where: { studentId, lockAll: true, lockAllUntil: { lte: now } },
    data: { lockAll: false, lockAllUntil: null, policyVersion: { increment: 1 } },
  });

  if (row) {
    notifyPolicy(studentId, row.policyVersion);
    return row;
  }
  // Boshqa jarayon allaqachon yechgan — dolzarbini o'qiymiz
  return readSettings(studentId);
}

/**
 * Dolzarb sozlama — muddati o'tgan blok yechilgan holda.
 * @param {string} studentId
 * @returns {Promise<object>}
 */
async function currentSettings(studentId) {
  return expireLockAllIfDue(studentId, await readSettings(studentId));
}

/**
 * POLICY — qurilmaga boradigan to'liq qoida.
 *
 * ⚠️ `platform` berilsa faqat shu platformaning ilovalari (iOS tokeni 2 KB
 * gacha — boshqa platformaning ro'yxati telefonga keraksiz yuk).
 *
 * ⚠️ DOIM OCHIQ ilovalar `blocked`/`limits` ga HECH QACHON tushmaydi —
 * server ularni yozishni ham rad etadi, bu esa ikkinchi qavat.
 *
 * ⚠️ `unlocks` — ota-ona TASDIQLAGAN, muddati o'tmagan ruxsatlar. Push
 * yetib bormasa ham qurilma ochishni shu yerdan oladi.
 *
 * @param {string} studentId
 * @param {{ platform?: "android"|"ios"|null, settings?: object }} [options]
 * @returns {Promise<object>}
 */
async function buildPolicy(studentId, { platform = null, settings = null } = {}) {
  const now = new Date();
  const s = settings ?? (await currentSettings(studentId));
  const platformWhere = platform ? { platform } : {};

  const [blockedApps, limitedApps, approved] = await Promise.all([
    prisma.parentalApp.findMany({
      where: { studentId, blocked: true, ...platformWhere },
      select: { appKeyHash: true, appKey: true, platform: true },
      orderBy: { firstSeenAt: "asc" },
    }),
    prisma.parentalApp.findMany({
      where: { studentId, blocked: false, dailyLimitMin: { not: null }, ...platformWhere },
      select: { appKeyHash: true, appKey: true, platform: true, dailyLimitMin: true },
      orderBy: { firstSeenAt: "asc" },
    }),
    prisma.parentalUnlockRequest.findMany({
      where: { studentId, status: "approved", unlockUntil: { gt: now } },
      select: { id: true, appKeyHash: true, unlockUntil: true },
      orderBy: { unlockUntil: "asc" },
    }),
  ]);

  // Ruxsatdagi ilova kaliti — qurilma hash'ni emas, kalitni taniydi
  const unlockHashes = [...new Set(approved.map((u) => u.appKeyHash).filter(Boolean))];
  const unlockApps = unlockHashes.length
    ? await prisma.parentalApp.findMany({
        where: { studentId, appKeyHash: { in: unlockHashes } },
        select: { appKeyHash: true, appKey: true },
      })
    : [];
  const keyByHash = new Map(unlockApps.map((a) => [a.appKeyHash, a.appKey]));

  const lockAll = effectiveLockAll(s, now);

  return {
    changed: true,
    policyVersion: s.policyVersion,
    serverTime: now.toISOString(),
    lockAll,
    lockAllUntil: lockAll && s.lockAllUntil ? new Date(s.lockAllUntil).toISOString() : null,
    unlockMinutes: s.unlockMinutes,
    blocked: blockedApps
      .filter((a) => !isAlwaysAllowed(a.appKey))
      .map((a) => ({ appId: a.appKeyHash, appKey: a.appKey, platform: a.platform })),
    limits: limitedApps
      .filter((a) => !isAlwaysAllowed(a.appKey))
      .map((a) => ({
        appId: a.appKeyHash,
        appKey: a.appKey,
        platform: a.platform,
        dailyLimitMin: a.dailyLimitMin,
      })),
    unlocks: approved.map((u) => ({
      requestId: u.id,
      appId: u.appKeyHash ?? null,
      appKey: u.appKeyHash ? keyByHash.get(u.appKeyHash) ?? null : null,
      until: u.unlockUntil.toISOString(),
    })),
    pin: s.pinHash
      ? { algo: PIN_ALGO, hash: s.pinHash, salt: s.pinSalt, iterations: s.pinIterations }
      : null,
    alwaysAllowed: [...PARENTAL_ALWAYS_ALLOWED],
  };
}

module.exports = {
  SETTINGS_DEFAULTS,
  isAlwaysAllowed,
  ensureSettings,
  readSettings,
  currentSettings,
  effectiveLockAll,
  notifyPolicy,
  bumpPolicy,
  expireLockAllIfDue,
  buildPolicy,
};
