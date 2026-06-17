const mongoose = require("mongoose");

const TIME_REGEX = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * ScheduleSettings - dars jadvali uchun global standart vaqt sozlamalari (singleton).
 * `periods` - har bir dars tartibi (order) uchun standart boshlanish va tugash vaqtlari.
 * Frontend dars jadvalini tahrirlashda dars tartibi tanlanganda shu vaqtlarni
 * inputlarga avtomatik to'ldirish uchun ishlatadi.
 */
const periodSchema = new mongoose.Schema(
  {
    order: {
      type: Number,
      required: [true, "Dars tartibi majburiy"],
      min: [1, "Dars tartibi kamida 1 bo'lishi kerak"],
      max: [100, "Dars tartibi 100 dan katta bo'lishi mumkin emas"],
    },
    startTime: {
      type: String,
      required: [true, "Boshlanish vaqti majburiy"],
      match: [TIME_REGEX, "Vaqt formati noto'g'ri (HH:mm)"],
    },
    endTime: {
      type: String,
      required: [true, "Tugash vaqti majburiy"],
      match: [TIME_REGEX, "Vaqt formati noto'g'ri (HH:mm)"],
    },
  },
  { _id: false },
);

const scheduleSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "singleton" },
    periods: {
      type: [periodSchema],
      default: [],
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

scheduleSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findById("singleton");
  if (!settings) {
    settings = await this.create({ _id: "singleton" });
  }
  return settings;
};

module.exports = mongoose.model("ScheduleSettings", scheduleSettingsSchema);
