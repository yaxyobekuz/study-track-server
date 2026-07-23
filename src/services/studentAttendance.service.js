const prisma = require("../config/prisma");
const { getTodayNormalized, normalizeDateTashkent } = require("./attendance.service");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");
const { BadRequestError, NotFoundError } = require("../utils/errors");

async function markAttendance({ classId, date, records }, markedBy) {
  const normalizedDate = date ? normalizeDateTashkent(date) : getTodayNormalized();
  const now = new Date();

  const classDoc = await prisma.class.findUnique({ where: { id: classId } });
  if (!classDoc) throw new NotFoundError("Sinf topilmadi");

  const results = [];

  for (const rec of records) {
    const { studentId, status, excuseReason, absenceReason } = rec;

    if (!["present", "late", "absent", "excused"].includes(status)) {
      throw new BadRequestError(`Noto'g'ri status: ${status}`);
    }

    // "Sababli" holatda sabab (kategoriya) majburiy
    if (status === "excused" && !absenceReason) {
      throw new BadRequestError("'Sababli' holat uchun sabab tanlanishi shart");
    }

    const isExcused = status === "excused";

    const updated = await prisma.studentAttendance.upsert({
      where: { studentId_date: { studentId, date: normalizedDate } },
      update: {
        studentId,
        classId,
        date: normalizedDate,
        status,
        markedAt: now,
        absenceReason: isExcused ? absenceReason : null,
        excuseReason: isExcused ? excuseReason || null : null,
        autoMarked: false,
        lastModifiedBy: markedBy,
      },
      create: {
        studentId,
        classId,
        date: normalizedDate,
        status,
        markedAt: now,
        absenceReason: isExcused ? absenceReason : null,
        excuseReason: isExcused ? excuseReason || null : null,
        autoMarked: false,
        lastModifiedBy: markedBy,
        createdBy: markedBy,
      },
    });

    results.push(updated);
  }

  return results;
}

async function updateRecord(recordId, { status, excuseReason }, modifiedBy) {
  const record = await prisma.studentAttendance.findUnique({
    where: { id: recordId },
  });
  if (!record) throw new NotFoundError("Davomat yozuvi topilmadi");

  if (!["present", "late", "absent", "excused"].includes(status)) {
    throw new BadRequestError("Noto'g'ri status");
  }

  return prisma.studentAttendance.update({
    where: { id: recordId },
    data: {
      status,
      excuseReason:
        excuseReason !== undefined ? excuseReason : record.excuseReason,
      lastModifiedBy: modifiedBy,
      markedAt: new Date(),
      autoMarked: false,
    },
  });
}

async function getTodayClassAttendance(classId, dateInput) {
  const classDoc = await prisma.class.findUnique({ where: { id: classId } });
  if (!classDoc) throw new NotFoundError("Sinf topilmadi");

  // Sana berilsa o'sha kun, aks holda bugun (default)
  const today = dateInput ? normalizeDateTashkent(dateInput) : getTodayNormalized();

  const students = await prisma.user.findMany({
    where: {
      classes: { some: { classId } },
      role: "student",
      isActive: true,
    },
    select: { id: true, firstName: true, lastName: true },
  });

  const attendanceRecords = await prisma.studentAttendance.findMany({
    where: {
      classId,
      date: today,
    },
  });

  const recordMap = {};
  for (const rec of attendanceRecords) {
    recordMap[String(rec.studentId)] = rec;
  }

  const data = students.map((student) => ({
    student,
    attendance: recordMap[String(student.id)] || null,
  }));

  const summary = { present: 0, late: 0, absent: 0, excused: 0, unmarked: 0 };
  for (const { attendance } of data) {
    if (!attendance) {
      summary.unmarked++;
    } else {
      summary[attendance.status] = (summary[attendance.status] || 0) + 1;
    }
  }

  return { classInfo: classDoc, students: data, summary, date: today };
}

/**
 * Barcha sinflar bo'yicha bir kunlik o'quvchilar davomati (sahifalangan).
 * Ko'p yuklamani kamaytirish uchun o'quvchilar sahifalab qaytariladi.
 * Yig'indi esa barcha faol o'quvchilar bo'yicha hisoblanadi (sahifadan qat'i nazar).
 * @param {Object} req - Express request (query: date, status, page, limit)
 */
async function getTodayAllStudents(req) {
  const { page, limit, skip } = getPaginationParams(req, 20);
  const dateInput = req.query.date || null;
  const status = req.query.status || null;

  // Sana berilsa o'sha kun, aks holda bugun (default)
  const day = dateInput ? normalizeDateTashkent(dateInput) : getTodayNormalized();

  // Shu kunning barcha o'quvchi davomat yozuvlari (xarita va yig'indi uchun)
  const dayRecords = await prisma.studentAttendance.findMany({
    where: { date: day },
    select: {
      studentId: true,
      status: true,
      markedAt: true,
      excuseReason: true,
    },
  });

  const recordMap = {};
  for (const rec of dayRecords) {
    recordMap[String(rec.studentId)] = rec;
  }

  // Yig'indi - barcha faol o'quvchilar bo'yicha
  const totalStudents = await prisma.user.count({
    where: {
      role: "student",
      isActive: true,
    },
  });

  const summary = { present: 0, late: 0, absent: 0, excused: 0, unmarked: 0 };
  for (const rec of dayRecords) {
    if (summary[rec.status] !== undefined) summary[rec.status]++;
  }
  summary.unmarked = Math.max(
    0,
    totalStudents -
      (summary.present + summary.late + summary.absent + summary.excused)
  );

  // Status filtri bo'yicha o'quvchilarni cheklash
  const userFilter = { role: "student", isActive: true };
  if (status) {
    if (status === "unmarked") {
      userFilter.id = { notIn: dayRecords.map((r) => r.studentId) };
    } else {
      const matchedIds = dayRecords
        .filter((r) => r.status === status)
        .map((r) => r.studentId);
      userFilter.id = { in: matchedIds };
    }
  }

  const [studentsRaw, total] = await Promise.all([
    prisma.user.findMany({
      where: userFilter,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        classes: { select: { class: { select: { id: true, name: true } } } },
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      skip,
      take: limit,
    }),
    prisma.user.count({ where: userFilter }),
  ]);

  // classes junctionni tekis massivga aylantiramiz (populate shakli saqlanadi)
  const students = studentsRaw.map((s) => ({
    ...s,
    classes: (s.classes || []).map((c) => c.class),
  }));

  const data = students.map((student) => ({
    student,
    attendance: recordMap[String(student.id)] || null,
  }));

  const totalPages = Math.ceil(total / limit) || 1;

  return {
    students: data,
    summary,
    date: day,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  };
}

async function getClassList() {
  const today = getTodayNormalized();

  const classes = await prisma.class.findMany({ where: { isActive: true } });

  const result = [];
  for (const cls of classes) {
    const totalStudents = await prisma.user.count({
      where: {
        classes: { some: { classId: cls.id } },
        role: "student",
        isActive: true,
      },
    });

    const markedToday = await prisma.studentAttendance.count({
      where: {
        classId: cls.id,
        date: today,
      },
    });

    result.push({ ...cls, totalStudents, markedToday });
  }

  return result;
}

async function getClassMonthRecords(classId, month, year) {
  const classDoc = await prisma.class.findUnique({ where: { id: classId } });
  if (!classDoc) throw new NotFoundError("Sinf topilmadi");

  const m = parseInt(month, 10);
  const y = parseInt(year, 10);
  const startDate = new Date(Date.UTC(y, m - 1, 1));
  const endDate = new Date(Date.UTC(y, m, 1));

  const rows = await prisma.studentAttendance.findMany({
    where: {
      classId,
      date: { gte: startDate, lt: endDate },
    },
  });

  // student — soft ref, qo'lda yuklaymiz
  const studentIds = [...new Set(rows.map((r) => r.studentId).filter(Boolean))];
  const students = studentIds.length
    ? await prisma.user.findMany({
        where: { id: { in: studentIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const studentMap = new Map(students.map((s) => [s.id, s]));
  const records = rows.map((r) => ({
    ...r,
    student: r.studentId ? studentMap.get(r.studentId) || null : null,
  }));

  const summary = { present: 0, late: 0, absent: 0, excused: 0 };
  for (const rec of records) {
    summary[rec.status] = (summary[rec.status] || 0) + 1;
  }

  return { classInfo: classDoc, records, summary, month: m, year: y };
}

async function getStudentMonthRecords(studentId, month, year) {
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { id: true, firstName: true, lastName: true, role: true },
  });
  if (!student || student.role !== "student") throw new NotFoundError("O'quvchi topilmadi");

  const m = parseInt(month, 10);
  const y = parseInt(year, 10);
  const startDate = new Date(Date.UTC(y, m - 1, 1));
  const endDate = new Date(Date.UTC(y, m, 1));

  const rows = await prisma.studentAttendance.findMany({
    where: {
      studentId,
      date: { gte: startDate, lt: endDate },
    },
    orderBy: { date: "asc" },
  });

  // class — soft ref, qo'lda yuklaymiz
  const classIds = [...new Set(rows.map((r) => r.classId).filter(Boolean))];
  const classes = classIds.length
    ? await prisma.class.findMany({
        where: { id: { in: classIds } },
        select: { id: true, name: true },
      })
    : [];
  const classMap = new Map(classes.map((c) => [c.id, c]));
  const records = rows.map((r) => ({
    ...r,
    class: r.classId ? classMap.get(r.classId) || null : null,
  }));

  const summary = { present: 0, late: 0, absent: 0, excused: 0 };
  for (const rec of records) {
    summary[rec.status] = (summary[rec.status] || 0) + 1;
  }

  return { student, records, summary, month: m, year: y };
}

async function getAllRecords(req) {
  const { classId, status, month, year } = req.query;
  const { page, limit, skip } = getPaginationParams(req);

  const filter = {};
  if (classId) filter.classId = classId;
  if (status) filter.status = status;

  if (month && year) {
    const m = parseInt(month, 10);
    const y = parseInt(year, 10);
    filter.date = {
      gte: new Date(Date.UTC(y, m - 1, 1)),
      lt: new Date(Date.UTC(y, m, 1)),
    };
  }

  const [rows, total] = await Promise.all([
    prisma.studentAttendance.findMany({
      where: filter,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
    }),
    prisma.studentAttendance.count({ where: filter }),
  ]);

  // student va class — soft ref'lar, qo'lda yuklaymiz
  const studentIds = [...new Set(rows.map((r) => r.studentId).filter(Boolean))];
  const classIds = [...new Set(rows.map((r) => r.classId).filter(Boolean))];
  const [students, classes] = await Promise.all([
    studentIds.length
      ? prisma.user.findMany({
          where: { id: { in: studentIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [],
    classIds.length
      ? prisma.class.findMany({
          where: { id: { in: classIds } },
          select: { id: true, name: true },
        })
      : [],
  ]);
  const studentMap = new Map(students.map((s) => [s.id, s]));
  const classMap = new Map(classes.map((c) => [c.id, c]));
  const records = rows.map((r) => ({
    ...r,
    student: r.studentId ? studentMap.get(r.studentId) || null : null,
    class: r.classId ? classMap.get(r.classId) || null : null,
  }));

  return formatPaginationResponse(records, total, page, limit);
}

module.exports = {
  markAttendance,
  updateRecord,
  getTodayClassAttendance,
  getTodayAllStudents,
  getClassList,
  getClassMonthRecords,
  getStudentMonthRecords,
  getAllRecords,
};
