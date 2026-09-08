/**
 * DARS O'RINBOSARLIGI — dars o'rniga chiqish.
 *
 * O'qituvchi kasal bo'lib qoldi; uning darslarini boshqa o'qituvchi o'tadi.
 * Bitta yozuv UCH natijani BIRGA beradi:
 *
 *   1. JADVAL — kim kimning o'rniga, qaysi kunlar, qaysi darslar;
 *   2. HUQUQ  — o'rinbosarga AYNAN o'sha dars uchun jurnal ochiladi
 *               (`helpers/teacherAccess.js`), egasiga esa yopiladi;
 *   3. PUL    — soat egasidan ayiriladi, o'rinbosarga qo'shiladi
 *               (`lessonHours.service.js`).
 *
 * Uchalasi bitta manbadan o'qigani uchun "jurnalda o'rinbosar ko'rinadi,
 * lekin oylik egasiga yozilib qolgan" degan holat STRUKTURAVIY imkonsiz.
 *
 * ⚠️ ATAMA: "almashtirish" EMAS. Bu so'z domenda BAND — u filial
 * almashtirishni bildiradi (`auth.service.js`, `security.service.js`,
 * `permissions.js`). Foydalanuvchiga ko'rinadigan matnda ham, kodda ham
 * "o'rinbosar" / "dars o'rniga chiqish".
 *
 * ⚠️ JADVAL TAHRIRLANMAYDI. `ScheduleLesson.teacherId` — e'lon qilingan
 * fakt, butun maktab ko'radi va u kelasi haftaga ham tegishli. Bir haftalik
 * kasallik uchun uni o'zgartirish "kim aslida bu darsning o'qituvchisi"
 * degan savolni yo'q qilardi va muddat tugaganda kim qaytarishini hech kim
 * bilmasdi.
 *
 * ⚠️ DARSGA `scheduleLessonId` BILAN ISHORA QILINMAYDI — `saveClassSchedule`
 * sinf jadvalini saqlaganda qatorlarni o'chirib qayta yaratadi. Kalit
 * darsning JADVALDAGI O'RNI: (classId, day, lessonOrder).
 */

const prisma = require("../config/prisma");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const logger = require("../utils/logger");
const { ROLES, DAYS_UZ } = require("../utils/constants");
const { formatDateUz, formatDateRangeUz } = require("../helpers/date.helpers");
const {
  parseDayDate,
  currentDayDate,
  monthKeyOfDate,
} = require("../helpers/month.helpers");
const { DAY_TO_NUMBER } = require("./scheduleWorkTime.service");
const { getScheduleSettings } = require("./settings.service");
const { buildHolidaySet } = require("./holiday.service");
const { getVacationSet } = require("./vacationMonth.service");
const { dayKey } = require("../helpers/lessonHours");

// Oynaning maksimal uzunligi. Cheksiz muddat "vaqtincha" degan so'zning
// ma'nosini yo'qotardi va jadvalni jimgina qayta yozib qo'ygan bo'lardi:
// uzoqroq kerak bo'lsa, dars jadvalining o'zi o'zgartiriladi.
const MAX_WINDOW_DAYS = 180;

const REASON_LABELS = {
  illness: "Kasallik",
  business_trip: "Xizmat safari",
  personal: "Shaxsiy sabab",
  training: "Malaka oshirish",
  other: "Boshqa sabab",
};

const STATUS_LABELS = {
  active: "Amalda",
  cancelled: "Bekor qilingan",
};

const TEACHER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  role: true,
  isArchived: true,
};

const fullName = (person) =>
  person ? `${person.firstName} ${person.lastName ?? ""}`.trim() : "Noma'lum";

/**
 * Yozuv AMALDAMI — sana bo'yicha holat.
 *
 * `status` — QAROR (bekor qilinganmi), bu esa VAQT: o'tib ketgan
 * o'rinbosarlik ham `active` bo'lib qoladi, chunki u haqiqatan bo'lib
 * o'tgan va oylikda hisobga olingan. Ikkalasini bitta ustunga siqish
 * "tarixni o'chirish" degani bo'lardi.
 */
const phaseOf = (row, today) => {
  if (row.status === "cancelled") return { key: "cancelled", label: "Bekor qilingan" };
  if (row.toDate.getTime() < today.getTime()) return { key: "finished", label: "Yakunlangan" };
  if (row.fromDate.getTime() > today.getTime()) return { key: "upcoming", label: "Kutilmoqda" };
  return { key: "ongoing", label: "Davom etmoqda" };
};

const serializeItem = (item) => ({
  id: item.id,
  classId: item.classId,
  subjectId: item.subjectId,
  day: item.day,
  dayLabel: item.day ? item.day[0].toUpperCase() + item.day.slice(1) : null,
  lessonOrder: item.lessonOrder,
  className: item.snapshot?.className ?? null,
  subjectName: item.snapshot?.subjectName ?? null,
  startTime: item.snapshot?.startTime ?? null,
  endTime: item.snapshot?.endTime ?? null,
});

const serialize = (row, { today = currentDayDate(), original, substitute } = {}) => {
  const items = (row.items ?? []).map(serializeItem);
  const phase = phaseOf(row, today);

  return {
    id: row.id,
    originalTeacherId: row.originalTeacherId,
    substituteTeacherId: row.substituteTeacherId,
    originalTeacher: original ?? null,
    substituteTeacher: substitute ?? null,
    // Xodim o'chirilgan bo'lsa ham ism qoladi
    originalTeacherName: original
      ? fullName(original)
      : row.teacherSnapshot?.original?.name || "Noma'lum",
    substituteTeacherName: substitute
      ? fullName(substitute)
      : row.teacherSnapshot?.substitute?.name || "Noma'lum",
    fromDate: row.fromDate,
    toDate: row.toDate,
    // ⚠️ `@db.Date` — `utc: true` bo'lmasa kun bir kunga siljiydi
    fromDateLabel: formatDateUz(row.fromDate, { utc: true }),
    toDateLabel: formatDateUz(row.toDate, { utc: true }),
    periodLabel: formatDateRangeUz(row.fromDate, row.toDate, { utc: true }),
    reason: row.reason,
    reasonLabel: REASON_LABELS[row.reason] ?? row.reason,
    note: row.note,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] ?? row.status,
    phase,
    // ⚠️ TAHRIRLASH VA O'CHIRISH FAQAT BOSHLANMAGAN YOZUVDA. Boshlangan
    // paytdan e'tiboran yozuv dalil bo'lib qoladi (`assertNotStarted`
    // izohiga qarang) — panel tugmalarni shu bayroqqa qarab ko'rsatadi.
    // Server baribir qayta tekshiradi; bu faqat UI qatlami.
    canEdit: phase.key === "upcoming",
    cancelReason: row.cancelReason,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    items,
    lessonCount: items.length,
    // Oyna ichida NECHA MARTA takrorlanadi — "4 soatlik dars" degani bir
    // marta emas, davr ichidagi har bir mos kun uchun bir marta.
    occurrenceCount: row.occurrenceCount ?? null,
  };
};

/**
 * O'qituvchi tekshiruvi. O'quvchi rad etiladi: u dars jadvalida o'qituvchi
 * bo'lib turolmaydi (`validateScheduleSubjects` bilan bir xil qoida).
 */
async function assertTeacher(teacherId, label) {
  if (!teacherId) throw new BadRequestError(`${label} tanlanmagan`);

  const teacher = await prisma.user.findUnique({
    where: { id: teacherId },
    select: TEACHER_SELECT,
  });

  if (!teacher) throw new NotFoundError(`${label} topilmadi`);
  if (teacher.role === ROLES.STUDENT) {
    throw new BadRequestError(`${label} o'quvchi bo'lishi mumkin emas`);
  }
  if (teacher.isArchived) {
    throw new BadRequestError(`${label} arxivlangan`);
  }

  return teacher;
}

/** Davrni o'qiydi va tekshiradi. */
function parseWindow(fromInput, toInput) {
  const fromDate = parseDayDate(fromInput, "Boshlanish sanasi");
  const toDate = parseDayDate(toInput, "Tugash sanasi");

  if (toDate < fromDate) {
    throw new BadRequestError("Tugash sanasi boshlanish sanasidan oldin bo'lishi mumkin emas");
  }

  const spanDays = Math.round((toDate - fromDate) / 86400000) + 1;
  if (spanDays > MAX_WINDOW_DAYS) {
    throw new BadRequestError(
      `O'rinbosarlik muddati ${MAX_WINDOW_DAYS} kundan oshmasligi kerak. ` +
        "Uzoqroq kerak bo'lsa, dars jadvalining o'zini o'zgartiring.",
    );
  }

  return { fromDate, toDate, spanDays };
}

/**
 * Davr ichida qaysi hafta kunlari BOR — bo'sh katak tanlanmasligi uchun.
 * @returns {Set<string>} `ScheduleDay` qiymatlari
 */
function daysWithinWindow(fromDate, toDate) {
  const set = new Set();
  const cursor = new Date(fromDate.getTime());

  while (cursor.getTime() <= toDate.getTime() && set.size < 6) {
    const name = DAYS_UZ[cursor.getUTCDay()];
    if (name && name !== "yakshanba") set.add(name);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return set;
}

/**
 * Davr ichida katak necha marta takrorlanadi — "4 ta dars" ni "haqiqatda
 * necha soat" ga aylantiradigan raqam.
 *
 * ⚠️ DARS BO'LMAYDIGAN KUNLARNING BARCHASI CHIQARILADI va ular AYNAN
 * `lessonHours.service.js` dagi bilan bir xil bo'lishi shart: yakshanba
 * (`DAYS_UZ[0]` — `byDay` da hech qachon bo'lmaydi), bayram (`holidaySet`)
 * va TA'TIL OYI (`vacationSet`).
 *
 * Ta'til oyi qoldirilsa, ekranda "12 soat" deb ko'rsatilgan o'rinbosarlik
 * oylikka 0 soat bo'lib tushardi — bir savolga ikki javob.
 *
 * @param {Array<{day: string}>} items
 * @param {Date} fromDate - INKLYUZIV
 * @param {Date} toDate - INKLYUZIV
 * @param {Set<string>} holidaySet - "YYYY-MM-DD"
 * @param {Set<number>} [vacationSet] - YYYYMM ta'til oylari
 * @returns {number}
 */
function countOccurrences(items, fromDate, toDate, holidaySet, vacationSet) {
  const byDay = new Map();
  for (const item of items) {
    byDay.set(item.day, (byDay.get(item.day) ?? 0) + 1);
  }

  let total = 0;
  const cursor = new Date(fromDate.getTime());

  while (cursor.getTime() <= toDate.getTime()) {
    const inVacation = vacationSet?.has(monthKeyOfDate(cursor)) ?? false;

    if (!inVacation && !holidaySet.has(dayKey(cursor))) {
      const name = DAYS_UZ[cursor.getUTCDay()];
      total += byDay.get(name) ?? 0;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return total;
}

/**
 * O'QITUVCHINING KO'CHIRISH MUMKIN BO'LGAN DARSLARI.
 *
 * Tanlov ekrani shu javobdan chiziladi: davr ichida haqiqatan takrorlanadigan
 * kataklar, har biri sinf/fan/vaqt bilan va allaqachon boshqa o'rinbosarga
 * berilgani belgilangan holda.
 *
 * @param {string} teacherId
 * @param {object} query - { fromDate, toDate }
 */
async function getAvailableLessons(teacherId, query = {}) {
  const teacher = await assertTeacher(teacherId, "O'qituvchi");
  const { fromDate, toDate } = parseWindow(query.fromDate, query.toDate);

  const windowDays = daysWithinWindow(fromDate, toDate);

  const [lessons, settings, taken, holidaySet, vacationSet] = await Promise.all([
    prisma.scheduleLesson.findMany({
      where: { teacherId },
      select: {
        subjectId: true,
        order: true,
        startTime: true,
        endTime: true,
        schedule: { select: { day: true, classId: true } },
      },
    }),
    getScheduleSettings(),
    prisma.lessonSubstitutionItem.findMany({
      where: {
        substitution: {
          status: "active",
          originalTeacherId: teacherId,
          fromDate: { lte: toDate },
          toDate: { gte: fromDate },
        },
      },
      select: { classId: true, day: true, lessonOrder: true },
    }),
    buildHolidaySet(fromDate, toDate),
    getVacationSet(),
  ]);

  const periodMap = new Map((settings.periods || []).map((p) => [p.order, p]));
  const takenKeys = new Set(
    taken.map((t) => `${t.classId}|${t.day}|${t.lessonOrder}`),
  );

  const classIds = [
    ...new Set(lessons.map((l) => l.schedule?.classId).filter(Boolean)),
  ];
  const subjectIds = [...new Set(lessons.map((l) => l.subjectId).filter(Boolean))];

  const [classes, subjects] = await Promise.all([
    classIds.length
      ? prisma.class.findMany({
          where: { id: { in: classIds } },
          select: { id: true, name: true },
        })
      : [],
    subjectIds.length
      ? prisma.subject.findMany({
          where: { id: { in: subjectIds } },
          select: { id: true, name: true },
        })
      : [],
  ]);

  const classMap = new Map(classes.map((c) => [c.id, c.name]));
  const subjectMap = new Map(subjects.map((s) => [s.id, s.name]));

  const rows = [];

  for (const lesson of lessons) {
    const day = lesson.schedule?.day;
    if (!day || !windowDays.has(day)) continue; // davrga tushmaydigan kun

    const period = periodMap.get(lesson.order);
    const key = `${lesson.schedule.classId}|${day}|${lesson.order}`;

    rows.push({
      key,
      classId: lesson.schedule.classId,
      className: classMap.get(lesson.schedule.classId) ?? "Noma'lum",
      subjectId: lesson.subjectId,
      subjectName: subjectMap.get(lesson.subjectId) ?? "Noma'lum",
      day,
      dayLabel: day[0].toUpperCase() + day.slice(1),
      dayNumber: DAY_TO_NUMBER.get(day) ?? 9,
      lessonOrder: lesson.order,
      startTime: lesson.startTime || period?.startTime || null,
      endTime: lesson.endTime || period?.endTime || null,
      occurrences: countOccurrences([{ day }], fromDate, toDate, holidaySet, vacationSet),
      alreadyAssigned: takenKeys.has(key),
    });
  }

  rows.sort(
    (a, b) =>
      a.dayNumber - b.dayNumber ||
      a.lessonOrder - b.lessonOrder ||
      a.className.localeCompare(b.className),
  );

  return {
    teacher,
    fromDate,
    toDate,
    periodLabel: formatDateRangeUz(fromDate, toDate, { utc: true }),
    totalLessons: rows.length,
    totalOccurrences: rows
      .filter((r) => !r.alreadyAssigned)
      .reduce((sum, r) => sum + r.occurrences, 0),
    items: rows,
  };
}

/**
 * O'QITUVCHILAR RO'YXATI — o'rinbosarlik tanlovi uchun.
 *
 * ⚠️ `/schedules/teachers` DAN FOYDALANILMAYDI: u `schedules.view`
 * ruxsatini talab qiladi. O'rinbosarlik biriktiradigan mas'ul xodimda
 * dars jadvalini TAHRIRLASH huquqi bo'lishi shart emas — aks holda
 * bitta ekran uchun butun jadval bo'limi ochib berilardi.
 *
 * Har bir qatorda haftalik dars soni bor: "kimning darsini ko'chirish
 * mumkin" degan savolga ro'yxatning O'ZI javob berishi kerak.
 */
async function getTeacherOptions() {
  const [teachers, lessons] = await Promise.all([
    prisma.user.findMany({
      where: { role: { not: ROLES.STUDENT }, isArchived: false },
      select: TEACHER_SELECT,
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
    prisma.scheduleLesson.groupBy({
      by: ["teacherId"],
      _count: { _all: true },
    }),
  ]);

  const lessonMap = new Map(lessons.map((l) => [l.teacherId, l._count._all]));

  return teachers
    .map((teacher) => ({
      ...teacher,
      name: fullName(teacher),
      weeklyHours: lessonMap.get(teacher.id) ?? 0,
    }))
    // Darsi borlar tepada: ro'yxatning maqsadi dars ko'chirish
    .sort((a, b) => b.weeklyHours - a.weeklyHours || a.name.localeCompare(b.name));
}

/**
 * TEKSHIRUV VA TAYYORLASH — yaratish ham, tahrirlash ham SHU YERDAN o'tadi.
 *
 * ⚠️ IKKI NUSXA BO'LMASLIGI SHART. Tekshiruvlar ro'yxati uzun (katak
 * egasiniki, davrga tushadimi, boshqa o'rinbosardami, o'rinbosarning o'zi
 * bandmi) va ular pulga ham, jurnal huquqiga ham ta'sir qiladi. Tahrirlash
 * uchun alohida nusxa yozilsa, ertami-kechmi bittasiga qo'shilgan shart
 * ikkinchisida unutilardi — va aynan tahrir yo'li orqali ikkita o'rinbosar
 * bitta darsga tushib qolardi.
 *
 * @param {object} data - { originalTeacherId, substituteTeacherId, fromDate,
 *   toDate, reason, note, lessons: [{ classId, day, lessonOrder }] }
 * @param {object} [options]
 * @param {string} [options.excludeId] - tahrirlanayotgan yozuv: to'qnashuv
 *   tekshiruvida u O'ZI bilan solishtirilmasligi kerak
 * @returns {Promise<object>} { original, substitute, fromDate, toDate,
 *   reason, note, itemRows }
 */
async function prepareSubstitution(data, { excludeId = null } = {}) {
  const [original, substitute] = await Promise.all([
    assertTeacher(data.originalTeacherId, "Dars egasi"),
    assertTeacher(data.substituteTeacherId, "O'rinbosar"),
  ]);

  if (original.id === substitute.id) {
    throw new BadRequestError("O'qituvchi o'z o'rniga chiqa olmaydi");
  }

  const { fromDate, toDate } = parseWindow(data.fromDate, data.toDate);

  if (!REASON_LABELS[data.reason ?? "other"]) {
    throw new BadRequestError("Sabab turi noto'g'ri");
  }
  const reason = data.reason ?? "other";
  const note = (data.note ?? "").trim();

  if (reason === "other" && !note) {
    throw new BadRequestError('"Boshqa sabab" tanlanganda izoh majburiy');
  }

  const requested = Array.isArray(data.lessons) ? data.lessons : [];
  if (requested.length === 0) {
    throw new BadRequestError("Kamida bitta dars tanlanishi kerak");
  }

  const windowDays = daysWithinWindow(fromDate, toDate);

  // Tahrirlashda yozuvning O'ZI to'qnashuv sifatida sanalmasligi kerak
  const otherActive = {
    status: "active",
    fromDate: { lte: toDate },
    toDate: { gte: fromDate },
    ...(excludeId ? { id: { not: excludeId } } : {}),
  };

  // ── 1. Tanlangan kataklar HAQIQATAN egasinikimi ──
  //
  // Jadval so'rovdan keyin o'zgargan bo'lishi mumkin, shuning uchun
  // tekshiruv YOZISHDAN OLDIN, tanlash paytidagi ro'yxatga ishonib emas.
  const ownLessons = await prisma.scheduleLesson.findMany({
    where: { teacherId: original.id },
    select: {
      subjectId: true,
      order: true,
      startTime: true,
      endTime: true,
      schedule: { select: { day: true, classId: true } },
    },
  });

  const ownMap = new Map(
    ownLessons
      .filter((l) => l.schedule?.day)
      .map((l) => [`${l.schedule.classId}|${l.schedule.day}|${l.order}`, l]),
  );

  const seen = new Set();
  const picked = [];

  for (const entry of requested) {
    const day = String(entry.day ?? "").trim();
    const lessonOrder = Number(entry.lessonOrder);
    const classId = String(entry.classId ?? "").trim();

    if (!classId || !day || !Number.isInteger(lessonOrder)) {
      throw new BadRequestError("Dars ma'lumoti to'liq emas");
    }

    const key = `${classId}|${day}|${lessonOrder}`;
    if (seen.has(key)) continue; // takror tanlov — jim tashlanadi
    seen.add(key);

    const lesson = ownMap.get(key);
    if (!lesson) {
      throw new BadRequestError(
        `${day[0].toUpperCase() + day.slice(1)}, ${lessonOrder}-dars ` +
          `${fullName(original)} ning jadvalida yo'q — jadval o'zgargan bo'lishi mumkin`,
      );
    }

    if (!windowDays.has(day)) {
      throw new BadRequestError(
        `Tanlangan davrga ${day} kuni tushmaydi — bu dars hech qachon o'tilmaydi`,
      );
    }

    picked.push({ key, classId, day, lessonOrder, lesson });
  }

  // ── 2. Bu katak allaqachon boshqa o'rinbosardami ──
  //
  // Ikki o'rinbosar bitta darsga qo'yilsa, soat IKKI MARTA to'lanardi va
  // jurnalga kim yozishi noaniq bo'lardi.
  const conflicting = await prisma.lessonSubstitutionItem.findMany({
    where: {
      OR: picked.map((p) => ({
        classId: p.classId,
        day: p.day,
        lessonOrder: p.lessonOrder,
      })),
      substitution: otherActive,
    },
    include: { substitution: { select: { fromDate: true, toDate: true } } },
  });

  if (conflicting.length > 0) {
    const first = conflicting[0];
    throw new BadRequestError(
      `${first.day[0].toUpperCase() + first.day.slice(1)}, ` +
        `${first.lessonOrder}-dars (${first.snapshot?.className ?? "sinf"}) ` +
        "shu davrda allaqachon boshqa o'qituvchiga berilgan " +
        `(${formatDateRangeUz(first.substitution.fromDate, first.substitution.toDate, { utc: true })})`,
    );
  }

  // ── 3. O'rinbosarning O'Z darsi bilan to'qnashuv ──
  //
  // Bitta vaqtda ikki sinfda turib bo'lmaydi. Jadval saqlashdagi
  // `collectTeacherConflicts` bilan bir xil mulohaza.
  const substituteLessons = await prisma.scheduleLesson.findMany({
    where: { teacherId: substitute.id },
    select: { order: true, schedule: { select: { day: true, classId: true } } },
  });

  const busy = new Set(
    substituteLessons
      .filter((l) => l.schedule?.day)
      .map((l) => `${l.schedule.day}|${l.order}`),
  );

  for (const p of picked) {
    if (busy.has(`${p.day}|${p.lessonOrder}`)) {
      throw new BadRequestError(
        `${fullName(substitute)} ${p.day} kuni ${p.lessonOrder}-darsda band — ` +
          "bir vaqtda ikki sinfda dars o'tib bo'lmaydi",
      );
    }
  }

  // O'rinbosarning boshqa o'rinbosarligi bilan to'qnashuv
  const substituteBusy = await prisma.lessonSubstitutionItem.findMany({
    where: {
      substitution: { ...otherActive, substituteTeacherId: substitute.id },
    },
    select: { day: true, lessonOrder: true },
  });

  const busySub = new Set(
    substituteBusy.map((l) => `${l.day}|${l.lessonOrder}`),
  );

  for (const p of picked) {
    if (busySub.has(`${p.day}|${p.lessonOrder}`)) {
      throw new BadRequestError(
        `${fullName(substitute)} shu davrda ${p.day} kuni ` +
          `${p.lessonOrder}-darsda boshqa o'qituvchi o'rniga chiqadi`,
      );
    }
  }

  // ── 4. Nomlar va vaqt — snapshot uchun ──
  const [settings, classes, subjects] = await Promise.all([
    getScheduleSettings(),
    prisma.class.findMany({
      where: { id: { in: [...new Set(picked.map((p) => p.classId))] } },
      select: { id: true, name: true },
    }),
    prisma.subject.findMany({
      where: { id: { in: [...new Set(picked.map((p) => p.lesson.subjectId))] } },
      select: { id: true, name: true },
    }),
  ]);

  const periodMap = new Map((settings.periods || []).map((p) => [p.order, p]));
  const classMap = new Map(classes.map((c) => [c.id, c.name]));
  const subjectMap = new Map(subjects.map((s) => [s.id, s.name]));

  const itemRows = picked.map((p) => {
    const period = periodMap.get(p.lessonOrder);
    return {
      classId: p.classId,
      subjectId: p.lesson.subjectId,
      day: p.day,
      lessonOrder: p.lessonOrder,
      snapshot: {
        className: classMap.get(p.classId) ?? null,
        subjectName: subjectMap.get(p.lesson.subjectId) ?? null,
        startTime: p.lesson.startTime || period?.startTime || null,
        endTime: p.lesson.endTime || period?.endTime || null,
      },
    };
  });

  return { original, substitute, fromDate, toDate, reason, note, itemRows };
}

/** Yozuv uchun takrorlanish sonini hisoblaydi (bayram va ta'til chiqarilgan). */
async function attachOccurrences(row) {
  const [holidaySet, vacationSet] = await Promise.all([
    buildHolidaySet(row.fromDate, row.toDate),
    getVacationSet(),
  ]);

  row.occurrenceCount = countOccurrences(
    row.items,
    row.fromDate,
    row.toDate,
    holidaySet,
    vacationSet,
  );

  return row;
}

/**
 * YOZUV HALI BOSHLANMAGANMI — tahrirlash va o'chirishning YAGONA sharti.
 *
 * ⚠️ BOSHLANGAN YOZUV TAHRIRLANMAYDI HAM, O'CHIRILMAYDI HAM. Boshlangan
 * paytdan e'tiboran u DALIL bo'lib qoladi: o'rinbosar o'sha kataklarga
 * baho yozgan bo'lishi mumkin, soat esa oylik hisobiga o'tgan bo'ladi.
 * Uni o'zgartirish o'tgan kunni qayta yozish degani bo'lardi — o'sha
 * baholar endi "sababsiz" bo'lib qolardi.
 *
 * Boshlangan yozuvni to'xtatishning yagona yo'li — BEKOR QILISH
 * (`cancelSubstitution`): u izni saqlaydi.
 *
 * Boshlanmagan yozuv esa hali REJA: hech kim unga tayanmagan, hech qanday
 * soat yozilmagan. Uni to'g'rilash yoki olib tashlash mumkin.
 *
 * @param {object} row
 * @param {string} action - xato xabaridagi amal nomi
 */
function assertNotStarted(row, action) {
  if (row.status === "cancelled") {
    throw new BadRequestError(`Bekor qilingan yozuvni ${action} mumkin emas`);
  }

  const today = currentDayDate();

  if (row.fromDate.getTime() <= today.getTime()) {
    throw new BadRequestError(
      `O'rinbosarlik ${formatDateUz(row.fromDate, { utc: true })} da boshlangan — ` +
        `uni ${action} mumkin emas. Kerak bo'lsa bekor qiling: shunda soat ` +
        "egasiga qaytadi va yozuv tarixda qoladi.",
    );
  }
}

/**
 * O'RINBOSARLIK YARATISH.
 *
 * @param {object} data - { originalTeacherId, substituteTeacherId, fromDate,
 *   toDate, reason, note, lessons: [{ classId, day, lessonOrder }] }
 * @param {string} userId
 */
async function createSubstitution(data, userId) {
  const { original, substitute, fromDate, toDate, reason, note, itemRows } =
    await prepareSubstitution(data);

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.lessonSubstitution.create({
      data: {
        originalTeacherId: original.id,
        substituteTeacherId: substitute.id,
        fromDate,
        toDate,
        reason,
        note,
        teacherSnapshot: {
          original: { id: original.id, name: fullName(original), username: original.username },
          substitute: {
            id: substitute.id,
            name: fullName(substitute),
            username: substitute.username,
          },
        },
        createdBy: userId,
      },
    });

    await tx.lessonSubstitutionItem.createMany({
      data: itemRows.map((item) => ({ ...item, substitutionId: row.id })),
    });

    return tx.lessonSubstitution.findUnique({
      where: { id: row.id },
      include: { items: true },
    });
  });

  await attachOccurrences(created);

  logger.info(
    `[substitution] ${fullName(original)} → ${fullName(substitute)}: ` +
      `${created.items.length} ta dars, ${created.occurrenceCount} soat, ` +
      `${formatDateRangeUz(fromDate, toDate, { utc: true })}, actor=${userId}`,
  );

  return serialize(created, { original, substitute });
}

/**
 * TAHRIRLASH — FAQAT BOSHLANMAGAN YOZUV.
 *
 * Yozuv butunlay qayta quriladi: ikkala o'qituvchi, davr, sabab va darslar
 * ro'yxati. Tekshiruvlar yaratishdagi bilan AYNAN bir xil
 * (`prepareSubstitution`), farq faqat shundaki, to'qnashuv qidiruvida
 * yozuvning O'ZI hisobga olinmaydi.
 *
 * ⚠️ Darslar ro'yxati O'RNIGA QO'YILADI, qo'shilmaydi: eskilari
 * o'chirilib, yangilari yoziladi. Yamash (qaysi qo'shildi, qaysi olindi)
 * bir xil natijani ikki xil yo'l bilan berardi va "nega bu dars hali ham
 * ro'yxatda" degan savolni tug'dirardi.
 *
 * @param {string} id
 * @param {object} data
 * @param {string} userId
 */
async function updateSubstitution(id, data, userId) {
  const existing = await prisma.lessonSubstitution.findUnique({
    where: { id },
    include: { items: true },
  });
  if (!existing) throw new NotFoundError("O'rinbosarlik topilmadi");

  assertNotStarted(existing, "tahrirlash");

  const { original, substitute, fromDate, toDate, reason, note, itemRows } =
    await prepareSubstitution(
      {
        // Berilmagan maydonlar eskisidan olinadi — panel faqat o'zgarganini
        // yuborishi ham mumkin.
        originalTeacherId: data.originalTeacherId ?? existing.originalTeacherId,
        substituteTeacherId:
          data.substituteTeacherId ?? existing.substituteTeacherId,
        fromDate: data.fromDate ?? existing.fromDate.toISOString().split("T")[0],
        toDate: data.toDate ?? existing.toDate.toISOString().split("T")[0],
        reason: data.reason ?? existing.reason,
        note: data.note ?? existing.note,
        lessons:
          data.lessons ??
          existing.items.map((item) => ({
            classId: item.classId,
            day: item.day,
            lessonOrder: item.lessonOrder,
          })),
      },
      { excludeId: id },
    );

  const updated = await prisma.$transaction(async (tx) => {
    await tx.lessonSubstitution.update({
      where: { id },
      data: {
        originalTeacherId: original.id,
        substituteTeacherId: substitute.id,
        fromDate,
        toDate,
        reason,
        note,
        teacherSnapshot: {
          original: { id: original.id, name: fullName(original), username: original.username },
          substitute: {
            id: substitute.id,
            name: fullName(substitute),
            username: substitute.username,
          },
        },
      },
    });

    await tx.lessonSubstitutionItem.deleteMany({ where: { substitutionId: id } });
    await tx.lessonSubstitutionItem.createMany({
      data: itemRows.map((item) => ({ ...item, substitutionId: id })),
    });

    return tx.lessonSubstitution.findUnique({
      where: { id },
      include: { items: true },
    });
  });

  await attachOccurrences(updated);

  logger.info(
    `[substitution] Tahrirlandi: id=${id} ` +
      `${fullName(original)} → ${fullName(substitute)}, ` +
      `${updated.items.length} ta dars, ${updated.occurrenceCount} soat, ` +
      `${formatDateRangeUz(fromDate, toDate, { utc: true })}, actor=${userId}`,
  );

  return serialize(updated, { original, substitute });
}

/**
 * O'CHIRISH — FAQAT BOSHLANMAGAN YOZUV.
 *
 * ⚠️ BEKOR QILISH BILAN CHALKASHMASIN, ikkalasi BOSHQA savolga javob
 * beradi:
 *
 *   · o'chirish — yozuv HECH QACHON kuchga kirmagan. Xato kiritilgan
 *     reja, uni saqlashning ma'nosi yo'q va tarixni ifloslantiradi.
 *   · bekor qilish — yozuv AMALDA BO'LGAN yoki hozir amalda. U dalil:
 *     jurnal huquqi ochilgan, soat hisoblangan. Sababi bilan yopiladi va
 *     tarixda qoladi.
 *
 * Shu sababli o'chirish "xavfliroq amal" EMAS: aksincha, u faqat hech
 * narsa bo'lmagan holatda ochiq. Ruxsati esa bekor qilish bilan bir xil
 * (`substitutions.cancel`) — ikkalasi ham "qarorni orqaga qaytarish".
 *
 * Darslar `onDelete: Cascade` bilan o'zi o'chadi.
 *
 * @param {string} id
 * @param {string} userId
 */
async function deleteSubstitution(id, userId) {
  const row = await prisma.lessonSubstitution.findUnique({
    where: { id },
    include: { items: true },
  });
  if (!row) throw new NotFoundError("O'rinbosarlik topilmadi");

  assertNotStarted(row, "o'chirish");

  await prisma.lessonSubstitution.delete({ where: { id } });

  logger.warn(
    `[substitution] O'chirildi (hali boshlanmagan edi): id=${id} ` +
      `${row.teacherSnapshot?.original?.name} → ${row.teacherSnapshot?.substitute?.name} ` +
      `${formatDateRangeUz(row.fromDate, row.toDate, { utc: true })} actor=${userId}`,
  );

  return { message: "O'rinbosarlik o'chirildi" };
}

/**
 * BEKOR QILISH — o'chirish EMAS.
 *
 * O'rinbosarlik bo'lib o'tgan bo'lsa, u dalil: jurnalga kim yozgani va
 * oylikda kimga soat yozilgani shu qatorga tayanadi. O'chirilsa, o'tgan
 * oylik "sababsiz" bo'lib qolardi.
 *
 * ⚠️ Bekor qilinganda soat AVTOMATIK egasiga qaytadi — `lessonHours` faqat
 * `status: "active"` ni o'qiydi. Lekin SHAKLLANGAN oylik majburiyati
 * MUHRLANGAN: u qayta hisoblanmaydi. To'g'rilash kerak bo'lsa majburiyat
 * bekor qilinib qayta shakllantiriladi (`payroll` doktrinasi).
 */
async function cancelSubstitution(id, reason, userId) {
  const row = await prisma.lessonSubstitution.findUnique({
    where: { id },
    include: { items: true },
  });
  if (!row) throw new NotFoundError("O'rinbosarlik topilmadi");

  if (row.status === "cancelled") {
    throw new BadRequestError("Bu o'rinbosarlik allaqachon bekor qilingan");
  }

  const trimmed = (reason ?? "").trim();
  if (!trimmed) throw new BadRequestError("Bekor qilish sababi majburiy");

  const updated = await prisma.lessonSubstitution.update({
    where: { id },
    data: {
      status: "cancelled",
      cancelReason: trimmed,
      cancelledAt: new Date(),
      cancelledBy: userId,
    },
    include: { items: true },
  });

  logger.warn(
    `[substitution] Bekor qilindi: id=${id} ` +
      `${row.teacherSnapshot?.original?.name} → ${row.teacherSnapshot?.substitute?.name} ` +
      `actor=${userId} sabab="${trimmed}"`,
  );

  const warnings = [];
  const startMonth = monthKeyOfDate(row.fromDate);
  const sealed = await prisma.payrollEntry.findFirst({
    where: {
      staffId: { in: [row.originalTeacherId, row.substituteTeacherId] },
      month: { gte: startMonth, lte: monthKeyOfDate(row.toDate) },
      status: { not: "cancelled" },
    },
    select: { id: true },
  });

  if (sealed) {
    warnings.push(
      "Bu davr uchun oylik majburiyati allaqachon shakllantirilgan. " +
        "Soatni to'g'rilash uchun majburiyatni bekor qilib qayta shakllantiring.",
    );
  }

  return { ...serialize(updated), warnings };
}

/** Ro'yxat — sahifalangan, filtrlar bilan. */
async function getSubstitutions(req) {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;
  const today = currentDayDate();

  const where = {};

  if (query.status) {
    if (!STATUS_LABELS[query.status]) throw new BadRequestError("Holat noto'g'ri");
    where.status = query.status;
  }

  if (query.teacherId) {
    where.OR = [
      { originalTeacherId: query.teacherId },
      { substituteTeacherId: query.teacherId },
    ];
  }

  if (query.originalTeacherId) where.originalTeacherId = query.originalTeacherId;
  if (query.substituteTeacherId) where.substituteTeacherId = query.substituteTeacherId;
  if (query.reason) where.reason = query.reason;

  if (query.fromDate || query.toDate) {
    const from = query.fromDate ? parseDayDate(query.fromDate, "Boshlanish sanasi") : null;
    const to = query.toDate ? parseDayDate(query.toDate, "Tugash sanasi") : null;
    if (to) where.fromDate = { lte: to };
    if (from) where.toDate = { gte: from };
  }

  // "Hozir amalda" — status EMAS, sana: o'tib ketgani ham `active` bo'lib
  // qoladi (u haqiqatan bo'lib o'tgan).
  if (query.ongoing === "true") {
    where.status = "active";
    where.fromDate = { ...(where.fromDate ?? {}), lte: today };
    where.toDate = { ...(where.toDate ?? {}), gte: today };
  }

  const [rows, total, activeCount] = await Promise.all([
    prisma.lessonSubstitution.findMany({
      where,
      orderBy: [{ fromDate: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
      include: { items: true },
    }),
    prisma.lessonSubstitution.count({ where }),
    prisma.lessonSubstitution.count({
      where: { status: "active", fromDate: { lte: today }, toDate: { gte: today } },
    }),
  ]);

  const teacherIds = [
    ...new Set(rows.flatMap((r) => [r.originalTeacherId, r.substituteTeacherId])),
  ];

  const teachers = teacherIds.length
    ? await prisma.user.findMany({
        where: { id: { in: teacherIds } },
        select: TEACHER_SELECT,
      })
    : [];
  const teacherMap = new Map(teachers.map((t) => [t.id, t]));

  return {
    ...formatPaginationResponse(
      rows.map((row) =>
        serialize(row, {
          today,
          original: teacherMap.get(row.originalTeacherId),
          substitute: teacherMap.get(row.substituteTeacherId),
        }),
      ),
      total,
      page,
      limit,
    ),
    totals: {
      ongoing: activeCount,
      lessons: rows.reduce((sum, r) => sum + r.items.length, 0),
    },
  };
}

/** Bitta yozuv — tafsilotlari va haqiqiy soat soni bilan. */
async function getSubstitution(id) {
  const row = await prisma.lessonSubstitution.findUnique({
    where: { id },
    include: { items: true },
  });
  if (!row) throw new NotFoundError("O'rinbosarlik topilmadi");

  const [, teachers] = await Promise.all([
    attachOccurrences(row),
    prisma.user.findMany({
      where: { id: { in: [row.originalTeacherId, row.substituteTeacherId] } },
      select: TEACHER_SELECT,
    }),
  ]);

  const teacherMap = new Map(teachers.map((t) => [t.id, t]));

  return serialize(row, {
    original: teacherMap.get(row.originalTeacherId),
    substitute: teacherMap.get(row.substituteTeacherId),
  });
}

/**
 * O'QITUVCHINING O'Z O'RINBOSARLIKLARI — teacher paneli uchun.
 * Ikki yo'nalish alohida: "men bermaganim" va "men chiqqanim".
 */
async function getMySubstitutions(teacherId) {
  const today = currentDayDate();

  const rows = await prisma.lessonSubstitution.findMany({
    where: {
      status: "active",
      OR: [{ originalTeacherId: teacherId }, { substituteTeacherId: teacherId }],
    },
    orderBy: [{ fromDate: "desc" }],
    take: 50,
    include: { items: true },
  });

  const given = rows.filter((r) => r.originalTeacherId === teacherId);
  const taken = rows.filter((r) => r.substituteTeacherId === teacherId);

  return {
    given: given.map((row) => serialize(row, { today })),
    taken: taken.map((row) => serialize(row, { today })),
    ongoing: rows.filter(
      (r) => r.fromDate <= today && r.toDate >= today,
    ).length,
  };
}

module.exports = {
  REASON_LABELS,
  getTeacherOptions,
  updateSubstitution,
  deleteSubstitution,
  STATUS_LABELS,
  MAX_WINDOW_DAYS,
  serialize,
  countOccurrences,
  getAvailableLessons,
  createSubstitution,
  cancelSubstitution,
  getSubstitutions,
  getSubstitution,
  getMySubstitutions,
};
