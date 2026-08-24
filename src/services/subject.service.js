const prisma = require("../config/prisma");
const { formatDateUz } = require("../helpers/date.helpers");
const { BadRequestError, NotFoundError } = require("../utils/errors");

// createdBy soft ref larni yuklab, xaritalash
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
 * Barcha fanlarni olish.
 */
async function getAllSubjects() {
  const subjects = await prisma.subject.findMany({ orderBy: { name: "asc" } });
  return attachCreators(subjects);
}

/**
 * Yangi fan yaratish.
 */
async function createSubject(data, createdBy) {
  const { name, description } = data;

  if (!name) {
    throw new BadRequestError("Fan nomi majburiy");
  }

  return prisma.subject.create({
    data: { name, description: description ?? null, createdBy },
  });
}

/**
 * Fanni yangilash.
 */
async function updateSubject(id, data) {
  const { name, description, isActive } = data;

  const subject = await prisma.subject.findUnique({ where: { id } });
  if (!subject) {
    throw new NotFoundError("Fan topilmadi");
  }

  const update = {};
  if (name) update.name = name;
  if (description !== undefined) update.description = description;
  if (isActive !== undefined) update.isActive = isActive;

  return prisma.subject.update({ where: { id }, data: update });
}

/**
 * Fanni o'chirish. Baholar yoki jadvallarda ishlatilsa xato qaytaradi.
 */
async function deleteSubject(id) {
  const subject = await prisma.subject.findUnique({ where: { id } });
  if (!subject) {
    throw new NotFoundError("Fan topilmadi");
  }

  const [gradesCount, schedulesCount] = await Promise.all([
    prisma.grade.count({ where: { subjectId: id } }),
    prisma.scheduleLesson.count({ where: { subjectId: id } }),
  ]);

  if (gradesCount > 0 || schedulesCount > 0) {
    throw new BadRequestError(
      "Bu fan baholarda yoki jadvallarda ishlatilmoqda. Avval ularni o'chiring.",
    );
  }

  await prisma.subject.delete({ where: { id } });
}

/**
 * Excel eksport uchun fanlar ma'lumotlarini tayyorlash.
 */
async function getSubjectsForExport() {
  const subjects = await prisma.subject.findMany({ orderBy: { name: "asc" } });
  const withCreators = await attachCreators(subjects);

  return withCreators.map((subject) => ({
    name: subject.name,
    description: subject.description || "-",
    status: subject.isActive ? "Faol" : "Faol emas",
    createdBy: subject.createdBy
      ? `${subject.createdBy.firstName} ${subject.createdBy.lastName}`
      : "-",
    createdAt: formatDateUz(subject.createdAt),
  }));
}

module.exports = {
  getAllSubjects,
  createSubject,
  updateSubject,
  deleteSubject,
  getSubjectsForExport,
};
