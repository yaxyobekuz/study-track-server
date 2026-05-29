const TeacherAssignment = require("../models/teacherAssignment.model");
const TestSeason = require("../models/testSeason.model");
const Class = require("../models/class.model");
const Subject = require("../models/subject.model");
const User = require("../models/user.model");
const { ROLES } = require("../utils/constants");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require("../utils/errors");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");

/**
 * O'qituvchi berilgan mavsum+sinf+fan uchun biriktirilganligini tekshiradi.
 * Biriktirilmagan bo'lsa ForbiddenError tashlaydi.
 * @param {string} teacherId - o'qituvchi ID
 * @param {string} seasonId - mavsum ID
 * @param {string} classId - sinf ID
 * @param {string} subjectId - fan ID
 * @returns {Promise<object>} biriktiruv yozuvi
 */
async function assertTeacherAssigned(teacherId, seasonId, classId, subjectId) {
  const assignment = await TeacherAssignment.findOne({
    season: seasonId,
    class: classId,
    subject: subjectId,
    teacher: teacherId,
    isActive: true,
  });

  if (!assignment) {
    throw new ForbiddenError(
      "Siz ushbu mavsum, sinf va fan bo'yicha biriktirilmagansiz",
    );
  }

  return assignment;
}

/**
 * Biriktiruvlar ro'yxatini sahifalash bilan oladi.
 * @param {object} req - Express request object
 * @returns {Promise<object>} sahifalangan javob
 */
async function listAssignments(req) {
  const { page, limit, skip } = getPaginationParams(req);
  const { season, class: classId, subject, teacher } = req.query;

  const filter = {};
  if (season) filter.season = season;
  if (classId) filter.class = classId;
  if (subject) filter.subject = subject;
  if (teacher) filter.teacher = teacher;

  const [assignments, total] = await Promise.all([
    TeacherAssignment.find(filter)
      .populate("season", "name status")
      .populate("class", "name")
      .populate("subject", "name")
      .populate("teacher", "firstName lastName")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    TeacherAssignment.countDocuments(filter),
  ]);

  return formatPaginationResponse(assignments, total, page, limit);
}

/**
 * O'qituvchining biriktiruvlarini oladi (test-platform o'qituvchi UI uchun).
 * @param {string} teacherId - o'qituvchi ID
 * @param {string} [seasonId] - mavsum ID (ixtiyoriy filtr)
 * @returns {Promise<Array>} biriktiruvlar
 */
async function getAssignmentsForTeacher(teacherId, seasonId) {
  const filter = { teacher: teacherId, isActive: true };
  if (seasonId) filter.season = seasonId;

  return TeacherAssignment.find(filter)
    .populate("season", "name status startDate endDate")
    .populate("class", "name")
    .populate("subject", "name")
    .sort({ createdAt: -1 });
}

/**
 * Yangi biriktiruv yaratadi.
 * @param {object} data - biriktiruv ma'lumotlari
 * @param {string} createdBy - yaratuvchi foydalanuvchi ID
 * @returns {Promise<object>} yaratilgan biriktiruv
 */
async function createAssignment(data, createdBy) {
  const { season, class: classId, subject, teacher } = data;

  if (!season || !classId || !subject || !teacher) {
    throw new BadRequestError("Mavsum, sinf, fan va o'qituvchi majburiy");
  }

  const [seasonDoc, classDoc, subjectDoc, teacherDoc] = await Promise.all([
    TestSeason.findById(season),
    Class.findById(classId),
    Subject.findById(subject),
    User.findById(teacher),
  ]);

  if (!seasonDoc) throw new NotFoundError("Mavsum topilmadi");
  if (!classDoc) throw new NotFoundError("Sinf topilmadi");
  if (!subjectDoc) throw new NotFoundError("Fan topilmadi");
  if (!teacherDoc) throw new NotFoundError("O'qituvchi topilmadi");
  if (teacherDoc.role !== ROLES.TEACHER) {
    throw new BadRequestError("Tanlangan foydalanuvchi o'qituvchi emas");
  }

  const existing = await TeacherAssignment.findOne({
    season,
    class: classId,
    subject,
    teacher,
  });
  if (existing) {
    throw new BadRequestError("Bu biriktiruv allaqachon mavjud");
  }

  const assignment = await TeacherAssignment.create({
    season,
    class: classId,
    subject,
    teacher,
    createdBy,
  });

  return assignment;
}

/**
 * Biriktiruvni yangilaydi.
 * @param {string} id - biriktiruv ID
 * @param {object} data - yangilash ma'lumotlari
 * @returns {Promise<object>} yangilangan biriktiruv
 */
async function updateAssignment(id, data) {
  const assignment = await TeacherAssignment.findById(id);
  if (!assignment) {
    throw new NotFoundError("Biriktiruv topilmadi");
  }

  const { class: classId, subject, teacher, isActive } = data;

  if (teacher !== undefined) {
    const teacherDoc = await User.findById(teacher);
    if (!teacherDoc) throw new NotFoundError("O'qituvchi topilmadi");
    if (teacherDoc.role !== ROLES.TEACHER) {
      throw new BadRequestError("Tanlangan foydalanuvchi o'qituvchi emas");
    }
    assignment.teacher = teacher;
  }
  if (classId !== undefined) assignment.class = classId;
  if (subject !== undefined) assignment.subject = subject;
  if (isActive !== undefined) assignment.isActive = isActive;

  // Yangilangan juftlik takrorlanmasligini tekshirish
  const duplicate = await TeacherAssignment.findOne({
    _id: { $ne: id },
    season: assignment.season,
    class: assignment.class,
    subject: assignment.subject,
    teacher: assignment.teacher,
  });
  if (duplicate) {
    throw new BadRequestError("Bu biriktiruv allaqachon mavjud");
  }

  await assignment.save();
  return assignment;
}

/**
 * Biriktiruvni o'chiradi (soft delete).
 * @param {string} id - biriktiruv ID
 * @returns {Promise<void>}
 */
async function deleteAssignment(id) {
  const assignment = await TeacherAssignment.findById(id);
  if (!assignment) {
    throw new NotFoundError("Biriktiruv topilmadi");
  }

  assignment.isActive = false;
  await assignment.save();
}

module.exports = {
  assertTeacherAssigned,
  listAssignments,
  getAssignmentsForTeacher,
  createAssignment,
  updateAssignment,
  deleteAssignment,
};
