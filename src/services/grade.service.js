/**
 * BAHOLAR — o'qish so'rovlari.
 *
 * ⚠️ Bu mantiq ilgari faqat `grade.controller.js` ichida (`res.json` bilan
 * birga) yashardi. U HTTP'dan tashqarida ham kerak bo'ldi (egasining AI
 * yordamchisi): controllerni soxta `req/res` bilan chaqirish ikkinchi,
 * mo'rt yo'l bo'lardi, mantiqni ko'chirib yozish esa ikki xil haqiqat
 * manbai. Shuning uchun u AYNAN O'ZGARISHSIZ shu yerga olib chiqildi va
 * controller shu funksiyalarni chaqiradi — javob shakli bayt-baytigacha
 * avvalgidek.
 *
 * Yozish amallari (`createGrade`, `updateGrade`, `deleteGrade`) controllerda
 * qoladi: ular o'qituvchining o'z darsiga bog'langan va AI yordamchisiga
 * ataylab ochilmaydi.
 */

const prisma = require("../config/prisma");
const { isHoliday } = require("./holiday.service");
const {
  getSubstitutionCells,
  effectiveTeacherOf,
} = require("../helpers/teacherAccess");
// ⚠️ TOSHKENT KUNI. `teacherAccess` sanani FAQAT `getUTC*` bilan o'qiydi,
// jadval esa Toshkent devor-soati bilan olinadi — `new Date()` berilsa
// 00:00–05:00 orasida ikkalasi boshqa-boshqa hafta kunini ko'rsatardi.
const { currentDayDate, parseRangeBound } = require("../helpers/month.helpers");
const {
  getDayNameUz,
  getDateRangeForDay,
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

const EMPTY_SUMMARY = () => ({
  totalTeachers: 0,
  totalLessons: 0,
  totalMissingStudents: 0,
});

/**
 * Bugun baho qo'yilmagan darslar — o'qituvchilar kesimida.
 *
 * Faqat TUGAGAN darslar (yoki tugash vaqti yo'q darslar) tekshiriladi.
 * Hisobot AMALDA darsga chiqqan odamni ko'rsatadi (o'rinbosarlik hisobga
 * olinadi) — jarima joblari bilan bir xil qoida.
 *
 * @returns {Promise<object>} `GET /api/grades/missing-today` javobining `data` qismi
 */
async function getMissingGradesToday() {
  const nowInUzbekistan = getNowInUzbekistan();

  // 1. Yakshanba tekshirish
  if (isSunday(nowInUzbekistan)) {
    return {
      isHoliday: false,
      isSunday: true,
      message: "Yakshanba kuni dars yo'q",
      byTeacher: [],
      summary: EMPTY_SUMMARY(),
    };
  }

  // 2. Bayram kuni tekshirish
  const holidayCheck = await isHoliday(nowInUzbekistan);
  if (holidayCheck.isHoliday) {
    return {
      isHoliday: true,
      holiday: holidayCheck.holiday,
      message: `Bugun dam olish kuni: ${holidayCheck.holiday.name}`,
      byTeacher: [],
      summary: EMPTY_SUMMARY(),
    };
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

  // ⚠️ O'RINBOSARLIK — hisobot amalda darsga chiqqan odamni ko'rsatishi
  // kerak. Kataklar BITTA so'rov bilan olinadi va o'rinbosarlarning ismi
  // ham quyidagi `teachers` so'roviga qo'shiladi: aks holda `teacherMap`
  // da topilmay, qator jimgina tushib qolardi.
  const missingSubstitutionCells = await getSubstitutionCells(currentDayDate());

  for (const cell of missingSubstitutionCells.values()) {
    if (!lessonTeacherIds.includes(cell.substituteTeacherId)) {
      lessonTeacherIds.push(cell.substituteTeacherId);
    }
  }

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

        // ⚠️ Hisobot AMALDA darsga chiqqan odamni ko'rsatadi. Aks holda
        // boshliq kasal bo'lib darsini bergan o'qituvchini "baho qo'ymadi"
        // deb qidirib yurardi — jarima joblari bilan bir xil qoida.
        const effective = effectiveTeacherOf(
          {
            classId: schedule.classId,
            day: schedule.day,
            order: lesson.order,
            teacherId: lesson.teacherId,
          },
          missingSubstitutionCells,
        );

        const lessonTeacher = teacherMap.get(effective.teacherId);
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

  return {
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
  };
}

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

/**
 * O'quvchining baholari va fanlar bo'yicha statistikasi.
 *
 * @param {string} studentId
 * @param {object} [options]
 * @param {string} [options.date] - bitta kun (HTTP yo'li; host-lokal kun oynasi)
 * @param {string} [options.from] - "YYYY-MM-DD", Toshkent kuni boshidan (INKLYUZIV)
 * @param {string} [options.to] - "YYYY-MM-DD", Toshkent kuni oxirigacha (INKLYUZIV)
 *
 * ⚠️ `date` va `from/to` BIRGA berilmaydi. `date` — mavjud HTTP yo'lining
 * xatti-harakati va u o'zgarmaydi. `from/to` esa `Grade.date` HAQIQIY
 * instant bo'lgani uchun Toshkent devor-soati chegaralari bilan quriladi
 * (`parseRangeBound`), host taymzonasiga bog'liq emas.
 *
 * @returns {Promise<{grades: object[], statistics: object}>}
 */
async function getStudentGrades(studentId, { date, from, to } = {}) {
  let where = { studentId };

  // If date is provided, filter by that specific date
  if (date) {
    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    where.date = { gte: startDate, lte: endDate };
  } else if (from || to) {
    where.date = {};
    if (from) where.date.gte = parseRangeBound(from, "Boshlanish sanasi", "start");
    if (to) where.date.lte = parseRangeBound(to, "Tugash sanasi", "end");
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

  return {
    grades,
    statistics: statsBySubject,
  };
}

module.exports = {
  getMissingGradesToday,
  attachGradeRefs,
  getStudentGrades,
};
