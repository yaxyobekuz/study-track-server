/**
 * O'QITUVCHINING DARS YUKLAMASI — profil sahifasi uchun yig'ma ko'rinish.
 *
 * Manba — AMALDAGI dars jadvali (`ScheduleLesson`), rejalashtirish qatlami
 * (`PlannerLoad`) EMAS: profilda "nima rejalashtirilgan" emas, "hozir nima
 * o'tilyapti" degan savolga javob berilishi kerak.
 *
 * ⚠️ SOAT = DARS. Domenda "haftalik soat" har doim dars sonini bildiradi
 * (`PlannerLoad.weeklyHours` bilan bir xil o'lchov), astronomik soat emas.
 * Ikkinchi o'lchov kiritilsa reja va amaldagi jadval raqamlari bir-biriga
 * taqqoslanmay qolardi.
 *
 * ⚠️ Kun yorliqlari ("Dushanba") bu yerdan CHIQMAYDI — panelda `days.data.js`
 * bor. Nusxa massiv yaratish aynan sana/oy nomlarida bo'lgan xatoning o'zi.
 */

const prisma = require("../config/prisma");
const { NotFoundError } = require("../utils/errors");
const { ROLES, DAYS } = require("../utils/constants");
const { getScheduleSettings } = require("./settings.service");
const { resolveSalaryForMonth } = require("./staffSalary.service");
const {
  currentMonthKey,
  formatMonthKey,
  formatMonthRange,
} = require("../helpers/month.helpers");
const { toDecimal, formatAmount } = require("../helpers/money.helpers");

// Enum tartibi (dushanba → shanba). `DAYS` — yagona manba.
const WEEK_DAYS = Object.values(DAYS);

const TEACHER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  fullName: true,
  role: true,
};

/**
 * Xodim mavjudligini tekshiradi.
 *
 * O'quvchi rad etiladi: dars jadvalida o'qituvchi bo'lib turolmaydi
 * (`validateScheduleSubjects` ham `role: "teacher"` ni talab qiladi).
 */
async function assertTeacher(teacherId) {
  const teacher = await prisma.user.findUnique({
    where: { id: teacherId },
    select: TEACHER_SELECT,
  });

  if (!teacher || teacher.role === ROLES.STUDENT) {
    throw new NotFoundError("O'qituvchi topilmadi");
  }

  return teacher;
}

/**
 * Dars vaqti: darsning O'ZIDA yozilgani ustun, bo'lmasa jadval sozlamasidagi
 * o'sha tartibning standart vaqti (`ScheduleSettings.periods`).
 */
function resolveTime(lesson, periodMap) {
  const period = periodMap.get(lesson.order);

  return {
    startTime: lesson.startTime || period?.startTime || null,
    endTime: lesson.endTime || period?.endTime || null,
  };
}

/**
 * Oylikni haftalik yuklamaga bo'ladi: "bitta haftalik dars soati oyiga
 * qanchaga tushadi".
 *
 * ATAYLAB shu ko'rinishda: "bitta darsning narxi" uchun oyda necha hafta
 * borligini taxmin qilish kerak bo'lardi, bunday raqam esa domenda yo'q.
 */
function perWeeklyHour(amount, weeklyHours) {
  if (!weeklyHours) return null;
  return formatAmount(toDecimal(amount).div(weeklyHours));
}

/**
 * O'qituvchining haftalik yuklamasi, sinflar kesimi va haftalik jadvali.
 *
 * @param {string} teacherId
 * @param {object} [options]
 * @param {boolean} [options.withSalary=false] - oylik ma'lumoti qo'shilsinmi
 *   (`payroll.view` ruxsati bor foydalanuvchi uchun). Ruxsatsiz chaqiruvda
 *   `salary` DOIM `null`: dars jadvalini ko'rish huquqi oylik summasini
 *   ochib bermasligi kerak.
 * @returns {Promise<object>}
 */
async function getTeacherWorkload(teacherId, { withSalary = false } = {}) {
  const teacher = await assertTeacher(teacherId);

  const [lessons, settings] = await Promise.all([
    prisma.scheduleLesson.findMany({
      where: { teacherId },
      include: { schedule: { select: { day: true, classId: true } } },
    }),
    getScheduleSettings(),
  ]);

  const periodMap = new Map(
    (settings.periods || []).map((period) => [period.order, period]),
  );

  // Nomlar — soft ref (relation yo'q), shuning uchun bitta so'rovdan xarita
  const classIds = [
    ...new Set(lessons.map((l) => l.schedule?.classId).filter(Boolean)),
  ];
  const subjectIds = [...new Set(lessons.map((l) => l.subjectId).filter(Boolean))];

  const [classes, subjects] = await Promise.all([
    prisma.class.findMany({
      where: { id: { in: classIds } },
      select: { id: true, name: true },
    }),
    prisma.subject.findMany({
      where: { id: { in: subjectIds } },
      select: { id: true, name: true },
    }),
  ]);

  const classMap = new Map(classes.map((c) => [c.id, c]));
  const subjectMap = new Map(subjects.map((s) => [s.id, s]));

  // ── Kunlar ──────────────────────────────────
  // Darssiz kun ham qaytadi: "payshanbada dars yo'q" ham ma'lumot.
  const byDay = new Map(WEEK_DAYS.map((day) => [day, []]));

  for (const lesson of lessons) {
    const day = lesson.schedule?.day;
    if (!byDay.has(day)) continue; // yo'q kun (ma'lumot buzilgan) — tashlanadi

    byDay.get(day).push({
      id: lesson.id,
      order: lesson.order,
      ...resolveTime(lesson, periodMap),
      class: classMap.get(lesson.schedule.classId) ?? null,
      subject: subjectMap.get(lesson.subjectId) ?? null,
    });
  }

  const days = WEEK_DAYS.map((day) => {
    const items = byDay.get(day).sort((a, b) => a.order - b.order);
    return { day, hours: items.length, lessons: items };
  });

  // ── Sinflar kesimi ──────────────────────────
  // "Qaysi sinflarga dars beradi" — har sinfda qaysi fandan va necha soat.
  const byClass = new Map();

  for (const day of days) {
    for (const lesson of day.lessons) {
      if (!lesson.class) continue;

      let row = byClass.get(lesson.class.id);
      if (!row) {
        row = { ...lesson.class, hours: 0, subjects: new Map() };
        byClass.set(lesson.class.id, row);
      }
      row.hours += 1;

      if (lesson.subject) {
        const subject = row.subjects.get(lesson.subject.id) ?? {
          ...lesson.subject,
          hours: 0,
        };
        subject.hours += 1;
        row.subjects.set(lesson.subject.id, subject);
      }
    }
  }

  const classRows = [...byClass.values()]
    .map((row) => ({
      ...row,
      subjects: [...row.subjects.values()].sort((a, b) => b.hours - a.hours),
    }))
    .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));

  // ⚠️ Jami HAR DOIM kunlar yig'indisidan olinadi, `lessons.length` dan emas:
  // kuni tanilmagan yozuv (enum tashqarisi) kunlar kesimiga tushmaydi, ya'ni
  // ikkita manba ishlatilsa "jami 24" deb turib, kunlarda 23 ta chiqardi.
  const weeklyHours = days.reduce((sum, day) => sum + day.hours, 0);
  const busiest = days.reduce(
    (best, day) => (day.hours > (best?.hours ?? 0) ? day : best),
    null,
  );

  // ── Oylik (ruxsat bilan) ────────────────────
  let salary = null;

  if (withSalary) {
    const month = currentMonthKey();
    const rule = await resolveSalaryForMonth(teacherId, month);

    salary = {
      month,
      monthLabel: formatMonthKey(month),
      amount: rule ? formatAmount(rule.amount) : null,
      periodLabel: rule ? formatMonthRange(rule.startMonth, rule.endMonth) : null,
      perWeeklyHour: rule ? perWeeklyHour(rule.amount, weeklyHours) : null,
    };
  }

  return {
    teacher,
    totals: {
      weeklyHours,
      classCount: classRows.length,
      subjectCount: new Set(
        days.flatMap((day) => day.lessons.map((l) => l.subject?.id)).filter(Boolean),
      ).size,
      activeDays: days.filter((day) => day.hours > 0).length,
      busiestDay: busiest && busiest.hours > 0
        ? { day: busiest.day, hours: busiest.hours }
        : null,
    },
    days,
    classes: classRows,
    salary,
  };
}

module.exports = { getTeacherWorkload };
