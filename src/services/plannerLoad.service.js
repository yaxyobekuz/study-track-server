/**
 * REJALASHTIRISH — HAFTALIK YUKLAMA ("Asosiy" tab).
 *
 * Bitta satr = o'qituvchi × fan. Satrning O'ZI bu jadvaldan emas,
 * `user_subjects` dan chiqadi: o'qituvchiga fan biriktirilishi bilan satr
 * paydo bo'ladi, ya'ni "satr qo'shish" tugmasi kerak emas va ikkita ro'yxatni
 * sinxron tutish muammosi tug'ilmaydi.
 *
 * Soat HAR BIR SINF uchun: `weeklyHours` standart, sinfdagi qiymat esa
 * istisno. Shu sababli "4 soat × 3 sinf" ni kiritish bitta raqam.
 */

const prisma = require("../config/prisma");
const { BadRequestError } = require("../utils/errors");
const { getGrid } = require("./plannerSettings.service");
const { buildDemands } = require("../helpers/planner.helpers");

const TEACHER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  fullName: true,
  role: true,
};

// Xodimlar (o'quvchi emas, arxivlanmagan) — fanlari bilan.
//
// ⚠️ `isActive` ATAYLAB filtrlanmaydi: logini vaqtincha o'chirilgan xodim ham
// reja tuzilayotgan paytda o'qituvchi bo'lib turishi mumkin. Arxivlangan esa
// maktabdan ketgan — u rejaga umuman kirmaydi.
async function loadTeachers() {
  return prisma.user.findMany({
    where: { role: { not: "student" }, isArchived: false },
    select: {
      ...TEACHER_SELECT,
      subjects: { include: { subject: { select: { id: true, name: true } } } },
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
}

/**
 * Yuklama satrlari — xom shakl (generator va preflight uchun).
 *
 * Faqat HAQIQIY satrlar qaytadi: `user_subjects` da yo'q juftlik (fan
 * o'qituvchidan olib tashlangan) va endi mavjud bo'lmagan sinf tashlanadi.
 * Qatorlarning o'zi O'CHIRILMAYDI — fan qaytarilsa soatlar joyida turadi.
 *
 * @returns {Promise<Array>}
 */
async function getRawLoads() {
  const [loads, links, classes] = await Promise.all([
    prisma.plannerLoad.findMany({ include: { classes: true } }),
    prisma.userSubject.findMany({ select: { userId: true, subjectId: true } }),
    prisma.class.findMany({ select: { id: true } }),
  ]);

  const allowed = new Set(links.map((l) => `${l.userId}|${l.subjectId}`));
  const classIds = new Set(classes.map((c) => c.id));

  return loads
    .filter((load) => allowed.has(`${load.teacherId}|${load.subjectId}`))
    .map((load) => ({
      teacherId: load.teacherId,
      subjectId: load.subjectId,
      weeklyHours: load.weeklyHours,
      classes: load.classes
        .filter((c) => classIds.has(c.classId))
        .map((c) => ({ classId: c.classId, weeklyHours: c.weeklyHours })),
    }));
}

/**
 * "Asosiy" tabning butun ma'lumoti — bitta so'rovda.
 *
 * Frontend hech narsa hisoblamaydi: jami soat, sig'im va ogohlantirishlar shu
 * yerda tayyorlanadi, aks holda bir xil formula ikki repoda ikki marta
 * yozilardi va ular albatta ajralib ketardi.
 */
async function getLoads() {
  const [grid, teachers, loads, classes, busySlots] = await Promise.all([
    getGrid(),
    loadTeachers(),
    prisma.plannerLoad.findMany({ include: { classes: true } }),
    prisma.class.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.plannerBusySlot.groupBy({ by: ["teacherId"], _count: { _all: true } }),
  ]);

  const slotsPerWeek = grid.days.length * grid.orders.length;
  const classMap = new Map(classes.map((c) => [c.id, c]));
  const loadMap = new Map(loads.map((l) => [`${l.teacherId}|${l.subjectId}`, l]));
  const busyMap = new Map(busySlots.map((b) => [b.teacherId, b._count._all]));

  const rows = [];
  const teachersWithoutSubjects = [];

  for (const teacher of teachers) {
    if (!teacher.subjects.length) {
      teachersWithoutSubjects.push({ id: teacher.id, fullName: teacher.fullName });
      continue;
    }

    for (const link of teacher.subjects) {
      const load = loadMap.get(`${teacher.id}|${link.subject.id}`);
      const weeklyHours = load?.weeklyHours ?? 0;

      const rowClasses = (load?.classes ?? [])
        .filter((c) => classMap.has(c.classId))
        .map((c) => ({
          id: c.classId,
          name: classMap.get(c.classId).name,
          weeklyHours: c.weeklyHours ?? weeklyHours,
          isOverride: c.weeklyHours !== null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const total = rowClasses.reduce((sum, c) => sum + c.weeklyHours, 0);

      const warnings = [];
      if (rowClasses.length === 0) warnings.push("Sinf tanlanmagan");
      else if (total === 0) warnings.push("Soat kiritilmagan");

      rows.push({
        teacher: { id: teacher.id, fullName: teacher.fullName },
        subject: { id: link.subject.id, name: link.subject.name },
        weeklyHours,
        classes: rowClasses,
        total,
        warnings,
      });
    }
  }

  const teacherTotals = new Map();
  for (const row of rows) {
    const entry = teacherTotals.get(row.teacher.id) || { total: 0 };
    entry.total += row.total;
    teacherTotals.set(row.teacher.id, entry);
  }

  const classTotals = new Map(
    classes.map((c) => [c.id, { id: c.id, name: c.name, demand: 0 }]),
  );
  for (const row of rows) {
    for (const cls of row.classes) {
      classTotals.get(cls.id).demand += cls.weeklyHours;
    }
  }

  return {
    grid: { days: grid.days, periods: grid.periods, slotsPerWeek },
    rows,
    teachersWithoutSubjects,
    teacherTotals: [...teacherTotals.entries()].map(([id, value]) => {
      const busy = busyMap.get(id) || 0;
      return {
        teacherId: id,
        total: value.total,
        busy,
        available: Math.max(0, slotsPerWeek - busy),
      };
    }),
    classTotals: [...classTotals.values()].map((c) => ({
      ...c,
      capacity: slotsPerWeek,
    })),
    classes,
  };
}

/**
 * Bitta satrni saqlaydi (upsert `teacherId + subjectId` bo'yicha).
 *
 * Sinflar TO'LIQ almashtiriladi — MultiSelect butun ro'yxatni yuboradi,
 * shuning uchun "qaysi biri o'chdi" ni hisoblash ortiqcha bo'lardi.
 *
 * @param {object} data - { teacherId, subjectId, weeklyHours, classes }
 *   `classes` elementi: `"classId"` yoki `{ classId, weeklyHours }`
 *   (`weeklyHours` null/bo'sh → standart soat amal qiladi).
 */
async function saveLoad(data) {
  const { teacherId, subjectId } = data;
  if (!teacherId || !subjectId) {
    throw new BadRequestError("O'qituvchi va fan ko'rsatilishi shart");
  }

  // Satr `user_subjects` dan tug'iladi — biriktirilmagan fanga soat yozib
  // bo'lmaydi, aks holda "Asosiy" tabda ko'rinmaydigan ma'lumot paydo bo'lardi.
  const link = await prisma.userSubject.findUnique({
    where: { userId_subjectId: { userId: teacherId, subjectId } },
  });
  if (!link) {
    throw new BadRequestError(
      "Bu fan o'qituvchiga biriktirilmagan — avval xodim sahifasida fanni belgilang",
    );
  }

  const weeklyHours = Number(data.weeklyHours ?? 0);
  if (!Number.isInteger(weeklyHours) || weeklyHours < 0 || weeklyHours > 40) {
    throw new BadRequestError(
      "Haftalik soat 0 dan 40 gacha butun son bo'lishi kerak",
    );
  }

  const incoming = Array.isArray(data.classes) ? data.classes : [];
  const seen = new Set();
  const rows = [];

  for (const item of incoming) {
    const classId = typeof item === "string" ? item : item?.classId;
    if (!classId) throw new BadRequestError("Sinf ko'rsatilmagan");
    if (seen.has(classId)) continue;
    seen.add(classId);

    const raw = typeof item === "string" ? null : item?.weeklyHours;
    let override = null;
    if (raw !== null && raw !== undefined && raw !== "") {
      override = Number(raw);
      if (!Number.isInteger(override) || override < 0 || override > 40) {
        throw new BadRequestError(
          "Sinf uchun haftalik soat 0 dan 40 gacha butun son bo'lishi kerak",
        );
      }
    }

    rows.push({ classId, weeklyHours: override });
  }

  if (rows.length) {
    const found = await prisma.class.findMany({
      where: { id: { in: rows.map((r) => r.classId) } },
      select: { id: true },
    });
    if (found.length !== rows.length) {
      const known = new Set(found.map((c) => c.id));
      const missing = rows.find((r) => !known.has(r.classId));
      throw new BadRequestError(`Sinf topilmadi: ${missing.classId}`);
    }
  }

  await prisma.$transaction(async (tx) => {
    const load = await tx.plannerLoad.upsert({
      where: { teacherId_subjectId: { teacherId, subjectId } },
      create: { teacherId, subjectId, weeklyHours },
      update: { weeklyHours },
    });

    await tx.plannerLoadClass.deleteMany({ where: { loadId: load.id } });
    if (rows.length) {
      await tx.plannerLoadClass.createMany({
        data: rows.map((r) => ({ ...r, loadId: load.id })),
        skipDuplicates: true,
      });
    }
  });

  return getLoads();
}

/**
 * Generator uchun talab birliklari.
 * @returns {Promise<Array>} [{ teacherId, subjectId, classId, hours }]
 */
async function getDemands() {
  return buildDemands(await getRawLoads());
}

module.exports = { getLoads, saveLoad, getRawLoads, getDemands, loadTeachers };
