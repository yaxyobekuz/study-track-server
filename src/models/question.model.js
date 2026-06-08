// Mongoose
const mongoose = require("mongoose");

// Yuklangan fayl (rasm) uchun embedded sub-schema
const attachmentSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    url: { type: String, required: true },
    type: { type: String, default: "image" },
    originalName: { type: String },
    sizeBytes: { type: Number },
  },
  { _id: false },
);

// Variantli savol uchun javob varianti
const optionSchema = new mongoose.Schema({
  text: {
    type: String,
    trim: true,
    maxlength: [1024, "Variant matni maksimal 1024 ta belgidan iborat bo'lishi kerak"],
  },
  image: {
    type: attachmentSchema,
    default: null,
  },
  isCorrect: {
    type: Boolean,
    default: false,
  },
});

const questionSchema = new mongoose.Schema(
  {
    // Savol qaysi testga tegishli
    test: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Test",
      required: [true, "Test majburiy"],
    },
    // Savol turi: 'standard' - variantli, 'open' - ochiq (matnli javob)
    type: {
      type: String,
      enum: ["standard", "open"],
      required: [true, "Savol turi majburiy"],
    },
    text: {
      type: String,
      trim: true,
      maxlength: [4096, "Savol matni maksimal 4096 ta belgidan iborat bo'lishi kerak"],
    },
    image: {
      type: attachmentSchema,
      default: null,
    },
    // Savol qiyinlik darajasi: 'easy' - oson, 'medium' - o'rta, 'hard' - qiyin.
    // Ball shu daraja asosida sessiya muzlatilganda avtomatik taqsimlanadi.
    difficulty: {
      type: String,
      enum: ["easy", "medium", "hard"],
      default: "medium",
    },
    // Eski ma'lumotlar uchun saqlangan (endi qo'lda kiritilmaydi; ball
    // sessiya muzlatilganda qiyinlik darajasiga qarab hisoblanadi).
    points: {
      type: Number,
      default: 0,
      min: [0, "Ball manfiy bo'lishi mumkin emas"],
    },
    // Faqat 'standard' tur uchun javob variantlari
    options: {
      type: [optionSchema],
      default: [],
    },
    // Savollar tartibi (UI da ko'rinish tartibi)
    order: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

questionSchema.index({ test: 1, order: 1 });
questionSchema.index({ test: 1, isActive: 1 });

/**
 * Savol turi va mazmunini tekshiradi
 * - standard: 2..99 variant va aynan bitta to'g'ri variant
 * - har savol/variant matn YOKI rasmga ega bo'lishi kerak
 * - open: variant bo'lmasligi kerak
 */
questionSchema.pre("save", function (next) {
  // Savolning o'zi matn yoki rasmga ega bo'lishi kerak
  if (!this.text && !this.image) {
    return next(new Error("Savol matn yoki rasmga ega bo'lishi kerak"));
  }

  if (this.type === "open") {
    if (this.options && this.options.length > 0) {
      return next(new Error("Ochiq turdagi savolda variant bo'lmasligi kerak"));
    }
    return next();
  }

  // type === "standard"
  if (!this.options || this.options.length < 2) {
    return next(new Error("Variantli savolda kamida 2 ta variant bo'lishi kerak"));
  }

  if (this.options.length > 99) {
    return next(new Error("Variantli savolda ko'pi bilan 99 ta variant bo'lishi mumkin"));
  }

  const correctCount = this.options.filter((opt) => opt.isCorrect).length;
  if (correctCount !== 1) {
    return next(new Error("Variantli savolda aynan bitta to'g'ri variant bo'lishi kerak"));
  }

  for (const opt of this.options) {
    if (!opt.text && !opt.image) {
      return next(new Error("Har bir variant matn yoki rasmga ega bo'lishi kerak"));
    }
  }

  next();
});

module.exports = mongoose.model("Question", questionSchema);
