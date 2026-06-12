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
 * Mavjud o'quvchilarni sinfga qo'shish.
 * @param {string} classId - sinf ID
 * @param {string[]} studentIds - o'quvchilar ID lari
 * @returns {Promise<{modified: number}>} yangilangan o'quvchilar soni
 */
async function addStudentsToClass(classId, studentIds) {
  const classData = await Class.findById(classId);
  if (!classData) {
    throw new NotFoundError("Sinf topilmadi");
  }

  if (!Array.isArray(studentIds) || studentIds.length === 0) {
    throw new BadRequestError("O'quvchilar tanlanmagan");
  }

  const result = await User.updateMany(
    { _id: { $in: studentIds }, role: "student" },
    { $addToSet: { classes: classId } },
  );

  return { modified: result.modifiedCount };
}

/**
 * O'quvchilarni sinfdan chiqarish (tanlangan yoki barchasini).
 * @param {string} classId - sinf ID
 * @param {object} options - { studentIds, all }
 * @param {string[]} [options.studentIds] - tanlangan o'quvchilar ID lari
 * @param {boolean} [options.all] - sinfdagi barcha o'quvchilarni chiqarish
 * @returns {Promise<{modified: number}>} yangilangan o'quvchilar soni
 */
async function removeStudentsFromClass(classId, { studentIds, all } = {}) {
  const classData = await Class.findById(classId);
  if (!classData) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const filter = { role: "student", classes: classId };

  if (!all) {
    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      throw new BadRequestError("O'quvchilar tanlanmagan");
    }
    filter._id = { $in: studentIds };
  }

  const result = await User.updateMany(filter, {
    $pull: { classes: classId },
  });

  return { modified: result.modifiedCount };
}

/**
 * Tanlangan o'quvchilarni boshqa sinfga ko'chirish.
 * Joriy sinfdan chiqarib, maqsadli sinfga qo'shadi.
 * @param {string} classId - joriy sinf ID
 * @param {string[]} studentIds - o'quvchilar ID lari
 * @param {string} targetClassId - maqsadli sinf ID
 * @returns {Promise<{modified: number}>} yangilangan o'quvchilar soni
 */
async function moveStudentsToClass(classId, studentIds, targetClassId) {
  if (!targetClassId) {
    throw new BadRequestError("Maqsadli sinf tanlanmagan");
  }

  if (String(targetClassId) === String(classId)) {
    throw new BadRequestError("O'quvchilar allaqachon shu sinfda");
  }

  if (!Array.isArray(studentIds) || studentIds.length === 0) {
    throw new BadRequestError("O'quvchilar tanlanmagan");
  }

  const [source, target] = await Promise.all([
    Class.findById(classId),
    Class.findById(targetClassId),
  ]);

  if (!source) {
    throw new NotFoundError("Sinf topilmadi");
  }
  if (!target) {
    throw new NotFoundError("Maqsadli sinf topilmadi");
  }

  const matchFilter = { _id: { $in: studentIds }, role: "student" };

  // $pull va $addToSet bir xil maydonga bitta amalda kelisha olmaydi - ikki bosqich
  await User.updateMany(matchFilter, { $pull: { classes: classId } });
  const result = await User.updateMany(matchFilter, {
    $addToSet: { classes: targetClassId },
  });

  return { modified: result.modifiedCount };
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
  addStudentsToClass,
  removeStudentsFromClass,
  moveStudentsToClass,
  getClassStudentsForExport,
  getAllClassesForExport,
};
