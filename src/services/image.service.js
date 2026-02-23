// Sharp for image processing
const sharp = require("sharp");

// Crypto for generating unique IDs
const crypto = require("crypto");

// Services
const fileStorageService = require("./fileStorage.service");

const IMAGE_VARIANTS = { sm: 144, md: 512, lg: 768 };

const FORMAT_EXTENSION_MAP = {
  jpeg: "jpg",
  jpg: "jpg",
  png: "png",
  webp: "webp",
};

const LOSSLESS_VARIANT_FORMAT = "webp";
const LOSSLESS_VARIANT_EXTENSION = "webp";
const LOSSLESS_VARIANT_MIME_TYPE = "image/webp";
const NEAR_LOSSLESS_WEBP_OPTIONS = {
  effort: 5,
  quality: 84,
  nearLossless: true,
};

/**
 * Uploads image original and responsive variants.
 * @param {object} params Processing params.
 * @param {Buffer} params.buffer Image buffer.
 * @param {string} params.mimeType Image mime type.
 * @returns {Promise<object>} Original and variant metadata.
 */
const uploadImageWithVariants = async ({ buffer, mimeType }) => {
  const image = sharp(buffer, { failOnError: true }).rotate();
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height || !metadata.format) {
    throw new Error("Invalid image metadata.");
  }

  const format = String(metadata.format).toLowerCase();
  const extension = FORMAT_EXTENSION_MAP[format];

  if (!extension) {
    throw new Error("Unsupported image format. Allowed: jpg, png, webp.");
  }

  const objectId = crypto.randomUUID();
  const rootPath = `images/${new Date().getFullYear()}/${String(new Date().getMonth() + 1).padStart(2, "0")}`;
  const originalKey = `${rootPath}/original/${objectId}.${extension}`;

  const originalUpload = await fileStorageService.uploadBuffer({
    key: originalKey,
    buffer,
    contentType: mimeType,
  });

  const originalVariant = {
    key: originalUpload.key,
    url: originalUpload.url,
    width: metadata.width,
    height: metadata.height,
    sizeBytes: originalUpload.size,
    reusedOriginal: true,
  };

  const variants = {
    original: originalVariant,
  };

  const entries = Object.entries(IMAGE_VARIANTS);
  for (const [variantName, targetWidth] of entries) {
    if (metadata.width <= targetWidth) {
      variants[variantName] = {
        ...originalVariant,
        reusedOriginal: true,
      };
      continue;
    }

    const resizedBuffer = await sharp(buffer)
      .rotate()
      .resize({ width: targetWidth, fit: "inside", withoutEnlargement: true })
      .toFormat(LOSSLESS_VARIANT_FORMAT, NEAR_LOSSLESS_WEBP_OPTIONS)
      .toBuffer();

    const resizedMetadata = await sharp(resizedBuffer).metadata();
    const resizedKey = `${rootPath}/${variantName}/${objectId}.${LOSSLESS_VARIANT_EXTENSION}`;

    const uploadedVariant = await fileStorageService.uploadBuffer({
      key: resizedKey,
      buffer: resizedBuffer,
      contentType: LOSSLESS_VARIANT_MIME_TYPE,
    });

    variants[variantName] = {
      key: uploadedVariant.key,
      url: uploadedVariant.url,
      width: resizedMetadata.width,
      height: resizedMetadata.height,
      sizeBytes: uploadedVariant.size,
      reusedOriginal: false,
    };
  }

  return {
    mimeType,
    extension,
    variants,
  };
};

/**
 * Removes all unique objects referenced by image variants.
 * @param {object} variants Variant object map.
 * @returns {Promise<void>}
 */
const deleteImageVariants = async (variants) => {
  const keys = new Set();
  Object.values(variants || {}).forEach((variant) => {
    if (variant?.key) keys.add(variant.key);
  });

  const deletionPromises = [...keys].map((key) =>
    fileStorageService.deleteObject(key),
  );
  await Promise.allSettled(deletionPromises);
};

module.exports = {
  IMAGE_VARIANTS,
  deleteImageVariants,
  uploadImageWithVariants,
};
