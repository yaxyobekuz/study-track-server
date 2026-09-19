/**
 * AI YORDAMCHI — DARS JADVALI bo'limi o'qish vositalari: bugungi darslar,
 * sinf va o'qituvchi jadvali, oylik dars soati, jadval yaxlitligi,
 * o'rinbosarliklar, dam olish kunlari, Google Sheets holati, rejalashtiruvchi.
 *
 * ⚠️ ATAMA: "o'rinbosar" / "dars o'rniga chiqish". "Almashtirish" so'zi
 * tizimda FILIAL almashtirishni bildiradi (`education.md` §8) — model
 * yorliqlardan o'rganadi, shuning uchun bu fayldagi hech bir matnda u yo'q.
 *
 * ⚠️ KUN FAQAT UTC-XAVFSIZ YO'L BILAN. `schedule.service.getAllTodaySchedules`
 * va `holiday.isHoliday` host-lokal `getDay()/setHours` ga tayanadi (UTC
 * hostda yakshanba tongida `day:"yakshanba"` → Prisma enum xatosi, 500).
 * Bu yerda hafta kuni `teacherAccess.scheduleDayOf`, bayram va ta'til esa
 * `lessonHours.getMonthCalendar` dan olinadi — oylik soat hisobi aynan shu
 * manbalardan foydalanadi, ya'ni model ko'rgan "bugun dars yo'q" va oylikka
 * tushgan soat bir-biriga zid bo'lolmaydi.
 *
 * ⚠️ `lessonHoursDashboard.service` BUZUQ (finance-outcome xaritasi D7) —
 * chaqirilmaydi. Soat faqat `lessonHours.getTeachersHours` dan.
 *
 * ⚠️ AMALDAGI JADVALGA YOZUV YO'Q. Bu fayl faqat o'qiydi; jadval tahriri va
 * Sheets qo'llash/manba almashtirish/tiklash AI orqali ochilmaydi
 * (odam hash va tasdiqlarni o'zi ko'rishi shart — `education.md` §10).
 */

const prisma = require("../../../config/prisma");
const {
  defineTool,
  AiToolError,
  idSchema,
  monthSchema,
  daySchema,
  limitSchema,
  requireId,
  monthArg,
  dayArg,
  reqLike,
  monthLabel,
  sliceList,
  personName,
} = require("../assistant.toolkit");
const { formatDateUz, formatDateTimeUz, formatDateRangeUz } = require("../../../helpers/date.helpers");
const {
  parseDayDate,
  currentDayDate,
  monthKeyOfDate,
  monthStartDate,
  monthEndDate,
  shiftIsoDays,
} = require("../../../helpers/month.helpers");
const { ROLES, DAYS, MONTHS_UZ } = require("../../../utils/constants");
const { scheduleDayOf, getSubstitutionCells, effectiveTeacherOf } = require("../../../helpers/teacherAccess");
const { conflictsInState } = require("../../../helpers/scheduleState.helpers");

const scheduleService = require("../../schedule.service");
const teacherWorkloadService = require("../../teacherWorkload.service");
const lessonHoursService = require("../../lessonHours.service");
const substitutionService = require("../../lessonSubstitution.service");
const holidayService = require("../../holiday.service");
const scheduleSheetSyncService = require("../../scheduleSheetSync.service");
const plannerGeneratorService = require("../../plannerGenerator.service");
const plannerLoadService = require("../../plannerLoad.service");
const plannerRunService = require("../../plannerRun.service");
const plannerSettingsService = require("../../plannerSettings.service");
const { loadActiveRows } = require("../../scheduleSyncReview.service");
const { resolveLessonTime } = require("../../scheduleWorkTime.service");
const { getScheduleSettings } = require("../../settings.service");

const TOOLSET = "schedule";

/** `ScheduleDay` enum qiymatlari (dushanba → shanba) — yagona manba `DAYS`. */
const SCHEDULE_DAYS = Object.values(DAYS);

/** Hafta kuni yorlig'i — `schedule.service.dayLabel` (nusxa emas). */
const dayLabel = (day) => scheduleService.dayLabel(day);

const SUBSTITUTION_STATUSES = Object.keys(substitutionService.STATUS_LABELS);
const SUBSTITUTION_REASONS = Object.keys(substitutionService.REASON_LABELS);

const REVISION_STATUS_LABELS = {
  pending: "Ko'rib chiqish kutilmoqda",
  applied: "Qo'llangan",
  rejected: "Rad etilgan",
  superseded: "Eskirgan (yangisi bor)",
};

const MODE_LABELS = {
  platform: "Platforma (admin panelda tahrirlanadi)",
  sheet: "Google Sheets (tahrir sheet'da, ko'rib chiqib qo'llanadi)",
};

const HOLIDAY_TYPE_LABELS = {
  single: "Bir kunlik",
  range: "Sana oralig'i",
  recurring: "Har yili takrorlanadi",
};

/**
 * O'rinbosarliklar ro'yxati sahifasi: bitta qator ~750 belgi (ikki ism, izoh,
 * 3 dars) — 20 qator natijani modelga sig'adigan hajmda ushlaydi.
 */
const LIST_PAGE_MAX = 20;
const LIST_ROW_LESSONS = 3;

/** Bayramlar oynasining eng uzun oralig'i — ro'yxat va sana to'plami chegarali bo'lishi uchun. */
const MAX_HOLIDAY_RANGE_DAYS = 400;

const USER_NAME_SELECT = { id: true, firstName: true, lastName: true, role: true, isArchived: true };

// ─────────────────────────────────────────────────────────────────────────
// Yordamchilar
// ─────────────────────────────────────────────────────────────────────────

/** "08:30–09:15" yoki vaqt noma'lum bo'lsa `null`. */
const timeLabel = (startTime, endTime) => (startTime && endTime ? `${startTime}–${endTime}` : null);

/** Dars tartibi → standart vaqt (`ScheduleSettings.periods`). */
const loadPeriodMap = async () => {
  const settings = await getScheduleSettings();
  return new Map((settings.periods || []).map((period) => [period.order, period]));
};

/** Soft ref foydalanuvchilar — bitta so'rovdan xarita. */
const loadUserMap = async (ids) => {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: USER_NAME_SELECT });
  return new Map(users.map((user) => [user.id, user]));
};

/** Soft ref nomlar (sinf / fan) — bitta so'rovdan xarita. */
const loadNameMap = async (model, ids) => {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await prisma[model].findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(rows.map((row) => [row.id, row.name]));
};

const clip = (text, max = 300) => {
  if (!text) return null;
  const value = String(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

/** Model tomonidan berilgan servis xatosini (400/404) vosita xatosiga aylantiradi. */
const asToolError = async (work) => {
  try {
    return await work();
  } catch (err) {
    if (err instanceof AiToolError) throw err;
    if (Number.isInteger(err?.statusCode) && err.statusCode < 500) throw new AiToolError(err.message);
    throw err;
  }
};

/** "YYYY-MM-DD" → UTC yarim tun (xato matni o'zbekcha). */
const dayDateArg = (value, label) => asToolError(async () => parseDayDate(value, label));

/**
 * O'rinbosarlik darsi — bitta qator matn: "Dushanba, 2-dars (08:30–09:15) · 5-A · Matematika".
 * Serializer bergan `snapshot` nomlari ishlatiladi: sinf keyin o'chirilsa ham o'qiladi.
 */
const substitutionItemLabel = (item) => {
  const time = timeLabel(item.startTime, item.endTime);
  return [
    `${item.dayLabel}, ${item.lessonOrder}-dars${time ? ` (${time})` : ""}`,
    item.className || "sinf noma'lum",
    item.subjectName || "fan noma'lum",
  ].join(" · ");
};

/** `lessonSubstitution.serialize` natijasining ixcham shakli. */
const compactSubstitution = (row, { maxLessons = 12, noteMax = 200 } = {}) => {
  const lessons = row.items.map(substitutionItemLabel);
  return {
    id: row.id,
    originalTeacherId: row.originalTeacherId,
    originalTeacherName: row.originalTeacherName,
    substituteTeacherId: row.substituteTeacherId,
    substituteTeacherName: row.substituteTeacherName,
    periodLabel: row.periodLabel,
    reasonLabel: row.reasonLabel,
    note: clip(row.note, noteMax) || undefined,
    statusLabel: row.statusLabel,
    phase: row.phase.key,
    phaseLabel: row.phase.label,
    canDelete: row.canEdit,
    cancelReason: row.status === "cancelled" ? clip(row.cancelReason, 200) : undefined,
    cancelledAtLabel: row.cancelledAt ? formatDateTimeUz(row.cancelledAt) : undefined,
    lessonCount: row.lessonCount,
    occurrenceCount: row.occurrenceCount ?? undefined,
    lessons: lessons.slice(0, maxLessons),
    lessonsTruncated: lessons.length > maxLessons ? true : undefined,
  };
};

/** Bayram qoidasining o'qiladigan ko'rinishi. Takrorlanuvchida oy 0 DAN boshlanadi. */
const recurringLabel = (point) =>
  point && Number.isInteger(point.month) && MONTHS_UZ[point.month] ? `${point.day}-${MONTHS_UZ[point.month]}` : null;

const holidayRuleLabel = (holiday) => {
  if (holiday.type === "single") return formatDateUz(holiday.date, { utc: true });
  if (holiday.type === "range") return formatDateRangeUz(holiday.startDate, holiday.endDate, { utc: true });
  const single = recurringLabel(holiday.recurringDate);
  if (single) return `Har yili ${single}`;
  const start = recurringLabel(holiday.recurringStartDate);
  const end = recurringLabel(holiday.recurringEndDate);
  return start && end ? `Har yili ${start} — ${end}` : "—";
};

/**
 * Hech qaysi kunga to'g'ri kelmaydigan bayram (service yaratishda sana
 * tartibini ham, oy/kun oralig'ini ham tekshirmaydi). Bunday yozuv panelda
 * "bor" ko'rinadi, lekin soat hisobi va davomat uni sezmaydi.
 */
const holidayProblem = (holiday) => {
  const validPoint = (point) =>
    point && Number.isInteger(point.month) && point.month >= 0 && point.month <= 11 &&
    Number.isInteger(point.day) && point.day >= 1 && point.day <= 31;

  if (holiday.type === "single") return holiday.date ? null : "Sana kiritilmagan";
  if (holiday.type === "range") {
    if (!holiday.startDate || !holiday.endDate) return "Oraliq sanalari to'liq emas";
    return new Date(holiday.startDate) > new Date(holiday.endDate)
      ? "Boshlanish sanasi tugash sanasidan keyin — hech bir kunga to'g'ri kelmaydi"
      : null;
  }
  if (validPoint(holiday.recurringDate)) return null;
  if (validPoint(holiday.recurringStartDate) && validPoint(holiday.recurringEndDate)) return null;
  return "Takrorlanuvchi sana noto'g'ri yoki to'liq emas";
};

// ─────────────────────────────────────────────────────────────────────────
// BUGUNGI (YOKI TANLANGAN KUNDAGI) DARSLAR
// ─────────────────────────────────────────────────────────────────────────

const scheduleToday = defineTool({
  name: "schedule_today",
  toolset: TOOLSET,
  label: "Bugungi darslar",
  description:
    "Lessons actually held on a given day (default today, Asia/Tashkent): per class, one line per lesson " +
    "\"<period>. <subject> — <EFFECTIVE teacher>\" after active substitutions (o'rinbosar lines also name the lesson owner); " +
    "default period times are listed once in periods, a lesson shows its own time only when it differs. Detects non-school " +
    "days: Sunday, active holiday, school-wide vacation month — then returns schoolDay=false with the reason instead of " +
    "lessons. Also returns substitutions in effect that day and teachers sorted by lesson count (lists truncated: max 40 " +
    "classes, 30 teachers). Optional classId narrows to one class.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      date: daySchema("Day as YYYY-MM-DD. Omit for today."),
      classId: idSchema("Optional class id to show only that class."),
    },
  },
  async handler(args, ctx) {
    const iso = dayArg(args.date, "Sana");
    const date = await dayDateArg(iso, "Sana");
    const day = scheduleDayOf(date);
    const classId = args.classId ? requireId(args.classId, "Sinf id") : null;

    const base = {
      date: iso,
      dateLabel: formatDateUz(date, { utc: true }),
      dayLabel: day ? dayLabel(day) : "Yakshanba",
      isToday: iso === ctx.today,
    };

    if (classId) {
      const exists = await prisma.class.findUnique({ where: { id: classId }, select: { id: true } });
      if (!exists) throw new AiToolError("Sinf topilmadi");
    }

    if (!day) return { ...base, schoolDay: false, reason: "Yakshanba — dars o'tilmaydi" };

    const [calendar, rows, periodMap, cells] = await Promise.all([
      lessonHoursService.getMonthCalendar(monthKeyOfDate(date)),
      prisma.schedule.findMany({
        where: { day, ...(classId ? { classId } : {}) },
        include: { lessons: true },
      }),
      loadPeriodMap(),
      getSubstitutionCells(date, classId ? { classId } : {}),
    ]);

    const templateLessonCount = rows.reduce((sum, row) => sum + row.lessons.length, 0);

    if (calendar.isVacationMonth) {
      return { ...base, schoolDay: false, reason: `${monthLabel(monthKeyOfDate(date))} — ta'til oyi`, templateLessonCount };
    }
    if (calendar.holidaySet.has(iso)) {
      return {
        ...base,
        schoolDay: false,
        reason: "Dam olish (bayram) kuni — tafsilot uchun holidays_list",
        templateLessonCount,
      };
    }
    if (templateLessonCount === 0) {
      return { ...base, schoolDay: true, empty: true, reason: `${base.dayLabel} kuni uchun dars jadvali kiritilmagan` };
    }

    const lessons = rows.flatMap((row) => row.lessons.map((lesson) => ({ ...lesson, classId: row.classId })));
    const [classMap, subjectMap, userMap] = await Promise.all([
      loadNameMap("class", rows.map((row) => row.classId)),
      loadNameMap("subject", lessons.map((lesson) => lesson.subjectId)),
      loadUserMap([
        ...lessons.map((lesson) => lesson.teacherId),
        ...[...cells.values()].map((cell) => cell.substituteTeacherId),
      ]),
    ]);

    const teacherCounts = new Map();
    const byClass = new Map();
    const substitutions = [];
    let withoutTime = 0;

    // ⚠️ IXCHAM SHAKL: katta filialda (40 sinf × 7 dars) har dars obyekt
    // bo'lsa natija modelga sig'masdi va sanitizer ro'yxatni jimgina
    // kesardi. Standart vaqt `periods` da bir marta, darsda esa faqat
    // standartdan farq qilsa ko'rsatiladi.
    for (const lesson of lessons) {
      const effective = effectiveTeacherOf(
        { classId: lesson.classId, day, order: lesson.order, teacherId: lesson.teacherId },
        cells,
      );
      const { startTime, endTime } = resolveLessonTime(lesson, periodMap);
      const time = timeLabel(startTime, endTime);
      if (!time) withoutTime += 1;
      const period = periodMap.get(lesson.order);
      const ownTime = time && time !== timeLabel(period?.startTime, period?.endTime) ? ` (${time})` : "";

      const subject = subjectMap.get(lesson.subjectId) || "Noma'lum fan";
      const teacher = personName(userMap.get(effective.teacherId));
      const className = classMap.get(lesson.classId) || "Noma'lum sinf";
      let text = `${lesson.order}${ownTime}. ${subject} — ${teacher}`;
      if (effective.substituted) {
        const originalTeacher = personName(userMap.get(lesson.teacherId));
        text += ` (o'rinbosar; dars egasi ${originalTeacher})`;
        substitutions.push({
          substitutionId: effective.substitutionId,
          className,
          order: lesson.order,
          originalTeacher,
          substituteTeacher: teacher,
        });
      }

      const counter = teacherCounts.get(effective.teacherId) || { id: effective.teacherId, name: teacher, lessons: 0 };
      counter.lessons += 1;
      teacherCounts.set(effective.teacherId, counter);

      if (!byClass.has(lesson.classId)) {
        byClass.set(lesson.classId, { classId: lesson.classId, className, lessons: [] });
      }
      byClass.get(lesson.classId).lessons.push({ order: lesson.order, text });
    }

    const classes = [...byClass.values()]
      .map((row) => ({
        classId: row.classId,
        className: row.className,
        lessons: row.lessons.sort((a, b) => a.order - b.order).map((entry) => entry.text),
      }))
      .sort((a, b) => a.className.localeCompare(b.className, "uz", { numeric: true }));

    const teachers = [...teacherCounts.values()].sort((a, b) => b.lessons - a.lessons || a.name.localeCompare(b.name));
    substitutions.sort((a, b) => a.className.localeCompare(b.className, "uz", { numeric: true }) || a.order - b.order);

    return {
      ...base,
      schoolDay: true,
      totals: {
        classCount: classes.length,
        lessonCount: lessons.length,
        substitutedLessons: substitutions.length,
        teacherCount: teachers.length,
        lessonsWithoutTime: withoutTime,
      },
      periods: [...periodMap.values()]
        .sort((a, b) => a.order - b.order)
        .map((period) => `${period.order}: ${timeLabel(period.startTime, period.endTime) || "vaqt kiritilmagan"}`),
      classes: sliceList(classes, 40),
      substitutions: sliceList(substitutions, 40),
      teachersByLessons: sliceList(teachers, 30),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// SINF JADVALI
// ─────────────────────────────────────────────────────────────────────────

const scheduleClass = defineTool({
  name: "schedule_class",
  toolset: TOOLSET,
  label: "Sinf dars jadvali",
  description:
    "Weekly timetable template of ONE class (Monday–Saturday): lessons per day in period order with time (lesson time, " +
    "else default period time), subject and teacher; teachers of the class with weekly lesson counts; and active " +
    "substitutions (o'rinbosar) of this class that are ongoing or upcoming. Flags duplicate day rows (data integrity). " +
    "Get classId from people_classes or search tools.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["classId"],
    properties: {
      classId: idSchema("Class id."),
    },
  },
  async handler(args) {
    const classId = requireId(args.classId, "Sinf id");
    const today = currentDayDate();

    const [schedules, classRow, periodMap, substitutionItems] = await Promise.all([
      asToolError(() => scheduleService.getScheduleByClass(classId)),
      prisma.class.findUnique({ where: { id: classId }, select: { id: true, name: true, isActive: true } }),
      loadPeriodMap(),
      prisma.lessonSubstitutionItem.findMany({
        where: { classId, substitution: { status: "active", toDate: { gte: today } } },
        include: {
          substitution: {
            select: { id: true, fromDate: true, toDate: true, teacherSnapshot: true, reason: true },
          },
        },
      }),
    ]);

    const daysSeen = new Map();
    const teacherCounts = new Map();
    const days = [];

    for (const schedule of schedules) {
      daysSeen.set(schedule.day, (daysSeen.get(schedule.day) || 0) + 1);
      const lessons = schedule.subjects.map((lesson) => {
        const { startTime, endTime } = resolveLessonTime(lesson, periodMap);
        const teacherName = personName(lesson.teacher);
        if (lesson.teacher) {
          const counter = teacherCounts.get(lesson.teacher.id) || { id: lesson.teacher.id, name: teacherName, lessons: 0 };
          counter.lessons += 1;
          teacherCounts.set(lesson.teacher.id, counter);
        }
        return {
          order: lesson.order,
          time: timeLabel(startTime, endTime),
          subject: lesson.subject?.name || "Noma'lum fan",
          teacher: lesson.teacher ? teacherName : "O'qituvchi topilmadi",
        };
      });
      if (lessons.length > 0) days.push({ day: schedule.day, dayLabel: dayLabel(schedule.day), lessons });
    }

    days.sort((a, b) => SCHEDULE_DAYS.indexOf(a.day) - SCHEDULE_DAYS.indexOf(b.day));

    const weeklyLessons = days.reduce((sum, day) => sum + day.lessons.length, 0);
    const base = {
      class: { id: classRow.id, name: classRow.name, isActive: classRow.isActive },
      weeklyLessons,
    };

    if (weeklyLessons === 0) {
      return { ...base, empty: true, reason: "Bu sinf uchun dars jadvali kiritilmagan" };
    }

    const duplicateDays = [...daysSeen.entries()].filter(([, count]) => count > 1).map(([day]) => dayLabel(day));

    const substitutions = substitutionItems
      .map((item) => ({
        substitutionId: item.substitution.id,
        lesson: `${dayLabel(item.day)}, ${item.lessonOrder}-dars · ${item.snapshot?.subjectName || "fan noma'lum"}`,
        originalTeacherName: item.substitution.teacherSnapshot?.original?.name || "Noma'lum",
        substituteTeacherName: item.substitution.teacherSnapshot?.substitute?.name || "Noma'lum",
        periodLabel: formatDateRangeUz(item.substitution.fromDate, item.substitution.toDate, { utc: true }),
        ongoing: item.substitution.fromDate.getTime() <= today.getTime(),
        sortKey: item.substitution.fromDate.getTime(),
      }))
      .sort((a, b) => a.sortKey - b.sortKey)
      .map(({ sortKey, ...rest }) => rest);

    return {
      ...base,
      activeDays: days.length,
      days,
      teachers: [...teacherCounts.values()].sort((a, b) => b.lessons - a.lessons || a.name.localeCompare(b.name)),
      duplicateDayRows: duplicateDays.length ? duplicateDays : undefined,
      activeSubstitutions: sliceList(substitutions, 30),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// O'QITUVCHI YUKLAMASI
// ─────────────────────────────────────────────────────────────────────────

const scheduleTeacher = defineTool({
  name: "schedule_teacher",
  toolset: TOOLSET,
  label: "O'qituvchi haftalik jadvali",
  description:
    "One teacher's weekly load from the active timetable (1 hour = 1 lesson): weekly lessons, classes and subjects, " +
    "busiest day, free days, double-booked slots (same period in 2+ classes), the full weekly timetable (period, " +
    "time, class, subject), and active substitutions (o'rinbosar) the teacher gives away or covers that are ongoing or " +
    "upcoming. No pay figures — use payroll tools for money and schedule_teacher_hours for monthly hours.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["teacherId"],
    properties: {
      teacherId: idSchema("Teacher (staff user) id — resolve with search_people."),
    },
  },
  async handler(args, ctx) {
    const teacherId = requireId(args.teacherId, "O'qituvchi id");

    // ⚠️ `withSalary: false` ATAYLAB: jadval vositasi pul ochmaydi. Oylik
    // faqat payroll vositalaridan (o'z ruxsati bilan) olinadi — jadvalni
    // ko'rish huquqi oylik summasini ochib bermasligi kerak.
    const [workload, substitutions] = await Promise.all([
      asToolError(() => teacherWorkloadService.getTeacherWorkload(teacherId, { withSalary: false })),
      substitutionService.getSubstitutions(
        reqLike(ctx, { teacherId, status: "active", fromDate: ctx.today, limit: 30 }),
      ),
    ]);

    const days = workload.days
      .filter((day) => day.hours > 0)
      .map((day) => ({
        dayLabel: dayLabel(day.day),
        lessons: day.lessons.map((lesson) =>
          [
            `${lesson.order}-dars${lesson.startTime && lesson.endTime ? ` (${timeLabel(lesson.startTime, lesson.endTime)})` : ""}`,
            lesson.class?.name || "sinf noma'lum",
            lesson.subject?.name || "fan noma'lum",
          ].join(" · "),
        ),
      }));

    const rows = substitutions.data.map((row) => compactSubstitution(row, { maxLessons: 6 }));

    // Bir vaqtda ikki sinfda — `conflictsInState` bilan bir xil mulohaza, faqat shu o'qituvchi uchun.
    const doubleBooked = workload.days.flatMap((day) => {
      const byOrder = new Map();
      for (const lesson of day.lessons) {
        byOrder.set(lesson.order, [...(byOrder.get(lesson.order) || []), lesson.class?.name || "sinf noma'lum"]);
      }
      return [...byOrder.entries()]
        .filter(([, classes]) => classes.length > 1)
        .map(([order, classes]) => `${dayLabel(day.day)}, ${order}-dars: ${classes.join(", ")}`);
    });

    return {
      teacher: {
        id: workload.teacher.id,
        name: personName(workload.teacher),
        role: workload.teacher.role,
      },
      totals: {
        weeklyLessons: workload.totals.weeklyHours,
        classCount: workload.totals.classCount,
        subjectCount: workload.totals.subjectCount,
        activeDays: workload.totals.activeDays,
        busiestDay: workload.totals.busiestDay
          ? { dayLabel: dayLabel(workload.totals.busiestDay.day), lessons: workload.totals.busiestDay.hours }
          : null,
      },
      freeDays: workload.days.filter((day) => day.hours === 0).map((day) => dayLabel(day.day)),
      doubleBookedSlots: doubleBooked.length ? doubleBooked : undefined,
      timetable: days,
      classes: workload.classes.map((row) => ({
        id: row.id,
        name: row.name,
        lessons: row.hours,
        subjects: row.subjects.map((subject) => `${subject.name} (${subject.hours})`).join(", "),
      })),
      substitutions: {
        givenAway: rows.filter((row) => row.originalTeacherId === teacherId),
        covering: rows.filter((row) => row.substituteTeacherId === teacherId),
        truncated: substitutions.pagination.total > rows.length,
      },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// OYLIK DARS SOATI
// ─────────────────────────────────────────────────────────────────────────

const scheduleTeacherHours = defineTool({
  name: "schedule_teacher_hours",
  toolset: TOOLSET,
  label: "Oylik dars soatlari",
  description:
    "Monthly lesson hours spread from the weekly timetable over the month's school days (Sundays, holidays and vacation " +
    "months excluded; 1 hour = 1 lesson): scheduledHours, substitutedOutHours (given to an o'rinbosar), " +
    "substitutedInHours (covered for others), hours = final number used by payroll, taughtHours up to today for the " +
    "current month, remainingHours. Without teacherId: all non-archived staff who have timetable lessons, cover as an " +
    "o'rinbosar this month, or have a salary category (paidByHours), sorted by hours, max 60. With teacherId: one teacher with weekday/class/subject breakdown. " +
    "Hours only — for money use payroll_lesson_hours.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      teacherId: idSchema("Optional teacher id for a detailed breakdown."),
      month: monthSchema(),
    },
  },
  async handler(args) {
    const month = monthArg(args.month);
    const cutoff = lessonHoursService.cutoffForMonth(month);

    let users;
    if (args.teacherId) {
      const teacherId = requireId(args.teacherId, "O'qituvchi id");
      const user = await prisma.user.findUnique({
        where: { id: teacherId },
        select: { ...USER_NAME_SELECT, salaryCategoryId: true },
      });
      if (!user || user.role === ROLES.STUDENT) throw new AiToolError("O'qituvchi topilmadi");
      users = [user];
    } else {
      // Darsi yo'q o'rinbosar ham (masalan, qabulxona xodimi) soat oladi — u
      // ro'yxatdan tushib qolsa, egasidan ayirilgan soat "hech kimga" ketgandek ko'rinardi.
      const [lessonOwners, substitutes] = await Promise.all([
        prisma.scheduleLesson.findMany({ distinct: ["teacherId"], select: { teacherId: true } }),
        prisma.lessonSubstitution.findMany({
          where: { status: "active", fromDate: { lte: monthEndDate(month) }, toDate: { gte: monthStartDate(month) } },
          distinct: ["substituteTeacherId"],
          select: { substituteTeacherId: true },
        }),
      ]);
      users = await prisma.user.findMany({
        where: {
          isArchived: false,
          role: { not: ROLES.STUDENT },
          OR: [
            { id: { in: lessonOwners.map((row) => row.teacherId) } },
            { id: { in: substitutes.map((row) => row.substituteTeacherId) } },
            { salaryCategoryId: { not: null } },
          ],
        },
        select: { ...USER_NAME_SELECT, salaryCategoryId: true },
      });
    }

    const calendar = await lessonHoursService.getMonthCalendar(month, { asOfDayOfMonth: cutoff });
    const header = {
      month,
      monthLabel: monthLabel(month),
      isVacationMonth: calendar.isVacationMonth,
      teachingDays: calendar.teachingDays,
      taughtDaysSoFar: calendar.taughtDayCount,
      holidayDays: calendar.holidayCount,
    };

    if (users.length === 0) {
      return { ...header, empty: true, reason: "Dars jadvalida darsi bor yoki toifaga biriktirilgan o'qituvchi topilmadi" };
    }

    const hoursMap = await lessonHoursService.getTeachersHours(
      users.map((user) => user.id),
      month,
      { asOfDayOfMonth: cutoff },
    );

    const rowOf = (user) => {
      const info = hoursMap.get(user.id);
      return {
        id: user.id,
        name: personName(user),
        paidByHours: Boolean(user.salaryCategoryId),
        archived: user.isArchived || undefined,
        weeklyLessons: info?.weeklyHours ?? 0,
        scheduledHours: info?.scheduledHours ?? 0,
        substitutedOutHours: info?.substitutedOutHours ?? 0,
        substitutedInHours: info?.substitutedInHours ?? 0,
        hours: info?.hours ?? 0,
        taughtHours: info?.taughtHours ?? 0,
        remainingHours: info?.remainingHours ?? 0,
      };
    };

    if (args.teacherId) {
      const info = hoursMap.get(users[0].id);
      return {
        ...header,
        teacher: rowOf(users[0]),
        byDay: (info?.byDay ?? []).map((row) => ({ dayLabel: row.dayLabel, hours: row.hours, days: row.occurrences })),
        byClass: sliceList(
          (info?.byClass ?? []).map((row) => ({ name: row.name, hours: row.hours, givenAway: row.substituted, covered: row.covered })),
          20,
        ),
        bySubject: sliceList(
          (info?.bySubject ?? []).map((row) => ({ name: row.name, hours: row.hours, givenAway: row.substituted, covered: row.covered })),
          20,
        ),
      };
    }

    const rows = users.map(rowOf).sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));
    return {
      ...header,
      teacherCount: rows.length,
      totals: {
        scheduledHours: rows.reduce((sum, row) => sum + row.scheduledHours, 0),
        substitutedHours: rows.reduce((sum, row) => sum + row.substitutedInHours, 0),
        hours: rows.reduce((sum, row) => sum + row.hours, 0),
        taughtHours: rows.reduce((sum, row) => sum + row.taughtHours, 0),
      },
      paidByHoursWithoutLessons: rows.filter((row) => row.paidByHours && row.weeklyLessons === 0).length,
      ...sliceList(rows, 60),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// JADVAL YAXLITLIGI
// ─────────────────────────────────────────────────────────────────────────

const scheduleConflicts = defineTool({
  name: "schedule_conflicts",
  toolset: TOOLSET,
  label: "Jadval to'qnashuvlari",
  description:
    "Integrity check of the whole active timetable: teacher double-booked in 2+ classes at the same day and period, " +
    "duplicate class-day rows and missing unique index, stale substitutions (the timetable changed after the o'rinbosar " +
    "record was made, so it silently no longer moves hours or journal access), lessons owned by archived/missing/student " +
    "users, lessons with no time (neither own nor default period), and classes without any timetable. Returns counts " +
    "plus bounded lists.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async handler(args, ctx) {
    const today = currentDayDate();

    const [activeRows, status, periodMap, classes, activeSubstitutions] = await Promise.all([
      loadActiveRows(prisma),
      scheduleSheetSyncService.getStatus(ctx.user),
      loadPeriodMap(),
      prisma.class.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
      prisma.lessonSubstitution.findMany({
        where: { status: "active", toDate: { gte: today } },
        include: { items: true },
      }),
    ]);

    const conflicts = conflictsInState(activeRows);
    const lessons = activeRows.flatMap((row) => row.lessons.map((lesson) => ({ ...lesson, classId: row.classId, day: row.day })));

    // ⚠️ ESKIRGAN O'RINBOSARLIK — `lessonHours.loadSubstitutionWindows` va
    // `teacherAccess.effectiveTeacherOf` dagi AYNI shart: katak hozir ham
    // dars egasiniki bo'lmasa, yozuv soatga ham, jurnal huquqiga ham ta'sir
    // qilmaydi. Ular faqat oy bo'yicha o'qiydi; bu yerda esa hali tugamagan
    // HAMMA yozuv kerak, shuning uchun egalik to'plami shu yerda quriladi.
    const owned = new Set(lessons.map((lesson) => `${lesson.teacherId}|${lesson.classId}|${lesson.day}|${lesson.order}`));
    const staleItems = [];
    for (const row of activeSubstitutions) {
      for (const item of row.items) {
        if (owned.has(`${row.originalTeacherId}|${item.classId}|${item.day}|${item.lessonOrder}`)) continue;
        staleItems.push({
          substitutionId: row.id,
          originalTeacherName: row.teacherSnapshot?.original?.name || "Noma'lum",
          substituteTeacherName: row.teacherSnapshot?.substitute?.name || "Noma'lum",
          periodLabel: formatDateRangeUz(row.fromDate, row.toDate, { utc: true }),
          lesson: `${dayLabel(item.day)}, ${item.lessonOrder}-dars · ${item.snapshot?.className || "sinf"} · ${item.snapshot?.subjectName || "fan"}`,
        });
      }
    }

    const teacherIds = [...new Set(lessons.map((lesson) => lesson.teacherId))];
    const [userMap, classNameMap] = await Promise.all([
      loadUserMap([...teacherIds, ...conflicts.map((conflict) => conflict.teacherId)]),
      loadNameMap("class", activeRows.map((row) => row.classId)),
    ]);

    const inactiveByTeacher = new Map();
    let withoutTime = 0;
    for (const lesson of lessons) {
      const { startTime, endTime } = resolveLessonTime(lesson, periodMap);
      if (!timeLabel(startTime, endTime)) withoutTime += 1;

      const user = userMap.get(lesson.teacherId);
      const state = !user ? "O'chirilgan foydalanuvchi" : user.isArchived ? "Arxivlangan" : user.role === ROLES.STUDENT ? "O'quvchi" : null;
      if (!state) continue;
      const entry = inactiveByTeacher.get(lesson.teacherId) || {
        teacherId: lesson.teacherId,
        name: user ? personName(user) : "—",
        state,
        lessons: 0,
      };
      entry.lessons += 1;
      inactiveByTeacher.set(lesson.teacherId, entry);
    }

    const scheduledClassIds = new Set(activeRows.filter((row) => row.lessons.length > 0).map((row) => row.classId));
    const classesWithoutSchedule = classes
      .filter((row) => !scheduledClassIds.has(row.id))
      .map((row) => row.name)
      .sort((a, b) => a.localeCompare(b, "uz", { numeric: true }));

    const inactiveTeachers = [...inactiveByTeacher.values()].sort((a, b) => b.lessons - a.lessons);

    const summary = {
      mode: status.mode,
      classCount: status.active.classCount,
      lessonCount: status.active.lessonCount,
      teacherConflicts: conflicts.length,
      duplicateRows: status.integrity.duplicateRows,
      uniqueIndexPresent: status.integrity.uniqueIndexPresent,
      staleSubstitutionLessons: staleItems.length,
      lessonsWithInactiveTeacher: inactiveTeachers.reduce((sum, row) => sum + row.lessons, 0),
      lessonsWithoutTime: withoutTime,
      activeClassesWithoutSchedule: classesWithoutSchedule.length,
    };

    const healthy =
      summary.teacherConflicts === 0 &&
      summary.duplicateRows === 0 &&
      summary.uniqueIndexPresent &&
      summary.staleSubstitutionLessons === 0 &&
      summary.lessonsWithInactiveTeacher === 0;

    return {
      healthy,
      summary,
      conflicts: sliceList(
        conflicts.map((conflict) => ({
          dayLabel: dayLabel(conflict.day),
          order: conflict.order,
          teacherId: conflict.teacherId,
          teacherName: personName(userMap.get(conflict.teacherId)),
          classes: conflict.classIds.map((id) => classNameMap.get(id) || "Noma'lum sinf"),
        })),
        40,
      ),
      staleSubstitutions: sliceList(staleItems, 30),
      inactiveTeacherLessons: sliceList(inactiveTeachers, 30),
      classesWithoutSchedule: sliceList(classesWithoutSchedule, 40),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// O'RINBOSARLIKLAR
// ─────────────────────────────────────────────────────────────────────────

const substitutionsList = defineTool({
  name: "substitutions_list",
  toolset: TOOLSET,
  label: "O'rinbosarliklar ro'yxati",
  description:
    "Substitution (o'rinbosar) records, newest start date first: original teacher, substitute, period, reason, status " +
    "(active/cancelled) and phase (upcoming/ongoing/finished/cancelled), canDelete (only upcoming), covered lessons. " +
    "Filters: status, ongoing=true (active and covering today), teacherId (as original OR substitute), reason, and a " +
    "date window fromDate/toDate (records overlapping it). Paginated (max 20 per page; each row lists at most 3 lessons — " +
    "use substitutions_get for all of them); ongoingInBranch counts all ongoing records in the branch.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: SUBSTITUTION_STATUSES, description: "active or cancelled." },
      ongoing: { type: "boolean", description: "true = only active records that cover today." },
      teacherId: idSchema("Teacher id, matches the original teacher or the substitute."),
      reason: { type: "string", enum: SUBSTITUTION_REASONS, description: "Reason filter." },
      fromDate: daySchema("Window start YYYY-MM-DD (records overlapping the window)."),
      toDate: daySchema("Window end YYYY-MM-DD."),
      page: { type: "integer", minimum: 1, description: "Page number, default 1." },
      limit: limitSchema(LIST_PAGE_MAX),
    },
  },
  async handler(args, ctx) {
    const result = await asToolError(() =>
      substitutionService.getSubstitutions(
        reqLike(ctx, {
          status: args.status,
          ongoing: args.ongoing === true ? "true" : undefined,
          teacherId: args.teacherId ? requireId(args.teacherId, "O'qituvchi id") : undefined,
          reason: args.reason,
          fromDate: args.fromDate,
          toDate: args.toDate,
          page: args.page,
          limit: args.limit,
        }),
      ),
    );

    if (result.pagination.total === 0) {
      return { empty: true, reason: "Shartga mos o'rinbosarlik yozuvi yo'q", ongoingInBranch: result.totals.ongoing };
    }

    return {
      ongoingInBranch: result.totals.ongoing,
      pagination: pageInfo(result.pagination),
      items: result.data.map((row) => compactSubstitution(row, { maxLessons: LIST_ROW_LESSONS, noteMax: 100 })),
    };
  },
});

/** Sahifalash — faqat model uchun kerakli maydonlar. */
function pageInfo(pagination) {
  return {
    page: pagination.page,
    limit: pagination.limit,
    total: pagination.total,
    totalPages: pagination.totalPages,
    hasNextPage: pagination.hasNextPage,
  };
}

const substitutionsGet = defineTool({
  name: "substitutions_get",
  toolset: TOOLSET,
  label: "O'rinbosarlik tafsiloti",
  description:
    "One substitution (o'rinbosar) record in full: both teachers, period, reason and note, status and phase, every " +
    "covered lesson, occurrenceCount = lesson occurrences in the window (holidays and vacation months excluded), " +
    "staleLessons (cells no longer owned by the original teacher after a timetable change — they move nothing), " +
    "cancellation details, and whether payroll entries already exist for the affected months (sealed pay is not " +
    "recalculated). Use before proposing to cancel or delete a substitution.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["substitutionId"],
    properties: {
      substitutionId: idSchema("Substitution id from substitutions_list."),
    },
  },
  async handler(args) {
    const id = requireId(args.substitutionId, "O'rinbosarlik id");
    const row = await asToolError(() => substitutionService.getSubstitution(id));

    // `cancelSubstitution` ogohlantirishidagi AYNI so'rov — ikkala joyda
    // "oylik muhrlangan" savoliga bir xil javob chiqishi uchun.
    const [sealedEntries, ownLessons] = await Promise.all([
      prisma.payrollEntry.findMany({
        where: {
          staffId: { in: [row.originalTeacherId, row.substituteTeacherId] },
          month: { gte: monthKeyOfDate(row.fromDate), lte: monthKeyOfDate(row.toDate) },
          status: { not: "cancelled" },
        },
        select: { month: true },
        distinct: ["month"],
        orderBy: { month: "asc" },
      }),
      prisma.scheduleLesson.findMany({
        where: { teacherId: row.originalTeacherId },
        select: { order: true, schedule: { select: { day: true, classId: true } } },
      }),
    ]);

    // Eskirgan katak: jadval qayta saqlanib, egasi o'zgargan — soatga ham, jurnalga ham ta'sir qilmaydi.
    const owned = new Set(
      ownLessons
        .filter((lesson) => lesson.schedule?.day)
        .map((lesson) => `${lesson.schedule.classId}|${lesson.schedule.day}|${lesson.order}`),
    );
    const staleLessons = row.items
      .filter((item) => !owned.has(`${item.classId}|${item.day}|${item.lessonOrder}`))
      .map(substitutionItemLabel);

    return {
      ...compactSubstitution(row, { maxLessons: 60 }),
      createdAtLabel: formatDateTimeUz(row.createdAt),
      staleLessons: row.status === "active" && staleLessons.length ? staleLessons : undefined,
      payrollGeneratedMonths: sealedEntries.map((entry) => monthLabel(entry.month)),
    };
  },
});

const substitutionsAvailableLessons = defineTool({
  name: "substitutions_available_lessons",
  toolset: TOOLSET,
  label: "O'rinbosarga beriladigan darslar",
  description:
    "Lessons of a teacher that can be given to an o'rinbosar in a date window (max 180 days): each timetable cell " +
    "(classId, day, lessonOrder) whose weekday occurs in the window, with class, subject, time, occurrences (real " +
    "lesson count in the window, holidays/vacation excluded) and alreadyAssigned (already covered by another active " +
    "substitution). With substituteTeacherId, also marks substituteBusy (the substitute has an own lesson or another " +
    "cover at that day and period). Use it to build the lessons list for propose_create_substitution.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["teacherId", "fromDate", "toDate"],
    properties: {
      teacherId: idSchema("Original (absent) teacher id."),
      fromDate: daySchema("First day YYYY-MM-DD (inclusive)."),
      toDate: daySchema("Last day YYYY-MM-DD (inclusive)."),
      substituteTeacherId: idSchema("Optional candidate substitute id to mark busy slots."),
    },
  },
  async handler(args) {
    const teacherId = requireId(args.teacherId, "O'qituvchi id");
    const substituteId = args.substituteTeacherId ? requireId(args.substituteTeacherId, "O'rinbosar id") : null;

    const result = await asToolError(() =>
      substitutionService.getAvailableLessons(teacherId, { fromDate: args.fromDate, toDate: args.toDate }),
    );

    // ⚠️ Servis faqat SHU o'qituvchi dars egasi bo'lgan o'rinbosarliklarni "band"
    // deb belgilaydi. `prepareSubstitution` esa katakni HAR QANDAY faol yozuv
    // bilan to'qnashuvda rad etadi (jadval o'zgargach eskirib qolgan boshqa egali
    // yozuv ham). Ro'yxat "beriladi" deb ko'rsatib, taklif rad etilmasligi uchun
    // aynan o'sha shart bilan qayta belgilanadi.
    const coveredElsewhere = result.items.length
      ? await prisma.lessonSubstitutionItem.findMany({
          where: {
            OR: result.items.map((item) => ({ classId: item.classId, day: item.day, lessonOrder: item.lessonOrder })),
            substitution: { status: "active", fromDate: { lte: result.toDate }, toDate: { gte: result.fromDate } },
          },
          select: { classId: true, day: true, lessonOrder: true },
        })
      : [];
    const coveredKeys = new Set(coveredElsewhere.map((row) => `${row.classId}|${row.day}|${row.lessonOrder}`));

    let busy = null;
    let substitute = null;
    if (substituteId) {
      // Faqat YO'L-YO'LAKAY belgi: haqiqiy tekshiruv `prepareSubstitution` da
      // (taklif paytida) — u yerda xato bo'lsa taklif umuman tuzilmaydi.
      const [user, ownLessons, covers] = await Promise.all([
        prisma.user.findUnique({ where: { id: substituteId }, select: USER_NAME_SELECT }),
        prisma.scheduleLesson.findMany({
          where: { teacherId: substituteId },
          select: { order: true, schedule: { select: { day: true } } },
        }),
        prisma.lessonSubstitutionItem.findMany({
          where: {
            substitution: {
              status: "active",
              substituteTeacherId: substituteId,
              fromDate: { lte: result.toDate },
              toDate: { gte: result.fromDate },
            },
          },
          select: { day: true, lessonOrder: true },
        }),
      ]);
      if (!user || user.role === ROLES.STUDENT) throw new AiToolError("O'rinbosar topilmadi");
      substitute = { id: user.id, name: personName(user), archived: user.isArchived || undefined };
      busy = new Set([
        ...ownLessons.filter((lesson) => lesson.schedule?.day).map((lesson) => `${lesson.schedule.day}|${lesson.order}`),
        ...covers.map((cover) => `${cover.day}|${cover.lessonOrder}`),
      ]);
    }

    const items = result.items.map((item) => ({
      classId: item.classId,
      className: item.className,
      subjectName: item.subjectName,
      day: item.day,
      dayLabel: item.dayLabel,
      lessonOrder: item.lessonOrder,
      time: timeLabel(item.startTime, item.endTime),
      occurrences: item.occurrences,
      alreadyAssigned: item.alreadyAssigned || coveredKeys.has(`${item.classId}|${item.day}|${item.lessonOrder}`),
      substituteBusy: busy ? busy.has(`${item.day}|${item.lessonOrder}`) : undefined,
    }));

    const base = {
      teacher: { id: result.teacher.id, name: personName(result.teacher) },
      substitute: substitute ?? undefined,
      periodLabel: result.periodLabel,
    };

    if (items.length === 0) {
      return { ...base, empty: true, reason: "Bu davrga to'g'ri keladigan darsi yo'q (jadvalda darsi yo'q yoki kunlar mos emas)" };
    }

    return {
      ...base,
      totalLessons: result.totalLessons,
      totalOccurrencesFree: items.filter((item) => !item.alreadyAssigned).reduce((sum, item) => sum + item.occurrences, 0),
      assignable: items.filter((item) => !item.alreadyAssigned && item.substituteBusy !== true).length,
      ...sliceList(items, 60),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// DAM OLISH KUNLARI VA TA'TIL OYLARI
// ─────────────────────────────────────────────────────────────────────────

const holidaysList = defineTool({
  name: "holidays_list",
  toolset: TOOLSET,
  label: "Dam olish kunlari",
  description:
    "Holidays (dam olish kunlari) and school-wide vacation months. Returns every holiday record (active and inactive) " +
    "with id, type, readable rule (single date, date range, or yearly recurring), creator, and a problem note when a " +
    "record can never match any day; plus, for the window fromDate..toDate (default today..+180 days, max 400 days), " +
    "the actual non-working dates produced by ACTIVE holidays (Sundays counted separately) and vacation months " +
    "intersecting the window. Holidays remove lesson hours and skip absence marking and grade penalties on those days.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      fromDate: daySchema("Window start YYYY-MM-DD. Default today."),
      toDate: daySchema("Window end YYYY-MM-DD. Default fromDate + 180 days."),
    },
  },
  async handler(args, ctx) {
    const fromIso = args.fromDate || ctx.today;
    const toIso = args.toDate || shiftIsoDays(fromIso, 180);
    const from = await dayDateArg(fromIso, "Boshlanish sanasi");
    const to = await dayDateArg(toIso, "Tugash sanasi");
    if (to < from) throw new AiToolError("Tugash sanasi boshlanish sanasidan oldin bo'lishi mumkin emas");
    const spanDays = Math.round((to - from) / 86400000) + 1;
    if (spanDays > MAX_HOLIDAY_RANGE_DAYS) {
      throw new AiToolError(`Oraliq ${MAX_HOLIDAY_RANGE_DAYS} kundan oshmasin`);
    }

    const [holidays, holidaySet, vacationRows] = await Promise.all([
      holidayService.getHolidays(),
      holidayService.buildHolidaySet(from, to),
      prisma.vacationMonth.findMany({
        where: { month: { gte: monthKeyOfDate(from), lte: monthKeyOfDate(to) } },
        orderBy: { month: "asc" },
        select: { month: true, title: true },
      }),
    ]);

    const dates = [...holidaySet].sort();
    const weekdayDates = dates.filter((iso) => new Date(`${iso}T00:00:00Z`).getUTCDay() !== 0);

    const rows = holidays.map((holiday) => ({
      id: holiday.id,
      name: holiday.name,
      description: clip(holiday.description, 200) || undefined,
      typeLabel: HOLIDAY_TYPE_LABELS[holiday.type] || holiday.type,
      rule: holidayRuleLabel(holiday),
      isActive: holiday.isActive,
      problem: holidayProblem(holiday) || undefined,
      createdBy: holiday.createdBy ? personName(holiday.createdBy) : undefined,
      createdAtLabel: formatDateUz(holiday.createdAt),
    }));

    return {
      window: formatDateRangeUz(from, to, { utc: true }),
      holidayCount: rows.length,
      activeHolidayCount: rows.filter((row) => row.isActive).length,
      holidays: sliceList(rows, 60),
      datesInWindow: {
        total: dates.length,
        onSchoolWeekdays: weekdayDates.length,
        ...sliceList(dates.map((iso) => formatDateUz(`${iso}T00:00:00Z`, { utc: true })), 60),
      },
      vacationMonthsInWindow: vacationRows.map((row) => ({
        month: row.month,
        monthLabel: monthLabel(row.month),
        title: row.title || undefined,
      })),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// GOOGLE SHEETS SINXRONIZATSIYASI
// ─────────────────────────────────────────────────────────────────────────

const scheduleSyncHealth = defineTool({
  name: "schedule_sync_health",
  toolset: TOOLSET,
  label: "Jadval manbai va Sheets holati",
  description:
    "Where the timetable is managed (platform or Google Sheets) and the health of the Sheets sync: auto-check on/off, " +
    "last check time and result, consecutive failures, whether the active timetable still equals the last applied " +
    "sheet version (inSync), whether the last check is fresh (<15 min), pending sheet revisions awaiting human review, " +
    "the 5 latest revisions, active timetable size and integrity, plus a signals list of detected problems. Read-only: " +
    "applying revisions or switching source is never done by the assistant.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async handler(args, ctx) {
    const [status, revisions, pendingRevisions] = await Promise.all([
      scheduleSheetSyncService.getStatus(ctx.user),
      scheduleSheetSyncService.listRevisions(reqLike(ctx, { limit: 5 })),
      prisma.scheduleSheetRevision.count({ where: { status: "pending" } }),
    ]);

    const revisionOf = (revision) => ({
      id: revision.id,
      statusLabel: REVISION_STATUS_LABELS[revision.status] || revision.status,
      isLatest: revision.isLatest,
      sheetTab: revision.sheetTab,
      classCount: revision.classCount,
      lessonCount: revision.lessonCount,
      issueCount: revision.issueCount,
      fetchedBy: revision.fetchedBy?.name,
      reviewedBy: revision.reviewedBy?.name,
      reviewedAtLabel: revision.reviewedAt ? formatDateTimeUz(revision.reviewedAt) : undefined,
      rejectReason: clip(revision.rejectReason, 200) || undefined,
      createdAtLabel: formatDateTimeUz(revision.createdAt),
    });

    const isSheet = status.mode === "sheet";
    const signals = [];
    if (status.integrity.duplicateRows > 0) {
      signals.push(`Amaldagi jadvalda ${status.integrity.duplicateRows} ta takroriy sinf-kun qatori bor`);
    }
    if (!status.integrity.uniqueIndexPresent) {
      signals.push("Sinf-kun yagonaligi indeksi yo'q — takroriy qatorlar paydo bo'lishi mumkin");
    }
    if (isSheet) {
      if (!status.sheetTab || !status.spreadsheetId) signals.push("Sheets rejimi yoqilgan, lekin sheet yoki varaq sozlanmagan");
      if (!status.autoCheck) signals.push("Sheets avtomatik tekshiruvi o'chirilgan");
      if (status.lastCheckOk === false) {
        signals.push(`Oxirgi tekshiruv muvaffaqiyatsiz (ketma-ket ${status.checkFailureCount} marta)`);
      }
      if (status.inSync === false) {
        signals.push("Amaldagi jadval oxirgi qo'llangan sheet versiyasidan farq qiladi");
      }
      if (pendingRevisions > 0) signals.push(`${pendingRevisions} ta sheet o'zgarishi ko'rib chiqilishini kutmoqda`);
    }

    return {
      mode: status.mode,
      modeLabel: MODE_LABELS[status.mode] || status.mode,
      modeChangedAtLabel: status.modeChangedAt ? formatDateTimeUz(status.modeChangedAt) : undefined,
      modeChangedBy: status.modeChangedBy?.name,
      sheet: {
        configured: Boolean(status.spreadsheetId && status.sheetTab),
        sheetTab: status.sheetTab || undefined,
        autoCheck: status.autoCheck,
        lastCheckedAtLabel: status.lastCheckedAt ? formatDateTimeUz(status.lastCheckedAt) : "Hali tekshirilmagan",
        lastCheckOk: status.lastCheckOk,
        lastCheckError: clip(status.lastCheckError, 300) || undefined,
        consecutiveFailures: status.checkFailureCount,
        checkFresh: status.checkFresh,
        inSync: status.inSync,
        usedForTimetable: isSheet,
      },
      active: {
        classCount: status.active.classCount,
        lessonCount: status.active.lessonCount,
        duplicateRows: status.integrity.duplicateRows,
        uniqueIndexPresent: status.integrity.uniqueIndexPresent,
      },
      platformArchive: status.platformSnapshot
        ? {
            kindLabel: status.platformSnapshot.kindLabel,
            lessonCount: status.platformSnapshot.lessonCount,
            createdAtLabel: formatDateTimeUz(status.platformSnapshot.createdAt),
          }
        : undefined,
      pendingRevisions,
      latestRevisions: revisions.data.map(revisionOf),
      signals,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// REJALASHTIRUVCHI (PLANNER)
// ─────────────────────────────────────────────────────────────────────────

const schedulePlannerOverview = defineTool({
  name: "schedule_planner_overview",
  toolset: TOOLSET,
  label: "Jadval rejalashtiruvchisi",
  description:
    "Timetable planner (draft generator, never touches the active timetable): grid (work days, periods, weekly slots, " +
    "limits), preflight blocking problems and warnings that stop or weaken generation, planned weekly load per teacher " +
    "(demand vs free slots) and per class (demand vs capacity), load rows with warnings, teachers without subjects, " +
    "and the 10 latest generated runs with fill rate and unplaced lessons.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async handler() {
    const [grid, preflight, loads, runs] = await Promise.all([
      plannerSettingsService.getGrid(),
      plannerGeneratorService.getPreflight(),
      plannerLoadService.getLoads(),
      plannerRunService.listRuns(),
    ]);

    const teacherNames = new Map(loads.rows.map((row) => [row.teacher.id, row.teacher.fullName]));
    const slotsPerWeek = loads.grid.slotsPerWeek;

    const teacherTotals = loads.teacherTotals
      .map((row) => ({
        name: teacherNames.get(row.teacherId) || "—",
        demand: row.total,
        busySlots: row.busy,
        freeSlots: row.available,
        overCapacity: row.total > row.available || undefined,
      }))
      .sort((a, b) => b.demand - a.demand);

    const classTotals = loads.classTotals
      .map((row) => ({ name: row.name, demand: row.demand, capacity: row.capacity, overCapacity: row.demand > row.capacity || undefined }))
      .sort((a, b) => a.name.localeCompare(b.name, "uz", { numeric: true }));

    const settings = grid.settings;

    return {
      grid: {
        days: grid.days.map(dayLabel),
        periods: grid.periods.map((period) => ({ order: period.order, time: timeLabel(period.startTime, period.endTime) })),
        slotsPerWeek,
        limits: {
          maxLessonsPerDay: settings.maxLessonsPerDay,
          minLessonsPerDay: settings.minLessonsPerDay,
          teacherMaxPerDay: settings.teacherMaxPerDay,
          maxSameSubjectPerDay: settings.maxSameSubjectPerDay,
          allowClassGaps: settings.allowClassGaps,
          allowTeacherGaps: settings.allowTeacherGaps,
          avoidConsecutiveSame: settings.avoidConsecutiveSame,
        },
      },
      preflight: {
        canGenerate: preflight.blocking.length === 0,
        totals: preflight.totals,
        blocking: sliceList(preflight.blocking.map((item) => ({ message: item.message, hint: item.hint })), 30),
        warnings: sliceList(preflight.warnings.map((item) => item.message), 30),
      },
      loads: {
        rowCount: loads.rows.length,
        rowsWithWarnings: sliceList(
          loads.rows
            .filter((row) => row.warnings.length > 0)
            .map((row) => ({ teacher: row.teacher.fullName, subject: row.subject.name, warnings: row.warnings.join("; ") })),
          30,
        ),
        teachersWithoutSubjects: sliceList(loads.teachersWithoutSubjects.map((row) => row.fullName), 30),
        teacherTotals: sliceList(teacherTotals, 40),
        classTotals: sliceList(classTotals, 40),
      },
      runs: sliceList(
        runs.map((run) => ({
          id: run.id,
          name: run.name,
          createdAtLabel: formatDateTimeUz(run.createdAt),
          generatedBy: run.generatedBy ? personName(run.generatedBy) : undefined,
          demand: run.stats?.demand,
          placed: run.stats?.placed,
          fillRate: run.stats?.fillRate,
          unplacedLessons: run.unplacedCount,
        })),
        10,
      ),
    };
  },
});

module.exports = [
  scheduleToday,
  scheduleClass,
  scheduleTeacher,
  scheduleTeacherHours,
  scheduleConflicts,
  substitutionsList,
  substitutionsGet,
  substitutionsAvailableLessons,
  holidaysList,
  scheduleSyncHealth,
  schedulePlannerOverview,
];
