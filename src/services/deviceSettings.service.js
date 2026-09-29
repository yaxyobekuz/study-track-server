/**
 * QURILMA NAZORATI SOZLAMALARI (filial singletoni).
 *
 * ⚠️ `enabled` — FAVQULODDA TUGMA. O'chirilganda profil bo'sh chekov
 * qaytaradi (hamma narsa ochiq), lekin SIYOSAT VA BIRIKTIRISHLAR
 * JOYIDA QOLADI: yoqilganda hammasi tiklanadi. Shuning uchun uni
 * o'chirish ma'lumotga TEGMAYDI — "tizim noto'g'ri ishlayapti, bolalar
 * telefonsiz qoldi" holatida ikkilanmasdan bosiladigan tugma bo'lishi
 * kerak (`devices.md` §10).
 *
 * ⚠️ BU YERDA FAVQULODDA QO'NG'IROQ SOZLAMASI YO'Q va bo'lmaydi: u
 * kodda qotirilgan (`devicePolicy.helpers.js` → `FALLBACK_ESSENTIAL`).
 * Sozlamaga chiqarilgan chegara ertaga "vaqtincha" o'chiriladi va
 * qaytarilmaydi.
 */

const prisma = require("../config/prisma");
const { BadRequestError } = require("../utils/errors");
const { getDeviceSettings } = require("./settings.service");
const deviceAudit = require("./deviceAudit.service");
const { FALLBACK_ESSENTIAL, MAX_UNLOCK_HOURS } = require("../helpers/devicePolicy.helpers");

/** Sozlama chegaralari — panel ham shu qiymatlarni ko'rsatadi. */
const LIMITS = Object.freeze({
  enrollmentCodeTtlMinutes: { min: 5, max: 1440, label: "Kod muddati (daqiqa)" },
  offlineGraceMinutes: { min: 15, max: 10080, label: "Oflayn deb belgilash (daqiqa)" },
  usageRetentionDays: { min: 7, max: 730, label: "Hisobotni saqlash (kun)" },
  syncIntervalMinutes: { min: 5, max: 720, label: "Sinxronizatsiya oralig'i (daqiqa)" },
});

function readInt(payload, key) {
  if (payload[key] === undefined) return undefined;

  const value = Number(payload[key]);
  const { min, max, label } = LIMITS[key];
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BadRequestError(`${label}: ${min} dan ${max} gacha bo'lishi kerak`);
  }
  return value;
}

/**
 * Sozlamalar + o'zgarmas chegaralar.
 *
 * ⚠️ `hardRules` ATAYLAB javobga qo'shiladi: panel "favqulodda qo'ng'iroq
 * doim ochiq" va "ochish ko'pi bilan 24 soat" degan qoidalarni
 * KO'RSATADI. Hujjatda qolib ketgan qoidani foydalanuvchi o'qimaydi —
 * ekranda turgani esa e'tiroz bildirish imkonini beradi.
 */
async function getSettings() {
  const settings = await getDeviceSettings();
  return {
    ...settings,
    limits: LIMITS,
    hardRules: {
      emergencyAlwaysAllowed: true,
      essentialFallback: FALLBACK_ESSENTIAL,
      maxUnlockHours: MAX_UNLOCK_HOURS,
      // ⚠️ Mazmun yig'ilmasligi — sozlama emas, arxitektura qarori.
      collectsContent: false,
    },
  };
}

async function updateSettings(payload = {}, actorId) {
  const current = await getDeviceSettings();

  const data = {
    updatedBy: actorId,
    ...(payload.enabled !== undefined ? { enabled: Boolean(payload.enabled) } : {}),
    ...(payload.offlinePolicy !== undefined
      ? { offlinePolicy: payload.offlinePolicy === "lockDown" ? "lockDown" : "keepLast" }
      : {}),
  };

  for (const key of Object.keys(LIMITS)) {
    const value = readInt(payload, key);
    if (value !== undefined) data[key] = value;
  }

  const updated = await prisma.deviceSettings.update({ where: { id: "singleton" }, data });

  // ⚠️ Modulni yoqish/o'chirish — butun maktabga ta'sir qiladigan qaror,
  // shuning uchun audit matni aynan shuni aytadi.
  const toggled = payload.enabled !== undefined && current.enabled !== updated.enabled;
  await deviceAudit.record({
    action: deviceAudit.ACTIONS.SETTINGS_UPDATE,
    actorId,
    summary: toggled
      ? `Qurilma nazorati ${updated.enabled ? "YOQILDI" : "O'CHIRILDI"}`
      : "Qurilma nazorati sozlamalari yangilandi",
    meta: { changed: Object.keys(data).filter((k) => k !== "updatedBy") },
  });

  return getSettings();
}

module.exports = { LIMITS, getSettings, updateSettings };
