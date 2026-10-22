const prisma = require("../config/prisma");
const XLSX = require("xlsx");
const logger = require("../utils/logger");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { parseTopicSheet, normalizeSubjectName } = require("../helpers/topicImport.helpers");

/**
 * Varaqni qatorlar massiviga o'qiydi.
 *
 * ⚠️ `header: 1` + `defval` — har qator TO'LIQ massiv: bo'sh katak o'z
 * o'rnida qoladi. Obyekt ko'rinishidagi `sheet_to_json` bo'sh katakni
 * qatordan tushirib qoldirardi va ustunlar surilib ketardi.
 * `raw: false` — katak faylda QANDAY ko'ringan bo'lsa shunday (son va sana
 * formati bilan) olinadi.
 */
function readSheetRows(sheet) {
  const ref = sheet?.["!ref"];
  if (!ref) return { rows: [], rowOffset: 0, colOffset: 0 };
  const range = XLSX.utils.decode_range(ref);
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    raw: false,
    blankrows: true,
  });
  return { rows, rowOffset: range.s.r, colOffset: range.s.c };
}

/**
 * Fanning mavzularini ALMASHTIRADI — o'chirish va yozish BITTA tranzaksiyada.
 *
 * ⚠️ Ilgari ikki alohida so'rov edi: yozish yiqilsa (masalan ulanish
 * uzilsa) fanning eski mavzulari o'chib, yangisi yozilmay qolardi va dars
 * jadvalidagi hamma mavzu "yuklanmagan" bo'lib ketardi.
 */
async function replaceSubjectTopics(subjectId, topics, createdBy) {
  await prisma.$transaction(async (tx) => {
    await tx.topic.deleteMany({ where: { subjectId } });
    await tx.topic.createMany({
      data: topics.map((topic) => ({ ...topic, subjectId, createdBy })),
    });
  });
}

/**
 * Bitta varaqni o'qib, fanga yozadi va hisobot qatorini qaytaradi.
 *
 * @returns {Promise<object>} `{ sheet, subject, status, topicCount, columns, notes, warnings, reason }`
 */
async function importSheet({ sheetName, sheet, subject, createdBy }) {
  const { rows, rowOffset, colOffset } = readSheetRows(sheet);
  const parsed = parseTopicSheet(rows, { rowOffset, colOffset });

  const report = {
    sheet: sheetName,
    subject: subject ? { id: subject.id, name: subject.name } : null,
    status: "skipped",
    topicCount: 0,
    columns: parsed.columns,
    notes: parsed.notes,
    warnings: parsed.warnings,
    reason: parsed.error,
  };

  // ⚠️ Varaq o'qilmasa fanning MAVJUD mavzulariga tegilmaydi: buzuq fayl
  // ishlab turgan mavzular ro'yxatini o'chirib yubormasligi kerak.
  if (parsed.error) return report;

  await replaceSubjectTopics(subject.id, parsed.topics, createdBy);

  report.status = "loaded";
  report.topicCount = parsed.topics.length;
  return report;
}

/** Hisobot qatorlaridan eski ko'rinishdagi tekis xabarlar ro'yxati. */
function flattenProblems(sheets) {
  const problems = [];
  for (const item of sheets) {
    const prefix = `Varaq "${item.sheet}"`;
    if (item.reason) problems.push(`${prefix}: ${item.reason}`);
    for (const warning of item.warnings) problems.push(`${prefix}: ${warning}`);
  }
  return problems;
}

/**
 * Excel fayldan mavzularni yuklash.
 *
 * Ustunlar sarlavha nomi bo'yicha topiladi (`helpers/topicImport.helpers.js`):
 * "Mavzu" majburiy, "Daraja", "Kitob", "Nimalar o'rgatiladi" ixtiyoriy.
 *
 * @param {string|null} subjectId - bitta fan uchun ID (ixtiyoriy)
 * @param {object} file - yuklangan fayl (multer fayl obyekti)
 * @param {string} createdBy - yaratuvchi foydalanuvchi ID
 * @returns {Promise<{processedSubjects: number, totalTopics: number, sheets: Array, errors?: string[]}>}
 */
async function uploadTopics(subjectId, file, createdBy) {
  if (!file) {
    throw new BadRequestError("Excel fayl yuklanmadi");
  }

  const fileExtension = file.originalname.split(".").pop().toLowerCase();
  if (fileExtension !== "xlsx") {
    throw new BadRequestError("Faqat .xlsx formatdagi fayllar qabul qilinadi");
  }

  // ⚠️ .xlsx — ZIP arxiv ("PK\x03\x04" bilan boshlanadi). `XLSX.read` har
  // qanday matnni CSV deb o'qib "Sheet1" varag'ini yasab beradi va admin
  // "Sheet1 nomli fan topilmadi" degan NOTO'G'RI sababni ko'rardi —
  // haqiqiy sabab esa fayl turining o'zi.
  const signature = file.buffer?.subarray(0, 4);
  if (!signature || signature.length < 4 || signature.toString("binary") !== "PK\x03\x04") {
    throw new BadRequestError(
      "Fayl .xlsx emas yoki buzilgan — Excel'da ochib, \".xlsx\" formatida qayta saqlang",
    );
  }

  let workbook;
  try {
    workbook = XLSX.read(file.buffer, { type: "buffer" });
  } catch (error) {
    logger.warn(`[Topics] Fayl o'qilmadi (${file.originalname}): ${error.message}`);
    throw new BadRequestError("Faylni o'qib bo'lmadi — u buzilgan yoki .xlsx emas");
  }
  const sheetNames = workbook.SheetNames;

  if (sheetNames.length === 0) {
    throw new BadRequestError("Excel faylda varaqlar topilmadi");
  }

  const sheets = [];

  if (subjectId) {
    const subject = await prisma.subject.findUnique({
      where: { id: subjectId },
      select: { id: true, name: true },
    });
    if (!subject) {
      throw new NotFoundError("Fan topilmadi");
    }

    // Bitta fan rejimida faqat BIRINCHI varaq o'qiladi (oynada shunday yozilgan)
    const sheetName = sheetNames[0];
    sheets.push(
      await importSheet({ sheetName, sheet: workbook.Sheets[sheetName], subject, createdBy }),
    );
  } else {
    // Fanlar BIR MARTA o'qiladi va varaq nomi bilan normallashtirilgan holda
    // solishtiriladi: oxirgi bo'shliq va apostrof varianti bitta fan.
    const subjects = await prisma.subject.findMany({ select: { id: true, name: true } });
    const subjectsByName = new Map();
    for (const subject of subjects) {
      const key = normalizeSubjectName(subject.name);
      if (!subjectsByName.has(key)) subjectsByName.set(key, []);
      subjectsByName.get(key).push(subject);
    }

    const loadedBy = new Map(); // fan id → birinchi yuklangan varaq nomi

    for (const sheetName of sheetNames) {
      const matches = subjectsByName.get(normalizeSubjectName(sheetName)) ?? [];
      const skipped = (reason) => ({
        sheet: sheetName,
        subject: matches.length === 1 ? { id: matches[0].id, name: matches[0].name } : null,
        status: "skipped",
        topicCount: 0,
        columns: {},
        notes: [],
        warnings: [],
        reason,
      });

      if (matches.length === 0) {
        sheets.push(
          skipped(
            `"${sheetName}" nomli fan topilmadi — varaq nomi platformadagi fan nomi bilan bir xil bo'lishi kerak`,
          ),
        );
        continue;
      }

      // ⚠️ TAXMIN QILINMAYDI: ikki fan bir xil nomga tushsa, mavzular
      // noto'g'ri fanga yozilib, uning ro'yxatini o'chirib yuborardi.
      if (matches.length > 1) {
        sheets.push(
          skipped(
            `"${sheetName}" nomiga ${matches.length} ta fan mos keldi — qaysi biriga yuklashni aniqlab bo'lmadi. "Bitta fan" usulida yuklang`,
          ),
        );
        continue;
      }

      const subject = matches[0];

      // Ikki varaq bitta fanga tushsa, ikkinchisi birinchisini jimgina
      // almashtirib yuborardi.
      if (loadedBy.has(subject.id)) {
        sheets.push(
          skipped(
            `"${subject.name}" fani shu faylning "${loadedBy.get(subject.id)}" varag'idan allaqachon yuklandi`,
          ),
        );
        continue;
      }

      const report = await importSheet({
        sheetName,
        sheet: workbook.Sheets[sheetName],
        subject,
        createdBy,
      });
      if (report.status === "loaded") loadedBy.set(subject.id, sheetName);
      sheets.push(report);
    }
  }

  const loaded = sheets.filter((item) => item.status === "loaded");
  const processedSubjects = loaded.length;
  const totalTopics = loaded.reduce((sum, item) => sum + item.topicCount, 0);
  const problems = flattenProblems(sheets);

  if (processedSubjects === 0) {
    // Sababi xabarning o'zida: bitta varaq bo'lsa — uning sababi, bir
    // nechta bo'lsa — ro'yxat `details` da (oyna uni chizadi).
    const message =
      sheets.length === 1 && sheets[0].reason
        ? `Mavzular yuklanmadi: ${sheets[0].reason}`
        : "Hech qaysi varaqdan mavzu yuklanmadi — sabablari quyida";
    throw new BadRequestError(message, { sheets, errors: problems });
  }

  logger.info(
    `[Topics] Yuklandi: ${loaded.map((item) => `${item.subject.name} (${item.topicCount})`).join(", ")}`,
  );

  return {
    processedSubjects,
    totalTopics,
    sheets,
    errors: problems.length > 0 ? problems : undefined,
  };
}

/**
 * Berilgan fan uchun barcha mavzularni olish.
 * @param {string} subjectId - fan ID
 * @returns {Promise<Array>} mavzular ro'yxati
 */
async function getTopicsBySubject(subjectId) {
  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) {
    throw new NotFoundError("Fan topilmadi");
  }

  return prisma.topic.findMany({
    where: { subjectId },
    orderBy: { order: "asc" },
    omit: { createdBy: true },
  });
}

/**
 * Berilgan fan uchun barcha mavzularni o'chirish.
 * @param {string} subjectId - fan ID
 * @returns {Promise<{deletedCount: number}>}
 */
async function deleteTopicsBySubject(subjectId) {
  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) {
    throw new NotFoundError("Fan topilmadi");
  }

  const result = await prisma.topic.deleteMany({ where: { subjectId } });
  return { deletedCount: result.count };
}

module.exports = {
  uploadTopics,
  getTopicsBySubject,
  deleteTopicsBySubject,
};
