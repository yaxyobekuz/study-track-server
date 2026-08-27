const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const {
  getCurrentDayUz,
  isSunday,
  getTashkentDateUtc,
} = require("../helpers/date.helpers");
const { parseDayDate, parseOptionalDayDate } = require("../helpers/month.helpers");

// ─────────────────────────────────────────────
// VERSIYALASH yordamchilari (amal qilish davri — kun aniqligida)
// ─────────────────────────────────────────────

/** Bugungi kun (Toshkent), @db.Date bilan mos UTC yarim tuni. */
const todayDate = () => getTashkentDateUtc(0);

/** @db.Date qiymatni "YYYY-MM-DD" ga (ekranga emas, API/solishtirish uchun). */
const formatDay = (date) => (date ? date.toISOString().slice(0, 10) : null);

/** N kun qo'shilgan/ayirilgan UTC yarim tunidagi sana. */
const addDaysUtc = (date, n) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + n));

/** Berilgan sanada AMALDA bo'lgan versiyalarni tanlash uchun where. */
const activeAsOfWhere = (asOf) => ({
  effectiveFrom: { lte: asOf },
  OR: [{ effectiveTo: null }, { effectiveTo: { gte: asOf } }],
});

/** [from, to] davri bilan KESISHUVCHI versiyalarni topish uchun where. */
const overlapWhere = (from, to) => ({
  ...(to ? { effectiveFrom: { lte: to } } : {}),
  OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
});

const resolveAsOf = (value) => (value ? parseDayDate(value, "Sana") : todayDate());

// ─────────────────────────────────────────────
// Format
// ─────────────────────────────────────────────

function mapLessons(lessons, subjectMap, teacherMap) {
  return (lessons || []).map((lesson) => ({
    id: lesson.id,
    subject: subjectMap.get(lesson.subjectId) || null,
    teacher: teacherMap.get(lesson.teacherId) || null,
    order: lesson.order,
    startTime: lesson.startTime,
    endTime: lesson.endTime,
  }));
}

async function loadLessonRefs(schedules) {
  const subjectIds = new Set();
  const teacherIds = new Set();
  for (const schedule of schedules) {
    for (const lesson of schedule.lessons || []) {
      if (lesson.subjectId) subjectIds.add(lesson.subjectId);
      if (lesson.teacherId) teacherIds.add(lesson.teacherId);
    }
  }

  const [subjects, teachers] = await Promise.all([
    prisma.subject.findMany({
      where: { id: { in: [...subjectIds] } },
      select: { id: true, name: true },
    }),
    prisma.user.findMany({
      where: { id: { in: [...teacherIds] } },
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);

  const subjectMap = new Map(subjects.map((s) => [s.id, { id: s.id, name: s.name }]));
  const teacherMap = new Map(
    teachers.map((t) => [t.id, { id: t.id, firstName: t.firstName, lastName: t.lastName }]),
  );

  return { subjectMap, teacherMap };
}

function formatSchedule(schedule, subjectMap, teacherMap) {
  return {
    id: schedule.id,
    class: schedule.classId,
    day: schedule.day,
    effectiveFrom: formatDay(schedule.effectiveFrom),
    effectiveTo: formatDay(schedule.effectiveTo),
    isOpen: schedule.effectiveTo == null,
    subjects: [...mapLessons(schedule.lessons, subjectMap, teacherMap)].sort(
      (a, b) => (a.order || 0) - (b.order || 0),
    ),
    createdBy: schedule.createdBy,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  };
}

function buildLessonRows(scheduleId, subjects) {
  return subjects.map((item, index) => ({
    scheduleId,
    subjectId: item.subject,
    teacherId: item.teacher,
    order: Number(item.order),
    startTime: item.startTime || null,
    endTime: item.endTime || null,
    position: index,
  }));
}

// ─────────────────────────────────────────────
// O'qish (sana bo'yicha — default BUGUN)
// ─────────────────────────────────────────────

/** Har (kun) uchun eng kech boshlangan amaldagi versiyani qoldiradi. */
function pickActivePerDay(schedules) {
  // schedules effectiveFrom desc tartibda kelgan bo'lishi kerak
  const perDay = new Map();
  for (const s of schedules) if (!perDay.has(s.day)) perDay.set(s.day, s);
  return [...perDay.values()];
}

async function getScheduleByClass(classId, asOfInput) {
  const classExists = await prisma.class.findUnique({ where: { id: classId } });
  if (!classExists) throw new NotFoundError("Sinf topilmadi");

  const asOf = resolveAsOf(asOfInput);
  const schedules = await prisma.schedule.findMany({
    where: { classId, ...activeAsOfWhere(asOf) },
    include: { lessons: true },
    orderBy: [{ day: "asc" }, { effectiveFrom: "desc" }],
  });

  const active = pickActivePerDay(schedules);
  const { subjectMap, teacherMap } = await loadLessonRefs(active);
  return active
    .map((schedule) => formatSchedule(schedule, subjectMap, teacherMap))
    .sort((a, b) => DAY_RANK(a.day) - DAY_RANK(b.day));
}

async function getScheduleByDay(classId, day, asOfInput) {
  const asOf = resolveAsOf(asOfInput);
  const schedule = await prisma.schedule.findFirst({
    where: { classId, day, ...activeAsOfWhere(asOf) },
    include: { lessons: true },
    orderBy: { effectiveFrom: "desc" },
  });

  if (!schedule) throw new NotFoundError("Bu kun uchun dars jadvali topilmadi");

  const { subjectMap, teacherMap } = await loadLessonRefs([schedule]);
  return formatSchedule(schedule, subjectMap, teacherMap);
}

/**
 * Sinfning BARCHA jadval versiyalari (tarix) — kun + amal qilish davri bo'yicha.
 * Frontend versiyalar ro'yxatini shu asosda chizadi.
 */
async function getScheduleVersions(classId) {
  const classExists = await prisma.class.findUnique({ where: { id: classId } });
  if (!classExists) throw new NotFoundError("Sinf topilmadi");

  const schedules = await prisma.schedule.findMany({
    where: { classId },
    include: { lessons: true },
    orderBy: [{ day: "asc" }, { effectiveFrom: "desc" }],
  });

  const { subjectMap, teacherMap } = await loadLessonRefs(schedules);
  return schedules.map((schedule) => formatSchedule(schedule, subjectMap, teacherMap));
}

// ─────────────────────────────────────────────
// Tekshiruvlar
// ─────────────────────────────────────────────

/**
 * O'qituvchining parallel to'qnashuvi — FAQAT [from, to] bilan kesishuvchi
 * versiyalar orasida (turli davrdagi jadvallar bir-biriga xalaqit bermaydi).
 */
async function ensureNoTeacherConflicts(classId, day, subjects, from, to) {
  const otherSchedules = await prisma.schedule.findMany({
    where: { day, classId: { not: classId }, ...overlapWhere(from, to) },
    include: { lessons: true },
  });

  const classIds = [...new Set(otherSchedules.map((s) => s.classId).filter(Boolean))];
  const teacherIds = new Set();
  for (const schedule of otherSchedules)
    for (const lesson of schedule.lessons || [])
      if (lesson.teacherId) teacherIds.add(lesson.teacherId);

  const [classes, teachers] = await Promise.all([
    prisma.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } }),
    prisma.user.findMany({
      where: { id: { in: [...teacherIds] } },
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);

  const classNameMap = new Map(classes.map((c) => [c.id, c.name]));
  const teacherMap = new Map(teachers.map((t) => [t.id, t]));

  const occupied = new Map();
  for (const schedule of otherSchedules) {
    for (const item of schedule.lessons || []) {
      const teacher = teacherMap.get(item.teacherId);
      occupied.set(`${String(item.teacherId)}-${item.order}`, {
        className: classNameMap.get(schedule.classId) || "",
        teacherName: teacher ? `${teacher.firstName} ${teacher.lastName || ""}`.trim() : "",
      });
    }
  }

  for (const item of subjects) {
    const conflict = occupied.get(`${String(item.teacher)}-${Number(item.order)}`);
    if (conflict) {
      throw new BadRequestError(
        `${conflict.teacherName} o'qituvchisi shu kuni ${item.order}-tartibda "${conflict.className}" sinfida band (shu davrda). Parallel dars belgilab bo'lmaydi`,
      );
    }
  }
}

async function validateScheduleSubjects(subjects) {
  const seenOrders = new Set();
  for (const item of subjects) {
    const order = Number(item.order);
    if (!Number.isInteger(order) || order < 1 || order > 100) {
      throw new BadRequestError("Dars tartibi 1 dan 100 gacha bo'lgan butun son bo'lishi kerak");
    }
    if (seenOrders.has(order)) {
      throw new BadRequestError(
        `${order}-tartib bir necha marta ishlatilgan. Har bir dars tartibi takrorlanmasligi kerak`,
      );
    }
    seenOrders.add(order);
  }

  for (const item of subjects) {
    if (item.startTime || item.endTime) {
      if (!item.startTime || !item.endTime) {
        throw new BadRequestError(
          `${item.order}-dars: boshlanish va tugash vaqti ikkalasi ham kiritilishi kerak`,
        );
      }
      const timeRegex = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;
      if (!timeRegex.test(item.startTime) || !timeRegex.test(item.endTime)) {
        throw new BadRequestError(
          `${item.order}-dars: vaqt formati noto'g'ri (HH:mm formatida bo'lishi kerak)`,
        );
      }
      if (item.startTime >= item.endTime) {
        throw new BadRequestError(
          `${item.order}-dars: boshlanish vaqti tugash vaqtidan oldin bo'lishi kerak`,
        );
      }
    }

    const subject = await prisma.subject.findUnique({ where: { id: item.subject } });
    if (!subject) throw new NotFoundError(`Fan topilmadi: ${item.subject}`);

    const teacher = await prisma.user.findFirst({ where: { id: item.teacher, role: "teacher" } });
    if (!teacher) throw new NotFoundError(`O'qituvchi topilmadi: ${item.teacher}`);
  }

  const subjectsWithTimes = subjects.filter((s) => s.startTime && s.endTime);
  if (subjectsWithTimes.length > 0) {
    const sorted = [...subjectsWithTimes].sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i].endTime > sorted[i + 1].startTime) {
        throw new BadRequestError(
          `Darslar vaqtlari to'qnashib ketdi: ${sorted[i].order}-dars (${sorted[i].startTime}-${sorted[i].endTime}) va ${sorted[i + 1].order}-dars (${sorted[i + 1].startTime}-${sorted[i + 1].endTime})`,
        );
      }
    }
  }
}

// ─────────────────────────────────────────────
// Yozish (VERSIYA)
// ─────────────────────────────────────────────

/** [from, to] boshqa versiya bilan kesishmasin. */
async function assertNoOverlap(tx, classId, day, from, to, excludeId) {
  const conflict = await tx.schedule.findFirst({
    where: {
      classId,
      day,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      ...overlapWhere(from, to),
    },
    orderBy: { effectiveFrom: "asc" },
  });
  if (conflict) {
    throw new BadRequestError(
      `Bu davr mavjud jadval versiyasi bilan kesishadi ` +
        `(${formatDay(conflict.effectiveFrom)} — ${conflict.effectiveTo ? formatDay(conflict.effectiveTo) : "hozircha"}). ` +
        "Avval o'shani yoping yoki sanani to'g'rilang.",
    );
  }
}

/** `from` dan oldin boshlangan ochiq/qamragan versiyani `from-1` da yopadi. */
async function autoClosePrior(tx, classId, day, from) {
  const prior = await tx.schedule.findFirst({
    where: {
      classId,
      day,
      effectiveFrom: { lt: from },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });
  if (prior) {
    await tx.schedule.update({
      where: { id: prior.id },
      data: { effectiveTo: addDaysUtc(from, -1) },
    });
  }
}

/**
 * Bitta (sinf, kun) versiyasini yozadi:
 *   - aynan `from` dan boshlanadigan versiya bo'lsa — o'shani tahrirlaydi;
 *   - bo'lmasa — oldingi ochiq versiyani yopib, yangi versiya ochadi.
 */
async function writeDayVersion(tx, classId, day, from, to, subjects, createdBy) {
  const sameStart = await tx.schedule.findFirst({
    where: { classId, day, effectiveFrom: from },
  });

  if (sameStart) {
    await assertNoOverlap(tx, classId, day, from, to, sameStart.id);
    await tx.schedule.update({ where: { id: sameStart.id }, data: { effectiveTo: to } });
    await tx.scheduleLesson.deleteMany({ where: { scheduleId: sameStart.id } });
    await tx.scheduleLesson.createMany({ data: buildLessonRows(sameStart.id, subjects) });
    return sameStart.id;
  }

  await autoClosePrior(tx, classId, day, from);
  await assertNoOverlap(tx, classId, day, from, to, null);
  const created = await tx.schedule.create({
    data: { classId, day, effectiveFrom: from, effectiveTo: to, createdBy },
  });
  await tx.scheduleLesson.createMany({ data: buildLessonRows(created.id, subjects) });
  return created.id;
}

/** Kunni `from` dan bo'sh qoldirish: shu sanadagi versiyani o'chirib, oldingisini yopadi. */
async function clearDayFrom(tx, classId, day, from) {
  await tx.schedule.deleteMany({ where: { classId, day, effectiveFrom: from } });
  await autoClosePrior(tx, classId, day, from);
}

const VALID_DAYS = ["dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"];

const parsePeriod = (effectiveFrom, effectiveTo) => {
  const from = effectiveFrom
    ? parseDayDate(effectiveFrom, "Amal qilish sanasi")
    : todayDate();
  const to = parseOptionalDayDate(effectiveTo, "Tugash sanasi");
  if (to && to < from) {
    throw new BadRequestError("Tugash sanasi boshlanish sanasidan oldin bo'lishi mumkin emas");
  }
  return { from, to };
};

/**
 * Bitta kun uchun jadval versiyasini yaratish/tahrirlash.
 * @param {object} data - { classId, day, subjects, effectiveFrom, effectiveTo }
 */
async function createOrUpdateSchedule(data, createdBy) {
  const { classId, day, subjects } = data;

  if (!classId || !day || !subjects || subjects.length === 0) {
    throw new BadRequestError("Sinf, kun va kamida bitta dars kiritilishi kerak");
  }
  if (!VALID_DAYS.includes(day)) throw new BadRequestError(`Noto'g'ri kun: ${day}`);

  const classExists = await prisma.class.findUnique({ where: { id: classId } });
  if (!classExists) throw new NotFoundError("Sinf topilmadi");

  const { from, to } = parsePeriod(data.effectiveFrom, data.effectiveTo);

  await validateScheduleSubjects(subjects);
  await ensureNoTeacherConflicts(classId, day, subjects, from, to);

  const scheduleId = await prisma.$transaction((tx) =>
    writeDayVersion(tx, classId, day, from, to, subjects, createdBy),
  );

  const saved = await prisma.schedule.findUnique({
    where: { id: scheduleId },
    include: { lessons: true },
  });
  const { subjectMap, teacherMap } = await loadLessonRefs([saved]);
  return formatSchedule(saved, subjectMap, teacherMap);
}

/**
 * Sinf uchun butun hafta jadvalini bir amal qilish davri bilan saqlash.
 * @param {string} classId
 * @param {object} payload - { schedules: [{day, subjects}], effectiveFrom, effectiveTo }
 */
async function saveClassSchedule(classId, payload, createdBy) {
  const { schedules, effectiveFrom, effectiveTo } = payload || {};
  if (!classId || !Array.isArray(schedules)) {
    throw new BadRequestError("Sinf va dars jadvali majburiy");
  }

  const classExists = await prisma.class.findUnique({ where: { id: classId } });
  if (!classExists) throw new NotFoundError("Sinf topilmadi");

  const { from, to } = parsePeriod(effectiveFrom, effectiveTo);

  // Avval hammasini tekshiramiz (qisman saqlanish bo'lmasin)
  const seenDays = new Set();
  for (const entry of schedules) {
    const { day, subjects = [] } = entry;
    if (!VALID_DAYS.includes(day)) throw new BadRequestError(`Noto'g'ri kun: ${day}`);
    if (seenDays.has(day)) throw new BadRequestError(`${day} kuni bir necha marta yuborildi`);
    seenDays.add(day);
    if (subjects.length === 0) continue;
    await validateScheduleSubjects(subjects);
    await ensureNoTeacherConflicts(classId, day, subjects, from, to);
  }

  await prisma.$transaction(async (tx) => {
    for (const entry of schedules) {
      const { day, subjects = [] } = entry;
      if (subjects.length === 0) {
        await clearDayFrom(tx, classId, day, from);
      } else {
        await writeDayVersion(tx, classId, day, from, to, subjects, createdBy);
      }
    }
  });

  // Yangi davr boshidagi holatni qaytaramiz
  return getScheduleByClass(classId, formatDay(from));
}

async function deleteSchedule(id) {
  const schedule = await prisma.schedule.findUnique({ where: { id } });
  if (!schedule) throw new NotFoundError("Dars jadvali topilmadi");
  await prisma.schedule.delete({ where: { id } });
}

// ─────────────────────────────────────────────
// Eksport / bugungi / boshqalar (sana-aware)
// ─────────────────────────────────────────────

const DAY_ORDER = ["dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba", "yakshanba"];
const DAY_RANK = (day) => {
  const i = DAY_ORDER.indexOf(day);
  return i === -1 ? 999 : i;
};

async function getScheduleForExport(classId, asOfInput) {
  const classDoc = await prisma.class.findUnique({ where: { id: classId } });
  if (!classDoc) throw new NotFoundError("Sinf topilmadi");

  const asOf = resolveAsOf(asOfInput);
  const rawSchedules = await prisma.schedule.findMany({
    where: { classId, ...activeAsOfWhere(asOf) },
    include: { lessons: true },
    orderBy: [{ day: "asc" }, { effectiveFrom: "desc" }],
  });
  const schedules = pickActivePerDay(rawSchedules);

  const { subjectMap, teacherMap } = await loadLessonRefs(schedules);

  const sortedSchedules = schedules
    .map((schedule) => formatSchedule(schedule, subjectMap, teacherMap))
    .sort((a, b) => DAY_RANK(a.day) - DAY_RANK(b.day));

  const data = [];
  sortedSchedules.forEach((schedule) => {
    const subjects = schedule.subjects || [];
    if (subjects.length === 0) {
      data.push({ day: schedule.day, order: "-", subject: "-", teacher: "-", time: "-" });
      return;
    }
    subjects.forEach((subj, index) => {
      const teacherName = subj.teacher
        ? `${subj.teacher.firstName} ${subj.teacher.lastName || ""}`.trim()
        : "-";
      const time = subj.startTime && subj.endTime ? `${subj.startTime} - ${subj.endTime}` : "-";
      data.push({
        day: schedule.day,
        order: subj.order || index + 1,
        subject: subj.subject?.name || "-",
        teacher: teacherName,
        time,
      });
    });
  });

  return { classDoc, data };
}

/** Dars mavjud (sinf|kun) to'plami — BUGUN amaldagi versiyalar bo'yicha. */
async function getLessonDayMap() {
  const asOf = todayDate();
  const schedules = await prisma.schedule.findMany({
    where: { lessons: { some: {} }, ...activeAsOfWhere(asOf) },
    select: { classId: true, day: true },
  });
  return new Set(schedules.map((s) => `${s.classId}|${s.day}`));
}

async function getAllTodaySchedules() {
  if (isSunday()) return [];
  const dayName = getCurrentDayUz();
  const asOf = todayDate();

  const raw = await prisma.schedule.findMany({
    where: { day: dayName, ...activeAsOfWhere(asOf) },
    include: { lessons: true },
    orderBy: { effectiveFrom: "desc" },
  });
  // Har sinf uchun bitta (amaldagi) versiya
  const perClass = new Map();
  for (const s of raw) if (!perClass.has(s.classId)) perClass.set(s.classId, s);
  const schedules = [...perClass.values()];

  const { subjectMap, teacherMap } = await loadLessonRefs(schedules);
  const classIds = [...new Set(schedules.map((s) => s.classId).filter(Boolean))];
  const classes = await prisma.class.findMany({
    where: { id: { in: classIds } },
    select: { id: true, name: true },
  });
  const classMap = new Map(classes.map((c) => [c.id, { id: c.id, name: c.name }]));

  return schedules
    .map((schedule) => ({
      class: classMap.get(schedule.classId) || null,
      subjects: mapLessons(schedule.lessons, subjectMap, teacherMap).sort((a, b) => a.order - b.order),
    }))
    .sort((a, b) => (a.class?.name || "").localeCompare(b.class?.name || ""));
}

async function getMyTodaySchedule(teacherId) {
  if (isSunday()) return [];
  const dayName = getCurrentDayUz();
  const asOf = todayDate();

  const raw = await prisma.schedule.findMany({
    where: {
      day: dayName,
      lessons: { some: { teacherId: teacherId.toString() } },
      ...activeAsOfWhere(asOf),
    },
    include: { lessons: true },
    orderBy: { effectiveFrom: "desc" },
  });
  const perClass = new Map();
  for (const s of raw) if (!perClass.has(s.classId)) perClass.set(s.classId, s);
  const schedules = [...perClass.values()];

  const { subjectMap, teacherMap } = await loadLessonRefs(schedules);
  const classIds = [...new Set(schedules.map((s) => s.classId).filter(Boolean))];
  const classes = await prisma.class.findMany({
    where: { id: { in: classIds } },
    select: { id: true, name: true },
  });
  const classMap = new Map(classes.map((c) => [c.id, { id: c.id, name: c.name }]));

  return schedules
    .map((schedule) => ({
      class: classMap.get(schedule.classId) || null,
      subjects: mapLessons(schedule.lessons, subjectMap, teacherMap)
        .filter((item) => item.teacher && item.teacher.id.toString() === teacherId.toString())
        .sort((a, b) => a.order - b.order),
    }))
    .filter((schedule) => schedule.subjects.length > 0);
}

async function getClassesBySubject(subjectId) {
  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) throw new NotFoundError("Fan topilmadi");

  const asOf = todayDate();
  const schedules = await prisma.schedule.findMany({
    where: { lessons: { some: { subjectId } }, ...activeAsOfWhere(asOf) },
    select: { classId: true },
  });

  const classIds = [...new Set(schedules.map((s) => s.classId).filter(Boolean))];

  const [classes, progressList] = await Promise.all([
    prisma.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } }),
    prisma.classSubjectProgress.findMany({ where: { subjectId, classId: { in: classIds } } }),
  ]);

  const classInfoMap = new Map(classes.map((c) => [c.id, { id: c.id, name: c.name }]));
  const progressMap = new Map(progressList.map((p) => [p.classId, p.currentTopicNumber]));

  const seen = new Set();
  const classesResult = [];
  for (const cid of classIds) {
    if (seen.has(cid)) continue;
    seen.add(cid);
    classesResult.push({
      class: classInfoMap.get(cid) || null,
      subjectId,
      currentTopicNumber: progressMap.get(cid) || 1,
    });
  }
  classesResult.sort((a, b) => (a.class?.name || "").localeCompare(b.class?.name || ""));

  return { classes: classesResult, subject: { id: subject.id, name: subject.name } };
}

async function updateCurrentTopic(classId, subjectId, topicNumber) {
  if (!topicNumber || topicNumber < 1) {
    throw new BadRequestError("Mavzu raqami kamida 1 bo'lishi kerak");
  }

  const classDoc = await prisma.class.findUnique({ where: { id: classId } });
  if (!classDoc) throw new NotFoundError("Sinf topilmadi");

  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) throw new NotFoundError("Fan topilmadi");

  const topic = await prisma.topic.findFirst({ where: { subjectId, order: topicNumber } });
  if (!topic) throw new NotFoundError(`${topicNumber}-mavzu ushbu fan uchun topilmadi`);

  const progress = await prisma.classSubjectProgress.upsert({
    where: { classId_subjectId: { classId, subjectId } },
    update: { currentTopicNumber: topicNumber },
    create: { classId, subjectId, currentTopicNumber: topicNumber },
  });

  return {
    class: { id: classDoc.id, name: classDoc.name },
    subject: { id: subject.id, name: subject.name },
    currentTopicNumber: progress.currentTopicNumber,
  };
}

module.exports = {
  getScheduleByClass,
  getScheduleByDay,
  getScheduleVersions,
  createOrUpdateSchedule,
  saveClassSchedule,
  deleteSchedule,
  getScheduleForExport,
  getLessonDayMap,
  getAllTodaySchedules,
  getMyTodaySchedule,
  getClassesBySubject,
  updateCurrentTopic,
};
