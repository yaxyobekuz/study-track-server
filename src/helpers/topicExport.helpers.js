/**
 * MAVZULAR REJASINI FAYLGA YOZISH (sof funksiyalar, bazaga tegmaydi).
 *
 * ⚠️ FAYL — HISOBOT EMAS, SHABLON. Platformada mavzuni tahrirlash yo'li
 * YO'Q: ro'yxat faqat fayl orqali almashtiriladi (`topic.service.js` →
 * `uploadTopics`), ya'ni "yuklab olish" amalda tahrirlashning birinchi
 * qadami. Shuning uchun yuklab olingan fayl hech narsa o'zgartirmasdan
 * QAYTA YUKLANSA, AYNAN o'sha mavzular AYNI raqamlar bilan qaytishi kerak
 * (`test/topicExport.helpers.test.js` — round-trip).
 *
 * Shundan kelib chiqadigan uchta qaror:
 *
 * 1. ⚠️ USTUN SARLAVHALARI BIRINCHI QATORDA va ular import shablonining
 *    O'ZI (`TOPIC_COLUMN_LABELS`). Hisobot sarlavhasi (`addTitledSheet` —
 *    1-qator nom, 2-qator izoh, 4-qator ustunlar) QO'YILMAYDI: u paytda
 *    import sarlavha qatorini taxmin qilishga majbur bo'lardi, chunki
 *    hisobot sarlavhasida ham "mavzular" so'zi bor va u "Mavzu" ustuni
 *    sifatida tanilardi.
 *
 * 2. ⚠️ "№" USTUNI MA'LUMOT EMAS, ODAM UCHUN. Import uni `serial` deb
 *    taniydi va O'QIMAYDI — raqam baribir qatorlar tartibidan chiqadi
 *    (`helpers/topicImport.helpers.js`). Ustun ekrandagi jadval bilan
 *    bir xil ko'rinish uchun turadi.
 *
 * 3. ⚠️ BO'SH RAQAM SAQLANADI. Bazada `order` bo'shliqli bo'lishi mumkin
 *    (yuklashda nomi bo'sh qolgan qator raqamni egallaydi). Bo'shliq
 *    qator bilan yozilmasa, qayta yuklashda raqamlar ZICHLASHIB, undan
 *    keyingi hamma mavzu bittaga surilardi — jadvaldagi ankorlar
 *    (`LessonTopicBinding.topicOrder`) esa boshqa mavzuga ko'chib ketardi.
 *    Qatorning "Mavzu" katagi bo'sh, "Nimalar o'rgatiladi" katagida esa
 *    izoh turadi: import "nomi bo'sh, lekin boshqa ma'lumoti bor" qatorni
 *    aynan shu maqsadda raqam egallaydigan qilib o'qiydi.
 */

const { TOPIC_COLUMN_LABELS } = require("./topicImport.helpers");

/** Bo'sh raqam qatorining izohi — qayta yuklashda raqamni EGALLAB turadi. */
const EMPTY_SLOT_NOTE = "(bo'sh raqam — mavzu nomi kiritilmagan)";

/**
 * Shablon ustunlari — tartibi va sarlavhalari import bilan AYNI.
 *
 * ⚠️ "Daraja" / "Kitob" / "Nimalar o'rgatiladi" fanda bo'sh bo'lsa ham
 * ustun CHIQADI (ekrandagi jadvaldan farqi): fayl — tahrirlash shabloni,
 * ya'ni admin o'sha ustunni keyin TO'LDIRISHI uchun joy kerak. Import
 * bo'sh ixtiyoriy ustunni xato deb hisoblamaydi.
 */
const EXPORT_COLUMNS = Object.freeze([
  { header: "№", key: "order", width: 7, align: "center" },
  { header: TOPIC_COLUMN_LABELS.level, key: "level", width: 18 },
  { header: TOPIC_COLUMN_LABELS.book, key: "book", width: 28 },
  { header: TOPIC_COLUMN_LABELS.name, key: "name", width: 46 },
  { header: TOPIC_COLUMN_LABELS.description, key: "description", width: 62 },
]);

/** Excel varaq nomida taqiqlangan belgilar va uzunlik chegarasi. */
const SHEET_NAME_MAX = 31;

/**
 * FAN NOMI → VARAQ NOMI.
 *
 * ⚠️ "Barcha fanlar" rejimida import varaqni AYNAN shu nom bo'yicha fanga
 * bog'laydi (`normalizeSubjectName`). Excel esa nomga o'z cheklovini
 * qo'yadi: 31 belgi va `: \ / ? * [ ]` belgilari mumkin emas. Nom
 * o'zgarishga majbur bo'lsa qayta yuklashda "bunday nomli fan topilmadi"
 * degan ANIQ sabab chiqadi — jim xato emas, shuning uchun nom kesiladi.
 *
 * @param {string} name
 * @returns {string}
 */
function sheetNameOf(name) {
  const cleaned = String(name ?? "")
    .replace(/[:\\/?*[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SHEET_NAME_MAX)
    .trim();
  return cleaned || "Fan";
}

/**
 * Varaq nomini faylda TAKRORSIZ qiladi (ExcelJS takror nomni rad etadi).
 *
 * Takror faqat ikki fan nomi 31 belgidan keyin bir xil bo'lganda yuzaga
 * keladi (`Subject.name` o'zi `@unique`). Bunday nom import bilan
 * baribir mos kelmaydi — lekin fayl yaratilishi YIQILMASLIGI kerak.
 *
 * @param {Set<string>} used - allaqachon ishlatilgan nomlar (o'zgartiriladi)
 * @param {string} base
 * @returns {string}
 */
function uniqueSheetName(used, base) {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let index = 2; ; index += 1) {
    const suffix = ` (${index})`;
    const candidate = base.slice(0, SHEET_NAME_MAX - suffix.length) + suffix;
    if (used.has(candidate)) continue;
    used.add(candidate);
    return candidate;
  }
}

/**
 * MAVZULAR → VARAQ QATORLARI (1-raqamdan oxirgisigacha, bo'shliqlar bilan).
 *
 * @param {Array<{order: number, name: string, level?: string|null, book?: string|null, description?: string|null}>} topics
 * @returns {Array<{order: number, level: string, book: string, name: string, description: string, isEmptySlot: boolean}>}
 */
function buildTopicRows(topics) {
  const byOrder = new Map();
  let maxOrder = 0;
  for (const topic of topics ?? []) {
    byOrder.set(topic.order, topic);
    if (topic.order > maxOrder) maxOrder = topic.order;
  }

  const rows = [];
  for (let order = 1; order <= maxOrder; order += 1) {
    const topic = byOrder.get(order);
    if (!topic) {
      rows.push({
        order,
        level: "",
        book: "",
        name: "",
        description: EMPTY_SLOT_NOTE,
        isEmptySlot: true,
      });
      continue;
    }
    rows.push({
      order,
      level: topic.level ?? "",
      book: topic.book ?? "",
      name: topic.name ?? "",
      description: topic.description ?? "",
      isEmptySlot: false,
    });
  }

  return rows;
}

/** Varaq qatorlari → `sheet_to_json(header: 1)` ko'rinishi (test va tekshiruv uchun). */
function toSheetMatrix(rows) {
  return [
    EXPORT_COLUMNS.map((column) => column.header),
    ...rows.map((row) => EXPORT_COLUMNS.map((column) => String(row[column.key] ?? ""))),
  ];
}

module.exports = {
  EMPTY_SLOT_NOTE,
  EXPORT_COLUMNS,
  SHEET_NAME_MAX,
  sheetNameOf,
  uniqueSheetName,
  buildTopicRows,
  toSheetMatrix,
};
