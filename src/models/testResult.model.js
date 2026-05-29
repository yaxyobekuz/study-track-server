// Mongoose
const mongoose = require("mongoose");

// Qo'shimcha ball yozuvi (har doim qo'lda qo'shiladi)
const extraPointsSchema = new mongoose.Schema(
  {
    amount: {
      type: Number,
      required: [true, "Ball miqdori majburiy"],
    },
    reason: {
      type: String,
      required: [true, "Qo'shimcha ball sababi majburiy"],
      trim: true,
      maxlength: [512, "Sabab maksimal 512 ta belgidan iborat bo'lishi kerak"],
    },
    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    addedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false },
);

// Har bir savol bo'yicha baholash tafsiloti
const perQuestionSchema = new mongoose.Schema(
  {
    // Session questions[].question ga havola
    question: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    awardedPoints: {
      type: Number,
      default: 0,
    },
    maxPoints: {
      type: Number,
      required: true,
    },
    gradedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // 'pending' - baholanmagan (ochiq savol), 'graded' - baholangan
    status: {
      type: String,
      enum: ["pending", "graded"],
      default: "graded",
    },
    feedback: {
      type: String,
      trim: true,
      maxlength: [1024, "Izoh maksimal 1024 ta belgidan iborat bo'lishi kerak"],
    },
  },
  { _id: false },
);

const testResultSchema = new mongoose.Schema(
  {
    session: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TestSession",
      required: [true, "Session majburiy"],
      unique: true,
    },
    // V3: sessiya orqali biriktirishga havola
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
    season: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TestSeason",
      required: [true, "Mavsum majburiy"],
    },
    // Hisobot uchun denormalizatsiya (V3: o'quvchining hisobotdagi sinfi - bindingdan)
    class: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
    },
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: true,
    },
    // Variantli savollardan avtomatik yig'ilgan ball
    autoGradedScore: {
      type: Number,
      default: 0,
    },
    // Ochiq savollar uchun o'qituvchi qo'ygan ball yig'indisi
    manualGradedScore: {
      type: Number,
      default: 0,
    },
    // Qo'lda qo'shilgan qo'shimcha ballar
    extraPoints: {
      type: [extraPointsSchema],
      default: [],
    },
    // clamp(autoGradedScore + manualGradedScore + ΣextraPoints, test.minScore, test.maxScore)
    finalScore: {
      type: Number,
      default: 0,
    },
    // Har bir savol bo'yicha baholash tafsiloti
    perQuestion: {
      type: [perQuestionSchema],
      default: [],
    },
    // Natija holati: 'pending' - baholanmagan, 'partially_graded' - qisman, 'graded' - to'liq
    status: {
      type: String,
      enum: ["pending", "partially_graded", "graded"],
      default: "pending",
    },
  },
  { timestamps: true },
);

testResultSchema.index({ test: 1 });
testResultSchema.index({ binding: 1 });
testResultSchema.index({ student: 1, season: 1 });
testResultSchema.index({ status: 1 });
testResultSchema.index({ season: 1, subject: 1 });

module.exports = mongoose.model("TestResult", testResultSchema);
