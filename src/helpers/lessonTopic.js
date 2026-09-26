/**
 * DARS MAVZUSI — bugungi darsda qaysi mavzu o'tilgani (sof funksiya).
 *
 * Mavzu tarixi saqlanmaydi: sinf+fan uchun faqat BITTA joriy raqam bor
 * (`ClassSubjectProgress.currentTopicNumber`) va uni `topicIncrement.job.js`
 * har bir dars TUGAGAN daqiqada bittaga oshiradi. Shuning uchun "joriy
 * raqam" darsdan keyin qo'yilgan baho uchun allaqachon KEYINGI mavzuni
 * ko'rsatadi. Bu funksiya o'sha siljishni orqaga qaytaradi:
 *
 *   bugungi boshlang'ich = joriy − (bugun shu fandan TUGAGAN darslar)
 *   i-dars mavzusi       = boshlang'ich + (undan OLDINGI oshiruvchi darslar)
 *
 * ⚠️ "Oshiruvchi dars" — tugash vaqti (`endTime`) bor dars: cron faqat
 * shularni oshiradi. Vaqtsiz dars hisobga qo'shilsa, raqam jimgina bir
 * mavzuga siljirdi.
 *
 * ⚠️ SOAT — cron bilan AYNI manba (`new Date().getHours()`, jarayon soati).
 * Cron dars tugaganini shu soat bilan aniqlaydi; boshqa soat (masalan
 * Toshkent devor-soati) olinsa, server boshqa mintaqada turganda ikkalasi
 * turli darsni "tugagan" deb hisoblab, mavzu adashardi.
 *
 * ⚠️ TAXMIN YOZILMAYDI. Mavzular tugab qolgan bo'lsa (joriy — oxirgi mavzu
 * va bugun dars tugagan), cron oshira olmagan bo'lishi mumkin — aniq
 * raqamni bilib bo'lmaydi va `null` qaytadi. Noto'g'ri mavzu tahlilda
 * boshqa mavzuni "oqsayapti" deb ayblardi; bo'sh mavzu esa shunchaki
 * qamrovdan chiqadi.
 */

/** "HH:MM" → daqiqa; yaroqsiz bo'lsa `null`. */
const toMinutes = (time) => {
  if (typeof time !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

/** Cron ishlatadigan soat — jarayon mintaqasi (izohga qarang). */
const cronClockMinutes = (now = new Date()) => now.getHours() * 60 + now.getMinutes();

/**
 * @param {object} input
 * @param {number} input.currentTopicNumber - sinf+fanning joriy mavzu raqami
 * @param {number} input.lastTopicOrder - fanning eng oxirgi mavzu raqami
 * @param {Array<{order: number, subjectId: string, endTime?: string|null}>} input.lessons - sinfning BUGUNGI darslari
 * @param {string} input.subjectId
 * @param {number} input.lessonOrder - baho qo'yilayotgan dars tartibi
 * @param {number} input.nowMinutes - `cronClockMinutes()`
 * @returns {number|null} mavzu raqami (`Topic.order`) yoki `null`
 */
function topicNumberForLesson({
  currentTopicNumber,
  lastTopicOrder,
  lessons,
  subjectId,
  lessonOrder,
  nowMinutes,
}) {
  if (!Number.isInteger(currentTopicNumber) || currentTopicNumber < 1) return null;

  const same = (lessons || [])
    .filter((lesson) => lesson && lesson.subjectId === subjectId)
    .sort((a, b) => a.order - b.order);

  const target = same.find((lesson) => lesson.order === lessonOrder);
  if (!target) return null;

  const incrementing = same.filter((lesson) => toMinutes(lesson.endTime) != null);
  const ended = incrementing.filter((lesson) => toMinutes(lesson.endTime) <= nowMinutes).length;
  const before = incrementing.filter((lesson) => lesson.order < lessonOrder).length;

  // Mavzular tugagan: cron oshira olmagan bo'lishi mumkin — raqam noaniq
  if (ended > 0 && Number.isInteger(lastTopicOrder) && currentTopicNumber >= lastTopicOrder) {
    return null;
  }

  const topicNumber = currentTopicNumber - ended + before;
  return topicNumber >= 1 ? topicNumber : null;
}

module.exports = { topicNumberForLesson, cronClockMinutes, toMinutes };
