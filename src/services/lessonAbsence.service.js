/**
 * DARSGA KELMAGANLAR — "dars vaqti bo'ldi, o'qituvchi esa maktabda yo'q".
 *
 * Boshliq uchun JONLI ro'yxat: qaysi o'qituvchi, qaysi sinfning nechanchi
 * darsiga kelmadi va dars soat nechada boshlangan. Bugun uchun faqat
 * BOSHLANGAN darslar olinadi (hali boshlanmagan darsga "kelmadi" deyish
 * erta); o'tgan kun so'ralsa — kunning hamma darsi.
 *
 * Holatlar (dars kesimida):
 *   · `absent`    — o'qituvchi bugun kelmagan (davomatda yo'q yoki "kelmadi");
 *   · `excused`   — sababli kelmagan, lekin darsiga o'rinbosar qo'yilmagan;
 *   · `cameAfter` — keldi, lekin dars TUGAGANDAN keyin;
 *   · `late`      — dars BOSHLANGANDAN keyin keldi;
 *   · `left`      — dars boshlanishidan OLDIN ketib qolgan.
 *
 * ⚠️ DARSNING AMALDAGI O'QITUVCHISI (`effectiveTeacherOf`): o'rinbosar
 * qo'yilgan darsda asl egasi emas, o'rinbosar tekshiriladi — aks holda
 * kasal o'qituvchi "kelmadi" ro'yxatida turib qolardi (`education.md` §8).
 *
 * ⚠️ DARS VAQTI: darsning o'z vaqti, bo'lmasa "Dars vaqtlari" sozlamasi
 * (`ScheduleSettings.periods`) — tartib raqami bo'yicha. Ikkalasi ham
 * bo'lmasa bugungi dars "boshlandimi" degan savolga javob yo'q: u
 * ro'yxatga kirmaydi, lekin soni alohida qaytadi (`untimedLessons`) —
 * jim tushib qolmasligi uchun.
 *
 * ⚠️ ADMIN QO'LDA "KELDI" BELGILAGAN (vaqtsiz) o'qituvchi darsda deb
 * hisoblanadi — `gradingPresence.service.js` bilan bir xil qoida.
 */

const prisma = require("../config/prisma");
const { BadRequestError } = require("../utils/errors");
const {
  currentDayDate,
  parseDayDate,
  monthKeyOfDate,
} = require("../helpers/month.helpers");
const { formatDateUz, formatTimeUz } = require("../helpers/date.helpers");
const { dayKey } = require("../helpers/lessonHours");
const {
  scheduleDayOf,
  getSubstitutionCells,
  effectiveTeacherOf,
} = require("../helpers/teacherAccess");
const { buildHolidaySet } = require("./holiday.service");
const { getVacationSet } = require("./vacationMonth.service");
const { getScheduleSettings } = require("./settings.service");

const DAY_MS = 24 * 3600 * 1000;
const TASHKENT_OFFSET_MS = 5 * 3600 * 1000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const PRESENT_STATUSES = new Set(["present", "late"]);

const STATE_LABELS = {
  absent: "Kelmagan",
  excused: "Sababli kelmagan",
  cameAfter: "Darsdan keyin keldi",
  late: "Dars boshlangach keldi",
  left: "Darsdan oldin ketgan",
};

/** Teacher kesimidagi og'irlik — kelmaganlar tepada. */
const TEACHER_STATE_RANK = { absent: 0, excused: 1, left: 2, cameAfter: 3, late: 3 };

const fullName = (person) =>
  person ? `${person.firstName ?? ""} ${person.lastName ?? ""}`.trim() || "Noma'lum" : "Noma'lum";

/** "08:30" → 510; yaroqsiz → null. */
const minutesOfTime = (value) => {
  if (!TIME_RE.test(String(value ?? ""))) return null;
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
};

/** Instantning Toshkent devor-soati, daqiqada. */
const tashkentMinutesOf = (instant) =>
  Math.floor((((new Date(instant).getTime() + TASHKENT_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / 60000);

const EMPTY_SUMMARY = () => ({
  teachers: 0,
  lessons: 0,
  ongoingLessons: 0,
  absentTeachers: 0,
  lateTeachers: 0,
  untimedLessons: 0,
});

/**
 * Bitta dars uchun o'qituvchi holati — sof funksiya.
 *
 * @param {object|null} record - o'qituvchining shu kungi `Attendance`
 * @param {{startMin: number|null, endMin: number|null}} lesson
 * @returns {null | "absent"|"excused"|"cameAfter"|"late"|"left"} — `null`: darsda edi
 */
function judgeLessonPresence(record, { startMin, endMin }) {
  if (!record || !PRESENT_STATUSES.has(record.status)) {
    return record?.status === "excused" ? "excused" : "absent";
  }

  // Vaqtsiz dars yoki vaqtsiz qayd (admin qo'lda belgilagan) — darsda
  if (startMin == null) return null;

  if (record.checkOut && tashkentMinutesOf(record.checkOut) <= startMin) return "left";

  if (record.checkIn) {
    const arrived = tashkentMinutesOf(record.checkIn);
    if (endMin != null && arrived >= endMin) return "cameAfter";
    if (arrived > startMin) return "late";
  }

  return null;
}

/**
 * DARSGA KELMAGANLAR RO'YXATI.
 *
 * @param {object} [query]
 * @param {string} [query.date] - "YYYY-MM-DD"; bo'lmasa bugun
 */
async function getLessonAbsentees({ date } = {}) {
  const today = currentDayDate();
  const day = date ? parseDayDate(date, "Sana") : today;
  if (day > today) throw new BadRequestError("Kelajakdagi kun uchun ro'yxat yo'q");

  const isToday = day.getTime() === today.getTime();
  const now = new Date();
  const nowMin = isToday ? tashkentMinutesOf(now) : null;

  const base = {
    date: dayKey(day),
    // ⚠️ `day` — UTC yarim tuni (`dates.md` §4)
    dateLabel: formatDateUz(day, { utc: true }),
    isToday,
    nowLabel: isToday ? formatTimeUz(now) : null,
    closed: null,
    message: null,
    periodsConfigured: true,
    teachers: [],
    summary: EMPTY_SUMMARY(),
  };

  const dayName = scheduleDayOf(day);
  if (!dayName) return { ...base, closed: "sunday", message: "Yakshanba — dars yo'q" };

  const [holidaySet, vacationSet] = await Promise.all([
    buildHolidaySet(day, day),
    getVacationSet(),
  ]);
  if (holidaySet.has(dayKey(day))) {
    return { ...base, closed: "holiday", message: "Bayram kuni — dars yo'q" };
  }
  if (vacationSet.has(monthKeyOfDate(day))) {
    return { ...base, closed: "vacation", message: "Ta'til oyi — dars yo'q" };
  }

  const [schedules, cells, settings] = await Promise.all([
    prisma.schedule.findMany({ where: { day: dayName }, include: { lessons: true } }),
    getSubstitutionCells(day),
    getScheduleSettings(),
  ]);

  const periods = new Map(
    (Array.isArray(settings.periods) ? settings.periods : []).map((p) => [Number(p.order), p]),
  );

  const classIds = [...new Set(schedules.map((s) => s.classId))];
  const classes = classIds.length
    ? await prisma.class.findMany({
        where: { id: { in: classIds } },
        select: { id: true, name: true, isActive: true },
      })
    : [];
  const classMap = new Map(classes.map((c) => [c.id, c]));

  // ── Darslar: amaldagi o'qituvchi va vaqt ─────────────
  const lessons = [];
  let untimed = 0;

  for (const schedule of schedules) {
    const klass = classMap.get(schedule.classId);
    if (!klass?.isActive) continue;

    for (const lesson of schedule.lessons) {
      if (!lesson.teacherId) continue;

      const period = periods.get(lesson.order);
      const startTime = TIME_RE.test(lesson.startTime ?? "") ? lesson.startTime : period?.startTime ?? null;
      const endTime = TIME_RE.test(lesson.endTime ?? "") ? lesson.endTime : period?.endTime ?? null;
      const startMin = minutesOfTime(startTime);
      const endMin = minutesOfTime(endTime);

      if (isToday) {
        if (startMin == null) {
          untimed += 1;
          continue;
        }
        if (startMin > nowMin) continue; // hali boshlanmagan
      }

      const effective = effectiveTeacherOf(
        { classId: schedule.classId, day: dayName, order: lesson.order, teacherId: lesson.teacherId },
        cells,
      );

      lessons.push({
        teacherId: effective.teacherId,
        substituted: effective.substituted,
        classId: schedule.classId,
        className: klass.name,
        subjectId: lesson.subjectId,
        lessonOrder: lesson.order,
        startTime,
        endTime,
        startMin,
        endMin,
      });
    }
  }

  const periodsConfigured = periods.size > 0;

  if (lessons.length === 0) {
    return {
      ...base,
      periodsConfigured,
      summary: { ...EMPTY_SUMMARY(), untimedLessons: untimed },
    };
  }

  const teacherIds = [...new Set(lessons.map((l) => l.teacherId))];
  const subjectIds = [...new Set(lessons.map((l) => l.subjectId))];

  const [records, teachers, subjects] = await Promise.all([
    prisma.attendance.findMany({
      where: { userId: { in: teacherIds }, date: day },
      select: { userId: true, status: true, checkIn: true, checkOut: true },
    }),
    prisma.user.findMany({
      where: { id: { in: teacherIds } },
      select: { id: true, firstName: true, lastName: true, phone: true },
    }),
    prisma.subject.findMany({
      where: { id: { in: subjectIds } },
      select: { id: true, name: true },
    }),
  ]);

  const recordMap = new Map(records.map((r) => [r.userId, r]));
  const teacherMap = new Map(teachers.map((t) => [t.id, t]));
  const subjectMap = new Map(subjects.map((s) => [s.id, s.name]));

  // ── Holat va guruhlash ─────────────
  const byTeacher = new Map();

  for (const lesson of lessons) {
    const record = recordMap.get(lesson.teacherId) ?? null;
    const state = judgeLessonPresence(record, lesson);
    if (!state) continue;

    let row = byTeacher.get(lesson.teacherId);
    if (!row) {
      const teacher = teacherMap.get(lesson.teacherId);
      row = {
        teacherId: lesson.teacherId,
        teacherName: fullName(teacher),
        phone: teacher?.phone ?? null,
        arrivedAtLabel: record?.checkIn ? formatTimeUz(record.checkIn) : null,
        leftAtLabel: record?.checkOut ? formatTimeUz(record.checkOut) : null,
        states: new Set(),
        lessons: [],
      };
      byTeacher.set(lesson.teacherId, row);
    }

    row.states.add(state);
    row.lessons.push({
      classId: lesson.classId,
      className: lesson.className,
      subjectName: subjectMap.get(lesson.subjectId) ?? "Noma'lum",
      lessonOrder: lesson.lessonOrder,
      startTime: lesson.startTime,
      endTime: lesson.endTime,
      // Hozir davom etayotgan dars — ekranda alohida ajratiladi
      ongoing:
        isToday &&
        lesson.startMin != null &&
        lesson.startMin <= nowMin &&
        (lesson.endMin == null || nowMin < lesson.endMin),
      substituted: lesson.substituted,
      state,
      stateLabel: STATE_LABELS[state],
    });
  }

  const rows = [...byTeacher.values()].map(({ states, ...row }) => {
    const state = [...states].sort((a, b) => TEACHER_STATE_RANK[a] - TEACHER_STATE_RANK[b])[0];
    const lessonsSorted = row.lessons.sort(
      (a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? "") || a.lessonOrder - b.lessonOrder,
    );
    return {
      ...row,
      state,
      stateLabel: STATE_LABELS[state],
      ongoingCount: lessonsSorted.filter((l) => l.ongoing).length,
      lessons: lessonsSorted,
    };
  });

  rows.sort(
    (a, b) =>
      Number(b.ongoingCount > 0) - Number(a.ongoingCount > 0) ||
      TEACHER_STATE_RANK[a.state] - TEACHER_STATE_RANK[b.state] ||
      (a.lessons[0].startTime ?? "").localeCompare(b.lessons[0].startTime ?? "") ||
      a.teacherName.localeCompare(b.teacherName),
  );

  return {
    ...base,
    periodsConfigured,
    teachers: rows,
    summary: {
      teachers: rows.length,
      lessons: rows.reduce((sum, r) => sum + r.lessons.length, 0),
      ongoingLessons: rows.reduce((sum, r) => sum + r.ongoingCount, 0),
      absentTeachers: rows.filter((r) => r.state === "absent" || r.state === "excused").length,
      lateTeachers: rows.filter((r) => r.state === "late" || r.state === "cameAfter" || r.state === "left").length,
      untimedLessons: untimed,
    },
  };
}

module.exports = {
  STATE_LABELS,
  judgeLessonPresence,
  tashkentMinutesOf,
  getLessonAbsentees,
};
