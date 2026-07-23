const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");

/**
 * Berilgan sana dam olish kuniga to'g'ri kelishini tekshirish.
 * (Mongoose Holiday.isHoliday static'i o'rnini bosadi.)
 * @param {Date} date - Tekshiriladigan sana
 * @returns {Promise<{isHoliday: boolean, holiday: Object|null}>}
 */
async function isHoliday(date) {
  const checkDate = new Date(date);
  checkDate.setHours(0, 0, 0, 0);

  const holidays = await prisma.holiday.findMany({ where: { isActive: true } });

  for (const holiday of holidays) {
    // Bir kunlik dam olish
    if (holiday.type === "single" && holiday.date) {
      const holidayDate = new Date(holiday.date);
      holidayDate.setHours(0, 0, 0, 0);
      if (holidayDate.getTime() === checkDate.getTime()) {
        return { isHoliday: true, holiday };
      }
    }

    // Vaqt oralig'i
    if (holiday.type === "range" && holiday.startDate && holiday.endDate) {
      const start = new Date(holiday.startDate);
      const end = new Date(holiday.endDate);
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);

      if (checkDate >= start && checkDate <= end) {
        return { isHoliday: true, holiday };
      }
    }

    // Har yili takrorlanuvchi
    if (holiday.type === "recurring") {
      const month = checkDate.getMonth();
      const day = checkDate.getDate();

      // Bir kunlik takrorlanuvchi
      if (holiday.recurringDate && holiday.recurringDate.month !== undefined) {
        if (
          holiday.recurringDate.month === month &&
          holiday.recurringDate.day === day
        ) {
          return { isHoliday: true, holiday };
        }
      }

      // Oraliq takrorlanuvchi
      if (
        holiday.recurringStartDate &&
        holiday.recurringEndDate &&
        holiday.recurringStartDate.month !== undefined &&
        holiday.recurringEndDate.month !== undefined
      ) {
        const startMonth = holiday.recurringStartDate.month;
        const startDay = holiday.recurringStartDate.day;
        const endMonth = holiday.recurringEndDate.month;
        const endDay = holiday.recurringEndDate.day;

        // Yil o'tib ketadigan holat (masalan, dekabr - yanvar)
        if (startMonth > endMonth) {
          if (
            month > startMonth ||
            month < endMonth ||
            (month === startMonth && day >= startDay) ||
            (month === endMonth && day <= endDay)
          ) {
            return { isHoliday: true, holiday };
          }
        } else {
          // Oddiy holat
          const startCheck =
            month > startMonth || (month === startMonth && day >= startDay);
          const endCheck =
            month < endMonth || (month === endMonth && day <= endDay);

          if (startCheck && endCheck) {
            return { isHoliday: true, holiday };
          }
        }
      }
    }
  }

  return { isHoliday: false, holiday: null };
}

// createdBy — soft ref (FK emas), qo'lda yuklaymiz
async function attachCreators(holidays) {
  const creatorIds = [
    ...new Set(holidays.map((h) => h.createdBy).filter(Boolean)),
  ];
  if (creatorIds.length === 0) {
    return holidays.map((h) => ({ ...h, createdBy: null }));
  }
  const creators = await prisma.user.findMany({
    where: { id: { in: creatorIds } },
    select: { id: true, firstName: true, lastName: true },
  });
  const creatorMap = new Map(creators.map((c) => [c.id, c]));
  return holidays.map((h) => ({
    ...h,
    createdBy: creatorMap.get(h.createdBy) || null,
  }));
}

/**
 * Barcha dam olish kunlarini olish.
 * @returns {Promise<Array>} dam olish kunlari ro'yxati
 */
async function getHolidays() {
  const holidays = await prisma.holiday.findMany({
    orderBy: { createdAt: "desc" },
  });

  return attachCreators(holidays);
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

  const holiday = await prisma.holiday.create({
    data: {
      name,
      description,
      type,
      date: date ? new Date(date) : null,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      recurringDate: recurringDate ?? null,
      recurringStartDate: recurringStartDate ?? null,
      recurringEndDate: recurringEndDate ?? null,
      isActive: isActive !== undefined ? isActive : true,
      createdBy,
    },
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
  const existing = await prisma.holiday.findUnique({ where: { id } });

  if (!existing) {
    throw new NotFoundError("Dam olish kuni topilmadi");
  }

  const update = {};
  if (data.name !== undefined) update.name = data.name;
  if (data.description !== undefined) update.description = data.description;
  if (data.type !== undefined) update.type = data.type;
  if (data.date !== undefined) update.date = data.date ? new Date(data.date) : null;
  if (data.startDate !== undefined)
    update.startDate = data.startDate ? new Date(data.startDate) : null;
  if (data.endDate !== undefined)
    update.endDate = data.endDate ? new Date(data.endDate) : null;
  if (data.recurringDate !== undefined) update.recurringDate = data.recurringDate;
  if (data.recurringStartDate !== undefined)
    update.recurringStartDate = data.recurringStartDate;
  if (data.recurringEndDate !== undefined)
    update.recurringEndDate = data.recurringEndDate;
  if (data.isActive !== undefined) update.isActive = data.isActive;
  if (data.createdBy !== undefined) update.createdBy = data.createdBy;

  const holiday = await prisma.holiday.update({ where: { id }, data: update });

  return holiday;
}

/**
 * Dam olish kunini o'chirish.
 * @param {string} id - dam olish kuni ID
 * @returns {Promise<void>}
 */
async function deleteHoliday(id) {
  const holiday = await prisma.holiday.findUnique({ where: { id } });

  if (!holiday) {
    throw new NotFoundError("Dam olish kuni topilmadi");
  }

  await prisma.holiday.delete({ where: { id } });
}

/**
 * Bugun dam olish kuni ekanligini tekshirish.
 * @returns {Promise<object>} tekshirish natijasi
 */
async function checkToday() {
  const result = await isHoliday(new Date());
  return result;
}

/**
 * Berilgan sanani dam olish kuni ekanligini tekshirish.
 * @param {string} date - tekshiriladigan sana
 * @returns {Promise<object>} tekshirish natijasi
 */
async function checkDate(date) {
  const result = await isHoliday(new Date(date));
  return result;
}

module.exports = {
  getHolidays,
  createHoliday,
  updateHoliday,
  deleteHoliday,
  checkToday,
  checkDate,
  isHoliday,
};
