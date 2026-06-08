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

// Muzlatilgan savol variantining snapshot'i (o'quvchiga shu tartibda ko'rsatiladi)
const frozenOptionSchema = new mongoose.Schema(
  {
    // Savol bankidagi original variant _id si
    optionId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    text: { type: String },
    image: { type: attachmentSchema, default: null },
  },
  { _id: false },
);

// Session boshlanganda muzlatiladigan savol snapshot'i
const frozenQuestionSchema = new mongoose.Schema({
  // Savol bankidagi savolga havola (proveniyans uchun)
  question: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Question",
    required: true,
  },
  type: {
    type: String,
    enum: ["standard", "open"],
    required: true,
  },
  text: { type: String },
  image: { type: attachmentSchema, default: null },
  // Qiyinlik darajasi (ball taqsimoti uchun) va undan hisoblangan ball (float)
  difficulty: {
    type: String,
    enum: ["easy", "medium", "hard"],
    default: "medium",
  },
  points: { type: Number, default: 0 },
  // Aralashtirilgan tartibdagi variantlar (isCorrect bu yerda saqlanmaydi)
  options: {
    type: [frozenOptionSchema],
    default: [],
  },
  // Muzlatilgan javob kaliti - o'quvchiga hech qachon yuborilmaydi
  correctOptionId: {
    type: mongoose.Schema.Types.ObjectId,
    select: false,
    default: null,
  },
});

// O'quvchi kiritgan javob
const answerSchema = new mongoose.Schema({
  // questions[].question ga havola qiladi
  question: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  // Variantli savol uchun tanlangan variant
  selectedOptionId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  // Ochiq savol uchun matnli javob
  textAnswer: {
    type: String,
    trim: true,
    maxlength: [8192, "Javob maksimal 8192 ta belgidan iborat bo'lishi kerak"],
  },
  answeredAt: {
    type: Date,
    default: Date.now,
  },
});

const testSessionSchema = new mongoose.Schema(
  {
    // V3: sessiya endi biriktirish (TestBinding) orqali boshlanadi
    binding: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TestBinding",
      required: [true, "Biriktirish majburiy"],
    },
    test: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Test",
      required: [true, "Test majburiy"],
    },
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "O'quvchi majburiy"],
    },
    // Tezkor mavsum so'rovlari uchun denormalizatsiya
    season: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TestSeason",
      required: [true, "Mavsum majburiy"],
    },
    // Urinish raqami (o'qituvchi qayta urinishga ruxsat berganda oshadi)
    attemptNumber: {
      type: Number,
      default: 1,
    },
    // Session holati: 'in_progress' - jarayonda, 'submitted' - topshirilgan, 'expired' - vaqti tugagan
    status: {
      type: String,
      enum: ["in_progress", "submitted", "expired"],
      default: "in_progress",
    },
    startedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    // startedAt + test.timeLimitMinutes
    expiresAt: {
      type: Date,
      required: [true, "Tugash vaqti majburiy"],
    },
    submittedAt: {
      type: Date,
    },
    // Sessiya muzlatilgan paytdagi ball shkalasi (keyin sozlama o'zgarsa ham barqaror)
    gradingMin: { type: Number },
    gradingMax: { type: Number },
    // Session boshlanganda muzlatilgan savollar snapshot'i
    questions: {
      type: [frozenQuestionSchema],
      default: [],
    },
    // O'quvchi kiritgan javoblar
    answers: {
      type: [answerSchema],
      default: [],
    },
  },
  { timestamps: true },
);

// V3: Bir o'quvchi bir biriktiruv uchun bir urinish raqamida bitta session
testSessionSchema.index(
  { binding: 1, student: 1, attemptNumber: 1 },
  { unique: true },
);
testSessionSchema.index({ student: 1, season: 1 });
testSessionSchema.index({ binding: 1 });
testSessionSchema.index({ test: 1 });
// Cron job uchun: vaqti tugagan ochiq sessiyalarni topish
testSessionSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model("TestSession", testSessionSchema);
