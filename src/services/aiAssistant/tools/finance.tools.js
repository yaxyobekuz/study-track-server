/**
 * AI YORDAMCHI — moliya (KIRIM) bo'limining o'qish vositalari.
 *
 * Har bir vosita MAVJUD servisni controller qanday chaqirsa aynan shunday
 * chaqiradi va natijani modelga ixcham shaklda qaytaradi. Biznes hisobi bu
 * yerda QAYTA YOZILMAYDI: "tushum", "qarz", "yig'ish foizi" raqamlari admin
 * panelidagi ekranlar bilan bir manbadan chiqishi shart, aks holda egasi
 * yordamchida bir raqam, dashboardda boshqa raqam ko'rardi.
 *
 * ⚠️ Kod `.claude/rules/finance.md` dan chetlashgan joylari bor (kechki
 * moslashtirish passi to'lanmagan va hatto to'langan hisob-fakturalarni
 * joriy qoidaga tekislaydi). Tavsiflar KODGA qarab yozilgan.
 *
 * ⚠️ Telefon raqamlari hech bir ro'yxatga kirmaydi — `getDebtorsForExport`
 * ataylab chaqirilmaydi.
 */

const {
  defineTool,
  AiToolError,
  idSchema,
  monthSchema,
  daySchema,
  limitSchema,
  requireId,
  monthArg,
  dayArg,
  reqLike,
  formatMoneyUz,
  monthLabel,
  sliceList,
  pick,
} = require("../assistant.toolkit");
const { currentMonthKey, prevMonth } = require("../../../helpers/month.helpers");
const { formatDateUz, formatDateTimeUz } = require("../../../helpers/date.helpers");
const { formatAmount } = require("../../../helpers/money.helpers");

const financeDashboardService = require("../../financeDashboard.service");
const financeReportService = require("../../financeReport.service");
const financeTargetService = require("../../financeTarget.service");
const financeSettingsService = require("../../financeSettings.service");
const incomePlanService = require("../../incomePlan.service");
const invoiceService = require("../../invoice.service");
const invoiceGenerationService = require("../../invoiceGeneration.service");
const tariffResolutionService = require("../../tariffResolution.service");
const studentTariffService = require("../../studentTariff.service");
const studentDiscountService = require("../../studentDiscount.service");
const studentEnrollmentService = require("../../studentEnrollment.service");
const studentFinanceStatusService = require("../../studentFinanceStatus.service");
const studentMonthOverrideService = require("../../studentMonthOverride.service");
const studentAccountService = require("../../studentAccount.service");
const paymentService = require("../../payment.service");
const paymentAccountService = require("../../paymentAccount.service");
const externalIncomeService = require("../../externalIncome.service");
const incomeCategoryService = require("../../incomeCategory.service");
const tariffService = require("../../tariff.service");
const discountService = require("../../discount.service");
const serviceCatalogService = require("../../service.service");
const vacationMonthService = require("../../vacationMonth.service");

const TOOLSET = "finance";

// ─────────────────────────────────────────────────────────────────────────
// Yordamchilar
// ─────────────────────────────────────────────────────────────────────────

/** Kun maydoni ("YYYY-MM-DD", `@db.Date`) — UTC yarim tunida o'qiladi. */
const dayLabel = (iso) => formatDateUz(iso, { utc: true });

/**
 * Xronologik ro'yxatning OXIRGI qismini oladi. `sliceList` boshidan kesadi —
 * vaqt qatorlarida esa eng yangi nuqtalar muhim.
 */
const tailList = (items, max) => {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= max) return { items: list, total: list.length, truncated: false };
  return { items: list.slice(-max), total: list.length, truncated: true };
};

/** `month` dan `count` oy orqaga (shu oy ham kiradi) boshlanadigan oy. */
const monthsBack = (month, count) => {
  let from = month;
  for (let i = 1; i < count; i += 1) from = prevMonth(from);
  return from;
};

/** Joriy oyning birinchi kuni "YYYY-MM-DD" (Toshkent kalendari). */
const firstDayOfMonthIso = (monthKey) =>
  `${Math.trunc(monthKey / 100)}-${String(monthKey % 100).padStart(2, "0")}-01`;

/** Sana oralig'i argumentlari: bittasi berilsa ham ikkinchisi servis sukutiga qoladi. */
const assertDayRange = (from, to) => {
  if (from && to && from > to) {
    throw new AiToolError("Boshlanish sanasi tugash sanasidan keyin bo'lishi mumkin emas");
  }
};

const KPI_LABELS = {
  income: "Tushum (kassa)",
  expense: "Xarajat (kassa)",
  profit: "Sof foyda",
  margin: "Sof foyda marjasi",
  cashBalance: "Pul qoldig'i",
  debt: "O'quvchilar qarzi",
  debtors: "Qarzdorlar soni",
  oldestDebt: "Eng eski qarz",
  payroll: "Belgilangan oylik",
};

const INVOICE_STATUSES = ["unpaid", "partial", "paid", "cancelled"];

/** Hisob-fakturaning modelga kerakli qismi (oy yorlig'i chaqiruvchida). */
const compactInvoice = (invoice) =>
  invoice
    ? {
        invoiceId: invoice.id,
        status: invoice.status,
        statusLabel: invoice.statusLabel,
        tariffName: invoice.tariffName || null,
        baseAmount: invoice.baseAmount,
        prorationLabel: invoice.prorationLabel,
        discountAmount: invoice.discountAmount,
        servicesAmount: invoice.hasServices ? invoice.servicesAmount : undefined,
        overrideReasonLabel: invoice.overrideReasonLabel || undefined,
        amount: invoice.amount,
        paidAmount: invoice.paidAmount,
        debt: invoice.debt,
        cancelReason: invoice.status === "cancelled" ? invoice.cancelReason : undefined,
      }
    : null;

// ─────────────────────────────────────────────────────────────────────────
// Vositalar
// ─────────────────────────────────────────────────────────────────────────

const financeDashboard = defineTool({
  name: "finance_dashboard",
  toolset: TOOLSET,
  label: "Moliya dashboardi o'qilmoqda",
  description:
    "Executive finance dashboard for one month: KPIs (cash income, cash expense, profit, margin, cash balance, student debt, debtors, oldest debt, assigned payroll) with previous month and plan, P&L rows, 12-month trend, revenue by direction, payment account balances, debt aging and top debtors, accrual (invoiced vs collected) series, pricing check, expense top categories, plan vs actual budget rows and the KPI scorecard (academic quality, payment discipline, attendance, NPS, admissions). Use first for 'how is the school doing financially'. Income/expense are CASH basis; debt/accrual are INVOICE basis. Money values are 2-decimal strings in so'm; percents are numbers.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      month: monthSchema(),
    },
  },
  async handler(args) {
    const month = monthArg(args.month);
    const query = { month: String(month) };

    // Controller: egasi uchun `includePayrollStaff` doim true. Xodimlar
    // ro'yxati bu yerda baribir qaytarilmaydi — u oylik bo'limining vositasi.
    const [dashboard, scorecard] = await Promise.all([
      financeDashboardService.getDashboard(query, { includePayrollStaff: true }),
      financeDashboardService.getKpiScorecard(query),
    ]);

    return {
      month: dashboard.month,
      monthLabel: dashboard.monthLabel,
      compareMonthLabel: dashboard.compareMonthLabel,
      basis:
        "Tushum va xarajat — kassa asosida (haqiqatda tushgan/chiqqan pul); qarz, hisoblangan summa va yig'ish foizi — hisob-faktura asosida",
      kpi: Object.values(dashboard.kpi).map((item) => ({
        key: item.key,
        label: KPI_LABELS[item.key] ?? item.key,
        unit: item.unit,
        value: item.value,
        previous: item.previous,
        change: item.change,
        changeUnit: item.changeUnit,
        plan: item.plan,
        planRate: item.planRate,
        sub: item.sub,
      })),
      pnl: dashboard.pnl.map((row) => pick(row, ["key", "label", "current", "previous", "change", "unit"])),
      trend: dashboard.trend.map((row) =>
        pick(row, ["monthLabel", "income", "expense", "profit", "margin", "balance"]),
      ),
      revenueStructure: {
        total: dashboard.revenueStructure.total,
        items: dashboard.revenueStructure.items.map((row) =>
          pick(row, ["label", "amount", "studentCount", "share"]),
        ),
      },
      directions: {
        note: dashboard.directions.note,
        items: dashboard.directions.items.map((row) =>
          pick(row, ["label", "income", "expense", "profit", "margin", "share", "studentCount"]),
        ),
        totals: dashboard.directions.totals,
      },
      accounts: {
        total: dashboard.accounts.total,
        items: dashboard.accounts.items.map((row) =>
          pick(row, ["id", "name", "isActive", "balance", "previousBalance", "change", "share"]),
        ),
      },
      debt: {
        ...pick(dashboard.debt, [
          "asOfMonthLabel",
          "debt",
          "overdue",
          "debtorCount",
          "studentCount",
          "previousDebt",
          "debtChange",
          "debtorChange",
          "debtorShare",
          "average",
          "oldestMonthLabel",
        ]),
        aging: dashboard.debt.aging.map((row) => pick(row, ["label", "amount", "share", "studentCount"])),
        topDebtors: dashboard.debt.topDebtors.map((row) =>
          pick(row, ["id", "fullName", "isArchived", "debt", "unpaidCount", "oldestMonthLabel"]),
        ),
      },
      accrual: {
        totals: dashboard.accrual.totals,
        series: dashboard.accrual.series.slice(-6).map((row) => ({
          monthLabel: row.monthLabel ?? monthLabel(row.month),
          invoiced: row.invoiced,
          collected: row.collected,
          collectionRate: row.collectionRate,
          invoiceCount: row.invoiceCount,
        })),
      },
      pricing: dashboard.pricing,
      payroll: pick(dashboard.payroll, [
        "accrued",
        "paid",
        "debt",
        "assigned",
        "assignedChange",
        "staffCount",
        "unpaidCount",
      ]),
      expenseTop: dashboard.expenseStructure.top.map((row) => pick(row, ["label", "amount", "count", "share"])),
      expenseBudget: dashboard.expenseBudget.totals,
      incomePlan: dashboard.incomePlan.totals,
      budget: [...dashboard.budget, ...dashboard.customBudget].map((row) =>
        pick(row, ["label", "unit", "plan", "actual", "diff", "rate"]),
      ),
      scorecard: scorecard.items.map((row) => pick(row, ["label", "unit", "value", "plan", "reached", "sub"])),
    };
  },
});

const financeCollection = defineTool({
  name: "finance_collection",
  toolset: TOOLSET,
  label: "To'lov yig'ilishi tahlil qilinmoqda",
  description:
    "Collection analysis on the invoice (accrual) basis: invoiced vs collected, collection rate %, discount and proration totals, deposit balance and a monthly series for a window of months ending at `month`; plus cash in/out for the same window with the previous-window comparison; debt aging buckets (current, 1, 2-3, 4-6, 7+ months), debt by class (from the sealed class name on invoices), top 10 debtors; and a one-month snapshot of expected/collected/debt by live class and by direction with grant (exclusive discount) counts. Use for 'how well are we collecting', 'which classes owe the most', 'how old is the debt'.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      month: monthSchema("Last month of the window and the snapshot month, YYYYMM. Omit for the current month."),
      months: {
        type: "integer",
        minimum: 1,
        maximum: 24,
        description: "Window length in months including `month`. Default 6.",
      },
    },
  },
  async handler(args) {
    const month = monthArg(args.month);
    const fromMonth = monthsBack(month, args.months ?? 6);

    const [overview, debt, snapshot] = await Promise.all([
      financeReportService.getOverview({ fromMonth: String(fromMonth), toMonth: String(month) }),
      financeReportService.getDebt({ asOfMonth: String(month) }),
      invoiceService.getOverviewDashboard(month),
    ]);

    const byClass = sliceList(snapshot.byClass, 40);
    const debtByClass = sliceList(debt.byClass, 40);

    return {
      window: { fromMonthLabel: overview.fromMonthLabel, toMonthLabel: overview.toMonthLabel },
      totals: overview.totals,
      totalsLabels: {
        invoiced: formatMoneyUz(overview.totals.invoiced),
        collected: formatMoneyUz(overview.totals.collected),
        debt: formatMoneyUz(overview.totals.debt),
      },
      cash: overview.cash,
      previousWindow: {
        ...overview.previous,
        fromMonthLabel: monthLabel(overview.previous.fromMonth),
        toMonthLabel: monthLabel(overview.previous.toMonth),
      },
      series: overview.series.map((row) =>
        pick(row, ["monthLabel", "invoiced", "collected", "debt", "collectionRate", "invoiceCount"]),
      ),
      debt: {
        asOfMonthLabel: debt.asOfMonthLabel,
        totals: debt.totals,
        aging: debt.aging.map((row) => pick(row, ["label", "amount", "share", "invoiceCount", "studentCount"])),
        byClass: debtByClass,
        topDebtors: debt.topDebtors.map((row) =>
          pick(row, ["id", "fullName", "debt", "unpaidCount", "oldestMonthLabel"]),
        ),
        series: debt.series.map((row) => pick(row, ["monthLabel", "debt", "invoiceCount"])),
      },
      monthSnapshot: {
        monthLabel: snapshot.monthLabel,
        counts: snapshot.counts,
        money: snapshot.money,
        byClass: {
          ...byClass,
          items: byClass.items.map((row) =>
            pick(row, [
              "classId",
              "className",
              "studentCount",
              "grantCount",
              "payingCount",
              "expected",
              "collected",
              "debt",
            ]),
          ),
        },
        byDirection: snapshot.byDirection,
      },
    };
  },
});

const financeDebtors = defineTool({
  name: "finance_debtors",
  toolset: TOOLSET,
  label: "Qarzdorlar ro'yxati o'qilmoqda",
  description:
    "Debtor registry: students with unpaid or partially paid invoices across ALL months (archived students included), each with total debt, number of open invoices and the oldest unpaid month, sorted by biggest debt (default) or oldest debt. Returns school-wide totals (total debt, debtor count, oldest month) and a bounded list with `total`/`truncated`. Filter by class or name. No phone numbers. Use the student ids with finance_student or propose_send_debt_reminders.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      classId: idSchema("Limit to students of this class."),
      search: {
        type: "string",
        maxLength: 60,
        description: "Part of the student's first name, last name or username.",
      },
      sort: {
        type: "string",
        enum: ["biggest", "oldest"],
        description: "biggest = largest debt first (default); oldest = oldest unpaid month first.",
      },
      limit: limitSchema(100),
    },
  },
  async handler(args, ctx) {
    const result = await invoiceService.getDebtors(
      reqLike(ctx, {
        classId: args.classId,
        search: args.search,
        sort: args.sort === "oldest" ? "oldest" : undefined,
        limit: args.limit ?? 20,
      }),
    );

    if (result.pagination.total === 0) {
      return { empty: true, reason: "Tanlangan filtr bo'yicha qarzdor o'quvchi yo'q", totals: result.totals };
    }

    return {
      totals: { ...result.totals, totalDebtLabel: formatMoneyUz(result.totals.totalDebt) },
      total: result.pagination.total,
      truncated: result.pagination.total > result.data.length,
      items: result.data.map((row) => ({
        studentId: row.id,
        fullName: row.fullName,
        isArchived: row.isArchived,
        debt: row.debt,
        unpaidCount: row.unpaidCount,
        oldestMonthLabel: row.oldestMonthLabel,
      })),
    };
  },
});

const financeCashflow = defineTool({
  name: "finance_cashflow",
  toolset: TOOLSET,
  label: "Kassa tushumi o'qilmoqda",
  description:
    "Cash income (money that actually arrived) for a date range: total amount, receipt count, average receipt, how much went to invoices vs deposits, split by source (student payments, external income, damage recoveries), by payment account, and a time series grouped by day/week/month (most recent 62 points). Dates are Tashkent days YYYY-MM-DD; default range is the last 30 days. totals.amount is the same 'income' number used by the dashboard.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      from: daySchema("Range start day YYYY-MM-DD (Tashkent). Default: 30 days ago."),
      to: daySchema("Range end day YYYY-MM-DD inclusive (Tashkent). Default: today."),
      groupBy: {
        type: "string",
        enum: ["day", "week", "month"],
        description: "Series granularity. Default day.",
      },
    },
  },
  async handler(args) {
    const from = args.from ? dayArg(args.from, "Boshlanish sanasi") : undefined;
    const to = args.to ? dayArg(args.to, "Tugash sanasi") : undefined;
    assertDayRange(from, to);

    const report = await financeReportService.getCashflow({ from, to, groupBy: args.groupBy });

    return {
      fromLabel: dayLabel(report.from),
      toLabel: dayLabel(report.to),
      groupBy: report.groupBy,
      totals: { ...report.totals, amountLabel: formatMoneyUz(report.totals.amount) },
      bySource: report.bySource.map((row) => pick(row, ["label", "amount", "count", "share"])),
      byAccount: report.byAccount,
      series: tailList(
        report.series.map((row) => ({ dateLabel: dayLabel(row.date), amount: row.amount, count: row.count })),
        62,
      ),
    };
  },
});

const financeTariffBreakdown = defineTool({
  name: "finance_tariff_breakdown",
  toolset: TOOLSET,
  label: "Tariflar kesimi o'qilmoqda",
  description:
    "Invoiced and collected amounts by tariff (sealed tariff name on invoices) for a month range, with discount and proration totals and `wipedByDiscount` = number of invoices whose amount was reduced to 0 by discounts (free months that silently disappear from debtors). Note: months fixed to 0 by a manual month override are NOT counted there. Use for 'which tariff brings the most', 'how much do discounts cost'.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      month: monthSchema("Last month of the range, YYYYMM. Omit for the current month."),
      fromMonth: monthSchema("First month of the range, YYYYMM. Omit to analyse only `month`."),
    },
  },
  async handler(args) {
    const toMonth = monthArg(args.month);
    const fromMonth = args.fromMonth ? monthArg(args.fromMonth, "Boshlanish oyi") : toMonth;
    if (fromMonth > toMonth) {
      throw new AiToolError("Boshlanish oyi tugash oyidan keyin bo'lishi mumkin emas");
    }

    const report = await financeReportService.getTariffBreakdown({
      fromMonth: String(fromMonth),
      toMonth: String(toMonth),
    });

    return {
      fromMonthLabel: monthLabel(report.fromMonth),
      toMonthLabel: monthLabel(report.toMonth),
      totals: report.totals,
      byTariff: report.byTariff,
      series: report.series.map((row) =>
        pick(row, ["monthLabel", "discountAmount", "prorationAmount", "invoiceCount"]),
      ),
    };
  },
});

const financeStudent = defineTool({
  name: "finance_student",
  toolset: TOOLSET,
  label: "O'quvchining moliyaviy holati o'qilmoqda",
  description:
    "Complete financial picture of ONE student: deposit balance and open debt; current-month tariff resolution (tariff, catalog or individual price, reason when unbilled: no_assignment / no_price) and live monthly amount after proration, discounts and extra services; tariff assignment history; discounts (current and past); enrollment periods (study dates, leave reason); freeze history; manual month overrides; month-by-month invoice timeline for the last 24 months (vacation / not enrolled / invoice with amount, paid, debt, status) with `missingInvoiceMonths` = enrolled, not frozen, due months that have no invoice (anomaly); last 10 payments with receipt, account and months covered. Use to explain any student's debt or billing.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["studentId"],
    properties: {
      studentId: idSchema("Student user id (resolve with search_people first)."),
    },
  },
  async handler(args, ctx) {
    const studentId = requireId(args.studentId, "O'quvchi id");

    // Mavjudlik va rol tekshiruvi: yo'q/o'quvchi bo'lmagan id 404 beradi,
    // "tarifsiz o'quvchi" bo'lib jim ko'rinmaydi.
    const resolution = await tariffResolutionService.resolveForStudent(studentId, ctx.monthKey);

    const [
      finance,
      tariffHistory,
      discounts,
      enrollments,
      statuses,
      overrides,
      payments,
      account,
    ] = await Promise.all([
      invoiceService.getMyFinance(studentId),
      studentTariffService.getStudentHistory(studentId),
      studentDiscountService.getStudentDiscounts(studentId),
      studentEnrollmentService.getStudentEnrollments(studentId),
      studentFinanceStatusService.getStudentStatusHistory(studentId),
      studentMonthOverrideService.getForStudent(studentId),
      paymentService.getStudentPayments(studentId),
      studentAccountService.getStudentAccount(studentId),
    ]);

    const frozenRows = statuses.items.filter((row) => row.status === "frozen");
    const isFrozenMonth = (month) =>
      frozenRows.some((row) => row.startMonth <= month && (row.endMonth == null || row.endMonth >= month));

    const timeline = finance.timeline.map((entry) => ({
      month: entry.month,
      monthLabel: entry.monthLabel,
      state: entry.isVacation
        ? "vacation"
        : entry.skipReason ?? (isFrozenMonth(entry.month) ? "frozen" : entry.isFuture ? "future" : "due"),
      invoice: compactInvoice(entry.invoice),
    }));

    const missingInvoiceMonths = finance.timeline
      .filter(
        (entry) =>
          entry.isEnrolled &&
          !entry.invoice &&
          !entry.isFuture &&
          entry.skipReason == null &&
          !isFrozenMonth(entry.month),
      )
      .map((entry) => entry.monthLabel);

    const recentPayments = sliceList(payments, 10);
    const name = `${resolution.student.firstName} ${resolution.student.lastName ?? ""}`.trim();

    return {
      student: {
        id: studentId,
        fullName: name,
        className: finance.student.className,
        isArchived: resolution.student.isArchived,
      },
      account: {
        deposit: account.balance,
        debt: account.debt,
        debtLabel: formatMoneyUz(account.debt),
        depositLabel: formatMoneyUz(account.balance),
      },
      currentMonth: {
        monthLabel: resolution.monthLabel,
        tariffName: resolution.items[0]?.tariff?.name ?? null,
        directionName: resolution.items[0]?.tariff?.direction?.name ?? null,
        catalogOrCustomPrice: resolution.total,
        isCustomPrice: resolution.isCustom ?? false,
        unbilledReason: resolution.reason,
        liveMonthlyAmount: finance.tariff?.effectiveMonthly ?? null,
        discountAmount: finance.tariff?.discountAmount ?? null,
        servicesAmount: finance.tariff?.servicesAmount ?? null,
        services: finance.tariff?.services ?? [],
        prorationLabel: finance.tariff?.isProrated
          ? `${finance.tariff.billableDays}/${finance.tariff.monthDays} kun`
          : null,
        financeStatus: finance.financeStatus.statusLabel,
      },
      totals: finance.totals,
      tariffHistory: tariffHistory.items.map((row) => ({
        assignmentId: row.id,
        tariffId: row.tariffId,
        tariffName: row.tariff?.name ?? "Noma'lum",
        startMonthLabel: row.startMonthLabel,
        endMonthLabel: row.endMonthLabel,
        customAmount: row.customAmount,
        prices: row.priceHistory.map((v) => ({
          fromLabel: monthLabel(v.startMonth),
          toLabel: v.endMonth ? monthLabel(v.endMonth) : null,
          monthlyAmount: v.monthlyAmount,
        })),
      })),
      discounts: discounts.items.map((row) => ({
        assignmentId: row.id,
        discountId: row.discountId,
        name: row.discount?.name ?? "Noma'lum",
        valueLabel: row.discount?.valueLabel ?? null,
        isExclusive: row.discount?.isExclusive ?? false,
        periodLabel: row.periodLabel,
        isActiveNow: row.isActive,
      })),
      enrollment: {
        isStudying: enrollments.isStudying,
        hasPeriods: enrollments.hasPeriods,
        periods: enrollments.items.map((row) => ({
          enrollmentId: row.id,
          startLabel: dayLabel(row.startDate),
          endLabel: row.endDate ? dayLabel(row.endDate) : null,
          isOpen: row.isOpen,
          endReasonLabel: row.endReasonLabel,
          reason: row.reason || undefined,
          firstMonthAmount: row.firstMonthAmount != null ? formatAmount(row.firstMonthAmount) : undefined,
        })),
      },
      freezes: statuses.items.map((row) => ({
        statusId: row.id,
        statusLabel: row.statusLabel,
        startMonthLabel: row.startMonthLabel,
        endMonthLabel: row.endMonthLabel,
        reason: row.reason || undefined,
      })),
      monthOverrides: overrides.map((row) => pick(row, ["monthLabel", "amount", "reasonLabel", "note"])),
      missingInvoiceMonths,
      timeline: tailList(timeline, 24),
      recentPayments: {
        total: recentPayments.total,
        truncated: recentPayments.truncated,
        items: recentPayments.items.map((payment) => ({
          paymentId: payment.id,
          receiptLabel: payment.receiptLabel,
          paidAtLabel: formatDateTimeUz(payment.paidAt),
          amount: payment.amount,
          toDeposit: payment.depositAmount,
          accountName: payment.account?.name ?? null,
          months: payment.allocations.map((a) => a.monthLabel).filter(Boolean),
        })),
      },
    };
  },
});

const financeInvoicesMonth = defineTool({
  name: "finance_invoices_month",
  toolset: TOOLSET,
  label: "Oylik hisob-fakturalar o'qilmoqda",
  description:
    "Invoice summary for one month: counts by status (unpaid, partial, paid, cancelled), base amount, proration, discounts, invoiced amount, paid, debt, school-wide deposit balance, comparison with the previous month, whether the month is a vacation month and whether generation is possible. Pass `status` to also list that month's invoices (student, tariff, amount, paid, debt, cancel reason) — bounded by `limit`.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      month: monthSchema(),
      status: {
        type: "string",
        enum: INVOICE_STATUSES,
        description: "Also list invoices with this status for the month.",
      },
      limit: limitSchema(60, "Maximum invoices to list when `status` is given."),
    },
  },
  async handler(args, ctx) {
    const month = monthArg(args.month);
    const summary = await invoiceService.getSummary(month);

    const result = {
      monthLabel: summary.monthLabel,
      compareMonthLabel: summary.compareMonthLabel,
      isVacation: summary.isVacation,
      canGenerate: summary.canGenerate,
      blockedReason: summary.blockedReason,
      counts: summary.counts,
      totals: summary.totals,
      totalsLabels: {
        amount: formatMoneyUz(summary.totals.amount),
        paid: formatMoneyUz(summary.totals.paid),
        debt: formatMoneyUz(summary.totals.debt),
      },
      previous: summary.previous,
      changePercent: summary.change,
    };

    if (!args.status) return result;

    const list = await invoiceService.getInvoices(
      reqLike(ctx, {
        month,
        status: args.status,
        limit: args.limit ?? 20,
      }),
    );

    return {
      ...result,
      invoices: {
        status: args.status,
        total: list.pagination.total,
        truncated: list.pagination.total > list.data.length,
        totals: list.totals,
        // Holat va oy hamma qatorda bir xil — ro'yxat qatori ataylab ixcham.
        items: list.data.map((invoice) => ({
          studentId: invoice.studentId,
          studentName: invoice.studentName,
          tariffName: invoice.tariffName || null,
          amount: invoice.amount,
          paidAmount: invoice.paidAmount,
          debt: invoice.debt,
          discountAmount: invoice.hasDiscount ? invoice.discountAmount : undefined,
          prorationLabel: invoice.prorationLabel || undefined,
          cancelReason: invoice.status === "cancelled" ? invoice.cancelReason : undefined,
        })),
      },
    };
  },
});

const financeCatalog = defineTool({
  name: "finance_catalog",
  toolset: TOOLSET,
  label: "Tarif va chegirmalar katalogi o'qilmoqda",
  description:
    "Pricing catalogs: tariffs (shared by ALL branches) with direction, current-month price (null = no price for this month, students on it are not billed), number of price versions and students assigned across all branches; discounts (shared) with type, value, exclusivity (grant) flag, active flag and students using them this month across branches; additional services of this branch (dormitory, meals…) with monthly amount and current assignments. Use to find tariffId / discountId before proposing assignments.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      includeArchived: {
        type: "boolean",
        description: "Include archived tariffs, discounts and services. Default false.",
      },
    },
  },
  async handler(args, ctx) {
    const includeArchived = args.includeArchived === true;

    const [tariffs, discounts, services] = await Promise.all([
      tariffService.getTariffs(
        reqLike(ctx, { limit: 100, isArchived: includeArchived ? "all" : undefined }),
      ),
      discountService.getDiscounts(reqLike(ctx, { limit: 100, withUsage: "true" })),
      serviceCatalogService.getServices({ includeArchived }),
    ]);

    // Chegirmalar servisida "arxivlanganlar bilan birga" rejimi yo'q —
    // arxiv so'ralsa alohida sahifa sifatida qo'shiladi.
    const archivedDiscounts = includeArchived
      ? await discountService.getDiscounts(reqLike(ctx, { limit: 100, status: "archived" }))
      : null;

    const discountRows = [...discounts.data, ...(archivedDiscounts?.data ?? [])];

    return {
      tariffs: {
        total: tariffs.pagination.total,
        truncated: tariffs.pagination.total > tariffs.data.length,
        items: tariffs.data.map((row) => ({
          tariffId: row.id,
          name: row.name,
          direction: row.direction?.name ?? null,
          isActive: row.isActive,
          isArchived: row.isArchived,
          currentPrice: row.currentVersion?.monthlyAmount ?? null,
          priceSinceLabel: row.currentVersion?.startMonthLabel ?? null,
          priceUntilLabel: row.currentVersion?.endMonthLabel ?? null,
          versionCount: row.versionCount,
          studentsAllBranches: row.assignedStudentCount,
        })),
      },
      discounts: {
        total: discounts.pagination.total + (archivedDiscounts?.pagination.total ?? 0),
        items: discountRows.map((row) => ({
          discountId: row.id,
          name: row.name,
          typeLabel: row.typeLabel,
          valueLabel: row.valueLabel,
          isExclusive: row.isExclusive,
          isActive: row.isActive,
          isArchived: row.isArchived,
          studentsThisMonthAllBranches: row.studentCount,
        })),
      },
      services: services.map((row) => ({
        serviceId: row.id,
        name: row.name,
        monthlyAmount: row.monthlyAmount,
        isArchived: row.isArchived,
        assignedThisMonth: row.assignedCount,
      })),
    };
  },
});

const financePaymentAccounts = defineTool({
  name: "finance_payment_accounts",
  toolset: TOOLSET,
  label: "To'lov turlari qoldig'i o'qilmoqda",
  description:
    "Payment accounts ('to'lov turi': cash desk, bank accounts, card terminal) with current balance and, for the date range, money in, money out, net and a breakdown by ledger entry type (student payment, external income, expense, salary, transfer, refund, adjustment…). Default range: from the first day of the current month to today. Use to find accountId for payment/income proposals and to check cash position.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      from: daySchema("Range start day YYYY-MM-DD (Tashkent). Default: first day of the current month."),
      to: daySchema("Range end day YYYY-MM-DD inclusive (Tashkent). Default: today."),
    },
  },
  async handler(args, ctx) {
    const from = args.from ? dayArg(args.from, "Boshlanish sanasi") : firstDayOfMonthIso(ctx.monthKey);
    const to = args.to ? dayArg(args.to, "Tugash sanasi") : ctx.today;
    assertDayRange(from, to);

    const report = await paymentAccountService.getAccountsReport({ from, to });

    if (report.items.length === 0) {
      return { empty: true, reason: "Bu filialda to'lov turi yaratilmagan" };
    }

    return {
      fromLabel: dayLabel(from),
      toLabel: dayLabel(to),
      totals: { ...report.totals, balanceLabel: formatMoneyUz(report.totals.balance) },
      items: report.items.map((row) => ({
        accountId: row.id,
        name: row.name,
        isActive: row.isActive,
        balance: row.balance,
        income: row.income,
        expense: row.expense,
        net: row.net,
        breakdown: Object.values(row.breakdown).map((entry) => pick(entry, ["label", "amount", "count"])),
      })),
    };
  },
});

const financePayments = defineTool({
  name: "finance_payments",
  toolset: TOOLSET,
  label: "To'lovlar ro'yxati o'qilmoqda",
  description:
    "Student payment receipts (newest first) for a date range: receipt number, student, amount, part applied to invoices vs sent to deposit, payment account, months covered, voided flag. Filters: date range (Tashkent days), account, student or student name search. Returns total count and total amount for the whole filter plus a bounded list. Use to verify whether a payment was already recorded before proposing a new one.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      from: daySchema("Range start day YYYY-MM-DD (Tashkent)."),
      to: daySchema("Range end day YYYY-MM-DD inclusive (Tashkent)."),
      accountId: idSchema("Only payments into this payment account."),
      studentId: idSchema("Only this student's payments."),
      search: { type: "string", maxLength: 60, description: "Part of the student's name or username." },
      includeVoided: { type: "boolean", description: "Include voided receipts. Default false." },
      limit: limitSchema(100),
    },
  },
  async handler(args, ctx) {
    const from = args.from ? dayArg(args.from, "Boshlanish sanasi") : undefined;
    const to = args.to ? dayArg(args.to, "Tugash sanasi") : undefined;
    assertDayRange(from, to);

    const result = await paymentService.getPayments(
      reqLike(ctx, {
        from,
        to,
        accountId: args.accountId,
        studentId: args.studentId,
        search: args.search,
        includeVoided: args.includeVoided ? "true" : undefined,
        limit: args.limit ?? 20,
      }),
    );

    if (result.pagination.total === 0) {
      return { empty: true, reason: "Tanlangan filtr bo'yicha to'lov topilmadi" };
    }

    return {
      totals: { ...result.totals, totalAmountLabel: formatMoneyUz(result.totals.totalAmount) },
      total: result.pagination.total,
      truncated: result.pagination.total > result.data.length,
      items: result.data.map((payment) => ({
        paymentId: payment.id,
        receiptLabel: payment.receiptLabel,
        paidAtLabel: formatDateTimeUz(payment.paidAt),
        studentId: payment.studentId,
        studentName: payment.studentName,
        amount: payment.amount,
        allocatedAmount: payment.allocatedAmount,
        depositAmount: payment.depositAmount,
        accountName: payment.account?.name ?? null,
        months: payment.allocations.map((a) => a.monthLabel).filter(Boolean),
        isVoided: payment.isVoided,
        voidReason: payment.isVoided ? payment.voidReason : undefined,
      })),
    };
  },
});

const financeExternalIncome = defineTool({
  name: "finance_external_income",
  toolset: TOOLSET,
  label: "Tashqi kirimlar o'qilmoqda",
  description:
    "External (non-tuition) income: totals, split by income category and a monthly series for the date range (default last 365 days), plus the latest records in the range (category, amount, payer, responsible staff, account, date) and the list of active income categories with their ids (needed for propose_record_external_income and propose_set_income_plan).",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      from: daySchema("Range start day YYYY-MM-DD (Tashkent). Default: 365 days ago."),
      to: daySchema("Range end day YYYY-MM-DD inclusive (Tashkent). Default: today."),
      categoryId: idSchema("Only list records of this income category (totals stay for the whole range)."),
      limit: limitSchema(50, "Maximum records to list."),
    },
  },
  async handler(args, ctx) {
    const from = args.from ? dayArg(args.from, "Boshlanish sanasi") : undefined;
    const to = args.to ? dayArg(args.to, "Tugash sanasi") : undefined;
    assertDayRange(from, to);

    const report = await financeReportService.getExternalIncome({ from, to });

    const [records, categories] = await Promise.all([
      externalIncomeService.getIncomes(
        reqLike(ctx, {
          from: report.from,
          to: report.to,
          categoryId: args.categoryId,
          limit: args.limit ?? 20,
        }),
      ),
      incomeCategoryService.getCategories({ status: "active" }),
    ]);

    return {
      fromLabel: dayLabel(report.from),
      toLabel: dayLabel(report.to),
      totals: { ...report.totals, amountLabel: formatMoneyUz(report.totals.amount) },
      byCategory: report.byCategory,
      series: report.series.map((row) => pick(row, ["monthLabel", "amount", "count"])),
      records: {
        total: records.pagination.total,
        truncated: records.pagination.total > records.data.length,
        items: records.data.map((row) => ({
          incomeId: row.id,
          occurredAtLabel: formatDateTimeUz(row.occurredAt),
          categoryName: row.categoryName,
          amount: row.amount,
          payer: row.payer || undefined,
          responsibleName: row.responsibleName || undefined,
          accountName: row.accountName,
          note: row.note || undefined,
        })),
      },
      categories: categories.items.map((row) => ({ categoryId: row.id, name: row.name })),
    };
  },
});

const financePlans = defineTool({
  name: "finance_plans",
  toolset: TOOLSET,
  label: "Moliyaviy rejalar o'qilmoqda",
  description:
    "Plans vs actual for one month: (1) collection plans per responsible staff × income category — target, collected external income, remaining, rate % and status (reached ≥100, close ≥80, behind, none), including income that arrived without a plan; (2) finance targets set by the owner (income, expense, profit, margin, cash balance and custom rows) with the actual value from the dashboard; (3) KPI scorecard targets (academic quality, payment discipline, attendance, NPS, new admissions) with actual value and reached flag. Returns responsibleId/categoryId for propose_set_income_plan.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      month: monthSchema(),
    },
  },
  async handler(args) {
    const month = monthArg(args.month);
    const query = { month: String(month) };

    const [plans, targets, dashboard, scorecard] = await Promise.all([
      incomePlanService.getPlans(query),
      financeTargetService.getTargets(query),
      financeDashboardService.getDashboard(query, { includePayrollStaff: false }),
      financeDashboardService.getKpiScorecard(query),
    ]);

    const actualByKey = new Map(
      [...dashboard.budget, ...dashboard.customBudget].map((row) => [row.key, row]),
    );
    const scoreByKey = new Map(scorecard.items.map((row) => [row.key, row]));

    return {
      monthLabel: plans.monthLabel,
      collectionPlans: {
        totals: plans.totals,
        items: plans.items.map((row) =>
          pick(row, [
            "responsibleId",
            "responsibleName",
            "isStaffArchived",
            "categoryId",
            "categoryName",
            "studentCount",
            "target",
            "collected",
            "remaining",
            "rate",
            "status",
            "hasPlan",
            "note",
          ]),
        ),
      },
      financeTargets: targets.items
        .filter((row) => row.planValue != null || row.actualValue != null)
        .map((row) => {
          const actual = actualByKey.get(row.metric);
          const score = scoreByKey.get(row.metric);
          return {
            label: row.label,
            kind: row.kind,
            group: row.group,
            plan: row.planValue,
            actual: actual?.actual ?? score?.value ?? row.actualValue,
            diff: actual?.diff ?? null,
            rate: actual?.rate ?? null,
            reached: score?.reached ?? null,
            note: row.note || undefined,
          };
        }),
      unplannedTargets: targets.items.filter((row) => row.planValue == null).map((row) => row.label),
    };
  },
});

const financeSettings = defineTool({
  name: "finance_settings",
  toolset: TOOLSET,
  label: "Moliya sozlamalari o'qilmoqda",
  description:
    "Billing configuration of this branch (read-only): automatic invoice generation on/off, day of month, catch-up months, first invoice month floor, entry proration and rounding unit, automatic deposit application, default tariff for new students (with its current price or missing flag), when the daily generation pass last ran and which month it reached; vacation (no-billing) months for the given year and the next one; and `observations` listing configuration risks detected from these values. Use for 'why were invoices not created' questions.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      year: {
        type: "integer",
        minimum: 2000,
        maximum: 2100,
        description: "Calendar year for vacation months. Default: current year.",
      },
    },
  },
  async handler(args, ctx) {
    const year = args.year ?? Math.trunc(ctx.monthKey / 100);

    const [settings, vacations, nextVacations] = await Promise.all([
      financeSettingsService.getSettings(),
      vacationMonthService.getVacationMonths({ year }),
      vacationMonthService.getVacationMonths({ year: year + 1 }),
    ]);

    const observations = [];
    if (!settings.autoGenerateEnabled) {
      observations.push(
        "Avtomatik shakllantirish o'chirilgan: hisob-fakturalar faqat qo'lda yoziladi va kunlik moslashtirish passi ham ishlamaydi",
      );
    }
    if (!settings.defaultTariff) {
      observations.push("Standart tarif belgilanmagan: yangi o'quvchilar tarifsiz qoladi va ularga hisob-faktura yozilmaydi");
    } else if (settings.defaultTariff.missing) {
      observations.push("Standart tarif katalogda topilmadi");
    } else if (settings.defaultTariff.isArchived) {
      observations.push(`Standart tarif "${settings.defaultTariff.name}" arxivlangan`);
    } else if (settings.defaultTariff.amount == null) {
      observations.push(
        `Standart tarif "${settings.defaultTariff.name}" uchun ${settings.defaultTariff.monthLabel} oyiga narx belgilanmagan`,
      );
    }
    if (settings.autoGenerateEnabled && settings.lastGeneratedMonth != null && settings.lastGeneratedMonth < currentMonthKey()) {
      observations.push(
        `Oxirgi avtomatik pass ${settings.lastGeneratedMonthLabel} oyigacha yetgan — joriy oy hali shakllantirilmagan bo'lishi mumkin`,
      );
    }

    const vacationList = [...vacations.months, ...nextVacations.months]
      .filter((row) => row.isVacation)
      .map((row) => ({ monthLabel: row.monthLabel, title: row.title || undefined }));

    return {
      autoGenerateEnabled: settings.autoGenerateEnabled,
      invoiceDayOfMonth: settings.invoiceDayOfMonth,
      catchUpMonths: settings.catchUpMonths,
      firstInvoiceMonthLabel: settings.firstInvoiceMonthLabel,
      prorationEnabled: settings.prorationEnabled,
      roundingUnit: settings.roundingUnit,
      depositAutoApply: settings.depositAutoApply,
      defaultTariff: settings.defaultTariff
        ? pick(settings.defaultTariff, ["id", "name", "isActive", "isArchived", "missing", "amount", "monthLabel"])
        : null,
      lastRunAtLabel: settings.lastRunAt ? formatDateTimeUz(settings.lastRunAt) : null,
      lastGeneratedMonthLabel: settings.lastGeneratedMonthLabel,
      vacationMonths: {
        yearsLabel: `${year}–${year + 1}`,
        billableMonthsThisYear: vacations.billableMonthCount,
        items: vacationList,
      },
      observations,
    };
  },
});

const financeStudentsWithoutTariff = defineTool({
  name: "finance_students_without_tariff",
  toolset: TOOLSET,
  label: "Tarifsiz o'quvchilar tekshirilmoqda",
  description:
    "Detects students who will NOT be billed for a month: (1) non-archived students with no tariff assignment covering the month (with class, enrollment and freeze state, current debt and deposit); (2) for months up to the current one, a dry-run of invoice generation (nothing is written) reporting how many students would be skipped and why — no tariff, newly enrolled without tariff, tariff without price for that month, not enrolled, frozen — and how many invoices are still missing (would be created or restored now). Use for billing-gap audits.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      month: monthSchema(),
      classId: idSchema("Limit to one class."),
      limit: limitSchema(100, "Maximum students to list."),
    },
  },
  async handler(args, ctx) {
    const month = monthArg(args.month);

    const registry = await invoiceService.getStudentRegistry(
      reqLike(ctx, {
        filter: "noTariff",
        month,
        classId: args.classId,
        limit: args.limit ?? 20,
      }),
    );

    // Kelajakdagi oy uchun generatsiya servisning o'zi rad etadi — sinov
    // faqat joriy va o'tgan oylarda ma'noli.
    const generation =
      month <= currentMonthKey()
        ? await invoiceGenerationService.generateForMonth(month, {
            actorId: ctx.user.id,
            source: "manual",
            classId: args.classId,
            dryRun: true,
          })
        : null;

    const names = (list) => sliceList((list ?? []).map((row) => row.fullName), 15);

    return {
      monthLabel: registry.monthLabel,
      withoutAssignment: {
        total: registry.pagination.total,
        truncated: registry.pagination.total > registry.data.length,
        items: registry.data.map((row) => ({
          studentId: row.id,
          fullName: row.fullName,
          className: row.className,
          isEnrolled: row.isEnrolled,
          status: row.status,
          debt: row.debt,
          deposit: row.balance,
        })),
      },
      generationCheck: generation
        ? {
            reason: generation.reason,
            eligible: generation.eligible,
            missingNow: generation.created,
            restorableCancelled: generation.restored,
            missingAmount: generation.totalAmount,
            skipped: generation.skipped,
            noPrice: names(generation.details.noPrice),
            noTariffNewlyEnrolled: names(generation.details.noTariffNewlyEnrolled),
            frozen: names(generation.details.frozen),
            notEnrolled: names(generation.details.notEnrolled),
          }
        : { skippedReason: "Kelajakdagi oy uchun shakllantirish sinovi o'tkazilmaydi" },
    };
  },
});

module.exports = [
  financeDashboard,
  financeCollection,
  financeDebtors,
  financeCashflow,
  financeTariffBreakdown,
  financeStudent,
  financeInvoicesMonth,
  financeCatalog,
  financePaymentAccounts,
  financePayments,
  financeExternalIncome,
  financePlans,
  financeSettings,
  financeStudentsWithoutTariff,
];
