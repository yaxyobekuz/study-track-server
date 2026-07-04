const Schedule = require("../models/schedule.model");
const Class = require("../models/class.model");
const Subject = require("../models/subject.model");
const User = require("../models/user.model");
const Topic = require("../models/topic.model");
const ClassSubjectProgress = require("../models/classSubjectProgress.model");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { getCurrentDayUz, isSunday } = require("../helpers/date.helpers");

/**
 * Sinf uchun barcha dars jadvallarini olish.
 * @param {string} classId - sinf ID
 * @returns {Promise<Array>} jadvallar ro'yxati
 */
async function getScheduleByClass(classId) {
  const classExists = await Class.findById(classId);
  if (!classExists) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const schedules = await Schedule.find({ class: classId })
    .populate("subjects.subject", "name")
    .populate("subjects.teacher", "firstName lastName")
    .sort({ day: 1 })
    .lean();

  // Sort lessons by their order number (manual order, e.g. 1, 3, 4)
  return schedules.map((schedule) => ({
    ...schedule,
    subjects: [...(schedule.subjects || [])].sort(
      (a, b) => (a.order || 0) - (b.order || 0),
    ),
  }));
}

/**
 * Sinf va kun uchun dars jadvalini olish.
 * @param {string} classId - sinf ID
 * @param {string} day - kun nomi
 * @returns {Promise<object>} jadval
 */
async function getScheduleByDay(classId, day) {
  const schedule = await Schedule.findOne({ class: classId, day })
    .populate("subjects.subject", "name")
    .populate("subjects.teacher", "firstName lastName");

  if (!schedule) {
    throw new NotFoundError("Bu kun uchun dars jadvali topilmadi");
  }

  return schedule;
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
  const otherSchedules = await Schedule.find({
    day,
    class: { $ne: classId },
  })
    .populate("class", "name")
    .populate("subjects.teacher", "firstName lastName")
    .lean();

  // Map: "teacherId-order" -> { className, teacherName }
  const occupied = new Map();
  for (const schedule of otherSchedules) {
    for (const item of schedule.subjects || []) {
      const teacherId =
        item.teacher && item.teacher._id
          ? item.teacher._id.toString()
          : String(item.teacher);
      const key = `${teacherId}-${item.order}`;
      occupied.set(key, {
        className: schedule.class?.name || "",
        teacherName: item.teacher
          ? `${item.teacher.firstName} ${item.teacher.lastName || ""}`.trim()
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

    const subject = await Subject.findById(item.subject);
    if (!subject) {
      throw new NotFoundError(`Fan topilmadi: ${item.subject}`);
    }

    const teacher = await User.findOne({
      _id: item.teacher,
      role: "teacher",
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

  const classExists = await Class.findById(classId);
  if (!classExists) {
    throw new NotFoundError("Sinf topilmadi");
  }

  await validateScheduleSubjects(subjects);

  // Check for teacher conflicts across other classes (same day + same order)
  await ensureNoTeacherConflicts(classId, day, subjects);

  let schedule = await Schedule.findOne({ class: classId, day });

  if (schedule) {
    schedule.subjects = subjects;
    await schedule.save();
  } else {
    schedule = await Schedule.create({
      class: classId,
      day,
      subjects,
      createdBy,
    });
  }

  return Schedule.findById(schedule._id)
    .populate("subjects.subject", "name")
    .populate("subjects.teacher", "firstName lastName");
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

  const classExists = await Class.findById(classId);
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
      await Schedule.deleteOne({ class: classId, day });
      continue;
    }

    const schedule = await Schedule.findOne({ class: classId, day });
    if (schedule) {
      schedule.subjects = subjects;
      await schedule.save();
    } else {
      await Schedule.create({ class: classId, day, subjects, createdBy });
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
  const schedule = await Schedule.findById(id);
  if (!schedule) {
    throw new NotFoundError("Dars jadvali topilmadi");
  }

  await schedule.deleteOne();
}

/**
 * Sinf uchun Excel eksport ma'lumotlarini tayyorlash.
 * @param {string} classId - sinf ID
 * @returns {Promise<{classDoc: object, data: Array}>}
 */
async function getScheduleForExport(classId) {
  const classDoc = await Class.findById(classId);
  if (!classDoc) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const schedules = await Schedule.find({ class: classId })
    .populate("subjects.subject", "name")
    .populate("subjects.teacher", "firstName lastName")
    .sort({ day: 1 })
    .lean();

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

  const sortedSchedules = [...schedules].sort((a, b) => {
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
  const schedules = await Schedule.find(
    { "subjects.0": { $exists: true } },
    "class day",
  ).lean();

  return new Set(schedules.map((s) => `${s.class}|${s.day}`));
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

  const schedules = await Schedule.find({ day: dayName })
    .populate("class", "name")
    .populate("subjects.subject", "name")
    .populate("subjects.teacher", "firstName lastName")
    .sort({ "class.name": 1 });

  return schedules.map((schedule) => ({
    class: schedule.class,
    subjects: schedule.subjects.sort((a, b) => a.order - b.order),
  }));
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

  const schedules = await Schedule.find({
    day: dayName,
    "subjects.teacher": teacherId.toString(),
  })
    .populate("class", "name")
    .populate("subjects.subject", "name")
    .populate("subjects.teacher", "firstName lastName");

  return schedules
    .map((schedule) => {
      const teacherSubjects = schedule.subjects
        .filter(
          (item) => item.teacher._id.toString() === teacherId.toString(),
        )
        .sort((a, b) => a.order - b.order);

      return {
        class: schedule.class,
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
  const subject = await Subject.findById(subjectId);
  if (!subject) {
    throw new NotFoundError("Fan topilmadi");
  }

  const schedules = await Schedule.find({
    "subjects.subject": subjectId,
  })
    .populate("class", "name")
    .lean();

  const classIds = [...new Set(schedules.map((s) => s.class._id.toString()))];

  const progressList = await ClassSubjectProgress.find({
    subject: subjectId,
    class: { $in: classIds },
  }).lean();

  const progressMap = new Map();
  for (const p of progressList) {
    progressMap.set(p.class.toString(), p.currentTopicNumber);
  }

  const classMap = new Map();
  for (const schedule of schedules) {
    const classId = schedule.class._id.toString();

    if (!classMap.has(classId)) {
      classMap.set(classId, {
        class: schedule.class,
        subjectId: subjectId,
        currentTopicNumber: progressMap.get(classId) || 1,
      });
    }
  }

  const classes = Array.from(classMap.values()).sort((a, b) =>
    a.class.name.localeCompare(b.class.name),
  );

  return {
    classes,
    subject: { _id: subject._id, name: subject.name },
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

  const classDoc = await Class.findById(classId);
  if (!classDoc) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const subject = await Subject.findById(subjectId);
  if (!subject) {
    throw new NotFoundError("Fan topilmadi");
  }

  const topic = await Topic.findOne({
    subject: subjectId,
    order: topicNumber,
  });

  if (!topic) {
    throw new NotFoundError(`${topicNumber}-mavzu ushbu fan uchun topilmadi`);
  }

  const progress = await ClassSubjectProgress.findOneAndUpdate(
    { class: classId, subject: subjectId },
    { currentTopicNumber: topicNumber },
    { upsert: true, new: true },
  );

  return {
    class: { _id: classDoc._id, name: classDoc.name },
    subject: { _id: subject._id, name: subject.name },
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
