const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { config } = require("../config/env.config");

const normalizedEndpoint = config.doEndpoint.startsWith("http")
  ? config.doEndpoint
  : `https://${config.doEndpoint}`;

const spacesClient = new S3Client({
  region: config.doRegion,
  endpoint: normalizedEndpoint,
  credentials: {
    accessKeyId: config.doAccessKey,
    secretAccessKey: config.doSecretKey,
  },
});

/**
 * Builds public URL for an object key.
 * @param {string} key Object key in bucket.
 * @returns {string} Public URL.
 */
const getPublicUrl = (key) => {
  if (config.doBucketPublicBaseUrl) {
    return `${config.doBucketPublicBaseUrl.replace(/\/$/, "")}/${key}`;
  }

  return `https://${config.doBucketName}.${config.doEndpoint}/${key}`;
};

/**
 * Uploads a file buffer to DigitalOcean Spaces.
 * @param {object} params Upload params.
 * @param {string} params.key Destination object key.
 * @param {Buffer} params.buffer File content.
 * @param {string} params.contentType MIME type.
 * @returns {Promise<{key:string,url:string,size:number}>} Uploaded object info.
 */
const uploadBuffer = async ({ key, buffer, contentType }) => {
  await spacesClient.send(
    new PutObjectCommand({
      Bucket: config.doBucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ACL: "public-read",
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );

  return {
    key,
    url: getPublicUrl(key),
    size: buffer.length,
  };
};

/**
 * MAXFIY fayl yuklaydi (`ACL: private`).
 *
 * ⚠️ `uploadBuffer` DAN FARQI: u yerda fayl havola orqali hammaga ochiq
 * (`public-read`) va brauzer uni bir yil keshda saqlaydi. Bu yerda obyektni
 * faqat server kaliti bilan o'qish mumkin — fayl mijozga faqat egalik
 * tekshiruvidan o'tgan so'rov orqali, `getObjectBuffer` bilan beriladi.
 * Shuning uchun natijada `url` YO'Q: uni hech qayerga yozib bo'lmasin.
 *
 * @param {object} params
 * @param {string} params.key Destination object key.
 * @param {Buffer} params.buffer File content.
 * @param {string} params.contentType MIME type.
 * @returns {Promise<{key:string,size:number}>}
 */
const uploadPrivateBuffer = async ({ key, buffer, contentType }) => {
  await spacesClient.send(
    new PutObjectCommand({
      Bucket: config.doBucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ACL: "private",
      CacheControl: "private, no-store",
    }),
  );

  return { key, size: buffer.length };
};

/**
 * Obyektni server kaliti bilan o'qiydi (maxfiy fayllar uchun).
 * @param {string} key Object key.
 * @returns {Promise<{buffer:Buffer,contentType:string|null}>}
 */
const getObjectBuffer = async (key) => {
  const response = await spacesClient.send(
    new GetObjectCommand({
      Bucket: config.doBucketName,
      Key: key,
    }),
  );

  const bytes = await response.Body.transformToByteArray();
  return {
    buffer: Buffer.from(bytes),
    contentType: response.ContentType || null,
  };
};

/**
 * Deletes an object from DigitalOcean Spaces.
 * @param {string} key Object key to delete.
 * @returns {Promise<void>}
 */
const deleteObject = async (key) => {
  if (!key) return;

  await spacesClient.send(
    new DeleteObjectCommand({
      Bucket: config.doBucketName,
      Key: key,
    }),
  );
};

module.exports = {
  uploadBuffer,
  uploadPrivateBuffer,
  getObjectBuffer,
  deleteObject,
  getPublicUrl,
};
