/**
 * DARS SOATI VA MAOSH — YIG'MA KO'RINISH.
 *
 * Uch savolga javob beradi va uchalasi ham BITTA hisobdan chiqadi:
 *
 *   · boshliq  — "shu oyda maktab qancha soat oldi va qancha to'laydi";
 *   · vedomost — "har bir o'qituvchida qancha soat va qancha pul";
 *   · o'qituvchi — "menda hozir qancha yig'ilyapti".
 *
 * ⚠️ RO'YXAT DARS JADVALIDAN QURILADI, OYLIK QOIDASIDAN EMAS.
 * Ilgari ro'yxat `resolveSalariesForMonth` dan olinardi va oqibati shu
 * edi: oylik qoidasi biriktirilmagan o'qituvchi — darsi bo'lsa ham —
 * ekranda UMUMAN ko'rinmasdi, jami soat esa 0 bo'lib turardi. Holbuki
 * bo'limning savoli aynan "kim qancha dars beradi", ya'ni u pul
 * qarorining NATIJASI emas, KIRISHI: avval soat ko'rinadi, keyin unga
 * oylik biriktiriladi. Shuning uchun manba — jadval, o'rinbosarlik,
 * toifa va qoida birlashmasi.
 *
 * ⚠️ SOAT PUL QOIDASIGA BOG'LIQ EMAS. Qoidasi yo'q o'qituvchining ham
 * soati to'liq hisoblanadi va ko'rsatiladi; faqat PUL ustunlari bo'sh
 * qoladi. Aks holda "oylik belgilanmagan" holati "dars bermaydi" bilan
 * bir xil ko'rinardi.
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
 *
 * ⚠️ PUL FORMULASI BU YERDA YOZILMAYDI. Summa `payrollEngine.service.js`
 * dan keladi — vedomostdagi raqam "Struktura" ekranidagi va muhrlangan
 * majburiyatdagi raqam bilan bir xil bo'lishi SHART (`finance.md` §10:
 * formula bitta joyda).
 */

const prisma = require("../config/prisma");
const { ROLES } = require("../utils/constants");
const {
  currentMonthKey,
  formatMonthKey,
  formatMonthShort,
  monthStartDate,
  monthEndDate,
  daysInMonth,
} = require("../helpers/month.helpers");
const { Decimal, formatAmount, sumAmounts } = require("../helpers/money.helpers");
const { formatDateRangeUz } = require("../helpers/date.helpers");
const { REASON_LABELS } = require("./lessonSubstitution.service");
const { resolveSalariesForMonth, TYPE_LABELS } = require("./staffSalary.service");
const { loadContext, computeForStaff } = require("./payrollEngine.service");
const {
  getTeachersHours,
  getMonthCalendar,
  cutoffForMonth,
} = require("./lessonHours.service");
const { NotFoundError } = require("../utils/errors");

/**
 * Xodim shakli — `STAFF_SELECT` dan FARQLI: bu yerda `positionId` va
 * `salaryCategoryId` ham kerak, chunki qatorlar payroll dvigatelidan
 * o'tadi va u aynan shu ikki maydondan lavozim/toifa summasini topadi.
 */
const DASHBOARD_STAFF_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  role: true,
  isArchived: true,
  positionId: true,
  salaryCategoryId: true,
};

const fullName = (person) =>
  person ? `${person.firstName} ${person.lastName ?? ""}`.trim() : "Noma'lum";

/**
 * Summani odam o'qiydigan ko'rinishga keltiradi ("45 000").
 *
 * ⚠️ `Intl.NumberFormat` ISHLATILMAYDI: natija Node ICU qurilishiga
 * bog'liq bo'lib qolardi (`dates.md` §3 bilan bir xil sabab — u yerda
 * sana, bu yerda ajratgich). Guruhlash qo'lda, natija har muhitda bir xil.
 */
const groupAmount = (value) =>
  new Decimal(value ?? 0)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toFixed(0)
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/**
 * SHARTNOMA FORMULASI — qatordagi ikkinchi qator matni.
 *
 * Komponentlardan quriladi, qoidaning o'zidan emas: fiksa qism lavozim
 * maoshi bilan qo'shilgan bo'lishi mumkin va o'qituvchi ekranda aynan
 * o'ziga to'lanadigan raqamni ko'rishi kerak.
 */
function formulaLabelOf(comp) {
  if (!comp) return null;

  const parts = [];
  if (comp.fixedAmount.greaterThan(0)) parts.push(`${groupAmount(comp.fixedAmount)} so'm`);
  if (comp.perHourRate.greaterThan(0)) {
    parts.push(`${groupAmount(comp.perHourRate)} so'm × soat`);
  }

  return parts.length ? parts.join(" + ") : "Summa belgilanmagan";
}

/**
 * `getTeachersHours` natijasini payroll dvigateli kutadigan shaklga
 * o'tkazadi. `field` — qaysi soat olinishi: `hours` (butun oy) yoki
 * `taughtHours` (bugungacha o'tilgani).
 */
const toEngineHours = (hoursMap, field) => {
  const out = new Map();
  for (const [teacherId, info] of hoursMap) {
    out.set(String(teacherId), {
      hours: info[field] ?? 0,
      weeklyHours: info.weeklyHours ?? 0,
      weeklyLessons: info.weeklyHours ?? 0,
      monthlyLessons: info.teachingDays ?? 0,
    });
  }
  return out;
};

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

/** Fan manbalari tartibi — ro'yxatda avval amalda dars beradigan fanlar. */
const SUBJECT_SOURCE_RANK = { schedule: 0, substitution: 1, profile: 2 };

/**
 * FANLAR — "bu odam qaysi fan o'qituvchisi".
 *
 * Uch manba BIRLASHTIRILADI, chunki har biri boshqa savolga javob beradi:
 *   · jadval shabloni (`schedule`)     — haftalik jadvalda o'z darsi bor fan;
 *   · o'rinbosarlik (`substitution`)   — o'z darsi yo'q, lekin shu oyda
 *                                        kimningdir o'rniga shu fandan chiqqan;
 *   · profil (`profile`)               — `UserSubject` da biriktirilgan,
 *                                        jadvalda esa darsi yo'q.
 *
 * ⚠️ FAQAT JADVAL OLINSA, jadvali hali to'ldirilmagan o'qituvchida fan
 * umuman ko'rinmasdi. FAQAT PROFIL OLINSA, ikkinchi fandan ham dars
 * beradigan o'qituvchining o'sha fani yo'qolardi — oylik soati esa aynan
 * o'sha fandan kelayotgan bo'lishi mumkin.
 *
 * ⚠️ "JADVALDA BORMI" SHABLONDAN aniqlanadi, oyning soatidan EMAS. Ta'til
 * oyida soat nol bo'ladi va oy kesimiga qaralsa, har bir fan
 * "jadvalda yo'q" deb ko'rinib qolardi.
 *
 * ⚠️ O'RINBOSARLIK ALOHIDA BELGILANADI: bir kun fizika darsiga chiqqan
 * matematika o'qituvchisi "fizika o'qituvchisi" bo'lib qolmasligi kerak,
 * lekin o'sha soat pulga kirgani uchun ro'yxatdan ham tushib qolmaydi.
 *
 * @param {object} params
 * @param {Array<{id, name, hours, covered}>} params.bySubject - oy kesimi (`getTeachersHours`)
 * @param {Array<{subjectId, _count: {_all}}>} params.weekly - jadval shabloni, fan bo'yicha
 * @param {Array<{id, name, isActive}>} params.assigned - profildagi fanlar
 * @param {Map<string, string>} params.names - qo'shimcha nomlar (shablondagi, oyda soati yo'q fanlar)
 * @returns {Array<{id, name, hours, weeklyHours, coveredHours, source, isAssigned}>}
 */
function buildSubjects({ bySubject, weekly, assigned, names }) {
  const monthly = new Map(bySubject.filter((row) => row.id).map((row) => [row.id, row]));
  const weeklyMap = new Map(weekly.map((row) => [row.subjectId, row._count._all]));
  const assignedMap = new Map(assigned.map((subject) => [subject.id, subject]));

  const ids = new Set([...weeklyMap.keys(), ...monthly.keys()]);
  // Arxivlangan fan profilda qolib ketgan bo'lsa, u "jadvalda yo'q" bo'lib
  // ko'rinmasin — faqat amalda dars bo'lsa chiqadi.
  for (const subject of assigned) if (subject.isActive) ids.add(subject.id);

  const rows = [...ids].map((id) => {
    const row = monthly.get(id);
    const weeklyHours = weeklyMap.get(id) ?? 0;
    const coveredHours = row?.covered ?? 0;

    return {
      id,
      name: row?.name ?? assignedMap.get(id)?.name ?? names.get(id) ?? "Noma'lum",
      hours: row?.hours ?? 0,
      weeklyHours,
      coveredHours,
      source: weeklyHours > 0 ? "schedule" : coveredHours > 0 ? "substitution" : "profile",
      isAssigned: assignedMap.has(id),
    };
  });

  return rows.sort(
    (a, b) =>
      SUBJECT_SOURCE_RANK[a.source] - SUBJECT_SOURCE_RANK[b.source] ||
      b.hours - a.hours ||
      b.weeklyHours - a.weeklyHours ||
      a.name.localeCompare(b.name, "uz"),
  );
}

/**
 * KIM RO'YXATGA KIRADI.
 *
 * To'rtta manba birlashtiriladi va har biri o'z savoliga javob beradi:
 *   1. dars jadvali      — "darsi bor" (asosiy manba);
 *   2. o'rinbosarlik     — shu oyda kimdir o'rniga chiqqan bo'lsa, uning
 *                          soati bor, lekin jadvalda o'z darsi bo'lmasligi
 *                          mumkin;
 *   3. toifa             — KPI toifasi biriktirilgan, jadvali hali
 *                          to'ldirilmagan o'qituvchi ("nega ro'yxatda
 *                          yo'q" degan savol tug'ilmasligi uchun);
 *   4. oylik qoidasi     — eski qatorlar ham yo'qolmasin.
 *
 * ⚠️ ROLGA TAYANILMAYDI. `User.role` — `Role.value` ga ishora va rollar
 * katalogi filial bo'yicha o'zgaruvchan ("o'qituvchi" boshqa nom bilan
 * bo'lishi mumkin, direktor ham dars berishi mumkin). Jadvalda darsi
 * borligi esa har filialda bir xil ma'noni bildiradi. Faqat o'quvchi
 * ATAYLAB chiqariladi.
 */
async function collectStaff(month) {
  const from = monthStartDate(month);
  const to = monthEndDate(month);

  const [lessonRows, substitutionRows, salaries] = await Promise.all([
    prisma.scheduleLesson.findMany({
      distinct: ["teacherId"],
      select: { teacherId: true },
    }),
    prisma.lessonSubstitution.findMany({
      where: { status: "active", fromDate: { lte: to }, toDate: { gte: from } },
      select: { originalTeacherId: true, substituteTeacherId: true },
    }),
    resolveSalariesForMonth(month),
  ]);

  const ids = new Set();
  for (const row of lessonRows) if (row.teacherId) ids.add(row.teacherId);
  for (const row of substitutionRows) {
    ids.add(row.originalTeacherId);
    ids.add(row.substituteTeacherId);
  }
  for (const staffId of salaries.keys()) ids.add(staffId);

  const staff = await prisma.user.findMany({
    where: {
      isArchived: false,
      role: { not: ROLES.STUDENT },
      OR: [{ id: { in: [...ids] } }, { salaryCategoryId: { not: null } }],
    },
    select: DASHBOARD_STAFF_SELECT,
  });

  return { staff, salaries };
}

/**
 * Bitta o'qituvchi qatori — vedomost va profil bitta shakldan o'qiydi.
 *
 * @param {object} person - `DASHBOARD_STAFF_SELECT` shaklidagi xodim
 * @param {object|null} projected - dvigatel natijasi, BUTUN oy soati bo'yicha
 * @param {object|null} accrued - dvigatel natijasi, BUGUNGACHA o'tilgan soat bo'yicha
 * @param {object|null} hoursRow - `lessonHours.service` natijasi
 * @param {object|null} entry - o'sha oyning MUHRLANGAN majburiyati
 */
function buildRow(person, projected, accrued, hoursRow, entry) {
  const hours = hoursRow?.hours ?? 0;
  const taught = hoursRow?.taughtHours ?? 0;
  // ⚠️ `Decimal(0)` — TRUTHY obyekt. Oddiy `perHourRate ? ... : null`
  // fiksa xodimda "0.00" stavka yozardi va u ekranda ham, Excel'da ham
  // "soatiga 0 so'm" bo'lib ko'rinardi.
  const rate = projected?.perHourRate ?? null;
  const perHourRate = rate && rate.greaterThan(0) ? rate : null;

  return {
    staffId: person.id,
    staff: person,
    staffName: fullName(person),
    role: person.role,

    // ── Shartnoma sharti ──────────────────
    hasRule: Boolean(projected),
    salaryType: projected?.salaryType ?? null,
    salaryTypeLabel: projected
      ? (TYPE_LABELS[projected.salaryType] ?? projected.salaryType)
      : null,
    formulaLabel: formulaLabelOf(projected),
    baseAmount: projected ? formatAmount(projected.fixedAmount) : null,
    hourlyRate: perHourRate ? formatAmount(perHourRate) : null,
    categoryName: projected?.categoryName || null,
    positionName: projected?.positionName || null,
    // Toifa/lavozim qaysi bo'limniki ("Yuqori sinflar") — bir xil nomli
    // toifa har bo'limda boshqa stavka bilan bo'lishi mumkin.
    departmentName: projected?.departmentName || null,
    // Soat PULGA aylanadimi — ustunni ko'rsatish sharti EMAS, faqat
    // "bu odamda soat pul hosil qiladi" belgisi (rang va jami uchun).
    usesHours: Boolean(perHourRate),

    // ── Soat (QOIDADAN QAT'IY NAZAR) ──────
    weeklyHours: hoursRow?.weeklyHours ?? 0,
    scheduledHours: hoursRow?.scheduledHours ?? 0,
    substitutedOutHours: hoursRow?.substitutedOutHours ?? 0,
    substitutedInHours: hoursRow?.substitutedInHours ?? 0,
    hours,
    taughtHours: taught,
    remainingHours: hoursRow?.remainingHours ?? 0,
    // Norma tushunchasi payroll-v2 da YO'Q (KPI stavkasi har soatga
    // to'lanadi, chegara yo'q) — maydon shakl uchun qoladi.
    normProgress: null,
    extraHours: 0,

    // ── Pul (JONLI, muhrlanmagan) ─────────
    accruedAmount: accrued ? formatAmount(accrued.amount) : null,
    projectedAmount: projected ? formatAmount(projected.amount) : null,
    projectedHoursAmount: projected ? formatAmount(projected.kpiAmount) : null,
    fixedAmount: projected ? formatAmount(projected.fixedAmount) : null,
    allowanceAmount: projected ? formatAmount(projected.allowanceAmount) : null,

    // ── Muhrlangan majburiyat (agar bor bo'lsa) ──
    entryId: entry?.id ?? null,
    entryStatus: entry?.status ?? null,
    sealedAmount: entry ? formatAmount(entry.amount) : null,
  };
}

/**
 * VEDOMOST YADROSI — qatorlar, kalendar va muhrlangan majburiyatlar.
 * `getOverview` ham, `getLedger` ham SHU funksiyadan o'qiydi: ikki ekran
 * bir xil raqamni ko'rsatishi kerak, ikkita mustaqil yig'uvchi bo'lsa
 * ular vaqt o'tib bir-biridan uzoqlashardi.
 */
async function buildLedger(month) {
  const cutoff = cutoffForMonth(month);
  const { staff, salaries } = await collectStaff(month);
  const staffIds = staff.map((p) => p.id);

  const [hoursMap, calendar, entries] = await Promise.all([
    getTeachersHours(staffIds, month, { asOfDayOfMonth: cutoff }),
    getMonthCalendar(month, { asOfDayOfMonth: cutoff }),
    staffIds.length
      ? prisma.payrollEntry.findMany({
          where: { month, staffId: { in: staffIds } },
          select: { id: true, staffId: true, status: true, amount: true },
        })
      : [],
  ]);

  const entryMap = new Map(entries.map((e) => [e.staffId, e]));

  // Ikki kontekst, BITTA dvigatel: farq faqat soatda. Shu tufayli
  // "hozirgacha" va "oy oxirida" ustunlari bir xil formuladan chiqadi —
  // ustama foizlari ham ikkalasida to'g'ri qayta hisoblanadi.
  const ctx = await loadContext(month, staff, {
    salaryRules: salaries,
    hoursMap: toEngineHours(hoursMap, "hours"),
  });
  const accruedCtx = { ...ctx, hoursMap: toEngineHours(hoursMap, "taughtHours") };

  const rows = staff
    .map((person) =>
      buildRow(
        person,
        computeForStaff(person, month, ctx),
        computeForStaff(person, month, accruedCtx),
        hoursMap.get(person.id),
        entryMap.get(person.id),
      ),
    )
    .sort((a, b) => b.hours - a.hours || a.staffName.localeCompare(b.staffName));

  return { rows, calendar, cutoff, entries, hoursMap };
}

/**
 * BOSHLIQ KO'RINISHI — bir oy, butun maktab.
 *
 * @param {number} month - YYYYMM
 * @returns {Promise<object>}
 */
async function getOverview(month) {
  const { rows, calendar, cutoff, entries, hoursMap } = await buildLedger(month);

  // ── Rejimlar kesimi ─────────────────────
  // "Belgilanmagan" ALOHIDA bucket: rahbar uchun "nechta o'qituvchi dars
  // beryapti-yu, oyligi hali biriktirilmagan" — shu ekranning eng muhim
  // ogohlantirishi. Uni ro'yxatdan tashqarida qoldirish jim bo'shliq edi.
  const byMode = new Map(
    Object.keys(TYPE_LABELS).map((key) => [
      key,
      { type: key, label: TYPE_LABELS[key], staffCount: 0, hours: 0, amounts: [] },
    ]),
  );
  byMode.set("none", {
    type: "none",
    label: "Belgilanmagan",
    staffCount: 0,
    hours: 0,
    amounts: [],
  });

  for (const row of rows) {
    const bucket = byMode.get(row.salaryType ?? "none");
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

  // ⚠️ JAMI SOAT — BARCHA qatordan, `usesHours` filtrisiz. Maktab olgan
  // soat oylik qoidasi biriktirilgan-biriktirilmaganiga bog'liq emas.
  const totalHours = rows.reduce((sum, r) => sum + r.hours, 0);
  const taughtHours = rows.reduce((sum, r) => sum + r.taughtHours, 0);
  const teachingStaff = rows.filter((r) => r.hours > 0);

  const projectedTotal = sumAmounts(rows.map((r) => r.projectedAmount).filter(Boolean));
  const accruedTotal = sumAmounts(rows.map((r) => r.accruedAmount).filter(Boolean));
  const sealedTotal = sumAmounts(entries.map((e) => e.amount));

  // Kunlik egri chiziq — barcha o'qituvchilarning kunlik soatlari
  // qo'shiladi. Nuqtalar soni oy uzunligiga TENG: `getTeachersHours` har
  // bir kalendar kuni uchun nuqta qaytaradi (bayram — nol soat), ya'ni
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

  // BIR SOATNING O'RTACHA TANNARXI — byudjet uchun eng qisqa ko'rsatkich.
  //
  // ⚠️ SURAT VA MAXRAJ BITTA TO'PLAMDAN. Faqat soatdan pul chiqadigan
  // xodimlar olinadi: maxrajga butun maktab soati, suratga esa faqat
  // KPI to'lovi qo'yilsa, raqam bir necha barobar past chiqardi.
  const paidByHours = rows.filter((r) => r.usesHours);
  const paidHours = paidByHours.reduce((sum, r) => sum + r.hours, 0);

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
      // "Dars beruvchi" = jadvalda soati bor. Oylik rejimi bilan aloqasi yo'q.
      hourlyStaffCount: teachingStaff.length,
      unassignedCount: rows.filter((r) => r.hours > 0 && !r.hasRule).length,
      totalHours,
      taughtHours,
      remainingHours: Math.max(0, totalHours - taughtHours),
      substitutedHours: rows.reduce((sum, r) => sum + r.substitutedInHours, 0),
      // Jonli prognoz — muhrlangan qarz EMAS
      projectedAmount: formatAmount(projectedTotal),
      accruedAmount: formatAmount(accruedTotal),
      sealedAmount: formatAmount(sealedTotal),
      sealedCount: entries.length,
      averageHourCost:
        paidHours > 0
          ? formatAmount(
              sumAmounts(paidByHours.map((r) => r.projectedAmount ?? "0")).div(paidHours),
            )
          : null,
      substitutionCount,
      ongoingSubstitutions: ongoingCount,
    },
    modes,
    series,
    // Eng ko'p yuklamali o'nlik — butun ro'yxat vedomost sahifasida
    topTeachers: teachingStaff.slice(0, 10),
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
  const { rows: allRows, calendar, cutoff } = await buildLedger(month);

  let rows = allRows;

  // `type` filtri: "none" — oyligi belgilanmaganlar (ular uchun
  // `salaryType` null, ya'ni oddiy tenglik ishlamaydi).
  if (query.type) {
    rows =
      query.type === "none"
        ? rows.filter((r) => !r.salaryType)
        : rows.filter((r) => r.salaryType === query.type);
  }
  if (query.withHoursOnly === "true") rows = rows.filter((r) => r.hours > 0);

  if (query.search) {
    const needle = String(query.search).trim().toLowerCase();
    rows = rows.filter(
      (r) =>
        r.staffName.toLowerCase().includes(needle) ||
        r.staff.username?.toLowerCase().includes(needle),
    );
  }

  return {
    month,
    monthLabel: formatMonthKey(month),
    isCurrentMonth: month === currentMonthKey(),
    isVacationMonth: calendar.isVacationMonth,
    cutoffDay: cutoff,
    teachingDays: calendar.teachingDays,
    items: rows,
    totals: {
      staffCount: rows.length,
      totalHours: rows.reduce((sum, r) => sum + r.hours, 0),
      taughtHours: rows.reduce((sum, r) => sum + r.taughtHours, 0),
      unassignedCount: rows.filter((r) => r.hours > 0 && !r.hasRule).length,
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
  // ⚠️ `assertTeacher` O'RNIGA TO'G'RIDAN-TO'G'RI O'QISH: payroll dvigateli
  // `positionId` va `salaryCategoryId` ni talab qiladi, `TEACHER_SELECT`
  // da esa ular yo'q — ularsiz har bir o'qituvchi "oyligi yo'q" bo'lib
  // ko'rinardi.
  const teacher = await prisma.user.findUnique({
    where: { id: teacherId },
    select: DASHBOARD_STAFF_SELECT,
  });

  if (!teacher || teacher.role === ROLES.STUDENT) {
    throw new NotFoundError("O'qituvchi topilmadi");
  }

  const cutoff = cutoffForMonth(month);
  const salaries = await resolveSalariesForMonth(month);

  const [hoursMap, entry, substitutions, weeklySubjects, assignedSubjects] = await Promise.all([
    getTeachersHours([teacher.id], month, { asOfDayOfMonth: cutoff }),
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
    prisma.scheduleLesson.groupBy({
      by: ["subjectId"],
      where: { teacherId: teacher.id },
      _count: { _all: true },
    }),
    prisma.userSubject.findMany({
      where: { userId: teacher.id },
      select: { subject: { select: { id: true, name: true, isActive: true } } },
    }),
  ]);

  const hoursRow = hoursMap.get(teacher.id);

  // Shablonda bor-u shu oyda soati yo'q fan (ta'til oyi) nomsiz qolmasin
  const bySubject = hoursRow?.bySubject ?? [];
  const assigned = assignedSubjects.map((row) => row.subject);
  const knownIds = new Set([...bySubject.map((row) => row.id), ...assigned.map((s) => s.id)]);
  const unnamedIds = weeklySubjects.map((row) => row.subjectId).filter((id) => !knownIds.has(id));
  const extraNames = unnamedIds.length
    ? await prisma.subject.findMany({
        where: { id: { in: unnamedIds } },
        select: { id: true, name: true },
      })
    : [];

  const ctx = await loadContext(month, [teacher], {
    salaryRules: salaries,
    hoursMap: toEngineHours(hoursMap, "hours"),
  });
  const accruedCtx = { ...ctx, hoursMap: toEngineHours(hoursMap, "taughtHours") };

  const row = buildRow(
    teacher,
    computeForStaff(teacher, month, ctx),
    computeForStaff(teacher, month, accruedCtx),
    hoursRow,
    entry,
  );

  // Oylik tarix — oxirgi 6 oy, egri chiziq uchun
  const history = await prisma.payrollEntry.findMany({
    where: { staffId: teacher.id, status: { not: "cancelled" } },
    orderBy: { month: "desc" },
    take: 6,
    select: {
      month: true,
      amount: true,
      lessonHours: true,
      kpiAmount: true,
      fixedAmount: true,
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
    bySubject,
    subjects: buildSubjects({
      bySubject,
      weekly: weeklySubjects,
      assigned,
      names: new Map(extraNames.map((s) => [s.id, s.name])),
    }),
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
        // Muhrlangan majburiyatning v2 komponentlari: fiksa qism va
        // soatdan chiqqan (KPI) qism.
        baseAmount: formatAmount(h.fixedAmount),
        hoursAmount: formatAmount(h.kpiAmount),
        hoursWorked: Number(h.lessonHours),
        status: h.status,
      }))
      .reverse(),
  };
}

/**
 * VEDOMOST → EXCEL.
 *
 * ⚠️ QATORLAR TAYYOR HOLDA KELADI (`getLedger` natijasi) — bu yerda
 * hech narsa qayta hisoblanmaydi. Excel ekranning NUSXASI bo'lishi
 * kerak: ikkinchi yig'uvchi yozilsa, bir kuni faylda boshqa raqam
 * chiqib, "qaysinisi to'g'ri" degan savolga javob qolmasdi.
 *
 * ⚠️ PUL MATN EMAS, SON bo'lib yoziladi (`Number(...)`): Excel'da
 * ustunni yig'ish va saralash kerak bo'ladi, string esa buni
 * imkonsiz qilardi. Ko'rinishi `numFmt` bilan beriladi.
 *
 * @param {import("express").Response} res
 * @param {object} data - `getLedger` qaytargan obyekt
 */
async function exportLedgerToExcel(res, data) {
  const ExcelService = require("./excel.service");

  const columns = [
    { header: "№", key: "no", width: 6 },
    { header: "O'qituvchi", key: "staffName", width: 26 },
    { header: "Login", key: "username", width: 16 },
    { header: "Oylik rejimi", key: "salaryTypeLabel", width: 16 },
    { header: "Formula", key: "formulaLabel", width: 26 },
    { header: "Haftasiga", key: "weeklyHours", width: 11 },
    { header: "Oyiga", key: "hours", width: 10 },
    { header: "O'tildi", key: "taughtHours", width: 10 },
    { header: "Qoldi", key: "remainingHours", width: 10 },
    { header: "Berildi", key: "substitutedOutHours", width: 10 },
    { header: "Olindi", key: "substitutedInHours", width: 10 },
    { header: "Stavka", key: "hourlyRate", width: 14 },
    { header: "Hisoblandi", key: "accruedAmount", width: 16 },
    { header: "Oy oxirida", key: "projectedAmount", width: 16 },
  ];

  const workbook = ExcelService.createWorkbook();
  const worksheet = ExcelService.addWorksheet(workbook, "Dars soatlari", {
    freezeHeader: false,
  });

  // ── Sarlavha bloki (2 qator) ─────────────
  worksheet.mergeCells(1, 1, 1, columns.length);
  const titleCell = worksheet.getCell(1, 1);
  titleCell.value = `Dars soatlari vedomosti — ${data.monthLabel}`;
  titleCell.font = { bold: true, size: 14, color: { argb: "FF1F2937" } };
  titleCell.alignment = { vertical: "middle", horizontal: "left" };
  worksheet.getRow(1).height = 26;

  worksheet.mergeCells(2, 1, 2, columns.length);
  const subCell = worksheet.getCell(2, 1);
  const unassigned = data.totals.unassignedCount
    ? ` · Oyligi biriktirilmagan: ${data.totals.unassignedCount} ta`
    : "";
  subCell.value =
    `Xodim: ${data.totals.staffCount} ta · Jami soat: ${data.totals.totalHours}` +
    ` · O'tildi: ${data.totals.taughtHours}` +
    (data.isVacationMonth ? " · TA'TIL OYI" : "") +
    unassigned;
  subCell.font = { size: 11, color: { argb: "FF6B7280" } };
  worksheet.getRow(2).height = 20;

  // ── Ustun sarlavhalari (4-qator, 3-si ajratgich) ──
  const headerRowIndex = 4;
  columns.forEach((c, i) => {
    worksheet.getColumn(i + 1).width = c.width;
  });

  const headerRow = worksheet.getRow(headerRowIndex);
  headerRow.values = columns.map((c) => c.header);
  headerRow.height = 22;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: "FFD0D0D0" } },
      left: { style: "thin", color: { argb: "FFD0D0D0" } },
      bottom: { style: "thin", color: { argb: "FFD0D0D0" } },
      right: { style: "thin", color: { argb: "FFD0D0D0" } },
    };
  });

  const MONEY_FMT = "#,##0";
  const moneyCols = new Set(["hourlyRate", "accruedAmount", "projectedAmount"]);
  const hourCols = new Set([
    "weeklyHours",
    "hours",
    "taughtHours",
    "remainingHours",
    "substitutedOutHours",
    "substitutedInHours",
  ]);

  // Bo'sh summa NOL EMAS, bo'sh katak: oyligi biriktirilmagan
  // o'qituvchida "0 so'm" yozilsa, u "bepul ishlaydi" deb o'qilardi.
  const money = (value) => (value == null ? null : Number(value));

  data.items.forEach((row, index) => {
    const excelRow = worksheet.addRow(
      columns.map((c) => {
        switch (c.key) {
          case "no":
            return index + 1;
          case "username":
            return row.staff?.username ?? "";
          case "salaryTypeLabel":
            return row.salaryTypeLabel ?? "Belgilanmagan";
          case "formulaLabel":
            return row.formulaLabel ?? "—";
          case "hourlyRate":
          case "accruedAmount":
          case "projectedAmount":
            return money(row[c.key]);
          default:
            return row[c.key];
        }
      }),
    );

    if (index % 2 === 0) {
      excelRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F6FC" } };
    }

    excelRow.eachCell((cell, colNumber) => {
      const col = columns[colNumber - 1];
      cell.border = {
        top: { style: "thin", color: { argb: "FFE5E7EB" } },
        left: { style: "thin", color: { argb: "FFE5E7EB" } },
        bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
        right: { style: "thin", color: { argb: "FFE5E7EB" } },
      };
      cell.alignment = {
        vertical: "middle",
        horizontal:
          moneyCols.has(col.key) || hourCols.has(col.key)
            ? "right"
            : col.key === "no"
              ? "center"
              : "left",
      };
      if (moneyCols.has(col.key)) cell.numFmt = MONEY_FMT;
      if (col.key === "hours") cell.font = { bold: true };
      if (col.key === "projectedAmount") {
        cell.font = { bold: true, color: { argb: "FF1F2937" } };
      }
      // Oyligi biriktirilmagan qator ko'zga tashlanib tursin
      if (col.key === "salaryTypeLabel" && !row.hasRule) {
        cell.font = { bold: true, color: { argb: "FFB91C1C" } };
      }
    });
  });

  // ── Jami qatori ──────────────────────────
  const totalRow = worksheet.addRow(
    columns.map((c) => {
      switch (c.key) {
        case "formulaLabel":
          return "JAMI:";
        case "weeklyHours":
          return data.items.reduce((sum, r) => sum + r.weeklyHours, 0);
        case "hours":
          return data.totals.totalHours;
        case "taughtHours":
          return data.totals.taughtHours;
        case "accruedAmount":
          return money(data.totals.accruedAmount);
        case "projectedAmount":
          return money(data.totals.projectedAmount);
        default:
          return null;
      }
    }),
  );

  totalRow.eachCell((cell, colNumber) => {
    const col = columns[colNumber - 1];
    if (cell.value == null) return;
    cell.font = { bold: true, color: { argb: "FF1F2937" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } };
    cell.alignment = {
      vertical: "middle",
      horizontal: col.key === "formulaLabel" ? "right" : "right",
    };
    if (moneyCols.has(col.key)) cell.numFmt = MONEY_FMT;
  });

  worksheet.autoFilter = {
    from: { row: headerRowIndex, column: 1 },
    to: { row: headerRowIndex, column: columns.length },
  };
  worksheet.views = [{ state: "frozen", ySplit: headerRowIndex }];

  // Fayl nomida OY turadi: bir nechta oy yuklab olinganda ular
  // bir-birini almashtirmasligi kerak.
  const filename = ExcelService.generateFileName(`dars-soatlari_${data.month}`);
  await ExcelService.sendWorkbook(res, workbook, filename);
}

module.exports = {
  buildRow,
  getOverview,
  getLedger,
  getTeacherDetail,
  exportLedgerToExcel,
};
