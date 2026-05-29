// Mongoose
const mongoose = require("mongoose");

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
    // Mavsum holati: 'draft' - tayyorlanmoqda, 'active' - faol, 'closed' - yopilgan
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
    // Absolyut chegaralar - admin tomonidan belgilanadi.
    // Masalan: { name: 'Oltin', minScore: 500, coinReward: 100 }
    absoluteTiers: [
      {
        name: { type: String, required: true, trim: true },
        minScore: { type: Number, required: true, min: 0 },
        coinReward: { type: Number, required: true, min: 0 },
      },
    ],
    // Sinf bo'yicha o'rin (top-N) chegaralari.
    // Masalan: { class: ObjectId, position: 1, coinReward: 50 }
    classTiers: [
      {
        class: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Class",
          required: true,
        },
        position: { type: Number, required: true, min: 1 },
        coinReward: { type: Number, required: true, min: 0 },
        createdBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
      },
    ],
    // Tarqatish holatini kuzatish (idempotentlik uchun)
    distributedAt: { type: Date },
    distributedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

testSeasonSchema.index({ status: 1, startDate: 1 });
testSeasonSchema.index({ startDate: 1, endDate: 1 });

// Tugash sanasi boshlanish sanasidan keyin bo'lishi kerak
testSeasonSchema.pre("save", function (next) {
  if (this.endDate <= this.startDate) {
    return next(
      new Error("Tugash sanasi boshlanish sanasidan keyin bo'lishi kerak"),
    );
  }
  next();
});

module.exports = mongoose.model("TestSeason", testSeasonSchema);
