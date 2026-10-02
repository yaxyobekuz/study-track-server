/**
 * DARS JADVALIDAN ISH VAQTI — o'qituvchining davomat oynasi.
 *
 * Qoida bitta jumlada:
 *
 * > Ishga KELISH vaqti — o'sha kuni o'tadigan BIRINCHI darsdan
 * > `SCHEDULE_ARRIVAL_LEAD_MINUTES` (10) daqiqa OLDIN, ish tugashi — OXIRGI
 * > darsning tugashi. Darsi yo'q kun ish kuni SANALMAYDI.
 *
 * Bu qatlam `User.workTimeSource === "schedule"` bo'lgan xodimlar uchun
 * `attendance.service.js` dagi `getEffectiveSchedule()` ga ulanadi. Qolgan
 * hamma uchun eski yo'l (`User` → `Role` merosi) o'zgarishsiz qoladi.
 *
 * ⚠️ KELISH VAQTI = BIRINCHI DARS − 10 DAQIQA (biznes qarori, 2026-10-02).
 * Kechikish va jarima AYNAN shu vaqtdan sanaladi; davomat sozlamasidagi
 * kechikish imtiyozi (`lateArrivalGraceMinutes`) boshqa xodimlardagi kabi
 * ustiga qo'shiladi. Darsning o'z vaqti (`firstLessonTime`) ham qaytadi —
 * ekranda "nega 08:20" degan savolga javob bo'lsin.
 *
 * ⚠️ IKKI SHAKL, BITTA HISOBLOVCHI:
 *   · HAFTALIK (`getScheduleWorkTimes`) — shablon: profil va xodimlar
 *     ro'yxatida "dushanba 08:20–14:00" ko'rinishi uchun;
 *   · KUNLIK (`getScheduleDayWindows`) — DAVOMAT shundan o'qiydi: o'sha kuni
 *     HAQIQATAN o'tiladigan darslar. O'rinbosarlik (`education.md` §8) darsni
 *     egasidan olib o'rinbosarga beradi, bayram kuni va ta'til oyida dars
 *     yo'q. Haftalik shablon bilan tekshirilsa, kasal o'qituvchining o'rniga
 *     chiqqan o'rinbosar o'sha darsga kech kelsa ham jarimasiz qolardi, darsi
 *     olingan egasi esa "kelmadi" bo'lib jarima olardi.
 *   Ikkalasi ham `addLesson` / `finalizeWindow` dan o'tadi — oynaning ikki
 *   nusxasi bo'lsa, profil bir vaqtni, davomat boshqasini ko'rsatardi.
 *
 * ⚠️ DARS VAQTI IKKI MANBADAN keladi va tartibi `teacherWorkload.service.js`
 * bilan AYNAN bir xil: darsning O'ZIDA yozilgan vaqt ustun, bo'lmasa
 * `ScheduleSettings.periods` dan o'sha `order` ning standart vaqti. Ikkinchi
 * mustaqil hal qiluvchi yozilsa, profil sahifasi va davomat bir xil dars
 * uchun boshqa-boshqa vaqt ko'rsatib qolardi.
 *
 * ⚠️ VAQTI ANIQLANMAGAN dars kunni ISH KUNI qiladi, lekin oynaga KIRMAYDI:
 * dars bor — demak odam ishlaydi, ammo aniq vaqt yo'q ekan, kechikish va erta
 * ketish tekshirilmaydi (jarima yozilmaydi). "Vaqti yo'q" ni "darsi yo'q" ga
 * tenglashtirsak, jadvali to'liq kiritilmagan o'qituvchi davomatdan jimgina
 * chiqib ketardi.
 *
 * ⚠️ Bu `plannerAvailability.service.js` BILAN CHALKASHMASIN. U yerda savol
 * teskari: "o'qituvchi qaysi slotga dars QO'YISH mumkin". Ish vaqtini dars
 * jadvalidan olib, keyin o'sha ish vaqtiga qarab dars qo'ysak — aylanma
 * bog'liqlik bo'lardi. Shu sababli planner bu servisga MUROJAAT QILMAYDI va
 * `workTimeSource` ni ham o'qimaydi.
 *
 * ⚠️ YAKSHANBA — `ScheduleDay` enumida yo'q, ya'ni hech qachon ish kuni
 * bo'lmaydi. Bu jadvalning o'zidan kelib chiqadi, alohida shart emas.
 */

const prisma = require("../config/prisma");
const { getScheduleSettings } = require("./settings.service");
const { buildHolidaySet } = require("./holiday.service");
const { getVacationSet } = require("./vacationMonth.service");
const { monthKeyOfDate } = require("../helpers/month.helpers");
const { dayKey } = require("../helpers/lessonHours");
const {
  scheduleDayOf,
  getSubstitutionCells,
  effectiveTeacherOf,
} = require("../helpers/teacherAccess");
const { DAYS_UZ, SCHEDULE_ARRIVAL_LEAD_MINUTES } = require("../utils/constants");

// `ScheduleDay` enum qiymati → JS `getDay()` raqami (0 = yakshanba).
// `DAYS_UZ` aynan shu tartibda yozilgan — yagona manba, nusxa massiv yo'q.
const DAY_TO_NUMBER = new Map(DAYS_UZ.map((day, index) => [day, index]));

const TIME_RE = /^(\d{1,2}):(\d{2})$/;

/**
 * Dars vaqti: darsning o'zidagi qiymat ustun, bo'lmasa jadval sozlamasidagi
 * o'sha tartibning standart vaqti.
 *
 * ⚠️ `teacherWorkload.service.js` dagi `resolveTime()` bilan bir xil qoida.
 *
 * @param {{order: number, startTime: string|null, endTime: string|null}} lesson
 * @param {Map<number, {startTime: string, endTime: string}>} periodMap
 * @returns {{startTime: string|null, endTime: string|null}}
 */
function resolveLessonTime(lesson, periodMap) {
  const period = periodMap.get(lesson.order);

  return {
    startTime: lesson.startTime || period?.startTime || null,
    endTime: lesson.endTime || period?.endTime || null,
  };
}

/**
 * "08:30" → 510. Yaroqsiz qiymat → `null` (dars "vaqtsiz" hisoblanadi).
 *
 * ⚠️ Matn taqqoslash EMAS va "9:00" ham qabul qilinadi: nol bilan
 * to'ldirilmagan qiymat bazada qolib ketgan bo'lsa, `"9:00" < "10:00"`
 * YOLG'ON bo'lardi va o'qituvchining ish kuni tushdan keyin boshlangandek
 * ko'rinardi.
 */
function minutesOf(value) {
  const match = TIME_RE.exec(String(value ?? "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 510 → "08:30". */
function timeOf(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * Darsning boshlanishidan KELISH vaqti: `SCHEDULE_ARRIVAL_LEAD_MINUTES` oldin.
 *
 * Yarim tundan oldinga o'tmaydi (00:05 dagi dars → 00:00): ish vaqti bir kun
 * ichida o'lchanadi, kechagi kunga o'tgan kelish vaqtining ma'nosi yo'q.
 *
 * @param {string|null} lessonStart - "HH:mm"
 * @returns {string|null}
 */
function arrivalTimeOf(lessonStart) {
  const minutes = minutesOf(lessonStart);
  if (minutes == null) return null;
  return timeOf(Math.max(0, minutes - SCHEDULE_ARRIVAL_LEAD_MINUTES));
}

/** Bitta kunning yig'uvchisi — darslar qo'shiladi, oxirida `finalizeWindow`. */
const emptyWindow = () => ({ firstMin: null, lastMin: null, lessonCount: 0 });

/**
 * Darsni kun oynasiga qo'shadi: eng erta boshlanish, eng kech tugash.
 *
 * @param {{firstMin: number|null, lastMin: number|null, lessonCount: number}} acc
 * @param {{startTime: string|null, endTime: string|null}} time - `resolveLessonTime`
 */
function addLesson(acc, { startTime, endTime }) {
  acc.lessonCount += 1;

  const start = minutesOf(startTime);
  const end = minutesOf(endTime);
  if (start != null && (acc.firstMin == null || start < acc.firstMin)) acc.firstMin = start;
  if (end != null && (acc.lastMin == null || end > acc.lastMin)) acc.lastMin = end;
}

/**
 * Yig'uvchidan tayyor oyna.
 *
 * @returns {{
 *   startTime: string|null,      // KELISH vaqti (birinchi dars − 10 daqiqa)
 *   endTime: string|null,        // oxirgi darsning tugashi
 *   firstLessonTime: string|null, // birinchi darsning o'zi
 *   lessonCount: number
 * }}
 */
function finalizeWindow(acc) {
  const firstLessonTime = acc.firstMin == null ? null : timeOf(acc.firstMin);

  return {
    startTime: arrivalTimeOf(firstLessonTime),
    endTime: acc.lastMin == null ? null : timeOf(acc.lastMin),
    firstLessonTime,
    lessonCount: acc.lessonCount,
  };
}

const periodMapOf = (settings) =>
  new Map(
    (Array.isArray(settings?.periods) ? settings.periods : []).map((period) => [
      Number(period.order),
      period,
    ]),
  );

const uniqueIds = (teacherIds) => [...new Set((teacherIds || []).filter(Boolean).map(String))];

/**
 * Bir nechta o'qituvchining HAFTALIK ish oynasini BITTA so'rovda hisoblaydi.
 *
 * Batch shakli ataylab: `attendanceAbsent.job.js` har kecha barcha xodimlar
 * bo'ylab aylanadi va yakka chaqiruv u yerda N+1 so'rovga aylanardi.
 *
 * ⚠️ Bu SHABLON: o'rinbosarlik, bayram va ta'til oyini bilmaydi. Davomat
 * (kechikish, kelmaganlik) `getScheduleDayWindows` dan o'qiydi.
 *
 * @param {string[]} teacherIds
 * @returns {Promise<Map<string, {
 *   byDay: Map<number, {startTime: string|null, endTime: string|null, firstLessonTime: string|null, lessonCount: number}>,
 *   workDays: number[],
 *   hasLessons: boolean
 * }>>} Har bir so'ralgan id uchun qator BO'LADI — darsi yo'q o'qituvchi
 *   `hasLessons: false` va bo'sh `workDays` bilan qaytadi (chaqiruvchi
 *   "topilmadi" va "darsi yo'q" ni farqlamasligi uchun).
 */
async function getScheduleWorkTimes(teacherIds) {
  const ids = uniqueIds(teacherIds);

  const result = new Map(
    ids.map((id) => [id, { byDay: new Map(), workDays: [], hasLessons: false }]),
  );

  if (ids.length === 0) return result;

  const [lessons, settings] = await Promise.all([
    prisma.scheduleLesson.findMany({
      where: { teacherId: { in: ids } },
      select: {
        teacherId: true,
        order: true,
        startTime: true,
        endTime: true,
        schedule: { select: { day: true } },
      },
    }),
    getScheduleSettings(),
  ]);

  const periodMap = periodMapOf(settings);
  const accumulators = new Map(); // teacherId → Map<dayNumber, acc>

  for (const lesson of lessons) {
    const row = result.get(lesson.teacherId);
    if (!row) continue;

    const dayNumber = DAY_TO_NUMBER.get(lesson.schedule?.day);
    if (dayNumber === undefined) continue; // ma'lumot buzilgan — tashlanadi

    row.hasLessons = true;

    if (!accumulators.has(lesson.teacherId)) accumulators.set(lesson.teacherId, new Map());
    const byDay = accumulators.get(lesson.teacherId);
    if (!byDay.has(dayNumber)) byDay.set(dayNumber, emptyWindow());

    addLesson(byDay.get(dayNumber), resolveLessonTime(lesson, periodMap));
  }

  for (const [teacherId, byDay] of accumulators) {
    const row = result.get(teacherId);
    for (const [dayNumber, acc] of byDay) row.byDay.set(dayNumber, finalizeWindow(acc));
  }

  for (const row of result.values()) {
    row.workDays = [...row.byDay.keys()].sort((a, b) => a - b);
  }

  return result;
}

/**
 * Bitta o'qituvchining haftalik ish oynasi.
 *
 * @param {string} teacherId
 * @returns {Promise<{byDay: Map, workDays: number[], hasLessons: boolean}>}
 */
async function getScheduleWorkTime(teacherId) {
  const map = await getScheduleWorkTimes([teacherId]);
  return map.get(String(teacherId));
}

/**
 * BERILGAN KUNDA o'qituvchilarning AMALDAGI ish oynasi — o'sha kuni haqiqatan
 * o'tiladigan darslardan. DAVOMAT (kechikish, erta ketish, kelmaganlik)
 * shundan o'qiydi.
 *
 * Haftalik shablondan farqi:
 *   · O'RINBOSARLIK — dars AMALDAGI o'qituvchiga yoziladi
 *     (`effectiveTeacherOf`, jarima va hisobotlar bilan AYNI qoida): darsini
 *     bergan egasidan olinadi, o'rinbosarga — o'z darsi bo'lmagan kunda ham —
 *     qo'shiladi;
 *   · BAYRAM kuni va TA'TIL oyi — dars yo'q (`closed`), ish kuni emas
 *     (oylikdagi dars soati bilan AYNI: `lessonHours.service.js`).
 *
 * Bitta kun uchun maktab bo'ylab: so'ralgan o'qituvchilarning o'z darslari va
 * ular o'rinbosar bo'lgan sinflar — ikki-uch so'rov, o'qituvchilar soniga
 * bog'liq emas.
 *
 * @param {string[]} teacherIds
 * @param {Date} day - Toshkent kuni, UTC yarim tuni
 * @returns {Promise<Map<string, {
 *   startTime: string|null,
 *   endTime: string|null,
 *   firstLessonTime: string|null,
 *   lessonCount: number,
 *   closed: "sunday"|"holiday"|"vacation"|null
 * }>>} Har bir so'ralgan id uchun qator BO'LADI (darsi yo'q — `lessonCount: 0`).
 */
async function getScheduleDayWindows(teacherIds, day) {
  const ids = uniqueIds(teacherIds);
  const build = (closed, accumulators = new Map()) =>
    new Map(
      ids.map((id) => [id, { ...finalizeWindow(accumulators.get(id) ?? emptyWindow()), closed }]),
    );

  if (ids.length === 0) return new Map();

  const dayName = scheduleDayOf(day);
  if (!dayName) return build("sunday");

  const [holidaySet, vacationSet] = await Promise.all([
    buildHolidaySet(day, day),
    getVacationSet(),
  ]);
  if (holidaySet.has(dayKey(day))) return build("holiday");
  if (vacationSet.has(monthKeyOfDate(day))) return build("vacation");

  const idSet = new Set(ids);
  const cells = await getSubstitutionCells(day);

  // O'rinbosar sifatida kiradigan sinflar — o'z darsi bo'lmagan joyda ham
  const extraClassIds = [
    ...new Set(
      [...cells.values()]
        .filter((cell) => idSet.has(cell.substituteTeacherId))
        .map((cell) => cell.classId),
    ),
  ];

  const [schedules, settings] = await Promise.all([
    prisma.schedule.findMany({
      where: {
        day: dayName,
        OR: [
          { lessons: { some: { teacherId: { in: ids } } } },
          ...(extraClassIds.length ? [{ classId: { in: extraClassIds } }] : []),
        ],
      },
      select: {
        classId: true,
        lessons: {
          select: { teacherId: true, order: true, startTime: true, endTime: true },
        },
      },
    }),
    getScheduleSettings(),
  ]);

  const periodMap = periodMapOf(settings);
  const accumulators = new Map(ids.map((id) => [id, emptyWindow()]));

  for (const schedule of schedules) {
    for (const lesson of schedule.lessons) {
      if (!lesson.teacherId) continue;

      const { teacherId } = effectiveTeacherOf(
        { classId: schedule.classId, day: dayName, order: lesson.order, teacherId: lesson.teacherId },
        cells,
      );
      const acc = accumulators.get(teacherId);
      if (!acc) continue; // boshqa o'qituvchining darsi (so'ralmagan)

      addLesson(acc, resolveLessonTime(lesson, periodMap));
    }
  }

  return build(null, accumulators);
}

/**
 * Bitta o'qituvchining berilgan kundagi ish oynasi.
 *
 * @param {string} teacherId
 * @param {Date} day - Toshkent kuni, UTC yarim tuni
 */
async function getScheduleDayWindow(teacherId, day) {
  const map = await getScheduleDayWindows([teacherId], day);
  return map.get(String(teacherId));
}

/**
 * Haftalik oynani BITTA qatorga siqadi — xodimlar ro'yxati uchun.
 *
 * ⚠️ `workStartTime`/`workEndTime` bu yerda HAFTA BO'YICHA eng erta kelish
 * va eng kech tugash, bitta kunning oynasi EMAS: ro'yxatda odamga bitta
 * qator ajraladi va "seshanba 08:20, payshanba 12:50" ni bitta katakka
 * sig'dirib bo'lmaydi. Kun-kunga ajratilgani `byDay` da to'liq turadi —
 * panel kerak bo'lsa o'shani ochadi.
 *
 * @param {{byDay: Map, workDays: number[], hasLessons: boolean}} row
 * @returns {{workStartTime, workEndTime, firstLessonTime, arrivalLeadMinutes, workDays, byDay, scheduleMissing}}
 */
function summarizeWeek(row) {
  const week = emptyWindow();
  const byDay = {};

  for (const [dayNumber, window] of row?.byDay ?? []) {
    addLesson(week, { startTime: window.firstLessonTime, endTime: window.endTime });
    byDay[dayNumber] = {
      startTime: window.startTime,
      endTime: window.endTime,
      firstLessonTime: window.firstLessonTime,
      lessonCount: window.lessonCount,
    };
  }

  const summary = finalizeWindow(week);

  return {
    workStartTime: summary.startTime,
    workEndTime: summary.endTime,
    firstLessonTime: summary.firstLessonTime,
    arrivalLeadMinutes: SCHEDULE_ARRIVAL_LEAD_MINUTES,
    workDays: row?.workDays ?? [],
    byDay,
    scheduleMissing: !row?.hasLessons,
  };
}

module.exports = {
  getScheduleWorkTimes,
  getScheduleWorkTime,
  getScheduleDayWindows,
  getScheduleDayWindow,
  summarizeWeek,
  // Testlar va qo'shni servislar uchun
  resolveLessonTime,
  arrivalTimeOf,
  DAY_TO_NUMBER,
};
