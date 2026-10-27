/**
 * MAVZULAR REJASINI FAYLDAN O'QISH (sof funksiyalar, bazaga tegmaydi).
 *
 * Fanning mavzular rejasi Excel / Google Sheets'dan yuklanadi
 * (`topic.service.js`). Shablon:
 *
 *     Daraja | Kitob | Mavzu | Nimalar o'rgatiladi
 *
 * Eski shablon (`Mavzu nomi | Tavsif`) ham o'qiladi.
 *
 * ⚠️ USTUN SARLAVHA NOMI BO'YICHA TOPILADI, O'RNI BO'YICHA EMAS. Ilgari
 * "2-ustun — nom, 3-ustun — tavsif" deb olinardi va yangi shablonda mavzu
 * nomi o'rniga daraja ("Beginner") yozilib qolardi. Bundan tashqari
 * `sheet_to_json` bo'sh katakni qatordan butunlay tushirib qoldiradi:
 * birinchi katagi bo'sh qatorda ustunlar bittaga surilib, tavsif nom bo'lib
 * ketardi — xato jim edi.
 *
 * ⚠️ FAQAT "MAVZU" MAJBURIY. Daraja, Kitob va "Nimalar o'rgatiladi" —
 * ixtiyoriy: ustun umuman bo'lmasligi ham, ayrim qatorlarda bo'sh turishi
 * ham XATO EMAS (ingliz tili rejasida 1165 mavzudan 982 tasida "Nimalar
 * o'rgatiladi" yo'q — mazmun mavzu nomining o'zida). Bunday holat yuklashni
 * to'xtatmaydi, faqat hisobotda MA'LUMOT sifatida aytiladi — ogohlantirish
 * (`warnings`) esa faqat haqiqatan yuklanmay qolgan narsa uchun.
 *
 * ⚠️ T/R USTUNI PLATFORMA UCHUN YO'Q (biznes qarori, 2026-10-22). Faylda
 * bo'lsa ham hech narsaga ta'sir qilmaydi: u faylni ustunsiz yuklash bilan
 * AYNAN bir xil natija beradi. Ustun faqat TANILADI (`serial`), ikki sabab
 * bilan: "Mavzu raqami" sarlavhasi mavzu NOMI deb olinmasin, va faqat T/R
 * yozilgan qator (oldindan raqamlab qo'yilgan bo'sh shablon) bo'sh qator
 * hisoblansin. Hisobotda ham, ko'rsatmalarda ham u tilga olinmaydi.
 *
 * ⚠️ MAVZU RAQAMINI PLATFORMA O'ZI BERADI — fayldagi qatorlar tartibida
 * (bo'sh qatorlar sanalmaydi). Dars jadvalidagi ankorlar
 * (`LessonTopicBinding.topicOrder`) aynan shu raqamga tayanadi. Nomi bo'sh,
 * lekin boshqa ma'lumoti bor qator raqamni EGALLAYDI (o'rtada bo'lsa):
 * keyin nomi to'ldirilib qayta yuklansa, undan keyingi mavzular surilmaydi
 * va biriktirilgan ankorlar boshqa mavzuga o'tib ketmaydi. Bo'sh qolgan
 * raqam hisobotda aytiladi, jadvalda esa o'sha darsda sababi ko'rinadi
 * (`TOPIC_MISS_REASONS.missingTopic`).
 */

/** Hisobot va xabarlarda ishlatiladigan ustun nomlari (shablondagi kabi). */
const TOPIC_COLUMN_LABELS = Object.freeze({
  level: "Daraja",
  book: "Kitob",
  name: "Mavzu",
  description: "Nimalar o'rgatiladi",
});

/** Ixtiyoriy maydonlar — shablondagi tartibda. */
const OPTIONAL_TOPIC_FIELDS = Object.freeze(["level", "book", "description"]);

/** Sarlavha qatori qidiriladigan eng ko'p qator (tepada nom/sarlavha bo'lishi mumkin). */
const HEADER_SCAN_ROWS = 10;

/**
 * USTUNNI TANISH QOIDALARI — TARTIB MUHIM.
 *
 * Bitta sarlavha bir nechta qoidaga mos kelishi mumkin va birinchi mos
 * kelgani yutadi:
 *   · "Mavzu raqami" — fayldagi tartib raqami (`serial`, e'tiborsiz), mavzu
 *     nomi EMAS (`serial` birinchi);
 *   · "Mavzu tavsifi" — mazmun, nom EMAS (`description` `name` dan oldin);
 *   · "Kitob nomi" — kitob, mavzu nomi EMAS (`book` `name` dan oldin).
 *
 * Sarlavha `normalizeHeader` dan o'tgan bo'ladi (kichik harf, apostrofsiz).
 */
const COLUMN_RULES = Object.freeze([
  {
    // T/R, №, "Tartib raqami" — taniladi, lekin O'QILMAYDI (u faylni o'qiydigan odam uchun)
    field: "serial",
    test: (h) => /^(t\/?r|№|#|n|no|n°)$/.test(h) || /(^|\s)(raqami?|tartibi?)(\s|$)/.test(h),
  },
  {
    field: "description",
    test: (h) => /(orgatil|organil|tavsif|izoh|mazmun|description)/.test(h),
  },
  { field: "book", test: (h) => /(kitob|darslik|qollanma|manba|book)/.test(h) },
  { field: "level", test: (h) => /(daraja|level)/.test(h) },
  { field: "name", test: (h) => /(mavzu|topic)/.test(h) || /^nomi?$/.test(h) },
]);

/**
 * SARLAVHANI TAQQOSLASH UCHUN NORMALLASHTIRADI.
 *
 * Kichik harf, apostrof variantlari (`ʻ ʼ ' ‘ ’ `` ´`) olib tashlanadi —
 * "Nimalar o'rgatiladi" va "Nimalar oʻrgatiladi" bitta sarlavha. Oxiridagi
 * ":" va "*" ("Mavzu*") ham tushiriladi.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeHeader(value) {
  return String(value ?? "")
    .replace(/[‘’ʻʼ'`´]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[\s:*]+$/, "");
}

/** Katak qiymati → tozalangan matn (bo'sh bo'lsa ""). */
function cellText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/** 0 → "A", 25 → "Z", 26 → "AA". */
function columnLetter(index) {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rest = (n - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** Bitta sarlavha qaysi maydon — tanilmasa `null`. */
function fieldOfHeader(header) {
  const normalized = normalizeHeader(header);
  if (!normalized) return null;
  return COLUMN_RULES.find((rule) => rule.test(normalized))?.field ?? null;
}

/**
 * SARLAVHA QATORIDAN USTUNLAR XARITASI.
 *
 * Bitta maydon ikki ustunda uchrasa BIRINCHISI olinadi va bu hisobotda
 * aytiladi — qaysi ustundan o'qilgani jim qolmasin.
 *
 * @param {unknown[]} headerRow
 * @param {number} [colOffset=0] - varaq diapazoni A ustunidan boshlanmasa
 * @returns {{
 *   columns: Record<string, number>,
 *   duplicates: string[],
 *   ignored: string[]
 * }} `columns` — maydon → ustun indeksi (massivdagi)
 */
function detectTopicColumns(headerRow, colOffset = 0) {
  const columns = {};
  const duplicates = [];
  const ignored = [];

  (headerRow ?? []).forEach((cell, index) => {
    const text = cellText(cell);
    if (!text) return;

    const field = fieldOfHeader(text);
    if (!field) {
      ignored.push(`"${text}" (${columnLetter(index + colOffset)})`);
      return;
    }
    if (columns[field] !== undefined) {
      // T/R o'qilmaydi — uning ikkinchi nusxasi ham hech narsani o'zgartirmaydi
      if (field === "serial") return;
      duplicates.push(
        `"${TOPIC_COLUMN_LABELS[field]}" ustuni ikki marta uchradi — ` +
          `${columnLetter(columns[field] + colOffset)} ustuni olindi, ` +
          `${columnLetter(index + colOffset)} e'tiborsiz qoldirildi`,
      );
      return;
    }
    columns[field] = index;
  });

  return { columns, duplicates, ignored };
}

/**
 * BITTA VARAQDAN MAVZULAR.
 *
 * @param {unknown[][]} rows - varaq qatorlari (`sheet_to_json(..., { header: 1 })`)
 * @param {object} [options]
 * @param {number} [options.rowOffset=0] - `rows[0]` ning varaqdagi indeksi (0 — 1-qator)
 * @param {number} [options.colOffset=0] - `rows[i][0]` ning varaqdagi ustun indeksi
 * @returns {{
 *   error: string|null,
 *   columns: Record<string, string|null>,
 *   topics: Array<{order: number, name: string, level: string|null, book: string|null, description: string|null}>,
 *   warnings: string[],
 *   notes: string[],
 *   emptyCounts: Record<string, number>,
 *   missingColumns: string[]
 * }}
 *   `error` — varaq UMUMAN yuklanmaydi (sababi); `warnings` — yuklanmay
 *   qolgan qatorlar; `notes` — ixtiyoriy ma'lumot bo'shligi (xato emas).
 */
function parseTopicSheet(rows, { rowOffset = 0, colOffset = 0 } = {}) {
  const result = {
    error: null,
    columns: {},
    topics: [],
    warnings: [],
    notes: [],
    emptyCounts: {},
    missingColumns: [],
  };

  const list = Array.isArray(rows) ? rows : [];
  const isBlank = (row) => !Array.isArray(row) || row.every((cell) => cellText(cell) === "");

  if (list.every(isBlank)) {
    result.error = "Varaq bo'sh";
    return result;
  }

  // Sarlavha qatori — "Mavzu" ustuni bor va ENG KO'P ustuni tanilgan qator
  // (tenglikda — birinchisi). Tepada sarlavha matni bo'lishi mumkin
  // ("Ingliz tili mavzulari") va u ham "mavzu" so'zini o'z ichiga oladi:
  // birinchi mos qator olinsa, haqiqiy sarlavha qatori mavzu bo'lib
  // yozilib qolardi.
  let headerIndex = -1;
  let detected = null;
  for (let index = 0; index < Math.min(list.length, HEADER_SCAN_ROWS); index += 1) {
    const candidate = detectTopicColumns(list[index], colOffset);
    if (candidate.columns.name === undefined) continue;
    const score = Object.keys(candidate.columns).length;
    if (!detected || score > Object.keys(detected.columns).length) {
      headerIndex = index;
      detected = candidate;
    }
  }

  const expected = Object.values(TOPIC_COLUMN_LABELS).join(", ");
  if (!detected) {
    result.error =
      `"Mavzu" ustuni topilmadi. Birinchi qatorda ustun nomlari bo'lishi kerak: ${expected}. ` +
      `"Mavzu" majburiy, qolganlari ixtiyoriy`;
    return result;
  }

  const { columns } = detected;
  for (const [field, index] of Object.entries(columns)) {
    // T/R hisobotga kirmaydi — u o'qilmaydi
    if (field === "serial") continue;
    result.columns[field] = columnLetter(index + colOffset);
  }
  result.warnings.push(...detected.duplicates);
  result.missingColumns = OPTIONAL_TOPIC_FIELDS.filter((field) => columns[field] === undefined);
  for (const field of OPTIONAL_TOPIC_FIELDS) {
    if (columns[field] !== undefined) result.emptyCounts[field] = 0;
  }

  const read = (row, field) =>
    columns[field] === undefined ? "" : cellText(row[columns[field]]);

  // ⚠️ T/R KATAGI QATORNI "TO'LDIRMAYDI": faqat raqami yozilgan qator —
  // bo'sh qator (oldindan raqamlab qo'yilgan shablon). Aks holda T/R
  // ustunining bor-yo'qligi mavzu raqamlarini o'zgartirib yuborardi.
  const serialIndex = columns.serial;
  const isBlankData = (row) =>
    !Array.isArray(row) ||
    row.every((cell, index) => index === serialIndex || cellText(cell) === "");

  // Avval qatorlar raqamlanadi, keyin quyruq aniqlanadi: oxirgi mavzudan
  // KEYINGI, faqat tanilmagan ustunlarda yozuvi bor nomsiz qatorlar jim
  // tashlanadi — ular hech qaysi mavzuning raqamini surmaydi.
  const entries = [];
  let position = 0;
  for (let index = headerIndex + 1; index < list.length; index += 1) {
    const row = list[index];
    if (isBlankData(row)) continue;
    position += 1;
    entries.push({
      rowNumber: index + rowOffset + 1,
      order: position,
      name: read(row, "name"),
      level: read(row, "level"),
      book: read(row, "book"),
      description: read(row, "description"),
    });
  }

  let lastNamed = -1;
  entries.forEach((entry, index) => {
    if (entry.name) lastNamed = index;
  });

  if (lastNamed === -1) {
    result.error = `"Mavzu" ustuni (${result.columns.name}) bo'sh — birorta mavzu nomi yo'q`;
    return result;
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (!entry.name) {
      const hasOther = Boolean(entry.level || entry.book || entry.description);
      if (index > lastNamed && !hasOther) continue;
      result.warnings.push(
        `${entry.rowNumber}-qator: mavzu nomi bo'sh — yuklanmadi ` +
          `(${entry.order}-raqamli mavzu bo'sh qoladi, jadvalda shu raqamga ` +
          `to'g'ri kelgan darsda mavzu ko'rinmaydi)`,
      );
      continue;
    }

    for (const field of OPTIONAL_TOPIC_FIELDS) {
      if (columns[field] !== undefined && !entry[field]) result.emptyCounts[field] += 1;
    }

    result.topics.push({
      order: entry.order,
      name: entry.name,
      level: entry.level || null,
      book: entry.book || null,
      description: entry.description || null,
    });
  }

  result.notes = describeOptionalGaps(result);
  return result;
}

/**
 * IXTIYORIY MA'LUMOT BO'SHLIGI — odam o'qiydigan izoh.
 *
 * ⚠️ Bular XATO EMAS va matnda shunday aytiladi: "982 tasida bo'sh" deb
 * yozilib qo'yilsa, admin faylda nimadir buzilgan deb o'ylardi.
 */
function describeOptionalGaps({ topics, emptyCounts, missingColumns }) {
  const notes = [];
  const total = topics.length;

  if (missingColumns.length > 0) {
    const labels = missingColumns.map((field) => `"${TOPIC_COLUMN_LABELS[field]}"`).join(", ");
    notes.push(
      `${labels} ${missingColumns.length > 1 ? "ustunlari" : "ustuni"} faylda yo'q — ` +
        `mavzular ${missingColumns.length > 1 ? "ularsiz" : "busiz"} yuklandi (ixtiyoriy)`,
    );
  }

  for (const field of OPTIONAL_TOPIC_FIELDS) {
    const empty = emptyCounts[field];
    if (!empty) continue;
    const label = `"${TOPIC_COLUMN_LABELS[field]}"`;
    notes.push(
      empty === total
        ? `${label} ustuni hamma mavzuda bo'sh (ixtiyoriy — xato emas)`
        : `${label} ${total} tadan ${empty} ta mavzuda bo'sh (ixtiyoriy — xato emas)`,
    );
  }

  return notes;
}

/**
 * FAN NOMINI TAQQOSLASH UCHUN NORMALLASHTIRADI (varaq nomi ↔ `Subject.name`).
 *
 * Google Sheets varaq nomida oxirgi bo'shliq va apostrof varianti
 * ("Oʻzbek tili" / "O'zbek tili") oson qolib ketadi — ular bitta fan.
 */
function normalizeSubjectName(value) {
  return String(value ?? "")
    .replace(/[‘’ʻʼ'`´]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

module.exports = {
  TOPIC_COLUMN_LABELS,
  OPTIONAL_TOPIC_FIELDS,
  HEADER_SCAN_ROWS,
  normalizeHeader,
  normalizeSubjectName,
  cellText,
  columnLetter,
  fieldOfHeader,
  detectTopicColumns,
  parseTopicSheet,
  describeOptionalGaps,
};
