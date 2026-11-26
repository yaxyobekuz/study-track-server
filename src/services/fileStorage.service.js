const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const fs = require("fs");
const path = require("path");
const { config } = require("../config/env.config");

// LOKAL REJIM — Spaces kalitlari yo'q yoki "dummy" bo'lsa fayllar LOKAL
// DISKKA yoziladi (`uploads/`) va server o'zi tarqatadi. Bu FAQAT lokal
// dev uchun: produksiyada haqiqiy kalitlar turadi va bu yo'l yoqilmaydi
// ("uploads/ produksiyada tarqatilmaydi" qoidasi buzilmaydi).
const isLocalStorage =
  !config.doBucketName ||
  config.doBucketName === "dummy" ||
  !config.doAccessKey ||
  config.doAccessKey === "dummy";

const LOCAL_UPLOADS_DIR = path.join(__dirname, "../../uploads");

/**
 * MAXFIY fayllarning lokal papkasi.
 *
 * ⚠️ `uploads` DAN TASHQARIDA. `index.js` `uploads` ni `express.static`
 * bilan tarqatadi, shuning uchun maxfiy fayl o'sha papkaga tushsa
 * havola orqali hammaga ochiq bo'lardi. Bu papka hech qayerga mount
 * qilinmaydi: fayl faqat `getObjectBuffer` orqali, ruxsat tekshiruvidan
 * o'tgan controller qo'li bilan beriladi.
 */
const LOCAL_PRIVATE_DIR = path.join(__dirname, "../../uploads-private");

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
  // Lokal dev: diskka yozamiz, URL server o'zi tarqatadigan /uploads bo'ladi
  if (isLocalStorage) {
    const filePath = path.join(LOCAL_UPLOADS_DIR, key);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, buffer);
    return {
      key,
      url: `http://localhost:${config.port}/uploads/${key}`,
      size: buffer.length,
    };
  }

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
  // Lokal dev: `LOCAL_PRIVATE_DIR` ga yoziladi.
  //
  // ⚠️ `LOCAL_UPLOADS_DIR` EMAS va bu ataylab: o'sha papka `index.js` da
  // `express.static` bilan tarqatiladi, ya'ni maxfiy fayl havola orqali
  // hammaga ochiq bo'lib qolardi — ya'ni `uploadPrivateBuffer` nomi
  // yolg'onga aylanardi. Alohida papka esa hech qayerga mount qilinmaydi.
  if (isLocalStorage) {
    const filePath = path.join(LOCAL_PRIVATE_DIR, key);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, buffer);
    return { key, size: buffer.length };
  }

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
  if (isLocalStorage) {
    // ⚠️ Yo'l NORMALIZATSIYA qilinadi va papkadan chiqib ketish rad
    // etiladi: kalit mijoz so'rovidan kelishi mumkin ("../../.env").
    const filePath = path.resolve(LOCAL_PRIVATE_DIR, key);
    if (!filePath.startsWith(path.resolve(LOCAL_PRIVATE_DIR))) {
      throw new Error("Fayl kaliti papkadan tashqariga ishora qiladi");
    }
    const buffer = await fs.promises.readFile(filePath);
    return { buffer, contentType: null };
  }

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

  if (isLocalStorage) {
    // Lokal fayl bo'lmasa ham jim o'tamiz — o'chirish best-effort.
    // ⚠️ IKKALA papka: chaqiruvchi fayl ochiq yoki maxfiy ekanini
    // bilishi shart emas (va bilmasligi kerak — kalit bitta).
    await Promise.all([
      fs.promises.unlink(path.join(LOCAL_UPLOADS_DIR, key)).catch(() => {}),
      fs.promises.unlink(path.join(LOCAL_PRIVATE_DIR, key)).catch(() => {}),
    ]);
    return;
  }

  await spacesClient.send(
    new DeleteObjectCommand({
      Bucket: config.doBucketName,
      Key: key,
    }),
  );
};

/* ═══════════════════ IMZOLANGAN HAVOLALAR (presign) ═══════════════════ */
//
// NIMA UCHUN KERAK: istoriya videosi 25 MB bo'lishi mumkin. U Node orqali
// o'tsa (multer `memoryStorage`), bir vaqtda uch kishi istoriya qo'yganda
// jarayon 75 MB xotira yeb, API butun maktab uchun sekinlashardi. Presign
// bilan server faqat RUXSAT beradi — bayt oqimi ilova bilan Spaces
// o'rtasida ketadi.
//
// ⚠️ LOKAL REJIMDA PRESIGN YO'Q. Dev mashinada Spaces kalitlari yo'q, ya'ni
// imzolab bo'lmaydi: bunday holatda `null` qaytadi va chaqiruvchi oddiy
// multipart yo'liga o'tadi (`mediaUpload.service.js`). Jim ravishda
// "ishladi" deb qaytarsa, dev muhitda fayl hech qayerga yozilmasdi.

/**
 * FAYLNI YUKLASH uchun imzolangan PUT havolasi.
 *
 * ⚠️ `ContentType` imzoga KIRADI: ilova boshqa turdagi faylni shu havola
 * bilan yuklab qo'ya olmaydi (imzo mos kelmaydi).
 *
 * ⚠️ `ACL: private` — bucket ichida fayl YOPIQ. Media havolasi har javobda
 * qaytadan imzolanadi (`createSignedGetUrl`), ya'ni kalitni bilgan odam
 * ham to'g'ridan-to'g'ri ocha olmaydi.
 *
 * @param {{key: string, contentType: string, expiresIn?: number}} params
 * @returns {Promise<{url: string, headers: object, expiresIn: number}|null>}
 *   lokal rejimda `null`
 */
const createPresignedPutUrl = async ({ key, contentType, expiresIn = 600 }) => {
  if (isLocalStorage) return null;

  const command = new PutObjectCommand({
    Bucket: config.doBucketName,
    Key: key,
    ContentType: contentType,
    ACL: "private",
  });

  const url = await getSignedUrl(spacesClient, command, { expiresIn });

  return {
    url,
    // ⚠️ Ilova AYNAN shu sarlavhalar bilan yuborishi shart — ular imzo
    // ichida. Ro'yxat javobda qaytadi, mobil tomonda qotirilmaydi.
    headers: { "Content-Type": contentType, "x-amz-acl": "private" },
    expiresIn,
  };
};

/**
 * FAYLNI O'QISH uchun imzolangan GET havolasi.
 *
 * ⚠️ Lokal rejimda imzo yo'q — `/uploads-private` hech qayerga mount
 * qilinmagani uchun server o'zi tarqatadigan yo'l qaytadi
 * (`/api/social/media/:id` → `getObjectBuffer`). Shu sababli funksiya
 * `null` qaytaradi va chaqiruvchi o'sha yo'lni quradi.
 *
 * @param {{key: string, expiresIn?: number, download?: string|null}} params
 * @returns {Promise<string|null>}
 */
const createSignedGetUrl = async ({ key, expiresIn = 3600, download = null }) => {
  if (isLocalStorage || !key) return null;

  const command = new GetObjectCommand({
    Bucket: config.doBucketName,
    Key: key,
    ...(download
      ? { ResponseContentDisposition: `attachment; filename="${download.replace(/"/g, "")}"` }
      : {}),
  });

  return getSignedUrl(spacesClient, command, { expiresIn });
};

/**
 * Obyekt haqiqatan yuklanganmi va hajmi qancha.
 *
 * ⚠️ BU TEKSHIRUV MAJBURIY: presign bilan ilova "1 MB" deb aytib 100 MB
 * yuklab qo'yishi mumkin. Haqiqatni faqat bucket biladi.
 *
 * @param {string} key
 * @returns {Promise<{size: number, contentType: string|null}|null>}
 *   obyekt yo'q bo'lsa `null`
 */
const headObject = async (key) => {
  if (isLocalStorage) {
    for (const dir of [LOCAL_PRIVATE_DIR, LOCAL_UPLOADS_DIR]) {
      const filePath = path.resolve(dir, key);
      if (!filePath.startsWith(path.resolve(dir))) continue;
      try {
        const stat = await fs.promises.stat(filePath);
        return { size: stat.size, contentType: null };
      } catch {
        // keyingi papka
      }
    }
    return null;
  }

  try {
    const response = await spacesClient.send(
      new HeadObjectCommand({ Bucket: config.doBucketName, Key: key }),
    );
    return {
      size: Number(response.ContentLength) || 0,
      contentType: response.ContentType || null,
    };
  } catch (error) {
    // 404 / NotFound — fayl hali yuklanmagan. Boshqa xato yuqoriga ketadi:
    // "fayl yo'q" bilan "bucket ishlamayapti" ni aralashtirib bo'lmaydi.
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound") return null;
    throw error;
  }
};

module.exports = {
  uploadBuffer,
  uploadPrivateBuffer,
  getObjectBuffer,
  deleteObject,
  getPublicUrl,
  createPresignedPutUrl,
  createSignedGetUrl,
  headObject,
  isLocalStorage,
  LOCAL_UPLOADS_DIR,
  LOCAL_PRIVATE_DIR,
};
