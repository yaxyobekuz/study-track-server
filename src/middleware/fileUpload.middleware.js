const multer = require("multer");
const { config } = require("../config/env.config");
const { getBranch, runWithBranch } = require("../config/branchContext");

const FILE_MIME_TYPES = {
  image: ["image/jpeg", "image/jpg", "image/png", "image/webp"],
  video: ["video/mp4", "video/webm", "video/quicktime"],
  audio: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4"],
  document: [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain",
  ],
  // Lottie animatsiya (.json) fayllari
  json: ["application/json", "text/plain", "application/octet-stream"],
  // ⚠️ ALOHIDA TOIFA, `document` GA QO'SHILMAGAN. Import faqat jadval
  // qabul qiladi va `document` ga `text/csv` qo'shilsa, u xabar/premium
  // yuklashlarida ham jimgina ochilib ketardi — mavjud endpointlarning
  // qabul qiladigan fayllari kengayishi kerak emas.
  spreadsheet: [
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv",
    "application/csv",
  ],
};

/**
 * FILIAL KONTEKSTINI TIKLAYDI (multer'dan keyin MAJBURIY).
 *
 * Multer faylni `req` stream'idan busboy orqali o'qiydi. Stream hodisalari
 * so'rov emas, SOKET async resursidan keladi — u esa `runWithBranch()`
 * chaqirilishidan ANCHA OLDIN, ulanish paytida yaratilgan. Shu sababli
 * AsyncLocalStorage konteksti multer'ning tugash callback'iga tarqalmaydi
 * va undan keyingi butun zanjir (controller, service) filialsiz qoladi —
 * "Filial konteksti yo'q" xatosi aynan shundan chiqadi.
 *
 * Yechim: kontekstni yuklashdan OLDIN o'qib olamiz va `next()` ni o'sha
 * filial ichida chaqiramiz. Kontekstsiz kelgan so'rovda hech narsa
 * o'zgarmaydi.
 *
 * @param {Function} uploadMiddleware Multer middleware.
 * @returns {Function} Filial kontekstini tiklaydigan middleware.
 */
const withBranchContext = (uploadMiddleware) => (req, res, next) => {
  const branch = getBranch();

  uploadMiddleware(req, res, (err) => {
    if (!branch) return next(err);
    runWithBranch(branch, () => next(err));
  });
};

/**
 * Returns mime types for selected file categories.
 * @param {string[]} categories File categories.
 * @returns {string[]} Flattened mime type list.
 */
const getAllowedMimeTypes = (categories = []) => {
  const mimeTypes = categories.flatMap(
    (category) => FILE_MIME_TYPES[category] || [],
  );
  return [...new Set(mimeTypes)];
};

/**
 * Creates a single-file upload middleware with security limits.
 * @param {object} options Upload options.
 * @param {string} [options.fieldName=file] Multipart field name.
 * @param {string[]} [options.categories=["image"]] Allowed categories.
 * @returns {Function} Multer single-file middleware.
 */
const createSingleFileUpload = ({
  fieldName = "file",
  categories = ["image"],
} = {}) => {
  const maxFileSizeMb = config.maxUploadFileSizeMb;
  const maxFileSizeBytes = Math.max(1, maxFileSizeMb) * 1024 * 1024;
  const allowedMimeTypes = getAllowedMimeTypes(categories);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxFileSizeBytes, files: 1, fields: 30, parts: 31 },
    fileFilter: (req, file, cb) => {
      if (!allowedMimeTypes.includes(file.mimetype)) {
        return cb(new Error("Unsupported file type."), false);
      }
      cb(null, true);
    },
  });

  return withBranchContext(upload.single(fieldName));
};

/**
 * Creates a multi-file upload middleware with security limits.
 * @param {object} options Upload options.
 * @param {string} [options.fieldName=files] Multipart field name.
 * @param {string[]} [options.categories=["image"]] Allowed categories.
 * @param {number} [options.maxFiles=3] Maximum files count.
 * @returns {Function} Multer array middleware.
 */
const createMultiFileUpload = ({
  fieldName = "files",
  categories = ["image"],
  maxFiles = 3,
} = {}) => {
  const maxFileSizeMb = config.maxUploadFileSizeMb;
  const maxFileSizeBytes = Math.max(1, maxFileSizeMb) * 1024 * 1024;
  const allowedMimeTypes = getAllowedMimeTypes(categories);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxFileSizeBytes,
      files: Math.max(1, maxFiles),
      fields: 40,
      parts: 50,
    },
    fileFilter: (req, file, cb) => {
      if (!allowedMimeTypes.includes(file.mimetype)) {
        return cb(new Error("Unsupported file type."), false);
      }

      cb(null, true);
    },
  });

  return withBranchContext(upload.array(fieldName, Math.max(1, maxFiles)));
};

/**
 * Creates a MULTI-FIELD upload middleware (multer `.fields()`).
 *
 * ⚠️ `createMultiFileUpload` bitta maydonga bir nechta fayl oladi, bu esa
 * TURLI maydonlarga (masalan `questionImage` + `optionImage_0`,
 * `optionImage_1`) bittadan fayl oladi. Diagnostika savolida savolning
 * o'z rasmi ham, har bir variantning rasmi ham bo'lishi mumkin va ular
 * qaysi variantga tegishli ekani MAYDON NOMIDAN aniqlanadi — bitta
 * massivda tartibga tayanib bo'lmasdi (bo'sh variantlar tartibni suradi).
 *
 * ⚠️ `withBranchContext` MAJBURIY (bu fayldagi qolganlari bilan bir xil
 * sabab): busboy so'rovni soket async resursi orqali o'qiydi va u
 * `runWithBranch()` dan OLDIN yaratilgan — o'ralmasa, yuklashdan keyingi
 * butun zanjir filialsiz ishlab, birinchi so'rovda yiqilardi.
 *
 * @param {object} options
 * @param {{name: string, maxCount?: number}[]} options.fields Maydonlar ro'yxati.
 * @param {string[]} [options.categories=["image"]] Ruxsat etilgan toifalar.
 * @param {number} [options.maxFiles=12] Umumiy fayllar chegarasi.
 * @returns {Function} Multer fields middleware.
 */
const createFieldsUpload = ({
  fields = [],
  categories = ["image"],
  maxFiles = 12,
} = {}) => {
  const maxFileSizeMb = config.maxUploadFileSizeMb;
  const maxFileSizeBytes = Math.max(1, maxFileSizeMb) * 1024 * 1024;
  const allowedMimeTypes = getAllowedMimeTypes(categories);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxFileSizeBytes,
      files: Math.max(1, maxFiles),
      fields: 60,
      parts: 80,
    },
    fileFilter: (req, file, cb) => {
      if (!allowedMimeTypes.includes(file.mimetype)) {
        return cb(new Error("Unsupported file type."), false);
      }
      cb(null, true);
    },
  });

  return withBranchContext(upload.fields(fields));
};

/**
 * Handles multer errors in a consistent JSON format.
 */
const handleFileUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        message: `Fayl juda katta. Maksimal hajm ${config.maxUploadFileSizeMb}MB.`,
      });
    }

    return res.status(400).json({
      success: false,
      message: `Upload error: ${err.message}`,
    });
  }

  if (err) {
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }

  next();
};

module.exports = {
  FILE_MIME_TYPES,
  withBranchContext,
  getAllowedMimeTypes,
  createSingleFileUpload,
  createMultiFileUpload,
  createFieldsUpload,
  handleFileUploadError,
};
