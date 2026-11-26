/**
 * MEDIA QOIDALARI — bitta joyda (sof funksiyalar, bazasiz).
 *
 * Nima uchun alohida fayl: bu chegaralarni UCH joy o'qiydi — yuklashga
 * ruxsat beradigan endpoint (`POST /social/uploads`), faylni tekshiradigan
 * endpoint (`.../complete`) va mobil ilova (hujjat orqali). Ikki nusxa
 * bo'lsa, ruxsat 25 MB berib, tekshiruv 10 MB da rad etardi va odam
 * videoni yuklab bo'lgach "xato" ko'rardi.
 *
 * ⚠️ MIME OQ RO'YXAT, qora ro'yxat EMAS: "ruxsat etilmaganlardan tashqari
 * hammasi" degan qoida ertaga paydo bo'ladigan har bir yangi format uchun
 * teshik qoldirardi.
 *
 * ⚠️ TUR + MAQSAD JUFTLIGI TEKSHIRILADI. "Video" o'zi yetarli emas: video
 * istoriyada 60 sekundgacha, chatda ham, lekin FAYL (`pdf`, `zip`) faqat
 * chatda va faqat XODIMGA. Chegarani faqat turga bog'lasak, o'quvchi sinf
 * guruhiga zip tashlab yuborardi.
 */

const { BadRequestError } = require("../utils/errors");

const MB = 1024 * 1024;

/** Yuklanadigan faylning maqsadi — chegaralar shunga ham bog'liq. */
const PURPOSES = Object.freeze(["story", "chat", "avatar"]);

/** `MediaKind` enumi bilan AYNI qiymatlar (prisma/platform/schema.prisma). */
const KINDS = Object.freeze(["image", "video", "file", "voice"]);

/**
 * MIME → kengaytma. ⚠️ Kengaytma MIJOZNING fayl nomidan OLINMAYDI:
 * "rasm.jpg.exe" nomli fayl bucket ichida o'sha nom bilan yotib qolardi.
 * Kalit faqat shu jadvaldan hosil bo'ladi.
 */
const MIME_EXTENSION = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "m4a",
  "audio/ogg": "ogg",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
});

/**
 * TUR QOIDALARI.
 *
 * `maxBytes`   — fayl hajmi chegarasi
 * `maxMs`      — davomiylik chegarasi (video, ovoz)
 * `purposes`   — qaysi maqsadda ishlatiladi
 * `staffOnly`  — faqat xodim yuborishi mumkin (o'quvchiga yopiq)
 */
const KIND_RULES = Object.freeze({
  image: {
    label: "Rasm",
    // ⚠️ HEIC (iPhone sukut formati) QABUL QILINMAYDI va bu ONGLI qaror.
    // Serverdagi `sharp` prebuilt libvips bilan keladi: unda HEIF faqat
    // AVIF uchun ochiq (HEVC litsenziya sababli yo'q), ya'ni haqiqiy
    // iPhone rasmi 10 MB yuklangandan KEYIN qayta ishlashda yiqilardi —
    // foydalanuvchi uchun bu "yuklanmadi" degan tushunarsiz xato bo'lardi.
    // Ilova baribir siqadi (`flutter_image_compress`, 1080 px / 80%) va
    // natijasi JPEG/WebP bo'ladi, shuning uchun chegara hech narsani
    // cheklamaydi — faqat xatoni YUKLASHDAN OLDIN beradi.
    mimes: ["image/jpeg", "image/png", "image/webp"],
    maxBytes: 10 * MB,
    purposes: ["story", "chat", "avatar"],
    staffOnly: false,
  },
  video: {
    label: "Video",
    mimes: ["video/mp4"],
    maxBytes: 25 * MB,
    maxMs: 60 * 1000,
    purposes: ["story", "chat"],
    // ⚠️ O'quvchi video yubormaydi (`.claude/rules` — sinf guruhi qoidalari):
    // 25 MB lik fayl sinf guruhida tarqatma kanalga aylanardi.
    staffOnly: true,
  },
  voice: {
    label: "Ovozli xabar",
    mimes: ["audio/m4a", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/ogg"],
    maxBytes: 5 * MB,
    maxMs: 5 * 60 * 1000,
    purposes: ["chat"],
    staffOnly: false,
  },
  file: {
    label: "Fayl",
    mimes: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/zip",
      "application/x-zip-compressed",
    ],
    maxBytes: 20 * MB,
    purposes: ["chat"],
    staffOnly: true,
  },
});

/** Avatar faylining alohida chegarasi (`image` dan qattiqroq). */
const AVATAR_MAX_BYTES = 5 * MB;

/** Serverda rasm shu kenglikka siqiladi (WebP). */
const IMAGE_MAX_WIDTH = 1080;
/** Oldindan ko'rinish (thumbnail) kengligi. */
const THUMB_WIDTH = 320;
/** Avatar — kvadrat. */
const AVATAR_SIZE = 512;

/** Bir odamda bir vaqtda ko'pi bilan shuncha `pending` yuklash. */
const MAX_PENDING_UPLOADS = 10;

/** Presigned PUT havolasining umri (sekund) — yuklash uchun yetarli oyna. */
const UPLOAD_URL_TTL_SEC = 600;

/** Istoriya izohi va xabar matni chegaralari (schema bilan AYNI). */
const STORY_CAPTION_MAX = 300;
const STORY_COMMENT_MAX = 500;
const MESSAGE_TEXT_MAX = 4000;
/** Suhbatlar ro'yxatidagi "oxirgi xabar" matni. */
const PREVIEW_MAX = 120;

/**
 * Yuklash so'rovini tekshiradi va NORMALIZATSIYA qilgan holda qaytaradi.
 *
 * ⚠️ `size` MIJOZNING E'LONI — haqiqat emas. Shu bosqichda u faqat
 * "so'rashga arziydimi" degan savolga javob beradi; HAQIQIY hajm fayl
 * yuklangandan keyin Spaces'dan o'qiladi (`HeadObject`) va mos kelmasa
 * yuklash RAD ETILADI (`mediaUpload.service.js`). Shu ikki qavat bo'lmasa,
 * ilova "1 MB" deb aytib 100 MB yuklab qo'yardi.
 *
 * @param {{kind?: string, mime?: string, size?: number, width?: number,
 *          height?: number, durationMs?: number, purpose?: string}} input
 * @param {{isStaff?: boolean}} [actor]
 * @returns {{kind: string, mime: string, size: number, purpose: string,
 *           width: number|null, height: number|null, durationMs: number|null,
 *           extension: string}}
 */
function validateUploadRequest(input = {}, actor = {}) {
  const purpose = String(input.purpose || "").trim();
  if (!PURPOSES.includes(purpose)) {
    throw new BadRequestError(
      `Maqsad noto'g'ri — ${PURPOSES.join(" / ")} dan biri bo'lishi kerak`,
    );
  }

  const kind = String(input.kind || "").trim();
  const rule = KIND_RULES[kind];
  if (!rule) {
    throw new BadRequestError(`Fayl turi noto'g'ri — ${KINDS.join(" / ")}`);
  }

  if (!rule.purposes.includes(purpose)) {
    throw new BadRequestError(`${rule.label} bu bo'limga yuklanmaydi`);
  }

  if (rule.staffOnly && actor.isStaff === false) {
    throw new BadRequestError(`${rule.label} yuborish faqat xodimlar uchun`);
  }

  const mime = String(input.mime || "").toLowerCase().trim();
  if (!rule.mimes.includes(mime)) {
    throw new BadRequestError(`${rule.label} formati qo'llab-quvvatlanmaydi: ${mime || "—"}`);
  }

  const size = Number(input.size);
  if (!Number.isFinite(size) || size <= 0) {
    throw new BadRequestError("Fayl hajmi ko'rsatilmagan");
  }

  const maxBytes = purpose === "avatar" ? Math.min(rule.maxBytes, AVATAR_MAX_BYTES) : rule.maxBytes;
  if (size > maxBytes) {
    throw new BadRequestError(
      `${rule.label} hajmi ${Math.round(maxBytes / MB)} MB dan oshmasligi kerak`,
    );
  }

  const durationMs = toPositiveInt(input.durationMs);
  if (rule.maxMs && durationMs && durationMs > rule.maxMs) {
    throw new BadRequestError(
      `${rule.label} davomiyligi ${Math.round(rule.maxMs / 1000)} sekunddan oshmasligi kerak`,
    );
  }

  return {
    kind,
    mime,
    size,
    purpose,
    width: toPositiveInt(input.width),
    height: toPositiveInt(input.height),
    durationMs,
    extension: MIME_EXTENSION[mime],
  };
}

/**
 * Haqiqiy (Spaces'dan o'qilgan) fayl bilan e'lon qilingani mos keladimi.
 *
 * ⚠️ `contentType` TEKSHIRILADI, lekin yo'qligi xato EMAS: ba'zi mijozlar
 * presigned PUT da `Content-Type` yubormaydi va obyekt
 * `application/octet-stream` bo'lib qoladi. Shunday holatda e'lon qilingan
 * MIME ishlatiladi — fayl baribir sharp bilan qayta kodlanadi (rasm) yoki
 * faqat hajmi bo'yicha qabul qilinadi.
 *
 * @param {{declaredMime: string, declaredSize: number, kind: string}} declared
 * @param {{size?: number, contentType?: string|null}} actual
 */
function assertActualMatchesDeclared(declared, actual = {}) {
  const rule = KIND_RULES[declared.kind];
  const size = Number(actual.size);

  if (!Number.isFinite(size) || size <= 0) {
    throw new BadRequestError("Fayl yuklanmagan");
  }
  if (rule && size > rule.maxBytes) {
    throw new BadRequestError(
      `Fayl hajmi ${Math.round(rule.maxBytes / MB)} MB dan oshmasligi kerak`,
    );
  }
  // ⚠️ 10% ZAXIRA: HEIC → WebP qayta kodlash mijoz tomonda ham bo'lishi
  // mumkin, ya'ni bayt-baytga tenglik talab qilish yaroqli yuklashni rad
  // etardi. Chegara esa yuqoridagi qattiq tekshiruvda qoladi.
  if (Number.isFinite(declared.declaredSize) && size > declared.declaredSize * 1.1 + 1024) {
    throw new BadRequestError("Yuklangan fayl e'lon qilingan hajmdan katta");
  }

  const type = String(actual.contentType || "").toLowerCase();
  if (type && type !== "application/octet-stream" && rule && !rule.mimes.includes(type)) {
    throw new BadRequestError(`Yuklangan fayl formati mos emas: ${type}`);
  }

  return { size };
}

/**
 * Spaces kaliti: `social/{ownerId}/{yyyy}/{mm}/{id}.{ext}`.
 *
 * ⚠️ `ownerId` kalit ichida ATAYLAB: fayl kimnikiligini bazaga bormasdan
 * ko'rish (nosozlikni izlashda) va bir odamning fayllarini bir joyda
 * ushlab turish uchun. Kalit SIR EMAS — obyekt baribir `private` va
 * havola imzolanadi.
 *
 * @param {{prefix: string, ownerId: string, id: string, extension: string,
 *          at?: Date, variant?: string|null}} input
 * @returns {string}
 */
function buildMediaKey({ prefix, ownerId, id, extension, at = new Date(), variant = null }) {
  const yyyy = at.getUTCFullYear();
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  const name = variant ? `${id}_${variant}.${extension}` : `${id}.${extension}`;
  return `${prefix}/${ownerId}/${yyyy}/${mm}/${name}`;
}

/** Musbat butun son yoki `null` (mijozdan kelgan ixtiyoriy raqamlar uchun). */
function toPositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * Matnni kesadi va bo'sh bo'lsa `null` qaytaradi.
 *
 * ⚠️ FAQAT BO'SHLIQDAN IBORAT MATN — BO'SH: aks holda chatda "   " degan
 * xabar yoki istoriyada ko'rinmas izoh paydo bo'lardi.
 */
function cleanText(value, max) {
  if (value == null) return null;
  const text = String(value).replace(/\u0000/g, "").trim();
  if (!text) return null;
  if (max && text.length > max) {
    throw new BadRequestError(`Matn ${max} belgidan oshmasligi kerak`);
  }
  return text;
}

module.exports = {
  MB,
  PURPOSES,
  KINDS,
  KIND_RULES,
  MIME_EXTENSION,
  AVATAR_MAX_BYTES,
  AVATAR_SIZE,
  IMAGE_MAX_WIDTH,
  THUMB_WIDTH,
  MAX_PENDING_UPLOADS,
  UPLOAD_URL_TTL_SEC,
  STORY_CAPTION_MAX,
  STORY_COMMENT_MAX,
  MESSAGE_TEXT_MAX,
  PREVIEW_MAX,
  validateUploadRequest,
  assertActualMatchesDeclared,
  buildMediaKey,
  cleanText,
};
