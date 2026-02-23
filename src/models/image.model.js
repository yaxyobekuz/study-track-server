const mongoose = require("mongoose");

const imageVariantSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    width: {
      type: Number,
      required: true,
      min: 1,
    },
    height: {
      type: Number,
      required: true,
      min: 1,
    },
    sizeBytes: {
      type: Number,
      required: true,
      min: 1,
    },
    reusedOriginal: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false },
);

const imageSchema = new mongoose.Schema(
  {
    originalName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
    },
    mimeType: {
      type: String,
      required: true,
      trim: true,
    },
    extension: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    originalSizeBytes: {
      type: Number,
      required: true,
      min: 1,
    },
    variants: {
      original: {
        type: imageVariantSchema,
        required: true,
      },
      sm: {
        type: imageVariantSchema,
        required: true,
      },
      md: {
        type: imageVariantSchema,
        required: true,
      },
      lg: {
        type: imageVariantSchema,
        required: true,
      },
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);

imageSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Image", imageSchema);
