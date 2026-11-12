const prisma = require("../config/prisma");
const XLSX = require("xlsx");
const logger = require("../utils/logger");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { parseTopicSheet, normalizeSubjectName } = require("../helpers/topicImport.helpers");
const {
  TEACHING_LANGUAGES,
  DEFAULT_TEACHING_LANGUAGE,
  normalizeLanguage,
  isTeachingLanguage,
  languageLabel,
  languageClassLabel,
} = require("../helpers/teachingLanguage.helpers");

/**
 * YUKLASHDAGI TIL — "bu fayl qaysi tildagi guruhlar uchun".
 *
 * ⚠️ BITTA FAYL — BITTA TIL (biznes qarori, 2026-11-12). Tilni varaq nomidan
 * taxmin qilish ("Matematika (rus)") `education.md` §10 dagi moslash
 * doktrinasini buzardi: nom bir harf bilan farq qilsa, butun reja boshqa
 * tilning ro'yxatini ALMASHTIRIB yuborardi. Shuning uchun til oynada ongli
 * tanlanadi va butun faylga qo'llanadi.
 *
 * ⚠️ TANIMAGAN QIYMATDA XATO: bu KIRITISH yo'li. Jim `uz` ga tushirilsa,
 * rus guruhining rejasi o'zbek ro'yxatini o'chirib yuborardi.
 */
function assertUploadLanguage(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_TEACHING_LANGUAGE;
  }
  if (!isTeachingLanguage(value)) {
    throw new BadRequestError(
      `Noma'lum o'quv tili "${value}" — ${TEACHING_LANGUAGES.join(", ")} dan biri bo'lishi kerak`,
    );
  }
  return normalizeLanguage(value);
}

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
 *
 * ⚠️ FAQAT SHU TILDAGI RO'YXAT ALMASHADI. Rus rejasini yuklash o'zbek
 * rejasiga TEGMAYDI: ular mustaqil ro'yxat va har biri 1 dan raqamlanadi
 * (`Topic.language`). Tilsiz o'chirish bitta yuklash bilan boshqa ikki
 * guruhning mavzularini yo'q qilardi.
 */
async function replaceSubjectTopics(subjectId, language, topics, createdBy) {
  await prisma.$transaction(async (tx) => {
    await tx.topic.deleteMany({ where: { subjectId, language } });
    await tx.topic.createMany({
      data: topics.map((topic) => ({ ...topic, subjectId, language, createdBy })),
    });
  });
}

/**
 * Bitta varaqni o'qib, fanga yozadi va hisobot qatorini qaytaradi.
 *
 * @returns {Promise<object>} `{ sheet, subject, status, topicCount, columns, notes, warnings, reason }`
 */
async function importSheet({ sheetName, sheet, subject, language, createdBy }) {
  const { rows, rowOffset, colOffset } = readSheetRows(sheet);
  const parsed = parseTopicSheet(rows, { rowOffset, colOffset });

  const report = {
    sheet: sheetName,
    subject: subject ? { id: subject.id, name: subject.name } : null,
    language,
    languageLabel: languageLabel(language),
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

  await replaceSubjectTopics(subject.id, language, parsed.topics, createdBy);

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
 * ⚠️ TIL BUTUN FAYLGA (`assertUploadLanguage`): yuklash faqat O'SHA tildagi
 * ro'yxatni almashtiradi, qolgan tillarga tegmaydi.
 *
 * @param {string|null} subjectId - bitta fan uchun ID (ixtiyoriy)
 * @param {object} file - yuklangan fayl (multer fayl obyekti)
 * @param {string} createdBy - yaratuvchi foydalanuvchi ID
 * @param {{language?: string}} [options] - o'quv tili (sukut: `uz`)
 * @returns {Promise<{language: string, processedSubjects: number, totalTopics: number, sheets: Array, errors?: string[]}>}
 */
async function uploadTopics(subjectId, file, createdBy, { language } = {}) {
  const lang = assertUploadLanguage(language);

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
      await importSheet({
        sheetName,
        sheet: workbook.Sheets[sheetName],
        subject,
        language: lang,
        createdBy,
      }),
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
        language: lang,
        languageLabel: languageLabel(lang),
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
        language: lang,
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
    `[Topics] Yuklandi (${lang}): ` +
      `${loaded.map((item) => `${item.subject.name} (${item.topicCount})`).join(", ")}`,
  );

  return {
    language: lang,
    languageLabel: languageLabel(lang),
    processedSubjects,
    totalTopics,
    sheets,
    errors: problems.length > 0 ? problems : undefined,
  };
}

/**
 * Berilgan fan uchun mavzular — BITTA TILDA.
 *
 * ⚠️ TILSIZ O'QILMAYDI: uch tilning ro'yxati bitta massivga qo'shilsa,
 * tartib raqamlari takrorlanib ("1-mavzu" uch marta), ekranda qaysi
 * ro'yxatdagi mavzu ekani noma'lum bo'lib qolardi. Berilmasa — `uz`
 * (migratsiyadagi mavjud ma'lumot aynan shunda).
 *
 * @param {string} subjectId - fan ID
 * @param {{language?: string}} [options]
 * @returns {Promise<Array>} mavzular ro'yxati
 */
async function getTopicsBySubject(subjectId, { language } = {}) {
  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) {
    throw new NotFoundError("Fan topilmadi");
  }

  return prisma.topic.findMany({
    where: { subjectId, language: normalizeLanguage(language) },
    orderBy: { order: "asc" },
    omit: { createdBy: true },
  });
}

/**
 * FANLAR BO'YICHA MAVZU HOLATI — "qaysi fanga yuklangan, qaysiga yo'q".
 *
 * ⚠️ Ro'yxat FANLAR KATALOGIDAN quriladi, mavzulardan EMAS: mavzudan
 * yig'ilsa mavzusi yo'q fan ro'yxatda umuman ko'rinmasdi — holbuki ekran
 * aynan o'sha savol uchun ochiladi (`education.md` §14 dagi "jadval
 * katalogdan quriladi" qoidasi bilan AYNI).
 *
 * `lastUploadedAt` — fanning eng kech yozilgan mavzu qatori: yuklash
 * ro'yxatni ALMASHTIRADI (`replaceSubjectTopics`), ya'ni bu aynan "qachon
 * yuklangan" degani. Sana MATNI emas, instant qaytadi — formatlashni
 * panel qiladi (`dates.md` §5).
 *
 * @returns {Promise<{items: Array, totals: object}>}
 */
async function getSubjectTopicStatus({ language = null } = {}) {
  // ⚠️ TIL FILTRI IXTIYORIY va uning yo'qligi ALOHIDA savol: "qaysi fanga
  // umuman reja yuklangan" (filtrsiz) bilan "qaysi fanga RUS rejasi
  // yuklangan" (filtr bilan) ikki boshqa savol va ikkalasi ham kerak —
  // rus guruh ochilganda aynan ikkinchisi javob beradi.
  const filter = language ? normalizeLanguage(language) : null;

  const [subjects, grouped, classStats] = await Promise.all([
    prisma.subject.findMany({
      select: { id: true, name: true, isActive: true },
      orderBy: { name: "asc" },
    }),
    prisma.topic.groupBy({
      by: ["subjectId", "language"],
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    // ⚠️ SINFLAR KESIMI JAVOBDA: "ingliz guruh bor, lekin ingliz rejasi
    // yuklanmagan" holatini ekran aynan shundan ko'rsatadi. Usiz admin
    // har tilni qo'lda tekshirib chiqishi kerak bo'lardi.
    prisma.class.groupBy({
      by: ["language"],
      where: { isActive: true },
      _count: { _all: true },
    }),
  ]);

  /** fan → til → { topicCount, lastUploadedAt } */
  const stats = new Map();
  for (const row of grouped) {
    if (!stats.has(row.subjectId)) stats.set(row.subjectId, new Map());
    stats.get(row.subjectId).set(row.language, {
      topicCount: row._count._all,
      lastUploadedAt: row._max.createdAt,
    });
  }

  const items = subjects.map((subject) => {
    const byLanguage = stats.get(subject.id) ?? new Map();

    const languages = TEACHING_LANGUAGES.map((key) => {
      const stat = byLanguage.get(key);
      return {
        language: key,
        label: languageLabel(key),
        classLabel: languageClassLabel(key),
        topicCount: stat?.topicCount ?? 0,
        lastUploadedAt: stat?.lastUploadedAt ?? null,
        hasTopics: Boolean(stat?.topicCount),
      };
    });

    // Filtr berilsa sanoq O'SHA tilning raqami bo'ladi; berilmasa —
    // hamma tilning yig'indisi (ro'yxatning o'zi baribir til kesimini
    // beradi, ya'ni ikki raqam aralashmaydi).
    const scoped = filter ? languages.filter((row) => row.language === filter) : languages;
    const topicCount = scoped.reduce((sum, row) => sum + row.topicCount, 0);
    const lastUploadedAt = scoped.reduce(
      (latest, row) =>
        row.lastUploadedAt && (!latest || row.lastUploadedAt > latest)
          ? row.lastUploadedAt
          : latest,
      null,
    );

    return {
      id: subject.id,
      name: subject.name,
      isActive: subject.isActive,
      topicCount,
      lastUploadedAt,
      hasTopics: topicCount > 0,
      languages,
    };
  });

  const withTopics = items.filter((item) => item.hasTopics).length;

  const classesByLanguage = new Map(classStats.map((row) => [row.language, row._count._all]));

  return {
    items,
    language: filter,
    totals: {
      subjects: items.length,
      withTopics,
      withoutTopics: items.length - withTopics,
      topics: items.reduce((sum, item) => sum + item.topicCount, 0),
      // Til kesimi: nechta fanga reja bor va nechta FAOL guruh shu tilda
      byLanguage: TEACHING_LANGUAGES.map((key) => ({
        language: key,
        label: languageLabel(key),
        classLabel: languageClassLabel(key),
        subjects: items.filter(
          (item) => item.languages.find((row) => row.language === key)?.hasTopics,
        ).length,
        topics: items.reduce(
          (sum, item) =>
            sum + (item.languages.find((row) => row.language === key)?.topicCount ?? 0),
          0,
        ),
        classes: classesByLanguage.get(key) ?? 0,
      })),
    },
  };
}

/**
 * Fanning mavzularini o'chirish — BITTA TILDA.
 *
 * ⚠️ TIL MAJBURIY EMAS, lekin berilmasa FAQAT `uz` o'chadi (yuklash bilan
 * AYNI qoida): "hamma tilni birdan o'chirish" tugmasi bitta bosishda uch
 * guruhning rejasini yo'q qilardi.
 *
 * @param {string} subjectId - fan ID
 * @param {{language?: string}} [options]
 * @returns {Promise<{deletedCount: number, language: string}>}
 */
async function deleteTopicsBySubject(subjectId, { language } = {}) {
  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) {
    throw new NotFoundError("Fan topilmadi");
  }

  const lang = assertUploadLanguage(language);
  const result = await prisma.topic.deleteMany({ where: { subjectId, language: lang } });
  return { deletedCount: result.count, language: lang, languageLabel: languageLabel(lang) };
}

module.exports = {
  assertUploadLanguage,
  uploadTopics,
  getTopicsBySubject,
  getSubjectTopicStatus,
  deleteTopicsBySubject,
};
