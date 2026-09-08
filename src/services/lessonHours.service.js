/**
 * DARS SOATLARI — HAFTALIK SHABLONNI OYGA YOYISH.
 *
 * Domenda dars jadvali haftalik shablon, kalendar sanasiga bog'langan dars
 * yozuvi esa YO'Q (`Schedule` + `ScheduleLesson`, `@@unique([classId, day])`).
 * Shuning uchun "sentabrda necha soat o'tildi" degan savolga javob berish
 * uchun shablonni oyning har bir kuniga yoyish kerak:
 *
 *     oylik soat = Σ (oyning har bir dars kuni uchun) o'sha hafta kunidagi
 *                    darslar soni   −  o'rinbosarga berilgani
 *                                   +  o'rniga chiqilgani
 *
 * ⚠️ SOAT = DARS (akademik soat). `teacherWorkload.service.js` va
 * `PlannerLoad.weeklyHours` bilan bir xil o'lchov.
 *
 * ── NIMA UCHUN ALOHIDA SO'ROV ────────────────
 *
 * `scheduleWorkTime.service.js` allaqachon hafta kuni bo'yicha `lessonCount`
 * beradi va u BATCH shaklda. Lekin u darslarni SONGA siqadi, bu yerda esa
 * har bir darsning (sinf, fan, tartib) koordinatasi kerak: o'rinbosarlik
 * AYNAN bitta katakka beriladi va soat undan ayiriladi. Ya'ni savol boshqa,
 * shuning uchun so'rov ham boshqa.
 *
 * Chalkashmasligi uchun: hafta kuni raqami (`0 = yakshanba`) IKKALA joyda
 * ham `DAY_TO_NUMBER` dan olinadi — nusxa massiv yaratilmaydi.
 *
 * ⚠️ BU SERVIS PULNI HISOBLAMAYDI. Formula `helpers/lessonHours.js` dagi
 * `computeSalary()` da, u yagona nuqta. Bu yerda faqat SOAT.
 */

const prisma = require("../config/prisma");
const { NotFoundError } = require("../utils/errors");
const { ROLES, DAYS_UZ } = require("../utils/constants");
const { DAY_TO_NUMBER } = require("./scheduleWorkTime.service");
const { buildHolidaySet } = require("./holiday.service");
const { getVacationSet } = require("./vacationMonth.service");
const {
  currentMonthKey,
  currentDayOfMonth,
  formatMonthKey,
  monthStartDate,
  monthEndDate,
  daysInMonth,
  parseMonthKey,
} = require("../helpers/month.helpers");
const { eachDayOfMonth, teachingDaysOfMonth } = require("../helpers/lessonHours");

const TEACHER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  role: true,
  isArchived: true,
};

// Hafta kunining ko'rsatiladigan nomi — `DAYS_UZ` yagona manba.
const dayLabel = (dayNumber) => {
  const name = DAYS_UZ[dayNumber];
  return name ? name[0].toUpperCase() + name.slice(1) : String(dayNumber);
};

/**
 * O'rinbosarlik yozuvlarining oy ichidagi AMALDAGI kataklari.
 *
 * Natija ikki xaritada qaytadi, chunki savol ikki xil:
 *   · `out` — "bu o'qituvchidan qaysi katak olingan"  (soat AYIRILADI)
 *   · `in`  — "bu o'qituvchiga qaysi katak berilgan"  (soat QO'SHILADI)
 *
 * Katak kaliti: `classId|day|lessonOrder` — `scheduleLessonId` EMAS.
 * Sinf jadvali qayta saqlanganda `ScheduleLesson` qatorlari o'chirilib
 * qayta yaratiladi, ya'ni id barqaror emas (`saveClassSchedule`).
 *
 * @param {number} month - YYYYMM
 * @returns {Promise<{
 *   out: Map<string, Array<{key: string, from: Date, to: Date, id: string}>>,
 *   in: Map<string, Array<{key: string, from: Date, to: Date, id: string, day: string}>>,
 *   rows: Array<object>
 * }>}
 */
async function loadSubstitutionWindows(month) {
  const from = monthStartDate(month);
  const to = monthEndDate(month);

  const rows = await prisma.lessonSubstitution.findMany({
    where: {
      status: "active",
      // Kesishuv: yozuv.from <= oy.oxiri  VA  yozuv.to >= oy.boshi
      fromDate: { lte: to },
      toDate: { gte: from },
    },
    include: { items: true },
  });

  // ⚠️ ESKIRGAN KATAK TASHLANADI — AYIRISH VA QO'SHISH JUFT BO'LISHI SHART.
  //
  // O'rinbosarlik tuzilgandan keyin sinf jadvali qayta saqlanishi mumkin
  // (`saveClassSchedule` qatorlarni o'chirib qayta yaratadi) va katak boshqa
  // o'qituvchiga o'tib ketishi yoki butunlay yo'qolishi mumkin. U holda:
  //   · `out` HECH QACHON ishlamaydi — egasida bunday dars endi yo'q;
  //   · `in` esa qo'shilaverardi.
  // Natijada bitta dars uchun IKKI kishiga pul yozilardi (yangi egasiga
  // "o'z darsi" sifatida, o'rinbosarga esa "o'rniga chiqqani" sifatida).
  //
  // O'rinbosarlik — FALON o'qituvchining o'rniga chiqish, "bu katakka
  // egalik" emas. Ega o'zgargan payt yozuv o'z ma'nosini yo'qotadi.
  // `helpers/teacherAccess.js` da huquq tomonida AYNAN shu shart bor.
  const ownerIds = [...new Set(rows.map((r) => r.originalTeacherId))];

  const ownerLessons = ownerIds.length
    ? await prisma.scheduleLesson.findMany({
        where: { teacherId: { in: ownerIds } },
        select: {
          teacherId: true,
          order: true,
          schedule: { select: { day: true, classId: true } },
        },
      })
    : [];

  const ownedKeys = new Set(
    ownerLessons
      .filter((lesson) => lesson.schedule?.day)
      .map(
        (lesson) =>
          `${lesson.teacherId}|${lesson.schedule.classId}|${lesson.schedule.day}|${lesson.order}`,
      ),
  );

  const out = new Map();
  const inbound = new Map();

  const push = (map, teacherId, entry) => {
    const list = map.get(teacherId);
    if (list) list.push(entry);
    else map.set(teacherId, [entry]);
  };

  for (const row of rows) {
    for (const item of row.items) {
      const ownedKey =
        `${row.originalTeacherId}|${item.classId}|${item.day}|${item.lessonOrder}`;

      // Katak endi egasiniki emas — yozuv "osilib qolgan", hisobga olinmaydi
      if (!ownedKeys.has(ownedKey)) continue;

      const entry = {
        id: row.id,
        key: `${item.classId}|${item.day}|${item.lessonOrder}`,
        day: item.day,
        dayNumber: DAY_TO_NUMBER.get(item.day),
        classId: item.classId,
        subjectId: item.subjectId,
        lessonOrder: item.lessonOrder,
        snapshot: item.snapshot,
        from: row.fromDate,
        to: row.toDate,
      };

      push(out, row.originalTeacherId, entry);
      push(inbound, row.substituteTeacherId, entry);
    }
  }

  return { out, in: inbound, rows };
}

/** Sana o'rinbosarlik oynasi ichidami (kun aniqligida, INKLYUZIV). */
const withinWindow = (date, entry) =>
  date.getTime() >= entry.from.getTime() && date.getTime() <= entry.to.getTime();

/**
 * OYNING KALENDARI — ta'til, bayram va dars kunlari.
 *
 * ⚠️ YAGONA MANBA. Ilgari bu qiymatlar faqat o'qituvchi qatorlari ichida
 * qaytardi va yig'ma ko'rinish ularni RO'YXATDAGI BIRINCHI o'qituvchidan
 * o'qirdi — soatbay xodim bo'lmasa esa ta'til bayrog'i umuman yo'qolardi va
 * ekranda sababsiz nollar turardi. Kalendar odamga bog'liq emas, shuning
 * uchun u alohida funksiya.
 *
 * @param {number} month - YYYYMM
 * @param {object} [options]
 * @param {number|null} [options.asOfDayOfMonth] - kesim kuni
 * @returns {Promise<{
 *   isVacationMonth: boolean,
 *   holidaySet: Set<string>,
 *   days: Array<object>,
 *   taughtDays: Array<object>,
 *   teachingDays: number,
 *   taughtDayCount: number,
 *   holidayCount: number
 * }>}
 */
async function getMonthCalendar(month, { asOfDayOfMonth = null } = {}) {
  const [holidaySet, vacationSet] = await Promise.all([
    buildHolidaySet(monthStartDate(month), monthEndDate(month)),
    getVacationSet(),
  ]);

  // ⚠️ TA'TIL OYIDA MAKTAB ISHLAMAYDI — hech kimga dars soati yozilmaydi.
  // Bu `VacationMonth` ning butun ma'nosi (`education.md` §2). Fiksa oylik
  // esa baribir to'lanadi: uni bu yerda emas, `payroll.service.js` hal qiladi.
  const isVacationMonth = vacationSet.has(month);

  const days = isVacationMonth
    ? []
    : teachingDaysOfMonth(month, { holidaySet, untilDayOfMonth: null });

  const taughtDays =
    asOfDayOfMonth == null
      ? days
      : days.filter((day) => day.dayOfMonth <= asOfDayOfMonth);

  // Bayram sanog'i — FAQAT shu oyning ichidagilari (to'plamda oraliqning
  // hammasi bo'lishi mumkin emas, u oy chegarasi bilan quriladi).
  return {
    isVacationMonth,
    holidaySet,
    days,
    taughtDays,
    teachingDays: days.length,
    taughtDayCount: taughtDays.length,
    holidayCount: holidaySet.size,
  };
}

/**
 * OYLIK DARS SOATI — bir nechta o'qituvchi uchun, BITTA o'tishda.
 *
 * So'rovlar soni o'qituvchilar soniga BOG'LIQ EMAS: darslar, o'rinbosarlik,
 * bayramlar va nomlar — beshta so'rov, qolgani sof hisob.
 *
 * @param {string[]} teacherIds
 * @param {number} month - YYYYMM
 * @param {object} [options]
 * @param {number|null} [options.asOfDayOfMonth] - "bugungacha o'tilgani" ni
 *   ajratish uchun kesim kuni. `null` bo'lsa oy to'liq hisoblanadi.
 * @returns {Promise<Map<string, object>>}
 */
async function getTeachersHours(teacherIds, month, options = {}) {
  const ids = [...new Set((teacherIds || []).filter(Boolean).map(String))];
  const result = new Map();
  if (ids.length === 0) return result;

  const { asOfDayOfMonth = null } = options;

  const [lessons, substitutions, calendar] = await Promise.all([
    prisma.scheduleLesson.findMany({
      where: { teacherId: { in: ids } },
      select: {
        teacherId: true,
        subjectId: true,
        order: true,
        schedule: { select: { day: true, classId: true } },
      },
    }),
    loadSubstitutionWindows(month),
    getMonthCalendar(month, { asOfDayOfMonth }),
  ]);

  const { isVacationMonth: isVacation, days, taughtDays } = calendar;
  const taughtKeys = new Set(taughtDays.map((day) => day.key));

  // Sinf va fan nomlari — soft ref, qo'lda yuklanadi
  const classIds = new Set();
  const subjectIds = new Set();

  for (const lesson of lessons) {
    if (lesson.schedule?.classId) classIds.add(lesson.schedule.classId);
    if (lesson.subjectId) subjectIds.add(lesson.subjectId);
  }
  for (const list of substitutions.in.values()) {
    for (const entry of list) {
      classIds.add(entry.classId);
      subjectIds.add(entry.subjectId);
    }
  }

  const [classes, subjects] = await Promise.all([
    classIds.size
      ? prisma.class.findMany({
          where: { id: { in: [...classIds] } },
          select: { id: true, name: true },
        })
      : [],
    subjectIds.size
      ? prisma.subject.findMany({
          where: { id: { in: [...subjectIds] } },
          select: { id: true, name: true },
        })
      : [],
  ]);

  const classMap = new Map(classes.map((c) => [c.id, c.name]));
  const subjectMap = new Map(subjects.map((s) => [s.id, s.name]));

  // O'qituvchi → o'z darslari
  const ownLessons = new Map(ids.map((id) => [id, []]));
  for (const lesson of lessons) {
    const dayNumber = DAY_TO_NUMBER.get(lesson.schedule?.day);
    if (dayNumber === undefined) continue; // ma'lumot buzilgan — tashlanadi

    ownLessons.get(lesson.teacherId)?.push({
      dayNumber,
      day: lesson.schedule.day,
      classId: lesson.schedule.classId,
      subjectId: lesson.subjectId,
      lessonOrder: lesson.order,
      key: `${lesson.schedule.classId}|${lesson.schedule.day}|${lesson.order}`,
    });
  }

  for (const teacherId of ids) {
    const own = ownLessons.get(teacherId) ?? [];
    const outEntries = substitutions.out.get(teacherId) ?? [];
    const inEntries = substitutions.in.get(teacherId) ?? [];

    // Tez qidiruv uchun: katak kaliti → o'sha katakka tegishli oynalar
    const outByKey = new Map();
    for (const entry of outEntries) {
      const list = outByKey.get(entry.key);
      if (list) list.push(entry);
      else outByKey.set(entry.key, [entry]);
    }

    const byDayNumber = new Map();
    const byClass = new Map();
    const bySubject = new Map();
    const hoursByDayOfMonth = new Map();
    const series = [];

    let scheduled = 0;
    let out = 0;
    let inbound = 0;
    let taught = 0;
    let taughtScheduled = 0;

    const bump = (map, id, name, field, delta) => {
      let row = map.get(id);
      if (!row) {
        row = { id, name: name ?? "Noma'lum", hours: 0, substituted: 0, covered: 0 };
        map.set(id, row);
      }
      row[field] += delta;
    };

    for (const day of days) {
      let dayHours = 0;

      // ── O'Z DARSLARI ───────────────────────
      for (const lesson of own) {
        if (lesson.dayNumber !== day.dayNumber) continue;

        scheduled += 1;
        if (taughtKeys.has(day.key)) taughtScheduled += 1;

        const windows = outByKey.get(lesson.key);
        const movedAway = windows?.some((entry) => withinWindow(day.date, entry));

        if (movedAway) {
          out += 1;
          bump(byClass, lesson.classId, classMap.get(lesson.classId), "substituted", 1);
          bump(bySubject, lesson.subjectId, subjectMap.get(lesson.subjectId), "substituted", 1);
          continue;
        }

        dayHours += 1;
        bump(byClass, lesson.classId, classMap.get(lesson.classId), "hours", 1);
        bump(bySubject, lesson.subjectId, subjectMap.get(lesson.subjectId), "hours", 1);
      }

      // ── O'RNIGA CHIQQAN DARSLARI ───────────
      for (const entry of inEntries) {
        if (entry.dayNumber !== day.dayNumber) continue;
        if (!withinWindow(day.date, entry)) continue;

        inbound += 1;
        dayHours += 1;
        bump(byClass, entry.classId, classMap.get(entry.classId), "covered", 1);
        bump(byClass, entry.classId, classMap.get(entry.classId), "hours", 1);
        bump(bySubject, entry.subjectId, subjectMap.get(entry.subjectId), "covered", 1);
        bump(bySubject, entry.subjectId, subjectMap.get(entry.subjectId), "hours", 1);
      }

      if (dayHours > 0) {
        const existing = byDayNumber.get(day.dayNumber) ?? {
          dayNumber: day.dayNumber,
          dayLabel: dayLabel(day.dayNumber),
          hours: 0,
          occurrences: 0,
        };
        existing.hours += dayHours;
        existing.occurrences += 1;
        byDayNumber.set(day.dayNumber, existing);
      }

      if (taughtKeys.has(day.key)) taught += dayHours;

      hoursByDayOfMonth.set(day.dayOfMonth, dayHours);
    }

    // ⚠️ EGRI CHIZIQ BUTUN OYNI QAMRAYDI — dars kunlarini emas.
    //
    // Diagramma nuqtalarni INDEKS bo'yicha joylashtiradi (`index * step`),
    // shuning uchun bayram yoki yakshanba tushib qolsa, undan keyingi har
    // bir nuqta bir katak chapga siljib, o'q yorlig'i ("30-kun") ham
    // yolg'on bo'lib qolardi. Dars bo'lmagan kun — NOL soatli nuqta, yo'q
    // nuqta emas.
    for (const day of eachDayOfMonth(month)) {
      series.push({
        day: day.dayOfMonth,
        hours: hoursByDayOfMonth.get(day.dayOfMonth) ?? 0,
        isPast: asOfDayOfMonth == null || day.dayOfMonth <= asOfDayOfMonth,
      });
    }

    const hours = scheduled - out + inbound;

    // Haftalik yuklama — shablonning O'ZI (oy bo'ylab yoyilmagan). Panelda
    // "haftasiga 24 soat" deb ko'rsatiladi.
    const weeklyHours = own.length;

    const sortRows = (map) =>
      [...map.values()].sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));

    result.set(teacherId, {
      month,
      monthLabel: formatMonthKey(month),
      isVacationMonth: isVacation,
      // Jadval bo'yicha rejalashtirilgan (o'rinbosarliksiz)
      scheduledHours: scheduled,
      // O'rinbosarga berilgani / o'rniga chiqilgani
      substitutedOutHours: out,
      substitutedInHours: inbound,
      // Yakuniy: OYLIK shu sondan hisoblanadi
      hours,
      // "Bugungacha o'tilgani" — jonli panel uchun
      taughtHours: taught,
      taughtScheduledHours: taughtScheduled,
      // Qolgan (rejalashtirilgan, hali o'tilmagan)
      remainingHours: hours - taught,
      weeklyHours,
      teachingDays: calendar.teachingDays,
      taughtDays: calendar.taughtDayCount,
      holidayCount: isVacation ? daysInMonth(month) : calendar.holidayCount,
      byDay: [...byDayNumber.values()].sort((a, b) => a.dayNumber - b.dayNumber),
      byClass: sortRows(byClass),
      bySubject: sortRows(bySubject),
      series,
    });
  }

  return result;
}

/**
 * Bitta o'qituvchining oylik soati.
 *
 * @param {string} teacherId
 * @param {number} month - YYYYMM
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function getTeacherHours(teacherId, month, options = {}) {
  const map = await getTeachersHours([teacherId], month, options);
  return map.get(String(teacherId)) ?? null;
}

/**
 * Joriy oy uchun kesim kuni.
 *
 * ⚠️ O'TGAN oyda kesim YO'Q (butun oy o'tilgan), KELAJAKDAGI oyda esa
 * hech narsa o'tilmagan. Uchala holat bitta joyda hal qilinadi — aks holda
 * har chaqiruvchi o'z shartini yozardi va biri "bugungacha" ni boshqacha
 * tushunardi.
 *
 * @param {number} month - YYYYMM
 * @returns {number|null}
 */
function cutoffForMonth(month) {
  const current = currentMonthKey();
  if (month < current) return null; // o'tgan oy — to'liq
  if (month > current) return 0; // kelajak — hali hech narsa yo'q
  return currentDayOfMonth();
}

/**
 * O'QITUVCHI TEKSHIRUVI — o'quvchi rad etiladi.
 * `teacherWorkload.service.js` dagi `assertTeacher` bilan bir xil qoida.
 */
async function assertTeacher(teacherId) {
  const teacher = await prisma.user.findUnique({
    where: { id: teacherId },
    select: TEACHER_SELECT,
  });

  if (!teacher || teacher.role === ROLES.STUDENT) {
    throw new NotFoundError("O'qituvchi topilmadi");
  }

  return teacher;
}

module.exports = {
  TEACHER_SELECT,
  dayLabel,
  getMonthCalendar,
  assertTeacher,
  cutoffForMonth,
  getTeacherHours,
  getTeachersHours,
  loadSubstitutionWindows,
  parseHoursMonth: (value) => (value ? parseMonthKey(value, "Oy") : currentMonthKey()),
};
