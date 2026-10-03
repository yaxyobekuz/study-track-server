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
 *   · NEGA KAM — har bir kamayish SABABI va KUNI bilan: kelmagan ish kuni
 *     (fiksadan kunlik summa) va o'tilmagan dars (kelmagan / sababli / baho
 *     qo'yilmagan — dars soati narxi).
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
const { getTeacherHours, cutoffForMonth } = require("./lessonHours.service");
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
 * O'tilmagan darslar KUNLAR KESIMIDA — "qaysi kuni, qaysi dars, nega va
 * qancha". Kun summasi = shu kuni o'tilmagan soat × 1 dars soati narxi.
 *
 * ⚠️ Sana matni SERVERDA (`dateLabel`): dars kuni — UTC yarim tuni
 * (`dates.md` §4), brauzerda o'qilsa kun siljirdi.
 *
 * @param {Array} lessons - `getTeachersHours(...).missedLessons`
 * @param {Decimal} rate - 1 dars soati narxi
 */
const groupMissedByDay = (lessons, rate) => {
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
    day.lessons.push({
      className: lesson.className,
      subjectName: lesson.subjectName,
      lessonOrder: lesson.lessonOrder,
      reason: lesson.reason,
      reasonLabel: lesson.reasonLabel,
      autoMarked: Boolean(lesson.autoMarked),
      substituted: Boolean(lesson.substituted),
    });
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
      // Jadval bo'yicha reja va uning taqsimoti (jonli)
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

    // ── NEGA KAM — o'tilmagan darslar (soatbay qism) ──
    missedLessons,
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
};
