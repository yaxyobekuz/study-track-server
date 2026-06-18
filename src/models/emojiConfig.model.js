const mongoose = require("mongoose");

const emojiConfigSchema = new mongoose.Schema(
  {
    // Emoji nomi (admin tomonidan kiritiladi)
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // S3 (DigitalOcean Spaces) dagi lottie-react .json fayl URL manzili
    animationUrl: {
      type: String,
      required: true,
    },
    // S3 obyekt kaliti (o'chirish/almashtirish uchun)
    fileKey: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EmojiConfig", emojiConfigSchema);
