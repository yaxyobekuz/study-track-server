/**
 * DAVOMAT — DAVR KESIMIDAGI STATISTIKA (bosh sahifa kartalari + hujjat).
 *
 * "Kunlik / Haftalik / Oylik / Yillik" tanlagichi bitta savolga javob
 * beradi: shu davrda davomat qanday va u OLDINGI davrga nisbatan o'sdimi
 * yoki tushdimi. Ikki ko'rinish bor va ikkalasi ham SHU fayldan oziqlanadi:
 *
 *   · bosh sahifadagi karta (`pulse` — yengil proyeksiya),
 *   · hujjat ko'rinishidagi to'liq hisobot (ekran + Word).
 *
 * ──────────────────────────────────────────────────────────────────────
 * IKKINCHI DVIGATEL YOZILMAYDI
 * ──────────────────────────────────────────────────────────────────────
 *
 * Hisob qoidalari `attendanceReport.service.js` dan OLINADI
 * (`aggregateByDay`, `classDayEntries`, `attendancePercent`): kutilgan =
 * jadval bo'yicha kutilganlar ∪ o'sha kuni belgilanganlar, kelganlar =
 * keldi + kech keldi, belgilanmagan esa KELMAGAN hisoblanadi
 * (`education.md` §6). Nusxa ko'chirilsa, "Hisobotlar" bo'limida 94%,
 * bosh sahifada 96% turib qolardi.
 *
 * Davr chegarasi ham bitta joyda (`helpers/statPeriod.helpers.js`) — xodimlar
 * topshiriqlari kartasi bilan AYNI oyna.
 *
 * ⚠️ `byDay` — KANONIK BIRLIK. Jami, dinamika (bo'laklar), hafta kunlari
 * kesimi va filiallar bo'ylab birlashtirish — hammasi SHUNDAN hosil
 * qilinadi (`attendanceStatsNetwork.service.js`). Jami alohida sanalsa,
 * tarmoq hisobotida u bo'laklar yig'indisidan farq qilib qolardi.
 *
 * ⚠️ FOIZ — KUTILGAN O'QUVCHI-KUNLARGA nisbatan, "belgilanganlarga"
 * nisbatan EMAS. Aks holda hech kim belgilamagan kun 100% bo'lib
 * ko'rinardi.
 */

const prisma = require("../config/prisma");
const { buildExpectedResolver } = require("./studentAttendance.service");
const { loadArchivedStudentScope } = require("./archivedStudentScope.service");
const { getTodayAllRecords } = require("./attendance.service");
const { getLessonAbsentees } = require("./lessonAbsence.service");
const {
  attendancePercent,
  emptyCounts,
  finalizeCounts,
  addCounts,
  aggregateByDay,
  indexDay,
  classDayEntries,
  tallyEntry,
  pointDiff,
  dayKey,
} = require("./attendanceReport.service");
const {
  resolveStatPeriod,
  bucketKey,
  bucketLabel,
  buildBuckets,
} = require("../helpers/statPeriod.helpers");
const { formatDateUz } = require("../helpers/date.helpers");
const { BadRequestError } = require("../utils/errors");
const { ROLES } = require("../utils/constants");

/** Hujjatdagi "eng ko'p qoldirganlar" ro'yxatining uzunligi. */
const TOP_STUDENTS = 25;
/** Davr kesimidagi hisobotda ko'rsatiladigan o'qituvchilar soni. */
const TOP_TEACHERS = 60;

/**
 * ⚠️ HAFTA KUNI INDEKSI 0 = DUSHANBA (topshiriqlar hisoboti bilan AYNI).
 * JS `getUTCDay()` da 0 = yakshanba, shuning uchun u har joyda bir xil
 * formula bilan suriladi — ikki konvensiya aralashsa jadval bir kunga
 * siljib chizilardi.
 */
const WEEKDAY_LABELS = [
  "Dushanba",
  "Seshanba",
  "Chorshanba",
  "Payshanba",
  "Juma",
  "Shanba",
  "Yakshanba",
];

const weekdayIndexOf = (key) => (new Date(`${key}T00:00:00Z`).getUTCDay() + 6) % 7;

const fullName = (user) =>
  [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() || "Noma'lum";

const period = (query) =>
  resolveStatPeriod(query, { onError: (message) => new BadRequestError(message) });

/* ────────────────────────── UMUMIY YIG'MALAR ────────────────────────── */

/**
 * KUNLARDAN BO'LAKLAR (dinamika jadvali).
 *
 * ⚠️ Davrning HAMMA bo'lagi qaytadi, yozuvsizi ham: yo'q bo'lak jadvaldan
 * tushib qolsa, "ta'tilda davomat yomonlashdi" degan yolg'on manzara
 * chiqardi — aslida u kunlarda dars umuman bo'lmagan.
 *
 * @param {Array<object>} days - `byDay` qatorlari
 * @param {{fromKey: string, toKey: string, granularity: string}} range
 * @param {string[]} fields - qo'shiladigan sanoqchilar
 */
const bucketize = (days, { fromKey, toKey, granularity }, fields) => {
  const rows = new Map(
    buildBuckets(fromKey, toKey, granularity).map((key) => [
      key,
      {
        key,
        label: bucketLabel(key, granularity),
        days: 0,
        ...Object.fromEntries(fields.map((field) => [field, 0])),
      },
    ]),
  );

  for (const day of days) {
    const row = rows.get(bucketKey(day.date, granularity));
    if (!row) continue;
    row.days += 1;
    for (const field of fields) row[field] += day[field] ?? 0;
  }

  return [...rows.values()].map((row) => ({
    ...row,
    percent: attendancePercent({ came: row.came, expected: row.expected }),
  }));
};

/** Hafta kunlari kesimi — "qaysi kuni ko'proq qoldiriladi". */
const byWeekday = (days, fields) => {
  const rows = WEEKDAY_LABELS.map((label, index) => ({
    index,
    label,
    days: 0,
    ...Object.fromEntries(fields.map((field) => [field, 0])),
  }));

  for (const day of days) {
    const row = rows[weekdayIndexOf(day.date)];
    row.days += 1;
    for (const field of fields) row[field] += day[field] ?? 0;
  }

  return rows
    .filter((row) => row.days > 0)
    .map((row) => ({
      ...row,
      percent: attendancePercent({ came: row.came, expected: row.expected }),
    }));
};

/**
 * JORIY VA OLDINGI DAVR FARQI.
 *
 * ⚠️ FOIZ FARQI — PUNKTDA (`pointDiff`): "94% dan 96% ga" o'sish 2 punkt,
 * 2,1% EMAS. Foizning foizi rahbarni chalg'itardi.
 *
 * ⚠️ SANOQLAR FARQI ham beriladi: faqat punkt ko'rsatilsa, davr qisqa
 * bo'lgani uchun tushgan raqam ham "yomonlashdi" bo'lib o'qilardi.
 */
const diffOf = (current, previous, fields) => ({
  percentPoints: pointDiff(current.percent, previous.percent),
  ...Object.fromEntries(
    fields.map((field) => [field, (current[field] ?? 0) - (previous[field] ?? 0)]),
  ),
});

/* ──────────────────────── O'QUVCHILAR DAVOMATI ──────────────────────── */

const STUDENT_FIELDS = [
  "expected",
  "came",
  "present",
  "late",
  "absent",
  "excused",
  "unmarked",
  "total",
];

/** Davr yozuvlari — kun kaliti bo'yicha guruhlangan. */
const groupByDay = (records) => {
  const map = new Map();
  for (const rec of records) {
    const key = dayKey(rec.date);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(rec);
  }
  return map;
};

/**
 * ⚠️ `classId` FAQAT KERAK BO'LGANDA o'qiladi: sinflar kesimi faqat JORIY
 * davr uchun quriladi, kartada esa umuman kerak emas. Yillik hisobotda bu
 * ustun yuz minglab qatorga ko'payib, javobni bejiz og'irlashtirardi.
 */
const loadStudentRecords = ({ start, end }, scope, { withClass = false } = {}) =>
  prisma.studentAttendance.findMany({
    where: { date: { gte: start, lte: end }, ...scope },
    select: {
      studentId: true,
      status: true,
      date: true,
      ...(withClass ? { classId: true } : {}),
    },
    orderBy: { date: "asc" },
  });

/** Kunlar yig'indisi — `addCounts` bilan, ya'ni oylik hisobot bilan AYNI. */
const sumDays = (days) => {
  const counts = emptyCounts();
  for (const day of days) addCounts(counts, day);
  finalizeCounts(counts);
  return { ...counts, schoolDays: days.length };
};

const studentDays = (records, resolver) =>
  [...aggregateByDay(records, resolver).values()]
    .map(({ recorded, ...day }) => day)
    .sort((a, b) => a.date.localeCompare(b.date));

/**
 * SINFLAR KESIMI — davr bo'yicha.
 *
 * ⚠️ Har KUN alohida hisoblanadi (`classDayEntries`): sinfning kutilgan
 * a'zolari kunga bog'liq (dars jadvali + o'qish davri), ya'ni oyni bitta
 * ro'yxat bilan ko'paytirib bo'lmaydi.
 */
const buildClassRows = async (byDayRecords, resolver) => {
  const rows = new Map();

  for (const [key, dayRecords] of byDayRecords) {
    const dayIndex = indexDay(dayRecords);
    const classIds = new Set([
      ...resolver.forDate(key).byClass.keys(),
      ...dayIndex.byClass.keys(),
    ]);

    for (const classId of classIds) {
      if (!rows.has(classId)) rows.set(classId, { classId, ...emptyCounts(), days: 0 });
      const row = rows.get(classId);
      let touched = false;

      for (const [, record] of classDayEntries(classId, key, resolver, dayIndex)) {
        tallyEntry(row, record);
        touched = true;
      }

      if (touched) row.days += 1;
    }
  }

  const list = [...rows.values()].filter((row) => row.expected > 0).map(finalizeCounts);

  const classes = list.length
    ? await prisma.class.findMany({
        where: { id: { in: list.map((row) => row.classId) } },
        select: { id: true, name: true },
      })
    : [];
  const nameOf = new Map(classes.map((item) => [String(item.id), item.name]));

  return list.map((row) => ({ ...row, className: nameOf.get(String(row.classId)) || "—" }));
};

/**
 * O'QUVCHILAR KESIMI — "eng ko'p qoldirgan" ro'yxati uchun.
 *
 * ⚠️ Kutilgan kunlar AYNI qoidadan (`forDate(key).ids` ∪ belgilanganlar),
 * ya'ni har o'quvchining kutilgan kunlari yig'indisi JAMI kutilganga
 * teng chiqadi — ikki jadval bir-biriga zid bo'lmaydi.
 */
const buildStudentRows = (byDayRecords, resolver) => {
  const rows = new Map();

  for (const [key, dayRecords] of byDayRecords) {
    const recordOf = new Map(dayRecords.map((rec) => [rec.studentId, rec]));
    const expected = new Set(resolver.forDate(key).ids);
    for (const id of recordOf.keys()) expected.add(id);

    for (const id of expected) {
      if (!rows.has(id)) rows.set(id, { studentId: id, ...emptyCounts() });
      const row = rows.get(id);
      const record = recordOf.get(id);

      row.expected += 1;
      if (!record) continue;
      if (row[record.status] !== undefined) row[record.status] += 1;
      row.total += 1;
    }
  }

  return [...rows.values()].map(finalizeCounts);
};

/** Ism va sinf — faqat ro'yxatga TUSHADIGAN o'quvchilar uchun o'qiladi. */
const attachStudents = async (rows) => {
  if (!rows.length) return [];

  const students = await prisma.user.findMany({
    where: { id: { in: rows.map((row) => row.studentId) } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      classes: { select: { class: { select: { name: true } } } },
    },
  });
  const byId = new Map(students.map((item) => [item.id, item]));

  return rows.map((row) => {
    const student = byId.get(row.studentId);
    return {
      ...row,
      name: fullName(student),
      className:
        student?.classes?.map((item) => item.class?.name).filter(Boolean).join(", ") || "—",
    };
  });
};

/**
 * O'QUVCHILAR DAVOMATI — davr kesimida.
 *
 * @param {{period?: string, from?: string, to?: string}} query
 * @param {{detail?: boolean, branch?: object|null}} [options]
 *   `detail: false` — bosh sahifadagi karta: sinflar va o'quvchilar
 *   ro'yxati QURILMAYDI (ular kartada ko'rinmaydi, lekin yillik davrda
 *   javobni bir necha yuz qatorga shishirardi).
 */
const getStudentAttendanceStats = async (query = {}, options = {}) => {
  const { detail = true, branch = null } = options;
  const range = period(query);

  const [resolver, scope] = await Promise.all([
    buildExpectedResolver(),
    loadArchivedStudentScope(),
  ]);

  const [records, previousRecords] = await Promise.all([
    loadStudentRecords(range, scope, { withClass: detail }),
    // ⚠️ OLDINGI DAVR AYNI DVIGATELDAN o'tadi, yengilroq yo'ldan EMAS:
    // sentabrning foizi oktabrda "oldingi davr" bo'lib, noyabrda esa
    // "joriy davr" bo'lib ko'rinadi — ikki yo'l bo'lsa, bitta oy ikki
    // ekranda ikki xil raqam bilan turardi.
    loadStudentRecords(
      {
        start: new Date(`${range.previous.fromKey}T00:00:00Z`),
        end: new Date(`${range.previous.toKey}T00:00:00Z`),
      },
      scope,
    ),
  ]);

  const days = studentDays(records, resolver);
  const previousDays = studentDays(previousRecords, resolver);

  const totals = sumDays(days);
  const previous = sumDays(previousDays);

  const byDayRecords = detail ? groupByDay(records) : null;
  const [classes, studentRows] = detail
    ? await Promise.all([
        buildClassRows(byDayRecords, resolver),
        attachStudents(
          buildStudentRows(byDayRecords, resolver)
            .filter((row) => row.expected > 0 && row.came < row.expected)
            .sort(
              (a, b) =>
                b.expected - b.came - (a.expected - a.came) ||
                (a.percent ?? 101) - (b.percent ?? 101),
            )
            .slice(0, TOP_STUDENTS),
        ),
      ])
    : [[], []];

  return {
    kind: "students",
    period: range,
    branch,
    isNetwork: false,
    branches: branch ? [branch] : [],
    partial: [],
    generatedAt: new Date(),
    totals,
    previous,
    // ⚠️ OLDINGI DAVRNING KUN KALITLARI: tarmoq hisobotida o'quv kunlari
    // filiallar bo'ylab BIRLASHTIRILADI, qo'shilmaydi (bir xil kun ikki
    // filialda ham o'quv kuni). Sanoqning o'zi buni ayta olmasdi.
    previousDayKeys: previousDays.map((day) => day.date),
    change: diffOf(totals, previous, ["expected", "came", "absent", "excused", "schoolDays"]),
    byDay: days,
    trend: bucketize(days, range, STUDENT_FIELDS),
    weekday: byWeekday(days, STUDENT_FIELDS),
    classes: classes.sort(
      (a, b) => (a.percent ?? 101) - (b.percent ?? 101) || a.className.localeCompare(b.className, "uz"),
    ),
    students: studentRows,
  };
};

/* ─────────────────────── O'QITUVCHILAR DAVOMATI ─────────────────────── */

const TEACHER_FIELDS = [
  "expected",
  "came",
  "present",
  "late",
  "absent",
  "excused",
  "unmarked",
  "total",
  "lateMinutes",
  // "Keldi-ketti": kelish va ketish vaqti yozilgan kunlar va ularning
  // yig'indisi. Faqat IKKALA vaqt ham bor kun sanaladi — ketishi
  // belgilanmagan kun "0 soat ishladi" bo'lib ko'rinardi.
  "workedMinutes",
  "timedDays",
];

/**
 * ⚠️ FAQAT O'QITUVCHILAR. Davomat jadvali butun xodimni qamraydi, lekin
 * bu karta "dars bo'lyapti-yu, o'qituvchi yo'q" degan savol bilan BIRGA
 * turadi: buxgalter bilan o'qituvchi bitta foizga qo'shilsa, raqam
 * "darslar qanday ketyapti" degan savolga javob bermay qolardi.
 *
 * Rol ASOSIY yoki QO'SHIMCHA bo'lishi mumkin (`extraRoles`) — loyihadagi
 * boshqa joylar bilan AYNI shart (`schedule.service.js`, `gradingGrant`).
 *
 * ⚠️ `isActive` SHART: avtomat "kelmadi" jobi ham aynan shu doirada
 * ishlaydi (`attendanceAbsent.job.js`), ya'ni maxraj o'sha yozuvlarga
 * to'g'ri keladi. Arxivlangan xodim umuman olinmaydi.
 */
const TEACHER_WHERE = {
  isActive: true,
  isArchived: false,
  OR: [{ role: ROLES.TEACHER }, { extraRoles: { has: ROLES.TEACHER } }],
};

const emptyTeacherDay = (date) => ({
  date,
  expected: 0,
  came: 0,
  present: 0,
  late: 0,
  absent: 0,
  excused: 0,
  unmarked: 0,
  total: 0,
  lateMinutes: 0,
  workedMinutes: 0,
  timedDays: 0,
  percent: null,
});

const finalizeTeacherDay = (day) => {
  day.came = day.present + day.late;
  day.percent = attendancePercent({ came: day.came, expected: day.expected });
  return day;
};

const loadTeacherRecords = ({ start, end }, teacherIds) =>
  teacherIds.length
    ? prisma.attendance.findMany({
        where: { userId: { in: teacherIds }, date: { gte: start, lte: end } },
        select: {
          userId: true,
          status: true,
          date: true,
          lateMinutes: true,
          // "Keldi-ketti" — ishda bo'lgan vaqt shu ikkisidan chiqadi
          checkIn: true,
          checkOut: true,
        },
        orderBy: { date: "asc" },
      })
    : [];

/**
 * BITTA KUNDA ISHDA BO'LGAN VAQT (daqiqa).
 *
 * ⚠️ FAQAT IKKALA VAQT HAM BOR bo'lsa sanaladi: "Men ketdim" bosilmagan
 * kun "0 soat ishladi" bo'lib ko'rinib, o'rtachani jimgina tushirib
 * yuborardi (`attendanceReport.service.js` dagi `timesheet` bilan AYNI
 * qoida). Manfiy ayirma (tuzatilgan vaqt) ham hisobga olinmaydi.
 */
const workedMinutesOf = (record) => {
  if (!record.checkIn || !record.checkOut) return 0;
  const minutes = Math.round(
    (new Date(record.checkOut).getTime() - new Date(record.checkIn).getTime()) / 60000,
  );
  return minutes > 0 ? minutes : 0;
};

/**
 * KUNLAR KESIMI.
 *
 * ⚠️ MAXRAJ — BELGILANGAN KUNLAR + BUGUNGI BELGILANMAGANLAR. Kun oxirida
 * avtomat job qolganlarni "kelmadi" qilib yozadi (`attendanceAbsent.job.js`),
 * ya'ni o'tgan kunlar to'liq. BUGUN esa hali to'liq emas: faqat
 * belgilanganlarga bo'linsa, ertalab soat 9 da karta 100% ko'rsatib
 * turardi.
 *
 * @param {Array<object>} records
 * @param {Map<string, number>} unmarkedToday - kun kaliti → belgilanmaganlar
 */
const teacherDays = (records, unmarkedToday = new Map()) => {
  const map = new Map();

  const dayOf = (key) => {
    if (!map.has(key)) map.set(key, emptyTeacherDay(key));
    return map.get(key);
  };

  for (const rec of records) {
    const day = dayOf(dayKey(rec.date));
    if (day[rec.status] !== undefined) day[rec.status] += 1;
    day.total += 1;
    day.expected += 1;
    day.lateMinutes += rec.lateMinutes || 0;

    const worked = workedMinutesOf(rec);
    if (worked) {
      day.workedMinutes += worked;
      day.timedDays += 1;
    }
  }

  for (const [key, count] of unmarkedToday) {
    if (!count) continue;
    const day = dayOf(key);
    day.expected += count;
    day.unmarked += count;
  }

  return [...map.values()].map(finalizeTeacherDay).sort((a, b) => a.date.localeCompare(b.date));
};

const sumTeacherDays = (days) => {
  const totals = { ...emptyTeacherDay(null), schoolDays: days.length };
  delete totals.date;

  for (const day of days) {
    for (const field of TEACHER_FIELDS) totals[field] += day[field] ?? 0;
  }

  finalizeTeacherDay(totals);
  totals.avgLateMinutes = totals.late ? Math.round(totals.lateMinutes / totals.late) : 0;
  // ⚠️ O'rtacha VAQTI YOZILGAN kunlarga bo'linadi, hamma kunga emas
  totals.avgWorkedMinutes = totals.timedDays
    ? Math.round(totals.workedMinutes / totals.timedDays)
    : 0;
  return totals;
};

/**
 * BUGUN BELGILANMAGANLAR — ish kuni bo'lgani holda yozuvi yo'q o'qituvchilar.
 *
 * ⚠️ "Ish kunimi" degan savolga FAQAT jadval javob beradi
 * (`getTodayAllRecords` → `isWorkDay`): dars jadvalidan ishlaydigan
 * o'qituvchida bu darslar bor-yo'qligiga bog'liq (`education.md` §6).
 * Shuning uchun u yerda hisoblangan qiymat qayta hisoblanmaydi.
 */
const loadUnmarkedToday = async (teacherIds) => {
  const ids = new Set(teacherIds);
  const { rows, date } = await getTodayAllRecords(null, null);

  const list = rows.filter(
    (row) => ids.has(row.user.id) && row.isWorkDay && row.status === "not_marked",
  );

  return { key: dayKey(date), ids: new Set(list.map((row) => row.user.id)) };
};

/**
 * O'QITUVCHILAR DAVOMATI — davr kesimida + "hozir darsda yo'qlar".
 *
 * @param {{period?: string, from?: string, to?: string}} query
 * @param {{detail?: boolean, branch?: object|null}} [options]
 */
const getTeacherAttendanceStats = async (query = {}, options = {}) => {
  const { detail = true, branch = null } = options;
  const range = period(query);

  const teachers = await prisma.user.findMany({
    where: TEACHER_WHERE,
    select: { id: true, firstName: true, lastName: true },
  });
  const teacherIds = teachers.map((item) => item.id);

  const previousRange = {
    start: new Date(`${range.previous.fromKey}T00:00:00Z`),
    end: new Date(`${range.previous.toKey}T00:00:00Z`),
  };

  const [records, previousRecords, today, live] = await Promise.all([
    loadTeacherRecords(range, teacherIds),
    loadTeacherRecords(previousRange, teacherIds),
    range.includesToday && teacherIds.length
      ? loadUnmarkedToday(teacherIds)
      : { key: null, ids: new Set() },
    // ⚠️ JONLI BLOK DAVRGA BOG'LIQ EMAS: u "hozir dars bo'lyapti, o'qituvchi
    // esa maktabda yo'q" degan savolga javob beradi. Davr bugunni
    // qamramasa (qo'lda tanlangan o'tgan oraliq) — umuman so'ralmaydi.
    range.includesToday ? getLessonAbsentees({}) : null,
  ]);

  const unmarkedToday = today.key ? new Map([[today.key, today.ids.size]]) : new Map();

  const days = teacherDays(records, unmarkedToday);
  const previousDays = teacherDays(previousRecords);

  const totals = sumTeacherDays(days);
  const previous = sumTeacherDays(previousDays);

  let rows = [];
  if (detail) {
    const byTeacher = new Map(
      teachers.map((item) => [
        item.id,
        { userId: item.id, name: fullName(item), ...emptyTeacherDay(null) },
      ]),
    );

    for (const rec of records) {
      const row = byTeacher.get(rec.userId);
      if (!row) continue;
      if (row[rec.status] !== undefined) row[rec.status] += 1;
      row.total += 1;
      row.expected += 1;
      row.lateMinutes += rec.lateMinutes || 0;

      const worked = workedMinutesOf(rec);
      if (worked) {
        row.workedMinutes += worked;
        row.timedDays += 1;
      }
    }

    for (const id of today.ids) {
      const row = byTeacher.get(id);
      if (!row) continue;
      row.expected += 1;
      row.unmarked += 1;
    }

    rows = [...byTeacher.values()]
      .filter((row) => row.expected > 0)
      .map((row) => {
        const { date: _date, ...rest } = finalizeTeacherDay(row);
        rest.avgWorkedMinutes = rest.timedDays
          ? Math.round(rest.workedMinutes / rest.timedDays)
          : 0;
        return rest;
      })
      // Eng muammolisi tepada: avval foiz, keyin kechikish daqiqalari
      .sort(
        (a, b) =>
          (a.percent ?? 101) - (b.percent ?? 101) ||
          b.lateMinutes - a.lateMinutes ||
          a.name.localeCompare(b.name, "uz"),
      )
      .slice(0, TOP_TEACHERS);
  }

  return {
    kind: "teachers",
    period: range,
    branch,
    isNetwork: false,
    branches: branch ? [branch] : [],
    partial: [],
    generatedAt: new Date(),
    staffCount: teachers.length,
    totals,
    previous,
    previousDayKeys: previousDays.map((day) => day.date),
    change: diffOf(totals, previous, ["expected", "came", "late", "absent", "excused", "schoolDays"]),
    byDay: days,
    trend: bucketize(days, range, TEACHER_FIELDS),
    weekday: byWeekday(days, TEACHER_FIELDS),
    teachers: rows,
    // Jonli blok: dars boshlangan, o'qituvchi esa maktabda yo'q
    live: live
      ? {
          date: live.date,
          dateLabel: live.dateLabel,
          nowLabel: live.nowLabel,
          closed: live.closed,
          message: live.message,
          summary: live.summary,
          // ⚠️ TELEFON RAQAMI OLIB TASHLANADI: bu hisobot davomatni
          // KO'RSATADI, qo'ng'iroq qilmaydi — "Darsga kelmaganlar" jonli
          // ro'yxati bilan farqi shunda (`studentAttendanceTeacher`
          // yo'lidagi AYNI qaror).
          teachers: detail
            ? live.teachers.map(({ phone: _phone, ...row }) => row)
            : [],
        }
      : null,
  };
};

module.exports = {
  getStudentAttendanceStats,
  getTeacherAttendanceStats,

  // Tarmoq birlashtiruvchisi AYNI qoidalardan foydalanadi
  WEEKDAY_LABELS,
  STUDENT_FIELDS,
  TEACHER_FIELDS,
  TOP_STUDENTS,
  TOP_TEACHERS,
  bucketize,
  byWeekday,
  diffOf,
  sumDays,
  sumTeacherDays,
  emptyTeacherDay,
  finalizeTeacherDay,
  weekdayIndexOf,
};
