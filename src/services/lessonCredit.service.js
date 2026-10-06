/**
 * O'TILMAGAN DARSNI "O'TILDI" DEB BELGILASH (`LessonCredit`).
 *
 * Dars jadvali — REJA, pul esa FAKTGA to'lanadi: o'qituvchi kelmagan yoki
 * hech kimga baho qo'yilmagan dars o'tilmagan hisoblanadi va uning soati
 * (puli) oylikka yozilmaydi (`helpers/lessonHours.js` → `judgeLesson`).
 * Lekin fakt har doim ham haqiqat emas: platforma ishlamay qolgan, baho
 * boshqa joyda qo'yilgan, davomat xato belgilangan. Shunda boshliq
 * (`lessonCredits.manage`, owner'da doim bor) darsni "o'tildi" qiladi:
 *
 *   · bittalab yoki bir nechtalab — tanlangan darslar;
 *   · kunning HAMMA o'tilmagan darslari — kun tanlanadi, hamma o'qituvchi
 *     (yoki tanlangan o'qituvchilar) bir amalda.
 *
 * Belgilangan dars soat hisobida O'TILGAN (`resolveLesson`): soati jonli
 * hisobga, vedomostga, o'qituvchi paneliga va hali shakllanmagan oylikka
 * darhol qaytadi — "o'tilmagan darslar uchun ayrilgan" summa yo'qoladi.
 *
 * ⚠️ FAQAT O'TGAN KUNLAR. Bugungi dars hali tekshirilmaydi (`judgedThroughDay`)
 * — u ertasiga yakuniy baholanadi; kelajakdagi dars esa umuman o'tilmagan.
 *
 * ⚠️ SERVER RO'YXATNI O'ZI QAYTA HISOBLAYDI. Panel yuborgan darslar faqat
 * TANLOV: yozishdan oldin kunning o'tilmagan darslari soat hisobining
 * O'ZIDAN qayta olinadi va faqat haqiqatan o'tilmagan dars belgilanadi.
 * Aks holda eskirgan ekran (shu orada baho qo'yilgan dars) yoki qo'lda
 * yasalgan so'rov o'tilgan darsga ham belgi yozardi.
 *
 * ⚠️ MUHRLANGAN OYLIK O'ZI O'ZGARMAYDI (`finance.md` §10): yopilgan oyning
 * soatbay oyligi muhrlangan, avtomat passlar uning dars soatiga tegmaydi.
 * Shunday oylik javobda qaytadi (`sealed`) va "Qayta hisoblash" bilan
 * (`payrollRecalc.service.js`, o'z ruxsati bilan) yangilanadi. Belgilash
 * huquqi to'langan oylik summasini o'zgartirish huquqiga aylanmasligi uchun
 * bu ataylab avtomat emas.
 *
 * ⚠️ DARS O'TILGAN KUN — KELGAN KUN (biznes qarori): kunning birorta darsi
 * belgilansa, o'qituvchining shu kungi davomati "keldi" bo'ladi
 * (`markDaysPresent`) — kelmagan kun ayirmasi (fiksadan) va "kelmadi"
 * jarimasi yo'qoladi. Belgi bekor qilinsa, davomat AYNAN qaytadi.
 *
 * ⚠️ "BAHO QO'YMASLIK" JARIMASI — ixtiyoriy (`cancelGradePenalty`). Kechki
 * cron shu dars uchun yozgan jarima (`gradePenalty.job.js`) bekor qilinadi
 * (`rejected` + sabab) va o'qituvchidan ball olib tashlanadi; belgi bekor
 * qilinsa — aynan qaytariladi.
 *
 * ⚠️ O'CHIRILMAYDI — BEKOR QILINADI (sabab + aktyor). Har amal oylik audit
 * tarixiga yoziladi (`lesson.credit` / `lesson.uncredit`).
 */

const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const { ROLES, DAYS_UZ } = require("../utils/constants");
const { BadRequestError, ConflictError } = require("../utils/errors");
const { generateId } = require("../utils/idGenerator");
const {
  currentDayDate,
  currentMonthKey,
  parseDayDate,
  parseMonthKey,
  monthKeyOfDate,
  monthStartDate,
  monthEndDate,
  formatMonthKey,
} = require("../helpers/month.helpers");
const { formatDateUz, formatDateTimeUz } = require("../helpers/date.helpers");
const { dayKey, lessonCreditKey, LESSON_MISS_REASONS } = require("../helpers/lessonHours");
const { gradePenaltyTitle } = require("../helpers/gradePenalty.helpers");
const { Decimal, formatAmount } = require("../helpers/money.helpers");
const { getTeachersHours } = require("./lessonHours.service");
const { loadContext, computeForStaff, toEngineHours } = require("./payrollEngine.service");
const { resolveSalariesForMonth } = require("./staffSalary.service");
const { PAYROLL_USER_SELECT, STATUS_LABELS: ENTRY_STATUS_LABELS } = require("./payroll.service");
const { resyncAfterAttendanceChange } = require("./payrollAbsence.service");
const payrollAudit = require("./payrollAudit.service");

const REASON_MAX = 200;
/** Bir amalda ko'pi bilan — maktab kattaligidagi bitta kun bemalol sig'adi. */
const MAX_LESSONS = 500;
const MAX_REVOKE = 500;
const MAX_LESSON_ORDER = 30;
const MODES = ["lessons", "day"];
const STATUSES = ["active", "revoked"];
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;
/** Davomatda "kelmagan" holatlar — dars o'tilgan kuni "keldi" ga aylanadi. */
const ABSENT_STATUSES = ["absent", "excused"];
// Bir necha yuz darsda har biriga jarima tekshiruvi — standart 5 soniya yetmasligi mumkin
const TX_OPTIONS = { timeout: 30000, maxWait: 10000 };

const fullName = (person) =>
  person ? `${person.firstName ?? ""} ${person.lastName ?? ""}`.trim() || "Noma'lum" : "Noma'lum";

/* ─────────────────────── Kirish tekshiruvlari ─────────────────────── */

/**
 * Belgilanadigan kun — faqat O'TGAN kun (`@db.Date`, UTC yarim tuni).
 *
 * @param {string} value - "YYYY-MM-DD"
 * @returns {Date}
 */
const parseCreditDay = (value) => {
  const day = parseDayDate(value, "Kun");
  if (day >= currentDayDate()) {
    throw new BadRequestError(
      "Faqat o'tgan kunni tanlang — bugungi darslar ertaga tekshiriladi",
    );
  }
  return day;
};

/** Sabab — majburiy: bu pul qarori va oylik tarixida "nega" deb so'raladi. */
const parseReason = (value, label = "Sabab") => {
  const reason = typeof value === "string" ? value.trim() : "";
  if (!reason) throw new BadRequestError(`${label} majburiy`);
  if (reason.length > REASON_MAX) {
    throw new BadRequestError(`${label} ${REASON_MAX} belgidan oshmasin`);
  }
  return reason;
};

/** Ixtiyoriy o'qituvchilar ro'yxati (kun rejimida filtr). */
const parseTeacherIds = (value) => {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new BadRequestError("O'qituvchilar ro'yxati noto'g'ri");
  const ids = [...new Set(value.map((id) => String(id).trim()).filter(Boolean))];
  if (ids.length === 0) return null;
  if (ids.length > MAX_LESSONS) throw new BadRequestError("O'qituvchilar ro'yxati juda uzun");
  if (ids.some((id) => !OBJECT_ID_RE.test(id))) {
    throw new BadRequestError("O'qituvchi identifikatori noto'g'ri");
  }
  return ids;
};

/**
 * Tanlangan darslar — har biri: kim + sinf + fan + tartib. Takrorlar
 * birlashtiriladi (ikki marta belgilangan katakcha bitta dars).
 *
 * @returns {Array<{teacherId, classId, subjectId, lessonOrder}>}
 */
const parseLessons = (value) => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestError("Kamida bitta darsni tanlang");
  }
  if (value.length > MAX_LESSONS) {
    throw new BadRequestError(`Bir amalda ko'pi bilan ${MAX_LESSONS} ta dars belgilanadi`);
  }

  const unique = new Map();
  for (const item of value) {
    const teacherId = String(item?.teacherId ?? "").trim();
    const classId = String(item?.classId ?? "").trim();
    const subjectId = String(item?.subjectId ?? "").trim();
    const lessonOrder = Number(item?.lessonOrder);

    if (![teacherId, classId, subjectId].every((id) => OBJECT_ID_RE.test(id))) {
      throw new BadRequestError("Dars ma'lumoti noto'g'ri");
    }
    if (!Number.isInteger(lessonOrder) || lessonOrder < 1 || lessonOrder > MAX_LESSON_ORDER) {
      throw new BadRequestError("Dars tartib raqami noto'g'ri");
    }

    unique.set(`${teacherId}|${classId}|${subjectId}|${lessonOrder}`, {
      teacherId,
      classId,
      subjectId,
      lessonOrder,
    });
  }
  return [...unique.values()];
};

/* ─────────────────────── Kunning o'tilmagan darslari ─────────────────────── */

/**
 * KUNNING O'TILMAGAN DARSLARI — soat hisobining O'ZIDAN (`getTeachersHours`
 * → `missedLessons`). Ekrandagi ro'yxat, belgilash tekshiruvi va oylik
 * bitta qoidadan o'qiydi: ikkinchi "o'tildimi" hisoblagichi yozilmaydi.
 *
 * Kimlar: shu hafta kunida darsi bor va shu kuni o'rinbosar bo'lgan,
 * arxivlanmagan xodimlar. Bayram, yakshanba va ta'til oyida dars yo'q —
 * ro'yxat bo'sh.
 *
 * @param {Date} day - UTC yarim tuni
 * @param {object} [options]
 * @param {string[]|null} [options.teacherIds] - faqat shu o'qituvchilar
 * @param {boolean} [options.withRates] - soat narxini ham hisoblash (ekran uchun)
 * @returns {Promise<{ month: number, key: string, teachers: Array<{
 *   user: object, lessons: Array<object>, rate: Decimal|null }> }>}
 */
async function collectDayMissed(day, { teacherIds = null, withRates = false } = {}) {
  const month = monthKeyOfDate(day);
  const key = dayKey(day);
  const empty = { month, key, teachers: [] };

  // Yakshanba `ScheduleDay` enumida yo'q — darsi ham yo'q
  const weekday = DAYS_UZ[day.getUTCDay()];
  if (day.getUTCDay() === 0 || !weekday) return empty;

  const filter = teacherIds ? { in: teacherIds } : undefined;

  const [lessonRows, substitutionRows] = await Promise.all([
    prisma.scheduleLesson.findMany({
      where: { schedule: { day: weekday }, ...(filter ? { teacherId: filter } : {}) },
      distinct: ["teacherId"],
      select: { teacherId: true },
    }),
    prisma.lessonSubstitution.findMany({
      where: {
        status: "active",
        fromDate: { lte: day },
        toDate: { gte: day },
        ...(filter ? { substituteTeacherId: filter } : {}),
      },
      select: { substituteTeacherId: true },
    }),
  ]);

  const ids = [
    ...new Set([
      ...lessonRows.map((row) => row.teacherId),
      ...substitutionRows.map((row) => row.substituteTeacherId),
    ]),
  ].filter(Boolean);
  if (ids.length === 0) return empty;

  const users = await prisma.user.findMany({
    where: { id: { in: ids }, isArchived: false, role: { not: ROLES.STUDENT } },
    select: PAYROLL_USER_SELECT,
  });
  if (users.length === 0) return empty;

  const hoursMap = await getTeachersHours(
    users.map((u) => u.id),
    month,
  );

  const withMissed = users
    .map((user) => ({
      user,
      lessons: (hoursMap.get(user.id)?.missedLessons ?? []).filter(
        (lesson) => dayKey(lesson.date) === key,
      ),
    }))
    .filter((row) => row.lessons.length > 0);

  // SOAT NARXI — dvigateldan (`computeForStaff`), vedomost bilan AYNI qoida:
  // qaytadigan pul = soat × narx. Faqat ekranga kerak.
  let rates = new Map();
  if (withRates && withMissed.length > 0) {
    const staff = withMissed.map((row) => row.user);
    const ctx = await loadContext(month, staff, {
      salaryRules: await resolveSalariesForMonth(month),
      hoursMap: new Map(
        staff.map((u) => [u.id, toEngineHours(hoursMap.get(u.id), hoursMap.get(u.id)?.hours ?? 0)]),
      ),
    });
    rates = new Map(
      staff.map((u) => [u.id, computeForStaff(u, month, ctx)?.perHourRate ?? null]),
    );
  }

  return {
    month,
    key,
    teachers: withMissed
      .map((row) => {
        const rate = rates.get(row.user.id);
        return {
          ...row,
          rate: rate && rate.greaterThan(0) ? rate : null,
          lessons: row.lessons.sort(
            (a, b) => a.lessonOrder - b.lessonOrder || a.className.localeCompare(b.className),
          ),
        };
      })
      .sort((a, b) => fullName(a.user).localeCompare(fullName(b.user))),
  };
}

/**
 * MUHRLANGAN OYLIKLAR — yopilgan oyda shu o'qituvchilarning dars soatiga
 * bog'liq (soat narxi bor) majburiyatlari. Belgi ularni O'ZI o'zgartirmaydi:
 * "Qayta hisoblash" kerak. Ochiq oyda soatbay oylik muhrlanmaydi
 * (`finance.md` §10) — u yerda hammasi jonli.
 *
 * @param {number} month - YYYYMM
 * @param {string[]} staffIds
 */
async function findSealedEntries(month, staffIds) {
  if (month >= currentMonthKey() || staffIds.length === 0) return [];

  const rows = await prisma.payrollEntry.findMany({
    where: {
      month,
      staffId: { in: staffIds },
      status: { not: "cancelled" },
      perHourRate: { gt: 0 },
    },
    select: { id: true, staffId: true, status: true, amount: true, staffSnapshot: true },
    orderBy: { id: "asc" },
  });

  return rows.map((row) => ({
    entryId: row.id,
    staffId: row.staffId,
    staffName: fullName(row.staffSnapshot),
    status: row.status,
    statusLabel: ENTRY_STATUS_LABELS[row.status] ?? row.status,
    amount: formatAmount(row.amount),
  }));
}

/** Oy bo'yicha guruhlangan muhrlangan oyliklar — javob shakli. */
async function sealedByMonth(pairs) {
  const byMonth = new Map();
  for (const { month, staffId } of pairs) {
    if (!byMonth.has(month)) byMonth.set(month, new Set());
    byMonth.get(month).add(staffId);
  }

  const result = [];
  for (const month of [...byMonth.keys()].sort((a, b) => a - b)) {
    const entries = await findSealedEntries(month, [...byMonth.get(month)]);
    if (entries.length) result.push({ month, monthLabel: formatMonthKey(month), entries });
  }
  return result;
}

/* ─────────────────────── Ko'rinish ─────────────────────── */

/** Nomlar xaritasi (soft ref'lar qo'lda yuklanadi). */
const loadNames = async (ids) => {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, firstName: true, lastName: true },
  });
  return new Map(users.map((u) => [u.id, fullName(u)]));
};

const serialize = (row, names = new Map()) => ({
  id: row.id,
  batchId: row.batchId,
  teacherId: row.teacherId,
  teacherName: row.snapshot?.teacherName ?? names.get(row.teacherId) ?? "Noma'lum",
  // ⚠️ `date` — `@db.Date`: kalit ham, matn ham `getUTC*` bilan (`dates.md` §4)
  date: dayKey(row.date),
  dateLabel: formatDateUz(row.date, { utc: true }),
  classId: row.classId,
  className: row.snapshot?.className ?? "Noma'lum",
  subjectId: row.subjectId,
  subjectName: row.snapshot?.subjectName ?? "Noma'lum",
  lessonOrder: row.lessonOrder,
  missReason: row.missReason,
  missReasonLabel: LESSON_MISS_REASONS[row.missReason] ?? row.missReason,
  substituted: row.substituted,
  reason: row.reason,
  createdByName: names.get(row.createdBy) ?? "Noma'lum",
  createdAtLabel: formatDateTimeUz(row.createdAt),
  penaltyCancelled: Boolean(row.penaltyId),
  status: row.revokedAt ? "revoked" : "active",
  revokedAtLabel: row.revokedAt ? formatDateTimeUz(row.revokedAt) : null,
  revokedByName: row.revokedBy ? names.get(row.revokedBy) ?? "Noma'lum" : null,
  revokeReason: row.revokeReason || null,
});

/**
 * KUN EKRANI — tanlangan kunning o'tilmagan darslari (o'qituvchilar
 * kesimida, soat narxi bilan) va shu kunga qo'yilgan faol belgilar.
 *
 * @param {object} query - { date: "YYYY-MM-DD", teacherId? }
 */
async function getDay(query = {}) {
  const day = parseCreditDay(query.date);
  const teacherIds = parseTeacherIds(query.teacherId ? [query.teacherId] : null);

  const [collected, creditRows] = await Promise.all([
    collectDayMissed(day, { teacherIds, withRates: true }),
    prisma.lessonCredit.findMany({
      where: { date: day, revokedAt: null, ...(teacherIds ? { teacherId: { in: teacherIds } } : {}) },
      orderBy: [{ createdAt: "desc" }, { lessonOrder: "asc" }],
    }),
  ]);

  const sealed = await findSealedEntries(
    collected.month,
    collected.teachers.map((row) => row.user.id),
  );
  const sealedMap = new Map(sealed.map((entry) => [entry.staffId, entry]));
  const names = await loadNames(creditRows.map((row) => row.createdBy));

  let totalAmount = new Decimal(0);
  let lessonCount = 0;

  const teachers = collected.teachers.map(({ user, lessons, rate }) => {
    const amount = rate ? rate.times(lessons.length) : null;
    if (amount) totalAmount = totalAmount.plus(amount);
    lessonCount += lessons.length;

    return {
      teacherId: user.id,
      teacherName: fullName(user),
      username: user.username ?? null,
      perHourRate: rate ? formatAmount(rate) : null,
      // Shu kunning o'tilmagan darslari puli — belgilansa qaytadigan dars
      // soati summasi (soat × narx); foizli ustama ta'siri bunga kirmaydi
      missedAmount: amount ? formatAmount(amount) : null,
      sealedEntry: sealedMap.get(user.id) ?? null,
      lessons: lessons.map((lesson) => ({
        classId: lesson.classId,
        className: lesson.className,
        subjectId: lesson.subjectId,
        subjectName: lesson.subjectName,
        lessonOrder: lesson.lessonOrder,
        reason: lesson.reason,
        reasonLabel: lesson.reasonLabel,
        autoMarked: lesson.autoMarked,
        substituted: lesson.substituted,
      })),
    };
  });

  return {
    date: collected.key,
    dateLabel: formatDateUz(day, { utc: true }),
    dayName: DAYS_UZ[day.getUTCDay()],
    month: collected.month,
    monthLabel: formatMonthKey(collected.month),
    // Yopilgan oy — soatbay oylik muhrlangan bo'lishi mumkin
    isClosedMonth: collected.month < currentMonthKey(),
    teachers,
    credited: creditRows.map((row) => serialize(row, names)),
    totals: {
      teachers: teachers.length,
      lessons: lessonCount,
      missedAmount: formatAmount(totalAmount),
      credited: creditRows.length,
      sealed: sealed.length,
    },
  };
}

/* ─────────────────────── Jarima: bekor qilish va qaytarish ─────────────────────── */

/**
 * Jarimani bekor qiladi (compare-and-swap `approved` → `rejected`) va
 * o'qituvchidan ballni oladi — 0 dan pastga tushirmasdan (ball boshqa yo'l
 * bilan kamaytirilgan bo'lishi mumkin). Parallel amal uni ikki marta bekor
 * qilib, ballni ikki marta ayirmaydi.
 *
 * @returns {Promise<number|null>} AYNAN olib tashlangan ball; `null` — jarima
 *   shu orada o'zgargan, tegilmadi
 */
async function cancelPenaltyInTx(tx, penalty, { reason, actorId, now }) {
  const updated = await tx.penalty.updateMany({
    where: { id: penalty.id, status: "approved" },
    data: {
      status: "rejected",
      rejectionReason: `Dars o'tildi deb belgilandi: ${reason}`,
      reviewedBy: actorId,
      reviewedAt: now,
    },
  });
  if (updated.count !== 1) return null;

  const user = await tx.user.findUnique({
    where: { id: penalty.userId },
    select: { penaltyPoints: true },
  });
  const removed = Math.max(0, Math.min(penalty.points, user?.penaltyPoints ?? 0));
  if (removed > 0) {
    await tx.user.update({
      where: { id: penalty.userId },
      data: { penaltyPoints: { decrement: removed } },
    });
  }
  return removed;
}

/**
 * Shu belgi bekor qilgan jarimani qaytaradi (`rejected` → `approved`) va
 * AYNAN olib tashlangan ballni. Jarima o'sha holatda qolgan bo'lsagina
 * (o'chirilgan bo'lsa — yo'q).
 *
 * @returns {Promise<boolean>}
 */
async function restorePenaltyInTx(tx, { penaltyId, userId, points }, { actorId, now }) {
  const back = await tx.penalty.updateMany({
    where: { id: penaltyId, status: "rejected" },
    data: { status: "approved", rejectionReason: null, reviewedBy: actorId, reviewedAt: now },
  });
  if (back.count !== 1) return false;
  if (points > 0) {
    await tx.user.update({
      where: { id: userId },
      data: { penaltyPoints: { increment: points } },
    });
  }
  return true;
}

/* ─────────────────────── "Baho qo'ymaslik" jarimasi ─────────────────────── */

/**
 * Yangi belgilar darslarining "Baho qo'ymaslik" jarimalarini bekor qiladi
 * (tranzaksiya ichida). Jarima sarlavha bo'yicha topiladi
 * (`gradePenaltyTitle`) — cron darsga boshqa ishora saqlamaydi.
 *
 * Har jarima compare-and-swap bilan (`status: approved`): parallel amal uni
 * ikki marta bekor qilib, ballni ikki marta ayirmaydi. Ball 0 dan pastga
 * tushirilmaydi va aynan olib tashlangani belgiga yoziladi — bekor
 * qilinganda shuncha qaytadi.
 *
 * @returns {Promise<number>} bekor qilingan jarimalar soni
 */
async function cancelGradePenalties(tx, credits, { reason, actorId, now }) {
  if (credits.length === 0) return 0;

  // Jarima yozilgan paytdagi sinf nomi — joriy nomi (cron ham shuni yozgan)
  const classes = await tx.class.findMany({
    where: { id: { in: [...new Set(credits.map((c) => c.classId))] } },
    select: { id: true, name: true },
  });
  const classNames = new Map(classes.map((c) => [c.id, c.name]));

  const titlesOf = (credit) => {
    const name = classNames.get(credit.classId) ?? credit.snapshot?.className;
    if (!name) return [];
    const day = dayKey(credit.date);
    return [
      gradePenaltyTitle(name, credit.lessonOrder, day, false),
      gradePenaltyTitle(name, credit.lessonOrder, day, true),
    ];
  };

  const allTitles = [...new Set(credits.flatMap(titlesOf))];
  if (allTitles.length === 0) return 0;

  const penalties = await tx.penalty.findMany({
    where: {
      userId: { in: [...new Set(credits.map((c) => c.teacherId))] },
      title: { in: allTitles },
      type: "penalty",
      status: "approved",
      isCustom: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const byUserTitle = new Map();
  for (const penalty of penalties) {
    const key = `${penalty.userId}|${penalty.title}`;
    if (!byUserTitle.has(key)) byUserTitle.set(key, penalty);
  }

  const used = new Set();
  let cancelled = 0;

  for (const credit of credits) {
    const penalty = titlesOf(credit)
      .map((title) => byUserTitle.get(`${credit.teacherId}|${title}`))
      .find((p) => p && !used.has(p.id));
    if (!penalty) continue;
    used.add(penalty.id);

    const removed = await cancelPenaltyInTx(tx, penalty, { reason, actorId, now });
    if (removed == null) continue;

    await tx.lessonCredit.update({
      where: { id: credit.id },
      data: { penaltyId: penalty.id, penaltyPoints: removed },
    });
    cancelled += 1;
  }

  return cancelled;
}

/* ─────────────────────── Davomat: dars o'tilgan kun — kelgan kun ─────────────────────── */

/**
 * DARS O'TILGAN KUN — KELGAN KUN (biznes qarori, 2026-10-06).
 *
 * Kunning birorta darsi "o'tildi" deb belgilansa, o'qituvchi o'sha kuni
 * kelgan hisoblanadi: davomatdagi "kelmadi"/"sababli" — "keldi" bo'ladi,
 * davomat qatori umuman bo'lmasa — "keldi" qatori yoziladi. Natijada:
 *   · kelmagan kun uchun fiksadan ayirma yo'qoladi (`payrollAbsence` faktlari);
 *   · "kelmadi" uchun yozilgan davomat jarimasi bekor qilinadi;
 *   · shu kunning baho qo'yilgan boshqa darslari ham o'tilgan bo'ladi
 *     ("kelmadi" kuni baho bo'lsa ham dars o'tilmagan edi — `judgeLesson`).
 *
 * Shakl admin qo'lda "keldi" belgilagani bilan AYNI (`markStaffAttendance`):
 * kelish/ketish vaqtisiz, `autoMarked: false`. Avvalgi holat o'qituvchining
 * shu amaldagi BIRINCHI belgisiga yoziladi (`attendanceRestore`) — bekor
 * qilinganda aynan qaytadi (`restoreDayAttendance`).
 *
 * Allaqachon "keldi"/"kech keldi" — tegilmaydi. Owner'da davomat yo'q.
 * Davomat shu orada o'zgargan bo'lsa (compare-and-swap) — butun amal 409:
 * yarim yozilgan holat qolmaydi.
 *
 * @param {Map<string, string>} roles - teacherId → rol
 * @returns {Promise<string[]>} davomati "keldi" qilingan o'qituvchilar
 */
async function markDaysPresent(tx, rows, roles, { day, reason, actorId, now }) {
  const firstByTeacher = new Map();
  for (const row of rows) {
    if (!firstByTeacher.has(row.teacherId)) firstByTeacher.set(row.teacherId, row);
  }

  const note = `Dars o'tildi deb belgilandi: ${reason}`;
  const changed = [];

  for (const [teacherId, credit] of firstByTeacher) {
    const role = roles.get(teacherId);
    if (role === ROLES.OWNER || role === ROLES.STUDENT) continue;

    // `Attendance.date` — Toshkent kunining UTC yarim tuni, `day` bilan AYNI
    const record = await tx.attendance.findUnique({
      where: { userId_date: { userId: teacherId, date: day } },
    });
    if (record && !ABSENT_STATUSES.includes(record.status)) continue;

    let restore;
    if (record) {
      // Avvalgi holat YOZISHDAN OLDIN muhrlanadi — keyin o'qilsa, o'zimiz
      // yozgan "keldi" ni "avvalgi holat" deb saqlab qo'yish xavfi bo'lardi
      restore = {
        created: false,
        attendanceId: record.id,
        status: record.status,
        autoMarked: record.autoMarked,
        absenceReason: record.absenceReason,
        excuseReason: record.excuseReason,
        lastModifiedBy: record.lastModifiedBy,
        penaltyApplied: record.penaltyApplied,
        penaltyRef: record.penaltyRef,
        penaltyRemoved: null,
      };

      // "Kelmadi" jarimasi (`attendanceAbsent.job.js`) — kelgan kunga jarima yo'q
      let penaltyRemoved = null;
      if (record.penaltyApplied && record.penaltyRef) {
        const penalty = await tx.penalty.findUnique({ where: { id: record.penaltyRef } });
        if (penalty) penaltyRemoved = await cancelPenaltyInTx(tx, penalty, { reason, actorId, now });
      }

      const updated = await tx.attendance.updateMany({
        where: { id: record.id, status: record.status, updatedAt: record.updatedAt },
        data: {
          status: "present",
          autoMarked: false,
          absenceReason: null,
          excuseReason: note,
          penaltyApplied: false,
          lastModifiedBy: actorId,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictError("O'qituvchi davomati shu orada o'zgardi — qayta urinib ko'ring", {
          reason: "attendance_changed",
        });
      }

      restore.penaltyRemoved = penaltyRemoved;
    } else {
      const created = await tx.attendance.create({
        data: {
          userId: teacherId,
          date: day,
          status: "present",
          autoMarked: false,
          excuseReason: note,
          createdBy: actorId,
          lastModifiedBy: actorId,
        },
      });
      restore = { created: true, attendanceId: created.id };
    }

    await tx.lessonCredit.update({
      where: { id: credit.id },
      data: { attendanceRestore: restore },
    });
    changed.push(teacherId);
  }

  return changed;
}

/**
 * Belgi bekor qilingan kunda davomatni AVVALGI holatiga qaytaradi.
 *
 *   · shu o'qituvchi + kunga BOSHQA faol belgi qolgan bo'lsa — dars hamon
 *     o'tilgan, o'qituvchi kelgan: davomat qoladi, qaytarish ma'lumoti
 *     qolgan belgiga ko'chadi;
 *   · ⚠️ davomat biz qo'ygan holatda bo'lsagina ("keldi", kelish/ketish
 *     vaqtisiz) qaytadi: keyin admin uni qo'lda o'zgartirgan bo'lsa — uning
 *     qarori ustun, tegilmaydi (jarima ham qaytmaydi).
 *
 * Chaqiruvchi shu amaldagi HAMMA belgini oldin bekor qilib bo'lgan bo'lishi
 * shart — aks holda ular "qolgan faol belgi" deb sanalardi.
 *
 * @returns {Promise<boolean>} davomat qaytarildimi
 */
async function restoreDayAttendance(tx, credit, { actorId, now }) {
  const restore = credit.attendanceRestore;
  if (!restore?.attendanceId) return false;

  const remaining = await tx.lessonCredit.findFirst({
    where: { teacherId: credit.teacherId, date: credit.date, revokedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (remaining) {
    if (!remaining.attendanceRestore) {
      await tx.lessonCredit.update({
        where: { id: remaining.id },
        data: { attendanceRestore: restore },
      });
    }
    return false;
  }

  const ours = { id: restore.attendanceId, status: "present", checkIn: null, checkOut: null };

  if (restore.created) {
    const deleted = await tx.attendance.deleteMany({ where: ours });
    return deleted.count === 1;
  }

  const updated = await tx.attendance.updateMany({
    where: ours,
    data: {
      status: restore.status,
      autoMarked: restore.autoMarked,
      absenceReason: restore.absenceReason,
      excuseReason: restore.excuseReason,
      penaltyApplied: restore.penaltyApplied,
      lastModifiedBy: actorId,
    },
  });
  if (updated.count !== 1) return false;

  if (restore.penaltyRemoved != null && restore.penaltyRef) {
    await restorePenaltyInTx(
      tx,
      { penaltyId: restore.penaltyRef, userId: credit.teacherId, points: restore.penaltyRemoved },
      { actorId, now },
    );
  }
  return true;
}

/* ─────────────────────── Belgilash ─────────────────────── */

/**
 * DARSLARNI "O'TILDI" DEB BELGILASH.
 *
 *   · `mode: "lessons"` — `lessons: [{ teacherId, classId, subjectId, lessonOrder }]`
 *     (bitta yoki bir nechta dars);
 *   · `mode: "day"` — kunning HAMMA o'tilmagan darslari (`teacherIds` berilsa —
 *     faqat shu o'qituvchilarniki).
 *
 * Tanlangan dars hozir o'tilmagan bo'lmasa (shu orada baho qo'yilgan, boshqa
 * kishi belgilagan) — o'tkazib yuboriladi va `skipped` da qaytadi. Hech
 * narsa belgilanmasa — 409.
 *
 * @param {object} input - { date, mode, lessons?, teacherIds?, reason, cancelGradePenalty? }
 * @param {string} actorId
 */
async function createCredits(input = {}, actorId) {
  const day = parseCreditDay(input.date);
  if (!MODES.includes(input.mode)) {
    throw new BadRequestError("Qaysi darslar belgilanishini tanlang");
  }
  const reason = parseReason(input.reason);
  const cancelPenalty = input.cancelGradePenalty === true;

  const requested = input.mode === "lessons" ? parseLessons(input.lessons) : null;
  const teacherIds = requested
    ? [...new Set(requested.map((lesson) => lesson.teacherId))]
    : parseTeacherIds(input.teacherIds);

  // ── Kunning o'tilmagan darslari — QAYTA, serverda ──
  const collected = await collectDayMissed(day, { teacherIds });
  const missed = new Map();
  for (const { user, lessons } of collected.teachers) {
    for (const lesson of lessons) {
      missed.set(
        lessonCreditKey(user.id, lesson.classId, lesson.subjectId, lesson.lessonOrder, collected.key),
        { user, lesson },
      );
    }
  }

  let targets;
  const skipped = [];
  if (requested) {
    targets = [];
    for (const item of requested) {
      const key = lessonCreditKey(item.teacherId, item.classId, item.subjectId, item.lessonOrder, collected.key);
      const hit = missed.get(key);
      if (hit) targets.push({ key, ...hit });
      else skipped.push(item);
    }
  } else {
    targets = [...missed.entries()].map(([key, hit]) => ({ key, ...hit }));
  }

  if (targets.length === 0) {
    throw new ConflictError(
      requested
        ? "Tanlangan darslar o'tilmaganlar ro'yxatida yo'q — ro'yxatni yangilang"
        : "Bu kunda o'tilmagan dars yo'q",
      { reason: "nothing_to_credit", skipped: skipped.length },
    );
  }

  const batchId = generateId();
  const dateLabel = formatDateUz(day, { utc: true });

  const roles = new Map(targets.map(({ user }) => [user.id, user.role]));

  const { created, penaltiesCancelled, attendanceFixed } = await prisma.$transaction(async (tx) => {
    const now = new Date();
    // ⚠️ `activeKey` yagona: parallel amal yoki ikki marta bosilgan tugma
    // bitta darsga ikkinchi faol belgi yoza olmaydi — u jim o'tkazib yuboriladi
    await tx.lessonCredit.createMany({
      data: targets.map(({ key, user, lesson }) => ({
        teacherId: user.id,
        date: day,
        classId: lesson.classId,
        subjectId: lesson.subjectId,
        lessonOrder: lesson.lessonOrder,
        missReason: lesson.reason,
        substituted: Boolean(lesson.substituted),
        snapshot: {
          teacherName: fullName(user),
          className: lesson.className,
          subjectName: lesson.subjectName,
        },
        activeKey: key,
        batchId,
        reason,
        createdBy: actorId,
      })),
      skipDuplicates: true,
    });

    const rows = await tx.lessonCredit.findMany({
      where: { batchId },
      orderBy: [{ teacherId: "asc" }, { lessonOrder: "asc" }],
    });
    if (rows.length === 0) {
      throw new ConflictError("Bu darslar allaqachon belgilangan — ro'yxatni yangilang", {
        reason: "already_credited",
      });
    }

    const cancelled = cancelPenalty
      ? await cancelGradePenalties(tx, rows, { reason, actorId, now })
      : 0;

    // Dars o'tilgan kun — kelgan kun: davomat "keldi", kelmagan kun ayirmasi va
    // "kelmadi" jarimasi yo'qoladi
    const present = await markDaysPresent(tx, rows, roles, { day, reason, actorId, now });

    const teacherCount = new Set(rows.map((row) => row.teacherId)).size;
    await payrollAudit.record(
      {
        actorId,
        action: "lesson.credit",
        targetType: "lessonCredit",
        targetId: batchId,
        summary:
          `${dateLabel}: ${rows.length} ta o'tilmagan dars "o'tildi" deb belgilandi ` +
          `(${teacherCount} ta o'qituvchi)` +
          (cancelled ? `, ${cancelled} ta baho jarimasi bekor qilindi` : "") +
          (present.length ? `, ${present.length} ta o'qituvchi davomati "keldi" qilindi` : "") +
          `. Sabab: ${reason}`,
        newValue: {
          batchId,
          date: collected.key,
          mode: input.mode,
          penaltiesCancelled: cancelled,
          attendanceFixed: present,
          lessons: rows.map((row) => ({
            creditId: row.id,
            teacherId: row.teacherId,
            classId: row.classId,
            subjectId: row.subjectId,
            lessonOrder: row.lessonOrder,
            missReason: row.missReason,
          })),
        },
      },
      tx,
    );

    return { created: rows, penaltiesCancelled: cancelled, attendanceFixed: present };
  }, TX_OPTIONS);

  // Davomat o'zgardi — muhrlangan oylikdagi kelmagan kun ayirmasi ham darhol
  // yangilansin (kutilmaydi, xatosi belgini yiqitmaydi; 06:00 dagi pass zaxira)
  resyncAfterAttendanceChange(attendanceFixed, day);

  const creditedTeacherIds = [...new Set(created.map((row) => row.teacherId))];
  const sealed = await sealedByMonth(
    creditedTeacherIds.map((staffId) => ({ month: collected.month, staffId })),
  );

  logger.info(
    `[lessonCredit] ${collected.key}: ${created.length} ta dars "o'tildi" deb belgilandi ` +
      `(o'qituvchi=${creditedTeacherIds.length}, jarima=${penaltiesCancelled}, ` +
      `davomat=${attendanceFixed.length}, ` +
      `muhrlangan=${sealed.reduce((sum, m) => sum + m.entries.length, 0)}) actor=${actorId}`,
  );

  return {
    batchId,
    date: collected.key,
    dateLabel,
    month: collected.month,
    monthLabel: formatMonthKey(collected.month),
    created: created.length,
    teachers: creditedTeacherIds.length,
    // Tanlangan, lekin hozir o'tilmagan emas (yoki shu orada belgilangan)
    skipped: skipped.length + (targets.length - created.length),
    penaltiesCancelled,
    // Davomati "kelmadi"/"sababli" (yoki belgilanmagan) bo'lib, "keldi" qilingan o'qituvchilar
    attendanceFixed: attendanceFixed.length,
    sealed,
  };
}

/* ─────────────────────── Bekor qilish ─────────────────────── */

/**
 * BELGILARNI BEKOR QILISH — bittalab yoki bir nechtalab. Dars yana
 * faktlar bo'yicha baholanadi (o'tilmagan bo'lsa soati yana ayriladi),
 * shu belgi bilan bekor qilingan jarima aynan qaytariladi, kunda boshqa
 * belgi qolmasa davomat ham avvalgi holatiga qaytadi.
 *
 * Har qator compare-and-swap (`revokedAt: null`): parallel bekor qilish
 * jarimani ikki marta qaytarmaydi.
 *
 * @param {object} input - { ids: string[], reason }
 * @param {string} actorId
 */
async function revokeCredits(input = {}, actorId) {
  const ids = Array.isArray(input.ids)
    ? [...new Set(input.ids.map((id) => String(id).trim()).filter(Boolean))]
    : [];
  if (ids.length === 0) throw new BadRequestError("Bekor qilinadigan belgini tanlang");
  if (ids.length > MAX_REVOKE) {
    throw new BadRequestError(`Bir amalda ko'pi bilan ${MAX_REVOKE} ta belgi bekor qilinadi`);
  }
  if (ids.some((id) => !OBJECT_ID_RE.test(id))) {
    throw new BadRequestError("Belgi identifikatori noto'g'ri");
  }
  const reason = parseReason(input.reason, "Bekor qilish sababi");

  const rows = await prisma.lessonCredit.findMany({
    where: { id: { in: ids }, revokedAt: null },
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });
  if (rows.length === 0) {
    throw new ConflictError("Tanlangan belgilar allaqachon bekor qilingan — ro'yxatni yangilang");
  }

  const { revoked, penaltiesRestored, attendanceRestored } = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const done = [];
    let restored = 0;

    for (const row of rows) {
      const updated = await tx.lessonCredit.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: now, revokedBy: actorId, revokeReason: reason, activeKey: null },
      });
      if (updated.count !== 1) continue;
      done.push(row);

      if (!row.penaltyId) continue;
      const back = await restorePenaltyInTx(
        tx,
        { penaltyId: row.penaltyId, userId: row.teacherId, points: row.penaltyPoints },
        { actorId, now },
      );
      if (back) restored += 1;
    }

    if (done.length === 0) {
      throw new ConflictError("Tanlangan belgilar allaqachon bekor qilingan — ro'yxatni yangilang");
    }

    // Davomat — HAMMA belgi bekor qilingandan KEYIN: shu amaldagilar
    // "qolgan faol belgi" deb sanalmasin
    const attendance = [];
    for (const row of done) {
      if (await restoreDayAttendance(tx, row, { actorId, now })) attendance.push(row);
    }

    const days = [...new Set(done.map((row) => formatDateUz(row.date, { utc: true })))];
    await payrollAudit.record(
      {
        actorId,
        action: "lesson.uncredit",
        targetType: "lessonCredit",
        targetId: done[0].batchId,
        summary:
          `${days.join(", ")}: ${done.length} ta darsning "o'tildi" belgisi bekor qilindi` +
          (restored ? `, ${restored} ta baho jarimasi qaytarildi` : "") +
          (attendance.length ? `, ${attendance.length} ta kun davomati qaytarildi` : "") +
          `. Sabab: ${reason}`,
        oldValue: {
          credits: done.map((row) => ({
            creditId: row.id,
            batchId: row.batchId,
            teacherId: row.teacherId,
            date: dayKey(row.date),
            classId: row.classId,
            subjectId: row.subjectId,
            lessonOrder: row.lessonOrder,
          })),
        },
        newValue: {
          reason,
          penaltiesRestored: restored,
          attendanceRestored: attendance.map((row) => ({
            teacherId: row.teacherId,
            date: dayKey(row.date),
          })),
        },
      },
      tx,
    );

    return { revoked: done, penaltiesRestored: restored, attendanceRestored: attendance };
  }, TX_OPTIONS);

  // Davomat qaytdi — kelmagan kun ayirmasi muhrlangan oylikda ham qaytsin
  for (const key of new Set(attendanceRestored.map((row) => dayKey(row.date)))) {
    resyncAfterAttendanceChange(
      attendanceRestored.filter((row) => dayKey(row.date) === key).map((row) => row.teacherId),
      parseDayDate(key),
    );
  }

  const sealed = await sealedByMonth(
    revoked.map((row) => ({ month: monthKeyOfDate(row.date), staffId: row.teacherId })),
  );

  logger.info(
    `[lessonCredit] ${revoked.length} ta "o'tildi" belgisi bekor qilindi ` +
      `(jarima qaytdi=${penaltiesRestored}, davomat qaytdi=${attendanceRestored.length}) actor=${actorId}`,
  );

  return {
    revoked: revoked.length,
    skipped: ids.length - revoked.length,
    penaltiesRestored,
    attendanceRestored: attendanceRestored.length,
    sealed,
  };
}

/* ─────────────────────── Registr ─────────────────────── */

/**
 * BELGILAR REGISTRI — "kim, qachon, qaysi darsni, nega". Yangisi tepada.
 *
 * @param {object} query - { status?, teacherId?, month? (YYYYMM), date?, page, limit }
 */
async function listCredits(query = {}) {
  const where = {};

  if (query.status) {
    if (!STATUSES.includes(query.status)) throw new BadRequestError("Holat noto'g'ri");
    where.revokedAt = query.status === "active" ? null : { not: null };
  }
  if (query.teacherId) {
    if (!OBJECT_ID_RE.test(String(query.teacherId))) {
      throw new BadRequestError("O'qituvchi identifikatori noto'g'ri");
    }
    where.teacherId = String(query.teacherId);
  }
  if (query.date) {
    where.date = parseDayDate(query.date, "Kun");
  } else if (query.month) {
    const month = parseMonthKey(query.month, "Oy");
    where.date = { gte: monthStartDate(month), lte: monthEndDate(month) };
  }

  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 20, 1), 100);
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);

  const [rows, total, active] = await Promise.all([
    prisma.lessonCredit.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { date: "desc" }, { lessonOrder: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.lessonCredit.count({ where }),
    prisma.lessonCredit.count({ where: { ...where, revokedAt: null } }),
  ]);

  const names = await loadNames(rows.flatMap((row) => [row.createdBy, row.revokedBy, row.teacherId]));

  return {
    data: rows.map((row) => serialize(row, names)),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPrevPage: page > 1,
    },
    totals: { active },
  };
}

/** Tanlov uchun o'qituvchilar — o'rinbosarlik ro'yxati bilan AYNI manba. */
const getTeacherOptions = () =>
  // Kechiktirilgan require: o'rinbosarlik servisi og'ir bog'liqliklarni tortadi
  require("./lessonSubstitution.service").getTeacherOptions();

module.exports = {
  MAX_LESSONS,
  REASON_MAX,
  parseCreditDay,
  collectDayMissed,
  getDay,
  createCredits,
  revokeCredits,
  listCredits,
  getTeacherOptions,
};
