const { v4: uuidv4 } = require("uuid");
const path = require("path");
const { uploadBuffer, deleteObject } = require("./fileStorage.service");

/**
 * Fayl turini MIME type asosida aniqlaydi
 * @param {string} mimeType - Fayl MIME turi
 * @returns {"image"|"video"|"document"} Fayl kategoriyasi
 */
const getFileCategory = (mimeType) => {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
};

/**
 * DO Spaces uchun unikal key yaratadi
 * @param {string} mimeType - Fayl MIME turi
 * @param {string} originalName - Original fayl nomi
 * @returns {string} S3 object key
 */
const generateFileKey = (mimeType, originalName) => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const ext = path.extname(originalName).toLowerCase() || ".bin";
  const category = getFileCategory(mimeType);

  return `files/${year}/${month}/${category}/${uuidv4()}${ext}`;
};

/**
 * Bitta faylni DO Spaces ga yuklaydi
 * @param {object} params - Yuklash parametrlari
 * @param {Buffer} params.buffer - Fayl content
 * @param {string} params.mimeType - MIME type
 * @param {string} params.originalName - Original fayl nomi
 * @returns {Promise<{key: string, url: string, type: string, originalName: string, sizeBytes: number}>}
 */
const uploadFile = async ({ buffer, mimeType, originalName }) => {
  const key = generateFileKey(mimeType, originalName);

  const result = await uploadBuffer({
    key,
    buffer,
    contentType: mimeType,
  });

  return {
    key: result.key,
    url: result.url,
    type: getFileCategory(mimeType),
    originalName,
    sizeBytes: result.size,
  };
};

/**
 * Bir nechta ilova faylni yuklaydi (rasm/video/pdf).
 *
 * Nomi ATAYLAB neytral: ilova fayllar jarimada ham, inventar zararida ham
 * bir xil shaklda saqlanadi (`attachments[]` — { key, url, type,
 * originalName, sizeBytes }). Ikkita bir xil yuklovchi yozilsa, biriga
 * qo'shilgan tozalash mantig'i ikkinchisida yo'q bo'lib qolardi.
 *
 * @param {Array} files - Multer fayl massivi
 * @returns {Promise<Array<{key: string, url: string, type: string, originalName: string, sizeBytes: number}>>}
 */
const uploadAttachments = async (files) => {
  if (!files || files.length === 0) return [];

  const uploaded = [];

  try {
    for (const file of files) {
      const result = await uploadFile({
        buffer: file.buffer,
        mimeType: file.mimetype,
        originalName: file.originalname,
      });
      uploaded.push(result);
    }
    return uploaded;
  } catch (error) {
    // Xatolik bo'lsa, yuklangan fayllarni tozalash
    await Promise.allSettled(
      uploaded.map((attachment) => deleteObject(attachment.key)),
    );
    throw error;
  }
};

/**
 * Ilova fayllarni saqlashdan o'chiradi.
 * @param {Array} attachments - Attachment massivi
 * @returns {Promise<void>}
 */
const deleteAttachments = async (attachments) => {
  if (!attachments || attachments.length === 0) return;

  await Promise.allSettled(
    attachments.map((attachment) => deleteObject(attachment.key)),
  );
};

module.exports = {
  uploadFile,
  uploadAttachments,
  deleteAttachments,
  // Eski nomlar — `penalty.service.js` shular bilan chaqiradi. Yangi kodda
  // neytral nomlar ishlatiladi (yuqoridagi izohga qarang).
  uploadPenaltyAttachments: uploadAttachments,
  deletePenaltyAttachments: deleteAttachments,
};
