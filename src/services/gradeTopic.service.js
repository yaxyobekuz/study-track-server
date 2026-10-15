/**
 * BAHO MAVZUSI — qo'yilayotgan bahoga dars mavzusini biriktirish.
 *
 * Hisob `lessonTopic.service.js` da (ankor + sanoq) — bu yerda faqat
 * chaqiruv va xatolarni yutish qatlami.
 *
 * ⚠️ YAGONA HISOB. Ilgari bu yerda alohida mantiq bor edi: sinf+fan uchun
 * bitta "joriy mavzu raqami" (`ClassSubjectProgress`) cron bilan oshirilar,
 * baho esa o'sha raqamdan bugun TUGAGAN darslar sonini ayirib hisoblanardi.
 * Endi mavzu jadvalga ham chiqadi, ya'ni ikkita hisob bo'lsa jurnalda bir
 * mavzu, jadvalda boshqa mavzu turardi.
 *
 * ⚠️ HECH QACHON XATO TASHLAMAYDI. Mavzu — baholar tahlili uchun QO'SHIMCHA
 * ma'lumot; uni aniqlab bo'lmasa baho baribir yozilishi shart. Shu sababli
 * har qanday xato `null` (mavzusiz baho) bilan tugaydi va log'da qoladi —
 * o'qituvchi "baho qo'yib bo'lmadi" degan xatoni hech qachon ko'rmaydi.
 */

const logger = require("../utils/logger");
const { tashkentDayKey } = require("../helpers/lessonHours");
const { getLessonTopicIds } = require("./lessonTopic.service");

/**
 * @param {object} input
 * @param {string} input.classId
 * @param {string} input.subjectId
 * @param {number[]} input.lessonOrders - baho yoziladigan dars tartiblari
 * @param {string} [input.actorId] - bahoni qo'yayotgan odam (avtomatik ankor muallifi)
 * @param {Date} [input.at] - baho qo'yilayotgan on (sukut: hozir)
 * @returns {Promise<Map<number, string>>} dars tartibi → `Topic.id` (topilmaganlari yo'q)
 */
async function resolveGradeTopics({ classId, subjectId, lessonOrders, actorId, at }) {
  try {
    if (!classId || !subjectId || !Array.isArray(lessonOrders) || lessonOrders.length === 0) {
      return new Map();
    }

    return await getLessonTopicIds({
      classId,
      subjectId,
      // Baho Toshkent kuniga tegishli (`Grade.date` — INSTANT, `@db.Date` emas)
      day: tashkentDayKey(at instanceof Date ? at : new Date()),
      lessonOrders,
      actorId,
    });
  } catch (error) {
    logger.warn(`[GradeTopic] Mavzuni aniqlab bo'lmadi (baho mavzusiz yoziladi): ${error.message}`);
    return new Map();
  }
}

module.exports = { resolveGradeTopics };
