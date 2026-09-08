/**
 * DARS SOATI VA MAOSH — YIG'MA KO'RINISH.
 *
 * Uch savolga javob beradi va uchalasi ham BITTA hisobdan chiqadi:
 *
 *   · boshliq  — "shu oyda maktab qancha soat oldi va qancha to'laydi";
 *   · vedomost — "har bir o'qituvchida qancha soat va qancha pul";
 *   · o'qituvchi — "menda hozir qancha yig'ilyapti".
 *
 * ⚠️ JAMI RAQAM SERVERDA HISOBLANADI. Panel qatorlarni qo'shib jami
 * chiqarmaydi: pul `Decimal(14,2)` va API'da STRING — `Number` ga
 * aylantirib qo'shish katta summalarda aniqlikni yo'qotardi
 * (`money.helpers.js` sarlavhasi).
 *
 * ⚠️ HISOBLANGAN ≠ MUHRLANGAN. Bu yerdagi summa — JONLI PROGNOZ: qoida va
 * bugungi jadval asosidagi hisob. Haqiqiy qarz esa `PayrollEntry` da, u
 * oy yopilganda muhrlanadi. Ikkalasi ataylab alohida ko'rsatiladi, aks
 * holda "panelda 5 200 000 turgan edi, vedomostda 4 900 000" degan savolga
 * javob bo'lmasdi — javob shu: oradan o'rinbosarlik o'tgan.
 */

const prisma = require("../config/prisma");
const { NotFoundError } = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const {
  currentMonthKey,
  formatMonthKey,
  formatMonthShort,
  monthStartDate,
  monthEndDate,
  daysInMonth,
} = require("../helpers/month.helpers");
const {
  Decimal,
  formatAmount,
  sumAmounts,
} = require("../helpers/money.helpers");
const { computeSalary, normProgress } = require("../helpers/lessonHours");
const { formatDateRangeUz } = require("../helpers/date.helpers");
const { REASON_LABELS } = require("./lessonSubstitution.service");
const {
  resolveSalariesForMonth,
  TYPE_LABELS,
  formulaOf,
  STAFF_SELECT,
} = require("./staffSalary.service");
const {
  getTeachersHours,
  getMonthCalendar,
  cutoffForMonth,
  assertTeacher,
} = require("./lessonHours.service");

const fullName = (person) =>
  person ? `${person.firstName} ${person.lastName ?? ""}`.trim() : "Noma'lum";

/**
 * O'rinbosarlik yozuvining qisqa ko'rinishi.
 *
 * ⚠️ SANA MATNI SERVERDA TAYYORLANADI. `fromDate`/`toDate` — `@db.Date`,
 * ya'ni UTC yarim tunida yotadi va uni frontendda `new Date(...)` bilan
 * o'qish brauzer taymzonasiga qarab kunni bir kunga siljitardi. Shuning
 * uchun panelga `periodLabel` beriladi (`.claude/rules/dates.md` §5.3).
 */
const summarizeSubstitution = (row, partner) => ({
  id: row.id,
  fromDate: row.fromDate,
  toDate: row.toDate,
  periodLabel: formatDateRangeUz(row.fromDate, row.toDate, { utc: true }),
  lessonCount: row.items.length,
  withName: row.teacherSnapshot?.[partner]?.name ?? "Noma'lum",
  reason: row.reason,
  reasonLabel: REASON_LABELS[row.reason] ?? row.reason,
});

/**
 * Bitta o'qituvchi qatori — vedomost va profil bitta shakldan o'qiydi.
 *
 * @param {object} person - `STAFF_SELECT` shaklidagi xodim
 * @param {object|null} rule - `StaffSalary` qatori
 * @param {object|null} hoursRow - `lessonHours.service` natijasi
 * @param {object|null} entry - o'sha oyning MUHRLANGAN majburiyati
 */
function buildRow(person, rule, hoursRow, entry) {
  const hours = hoursRow?.hours ?? 0;
  const taught = hoursRow?.taughtHours ?? 0;

  // Ikki raqam ATAYLAB alohida: "hozirgacha yig'ilgani" odamni qiziqtiradi,
  // "oy oxirida chiqadigani" esa byudjetni.
  const accrued = rule ? computeSalary(rule, taught) : null;
  const projected = rule ? computeSalary(rule, hours) : null;

  return {
    staffId: person.id,
    staff: person,
    staffName: fullName(person),
    role: person.role,

    // ── Shartnoma sharti ──────────────────
    hasRule: Boolean(rule),
    salaryType: rule?.type ?? null,
    salaryTypeLabel: rule ? (TYPE_LABELS[rule.type] ?? rule.type) : null,
    formulaLabel: rule ? formulaOf(rule) : null,
    baseAmount: rule ? formatAmount(rule.amount) : null,
    hourlyRate: rule?.hourlyRate != null ? formatAmount(rule.hourlyRate) : null,
    monthlyHourNorm: rule?.monthlyHourNorm ?? null,
    usesHours: rule?.type === "hourly" || rule?.type === "mixed",

    // ── Soat ──────────────────────────────
    weeklyHours: hoursRow?.weeklyHours ?? 0,
    scheduledHours: hoursRow?.scheduledHours ?? 0,
    substitutedOutHours: hoursRow?.substitutedOutHours ?? 0,
    substitutedInHours: hoursRow?.substitutedInHours ?? 0,
    hours,
    taughtHours: taught,
    remainingHours: hoursRow?.remainingHours ?? 0,
    normProgress: rule ? normProgress(rule, hours) : null,

    // ── Pul (JONLI, muhrlanmagan) ─────────
    accruedAmount: accrued ? formatAmount(accrued.amount) : null,
    projectedAmount: projected ? formatAmount(projected.amount) : null,
    projectedHoursAmount: projected ? formatAmount(projected.hoursAmount) : null,
    extraHours: projected?.extraHours ?? 0,

    // ── Muhrlangan majburiyat (agar bor bo'lsa) ──
    entryId: entry?.id ?? null,
    entryStatus: entry?.status ?? null,
    sealedAmount: entry ? formatAmount(entry.amount) : null,
  };
}

/**
 * BOSHLIQ KO'RINISHI — bir oy, butun maktab.
 *
 * @param {number} month - YYYYMM
 * @returns {Promise<object>}
 */
async function getOverview(month) {
  const cutoff = cutoffForMonth(month);

  const salaries = await resolveSalariesForMonth(month);
  const staffIds = [...salaries.keys()];

  const [staff, entries] = await Promise.all([
    staffIds.length
      ? prisma.user.findMany({
          where: { id: { in: staffIds }, isArchived: false, role: { not: ROLES.STUDENT } },
          select: STAFF_SELECT,
        })
      : [],
    staffIds.length
      ? prisma.payrollEntry.findMany({
          where: { month, staffId: { in: staffIds }, status: { not: "cancelled" } },
          select: { id: true, staffId: true, status: true, amount: true },
        })
      : [],
  ]);

  const entryMap = new Map(entries.map((e) => [e.staffId, e]));

  // Soat FAQAT soatbay/aralash uchun — fiksa xodimning jadvali bo'lmasligi
  // mumkin va uni hisobga qo'shish har oy ma'nosiz ish bo'lardi.
  const hourStaff = staff.filter((person) => {
    const rule = salaries.get(person.id);
    return rule && (rule.type === "hourly" || rule.type === "mixed");
  });

  const [hoursMap, calendar] = await Promise.all([
    hourStaff.length
      ? getTeachersHours(hourStaff.map((p) => p.id), month, {
          asOfDayOfMonth: cutoff,
        })
      : new Map(),
    getMonthCalendar(month, { asOfDayOfMonth: cutoff }),
  ]);

  const rows = staff
    .map((person) =>
      buildRow(
        person,
        salaries.get(person.id),
        hoursMap.get(person.id),
        entryMap.get(person.id),
      ),
    )
    .sort((a, b) => b.hours - a.hours || a.staffName.localeCompare(b.staffName));

  // ── Rejimlar kesimi ─────────────────────
  const byMode = new Map(
    Object.keys(TYPE_LABELS).map((key) => [
      key,
      { type: key, label: TYPE_LABELS[key], staffCount: 0, hours: 0, amounts: [] },
    ]),
  );

  for (const row of rows) {
    if (!row.salaryType) continue;
    const bucket = byMode.get(row.salaryType);
    if (!bucket) continue;
    bucket.staffCount += 1;
    bucket.hours += row.hours;
    if (row.projectedAmount) bucket.amounts.push(row.projectedAmount);
  }

  const modes = [...byMode.values()].map((bucket) => ({
    type: bucket.type,
    label: bucket.label,
    staffCount: bucket.staffCount,
    hours: bucket.hours,
    amount: formatAmount(sumAmounts(bucket.amounts)),
  }));

  // ── O'rinbosarlik ───────────────────────
  const from = monthStartDate(month);
  const to = monthEndDate(month);

  const [substitutionCount, ongoingCount] = await Promise.all([
    prisma.lessonSubstitution.count({
      where: { status: "active", fromDate: { lte: to }, toDate: { gte: from } },
    }),
    prisma.lessonSubstitution.count({
      where: {
        status: "active",
        fromDate: { lte: new Date() },
        toDate: { gte: new Date() },
      },
    }),
  ]);

  const withHours = rows.filter((r) => r.usesHours);

  const projectedTotal = sumAmounts(
    rows.map((r) => r.projectedAmount).filter(Boolean),
  );
  const accruedTotal = sumAmounts(
    rows.map((r) => r.accruedAmount).filter(Boolean),
  );
  const sealedTotal = sumAmounts(entries.map((e) => e.amount));

  const totalHours = withHours.reduce((sum, r) => sum + r.hours, 0);
  const taughtHours = withHours.reduce((sum, r) => sum + r.taughtHours, 0);

  // Kunlik egri chiziq — barcha soatbay o'qituvchilarning kunlik soatlari
  // qo'shiladi. Nuqtalar soni oy uzunligiga TENG: `getTeachersHours` endi
  // har bir kalendar kuni uchun nuqta qaytaradi (bayram — nol soat), ya'ni
  // indeks bo'yicha to'g'ridan-to'g'ri qo'shsa bo'ladi.
  const dayCount = daysInMonth(month);
  const series = Array.from({ length: dayCount }, (_, index) => ({
    day: index + 1,
    hours: 0,
    isPast: cutoff == null || index + 1 <= cutoff,
  }));

  for (const row of hoursMap.values()) {
    for (const point of row.series ?? []) {
      const bucket = series[point.day - 1];
      if (bucket) bucket.hours += point.hours;
    }
  }

  let cumulative = 0;
  for (const point of series) {
    cumulative += point.hours;
    point.cumulative = cumulative;
  }

  return {
    month,
    monthLabel: formatMonthKey(month),
    isCurrentMonth: month === currentMonthKey(),
    // ⚠️ KALENDAR ODAMGA BOG'LIQ EMAS. Ilgari bu ikki qiymat ro'yxatdagi
    // BIRINCHI soatbay o'qituvchidan o'qilardi — soatbay xodim bo'lmasa
    // ta'til bayrog'i umuman yo'qolib, ekranda sababsiz nollar turardi.
    isVacationMonth: calendar.isVacationMonth,
    cutoffDay: cutoff,
    teachingDays: calendar.teachingDays,
    totals: {
      staffCount: rows.length,
      hourlyStaffCount: withHours.length,
      totalHours,
      taughtHours,
      remainingHours: Math.max(0, totalHours - taughtHours),
      substitutedHours: withHours.reduce((sum, r) => sum + r.substitutedInHours, 0),
      // Jonli prognoz — muhrlangan qarz EMAS
      projectedAmount: formatAmount(projectedTotal),
      accruedAmount: formatAmount(accruedTotal),
      sealedAmount: formatAmount(sealedTotal),
      sealedCount: entries.length,
      // BIR SOATNING O'RTACHA TANNARXI — byudjet uchun eng qisqa ko'rsatkich.
      //
      // ⚠️ SURATDA `projectedHoursAmount` EMAS, TO'LIQ `projectedAmount`.
      // Aralash rejimda soatdan chiqqan qism faqat NORMADAN ORTIQCHA
      // soatlarni to'laydi; bazaviy oylik esa birinchi `norm` soatning
      // haqqi. Suratga faqat ortiqcha qism qo'yilsa, maxrajda BARCHA
      // soatlar turgani uchun raqam bir necha barobar past chiqardi
      // (3 000 000 + 80 soat normali xodimda 100 soat → 10 000 so'm/soat,
      // aslida 40 000). Bu raqam boshliqqa "1 soat qanchaga tushadi" deb
      // ko'rsatiladi, ya'ni u TANNARX bo'lishi kerak, marjinal stavka emas.
      averageHourCost:
        totalHours > 0
          ? formatAmount(
              sumAmounts(
                rows.filter((r) => r.usesHours).map((r) => r.projectedAmount ?? "0"),
              ).div(totalHours),
            )
          : null,
      substitutionCount,
      ongoingSubstitutions: ongoingCount,
    },
    modes,
    series,
    // Eng ko'p yuklamali o'nlik — butun ro'yxat vedomost sahifasida
    topTeachers: rows.filter((r) => r.usesHours).slice(0, 10),
  };
}

/**
 * VEDOMOST — barcha o'qituvchilar, filtr bilan.
 *
 * ⚠️ SAHIFALANMAYDI: bu ekran "oy yakunida hammasini bir ko'z bilan
 * ko'rish" uchun va xodimlar soni yuzlab emas. Sahifalash jami raqamni
 * sahifadan sahifaga o'zgartirib yuborardi.
 *
 * @param {number} month
 * @param {object} query - { type, search, withHoursOnly }
 */
async function getLedger(month, query = {}) {
  const cutoff = cutoffForMonth(month);
  const salaries = await resolveSalariesForMonth(month);
  const staffIds = [...salaries.keys()];

  const [staff, entries] = await Promise.all([
    staffIds.length
      ? prisma.user.findMany({
          where: { id: { in: staffIds }, isArchived: false, role: { not: ROLES.STUDENT } },
          select: STAFF_SELECT,
        })
      : [],
    staffIds.length
      ? prisma.payrollEntry.findMany({
          where: { month, staffId: { in: staffIds } },
          select: { id: true, staffId: true, status: true, amount: true },
        })
      : [],
  ]);

  const entryMap = new Map(entries.map((e) => [e.staffId, e]));

  const hourStaff = staff.filter((person) => {
    const rule = salaries.get(person.id);
    return rule && (rule.type === "hourly" || rule.type === "mixed");
  });

  const hoursMap = hourStaff.length
    ? await getTeachersHours(
        hourStaff.map((p) => p.id),
        month,
        { asOfDayOfMonth: cutoff },
      )
    : new Map();

  let rows = staff.map((person) =>
    buildRow(
      person,
      salaries.get(person.id),
      hoursMap.get(person.id),
      entryMap.get(person.id),
    ),
  );

  if (query.type) rows = rows.filter((r) => r.salaryType === query.type);
  if (query.withHoursOnly === "true") rows = rows.filter((r) => r.usesHours);

  if (query.search) {
    const needle = String(query.search).trim().toLowerCase();
    rows = rows.filter(
      (r) =>
        r.staffName.toLowerCase().includes(needle) ||
        r.staff.username?.toLowerCase().includes(needle),
    );
  }

  rows.sort((a, b) => b.hours - a.hours || a.staffName.localeCompare(b.staffName));

  return {
    month,
    monthLabel: formatMonthKey(month),
    isCurrentMonth: month === currentMonthKey(),
    items: rows,
    totals: {
      staffCount: rows.length,
      totalHours: rows.reduce((sum, r) => sum + r.hours, 0),
      projectedAmount: formatAmount(
        sumAmounts(rows.map((r) => r.projectedAmount).filter(Boolean)),
      ),
      accruedAmount: formatAmount(
        sumAmounts(rows.map((r) => r.accruedAmount).filter(Boolean)),
      ),
    },
  };
}

/**
 * BITTA O'QITUVCHI — jonli panel (boshliq ham, o'qituvchining o'zi ham).
 *
 * @param {string} teacherId
 * @param {number} month
 */
async function getTeacherDetail(teacherId, month) {
  const teacher = await assertTeacher(teacherId);
  const cutoff = cutoffForMonth(month);

  const salaries = await resolveSalariesForMonth(month);
  const rule = salaries.get(teacher.id) ?? null;

  const [hoursRow, entry, substitutions] = await Promise.all([
    getTeachersHours([teacher.id], month, { asOfDayOfMonth: cutoff }).then((m) =>
      m.get(teacher.id),
    ),
    prisma.payrollEntry.findUnique({
      where: { staffId_month: { staffId: teacher.id, month } },
      select: { id: true, staffId: true, status: true, amount: true },
    }),
    prisma.lessonSubstitution.findMany({
      where: {
        status: "active",
        fromDate: { lte: monthEndDate(month) },
        toDate: { gte: monthStartDate(month) },
        OR: [{ originalTeacherId: teacher.id }, { substituteTeacherId: teacher.id }],
      },
      include: { items: true },
      orderBy: { fromDate: "desc" },
    }),
  ]);

  const row = buildRow(teacher, rule, hoursRow, entry);

  // Oylik tarix — oxirgi 6 oy, egri chiziq uchun
  const history = await prisma.payrollEntry.findMany({
    where: { staffId: teacher.id, status: { not: "cancelled" } },
    orderBy: { month: "desc" },
    take: 6,
    select: {
      month: true,
      amount: true,
      hoursWorked: true,
      hoursAmount: true,
      baseAmount: true,
      status: true,
    },
  });

  return {
    ...row,
    month,
    monthLabel: formatMonthKey(month),
    isCurrentMonth: month === currentMonthKey(),
    cutoffDay: cutoff,
    isVacationMonth: hoursRow?.isVacationMonth ?? false,
    teachingDays: hoursRow?.teachingDays ?? 0,
    taughtDays: hoursRow?.taughtDays ?? 0,
    byDay: hoursRow?.byDay ?? [],
    byClass: hoursRow?.byClass ?? [],
    bySubject: hoursRow?.bySubject ?? [],
    series: (hoursRow?.series ?? []).reduce((acc, point) => {
      const prev = acc[acc.length - 1];
      acc.push({ ...point, cumulative: (prev?.cumulative ?? 0) + point.hours });
      return acc;
    }, []),
    substitutions: {
      given: substitutions
        .filter((s) => s.originalTeacherId === teacher.id)
        .map((s) => summarizeSubstitution(s, "substitute")),
      taken: substitutions
        .filter((s) => s.substituteTeacherId === teacher.id)
        .map((s) => summarizeSubstitution(s, "original")),
    },
    history: history
      .map((h) => ({
        month: h.month,
        monthLabel: formatMonthKey(h.month),
        // ⚠️ QISQARTMA SERVERDA. Panelda `monthLabel` ni 3 harfga kesish
        // "Iyun" va "Iyul" ni bitta "Iyu" ga aylantirardi — diagrammadagi
        // ikki ustun farqlanmay qolardi. `formatMonthShort` — o'sha
        // ro'yxatning YAGONA manbasi (`month.helpers.js`).
        monthShortLabel: formatMonthShort(h.month),
        amount: formatAmount(h.amount),
        baseAmount: formatAmount(h.baseAmount),
        hoursAmount: formatAmount(h.hoursAmount),
        hoursWorked: h.hoursWorked,
        status: h.status,
      }))
      .reverse(),
  };
}

module.exports = { buildRow, getOverview, getLedger, getTeacherDetail };
