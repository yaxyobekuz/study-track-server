const Class = require("../models/class.model");
const User = require("../models/user.model");
const { BadRequestError, NotFoundError } = require("../utils/errors");

/**
 * Barcha sinflarni olish.
 * @returns {Promise<Array>} sinflar ro'yxati
 */
async function getAllClasses() {
  const classes = await Class.find()
    .populate("createdBy", "firstName lastName")
    .sort({ name: 1 })
    .lean();

  return classes;
}

/**
 * ID bo'yicha sinfni o'quvchilari bilan olish.
 * @param {string} id - sinf ID
 * @returns {Promise<object>} sinf ma'lumotlari va o'quvchilar
 */
async function getClassById(id) {
  const classData = await Class.findById(id).populate(
    "createdBy",
    "firstName lastName",
  );

  if (!classData) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const students = await User.find({
    classes: id,
    role: "student",
  })
    .select("-password")
    .sort({ lastName: 1, firstName: 1 });

  return {
    ...classData.toObject(),
    students,
  };
}

/**
 * Yangi sinf yaratish.
 * @param {string} name - sinf nomi
 * @param {string} createdBy - yaratuvchi foydalanuvchi ID
 * @returns {Promise<object>} yaratilgan sinf
 */
async function createClass(name, createdBy) {
  if (!name) {
    throw new BadRequestError("Sinf nomi majburiy");
  }

  const classData = await Class.create({
    name,
    createdBy,
  });

  const populatedClass = await Class.findById(classData._id).populate(
    "createdBy",
    "firstName lastName",
  );

  return populatedClass;
}

/**
 * Sinfni yangilash.
 * @param {string} id - sinf ID
 * @param {object} data - yangilash ma'lumotlari
 * @param {string} [data.name] - sinf nomi
 * @param {boolean} [data.isActive] - faollik holati
 * @returns {Promise<object>} yangilangan sinf
 */
async function updateClass(id, data) {
  const classData = await Class.findById(id);

  if (!classData) {
    throw new NotFoundError("Sinf topilmadi");
  }

  if (data.name) classData.name = data.name;
  if (data.isActive !== undefined) classData.isActive = data.isActive;

  await classData.save();

  const updatedClass = await Class.findById(classData._id).populate(
    "createdBy",
    "firstName lastName",
  );

  return updatedClass;
}

/**
 * Sinfni o'chirish.
 * @param {string} id - sinf ID
 * @returns {Promise<void>}
 */
async function deleteClass(id) {
  const classData = await Class.findById(id);

  if (!classData) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const studentsCount = await User.countDocuments({
    classes: id,
    role: "student",
  });

  if (studentsCount > 0) {
    throw new BadRequestError(
      "Bu sinfda o'quvchilar bor. Avval o'quvchilarni boshqa sinfga o'tkazing",
    );
  }

  await classData.deleteOne();
}

/**
 * Sinf o'quvchilarini Excel eksport uchun olish.
 * @param {string} classId - sinf ID
 * @returns {Promise<{classData: object, data: Array}>} sinf va formatlangan o'quvchilar
 */
async function getClassStudentsForExport(classId) {
  const classData = await Class.findById(classId);

  if (!classData) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const students = await User.find({
    classes: classId,
    role: "student",
  })
    .populate("classes", "name")
    .select("+plainPassword")
    .sort({ firstName: 1, lastName: 1 });

  const data = students.map((student) => ({
    fullName: `${student.firstName} ${student.lastName || ""}`.trim(),
    username: student.username,
    password: student.plainPassword || "N/A",
    role: "O'quvchi",
    classes:
      student.classes && student.classes.length > 0
        ? student.classes.map((c) => c.name).join(", ")
        : "-",
  }));

  return { classData, data };
}

/**
 * Barcha sinflarni Excel eksport uchun olish.
 * @returns {Promise<Array>} formatlangan sinflar ro'yxati
 */
async function getAllClassesForExport() {
  const classes = await Class.find()
    .populate("createdBy", "firstName lastName")
    .sort({ name: 1 })
    .lean();

  const data = classes.map((classItem) => ({
    name: classItem.name,
    status: classItem.isActive ? "Faol" : "Faol emas",
    createdBy: classItem.createdBy
      ? `${classItem.createdBy.firstName} ${classItem.createdBy.lastName}`
      : "-",
    createdAt: new Date(classItem.createdAt).toLocaleDateString("uz-UZ"),
  }));

  return data;
}

module.exports = {
  getAllClasses,
  getClassById,
  createClass,
  updateClass,
  deleteClass,
  getClassStudentsForExport,
  getAllClassesForExport,
};
