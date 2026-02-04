const mongoose = require("mongoose");

/**
 * ClassSubjectProgress Model
 *
 * Har bir sinf + fan kombinatsiyasi uchun bitta mavzu raqamini saqlaydi.
 * Masalan: 1-B sinf + Rus tili = 5-mavzu (butun sinf uchun bitta)
 */
const classSubjectProgressSchema = new mongoose.Schema(
  {
    class: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
      required: true,
    },
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: true,
    },
    currentTopicNumber: {
      type: Number,
      default: 1,
      min: [1, "Mavzu raqami kamida 1 bo'lishi kerak"],
    },
  },
  { timestamps: true }
);

// Unique index - har bir sinf+fan uchun faqat bitta record
classSubjectProgressSchema.index({ class: 1, subject: 1 }, { unique: true });

module.exports = mongoose.model("ClassSubjectProgress", classSubjectProgressSchema);
