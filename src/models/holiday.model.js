// Mongoose
const mongoose = require("mongoose");

const holidaySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Bayram nomi majburiy"],
      trim: true,
      maxlength: [128, "Nom maksimal 128 ta belgidan iborat bo'lishi kerak"],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [512, "Tavsif maksimal 512 ta belgidan iborat bo'lishi kerak"],
    },
    // Dam olish turi: 'single' - bir kun, 'range' - oraliq, 'recurring' - har yili
    type: {
      type: String,
      enum: ["single", "range", "recurring"],
      required: [true, "Dam olish turi majburiy"],
    },
    // Bir kunlik uchun
    date: {
      type: Date,
    },
    // Oraliq uchun
    startDate: {
      type: Date,
    },
    endDate: {
      type: Date,
    },
    // Takrorlanuvchi uchun (har yili) - bir kunlik
    // Format: { month: 0-11, day: 1-31 }
    recurringDate: {
      month: { type: Number, min: 0, max: 11 },
      day: { type: Number, min: 1, max: 31 },
    },
    // Takrorlanuvchi oraliq uchun
    recurringStartDate: {
      month: { type: Number, min: 0, max: 11 },
      day: { type: Number, min: 1, max: 31 },
    },
    recurringEndDate: {
      month: { type: Number, min: 0, max: 11 },
      day: { type: Number, min: 1, max: 31 },
    },
    // Aktiv/noaktiv
    isActive: {
      type: Boolean,
      default: true,
    },
    // Kim yaratgan
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

/**
 * Berilgan sana dam olish kuniga to'g'ri kelishini tekshirish
 * @param {Date} date - Tekshiriladigan sana
 * @returns {Promise<{isHoliday: boolean, holiday: Object|null}>}
 */
holidaySchema.statics.isHoliday = async function (date) {
  const checkDate = new Date(date);
  checkDate.setHours(0, 0, 0, 0);

  const holidays = await this.find({ isActive: true });

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
};

module.exports = mongoose.model("Holiday", holidaySchema);
