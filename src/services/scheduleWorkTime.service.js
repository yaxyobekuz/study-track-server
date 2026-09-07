/**
 * DARS JADVALIDAN ISH VAQTI — o'qituvchining davomat oynasi.
 *
 * Qoida bitta jumlada:
 *
 * > Kunning BIRINCHI darsi boshlanishi — ish boshlanishi, OXIRGI darsi
 * > tugashi — ish tugashi. Darsi yo'q kun ish kuni SANALMAYDI.
 *
 * Bu qatlam `User.workTimeSource === "schedule"` bo'lgan xodimlar uchun
 * `attendance.service.js` dagi `getEffectiveSchedule()` ga ulanadi. Qolgan
 * hamma uchun eski yo'l (`User` → `Role` merosi) o'zgarishsiz qoladi.
 *
 * ⚠️ DARS VAQTI IKKI MANBADAN keladi va tartibi `teacherWorkload.service.js`
 * bilan AYNAN bir xil: darsning O'ZIDA yozilgan vaqt ustun, bo'lmasa
 * `ScheduleSettings.periods` dan o'sha `order` ning standart vaqti. Ikkinchi
 * mustaqil hal qiluvchi yozilsa, profil sahifasi va davomat bir xil dars
 * uchun boshqa-boshqa vaqt ko'rsatib qolardi.
 *
 * ⚠️ VAQTI ANIQLANMAGAN dars kunni ISH KUNI qiladi, lekin oynaga KIRMAYDI:
 * dars bor — demak odam ishlaydi, ammo aniq vaqt yo'q ekan, kechikish va erta
 * ketish tekshirilmaydi (jarima yozilmaydi). "Vaqti yo'q" ni "darsi yo'q" ga
 * tenglashtirsak, jadvali to'liq kiritilmagan o'qituvchi davomatdan jimgina
 * chiqib ketardi.
 *
 * ⚠️ Bu `plannerAvailability.service.js` BILAN CHALKASHMASIN. U yerda savol
 * teskari: "o'qituvchi qaysi slotga dars QO'YISH mumkin". Ish vaqtini dars
 * jadvalidan olib, keyin o'sha ish vaqtiga qarab dars qo'ysak — aylanma
 * bog'liqlik bo'lardi. Shu sababli planner bu servisga MUROJAAT QILMAYDI va
 * `workTimeSource` ni ham o'qimaydi.
 *
 * ⚠️ YAKSHANBA — `ScheduleDay` enumida yo'q, ya'ni hech qachon ish kuni
 * bo'lmaydi. Bu jadvalning o'zidan kelib chiqadi, alohida shart emas.
 */

const prisma = require("../config/prisma");
const { getScheduleSettings } = require("./settings.service");
const { timeToMinutes } = require("../helpers/date.helpers");
const { DAYS_UZ } = require("../utils/constants");

// `ScheduleDay` enum qiymati → JS `getDay()` raqami (0 = yakshanba).
// `DAYS_UZ` aynan shu tartibda yozilgan — yagona manba, nusxa massiv yo'q.
const DAY_TO_NUMBER = new Map(DAYS_UZ.map((day, index) => [day, index]));

/**
 * Dars vaqti: darsning o'zidagi qiymat ustun, bo'lmasa jadval sozlamasidagi
 * o'sha tartibning standart vaqti.
 *
 * ⚠️ `teacherWorkload.service.js` dagi `resolveTime()` bilan bir xil qoida.
 *
 * @param {{order: number, startTime: string|null, endTime: string|null}} lesson
 * @param {Map<number, {startTime: string, endTime: string}>} periodMap
 * @returns {{startTime: string|null, endTime: string|null}}
 */
function resolveLessonTime(lesson, periodMap) {
  const period = periodMap.get(lesson.order);

  return {
    startTime: lesson.startTime || period?.startTime || null,
    endTime: lesson.endTime || period?.endTime || null,
  };
}

/**
 * HH:mm larni daqiqa bo'yicha taqqoslab eng erkinini/kechkisini tanlaydi.
 *
 * ⚠️ Matn taqqoslash EMAS: "9:00" kabi nol bilan to'ldirilmagan qiymat
 * bazada qolib ketgan bo'lsa, `"9:00" < "10:00"` YOLG'ON bo'lardi va
 * o'qituvchining ish kuni tushdan keyin boshlangandek ko'rinardi.
 */
function earlier(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;
  return timeToMinutes(candidate) < timeToMinutes(current) ? candidate : current;
}

function later(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;
  return timeToMinutes(candidate) > timeToMinutes(current) ? candidate : current;
}

/**
 * Bir nechta o'qituvchining haftalik ish oynasini BITTA so'rovda hisoblaydi.
 *
 * Batch shakli ataylab: `attendanceAbsent.job.js` har kecha barcha xodimlar
 * bo'ylab aylanadi va yakka chaqiruv u yerda N+1 so'rovga aylanardi.
 *
 * @param {string[]} teacherIds
 * @returns {Promise<Map<string, {
 *   byDay: Map<number, {startTime: string|null, endTime: string|null, lessonCount: number}>,
 *   workDays: number[],
 *   hasLessons: boolean
 * }>>} Har bir so'ralgan id uchun qator BO'LADI — darsi yo'q o'qituvchi
 *   `hasLessons: false` va bo'sh `workDays` bilan qaytadi (chaqiruvchi
 *   "topilmadi" va "darsi yo'q" ni farqlamasligi uchun).
 */
async function getScheduleWorkTimes(teacherIds) {
  const ids = [...new Set((teacherIds || []).filter(Boolean).map(String))];

  const result = new Map(
    ids.map((id) => [id, { byDay: new Map(), workDays: [], hasLessons: false }]),
  );

  if (ids.length === 0) return result;

  const [lessons, settings] = await Promise.all([
    prisma.scheduleLesson.findMany({
      where: { teacherId: { in: ids } },
      select: {
        teacherId: true,
        order: true,
        startTime: true,
        endTime: true,
        schedule: { select: { day: true } },
      },
    }),
    getScheduleSettings(),
  ]);

  const periodMap = new Map(
    (settings.periods || []).map((period) => [period.order, period]),
  );

  for (const lesson of lessons) {
    const row = result.get(lesson.teacherId);
    if (!row) continue;

    const dayNumber = DAY_TO_NUMBER.get(lesson.schedule?.day);
    if (dayNumber === undefined) continue; // ma'lumot buzilgan — tashlanadi

    row.hasLessons = true;

    const { startTime, endTime } = resolveLessonTime(lesson, periodMap);

    const existing = row.byDay.get(dayNumber);
    if (!existing) {
      row.byDay.set(dayNumber, { startTime, endTime, lessonCount: 1 });
      continue;
    }

    existing.lessonCount += 1;
    existing.startTime = earlier(existing.startTime, startTime);
    existing.endTime = later(existing.endTime, endTime);
  }

  for (const row of result.values()) {
    row.workDays = [...row.byDay.keys()].sort((a, b) => a - b);
  }

  return result;
}

/**
 * Bitta o'qituvchining haftalik ish oynasi.
 *
 * @param {string} teacherId
 * @returns {Promise<{byDay: Map, workDays: number[], hasLessons: boolean}>}
 */
async function getScheduleWorkTime(teacherId) {
  const map = await getScheduleWorkTimes([teacherId]);
  return map.get(String(teacherId));
}

/**
 * Haftalik oynani BITTA qatorga siqadi — xodimlar ro'yxati uchun.
 *
 * ⚠️ `workStartTime`/`workEndTime` bu yerda HAFTA BO'YICHA eng erta va eng
 * kech vaqt, bitta kunning oynasi EMAS: ro'yxatda odamga bitta qator ajraladi
 * va "seshanba 08:30, payshanba 13:00" ni bitta katakka sig'dirib bo'lmaydi.
 * Kun-kunga ajratilgani `byDay` da to'liq turadi — panel kerak bo'lsa o'shani
 * ochadi.
 *
 * @param {{byDay: Map, workDays: number[], hasLessons: boolean}} row
 * @returns {{workStartTime, workEndTime, workDays, byDay, scheduleMissing}}
 */
function summarizeWeek(row) {
  let startTime = null;
  let endTime = null;
  const byDay = {};

  for (const [dayNumber, window] of row?.byDay ?? []) {
    startTime = earlier(startTime, window.startTime);
    endTime = later(endTime, window.endTime);
    byDay[dayNumber] = {
      startTime: window.startTime,
      endTime: window.endTime,
      lessonCount: window.lessonCount,
    };
  }

  return {
    workStartTime: startTime,
    workEndTime: endTime,
    workDays: row?.workDays ?? [],
    byDay,
    scheduleMissing: !row?.hasLessons,
  };
}

module.exports = {
  getScheduleWorkTimes,
  getScheduleWorkTime,
  summarizeWeek,
  // Testlar va qo'shni servislar uchun
  resolveLessonTime,
  DAY_TO_NUMBER,
};
