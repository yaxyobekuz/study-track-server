const asyncHandler = require("../middleware/async.middleware");
const { BadRequestError, NotFoundError, ForbiddenError } = require("../utils/errors");
const logger = require("../utils/logger");

// Prisma
const prisma = require("../config/prisma");

// Services
const {
  updateWeeklyStatsForGrade,
} = require("../services/weeklystats.service");
const { isHoliday } = require("../services/holiday.service");
const ExcelService = require("../services/excel.service");

const {
  getDayNameUz,
  getDateRangeForDay,
  getCurrentDayUz,
  getNowInUzbekistan,
  isSunday,
} = require("../helpers/date.helpers");

// Vaqtni minutlarga aylantirish (HH:MM -> minutes)
const timeToMinutes = (time) => {
  if (!time) return null;
  const [hours, minutes] = time.split(":").map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
};

// Get missing grades for today (Owner only)
const getMissingGradesToday = asyncHandler(async (req, res) => {
  const nowInUzbekistan = getNowInUzbekistan();

  // 1. Yakshanba tekshirish
  if (isSunday(nowInUzbekistan)) {
    return res.json({
      success: true,
      data: {
        isHoliday: false,
        isSunday: true,
        message: "Yakshanba kuni dars yo'q",
        byTeacher: [],
        summary: {
          totalTeachers: 0,
          totalLessons: 0,
          totalMissingStudents: 0,
        },
      },
    });
  }

  // 2. Bayram kuni tekshirish
  const holidayCheck = await isHoliday(nowInUzbekistan);
  if (holidayCheck.isHoliday) {
    return res.json({
      success: true,
      data: {
        isHoliday: true,
        holiday: holidayCheck.holiday,
        message: `Bugun dam olish kuni: ${holidayCheck.holiday.name}`,
        byTeacher: [],
        summary: {
          totalTeachers: 0,
          totalLessons: 0,
          totalMissingStudents: 0,
        },
      },
    });
  }

  // 3. Bugungi kun nomi va hozirgi vaqt
  const todayDayName = getDayNameUz(nowInUzbekistan);
  const currentMinutes =
    nowInUzbekistan.getHours() * 60 + nowInUzbekistan.getMinutes();

  // 4. Bugungi sana oralig'i
  const { startDate, endDate } = getDateRangeForDay(nowInUzbekistan);

  // 5. Bugungi barcha jadvallarni olish
  const todaySchedules = await prisma.schedule.findMany({
    where: { day: todayDayName },
    include: {
      lessons: { orderBy: { position: "asc" } },
    },
  });

  // Jadvaldagi sinf/fan/o'qituvchi ref'lari scalar — qo'lda yuklaymiz
  const scheduleClassIds = [
    ...new Set(todaySchedules.map((s) => s.classId).filter(Boolean)),
  ];
  const lessonSubjectIds = [
    ...new Set(
      todaySchedules.flatMap((s) => s.lessons.map((l) => l.subjectId)).filter(Boolean),
    ),
  ];
  const lessonTeacherIds = [
    ...new Set(
      todaySchedules.flatMap((s) => s.lessons.map((l) => l.teacherId)).filter(Boolean),
    ),
  ];

  const [classes, subjects, teachers] = await Promise.all([
    scheduleClassIds.length
      ? prisma.class.findMany({
          where: { id: { in: scheduleClassIds } },
          select: { id: true, name: true, isActive: true },
        })
      : [],
    lessonSubjectIds.length
      ? prisma.subject.findMany({
          where: { id: { in: lessonSubjectIds } },
          select: { id: true, name: true },
        })
      : [],
    lessonTeacherIds.length
      ? prisma.user.findMany({
          where: { id: { in: lessonTeacherIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [],
  ]);

  const classMap = new Map(classes.map((c) => [c.id, c]));
  const subjectMap = new Map(subjects.map((s) => [s.id, s]));
  const teacherMap = new Map(teachers.map((t) => [t.id, t]));

  // 6. O'qituvchilar bo'yicha guruhlash uchun map
  const teacherDataMap = {};

  for (const schedule of todaySchedules) {
    const scheduleClass = classMap.get(schedule.classId);

    // Faol bo'lmagan sinflarni o'tkazib yuborish
    if (!scheduleClass || !scheduleClass.isActive) continue;

    // Sinfdagi barcha faol o'quvchilarni olish
    const studentsInClass = await prisma.user.findMany({
      where: {
        role: "student",
        classes: { some: { classId: schedule.classId } },
        isActive: true,
      },
      select: { id: true, firstName: true, lastName: true },
    });

    if (studentsInClass.length === 0) continue;

    // Bugungi baholarni olish
    const todayGrades = await prisma.grade.findMany({
      where: {
        classId: schedule.classId,
        date: { gte: startDate, lte: endDate },
      },
    });

    // Har bir darsni tekshirish
    for (const lesson of schedule.lessons) {
      if (!lesson.teacherId) continue;

      // Vaqt tekshiruvi: endTime mavjud va o'tib ketgan yoki endTime yo'q
      const endMinutes = timeToMinutes(lesson.endTime);
      const isLessonEnded =
        endMinutes === null || currentMinutes > endMinutes;

      // Agar dars hali tugamagan bo'lsa, o'tkazib yuboramiz
      if (!isLessonEnded) continue;

      // Bu dars uchun baho olgan o'quvchilar
      const gradedStudentIds = new Set(
        todayGrades
          .filter(
            (g) =>
              g.subjectId === lesson.subjectId &&
              g.lessonOrder === lesson.order,
          )
          .map((g) => g.studentId),
      );

      // Baho olmagan o'quvchilar
      const missingStudents = studentsInClass.filter(
        (s) => !gradedStudentIds.has(s.id),
      );

      // Agar baho olmagan o'quvchilar bo'lsa
      if (missingStudents.length > 0) {
        const lessonSubject = subjectMap.get(lesson.subjectId);
        const lessonTeacher = teacherMap.get(lesson.teacherId);
        if (!lessonTeacher) continue;

        const teacherId = lessonTeacher.id;

        // O'qituvchi uchun data yaratish
        if (!teacherDataMap[teacherId]) {
          teacherDataMap[teacherId] = {
            teacher: {
              id: lessonTeacher.id,
              firstName: lessonTeacher.firstName,
              lastName: lessonTeacher.lastName,
            },
            lessons: [],
          };
        }

        // Dars ma'lumotlarini qo'shish
        teacherDataMap[teacherId].lessons.push({
          class: {
            id: scheduleClass.id,
            name: scheduleClass.name,
          },
          subject: {
            id: lesson.subjectId,
            name: lessonSubject ? lessonSubject.name : undefined,
          },
          lessonOrder: lesson.order,
          startTime: lesson.startTime,
          endTime: lesson.endTime,
          totalStudents: studentsInClass.length,
          missingStudents: missingStudents.map((s) => ({
            id: s.id,
            firstName: s.firstName,
            lastName: s.lastName,
          })),
        });
      }
    }
  }

  // 7. Array formatiga o'tkazish
  const byTeacher = Object.values(teacherDataMap);

  // 8. Summary hisoblash
  let totalLessons = 0;
  let totalMissingStudents = 0;
  byTeacher.forEach((t) => {
    totalLessons += t.lessons.length;
    t.lessons.forEach((l) => {
      totalMissingStudents += l.missingStudents.length;
    });
  });

  // 9. Response
  return res.json({
    success: true,
    data: {
      isHoliday: false,
      isSunday: false,
      dayName: todayDayName,
      date: nowInUzbekistan.toISOString().split("T")[0],
      byTeacher,
      summary: {
        totalTeachers: byTeacher.length,
        totalLessons,
        totalMissingStudents,
      },
    },
  });
});

// Grade ref'larni (student/subject/teacher/class) scalar bo'lgani uchun qo'lda yuklab biriktiradi
async function attachGradeRefs(grades, { student = true, subject = true, teacher = true, class: withClass = true } = {}) {
  const arr = Array.isArray(grades) ? grades : [grades];
  if (arr.length === 0) return grades;

  const userIds = new Set();
  const subjectIds = new Set();
  const classIds = new Set();

  arr.forEach((g) => {
    if (student && g.studentId) userIds.add(g.studentId);
    if (teacher && g.teacherId) userIds.add(g.teacherId);
    if (subject && g.subjectId) subjectIds.add(g.subjectId);
    if (withClass && g.classId) classIds.add(g.classId);
  });

  const [users, subjects, classes] = await Promise.all([
    userIds.size
      ? prisma.user.findMany({
          where: { id: { in: [...userIds] } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [],
    subjectIds.size
      ? prisma.subject.findMany({
          where: { id: { in: [...subjectIds] } },
          select: { id: true, name: true },
        })
      : [],
    classIds.size
      ? prisma.class.findMany({
          where: { id: { in: [...classIds] } },
          select: { id: true, name: true },
        })
      : [],
  ]);

  const userMap = new Map(users.map((u) => [u.id, { ...u }]));
  const subjectMap = new Map(subjects.map((s) => [s.id, { ...s }]));
  const classMap = new Map(classes.map((c) => [c.id, { ...c }]));

  const mapped = arr.map((g) => {
    const out = { ...g };
    if (student) out.student = g.studentId ? userMap.get(g.studentId) || null : null;
    if (teacher) out.teacher = g.teacherId ? userMap.get(g.teacherId) || null : null;
    if (subject) out.subject = g.subjectId ? subjectMap.get(g.subjectId) || null : null;
    if (withClass) out.class = g.classId ? classMap.get(g.classId) || null : null;
    return out;
  });

  return Array.isArray(grades) ? mapped : mapped[0];
}

// Get grades (with filters)
const getGrades = asyncHandler(async (req, res) => {
  const { studentId, subjectId, classId, startDate, endDate } = req.query;

  let where = {};

  if (studentId) where.studentId = studentId;
  if (subjectId) where.subjectId = subjectId;
  if (classId) where.classId = classId;

  // If teacher, can only see their own grades
  if (req.user.role === "teacher") {
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
    where: { role: "student", classes: { some: { classId } } },
    select: { id: true, firstName: true, lastName: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  // Grade ref'lari scalar — baholarni olib qo'lda student/subject/teacher biriktiramiz
  const gradeRows = await prisma.grade.findMany({
    where: {
      classId,
      date: { gte: startDate, lte: endDate },
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

// Create grade (Teacher only)
const createGrade = asyncHandler(async (req, res) => {
  const { studentId, subjectId, classId, grade, comment, lessonOrder } =
    req.body;

  // Validation
  if (!studentId || !subjectId || !classId || !grade) {
    throw new BadRequestError("Barcha majburiy maydonlarni to'ldiring");
  }

  // Holiday check
  const holidayCheck = await isHoliday(new Date());
  if (holidayCheck.isHoliday) {
    throw new ForbiddenError(
      `Bugun dam olish kuni: ${holidayCheck.holiday.name}. Baho qo'yish mumkin emas.`,
    );
  }

  // Only teacher can add grades
  if (req.user.role !== "teacher") {
    throw new ForbiddenError("Faqat o'qituvchilar baho qo'ya oladi");
  }

  // Check grade (must be between 1-5)
  if (grade < 1 || grade > 5) {
    throw new BadRequestError("Baho 1 dan 5 gacha bo'lishi kerak");
  }

  // Validate student, subject and class exist
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

  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) {
    throw new NotFoundError("Fan topilmadi");
  }

  const classExists = await prisma.class.findUnique({ where: { id: classId } });
  if (!classExists) {
    throw new NotFoundError("Sinf topilmadi");
  }

  // Check if teacher teaches this subject in this class TODAY
  const todayDayName = getCurrentDayUz();

  // Skip Sunday (yakshanba) - no lessons
  if (isSunday()) {
    throw new ForbiddenError("Yakshanba kuni dars yo'q, baho qo'yib bo'lmaydi");
  }

  // Find today's schedule for this class
  const todaySchedule = await prisma.schedule.findFirst({
    where: { classId, day: todayDayName },
    include: { lessons: { orderBy: { position: "asc" } } },
  });

  if (!todaySchedule) {
    throw new ForbiddenError(
      `Bugun (${todayDayName}) ushbu sinfda dars jadvali topilmadi`,
    );
  }

  // Check if teacher has this subject in today's schedule and validate lessonOrder
  const teacherLessons = todaySchedule.lessons.filter(
    (s) => s.subjectId === subjectId && s.teacherId === req.user.id,
  );

  if (teacherLessons.length === 0) {
    throw new ForbiddenError(
      `Bugun (${todayDayName}) ushbu sinfda sizning bu fan darslaringiz yo'q`,
    );
  }

  // Validate lessonOrder if provided
  const parsedLessonOrder = lessonOrder ? Number(lessonOrder) : null;
  const finalLessonOrder = parsedLessonOrder || teacherLessons[0].order;
  const lessonExists = teacherLessons.find(
    (l) => l.order === finalLessonOrder,
  );

  if (!lessonExists) {
    throw new BadRequestError(
      `Dars tartibi noto'g'ri. Sizning darslaringiz: ${teacherLessons.map((l) => l.order).join(", ")}`,
    );
  }

  // Check grading time window (only if enabled in config)
  const {
    GRADE_TIME_LIMIT_MINUTES,
    ENABLE_SCHEDULE_TIME_VALIDATION,
  } = require("../utils/constants");

  if (ENABLE_SCHEDULE_TIME_VALIDATION) {
    const { checkGradingTimeWindow } = require("../helpers/date.helpers");

    const lessonSchedule = todaySchedule.lessons.find(
      (s) => s.order === finalLessonOrder,
    );

    if (
      !lessonSchedule ||
      !lessonSchedule.startTime ||
      !lessonSchedule.endTime
    ) {
      throw new BadRequestError(
        "Dars jadvali to'liq emas - boshlanish va tugash vaqti kiritilmagan",
      );
    }

    const timeCheck = checkGradingTimeWindow(
      lessonSchedule.startTime,
      lessonSchedule.endTime,
      GRADE_TIME_LIMIT_MINUTES,
    );

    if (!timeCheck.canGrade) {
      throw new ForbiddenError(timeCheck.reason);
    }
  }

  // Date must be today
  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  const tomorrow = new Date(todayDate);
  tomorrow.setDate(tomorrow.getDate() + 1);

  // Find existing grades for this student/subject/class in teacher's all today lesson orders
  const teacherLessonOrders = teacherLessons.map((l) => l.order);
  const existingGrades = await prisma.grade.findMany({
    where: {
      studentId,
      subjectId,
      classId,
      lessonOrder: { in: teacherLessonOrders },
      date: { gte: todayDate, lt: tomorrow },
    },
    select: { id: true, lessonOrder: true },
  });

  const existingLessonOrders = new Set(
    existingGrades.map((g) => g.lessonOrder),
  );
  const missingLessonOrders = teacherLessonOrders.filter(
    (order) => !existingLessonOrders.has(order),
  );

  if (missingLessonOrders.length === 0) {
    throw new BadRequestError(
      "Bugun ushbu o'quvchiga bu fan bo'yicha barcha darslar uchun baho allaqachon qo'yilgan",
    );
  }

  // Create grade records for all missing lesson orders of today
  const now = new Date();
  const gradesToCreate = missingLessonOrders.map((order) => ({
    studentId,
    subjectId,
    classId,
    teacherId: req.user.id,
    grade,
    date: now,
    lessonOrder: order,
    comment,
  }));

  await prisma.grade.createMany({ data: gradesToCreate });

  // createMany id qaytarmaydi — yaratilgan baholarni qayta o'qib olamiz
  const createdGrades = await prisma.grade.findMany({
    where: {
      studentId,
      subjectId,
      classId,
      teacherId: req.user.id,
      lessonOrder: { in: missingLessonOrders },
      date: { gte: todayDate, lt: tomorrow },
    },
  });

  const populatedGrade = await attachGradeRefs(createdGrades[0]);

  // Update WeeklyStats after creating grades
  try {
    for (const createdGrade of createdGrades) {
      await updateWeeklyStatsForGrade(createdGrade);
    }
  } catch (statsError) {
    logger.error("Error updating WeeklyStats:", statsError);
    // Don't fail the request if stats update fails
  }

  res.status(201).json({
    success: true,
    message:
      createdGrades.length > 1
        ? `Baho muvaffaqiyatli qo'yildi va ${createdGrades.length} ta dars soatiga avtomatik qo'llandi`
        : "Baho muvaffaqiyatli qo'yildi",
    data: populatedGrade,
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

  // Only teacher can edit
  if (req.user.role !== "teacher") {
    throw new ForbiddenError("Faqat o'qituvchi baho tahrirlashi mumkin");
  }

  // Can only edit own grades
  if (gradeDoc.teacherId !== req.user.id) {
    throw new ForbiddenError("Bu bahoni tahrirlash uchun ruxsatingiz yo'q");
  }

  // Can only edit today's grades
  const gradeDate = new Date(gradeDoc.date);
  gradeDate.setHours(0, 0, 0, 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (gradeDate.getTime() !== today.getTime()) {
    throw new ForbiddenError("Faqat bugungi baholarni tahrirlash mumkin");
  }

  // Check grading time window for updates (only if enabled in config)
  const { ENABLE_SCHEDULE_TIME_VALIDATION } = require("../utils/constants");

  if (ENABLE_SCHEDULE_TIME_VALIDATION) {
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

    if (
      !lessonSchedule ||
      !lessonSchedule.startTime ||
      !lessonSchedule.endTime
    ) {
      throw new BadRequestError(
        "Dars jadvali to'liq emas - boshlanish va tugash vaqti kiritilmagan",
      );
    }

    const { checkGradingTimeWindow } = require("../helpers/date.helpers");
    const { GRADE_TIME_LIMIT_MINUTES } = require("../utils/constants");

    const timeCheck = checkGradingTimeWindow(
      lessonSchedule.startTime,
      lessonSchedule.endTime,
      GRADE_TIME_LIMIT_MINUTES,
    );

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

  // Update WeeklyStats after updating grade
  try {
    await updateWeeklyStatsForGrade(savedGrade);
  } catch (statsError) {
    logger.error("Error updating WeeklyStats:", statsError);
    // Don't fail the request if stats update fails
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

  // If teacher role, apply restrictions
  if (req.user.role === "teacher") {
    // Can only delete own grades
    if (grade.teacherId !== req.user.id) {
      throw new ForbiddenError("Bu bahoni o'chirish uchun ruxsatingiz yo'q");
    }

    // Can only delete today's grades
    const gradeDate = new Date(grade.date);
    gradeDate.setHours(0, 0, 0, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (gradeDate.getTime() !== today.getTime()) {
      throw new ForbiddenError("Faqat bugungi baholarni o'chirish mumkin");
    }
  }

  // Save grade data before deleting (for WeeklyStats update)
  const gradeData = {
    studentId: grade.studentId,
    subjectId: grade.subjectId,
    classId: grade.classId,
    teacherId: grade.teacherId,
    grade: grade.grade,
    date: grade.date,
    lessonOrder: grade.lessonOrder,
  };

  // Delete the grade
  await prisma.grade.delete({ where: { id: req.params.id } });

  // Update WeeklyStats after deleting grade
  try {
    await updateWeeklyStatsForGrade(gradeData);
  } catch (statsError) {
    logger.error("Error updating WeeklyStats:", statsError);
    // Don't fail the request if stats update fails
  }

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

  let where = { studentId };

  // If date is provided, filter by that specific date
  if (date) {
    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    where.date = { gte: startDate, lte: endDate };
  }

  const gradeRows = await prisma.grade.findMany({
    where,
    orderBy: { date: "desc" },
  });

  // student baholari — subject/teacher/class ref'larni qo'lda biriktiramiz
  const grades = await attachGradeRefs(gradeRows, { student: false });

  // Statistics by subject
  const statsBySubject = {};
  grades.forEach((g) => {
    const subjectName = g.subject.name;
    if (!statsBySubject[subjectName]) {
      statsBySubject[subjectName] = {
        subject: g.subject,
        grades: [],
        average: 0,
        count: 0,
      };
    }
    statsBySubject[subjectName].grades.push(g.grade);
    statsBySubject[subjectName].count++;
  });

  // Calculate average
  Object.keys(statsBySubject).forEach((subjectName) => {
    const stats = statsBySubject[subjectName];
    stats.average = (
      stats.grades.reduce((a, b) => a + b, 0) / stats.count
    ).toFixed(2);
  });

  res.json({
    success: true,
    data: {
      grades,
      statistics: statsBySubject,
    },
  });
});

// Get teacher's subjects in a class (for grade adding - TODAY's schedule only)
const getTeacherSubjectsInClass = asyncHandler(async (req, res) => {
  const { classId } = req.params;

  if (req.user.role !== "teacher") {
    throw new ForbiddenError("Faqat o'qituvchilar uchun");
  }

  // Get today's day name in Uzbek
  const daysUz = [
    "yakshanba",
    "dushanba",
    "seshanba",
    "chorshanba",
    "payshanba",
    "juma",
    "shanba",
  ];
  const today = new Date();
  const todayDayName = daysUz[today.getDay()];

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

  // Get unique subject IDs for progress lookup
  const teacherSubjectIds = new Set();
  todaySchedule.lessons.forEach((item) => {
    if (item.teacherId === req.user.id) {
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

  // Get progress for all teacher's subjects in this class
  const progressList = await prisma.classSubjectProgress.findMany({
    where: {
      classId,
      subjectId: { in: teacherSubjectIdList },
    },
  });

  // Create progress map
  const progressMap = new Map();
  for (const p of progressList) {
    progressMap.set(p.subjectId, p.currentTopicNumber);
  }

  todaySchedule.lessons.forEach((item) => {
    if (item.teacherId === req.user.id) {
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
        currentTopicNumber: progressMap.get(subjectId) || 1,
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

// Get students with their grades for a class, subject and date
const getStudentsWithGrades = asyncHandler(async (req, res) => {
  const { classId, subjectId, date, lessonOrder } = req.query;

  if (!classId || !subjectId || !date) {
    throw new BadRequestError("Sinf, fan va sana majburiy");
  }

  const finalLessonOrder = lessonOrder ? parseInt(lessonOrder) : null;

  // Get all students in the class
  const students = await prisma.user.findMany({
    where: { role: "student", classes: { some: { classId } } },
    select: { id: true, firstName: true, lastName: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

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

  // Get current topic for this class and subject from ClassSubjectProgress
  let currentTopic = null;
  const progress = await prisma.classSubjectProgress.findUnique({
    where: { classId_subjectId: { classId, subjectId } },
  });

  const currentTopicNumber = progress?.currentTopicNumber || 1;

  const topic = await prisma.topic.findUnique({
    where: { subjectId_order: { subjectId, order: currentTopicNumber } },
    select: { order: true, name: true, description: true },
  });

  if (topic) {
    currentTopic = {
      number: topic.order,
      name: topic.name,
      description: topic.description || "",
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
    where: { role: "student", classes: { some: { classId } } },
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
  updateGrade,
  deleteGrade,
  getStudentGrades,
  getStudentsWithGrades,
  getGradesByClassAndDate,
  getTeacherSubjectsInClass,
  exportGrades,
};
