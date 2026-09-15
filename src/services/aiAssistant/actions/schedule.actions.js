/**
 * AI YORDAMCHI — DARS JADVALI bo'limi amallari (taklif → ko'rinish → tasdiq
 * → bajarish): o'rinbosar biriktirish, uni bekor qilish yoki (hali
 * boshlanmagan bo'lsa) o'chirish, dam olish kuni qo'shish va o'chirib qo'yish.
 *
 * ⚠️ ATAMA: "o'rinbosar" / "dars o'rniga chiqish". "Almashtirish" so'zi
 * tizimda FILIAL almashtirishni bildiradi (`education.md` §8).
 *
 * ⚠️ O'RINBOSARLIK TEKSHIRUVI NUSXALANMAYDI. `prepare` servisning o'zidagi
 * `prepareSubstitution` ni chaqiradi (u faqat o'qiydi): ikki o'rinbosar bitta
 * darsga, o'rinbosarning o'z darsi bilan to'qnashuv, o'z o'rniga chiqish,
 * davrga tushmaydigan kun, 180 kun, "boshqa sabab" izohi — hammasi AYNAN
 * yozishdagi shartlar. Nusxa yozilsa, tasdiqdan oldin "mumkin" deb
 * ko'rsatilgan taklif tasdiqdan keyin yiqilishi mumkin edi.
 *
 * ⚠️ DAM OLISH KUNI SERVISI DEYARLI HECH NARSANI TEKSHIRMAYDI
 * (`holiday.service.createHoliday`): sana formati, oraliq tartibi, oy/kun
 * chegarasi, takror — hech biri. Noto'g'ri yozuv panelda "bor" bo'lib
 * ko'rinadi, lekin hech bir kunga to'g'ri kelmaydi. Bu tekshiruvlar SHU
 * YERDA, tasdiqdan oldin.
 *
 * ⚠️ MUHRLANGAN OYLIK QAYTA HISOBLANMAYDI (`finance.md` §10). O'rinbosarlik
 * ham, dam olish kuni ham dars soatini o'zgartiradi; shakllangan oylik
 * majburiyati bo'lgan oy uchun ko'rinish buni OGOHLANTIRISH qilib aytadi.
 *
 * ⚠️ Ataylab OCHILMAGAN: amaldagi jadval tahriri, Google Sheets qo'llash /
 * manba almashtirish / tiklash (odam hash va tasdiqlarni o'zi ko'rishi
 * shart — `education.md` §10), dam olish kunini butunlay o'chirish.
 *
 * Erkin matn (izoh, sabab, nom) to'g'ridan-to'g'ri servisga boradi va
 * `xss-clean` dan o'tmaydi. Bu matnlar Telegramga yuborilmaydi, panel esa
 * ularni React orqali (ekranlab) chizadi.
 */

const prisma = require("../../../config/prisma");
const {
  defineAction,
  AiToolError,
  idSchema,
  daySchema,
  requireId,
  monthLabel,
  personName,
} = require("../assistant.toolkit");
const { formatDateUz, formatDateRangeUz } = require("../../../helpers/date.helpers");
const { parseDayDate, monthKeyOfDate, daysInMonth } = require("../../../helpers/month.helpers");
const { ROLES, DAYS, DAYS_UZ, MONTHS_UZ } = require("../../../utils/constants");
const { hasRole } = require("../../../utils/permissions");

const substitutionService = require("../../lessonSubstitution.service");
const holidayService = require("../../holiday.service");
const { getVacationSet } = require("../../vacationMonth.service");

const TOOLSET = "schedule";

const DAY_MS = 86400000;

/** `ScheduleDay` enum qiymatlari (dushanba → shanba). */
const SCHEDULE_DAYS = Object.values(DAYS);
const SUBSTITUTION_REASONS = Object.keys(substitutionService.REASON_LABELS);

/** Bitta taklifdagi darslar — ko'rinish o'qiladigan bo'lib qolishi uchun (haftalik yuklama odatda 30 dan kam). */
const MAX_LESSONS_PER_PROPOSAL = 60;

/** Bitta dars katagi uchun ko'rinishda sanab o'tiladigan sanalar. */
const CELL_DATES_SHOWN = 6;

/** Ko'rinishda sanab o'tiladigan dam olish sanalari. */
const HOLIDAY_DATES_SHOWN = 12;

/**
 * Oraliqli dam olish kunining eng uzun muddati. Yildan uzun "bayram" deyarli
 * har doim yil xatosi (2027 o'rniga 2072); uzoq tanaffus uchun esa ta'til oyi bor.
 */
const MAX_HOLIDAY_RANGE_DAYS = 366;

/** Bundan uzun oraliq ta'til oyi bilan belgilanishi to'g'riroq ekani haqida ogohlantiriladi. */
const LONG_HOLIDAY_RANGE_DAYS = 31;

/** Hisob oynasi uzunligi (kun) — nofaol qilinayotgan eski yozuvda yil xatosi bo'lsa ham sikl chegarali qolsin. */
const MAX_EFFECT_WINDOW_DAYS = 400;

const HOLIDAY_TYPE_LABELS = {
  single: "Bir kunlik",
  range: "Sana oralig'i",
  recurring: "Har yili takrorlanadi",
};

const MAX_NAME = 120;
const MAX_TEXT = 500;

// ─────────────────────────────────────────────────────────────────────────
// Umumiy yordamchilar
// ─────────────────────────────────────────────────────────────────────────

/** Servis xatosini (400/404) egaga tushunarli vosita xatosiga aylantiradi. */
async function asToolError(work) {
  try {
    return await work();
  } catch (err) {
    if (err instanceof AiToolError) throw err;
    if (Number.isInteger(err?.statusCode) && err.statusCode < 500) throw new AiToolError(err.message);
    throw err;
  }
}

/** "YYYY-MM-DD" → UTC yarim tun (xato matni o'zbekcha). */
function parseDay(value, label) {
  try {
    return parseDayDate(value, label);
  } catch (err) {
    throw new AiToolError(err.message);
  }
}

const isoOf = (date) => date.toISOString().slice(0, 10);
const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);
const dayText = (date) => formatDateUz(date, { utc: true });
const dayLabelOf = (day) => (day ? day[0].toUpperCase() + day.slice(1) : "—");
const timeLabel = (startTime, endTime) => (startTime && endTime ? `${startTime}–${endTime}` : null);

/** Erkin matn: bo'sh → "". */
const cleanText = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Ro'yxat matni: "A; B; C va yana 4 ta". Ajratgich nuqta-vergul: sana
 * formatining o'zida vergul bor ("21-may, 2025").
 */
function listText(values, shown) {
  const head = values.slice(0, shown).join("; ");
  const rest = values.length - shown;
  return rest > 0 ? `${head} va yana ${rest} ta` : head;
}

/**
 * Sanalar ro'yxati kalendar oylari bo'yicha bo'linadi: [{ month, from, to }].
 * Oylik majburiyat oy aniqligida — ko'rinishdagi soat ham oyma-oy aytiladi.
 */
function monthSegments(fromDate, toDate) {
  const segments = [];
  let cursor = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), 1));
  while (cursor.getTime() <= toDate.getTime()) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const monthEnd = addDays(next, -1);
    segments.push({
      month: monthKeyOfDate(cursor),
      from: cursor.getTime() < fromDate.getTime() ? fromDate : cursor,
      to: monthEnd.getTime() > toDate.getTime() ? toDate : monthEnd,
    });
    cursor = next;
  }
  return segments;
}

/**
 * Shakllangan (bekor qilinmagan) oylik majburiyatlari — oy bo'yicha soni.
 * `cancelSubstitution` ogohlantirishidagi AYNI shart: `status ≠ cancelled`.
 *
 * @param {number[]} months - YYYYMM
 * @param {string[]|null} staffIds - `null` → butun filial
 * @returns {Promise<Array<{ month: number, count: number }>>}
 */
async function sealedPayrollMonths(months, staffIds = null) {
  const unique = [...new Set(months)].sort((a, b) => a - b);
  if (unique.length === 0) return [];
  const rows = await prisma.payrollEntry.groupBy({
    by: ["month"],
    where: {
      month: { in: unique },
      status: { not: "cancelled" },
      ...(staffIds ? { staffId: { in: staffIds } } : {}),
    },
    _count: { _all: true },
    orderBy: { month: "asc" },
  });
  return rows.map((row) => ({ month: row.month, count: row._count._all }));
}

function sealedPayrollWarning(sealed, { perStaff = false } = {}) {
  if (sealed.length === 0) return null;
  const months = sealed
    .map((row) => (perStaff ? monthLabel(row.month) : `${monthLabel(row.month)} (${row.count} ta xodim)`))
    .join("; ");
  return (
    `${months} uchun oylik majburiyati allaqachon shakllantirilgan — u qayta hisoblanmaydi. ` +
    "Dars soatini oylikka o'tkazish uchun majburiyatni bekor qilib, oyni qayta shakllantirish kerak."
  );
}

// ─────────────────────────────────────────────────────────────────────────
// O'rinbosarlik yordamchilari
// ─────────────────────────────────────────────────────────────────────────

/** Katak kaliti — `teacherAccess.cellKey` bilan bir xil shakl: sinf|kun|tartib. */
const cellKeyOf = (item) => `${item.classId}|${item.day}|${item.lessonOrder}`;

/** Bitta dars katagi — bir qator matn: "Dushanba, 2-dars (08:30–09:15) · 5-A · Matematika". */
function cellText({ day, lessonOrder, className, subjectName, startTime, endTime }) {
  const time = timeLabel(startTime, endTime);
  return [
    `${dayLabelOf(day)}, ${lessonOrder}-dars${time ? ` (${time})` : ""}`,
    className || "sinf noma'lum",
    subjectName || "fan noma'lum",
  ].join(" · ");
}

/**
 * Oyna ichida katak HAQIQATAN o'tiladigan sanalar — faqat KO'RSATISH uchun.
 * Soat soni (pul) servisdagi `countOccurrences` dan olinadi; bu ro'yxat esa
 * uning AYNI shartlari bilan (yakshanba yo'q, bayram va ta'til oyi
 * chiqariladi) egaga "qaysi kunlar" ekanini ko'rsatadi.
 */
function cellDates(day, fromDate, toDate, holidaySet, vacationSet) {
  const dates = [];
  for (let cursor = fromDate; cursor.getTime() <= toDate.getTime(); cursor = addDays(cursor, 1)) {
    if (DAYS_UZ[cursor.getUTCDay()] !== day) continue;
    if (vacationSet.has(monthKeyOfDate(cursor)) || holidaySet.has(isoOf(cursor))) continue;
    dates.push(cursor);
  }
  return dates;
}

/**
 * Oyma-oy ko'chadigan soat — `countOccurrences` (servis) bilan. Oylik
 * majburiyati oy aniqligida bo'lgani uchun ega "qaysi oyga qancha" ni ko'rishi kerak.
 */
function hoursByMonth(items, fromDate, toDate, holidaySet, vacationSet) {
  return monthSegments(fromDate, toDate)
    .map((segment) => ({
      month: segment.month,
      hours: substitutionService.countOccurrences(items, segment.from, segment.to, holidaySet, vacationSet),
    }))
    .filter((row) => row.hours > 0);
}

/** Oynaning bayram to'plami va ta'til oylari — servisning `attachOccurrences` dagi AYNI manbalar. */
async function loadCalendar(fromDate, toDate) {
  const [holidaySet, vacationSet] = await Promise.all([
    holidayService.buildHolidaySet(fromDate, toDate),
    getVacationSet(),
  ]);
  return { holidaySet, vacationSet };
}

/**
 * Yozuvning hali ham dars egasiga tegishli kataklari. Jadval keyin qayta
 * saqlangan bo'lsa, egasi o'zgargan katak soatga ham, jurnal huquqiga ham
 * ta'sir qilmaydi (`lessonHours.loadSubstitutionWindows`,
 * `teacherAccess.effectiveTeacherOf` dagi shart) — ko'rinishdagi soat faqat
 * amaldagi kataklardan hisoblanadi.
 */
async function splitStaleItems(row) {
  const ownLessons = await prisma.scheduleLesson.findMany({
    where: { teacherId: row.originalTeacherId },
    select: { order: true, schedule: { select: { day: true, classId: true } } },
  });
  const owned = new Set(
    ownLessons
      .filter((lesson) => lesson.schedule?.day)
      .map((lesson) => `${lesson.schedule.classId}|${lesson.schedule.day}|${lesson.order}`),
  );
  const live = [];
  const stale = [];
  for (const item of row.items) (owned.has(cellKeyOf(item)) ? live : stale).push(item);
  return { live, stale };
}

/** Taklif uchun o'rinbosarlik yozuvi (servis serializeri: teacher obyektlari va `occurrenceCount` bilan). */
async function loadSubstitution(rawId) {
  const id = requireId(rawId, "O'rinbosarlik id");
  const row = await asToolError(() => substitutionService.getSubstitution(id));
  return { id, row };
}

const substitutionTarget = (row) =>
  `${row.originalTeacherName} (dars egasi) → ${row.substituteTeacherName} (o'rinbosar), ${row.periodLabel}`;

// ─────────────────────────────────────────────────────────────────────────
// 1. O'rinbosar biriktirish
// ─────────────────────────────────────────────────────────────────────────

const createSubstitution = defineAction({
  type: "substitutions.create",
  toolName: "propose_create_substitution",
  toolset: TOOLSET,
  title: "O'rinbosar biriktirish",
  risk: "high",
  permission: "substitutions.create",
  description:
    "Propose assigning a substitute teacher (o'rinbosar) to cover specific timetable lessons of an absent teacher for a " +
    "date window (inclusive, max 180 days). The timetable itself is never edited: for each covered lesson the journal " +
    "access and the lesson hours move from the original teacher to the substitute. Lessons are timetable cells " +
    "(classId, day, lessonOrder) of the ORIGINAL teacher whose weekday occurs in the window — build the list with " +
    "substitutions_available_lessons (pass substituteTeacherId to skip cells where the substitute is busy or the cell " +
    "is already covered). Rejected: same person, substitute has an own lesson or another cover at that day and period, " +
    "cell already covered, reason 'other' without a note. Resolve both teachers with search_people first.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["originalTeacherId", "substituteTeacherId", "fromDate", "toDate", "reason", "lessons"],
    properties: {
      originalTeacherId: idSchema("Absent teacher (lesson owner) id."),
      substituteTeacherId: idSchema("Substitute teacher id (any non-student, non-archived staff)."),
      fromDate: daySchema("First covered day YYYY-MM-DD (inclusive)."),
      toDate: daySchema("Last covered day YYYY-MM-DD (inclusive)."),
      reason: {
        type: "string",
        enum: SUBSTITUTION_REASONS,
        description: "illness, business_trip, personal, training or other (other requires a note).",
      },
      note: { type: "string", maxLength: MAX_TEXT, description: "Free-text note; required when reason is other." },
      lessons: {
        type: "array",
        minItems: 1,
        maxItems: MAX_LESSONS_PER_PROPOSAL,
        description: "Timetable cells of the original teacher to cover.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["classId", "day", "lessonOrder"],
          properties: {
            classId: idSchema("Class id of the lesson."),
            day: { type: "string", enum: SCHEDULE_DAYS, description: "Weekday of the lesson (Uzbek enum)." },
            lessonOrder: { type: "integer", minimum: 1, maximum: 100, description: "Period number of the lesson." },
          },
        },
      },
    },
  },
  async prepare(args, ctx) {
    const originalTeacherId = requireId(args.originalTeacherId, "Dars egasi id");
    const substituteTeacherId = requireId(args.substituteTeacherId, "O'rinbosar id");
    const note = cleanText(args.note);

    // Servisdagi YAGONA tekshiruv — yozishda ham aynan shu funksiya ishlaydi.
    const prepared = await asToolError(() =>
      substitutionService.prepareSubstitution({
        originalTeacherId,
        substituteTeacherId,
        fromDate: args.fromDate,
        toDate: args.toDate,
        reason: args.reason,
        note,
        lessons: args.lessons,
      }),
    );
    const { original, substitute, fromDate, toDate, reason, itemRows } = prepared;

    const [{ holidaySet, vacationSet }, substituteRoles, sealed] = await Promise.all([
      loadCalendar(fromDate, toDate),
      prisma.user.findUnique({ where: { id: substitute.id }, select: { role: true, extraRoles: true } }),
      sealedPayrollMonths(
        monthSegments(fromDate, toDate).map((segment) => segment.month),
        [original.id, substitute.id],
      ),
    ]);

    const originalName = personName(original);
    const substituteName = personName(substitute);
    const singleDay = fromDate.getTime() === toDate.getTime();
    const periodLabel = singleDay ? dayText(fromDate) : formatDateRangeUz(fromDate, toDate, { utc: true });
    const totalHours = substitutionService.countOccurrences(itemRows, fromDate, toDate, holidaySet, vacationSet);
    const byMonth = hoursByMonth(itemRows, fromDate, toDate, holidaySet, vacationSet);

    // Kataklar hafta kuni va tartib bo'yicha — jadvalni o'qigandek.
    const cells = itemRows
      .map((item) => {
        const dates = cellDates(item.day, fromDate, toDate, holidaySet, vacationSet);
        return {
          sort: SCHEDULE_DAYS.indexOf(item.day) * 1000 + item.lessonOrder,
          text:
            `${cellText({ day: item.day, lessonOrder: item.lessonOrder, ...item.snapshot })} — ` +
            (dates.length
              ? `${dates.length} marta: ${listText(dates.map(dayText), CELL_DATES_SHOWN)}`
              : "bu davrda bayram yoki ta'til sababli o'tilmaydi"),
        };
      })
      .sort((a, b) => a.sort - b.sort || a.text.localeCompare(b.text));

    const effects = [
      ...cells.map((cell) => cell.text),
      ...byMonth.map(
        (row) => `${monthLabel(row.month)}: ${row.hours} soat dars egasidan olinib, o'rinbosarga qo'shiladi`,
      ),
      "Shu darslar jurnali shu kunlarda o'rinbosarga ochiladi, dars egasiga yopiladi",
      "Dars jadvalining o'zi o'zgarmaydi",
    ];

    const warnings = [];
    if (isoOf(fromDate) < ctx.today) {
      warnings.push(
        `Davr ${dayText(fromDate)} dan boshlanadi — o'tgan kunlar uchun ham jurnal huquqi va dars soati o'rinbosarga o'tadi`,
      );
    } else if (isoOf(fromDate) === ctx.today) {
      warnings.push("Davr bugundan boshlanadi — bugungi darslar jurnali ham darhol o'rinbosarga o'tadi");
    }
    if (totalHours === 0) {
      warnings.push("Tanlangan davrda bu darslar bayram yoki ta'til sababli umuman o'tilmaydi — soat ko'chmaydi");
    }
    if (substituteRoles && !hasRole(substituteRoles, ROLES.TEACHER)) {
      warnings.push(`${substituteName} o'qituvchi rolida emas`);
    }
    const sealedWarning = sealedPayrollWarning(sealed, { perStaff: true });
    if (sealedWarning) warnings.push(sealedWarning);

    const reasonLabel = substitutionService.REASON_LABELS[reason];

    return {
      params: {
        originalTeacherId: original.id,
        substituteTeacherId: substitute.id,
        fromDate: isoOf(fromDate),
        toDate: isoOf(toDate),
        reason,
        note,
        // Takrorlar servisda jim tashlanadi — params allaqachon tozalangan ro'yxat.
        lessons: itemRows.map((item) => ({ classId: item.classId, day: item.day, lessonOrder: item.lessonOrder })),
      },
      preview: {
        summary:
          `${periodLabel}${singleDay ? " kuni" : " davomida"} ${originalName} o'rniga ${substituteName} ` +
          `${itemRows.length} ta darsga chiqadi (${totalHours} soat)`,
        target: `${originalName} (dars egasi) → ${substituteName} (o'rinbosar)`,
        fields: [
          { label: "Davr", before: "—", after: periodLabel },
          { label: "Sabab", before: "—", after: note ? `${reasonLabel}: ${note}` : reasonLabel },
          { label: "Darslar (haftalik katak)", before: "—", after: `${itemRows.length} ta` },
          { label: "Ko'chadigan dars soati", before: "—", after: `${totalHours} soat` },
        ],
        effects,
        warnings,
      },
    };
  },
  async execute(params, ctx) {
    // lessonSubstitution.controller.createSubstitution:
    //   substitutionService.createSubstitution(req.body, req.user.id)
    const created = await substitutionService.createSubstitution(
      {
        originalTeacherId: params.originalTeacherId,
        substituteTeacherId: params.substituteTeacherId,
        fromDate: params.fromDate,
        toDate: params.toDate,
        reason: params.reason,
        note: params.note,
        lessons: params.lessons,
      },
      ctx.user.id,
    );

    return {
      summary:
        `${created.substituteTeacherName} ${created.periodLabel} davomida ${created.originalTeacherName} o'rniga ` +
        `o'rinbosar etib biriktirildi: ${created.lessonCount} ta dars, ${created.occurrenceCount} soat`,
      details: [
        { label: "Davr", value: created.periodLabel },
        { label: "Sabab", value: created.reasonLabel },
        { label: "Darslar", value: `${created.lessonCount} ta` },
        { label: "Dars soati", value: `${created.occurrenceCount} soat` },
      ],
      data: { substitutionId: created.id },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 2. O'rinbosarlikni bekor qilish
// ─────────────────────────────────────────────────────────────────────────

const cancelSubstitution = defineAction({
  type: "substitutions.cancel",
  toolName: "propose_cancel_substitution",
  toolset: TOOLSET,
  title: "O'rinbosarlikni bekor qilish",
  risk: "high",
  permission: "substitutions.cancel",
  description:
    "Propose cancelling an active substitution (o'rinbosar) record in any phase (upcoming, ongoing or finished). The " +
    "record stays in history with the reason. Cancelling returns journal access and ALL lesson hours of the whole " +
    "window (including days already passed) to the original teacher; grades already written stay. Already generated " +
    "payroll is not recalculated. A reason is required. For a record that has not started yet, " +
    "propose_delete_upcoming_substitution removes it without leaving history. Get the id from substitutions_list.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["substitutionId", "reason"],
    properties: {
      substitutionId: idSchema("Substitution id."),
      reason: { type: "string", minLength: 1, maxLength: MAX_TEXT, description: "Why it is cancelled (stored on the record)." },
    },
  },
  async prepare(args, ctx) {
    const { id, row } = await loadSubstitution(args.substitutionId);
    if (row.status === "cancelled") throw new AiToolError("Bu o'rinbosarlik allaqachon bekor qilingan");
    const reason = cleanText(args.reason);
    if (!reason) throw new AiToolError("Bekor qilish sababi majburiy");

    const [{ live, stale }, { holidaySet, vacationSet }, sealed] = await Promise.all([
      splitStaleItems(row),
      loadCalendar(row.fromDate, row.toDate),
      sealedPayrollMonths(
        monthSegments(row.fromDate, row.toDate).map((segment) => segment.month),
        [row.originalTeacherId, row.substituteTeacherId],
      ),
    ]);

    const totalHours = substitutionService.countOccurrences(live, row.fromDate, row.toDate, holidaySet, vacationSet);
    const byMonth = hoursByMonth(live, row.fromDate, row.toDate, holidaySet, vacationSet);
    const started = row.phase.key !== "upcoming";
    const todayDate = parseDay(ctx.today, "Bugun");
    const pastHours = started
      ? substitutionService.countOccurrences(
          live,
          row.fromDate,
          row.toDate.getTime() < todayDate.getTime() ? row.toDate : todayDate,
          holidaySet,
          vacationSet,
        )
      : 0;

    const effects = [
      ...byMonth.map(
        (entry) => `${monthLabel(entry.month)}: ${entry.hours} soat o'rinbosardan olinib, dars egasiga qaytadi`,
      ),
      "O'rinbosarning bu darslar jurnaliga kirishi butun davr uchun yopiladi va dars egasiga qaytadi",
      "Yozuv o'chirilmaydi — bekor qilish sababi bilan tarixda qoladi",
    ];
    if (started) {
      effects.push(`O'tgan kunlar soati ham qaytadi: bugungacha ${pastHours} soat; qo'yilgan baholar o'chirilmaydi`);
    } else {
      effects.push("Yozuv hali boshlanmagan — uni tarixda qoldirmay butunlay o'chirish ham mumkin");
    }

    const warnings = [];
    if (row.phase.key === "finished") {
      warnings.push("Yakunlangan o'rinbosarlik bekor qilinmoqda — o'tgan davr soati dars egasiga qayta yoziladi");
    }
    if (stale.length > 0) {
      warnings.push(
        `${stale.length} ta dars jadvalda endi dars egasiga tegishli emas (jadval o'zgargan) — ` +
          "ular soat hisobiga baribir ta'sir qilmayotgan edi",
      );
    }
    const sealedWarning = sealedPayrollWarning(sealed, { perStaff: true });
    if (sealedWarning) warnings.push(sealedWarning);

    return {
      params: { substitutionId: id, reason },
      preview: {
        summary: `${row.originalTeacherName} o'rniga ${row.substituteTeacherName} chiqishi (${row.periodLabel}) bekor qilinadi`,
        target: substitutionTarget(row),
        fields: [
          { label: "Holat", before: `${row.statusLabel} (${row.phase.label.toLowerCase()})`, after: "Bekor qilingan" },
          { label: "Bekor qilish sababi", before: "—", after: reason },
          { label: "Darslar", before: `${row.lessonCount} ta`, after: "—" },
          { label: "Dars egasiga qaytadigan soat", before: "—", after: `${totalHours} soat` },
        ],
        effects,
        warnings,
      },
      fingerprint: {
        id,
        status: row.status,
        fromDate: isoOf(row.fromDate),
        toDate: isoOf(row.toDate),
        originalTeacherId: row.originalTeacherId,
        substituteTeacherId: row.substituteTeacherId,
        liveCells: live.map(cellKeyOf).sort(),
        staleCells: stale.map(cellKeyOf).sort(),
        byMonth,
        sealed,
        phase: row.phase.key,
        reason,
      },
    };
  },
  async execute(params, ctx) {
    // lessonSubstitution.controller.cancelSubstitution:
    //   substitutionService.cancelSubstitution(req.params.id, req.body.reason, req.user.id)
    const cancelled = await substitutionService.cancelSubstitution(params.substitutionId, params.reason, ctx.user.id);

    return {
      summary: `${cancelled.originalTeacherName} o'rniga ${cancelled.substituteTeacherName} chiqishi (${cancelled.periodLabel}) bekor qilindi`,
      details: [
        { label: "Sabab", value: cancelled.cancelReason },
        ...cancelled.warnings.map((warning) => ({ label: "Ogohlantirish", value: warning })),
      ],
      data: { substitutionId: cancelled.id, status: cancelled.status },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Boshlanmagan o'rinbosarlikni o'chirish
// ─────────────────────────────────────────────────────────────────────────

const deleteUpcomingSubstitution = defineAction({
  type: "substitutions.delete",
  toolName: "propose_delete_upcoming_substitution",
  toolset: TOOLSET,
  title: "Rejalashtirilgan o'rinbosarlikni o'chirish",
  risk: "low",
  permission: "substitutions.cancel",
  description:
    "Propose permanently deleting a substitution (o'rinbosar) record that has NOT started yet (its first day is after " +
    "today) — typically a plan entered by mistake. Nothing has happened under it yet, so no history is kept. Records " +
    "that already started (or are cancelled) cannot be deleted — use propose_cancel_substitution for those.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["substitutionId"],
    properties: {
      substitutionId: idSchema("Substitution id."),
    },
  },
  async prepare(args) {
    const { id, row } = await loadSubstitution(args.substitutionId);
    // Servisdagi YAGONA chegara: bekor qilingan yoki `fromDate <= bugun` → rad.
    await asToolError(async () => substitutionService.assertNotStarted(row, "o'chirish"));

    const { holidaySet, vacationSet } = await loadCalendar(row.fromDate, row.toDate);
    const [{ live }, sealed] = await Promise.all([
      splitStaleItems(row),
      sealedPayrollMonths(
        monthSegments(row.fromDate, row.toDate).map((segment) => segment.month),
        [row.originalTeacherId, row.substituteTeacherId],
      ),
    ]);
    const totalHours = substitutionService.countOccurrences(live, row.fromDate, row.toDate, holidaySet, vacationSet);

    const warnings = [];
    const sealedWarning = sealedPayrollWarning(sealed, { perStaff: true });
    if (sealedWarning) warnings.push(sealedWarning);

    return {
      params: { substitutionId: id },
      preview: {
        summary: `${row.originalTeacherName} o'rniga ${row.substituteTeacherName} chiqishi rejalashtirilgan yozuv (${row.periodLabel}) o'chiriladi`,
        target: substitutionTarget(row),
        fields: [
          { label: "Holat", before: row.phase.label, after: "O'chirilgan" },
          { label: "Darslar", before: `${row.lessonCount} ta`, after: "—" },
          { label: "Rejalashtirilgan dars soati", before: `${totalHours} soat`, after: "—" },
        ],
        effects: [
          ...row.items.map((item) => cellText(item)),
          "Yozuv butunlay o'chiriladi va tarixda qolmaydi — u hali kuchga kirmagan",
          `Rejalashtirilgan ${totalHours} soat dars egasida qoladi, jurnal huquqi o'zgarmaydi`,
        ],
        warnings,
      },
      fingerprint: {
        id,
        status: row.status,
        fromDate: isoOf(row.fromDate),
        toDate: isoOf(row.toDate),
        originalTeacherId: row.originalTeacherId,
        substituteTeacherId: row.substituteTeacherId,
        cells: row.items.map(cellKeyOf).sort(),
        totalHours,
        sealed,
      },
    };
  },
  async execute(params, ctx) {
    // lessonSubstitution.controller.deleteSubstitution:
    //   substitutionService.deleteSubstitution(req.params.id, req.user.id)
    const result = await substitutionService.deleteSubstitution(params.substitutionId, ctx.user.id);
    return {
      summary: result.message,
      data: { substitutionId: params.substitutionId },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// Dam olish kuni yordamchilari
// ─────────────────────────────────────────────────────────────────────────

/** Saqlangan qiymatni kunga keltiradi — `buildHolidaySet.dayOf` bilan bir xil. */
function dayStampOf(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

const isRecurringPoint = (point) => point && point.month !== undefined && point.month !== null;

/** Yil oshib ketadigan oyna ham (dekabr → yanvar) — `buildHolidaySet.inRecurringWindow` bilan bir xil. */
function inRecurringWindow(date, start, end) {
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  if (start.month > end.month) {
    return (
      month > start.month ||
      month < end.month ||
      (month === start.month && day >= start.day) ||
      (month === end.month && day <= end.day)
    );
  }
  const afterStart = month > start.month || (month === start.month && day >= start.day);
  const beforeEnd = month < end.month || (month === end.month && day <= end.day);
  return afterStart && beforeEnd;
}

/**
 * Bitta dam olish qoidasi oynaning qaysi kunlariga to'g'ri keladi.
 *
 * ⚠️ `holiday.service.buildHolidaySet` bilan AYNAN bir xil moslash qoidasi
 * (u faqat bazadagi faol yozuvlarni o'qiydi — hali YARATILMAGAN taklif yoki
 * boshqalardan AJRATILGAN bitta yozuv uchun uni chaqirib bo'lmaydi). Soat
 * hisobi `buildHolidaySet` dan olinadi, shuning uchun ikkalasi farq qilsa
 * ko'rinish haqiqatdan ajralib qolardi — o'zgartirsangiz, ikkalasini birga.
 * Takrorlanuvchida oy 0 DAN boshlanadi.
 *
 * @returns {Date[]} UTC yarim tun kunlari
 */
function holidayDates(holiday, fromDate, toDate) {
  const single = holiday.type === "single" ? dayStampOf(holiday.date) : null;
  const rangeStart = holiday.type === "range" ? dayStampOf(holiday.startDate) : null;
  const rangeEnd = holiday.type === "range" ? dayStampOf(holiday.endDate) : null;
  const point = holiday.recurringDate;
  const start = holiday.recurringStartDate;
  const end = holiday.recurringEndDate;

  const dates = [];
  for (let cursor = fromDate; cursor.getTime() <= toDate.getTime(); cursor = addDays(cursor, 1)) {
    const stamp = cursor.getTime();
    let match = false;
    if (holiday.type === "single") {
      match = single !== null && stamp === single;
    } else if (holiday.type === "range") {
      match = rangeStart !== null && rangeEnd !== null && stamp >= rangeStart && stamp <= rangeEnd;
    } else if (holiday.type === "recurring") {
      match =
        (isRecurringPoint(point) && point.month === cursor.getUTCMonth() && point.day === cursor.getUTCDate()) ||
        (isRecurringPoint(start) && isRecurringPoint(end) && inRecurringWindow(cursor, start, end));
    }
    if (match) dates.push(cursor);
  }
  return dates;
}

/**
 * Qoidaning ta'sir oynasi. Bir martalik yozuvda — o'z sanalari (chegarali);
 * takrorlanuvchida — joriy oy boshidan 12 oy: joriy oy hali muhrlanmagan
 * bo'lishi mumkin, keyingi takrorlanish esa bir yil ichida albatta keladi.
 */
function effectWindow(holiday, today) {
  if (holiday.type === "recurring") {
    const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const to = addDays(new Date(Date.UTC(today.getUTCFullYear() + 1, today.getUTCMonth(), 1)), -1);
    return { from, to, clipped: false };
  }
  const from = holiday.type === "single" ? dayStampOf(holiday.date) : dayStampOf(holiday.startDate);
  const to = holiday.type === "single" ? from : dayStampOf(holiday.endDate);
  if (from === null || to === null || to < from) return null;
  const clippedTo = Math.min(to, from + (MAX_EFFECT_WINDOW_DAYS - 1) * DAY_MS);
  return { from: new Date(from), to: new Date(clippedTo), clipped: clippedTo !== to };
}

const recurringText = (point) => `${point.day}-${MONTHS_UZ[point.month]}`;

/** Qoidaning o'qiladigan ko'rinishi: "1-sentabr, 2026", "Har yili 30-dekabr — 2-yanvar". */
function holidayRuleText(holiday) {
  if (holiday.type === "single") return formatDateUz(holiday.date, { utc: true });
  if (holiday.type === "range") return formatDateRangeUz(holiday.startDate, holiday.endDate, { utc: true });
  if (isRecurringPoint(holiday.recurringDate) && MONTHS_UZ[holiday.recurringDate.month]) {
    return `Har yili ${recurringText(holiday.recurringDate)}`;
  }
  const { recurringStartDate: start, recurringEndDate: end } = holiday;
  if (isRecurringPoint(start) && isRecurringPoint(end) && MONTHS_UZ[start.month] && MONTHS_UZ[end.month]) {
    return `Har yili ${recurringText(start)} — ${recurringText(end)}`;
  }
  return "—";
}

/** Bir xil qoida kaliti — aynan takror yozuvni topish uchun (vaqt komponenti kunga keltiriladi). */
function holidayRuleKey(holiday) {
  if (holiday.type === "single") return `single:${dayStampOf(holiday.date)}`;
  if (holiday.type === "range") return `range:${dayStampOf(holiday.startDate)}:${dayStampOf(holiday.endDate)}`;
  const point = holiday.recurringDate;
  if (isRecurringPoint(point)) return `recurring:${point.month}-${point.day}`;
  const { recurringStartDate: start, recurringEndDate: end } = holiday;
  if (isRecurringPoint(start) && isRecurringPoint(end)) {
    return `recurring:${start.month}-${start.day}:${end.month}-${end.day}`;
  }
  return `recurring:invalid`;
}

/**
 * Dam olish qoidasining ta'siri — yaratishda ham, o'chirib qo'yishda ham
 * bir xil hisob (faqat yo'nalishi teskari).
 *
 * @param {object} holiday - DB shaklidagi qoida (takrorlanuvchida oy 0 dan)
 * @param {object} options
 * @param {string|null} options.excludeId - boshqa faol yozuvlardan chiqariladigan yozuv (o'zi)
 * @param {Date} options.today
 */
async function holidayImpact(holiday, { excludeId = null, today }) {
  const window = effectWindow(holiday, today);
  const [allHolidays, vacationSet, lessons] = await Promise.all([
    prisma.holiday.findMany({ orderBy: { createdAt: "asc" } }),
    getVacationSet(),
    prisma.scheduleLesson.findMany({
      select: { teacherId: true, order: true, schedule: { select: { day: true, classId: true } } },
    }),
  ]);

  const others = allHolidays.filter((row) => row.id !== excludeId);
  const lessonsByDay = new Map();
  const owned = new Set();
  for (const lesson of lessons) {
    if (!lesson.schedule?.day) continue;
    lessonsByDay.set(lesson.schedule.day, (lessonsByDay.get(lesson.schedule.day) || 0) + 1);
    owned.add(`${lesson.teacherId}|${lesson.schedule.classId}|${lesson.schedule.day}|${lesson.order}`);
  }

  if (!window) {
    return {
      window: null,
      others,
      dates: [],
      coveredByOthers: [],
      coveringNames: [],
      vacationDates: [],
      sundayCount: 0,
      schoolDates: [],
      lessonHours: 0,
      sealed: [],
      substitutions: { records: 0, hours: 0 },
      lessonsByDay: [...lessonsByDay.entries()].sort(),
    };
  }

  const dates = holidayDates(holiday, window.from, window.to);

  // Boshqa FAOL yozuv allaqachon qoplagan kun — bu yozuv u kunni o'zgartirmaydi.
  const covering = new Map();
  for (const other of others) {
    if (!other.isActive) continue;
    for (const date of holidayDates(other, window.from, window.to)) {
      if (!covering.has(date.getTime())) covering.set(date.getTime(), other.name);
    }
  }

  const coveredByOthers = dates.filter((date) => covering.has(date.getTime()));
  const effective = dates.filter((date) => !covering.has(date.getTime()));
  const vacationDates = effective.filter((date) => vacationSet.has(monthKeyOfDate(date)));
  const sundayCount = effective.filter((date) => date.getUTCDay() === 0).length;
  const schoolDates = effective.filter(
    (date) => date.getUTCDay() !== 0 && !vacationSet.has(monthKeyOfDate(date)),
  );

  const lessonHours = schoolDates.reduce((sum, date) => sum + (lessonsByDay.get(DAYS_UZ[date.getUTCDay()]) || 0), 0);

  let sealed = [];
  let substitutions = { records: 0, hours: 0 };
  if (schoolDates.length > 0) {
    const first = schoolDates[0];
    const last = schoolDates[schoolDates.length - 1];
    const schoolSet = new Set(schoolDates.map((date) => date.getTime()));
    const [sealedRows, activeSubstitutions] = await Promise.all([
      sealedPayrollMonths(schoolDates.map(monthKeyOfDate)),
      prisma.lessonSubstitution.findMany({
        where: { status: "active", fromDate: { lte: last }, toDate: { gte: first } },
        select: {
          originalTeacherId: true,
          fromDate: true,
          toDate: true,
          items: { select: { classId: true, day: true, lessonOrder: true } },
        },
      }),
    ]);
    sealed = sealedRows;

    // Eskirgan katak (jadvalda egasi o'zgargan) soatga baribir ta'sir qilmaydi — sanalmaydi.
    const affected = new Set();
    for (const [index, row] of activeSubstitutions.entries()) {
      const liveItems = row.items.filter((item) => owned.has(`${row.originalTeacherId}|${cellKeyOf(item)}`));
      for (const stamp of schoolSet) {
        if (stamp < row.fromDate.getTime() || stamp > row.toDate.getTime()) continue;
        const day = DAYS_UZ[new Date(stamp).getUTCDay()];
        const hours = liveItems.filter((item) => item.day === day).length;
        if (hours === 0) continue;
        substitutions.hours += hours;
        affected.add(index);
      }
    }
    substitutions = { records: affected.size, hours: substitutions.hours };
  }

  return {
    window,
    others,
    dates,
    coveredByOthers,
    coveringNames: [...new Set(coveredByOthers.map((date) => covering.get(date.getTime())))],
    vacationDates,
    sundayCount,
    schoolDates,
    lessonHours,
    sealed,
    substitutions,
    lessonsByDay: [...lessonsByDay.entries()].sort(),
  };
}

/** Ta'sir oynasining izohi (takrorlanuvchi yoki kesilgan oraliq uchun). */
function windowNote(holiday, impact) {
  if (!impact.window) return null;
  if (holiday.type === "recurring") {
    return `Qoida har yili takrorlanadi; quyidagi hisob ${formatDateRangeUz(impact.window.from, impact.window.to, { utc: true })} oralig'i uchun`;
  }
  if (impact.window.clipped) {
    return `Oraliq juda uzun — hisob faqat birinchi ${MAX_EFFECT_WINDOW_DAYS} kun uchun`;
  }
  return null;
}

/** Ta'sir fingerprinti — tartiblangan va vaqtga bog'liq bo'lmagan. */
const impactFingerprint = (impact) => ({
  dates: impact.dates.map(isoOf),
  schoolDates: impact.schoolDates.map(isoOf),
  coveredByOthers: impact.coveredByOthers.map(isoOf),
  lessonHours: impact.lessonHours,
  sealed: impact.sealed,
  substitutions: impact.substitutions,
  lessonsByDay: impact.lessonsByDay,
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Dam olish kuni qo'shish
// ─────────────────────────────────────────────────────────────────────────

/**
 * Takrorlanuvchi nuqta: model oyni 1..12 da beradi (odam shunday aytadi),
 * bazada esa 0 dan (`getUTCMonth()` bilan solishtiriladi).
 */
function recurringPointArg(monthArg, dayArg, label) {
  if (monthArg === undefined || dayArg === undefined) {
    throw new AiToolError(`${label}: oy va kun ikkalasi ham kerak`);
  }
  // 29-fevral kabi sana kabisa yilida mavjud — shuning uchun kabisa yili bilan tekshiriladi.
  const maxDay = daysInMonth(2024 * 100 + monthArg);
  if (dayArg > maxDay) {
    throw new AiToolError(`${label}: ${MONTHS_UZ[monthArg - 1]} oyida ${maxDay} kundan ortiq yo'q`);
  }
  return { month: monthArg - 1, day: dayArg };
}

/** Faqat tanlangan turga tegishli maydonlar berilganini tekshiradi — aralash kiritma jimgina e'tiborsiz qolmasin. */
function assertOnlyFields(args, allowed, type) {
  const typeFields = [
    "date",
    "startDate",
    "endDate",
    "recurringMonth",
    "recurringDay",
    "recurringStartMonth",
    "recurringStartDay",
    "recurringEndMonth",
    "recurringEndDay",
  ];
  const extra = typeFields.filter((key) => args[key] !== undefined && !allowed.includes(key));
  if (extra.length > 0) {
    throw new AiToolError(`"${HOLIDAY_TYPE_LABELS[type]}" turi uchun ortiqcha maydon berildi: ${extra.join(", ")}`);
  }
}

/** Model argumentlari → `createHoliday` kutgan AYNI tana (admin `HolidayForm` yuboradigan shakl). */
function buildHolidayBody(args) {
  const name = cleanText(args.name);
  if (name.length < 2) throw new AiToolError("Dam olish kuni nomi kamida 2 belgi bo'lsin");
  const body = { name, description: cleanText(args.description), type: args.type, isActive: true };

  if (args.type === "single") {
    assertOnlyFields(args, ["date"], args.type);
    if (!args.date) throw new AiToolError("Bir kunlik dam olish uchun sana (date) majburiy");
    body.date = isoOf(parseDay(args.date, "Sana"));
    return body;
  }

  if (args.type === "range") {
    assertOnlyFields(args, ["startDate", "endDate"], args.type);
    if (!args.startDate || !args.endDate) {
      throw new AiToolError("Sana oralig'i uchun boshlanish (startDate) va tugash (endDate) sanasi majburiy");
    }
    const start = parseDay(args.startDate, "Boshlanish sanasi");
    const end = parseDay(args.endDate, "Tugash sanasi");
    if (end.getTime() < start.getTime()) {
      throw new AiToolError("Tugash sanasi boshlanish sanasidan oldin bo'lishi mumkin emas");
    }
    const spanDays = Math.round((end - start) / DAY_MS) + 1;
    if (spanDays > MAX_HOLIDAY_RANGE_DAYS) {
      throw new AiToolError(`Dam olish oralig'i ${MAX_HOLIDAY_RANGE_DAYS} kundan oshmasin — sanalarni tekshiring`);
    }
    body.startDate = isoOf(start);
    body.endDate = isoOf(end);
    return body;
  }

  assertOnlyFields(
    args,
    ["recurringMonth", "recurringDay", "recurringStartMonth", "recurringStartDay", "recurringEndMonth", "recurringEndDay"],
    args.type,
  );
  const single = args.recurringMonth !== undefined || args.recurringDay !== undefined;
  const range = ["recurringStartMonth", "recurringStartDay", "recurringEndMonth", "recurringEndDay"].some(
    (key) => args[key] !== undefined,
  );
  if (single && range) {
    throw new AiToolError("Takrorlanuvchi dam olish uchun yoki bitta kun, yoki oraliq beriladi — ikkalasi emas");
  }
  if (single) {
    body.recurringDate = recurringPointArg(args.recurringMonth, args.recurringDay, "Takrorlanuvchi sana");
    return body;
  }
  if (range) {
    body.recurringStartDate = recurringPointArg(args.recurringStartMonth, args.recurringStartDay, "Boshlanish");
    body.recurringEndDate = recurringPointArg(args.recurringEndMonth, args.recurringEndDay, "Tugash");
    if (
      body.recurringStartDate.month === body.recurringEndDate.month &&
      body.recurringStartDate.day === body.recurringEndDate.day
    ) {
      throw new AiToolError("Boshlanish va tugash bir kun — bitta kun uchun recurringMonth va recurringDay bering");
    }
    return body;
  }
  throw new AiToolError(
    "Takrorlanuvchi dam olish uchun recurringMonth + recurringDay yoki boshlanish/tugash oy va kunini bering",
  );
}

/** Tana → hisob uchun DB shakli (sanalar UTC yarim tun). */
const bodyAsHoliday = (body) => ({
  type: body.type,
  date: body.date ? parseDayDate(body.date) : null,
  startDate: body.startDate ? parseDayDate(body.startDate) : null,
  endDate: body.endDate ? parseDayDate(body.endDate) : null,
  recurringDate: body.recurringDate ?? null,
  recurringStartDate: body.recurringStartDate ?? null,
  recurringEndDate: body.recurringEndDate ?? null,
});

const createHoliday = defineAction({
  type: "holidays.create",
  toolName: "propose_create_holiday",
  toolset: TOOLSET,
  title: "Dam olish kuni qo'shish",
  risk: "high",
  permission: "holidays.create",
  description:
    "Propose adding a school-wide holiday (dam olish kuni) for the current branch: a single day (type single + date), " +
    "an inclusive date range (type range + startDate/endDate, max 366 days), or a yearly recurring day or range (type " +
    "recurring + recurringMonth/recurringDay, or recurringStartMonth/StartDay + recurringEndMonth/EndDay; months are " +
    "1-12, January = 1; a range may wrap the year, e.g. December 30 to January 2). On holiday dates no lessons are " +
    "counted in teachers' lesson hours, staff and students are not auto-marked absent, and no missing-grade penalties " +
    "are given. Refuses exact duplicates and dates already fully covered by another active holiday. Check holidays_list first.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name", "type"],
    properties: {
      name: { type: "string", minLength: 2, maxLength: MAX_NAME, description: "Holiday name, e.g. Mustaqillik kuni." },
      description: { type: "string", maxLength: MAX_TEXT, description: "Optional description." },
      type: { type: "string", enum: Object.keys(HOLIDAY_TYPE_LABELS), description: "single, range or recurring." },
      date: daySchema("type single: the day YYYY-MM-DD."),
      startDate: daySchema("type range: first day YYYY-MM-DD (inclusive)."),
      endDate: daySchema("type range: last day YYYY-MM-DD (inclusive)."),
      recurringMonth: { type: "integer", minimum: 1, maximum: 12, description: "type recurring, one day: month 1-12." },
      recurringDay: { type: "integer", minimum: 1, maximum: 31, description: "type recurring, one day: day of month." },
      recurringStartMonth: { type: "integer", minimum: 1, maximum: 12, description: "type recurring range: start month 1-12." },
      recurringStartDay: { type: "integer", minimum: 1, maximum: 31, description: "type recurring range: start day." },
      recurringEndMonth: { type: "integer", minimum: 1, maximum: 12, description: "type recurring range: end month 1-12." },
      recurringEndDay: { type: "integer", minimum: 1, maximum: 31, description: "type recurring range: end day." },
    },
  },
  async prepare(args, ctx) {
    const body = buildHolidayBody(args);
    const rule = bodyAsHoliday(body);
    const today = parseDay(ctx.today, "Bugun");
    const impact = await holidayImpact(rule, { today });

    const ruleText = holidayRuleText(rule);
    const ruleKey = holidayRuleKey(rule);
    const duplicates = impact.others.filter((row) => row.type === rule.type && holidayRuleKey(row) === ruleKey);
    const activeDuplicate = duplicates.find((row) => row.isActive);
    if (activeDuplicate) {
      throw new AiToolError(`Aynan shu dam olish kuni allaqachon bor: "${activeDuplicate.name}" (${ruleText})`);
    }
    // ⚠️ Takrorlanuvchi qoida hisob oynasidan tashqaridagi YILLARGA ham tegishli:
    // oynadagi yagona sanasini bir martalik yozuv qoplagani uni ortiqcha qilmaydi.
    // U faqat boshqa TAKRORLANUVCHI faol yozuv barcha sanalarini qoplasa rad etiladi.
    const blockers =
      rule.type === "recurring"
        ? impact.others.filter((other) => other.isActive && other.type === "recurring")
        : impact.others.filter((other) => other.isActive);
    const blockerNames = new Set();
    const fullyCovered =
      impact.dates.length > 0 &&
      impact.dates.every((date) => {
        const cover = blockers.find((other) => holidayDates(other, date, date).length > 0);
        if (cover) blockerNames.add(cover.name);
        return Boolean(cover);
      });
    if (fullyCovered) {
      throw new AiToolError(
        `Bu kunlarning barchasi allaqachon dam olish kuni: ${[...blockerNames].map((name) => `"${name}"`).join(", ")}`,
      );
    }

    const effects = [];
    const note = windowNote(rule, impact);
    if (note) effects.push(note);
    if (impact.schoolDates.length > 0) {
      effects.push(
        `${impact.schoolDates.length} ta o'quv kuni dam olish kuniga aylanadi: ${listText(impact.schoolDates.map(dayText), HOLIDAY_DATES_SHOWN)}`,
      );
      effects.push(
        impact.lessonHours > 0
          ? `Dars jadvali bo'yicha ${impact.lessonHours} ta dars soati o'tilmaydi — o'qituvchilarning oylik dars soati shunchaga kamayadi`
          : "Bu hafta kunlarida dars jadvalida dars yo'q — dars soatiga ta'sir qilmaydi",
      );
      effects.push("Bu kunlarda xodim va o'quvchilar avtomatik \"kelmadi\" deb belgilanmaydi, baho qo'yilmagani uchun jarima yozilmaydi");
    }
    if (impact.sundayCount > 0) effects.push(`${impact.sundayCount} ta sana yakshanbaga to'g'ri keladi — u kunlar baribir dars kuni emas`);
    if (impact.substitutions.records > 0) {
      effects.push(
        `${impact.substitutions.records} ta amaldagi o'rinbosarlikda ${impact.substitutions.hours} soat kamayadi`,
      );
    }

    const warnings = [];
    if (!impact.window || impact.dates.length === 0) {
      warnings.push("Qoida hisob oralig'ida birorta kunga to'g'ri kelmaydi (masalan, kabisa bo'lmagan yildagi 29-fevral)");
    }
    if (duplicates.length > 0) {
      warnings.push(`Xuddi shu qoidali nofaol yozuv bor: "${duplicates[0].name}" — yangisini qo'shish o'rniga uni faollashtirish mumkin`);
    }
    if (impact.coveredByOthers.length > 0) {
      warnings.push(
        `${impact.coveredByOthers.length} ta sana allaqachon boshqa dam olish kunida (${impact.coveringNames.join(", ")}) — ular uchun o'zgarish yo'q`,
      );
    }
    if (impact.vacationDates.length > 0) {
      warnings.push(`${impact.vacationDates.length} ta sana ta'til oyiga to'g'ri keladi — ular uchun o'zgarish yo'q`);
    }
    const pastDates = impact.schoolDates.filter((date) => isoOf(date) <= ctx.today);
    if (pastDates.length > 0) {
      warnings.push(
        `${pastDates.length} ta kun bugun yoki o'tgan kun: o'sha kunlarga avtomatik yozilgan "kelmadi" belgilari va jarimalar bekor qilinmaydi`,
      );
    }
    if (rule.type === "recurring") {
      warnings.push("Takrorlanuvchi qoida o'tgan yillarga ham tegishli: o'tgan oylar dars soati jonli hisobotlarda qayta hisoblanadi");
    }
    if (rule.type === "range" && Math.round((rule.endDate - rule.startDate) / DAY_MS) + 1 > LONG_HOLIDAY_RANGE_DAYS) {
      warnings.push("Bir oydan uzun tanaffus uchun ta'til oyi (moliya sozlamalari) belgilash to'g'riroq");
    }
    const sealedWarning = sealedPayrollWarning(impact.sealed);
    if (sealedWarning) warnings.push(sealedWarning);

    const fields = [
      { label: "Nomi", before: "—", after: body.name },
      { label: "Turi", before: "—", after: HOLIDAY_TYPE_LABELS[body.type] },
      { label: "Sana", before: "—", after: ruleText },
    ];
    if (body.description) fields.push({ label: "Tavsif", before: "—", after: body.description });
    fields.push({ label: "Holat", before: "—", after: "Faol" });

    return {
      params: body,
      preview: {
        summary: `"${body.name}" dam olish kuni qo'shiladi: ${ruleText}`,
        target: `Butun filial — ${ctx.branch?.name || "joriy filial"}`,
        fields,
        effects,
        warnings,
      },
      fingerprint: {
        body,
        impact: impactFingerprint(impact),
        duplicates: duplicates.map((row) => row.id).sort(),
        pastDates: pastDates.map(isoOf),
      },
    };
  },
  async execute(params, ctx) {
    // holiday.controller.createHoliday: holidayService.createHoliday(req.body, req.user.id)
    const holiday = await holidayService.createHoliday(params, ctx.user.id);
    return {
      summary: `"${holiday.name}" dam olish kuni qo'shildi: ${holidayRuleText(holiday)}`,
      details: [
        { label: "Turi", value: HOLIDAY_TYPE_LABELS[holiday.type] },
        { label: "Sana", value: holidayRuleText(holiday) },
      ],
      data: { holidayId: holiday.id },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Dam olish kunini o'chirib qo'yish (nofaol)
// ─────────────────────────────────────────────────────────────────────────

const deactivateHoliday = defineAction({
  type: "holidays.deactivate",
  toolName: "propose_deactivate_holiday",
  toolset: TOOLSET,
  title: "Dam olish kunini o'chirib qo'yish",
  risk: "high",
  permission: "holidays.update",
  description:
    "Propose turning off (deactivating) an active holiday (dam olish kuni). The record is kept and can be switched on " +
    "again from the holidays page; it is not deleted. Its dates become normal school days again: lesson hours return " +
    "to teachers, and on future dates absence auto-marking and missing-grade penalties apply again. Get the id from holidays_list.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["holidayId"],
    properties: {
      holidayId: idSchema("Holiday id from holidays_list."),
    },
  },
  async prepare(args, ctx) {
    const holidayId = requireId(args.holidayId, "Dam olish kuni id");
    const holiday = await prisma.holiday.findUnique({ where: { id: holidayId } });
    if (!holiday) throw new AiToolError("Dam olish kuni topilmadi");
    if (!holiday.isActive) throw new AiToolError(`"${holiday.name}" allaqachon nofaol`);

    const today = parseDay(ctx.today, "Bugun");
    const impact = await holidayImpact(holiday, { excludeId: holiday.id, today });
    const ruleText = holidayRuleText(holiday);

    const effects = ["Yozuv o'chirilmaydi — kerak bo'lsa dam olish kunlari sahifasida qayta yoqish mumkin"];
    const note = windowNote(holiday, impact);
    if (note) effects.push(note);

    const futureDates = impact.schoolDates.filter((date) => isoOf(date) > ctx.today);
    const pastDates = impact.schoolDates.filter((date) => isoOf(date) <= ctx.today);

    if (impact.schoolDates.length > 0) {
      effects.push(
        `${impact.schoolDates.length} ta kun yana o'quv kuni hisoblanadi: ${listText(impact.schoolDates.map(dayText), HOLIDAY_DATES_SHOWN)}`,
      );
      if (impact.lessonHours > 0) {
        effects.push(`Dars jadvali bo'yicha ${impact.lessonHours} ta dars soati o'qituvchilarga qaytadi`);
      }
      if (futureDates.length > 0) {
        effects.push(
          `Kelgusi ${futureDates.length} ta kunda davomat avtomatik belgilanadi va baho qo'yilmasa jarima yoziladi`,
        );
      }
    } else {
      effects.push("Bu yozuv hozir hech bir o'quv kuniga ta'sir qilmayapti — faqat ro'yxatdagi holati o'zgaradi");
    }
    if (impact.substitutions.records > 0) {
      effects.push(`${impact.substitutions.records} ta amaldagi o'rinbosarlikka ${impact.substitutions.hours} soat qo'shiladi`);
    }

    const warnings = [];
    if (pastDates.length > 0) {
      warnings.push(
        `${pastDates.length} ta kun bugun yoki o'tgan kun: u kunlar uchun davomat va jarimalar avtomatik yozilmaydi, lekin dars soati jonli hisobda qaytadi`,
      );
    }
    if (impact.coveredByOthers.length > 0) {
      warnings.push(
        `${impact.coveredByOthers.length} ta sana boshqa faol dam olish kunida ham bor (${impact.coveringNames.join(", ")}) — ular dam olish kuni bo'lib qoladi`,
      );
    }
    if (!impact.window || impact.dates.length === 0) {
      warnings.push("Yozuvning sanalari noto'g'ri yoki to'liq emas — u hech bir kunga to'g'ri kelmayapti");
    }
    if (holiday.type === "recurring") {
      warnings.push("Takrorlanuvchi qoida o'tgan yillarga ham tegishli edi: o'tgan oylar dars soati jonli hisobotlarda qayta hisoblanadi");
    }
    const sealedWarning = sealedPayrollWarning(impact.sealed);
    if (sealedWarning) warnings.push(sealedWarning);

    return {
      params: { holidayId },
      preview: {
        summary: `"${holiday.name}" dam olish kuni o'chirib qo'yiladi: ${ruleText}`,
        target: `Butun filial — ${ctx.branch?.name || "joriy filial"}`,
        fields: [
          { label: "Holat", before: "Faol", after: "Nofaol" },
          { label: HOLIDAY_TYPE_LABELS[holiday.type] || "Sana", before: ruleText, after: ruleText },
        ],
        effects,
        warnings,
      },
      fingerprint: {
        holidayId,
        isActive: holiday.isActive,
        updatedAt: holiday.updatedAt.toISOString(),
        impact: impactFingerprint(impact),
        pastDates: pastDates.map(isoOf),
      },
    };
  },
  async execute(params) {
    // holiday.controller.updateHoliday: holidayService.updateHoliday(req.params.id, req.body)
    // — admin panel "Aktiv" belgisini o'chirganda tanadagi amaldagi o'zgarish `isActive: false`.
    const holiday = await holidayService.updateHoliday(params.holidayId, { isActive: false });
    return {
      summary: `"${holiday.name}" dam olish kuni o'chirib qo'yildi (${holidayRuleText(holiday)})`,
      data: { holidayId: holiday.id, isActive: holiday.isActive },
    };
  },
});

module.exports = [createSubstitution, cancelSubstitution, deleteUpcomingSubstitution, createHoliday, deactivateHoliday];
