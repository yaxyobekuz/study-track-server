/**
 * GOOGLE SHEETS DARS JADVALI — sof funksiyalar (BAZA YO'Q).
 *
 * Bu fayl ikki narsani qiladi:
 *   1. Sheet varag'ini o'qib, uni "sinf → kun → vaqt → dars" qatorlariga
 *      aylantiradi;
 *   2. Sheet'dagi yozuvni (sinf/fan/o'qituvchi nomi) tizimdagi yozuvga
 *      solishtirish uchun KALIT va NOMZODLAR beradi.
 *
 * Bazaga tegadigan hamma narsa `scheduleSheetSync.service.js` da. Sabab: o'qish
 * qoidalarini baza bilan aralashtirsak, ularni alohida tekshirib bo'lmasdi.
 *
 * ── VARAQ TUZILISHI ─────────────────────────
 *
 *   ┌────────┬──────────────┬─────────┬──────┬───────────────┬───────────────┐
 *   │ (izoh) │ Hafta kunlari│ (vaqt)  │ (№)  │   5-A sinf    │   5-B sinf    │ ← sarlavha
 *   │        │              │         │      │ Fan │ O'qit.  │ Fan │ O'qit.  │
 *   │        │  Dushanba    │8:30-9:25│ 1    │Kimyo│ Muqimov │ ... │ ...     │ ← dars
 *
 *   · Langar — "Hafta kunlari" katagi. Undan o'ngda: vaqt, tartib raqami,
 *     keyin har sinfga IKKITA ustun (fan, o'qituvchi).
 *   · Kun — "Hafta kunlari" ustunidagi (birlashtirilgan) katak.
 *
 * ⚠️ BU FAYL DARS TARTIB RAQAMINI BERMAYDI — faqat VAQTNI. Raqam
 * (`order`) tizimda darsning shaxsi: baho (`lessonOrder`), o'rinbosarlik
 * katagi, jurnal huquqi, jarima — hammasi (sinf, kun, raqam) ga bog'langan.
 * Uni service "Dars vaqtlari" sozlamasidan (`ScheduleSettings.periods`)
 * aniq boshlanish VA tugash vaqti bo'yicha oladi. Sheet'dagi "№" ustuniga
 * ishonilmaydi (real sheet'da shanba blokida raqamlar surilib ketgan), vaqt
 * qatorining o'rniga ham (bitta yangi qator butun maktab raqamlarini
 * siljitib yuborardi).
 *
 * ⚠️ O'qib bo'lmagan narsa JIM TASHLAB YUBORILMAYDI. Vaqti tanilmagan qatorda
 * dars bo'lsa, fan bor-u o'qituvchi yo'q bo'lsa, katakda formula xatosi
 * (#N/A, #REF!) bo'lsa — bu `issues` ga tushadi va tasdiqlashni to'xtatadi.
 * Jim tashlab yuborilgan dars jadvaldan jimgina yo'qolib qolardi.
 */

const crypto = require("crypto");
const { DAYS } = require("../utils/constants");
const { BadRequestError } = require("../utils/errors");

// Sarlavha qidiriladigan maksimal qator — undan pastda langar bo'lmaydi.
const HEADER_SEARCH_ROWS = 10;

// Nom ustunlari sig'imi (`schedule_sheet_mappings.label`, VARCHAR(300)).
// Undan uzun nomni moslab bo'lmaydi — o'qishning o'zida xato sifatida
// ko'rsatiladi, saqlashda 500 bilan yiqilmaydi.
const MAX_LABEL_LENGTH = 300;

// Faqat Google Sheets havolasi qabul qilinadi: eksport URL'ini server O'ZI
// yig'adi. Foydalanuvchi bergan ixtiyoriy URL'ga so'rov yuborilmaydi (SSRF).
// `/u/1/` — bir nechta Google akkaunt ochiq bo'lganda havolada bo'ladi.
const SPREADSHEET_ID_RE = /\/spreadsheets\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{20,})/;

// `schedule_sync_settings.spreadsheet_id` va `schedule_sheet_revisions.spreadsheet_id`
// — VARCHAR(128). Uzunroq identifikator bazada 500 bilan yiqilmasin, 400 bo'lsin.
const MAX_SPREADSHEET_ID_LENGTH = 128;

// Varaq hajmi chegarasi: maktab jadvali bir necha o'n qator va ustundan
// iborat. Chegaradan oshgan varaq — noto'g'ri tanlangan varaq yoki keraksiz
// ma'lumot; uni o'qishga urinib server xotirasini to'ldirib bo'lmaydi.
const MAX_SHEET_ROWS = 2000;
const MAX_CLASS_COLUMNS = 200;

// Bitta tahrirda saqlanadigan muammolar soni (qolgani bitta xulosa qatori).
const MAX_ISSUES = 300;

// Xato matnida iqtibos qilinadigan katak matni (uzun izoh butun holda
// xabarga — va Telegram'ga — tushmasligi uchun).
const QUOTE_LENGTH = 80;
const quote = (text) =>
  text && text.length > QUOTE_LENGTH ? `${text.slice(0, QUOTE_LENGTH)}…` : text;

// Ko'rinishi lotin harfi bilan bir xil kirill harflari. Real sheet'da
// "1-А класс" dagi "А" — kirillcha (U+0410): ko'zga bir xil, lekin satr
// taqqoslashda boshqa harf. Kalitda ular lotinga keltiriladi.
//
// ⚠️ Faqat KICHIK harflar va almashtirish KICHIK HARFGA o'tkazilgandan
// KEYIN: aks holda "Вторник" (katta В → B) va "вторник" (kichik в) ikki
// xil kalit berardi — natija harfning katta-kichikligiga bog'liq bo'lardi.
//
// ⚠️ Bu almashtirish faqat TAKLIF uchun yetarli, avtomatik moslash uchun
// EMAS (`strictKey`): kirillcha "5-В" bilan lotincha "5-B" ikki xil sinf
// bo'lishi mumkin.
const HOMOGLYPHS = {
  а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c",
  т: "t", у: "y", х: "x", і: "i", ј: "j",
};
const HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPHS).join("")}]`, "g");

// O'zbek lotinidagi tutuq belgisining barcha ko'rinishlari: "O'qish",
// "O`qish", "Oʻqish" — bitta fan.
const APOSTROPHES_RE = /[`'ʻʼ’‘´ʹ′"]/g;

/**
 * Ko'rsatish uchun nom: bo'shliqlar yig'iladi, boshqa hech narsa o'zgarmaydi.
 * @param {*} value
 * @returns {string}
 */
function cleanLabel(value) {
  if (value === null || value === undefined) return "";
  return String(value).normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * Harf-raqamdan boshqa hamma narsani olib tashlaydigan umumiy qadam.
 * @param {string} text - kichik harfga o'tkazilgan matn
 * @returns {string}
 */
function stripPunctuation(text) {
  return text
    .replace(APOSTROPHES_RE, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * SOLISHTIRISH KALITI. Ikkala tomon (sheet va baza) ham shu funksiyadan
 * o'tadi, shuning uchun kalit qoidasi faqat shu yerda. Moslash jadvalining
 * `key` ustuni ham shu.
 *
 * "Ona-tili", "ona tili", "Ona  tili" → "ona tili";
 * "O'qish", "O`qish" → "oqish"; "1-А" (kirill) → "1 a".
 *
 * @param {*} value
 * @returns {string}
 */
function normalizeKey(value) {
  return stripPunctuation(
    cleanLabel(value)
      .normalize("NFKC")
      .toLowerCase()
      .replace(HOMOGLYPH_RE, (ch) => HOMOGLYPHS[ch]),
  );
}

/**
 * QAT'IY kalit — kirill/lotin almashtirishsiz. Avtomatik moslash faqat
 * shu kalit teng bo'lsa bo'ladi; faqat `normalizeKey` teng bo'lsa — taklif.
 * @param {*} value
 * @returns {string}
 */
function strictKey(value) {
  return stripPunctuation(cleanLabel(value).normalize("NFKC").toLowerCase());
}

// Sinf nomidagi umumiy so'zlar: "5-A sinf" va "5-A" — bitta sinf bo'lishi
// MUMKIN. Bu faqat TAKLIF uchun, avtomatik moslash uchun emas.
const CLASS_STOPWORDS = new Set(
  ["sinf", "sinfi", "guruh", "guruhi", "класс", "расписание", "уроков"].map(normalizeKey),
);

/**
 * Sinf nomining "yadrosi" — umumiy so'zlarsiz kalit.
 * @param {string} value
 * @returns {string}
 */
function classCoreKey(value) {
  return normalizeKey(value)
    .split(" ")
    .filter((token) => token && !CLASS_STOPWORDS.has(token))
    .join(" ");
}

/**
 * Google Sheets havolasidan jadval identifikatorini ajratadi.
 * @param {string} url
 * @returns {string} spreadsheetId
 */
function extractSpreadsheetId(url) {
  const text = cleanLabel(url);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new BadRequestError("Havola noto'g'ri. Google Sheets havolasini to'liq kiriting");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "docs.google.com") {
    throw new BadRequestError(
      "Faqat Google Sheets havolasi qabul qilinadi (https://docs.google.com/spreadsheets/...)",
    );
  }
  const match = parsed.pathname.match(SPREADSHEET_ID_RE);
  if (!match) {
    throw new BadRequestError("Havolada jadval identifikatori topilmadi");
  }
  if (match[1].length > MAX_SPREADSHEET_ID_LENGTH) {
    throw new BadRequestError("Havolada jadval identifikatori noto'g'ri");
  }
  return match[1];
}

/**
 * Butun kitobni XLSX ko'rinishida yuklab olish manzili. Serverning o'zi
 * yig'adi — tashqaridan kelgan URL ishlatilmaydi.
 * @param {string} spreadsheetId
 * @returns {string}
 */
function buildExportUrl(spreadsheetId) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/export?format=xlsx`;
}

/**
 * "8:30-9:25", "08.30 – 09.25" → { startTime: "08:30", endTime: "09:25" }.
 * Tizim vaqtni faqat `HH:mm` ko'rinishida qabul qiladi (`validateDayShape`).
 * @param {string} text
 * @returns {{startTime: string, endTime: string} | null}
 */
function parseTimeRange(text) {
  const match = cleanLabel(text)
    .replace(/\s+/g, "")
    .match(/^(\d{1,2})[:.](\d{2})[-–—](\d{1,2})[:.](\d{2})$/);
  if (!match) return null;

  const [sh, sm, eh, em] = match.slice(1).map(Number);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;

  const pad = (n) => String(n).padStart(2, "0");
  const startTime = `${pad(sh)}:${pad(sm)}`;
  const endTime = `${pad(eh)}:${pad(em)}`;
  if (startTime >= endTime) return null;
  return { startTime, endTime };
}

// Kun nomlari: o'zbekcha (asosiy) va ruscha (rus sinflari sarlavhasi).
// Qiymat — ScheduleDay enum. Yakshanba YO'Q: tizimda u dars kuni emas.
const DAY_NAMES = new Map([
  ...Object.values(DAYS).map((day) => [normalizeKey(day), day]),
  [normalizeKey("понедельник"), DAYS.MONDAY],
  [normalizeKey("вторник"), DAYS.TUESDAY],
  [normalizeKey("среда"), DAYS.WEDNESDAY],
  [normalizeKey("четверг"), DAYS.THURSDAY],
  [normalizeKey("пятница"), DAYS.FRIDAY],
  [normalizeKey("суббота"), DAYS.SATURDAY],
]);

/**
 * @param {string} text
 * @returns {string | null} ScheduleDay qiymati
 */
function parseDayName(text) {
  return DAY_NAMES.get(normalizeKey(text)) || null;
}

// Sinf ustunlari tepasidagi ustun nomlari (o'zbekcha va rus sinfi uchun).
const COLUMN_HEADER_KEYS = new Set(
  ["Fan nomi", "O'qituvchi F.I.O.", "O'qituvchi", "Название предмета", "Ф.И.О. учителя"].map(
    normalizeKey,
  ),
);

/**
 * Vaqtsiz qatordagi matn sarlavhami (kun nomi yoki ustun nomi)?
 * Bo'sh katak ham sarlavha qatoriga xalaqit bermaydi.
 * @param {string} text
 * @returns {boolean}
 */
function isHeaderText(text) {
  if (!text) return true;
  return Boolean(parseDayName(text)) || COLUMN_HEADER_KEYS.has(normalizeKey(text));
}

/**
 * ExcelJS katagi qiymati → matn yoki xato.
 *
 * Formula bo'lsa HISOBLANGAN natija olinadi. Formula xatosi (#N/A, #REF!)
 * va sana/vaqt qiymati `error` bilan qaytadi: ular bo'sh katak EMAS — bo'sh
 * deb o'qilsa, VLOOKUP bilan to'ldirilgan dars jimgina yo'qolardi.
 *
 * @param {*} value - `cell.value`
 * @returns {{text: string, error: string|null}}
 */
function readValue(value) {
  if (value === null || value === undefined) return { text: "", error: null };
  if (value instanceof Date) {
    return { text: "", error: "sana/vaqt formatidagi katak (matn bo'lishi kerak)" };
  }
  if (typeof value !== "object") return { text: cleanLabel(value), error: null };
  if (typeof value.error === "string") return { text: "", error: `formula xatosi ${value.error}` };
  if (Array.isArray(value.richText)) {
    return { text: cleanLabel(value.richText.map((part) => part.text || "").join("")), error: null };
  }
  // Havolali katak: ExcelJS asl qiymatni `text` ga qo'yadi va u o'zi ham
  // rich text, formula natijasi yoki xato bo'lishi mumkin — ichkarisi
  // yuqoridagi AYNI tarmoqlardan o'tadi.
  if ("hyperlink" in value && "text" in value) return readValue(value.text);
  if ("result" in value) return readValue(value.result);
  if (typeof value.text === "string") return { text: cleanLabel(value.text), error: null };
  // Tanilmagan shakl bo'sh deb o'qilmaydi: dars jimgina yo'qolmasligi kerak
  return { text: "", error: "katak qiymati tanilmadi" };
}

/**
 * Katak o'qigich. Birlashtirilgan katakning faqat BOSH katagida qiymat bor,
 * shuning uchun qiymat har doim bosh katakdan olinadi va u qayerda
 * turgani ham qaytariladi (gorizontal birlashtirishni aniqlash uchun).
 *
 * @param {import("exceljs").Worksheet} ws
 * @param {number} row
 * @param {number} col
 * @returns {{text: string, error: string|null, masterRow: number, masterCol: number, address: string}}
 */
function readCell(ws, row, col) {
  const cell = ws.getCell(row, col);
  const master = cell.isMerged && cell.master ? cell.master : cell;
  return {
    ...readValue(master.value),
    masterRow: Number(master.row),
    masterCol: Number(master.col),
    address: cell.address,
  };
}

/**
 * Kitobdagi KO'RINADIGAN varaqlar nomi. Yashirin varaq taklif qilinmaydi:
 * real sheet'da yashirin "Dars jadvali" varag'i eski va buzilgan ma'lumotli.
 * @param {import("exceljs").Workbook} workbook
 * @returns {string[]}
 */
function listVisibleSheets(workbook) {
  const names = [];
  workbook.eachSheet((ws) => {
    if (ws.state === "visible" || !ws.state) names.push(cleanLabel(ws.name));
  });
  return names;
}

/**
 * Varaqni nomi bo'yicha topadi (bo'shliq va katta-kichik harfga sezgir emas).
 * @param {import("exceljs").Workbook} workbook
 * @param {string} tabName
 * @returns {import("exceljs").Worksheet}
 */
function findWorksheet(workbook, tabName) {
  const wanted = normalizeKey(tabName);
  const matches = [];
  workbook.eachSheet((ws) => {
    if (normalizeKey(ws.name) === wanted) matches.push(ws);
  });

  if (matches.length === 0) {
    const visible = listVisibleSheets(workbook);
    throw new BadRequestError(
      `"${cleanLabel(tabName)}" varag'i topilmadi. Mavjud varaqlar: ${visible.join(", ") || "yo'q"}`,
    );
  }
  if (matches.length > 1) {
    throw new BadRequestError(`"${cleanLabel(tabName)}" nomli varaq bir nechta — nomlarni farqlang`);
  }
  const [ws] = matches;
  if (ws.state && ws.state !== "visible") {
    throw new BadRequestError(
      `"${cleanLabel(ws.name)}" varag'i yashirin. Yashirin varaqdan jadval olinmaydi`,
    );
  }
  return ws;
}

/**
 * "Hafta kunlari" langarini topadi.
 * @param {import("exceljs").Worksheet} ws
 * @returns {{row: number, col: number, lastHeaderRow: number}}
 */
function findAnchor(ws) {
  const anchorKey = normalizeKey("Hafta kunlari");
  const maxCol = Math.min(ws.columnCount || 0, 30);

  for (let row = 1; row <= HEADER_SEARCH_ROWS; row++) {
    for (let col = 1; col <= maxCol; col++) {
      const cell = ws.getCell(row, col);
      if (cell.isMerged && cell.master && cell.master.address !== cell.address) continue;
      if (normalizeKey(readValue(cell.value).text) !== anchorKey) continue;

      // Langar vertikal birlashtirilgan bo'lsa (1-2 qatorlar), sarlavha
      // bloki uning oxirigacha davom etadi.
      let lastHeaderRow = row;
      while (lastHeaderRow < row + 5) {
        const below = ws.getCell(lastHeaderRow + 1, col);
        if (below.isMerged && below.master && below.master.address === cell.address) {
          lastHeaderRow += 1;
        } else {
          break;
        }
      }
      return { row, col, lastHeaderRow };
    }
  }

  throw new BadRequestError(
    `Jadval tuzilishi tanilmadi: birinchi ${HEADER_SEARCH_ROWS} qatorda "Hafta kunlari" sarlavhasi topilmadi`,
  );
}

/**
 * Sinf sarlavhalari — langar qatorida, har sinfga 2 ta ustun.
 * @returns {Array<{label: string, col: number, address: string}>}
 */
function readClassHeaders(ws, anchor) {
  const firstCol = anchor.col + 3;
  const lastCol = ws.columnCount || 0;
  const classes = [];
  const seenKeys = new Map();

  if (lastCol - firstCol + 1 > MAX_CLASS_COLUMNS * 2) {
    throw new BadRequestError(
      `Varaq juda keng (${lastCol} ustun). Jadval varag'ida ko'pi bilan ${MAX_CLASS_COLUMNS} ta sinf bo'lishi mumkin — varaq to'g'ri tanlanganini tekshiring`,
    );
  }

  for (let col = firstCol; col <= lastCol; col += 2) {
    const head = readCell(ws, anchor.row, col);

    if (head.error) {
      throw new BadRequestError(`Sinf sarlavhasida xato (${head.address}): ${head.error}`);
    }
    // Bosh katak boshqa ustunda — sarlavha juftligi buzilgan
    if (head.masterCol !== col && head.text) {
      throw new BadRequestError(
        `Jadval tuzilishi buzilgan: ${head.address} katagi ${head.masterCol}-ustundagi sarlavhaga birlashtirilgan. Har sinf sarlavhasi aniq 2 ta ustunni egallashi kerak`,
      );
    }
    const pair = readCell(ws, anchor.row, col + 1);
    const pairIsPartOfHead = pair.masterCol === col && pair.masterRow === head.masterRow;
    if (pair.text && !pairIsPartOfHead) {
      throw new BadRequestError(
        `Jadval tuzilishi buzilgan: ${pair.address} katagida ("${quote(pair.text)}") sarlavha bor, lekin u sinfning ikkinchi (o'qituvchi) ustuni bo'lishi kerak`,
      );
    }
    const third = readCell(ws, anchor.row, col + 2);
    if (third.masterCol === col && head.text) {
      throw new BadRequestError(
        `Jadval tuzilishi buzilgan: "${quote(head.text)}" sarlavhasi 2 tadan ortiq ustunga birlashtirilgan`,
      );
    }

    // Bo'sh sarlavha yoki faqat belgi ("—", "?") — sinf nomi yo'q. Ustun
    // baribir o'qiladi: tagida dars bo'lsa `lesson_without_class` chiqadi.
    if (!head.text || !normalizeKey(head.text)) {
      classes.push({ label: "", col, address: head.address });
      continue;
    }
    if (head.text.length > MAX_LABEL_LENGTH) {
      throw new BadRequestError(
        `Sinf nomi juda uzun (${head.address}, ${head.text.length} belgi). Ko'pi bilan ${MAX_LABEL_LENGTH} belgi`,
      );
    }

    const key = normalizeKey(head.text);
    if (seenKeys.has(key)) {
      throw new BadRequestError(
        `"${head.text}" sinfi jadvalda ikki marta bor (${seenKeys.get(key)} va ${head.address})`,
      );
    }
    seenKeys.set(key, head.address);
    classes.push({ label: head.text, col, address: head.address });
  }

  // ⚠️ O'ng chekkadagi sarlavhasiz ustunlar TASHLAB YUBORILMAYDI: yangi sinf
  // qo'shilib, sarlavhasi hali yozilmagan bo'lsa (yoki tasodifan o'chirilgan
  // bo'lsa), ularning darslari jimgina yo'qolardi. Bo'sh ustunlar esa
  // qatorlar o'qilganda o'zi o'tkazib yuboriladi.
  if (!classes.some((c) => c.label)) {
    throw new BadRequestError("Jadvalda birorta ham sinf sarlavhasi topilmadi");
  }
  return classes;
}

/**
 * Varaqni o'qiydi.
 *
 * @param {import("exceljs").Workbook} workbook
 * @param {string} tabName
 * @returns {{
 *   tab: string,
 *   slots: Array<{startTime: string, endTime: string}>,
 *   classes: string[],
 *   lessons: Array<{classLabel: string, day: string, startTime: string,
 *                   endTime: string, subjectLabel: string, teacherLabel: string, cell: string}>,
 *   issues: Array<{code: string, message: string, cell: string|null}>,
 * }}
 * @throws {BadRequestError} tuzilish umuman tanilmasa
 */
function parseScheduleSheet(workbook, tabName) {
  const ws = findWorksheet(workbook, tabName);
  const anchor = findAnchor(ws);
  const dayCol = anchor.col;
  const timeCol = anchor.col + 1;
  const classes = readClassHeaders(ws, anchor);
  const lastRow = ws.rowCount || 0;
  if (lastRow > MAX_SHEET_ROWS) {
    throw new BadRequestError(
      `Varaqda juda ko'p qator (${lastRow}). Jadval varag'ida ko'pi bilan ${MAX_SHEET_ROWS} qator bo'lishi mumkin — varaq to'g'ri tanlanganini tekshiring`,
    );
  }

  const issues = [];
  const lessons = [];
  const slotMap = new Map(); // "08:30-09:25" → {startTime, endTime}
  const seenCell = new Map(); // "classKey|day|startTime" → address

  for (let row = anchor.lastHeaderRow + 1; row <= lastRow; row++) {
    const timeCell = readCell(ws, row, timeCol);
    const time = timeCell.error ? null : parseTimeRange(timeCell.text);

    const filled = [];
    for (const cls of classes) {
      const subject = readCell(ws, row, cls.col);
      const teacher = readCell(ws, row, cls.col + 1);
      if (!subject.text && !teacher.text && !subject.error && !teacher.error) continue;
      filled.push({ cls, subject, teacher });
    }

    if (!time) {
      if (filled.length === 0) continue;
      // Kun sarlavhasi ("Dushanba") yoki ustun sarlavhasi ("Fan nomi")
      // qatori — dars emas.
      const isHeaderRow = filled.every(
        ({ subject, teacher }) =>
          !subject.error &&
          !teacher.error &&
          isHeaderText(subject.text) &&
          isHeaderText(teacher.text),
      );
      if (isHeaderRow) continue;

      let reason = "vaqt ko'rsatilmagan";
      if (timeCell.error) reason = `vaqt katagida ${timeCell.error}`;
      else if (timeCell.text) reason = `vaqt "${quote(timeCell.text)}" tanilmadi`;
      issues.push({
        code: "row_without_time",
        message: `${row}-qator: ${reason}, lekin qatorda darslar bor`,
        cell: timeCell.address,
      });
      continue;
    }

    const dayCell = readCell(ws, row, dayCol);
    const day = dayCell.error ? null : parseDayName(dayCell.text);
    if (!day) {
      if (filled.length === 0) continue;
      issues.push({
        code: "row_without_day",
        message: `${row}-qator: hafta kuni tanilmadi ("${dayCell.error || quote(dayCell.text)}")`,
        cell: dayCell.address,
      });
      continue;
    }

    for (const { cls, subject, teacher } of filled) {
      const where = `${cls.label || subject.address}, ${day}, ${time.startTime}`;

      if (subject.error || teacher.error) {
        const bad = subject.error ? subject : teacher;
        issues.push({
          code: "cell_error",
          message: `${where}: ${bad.address} katagida ${bad.error}`,
          cell: bad.address,
        });
        continue;
      }
      if (!cls.label) {
        issues.push({
          code: "lesson_without_class",
          message: `${subject.address}: dars bor, lekin ustun tepasida sinf nomi yo'q`,
          cell: subject.address,
        });
        continue;
      }

      // Gorizontal birlashtirish: katak boshqa ustundagi qiymatni ko'rsatadi.
      // Masalan fan+o'qituvchi bitta katakka birlashtirilgan — o'qituvchi
      // ustuniga fan nomi "ko'chib" qolardi.
      const crossSubject = subject.text && subject.masterCol !== cls.col;
      const crossTeacher = teacher.text && teacher.masterCol !== cls.col + 1;
      if (crossSubject || crossTeacher) {
        issues.push({
          code: "merged_across_columns",
          message: `${where}: katak boshqa ustun bilan birlashtirilgan (${subject.address}). Fan va o'qituvchi alohida kataklarda bo'lishi kerak`,
          cell: subject.address,
        });
        continue;
      }
      if (!subject.text || !teacher.text) {
        issues.push({
          code: subject.text ? "missing_teacher" : "missing_subject",
          message: subject.text
            ? `${where}: "${quote(subject.text)}" darsiga o'qituvchi ko'rsatilmagan (${teacher.address})`
            : `${where}: o'qituvchi "${quote(teacher.text)}" bor, lekin fan ko'rsatilmagan (${subject.address})`,
          cell: subject.text ? teacher.address : subject.address,
        });
        continue;
      }
      // Faqat belgidan iborat katak ("—", "-", "?"): nomi yo'q, uni hech
      // narsaga moslab bo'lmaydi. Dars sifatida o'tkazib yuborilsa, ko'rib
      // chiqish bo'sh id bilan yiqilardi; jim tashlansa — dars yo'qolardi.
      if (!normalizeKey(subject.text) || !normalizeKey(teacher.text)) {
        const bad = normalizeKey(subject.text) ? teacher : subject;
        issues.push({
          code: "invalid_label",
          message: `${where}: ${bad.address} katagida ("${quote(bad.text)}") harf yoki raqam yo'q. Dars bo'lmasa, fan va o'qituvchi kataklarini bo'shating`,
          cell: bad.address,
        });
        continue;
      }
      if (subject.text.length > MAX_LABEL_LENGTH || teacher.text.length > MAX_LABEL_LENGTH) {
        issues.push({
          code: "label_too_long",
          message: `${where}: nom juda uzun (ko'pi bilan ${MAX_LABEL_LENGTH} belgi)`,
          cell: subject.address,
        });
        continue;
      }

      const dupKey = `${normalizeKey(cls.label)}|${day}|${time.startTime}`;
      if (seenCell.has(dupKey)) {
        issues.push({
          code: "duplicate_slot",
          message: `${where}: bir vaqtga ikki dars (${seenCell.get(dupKey)} va ${subject.address})`,
          cell: subject.address,
        });
        continue;
      }
      seenCell.set(dupKey, subject.address);
      slotMap.set(`${time.startTime}-${time.endTime}`, time);

      lessons.push({
        classLabel: cls.label,
        day,
        startTime: time.startTime,
        endTime: time.endTime,
        subjectLabel: subject.text,
        teacherLabel: teacher.text,
        cell: subject.address,
      });
    }
  }

  const slots = [...slotMap.values()].sort((a, b) =>
    compareStrings(`${a.startTime}-${a.endTime}`, `${b.startTime}-${b.endTime}`),
  );

  // Muammolar ro'yxati cheklanadi (tahrir JSON'i va javob hajmi), lekin
  // qolganlari jim yo'qolmaydi — xulosa qatori ularning sonini aytadi.
  const shownIssues =
    issues.length > MAX_ISSUES
      ? [
          ...issues.slice(0, MAX_ISSUES),
          {
            code: "too_many_issues",
            message: `Yana ${issues.length - MAX_ISSUES} ta muammo bor — avval yuqoridagilarni tuzating`,
            cell: null,
          },
        ]
      : issues;

  return {
    tab: cleanLabel(ws.name),
    slots,
    classes: classes.filter((c) => c.label).map((c) => c.label),
    lessons,
    issues: shownIssues,
  };
}

/**
 * Satrlarni kod birligi bo'yicha taqqoslash. `localeCompare` EMAS: u Node
 * ICU va tizim tiliga bog'liq — server yangilanganda imzo o'zgarib, sheet
 * o'zgarmagan bo'lsa ham "yangi tahrir" paydo bo'lardi.
 */
function compareStrings(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * O'qilgan varaq mazmunining imzosi. XLSX faylning baytlari har eksportda
 * o'zgaradi (vaqt belgisi), shuning uchun imzo MAZMUNDAN olinadi: sheet
 * o'zgarmagan bo'lsa yangi tahrir yaratilmaydi.
 *
 * @param {ReturnType<typeof parseScheduleSheet>} parsed
 * @returns {string} sha256 hex
 */
function hashParsedSheet(parsed) {
  const lessons = parsed.lessons
    .map((l) =>
      JSON.stringify([l.classLabel, l.day, l.startTime, l.endTime, l.subjectLabel, l.teacherLabel]),
    )
    .sort(compareStrings);
  const issues = parsed.issues
    .map((i) => JSON.stringify([i.code, i.cell, i.message]))
    .sort(compareStrings);
  const payload = JSON.stringify({
    tab: normalizeKey(parsed.tab),
    classes: parsed.classes,
    lessons,
    issues,
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

// ─────────────────────────────────────────────
// MOSLASH NOMZODLARI (sof)
// ─────────────────────────────────────────────

/**
 * Levenshtein masofasi — qisqa satrlar uchun (fan nomlari).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Bitta sheet nomi uchun tizimdagi nomzodlar va AVTOMATIK moslash qarori.
 *
 * Avtomatik moslash (`auto`) FAQAT shunda:
 *   · qat'iy kalit (kirill/lotin almashtirishsiz) AYNAN teng nomzod BITTA;
 *   · boshqa hech qanday o'xshash nomzod YO'Q ("Ona tili" bor, lekin
 *     "Ona tili va adabiyot" ham bo'lsa — avtomatik emas);
 *   · o'qituvchi nomi bir so'zdan iborat EMAS ("Jasurbek" — kim ekanini
 *     familiyasiz aniq aytib bo'lmaydi).
 * Qolgan hamma holat — `candidates` ro'yxati; odam tasdiqlamaguncha
 * ISHLATILMAYDI.
 *
 * ⚠️ Taxminiy moslash hech qachon o'z-o'zidan qo'llanmaydi: "Qosimov M"
 * noto'g'ri odamga bog'lansa, butun hafta boshqa o'qituvchiga yozilardi va
 * jurnal huquqi ham, oylik soati ham unga o'tib ketardi.
 *
 * @param {"class"|"subject"|"teacher"} kind
 * @param {string} label - sheet'dagi nom
 * @param {Array<{id: string, name?: string, firstName?: string, lastName?: string}>} targets
 * @returns {{auto: string|null, candidates: string[]}} id'lar
 */
function findCandidates(kind, label, targets) {
  const key = normalizeKey(label);
  if (!key) return { auto: null, candidates: [] };

  const { exact, similar } =
    kind === "teacher"
      ? findTeacherMatches(label, targets)
      : findNamedMatches(kind, label, targets);

  const candidates = [...new Set([...exact, ...similar])];
  const singleWordTeacher = kind === "teacher" && key.split(" ").length < 2;
  const auto =
    exact.length === 1 && candidates.length === 1 && !singleWordTeacher ? exact[0] : null;

  return { auto, candidates };
}

/**
 * Sinf va fan: nom bitta maydonda (`name`).
 * @returns {{exact: string[], similar: string[]}}
 */
function findNamedMatches(kind, label, targets) {
  const strict = strictKey(label);
  const key = normalizeKey(label);
  const core = kind === "class" ? classCoreKey(label) : "";
  const limit = Math.max(1, Math.floor(key.length * 0.2));

  const exact = [];
  const similar = [];
  for (const t of targets) {
    if (strictKey(t.name) === strict) {
      exact.push(t.id);
      continue;
    }
    const target = normalizeKey(t.name);
    let isSimilar = target === key; // faqat kirill/lotin almashtirish bilan teng
    if (!isSimilar && kind === "class") {
      isSimilar = Boolean(core) && classCoreKey(t.name) === core;
    }
    if (!isSimilar && kind === "subject") {
      isSimilar =
        editDistance(target, key) <= limit ||
        target.startsWith(`${key} `) ||
        key.startsWith(`${target} `);
    }
    if (isSimilar) similar.push(t.id);
  }
  return { exact, similar };
}

/**
 * O'qituvchi: sheet'da ko'pincha "Familiya I" yoki faqat ism ("Jasurbek").
 * @returns {{exact: string[], similar: string[]}}
 */
function findTeacherMatches(label, teachers) {
  const strict = strictKey(label);
  const tokens = normalizeKey(label).split(" ");
  const exact = [];
  const similar = [];

  for (const t of teachers) {
    const strictFull = [
      `${strictKey(t.lastName)} ${strictKey(t.firstName)}`.trim(),
      `${strictKey(t.firstName)} ${strictKey(t.lastName)}`.trim(),
    ];
    if (strictFull.includes(strict)) {
      exact.push(t.id);
      continue;
    }

    const first = normalizeKey(t.firstName).split(" ").filter(Boolean);
    const last = normalizeKey(t.lastName).split(" ").filter(Boolean);
    const full = [[...last, ...first].join(" "), [...first, ...last].join(" ")];
    const key = tokens.join(" ");
    const [a, b] = tokens;

    let isSimilar = full.includes(key); // kirill/lotin almashtirish bilan teng
    if (!isSimilar && tokens.length === 1) {
      // "Jasurbek" — faqat ism yoki faqat familiya
      isSimilar = first[0] === a || last[0] === a;
    } else if (!isSimilar && tokens.length === 2) {
      // "Toshmirzayeva I", "Axmadaliyeva Shoiraxon" (bazada "Shoiraxonamola")
      isSimilar =
        (last[0] === a && Boolean(first[0]) && first[0].startsWith(b)) ||
        (first[0] === a && Boolean(last[0]) && last[0].startsWith(b));
    } else if (!isSimilar) {
      // 3+ so'z: bazadagi to'liq nomning boshlanishi
      isSimilar = full.some((f) => f.startsWith(key) || key.startsWith(`${f} `));
    }
    if (isSimilar) similar.push(t.id);
  }
  return { exact, similar };
}

module.exports = {
  MAX_LABEL_LENGTH,
  cleanLabel,
  normalizeKey,
  strictKey,
  classCoreKey,
  compareStrings,
  extractSpreadsheetId,
  buildExportUrl,
  parseTimeRange,
  parseDayName,
  listVisibleSheets,
  parseScheduleSheet,
  hashParsedSheet,
  findCandidates,
  editDistance,
};
