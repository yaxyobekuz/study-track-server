/**
 * MEDIA YUKLASH — rasm, video, ovoz va hujjat.
 *
 * Qoida bitta jumlada:
 *
 * > Katta fayl server orqali O'TMAYDI: ilova to'g'ridan-to'g'ri Spaces'ga
 * > yuklaydi, server esa UCH ishni qiladi — ruxsat beradi, keyin faylni
 * > TEKSHIRADI va biriktiriladigan paytda EGASINI tasdiqlaydi.
 *
 * Oqim:
 *   1. `POST /social/uploads`            → `pending` qator + imzolangan PUT
 *   2. ilova faylni Spaces'ga yuklaydi    (server ko'rmaydi)
 *   3. `POST /social/uploads/:id/complete`→ HeadObject, qayta ishlash, `ready`
 *   4. istoriya/xabar yaratish            → `attached`
 *
 * ⚠️ 3-QADAM MAJBURIY VA U SERVERNING YAGONA HIMOYASI. Presign bilan ilova
 * "1 MB rasm" deb so'rab, 100 MB yoki butunlay boshqa fayl yuklab qo'yishi
 * mumkin — haqiqatni faqat bucket biladi. Shuning uchun hajm va
 * `Content-Type` yuklangandan KEYIN o'qiladi va mos kelmasa qator
 * `ready` bo'lmaydi, ya'ni hech qayerga biriktirilmaydi.
 *
 * ⚠️ EXIF VA GPS OLIB TASHLANADI. Telefon rasmiga koordinata yoziladi:
 * o'qituvchi sinfdagi rasmni istoriyaga qo'ysa, uning uy manzili ham
 * ketishi mumkin bo'lardi. `sharp` metama'lumotni ATAYLAB ko'chirmaydi
 * (`withMetadata` CHAQIRILMAYDI) — bu tasodif emas, qoida.
 *
 * ⚠️ VIDEO SERVERDA SIQILMAYDI (ffmpeg yo'q va kiritilmaydi): siqish
 * ILOVADA bo'ladi, server faqat hajm va davomiylik chegarasini tekshiradi.
 * Kadr-rasmni ham ilova yuklaydi (`thumbPutUrl`) — shu sababli video
 * istoriyada ham blurhash va oldindan ko'rinish bor.
 *
 * ⚠️ BUCKET ICHIDA HAMMA NARSA YOPIQ (`private`). Javobda imzolangan GET
 * havolasi beriladi (1 soat). Ilova keshni `mediaId` bo'yicha saqlaydi,
 * URL bo'yicha EMAS — aks holda har soatda o'sha rasmni qaytadan yuklab
 * olardi (`docs/social-api.md` da shartnoma sifatida yozilgan).
 */

const sharp = require("sharp");
const { encode: encodeBlurhash } = require("blurhash");

const platformPrisma = require("../config/platformPrisma");
const fileStorage = require("./fileStorage.service");
const { config } = require("../config/env.config");
const logger = require("../utils/logger");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} = require("../utils/errors");
const {
  KIND_RULES,
  MAX_PENDING_UPLOADS,
  UPLOAD_URL_TTL_SEC,
  IMAGE_MAX_WIDTH,
  THUMB_WIDTH,
  validateUploadRequest,
  assertActualMatchesDeclared,
  buildMediaKey,
} = require("../helpers/socialMedia.helpers");

/** Qayta ishlangan rasm formati — bitta joyda. */
const PROCESSED_FORMAT = "webp";
const PROCESSED_MIME = "image/webp";
const PROCESSED_QUALITY = 80;

/** Blurhash to'ri — 4×4 yetarli (satr ~30 belgi). */
const BLURHASH_COMPONENTS = 4;
/** Blurhash hisoblash uchun rasm shu kenglikka kichraytiriladi (tez bo'lishi uchun). */
const BLURHASH_WIDTH = 32;

/* ─────────────────────────── 1. RUXSAT ─────────────────────────── */

/**
 * Yuklash uchun joy band qiladi va imzolangan PUT havolasini qaytaradi.
 *
 * ⚠️ BIR ODAMDA BIR VAQTDA KO'PI BILAN 10 TA `pending`: aks holda ilovadagi
 * xato (yoki qasddan yuborilgan so'rovlar) bazani bo'sh qatorlar bilan
 * to'ldirib, bucket'da band qilingan kalitlar qoldirardi.
 *
 * @param {{ actor: {id: string, isStaff: boolean}, body: object }} input
 * @returns {Promise<object>}
 */
async function createUpload({ actor, body }) {
  const spec = validateUploadRequest(body, { isStaff: actor.isStaff });

  const pending = await platformPrisma.mediaUpload.count({
    where: { ownerId: actor.id, status: "pending" },
  });
  if (pending >= MAX_PENDING_UPLOADS) {
    throw new ConflictError(
      `Tugallanmagan yuklashlar ko'p (${pending}) — avvalgilarini yakunlang`,
    );
  }

  const now = new Date();
  // ⚠️ `id` ni O'ZIMIZ hosil qilamiz, chunki kalit unga tayanadi: qator
  // yozilgandan keyin kalitni yangilash ikkinchi `UPDATE` bo'lardi va
  // oraliqda yiqilsa kalitsiz qator qolib ketardi.
  const id = require("../utils/idGenerator").generateId();

  const key = buildMediaKey({
    prefix: config.socialMediaPrefix,
    ownerId: actor.id,
    id,
    extension: spec.extension,
    at: now,
  });
  // Kadr-rasm FAQAT video uchun: ilova uni o'zi yuklaydi (server ffmpeg
  // ishlatmaydi). Rasmning thumbnail'i serverda hosil qilinadi.
  const thumbKey =
    spec.kind === "video"
      ? buildMediaKey({
          prefix: config.socialMediaPrefix,
          ownerId: actor.id,
          id,
          extension: PROCESSED_FORMAT,
          at: now,
          variant: "t",
        })
      : null;

  await platformPrisma.mediaUpload.create({
    data: {
      id,
      ownerId: actor.id,
      kind: spec.kind,
      key,
      thumbKey,
      mime: spec.mime,
      size: spec.size,
      width: spec.width,
      height: spec.height,
      durationMs: spec.durationMs,
      status: "pending",
    },
  });

  const put = await fileStorage.createPresignedPutUrl({
    key,
    contentType: spec.mime,
    expiresIn: UPLOAD_URL_TTL_SEC,
  });
  const thumbPut = thumbKey
    ? await fileStorage.createPresignedPutUrl({
        key: thumbKey,
        contentType: PROCESSED_MIME,
        expiresIn: UPLOAD_URL_TTL_SEC,
      })
    : null;

  return {
    uploadId: id,
    // ⚠️ `mode` ILOVAGA AYTILADI: lokal dev muhitida presign yo'q va ilova
    // faylni serverga multipart bilan yuboradi
    // (`POST /social/uploads/:id/binary`). Ikki yo'lni ilova O'ZI
    // taxmin qilmaydi — server aytadi.
    mode: put ? "presigned" : "multipart",
    putUrl: put?.url || null,
    headers: put?.headers || null,
    thumbPutUrl: thumbPut?.url || null,
    thumbHeaders: thumbPut?.headers || null,
    multipartUrl: put ? null : `/api/social/uploads/${id}/binary`,
    expiresIn: UPLOAD_URL_TTL_SEC,
  };
}

/* ──────────────────── 2. LOKAL (dev) YUKLASH ──────────────────── */

/**
 * LOKAL REJIM uchun multipart yuklash — presign bo'lmaganda.
 *
 * ⚠️ FAQAT DEV. Produksiyada haqiqiy kalitlar bor, ya'ni
 * `createPresignedPutUrl` havola qaytaradi va bu yo'l umuman
 * chaqirilmaydi. Shunga qaramay u JAVOB SHAKLINI o'zgartirmaydi: mobil
 * tomondagi oqim ikki muhitda bir xil bo'lib qolishi kerak.
 */
async function putBinary({ actor, uploadId, file, isThumb = false }) {
  const row = await loadOwnPending(actor, uploadId);
  if (!file?.buffer) throw new BadRequestError("Fayl yuborilmadi");

  const key = isThumb ? row.thumbKey : row.key;
  if (!key) throw new BadRequestError("Bu yuklashda kadr-rasm kutilmaydi");

  await fileStorage.uploadPrivateBuffer({
    key,
    buffer: file.buffer,
    contentType: isThumb ? PROCESSED_MIME : row.mime,
  });

  return { uploadId: row.id, uploaded: true, thumb: isThumb };
}

/* ────────────────────── 3. TEKSHIRISH VA QAYTA ISHLASH ────────────────────── */

/**
 * Fayl haqiqatan yuklanganini tekshiradi, rasmni qayta ishlaydi va
 * qatorni `ready` holatiga o'tkazadi.
 *
 * ⚠️ IDEMPOTENT: allaqachon `ready` bo'lgan qator xato BERMAYDI — ilova
 * javobni olmay qolib, qayta urinishi odatiy hol (tarmoq uzilishi).
 * `attached` esa xato: u biriktirilgan, ya'ni ustiga yozib bo'lmaydi.
 *
 * @param {{ actor: object, uploadId: string }} input
 */
async function completeUpload({ actor, uploadId }) {
  const row = await platformPrisma.mediaUpload.findUnique({ where: { id: String(uploadId) } });
  if (!row) throw new NotFoundError("Yuklash topilmadi");
  if (row.ownerId !== actor.id) throw new ForbiddenError("Bu yuklash sizga tegishli emas");
  if (row.status === "attached") {
    throw new ConflictError("Bu fayl allaqachon ishlatilgan");
  }
  if (row.status === "ready") return present(row);

  const head = await fileStorage.headObject(row.key);
  if (!head) throw new BadRequestError("Fayl Spaces'ga yuklanmagan");

  assertActualMatchesDeclared(
    { declaredMime: row.mime, declaredSize: row.size, kind: row.kind },
    head,
  );

  let patch = { status: "ready", size: head.size };

  if (row.kind === "image") {
    patch = { ...patch, ...(await processImage(row)) };
  } else if (row.kind === "video") {
    patch = { ...patch, ...(await processVideoThumb(row)) };
  }

  const updated = await platformPrisma.mediaUpload.update({
    where: { id: row.id },
    data: patch,
  });

  return present(updated);
}

/**
 * RASMNI QAYTA ISHLASH: EXIF/GPS olib tashlash, 1080 px gacha kichraytirish,
 * WebP, 320 px thumbnail va blurhash.
 *
 * ⚠️ NATIJA YANGI KALITGA yoziladi (`..._p.webp`), xom fayl esa
 * O'CHIRILADI: aks holda bucket'da har rasmning ikki nusxasi (xom + siqilgan)
 * yotib qolardi va "nega 10 GB" degan savolga javob yo'q bo'lardi.
 *
 * @param {object} row
 * @returns {Promise<object>} `mediaUpload` ga yoziladigan maydonlar
 */
async function processImage(row) {
  const { buffer } = await fileStorage.getObjectBuffer(row.key);

  const image = sharp(buffer, { failOnError: false }).rotate();
  const meta = await image.metadata();

  // ⚠️ `withMetadata()` ATAYLAB CHAQIRILMAYDI — shu bitta qarorda EXIF va
  // GPS yo'qoladi (yuqoridagi izoh).
  const processed = await sharp(buffer, { failOnError: false })
    .rotate()
    .resize({ width: IMAGE_MAX_WIDTH, fit: "inside", withoutEnlargement: true })
    .toFormat(PROCESSED_FORMAT, { quality: PROCESSED_QUALITY })
    .toBuffer();
  const processedMeta = await sharp(processed).metadata();

  const thumb = await sharp(buffer, { failOnError: false })
    .rotate()
    .resize({ width: THUMB_WIDTH, fit: "inside", withoutEnlargement: true })
    .toFormat(PROCESSED_FORMAT, { quality: PROCESSED_QUALITY })
    .toBuffer();

  const processedKey = replaceExtension(row.key, PROCESSED_FORMAT, "p");
  const thumbKey = replaceExtension(row.key, PROCESSED_FORMAT, "t");

  await fileStorage.uploadPrivateBuffer({
    key: processedKey,
    buffer: processed,
    contentType: PROCESSED_MIME,
  });
  await fileStorage.uploadPrivateBuffer({
    key: thumbKey,
    buffer: thumb,
    contentType: PROCESSED_MIME,
  });

  // Xom fayl endi kerak emas. ⚠️ Xatosi YUTILADI: tozalash muvaffaqiyatsiz
  // bo'lsa ham rasm allaqachon tayyor — foydalanuvchi "yuklanmadi" degan
  // soxta xato ko'rmasligi kerak.
  if (processedKey !== row.key) {
    fileStorage.deleteObject(row.key).catch((err) =>
      logger.warn(`[social] xom rasmni o'chirishda xato: ${err.message}`),
    );
  }

  return {
    key: processedKey,
    thumbKey,
    mime: PROCESSED_MIME,
    size: processed.length,
    width: processedMeta.width || meta.width || null,
    height: processedMeta.height || meta.height || null,
    blurhash: await buildBlurhash(thumb),
  };
}

/**
 * VIDEO: ilova yuklagan kadr-rasmdan blurhash hosil qiladi.
 *
 * ⚠️ KADR-RASM IXTIYORIY: ilova uni yuklamagan bo'lsa (eski versiya, tarmoq
 * uzilishi) video baribir qabul qilinadi — faqat xira oldindan ko'rinish
 * bo'lmaydi. Buni xato qilsak, ishlayotgan ilova versiyasi bir kunda
 * butunlay video yuborolmay qolardi.
 */
async function processVideoThumb(row) {
  if (!row.thumbKey) return {};

  const head = await fileStorage.headObject(row.thumbKey);
  if (!head) return { thumbKey: null };

  try {
    const { buffer } = await fileStorage.getObjectBuffer(row.thumbKey);
    return { blurhash: await buildBlurhash(buffer) };
  } catch (error) {
    logger.warn(`[social] video kadr-rasmini o'qishda xato: ${error.message}`);
    return {};
  }
}

/**
 * Blurhash — yuklanayotganda ko'rsatiladigan xira ko'rinish.
 *
 * ⚠️ XATOSI YUTILADI: blurhash — qulaylik, majburiyat emas. Buzuq rasmda
 * yiqilsa, butun yuklash rad etilardi.
 */
async function buildBlurhash(buffer) {
  try {
    const { data, info } = await sharp(buffer)
      .resize({ width: BLURHASH_WIDTH, fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return encodeBlurhash(
      new Uint8ClampedArray(data),
      info.width,
      info.height,
      BLURHASH_COMPONENTS,
      BLURHASH_COMPONENTS,
    );
  } catch (error) {
    logger.warn(`[social] blurhash hosil qilinmadi: ${error.message}`);
    return null;
  }
}

/** `.../id.jpg` → `.../id_p.webp` */
function replaceExtension(key, extension, variant) {
  const base = key.replace(/\.[^./]+$/, "");
  return `${base}_${variant}.${extension}`;
}

/* ──────────────────────── 4. BIRIKTIRISH ──────────────────────── */

/**
 * Yuklashni istoriyaga yoki xabarga biriktiradi (`attached`).
 *
 * ⚠️ TRANZAKSIYA ICHIDA chaqiriladi va `updateMany` + shart bilan
 * (compare-and-swap): ikki parallel so'rov bitta faylni ikki joyga
 * biriktira OLMAYDI. Oddiy `update` bo'lsa, ikkinchisi ham o'tib ketardi
 * va bitta rasm ikkita istoriyada ko'rinardi — ularning biri o'chirilsa
 * media ham ketib, ikkinchisi buzuq bo'lib qolardi.
 *
 * @param {object} tx - platforma tranzaksiyasi
 * @param {{uploadId: string, ownerId: string, kind?: string|string[]}} input
 * @returns {Promise<object>} biriktirilgan `mediaUpload` qatori
 */
async function attachUploadInTx(tx, { uploadId, ownerId, kind }) {
  const row = await tx.mediaUpload.findUnique({ where: { id: String(uploadId) } });
  if (!row) throw new NotFoundError("Fayl topilmadi");
  if (row.ownerId !== ownerId) throw new ForbiddenError("Bu fayl sizga tegishli emas");
  if (row.status === "pending") {
    throw new BadRequestError("Fayl yuklanishi yakunlanmagan");
  }
  if (row.status === "attached") {
    throw new ConflictError("Bu fayl allaqachon ishlatilgan");
  }

  if (kind) {
    const allowed = Array.isArray(kind) ? kind : [kind];
    if (!allowed.includes(row.kind)) {
      const label = KIND_RULES[row.kind]?.label || row.kind;
      throw new BadRequestError(`${label} bu yerga qo'yilmaydi`);
    }
  }

  const { count } = await tx.mediaUpload.updateMany({
    where: { id: row.id, status: "ready" },
    data: { status: "attached" },
  });
  if (count !== 1) throw new ConflictError("Fayl holati o'zgardi — qaytadan urinib ko'ring");

  return { ...row, status: "attached" };
}

/* ────────────────────────── 5. JAVOB SHAKLI ────────────────────────── */

/**
 * Media bloki — javobning HAR joyida AYNI shakl.
 *
 * ⚠️ `url` IMZOLANGAN va MUDDATLI (`expiresIn`). Ilova keshni `id`
 * bo'yicha saqlashi SHARTNOMA: URL har javobda boshqacha bo'ladi, ya'ni
 * kesh kaliti qilib olinsa, bir xil rasm har soatda qaytadan yuklab
 * olinardi.
 *
 * @param {object|null} row
 * @returns {Promise<object|null>}
 */
async function present(row) {
  if (!row) return null;

  const ttl = config.socialSignedUrlTtlSec;
  const [url, thumbUrl] = await Promise.all([
    fileStorage.createSignedGetUrl({ key: row.key, expiresIn: ttl }),
    row.thumbKey
      ? fileStorage.createSignedGetUrl({ key: row.thumbKey, expiresIn: ttl })
      : Promise.resolve(null),
  ]);

  return {
    id: row.id,
    kind: row.kind,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    blurhash: row.blurhash,
    // Lokal rejimda imzo yo'q — server o'zi tarqatadigan yo'l beriladi.
    url: url || `/api/social/media/${row.id}`,
    thumbUrl: row.thumbKey ? thumbUrl || `/api/social/media/${row.id}?thumb=1` : null,
    expiresIn: url ? ttl : null,
  };
}

/** Bir nechta media — bitta `Promise.all` bilan (imzolash tarmoqsiz amal). */
async function presentMany(rows = []) {
  return Promise.all(rows.map((row) => present(row)));
}

/* ──────────────────────────── 6. TOZALASH ──────────────────────────── */

/**
 * YETIM FAYLLAR: 24 soatdan eski `pending` va `ready` qatorlar.
 *
 * ⚠️ `ready` HAM TOZALANADI: odam rasmni yuklab, "Joylash" ni bosmay
 * chiqib ketgan bo'lsa, fayl bucket'da abadiy yotib qolardi. Biriktirilgani
 * (`attached`) esa hech qachon bu yo'l bilan o'chirilmaydi.
 *
 * @param {{olderThanHours?: number}} [options]
 */
async function cleanupStale({ olderThanHours = 24 } = {}) {
  const cutoff = new Date(Date.now() - olderThanHours * 3600000);
  const rows = await platformPrisma.mediaUpload.findMany({
    where: { status: { in: ["pending", "ready"] }, createdAt: { lt: cutoff } },
    select: { id: true, key: true, thumbKey: true },
    take: 500,
  });

  let removed = 0;
  for (const row of rows) {
    try {
      await fileStorage.deleteObject(row.key);
      if (row.thumbKey) await fileStorage.deleteObject(row.thumbKey);
      await platformPrisma.mediaUpload.delete({ where: { id: row.id } });
      removed += 1;
    } catch (error) {
      // Bitta buzuq qator butun tozalashni to'xtatmasligi kerak.
      logger.warn(`[social] yetim faylni o'chirishda xato (${row.id}): ${error.message}`);
    }
  }

  return { scanned: rows.length, removed };
}

/**
 * Biriktirilgan media faylini O'CHIRADI (istoriya o'chirilgandan 30 kun keyin).
 *
 * @param {{id: string, key: string, thumbKey?: string|null}} row
 */
async function destroy(row) {
  if (!row) return;
  await fileStorage.deleteObject(row.key);
  if (row.thumbKey) await fileStorage.deleteObject(row.thumbKey);
  await platformPrisma.mediaUpload.delete({ where: { id: row.id } }).catch(() => {});
}

/** Faylni xom holda o'qiydi (lokal rejim va maxfiy yo'l uchun). */
async function readRaw(id, { thumb = false } = {}) {
  const row = await platformPrisma.mediaUpload.findUnique({ where: { id: String(id) } });
  if (!row) throw new NotFoundError("Fayl topilmadi");
  const key = thumb ? row.thumbKey : row.key;
  if (!key) throw new NotFoundError("Fayl topilmadi");
  const { buffer, contentType } = await fileStorage.getObjectBuffer(key);
  return { row, buffer, contentType: contentType || (thumb ? PROCESSED_MIME : row.mime) };
}

/** Egasining `pending` qatorini oladi (lokal yuklash uchun). */
async function loadOwnPending(actor, uploadId) {
  const row = await platformPrisma.mediaUpload.findUnique({ where: { id: String(uploadId) } });
  if (!row) throw new NotFoundError("Yuklash topilmadi");
  if (row.ownerId !== actor.id) throw new ForbiddenError("Bu yuklash sizga tegishli emas");
  if (row.status !== "pending") throw new ConflictError("Yuklash allaqachon yakunlangan");
  return row;
}

module.exports = {
  createUpload,
  putBinary,
  completeUpload,
  attachUploadInTx,
  present,
  presentMany,
  cleanupStale,
  destroy,
  readRaw,
  PROCESSED_MIME,
};
