/**
 * DARS MAVZUSI — ANKORDAN SANOQ (sof funksiyalar, bazaga tegmaydi).
 *
 * Dars jadvali — HAFTALIK SHABLON (`Schedule` + `ScheduleLesson`,
 * `@@unique([classId, day])`): unda sana yo'q, faqat hafta kuni bor. Mavzu
 * esa sanaga bog'liq ("16-oktabr, 3-darsda 50-mavzu"). Ikkisini bog'laydigan
 * yagona narsa — ANKOR (`LessonTopicBinding`) va undan keyingi darslarni
 * SANAB chiqish:
 *
 *     dars mavzusi = ankor mavzusi + ankordan keyin o'sha fandan o'tadigan
 *                    darslar soni
 *
 * ⚠️ SANOQ KALENDAR BO'YICHA (biznes qarori, 2026-10-15). Jadvalda turgan
 * har bir dars mavzuni bittaga suradi — dars haqiqatan o'tilgan-o'tilmagani
 * (baho bor-yo'qligi, `resolveLesson`) tekshirilmaydi. Sabab: KELAJAKDAGI
 * darsning fakti yo'q va faktga bog'lansa jadval kelasi haftaga mavzu
 * ko'rsata olmasdi; bugungi kun esa umuman tekshirilmaydi
 * (`judgedThroughDay`). Tuzatish yo'li bor va u aniq: boshliq o'sha darsga
 * kerakli mavzuni biriktiradi, qolgani o'z-o'zidan suriladi.
 *
 * ⚠️ DARS BO'LMAYDIGAN KUN SANALMAYDI: yakshanba (`ScheduleDay` enumida
 * umuman yo'q), bayram (`Holiday`) va ta'til oyi (`VacationMonth`). Ular
 * `isTeachingDay` orqali tashqaridan beriladi — bu fayl bazaga bormaydi va
 * shu sababli test qilinadigan bo'lib qoladi.
 *
 * ⚠️ `topicOrder` — `Topic.order`, `Topic.id` EMAS. Mavzular fayldan qayta
 * yuklanganda hammasi o'chirilib qaytadan yoziladi (`topic.service.js`), ya'ni
 * id barqaror emas; tartib raqami esa butun domenning o'lchovi.
 */

const { dayKey } = require("./lessonHours");

/**
 * Ankordan maqsad kunigacha bo'lgan eng katta masofa.
 *
 * Sanoq kun-kun yuradi, ya'ni narx — ankor qancha eski bo'lsa shuncha
 * iteratsiya. To'rt yillik ankor ham 1500 ta bo'sh tsikl, lekin chegara
 * ataylab bor: buzuq sana (masalan 1970) butun so'rovni muzlatib
 * qo'ymasligi kerak.
 */
const MAX_SPAN_DAYS = 1500;

/** Bitta darsning kaliti: kun + tartib. */
const lessonKey = (day, lessonOrder) => `${day}|${lessonOrder}`;

/**
 * FAOL ANKORNING yagona kaliti (`LessonTopicBinding.activeKey`).
 *
 * Katak kaliti `scheduleLessonId` EMAS: `saveClassSchedule` sinf jadvalini
 * saqlaganda `ScheduleLesson` qatorlarini o'chirib qayta yaratadi, ya'ni
 * id barqaror emas (`education.md` §8 bilan AYNI qoida).
 */
const bindingActiveKey = (classId, subjectId, day, lessonOrder) =>
  `${classId}|${subjectId}|${day}|${lessonOrder}`;

/** "YYYY-MM-DD" → UTC yarim tundagi `Date` (`@db.Date` uslubi). */
function parseDayKey(day) {
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Ikki kun kaliti orasidagi kunlar soni (`to − from`). */
function daysBetween(from, to) {
  const a = parseDayKey(from);
  const b = parseDayKey(to);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/**
 * Mavzu raqami topilmaganda — NEGA topilmagani.
 *
 * Sabab ekranda ko'rsatiladi: har biri boshqa harakat talab qiladi —
 * mavzu yuklash, ankor biriktirish yoki ro'yxatni uzaytirish.
 */
const TOPIC_MISS_REASONS = {
  noTopics: "Bu fanga mavzular yuklanmagan",
  noAnchor: "Mavzu biriktirilmagan",
  beforeAnchor: "Mavzu biriktirilgan kundan oldin",
  exhausted: "Mavzular tugagan",
  outOfRange: "Mavzu biriktirilgan kun juda uzoqda",
};

/**
 * ANKORDAN KEYINGI DARSLARNING MAVZU RAQAMLARI.
 *
 * Bitta o'tishda hisoblaydi: ankor kunidan maqsad kunlarining ENG
 * OXIRGISIGACHA yuradi va yo'lda uchragan har bir darsni bittadan sanaydi.
 * Shu sababli "oldin hafta boshigacha sanab, keyin hafta ichida sanash"
 * kabi ikkinchi hisob kerak emas — ikkita sanoq bo'lsa, ularning biri
 * bayramni hisobga olmay qolishi aniq edi.
 *
 * @param {object} input
 * @param {{day: string, lessonOrder: number, topicOrder: number}} input.anchor
 * @param {Map<number, number[]>} input.ordersByDayNumber - hafta kuni
 *   (`0 = yakshanba`, `Date#getUTCDay()`) → o'sha fan darslarining tartiblari,
 *   O'SISH bo'yicha saralangan
 * @param {string[]} input.targetDays - mavzusi kerak bo'lgan kunlar ("YYYY-MM-DD")
 * @param {(day: string) => boolean} input.isTeachingDay
 * @param {number|null} [input.lastTopicOrder] - fanning oxirgi mavzu raqami
 * @returns {Map<string, {topicOrder: number|null, reason: string|null}>}
 *   kalit — `lessonKey(day, lessonOrder)`
 */
function topicOrdersForDays({
  anchor,
  ordersByDayNumber,
  targetDays,
  isTeachingDay,
  lastTopicOrder = null,
}) {
  const result = new Map();
  if (!anchor || !Array.isArray(targetDays) || targetDays.length === 0) return result;

  const targets = [...targetDays].sort();
  const lastTarget = targets[targets.length - 1];
  const targetSet = new Set(targets);

  // Ankordan oldingi kunlar — "oldingi ankor davri". Ularni orqaga sanab
  // to'ldirish MUMKIN EMAS: ankor "shu kundan boshlab shunday" degan qaror,
  // undan oldingi kunlar o'z ankoriga tegishli (yoki umuman yo'q).
  for (const day of targets) {
    if (day < anchor.day) {
      for (const order of ordersByDayNumber.get(parseDayKey(day)?.getUTCDay()) ?? []) {
        result.set(lessonKey(day, order), {
          topicOrder: null,
          reason: TOPIC_MISS_REASONS.beforeAnchor,
        });
      }
    }
  }

  if (lastTarget < anchor.day) return result;

  const span = daysBetween(anchor.day, lastTarget);
  if (span == null || span > MAX_SPAN_DAYS) {
    for (const day of targets) {
      for (const order of ordersByDayNumber.get(parseDayKey(day)?.getUTCDay()) ?? []) {
        result.set(lessonKey(day, order), {
          topicOrder: null,
          reason: TOPIC_MISS_REASONS.outOfRange,
        });
      }
    }
    return result;
  }

  const cursor = parseDayKey(anchor.day);
  const end = parseDayKey(lastTarget);
  let current = anchor.topicOrder;

  while (cursor.getTime() <= end.getTime()) {
    const day = dayKey(cursor);

    if (isTeachingDay(day)) {
      const orders = ordersByDayNumber.get(cursor.getUTCDay()) ?? [];

      for (const order of orders) {
        // Ankor kunidagi undan OLDINGI darslar ankorga tegishli emas
        if (day === anchor.day && order < anchor.lessonOrder) continue;

        if (targetSet.has(day)) {
          const exhausted = lastTopicOrder != null && current > lastTopicOrder;
          result.set(lessonKey(day, order), {
            topicOrder: exhausted ? null : current,
            reason: exhausted ? TOPIC_MISS_REASONS.exhausted : null,
          });
        }

        current += 1;
      }
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return result;
}

module.exports = {
  MAX_SPAN_DAYS,
  TOPIC_MISS_REASONS,
  bindingActiveKey,
  lessonKey,
  parseDayKey,
  daysBetween,
  topicOrdersForDays,
};
