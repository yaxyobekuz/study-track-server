/**
 * OYLIK QANDAY HISOBLANDI — bitta xodimning bitta oyi (o'qituvchi profili →
 * "Oylik" → "Batafsil").
 *
 * Xodim uchta savolga javob oladi:
 *   · QANCHA VAQT UCHUN — oyning ish kunlari, dars soati (reja / o'tildi /
 *     o'tilmadi) va ularning narxi (1 ish kuni, 1 dars soati);
 *   · QANCHA OYLIK — tarkib zanjiri:
 *       fiksa + dars soati × narx + ustamalar
 *       − kelmagan kunlar − to'xtatilgan − ushlab qolingan = oylik
 *     (`financeReconcile` invarianti 6 bilan AYNI tenglik);
 *   · NEGA KAM — har bir kamayish SABABI va KUNI bilan (`reasons`): kelmagan
 *     ish kuni (fiksadan kunlik summa), o'tilmagan dars (kelmagan / sababli /
 *     baho qo'yilmagan) va o'rinbosarga berilgan dars (dars soati narxi),
 *     butun oyga tegishlilari (to'xtatish, ushlab qolish) — alohida.
 *
 * ⚠️ MUHRLANGAN OY MUHRDAN O'QILADI. Majburiyat shakllangan bo'lsa zanjir
 * uning MUHRLANGAN qismlaridan quriladi (`PayrollEntry` doktrinasi): qoida
 * keyin o'zgarsa ham xodim o'sha oy aynan qanday hisoblanganini ko'radi.
 * Shakllanmagan oy — `payrollEngine` dan jonli (vedomost bilan AYNI).
 *
 * ⚠️ O'TILMAGAN DARSLAR MUHRDA YO'Q — ular dars soati hisobidan (jonli,
 * `getTeacherHours`) olinadi: majburiyatda faqat pul yozilgan soat
 * muhrlanadi. Muhrlangandan keyin davomat yoki baho o'zgargan bo'lsa (soat
 * mos kelmasa) bu yashirilmaydi — `hoursDrift` qaytadi, summa esa
 * muhrdagidek qoladi.
 *
 * ⚠️ PUL FORMULASI BU YERDA YOZILMAYDI. Zanjirning har bir qismi dvigateldan
 * yoki muhrdan keladi; bu fayl faqat ularni tushuntirish uchun yig'adi.
 * Yagona hisob — kunlik o'tilmagan dars summasi (`soat × dars soati narxi`),
 * bu esa dvigateldagi KPI formulasining (`perHourRate × hours`) aynan o'zi.
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { currentMonthKey, formatMonthKey } = require("../helpers/month.helpers");
const { Decimal, formatAmount } = require("../helpers/money.helpers");
const { formatDateUz } = require("../helpers/date.helpers");
const { dayKey } = require("../helpers/lessonHours");
const { resolveSalariesForMonth, TYPE_LABELS } = require("./staffSalary.service");
const payrollEngine = require("./payrollEngine.service");
const { getTeacherHours, getMonthCalendar, cutoffForMonth } = require("./lessonHours.service");
const { REASON_LABELS: SUBSTITUTION_REASON_LABELS } = require("./lessonSubstitution.service");
const { serializeAbsence, loadWorkDays } = require("./payrollAbsence.service");
const { PAYROLL_USER_SELECT, STATUS_LABELS } = require("./payroll.service");

const round2 = (d) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const asArray = (value) => (Array.isArray(value) ? value : []);
const positive = (row) => new Decimal(row?.amount || 0).greaterThan(0);

/**
 * Zanjir qismlari — muhrdan. Yalpi qismlar va ayirmalar alohida-alohida:
 * amount = fixed + kpi + allowance − absence − suspended − deduction.
 */
const fromEntry = (entry) => ({
  salaryType: entry.salaryType,
  fixedAmount: new Decimal(entry.fixedAmount ?? 0),
  kpiAmount: new Decimal(entry.kpiAmount ?? 0),
  lessonHours: Number(entry.lessonHours ?? 0),
  perHourRate: new Decimal(entry.perHourRate ?? 0),
  allowanceAmount: new Decimal(entry.allowanceAmount ?? 0),
  allowanceBreakdown: asArray(entry.allowanceBreakdown),
  absenceAmount: new Decimal(entry.absenceAmount ?? 0),
  absenceBreakdown: entry.absenceBreakdown,
  suspendedAmount: new Decimal(entry.suspendedAmount ?? 0),
  suspensionBreakdown: asArray(entry.suspensionBreakdown),
  deductionAmount: new Decimal(entry.deductionAmount ?? 0),
  deductionBreakdown: asArray(entry.deductionBreakdown),
  amount: new Decimal(entry.amount),
  positionName: entry.positionName || "",
  categoryName: entry.categoryName || "",
});

/** Zanjir qismlari — dvigatelning jonli natijasidan (shakllanmagan oy). */
const fromComputed = (c) => ({
  salaryType: c.salaryType,
  fixedAmount: c.fixedAmount,
  kpiAmount: c.kpiAmount,
  lessonHours: Number(c.lessonHours),
  perHourRate: c.perHourRate,
  allowanceAmount: c.allowanceAmount,
  allowanceBreakdown: c.allowanceBreakdown,
  absenceAmount: c.absenceAmount,
  absenceBreakdown: c.absenceBreakdown,
  suspendedAmount: c.suspendedAmount,
  suspensionBreakdown: c.suspensionBreakdown,
  deductionAmount: c.deductionAmount,
  deductionBreakdown: c.deductionBreakdown,
  amount: c.amount,
  positionName: c.positionName || "",
  categoryName: c.categoryName || "",
});

/**
 * Darslar KUNLAR KESIMIDA — "qaysi kuni, qaysi dars va qancha". Kun summasi =
 * shu kungi soat × 1 dars soati narxi (dvigateldagi KPI formulasining o'zi).
 *
 * ⚠️ Sana matni SERVERDA (`dateLabel`): dars kuni — UTC yarim tuni
 * (`dates.md` §4), brauzerda o'qilsa kun siljirdi.
 *
 * @param {Array} lessons - `getTeachersHours(...)` dagi dars qatorlari
 * @param {Decimal} rate - 1 dars soati narxi
 * @param {(lesson: object) => object} shape - ekranga chiqadigan dars shakli
 */
const groupLessonsByDay = (lessons, rate, shape) => {
  const byDay = new Map();
  for (const lesson of lessons) {
    const key = dayKey(new Date(lesson.date));
    let day = byDay.get(key);
    if (!day) {
      day = {
        date: key,
        dateLabel: lesson.dateLabel ?? formatDateUz(new Date(`${key}T00:00:00Z`), { utc: true }),
        lessons: [],
      };
      byDay.set(key, day);
    }
    day.lessons.push(shape(lesson));
  }

  return [...byDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => {
      day.lessons.sort((a, b) => a.lessonOrder - b.lessonOrder);
      return {
        ...day,
        hours: day.lessons.length,
        amount: formatAmount(round2(rate.times(day.lessons.length))),
      };
    });
};

/** O'tilmagan darslar kunlar kesimida — sababi bilan. */
const groupMissedByDay = (lessons, rate) =>
  groupLessonsByDay(lessons, rate, (lesson) => ({
    className: lesson.className,
    subjectName: lesson.subjectName,
    lessonOrder: lesson.lessonOrder,
    reason: lesson.reason,
    reasonLabel: lesson.reasonLabel,
    autoMarked: Boolean(lesson.autoMarked),
    substituted: Boolean(lesson.substituted),
  }));

/**
 * NEGA KAM — barcha KUNLIK sabablar bitta xronologik ro'yxatda: kelmagan kun
 * (fiksadan), o'tilmagan darslar va o'rinbosarga berilgan darslar. Bir kunda
 * bir nechta sabab bo'lishi mumkin (aralash oylikda kelmagan kun fiksadan
 * HAM, o'sha kungi darslar soatidan HAM ayriladi) — ular yonma-yon turadi.
 *
 * Summalar qismlarning o'zidan (kelmagan kun — muhrdagi/dvigateldagi kun
 * summasi, darslar — `soat × narx`); kun jami shu qatorlar yig'indisi.
 *
 * @returns {{ days: Array, total: Decimal }}
 */
const buildReasonDays = ({ absence, missedLessons, substitutedOut }) => {
  const byDay = new Map();
  const dayOf = (date, dateLabel) => {
    let day = byDay.get(date);
    if (!day) {
      day = { date, dateLabel, items: [], total: new Decimal(0) };
      byDay.set(date, day);
    }
    return day;
  };

  for (const row of absence?.days ?? []) {
    if (!positive(row)) continue;
    const day = dayOf(row.date, row.dateLabel);
    day.items.push({ kind: "absence", status: row.status, statusLabel: row.statusLabel, amount: row.amount });
    day.total = day.total.plus(row.amount);
  }
  for (const [kind, block] of [["missed", missedLessons], ["substituted", substitutedOut]]) {
    for (const row of block?.days ?? []) {
      const day = dayOf(row.date, row.dateLabel);
      day.items.push({ kind, hours: row.hours, amount: row.amount, lessons: row.lessons });
      day.total = day.total.plus(row.amount);
    }
  }

  let total = new Decimal(0);
  const days = [...byDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ total: dayTotal, ...day }) => {
      total = total.plus(dayTotal);
      return { ...day, amount: formatAmount(dayTotal) };
    });
  return { days, total };
};

/**
 * Bitta oy hisobi — xodimning O'ZI uchun (profil). Kelgusi oy rad etiladi:
 * u hali majburiyat ham, fakt ham emas.
 *
 * @param {string} staffId - HAR DOIM `req.user.id` (o'zganikini olib bo'lmaydi)
 * @param {number} month - YYYYMM
 */
const getMonthBreakdown = async (staffId, month) => {
  const current = currentMonthKey();
  if (month > current) {
    throw new BadRequestError("Kelgusi oy uchun oylik hisobi hali yo'q");
  }

  const user = await prisma.user.findUnique({
    where: { id: staffId },
    select: PAYROLL_USER_SELECT,
  });
  if (!user) throw new NotFoundError("Xodim topilmadi");

  const [salaryRules, entry] = await Promise.all([
    resolveSalariesForMonth(month),
    prisma.payrollEntry.findFirst({
      where: { staffId, month, status: { not: "cancelled" } },
      include: {
        allocations: {
          where: { isVoided: false },
          orderBy: { appliedAt: "asc" },
          include: { payment: { select: { paidAt: true } } },
        },
      },
    }),
  ]);

  // ── Dars soati — faqat soat pulga aylanadigan xodimda ──
  // Ro'yxat dvigatelning o'zidan (`hourlyStaffIds`) yoki muhrdagi narxdan:
  // shartnoma keyin fiksaga o'tgan bo'lsa ham muhrlangan soatbay oy
  // tushuntirishsiz qolmasin.
  const sealedRate = new Decimal(entry?.perHourRate ?? 0);
  const needsHours =
    payrollEngine.hourlyStaffIds([user], salaryRules).length > 0 || sealedRate.greaterThan(0);
  const hoursInfo = needsHours
    ? await getTeacherHours(user.id, month, { asOfDayOfMonth: cutoffForMonth(month) })
    : null;

  // Soat BIR MARTA o'qiladi, undan ikki kontekst (vedomost bilan AYNI):
  //   oy oxirida = o'tildi + qoldi (pul yoziladigan soat)
  //   reja       = o'tildi + o'tilmadi + qoldi (dars qoldirilmaganda)
  const liveHours = hoursInfo?.hours ?? 0;
  const missedHours = hoursInfo?.missedHours ?? 0;
  const hoursMapOf = (hours) =>
    new Map([[String(user.id), payrollEngine.toEngineHours(hoursInfo, hours)]]);

  const ctx = await payrollEngine.loadContext(month, [user], {
    salaryRules,
    hoursMap: hoursMapOf(liveHours),
  });
  const projected = payrollEngine.computeForStaff(user, month, ctx);
  const planned =
    projected && missedHours > 0
      ? payrollEngine.computeForStaff(user, month, { ...ctx, hoursMap: hoursMapOf(liveHours + missedHours) })
      : projected;

  const head = {
    month,
    monthLabel: formatMonthKey(month),
    isCurrentMonth: month === current,
    isSealed: Boolean(entry),
    hasSalary: Boolean(projected || entry),
  };
  if (!head.hasSalary) return head;

  const src = entry ? fromEntry(entry) : fromComputed(projected);
  const rate = src.perHourRate;
  const grossAmount = src.fixedAmount.plus(src.kpiAmount).plus(src.allowanceAmount);

  // ── Ushlab qolish — sabab va izoh qoidaning o'zidan ──
  const deductionRows = src.deductionBreakdown.filter(positive);
  const deductionRules = deductionRows.length
    ? await prisma.payrollDeduction.findMany({
        where: { id: { in: deductionRows.map((row) => row.id).filter(Boolean) } },
        select: { id: true, reason: true, note: true },
      })
    : [];
  const ruleMap = new Map(deductionRules.map((rule) => [rule.id, rule]));

  // ── Kelmagan kunlar va oyning ish kunlari — faqat FIKSA qism bo'lsa ──
  // ⚠️ Fiksasiz (sof soatbay) xodimda ayirma tafsiloti ham yoziladi, lekin
  // kunlik summa 0: "kelmagan kun − 0 so'm" chalg'itardi. Uning kelmagan
  // kuni o'tilmagan darslarda (sabab "Kelmagan") ko'rinadi.
  const hasFixed = src.fixedAmount.greaterThan(0);
  const absence = hasFixed ? serializeAbsence(src.absenceBreakdown, src.absenceAmount) : null;
  let workDays = absence?.workDays ?? null;
  if (workDays == null && hasFixed) {
    workDays = (await loadWorkDays(month)).length;
  }

  // ── O'tilmagan darslar — pulga ta'siri faqat soat narxi bo'lsa ──
  // Jonli raqam MUHRGA MOS bo'lsagina (bir xil soat va summa) dvigatel
  // farqi olinadi: u foizli ustama va ushlab qolish ta'sirini ham o'z
  // ichiga oladi. Mos bo'lmasa (muhrdan keyin nimadir o'zgargan) — faqat
  // `soat × narx`, chunki boshqa shartnoma bilan hisoblangan farq muhrga
  // tegishli bo'lmasdi.
  // ⚠️ Faqat muhrda soat PULGA aylangan bo'lsa: fiksa bilan muhrlangan oyda
  // soat 0 yozilgan va u "farq" emas.
  const hoursDrift =
    entry && hoursInfo && rate.greaterThan(0) && src.lessonHours !== liveHours
      ? { sealedHours: src.lessonHours, liveHours }
      : null;
  const comparable =
    Boolean(projected && planned) &&
    (!entry || (!hoursDrift && projected.amount.equals(src.amount)));

  let missedLessons = null;
  if (hoursInfo && rate.greaterThan(0) && missedHours > 0) {
    const lessonsAmount = round2(rate.times(missedHours));
    const effect = comparable
      ? Decimal.max(planned.amount.minus(projected.amount), 0)
      : lessonsAmount;

    missedLessons = {
      hours: missedHours,
      perHourRate: formatAmount(rate),
      // Dars soatidan: o'tilmagan soat × 1 dars soati narxi
      lessonsAmount: formatAmount(lessonsAmount),
      // Jami kamayish — foizli ustama / to'xtatish / ushlab qolish ta'siri bilan
      amount: formatAmount(effect),
      otherAmount: formatAmount(effect.minus(lessonsAmount)),
      // Dars qoldirilmaganda oylik (faqat jonli raqam muhrga mos bo'lsa)
      plannedAmount: comparable ? formatAmount(planned.amount) : null,
      byReason: hoursInfo.missedByReason ?? { absent: 0, excused: 0, noGrade: 0 },
      days: groupMissedByDay(hoursInfo.missedLessons ?? [], rate),
    };
  }

  // ── O'rinbosarga berilgan darslar — soat egasidan AYIRILADI ──
  // (o'rinbosarga qo'shiladi, `education.md` §8). Pulga ta'siri faqat soat
  // narxi bo'lsa; kim o'tgani va sababi o'rinbosarlik yozuvining o'zidan.
  const outLessons = hoursInfo?.substitutedOutLessons ?? [];
  let substitutedOut = null;
  if (rate.greaterThan(0) && outLessons.length > 0) {
    const ids = [...new Set(outLessons.map((lesson) => lesson.substitutionId).filter(Boolean))];
    const rows = ids.length
      ? await prisma.lessonSubstitution.findMany({
          where: { id: { in: ids } },
          select: { id: true, reason: true, teacherSnapshot: true },
        })
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));

    substitutedOut = {
      hours: outLessons.length,
      perHourRate: formatAmount(rate),
      amount: formatAmount(round2(rate.times(outLessons.length))),
      days: groupLessonsByDay(outLessons, rate, (lesson) => {
        const row = byId.get(lesson.substitutionId);
        return {
          className: lesson.className,
          subjectName: lesson.subjectName,
          lessonOrder: lesson.lessonOrder,
          substituteName: row?.teacherSnapshot?.substitute?.name || "Noma'lum",
          reasonLabel: SUBSTITUTION_REASON_LABELS[row?.reason] ?? "",
        };
      }),
    };
  }

  // ── Bayram kunlari — soatbay oylikda dars ham, soat ham yo'q (ma'lumot) ──
  // Ayirma EMAS (reja ularsiz tuziladi), lekin "nega bu oy soat kam" degan
  // savolga javob. Yakshanba bayrami sanalmaydi — u kuni dars baribir yo'q.
  let holidays = [];
  if (hoursInfo && rate.greaterThan(0) && !hoursInfo.isVacationMonth) {
    const { holidaySet } = await getMonthCalendar(month);
    const prefix = `${Math.trunc(month / 100)}-${String(month % 100).padStart(2, "0")}-`;
    holidays = [...holidaySet]
      .filter((key) => key.startsWith(prefix))
      .map((key) => new Date(`${key}T00:00:00Z`))
      .filter((date) => date.getUTCDay() !== 0)
      .sort((a, b) => a - b)
      .map((date) => ({ date: dayKey(date), dateLabel: formatDateUz(date, { utc: true }) }));
  }

  // ── NEGA KAM — kunlik sabablar + butun oyga tegishlilari ──
  // Jami = ekranda ko'rinadigan har bir qator yig'indisi (kunlar, to'xtatish,
  // ushlab qolish, foizli ustama ta'siri) — "qayerdan shuncha" ochiq qolmasin.
  const reasonDays = buildReasonDays({ absence, missedLessons, substitutedOut });
  const reasonsTotal = reasonDays.total
    .plus(src.suspendedAmount)
    .plus(src.deductionAmount)
    .plus(missedLessons ? new Decimal(missedLessons.otherAmount) : 0);

  const paid = new Decimal(entry?.paidAmount ?? 0);
  const debt = src.amount.minus(paid);

  return {
    ...head,
    salaryType: src.salaryType,
    salaryTypeLabel: TYPE_LABELS[src.salaryType] ?? src.salaryType,
    positionName: src.positionName || null,
    categoryName: src.categoryName || null,

    // ── QANCHA VAQT UCHUN ──
    work: {
      // Oyning ish kunlari (yakshanba va bayramsiz) — fiksa shunga bo'linadi
      workDays,
      // 1 ish kuni (kelmagan kun ayirmasi amalda bo'lgan oyda)
      dailyRate: absence?.dailyRate ?? null,
      absentDays: absence?.dayCount ?? 0,
      paysByHours: rate.greaterThan(0),
      perHourRate: formatAmount(rate),
      // Pul yozilgan soat — muhrlangan oyda muhrdagisi
      paidHours: src.lessonHours,
      // Jadval bo'yicha reja va uning taqsimoti (jonli):
      //   jadval − o'rinbosarga berildi + o'rniga chiqildi = reja
      //   reja − o'tilmadi = pul yoziladigan soat
      scheduledHours: hoursInfo?.scheduledHours ?? null,
      substitutedOutHours: hoursInfo?.substitutedOutHours ?? 0,
      substitutedInHours: hoursInfo?.substitutedInHours ?? 0,
      plannedHours: hoursInfo ? liveHours + missedHours : null,
      taughtHours: hoursInfo?.taughtHours ?? null,
      missedHours,
      remainingHours: hoursInfo?.remainingHours ?? 0,
      isVacationMonth: hoursInfo?.isVacationMonth ?? false,
    },

    // ── QANCHA OYLIK — zanjir ──
    fixedAmount: formatAmount(src.fixedAmount),
    kpiAmount: formatAmount(src.kpiAmount),
    allowanceAmount: formatAmount(src.allowanceAmount),
    allowances: src.allowanceBreakdown.filter(positive),
    grossAmount: formatAmount(grossAmount),
    absenceAmount: formatAmount(src.absenceAmount),
    absence,
    suspendedAmount: formatAmount(src.suspendedAmount),
    suspensions: src.suspensionBreakdown.filter(positive).map((row) => ({
      id: row.id ?? null,
      label: row.label,
      reason: row.reason ?? "",
      amount: formatAmount(row.amount),
    })),
    deductionAmount: formatAmount(src.deductionAmount),
    deductions: deductionRows.map((row) => ({
      id: row.id ?? null,
      reason: ruleMap.get(row.id)?.reason ?? row.reason ?? "",
      note: ruleMap.get(row.id)?.note ?? "",
      type: row.type,
      value: row.value,
      amount: formatAmount(row.amount),
    })),
    amount: formatAmount(src.amount),

    // ── NEGA KAM ──
    // Kunlar xronologik (kelmagan kun, o'tilmagan va o'rinbosarga berilgan
    // darslar), bo'sh bo'lsa — "hech narsa ayrilmagan"
    reasons: {
      days: reasonDays.days,
      total: formatAmount(reasonsTotal),
      holidays,
    },
    // Tafsilot bloklari (joriy oy kartasi `missedLessons` dan o'qiydi)
    missedLessons,
    substitutedOut,
    hoursDrift,

    // ── TO'LOV — faqat shakllangan oyda ──
    payment: entry
      ? {
          status: entry.status,
          statusLabel: STATUS_LABELS[entry.status] ?? entry.status,
          paidAmount: formatAmount(paid),
          debt: formatAmount(debt.isNegative() ? new Decimal(0) : debt),
          payments: entry.allocations.map((row) => ({
            id: row.id,
            amount: formatAmount(row.amount),
            // To'lov sanasi — instant, Toshkent devor-soati
            paidAtLabel: formatDateUz(row.payment?.paidAt ?? row.appliedAt),
          })),
        }
      : null,
  };
};

module.exports = {
  getMonthBreakdown,
  groupMissedByDay,
  buildReasonDays,
};
