/**
 * DARS TAQSIMOTI VARAG'I — mustaqil tab uchun ixtiyoriy zaxira.
 *
 * ⚠️ Bu servis varaqning ICHIGA QARAMAYDI. U bitta JSON hujjatni oladi va
 * qaytaradi, xolos. Sababi: tab hozircha mustaqil — ustunlar (sinflar) va
 * qatorlar (fanlar) varaqning o'zida yashaydi va `Class` / `Subject`
 * kataloglariga bog'lanmaydi. Bu yerda ularni tekshirmoqchi bo'lsak, hali
 * qabul qilinmagan integratsiya qarorini serverga muhrlab qo'ygan bo'lardik.
 *
 * Doimiy saqlash MIJOZDA (localStorage). Bu — faqat "Saqlash" tugmasi bosilganda
 * yoziladigan nusxa: boshqa kompyuterda ochish yoki brauzer xotirasi
 * tozalanib ketishidan himoya.
 */

const prisma = require("../config/prisma");
const { BadRequestError } = require("../utils/errors");

const SINGLETON = "singleton";

// Varaq JSON'i uchun oqilona chegara. Bu tekshiruv MAZMUNGA emas, HAJMGA
// qaraydi: buzilgan yoki cheksiz o'sgan hujjat bazaga tushmasligi kerak.
const MAX_BYTES = 512 * 1024;

/**
 * Saqlangan varaqni qaytaradi.
 *
 * Hech qachon saqlanmagan bo'lsa `data: null` qaytadi — bo'sh obyekt EMAS.
 * Mijoz shu farqqa qarab "serverda nusxa yo'q" holatini ko'rsatadi.
 *
 * @returns {Promise<{data: object|null, updatedAt: Date|null, updatedBy: string|null}>}
 */
async function getSheet() {
  const row = await prisma.plannerDistribution.findUnique({
    where: { id: SINGLETON },
  });

  if (!row) return { data: null, updatedAt: null, updatedBy: null };

  const isEmpty =
    !row.data || (typeof row.data === "object" && Object.keys(row.data).length === 0);

  return {
    data: isEmpty ? null : row.data,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/**
 * Varaqni saqlaydi (to'liq almashtirish).
 *
 * @param {object} data - varaqning butun holati
 * @param {string} userId
 */
async function saveSheet(data, userId) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new BadRequestError("Varaq ma'lumoti obyekt bo'lishi kerak");
  }

  const size = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (size > MAX_BYTES) {
    throw new BadRequestError(
      `Varaq juda katta (${Math.round(size / 1024)} KB). Ortiqcha ustun yoki qatorlarni olib tashlang`,
    );
  }

  const row = await prisma.plannerDistribution.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, data, updatedBy: userId || null },
    update: { data, updatedBy: userId || null },
  });

  return { data: row.data, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
}

module.exports = { getSheet, saveSheet };
