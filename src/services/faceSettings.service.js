/**
 * FACE ID SOZLAMASI — O'QISH VA TEKSHIRILGAN YOZISH.
 *
 * ⚠️ CHEGARALAR SOZLAMADA, KODDA EMAS: har kameraning sifati boshqa va
 * "0.62" raqami bitta filialda juda qattiq, boshqasida juda yumshoq
 * bo'lib chiqadi. Lekin aynan shu sababli ular TEKSHIRILISHI shart —
 * bitta xato raqam butun davomatni buzadi.
 *
 * ── NIMA UCHUN ALOHIDA SERVICE ──────────────────────────────────────
 *
 * O'qish `settings.service.js` da (barcha singletonlar bilan birga),
 * YOZISH esa bu yerda: har maydonning o'z chegarasi va o'z ogohlantirishi
 * bor va ularni umumiy getter faylga qo'yish uni 300 qator validatsiya
 * bilan to'ldirardi.
 */

const prisma = require("../config/prisma");
const { getFaceSettings } = require("./settings.service");
const faceGallery = require("./faceGallery.service");
const { BadRequestError } = require("../utils/errors");
const logger = require("../utils/logger");

const SINGLETON = "singleton";

/**
 * CHEGARA KATALOGI — har maydon uchun ruxsat etilgan oraliq.
 *
 * ⚠️ `min: 0` bo'lgan tiriklik chegaralari — TEKSHIRUVSIZ rejim. U
 * ataylab mumkin (ba'zi kameralarda anti-spoof modeli ishlamaydi), lekin
 * `warnings` bilan qaytadi: telefondagi rasm bilan davomatdan o'tish
 * aynan shu bitta son orqasida (`.claude/rules/face-id.md` §4).
 */
const RANGES = Object.freeze({
  matchThreshold: { min: 0.3, max: 0.99, type: "float" },
  marginThreshold: { min: 0, max: 0.5, type: "float" },
  livenessThreshold: { min: 0, max: 0.99, type: "float" },
  antispoofThreshold: { min: 0, max: 0.99, type: "float" },
  minFaceQuality: { min: 0, max: 0.99, type: "float" },
  duplicateThreshold: { min: 0.3, max: 0.99, type: "float" },
  cooldownSeconds: { min: 0, max: 3600, type: "int" },
  checkoutMinMinutes: { min: 0, max: 24 * 60, type: "int" },
  maxSamplesPerPerson: { min: 1, max: 20, type: "int" },
  studentLateGraceMinutes: { min: 0, max: 240, type: "int" },
  snapshotRetentionDays: { min: 1, max: 365, type: "int" },
});

const BOOLEANS = Object.freeze([
  "staffEnabled",
  "studentEnabled",
  "storeSnapshots",
  "offlineGalleryEnabled",
]);

const parseNumber = (key, value) => {
  const range = RANGES[key];
  const num = Number(value);
  if (!Number.isFinite(num)) throw new BadRequestError(`"${key}" son bo'lishi kerak`);
  const rounded = range.type === "int" ? Math.round(num) : Math.round(num * 1000) / 1000;
  if (rounded < range.min || rounded > range.max) {
    throw new BadRequestError(
      `"${key}" ${range.min} va ${range.max} orasida bo'lishi kerak (${rounded} keldi)`,
    );
  }
  return rounded;
};

/**
 * Sozlamani o'qiydi (panel uchun — chegaralar bilan birga).
 *
 * ⚠️ `ranges` javobda qaytadi: panel slayderlarining chegarasi va
 * serverning tekshiruvi BIR MANBADAN bo'lishi kerak. Ikki joyda
 * yozilsa, panel ruxsat bergan qiymat serverda rad etilardi.
 */
async function get() {
  const settings = await getFaceSettings();
  const coverage = await faceGallery.getCoverage(settings);
  return { settings: shape(settings), ranges: RANGES, coverage };
}

const shape = (row) => ({
  matchThreshold: row.matchThreshold,
  marginThreshold: row.marginThreshold,
  livenessThreshold: row.livenessThreshold,
  antispoofThreshold: row.antispoofThreshold,
  minFaceQuality: row.minFaceQuality,
  duplicateThreshold: row.duplicateThreshold,
  cooldownSeconds: row.cooldownSeconds,
  checkoutMinMinutes: row.checkoutMinMinutes,
  maxSamplesPerPerson: row.maxSamplesPerPerson,
  studentLateGraceMinutes: row.studentLateGraceMinutes,
  staffEnabled: row.staffEnabled,
  studentEnabled: row.studentEnabled,
  storeSnapshots: row.storeSnapshots,
  snapshotRetentionDays: row.snapshotRetentionDays,
  offlineGalleryEnabled: row.offlineGalleryEnabled,
  embeddingModel: row.embeddingModel,
  embeddingDim: row.embeddingDim,
  galleryVersion: row.galleryVersion,
  updatedBy: row.updatedBy,
  updatedAt: row.updatedAt,
});

/**
 * Kioskka beriladigan sozlama — faqat QURILMAGA kerakli maydonlar.
 *
 * ⚠️ `galleryVersion` ham shu javobda: kiosk har heartbeat'da keshi
 * eskirgan-eskirmaganini bitta so'rovda biladi va galereyani bekorga
 * qayta yuklab olmaydi.
 */
const forKiosk = (row) => ({
  matchThreshold: row.matchThreshold,
  marginThreshold: row.marginThreshold,
  livenessThreshold: row.livenessThreshold,
  antispoofThreshold: row.antispoofThreshold,
  minFaceQuality: row.minFaceQuality,
  cooldownSeconds: row.cooldownSeconds,
  staffEnabled: row.staffEnabled,
  studentEnabled: row.studentEnabled,
  storeSnapshots: row.storeSnapshots,
  offlineGalleryEnabled: row.offlineGalleryEnabled,
  embeddingModel: row.embeddingModel,
  embeddingDim: row.embeddingDim,
  galleryVersion: row.galleryVersion,
});

/**
 * Sozlamani yozadi.
 *
 * ⚠️ MODEL VA O'LCHAM BU YERDAN O'ZGARMAYDI. Ularni almashtirish butun
 * galereyani yaroqsiz qiladi (eski vektorlar yangi model bilan
 * taqqoslanmaydi) — ya'ni bu sozlama emas, MIGRATSIYA. Tasodifan
 * bosilgan tanlov ertasiga butun maktabni "tanilmadi" holatiga
 * tushirardi; shuning uchun u alohida amal (`switchModel`) va ochiq
 * ogohlantirish bilan.
 *
 * @returns {Promise<{ settings: object, warnings: string[] }>}
 */
async function update(data = {}, actorId) {
  const patch = { updatedBy: actorId || null };

  for (const key of Object.keys(RANGES)) {
    if (data[key] !== undefined) patch[key] = parseNumber(key, data[key]);
  }
  for (const key of BOOLEANS) {
    if (data[key] !== undefined) patch[key] = Boolean(data[key]);
  }

  const current = await getFaceSettings();
  const next = { ...current, ...patch };

  // ── O'ZARO BOG'LIQ TEKSHIRUVLAR ─────────────────────────────────
  //
  // ⚠️ `duplicateThreshold` `matchThreshold` DAN OSHMASLIGI kerak:
  // oshsa, taqqoslashda "bu odam" deb topiladigan yuz ro'yxatga
  // olishda dublikat sanalmaydi va bitta yuz ikki odamga biriktirilib
  // ketardi. Chegarani o'zgartirgan odam buni hisoblab o'tirmasligi
  // kerak — server aytadi.
  if (next.duplicateThreshold > next.matchThreshold) {
    throw new BadRequestError(
      "Dublikat chegarasi mos kelish chegarasidan yuqori bo'lmasligi kerak — " +
        "aks holda bitta yuz ikki odamga biriktirilib ketadi",
    );
  }

  const warnings = [];
  if (next.antispoofThreshold === 0 && next.livenessThreshold === 0) {
    warnings.push(
      "Tiriklik tekshiruvi butunlay o'chirilgan — telefondagi rasm bilan davomatdan o'tish mumkin",
    );
  }
  if (next.cooldownSeconds === 0) {
    warnings.push(
      "Takror skaner darvozasi o'chirilgan — bitta odam ketma-ket bir necha qayd olishi mumkin",
    );
  }
  if (next.marginThreshold === 0) {
    warnings.push(
      "Noaniqlik darvozasi o'chirilgan — bir-biriga o'xshash ikki odam adashtirilishi mumkin",
    );
  }
  if (!next.staffEnabled && !next.studentEnabled) {
    warnings.push("Face ID hech kim uchun yoqilmagan — kiosklar hech kimni o'tkazmaydi");
  }
  if (!next.offlineGalleryEnabled) {
    warnings.push("Oflayn rejim o'chirilgan — internetsiz kiosk ishlamaydi");
  }

  const row = await prisma.faceSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, ...patch },
    update: patch,
  });

  if (warnings.length > 0) {
    logger.warn(`Face ID sozlamasi: ${warnings.join(" | ")}`);
  }

  return { settings: shape(row), warnings };
}

/**
 * MODEL ALMASHTIRISH — alohida, ogohlantirishli amal.
 *
 * ⚠️ Bu MIGRATSIYA, sozlama emas. Yangi modeldagi vektorlar eskisi
 * bilan taqqoslanmaydi, ya'ni almashtirilgandan keyin HAMMANI QAYTA
 * RO'YXATGA OLISH kerak. Eski namunalar O'CHIRILMAYDI (modeli bilan
 * saqlanadi): qaytib tushish kerak bo'lsa bir buyruq bilan tiklanadi va
 * oradagi vaqtda bitta ham kadr yo'qolmaydi.
 *
 * @param {{ embeddingModel: string, embeddingDim: number, confirm: boolean }} data
 */
async function switchModel(data = {}, actorId) {
  const model = String(data.embeddingModel || "").trim();
  const dim = Math.round(Number(data.embeddingDim));

  if (!model || model.length > 80) throw new BadRequestError("Model nomi noto'g'ri");
  if (!Number.isFinite(dim) || dim < 64 || dim > 4096) {
    throw new BadRequestError("Vektor o'lchami 64 va 4096 orasida bo'lishi kerak");
  }

  const current = await getFaceSettings();
  if (current.embeddingModel === model && current.embeddingDim === dim) {
    return { settings: shape(current), affected: 0, changed: false };
  }

  // Nechta namuna galereyadan chiqib ketadi — tasdiqlashdan OLDIN aytiladi.
  const affected = await prisma.faceSample.count({
    where: { model: current.embeddingModel, dim: current.embeddingDim },
  });

  if (!data.confirm) {
    const error = new BadRequestError(
      `Model almashtirilsa ${affected} ta yuz namunasi taqqoslashdan chiqadi va ` +
        "hammani qayta ro'yxatga olish kerak bo'ladi. Tasdiqlang.",
    );
    error.details = { reason: "confirm_required", affected };
    throw error;
  }

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.faceSettings.upsert({
      where: { id: SINGLETON },
      create: { id: SINGLETON, embeddingModel: model, embeddingDim: dim, updatedBy: actorId || null },
      update: { embeddingModel: model, embeddingDim: dim, updatedBy: actorId || null },
    });
    await faceGallery.bumpVersion(tx);
    return updated;
  });

  faceGallery.invalidate();
  logger.warn(
    `Face ID: model almashtirildi — ${current.embeddingModel}/${current.embeddingDim} → ${model}/${dim} (${affected} namuna chiqdi)`,
  );

  return { settings: shape(row), affected, changed: true };
}

module.exports = { get, update, switchModel, shape, forKiosk, RANGES };
