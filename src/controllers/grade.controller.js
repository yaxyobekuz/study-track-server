const asyncHandler = require("../middleware/async.middleware");
const { hasRole } = require("../utils/permissions");
const { ROLES, DAYS_UZ } = require("../utils/constants");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} = require("../utils/errors");
const logger = require("../utils/logger");

// Prisma
const prisma = require("../config/prisma");

// Services
const { isHoliday } = require("../services/holiday.service");
// O'qish mantig'i (bugungi baholanmagan darslar, o'quvchi baholari, ref
// biriktirish) servisda — HTTP'dan tashqarida ham chaqiriladi.
const gradeService = require("../services/grade.service");
const { loadArchivedStudentScope } = require("../services/archivedStudentScope.service");
const { attachGradeRefs } = gradeService;
const {
  resolveLessonAccess,
  scheduleDayOf,
  hasGradingGrantFor,
} = require("../helpers/teacherAccess");
const { findActiveUnlock } = require("../services/gradingUnlock.service");
const { assertAtSchool } = require("../services/gradingPresence.service");
// "Shu darsda baho kutilgan o'quvchilar" — kechki jarima maxraji bilan AYNI
// manba: hammaga baho qo'yish ham, panel hisobi ham shundan o'qiydi
const { loadExpectedStudents } = require("../services/gradeExpectation.service");
// Baholar tahlili uchun dars mavzusi — xato tashlamaydi (servis izohiga qarang)
const { resolveGradeTopics } = require("../services/gradeTopic.service");
const lessonTopicService = require("../services/lessonTopic.service");
const { dayKey } = require("../helpers/lessonHours");
// ⚠️ TOSHKENT KUNI. `new Date()` ni to'g'ridan-to'g'ri berib bo'lmaydi:
// `teacherAccess` sanani FAQAT `getUTC*` bilan o'qiydi, jadval esa
// `getCurrentDayUz()` (Toshkent devor-soati) bilan olinadi. Toshkentda
// 00:00–05:00 orasida UTC hali KECHAGI kun bo'ladi va ikkalasi boshqa-boshqa
// hafta kunini ko'rsatib qolardi.
const { currentDayDate, parseDayDate } = require("../helpers/month.helpers");
const ExcelService = require("../services/excel.service");

const {
  getDayNameUz,
  getCurrentDayUz,
  isSunday,
  formatDateUz,
} = require("../helpers/date.helpers");

const HOUR_MS = 3600 * 1000;

const GRANT_CLOSED_MESSAGE =
  "Bu sinf va fanga baho qo'yish ruxsatingiz yopilgan — bahoni o'zgartirib bo'lmaydi";

/** Instantning Toshkent kuni — UTC yarim tuni (`currentDayDate` bilan bir o'lchov). */
const tashkentDayOf = (instant) => {
  const shifted = new Date(new Date(instant).getTime() + 5 * HOUR_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
};

/**
 * BAHO KUNI — bugun yoki boshliq OCHIB BERGAN o'tgan kun.
 *
 * ⚠️ O'TGAN KUNGA FAQAT OCHIQ OYNA BILAN (`GradingUnlock`): boshliq kunlar
 * oralig'ini hammaga yoki tanlangan o'qituvchilarga muddat bilan ochadi.
 * Qo'yilgan baho darsni o'tilgan qiladi va soati oylikka yoziladi — shu
 * sabab oynasiz orqaga sanab baho qo'yish yopiq qoladi.
 *
 * `date` berilmasa — bugun (eski xatti-harakat o'zgarmaydi).
 *
 * @param {object} user - req.user
 * @param {string|undefined} dateInput - "YYYY-MM-DD"
 * @returns {Promise<{date: Date, isPast: boolean, dayName: string|null, label: string}>}
 */
const resolveGradingDay = async (user, dateInput) => {
  const today = currentDayDate();
  const date = dateInput ? parseDayDate(dateInput, "Sana") : today;

  if (date.getTime() > today.getTime()) {
    throw new BadRequestError("Kelajakdagi darsga baho qo'yib bo'lmaydi");
  }

  const isPast = date.getTime() < today.getTime();
  const label = formatDateUz(date, { utc: true });

  if (isPast && !(await findActiveUnlock(user.id, date))) {
    throw new ForbiddenError(
      `${label} darslariga baho qo'yish ochilmagan — boshliqdan so'rang`,
    );
  }

  return { date, isPast, dayName: scheduleDayOf(date), label };
};

// Get missing grades for today (Owner only)
const getMissingGradesToday = asyncHandler(async (req, res) => {
  const data = await gradeService.getMissingGradesToday();
  return res.json({ success: true, data });
});

// Get grades (with filters)
const getGrades = asyncHandler(async (req, res) => {
  const { studentId, subjectId, classId, startDate, endDate } = req.query;

  let where = {};

  if (studentId) where.studentId = studentId;
  if (subjectId) where.subjectId = subjectId;
  if (classId) where.classId = classId;

  // ⚠️ `req.user.role === "teacher"` EMAS, `hasRole` — ko'p rollilik.
  //
  // Darvoza (`authorizePermission(..., ROLES.TEACHER)`) qo'shimcha
  // rolni ham o'tkazadi. Agar cheklov faqat ASOSIY rolga qarasa,
  // qo'shimcha `teacher` roli olgan odam darvozadan o'tib, cheklovga
  // TUSHMASDAN qolardi — ya'ni HAQIQIY o'qituvchidan ko'proq huquq
  // olardi (bu yerda: barcha o'qituvchilarning baholarini ko'rardi).
  //
  // Qoida: "o'qituvchi sifatida ish qila olasanmi" degan savolga
  // darvoza ham, cheklov ham BIR XIL javob berishi shart.
  if (hasRole(req.user, ROLES.TEACHER)) {
    where.teacherId = req.user.id;
  }

  // Date range
  if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = new Date(startDate);
    if (endDate) where.date.lte = new Date(endDate);
  }

  const gradeRows = await prisma.grade.findMany({
    where,
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
  });

  const grades = await attachGradeRefs(gradeRows);

  res.json({
    success: true,
    data: grades,
  });
});

// Get grades by class and date
const getGradesByClassAndDate = asyncHandler(async (req, res) => {
  const { classId, date } = req.params;

  // Split date into start and end times
  const startDate = new Date(date);
  startDate.setHours(0, 0, 0, 0);

  const endDate = new Date(date);
  endDate.setHours(23, 59, 59, 999);

  const todayDayName = getDayNameUz(date);

  const todaySchedule = await prisma.schedule.findFirst({
    where: { classId, day: todayDayName },
    include: { lessons: { orderBy: { position: "asc" } } },
  });

  // Create a map of subject ID to order
  const subjectOrderMap = {};
  if (todaySchedule && todaySchedule.lessons) {
    todaySchedule.lessons.forEach((s) => {
      const subjectId = s.subjectId;
      if (!subjectOrderMap[subjectId]) {
        subjectOrderMap[subjectId] = s.order;
      }
    });
  }

  // Get all students in the class
  const allStudents = await prisma.user.findMany({
    where: { role: "student", isArchived: false, classes: { some: { classId } } },
    select: { id: true, firstName: true, lastName: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  // Grade ref'lari scalar — baholarni olib qo'lda student/subject/teacher biriktiramiz.
  // Arxivlangan o'quvchi eski bahosi bilan jurnalga qaytib kirmasin
  const gradeRows = await prisma.grade.findMany({
    where: {
      classId,
      date: { gte: startDate, lte: endDate },
      ...(await loadArchivedStudentScope()),
    },
    select: {
      id: true,
      grade: true,
      comment: true,
      date: true,
      lessonOrder: true,
      isEdited: true,
      createdAt: true,
      studentId: true,
      subjectId: true,
      teacherId: true,
    },
  });

  const grades = await attachGradeRefs(gradeRows, { class: false });

  // Group grades by student
  const gradesByStudent = {};
  grades.forEach((grade) => {
    const studentId = grade.student.id;
    if (!gradesByStudent[studentId]) {
      gradesByStudent[studentId] = {
        student: grade.student,
        grades: [],
      };
    }
    gradesByStudent[studentId].grades.push(grade);
  });

  // Add students without grades
  allStudents.forEach((student) => {
    const studentId = student.id;
    if (!gradesByStudent[studentId]) {
      gradesByStudent[studentId] = {
        student: {
          id: student.id,
          firstName: student.firstName,
          lastName: student.lastName,
        },
        grades: [],
      };
    }
  });

  // Convert to array and sort by student name
  const studentsWithGrades = Object.values(gradesByStudent).sort((a, b) => {
    const nameA = `${a.student.lastName} ${a.student.firstName}`;
    const nameB = `${b.student.lastName} ${b.student.firstName}`;
    return nameA.localeCompare(nameB);
  });

  res.json({
    success: true,
    data: studentsWithGrades,
  });
});

/**
 * DARSGA BAHO QO'YISH DARVOZASI — bitta o'quvchiga ham, hammaga ham AYNI.
 *
 * ⚠️ YAGONA NUSXA. "Hammaga baho qo'yish" (`bulkCreateGrades`) ham shundan
 * o'tadi: kun (bugun yoki ochilgan oyna), maktabda bo'lish, bayram, jadval,
 * darsga huquq (o'z darsi / o'rinbosarlik / ruxsat) va vaqt oynasi. Ommaviy
 * yo'lga alohida tekshiruv yozilsa, biriga qo'shilgan shart ikkinchisida
 * tushib qolib, tugma orqali qoidani chetlab o'tish yo'li ochilardi.
 *
 * @param {object} user - req.user
 * @param {{classId: string, subjectId: string, lessonOrder?: number|string,
 *   date?: string}} input
 * @returns {Promise<{day: object, dayText: string, classId: string,
 *   subjectId: string, selected: object, teacherLessons: object[],
 *   grantIdByOrder: Map<number, string|null>, range: {from: Date, to: Date},
 *   at: Date}>}
 */
const resolveGradingLesson = async (user, { classId, subjectId, lessonOrder, date: dateInput }) => {
  // Only teacher can add grades (ko'p rollilik — `hasRole`)
  if (!hasRole(user, ROLES.TEACHER)) {
    throw new ForbiddenError("Faqat o'qituvchilar baho qo'ya oladi");
  }

  // Bugun yoki ruxsat ochilgan o'tgan kun
  const day = await resolveGradingDay(user, dateInput);
  const dayText = day.isPast ? day.label : "Bugun";

  // Bugungi darsga — faqat MAKTABDA ("Siz maktabda emassiz"). Ochib
  // berilgan o'tgan kunga bu shart qo'yilmaydi (`gradingPresence.service.js`).
  if (!day.isPast) await assertAtSchool(user);

  // Holiday check — tanlangan kun bo'yicha (kun o'rtasi: server taymzonasidan qat'i nazar)
  const holidayCheck = await isHoliday(day.isPast ? new Date(day.date.getTime() + 7 * HOUR_MS) : new Date());
  if (holidayCheck.isHoliday) {
    throw new ForbiddenError(
      `${dayText} dam olish kuni: ${holidayCheck.holiday.name}. Baho qo'yish mumkin emas.`,
    );
  }

  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) {
    throw new NotFoundError("Fan topilmadi");
  }

  const classExists = await prisma.class.findUnique({ where: { id: classId } });
  if (!classExists) {
    throw new NotFoundError("Sinf topilmadi");
  }

  // Check if teacher teaches this subject in this class on that day
  const todayDayName = day.isPast ? day.dayName : getCurrentDayUz();

  // Skip Sunday (yakshanba) - no lessons
  if (day.isPast ? !day.dayName : isSunday()) {
    throw new ForbiddenError("Yakshanba kuni dars yo'q, baho qo'yib bo'lmaydi");
  }

  // Find the day's schedule for this class
  const todaySchedule = await prisma.schedule.findFirst({
    where: { classId, day: todayDayName },
    include: { lessons: { orderBy: { position: "asc" } } },
  });

  if (!todaySchedule) {
    throw new ForbiddenError(
      `${dayText} (${todayDayName}) ushbu sinfda dars jadvali topilmadi`,
    );
  }

  // DARSGA HUQUQ — o'z darsi, o'rinbosarlik YOKI boshliq bergan fanga ruxsat.
  //
  // ⚠️ Qoida `helpers/teacherAccess.js` da, bu yerda EMAS. U ikki tomonga
  // ishlaydi: o'rinbosarga huquq ochadi va dars egasidan AYNAN o'sha dars
  // uchun huquqni oladi (u ko'rish rejimida qoladi). Ilgari bu yerda oddiy
  // `teacherId === req.user.id` filtri turardi — u o'rinbosarni bilmasdi.
  const access = await resolveLessonAccess({
    actor: user,
    classId,
    subjectId,
    date: day.date,
    lessons: todaySchedule.lessons,
  });

  if (!access.allowed) {
    throw new ForbiddenError(
      access.message ||
        `${dayText} (${todayDayName}) ushbu sinfda sizning bu fan darslaringiz yo'q`,
    );
  }

  const allowedLessons = access.lessons;

  // Validate lessonOrder if provided
  const parsedLessonOrder = lessonOrder ? Number(lessonOrder) : null;
  const finalLessonOrder = parsedLessonOrder || allowedLessons[0].order;
  const lessonExists = allowedLessons.find(
    (l) => l.order === finalLessonOrder,
  );

  if (!lessonExists) {
    // ⚠️ AYNAN SHU DARS O'RINBOSARGA BERILGAN bo'lsa, sabab BOSHQA va
    // xabar ham boshqa bo'lishi kerak. "Dars tartibi noto'g'ri" degan
    // umumiy xabar o'qituvchini "jadval buzilibdi" deb o'ylashga majbur
    // qilardi — aslida esa u ataylab ko'rish rejimiga o'tkazilgan.
    const handedOver = access.blocked.find((l) => l.order === finalLessonOrder);

    if (handedOver) {
      throw new ForbiddenError(access.blockedMessage);
    }

    throw new BadRequestError(
      `Dars tartibi noto'g'ri. Sizning darslaringiz: ${allowedLessons.map((l) => l.order).join(", ")}`,
    );
  }

  // BAHO QAYSI DARSLARGA TARQALADI — faqat tanlangan dars bilan BIR XIL
  // yo'l bilan ochilganlariga.
  //
  // ⚠️ O'z darsidagi baho RUXSAT darsiga tarqalmaydi (va aksincha): ruxsat
  // darsi boshqa o'qituvchining darsi — u yerga avtomatik baho yozilsa,
  // dars egasi o'sha o'quvchiga baho qo'ya olmay qolardi ("allaqachon
  // qo'yilgan"). O'z darslari orasidagi tarqalish avvalgidek qoladi.
  const viaGrant = lessonExists.access === "grant";
  const teacherLessons = allowedLessons.filter(
    (l) => (l.access === "grant") === viaGrant,
  );
  const grantIdByOrder = new Map(
    teacherLessons.map((l) => [l.order, l.grantId ?? null]),
  );

  // Vaqt: bugungi darsga — dars BOSHLANGANDAN "Men ketdim" gacha (dars
  // tugashi yopmaydi, `checkGradingTimeWindow`). Faqat sozlamada yoqilgan bo'lsa.
  const { ENABLE_SCHEDULE_TIME_VALIDATION } = require("../utils/constants");

  // Vaqt oynasi faqat BUGUNGI dars uchun — ochib berilgan o'tgan kunda dars
  // allaqachon tugagan, oyna ruxsatning ma'nosini yo'qqa chiqarardi
  if (ENABLE_SCHEDULE_TIME_VALIDATION && !day.isPast) {
    const { checkGradingTimeWindow } = require("../helpers/date.helpers");

    const lessonSchedule = todaySchedule.lessons.find(
      (s) => s.order === finalLessonOrder,
    );

    if (!lessonSchedule || !lessonSchedule.startTime) {
      throw new BadRequestError(
        "Dars jadvali to'liq emas - boshlanish vaqti kiritilmagan",
      );
    }

    const timeCheck = checkGradingTimeWindow(lessonSchedule.startTime);

    if (!timeCheck.canGrade) {
      throw new ForbiddenError(timeCheck.reason);
    }
  }

  // Kun oralig'i — TOSHKENT kunining instantlari (bugun ham, o'tgan kun ham).
  // ⚠️ Ilgari bugungi kun server-lokal `setHours(0,0,0,0)` bilan olinardi:
  // UTC hostda Toshkentning 00:00–05:00 dagi bahosi "kechagi" bo'lib, o'sha
  // o'quvchiga ikkinchi baho yozib qo'yish mumkin edi.
  const from = new Date(day.date.getTime() - 5 * HOUR_MS);
  const to = new Date(from.getTime() + 24 * HOUR_MS);

  // ⚠️ O'tgan kun bahosi o'sha KUNNING o'rtasiga (12:00 Toshkent) yoziladi:
  // `Grade.date` instant, soat hisobi esa uni Toshkent kuniga keltiradi —
  // "qo'yilgan payt" yozilsa, baho bugungi kunga tushib, o'tilmagan dars
  // o'tilgan bo'lmay qolardi.
  const at = day.isPast ? new Date(day.date.getTime() + 7 * HOUR_MS) : new Date();

  return {
    day,
    dayText,
    classId,
    subjectId,
    selected: lessonExists,
    teacherLessons,
    grantIdByOrder,
    range: { from, to },
    at,
  };
};

/**
 * DARS MAVZUSI (baholar tahlilining mavzu kesimi) — `lessonTopic.service.js`
 * dagi AYNI hisob, jadvalda ko'rinadigan mavzu bilan bitta manba.
 *
 * ⚠️ O'TGAN KUNGA HAM YOZILADI. Ilgari yozilmasdi va buning sababi bor edi:
 * eski hisoblagich faqat "hozirgi" mavzuni bilardi. Ankor + sanoq esa
 * istalgan kunning mavzusini beradi, shuning uchun ochilgan kunga
 * (`GradingUnlock`) qo'yilgan baho ham o'z mavzusini oladi.
 *
 * ⚠️ `resolveGradeTopics` xato TASHLAMAYDI — aniqlab bo'lmasa baho
 * mavzusiz yoziladi, baho qo'yish hech qachon shu sababli yiqilmaydi.
 *
 * @param {object} lesson - `resolveGradingLesson` natijasi
 * @param {string} actorId
 * @returns {Promise<Map<number, string|null>>}
 */
const resolveLessonTopics = (lesson, actorId) =>
  resolveGradeTopics({
    classId: lesson.classId,
    subjectId: lesson.subjectId,
    lessonOrders: lesson.teacherLessons.map((l) => l.order),
    actorId,
    at: lesson.at,
  });

/**
 * BAHOLARNI YOZADI — qulf ostida, takrorsiz.
 *
 * Baho o'qituvchining shu kungi shu fandagi HAMMA darsiga (tanlangan dars
 * bilan bir xil yo'l bilan ochilganlariga) tarqaladi — o'quvchida baho
 * YO'Q darslarga. Mavjud bahoga tegilmaydi (uni faqat tahrirlash o'zgartiradi).
 *
 * ⚠️ TEKSHIRUV VA YOZUV BITTA QULF ICHIDA (sinf + fan + kun). Ilgari "bor
 * baholarni o'qi → yoz" qulfsiz edi: ikki marta bosish yoki parallel ikki
 * so'rov bir o'quvchiga bitta darsda ikkita baho yozardi. Ommaviy yo'lda bu
 * butun sinfni ikkilantirardi. Qulf bittalik va ommaviy yo'l uchun UMUMIY —
 * ular bir-birining takrorini ham ko'radi.
 *
 * @param {object} lesson - `resolveGradingLesson` natijasi
 * @param {{studentIds: string[], grade: number, comment?: string|null,
 *   actorId: string, topicByOrder: Map<number, string|null>,
 *   eligibleIds?: Set<string>|null, skipIfSelectedGraded?: boolean}} input
 *   `eligibleIds` — faqat shu o'quvchilarga yoziladi (qolgani `away`);
 *   `skipIfSelectedGraded` — tanlangan darsda bahosi borga umuman tegilmaydi
 * @returns {Promise<{written: Map<string, number[]>, graded: string[], away: string[]}>}
 *   `written` — o'quvchi → yozilgan dars tartiblari
 */
const writeLessonGrades = (
  lesson,
  { studentIds, grade, comment = null, actorId, topicByOrder, eligibleIds = null, skipIfSelectedGraded = false },
) =>
  prisma.$transaction(async (tx) => {
    // ⚠️ `$executeRaw`: `pg_advisory_xact_lock` `void` qaytaradi
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`grades:${lesson.classId}:${lesson.subjectId}:${dayKey(lesson.day.date)}`}))`;

    const orders = lesson.teacherLessons.map((l) => l.order);
    const existing = await tx.grade.findMany({
      where: {
        studentId: { in: studentIds },
        subjectId: lesson.subjectId,
        classId: lesson.classId,
        lessonOrder: { in: orders },
        date: { gte: lesson.range.from, lt: lesson.range.to },
      },
      select: { studentId: true, lessonOrder: true },
    });

    const takenByStudent = new Map();
    for (const row of existing) {
      if (!takenByStudent.has(row.studentId)) takenByStudent.set(row.studentId, new Set());
      takenByStudent.get(row.studentId).add(row.lessonOrder);
    }

    const written = new Map();
    const graded = [];
    const away = [];
    const rows = [];

    for (const studentId of studentIds) {
      const taken = takenByStudent.get(studentId) ?? new Set();

      // Tartib — panel hisobi bilan AYNI: avval "bahosi bor", keyin "darsda yo'q"
      if (skipIfSelectedGraded && taken.has(lesson.selected.order)) {
        graded.push(studentId);
        continue;
      }
      if (eligibleIds && !eligibleIds.has(studentId)) {
        away.push(studentId);
        continue;
      }

      const missing = orders.filter((order) => !taken.has(order));
      if (missing.length === 0) {
        graded.push(studentId);
        continue;
      }

      written.set(studentId, missing);
      for (const order of missing) {
        rows.push({
          studentId,
          subjectId: lesson.subjectId,
          classId: lesson.classId,
          teacherId: actorId,
          grade,
          date: lesson.at,
          lessonOrder: order,
          comment,
          topicId: topicByOrder.get(order) ?? null,
          // Ruxsat bilan qo'yilgan baho — dars egasining oyligida hisoblanmaydi
          gradingGrantId: lesson.grantIdByOrder.get(order) ?? null,
        });
      }
    }

    if (rows.length > 0) await tx.grade.createMany({ data: rows });

    return { written, graded, away };
  });

// Create grade (Teacher only)
const createGrade = asyncHandler(async (req, res) => {
  const { studentId, subjectId, classId, grade, comment, lessonOrder, date: dateInput } =
    req.body;

  // Validation
  if (!studentId || !subjectId || !classId || !grade) {
    throw new BadRequestError("Barcha majburiy maydonlarni to'ldiring");
  }

  // Check grade (must be between 1-5)
  if (grade < 1 || grade > 5) {
    throw new BadRequestError("Baho 1 dan 5 gacha bo'lishi kerak");
  }

  const lesson = await resolveGradingLesson(req.user, {
    classId,
    subjectId,
    lessonOrder,
    date: dateInput,
  });

  // Validate student exists in the class
  const student = await prisma.user.findFirst({
    where: {
      id: studentId,
      role: "student",
      classes: { some: { classId } },
    },
  });
  if (!student) {
    throw new NotFoundError("O'quvchi ushbu sinfda topilmadi");
  }

  const topicByOrder = await resolveLessonTopics(lesson, req.user.id);

  const { written } = await writeLessonGrades(lesson, {
    studentIds: [studentId],
    grade,
    comment,
    actorId: req.user.id,
    topicByOrder,
  });

  const missingLessonOrders = written.get(studentId);
  if (!missingLessonOrders) {
    throw new BadRequestError(
      "Bugun ushbu o'quvchiga bu fan bo'yicha barcha darslar uchun baho allaqachon qo'yilgan",
    );
  }

  // createMany id qaytarmaydi — yaratilgan baholarni qayta o'qib olamiz
  const createdGrades = await prisma.grade.findMany({
    where: {
      studentId,
      subjectId,
      classId,
      teacherId: req.user.id,
      lessonOrder: { in: missingLessonOrders },
      date: { gte: lesson.range.from, lt: lesson.range.to },
    },
  });

  const populatedGrade = await attachGradeRefs(createdGrades[0]);

  res.status(201).json({
    success: true,
    message:
      createdGrades.length > 1
        ? `Baho muvaffaqiyatli qo'yildi va ${createdGrades.length} ta dars soatiga avtomatik qo'llandi`
        : "Baho muvaffaqiyatli qo'yildi",
    data: populatedGrade,
  });
});

const BULK_GRANT_MESSAGE =
  "Ruxsat bilan ochilgan darsda hammaga baho qo'yib bo'lmaydi — " +
  "kerakli o'quvchilarga bittalab qo'ying";

/**
 * HAMMAGA BAHO QO'YISH — `POST /grades/bulk`
 * `{ classId, subjectId, lessonOrder, grade, date? }`
 *
 * Tanlangan darsda bahosi YO'Q va shu kuni darsda BOR (o'qiydi, kelmagan
 * deb belgilanmagan) har bir o'quvchiga bitta bahoni qo'yadi.
 *
 * ⚠️ MAVJUD BAHOGA TEGILMAYDI: o'qituvchi qo'lda qo'ygan "3" ni ommaviy "5"
 * bosib ketmasin. Boshqa o'qituvchi qo'ygani ham shunday.
 *
 * ⚠️ KELMAGAN O'QUVCHIGA QO'YILMAYDI — ro'yxat kechki jarima maxraji bilan
 * AYNI manbadan (`gradeExpectation.service.js`): maktabdan ketgan, o'sha kuni
 * kelmagan ("kelmadi"/"sababli") o'quvchi chetda qoladi. Darsda bo'lmagan
 * bolaga baho bir bosishda yozilib ketardi. Bittalab qo'yish bu cheklovsiz
 * qoladi — u o'qituvchining ongli qarori.
 *
 * ⚠️ RUXSAT BILAN OCHILGAN DARSDA YOPIQ (`GradingGrant`): ruxsat — dars
 * egasining jurnaliga QO'SHIMCHA huquq (odatda bitta-ikkita o'quvchi uchun).
 * Hammaga yozilsa, dars egasi o'z sinfining hech biriga shu darsda baho
 * qo'ya olmay qolardi ("allaqachon qo'yilgan").
 *
 * Tekshiruvlar bittalik yo'l bilan AYNI (`resolveGradingLesson`), yozuv
 * ham (`writeLessonGrades`).
 */
const bulkCreateGrades = asyncHandler(async (req, res) => {
  const { classId, subjectId, lessonOrder, grade, date: dateInput } = req.body;

  if (!classId || !subjectId || !lessonOrder) {
    throw new BadRequestError("Sinf, fan va dars tanlanishi shart");
  }

  const value = Number(grade);
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new BadRequestError("Baho 1 dan 5 gacha butun son bo'lishi kerak");
  }

  const lesson = await resolveGradingLesson(req.user, {
    classId,
    subjectId,
    lessonOrder,
    date: dateInput,
  });

  if (lesson.selected.access === "grant") {
    throw new ForbiddenError(BULK_GRANT_MESSAGE);
  }

  // Sinf ro'yxati — baho qo'yish sahifasidagi bilan AYNI (`getStudentsWithGrades`)
  const [classStudents, expectedByClass] = await Promise.all([
    prisma.user.findMany({
      where: { role: ROLES.STUDENT, isArchived: false, classes: { some: { classId } } },
      select: { id: true },
    }),
    loadExpectedStudents([classId], lesson.day.date),
  ]);

  const eligibleIds = new Set((expectedByClass.get(classId) ?? []).map((s) => s.id));
  const topicByOrder = await resolveLessonTopics(lesson, req.user.id);

  const { written, graded, away } = await writeLessonGrades(lesson, {
    studentIds: classStudents.map((s) => s.id),
    grade: value,
    actorId: req.user.id,
    topicByOrder,
    eligibleIds,
    skipIfSelectedGraded: true,
  });

  const skippedText = [
    graded.length > 0 ? `${graded.length} tasida baho bor edi — tegilmadi` : null,
    away.length > 0 ? `${away.length} tasi darsda yo'q — qo'yilmadi` : null,
  ]
    .filter(Boolean)
    .join(", ");

  if (written.size === 0) {
    throw new ConflictError(
      `Baho qo'yiladigan o'quvchi qolmadi${skippedText ? `: ${skippedText}` : ""}. Ro'yxatni yangilang`,
    );
  }

  const gradesCreated = [...written.values()].reduce((sum, orders) => sum + orders.length, 0);

  res.status(201).json({
    success: true,
    message:
      `${written.size} ta o'quvchiga ${value} baho qo'yildi` +
      (gradesCreated > written.size ? ` (${gradesCreated} ta dars soatiga)` : "") +
      (skippedText ? `. ${skippedText.charAt(0).toUpperCase()}${skippedText.slice(1)}` : ""),
    data: {
      grade: value,
      studentsGraded: written.size,
      gradesCreated,
      alreadyGraded: graded.length,
      away: away.length,
    },
  });
});

// Update grade (Teacher only - only for today's grades)
const updateGrade = asyncHandler(async (req, res) => {
  const { grade: newGrade, comment } = req.body;
  const gradeId = req.params.id;

  const gradeDoc = await prisma.grade.findUnique({ where: { id: gradeId } });

  if (!gradeDoc) {
    throw new NotFoundError("Baho topilmadi");
  }

  // Only teacher can edit (ko'p rollilik — `hasRole`)
  if (!hasRole(req.user, ROLES.TEACHER)) {
    throw new ForbiddenError("Faqat o'qituvchi baho tahrirlashi mumkin");
  }

  // Can only edit own grades
  if (gradeDoc.teacherId !== req.user.id) {
    throw new ForbiddenError("Bu bahoni tahrirlash uchun ruxsatingiz yo'q");
  }

  // Can only edit today's grades — yoki ruxsat ochilgan o'tgan kunnikini.
  // Kun TOSHKENT bo'yicha: server taymzonasidagi `setHours` 00:00–05:00
  // orasida kechagi bahoni "bugungi" deb o'qirdi.
  const gradeDay = tashkentDayOf(gradeDoc.date);
  const isTodayGrade = gradeDay.getTime() === currentDayDate().getTime();
  const unlockedPast =
    !isTodayGrade && Boolean(await findActiveUnlock(req.user.id, gradeDay));

  if (!isTodayGrade && !unlockedPast) {
    throw new ForbiddenError("Faqat bugungi baholarni tahrirlash mumkin");
  }

  // Ruxsat bilan qo'yilgan baho — faqat ruxsat hali AMALDA bo'lsa
  // (`hasGradingGrantFor` izohi): yopilgan ruxsat boshqaning jurnalini ham yopadi
  if (gradeDoc.gradingGrantId && !(await hasGradingGrantFor(gradeDoc, gradeDay))) {
    throw new ForbiddenError(GRANT_CLOSED_MESSAGE);
  }

  // Bugungi bahoni ham faqat maktabda turib o'zgartiradi
  if (isTodayGrade) await assertAtSchool(req.user);

  // Vaqt: dars boshlangandan "Men ketdim" gacha (faqat sozlamada yoqilgan bo'lsa)
  const { ENABLE_SCHEDULE_TIME_VALIDATION } = require("../utils/constants");

  if (ENABLE_SCHEDULE_TIME_VALIDATION && !unlockedPast) {
    const { getCurrentDayUz } = require("../helpers/date.helpers");

    const dayName = getCurrentDayUz();
    const todaySchedule = await prisma.schedule.findFirst({
      where: { classId: gradeDoc.classId, day: dayName },
      include: { lessons: { orderBy: { position: "asc" } } },
    });

    if (!todaySchedule) {
      throw new ForbiddenError("Bugun uchun dars jadvali topilmadi");
    }

    const lessonSchedule = todaySchedule.lessons.find(
      (s) =>
        s.subjectId === gradeDoc.subjectId &&
        s.order === gradeDoc.lessonOrder,
    );

    if (!lessonSchedule || !lessonSchedule.startTime) {
      throw new BadRequestError(
        "Dars jadvali to'liq emas - boshlanish vaqti kiritilmagan",
      );
    }

    // Dars tugashi tahrirni ham yopmaydi — faqat "Men ketdim" (maktabda
    // bo'lish sharti) yopadi
    const { checkGradingTimeWindow } = require("../helpers/date.helpers");
    const timeCheck = checkGradingTimeWindow(lessonSchedule.startTime);

    if (!timeCheck.canGrade) {
      throw new ForbiddenError(timeCheck.reason);
    }
  }

  const update = {};
  const editHistory = Array.isArray(gradeDoc.editHistory)
    ? [...gradeDoc.editHistory]
    : [];

  // Add to history
  if (newGrade && newGrade !== gradeDoc.grade) {
    editHistory.push({
      previousGrade: gradeDoc.grade,
      editedAt: new Date(),
      editedBy: req.user.id,
    });
    update.grade = newGrade;
    update.isEdited = true;
    update.editHistory = editHistory;
  }

  if (comment !== undefined) {
    update.comment = comment;
  }

  const savedGrade = await prisma.grade.update({
    where: { id: gradeDoc.id },
    data: update,
  });

  const updatedGrade = await attachGradeRefs(savedGrade);

  // editHistory.editedBy — scalar user ref'larni qo'lda yuklab biriktiramiz
  const historyEditorIds = [
    ...new Set(
      (updatedGrade.editHistory || [])
        .map((h) => h.editedBy)
        .filter(Boolean),
    ),
  ];
  if (historyEditorIds.length > 0) {
    const editors = await prisma.user.findMany({
      where: { id: { in: historyEditorIds } },
      select: { id: true, firstName: true, lastName: true },
    });
    const editorMap = new Map(editors.map((e) => [e.id, { ...e }]));
    updatedGrade.editHistory = (updatedGrade.editHistory || []).map((h) => ({
      ...h,
      editedBy: h.editedBy ? editorMap.get(h.editedBy) || null : null,
    }));
  }

  res.json({
    success: true,
    message: "Baho muvaffaqiyatli yangilandi",
    data: updatedGrade,
  });
});

// Delete grade (Teacher can delete own today's grades, Owner can delete any)
const deleteGrade = asyncHandler(async (req, res) => {
  const grade = await prisma.grade.findUnique({ where: { id: req.params.id } });

  if (!grade) {
    throw new NotFoundError("Baho topilmadi");
  }

  // ⚠️ ENG MUHIM JOY. Darvoza qo'shimcha rolni o'tkazgani holda bu
  // shart faqat asosiy rolga qarasa, qo'shimcha `teacher` roli olgan
  // odam IKKALA cheklovdan ham — "faqat o'z bahosi" va "faqat
  // bugungi baho" — qutulib qolardi va istalgan o'qituvchining
  // istalgan sanadagi bahosini o'chira olardi.
  if (hasRole(req.user, ROLES.TEACHER)) {
    // Can only delete own grades
    if (grade.teacherId !== req.user.id) {
      throw new ForbiddenError("Bu bahoni o'chirish uchun ruxsatingiz yo'q");
    }

    // Can only delete today's grades — yoki ruxsat ochilgan o'tgan kunnikini
    // (kun TOSHKENT bo'yicha — `updateGrade` bilan bir xil)
    const gradeDay = tashkentDayOf(grade.date);
    const isTodayGrade = gradeDay.getTime() === currentDayDate().getTime();

    if (!isTodayGrade && !(await findActiveUnlock(req.user.id, gradeDay))) {
      throw new ForbiddenError("Faqat bugungi baholarni o'chirish mumkin");
    }

    // Ruxsat bilan qo'yilgan baho — faqat ruxsat hali amalda bo'lsa (`updateGrade` bilan AYNI)
    if (grade.gradingGrantId && !(await hasGradingGrantFor(grade, gradeDay))) {
      throw new ForbiddenError(GRANT_CLOSED_MESSAGE);
    }

    // Bugungi bahoni ham faqat maktabda turib o'chiradi
    if (isTodayGrade) await assertAtSchool(req.user);
  }

  // Delete the grade (reytinglar grade jadvalidan jonli hisoblanadi — sync shart emas)
  await prisma.grade.delete({ where: { id: req.params.id } });

  res.json({
    success: true,
    message: "Baho muvaffaqiyatli o'chirildi",
  });
});

// Get student grades
const getStudentGrades = asyncHandler(async (req, res) => {
  const studentId =
    req.user.role === "student" ? req.user.id : req.params.studentId;

  // Get date from query parameter (for student) or use all dates
  const { date } = req.query;

  const data = await gradeService.getStudentGrades(studentId, { date });

  res.json({
    success: true,
    data,
  });
});

// Get teacher's subjects in a class (for grade adding - TODAY's schedule only)
const getTeacherSubjectsInClass = asyncHandler(async (req, res) => {
  const { classId } = req.params;

  if (!hasRole(req.user, ROLES.TEACHER)) {
    throw new ForbiddenError("Faqat o'qituvchilar uchun");
  }

  // Bugun yoki ruxsat ochilgan o'tgan kun (`?date=YYYY-MM-DD`).
  // Hafta kuni — TOSHKENT kunidan (`createGrade` bilan bir o'lchov).
  const day = await resolveGradingDay(req.user, req.query.date);
  const todayDayName = DAYS_UZ[day.date.getUTCDay()];

  // If Sunday, return empty array
  if (todayDayName === "yakshanba") {
    return res.json({
      success: true,
      data: [],
      message: "Yakshanba kuni dars yo'q",
    });
  }

  // Find today's schedule for this class
  const todaySchedule = await prisma.schedule.findFirst({
    where: { classId, day: todayDayName },
    include: { lessons: { orderBy: { position: "asc" } } },
  });

  if (!todaySchedule) {
    return res.json({
      success: true,
      data: [],
      message: `Bugun (${todayDayName}) ushbu sinfda dars jadvali yo'q`,
    });
  }

  // Filter only teacher's subjects from today's schedule
  // Include ALL lessons (with duplicates) and add order/lessonNumber
  const teacherSubjects = [];
  const subjectCountMap = {}; // Track how many times each subject appears

  // ⚠️ O'RINBOSARLIK SHU RO'YXATGA HAM TA'SIR QILADI. Yozish huquqi
  // `createGrade` da ochilib, ro'yxat esa eski filtrda qolsa, o'rinbosar
  // "baho qo'yish" ekranini BO'SH ko'rardi — huquqi bor, lekin fanni
  // tanlay olmaydi. Shu sababli ikkala joyda ham bir xil hal qiluvchi.
  const access = await resolveLessonAccess({
    actor: req.user,
    classId,
    date: day.date,
    lessons: todaySchedule.lessons,
  });

  // Ruxsat etilgan darslar — jadval qatori `id` si bo'yicha (pastdagi ikkala
  // siklda). Har birida `access`: o'z darsi / o'rinbosarlik / fanga ruxsat —
  // panel ruxsat bilan ochilgan darsni alohida belgilaydi.
  const allowedById = new Map(access.lessons.map((l) => [l.id, l]));

  // Get unique subject IDs for progress lookup
  const teacherSubjectIds = new Set();
  todaySchedule.lessons.forEach((item) => {
    if (allowedById.has(item.id)) {
      teacherSubjectIds.add(item.subjectId);
    }
  });

  // Fan nomlari scalar ref — qo'lda yuklaymiz
  const teacherSubjectIdList = Array.from(teacherSubjectIds);
  const subjectDocs = teacherSubjectIdList.length
    ? await prisma.subject.findMany({
        where: { id: { in: teacherSubjectIdList } },
        select: { id: true, name: true },
      })
    : [];
  const subjectMap = new Map(subjectDocs.map((s) => [s.id, s]));

  // DARS MAVZUSI — har bir DARS uchun alohida (`lessonTopic.service.js`).
  //
  // ⚠️ Ilgari bu yerda sinf+fanning bitta "joriy mavzu raqami" o'qilardi va
  // bir kunda o'sha fandan ikki dars bo'lsa, ikkalasi ham BIR XIL mavzuni
  // ko'rsatardi. Endi mavzu kun + dars tartibi bo'yicha hal qilinadi, ya'ni
  // paneldagi raqam jadvaldagi raqam bilan AYNI.
  const dayTopics = await lessonTopicService.getDayLessonTopics({
    classId,
    day: dayKey(day.date),
    actorId: req.user.id,
  });

  todaySchedule.lessons.forEach((item) => {
    const allowed = allowedById.get(item.id);
    if (allowed) {
      const subjectId = item.subjectId;

      // Increment count for this subject
      if (!subjectCountMap[subjectId]) {
        subjectCountMap[subjectId] = 0;
      }
      subjectCountMap[subjectId]++;

      const subjectDoc = subjectMap.get(subjectId);

      // Add subject with lesson number
      teacherSubjects.push({
        id: subjectId,
        name: subjectDoc ? subjectDoc.name : undefined,
        order: item.order,
        lessonNumber: subjectCountMap[subjectId], // 1st, 2nd, 3rd occurrence
        currentTopicNumber: dayTopics.get(item.order)?.topicOrder ?? null,
        currentTopicName: dayTopics.get(item.order)?.topic?.name ?? null,
        topicReason: dayTopics.get(item.order)?.reason ?? null,
        // "own" | "substitution" | "grant" — qaysi yo'l bilan ochilgan
        access: allowed.access,
      });
    }
  });

  // Sort by order to maintain schedule sequence
  teacherSubjects.sort((a, b) => a.order - b.order);

  res.json({
    success: true,
    data: teacherSubjects,
    day: todayDayName,
  });
});

/**
 * BAHO QO'YISH MUMKIN BO'LGAN SINFLAR — bugun yoki ochilgan o'tgan kun
 * (`?date=YYYY-MM-DD`). O'z darsi, o'rinbosarlik va fanga ruxsat — baho
 * yozish bilan AYNI hal qiluvchidan (`grade.service.js`).
 */
const getTeacherGradingClasses = asyncHandler(async (req, res) => {
  if (!hasRole(req.user, ROLES.TEACHER)) {
    throw new ForbiddenError("Faqat o'qituvchilar uchun");
  }

  const day = await resolveGradingDay(req.user, req.query.date);
  const data = await gradeService.getTeacherGradingClasses(req.user, day.date);

  res.json({ success: true, data });
});

// Get students with their grades for a class, subject and date
const getStudentsWithGrades = asyncHandler(async (req, res) => {
  const { classId, subjectId, date, lessonOrder } = req.query;

  if (!classId || !subjectId || !date) {
    throw new BadRequestError("Sinf, fan va sana majburiy");
  }

  const finalLessonOrder = lessonOrder ? parseInt(lessonOrder) : null;
  // Kun kaliti so'rovning o'zidan (`parseDayDate` → UTC yarim tun)
  const day = parseDayDate(date, "Sana");

  // Get all students in the class
  const [students, expectedByClass] = await Promise.all([
    prisma.user.findMany({
      where: { role: "student", isArchived: false, classes: { some: { classId } } },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    }),
    // Shu kuni darsda BORMI (o'qiydi, kelmagan deb belgilanmagan) —
    // "Hammaga baho qo'yish" aynan shularga yozadi (`bulkCreateGrades`).
    // Panel sanog'i server yozadigani bilan bitta manbadan bo'lsin.
    loadExpectedStudents([classId], day),
  ]);
  const expectedIds = new Set((expectedByClass.get(classId) ?? []).map((s) => s.id));

  // Parse date range
  const startDate = new Date(date);
  startDate.setHours(0, 0, 0, 0);

  const endDate = new Date(date);
  endDate.setHours(23, 59, 59, 999);

  // Get grades for this class, subject and date
  const gradeWhere = {
    classId,
    subjectId,
    date: { gte: startDate, lte: endDate },
  };

  // If lessonOrder is specified, filter by it
  if (finalLessonOrder) {
    gradeWhere.lessonOrder = finalLessonOrder;
  }

  const gradeRows = await prisma.grade.findMany({ where: gradeWhere });

  // teacher ref scalar — qo'lda biriktiramiz
  const grades = await attachGradeRefs(gradeRows, {
    student: false,
    subject: false,
    class: false,
  });

  // SHU KUNGI, SHU DARSNING MAVZUSI (`lessonTopic.service.js`).
  //
  // ⚠️ Ilgari bu "sinf+fanning joriy mavzusi" edi: o'tgan kun jurnali
  // ochilsa ham BUGUNGI mavzu ko'rinardi va bir kunda ikki dars bo'lsa
  // ikkalasida bir xil turardi. Endi sana va dars tartibi bo'yicha —
  // jadvalda ko'rinadigan mavzu bilan AYNI.
  let currentTopic = null;
  // ⚠️ `startDate` LOKAL yarim tun (`setHours`) — `dayKey` esa faqat
  // `getUTC*` bilan o'qiydi va UTC+5 hostda u BIR KUN ORQAGA tushardi.
  // Kun kaliti so'rovning o'zidan olinadi (`parseDayDate` → UTC yarim tun).
  const dayTopics = await lessonTopicService.getDayLessonTopics({
    classId,
    day: dayKey(day),
    actorId: req.user.id,
  });

  const lessonEntry = finalLessonOrder
    ? dayTopics.get(finalLessonOrder)
    : [...dayTopics.values()].find((entry) => entry.subjectId === subjectId);

  if (lessonEntry?.topic && lessonEntry.subjectId === subjectId) {
    currentTopic = {
      number: lessonEntry.topic.order,
      name: lessonEntry.topic.name,
      description: lessonEntry.topic.description || "",
      // Ixtiyoriy — mavzular faylida bo'lmasa `null`
      level: lessonEntry.topic.level ?? null,
      book: lessonEntry.topic.book ?? null,
    };
  }

  // Map grades to students
  const studentsWithGrades = students.map((student) => {
    const grade = grades.find((g) => g.studentId === student.id);
    return {
      id: student.id,
      firstName: student.firstName,
      lastName: student.lastName,
      grade: grade || null,
      expected: expectedIds.has(student.id),
    };
  });

  res.json({
    success: true,
    data: studentsWithGrades,
    currentTopic,
  });
});

// Export grades to Excel
const exportGrades = asyncHandler(async (req, res) => {
  const { classId, date, subjectId } = req.query;

  if (!classId || !date) {
    throw new BadRequestError("Sinf va sana majburiy");
  }

  // Get class info
  const classData = await prisma.class.findUnique({ where: { id: classId } });
  if (!classData) {
    throw new NotFoundError("Sinf topilmadi");
  }

  // Split date into start and end times
  const startDate = new Date(date);
  startDate.setHours(0, 0, 0, 0);

  const endDate = new Date(date);
  endDate.setHours(23, 59, 59, 999);

  const todayDayName = getDayNameUz(date);

  // Get schedule for the day
  const todaySchedule = await prisma.schedule.findFirst({
    where: { classId, day: todayDayName },
    include: { lessons: { orderBy: { position: "asc" } } },
  });

  // Jadvaldagi fan ref'lari scalar — nomlarni qo'lda yuklaymiz
  const scheduleSubjectIds = todaySchedule
    ? [...new Set(todaySchedule.lessons.map((l) => l.subjectId).filter(Boolean))]
    : [];
  const scheduleSubjects = scheduleSubjectIds.length
    ? await prisma.subject.findMany({
        where: { id: { in: scheduleSubjectIds } },
        select: { id: true, name: true },
      })
    : [];
  const scheduleSubjectMap = new Map(scheduleSubjects.map((s) => [s.id, s]));

  // Get all students in the class
  const allStudents = await prisma.user.findMany({
    where: { role: "student", isArchived: false, classes: { some: { classId } } },
    select: { id: true, firstName: true, lastName: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });

  // Get grades with all necessary fields
  const gradeRows = await prisma.grade.findMany({
    where: {
      classId,
      date: { gte: startDate, lte: endDate },
    },
  });

  // student/subject/teacher ref'larini qo'lda biriktiramiz
  const grades = await attachGradeRefs(gradeRows, { class: false });

  // Create map of student grades
  const studentGradesMap = {};
  allStudents.forEach((student) => {
    studentGradesMap[student.id] = {
      student: { ...student },
      grades: grades.filter(
        (g) => g.student && g.student.id && g.student.id === student.id,
      ),
    };
  });

  const studentsWithGrades = Object.values(studentGradesMap);

  let columns, data, sheetName;

  // If specific subject selected
  if (subjectId && subjectId !== "all") {
    const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
    sheetName = `${classData.name} - ${subject?.name || "Fan"}`;

    columns = [
      { header: "O'quvchi", key: "student", width: 30 },
      { header: "Baho", key: "grade", width: 12 },
      { header: "O'qituvchi", key: "teacher", width: 25 },
    ];

    data = studentsWithGrades.map((item) => {
      const gradeData = item.grades.find(
        (g) => g.subject && g.subject.id && g.subject.id === subjectId,
      );

      return {
        student:
          `${item.student.firstName} ${item.student.lastName || ""}`.trim(),
        grade: gradeData ? gradeData.grade : "-",
        teacher: gradeData
          ? `${gradeData.teacher.firstName} ${gradeData.teacher.lastName || ""}`.trim()
          : "-",
      };
    });
  } else {
    // All subjects
    sheetName = `${classData.name} - Barcha fanlar`;

    const todaySubjects = todaySchedule?.lessons || [];
    const sortedSubjects = todaySubjects
      .filter((s) => s.subjectId)
      .sort((a, b) => a.order - b.order);

    columns = [{ header: "O'quvchi", key: "student", width: 30 }];

    // Add columns for each subject
    sortedSubjects.forEach((s, idx) => {
      const subjectDoc = scheduleSubjectMap.get(s.subjectId);
      columns.push({
        header: `${idx + 1}. ${subjectDoc ? subjectDoc.name : ""}`,
        key: `subject_${s.order}`,
        width: 15,
      });
    });

    columns.push({ header: "O'rtacha", key: "average", width: 12 });

    data = studentsWithGrades.map((item) => {
      const row = {
        student:
          `${item.student.firstName} ${item.student.lastName || ""}`.trim(),
      };

      let totalGrades = 0;
      let gradeCount = 0;

      // Fan takrorlanish indekslarini hisoblash
      const subjectOccurrences = {};

      // Shu o'quvchining baholarini lessonOrder bo'yicha tartiblash
      const sortedGrades = [...item.grades].sort(
        (a, b) => (a.lessonOrder || 0) - (b.lessonOrder || 0),
      );

      // Har bir fan uchun baholarni guruhlash
      const gradesBySubject = {};
      sortedGrades.forEach((g) => {
        if (g.subject && g.subject.id) {
          const subjectId = g.subject.id;
          if (!gradesBySubject[subjectId]) {
            gradesBySubject[subjectId] = [];
          }
          gradesBySubject[subjectId].push(g);
        }
      });

      sortedSubjects.forEach((s) => {
        const subjectId = s.subjectId;

        // Bu fanning nechanchi marta takrorlanishini hisoblash
        if (!subjectOccurrences[subjectId]) {
          subjectOccurrences[subjectId] = 0;
        }
        const occurrenceIndex = subjectOccurrences[subjectId];
        subjectOccurrences[subjectId]++;

        // Shu takrorlanish indeksidagi bahoni olish
        const subjectGrades = gradesBySubject[subjectId] || [];
        const gradeData = subjectGrades[occurrenceIndex] || null;

        const gradeValue = gradeData ? gradeData.grade : "-";
        row[`subject_${s.order}`] = gradeValue;

        if (gradeData && typeof gradeData.grade === "number") {
          totalGrades += gradeData.grade;
          gradeCount++;
        }
      });

      row.average =
        gradeCount > 0 ? (totalGrades / gradeCount).toFixed(2) : "-";

      return row;
    });
  }

  // Create Excel
  const workbook = ExcelService.createExcel({
    sheetName,
    columns,
    data,
  });

  // Generate filename
  const filename = ExcelService.generateFileName(
    `${classData.name}_baholar_${date}`,
  );

  // Send file
  await ExcelService.sendWorkbook(res, workbook, filename);
});

module.exports = {
  getGrades,
  getMissingGradesToday,
  createGrade,
  bulkCreateGrades,
  updateGrade,
  deleteGrade,
  getStudentGrades,
  getStudentsWithGrades,
  getGradesByClassAndDate,
  getTeacherSubjectsInClass,
  getTeacherGradingClasses,
  exportGrades,
};
