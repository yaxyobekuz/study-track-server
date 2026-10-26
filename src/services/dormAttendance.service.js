/**
 * YOTOQXONA DAVOMATI — "bugun kechqurun yotoqxonada kim qoldi".
 *
 * Qoida bitta jumlada:
 *
 * > Tarbiyachi har kuni belgilangan vaqtdan (sukut 16:00, Toshkent)
 * > boshlab o'quvchini "keldi / kelmadi / sababli" deb belgilaydi —
 * > xohlagan sinfni tanlab yoki butun maktab ro'yxatidan.
 *
 * ⚠️ DARS DAVOMATI BILAN ARALASHMAYDI (`studentAttendance.service.js`).
 * U — kunning o'quv davomati: baho jarimasining maxraji (`education.md`
 * §7), davomat foizi va kechki "kelmadi" job o'shanga tayanadi. Bu yerda
 * esa boshqa savol va ALOHIDA jadval (`DormAttendance`): tarbiyachining
 * "kelmadi" si bolaning dars davomatini, demak jarima va oylik hisobini
 * O'ZGARTIRMAYDI. Ikkalasi bitta qatorga yozilsa, kechqurun yotoqxonaga
 * kelmagan bola ertalab darsga kelmagan bo'lib qolardi.
 *
 * ⚠️ YOTOQXONA HAR KUNI ISHLAYDI. Yakshanba, bayram (`Holiday`) va ta'til
 * oyida (`VacationMonth`) ham ro'yxat OCHIQ — bola o'sha yerda yashaydi.
 * Dars kunlari darvozasi (`scheduleDayOf`, `buildHolidaySet`) shu sababdan
 * bu yerda chaqirilmaydi: u dars bor-yo'qligini hal qiladi.
 *
 * ⚠️ "O'QIYAPTIMI" DEGAN SAVOLGA FAQAT O'QISH DAVRI JAVOB BERADI
 * (`education.md` §3–4): ro'yxat `loadEnrollmentsOn` bilan kesiladi —
 * kunlik dars ro'yxatlari bilan AYNI qoida. Aks holda maktabdan ketgan,
 * lekin sinfda qolgan bola har kecha "belgilanmagan" bo'lib turardi.
 *
 * ⚠️ YOTOQXONA RO'YXATI ALOHIDA SAQLANMAYDI (biznes qarori): tarbiyachi
 * butun maktab yoki tanlangan sinf ro'yxatidan o'zi kerakligini belgilaydi.
 * Shuning uchun "kelmadi" — BELGILANGAN fakt, "belgilanmagan" esa fakt
 * EMAS: yotoqxonada yashamaydigan yuzlab o'quvchini "kelmadi" deb sanash
 * sanoqni ma'nosiz qilardi (`buildSummary` izohiga qarang).
 *
 * ⚠️ SINFSIZ O'QUVCHI HAM BELGILANADI (`classId` NULL bo'lishi mumkin):
 * yotoqxonada yashash sinf a'zoligiga bog'liq emas. Dars davomatida
 * `classId` majburiy va u yerda sinfsiz o'quvchi belgilanmaydi — bu farq
 * ATAYLAB.
 */

const prisma = require("../config/prisma");
const { BadRequestError, ForbiddenError, NotFoundError } = require("../utils/errors");
const { PERMISSIONS, hasPermission, hasRole } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");
const { currentDayDate, parseDayDate } = require("../helpers/month.helpers");
const { dayKey } = require("../helpers/lessonHours");
const { tashkentMinuteOfDay, parseClock, formatClock } = require("../helpers/devicePolicy.helpers");
const { formatDateUz } = require("../helpers/date.helpers");
const { getDormAttendanceSettings } = require("./settings.service");
const { ACTIVE_STUDENT_WHERE, loadEnrollmentsOn } = require("./studentAttendance.service");

/** Belgilanadigan holatlar — yagona manba (panel ham shu tartibda ko'rsatadi). */
const DORM_STATUSES = Object.freeze(["present", "absent", "excused"]);

const DORM_STATUS_LABELS = Object.freeze({
  present: "Keldi",
  absent: "Kelmadi",
  excused: "Sababli",
});

/** Ro'yxat filtri: saqlangan holat + "belgilanmagan". */
const LIST_STATUS_FILTERS = Object.freeze([...DORM_STATUSES, "unmarked"]);

/** Sinf filtri: "Sinfsiz o'quvchilar" (`studentSystem.service.js` bilan AYNI kalit). */
const NO_CLASS = "none";
const NO_CLASS_LABEL = "Sinfsiz";

/** Bitta so'rovda belgilanadigan qatorlarning chegarasi. */
const MARK_BATCH_MAX = 1000;

const NOTE_MAX = 300;

/** Qidiruvda hisobga olinadigan so'zlar (`nameSearch.helpers.js` bilan AYNI). */
const SEARCH_TERMS_MAX = 4;

const nameCollator = new Intl.Collator("uz", { sensitivity: "base" });
const classCollator = new Intl.Collator("uz", { numeric: true, sensitivity: "base" });

const STUDENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  classes: { select: { class: { select: { id: true, name: true } } } },
};

const RECORD_SELECT = {
  id: true,
  studentId: true,
  classId: true,
  status: true,
  note: true,
  markedAt: true,
  lastModifiedBy: true,
};

const fullName = (person) =>
  [person?.lastName, person?.firstName].filter(Boolean).join(" ").trim() || "—";

/* ───────────────────────────── KUN VA VAQT ───────────────────────────── */

/**
 * So'rovdagi kun — Toshkent kunining UTC yarim tuni.
 *
 * KELAJAK KUNI HAR DOIM RAD ETILADI: hali bo'lmagan kecha uchun "keldi"
 * yozib qo'yish mumkin bo'lsa, registr fakt emas, rejaga aylanardi.
 *
 * @param {string|undefined} dateInput - "YYYY-MM-DD"
 * @returns {{day: Date, today: Date, isToday: boolean, isPast: boolean}}
 */
function resolveDormDay(dateInput) {
  const today = currentDayDate();
  const day = dateInput ? parseDayDate(dateInput, "Sana") : today;

  if (day.getTime() > today.getTime()) {
    throw new BadRequestError("Kelajak kuni uchun yotoqxona davomati belgilanmaydi");
  }

  return {
    day,
    today,
    isToday: day.getTime() === today.getTime(),
    isPast: day.getTime() < today.getTime(),
  };
}

/** Sozlamadagi boshlanish vaqti — yaroqsiz qiymatda ham ro'yxat yopilmaydi. */
function resolveStartMinute(settings) {
  const minute = parseClock(settings?.startTime);
  return minute === null ? 0 : minute;
}

/**
 * "Hozir belgilash mumkinmi" — HAR IKKALA yo'l (o'qish va yozish) shu
 * yagona funksiyadan javob oladi.
 *
 * ⚠️ TUGMA BILAN SERVER BIR XIL GAPIRADI: ekran tugmani shu javob bilan
 * yopadi, yozuv yo'li ham shuni tekshiradi. Ikki nusxa bo'lsa, panel
 * "belgilang" deb turib, server 403 qaytarardi.
 *
 * ⚠️ VAQT DARVOZASI FAQAT BUGUNGI KUNGA tegishli: o'tgan kun allaqachon
 * tugagan, uni soat bilan to'sishning ma'nosi yo'q — u KUN bo'yicha
 * to'siladi (faqat `dormAttendance.update`).
 *
 * @param {{ day: Date, isToday: boolean, isPast: boolean }} dayState
 * @param {object} settings - `DormAttendanceSettings`
 * @param {object} actor - `req.user`
 * @returns {{ canMark: boolean, reason: string|null, message: string|null,
 *   startTime: string, startsInMinutes: number|null, canBackfill: boolean }}
 */
function resolveMarkGate(dayState, settings, actor) {
  const startMinute = resolveStartMinute(settings);
  const startTime = formatClock(startMinute);

  // Ma'muriyat (`update`) — o'tgan kunni to'g'rilaydi va soatga bog'lanmaydi.
  // Owner har doim ichida (`authorizePermission` bilan AYNI qoida).
  const canBackfill =
    hasRole(actor, ROLES.OWNER) ||
    hasPermission(actor?.permissions ?? [], PERMISSIONS.DORMATTENDANCE_UPDATE);

  const base = { startTime, startsInMinutes: null, canBackfill };

  if (dayState.isPast) {
    return canBackfill
      ? { ...base, canMark: true, reason: null, message: null }
      : {
          ...base,
          canMark: false,
          reason: "past_day",
          message:
            "O'tgan kunning yotoqxona davomatini faqat ma'muriyat to'g'rilaydi",
        };
  }

  if (canBackfill) return { ...base, canMark: true, reason: null, message: null };

  const nowMinute = tashkentMinuteOfDay(new Date());
  if (nowMinute < startMinute) {
    return {
      ...base,
      canMark: false,
      reason: "too_early",
      startsInMinutes: startMinute - nowMinute,
      message: `Yotoqxona davomati soat ${startTime} dan boshlanadi`,
    };
  }

  return { ...base, canMark: true, reason: null, message: null };
}

/* ───────────────────────────── DOIRA (SCOPE) ───────────────────────────── */

function assertStatusFilter(status) {
  if (status && !LIST_STATUS_FILTERS.includes(status)) {
    throw new BadRequestError(`Noto'g'ri holat filtri: ${status}`);
  }
}

/** `"none"` → sinfsiz, id → o'sha sinf, bo'sh → butun maktab. */
function parseClassFilter(value) {
  if (value === undefined || value === null || value === "" || value === "all") {
    return null;
  }
  return String(value);
}

async function resolveClassScope(classFilter) {
  if (!classFilter) return { where: {}, label: "Butun maktab", classId: null };
  if (classFilter === NO_CLASS) {
    return {
      where: { classes: { none: {} } },
      label: `${NO_CLASS_LABEL} o'quvchilar`,
      classId: NO_CLASS,
    };
  }

  const classDoc = await prisma.class.findUnique({
    where: { id: classFilter },
    select: { id: true, name: true },
  });
  if (!classDoc) throw new NotFoundError("Sinf topilmadi");

  return {
    where: { classes: { some: { classId: classDoc.id } } },
    label: classDoc.name,
    classId: classDoc.id,
  };
}

/**
 * Doiradagi o'quvchilar va ularning shu kundagi yozuvi.
 *
 * ⚠️ YIG'INDI FILTRDAN OLDIN hisoblanadi (dars davomati bilan AYNI qoida):
 * "Kelmadi" filtrida turgan tarbiyachi ham umumiy manzarani ko'rishi kerak.
 */
async function loadScope(day, classFilter) {
  const scope = await resolveClassScope(classFilter);

  const members = await prisma.user.findMany({
    where: { ...ACTIVE_STUDENT_WHERE, ...scope.where },
    select: STUDENT_SELECT,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  // Sinf/sinfsiz ko'rinishida id bo'yicha, butun maktabda esa kunni qamragan
  // hamma davr bitta so'rovda (minglab id parametr yubormaslik uchun —
  // `getMarkList` bilan AYNI mulohaza).
  const enrollments = await loadEnrollmentsOn(
    day,
    scope.classId ? members.map((s) => s.id) : null,
  );

  const students = members
    .filter((s) => enrollments.has(s.id))
    .map((s) => ({ ...s, classes: (s.classes || []).map((c) => c.class) }));

  const records = students.length
    ? await prisma.dormAttendance.findMany({
        where: { date: day, studentId: { in: students.map((s) => s.id) } },
        select: RECORD_SELECT,
      })
    : [];

  return {
    scope,
    students,
    recordOf: new Map(records.map((rec) => [rec.studentId, rec])),
  };
}

/**
 * Yig'indi — hamma ekranda AYNI kalitlar.
 *
 * ⚠️ "KELMADI" — BELGILANGAN FAKT, hisoblanmaydi. Dars davomatida
 * `notCame = jami − kelganlar` (belgilanmagan ham kelmagan hisobiga
 * kiradi), bu yerda esa doira butun maktab: yotoqxonada yashamaydigan
 * yuzlab o'quvchi "kelmadi" bo'lib chiqar va "nechta bola kelmadi" degan
 * raqam yolg'on bo'lardi. Shu sababli `absent` faqat tarbiyachi aynan
 * shunday belgilagan qatorlardan sanaladi.
 *
 * `stayed` — "nechta kishi qoldi" degan savolning javobi (kelganlar).
 */
function buildSummary(total, records) {
  const summary = {
    total,
    present: 0,
    absent: 0,
    excused: 0,
    marked: 0,
    unmarked: 0,
    stayed: 0,
  };

  for (const rec of records) {
    if (summary[rec.status] !== undefined) summary[rec.status]++;
  }

  summary.marked = summary.present + summary.absent + summary.excused;
  summary.unmarked = Math.max(0, total - summary.marked);
  summary.stayed = summary.present;

  return summary;
}

function matchesStatusFilter(record, status) {
  if (!status) return true;
  if (status === "unmarked") return !record;
  return Boolean(record) && record.status === status;
}

/**
 * Qidiruv — XOTIRADA.
 *
 * Ro'yxat sahifalanmaydi (tarbiyachi bir ekranda hammasini belgilaydi),
 * ya'ni "501-chi o'quvchi topilmaydi" muammosi tug'ilmaydi va yig'indi
 * filtrdan oldin hisoblanadi. Sahifalangan ro'yxatda qidiruv SQL darajasida
 * bo'lishi SHART (`devices.md` §10) — bu yerda esa to'liq ro'yxat o'qilgan.
 */
function matchesSearch(student, search) {
  const terms = String(search ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, SEARCH_TERMS_MAX)
    .map((t) => t.toLowerCase());
  if (terms.length === 0) return true;

  const haystack = [student.firstName, student.lastName, student.username]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return terms.every((term) => haystack.includes(term));
}

/** Qatordagi sinf: yozuvdagi, bo'lmasa o'quvchining birinchi sinfi. */
function rowClassOf(student, record) {
  const classes = student.classes ?? [];
  if (record?.classId) {
    return classes.find((c) => c.id === record.classId) ?? { id: record.classId, name: null };
  }
  return classes[0] ?? null;
}

/* ──────────────────────────── O'QISH YO'LLARI ──────────────────────────── */

/**
 * KUNLIK RO'YXAT — belgilash ekranining ma'lumoti (sahifalanmaydi).
 *
 * @param {object} actor - `req.user`
 * @param {{date?: string, classId?: string, status?: string, search?: string}} query
 */
async function getDormDay(actor, { date, classId, status, search } = {}) {
  assertStatusFilter(status);

  const dayState = resolveDormDay(date);
  const classFilter = parseClassFilter(classId);

  const [settings, { scope, students, recordOf }] = await Promise.all([
    getDormAttendanceSettings(),
    loadScope(dayState.day, classFilter),
  ]);

  const gate = resolveMarkGate(dayState, settings, actor);
  const summary = buildSummary(students.length, [...recordOf.values()]);

  const markedByIds = [
    ...new Set([...recordOf.values()].map((r) => r.lastModifiedBy).filter(Boolean)),
  ];
  const markedByPeople = markedByIds.length
    ? await prisma.user.findMany({
        where: { id: { in: markedByIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const markedByName = new Map(
    markedByPeople.map((p) => [
      p.id,
      [p.firstName, p.lastName].filter(Boolean).join(" ").trim() || "Noma'lum",
    ]),
  );

  const rows = students
    .map((student) => {
      const record = recordOf.get(student.id) ?? null;
      const cls = rowClassOf(student, record);

      return {
        student: {
          id: student.id,
          firstName: student.firstName,
          lastName: student.lastName,
          username: student.username,
          classes: student.classes,
        },
        classId: cls?.id ?? null,
        className: cls?.name ?? null,
        status: record?.status ?? null,
        note: record?.note ?? "",
        markedAt: record?.markedAt ?? null,
        // KIM belgilagani — boshqa tarbiyachining qarori jim bosilmasin
        // (`studentAttendanceTeacher.service.js` bilan AYNI mulohaza)
        markedBy: record?.lastModifiedBy
          ? {
              id: record.lastModifiedBy,
              name: markedByName.get(record.lastModifiedBy) ?? "Noma'lum",
              isMe: record.lastModifiedBy === actor?.id,
            }
          : null,
      };
    })
    .filter(
      (row) =>
        matchesStatusFilter(recordOf.get(row.student.id), status) &&
        matchesSearch(row.student, search),
    );

  return {
    date: dayKey(dayState.day),
    // ⚠️ `day` — UTC yarim tuni (`dates.md` §4)
    dateLabel: formatDateUz(dayState.day, { utc: true }),
    isToday: dayState.isToday,
    scope: { classId: scope.classId, label: scope.label },
    gate,
    summary,
    students: rows,
  };
}

/**
 * SINFLAR KESIMI — "qaysi sinfdan nechta qoldi".
 *
 * ⚠️ Doira kunlik ro'yxat bilan AYNI (`loadEnrollmentsOn`), aks holda
 * kartadagi "jami" bilan ro'yxatdagi qatorlar soni bir-biriga mos
 * kelmasdi.
 *
 * ⚠️ IKKI SINFDAGI O'QUVCHI HAR IKKI QATORDA sanaladi, "Jami" da esa BIR
 * MARTA — shuning uchun kesimlar yig'indisi jamidan katta bo'lishi mumkin
 * (`studentSystem.service.js` va sertifikat kesimlari bilan AYNI qoida).
 *
 * @param {{date?: string}} query
 */
async function getDormClassBreakdown({ date } = {}) {
  const dayState = resolveDormDay(date);
  const day = dayState.day;

  const [classes, members, enrollments, records] = await Promise.all([
    prisma.class.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
    }),
    prisma.user.findMany({
      where: ACTIVE_STUDENT_WHERE,
      select: { id: true, classes: { select: { classId: true } } },
    }),
    loadEnrollmentsOn(day),
    prisma.dormAttendance.findMany({
      where: { date: day },
      select: { studentId: true, status: true },
    }),
  ]);

  const studying = members.filter((s) => enrollments.has(s.id));
  const statusOf = new Map(records.map((r) => [r.studentId, r.status]));

  const emptyRow = () => ({ total: 0, present: 0, absent: 0, excused: 0 });
  const byClass = new Map(classes.map((cls) => [cls.id, emptyRow()]));
  const noClass = emptyRow();

  for (const student of studying) {
    const status = statusOf.get(student.id) ?? null;
    const classIds = student.classes.map((c) => c.classId).filter((id) => byClass.has(id));

    const buckets = classIds.length ? classIds.map((id) => byClass.get(id)) : [noClass];
    for (const bucket of buckets) {
      bucket.total++;
      if (status) bucket[status]++;
    }
  }

  const finish = (row) => ({
    ...row,
    marked: row.present + row.absent + row.excused,
    unmarked: Math.max(0, row.total - (row.present + row.absent + row.excused)),
    stayed: row.present,
  });

  const rows = classes
    .map((cls) => ({ id: cls.id, name: cls.name, ...finish(byClass.get(cls.id)) }))
    .sort((a, b) => classCollator.compare(a.name, b.name));

  if (noClass.total > 0) {
    rows.push({ id: NO_CLASS, name: NO_CLASS_LABEL, ...finish(noClass) });
  }

  // Jami — TAKRORSIZ o'quvchilar bo'yicha (ikki sinfdagi bola bir marta)
  const totals = buildSummary(
    studying.length,
    studying
      .map((s) => statusOf.get(s.id))
      .filter(Boolean)
      .map((status) => ({ status })),
  );

  return {
    date: dayKey(day),
    dateLabel: formatDateUz(day, { utc: true }),
    classes: rows,
    totals,
  };
}

/* ──────────────────────────── YOZUV YO'LI ──────────────────────────── */

/**
 * BELGILASH — bitta yoki bir nechta o'quvchi.
 *
 * ⚠️ RO'YXAT SERVERDAN tekshiriladi: yuborilgan `studentId` shu kuni
 * O'QIYOTGAN faol o'quvchi bo'lishi shart, sinf esa SERVER ro'yxatidan
 * qo'yiladi. Panel yuborgan `classId` ga ishonilmaydi (`LessonCredit` va
 * o'qituvchi davomati bilan AYNI doktrina): usiz eskirgan ekran ketgan
 * o'quvchiga, yoki qo'lda yozilgan so'rov istalgan sinf nomidan yozib
 * yuborardi.
 *
 * ⚠️ HOLATLAR YOZISHDAN OLDIN tekshiriladi: 50 qatorning 49-tasi xato
 * bo'lsa, oldingi 48 tasi allaqachon yozilgan bo'lib, tarbiyachi
 * "saqlanmadi" xatosini ko'rar, davomat esa yarim belgilangan qolardi.
 *
 * @param {object} actor - `req.user`
 * @param {{date?: string, records: Array<{studentId: string, status: string, note?: string}>}} params
 */
async function markDormAttendance(actor, { date, records } = {}) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new BadRequestError("Belgilash uchun yozuvlar yo'q");
  }
  if (records.length > MARK_BATCH_MAX) {
    throw new BadRequestError(
      `Bir martada ${MARK_BATCH_MAX} tadan ko'p o'quvchi belgilanmaydi`,
    );
  }

  const dayState = resolveDormDay(date);

  const settings = await getDormAttendanceSettings();
  const gate = resolveMarkGate(dayState, settings, actor);
  if (!gate.canMark) throw new ForbiddenError(gate.message);

  // Tekshiruv uchun doira: butun maktab (tarbiyachi sinf tanlamasdan ham
  // belgilaydi) — sinf esa har o'quvchining O'ZIDAN olinadi
  const { students } = await loadScope(dayState.day, null);
  const allowed = new Map(students.map((s) => [s.id, s]));

  const seen = new Set();
  const prepared = [];

  for (const rec of records) {
    if (!rec || typeof rec !== "object" || !rec.studentId) {
      throw new BadRequestError("Har bir yozuvda studentId bo'lishi shart");
    }
    if (seen.has(rec.studentId)) {
      throw new BadRequestError("Bitta o'quvchi ikki marta yuborilgan");
    }
    seen.add(rec.studentId);

    if (!DORM_STATUSES.includes(rec.status)) {
      throw new BadRequestError(`Noto'g'ri status: ${rec.status}`);
    }

    const student = allowed.get(rec.studentId);
    if (!student) {
      throw new ForbiddenError(
        "Ro'yxatda yo'q o'quvchi belgilanmaydi — ro'yxatni yangilang",
      );
    }

    const note = typeof rec.note === "string" ? rec.note.trim().slice(0, NOTE_MAX) : "";

    prepared.push({
      studentId: student.id,
      // Sinf SERVERDAN; sinfsiz o'quvchida NULL (ataylab — fayl izohiga qarang)
      classId: student.classes?.[0]?.id ?? null,
      status: rec.status,
      note: note || null,
    });
  }

  const now = new Date();
  const saved = [];

  for (const row of prepared) {
    saved.push(
      await prisma.dormAttendance.upsert({
        where: { studentId_date: { studentId: row.studentId, date: dayState.day } },
        update: {
          classId: row.classId,
          status: row.status,
          note: row.note,
          markedAt: now,
          lastModifiedBy: actor?.id ?? null,
        },
        create: {
          studentId: row.studentId,
          classId: row.classId,
          date: dayState.day,
          status: row.status,
          note: row.note,
          markedAt: now,
          createdBy: actor?.id ?? null,
          lastModifiedBy: actor?.id ?? null,
        },
        select: RECORD_SELECT,
      }),
    );
  }

  return { date: dayKey(dayState.day), saved: saved.length, records: saved };
}

/* ───────────────────────────── SOZLAMALAR ───────────────────────────── */

async function getSettings() {
  const settings = await getDormAttendanceSettings();
  return { startTime: formatClock(resolveStartMinute(settings)) };
}

/**
 * Boshlanish vaqtini o'zgartirish.
 *
 * ⚠️ `parseClock` dan o'tadi: panelda `<input type="time">` bo'lsa ham API
 * ga istalgan matn kelishi mumkin va yaroqsiz qiymat butun darvozani
 * jimgina "00:00" ga tushirardi.
 */
async function updateSettings(actor, { startTime } = {}) {
  const minute = parseClock(startTime);
  if (minute === null || minute >= 24 * 60) {
    throw new BadRequestError("Boshlanish vaqti noto'g'ri (masalan 16:00)");
  }

  const value = formatClock(minute);
  const settings = await prisma.dormAttendanceSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", startTime: value, updatedBy: actor?.id ?? null },
    update: { startTime: value, updatedBy: actor?.id ?? null },
  });

  return { startTime: settings.startTime };
}

/* ───────────────────────────── EKSPORT UCHUN ───────────────────────────── */

/**
 * EXCEL uchun ma'lumot — ekrandagi ro'yxat bilan BITTA manbadan.
 *
 * ⚠️ Fayl `loadScope` ning o'zidan quriladi: ikkinchi so'rov yozilsa
 * "kelganlar" ta'rifi yoki doira (o'qish davri) faylda boshqacha bo'lib
 * ketardi — odam esa aynan faylga ishonib ish qiladi.
 *
 * @param {{date?: string, classId?: string, status?: string}} query
 */
async function loadExportData({ date, classId, status } = {}) {
  assertStatusFilter(status);

  const dayState = resolveDormDay(date);
  const classFilter = parseClassFilter(classId);

  const { scope, students, recordOf } = await loadScope(dayState.day, classFilter);

  const summary = buildSummary(students.length, [...recordOf.values()]);

  // ⚠️ Holat filtri MAP dan OLDIN: qator shakli (`name`, `className`) ichida
  // `studentId` yo'q, ya'ni keyin filtrlash yozuvni qayta topa olmasdi.
  const rows = students
    .filter((student) => matchesStatusFilter(recordOf.get(student.id) ?? null, status))
    .map((student) => {
      const record = recordOf.get(student.id) ?? null;
      const cls = rowClassOf(student, record);

      return {
        name: fullName(student),
        username: student.username ?? "",
        className: cls?.name ?? NO_CLASS_LABEL,
        status: record?.status ?? null,
        statusLabel: record ? DORM_STATUS_LABELS[record.status] : "Belgilanmagan",
        note: record?.note ?? "",
        markedAt: record?.markedAt ?? null,
      };
    })
    .sort(
      (a, b) =>
        classCollator.compare(a.className, b.className) ||
        nameCollator.compare(a.name, b.name),
    );

  const breakdown = await getDormClassBreakdown({ date });

  return {
    date: dayKey(dayState.day),
    dateLabel: formatDateUz(dayState.day, { utc: true }),
    scopeLabel: scope.label,
    status: status ?? null,
    summary,
    rows,
    breakdown: breakdown.classes,
  };
}

module.exports = {
  DORM_STATUSES,
  DORM_STATUS_LABELS,
  LIST_STATUS_FILTERS,
  NO_CLASS,
  NO_CLASS_LABEL,
  resolveDormDay,
  resolveMarkGate,
  buildSummary,
  getDormDay,
  getDormClassBreakdown,
  markDormAttendance,
  getSettings,
  updateSettings,
  loadExportData,
};
