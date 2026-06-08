// Mongoose
const mongoose = require("mongoose");
const { computeSeasonStatus } = require("../helpers/seasonStatus.helper");

const testSeasonSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Mavsum nomi majburiy"],
      trim: true,
      maxlength: [128, "Nom maksimal 128 ta belgidan iborat bo'lishi kerak"],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [512, "Tavsif maksimal 512 ta belgidan iborat bo'lishi kerak"],
    },
    startDate: {
      type: Date,
      required: [true, "Boshlanish sanasi majburiy"],
    },
    endDate: {
      type: Date,
      required: [true, "Tugash sanasi majburiy"],
    },
    // Mavsum holati - sanalardan avtomatik hisoblanadi (qo'lda belgilanmaydi):
    // 'draft' - kutilmoqda, 'active' - faol, 'closed' - yakunlangan.
    // pre-save hook va seasonStatus cron joriy holatda saqlaydi.
    status: {
      type: String,
      enum: ["draft", "active", "closed"],
      default: "draft",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    // Maktab bo'yicha o'rin (top-N) mukofotlari.
    // Masalan: { position: 1, coinReward: 100, note: 'Tabriklaymiz!' }
    schoolTiers: [
      {
        position: { type: Number, required: true, min: 1 },
        coinReward: { type: Number, required: true, min: 0 },
        note: { type: String, trim: true, maxlength: 512 },
      },
    ],
    // Sinf bo'yicha o'rin (top-N) mukofotlari - UMUMIY, har bir sinfga qo'llanadi.
    // Masalan: { position: 1, coinReward: 50, note: '...' } - har sinfning 1-o'rni.
    classTiers: [
      {
        position: { type: Number, required: true, min: 1 },
        coinReward: { type: Number, required: true, min: 0 },
        note: { type: String, trim: true, maxlength: 512 },
      },
    ],
    // Tarqatish holatini kuzatish (idempotentlik uchun)
    distributedAt: { type: Date },
    distributedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    // To'liq yakunlash (admin tasdig'i) - sanaviy "closed" dan alohida.
    // Belgilangach o'quvchilar test ishlay olmaydi va natijalar tarqatiladi.
    finalizedAt: { type: Date },
    finalizedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

testSeasonSchema.index({ status: 1, startDate: 1 });
testSeasonSchema.index({ startDate: 1, endDate: 1 });

// Tugash sanasi boshlanish sanasidan keyin bo'lishi kerak hamda
// holatni sanalardan avtomatik hisoblash
testSeasonSchema.pre("save", function (next) {
  if (this.endDate <= this.startDate) {
    return next(
      new Error("Tugash sanasi boshlanish sanasidan keyin bo'lishi kerak"),
    );
  }
  this.status = computeSeasonStatus(this.startDate, this.endDate);
  next();
});

module.exports = mongoose.model("TestSeason", testSeasonSchema);
