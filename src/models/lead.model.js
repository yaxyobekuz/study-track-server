const mongoose = require("mongoose");

const LEAD_STATUSES = [
  "new",
  "contacted",
  "interested",
  "visited",
  "trial",
  "negotiation",
  "enrolled",
  "rejected",
  "lost",
  "postponed",
];

const leadSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: [true, "Ism majburiy"],
      trim: true,
      maxlength: [128, "Ism maksimal 128 ta belgidan iborat bo'lishi kerak"],
    },
    lastName: {
      type: String,
      required: [true, "Familiya majburiy"],
      trim: true,
      maxlength: [128, "Familiya maksimal 128 ta belgidan iborat bo'lishi kerak"],
    },
    phone: {
      type: String,
      required: [true, "Telefon raqam majburiy"],
      trim: true,
      maxlength: [20, "Telefon raqam maksimal 20 ta belgidan iborat bo'lishi kerak"],
    },
    additionalPhone: {
      type: String,
      trim: true,
      maxlength: [20, "Telefon raqam maksimal 20 ta belgidan iborat bo'lishi kerak"],
    },
    source: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LeadSource",
      required: [true, "Manba majburiy"],
    },
    status: {
      type: String,
      enum: LEAD_STATUSES,
      default: "new",
    },
    classInterest: {
      type: String,
      trim: true,
      maxlength: [100, "Sinf/yosh guruhi maksimal 100 ta belgidan iborat bo'lishi kerak"],
    },
    parentName: {
      type: String,
      trim: true,
      maxlength: [128, "Ota-ona ismi maksimal 128 ta belgidan iborat bo'lishi kerak"],
    },
    parentPhone: {
      type: String,
      trim: true,
      maxlength: [20, "Telefon raqam maksimal 20 ta belgidan iborat bo'lishi kerak"],
    },
    address: {
      type: String,
      trim: true,
      maxlength: [300, "Manzil maksimal 300 ta belgidan iborat bo'lishi kerak"],
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [2000, "Izoh maksimal 2000 ta belgidan iborat bo'lishi kerak"],
    },
    expectedEnrollDate: {
      type: Date,
    },
    lostReason: {
      type: String,
      trim: true,
      maxlength: [500, "Sabab maksimal 500 ta belgidan iborat bo'lishi kerak"],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

// Virtual field - full name
leadSchema.virtual("fullName").get(function () {
  return `${this.firstName} ${this.lastName}`;
});

leadSchema.set("toJSON", { virtuals: true });
leadSchema.set("toObject", { virtuals: true });

// Indexes
leadSchema.index({ status: 1, source: 1, createdAt: -1 });
leadSchema.index({ phone: 1 });
leadSchema.index({ createdBy: 1 });

module.exports = mongoose.model("Lead", leadSchema);
module.exports.LEAD_STATUSES = LEAD_STATUSES;
