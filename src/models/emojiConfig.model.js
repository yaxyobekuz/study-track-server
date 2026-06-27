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

/**
 * Eski sxemadan qolib ketgan yetim indekslarni (masalan, `emojiId_1` UNIQUE)
 * o'chiradi. Yangi sxemada faqat `_id` indeksi kerak. Bu funksiya har bir
 * muhitda (localhost, prod) ishga tushishda chaqiriladi va o'zini-o'zi
 * tuzatadi - natijada "emojiId allaqachon mavjud" (E11000 null duplicate)
 * xatosi yo'qoladi.
 * @returns {Promise<void>}
 */
emojiConfigSchema.statics.dropLegacyIndexes = async function () {
  let indexes;
  try {
    indexes = await this.collection.indexes();
  } catch {
    // Kolleksiya hali yaratilmagan bo'lsa, indeks ham yo'q
    return;
  }

  for (const index of indexes) {
    if (index.name === "_id_") continue;
    try {
      await this.collection.dropIndex(index.name);
    } catch {
      // Indeks allaqachon yo'q bo'lsa, e'tiborsiz qoldiramiz
    }
  }
};

module.exports = mongoose.model("EmojiConfig", emojiConfigSchema);
