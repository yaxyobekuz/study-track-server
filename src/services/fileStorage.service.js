const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

const endpointValue = process.env.DO_ENDPOINT || "";
const normalizedEndpoint = endpointValue.startsWith("http")
  ? endpointValue
  : `https://${endpointValue}`;

const spacesClient = new S3Client({
  region: process.env.DO_REGION || "fra1",
  endpoint: normalizedEndpoint,
  credentials: {
    accessKeyId: process.env.DO_ACCESS_KEY,
    secretAccessKey: process.env.DO_SECRET_KEY,
  },
});

/**
 * Builds public URL for an object key.
 * @param {string} key Object key in bucket.
 * @returns {string} Public URL.
 */
const getPublicUrl = (key) => {
  const customBaseUrl = process.env.DO_BUCKET_PUBLIC_BASE_URL;
  if (customBaseUrl) {
    return `${customBaseUrl.replace(/\/$/, "")}/${key}`;
  }

  return `https://${process.env.DO_BUCKET_NAME}.${process.env.DO_ENDPOINT}/${key}`;
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
      Bucket: process.env.DO_BUCKET_NAME,
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
      Bucket: process.env.DO_BUCKET_NAME,
      Key: key,
    }),
  );
};

module.exports = {
  uploadBuffer,
  deleteObject,
  getPublicUrl,
};
