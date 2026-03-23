const Grade = require("../models/grade.model");
const Subject = require("../models/subject.model");
const Schedule = require("../models/schedule.model");
const { BadRequestError, NotFoundError } = require("../utils/errors");

/**
 * Barcha fanlarni olish.
 * @returns {Promise<Array>} fanlar ro'yxati
 */
async function getAllSubjects() {
  return Subject.find()
    .populate("createdBy", "firstName lastName")
    .sort({ name: 1 })
    .lean();
}

/**
 * Yangi fan yaratish.
 * @param {object} data - { name, description }
 * @param {string} createdBy - yaratuvchi foydalanuvchi ID
 * @returns {Promise<object>} yaratilgan fan
 */
async function createSubject(data, createdBy) {
  const { name, description } = data;

  if (!name) {
    throw new BadRequestError("Fan nomi majburiy");
  }

  return Subject.create({
    name,
    description,
    createdBy,
  });
}

/**
 * Fanni yangilash.
 * @param {string} id - fan ID
 * @param {object} data - { name, description, isActive }
 * @returns {Promise<object>} yangilangan fan
 */
async function updateSubject(id, data) {
  const { name, description, isActive } = data;

  const subject = await Subject.findById(id);
  if (!subject) {
    throw new NotFoundError("Fan topilmadi");
  }

  if (name) subject.name = name;
  if (description !== undefined) subject.description = description;
  if (isActive !== undefined) subject.isActive = isActive;

  await subject.save();
  return subject;
}

/**
 * Fanni o'chirish. Baholar yoki jadvallarda ishlatilsa xato qaytaradi.
 * @param {string} id - fan ID
 * @returns {Promise<void>}
 */
async function deleteSubject(id) {
  const subject = await Subject.findById(id);
  if (!subject) {
    throw new NotFoundError("Fan topilmadi");
  }

  const [gradesCount, schedulesCount] = await Promise.all([
    Grade.countDocuments({ subject: subject._id }),
    Schedule.countDocuments({ "subjects.subject": subject._id }),
  ]);

  if (gradesCount > 0 || schedulesCount > 0) {
    throw new BadRequestError(
      "Bu fan baholarda yoki jadvallarda ishlatilmoqda. Avval ularni o'chiring.",
    );
  }

  await subject.deleteOne();
}

/**
 * Excel eksport uchun fanlar ma'lumotlarini tayyorlash.
 * @returns {Promise<Array>} formatlangan fanlar ro'yxati
 */
async function getSubjectsForExport() {
  const subjects = await Subject.find()
    .populate("createdBy", "firstName lastName")
    .sort({ name: 1 })
    .lean();

  return subjects.map((subject) => ({
    name: subject.name,
    description: subject.description || "-",
    status: subject.isActive ? "Faol" : "Faol emas",
    createdBy: subject.createdBy
      ? `${subject.createdBy.firstName} ${subject.createdBy.lastName}`
      : "-",
    createdAt: new Date(subject.createdAt).toLocaleDateString("uz-UZ"),
  }));
}

module.exports = {
  getAllSubjects,
  createSubject,
  updateSubject,
  deleteSubject,
  getSubjectsForExport,
};
