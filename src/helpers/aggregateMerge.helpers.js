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

/**
 * QO'SHILMAYDIGAN SONLAR — davr, sahifa va identifikator.
 *
 * ⚠️ `month: 202610` ikki filialda ham AYNI bo'lgani uchun odatda shunchaki
 * saqlanadi; lekin kutilmaganda farq qilsa, uni qo'shib yuborish `405220`
 * kabi ma'nosiz raqam berardi. Shuning uchun bunday kalitlar hech qachon
 * qo'shilmaydi: langar filialning qiymati qoladi va meta'da aytiladi.
 */
const KEEP_SEGMENTS = new Set([
  "month",
  "year",
  "day",
  "date",
  "week",
  "quarter",
  "page",
  "limit",
  "offset",
  "version",
  "seq",
  "id",
  "code",
  "from",
  "to",
  "timestamp",
  "epoch",
]);

/**
 * SOZLAMA QIYMATLARI — sanoqchilar ichida yurgan, lekin SANOQ EMAS.
 *
 * ⚠️ Masalan `dueSoonHours` ("muddati yaqin" chegarasi, 24 soat)
 * `GET /tasks/stats` javobida sanoqchilar bilan yonma-yon keladi. Qo'shilsa,
 * to'rt filialda 96 soat bo'lib, "muddati yaqin" kartasi butunlay boshqa
 * narsani ko'rsatardi. Bu ro'yxat — nomi bo'yicha aniq TANILADIGAN
 * sozlamalar; yangisi chiqsa registrdagi `keep` bilan ham berish mumkin.
 */
const SETTING_KEYS = new Set([
  "dueSoonHours",
  "lateArrivalGraceMinutes",
  "offlineGraceMinutes",
  "roundingUnit",
]);

/** `max*` → eng kattasi, `min*` → eng kichigi (qo'shish ma'nosiz). */
const MAX_PREFIX = "max";
const MIN_PREFIX = "min";

/**
 * PUL — 2 XONALI STRING, SON EMAS (`helpers/money.helpers.js` doktrinasi).
 *
 * ⚠️ Moliya javoblarida summa HAR DOIM `formatAmount()` dan chiqqan
 * `"1200000.00"` ko'rinishida keladi. Ilgari bu yerda u oddiy matn deb
 * qabul qilinardi: to'rt filialning tushumi birlashganda LANGAR filialning
 * summasi "butun tarmoq" bo'lib ko'rinardi — jim xato, eng qimmat turi.
 *
 * Shablon ATAYLAB qat'iy (aniq ikki kasr xonasi): id, chek raqami, telefon,
 * kod va versiya ("1.0.0") unga tushmaydi, ya'ni ular tasodifan "pul" deb
 * qo'shilib ketmaydi.
 */
const MONEY_PATTERN = /^-?\d{1,15}\.\d{2}$/;

/** `"1200000.00"` → `120000000n` (tiyin). Noto'g'ri shakl — `null`. */
const toCents = (value) => {
  if (typeof value !== "string" || !MONEY_PATTERN.test(value)) return null;
  const negative = value.startsWith("-");
  const [whole, fraction] = (negative ? value.slice(1) : value).split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction);
  return negative ? -cents : cents;
};

/** `120000000n` → `"1200000.00"`. */
const fromCents = (cents) => {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
};

/**
 * QO'SHIB BO'LMAYDIGAN O'LCHOV BIRLIKLARI.
 *
 * ⚠️ Dashboard kartalari `{ key, unit, value, previous, plan, change }`
 * shaklida keladi va qiymatning kaliti HAR DOIM `value` — ya'ni nomidan
 * uning foizmi yoki pulmi ekanini bilib bo'lmaydi. Foizli kartaning
 * (`margin`, `attendanceRate`) `value` i qo'shilsa, to'rt filialda
 * "96% foyda margini" kabi ma'nosiz raqam chiqardi.
 *
 * Shuning uchun qiymat YONIDAGI `unit` o'qiladi: u ham javobning o'z
 * shartnomasi (`formatByUnit(row.value, row.unit)` — panel ham shundan
 * o'qiydi), taxmin emas.
 */
const NON_SUM_UNITS = new Set([
  // ⚠️ "%" ham shu yerda: faollik lentasi birlikni AYNAN shu belgi bilan
  // yuboradi (`activityDashboard.service.js`), "percent" deb emas. U
  // ro'yxatda bo'lmagani uchun "bot qamrovi" to'rt filialda 240% bo'lib
  // chiqardi.
  "%",
  "percent",
  "point",
  "rate",
  "ratio",
  "grade",
  "score",
  "index",
  "avg",
  "average",
]);

/** Qaysi kalitlar yonidagi `unit` ga bo'ysunadi. */
const UNIT_FIELDS = new Map([
  ["value", "unit"],
  ["previous", "unit"],
  ["plan", "unit"],
  ["target", "unit"],
  ["actual", "unit"],
  // ⚠️ `change` o'z birligiga ega (`changeUnit`): pul kartasida ham u FOIZ
  // o'zgarishi, ya'ni hech qachon qo'shilmaydi.
  ["change", "changeUnit"],
]);

/**
 * Obyektning bolalariga beriladigan birlik maslahati.
 *
 * Faqat HAMMA filial AYNI birlikni aytgan bo'lsa qabul qilinadi: filiallar
 * boshqa-boshqa birlik qaytargan bo'lsa, bu javob shakli o'zgargani degani
 * va taxmin qilishdan ko'ra umumiy qoidaga qaytgan ma'qul.
 *
 * @param {Array<{value: object}>} defined
 * @returns {Object<string, string>}
 */
const unitHints = (defined) => {
  const hints = {};
  for (const [field, source] of UNIT_FIELDS) {
    const units = defined.map((entry) => entry.value?.[source]);
    const first = units[0];
    if (typeof first !== "string") continue;
    if (units.every((unit) => unit === first)) hints[field] = first;
  }
  return hints;
};

/**
 * FILIALLAR KESIMI — "bu raqamning qanchasi qaysi filialdan".
 *
 * ⚠️ Jami raqam ASOSIY javob bo'lib qoladi; kesim esa `meta.aggregate` da
 * YONIDA turadi. Panel uni karta ostida ko'rsatadi va bosilganda o'sha
 * filialga o'tkazadi — "461 o'quvchi" degan raqam "qayerda?" degan
 * savolsiz qolmasin.
 *
 * ⚠️ FAQAT OBYEKT YO'LIDA yoziladi (`track: false` — massiv ichida emas):
 * massiv qatorlarining kaliti takrorlanadi (`data.days` ichidagi har kun
 * bitta yo'lga tushardi) va qatorlar allaqachon `_branch` bilan belgilangan.
 */
const MAX_BRANCH_PATHS = 300;

const recordBranchValues = (notes, path, entries, options) => {
  if (options.track === false) return;
  if (!notes.byBranch || entries.length < 2) return;
  if (notes.byBranch.has(path) || notes.byBranch.size >= MAX_BRANCH_PATHS) return;

  notes.byBranch.set(
    path,
    entries.map((entry) => ({
      branch: entry.branch,
      value: entry.value === undefined ? null : entry.value,
    })),
  );
};

/**
 * Qatorlarni guruhlash uchun kalit nomzodlari.
 *
 * Kunlik/oylik qatorlar (hisobot jadvallari, grafiklar) filiallar bo'ylab
 * ULANMAYDI — AYNI kun AYNI qatorga qo'shiladi. Aks holda bitta sanada
 * to'rtta qator paydo bo'lib, jadval ham, grafik ham ma'nosini yo'qotardi.
 */
const GROUP_KEYS = [
  "date",
  "day",
  "month",
  "week",
  "key",
  "status",
  "kind",
  "type",
  "category",
  "categoryId",
  "classId",
  "subjectId",
  "tariffId",
  "discountId",
  "roleId",
  "id",
  // ⚠️ "id" DAN KEYIN ataylab: baho qatorlarida ikkalasi ham bor
  // (`id` + `grade`) va ular `id` bo'yicha guruhlanishi kerak — aks holda
  // turli o'quvchilarning bir xil bahosi bitta qatorga qo'shilib ketardi.
  // Asl sinf kesimida (`{grade, label, studentCount}`) esa `id` yo'q,
  // ya'ni guruhlash aynan daraja bo'yicha boradi.
  "grade",
];

/**
 * KESIM YOZILADIGAN GURUH KALITLARI (massiv qatorlari uchun).
 *
 * ⚠️ VAQT QATORLARI (kun, oy, hafta) ATAYLAB YO'Q: ular grafik ma'lumoti
 * va har kun uchun alohida kesim yozilsa, 30 kunlik trend butun kesim
 * chegarasini (`MAX_BRANCH_PATHS`) yeb qo'yardi — holbuki odam kesimni
 * KARTADAGI raqam uchun ochadi, grafikning bitta nuqtasi uchun emas.
 *
 * Qolganlari — kartaga aylanadigan, soni tabiiy cheklangan kalitlar
 * (ko'rsatkich kaliti, holat, toifa, sinf darajasi).
 */
const SPLIT_GROUP_KEYS = new Set([
  "key",
  "status",
  "kind",
  "type",
  "category",
  "grade",
]);

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** 24-hex id (loyihadagi barcha id lar shunday). */
const ID_VALUE = /^[0-9a-fA-F]{24}$/;

/**
 * QATOR ODAMNI (yoki YOZUVNI) bildiradimi — "kimlik" testi.
 *
 * ⚠️ BU TEST GURUHLASHNI TO'XTATADI va u MAJBURIY. `GROUP_KEYS` dagi
 * kalitlar (`status`, `type`, `category`...) hisobot qatorlari uchun
 * o'ylangan: "to'langan — 12 ta" degan qator filiallar bo'ylab
 * QO'SHILISHI kerak. Lekin AYNI kalitlar odamlar ro'yxatida ham uchraydi:
 * kunlik davomatda har xodimning o'z `status` i bor
 * (`attendance.service.js` → `getTodayAllRecords`). Natijada 115 ta
 * xodim holat bo'yicha guruhlanib, ekranda UCHTA qator qolgan edi —
 * "Keldi", "Kech keldi", "Belgilanmagan" — va ularning nomi langar
 * filialning birinchi xodimidan olingan edi.
 *
 * Kimlik belgisi: qatorda 24-hex id (`id`, `userId`, `classId`...) yoki
 * `id` si bor ichki obyekt (`{user: {id}}`) bo'lishi. Hisobot qatorida
 * bunday narsa bo'lmaydi — unda o'lchov (kun, holat) va sonlar turadi.
 *
 * ⚠️ Qoida AMALDAGI natijani faqat BITTA holatda o'zgartiradi: kalit
 * takrorlanadigan VA kimligi bor qatorlar. Id bo'yicha guruhlash
 * allaqachon bo'sh ish edi — id har schema'da alohida generatsiya
 * qilinadi, ya'ni guruhda doim bitta qator qolardi.
 *
 * @param {object} row
 * @returns {boolean}
 */
const hasIdentity = (row) => {
  for (const value of Object.values(row)) {
    if (typeof value === "string" && ID_VALUE.test(value)) return true;
    if (isPlainObject(value) && typeof value.id === "string") return true;
  }
  return false;
};


/** Kalitni camelCase bo'laklariga ajratadi. */
const keySegments = (key = "") =>
  String(key)
    .split(/(?=[A-Z])|[_\-\s]+/)
    .map((part) => part.toLowerCase())
    .filter(Boolean);

/** Kalit foiz/o'rtacha ma'nosidami? */
const isRatioKey = (key = "") =>
  keySegments(key).some((part) => RATIO_SEGMENTS.has(part));

/** Kalit davr/identifikator ma'nosidami (qo'shilmaydi)? */
const isKeepKey = (key = "") => {
  if (SETTING_KEYS.has(key)) return true;
  const segments = keySegments(key);
  if (segments.some((part) => KEEP_SEGMENTS.has(part))) return true;
  // `createdAt`, `lastSyncAt`, `updatedAt` — instant, qo'shilmaydi.
  // ⚠️ Oxirgi BO'LAK tekshiriladi, matnning oxiri emas: aks holda
  // `format` yoki `seat` kabi so'zlar ham "sana" deb qabul qilinardi
  // (va `At` katta harf bilan yozilgani uchun matn tekshiruvi jim o'tmasdi).
  return segments.length > 1 && segments[segments.length - 1] === "at";
};

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
/** Bo'sh izohlar to'plami (meta uchun). */
const newNotes = () => ({
  summed: new Set(),
  averaged: new Set(),
  reduced: new Set(),
  grouped: new Set(),
  partial: new Set(),
  // yo'l → `[{branch, value}]` (filiallar kesimi, `recordBranchValues`)
  byBranch: new Map(),
});

/**
 * QATORLAR RO'YXATINI BIRLASHTIRADI — ulash EMAS, GURUHLASH.
 *
 * ⚠️ Kunlik/oylik hisobot qatorlari (kun, oy, holat, sinf kesimi) filiallar
 * bo'ylab shunchaki ulansa, bitta sanada to'rtta qator paydo bo'lardi va
 * jadval ham, grafik ham ma'nosini yo'qotardi. Shuning uchun qatorlar
 * KALIT bo'yicha guruhlanadi (`GROUP_KEYS`) va guruh ichidagi sonlar
 * qo'shiladi.
 *
 * Kaliti yo'q (yoki har filialda boshqa) qatorlar ulanadi va har biriga
 * qaysi filialdan kelgani yoziladi — "top 5 o'quvchi" kabi ro'yxatlarda
 * aynan shu kerak.
 *
 * @param {Array<{value: any[], branch: object}>} entries
 * @returns {any[]}
 */
const mergeRows = (entries, notes, path, options) => {
  const all = entries.flatMap(({ value, branch }) =>
    (value ?? []).map((row) => ({ row, branch })),
  );

  if (!all.length) return [];
  // Primitivlar (matn/son ro'yxati) — belgisiz ulanadi
  if (!all.every(({ row }) => isPlainObject(row))) return all.map(({ row }) => row);

  // Odamlar/yozuvlar ro'yxati guruhlanmaydi — har qator alohida
  // (`hasIdentity` izohiga qarang).
  if (all.some(({ row }) => hasIdentity(row))) {
    return all.map(({ row, branch }) => tagRow(row, branch));
  }

  const groupKey = GROUP_KEYS.find((candidate) =>
    all.every(({ row }) => row[candidate] !== undefined && row[candidate] !== null),
  );

  if (!groupKey) return all.map(({ row, branch }) => tagRow(row, branch));

  const buckets = new Map();
  for (const { row, branch } of all) {
    const id = String(row[groupKey]);
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id).push({ value: row, branch });
  }

  const out = [];
  for (const group of buckets.values()) {
    // Faqat bitta filialda bor qator — o'zi qoladi, filial belgisi bilan
    if (group.length === 1) {
      out.push(tagRow(group[0].value, group[0].branch));
      continue;
    }

    notes.grouped.add(path);
    const keys = [...new Set(group.flatMap((g) => Object.keys(g.value)))];

    // ⚠️ Qator kesimi FAQAT kartaga aylanadigan kalitlarda yoziladi
    // (`SPLIT_GROUP_KEYS`) va yo'lga qatorning kaliti qo'shiladi
    // ("data.metrics[bot_today].value") — aks holda massivning hamma
    // qatori BITTA yo'lga tushib, kesim ma'nosini yo'qotardi.
    const splittable = SPLIT_GROUP_KEYS.has(groupKey) && options.track !== false;
    const rowPath = splittable
      ? `${path}[${String(group[0].value[groupKey])}]`
      : path;
    const rowOptions = {
      ...options,
      track: splittable,
      units: unitHints(group),
    };
    const merged = {};
    for (const childKey of keys) {
      // ⚠️ GURUH KALITI BIRLASHTIRILMAYDI. U qatorning KIMLIGI: "5-sinf"
      // ikki filialda ham 5 bo'lgani uchun qo'shilsa 10-sinfga aylanardi.
      if (childKey === groupKey) {
        merged[childKey] = group[0].value[groupKey];
        continue;
      }
      merged[childKey] = mergeValue(
        childKey,
        group.map((g) => ({ value: g.value[childKey], branch: g.branch })),
        notes,
        rowPath,
        rowOptions,
      );
    }
    out.push(merged);
  }

  return out;
};

/**
 * Bitta qiymatni filiallar bo'ylab birlashtiradi.
 *
 * Qoidalar (tartib bilan):
 *   1. registrda "tegilmasin" (`keep`) yoki davr/identifikator kaliti
 *      (`month`, `page`, `createdAt`...) → langar filialniki qoladi
 *   2. `max*` / `min*`              → eng katta / eng kichik
 *   3. foiz, o'rtacha yoki yonidagi `unit` qo'shib bo'lmaydigan birlik
 *                                   → o'rtacha (QO'SHILMAYDI)
 *   4. qolgan sonlar va PUL ("1200000.00") → qo'shiladi
 *   5. hamma joyda AYNI qiymat (son emas) → o'zi qoladi
 *   6. ro'yxatlar                   → kalit bo'yicha guruhlanadi
 *   7. obyektlar                    → ichkariga kirib, shu qoidalar qayta
 *   8. turlar aralash               → langar filialniki + meta'da ogohlantirish
 *
 * ⚠️ SONLAR TENGLIK TEKSHIRUVIDAN OLDIN keladi (ilgari teskari edi): ikki
 * filialda ham 120 o'quvchi bo'lsa, jami 240 — 120 emas.
 *
 * @param {string} key
 * @param {Array<{value: any, branch: object}>} entries
 * @param {object} notes
 * @param {string} [prefix]
 * @param {{keep?: Set<string>, units?: object, track?: boolean}} [options]
 */
const mergeValue = (key, entries, notes, prefix = "", options = {}) => {
  const path = prefix ? `${prefix}.${key}` : key;
  const defined = entries.filter(
    (entry) => entry.value !== undefined && entry.value !== null,
  );

  if (defined.length === 0) return entries[0]?.value ?? null;

  const numeric = defined.every(
    (entry) => typeof entry.value === "number" && Number.isFinite(entry.value),
  );

  // Pul — 2 xonali string (`MONEY_PATTERN` izohiga qarang).
  const money =
    !numeric &&
    defined.every(
      (entry) => typeof entry.value === "string" && MONEY_PATTERN.test(entry.value),
    );

  if (numeric || money) {
    // ⚠️ Sozlama va davr qiymatlari QO'SHILMAYDI: "24 soat" chegarasi to'rt
    // filialda 96 soatga aylanib qolardi.
    if (options.keep?.has(key) || isKeepKey(key)) {
      if (!defined.every((entry) => entry.value === defined[0].value)) {
        notes.partial.add(path);
      }
      return defined[0].value;
    }

    // Kesim jami raqam bilan BIRGA yoziladi: "qancha" yonida "qayerda".
    recordBranchValues(notes, path, entries, options);

    const numbers = numeric ? defined.map((entry) => entry.value) : null;
    const cents = money ? defined.map((entry) => toCents(entry.value)) : null;
    const segments = keySegments(key);

    if (segments[0] === MAX_PREFIX || segments[0] === MIN_PREFIX) {
      notes.reduced.add(path);
      const takeMax = segments[0] === MAX_PREFIX;
      if (numeric) return takeMax ? Math.max(...numbers) : Math.min(...numbers);
      return fromCents(
        cents.reduce((acc, value) =>
          takeMax ? (value > acc ? value : acc) : value < acc ? value : acc,
        ),
      );
    }

    if (defined.length === 1) return defined[0].value;

    // Foiz/baho/ball — nomidan ham (`attendancePercent`), yonidagi `unit`
    // dan ham (`{unit: "percent", value: 24.1}`) aniqlanadi.
    const unit = options.units?.[key];
    if (isRatioKey(key) || (typeof unit === "string" && NON_SUM_UNITS.has(unit))) {
      notes.averaged.add(path);
      if (numeric) {
        const sum = numbers.reduce((acc, value) => acc + value, 0);
        return Math.round((sum / numbers.length) * 100) / 100;
      }
      const total = cents.reduce((acc, value) => acc + value, 0n);
      const count = BigInt(cents.length);
      const half = count / 2n;
      return fromCents((total + (total >= 0n ? half : -half)) / count);
    }

    notes.summed.add(path);
    if (numeric) return numbers.reduce((acc, value) => acc + value, 0);
    return fromCents(cents.reduce((acc, value) => acc + value, 0n));
  }

  if (defined.length === 1) return defined[0].value;

  // ⚠️ OBYEKT HAR DOIM ICHKARIGA KIRIB birlashtiriladi — tenglikdan OLDIN.
  // Ikki filialning sanoqchilar bloki tasodifan aynan teng chiqishi mumkin
  // (`{students: 120, workers: 0}`) va "teng → o'zi qoladi" qoidasi butun
  // blokni yarmiga tushirib qo'yardi. Ichkarida esa har kalit O'Z qoidasini
  // oladi: sanoqchi qo'shiladi, sozlama tegilmaydi, foiz o'rtachalanadi.
  if (defined.every((entry) => isPlainObject(entry.value))) {
    const keys = [...new Set(defined.flatMap((entry) => Object.keys(entry.value)))];
    // Birlik maslahati HAR OBYEKT uchun qaytadan hisoblanadi — yuqoridagi
    // kartaning `unit` i pastdagi boshqa blokka ergashib ketmasin.
    const childOptions = { ...options, units: unitHints(defined) };
    const merged = {};
    for (const childKey of keys) {
      merged[childKey] = mergeValue(
        childKey,
        defined.map((entry) => ({ value: entry.value[childKey], branch: entry.branch })),
        notes,
        path,
        childOptions,
      );
    }
    return merged;
  }

  // Massiv va qolgan turlar uchun tenglik SAQLANADI: har filialda AYNI
  // ro'yxat (platforma katalogi) ulansa, u filial soniga ko'payib ko'rinardi.
  if (defined.every((entry) => deepEqual(entry.value, defined[0].value))) {
    return defined[0].value;
  }

  if (defined.every((entry) => Array.isArray(entry.value))) {
    return mergeRows(defined, notes, path, options);
  }

  // Turlar aralash (matn/boolean/son) — birlashtirib bo'lmaydi. Langar
  // filialning qiymati qoladi va bu META da OCHIQ aytiladi.
  notes.partial.add(path);
  return defined[0].value;
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
  const notes = newNotes();

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
      results.map(({ branch, body }) => ({ value: body[key], branch })),
      notes,
      "",
      options,
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
const mergeObject = (results, options = {}) => {
  const notes = newNotes();
  const entries = results.map(({ branch, body }) => ({ value: body?.data, branch }));

  // Ro'yxat bo'lsa — qatorlar kalit bo'yicha guruhlanadi (`mergeRows`),
  // obyekt bo'lsa — maydonlar bo'yicha ichkariga kiriladi.
  const data = Array.isArray(entries[0]?.value)
    ? mergeRows(entries, notes, "data", options)
    : mergeValue("data", entries, notes, "", options);

  // `data` dan tashqari kalitlar (sarlavha, jami, sozlama) ham birlashadi.
  const reserved = new Set(["success", "data", "pagination", "message", "meta"]);
  const extraKeys = [
    ...new Set(
      results.flatMap(({ body }) =>
        Object.keys(body ?? {}).filter((key) => !reserved.has(key)),
      ),
    ),
  ];

  const extras = {};
  for (const key of extraKeys) {
    extras[key] = mergeValue(
      key,
      results.map(({ branch, body }) => ({ value: body?.[key], branch })),
      notes,
      "",
      options,
    );
  }

  return { data, extras, notes };
};

/**
 * `Set` larni meta uchun massivga aylantiradi (bo'shlari tashlanadi).
 *
 * FILIALLAR KESIMI ixcham shaklda chiqadi: filiallar ro'yxati BIR MARTA,
 * qiymatlar esa o'sha ro'yxatga MOS TARTIBDAGI massiv bilan:
 *
 *   byBranch: {
 *     branches: [{id, code, name, shortName}, ...],
 *     values:   { "data.students": [120, 90, null, 251] }
 *   }
 *
 * ⚠️ Ro'yxat kesimning O'Z ICHIDA turadi, `meta.branches` ga ISHORA
 * QILMAYDI: ikki ro'yxatning tartibi kelajakda ajralib ketsa, raqamlar
 * jimgina boshqa filialga yozilib ketardi.
 *
 * `null` — o'sha filial bu raqamni umuman qaytarmagan (bo'lim yo'q yoki
 * ruxsat yopiq); nol bilan adashtirmaslik uchun ataylab `null`.
 */
const notesToMeta = (notes) => {
  const meta = {};
  if (notes.summed.size) meta.summed = [...notes.summed];
  if (notes.averaged.size) meta.averaged = [...notes.averaged];
  if (notes.reduced?.size) meta.reduced = [...notes.reduced];
  if (notes.grouped?.size) meta.grouped = [...notes.grouped];
  if (notes.partial.size) meta.partial = [...notes.partial];

  if (notes.byBranch?.size) {
    const branches = [];
    const index = new Map();

    for (const rows of notes.byBranch.values()) {
      for (const { branch } of rows) {
        if (!branch?.id || index.has(branch.id)) continue;
        index.set(branch.id, branches.length);
        branches.push(branch);
      }
    }

    if (branches.length > 1) {
      const values = {};
      for (const [path, rows] of notes.byBranch) {
        const line = new Array(branches.length).fill(null);
        for (const { branch, value } of rows) {
          const at = index.get(branch?.id);
          if (at !== undefined) line[at] = value;
        }
        values[path] = line;
      }
      meta.byBranch = { branches, values };
    }
  }

  return meta;
};

module.exports = {
  BRANCH_FIELD,
  MONEY_PATTERN,
  NON_SUM_UNITS,
  toCents,
  fromCents,
  unitHints,
  newNotes,
  mergeRows,
  SETTING_KEYS,
  isKeepKey,
  keySegments,
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
