const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * YUZ VEKTORI — SAQLASH SHAKLI VA TAQQOSLASH MATEMATIKASI.
 *
 * ⚠️ Bu testlar MODULNING ASOSINI qo'riqlaydi. Bitta buzilgan shart
 * butun davomatni jimgina noto'g'ri qiladi:
 *   · normalizatsiya buzilsa — chegara (`matchThreshold`) ma'nosini
 *     yo'qotadi va 0.62 raqami hech narsani bildirmaydi;
 *   · pack/unpack buzilsa — bazadagi barcha namunalar yaroqsiz;
 *   · `NaN` o'tib ketsa — HECH KIM tanilmaydi, lekin xato ham chiqmaydi.
 */

const {
  normalizeEmbedding,
  packEmbedding,
  unpackEmbedding,
  cosineSimilarity,
  scoreToPercent,
} = require("../src/helpers/faceEmbedding.helpers");

const DIM = 128;

const vectorOf = (fn) => Array.from({ length: DIM }, (_, i) => fn(i));

test("normalizatsiya: uzunligi 1 ga keltiriladi", () => {
  const vector = normalizeEmbedding(vectorOf((i) => i + 1));

  let sum = 0;
  for (const value of vector) sum += value * value;

  // Suzuvchi nuqta xatosi hisobga olinadi.
  assert.ok(Math.abs(Math.sqrt(sum) - 1) < 1e-6, "L2 normasi 1 bo'lishi kerak");
});

test("normalizatsiya: YO'NALISHNI saqlaydi — ko'paytirilgan vektor AYNI natija beradi", () => {
  // ⚠️ Bu modulning asosiy xususiyati: model kadrni yorqinroq ko'rsa
  // vektorning UZUNLIGI o'zgaradi, yo'nalishi esa deyarli o'zgarmaydi.
  // Normalizatsiya aynan shuni ushlab turadi — aks holda yorug'lik
  // o'zgargan kadr "boshqa odam" bo'lib chiqardi.
  const base = vectorOf((i) => Math.sin(i));
  const scaled = base.map((v) => v * 7.5);

  const a = normalizeEmbedding(base);
  const b = normalizeEmbedding(scaled);

  assert.ok(cosineSimilarity(a, b) > 0.999999, "yo'nalish bir xil bo'lishi kerak");
});

test("pack/unpack: bazaga yozib qaytarilganda vektor O'ZGARMAYDI", () => {
  const vector = normalizeEmbedding(vectorOf((i) => Math.cos(i * 0.7)));
  const buffer = packEmbedding(vector);

  assert.equal(buffer.length, DIM * 4, "float32 → 4 bayt");

  const back = unpackEmbedding(buffer, DIM);
  assert.ok(back, "qaytarilishi kerak");
  assert.equal(back.length, DIM);
  assert.ok(cosineSimilarity(vector, back) > 0.999999);
});

test("pack: BO'LAK vektor ham to'g'ri yoziladi (subarray tuzog'i)", () => {
  // ⚠️ `Buffer.from(view.buffer)` butun asosiy buferni yozib yuborardi.
  // `byteOffset` + `byteLength` bilan olinishi SHART.
  const big = new Float32Array(DIM * 3);
  for (let i = 0; i < big.length; i += 1) big[i] = i;

  const slice = big.subarray(DIM, DIM * 2);
  const buffer = packEmbedding(slice);

  assert.equal(buffer.length, DIM * 4, "faqat bo'lak yoziladi");
  const back = unpackEmbedding(buffer, DIM);
  assert.equal(back[0], DIM, "bo'lakning birinchi elementi");
});

test("unpack: BUZUQ bufer `null` qaytaradi, xato tashlamaydi", () => {
  // ⚠️ Bitta buzuq qator butun galereyani yiqitmasligi kerak
  // (`faceGallery.service.js` bunday namunalarni o'tkazib yuboradi).
  assert.equal(unpackEmbedding(Buffer.alloc(0)), null, "bo'sh");
  assert.equal(unpackEmbedding(Buffer.alloc(13)), null, "4 ga bo'linmaydi");
  assert.equal(unpackEmbedding(Buffer.alloc(DIM * 4), DIM + 1), null, "dim mos emas");
  assert.equal(unpackEmbedding(null), null);
});

test("unpack: BO'LINMAYDIGAN offset ham ishlaydi (Buffer pool tuzog'i)", () => {
  // ⚠️ Node'dagi kichik `Buffer` umumiy pool ustida yashaydi va
  // `byteOffset` 4 ga bo'linmasligi mumkin. `new Float32Array(buf.buffer,
  // buf.byteOffset)` shunda "start offset must be a multiple of 4"
  // bilan YIQILADI — shuning uchun nusxa olinadi.
  const pool = Buffer.alloc(DIM * 4 + 3);
  const odd = pool.subarray(3); // offset 3 — 4 ga bo'linmaydi

  const vector = normalizeEmbedding(vectorOf((i) => i % 5));
  packEmbedding(vector).copy(odd);

  const back = unpackEmbedding(odd, DIM);
  assert.ok(back, "yiqilmasligi kerak");
  assert.ok(cosineSimilarity(vector, back) > 0.999999);
});

test("normalizatsiya: `NaN` va `Infinity` RAD ETILADI", () => {
  // ⚠️ Bitta `NaN` butun taqqoslashni `NaN` ga aylantiradi — natija
  // "hech kim tanilmadi" bo'lib, sababi hech qayerda ko'rinmasdi.
  const withNaN = vectorOf((i) => i);
  withNaN[42] = Number.NaN;
  assert.throws(() => normalizeEmbedding(withNaN), /yaroqsiz son/);

  const withInf = vectorOf((i) => i);
  withInf[7] = Number.POSITIVE_INFINITY;
  assert.throws(() => normalizeEmbedding(withInf), /yaroqsiz son/);
});

test("normalizatsiya: NOL vektor rad etiladi", () => {
  assert.throws(() => normalizeEmbedding(new Array(DIM).fill(0)), /bo'sh/);
});

test("normalizatsiya: o'lcham tekshiriladi", () => {
  assert.throws(() => normalizeEmbedding([1, 2, 3]), /o'lchami noto'g'ri/);
  assert.throws(() => normalizeEmbedding("salom"), /massiv/);
  assert.throws(
    () => normalizeEmbedding(vectorOf(() => 1), { expectedDim: 1024 }),
    /1024 o'lchamli/,
    "model mos kelmasa ochiq xato beradi",
  );
});

test("kosinus: aynan bir xil → 1, qarama-qarshi → -1", () => {
  const a = normalizeEmbedding(vectorOf((i) => Math.sin(i)));
  const b = normalizeEmbedding(vectorOf((i) => -Math.sin(i)));

  assert.ok(cosineSimilarity(a, a) > 0.999999);
  assert.ok(cosineSimilarity(a, b) < -0.999999);
});

test("kosinus: o'lchamlari farq qilsa `-1` (xato EMAS)", () => {
  // ⚠️ Model almashganini xato bilan emas, "tanilmadi" bilan
  // ko'rsatish kerak: bitta eski namuna butun skanerni yiqitmasligi
  // lozim.
  const a = normalizeEmbedding(vectorOf((i) => i + 1));
  const b = normalizeEmbedding(Array.from({ length: 256 }, (_, i) => i + 1));

  assert.equal(cosineSimilarity(a, b), -1);
  assert.equal(cosineSimilarity(a, null), -1);
});

test("kosinus: natija [-1, 1] dan CHIQMAYDI", () => {
  // Suzuvchi nuqta xatosi 1.0000001 berishi mumkin — ekranda
  // "100.00001%" ko'rinardi.
  const a = normalizeEmbedding(vectorOf(() => 1));
  assert.ok(cosineSimilarity(a, a) <= 1);
  assert.ok(cosineSimilarity(a, a) >= -1);
});

test("foiz: manfiy qiymat 0 ga qisiladi, bir xona qoldiriladi", () => {
  assert.equal(scoreToPercent(0.8234), 82.3);
  assert.equal(scoreToPercent(-0.5), 0, "«−50% o'xshash» ma'nosiz");
  assert.equal(scoreToPercent(1), 100);
  assert.equal(scoreToPercent(null), null);
  assert.equal(scoreToPercent(Number.NaN), null);
});
