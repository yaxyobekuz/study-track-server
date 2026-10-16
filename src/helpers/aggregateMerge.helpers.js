/**
 * UMUMIY KO'RINISH — JAVOBLARNI BIRLASHTIRISH (sof funksiyalar).
 *
 * So'rov har filialda ALOHIDA bajariladi (`middleware/aggregate.middleware.js`),
 * natijada N ta javob paydo bo'ladi. Shu fayl ulardan BITTA javob yasaydi.
 *
 * ⚠️ ASOSIY DOKTRINA — **TAXMIN QILINGAN RAQAM YO'Q.** Faqat to'g'ri
 * birlashtiriladigan narsa birlashtiriladi:
 *
 *   - ro'yxat (massiv)      → ulanadi va har qatorga `_branch` yoziladi
 *   - sanoqchi (son)        → qo'shiladi
 *   - bir xil qiymat        → o'zi qoladi (platforma ma'lumoti: rol, tarif)
 *   - foiz / o'rtacha       → filiallar bo'yicha O'RTACHA (qo'shilmaydi!)
 *   - qolgani               → birlashtirilmaydi, `meta.aggregate` da aytiladi
 *
 * Aks holda ekranda "butun tarmoq bo'yicha 174% davomat" kabi raqam paydo
 * bo'lardi — jim xato, eng qimmat turi.
 *
 * ⚠️ SAHIFALASH TO'G'RILIGI. Dispatcher har filialdan `page*limit` tagacha
 * BIRINCHI qatorlarni so'raydi (`page=1`), keyin bu yerda birlashtirilib
 * kerakli bo'lak qirqiladi. Global birinchi N qator har filialning birinchi
 * N qatoridan tashqarida bo'lishi MUMKIN EMAS, shuning uchun natija aniq —
 * BITTA shart bilan: bu yerdagi saralash filialning o'z saralashi bilan mos
 * bo'lishi kerak (shuning uchun yirik ro'yxatlar uchun tartib registrda
 * ATAYLAB e'lon qilinadi — `aggregateRoute.registry.js`).
 */

/** Qatorga qaysi filialdan kelgani yoziladigan maydon. */
const BRANCH_FIELD = "_branch";

/**
 * FOIZ / O'RTACHA KO'RINISHIDAGI KALITLAR — qo'shilmaydi, o'rtachalanadi.
 *
 * Kalit camelCase bo'laklariga ajratiladi va BUTUN bo'lak solishtiriladi:
 * aks holda "generated" ichidagi "rate" ham foiz deb qabul qilinardi.
 */
const RATIO_SEGMENTS = new Set([
  "percent",
  "percentage",
  "ratio",
  "rate",
  "avg",
  "average",
  "mean",
]);

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Kalit foiz/o'rtacha ma'nosidami? */
const isRatioKey = (key = "") =>
  String(key)
    .split(/(?=[A-Z])|[_\-\s]+/)
    .map((part) => part.toLowerCase())
    .some((part) => RATIO_SEGMENTS.has(part));

/**
 * Nuqtali yo'l bo'yicha qiymat (`"student.fullName"`).
 * @returns {*}
 */
const getPath = (row, path) => {
  if (!path) return undefined;
  let current = row;
  for (const part of String(path).split(".")) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
};

/**
 * Chuqur tenglik — "bu platforma ma'lumoti" degan xulosa uchun.
 *
 * ⚠️ NIMA UCHUN KERAK: tarif, chegirma va rol katalogi PLATFORMADA yashaydi,
 * ya'ni har filial AYNI ro'yxatni qaytaradi. Ularni ulab qo'ysak, bitta
 * tarif ro'yxatda filial soniga ko'payib ko'rinardi. Tenglik aniqlansa javob
 * O'ZGARTIRILMASDAN qaytariladi.
 *
 * ⚠️ Tasodifiy tenglik xavfi YO'Q: filial ma'lumotining `id` lari har
 * schema'da alohida generatsiya qilinadi, ya'ni ikki filialning qatorlari
 * aynan teng bo'lolmaydi. Bo'sh ro'yxatlar esa teng va natija ham bo'sh —
 * bu to'g'ri javob.
 *
 * @param {*} a
 * @param {*} b
 * @param {{budget?: number}} [options] - solishtiriladigan tugunlar chegarasi
 * @returns {boolean}
 */
const deepEqual = (a, b, options = {}) => {
  const state = { left: options.budget ?? 20000 };
  const walk = (x, y) => {
    if (state.left-- <= 0) return false; // juda katta — tenglikka da'vo qilmaymiz
    if (x === y) return true;
    if (typeof x !== typeof y) return false;
    if (x === null || y === null) return false;
    if (x instanceof Date || y instanceof Date) {
      return (
        x instanceof Date &&
        y instanceof Date &&
        x.getTime() === y.getTime()
      );
    }
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y)) return false;
      if (x.length !== y.length) return false;
      return x.every((item, index) => walk(item, y[index]));
    }
    if (isPlainObject(x) && isPlainObject(y)) {
      const keys = Object.keys(x);
      if (keys.length !== Object.keys(y).length) return false;
      return keys.every(
        (key) => Object.hasOwn(y, key) && walk(x[key], y[key]),
      );
    }
    return false;
  };
  return walk(a, b);
};

/**
 * Qatorga filial belgisini qo'yadi.
 *
 * ⚠️ MAVJUD `_branch` USTIDAN YOZILMAYDI: ichki (nested) ro'yxat allaqachon
 * belgilangan bo'lishi mumkin, qayta yozish uni buzardi.
 *
 * @param {*} row
 * @param {object} branchLabel - `{id, code, name, shortName}`
 * @returns {*}
 */
const tagRow = (row, branchLabel) => {
  if (!isPlainObject(row)) return row; // primitiv qatorga belgi qo'yilmaydi
  if (row[BRANCH_FIELD]) return row;
  return { ...row, [BRANCH_FIELD]: branchLabel };
};

/**
 * Saralash komparatori.
 *
 * @param {Array<{field: string, dir?: "asc"|"desc"}>} spec
 * @returns {(a: object, b: object) => number}
 */
const comparatorFor = (spec = []) => {
  const compareOne = (a, b) => {
    if (a === b) return 0;
    // Bo'sh qiymat har doim OXIRIDA — tartib yo'nalishidan qat'i nazar:
    // "sanasi yo'q" qator ro'yxat boshiga chiqib qolmasligi kerak.
    if (a === null || a === undefined) return 1;
    if (b === null || b === undefined) return -1;

    const an = a instanceof Date ? a.getTime() : a;
    const bn = b instanceof Date ? b.getTime() : b;

    if (typeof an === "number" && typeof bn === "number") return an - bn;

    const as = String(an);
    const bs = String(bn);
    return as < bs ? -1 : as > bs ? 1 : 0;
  };

  return (rowA, rowB) => {
    for (const { field, dir = "asc" } of spec) {
      const raw = compareOne(getPath(rowA, field), getPath(rowB, field));
      if (raw !== 0) {
        // Bo'sh qiymat (±1) yo'nalishga qarab aylanmasligi kerak, shuning
        // uchun faqat haqiqiy taqqoslash teskari qilinadi.
        const aEmpty = getPath(rowA, field) == null;
        const bEmpty = getPath(rowB, field) == null;
        if (aEmpty || bEmpty) return raw;
        return dir === "desc" ? -raw : raw;
      }
    }
    return 0;
  };
};

/**
 * Tartib e'lon qilinmagan bo'lsa — `createdAt` bo'yicha kamayish tartibi
 * (loyihadagi ro'yxatlarning ustun qismi aynan shunday saralaydi), u ham
 * bo'lmasa tartib o'zgartirilmaydi.
 *
 * @param {object[]} rows
 * @returns {Array<{field: string, dir: string}>|null}
 */
const inferSort = (rows) => {
  if (!rows.length) return null;
  const objects = rows.filter(isPlainObject);
  if (objects.length !== rows.length) return null;
  if (objects.every((row) => row.createdAt != null)) {
    return [{ field: "createdAt", dir: "desc" }];
  }
  return null;
};

/**
 * Qo'shimcha (data/pagination dan boshqa) kalitlarni birlashtiradi.
 *
 * @param {string} key
 * @param {*[]} values - har filialdan (aniqlanmaganlari TASHLANGAN)
 * @param {object} notes - `{ summed: Set, averaged: Set, partial: Set }`
 * @param {string} [prefix] - meta uchun to'liq yo'l
 * @returns {*}
 */
const mergeValue = (key, values, notes, prefix = "") => {
  const path = prefix ? `${prefix}.${key}` : key;
  const defined = values.filter((v) => v !== undefined && v !== null);

  if (defined.length === 0) return values[0] ?? null;
  if (defined.length === 1) return defined[0];
  if (defined.every((v) => deepEqual(v, defined[0]))) return defined[0];

  if (defined.every((v) => typeof v === "number" && Number.isFinite(v))) {
    if (isRatioKey(key)) {
      notes.averaged.add(path);
      const sum = defined.reduce((acc, v) => acc + v, 0);
      return Math.round((sum / defined.length) * 100) / 100;
    }
    notes.summed.add(path);
    return defined.reduce((acc, v) => acc + v, 0);
  }

  if (defined.every(Array.isArray)) {
    return defined.flat();
  }

  if (defined.every(isPlainObject)) {
    const keys = [...new Set(defined.flatMap((v) => Object.keys(v)))];
    const merged = {};
    for (const childKey of keys) {
      merged[childKey] = mergeValue(
        childKey,
        defined.map((v) => v[childKey]),
        notes,
        path,
      );
    }
    return merged;
  }

  // Turlar aralash (matn/boolean/son) — birlashtirib bo'lmaydi. Birinchi
  // (langar) filialning qiymati qoladi va bu META da OCHIQ aytiladi.
  notes.partial.add(path);
  return defined[0];
};

/**
 * RO'YXATLARNI BIRLASHTIRADI.
 *
 * @param {Array<{branch: object, body: object}>} results - faqat muvaffaqiyatli
 * @param {object} options
 * @param {number} [options.page] - mijoz so'ragan sahifa
 * @param {number} [options.limit] - mijoz so'ragan hajm
 * @param {Array} [options.sort] - e'lon qilingan tartib
 * @returns {{data: any[], pagination: object|null, extras: object, notes: object}}
 */
const mergeList = (results, options = {}) => {
  const notes = { summed: new Set(), averaged: new Set(), partial: new Set() };

  const rows = results.flatMap(({ branch, body }) =>
    (body.data ?? []).map((row) => tagRow(row, branch)),
  );

  const sort = options.sort ?? inferSort(rows);
  const sorted = sort ? [...rows].sort(comparatorFor(sort)) : rows;

  // Sahifalash: filialning HAR BIRI o'z `pagination` ini qaytargan bo'lsa.
  const paginations = results.map(({ body }) => body.pagination);
  const paginated = paginations.every(isPlainObject);

  let data = sorted;
  let pagination = null;

  if (paginated) {
    // ⚠️ Mijoz `page`/`limit` yubormagan bo'lsa ular ENDPOINTNING O'Z
    // sukutidan olinadi (javobdagi `pagination`), chunki har endpoint
    // `getPaginationParams` ga boshqa sukut berishi mumkin. Taxmin qilingan
    // 24 bilan qirqilsa, sukuti 50 bo'lgan ro'yxat yarmini yo'qotardi.
    const page = Math.max(
      1,
      Number(options.page) || Number(paginations[0].page) || 1,
    );
    const limit = Math.max(
      1,
      Number(options.limit) || Number(paginations[0].limit) || sorted.length || 1,
    );
    const total = paginations.reduce(
      (acc, p) => acc + (Number(p.total) || 0),
      0,
    );
    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;

    data = sorted.slice(offset, offset + limit);
    pagination = {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };
  }

  // `data`/`pagination`/`success`/`message` dan boshqa kalitlar (jami,
  // sanoqchilar) — o'z qoidalari bilan birlashtiriladi.
  const reserved = new Set(["success", "data", "pagination", "message", "meta"]);
  const extraKeys = [
    ...new Set(
      results.flatMap(({ body }) =>
        Object.keys(body).filter((key) => !reserved.has(key)),
      ),
    ),
  ];

  const extras = {};
  for (const key of extraKeys) {
    extras[key] = mergeValue(
      key,
      results.map(({ body }) => body[key]),
      notes,
    );
  }

  return { data, pagination, extras, notes, sort };
};

/**
 * OBYEKT JAVOBLARNI BIRLASHTIRADI (sanoqchilar, dashboard bloklari).
 *
 * ⚠️ FAQAT REGISTRDA E'LON QILINGAN yo'llar uchun chaqiriladi: har qanday
 * obyektni avtomatik qo'shib yuborish — aynan taxmin qilingan raqam.
 *
 * @param {Array<{branch: object, body: object}>} results
 * @returns {{data: *, notes: object}}
 */
const mergeObject = (results) => {
  const notes = { summed: new Set(), averaged: new Set(), partial: new Set() };
  const values = results.map(({ body }) => body.data);

  if (values.every(Array.isArray)) {
    const data = results.flatMap(({ branch, body }) =>
      (body.data ?? []).map((row) => tagRow(row, branch)),
    );
    return { data, notes };
  }

  const data = mergeValue(
    "data",
    values,
    notes,
  );

  return { data, notes };
};

/** `Set` larni meta uchun massivga aylantiradi (bo'shlari tashlanadi). */
const notesToMeta = (notes) => {
  const meta = {};
  if (notes.summed.size) meta.summed = [...notes.summed];
  if (notes.averaged.size) meta.averaged = [...notes.averaged];
  if (notes.partial.size) meta.partial = [...notes.partial];
  return meta;
};

module.exports = {
  BRANCH_FIELD,
  isPlainObject,
  isRatioKey,
  getPath,
  deepEqual,
  tagRow,
  comparatorFor,
  inferSort,
  mergeValue,
  mergeList,
  mergeObject,
  notesToMeta,
};
