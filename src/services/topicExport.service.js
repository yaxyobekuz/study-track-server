/**
 * MAVZULAR REJASI → EXCEL.
 *
 * Ikki rejim, import bilan AYNI (`topic.service.js` → `uploadTopics`):
 *   · `subjectId` berilsa — bitta fan, bitta varaq;
 *   · berilmasa — mavzusi BOR hamma fan, har biri ALOHIDA varaqda va
 *     varaq nomi fan nomi bilan (aynan shu nom bo'yicha import ularni
 *     fanlarga qaytarib bog'laydi).
 *
 * ⚠️ FAYL — SHABLON, HISOBOT EMAS: u o'zgartirilmasdan qayta yuklansa
 * AYNAN o'sha mavzular qaytadi. Sabablar va round-trip qoidalari —
 * `helpers/topicExport.helpers.js`; bu fayl faqat varaqlarni chizadi.
 *
 * ⚠️ MAVZUSI YO'Q FAN VARAQQA KIRMAYDI. Bo'sh varaq importda "Varaq bo'sh"
 * sababi bilan qaytardi va admin uni XATO deb o'qirdi — holbuki fanda
 * shunchaki hali reja yo'q.
 *
 * ⚠️ BITTA FAYL — BITTA TIL (import bilan AYNI qoida, 2026-11-12). Uch
 * tilning rejasi bitta varaqqa qo'shilsa, tartib raqamlari takrorlanib
 * (har ro'yxat 1 dan boshlanadi) qayta yuklashda hammasi aralashib
 * ketardi. Til fayl nomiga ham yoziladi — uchta fayl bir-birini
 * almashtirmasin.
 */

const prisma = require("../config/prisma");
const ExcelService = require("./excel.service");
const { BadRequestError, NotFoundError, ValidationError } = require("../utils/errors");
const { isValidId } = require("../utils/objectId");
const {
  EXPORT_COLUMNS,
  sheetNameOf,
  uniqueSheetName,
  buildTopicRows,
} = require("../helpers/topicExport.helpers");
const {
  normalizeLanguage,
  languageLabel,
} = require("../helpers/teachingLanguage.helpers");

const TOPIC_SELECT = {
  subjectId: true,
  order: true,
  name: true,
  level: true,
  book: true,
  description: true,
};

const HEADER_STYLE = { bgColor: ExcelService.COLORS.HEADER_BLUE, height: 24 };

/** Bo'sh raqam qatori — kulrang kursiv: u mavzu emas, o'rin band qilib turibdi. */
const EMPTY_SLOT_FONT = { italic: true, color: { argb: "FF9CA3AF" } };

/**
 * Qaysi fanlar va ularning mavzulari.
 *
 * @param {string|null} subjectId
 * @returns {Promise<Array<{subject: {id: string, name: string}, topics: object[]}>>}
 */
async function loadExportSheets(subjectId, language = undefined) {
  const lang = normalizeLanguage(language);
  const label = languageLabel(lang);

  if (subjectId) {
    // ⚠️ Fan id yo'lda emas, so'rov parametrida — `validateObjectId`
    // uni ushlamaydi. Tekshirilmasa uzun qiymat Prisma'da "value too
    // long" bilan 500 bo'lib qaytardi.
    if (!isValidId(subjectId)) throw new ValidationError("Noto'g'ri fan ID formati");

    const subject = await prisma.subject.findUnique({
      where: { id: subjectId },
      select: { id: true, name: true },
    });
    if (!subject) throw new NotFoundError("Fan topilmadi");

    const topics = await prisma.topic.findMany({
      where: { subjectId, language: lang },
      orderBy: { order: "asc" },
      select: TOPIC_SELECT,
    });
    if (topics.length === 0) {
      throw new BadRequestError(
        `"${subject.name}" fanida ${label} tilidagi mavzu yo'q — avval mavzular faylini yuklang`,
      );
    }

    return { language: lang, sheets: [{ subject, topics }] };
  }

  // Fanlar nomi bo'yicha: varaqlar faylda alifbo tartibida tursin
  const subjects = await prisma.subject.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  const topics = await prisma.topic.findMany({
    where: { language: lang },
    orderBy: { order: "asc" },
    select: TOPIC_SELECT,
  });

  const bySubject = new Map();
  for (const topic of topics) {
    if (!bySubject.has(topic.subjectId)) bySubject.set(topic.subjectId, []);
    bySubject.get(topic.subjectId).push(topic);
  }

  const sheets = subjects
    .filter((subject) => bySubject.has(subject.id))
    .map((subject) => ({ subject, topics: bySubject.get(subject.id) }));

  if (sheets.length === 0) {
    throw new BadRequestError(
      `Birorta fanda ${label} tilidagi mavzu yo'q — avval mavzular faylini yuklang`,
    );
  }

  return { language: lang, sheets };
}

/** Bitta fanning varag'i. */
function addSubjectSheet(workbook, usedNames, { subject, topics }) {
  const rows = buildTopicRows(topics);

  const sheet = ExcelService.addSheet(workbook, {
    sheetName: uniqueSheetName(usedNames, sheetNameOf(subject.name)),
    columns: EXPORT_COLUMNS.map(({ header, key, width }) => ({ header, key, width })),
    data: rows,
    headerStyle: HEADER_STYLE,
  });

  rows.forEach((row, index) => {
    const excelRow = sheet.getRow(index + 2); // 1-qator — sarlavha
    excelRow.alignment = { vertical: "middle", wrapText: true };
    excelRow.getCell(1).alignment = { vertical: "middle", horizontal: "center" };
    if (row.isEmptySlot) excelRow.font = EMPTY_SLOT_FONT;
  });

  return sheet;
}

/**
 * @param {import("express").Response} res
 * @param {string|null} [subjectId] - bitta fan; bo'lmasa mavzusi bor hamma fan
 * @param {string} [language] - o'quv tili (sukut: `uz`)
 */
async function exportTopics(res, subjectId = null, language = undefined) {
  const { language: lang, sheets } = await loadExportSheets(subjectId, language);

  const workbook = ExcelService.createWorkbook();
  const usedNames = new Set();
  for (const item of sheets) addSubjectSheet(workbook, usedNames, item);

  // Til fayl NOMIDA: uchta tilning fayli bir papkada bir-birini
  // almashtirmasin ("mavzular_ru.xlsx"). Varaq nomi esa O'ZGARMAYDI —
  // import aynan fan nomi bo'yicha bog'laydi.
  const suffix = `_${lang}`;
  const baseName = subjectId
    ? `${sheets[0].subject.name}_mavzular${suffix}`
    : `mavzular${suffix}`;
  await ExcelService.sendWorkbookAs(res, workbook, baseName, {
    fallbackName: `mavzular${suffix}`,
  });
}

module.exports = { exportTopics, loadExportSheets };
