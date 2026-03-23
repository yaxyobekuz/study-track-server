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

  return Schedule.find({ class: classId })
    .populate("subjects.subject", "name")
    .populate("subjects.teacher", "firstName lastName")
    .sort({ day: 1 })
    .lean();
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
 * Dars jadvalini yaratish yoki yangilash.
 * @param {object} data - { classId, day, subjects, startingOrder }
 * @param {string} createdBy - yaratuvchi foydalanuvchi ID
 * @returns {Promise<object>} saqlangan jadval
 */
async function createOrUpdateSchedule(data, createdBy) {
  const { classId, day, subjects, startingOrder } = data;

  if (!classId || !day || !subjects || subjects.length === 0) {
    throw new BadRequestError("All required fields must be filled");
  }

  const classExists = await Class.findById(classId);
  if (!classExists) {
    throw new NotFoundError("Sinf topilmadi");
  }

  // Validate subjects and teachers
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

  let schedule = await Schedule.findOne({ class: classId, day });

  if (schedule) {
    schedule.subjects = subjects;
    schedule.startingOrder = startingOrder || 1;
    await schedule.save();
  } else {
    schedule = await Schedule.create({
      class: classId,
      day,
      subjects,
      startingOrder: startingOrder || 1,
      createdBy,
    });
  }

  return Schedule.findById(schedule._id)
    .populate("subjects.subject", "name")
    .populate("subjects.teacher", "firstName lastName");
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
      const displayOrder =
        (schedule.startingOrder || 1) + (subj.order || index + 1) - 1;
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
    startingOrder: schedule.startingOrder || 1,
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
        startingOrder: schedule.startingOrder || 1,
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
  deleteSchedule,
  getScheduleForExport,
  getAllTodaySchedules,
  getMyTodaySchedule,
  getClassesBySubject,
  updateCurrentTopic,
};
