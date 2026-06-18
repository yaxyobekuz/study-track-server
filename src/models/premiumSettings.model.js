const mongoose = require("mongoose");

// Premium foydalanuvchilar uchun ruxsat etilgan ism ranglari (default)
const DEFAULT_NAME_COLORS = [
  { key: "blue", label: "Ko'k", hex: "#3b82f6", isActive: true },
  { key: "purple", label: "Binafsha", hex: "#a855f7", isActive: true },
  { key: "green", label: "Yashil", hex: "#22c55e", isActive: true },
  { key: "gold", label: "Oltin", hex: "#f59e0b", isActive: true },
  { key: "red", label: "Qizil", hex: "#ef4444", isActive: true },
  { key: "pink", label: "Pushti", hex: "#ec4899", isActive: true },
];

const nameColorSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    hex: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { _id: false },
);

const premiumSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "singleton" },
    // Premium umuman yoqilganmi (o'chirilsa o'quvchilar sotib ololmaydi)
    isEnabled: {
      type: Boolean,
      default: true,
    },
    // Bir martalik premium narxi (tanga)
    coinCost: {
      type: Number,
      default: 100,
      min: [0, "Narx manfiy bo'lishi mumkin emas"],
    },
    // Obuna muddati (kun)
    durationDays: {
      type: Number,
      default: 30,
      min: [1, "Muddat kamida 1 kun bo'lishi kerak"],
    },
    // Ruxsat etilgan ism ranglari
    allowedNameColors: {
      type: [nameColorSchema],
      default: DEFAULT_NAME_COLORS,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

/**
 * Singleton sozlamalarni olish yoki yaratish.
 * @returns {Promise<Document>} PremiumSettings hujjati
 */
premiumSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findById("singleton");
  if (!settings) {
    settings = await this.create({ _id: "singleton" });
  }

  // Eski hujjatlarda ranglar bo'lmasa, default bilan to'ldirish
  if (!settings.allowedNameColors || settings.allowedNameColors.length === 0) {
    settings.allowedNameColors = DEFAULT_NAME_COLORS;
    await settings.save();
  }

  return settings;
};

premiumSettingsSchema.statics.DEFAULT_NAME_COLORS = DEFAULT_NAME_COLORS;

module.exports = mongoose.model("PremiumSettings", premiumSettingsSchema);
