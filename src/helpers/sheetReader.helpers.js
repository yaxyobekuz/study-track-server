/**
 * EXCEL / CSV O'QUVCHI — YAGONA MANBA.
 *
 * Importlar (diagnostika savollari, sertifikat rejalari) faylni AYNI
 * yo'l bilan o'qiydi: kengaytma tekshiruvi, CSV kodlashi va sarlavha
 * normallashtirish bir joyda turadi. Ikkinchi nusxa yozilsa, pastdagi
 * kodlash tuzog'i (u JIM xatolik berardi) faqat bitta importda tuzatilgan
 * bo'lib qolardi.
 */

const XLSX = require("xlsx");
const { BadRequestError } = require("../utils/errors");

/** Qabul qilinadigan kengaytmalar — HAQIQIY darvoza shu, MIME turi emas. */
const SHEET_EXTENSIONS = Object.freeze(["xlsx", "xls", "csv"]);

/**
 * Ustun sarlavhasini qidirish uchun qulay ko'rinishga keltiradi.
 *
 * Kichik harf, apostroflar olib tashlanadi, bo'shliq/nuqta/defis `_` ga
 * aylanadi: foydalanuvchi "To'g'ri javob" deb yozsa ham, "togri_javob" deb
 * yozsa ham bir xil ustun topiladi. Aks holda import faqat namunaviy
 * shablon bilan ishlardi.
 *
 * @param {unknown} key
 * @returns {string}
 */
function normalizeHeader(key) {
  return String(key ?? "")
    .trim()
    .toLowerCase()
    .replace(/[‘’ʻʼ'`´]/g, "")
    .replace(/[\s.-]+/g, "_");
}

/**
 * Faylning BIRINCHI varag'ini o'qiydi.
 *
 * ⚠️ CSV MATN sifatida, ATAYLAB UTF-8 deb o'qiladi.
 *
 * `XLSX.read(buffer)` kodlashni o'zi taxmin qiladi va BOM'siz UTF-8 faylni
 * CP1252 deb o'qib yuboradi: "O‘zbekistonda" → "OÊ»zbekistonda". Google
 * Sheets ham, LibreOffice ham BOM qo'ymaydi, ya'ni bu ODATIY hol edi. Eng
 * yomoni — xato JIM: ustun sarlavhalari ASCII bo'lgani uchun qator
 * muvaffaqiyatli import bo'ladi va buzuq matn bazaga tushadi. Sarlavhada
 * apostrof bo'lsa ("To'g'ri javob") u ham buzilib, HAR BIR qator
 * "To'g'ri javob ko'rsatilmagan" bilan yiqilardi.
 *
 * .xlsx/.xls o'z kodlashini ichida olib yuradi — ularga tegilmaydi.
 *
 * ⚠️ `headers` — ustunlarning JADVALDAGI TARTIBI bilan qaytadi va u
 * sarlavha QATORIDAN o'qiladi, qator obyektining kalitlaridan EMAS: bo'sh
 * kataklari bor qatorda `sheet_to_json` kalitlarni tashlab ketadi, ya'ni
 * "1-fan / 2-fan" kabi TARTIBGA tayanadigan import ustunlarni aralashtirib
 * yuborardi.
 *
 * ⚠️ `cellDates` SUKUT BO'YICHA O'CHIQ va bu ATAYLAB. U yoqilganda sana
 * kataklari `Date` bo'lib qaytadi — sana ustuni bor import uchun qulay,
 * LEKIN bayroq BUTUN VARAQQA ta'sir qiladi: sana deb FORMATLANGAN istalgan
 * katak (masalan xato formatlangan sinf raqami) `Date` bo'lib chiqadi va
 * `String(value)` dan "Mon Jan 01 2026..." kelib qoladi. Shuning uchun uni
 * faqat SANA O'QIYDIGAN import yoqadi; mavjud importlarning xatti-harakati
 * o'zgarmaydi.
 *
 * @param {{originalname?: string, buffer: Buffer}} file - multer fayli
 * @param {{cellDates?: boolean}} [options]
 * @returns {{rows: Record<string, unknown>[], headers: string[]}}
 */
function readSheet(file, { cellDates = false } = {}) {
  if (!file || !file.buffer) throw new BadRequestError("Fayl yuklanmadi");

  const name = String(file.originalname || "");
  const extension = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  if (!SHEET_EXTENSIONS.includes(extension)) {
    throw new BadRequestError("Faqat .xlsx, .xls yoki .csv fayllar qabul qilinadi");
  }

  let workbook;
  try {
    if (extension === "csv") {
      const text = file.buffer.toString("utf8").replace(/^﻿/, "");
      workbook = XLSX.read(text, { type: "string", cellDates });
    } else {
      workbook = XLSX.read(file.buffer, { type: "buffer", cellDates });
    }
  } catch {
    throw new BadRequestError("Faylni o'qib bo'lmadi — format buzilgan bo'lishi mumkin");
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new BadRequestError("Faylda sahifa topilmadi");

  const sheet = workbook.Sheets[sheetName];

  // Sarlavha qatori — tartibni saqlab olish uchun alohida o'qiladi
  const [headerRow = []] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    range: 0,
    blankrows: false,
    defval: "",
  });
  const headers = headerRow.map(normalizeHeader);

  const raw = XLSX.utils.sheet_to_json(sheet, { defval: "", blankrows: false });

  const rows = raw.map((row) => {
    const normalized = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[normalizeHeader(key)] = value;
    }
    return normalized;
  });

  return { rows, headers };
}

module.exports = { SHEET_EXTENSIONS, normalizeHeader, readSheet };
