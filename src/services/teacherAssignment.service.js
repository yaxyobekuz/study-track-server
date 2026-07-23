const prisma = require("../config/prisma");
const { ROLES } = require("../utils/constants");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require("../utils/errors");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");

/**
 * Biriktiruvlarning soft ref maydonlarini (season/class/subject/teacher — FK emas)
 * qo'lda yuklab, eski populate shakliga xaritalaydi.
 * @param {Array} assignments - TeacherAssignment yozuvlari
 * @param {object} [options] - { seasonSelect } — season uchun qo'shimcha maydonlar
 * @returns {Promise<Array>} refs to'ldirilgan biriktiruvlar
 */
async function attachRefs(assignments, options = {}) {
  const { seasonExtra = false } = options;

  const seasonIds = [
    ...new Set(assignments.map((a) => a.seasonId).filter(Boolean)),
  ];
  const classIds = [
    ...new Set(assignments.map((a) => a.classId).filter(Boolean)),
  ];
  const subjectIds = [
    ...new Set(assignments.map((a) => a.subjectId).filter(Boolean)),
  ];
  const teacherIds = [
    ...new Set(assignments.map((a) => a.teacherId).filter(Boolean)),
  ];

  const seasonSelect = seasonExtra
    ? { id: true, name: true, status: true, startDate: true, endDate: true }
    : { id: true, name: true, status: true };

  const [seasons, classes, subjects, teachers] = await Promise.all([
    prisma.testSeason.findMany({
      where: { id: { in: seasonIds } },
      select: seasonSelect,
    }),
    prisma.class.findMany({
      where: { id: { in: classIds } },
      select: { id: true, name: true },
    }),
    prisma.subject.findMany({
      where: { id: { in: subjectIds } },
      select: { id: true, name: true },
    }),
    prisma.user.findMany({
      where: { id: { in: teacherIds } },
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);

  const seasonMap = new Map(
    seasons.map((s) => [
      s.id,
      seasonExtra
        ? {
            id: s.id,
            name: s.name,
            status: s.status,
            startDate: s.startDate,
            endDate: s.endDate,
          }
        : { id: s.id, name: s.name, status: s.status },
    ]),
  );
  const classMap = new Map(
    classes.map((c) => [c.id, { id: c.id, name: c.name }]),
  );
  const subjectMap = new Map(
    subjects.map((s) => [s.id, { id: s.id, name: s.name }]),
  );
  const teacherMap = new Map(
    teachers.map((t) => [
      t.id,
      { id: t.id, firstName: t.firstName, lastName: t.lastName },
    ]),
  );

  return assignments.map((a) => ({
    ...a,
    season: seasonMap.get(a.seasonId) || null,
    class: classMap.get(a.classId) || null,
    subject: subjectMap.get(a.subjectId) || null,
    teacher: teacherMap.get(a.teacherId) || null,
  }));
}

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
  const assignment = await prisma.teacherAssignment.findFirst({
    where: {
      seasonId,
      classId,
      subjectId,
      teacherId,
      isActive: true,
    },
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
  if (season) filter.seasonId = season;
  if (classId) filter.classId = classId;
  if (subject) filter.subjectId = subject;
  if (teacher) filter.teacherId = teacher;

  const [assignments, total] = await Promise.all([
    prisma.teacherAssignment.findMany({
      where: filter,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.teacherAssignment.count({ where: filter }),
  ]);

  const withRefs = await attachRefs(assignments);

  return formatPaginationResponse(withRefs, total, page, limit);
}

/**
 * O'qituvchining biriktiruvlarini oladi (test-platform o'qituvchi UI uchun).
 * @param {string} teacherId - o'qituvchi ID
 * @param {string} [seasonId] - mavsum ID (ixtiyoriy filtr)
 * @returns {Promise<Array>} biriktiruvlar
 */
async function getAssignmentsForTeacher(teacherId, seasonId) {
  const filter = { teacherId, isActive: true };
  if (seasonId) filter.seasonId = seasonId;

  const assignments = await prisma.teacherAssignment.findMany({
    where: filter,
    orderBy: { createdAt: "desc" },
  });

  // season uchun startDate/endDate ham kerak; class/subject faqat name.
  const withRefs = await attachRefs(assignments, { seasonExtra: true });

  // Bu yerda teacher populate qilinmaydi (eski kod ham qilmagan), olib tashlaymiz.
  return withRefs.map(({ teacher, ...rest }) => rest);
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
    prisma.testSeason.findUnique({ where: { id: season } }),
    prisma.class.findUnique({ where: { id: classId } }),
    prisma.subject.findUnique({ where: { id: subject } }),
    prisma.user.findUnique({ where: { id: teacher } }),
  ]);

  if (!seasonDoc) throw new NotFoundError("Mavsum topilmadi");
  if (!classDoc) throw new NotFoundError("Sinf topilmadi");
  if (!subjectDoc) throw new NotFoundError("Fan topilmadi");
  if (!teacherDoc) throw new NotFoundError("O'qituvchi topilmadi");
  if (teacherDoc.role !== ROLES.TEACHER) {
    throw new BadRequestError("Tanlangan foydalanuvchi o'qituvchi emas");
  }

  const existing = await prisma.teacherAssignment.findFirst({
    where: {
      seasonId: season,
      classId,
      subjectId: subject,
      teacherId: teacher,
    },
  });
  if (existing) {
    throw new BadRequestError("Bu biriktiruv allaqachon mavjud");
  }

  const assignment = await prisma.teacherAssignment.create({
    data: {
      seasonId: season,
      classId,
      subjectId: subject,
      teacherId: teacher,
      createdBy,
    },
  });

  return assignment;
}

/**
 * Bir nechta biriktiruvni bittada yaratadi (bulk).
 * Dublikatlar va yaroqsiz yozuvlar o'tkazib yuboriladi va hisobotda qaytariladi.
 * @param {object} data - { season, items: [{ class, subject, teacher }] }
 * @param {string} createdBy - yaratuvchi foydalanuvchi ID
 * @returns {Promise<object>} { createdCount, skippedCount, created, skipped }
 */
async function bulkCreateAssignments(data, createdBy) {
  const { season, items } = data;

  if (!season) {
    throw new BadRequestError("Mavsum majburiy");
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new BadRequestError("Kamida bitta biriktiruv kerak");
  }

  const seasonDoc = await prisma.testSeason.findUnique({
    where: { id: season },
  });
  if (!seasonDoc) throw new NotFoundError("Mavsum topilmadi");

  // Shaklni tekshirib, batch ichidagi dublikatlarni olib tashlash
  const seen = new Set();
  const normalized = [];
  for (const it of items) {
    const classId = it.class;
    const subject = it.subject;
    const teacher = it.teacher;
    if (!classId || !subject || !teacher) {
      throw new BadRequestError(
        "Har bir biriktiruvda sinf, fan va o'qituvchi majburiy",
      );
    }
    const key = `${classId}|${subject}|${teacher}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ class: classId, subject, teacher });
  }

  // Havola qilingan ID'lar mavjudligini bitta so'rovda tekshirish
  const classIds = [...new Set(normalized.map((n) => n.class))];
  const subjectIds = [...new Set(normalized.map((n) => n.subject))];
  const teacherIds = [...new Set(normalized.map((n) => n.teacher))];

  const [classes, subjects, teachers, existing] = await Promise.all([
    prisma.class.findMany({
      where: { id: { in: classIds } },
      select: { id: true },
    }),
    prisma.subject.findMany({
      where: { id: { in: subjectIds } },
      select: { id: true },
    }),
    prisma.user.findMany({
      where: { id: { in: teacherIds } },
      select: { id: true, role: true },
    }),
    prisma.teacherAssignment.findMany({
      where: { seasonId: season },
      select: { classId: true, subjectId: true, teacherId: true },
    }),
  ]);

  const classSet = new Set(classes.map((c) => String(c.id)));
  const subjectSet = new Set(subjects.map((s) => String(s.id)));
  const teacherRole = new Map(teachers.map((t) => [String(t.id), t.role]));
  const existingSet = new Set(
    existing.map((e) => `${e.classId}|${e.subjectId}|${e.teacherId}`),
  );

  const toCreate = [];
  const skipped = [];

  for (const n of normalized) {
    if (!classSet.has(String(n.class))) {
      skipped.push({ ...n, reason: "Sinf topilmadi" });
    } else if (!subjectSet.has(String(n.subject))) {
      skipped.push({ ...n, reason: "Fan topilmadi" });
    } else if (!teacherRole.has(String(n.teacher))) {
      skipped.push({ ...n, reason: "O'qituvchi topilmadi" });
    } else if (teacherRole.get(String(n.teacher)) !== ROLES.TEACHER) {
      skipped.push({ ...n, reason: "Foydalanuvchi o'qituvchi emas" });
    } else if (existingSet.has(`${n.class}|${n.subject}|${n.teacher}`)) {
      skipped.push({ ...n, reason: "Allaqachon mavjud" });
    } else {
      toCreate.push({
        seasonId: season,
        classId: n.class,
        subjectId: n.subject,
        teacherId: n.teacher,
        createdBy,
      });
    }
  }

  let created = [];
  if (toCreate.length > 0) {
    // createMany count qaytaradi; eski insertMany yaratilgan yozuvlarni
    // qaytargani uchun yaratilgach qayta o'qib beramiz (createdCount saqlanadi).
    await prisma.teacherAssignment.createMany({
      data: toCreate,
      skipDuplicates: true,
    });
    const keys = new Set(
      toCreate.map((t) => `${t.classId}|${t.subjectId}|${t.teacherId}`),
    );
    const fetched = await prisma.teacherAssignment.findMany({
      where: {
        seasonId: season,
        classId: { in: [...new Set(toCreate.map((t) => t.classId))] },
        subjectId: { in: [...new Set(toCreate.map((t) => t.subjectId))] },
        teacherId: { in: [...new Set(toCreate.map((t) => t.teacherId))] },
      },
    });
    created = fetched.filter((f) =>
      keys.has(`${f.classId}|${f.subjectId}|${f.teacherId}`),
    );
  }

  return {
    createdCount: created.length,
    skippedCount: skipped.length,
    created,
    skipped,
  };
}

/**
 * Biriktiruvni yangilaydi.
 * @param {string} id - biriktiruv ID
 * @param {object} data - yangilash ma'lumotlari
 * @returns {Promise<object>} yangilangan biriktiruv
 */
async function updateAssignment(id, data) {
  const assignment = await prisma.teacherAssignment.findUnique({
    where: { id },
  });
  if (!assignment) {
    throw new NotFoundError("Biriktiruv topilmadi");
  }

  const { class: classId, subject, teacher, isActive } = data;

  const update = {};
  let nextClassId = assignment.classId;
  let nextSubjectId = assignment.subjectId;
  let nextTeacherId = assignment.teacherId;

  if (teacher !== undefined) {
    const teacherDoc = await prisma.user.findUnique({ where: { id: teacher } });
    if (!teacherDoc) throw new NotFoundError("O'qituvchi topilmadi");
    if (teacherDoc.role !== ROLES.TEACHER) {
      throw new BadRequestError("Tanlangan foydalanuvchi o'qituvchi emas");
    }
    update.teacherId = teacher;
    nextTeacherId = teacher;
  }
  if (classId !== undefined) {
    update.classId = classId;
    nextClassId = classId;
  }
  if (subject !== undefined) {
    update.subjectId = subject;
    nextSubjectId = subject;
  }
  if (isActive !== undefined) update.isActive = isActive;

  // Yangilangan juftlik takrorlanmasligini tekshirish
  const duplicate = await prisma.teacherAssignment.findFirst({
    where: {
      id: { not: id },
      seasonId: assignment.seasonId,
      classId: nextClassId,
      subjectId: nextSubjectId,
      teacherId: nextTeacherId,
    },
  });
  if (duplicate) {
    throw new BadRequestError("Bu biriktiruv allaqachon mavjud");
  }

  return prisma.teacherAssignment.update({ where: { id }, data: update });
}

/**
 * Biriktiruvni o'chiradi (soft delete).
 * @param {string} id - biriktiruv ID
 * @returns {Promise<void>}
 */
async function deleteAssignment(id) {
  const assignment = await prisma.teacherAssignment.findUnique({
    where: { id },
  });
  if (!assignment) {
    throw new NotFoundError("Biriktiruv topilmadi");
  }

  await prisma.teacherAssignment.update({
    where: { id },
    data: { isActive: false },
  });
}

module.exports = {
  assertTeacherAssigned,
  listAssignments,
  getAssignmentsForTeacher,
  createAssignment,
  bulkCreateAssignments,
  updateAssignment,
  deleteAssignment,
};
