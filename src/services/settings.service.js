/**
 * Singleton sozlama modellari uchun getSettings() helperlar.
 *
 * Mongoose'dagi `Model.getSettings()` static'lari o'rnini bosadi. Har biri
 * upsert bilan (yo'q bo'lsa yaratadi) — idempotent, id har doim "singleton".
 *
 * ── FILIAL VA PLATFORMA ──────────────────────
 *
 * Bu yerdagi sozlamalarning deyarli hammasi HAR FILIALDA ALOHIDA: har filialda
 * o'z ofis koordinatasi (davomat), o'z o'quv yili va hisob-faktura kuni
 * (moliya), o'z tanga qoidasi. Ular filial schema'sida yashaydi, ya'ni
 * `prisma` (filial Proxy'si) orqali o'qiladi.
 *
 * YAGONA ISTISNO — `getChangelogSettings`: o'zgarishlar tarixi dasturiy
 * ta'minot darajasida, shuning uchun platformada.
 *
 * ⚠️ Aynan shu funksiyalar YANGI FILIAL OCHILGANDA seed sifatida chaqiriladi
 * (`branchProvision.service.js`) — alohida seed fayli YO'Q va bo'lmasligi
 * kerak: default qiymatlar yagona manbada, schema'ning o'zida.
 */

const prisma = require("../config/prisma");
const platformPrisma = require("../config/platformPrisma");

const SINGLETON = "singleton";

async function getCoinSettings() {
  return prisma.coinSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON },
    update: {},
  });
}

async function getScheduleSettings() {
  return prisma.scheduleSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON },
    update: {},
  });
}

async function getAttendanceSettings() {
  return prisma.attendanceSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON },
    update: {},
  });
}

async function getGradePenaltySettings() {
  return prisma.gradePenaltySettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON },
    update: {},
  });
}

async function getTestSettings() {
  return prisma.testSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON },
    update: {},
  });
}

/**
 * PenaltySettings — lazy migration: fineAmounts bo'sh bo'lsa eski
 * studentFineAmount/teacherFineAmount dan to'ldiradi (Mongoose logikasi).
 */
async function getPenaltySettings() {
  let settings = await prisma.penaltySettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON },
    update: {},
  });

  const fineAmounts = settings.fineAmounts || {};
  if (Object.keys(fineAmounts).length === 0) {
    const next = {};
    if (settings.studentFineAmount > 0) next.student = settings.studentFineAmount;
    if (settings.teacherFineAmount > 0) next.teacher = settings.teacherFineAmount;
    if (Object.keys(next).length > 0) {
      settings = await prisma.penaltySettings.update({
        where: { id: SINGLETON },
        data: { fineAmounts: next },
      });
    }
  }
  return settings;
}

/**
 * Moliya sozlamalari — akademik davr (global) va hisob-faktura cron'i.
 * Barcha maydonlarda @default bor, shuning uchun oddiy upsert yetarli.
 */
async function getFinanceSettings() {
  return prisma.financeSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON },
    update: {},
  });
}

// PLATFORMADA — yuqoridagi izohga qarang (yagona istisno).
async function getChangelogSettings() {
  return platformPrisma.changelogSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON },
    update: {},
  });
}

// Premium uchun default ranglar (Mongoose modelidagi DEFAULT_NAME_COLORS)
const DEFAULT_NAME_COLORS = [
  { key: "blue", label: "Ko'k", hex: "#3b82f6", isActive: true },
  { key: "purple", label: "Binafsha", hex: "#a855f7", isActive: true },
  { key: "green", label: "Yashil", hex: "#22c55e", isActive: true },
  { key: "gold", label: "Oltin", hex: "#f59e0b", isActive: true },
  { key: "red", label: "Qizil", hex: "#ef4444", isActive: true },
  { key: "pink", label: "Pushti", hex: "#ec4899", isActive: true },
];

/**
 * PremiumSettings — allowedNameColors bo'sh bo'lsa default bilan to'ldiradi.
 */
async function getPremiumSettings() {
  let settings = await prisma.premiumSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, allowedNameColors: DEFAULT_NAME_COLORS },
    update: {},
  });

  const colors = settings.allowedNameColors || [];
  if (!Array.isArray(colors) || colors.length === 0) {
    settings = await prisma.premiumSettings.update({
      where: { id: SINGLETON },
      data: { allowedNameColors: DEFAULT_NAME_COLORS },
    });
  }
  return settings;
}

module.exports = {
  getCoinSettings,
  getScheduleSettings,
  getAttendanceSettings,
  getGradePenaltySettings,
  getTestSettings,
  getPenaltySettings,
  getPremiumSettings,
  getFinanceSettings,
  getChangelogSettings,
  DEFAULT_NAME_COLORS,
};
