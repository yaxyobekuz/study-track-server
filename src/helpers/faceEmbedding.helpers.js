/**
 * YUZ VEKTORI (embedding) — SAQLASH SHAKLI VA TAQQOSLASH MATEMATIKASI.
 *
 * Sof funksiyalar: bazaga ham, kioskka ham, service'ga ham bog'liq emas.
 * Butun modulda vektor bilan ishlaydigan YAGONA joy — ikkinchi nusxa
 * paydo bo'lsa, ro'yxatga olish bir normalizatsiya, taqqoslash boshqasini
 * ishlatib, hamma narsa jimgina ishlamay qo'yardi.
 *
 * ── SAQLASH SHAKLI ──────────────────────────────────────────────────
 *
 * `FaceSample.embedding` — `Float32Array` ning XOM BAYTLARI (`Bytes`),
 * JSON massiv EMAS:
 *   · 1024 o'lchamli vektor JSON'da ~12 KB, baytlarda aniq 4096;
 *   · o'qishda `JSON.parse` yo'q — `Float32Array` to'g'ridan-to'g'ri
 *     bufer ustiga qo'yiladi (nusxasiz).
 *
 * ⚠️ `Float64` EMAS: model o'zi `float32` chiqaradi, ikki barobar joyni
 * aniqlik bermasdan egallardi.
 *
 * ── NIMA UCHUN KOSINUS, VA NIMA UCHUN NORMALIZATSIYA ────────────────
 *
 * Vektorlar SAQLASHDAN OLDIN L2-normalizatsiya qilinadi (uzunligi 1).
 * Shundan keyin kosinus o'xshashlik = SKALYAR KO'PAYTMA, ya'ni
 * taqqoslashda bo'lish ham, `Math.sqrt` ham yo'q — 5000 namuna ustidan
 * o'tish ~5 ms.
 *
 * ⚠️ Normalizatsiya BIR MARTA, yozishda qilinadi. Taqqoslash paytida
 * qilinsa, har so'rovda butun galereya qayta hisoblanardi.
 *
 * ⚠️ Shu sababli natija har doim [-1, 1] oralig'ida va chegara
 * (`matchThreshold`) MA'NOLI son bo'ladi: 0.62 har kamerada, har
 * filialda bir xil ma'noni beradi.
 */

const { BadRequestError } = require("../utils/errors");

/** Bitta `float32` — 4 bayt. */
const BYTES_PER_FLOAT = 4;

/**
 * O'lcham chegaralari — mijozdan kelgan "dim" ga ishonmaslik uchun.
 * Hozirgi modellar: `human/faceres` 1024, `face-api` 128, ArcFace 512.
 */
const MIN_DIM = 64;
const MAX_DIM = 4096;

/**
 * Nolga teng vektorni rad etish chegarasi. Model xato ishlaganda
 * (yoki mijoz nol massiv yuborganda) norma 0 bo'ladi va keyin BARCHA
 * taqqoslash `NaN` qaytarardi — ya'ni hech kim tanilmay qolardi, lekin
 * sababi ko'rinmasdi.
 */
const MIN_NORM = 1e-6;

/**
 * Mijozdan kelgan vektorni tekshiradi va L2-normalizatsiya qiladi.
 *
 * ⚠️ `Array.isArray` dan tashqari HAR BIR SON tekshiriladi:
 * `NaN`/`Infinity` bitta element ham butun taqqoslashni `NaN` ga
 * aylantiradi — natija "hech kim tanilmadi" bo'lib, sababi esa
 * hech qayerda ko'rinmasdi.
 *
 * @param {unknown} input - sonlar massivi (JSON'dan)
 * @param {{ expectedDim?: number }} [options] - `expectedDim` berilsa qat'iy mos kelishi shart
 * @returns {Float32Array} normalizatsiya qilingan vektor
 * @throws {BadRequestError}
 */
function normalizeEmbedding(input, { expectedDim } = {}) {
  if (!Array.isArray(input) && !(input instanceof Float32Array)) {
    throw new BadRequestError("Yuz vektori massiv bo'lishi kerak");
  }

  const dim = input.length;
  if (dim < MIN_DIM || dim > MAX_DIM) {
    throw new BadRequestError(`Yuz vektorining o'lchami noto'g'ri: ${dim}`);
  }
  if (expectedDim && dim !== expectedDim) {
    throw new BadRequestError(
      `Yuz vektori ${expectedDim} o'lchamli bo'lishi kerak, ${dim} keldi — ` +
        "kiosk dasturidagi model sozlamadagi modeldan farq qiladi",
    );
  }

  const out = new Float32Array(dim);
  let sumSquares = 0;

  for (let i = 0; i < dim; i += 1) {
    const value = Number(input[i]);
    if (!Number.isFinite(value)) {
      throw new BadRequestError("Yuz vektorida yaroqsiz son bor");
    }
    out[i] = value;
    sumSquares += value * value;
  }

  const norm = Math.sqrt(sumSquares);
  if (norm < MIN_NORM) {
    throw new BadRequestError("Yuz vektori bo'sh (nol) — kadr qayta olinishi kerak");
  }

  for (let i = 0; i < dim; i += 1) out[i] /= norm;

  return out;
}

/**
 * Normalizatsiya qilingan vektorni bazaga yozish uchun buferga aylantiradi.
 *
 * ⚠️ `Buffer.from(float32Array.buffer)` EMAS: `Float32Array` boshqa
 * buferning BO'LAGI bo'lishi mumkin (`subarray`) va u holda butun asosiy
 * bufer yozilib ketardi. `byteOffset` + `byteLength` bilan aniq bo'lak
 * olinadi.
 *
 * @param {Float32Array} vector
 * @returns {Buffer}
 */
function packEmbedding(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * Bazadagi buferni `Float32Array` ga o'raydi.
 *
 * ⚠️ NUSXA OLINADI (`slice`), ko'rinish emas. Sabab: Node'dagi `Buffer`
 * umumiy `ArrayBuffer` pool ustida yashaydi va `byteOffset` 4 ga
 * bo'linmasligi mumkin — `new Float32Array(buf.buffer, buf.byteOffset)`
 * shunda "start offset must be a multiple of 4" bilan yiqiladi. Galereya
 * bir marta qurilib keshlanadi, shuning uchun nusxa narxi bir martalik.
 *
 * Buzuq uzunlik (4 ga bo'linmaydi) yoki `dim` ga mos kelmasa — `null`:
 * bitta buzuq qator butun galereyani yiqitmasligi kerak
 * (`faceGallery.service.js` bunday namunalarni o'tkazib yuboradi).
 *
 * @param {Buffer|Uint8Array|null} buffer
 * @param {number} [dim] - kutilgan o'lcham (qatordagi `dim` ustuni)
 * @returns {Float32Array|null}
 */
function unpackEmbedding(buffer, dim) {
  if (!buffer || buffer.byteLength === 0) return null;
  if (buffer.byteLength % BYTES_PER_FLOAT !== 0) return null;

  const length = buffer.byteLength / BYTES_PER_FLOAT;
  if (dim && length !== dim) return null;
  if (length < MIN_DIM || length > MAX_DIM) return null;

  const copy = Buffer.from(buffer);
  return new Float32Array(copy.buffer, copy.byteOffset, length);
}

/**
 * KOSINUS O'XSHASHLIK — ikkala vektor NORMALIZATSIYA QILINGAN bo'lishi shart.
 *
 * ⚠️ Shu shart tufayli bu oddiy skalyar ko'paytma: normasini qayta
 * hisoblash yo'q. Normalizatsiyasiz vektor berilsa natija chegaralardan
 * chiqib ketadi va mos kelish qarori ma'nosiz bo'ladi — shuning uchun
 * yozish yo'lida `normalizeEmbedding` MAJBURIY.
 *
 * O'lchamlari farq qilsa `-1` (mos kelmaydi): model almashganini xato
 * bilan emas, "tanilmadi" bilan ko'rsatish kerak.
 *
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number} [-1, 1]
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return -1;

  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];

  // Suzuvchi nuqta xatosi 1.0000001 berishi mumkin — chegara taqqoslashi
  // uchun ahamiyatsiz, lekin ekranda "100.00001%" ko'rinardi.
  if (dot > 1) return 1;
  if (dot < -1) return -1;
  return dot;
}

/**
 * O'xshashlikni ekranga chiqarish uchun foiz (0..100, bir xona).
 *
 * ⚠️ Manfiy qiymat 0 ga qisiladi: "−12% o'xshash" degan ibora
 * foydalanuvchi uchun ma'nosiz.
 *
 * @param {number|null|undefined} score
 * @returns {number|null}
 */
function scoreToPercent(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  return Math.round(Math.max(0, score) * 1000) / 10;
}

module.exports = {
  normalizeEmbedding,
  packEmbedding,
  unpackEmbedding,
  cosineSimilarity,
  scoreToPercent,
  BYTES_PER_FLOAT,
  MIN_DIM,
  MAX_DIM,
};
