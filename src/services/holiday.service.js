const Holiday = require("../models/holiday.model");
const { BadRequestError, NotFoundError } = require("../utils/errors");

/**
 * Barcha dam olish kunlarini olish.
 * @returns {Promise<Array>} dam olish kunlari ro'yxati
 */
async function getHolidays() {
  const holidays = await Holiday.find()
    .populate("createdBy", "firstName lastName")
    .sort({ createdAt: -1 });

  return holidays;
}

/**
 * Yangi dam olish kuni yaratish.
 * @param {object} data - dam olish kuni ma'lumotlari
 * @param {string} data.name - nomi
 * @param {string} [data.description] - tavsif
 * @param {string} data.type - turi (single, range, recurring)
 * @param {string} [data.date] - sana (single turi uchun)
 * @param {string} [data.startDate] - boshlanish sanasi (range turi uchun)
 * @param {string} [data.endDate] - tugash sanasi (range turi uchun)
 * @param {object} [data.recurringDate] - takrorlanuvchi sana
 * @param {object} [data.recurringStartDate] - takrorlanuvchi boshlanish
 * @param {object} [data.recurringEndDate] - takrorlanuvchi tugash
 * @param {boolean} [data.isActive] - faollik holati
 * @param {string} createdBy - yaratuvchi foydalanuvchi ID
 * @returns {Promise<object>} yaratilgan dam olish kuni
 */
async function createHoliday(data, createdBy) {
  const {
    name,
    description,
    type,
    date,
    startDate,
    endDate,
    recurringDate,
    recurringStartDate,
    recurringEndDate,
    isActive,
  } = data;

  if (!name || !type) {
    throw new BadRequestError("Nom va turi majburiy");
  }

  if (type === "single" && !date) {
    throw new BadRequestError("Bir kunlik dam olish uchun sana majburiy");
  }

  if (type === "range" && (!startDate || !endDate)) {
    throw new BadRequestError(
      "Vaqt oralig'i uchun boshlanish va tugash sanasi majburiy",
    );
  }

  if (type === "recurring") {
    const hasRecurringDate =
      recurringDate &&
      recurringDate.month !== undefined &&
      recurringDate.day !== undefined;
    const hasRecurringRange =
      recurringStartDate &&
      recurringEndDate &&
      recurringStartDate.month !== undefined &&
      recurringEndDate.month !== undefined;

    if (!hasRecurringDate && !hasRecurringRange) {
      throw new BadRequestError(
        "Takrorlanuvchi dam olish uchun sana yoki oraliq kiritish majburiy",
      );
    }
  }

  const holiday = await Holiday.create({
    name,
    description,
    type,
    date,
    startDate,
    endDate,
    recurringDate,
    recurringStartDate,
    recurringEndDate,
    isActive: isActive !== undefined ? isActive : true,
    createdBy,
  });

  return holiday;
}

/**
 * Dam olish kunini yangilash.
 * @param {string} id - dam olish kuni ID
 * @param {object} data - yangilash ma'lumotlari
 * @returns {Promise<object>} yangilangan dam olish kuni
 */
async function updateHoliday(id, data) {
  const holiday = await Holiday.findByIdAndUpdate(id, data, {
    new: true,
    runValidators: true,
  });

  if (!holiday) {
    throw new NotFoundError("Dam olish kuni topilmadi");
  }

  return holiday;
}

/**
 * Dam olish kunini o'chirish.
 * @param {string} id - dam olish kuni ID
 * @returns {Promise<void>}
 */
async function deleteHoliday(id) {
  const holiday = await Holiday.findByIdAndDelete(id);

  if (!holiday) {
    throw new NotFoundError("Dam olish kuni topilmadi");
  }
}

/**
 * Bugun dam olish kuni ekanligini tekshirish.
 * @returns {Promise<object>} tekshirish natijasi
 */
async function checkToday() {
  const result = await Holiday.isHoliday(new Date());
  return result;
}

/**
 * Berilgan sanani dam olish kuni ekanligini tekshirish.
 * @param {string} date - tekshiriladigan sana
 * @returns {Promise<object>} tekshirish natijasi
 */
async function checkDate(date) {
  const result = await Holiday.isHoliday(new Date(date));
  return result;
}

module.exports = {
  getHolidays,
  createHoliday,
  updateHoliday,
  deleteHoliday,
  checkToday,
  checkDate,
};
