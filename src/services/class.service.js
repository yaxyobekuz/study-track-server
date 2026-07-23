const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");

// createdBy soft ref (FK emas) larni bir so'rovda yuklab, xaritalash uchun
async function attachCreators(rows) {
  const ids = [...new Set(rows.map((r) => r.createdBy).filter(Boolean))];
  if (ids.length === 0) return rows.map((r) => ({ ...r, createdBy: null }));
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true },
  });
  const map = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) => ({ ...r, createdBy: map.get(r.createdBy) || null }));
}

/**
 * Barcha sinflarni olish.
 */
async function getAllClasses() {
  const classes = await prisma.class.findMany({ orderBy: { name: "asc" } });
  return attachCreators(classes);
}

/**
 * ID bo'yicha sinfni o'quvchilari bilan olish.
 */
async function getClassById(id) {
  const classData = await prisma.class.findUnique({ where: { id } });

  if (!classData) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const [withCreator] = await attachCreators([classData]);

  const students = await prisma.user.findMany({
    where: { role: "student", classes: { some: { classId: id } } },
    omit: { password: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  return { ...withCreator, students };
}

/**
 * Yangi sinf yaratish.
 */
async function createClass(name, createdBy) {
  if (!name) {
    throw new BadRequestError("Sinf nomi majburiy");
  }

  const classData = await prisma.class.create({ data: { name, createdBy } });
  const [populated] = await attachCreators([classData]);
  return populated;
}

/**
 * Sinfni yangilash.
 */
async function updateClass(id, data) {
  const classData = await prisma.class.findUnique({ where: { id } });

  if (!classData) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const update = {};
  if (data.name) update.name = data.name;
  if (data.isActive !== undefined) update.isActive = data.isActive;

  const updated = await prisma.class.update({ where: { id }, data: update });
  const [populated] = await attachCreators([updated]);
  return populated;
}

/**
 * Sinfni o'chirish.
 */
async function deleteClass(id) {
  const classData = await prisma.class.findUnique({ where: { id } });

  if (!classData) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const studentsCount = await prisma.user.count({
    where: { role: "student", classes: { some: { classId: id } } },
  });

  if (studentsCount > 0) {
    throw new BadRequestError(
      "Bu sinfda o'quvchilar bor. Avval o'quvchilarni boshqa sinfga o'tkazing",
    );
  }

  await prisma.class.delete({ where: { id } });
}

/**
 * Mavjud o'quvchilarni sinfga qo'shish.
 */
async function addStudentsToClass(classId, studentIds) {
  const classData = await prisma.class.findUnique({ where: { id: classId } });
  if (!classData) {
    throw new NotFoundError("Sinf topilmadi");
  }

  if (!Array.isArray(studentIds) || studentIds.length === 0) {
    throw new BadRequestError("O'quvchilar tanlanmagan");
  }

  // Arxivlangan o'quvchilarga sinf biriktirib bo'lmaydi
  const archivedCount = await prisma.user.count({
    where: { id: { in: studentIds }, role: "student", isArchived: true },
  });
  if (archivedCount > 0) {
    throw new BadRequestError(
      "Arxivlangan o'quvchilarga sinf biriktirish mumkin emas",
    );
  }

  // Faol (arxivlanmagan) student'larni topib, junction'ga qo'shamiz (skipDuplicates = $addToSet)
  const eligible = await prisma.user.findMany({
    where: { id: { in: studentIds }, role: "student", isArchived: false },
    select: { id: true },
  });
  const { count } = await prisma.userClass.createMany({
    data: eligible.map((s) => ({ userId: s.id, classId })),
    skipDuplicates: true,
  });

  return { modified: count };
}

/**
 * O'quvchilarni sinfdan chiqarish (tanlangan yoki barchasini).
 */
async function removeStudentsFromClass(classId, { studentIds, all } = {}) {
  const classData = await prisma.class.findUnique({ where: { id: classId } });
  if (!classData) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const where = { classId };

  if (!all) {
    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      throw new BadRequestError("O'quvchilar tanlanmagan");
    }
    where.userId = { in: studentIds };
  }

  const result = await prisma.userClass.deleteMany({ where });
  return { modified: result.count };
}

/**
 * Tanlangan o'quvchilarni boshqa sinfga ko'chirish.
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
    prisma.class.findUnique({ where: { id: classId } }),
    prisma.class.findUnique({ where: { id: targetClassId } }),
  ]);

  if (!source) {
    throw new NotFoundError("Sinf topilmadi");
  }
  if (!target) {
    throw new NotFoundError("Maqsadli sinf topilmadi");
  }

  // Arxivlangan o'quvchilarni boshqa sinfga ko'chirib bo'lmaydi
  const archivedCount = await prisma.user.count({
    where: { id: { in: studentIds }, role: "student", isArchived: true },
  });
  if (archivedCount > 0) {
    throw new BadRequestError(
      "Arxivlangan o'quvchilarni sinfga ko'chirish mumkin emas",
    );
  }

  const eligible = await prisma.user.findMany({
    where: { id: { in: studentIds }, role: "student", isArchived: false },
    select: { id: true },
  });
  const eligibleIds = eligible.map((s) => s.id);

  // $pull + $addToSet → transaction ichida atomik
  const [, added] = await prisma.$transaction([
    prisma.userClass.deleteMany({
      where: { classId, userId: { in: eligibleIds } },
    }),
    prisma.userClass.createMany({
      data: eligibleIds.map((id) => ({ userId: id, classId: targetClassId })),
      skipDuplicates: true,
    }),
  ]);

  return { modified: added.count };
}

/**
 * Sinf o'quvchilarini Excel eksport uchun olish.
 */
async function getClassStudentsForExport(classId) {
  const classData = await prisma.class.findUnique({ where: { id: classId } });

  if (!classData) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const students = await prisma.user.findMany({
    where: { role: "student", classes: { some: { classId } } },
    include: { classes: { include: { class: { select: { name: true } } } } },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });

  const data = students.map((student) => ({
    fullName: `${student.firstName} ${student.lastName || ""}`.trim(),
    username: student.username,
    password: student.plainPassword || "N/A",
    role: "O'quvchi",
    classes:
      student.classes && student.classes.length > 0
        ? student.classes.map((c) => c.class.name).join(", ")
        : "-",
  }));

  return { classData, data };
}

/**
 * Barcha sinflarni Excel eksport uchun olish.
 */
async function getAllClassesForExport() {
  const classes = await prisma.class.findMany({ orderBy: { name: "asc" } });
  const withCreators = await attachCreators(classes);

  return withCreators.map((classItem) => ({
    name: classItem.name,
    status: classItem.isActive ? "Faol" : "Faol emas",
    createdBy: classItem.createdBy
      ? `${classItem.createdBy.firstName} ${classItem.createdBy.lastName}`
      : "-",
    createdAt: new Date(classItem.createdAt).toLocaleDateString("uz-UZ"),
  }));
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
