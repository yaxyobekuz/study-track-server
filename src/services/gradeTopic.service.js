/**
 * BAHO MAVZUSI — bugungi darsga qo'yilayotgan bahoga mavzu biriktirish.
 *
 * Hisob `helpers/lessonTopic.js` da (sof funksiya); bu yerda faqat baza.
 *
 * ⚠️ HECH QACHON XATO TASHLAMAYDI. Mavzu — baholar tahlili uchun QO'SHIMCHA
 * ma'lumot; uni aniqlab bo'lmasa baho baribir yozilishi shart. Shu sababli
 * har qanday xato `null` (mavzusiz baho) bilan tugaydi va log'da qoladi —
 * o'qituvchi "baho qo'yib bo'lmadi" degan xatoni hech qachon ko'rmaydi.
 */

const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const { topicNumberForLesson, cronClockMinutes } = require("../helpers/lessonTopic");

/**
 * @param {object} input
 * @param {string} input.classId
 * @param {string} input.subjectId
 * @param {Array<{order: number, subjectId: string, endTime?: string|null}>} input.lessons - sinfning bugungi darslari
 * @param {number[]} input.lessonOrders - baho yoziladigan dars tartiblari
 * @returns {Promise<Map<number, string>>} dars tartibi → `Topic.id` (topilmaganlari yo'q)
 */
async function resolveGradeTopics({ classId, subjectId, lessons, lessonOrders }) {
  const result = new Map();

  try {
    if (!classId || !subjectId || !Array.isArray(lessonOrders) || lessonOrders.length === 0) {
      return result;
    }

    const [progress, topics] = await Promise.all([
      prisma.classSubjectProgress.findUnique({
        where: { classId_subjectId: { classId, subjectId } },
        select: { currentTopicNumber: true },
      }),
      prisma.topic.findMany({
        where: { subjectId },
        select: { id: true, order: true },
        orderBy: { order: "asc" },
      }),
    ]);

    // Fanda mavzular kiritilmagan — biriktiradigan narsa yo'q
    if (topics.length === 0) return result;

    const byOrder = new Map(topics.map((topic) => [topic.order, topic.id]));
    const nowMinutes = cronClockMinutes();

    for (const lessonOrder of lessonOrders) {
      const topicNumber = topicNumberForLesson({
        // Progress qatori yo'q — cron hali bu sinf+fanga tegmagan, ya'ni 1-mavzu
        // (jurnal ekranidagi `currentTopic` bilan AYNI qoida).
        currentTopicNumber: progress?.currentTopicNumber ?? 1,
        lastTopicOrder: topics[topics.length - 1].order,
        lessons,
        subjectId,
        lessonOrder,
        nowMinutes,
      });

      const topicId = topicNumber != null ? byOrder.get(topicNumber) : null;
      if (topicId) result.set(lessonOrder, topicId);
    }
  } catch (error) {
    logger.warn(`[GradeTopic] Mavzuni aniqlab bo'lmadi (baho mavzusiz yoziladi): ${error.message}`);
  }

  return result;
}

module.exports = { resolveGradeTopics };
