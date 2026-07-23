const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { getCurrentDayUz, isSunday } = require("../helpers/date.helpers");

/**
 * ScheduleLesson child yozuvlarini eski `subjects[]` embedded shakliga xaritalaydi.
 * Berilgan subject/teacher xaritalaridan `subject` ({_id,name}) va
 * `teacher` ({_id,firstName,lastName}) objektlarini to'ldiradi.
 * @param {Array} lessons - ScheduleLesson yozuvlari
 * @param {Map} subjectMap - subjectId -> { _id, name }
 * @param {Map} teacherMap - teacherId -> { _id, firstName, lastName }
 * @returns {Array} eski shakldagi subjects massivi
 */
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

/**
 * Berilgan schedule yozuvlaridagi barcha subject va teacher'larni bitta
 * so'rovdan yuklab, xaritalarni qaytaradi (soft ref — relation YO'Q).
 * @param {Array} schedules - lessons bilan yuklangan schedule'lar
 * @returns {Promise<{subjectMap: Map, teacherMap: Map}>}
 */
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

  const subjectMap = new Map(
    subjects.map((s) => [s.id, { id: s.id, name: s.name }]),
  );
  const teacherMap = new Map(
    teachers.map((t) => [
      t.id,
      { id: t.id, firstName: t.firstName, lastName: t.lastName },
    ]),
  );

  return { subjectMap, teacherMap };
}

/**
 * Bitta schedule'ni eski shaklga (id + subjects[]) aylantiradi.
 * @param {object} schedule - lessons bilan yuklangan schedule
 * @param {Map} subjectMap
 * @param {Map} teacherMap
 * @returns {object}
 */
function formatSchedule(schedule, subjectMap, teacherMap) {
  return {
    id: schedule.id,
    class: schedule.classId,
    day: schedule.day,
    subjects: mapLessons(schedule.lessons, subjectMap, teacherMap),
    createdBy: schedule.createdBy,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  };
}

/**
 * Bir kunlik darslardan ScheduleLesson create'lar uchun ma'lumot tuzadi.
 * @param {Array} subjects - kiritilgan darslar (subject, teacher, order, ...)
 * @returns {Array} createMany uchun data (position bilan)
 */
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

/**
 * Sinf uchun barcha dars jadvallarini olish.
 * @param {string} classId - sinf ID
 * @returns {Promise<Array>} jadvallar ro'yxati
 */
async function getScheduleByClass(classId) {
  const classExists = await prisma.class.findUnique({ where: { id: classId } });
  if (!classExists) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const schedules = await prisma.schedule.findMany({
    where: { classId },
    include: { lessons: true },
    orderBy: { day: "asc" },
  });

  const { subjectMap, teacherMap } = await loadLessonRefs(schedules);

  // Sort lessons by their order number (manual order, e.g. 1, 3, 4)
  return schedules.map((schedule) => {
    const formatted = formatSchedule(schedule, subjectMap, teacherMap);
    formatted.subjects = [...formatted.subjects].sort(
      (a, b) => (a.order || 0) - (b.order || 0),
    );
    return formatted;
  });
}

/**
 * Sinf va kun uchun dars jadvalini olish.
 * @param {string} classId - sinf ID
 * @param {string} day - kun nomi
 * @returns {Promise<object>} jadval
 */
async function getScheduleByDay(classId, day) {
  const schedule = await prisma.schedule.findFirst({
    where: { classId, day },
    include: { lessons: true },
  });

  if (!schedule) {
    throw new NotFoundError("Bu kun uchun dars jadvali topilmadi");
  }

  const { subjectMap, teacherMap } = await loadLessonRefs([schedule]);
  return formatSchedule(schedule, subjectMap, teacherMap);
}

/**
 * O'qituvchining parallel to'qnashuvini tekshirish.
 * Bir o'qituvchi bir kunda bir xil tartib (order) raqamida turli sinflarda
 * band bo'lsa, xato beriladi.
 * @param {string} classId - joriy sinf ID (o'zini tekshirmaslik uchun)
 * @param {string} day - kun nomi
 * @param {Array} subjects - kiritilayotgan darslar
 * @returns {Promise<void>}
 */
async function ensureNoTeacherConflicts(classId, day, subjects) {
  const otherSchedules = await prisma.schedule.findMany({
    where: {
      day,
      classId: { not: classId },
    },
    include: { lessons: true },
  });

  // Boshqa sinflarning nomlari va band o'qituvchilar uchun refs'ni yuklaymiz
  const classIds = [
    ...new Set(otherSchedules.map((s) => s.classId).filter(Boolean)),
  ];
  const teacherIds = new Set();
  for (const schedule of otherSchedules) {
    for (const lesson of schedule.lessons || []) {
      if (lesson.teacherId) teacherIds.add(lesson.teacherId);
    }
  }

  const [classes, teachers] = await Promise.all([
    prisma.class.findMany({
      where: { id: { in: classIds } },
      select: { id: true, name: true },
    }),
    prisma.user.findMany({
      where: { id: { in: [...teacherIds] } },
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);

  const classNameMap = new Map(classes.map((c) => [c.id, c.name]));
  const teacherMap = new Map(teachers.map((t) => [t.id, t]));

  // Map: "teacherId-order" -> { className, teacherName }
  const occupied = new Map();
  for (const schedule of otherSchedules) {
    for (const item of schedule.lessons || []) {
      const teacherId = String(item.teacherId);
      const teacher = teacherMap.get(item.teacherId);
      const key = `${teacherId}-${item.order}`;
      occupied.set(key, {
        className: classNameMap.get(schedule.classId) || "",
        teacherName: teacher
          ? `${teacher.firstName} ${teacher.lastName || ""}`.trim()
          : "",
      });
    }
  }

  for (const item of subjects) {
    const teacherId = String(item.teacher);
    const conflict = occupied.get(`${teacherId}-${Number(item.order)}`);
    if (conflict) {
      throw new BadRequestError(
        `${conflict.teacherName} o'qituvchisi shu kuni ${item.order}-tartibda "${conflict.className}" sinfida band. Parallel dars belgilab bo'lmaydi`,
      );
    }
  }
}

/**
 * Bir kunlik darslar ro'yxatini tekshirish: tartib raqamlari, vaqtlar,
 * fan/o'qituvchi mavjudligi va vaqtlar to'qnashuvi.
 * O'qituvchining boshqa sinflar bilan to'qnashuvi bu yerda tekshirilmaydi.
 * @param {Array} subjects - bir kun uchun darslar
 * @returns {Promise<void>}
 */
async function validateScheduleSubjects(subjects) {
  // Validate lesson order numbers (manual 1..100, no duplicates within a day)
  const seenOrders = new Set();
  for (const item of subjects) {
    const order = Number(item.order);
    if (!Number.isInteger(order) || order < 1 || order > 100) {
      throw new BadRequestError(
        "Dars tartibi 1 dan 100 gacha bo'lgan butun son bo'lishi kerak",
      );
    }
    if (seenOrders.has(order)) {
      throw new BadRequestError(
        `${order}-tartib bir necha marta ishlatilgan. Har bir dars tartibi takrorlanmasligi kerak`,
      );
    }
    seenOrders.add(order);
  }

  // Validate times, subjects and teachers
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

    const subject = await prisma.subject.findUnique({
      where: { id: item.subject },
    });
    if (!subject) {
      throw new NotFoundError(`Fan topilmadi: ${item.subject}`);
    }

    const teacher = await prisma.user.findFirst({
      where: { id: item.teacher, role: "teacher" },
    });
    if (!teacher) {
      throw new NotFoundError(`O'qituvchi topilmadi: ${item.teacher}`);
    }
  }

  // Check for time overlaps
  const subjectsWithTimes = subjects.filter((s) => s.startTime && s.endTime);
  if (subjectsWithTimes.length > 0) {
    const sortedSubjects = [...subjectsWithTimes].sort((a, b) =>
      a.startTime.localeCompare(b.startTime),
    );
    for (let i = 0; i < sortedSubjects.length - 1; i++) {
      if (sortedSubjects[i].endTime > sortedSubjects[i + 1].startTime) {
        throw new BadRequestError(
          `Darslar vaqtlari to'qnashib ketdi: ${sortedSubjects[i].order}-dars (${sortedSubjects[i].startTime}-${sortedSubjects[i].endTime}) va ${sortedSubjects[i + 1].order}-dars (${sortedSubjects[i + 1].startTime}-${sortedSubjects[i + 1].endTime})`,
        );
      }
    }
  }
}

/**
 * Dars jadvalini yaratish yoki yangilash.
 * @param {object} data - { classId, day, subjects }
 * @param {string} createdBy - yaratuvchi foydalanuvchi ID
 * @returns {Promise<object>} saqlangan jadval
 */
async function createOrUpdateSchedule(data, createdBy) {
  const { classId, day, subjects } = data;

  if (!classId || !day || !subjects || subjects.length === 0) {
    throw new BadRequestError("All required fields must be filled");
  }

  const classExists = await prisma.class.findUnique({ where: { id: classId } });
  if (!classExists) {
    throw new NotFoundError("Sinf topilmadi");
  }

  await validateScheduleSubjects(subjects);

  // Check for teacher conflicts across other classes (same day + same order)
  await ensureNoTeacherConflicts(classId, day, subjects);

  const existing = await prisma.schedule.findFirst({
    where: { classId, day },
  });

  let scheduleId;
  if (existing) {
    scheduleId = existing.id;
    // Eski darslarni tozalab, yangilarini qayta yozamiz (position bilan)
    await prisma.scheduleLesson.deleteMany({ where: { scheduleId } });
    await prisma.scheduleLesson.createMany({
      data: buildLessonRows(scheduleId, subjects),
    });
  } else {
    const schedule = await prisma.schedule.create({
      data: { classId, day, createdBy },
    });
    scheduleId = schedule.id;
    await prisma.scheduleLesson.createMany({
      data: buildLessonRows(scheduleId, subjects),
    });
  }

  const saved = await prisma.schedule.findUnique({
    where: { id: scheduleId },
    include: { lessons: true },
  });
  const { subjectMap, teacherMap } = await loadLessonRefs([saved]);
  return formatSchedule(saved, subjectMap, teacherMap);
}

/**
 * Sinf uchun butun hafta dars jadvalini bir martada saqlash.
 * Har bir kun uchun darslar bo'lsa - yaratiladi/yangilanadi,
 * darslar bo'sh bo'lsa - o'sha kun jadvali o'chiriladi.
 * Barcha kunlar avval tekshiriladi, keyin yoziladi (qisman saqlanish bo'lmaydi).
 * @param {string} classId - sinf ID
 * @param {Array} schedules - [{ day, subjects }]
 * @param {string} createdBy - yaratuvchi foydalanuvchi ID
 * @returns {Promise<Array>} sinfning yangilangan jadvallari
 */
async function saveClassSchedule(classId, schedules, createdBy) {
  if (!classId || !Array.isArray(schedules)) {
    throw new BadRequestError("Sinf va dars jadvali majburiy");
  }

  const classExists = await prisma.class.findUnique({ where: { id: classId } });
  if (!classExists) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const validDays = [
    "dushanba",
    "seshanba",
    "chorshanba",
    "payshanba",
    "juma",
    "shanba",
  ];

  // Validate everything first so a single bad day doesn't leave a partial save
  const seenDays = new Set();
  for (const entry of schedules) {
    const { day, subjects = [] } = entry;

    if (!validDays.includes(day)) {
      throw new BadRequestError(`Noto'g'ri kun: ${day}`);
    }
    if (seenDays.has(day)) {
      throw new BadRequestError(`${day} kuni bir necha marta yuborildi`);
    }
    seenDays.add(day);

    if (subjects.length === 0) continue;

    await validateScheduleSubjects(subjects);
    await ensureNoTeacherConflicts(classId, day, subjects);
  }

  // Persist: upsert days with lessons, delete days that were cleared
  for (const entry of schedules) {
    const { day, subjects = [] } = entry;

    if (subjects.length === 0) {
      await prisma.schedule.deleteMany({ where: { classId, day } });
      continue;
    }

    const schedule = await prisma.schedule.findFirst({
      where: { classId, day },
    });
    if (schedule) {
      await prisma.scheduleLesson.deleteMany({
        where: { scheduleId: schedule.id },
      });
      await prisma.scheduleLesson.createMany({
        data: buildLessonRows(schedule.id, subjects),
      });
    } else {
      const created = await prisma.schedule.create({
        data: { classId, day, createdBy },
      });
      await prisma.scheduleLesson.createMany({
        data: buildLessonRows(created.id, subjects),
      });
    }
  }

  return getScheduleByClass(classId);
}

/**
 * Dars jadvalini o'chirish.
 * @param {string} id - jadval ID
 * @returns {Promise<void>}
 */
async function deleteSchedule(id) {
  const schedule = await prisma.schedule.findUnique({ where: { id } });
  if (!schedule) {
    throw new NotFoundError("Dars jadvali topilmadi");
  }

  await prisma.schedule.delete({ where: { id } });
}

/**
 * Sinf uchun Excel eksport ma'lumotlarini tayyorlash.
 * @param {string} classId - sinf ID
 * @returns {Promise<{classDoc: object, data: Array}>}
 */
async function getScheduleForExport(classId) {
  const classDoc = await prisma.class.findUnique({ where: { id: classId } });
  if (!classDoc) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const schedules = await prisma.schedule.findMany({
    where: { classId },
    include: { lessons: true },
    orderBy: { day: "asc" },
  });

  const { subjectMap, teacherMap } = await loadLessonRefs(schedules);

  const dayOrder = [
    "dushanba",
    "seshanba",
    "chorshanba",
    "payshanba",
    "juma",
    "shanba",
    "yakshanba",
  ];

  const dayRank = new Map(dayOrder.map((day, index) => [day, index]));

  const formattedSchedules = schedules.map((schedule) =>
    formatSchedule(schedule, subjectMap, teacherMap),
  );

  const sortedSchedules = [...formattedSchedules].sort((a, b) => {
    const rankA = dayRank.has(a.day) ? dayRank.get(a.day) : 999;
    const rankB = dayRank.has(b.day) ? dayRank.get(b.day) : 999;
    return rankA - rankB;
  });

  const data = [];

  sortedSchedules.forEach((schedule) => {
    const subjects = [...(schedule.subjects || [])].sort(
      (a, b) => (a.order || 0) - (b.order || 0),
    );

    if (subjects.length === 0) {
      data.push({
        day: schedule.day,
        order: "-",
        subject: "-",
        teacher: "-",
        time: "-",
      });
      return;
    }

    subjects.forEach((subj, index) => {
      const displayOrder = subj.order || index + 1;
      const teacherName = subj.teacher
        ? `${subj.teacher.firstName} ${subj.teacher.lastName || ""}`.trim()
        : "-";
      const time =
        subj.startTime && subj.endTime
          ? `${subj.startTime} - ${subj.endTime}`
          : "-";

      data.push({
        day: schedule.day,
        order: displayOrder,
        subject: subj.subject?.name || "-",
        teacher: teacherName,
        time,
      });
    });
  });

  return { classDoc, data };
}

/**
 * Dars mavjud (kamida bitta fan) sinf+kun juftliklari to'plamini qaytaradi.
 * Kalit formati: "<classId>|<dayName>" (masalan "65f...|dushanba").
 * Davomat cron va hisobotlarida "bu sinfda shu kuni dars bormi?" tekshiruvi uchun.
 * @returns {Promise<Set<string>>}
 */
async function getLessonDayMap() {
  const schedules = await prisma.schedule.findMany({
    where: { lessons: { some: {} } },
    select: { classId: true, day: true },
  });

  return new Set(schedules.map((s) => `${s.classId}|${s.day}`));
}

/**
 * Bugungi barcha jadvallarni olish.
 * @returns {Promise<Array>} formatlangan jadvallar
 */
async function getAllTodaySchedules() {
  const dayName = getCurrentDayUz();

  if (isSunday()) {
    return [];
  }

  const schedules = await prisma.schedule.findMany({
    where: { day: dayName },
    include: { lessons: true },
  });

  const { subjectMap, teacherMap } = await loadLessonRefs(schedules);

  // Sinf nomlarini yuklab, sinf nomi bo'yicha tartiblaymiz
  const classIds = [
    ...new Set(schedules.map((s) => s.classId).filter(Boolean)),
  ];
  const classes = await prisma.class.findMany({
    where: { id: { in: classIds } },
    select: { id: true, name: true },
  });
  const classMap = new Map(
    classes.map((c) => [c.id, { id: c.id, name: c.name }]),
  );

  const result = schedules.map((schedule) => ({
    class: classMap.get(schedule.classId) || null,
    subjects: mapLessons(schedule.lessons, subjectMap, teacherMap).sort(
      (a, b) => a.order - b.order,
    ),
  }));

  return result.sort((a, b) =>
    (a.class?.name || "").localeCompare(b.class?.name || ""),
  );
}

/**
 * O'qituvchining bugungi dars jadvalini olish.
 * @param {string} teacherId - o'qituvchi ID
 * @returns {Promise<Array>} o'qituvchining bugungi darslari
 */
async function getMyTodaySchedule(teacherId) {
  const dayName = getCurrentDayUz();

  if (isSunday()) {
    return [];
  }

  const schedules = await prisma.schedule.findMany({
    where: {
      day: dayName,
      lessons: { some: { teacherId: teacherId.toString() } },
    },
    include: { lessons: true },
  });

  const { subjectMap, teacherMap } = await loadLessonRefs(schedules);

  const classIds = [
    ...new Set(schedules.map((s) => s.classId).filter(Boolean)),
  ];
  const classes = await prisma.class.findMany({
    where: { id: { in: classIds } },
    select: { id: true, name: true },
  });
  const classMap = new Map(
    classes.map((c) => [c.id, { id: c.id, name: c.name }]),
  );

  return schedules
    .map((schedule) => {
      const teacherSubjects = mapLessons(
        schedule.lessons,
        subjectMap,
        teacherMap,
      )
        .filter(
          (item) =>
            item.teacher &&
            item.teacher.id.toString() === teacherId.toString(),
        )
        .sort((a, b) => a.order - b.order);

      return {
        class: classMap.get(schedule.classId) || null,
        subjects: teacherSubjects,
      };
    })
    .filter((schedule) => schedule.subjects.length > 0);
}

/**
 * Fan bo'yicha sinflarni va joriy mavzu raqamini olish.
 * @param {string} subjectId - fan ID
 * @returns {Promise<{classes: Array, subject: object}>}
 */
async function getClassesBySubject(subjectId) {
  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) {
    throw new NotFoundError("Fan topilmadi");
  }

  const schedules = await prisma.schedule.findMany({
    where: { lessons: { some: { subjectId } } },
    include: { lessons: true },
  });

  const classIds = [
    ...new Set(schedules.map((s) => s.classId).filter(Boolean)),
  ];

  const [classes, progressList] = await Promise.all([
    prisma.class.findMany({
      where: { id: { in: classIds } },
      select: { id: true, name: true },
    }),
    prisma.classSubjectProgress.findMany({
      where: { subjectId, classId: { in: classIds } },
    }),
  ]);

  const classInfoMap = new Map(
    classes.map((c) => [c.id, { id: c.id, name: c.name }]),
  );

  const progressMap = new Map();
  for (const p of progressList) {
    progressMap.set(p.classId, p.currentTopicNumber);
  }

  const classMap = new Map();
  for (const schedule of schedules) {
    const classId = schedule.classId;

    if (!classMap.has(classId)) {
      classMap.set(classId, {
        class: classInfoMap.get(classId) || null,
        subjectId: subjectId,
        currentTopicNumber: progressMap.get(classId) || 1,
      });
    }
  }

  const classesResult = Array.from(classMap.values()).sort((a, b) =>
    (a.class?.name || "").localeCompare(b.class?.name || ""),
  );

  return {
    classes: classesResult,
    subject: { id: subject.id, name: subject.name },
  };
}

/**
 * Sinf+fan uchun joriy mavzu raqamini yangilash.
 * @param {string} classId - sinf ID
 * @param {string} subjectId - fan ID
 * @param {number} topicNumber - mavzu raqami
 * @returns {Promise<object>} yangilangan ma'lumot
 */
async function updateCurrentTopic(classId, subjectId, topicNumber) {
  if (!topicNumber || topicNumber < 1) {
    throw new BadRequestError("Mavzu raqami kamida 1 bo'lishi kerak");
  }

  const classDoc = await prisma.class.findUnique({ where: { id: classId } });
  if (!classDoc) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) {
    throw new NotFoundError("Fan topilmadi");
  }

  const topic = await prisma.topic.findFirst({
    where: { subjectId, order: topicNumber },
  });

  if (!topic) {
    throw new NotFoundError(`${topicNumber}-mavzu ushbu fan uchun topilmadi`);
  }

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
