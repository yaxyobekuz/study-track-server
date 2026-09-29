const prisma = require("../config/prisma");
const { formatDateUz } = require("../helpers/date.helpers");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { isValidId } = require("../utils/objectId");
const classChanges = require("./studentClassChange.service");

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

  // O'quvchi soni — BITTA guruhlangan so'rov bilan (har sinf uchun alohida
  // `count` qilsak, 25 sinfda 25 ta so'rov ketardi).
  //
  // Arxivlangan o'quvchi sanalmaydi: u maktabda yo'q, ya'ni sinf
  // ro'yxatidagi raqam haqiqiy holatni ko'rsatishi kerak.
  const counts = await prisma.userClass.groupBy({
    by: ["classId"],
    where: { user: { role: "student", isArchived: false } },
    _count: { userId: true },
  });
  const countMap = new Map(counts.map((c) => [c.classId, c._count.userId]));

  const withCreators = await attachCreators(classes);
  return withCreators.map((item) => ({
    ...item,
    studentCount: countMap.get(item.id) ?? 0,
  }));
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
 * Sig'imni normallashtiradi: bo'sh/`null` → `null` (belgilanmagan), aks holda
 * manfiy bo'lmagan butun son. Yaroqsiz qiymatni JIM qabul qilmaydi.
 */
function normalizeCapacity(value) {
  if (value == null || value === "") return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new BadRequestError("Sig'im manfiy bo'lmagan butun son bo'lishi kerak");
  }
  return n;
}

/**
 * Yangi sinf yaratish.
 */
async function createClass(name, createdBy, capacity) {
  if (!name) {
    throw new BadRequestError("Sinf nomi majburiy");
  }

  const classData = await prisma.class.create({
    data: { name, createdBy, capacity: normalizeCapacity(capacity) },
  });
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
  // `capacity` maydoni yuborilgan bo'lsa (bo'sh string ham) — yangilanadi;
  // yuborilmasa tegilmaydi.
  if (data.capacity !== undefined) update.capacity = normalizeCapacity(data.capacity);

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

  // Tyutor guruhi oylik tarixiga ishora qiladi — sinf jimgina yo'qolmasin
  const tutorGroupsCount = await prisma.tutorGroup.count({ where: { classId: id } });
  if (tutorGroupsCount > 0) {
    throw new BadRequestError(
      "Bu sinf tyutorga guruh sifatida biriktirilgan (yoki biriktirilgan edi). " +
        "Sinfni o'chirish o'rniga uni faol emas qiling",
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

// Ro'yxat sahifada eskirgan bo'lsa (boshqa oynada allaqachon ko'chirilgan /
// chiqarilgan) — jim "0 ta" o'rniga aniq xabar
const NOT_IN_CLASS_MESSAGE =
  "Tanlangan o'quvchilar bu sinfda topilmadi. Ro'yxatni yangilab, qayta urinib ko'ring";

/** Tanlangan id lar — takrorsiz, matn ko'rinishida. Bo'sh ro'yxat rad etiladi. */
function normalizeStudentIds(studentIds) {
  if (!Array.isArray(studentIds) || studentIds.length === 0) {
    throw new BadRequestError("O'quvchilar tanlanmagan");
  }
  return [...new Set(studentIds.map(String))];
}

/**
 * O'quvchilarni sinfdan chiqarish (tanlangan yoki barchasini).
 *
 * ⚠️ SABAB MAJBURIY va har o'quvchi uchun jurnalga yoziladi
 * (`studentClassChange.service.js`) — a'zolik bilan BITTA tranzaksiyada.
 *
 * "Barchasi" — amal boshlangan paytdagi a'zolar: oraliqda qo'shilgan
 * o'quvchi admin ko'rmagan ro'yxat bilan sababsiz chiqib ketmasligi uchun
 * faqat qulflangan to'plam chiqariladi.
 *
 * @param {string} classId
 * @param {{ studentIds?: string[], all?: boolean, reason?: string }} payload
 * @param {{ actorId: string, source?: string }} options
 */
async function removeStudentsFromClass(
  classId,
  { studentIds, all, reason } = {},
  { actorId, source = classChanges.CHANGE_SOURCES.CLASS_PAGE } = {},
) {
  const classData = await prisma.class.findUnique({ where: { id: classId } });
  if (!classData) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const ids = all ? null : normalizeStudentIds(studentIds);
  const text = classChanges.normalizeReason(reason);

  const candidates = await prisma.userClass.findMany({
    where: { classId, ...(ids ? { userId: { in: ids } } : {}) },
    select: { userId: true },
  });
  if (candidates.length === 0) {
    throw new BadRequestError(NOT_IN_CLASS_MESSAGE);
  }
  const candidateIds = candidates.map((c) => c.userId);

  const removedIds = await prisma.$transaction(async (tx) => {
    await classChanges.lockStudentClasses(tx, candidateIds);

    // Qulf ostida qayta o'qiladi — oraliqda boshqa amal chiqargan bo'lishi mumkin
    const present = await tx.userClass.findMany({
      where: { classId, userId: { in: candidateIds } },
      select: { userId: true },
    });
    const presentIds = present.map((p) => p.userId);
    if (presentIds.length === 0) return [];

    await tx.userClass.deleteMany({
      where: { classId, userId: { in: presentIds } },
    });
    await classChanges.recordClassChanges(
      tx,
      presentIds.map((studentId) => ({
        studentId,
        fromClassIds: [classId],
        toClassIds: [],
      })),
      { reason: text, source, actorId },
    );
    return presentIds;
  });

  if (removedIds.length === 0) {
    throw new BadRequestError(NOT_IN_CLASS_MESSAGE);
  }
  return { modified: removedIds.length };
}

/**
 * Tanlangan o'quvchilarni boshqa sinfga ko'chirish.
 *
 * ⚠️ SABAB MAJBURIY — `removeStudentsFromClass` bilan bir xil jurnal.
 *
 * ⚠️ Faqat HAQIQATAN manba sinfda turgan o'quvchi ko'chiriladi. Ilgari
 * a'zolik tekshirilmasdi: eskirgan tanlovdagi, manba sinfda yo'q o'quvchi
 * maqsad sinfga jimgina QO'SHILIB ketardi.
 *
 * Maqsad sinfda allaqachon bor o'quvchi faqat manbadan chiqadi, lekin
 * jurnalda "ko'chirildi" bo'lib yoziladi — admin qarori aynan shu edi.
 *
 * @param {string} classId - manba sinf
 * @param {{ studentIds: string[], targetClassId: string, reason: string }} payload
 * @param {{ actorId: string, source?: string }} options
 */
async function moveStudentsToClass(
  classId,
  { studentIds, targetClassId, reason } = {},
  { actorId, source = classChanges.CHANGE_SOURCES.CLASS_PAGE } = {},
) {
  if (!targetClassId) {
    throw new BadRequestError("Maqsadli sinf tanlanmagan");
  }
  if (!isValidId(String(targetClassId))) {
    throw new BadRequestError("Noto'g'ri maqsadli sinf formati");
  }

  if (String(targetClassId) === String(classId)) {
    throw new BadRequestError("O'quvchilar allaqachon shu sinfda");
  }

  const ids = normalizeStudentIds(studentIds);
  const text = classChanges.normalizeReason(reason);

  const [sourceClass, targetClass] = await Promise.all([
    prisma.class.findUnique({ where: { id: classId } }),
    prisma.class.findUnique({ where: { id: targetClassId } }),
  ]);

  if (!sourceClass) {
    throw new NotFoundError("Sinf topilmadi");
  }
  if (!targetClass) {
    throw new NotFoundError("Maqsadli sinf topilmadi");
  }

  // Arxivlangan o'quvchilarni boshqa sinfga ko'chirib bo'lmaydi
  const archivedCount = await prisma.user.count({
    where: { id: { in: ids }, role: "student", isArchived: true },
  });
  if (archivedCount > 0) {
    throw new BadRequestError(
      "Arxivlangan o'quvchilarni sinfga ko'chirish mumkin emas",
    );
  }

  const movedIds = await prisma.$transaction(async (tx) => {
    await classChanges.lockStudentClasses(tx, ids);

    // Qulf ostida: faqat hozir manba sinfda turgan faol o'quvchilar
    const present = await tx.userClass.findMany({
      where: {
        classId,
        userId: { in: ids },
        user: { role: "student", isArchived: false },
      },
      select: { userId: true },
    });
    const presentIds = present.map((p) => p.userId);
    if (presentIds.length === 0) return [];

    await tx.userClass.deleteMany({
      where: { classId, userId: { in: presentIds } },
    });
    await tx.userClass.createMany({
      data: presentIds.map((userId) => ({ userId, classId: targetClassId })),
      skipDuplicates: true,
    });
    await classChanges.recordClassChanges(
      tx,
      presentIds.map((studentId) => ({
        studentId,
        fromClassIds: [classId],
        toClassIds: [targetClassId],
      })),
      { reason: text, source, actorId },
    );
    return presentIds;
  });

  if (movedIds.length === 0) {
    throw new BadRequestError(NOT_IN_CLASS_MESSAGE);
  }
  return { modified: movedIds.length };
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
    createdAt: formatDateUz(classItem.createdAt),
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
