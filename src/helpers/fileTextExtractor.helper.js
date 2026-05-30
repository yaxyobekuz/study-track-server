// PDF/Word/matn fayllardan matn ajratish (AI savol generatsiyasi uchun kontekst)
const { PDFParse } = require("pdf-parse");
const mammoth = require("mammoth");

// AI ga yuboriladigan matnning maksimal uzunligi (token limitidan himoya)
const MAX_TEXT_LENGTH = 12000;

const PDF_MIME = "application/pdf";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TXT_MIME = "text/plain";

/**
 * Berilgan mime turi matn ajratish uchun qo'llab-quvvatlanishini tekshiradi.
 * @param {string} mimeType Fayl mime turi.
 * @returns {boolean} Qo'llab-quvvatlansa true.
 */
function isExtractableTextMime(mimeType) {
  return mimeType === PDF_MIME || mimeType === DOCX_MIME || mimeType === TXT_MIME;
}

/**
 * Berilgan mime turi rasm ekanligini tekshiradi (Vision uchun).
 * @param {string} mimeType Fayl mime turi.
 * @returns {boolean} Rasm bo'lsa true.
 */
function isImageMime(mimeType) {
  return typeof mimeType === "string" && mimeType.startsWith("image/");
}

/**
 * Fayl buferidan oddiy matn ajratadi (PDF, .docx yoki .txt).
 * Qo'llab-quvvatlanmaydigan turlar uchun bo'sh string qaytaradi.
 * @param {object} params
 * @param {Buffer} params.buffer Fayl buferi.
 * @param {string} params.mimeType Fayl mime turi.
 * @returns {Promise<string>} Ajratilgan matn (kesilgan bo'lishi mumkin).
 */
async function extractTextFromBuffer({ buffer, mimeType }) {
  if (!buffer || buffer.length === 0) return "";

  let text = "";

  if (mimeType === PDF_MIME) {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      text = result.text || "";
    } finally {
      await parser.destroy();
    }
  } else if (mimeType === DOCX_MIME) {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value || "";
  } else if (mimeType === TXT_MIME) {
    text = buffer.toString("utf-8");
  } else {
    return "";
  }

  return text.trim().slice(0, MAX_TEXT_LENGTH);
}

module.exports = {
  MAX_TEXT_LENGTH,
  isExtractableTextMime,
  isImageMime,
  extractTextFromBuffer,
};
