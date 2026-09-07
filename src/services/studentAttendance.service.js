const prisma = require("../config/prisma");
const { getTodayNormalized, normalizeDateTashkent } = require("./attendance.service");
const { getLessonDayMap } = require("./schedule.service");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { DAYS_UZ } = require("../utils/constants");

const STUDENT_STATUSES = ["present", "late", "absent", "excused"];

// Ro'yxat filtrlari: saqlangan holat + "came" (present yoki late) + "unmarked"
const LIST_STATUS_FILTERS = ["came", ...STUDENT_STATUSES, "unmarked"];

// "Faol o'quvchi" — login yoqilgan va arxivlanmagan. Arxivlangan o'quvchi
// sinflardan chiqariladi, lekin `isActive` o'zgarmaydi — shuning uchun
// ikkalasi birga tekshiriladi.
const ACTIVE_STUDENT_WHERE = { role: "student", isActive: true, isArchived: false };

// Davomat qatoridagi `student` shakli — BARCHA o'quvchi-davomat ro'yxatlarida
// bir xil (telefon raqamlari va sinflar bilan)
const STUDENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
  parentPhone: true,
  classes: { select: { class: { select: { id: true, name: true } } } },
};

// Davomat qatoridagi `attendance` shakli (studentId — xaritalash uchun)
const ATTENDANCE_SELECT = {
  id: true,
  studentId: true,
  status: true,
  markedAt: true,
  excuseReason: true,
  absenceReason: true,
  classId: true,
  autoMarked: true,
};

// classes junctionni tekis massivga aylantiramiz (populate shakli saqlanadi)
function flattenStudent(student) {
  return { ...student, classes: (student.classes || []).map((c) => c.class) };
}

/**
 * Davomat qatori (`row`) — kontrakt: `{ student, attendance, classId }`.
 * `classId`: yozuv bo'lsa yozuvdagi sinf, bo'lmasa so'ralgan sinf yoki
 * o'quvchining birinchi sinfi (yangi yozuv qaysi sinfga yozilishini bildiradi).
 */
function buildRow(student, attendance, requestedClassId = null) {
  return {
    student,
    attendance: attendance || null,
    classId:
      attendance?.classId || requestedClassId || student.classes?.[0]?.id || null,
  };
}

/**
 * Yig'indi (`summary`) — hamma joyda bir xil kalitlar.
 * Kelganlar = present + late (kech kelgan ham kelgan). Kelmaganlar = jami − kelganlar,
 * ya'ni belgilanmaganlar ham kelmagan hisobiga kiradi.
 * @param {number} total - kutilgan (doiradagi barcha faol) o'quvchilar soni
 * @param {Array<{status:string}>} records - shu doiradagi davomat yozuvlari
 */
function buildSummary(total, records) {
  const summary = {
    total,
    came: 0,
    notCame: 0,
    present: 0,
    late: 0,
    absent: 0,
    excused: 0,
    unmarked: 0,
  };
  for (const rec of records) {
    if (summary[rec.status] !== undefined) summary[rec.status]++;
  }
  summary.came = summary.present + summary.late;
  summary.notCame = Math.max(0, total - summary.came);
  summary.unmarked = Math.max(
    0,
    total - (summary.present + summary.late + summary.absent + summary.excused)
  );
  return summary;
}

// Holat filtri saqlangan (serverdagi) holat bo'yicha ishlaydi
function matchesStatusFilter(attendance, status) {
  if (!status) return true;
  if (status === "unmarked") return !attendance;
  if (!attendance) return false;
  if (status === "came") return attendance.status === "present" || attendance.status === "late";
  return attendance.status === status;
}

function assertListStatus(status) {
  if (status && !LIST_STATUS_FILTERS.includes(status)) {
    throw new BadRequestError(`Noto'g'ri holat filtri: ${status}`);
  }
}

// Qidiruv so'zlari: har bir so'z ism YOKI familiyada uchrashi kerak
function searchTerms(search) {
  return String(search || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// Prisma `where` uchun ism/familiya qidiruvi (case-insensitive contains)
function buildSearchWhere(search) {
  const terms = searchTerms(search);
  if (!terms.length) return null;
  return {
    AND: terms.map((term) => ({
      OR: [
        { firstName: { contains: term, mode: "insensitive" } },
        { lastName: { contains: term, mode: "insensitive" } },
      ],
    })),
  };
}

// Xotiradagi ro'yxat uchun xuddi shu qidiruv qoidasi
function matchesSearch(student, search) {
  const terms = searchTerms(search).map((t) => t.toLowerCase());
  if (!terms.length) return true;
  const first = String(student.firstName || "").toLowerCase();
  const last = String(student.lastName || "").toLowerCase();
  return terms.every((t) => first.includes(t) || last.includes(t));
}

// Sana berilsa o'sha kun, aks holda bugun (default); yaroqsiz sana → 400
function resolveDay(dateInput) {
  if (!dateInput) return getTodayNormalized();
  const day = normalizeDateTashkent(dateInput);
  if (Number.isNaN(day.getTime())) {
    throw new BadRequestError("Sana noto'g'ri formatda");
  }
  return day;
}

/**
 * IZOH — ixtiyoriy va HAR QANDAY holatda yoziladi.
 *
 * ⚠️ Sabab KATEGORIYASI (`AbsenceReason`) qo'lda belgilashdan OLIB TASHLANDI.
 * Avval "Sababli" uchun katalogdan kategoriya tanlash MAJBURIY edi va bu
 * oddiy tuzatishni to'sib qo'yardi: kelmagan bolani keyin "keldi" qilmoqchi
 * bo'lgan xodim ro'yxatdan nimadir tanlashga majbur bo'lardi. Endi izoh
 * yoziladi yoki bo'sh qoldiriladi — boshqa hech narsa so'ralmaydi.
 *
 * Kategoriya faqat "Uzrli so'rovlar" oqimida qoladi: u yerda tanlov
 * so'rovning MA'NOSI (xodim o'zi yuboradi, ma'muriyat ko'rib chiqadi).
 *
 * Qo'lda belgilashda kategoriya YOZILMAYDI va eskisi tozalanadi — izoh
 * bilan birga qolgan eski kategoriya chalkashlik tug'dirardi.
 */
function resolveReasonFields(status, { excuseReason }) {
  if (!STUDENT_STATUSES.includes(status)) {
    throw new BadRequestError(`Noto'g'ri status: ${status}`);
  }
  const note = typeof excuseReason === "string" ? excuseReason.trim() : "";
  return { absenceReason: null, excuseReason: note || null };
}

/**
 * Davomatni belgilash. `classId` yuqori darajada YOKI har bir yozuvda bo'ladi
 * ("Barcha sinflar" rejimida har o'quvchi o'z sinfi bilan keladi).
 */
async function markAttendance({ classId, date, records }, markedBy) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new BadRequestError("Belgilash uchun yozuvlar yo'q");
  }

  const normalizedDate = resolveDay(date);
  const now = new Date();

  // Har bir yozuvning sinfi: yozuvdagi, bo'lmasa umumiy
  const classIds = new Set();
  for (const rec of records) {
    if (!rec || typeof rec !== "object" || !rec.studentId) {
      throw new BadRequestError("Har bir yozuvda studentId bo'lishi shart");
    }
    const recClassId = rec.classId || classId;
    if (!recClassId) {
      throw new BadRequestError("Sinf ko'rsatilmagan (classId)");
    }
    classIds.add(recClassId);
  }

  // Sinflar mavjudligi — bir xil sinf uchun bir marta (bitta so'rov)
  const classDocs = await prisma.class.findMany({
    where: { id: { in: [...classIds] } },
    select: { id: true },
  });
  if (classDocs.length !== classIds.size) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const results = [];

  for (const rec of records) {
    const { studentId, status, excuseReason } = rec;
    const recClassId = rec.classId || classId;
    const reasonFields = resolveReasonFields(status, { excuseReason });

    const updated = await prisma.studentAttendance.upsert({
      where: { studentId_date: { studentId, date: normalizedDate } },
      update: {
        studentId,
        classId: recClassId,
        date: normalizedDate,
        status,
        markedAt: now,
        ...reasonFields,
        autoMarked: false,
        lastModifiedBy: markedBy,
      },
      create: {
        studentId,
        classId: recClassId,
        date: normalizedDate,
        status,
        markedAt: now,
        ...reasonFields,
        autoMarked: false,
        lastModifiedBy: markedBy,
        createdBy: markedBy,
      },
    });

    results.push(updated);
  }

  return results;
}

/**
 * Bitta yozuvni tahrirlash — izoh qoidasi markAttendance bilan bir xil:
 * ixtiyoriy, har qanday holatda yoziladi, kategoriya so'ralmaydi.
 */
async function updateRecord(recordId, { status, excuseReason }, modifiedBy) {
  const record = await prisma.studentAttendance.findUnique({
    where: { id: recordId },
  });
  if (!record) throw new NotFoundError("Davomat yozuvi topilmadi");

  const reasonFields = resolveReasonFields(status, { excuseReason });

  return prisma.studentAttendance.update({
    where: { id: recordId },
    data: {
      status,
      ...reasonFields,
      lastModifiedBy: modifiedBy,
      markedAt: new Date(),
      autoMarked: false,
    },
  });
}

/**
 * Bitta sinfning bir kunlik davomati.
 * ⚠️ Yozuvlar o'quvchi bo'yicha olinadi (sinf bo'yicha emas): o'quvchi bir
 * kunda bitta yozuvga ega va u boshqa sinf nomidan belgilangan bo'lishi mumkin.
 */
async function getTodayClassAttendance(classId, dateInput) {
  const classDoc = await prisma.class.findUnique({ where: { id: classId } });
  if (!classDoc) throw new NotFoundError("Sinf topilmadi");

  const today = resolveDay(dateInput);

  const studentsRaw = await prisma.user.findMany({
    where: { ...ACTIVE_STUDENT_WHERE, classes: { some: { classId } } },
    select: STUDENT_SELECT,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  const students = studentsRaw.map(flattenStudent);

  const attendanceRecords = students.length
    ? await prisma.studentAttendance.findMany({
        where: { date: today, studentId: { in: students.map((s) => s.id) } },
        select: ATTENDANCE_SELECT,
      })
    : [];

  const recordMap = new Map(attendanceRecords.map((rec) => [rec.studentId, rec]));

  const data = students.map((student) =>
    buildRow(student, recordMap.get(student.id) || null, classId)
  );

  const summary = buildSummary(students.length, attendanceRecords);

  return { classInfo: classDoc, students: data, summary, date: today };
}

/**
 * Barcha sinflar bo'yicha bir kunlik o'quvchilar davomati (sahifalangan).
 * Ko'p yuklamani kamaytirish uchun o'quvchilar sahifalab qaytariladi.
 * Yig'indi esa barcha faol o'quvchilar bo'yicha hisoblanadi (sahifadan qat'i nazar).
 * ⚠️ Jadvalga qaralmaydi: `total` = butun maktabdagi barcha faol o'quvchilar.
 * @param {Object} req - Express request (query: date, status, page, limit, search)
 */
async function getTodayAllStudents(req) {
  const { page, limit, skip } = getPaginationParams(req, 20);
  const dateInput = req.query.date || null;
  const status = req.query.status || null;
  const search = req.query.search || null;

  assertListStatus(status);

  const day = resolveDay(dateInput);

  // Barcha faol o'quvchilar (yig'indi va filtr uchun faqat id)
  const activeStudents = await prisma.user.findMany({
    where: ACTIVE_STUDENT_WHERE,
    select: { id: true },
  });
  const activeIds = new Set(activeStudents.map((s) => s.id));

  // Shu kunning barcha o'quvchi davomat yozuvlari (xarita va yig'indi uchun)
  const dayRecordsRaw = await prisma.studentAttendance.findMany({
    where: { date: day },
    select: ATTENDANCE_SELECT,
  });
  // Faol bo'lmagan (ketgan/arxivlangan) o'quvchi yozuvlari yig'indiga kirmaydi
  const dayRecords = dayRecordsRaw.filter((rec) => activeIds.has(rec.studentId));

  const recordMap = new Map(dayRecords.map((rec) => [rec.studentId, rec]));

  // Yig'indi - barcha faol o'quvchilar bo'yicha
  const summary = buildSummary(activeIds.size, dayRecords);

  // Status filtri bo'yicha o'quvchilarni cheklash (saqlangan holat bo'yicha)
  const userFilter = { ...ACTIVE_STUDENT_WHERE };
  if (status) {
    if (status === "unmarked") {
      userFilter.id = { notIn: dayRecords.map((r) => r.studentId) };
    } else {
      const matchedIds = dayRecords
        .filter((r) => matchesStatusFilter(r, status))
        .map((r) => r.studentId);
      userFilter.id = { in: matchedIds };
    }
  }
  const searchWhere = buildSearchWhere(search);
  if (searchWhere) userFilter.AND = searchWhere.AND;

  const [studentsRaw, total] = await Promise.all([
    prisma.user.findMany({
      where: userFilter,
      select: STUDENT_SELECT,
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      skip,
      take: limit,
    }),
    prisma.user.count({ where: userFilter }),
  ]);

  const students = studentsRaw.map(flattenStudent);

  const data = students.map((student) =>
    buildRow(student, recordMap.get(student.id) || null)
  );

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

/**
 * Belgilash uchun to'liq ro'yxat (sahifalanmaydi).
 * `classId` bo'lsa shu sinf, bo'lmasa barcha faol o'quvchilar ("Barcha sinflar").
 * Yig'indi butun doira bo'yicha; holat/qidiruv filtri faqat ro'yxatni qisqartiradi.
 * ⚠️ Jadvalga qaralmaydi: `total` = doiradagi barcha faol o'quvchilar.
 * @param {Object} params - { date, status, search, classId }
 */
async function getMarkList({ date, status, search, classId } = {}) {
  assertListStatus(status);

  if (classId) {
    const classDoc = await prisma.class.findUnique({
      where: { id: classId },
      select: { id: true },
    });
    if (!classDoc) throw new NotFoundError("Sinf topilmadi");
  }

  const day = resolveDay(date);

  const userFilter = { ...ACTIVE_STUDENT_WHERE };
  if (classId) userFilter.classes = { some: { classId } };

  const studentsRaw = await prisma.user.findMany({
    where: userFilter,
    select: STUDENT_SELECT,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  const students = studentsRaw.map(flattenStudent);

  const records = students.length
    ? await prisma.studentAttendance.findMany({
        where: { date: day, studentId: { in: students.map((s) => s.id) } },
        select: ATTENDANCE_SELECT,
      })
    : [];
  const recordMap = new Map(records.map((rec) => [rec.studentId, rec]));

  // Yig'indi — filtrdan oldin, butun doira bo'yicha
  const summary = buildSummary(students.length, records);

  const rows = students
    .map((student) => buildRow(student, recordMap.get(student.id) || null, classId || null))
    .filter(
      (row) => matchesStatusFilter(row.attendance, status) && matchesSearch(row.student, search)
    );

  return { students: rows, summary, date: day };
}

/**
 * Hisobot uchun "KUTILGAN o'quvchilar" resolveri.
 * Bir marta faol o'quvchilarni (sinflari bilan) va dars-kun xaritasini
 * (`getLessonDayMap`) yuklaydi, so'ng hafta kuni bo'yicha kutilganlarni beradi:
 * - jadval umuman kiritilmagan bo'lsa (`hasSchedule=false`) — dushanba–shanba
 *   har kuni HAMMA faol o'quvchi kutiladi (fallback); yakshanba jadval
 *   enum'ida yo'q, shuning uchun u har doim bo'sh;
 * - aks holda kun uchun kutilganlar = shu hafta kunida darsi bor sinf(lar)dagi
 *   o'quvchilar (bir o'quvchi bir marta). Sinfsiz o'quvchi kutilmaydi.
 *
 * ⚠️ FAQAT hisobot uchun. Kunlik sahifalar (`/today`, `/mark-list`) jadvalga
 * qaramaydi — ular "bugun nechta bola bor/yo'q" degan oddiy savolga javob beradi.
 * @returns {Promise<{
 *   forWeekday: (dow:number) => { ids: Set<string>, byClass: Map<string, Set<string>> },
 *   allStudentIds: Set<string>,
 *   hasSchedule: boolean,
 * }>}
 */
async function buildExpectedResolver() {
  const [students, lessonDays] = await Promise.all([
    prisma.user.findMany({
      where: ACTIVE_STUDENT_WHERE,
      select: { id: true, classes: { select: { classId: true } } },
    }),
    getLessonDayMap(),
  ]);

  const hasSchedule = lessonDays.size > 0;
  const allStudentIds = new Set(students.map((s) => s.id));

  // Sinf → o'quvchilar to'plami
  const classStudents = new Map();
  for (const s of students) {
    for (const { classId } of s.classes || []) {
      if (!classStudents.has(classId)) classStudents.set(classId, new Set());
      classStudents.get(classId).add(s.id);
    }
  }

  const cache = new Map();

  // 0=Yakshanba ... 6=Shanba (getUTCDay bilan bir xil)
  function forWeekday(dow) {
    if (cache.has(dow)) return cache.get(dow);

    const ids = new Set();
    const byClass = new Map();
    const dayName = DAYS_UZ[dow];

    if (dow !== 0) {
      for (const [classId, members] of classStudents) {
        if (hasSchedule && !lessonDays.has(`${classId}|${dayName}`)) continue;
        byClass.set(classId, members);
        for (const id of members) ids.add(id);
      }
      // Fallback (jadval yo'q): sinfsiz o'quvchilar ham kutiladi
      if (!hasSchedule) for (const id of allStudentIds) ids.add(id);
    }

    const result = { ids, byClass };
    cache.set(dow, result);
    return result;
  }

  return { forWeekday, allStudentIds, hasSchedule };
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

  // class va absenceReason — soft ref'lar, qo'lda yuklaymiz
  const classIds = [...new Set(rows.map((r) => r.classId).filter(Boolean))];
  const reasonIds = [
    ...new Set(rows.map((r) => r.absenceReason).filter(Boolean)),
  ];

  const [classes, reasons] = await Promise.all([
    classIds.length
      ? prisma.class.findMany({
          where: { id: { in: classIds } },
          select: { id: true, name: true },
        })
      : [],
    reasonIds.length
      ? prisma.absenceReason.findMany({
          where: { id: { in: reasonIds } },
          select: { id: true, title: true },
        })
      : [],
  ]);

  const classMap = new Map(classes.map((c) => [c.id, c]));
  const reasonMap = new Map(reasons.map((r) => [r.id, r]));
  const records = rows.map((r) => ({
    ...r,
    class: r.classId ? classMap.get(r.classId) || null : null,
    absenceReason: r.absenceReason
      ? reasonMap.get(r.absenceReason) || null
      : null,
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
  getMarkList,
  buildExpectedResolver,
  getClassList,
  getClassMonthRecords,
  getStudentMonthRecords,
  getAllRecords,
};
