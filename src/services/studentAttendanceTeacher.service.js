/**
 * O'QITUVCHI O'Z DARSIGA KIRGAN O'QUVCHILARNING DAVOMATINI BELGILAYDI.
 *
 * Qoida bitta jumlada:
 *
 * > O'qituvchi BUGUN o'zi dars o'tadigan (yoki o'rinbosar bo'lib chiqadigan)
 * > sinfning shu kuni O'QIYOTGAN o'quvchilarini belgilaydi — maktabda turib.
 *
 * ⚠️ YADRO BITTA. Yozuvni `studentAttendance.service.js` dagi
 * `markAttendance` yozadi, bu servis esa faqat DARVOZA: kun, maktabda
 * bo'lish, sinfga huquq va o'quvchining ro'yxatda borligi. Mustaqil SQL
 * yozilsa, qabulxona yo'liga qo'shilgan shart (izoh qoidasi, `autoMarked`
 * tozalash, upsert kaliti) o'qituvchi yo'lida jimgina tushib qolardi.
 *
 * ⚠️ HUQUQ DARS JADVALIDAN KELADI, ruxsat kalitidan EMAS
 * (`/tutor-groups/my` va `/grades/teacher/classes` bilan AYNI qoida):
 * o'qituvchi id si TOKENDAN, sinflar esa `resolveLessonAccess` dan — o'z
 * darsi va o'rinbosarlik (`education.md` §8). Har so'rovda QAYTA
 * hisoblanadi: jadval o'zgarsa yoki dars o'rinbosarga berilsa, eskirgan
 * ekran begona sinfga tegib ketmaydi.
 *
 * ⚠️ FANGA BAHO RUXSATI (`GradingGrant`) DAVOMATGA HUQUQ BERMAYDI. U
 * ataylab faqat BAHO uchun berilgan qo'shimcha huquq (`education.md` §7):
 * boshqa o'qituvchining sinfiga baho qo'yadigan odam o'sha sinfning KUNLIK
 * davomatini ham yozsa, dars egasining qaroriga aralashardi. Shu sabab
 * hal qiluvchiga `grants: []` beriladi — ro'yxat keyin filtrlanmaydi,
 * umuman so'ralmaydi.
 *
 * ⚠️ DAVOMAT KUNLIK, DARS KESIMIDA EMAS (`@@unique([studentId, date])`).
 * Ikkinchi o'q (dars bo'yicha davomat) qo'shilsa, davomat foizi, baho
 * jarimasi maxraji (`education.md` §7), kechki "kelmadi" job va hisobotlar
 * ikkita haqiqat manbaidan o'qiydigan bo'lardi. Shuning uchun o'qituvchi
 * KUN yozuvining O'ZINI yozadi — qabulxona bilan AYNI qator — va KIM
 * belgilaganini ko'radi (`markedBy`): boshqaning qarori jim qolmasin.
 *
 * ⚠️ FAQAT BUGUN. O'tgan kunni ma'muriyat to'g'rilaydi
 * (`attendance.update`): davomat baho jarimasi maxrajiga ta'sir qiladi,
 * ya'ni orqa sanab yozish o'tgan kunlarning jarimasini qayta hisoblatardi.
 * Kelajak kun ham yopiq. `?date=` berilsa tekshiriladi va jim e'tiborsiz
 * qoldirilmaydi — aks holda panel boshqa kunni so'rab, bugunning javobini
 * olib turardi.
 *
 * ⚠️ FAQAT MAKTABDA — baho qo'yish bilan AYNI shart va AYNI sozlama
 * (`gradingPresence.service.js`, `AttendanceSettings.gradingRequiresPresence`).
 *
 * ⚠️ YAKSHANBA / BAYRAM / TA'TIL OYIDA ro'yxat yopiq (`closed`) — kechki
 * "kelmadi" job va soat hisobi bilan AYNI kunlar (`education.md` §2, §9).
 *
 * ⚠️ YUBORILGAN `studentId` SERVER RO'YXATI BILAN TEKSHIRILADI va sinf ham
 * SERVERDAN qo'yiladi. Panel yuborgan ro'yxatga ishonilmaydi (`LessonCredit`
 * doktrinasi bilan AYNI): usiz o'qituvchi istalgan o'quvchiga istalgan
 * holatni yozib yuborardi.
 */

const prisma = require("../config/prisma");
const { BadRequestError, ForbiddenError } = require("../utils/errors");
const { currentDayDate, parseDayDate, monthKeyOfDate } = require("../helpers/month.helpers");
const { dayKey } = require("../helpers/lessonHours");
const { formatDateUz } = require("../helpers/date.helpers");
const {
  scheduleDayOf,
  getSubstitutionCells,
  resolveLessonAccess,
} = require("../helpers/teacherAccess");
const { buildHolidaySet } = require("./holiday.service");
const { getVacationSet } = require("./vacationMonth.service");
const { getGradingPresence, assertAtSchool } = require("./gradingPresence.service");
const { getScheduleSettings } = require("./settings.service");
const studentAttendance = require("./studentAttendance.service");

const { STUDENT_STATUSES } = studentAttendance;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const NO_LESSON_MESSAGE =
  "Bugun bu sinfda sizning darsingiz yo'q — davomat faqat o'zingiz dars o'tadigan sinflarga belgilanadi";

const PAST_DAY_MESSAGE =
  "O'qituvchi faqat BUGUNGI davomatni belgilaydi — boshqa kunni ma'muriyat to'g'rilaydi";

/**
 * KUN — faqat bugun.
 *
 * @param {string|undefined} dateInput - "YYYY-MM-DD" (ixtiyoriy)
 * @returns {Date} Toshkent kunining UTC yarim tuni
 */
function resolveTeacherDay(dateInput) {
  const today = currentDayDate();
  if (!dateInput) return today;

  const day = parseDayDate(dateInput, "Sana");
  if (day.getTime() !== today.getTime()) {
    throw new BadRequestError(PAST_DAY_MESSAGE);
  }
  return today;
}

/**
 * KUN OCHIQMI — yakshanba, bayram va ta'til oyida dars yo'q.
 *
 * @param {Date} day
 * @returns {Promise<{closed: string|null, message: string|null}>}
 */
async function buildDayState(day) {
  if (!scheduleDayOf(day)) {
    return { closed: "sunday", message: "Yakshanba — dars yo'q" };
  }

  const [holidaySet, vacationSet] = await Promise.all([
    buildHolidaySet(day, day),
    getVacationSet(),
  ]);

  if (holidaySet.has(dayKey(day))) {
    return { closed: "holiday", message: "Bayram kuni — dars yo'q" };
  }
  if (vacationSet.has(monthKeyOfDate(day))) {
    return { closed: "vacation", message: "Ta'til oyi — dars yo'q" };
  }

  return { closed: null, message: null };
}

/**
 * O'QITUVCHI SHU KUNI DARS O'TADIGAN DARSLAR (sinf kesimida tekis ro'yxat).
 *
 * Nomzod sinflar ikki manbadan: o'z jadvali va o'rinbosar bo'lgan kataklar.
 * So'ng HAR sinf `resolveLessonAccess` dan o'tadi — ya'ni "egasiga berilib
 * yuborilgan dars" ham, "eskirgan o'rinbosarlik katagi" ham AYNI qoida
 * bilan chiqib ketadi (ikkinchi nusxa yozilmaydi).
 *
 * @param {{id: string}} actor - `req.user`
 * @param {Date} day
 * @returns {Promise<Array<{classId: string, className: string, subjectId: string,
 *   order: number, startTime: string|null, substituted: boolean}>>}
 */
async function loadTeacherLessons(actor, day) {
  const dayName = scheduleDayOf(day);
  if (!dayName) return [];

  const [ownLessons, cells] = await Promise.all([
    prisma.scheduleLesson.findMany({
      where: { teacherId: actor.id, schedule: { day: dayName } },
      select: { schedule: { select: { classId: true } } },
    }),
    getSubstitutionCells(day),
  ]);

  const classIds = new Set(ownLessons.map((l) => l.schedule.classId));
  for (const cell of cells.values()) {
    if (cell.substituteTeacherId === actor.id) classIds.add(cell.classId);
  }
  if (classIds.size === 0) return [];

  const [schedules, classes, settings] = await Promise.all([
    prisma.schedule.findMany({
      where: { day: dayName, classId: { in: [...classIds] } },
      include: { lessons: { orderBy: { position: "asc" } } },
    }),
    // ⚠️ Nofaol sinf chiqib ketadi: u faqat tarixni ushlab turadi
    // (filiallararo ko'chirishda shunday ochiladi) va joriy ro'yxatlarga
    // kirmaydi — "Darsga kelmaganlar" bilan AYNI shart.
    prisma.class.findMany({
      where: { id: { in: [...classIds] }, isActive: true },
      select: { id: true, name: true },
    }),
    getScheduleSettings(),
  ]);

  const classMap = new Map(classes.map((c) => [c.id, c.name]));
  const periods = new Map(
    (Array.isArray(settings.periods) ? settings.periods : []).map((p) => [
      Number(p.order),
      p,
    ]),
  );

  const rows = [];

  for (const schedule of schedules) {
    const className = classMap.get(schedule.classId);
    if (!className) continue;

    const access = await resolveLessonAccess({
      actor,
      classId: schedule.classId,
      date: day,
      lessons: schedule.lessons,
      cells,
      // ⚠️ Fanga baho ruxsati davomatga huquq bermaydi (fayl izohi)
      grants: [],
    });

    for (const lesson of access.lessons) {
      rows.push({
        classId: schedule.classId,
        className,
        subjectId: lesson.subjectId,
        order: lesson.order,
        // Darsning o'z vaqti, bo'lmasa "Dars vaqtlari" sozlamasi — o'qituvchi
        // qaysi dars ekanini soatdan taniydi ("Darsga kelmaganlar" bilan AYNI)
        startTime: TIME_RE.test(lesson.startTime ?? "")
          ? lesson.startTime
          : (periods.get(lesson.order)?.startTime ?? null),
        substituted: lesson.access === "substitution",
      });
    }
  }

  return rows;
}

/** Tekis darslar ro'yxatini sinf kesimiga guruhlaydi (nom bo'yicha A-Z). */
function groupByClass(rows) {
  const byClass = new Map();

  for (const row of rows) {
    let entry = byClass.get(row.classId);
    if (!entry) {
      entry = { id: row.classId, name: row.className, lessons: [] };
      byClass.set(row.classId, entry);
    }
    entry.lessons.push({
      order: row.order,
      subjectId: row.subjectId,
      // ⚠️ Fan nomi guruhlashdan OLDIN biriktirilgan (`attachSubjectNames`) —
      // bu yerda ko'chirilmasa, dars ekranda nomsiz chiqardi
      subjectName: row.subjectName ?? null,
      startTime: row.startTime,
      substituted: row.substituted,
    });
  }

  for (const entry of byClass.values()) {
    entry.lessons.sort((a, b) => a.order - b.order);
  }

  return [...byClass.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "uz", { numeric: true }),
  );
}

/** Fan nomlari — scalar ref, bitta so'rovda yuklanadi. */
async function attachSubjectNames(lessons) {
  const ids = [...new Set(lessons.map((l) => l.subjectId).filter(Boolean))];
  const subjects = ids.length
    ? await prisma.subject.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      })
    : [];
  const nameOf = new Map(subjects.map((s) => [s.id, s.name]));

  return lessons.map((lesson) => ({
    ...lesson,
    subjectName: nameOf.get(lesson.subjectId) ?? null,
  }));
}

/**
 * Sinf kartalaridagi yig'indi ("18 / 20 belgilandi").
 *
 * ⚠️ Doira kunlik sahifalar bilan AYNI: shu kuni o'qiyotgan faol
 * o'quvchilar (`loadEnrollmentsOn`). Aks holda kartada "20 dan 18 tasi"
 * turib, sinf ochilganda belgilanmagan bola topilmasdi.
 */
async function attachClassSummaries(classes, day) {
  const classIds = classes.map((c) => c.id);

  const members = await prisma.user.findMany({
    where: {
      ...studentAttendance.ACTIVE_STUDENT_WHERE,
      classes: { some: { classId: { in: classIds } } },
    },
    select: { id: true, classes: { select: { classId: true } } },
  });

  const enrollments = await studentAttendance.loadEnrollmentsOn(
    day,
    members.map((s) => s.id),
  );
  const studying = members.filter((s) => enrollments.has(s.id));

  const records = studying.length
    ? await prisma.studentAttendance.findMany({
        where: { date: day, studentId: { in: studying.map((s) => s.id) } },
        select: { studentId: true, status: true },
      })
    : [];
  const recordOf = new Map(records.map((r) => [r.studentId, r]));

  const idsByClass = new Map(classIds.map((id) => [id, []]));
  for (const student of studying) {
    for (const { classId } of student.classes) {
      idsByClass.get(classId)?.push(student.id);
    }
  }

  return classes.map((cls) => {
    const ids = idsByClass.get(cls.id) ?? [];
    const rows = ids.map((id) => recordOf.get(id)).filter(Boolean);
    return { ...cls, summary: studentAttendance.buildSummary(ids.length, rows) };
  });
}

/**
 * Qatorni o'qituvchi ekraniga keltiradi: KIM belgilagani qo'shiladi,
 * TELEFON RAQAMI esa olib tashlanadi.
 *
 * ⚠️ Raqam ataylab chiqarilmaydi. Umumiy ro'yxat quruvchisi
 * (`STUDENT_SELECT`) uni qabulxona ekrani uchun oladi; o'qituvchining bu
 * bo'limi esa davomat BELGILAYDI, qo'ng'iroq qilmaydi. Yo'lni javobda
 * qoldirish o'qituvchiga maktab hech qachon bermagan ma'lumotni jimgina
 * ochib berardi — kerak bo'lsa bu ONGLI qaror bilan qo'shiladi.
 */
async function attachMarkedBy(rows, actorId) {
  const ids = [
    ...new Set(rows.map((r) => r.attendance?.lastModifiedBy).filter(Boolean)),
  ];
  const people = ids.length
    ? await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const nameOf = new Map(
    people.map((p) => [p.id, `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim()]),
  );

  return rows.map((row) => {
    const id = row.attendance?.lastModifiedBy ?? null;
    const { phone, parentPhone, ...student } = row.student;

    return {
      ...row,
      student,
      markedBy: id
        ? { id, name: nameOf.get(id) || "Noma'lum", isMe: id === actorId }
        : null,
    };
  });
}

/** Ikkala o'qish yo'li uchun umumiy kun sarlavhasi. */
function dayHeader(day, state, presence) {
  return {
    date: dayKey(day),
    // ⚠️ `day` — UTC yarim tuni (`dates.md` §4)
    dateLabel: formatDateUz(day, { utc: true }),
    dayName: scheduleDayOf(day),
    closed: state.closed,
    message: state.message,
    presence,
    canMark: !state.closed && presence.atSchool,
  };
}

/**
 * BUGUN DAVOMAT BELGILANADIGAN SINFLAR — darslari va yig'indisi bilan.
 *
 * @param {{id: string, role: string}} actor
 * @param {{date?: string}} [query]
 */
async function getTeacherDay(actor, { date } = {}) {
  const day = resolveTeacherDay(date);
  const [state, presence] = await Promise.all([
    buildDayState(day),
    getGradingPresence(actor),
  ]);

  const base = { ...dayHeader(day, state, presence), classes: [] };
  if (state.closed) return base;

  const lessons = await loadTeacherLessons(actor, day);
  if (lessons.length === 0) return base;

  const classes = groupByClass(await attachSubjectNames(lessons));
  return { ...base, classes: await attachClassSummaries(classes, day) };
}

/**
 * BITTA SINFNING BUGUNGI RO'YXATI — belgilash ekranining ma'lumoti.
 *
 * Ro'yxatning o'zi `getTodayClassAttendance` dan: o'qish davri filtri,
 * qator kontrakti (`{ student, attendance, classId, enrollment }`) va
 * yig'indi qabulxona ekrani bilan AYNI bo'lishi uchun.
 *
 * @param {{id: string, role: string}} actor
 * @param {{classId: string, date?: string}} params
 */
async function getTeacherClassRoster(actor, { classId, date } = {}) {
  if (!classId) throw new BadRequestError("Sinf ko'rsatilmagan (classId)");

  const day = resolveTeacherDay(date);
  const [state, presence] = await Promise.all([
    buildDayState(day),
    getGradingPresence(actor),
  ]);
  if (state.closed) throw new ForbiddenError(state.message);

  const lessons = await loadTeacherLessons(actor, day);
  const mine = lessons.filter((l) => l.classId === classId);
  if (mine.length === 0) throw new ForbiddenError(NO_LESSON_MESSAGE);

  // ⚠️ `null` — "bugun": kun matn orqali aylanib o'tmaydi (`resolveDay`
  // bugunni o'zi beradi va u `currentDayDate()` bilan AYNI qiymat)
  const roster = await studentAttendance.getTodayClassAttendance(classId, null);

  const [classLessons] = groupByClass(await attachSubjectNames(mine));

  return {
    ...dayHeader(day, state, presence),
    classInfo: { id: roster.classInfo.id, name: roster.classInfo.name },
    lessons: classLessons.lessons,
    students: await attachMarkedBy(roster.students, actor.id),
    summary: roster.summary,
  };
}

/**
 * BELGILASH — darvozadan o'tib, yozuvni yadroga topshiradi.
 *
 * @param {{id: string, role: string}} actor
 * @param {{classId: string, date?: string, records: Array}} params
 */
async function markTeacherAttendance(actor, { classId, date, records } = {}) {
  if (!classId) throw new BadRequestError("Sinf ko'rsatilmagan (classId)");
  if (!Array.isArray(records) || records.length === 0) {
    throw new BadRequestError("Belgilash uchun yozuvlar yo'q");
  }

  const day = resolveTeacherDay(date);

  const state = await buildDayState(day);
  if (state.closed) throw new ForbiddenError(state.message);

  // Maktabda bo'lish — baho qo'yish bilan AYNI shart
  await assertAtSchool(actor);

  const lessons = await loadTeacherLessons(actor, day);
  if (!lessons.some((l) => l.classId === classId)) {
    throw new ForbiddenError(NO_LESSON_MESSAGE);
  }

  const roster = await studentAttendance.getTodayClassAttendance(classId, null);
  const allowed = new Set(roster.students.map((row) => row.student.id));

  const seen = new Set();
  for (const rec of records) {
    if (!rec || typeof rec !== "object" || !rec.studentId) {
      throw new BadRequestError("Har bir yozuvda studentId bo'lishi shart");
    }
    if (seen.has(rec.studentId)) {
      throw new BadRequestError("Bitta o'quvchi ikki marta yuborilgan");
    }
    seen.add(rec.studentId);

    // ⚠️ Ro'yxat SERVERDAN: eskirgan ekran ham, qo'lda yozilgan so'rov ham
    // boshqa sinfning yoki ketgan o'quvchining davomatiga tegmaydi
    if (!allowed.has(rec.studentId)) {
      throw new ForbiddenError(
        "Ro'yxatda yo'q o'quvchi belgilanmaydi — ro'yxatni yangilang",
      );
    }

    // ⚠️ HOLAT YOZISHDAN OLDIN tekshiriladi. Yadro ham tekshiradi
    // (`resolveReasonFields`), lekin u har yozuvni SIKL ichida yozadi: 20
    // qatorning 19-tasi xato bo'lsa, oldingi 18 tasi allaqachon yozilgan
    // bo'lib, o'qituvchi "saqlanmadi" degan xatoni ko'rar, davomat esa
    // yarim belgilangan qolardi. Ro'yxat BITTA (`STUDENT_STATUSES`) —
    // ikkinchi nusxa emas.
    if (!STUDENT_STATUSES.includes(rec.status)) {
      throw new BadRequestError(`Noto'g'ri status: ${rec.status}`);
    }
  }

  // Izoh qoidasi yadroda (`resolveReasonFields`) — bu yerda
  // takrorlanmaydi; sinf esa SERVERDAN qo'yiladi
  return studentAttendance.markAttendance(
    {
      classId,
      records: records.map(({ studentId, status, excuseReason }) => ({
        studentId,
        classId,
        status,
        excuseReason,
      })),
    },
    actor.id,
  );
}

module.exports = {
  NO_LESSON_MESSAGE,
  PAST_DAY_MESSAGE,
  resolveTeacherDay,
  buildDayState,
  loadTeacherLessons,
  getTeacherDay,
  getTeacherClassRoster,
  markTeacherAttendance,
};
