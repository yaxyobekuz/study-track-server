/**
 * DARS JADVALI QORALAMASI — tugallanmagan tahrirning zaxirasi.
 *
 * ⚠️ Qoralama AMALDAGI jadval EMAS. U hech qayerga chiqmaydi: o'quvchi ham,
 * o'qituvchi ham, hisobot ham uni ko'rmaydi. Uni faqat YOZGAN ODAM ko'radi.
 *
 * Nima uchun kerak. Jadval saqlashda BUTUNLIGICHA tekshiriladi: o'qituvchi
 * boshqa sinfda o'sha tartibda band bo'lsa, butun hafta rad etiladi.
 * Konfliktni bartaraf qilish uchun boshqa sinf jadvaliga o'tish kerak
 * bo'ladi va shu paytgacha qilingan tahrir brauzer xotirasida turgani uchun
 * yo'q bo'lardi. Qoralama shu bo'shliqni yopadi.
 *
 * ⚠️ Bu servis qoralamaning ICHIGA QARAMAYDI (fan bormi, o'qituvchi bormi —
 * tekshirilmaydi). Qoralama ATAYLAB YAROQSIZ bo'lishi mumkin: odam yarim
 * to'ldirilgan darsni qoldirib ketishi tabiiy hol. Tekshiruv "Saqlash"
 * bosilganda, `schedule.service.js` da bo'ladi — u yerda bitta joyda.
 * Bu yerda faqat SHAKL va HAJM tekshiriladi.
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { DAYS } = require("../utils/constants");

const VALID_DAYS = Object.values(DAYS);

// Bir sinfning haftalik qoralamasi uchun oqilona chegara (6 kun × ~15 dars).
// Tekshiruv MAZMUNGA emas, HAJMGA qaraydi: buzilgan yoki cheksiz o'sgan
// hujjat bazaga tushmasligi kerak.
const MAX_BYTES = 256 * 1024;

// Bitta darsdan olinadigan maydonlar — qolgani tashlanadi. Mijoz nima
// yuborsa o'shani saqlab qo'ysak, qoralama vaqt o'tib formadan butunlay
// boshqa shaklga aylanib ketardi.
const LESSON_FIELDS = ["subject", "teacher", "order", "startTime", "endTime"];

/**
 * Qoralamani forma kutgan shaklga keltiradi: `{ <kun>: [dars, ...] }`.
 *
 * Noma'lum kunlar va dars bo'lmagan qiymatlar tashlanadi, matn maydonlari
 * kesiladi. Yaroqsiz DARS esa saqlanadi (bo'sh fan, bo'sh o'qituvchi) —
 * tugallanmagan ishning butun mazmuni shu.
 *
 * @param {object} week
 * @returns {object}
 */
function sanitizeWeek(week) {
  if (!week || typeof week !== "object" || Array.isArray(week)) {
    throw new BadRequestError("Qoralama shakli noto'g'ri");
  }

  const out = {};
  for (const day of VALID_DAYS) {
    const lessons = week[day];
    if (!Array.isArray(lessons)) continue;

    out[day] = lessons.slice(0, 100).map((lesson) => {
      const row = {};
      for (const field of LESSON_FIELDS) {
        const value = lesson?.[field];
        row[field] =
          value === undefined || value === null ? "" : String(value).slice(0, 64);
      }
      return row;
    });
  }
  return out;
}

/**
 * Foydalanuvchining shu sinf uchun qoralamasi.
 *
 * Qoralama yo'q bo'lsa `null` qaytadi — bo'sh obyekt EMAS. Mijoz shu farqqa
 * qarab "tiklanadigan narsa yo'q" holatini ko'rsatadi.
 *
 * @param {string} classId
 * @param {string} userId
 * @returns {Promise<{week: object, baseHash: string|null, updatedAt: Date}|null>}
 */
async function getDraft(classId, userId) {
  const row = await prisma.scheduleDraft.findUnique({
    where: { classId_userId: { classId, userId } },
  });
  if (!row) return null;

  const week = row.data?.week;
  if (!week || typeof week !== "object") return null;

  return { week, baseHash: row.baseHash || null, updatedAt: row.updatedAt };
}

/**
 * Qoralamani saqlash (to'liq almashtirish).
 *
 * ⚠️ Kalit — (sinf, foydalanuvchi). Bitta sinfni ikki xodim tahrir qilsa,
 * ular bir-birining tugallanmagan ishini ko'rmaydi va bosib ketmaydi.
 *
 * @param {string} classId
 * @param {string} userId
 * @param {object} week - `{ <kun>: [dars, ...] }`
 * @param {string} [baseHash] - qoralama qurilgan jadvalning imzosi
 * @returns {Promise<{updatedAt: Date}>}
 */
async function saveDraft(classId, userId, week, baseHash) {
  const classExists = await prisma.class.findUnique({ where: { id: classId } });
  if (!classExists) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const data = { week: sanitizeWeek(week) };

  const size = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (size > MAX_BYTES) {
    throw new BadRequestError(
      `Qoralama juda katta (${Math.round(size / 1024)} KB). Ortiqcha darslarni olib tashlang`,
    );
  }

  const hash =
    typeof baseHash === "string" && baseHash.length <= 64 ? baseHash : null;

  const row = await prisma.scheduleDraft.upsert({
    where: { classId_userId: { classId, userId } },
    create: { classId, userId, data, baseHash: hash },
    update: { data, baseHash: hash },
  });

  return { updatedAt: row.updatedAt };
}

/**
 * Qoralamani o'chirish ("saqlangan jadvalga qaytish").
 *
 * Yo'q bo'lsa ham xato QAYTMAYDI: "qoralamani tashlash" amali natijaga
 * qarab baholanadi — qoralama qolmadi, demak bajarildi.
 *
 * @param {string} classId
 * @param {string} userId
 * @returns {Promise<void>}
 */
async function deleteDraft(classId, userId) {
  await prisma.scheduleDraft.deleteMany({ where: { classId, userId } });
}

module.exports = { getDraft, saveDraft, deleteDraft };
