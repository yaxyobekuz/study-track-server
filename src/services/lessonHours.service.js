/**
 * DARS SOATLARI — schedule'dan o'qib, oylik jami soatni hisoblaydi.
 *
 * KPI oyligining manbai: o'qituvchining `ScheduleLesson` yozuvlari. Sof
 * matematika `helpers/lessonHours.helpers.js` da; bu yerda faqat DB o'qish.
 */

const prisma = require("../config/prisma");
const {
  SCHEDULE_DAY_TO_WEEKDAY,
  DEFAULT_LESSON_HOURS,
  lessonDurationHours,
  countWeekdayBetween,
} = require("../helpers/lessonHours.helpers");

const round2 = (n) => Math.round(n * 100) / 100;

const monthBounds = (month) => {
  const year = Math.floor(month / 100);
  const monthIndex = (month % 100) - 1;
  return {
    start: new Date(Date.UTC(year, monthIndex, 1)),
    end: new Date(Date.UTC(year, monthIndex + 1, 0)), // oyning oxirgi kuni
  };
};

const maxDate = (a, b) => (a > b ? a : b);
const minDate = (a, b) => (a < b ? a : b);

/**
 * Bir oyda berilgan xodimlarning jami dars soati.
 *
 * ⚠️ VERSIYALASH: har KUN uchun o'sha sanada AMALDA bo'lgan jadval versiyasi
 * ishlatiladi (kesishuv taqiqlangani uchun ikkilanish yo'q). Payroll
 * generatsiyasi natijani `PayrollEntry` ga MUHRLAYDI — keyingi jadval
 * o'zgarishi o'tgan majburiyatga ta'sir qilmaydi.
 *
 * @param {number} month - YYYYMM
 * @param {string[]} teacherIds
 * @returns {Promise<Map<string, {hours:number, weeklyHours:number, weeklyLessons:number, monthlyLessons:number}>>}
 */
const computeLessonHoursForMonth = async (month, teacherIds) => {
  const result = new Map();
  if (!teacherIds || teacherIds.length === 0) return result;

  const { start, end } = monthBounds(month);

  // Oy bilan kesishuvchi jadval versiyalari (o'qituvchi darslari bilan)
  const versions = await prisma.schedule.findMany({
    where: {
      effectiveFrom: { lte: end },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }],
      lessons: { some: { teacherId: { in: teacherIds } } },
    },
    select: {
      day: true,
      effectiveFrom: true,
      effectiveTo: true,
      lessons: {
        where: { teacherId: { in: teacherIds } },
        select: { teacherId: true, startTime: true, endTime: true },
      },
    },
  });

  for (const version of versions) {
    const weekday = SCHEDULE_DAY_TO_WEEKDAY[version.day];
    if (weekday == null) continue;

    // Versiyaning oy ichidagi amal qilgan qismi
    const from = maxDate(start, version.effectiveFrom);
    const to = version.effectiveTo ? minDate(end, version.effectiveTo) : end;
    const activeDays = countWeekdayBetween(weekday, from, to);
    if (activeDays === 0) continue;

    for (const lesson of version.lessons) {
      const duration = lessonDurationHours(
        lesson.startTime,
        lesson.endTime,
        DEFAULT_LESSON_HOURS,
      );

      const cur =
        result.get(lesson.teacherId) ??
        { hours: 0, weeklyHours: 0, weeklyLessons: 0, monthlyLessons: 0 };

      cur.weeklyHours += duration;
      cur.weeklyLessons += 1;
      cur.hours += duration * activeDays;
      cur.monthlyLessons += activeDays;

      result.set(lesson.teacherId, cur);
    }
  }

  for (const value of result.values()) {
    value.hours = round2(value.hours);
    value.weeklyHours = round2(value.weeklyHours);
  }

  return result;
};

/**
 * Bitta xodimning bir oydagi dars soati (nol bo'lsa ham obyekt qaytadi).
 * @param {string} staffId
 * @param {number} month - YYYYMM
 */
const computeLessonHoursForStaff = async (staffId, month) => {
  const map = await computeLessonHoursForMonth(month, [staffId]);
  return (
    map.get(staffId) ?? {
      hours: 0,
      weeklyHours: 0,
      weeklyLessons: 0,
      monthlyLessons: 0,
    }
  );
};

module.exports = {
  computeLessonHoursForMonth,
  computeLessonHoursForStaff,
};
