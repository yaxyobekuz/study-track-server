const mongoose = require("mongoose");

const marketProductSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Mahsulot nomi majburiy"],
      trim: true,
      maxlength: [128, "Mahsulot nomi maksimal 128 ta belgidan iborat bo'lishi kerak"],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [2000, "Tavsif maksimal 2000 ta belgidan iborat bo'lishi kerak"],
      default: "",
    },
    price: {
      type: Number,
      required: [true, "Mahsulot narxi majburiy"],
      min: [1, "Mahsulot narxi 1 coindan kam bo'lishi mumkin emas"],
    },
    quantity: {
      type: Number,
      required: [true, "Mahsulot soni majburiy"],
      min: [0, "Mahsulot soni manfiy bo'lishi mumkin emas"],
    },
    images: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Image" }],
      validate: [
        {
          validator: function (value) {
            return Array.isArray(value) && value.length >= 1;
          },
          message: "Kamida 1 ta rasm bo'lishi kerak",
        },
        {
          validator: function (value) {
            return Array.isArray(value) && value.length <= 3;
          },
          message: "Maksimal 3 ta rasm yuklash mumkin",
        },
      ],
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    isArchived: {
      type: Boolean,
      default: false,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    archivedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

marketProductSchema.index({ isArchived: 1, isActive: 1, createdAt: -1 });
marketProductSchema.index({ quantity: 1, createdAt: -1 });

module.exports = mongoose.model("MarketProduct", marketProductSchema);
