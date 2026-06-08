const mongoose = require("mongoose");

/**
 * TestSettings - test ball berish tizimining global sozlamalari (singleton).
 * minScore - o'tish bali (faqat o'tdi/yiqildi chizig'i, ballga qo'shilmaydi).
 * maxScore - test uchun maksimal ball; savollarga qiyinlik bo'yicha taqsimlanadi.
 */
const testSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "singleton" },
    minScore: {
      type: Number,
      default: 56,
      min: [0, "Minimal ball manfiy bo'lishi mumkin emas"],
    },
    maxScore: {
      type: Number,
      default: 189,
      min: [1, "Maksimal ball 0 dan katta bo'lishi kerak"],
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

// Maksimal ball minimaldan katta bo'lishi kerak
testSettingsSchema.pre("validate", function (next) {
  if (this.maxScore <= this.minScore) {
    return next(
      new Error("Maksimal ball minimal balldan katta bo'lishi kerak"),
    );
  }
  next();
});

testSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findById("singleton");
  if (!settings) {
    settings = await this.create({ _id: "singleton" });
  }
  return settings;
};

module.exports = mongoose.model("TestSettings", testSettingsSchema);
