/**
 * Dars jadvalini rejalashtirish — SOZLAMALAR va GRID.
 *
 * ⚠️ Dars soatlari (`periods`) bu yerda EMAS: ular `ScheduleSettings` da
 * yashaydi va `/schedule-settings` sahifasi ham, rejalashtirish ham AYNAN
 * o'sha ro'yxatni o'qiydi. Ikkinchi nusxa yaratilsa, preview grid amaldagi
 * jadvaldan ajralib qolardi va keyinchalik "qo'llash" imkonsiz bo'lardi.
 */

const prisma = require("../config/prisma");
const { BadRequestError } = require("../utils/errors");
const {
  getPlannerSettings,
  getScheduleSettings,
} = require("./settings.service");
const {
  SCHEDULE_DAYS,
  resolveWorkDays,
  resolveOrders,
} = require("../helpers/planner.helpers");

/**
 * Sozlamalar (singleton).
 * @returns {Promise<object>}
 */
async function getSettings() {
  return getPlannerSettings();
}

// Butun son maydonini tekshiradi va qaytaradi.
function readInt(value, { field, min, max }) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < min || num > max) {
    throw new BadRequestError(
      `${field} ${min} dan ${max} gacha butun son bo'lishi kerak`,
    );
  }
  return num;
}

/**
 * Sozlamalarni yangilaydi. Faqat yuborilgan maydonlar tegiladi
 * (financeSettings uslubi: har maydon uchun alohida `!== undefined` bloki).
 *
 * @param {object} data
 * @param {string} userId
 * @returns {Promise<object>}
 */
async function updateSettings(data, userId) {
  const payload = {};

  if (data.workDays !== undefined) {
    if (!Array.isArray(data.workDays)) {
      throw new BadRequestError("Ish kunlari massiv bo'lishi kerak");
    }
    for (const day of data.workDays) {
      if (!SCHEDULE_DAYS.includes(day)) {
        throw new BadRequestError(`Noma'lum kun: ${day}`);
      }
    }
    // Takrorlarni olib tashlaymiz va hafta tartibida saqlaymiz — javob va DB
    // yozuvi barqaror bo'lishi uchun.
    payload.workDays = SCHEDULE_DAYS.filter((day) => data.workDays.includes(day));
  }

  if (data.maxLessonsPerDay !== undefined) {
    payload.maxLessonsPerDay = readInt(data.maxLessonsPerDay, {
      field: "Sinf uchun kunlik maksimal dars",
      min: 1,
      max: 20,
    });
  }

  if (data.minLessonsPerDay !== undefined) {
    payload.minLessonsPerDay = readInt(data.minLessonsPerDay, {
      field: "Sinf uchun kunlik minimal dars",
      min: 0,
      max: 20,
    });
  }

  if (data.teacherMaxPerDay !== undefined) {
    payload.teacherMaxPerDay = readInt(data.teacherMaxPerDay, {
      field: "O'qituvchi uchun kunlik maksimal dars",
      min: 1,
      max: 20,
    });
  }

  if (data.maxSameSubjectPerDay !== undefined) {
    payload.maxSameSubjectPerDay = readInt(data.maxSameSubjectPerDay, {
      field: "Bir kunda bir xil fan",
      min: 1,
      max: 10,
    });
  }

  if (data.seed !== undefined) {
    payload.seed = readInt(data.seed, { field: "Variant raqami", min: 1, max: 999999 });
  }

  for (const flag of ["allowClassGaps", "allowTeacherGaps", "avoidConsecutiveSame"]) {
    if (data[flag] !== undefined) payload[flag] = Boolean(data[flag]);
  }

  const current = await getPlannerSettings();
  const nextMin = payload.minLessonsPerDay ?? current.minLessonsPerDay;
  const nextMax = payload.maxLessonsPerDay ?? current.maxLessonsPerDay;
  if (nextMin > nextMax) {
    throw new BadRequestError(
      "Kunlik minimal dars maksimaldan katta bo'lishi mumkin emas",
    );
  }

  return prisma.plannerSettings.update({
    where: { id: current.id },
    data: { ...payload, updatedBy: userId },
  });
}

/**
 * Jadval koordinatasi: qaysi kunlar va qaysi dars kataklari mavjud.
 *
 * `periods` — ScheduleSettings dan, `days` — planner sozlamasidan.
 * Ikkalasi ham bir joyda hisoblanadi, chunki grid barcha ekranlarda
 * (bandlik, shakllantirish, jadval) bir xil bo'lishi shart.
 *
 * @returns {Promise<{days: string[], periods: Array, orders: number[], settings: object}>}
 */
async function getGrid() {
  const [settings, scheduleSettings] = await Promise.all([
    getPlannerSettings(),
    getScheduleSettings(),
  ]);

  const rawPeriods = Array.isArray(scheduleSettings.periods)
    ? scheduleSettings.periods
    : [];
  const orders = resolveOrders(rawPeriods);

  // `orders` tartibida, takrorsiz — ekranda ustunlar shu ketma-ketlikda chiziladi.
  const periods = orders.map((order) => {
    const found = rawPeriods.find((p) => Number(p?.order) === order) || {};
    return {
      order,
      startTime: found.startTime || null,
      endTime: found.endTime || null,
    };
  });

  return {
    days: resolveWorkDays(settings.workDays),
    periods,
    orders,
    settings,
  };
}

module.exports = { getSettings, updateSettings, getGrid };
