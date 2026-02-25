const mongoose = require("mongoose");

const marketOrderHistorySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "cancelled"],
      required: true,
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    note: {
      type: String,
      trim: true,
      maxlength: 512,
      default: "",
    },
    changedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
  },
  { _id: false },
);

const marketOrderSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "O'quvchi majburiy"],
      index: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MarketProduct",
      required: [true, "Mahsulot majburiy"],
      index: true,
    },
    quantity: {
      type: Number,
      required: [true, "Soni majburiy"],
      min: [1, "Soni kamida 1 bo'lishi kerak"],
    },
    unitPrice: {
      type: Number,
      required: [true, "Birlik narx majburiy"],
      min: [1, "Birlik narx kamida 1 bo'lishi kerak"],
    },
    totalPrice: {
      type: Number,
      required: [true, "Jami narx majburiy"],
      min: [1, "Jami narx kamida 1 bo'lishi kerak"],
    },
    productSnapshot: {
      name: {
        type: String,
        required: true,
        trim: true,
      },
      description: {
        type: String,
        default: "",
        trim: true,
      },
      imageUrl: {
        type: String,
        default: "",
        trim: true,
      },
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "cancelled"],
      default: "pending",
      index: true,
    },
    rejectReason: {
      type: String,
      default: "",
      trim: true,
      maxlength: [512, "Rad etish sababi maksimal 512 ta belgi bo'lishi kerak"],
    },
    statusHistory: {
      type: [marketOrderHistorySchema],
      default: [],
    },
  },
  { timestamps: true },
);

marketOrderSchema.index({ student: 1, createdAt: -1 });
marketOrderSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("MarketOrder", marketOrderSchema);
