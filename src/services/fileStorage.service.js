const {
  S3Client,
  PutObjectCommand,
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
  deleteObject,
  getPublicUrl,
};
