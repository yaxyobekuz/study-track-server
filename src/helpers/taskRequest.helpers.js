/**
 * TOPSHIRIQ SO'ROVINING TANASINI SERVIS KUTGAN SHAKLGA KELTIRADI.
 *
 * `multipart/form-data` da massivlar JSON SATRI bo'lib keladi (fayl bilan
 * bir qatorda yuborilgani uchun) — ya'ni `weekdays: "[1,3]"`. Servis esa
 * haqiqiy massiv kutadi.
 *
 * ⚠️ YAGONA PARSER. Ilgari u `taskSchedule.controller.js` ichida yashardi
 * va shaxsiy topshiriqlar yo'li (`selfTask.controller.js`) qo'shilganda
 * o'sha yerdan ko'rinmasdi: natijada "har dushanba" qoidasi fayl bilan
 * yuborilganda "Hafta kunlari tanlanishi kerak" degan xato berardi —
 * holbuki kunlar tanlangan edi. Ikkita nusxa bo'lsa, keyingi maydon
 * (masalan `monthDays`) faqat bittasiga qo'shilib qolardi.
 *
 * ⚠️ `slots` BU YERDA OCHILMAYDI: uni `taskSchedule.service.js` dagi
 * `_assertSlots` o'zi ochadi (ichidagi vaqtlarni baribir qator-qator
 * tekshiradi). Ikki joyda ochilsa, biri ikkinchisining xato xabarini
 * bosib ketardi.
 */

const { BadRequestError } = require("../utils/errors");

/**
 * JSON satri yoki massiv → massiv. Bo'sh qiymat — `undefined`, ya'ni
 * "maydon berilmagan" (tahrirda u o'zgarmaydi degani).
 *
 * @param {unknown} value
 * @param {string} label - xato xabarida ko'rinadigan nom
 * @returns {Array|undefined}
 */
const parseJsonList = (value, label) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("not array");
    return parsed;
  } catch {
    throw new BadRequestError(`${label} formati noto'g'ri`);
  }
};

/**
 * DOIMIY TOPSHIRIQ QOIDASI uchun tana — yaratish ham, tahrir ham.
 *
 * @param {object} req - Express request
 * @returns {object}
 */
const buildSchedulePayload = (req) => ({
  ...req.body,
  assigneeIds: parseJsonList(req.body.assigneeIds, "Ijrochilar"),
  weekdays: parseJsonList(req.body.weekdays, "Hafta kunlari"),
  monthDays: parseJsonList(req.body.monthDays, "Oy kunlari"),
  links: req.body.links,
  files: req.files || [],
});

module.exports = { parseJsonList, buildSchedulePayload };
