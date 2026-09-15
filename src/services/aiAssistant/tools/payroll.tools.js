/**
 * AI YORDAMCHI — CHIQIM bo'limi o'qish vositalari: oylik (payroll v2),
 * xarajatlar va limitlar, jarimalar, premium, tangalar.
 *
 * ⚠️ OYLIK RAQAMI FAQAT `payrollEngine` DAN. `helpers/lessonHours.js`
 * dagi `computeSalary()` (v1) va `lessonHoursDashboard.service` BUZUQ
 * (`finance-outcome` xaritasi D2/D7): ular chaqirilsa model boshqa, admin
 * paneli boshqa raqam ko'rardi yoki vosita har safar yiqilardi. Dars soati
 * `lessonHours.getTeachersHours` dan, pul esa engine'dan olinadi.
 *
 * ⚠️ `.claude/rules/finance.md` §10 ESKI (v1) modelni tasvirlaydi. Bu yerda
 * KOD bo'yicha ish ko'riladi: bekor qilingan majburiyat oyni abadiy to'sadi,
 * `SalaryType` = fixed/kpi/mixed, jarima oylikka ta'sir qilmaydi.
 *
 * Ro'yxatlar doim chegaralangan (`sliceList` / `limit`), telefon raqamlari
 * va parol maydonlari hech qaysi natijaga kirmaydi.
 */

const prisma = require("../../../config/prisma");
const {
  defineTool,
  AiToolError,
  idSchema,
  monthSchema,
  daySchema,
  limitSchema,
  requireId,
  monthArg,
  reqLike,
  formatMoneyUz,
  monthLabel,
  sliceList,
  personName,
} = require("../assistant.toolkit");
const { formatDateUz, formatDateTimeUz } = require("../../../helpers/date.helpers");
const { prevMonth } = require("../../../helpers/month.helpers");
const { ROLES } = require("../../../utils/constants");

const payrollService = require("../../payroll.service");
const payrollEngine = require("../../payrollEngine.service");
const payrollViewService = require("../../payrollView.service");
const payrollAuditService = require("../../payrollAudit.service");
const payrollRequestService = require("../../payrollRequest.service");
const staffSalaryService = require("../../staffSalary.service");
const salaryPaymentService = require("../../salaryPayment.service");
const departmentService = require("../../department.service");
const positionService = require("../../position.service");
const salaryCategoryService = require("../../salaryCategory.service");
const lessonHoursService = require("../../lessonHours.service");
const financeDashboardService = require("../../financeDashboard.service");
const financeReportService = require("../../financeReport.service");
const expenseService = require("../../expense.service");
const expenseCategoryService = require("../../expenseCategory.service");
const expenseBudgetService = require("../../expenseBudget.service");
const paymentAccountService = require("../../paymentAccount.service");
const penaltyService = require("../../penalty.service");
const premiumService = require("../../premium.service");
const coinService = require("../../coin.service");

const TOOLSET = "payroll";

/**
 * Engine kutadigan foydalanuvchi maydonlari. `payroll.service` dagi
 * `PAYROLL_USER_SELECT` eksport qilinmagan — shu sababli bu yerda aynan
 * o'sha to'plam yoziladi (ortiqcha maydon engine'ga ta'sir qilmaydi).
 */
const PAYROLL_USER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  role: true,
  isArchived: true,
  positionId: true,
  salaryCategoryId: true,
};

const SALARY_TYPE_LABELS = staffSalaryService.TYPE_LABELS;
const ENTRY_STATUS_LABELS = payrollService.STATUS_LABELS;

const PENALTY_TYPE_LABELS = { penalty: "Jarima", reduction: "Kamaytirish" };
const REVIEW_STATUS_LABELS = {
  pending: "Kutilmoqda",
  approved: "Tasdiqlangan",
  rejected: "Rad etilgan",
};
const REQUEST_KIND_LABELS = { category: "Toifa o'zgartirish", bonus: "Ustama" };
const PREMIUM_STATUS_LABELS = {
  active: "Faol",
  expired: "Muddati tugagan",
  revoked: "Bekor qilingan",
};
const PREMIUM_SOURCE_LABELS = { purchase: "Tangaga sotib olingan", admin_grant: "Qo'lda berilgan" };

/**
 * 30 kunlik kunlik trendni ixchamlaydi: faqat qiymati bor kunlar qoladi.
 *
 * ⚠️ Servislar sanani "YYYY-MM-DD" (ISO) qaytaradi — ekranda ISO chiqmasligi
 * uchun yorliq `formatDateUz(..., { utc: true })` bilan quriladi: satr UTC
 * yarim tuni sifatida o'qiladi va kun siljimaydi.
 */
const compactDailyTrend = (rows, fields) => {
  const totals = Object.fromEntries(fields.map((field) => [field, 0]));
  const activeDays = [];
  for (const row of rows || []) {
    let hasValue = false;
    for (const field of fields) {
      const value = Number(row[field]) || 0;
      totals[field] += value;
      if (value !== 0) hasValue = true;
    }
    if (hasValue) {
      activeDays.push({
        dateLabel: formatDateUz(row.date, { utc: true }),
        ...Object.fromEntries(fields.map((field) => [field, Number(row[field]) || 0])),
      });
    }
  }
  return { days: (rows || []).length, totals, activeDays };
};

/** O'qish vositasida topilmagan foydalanuvchi — model boshqa id qidirishi uchun aniq xabar. */
const loadPayrollUser = async (userId, label = "Xodim") => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: PAYROLL_USER_SELECT });
  if (!user) throw new AiToolError(`${label} topilmadi`);
  return user;
};

/**
 * Muhrlangan majburiyat — ixcham shakl. Soat va lavozim/toifa nomi faqat
 * ma'noli bo'lganda qo'shiladi: fiksa oylikda "0 soat" yolg'on taassurot
 * beradi va ro'yxat hajmini behuda oshiradi.
 */
const compactEntry = (row) => ({
  id: row.id,
  month: row.month,
  monthLabel: row.monthLabel,
  amount: row.amount,
  paidAmount: row.paidAmount,
  debt: row.debt,
  statusLabel: row.statusLabel,
  salaryTypeLabel: row.salaryTypeLabel,
  ...(row.salaryType !== "fixed" ? { lessonHours: row.lessonHours } : {}),
  ...(row.positionName ? { positionName: row.positionName } : {}),
  ...(row.categoryName ? { categoryName: row.categoryName } : {}),
});

const compactPreview = (preview) =>
  preview
    ? {
        salaryType: preview.salaryType,
        salaryTypeLabel: SALARY_TYPE_LABELS[preview.salaryType] ?? preview.salaryType,
        fixedAmount: preview.fixedAmount,
        kpiAmount: preview.kpiAmount,
        lessonHours: preview.lessonHours,
        perHourRate: preview.perHourRate,
        allowanceAmount: preview.allowanceAmount,
        allowances: preview.allowanceBreakdown,
        amount: preview.amount,
        amountLabel: formatMoneyUz(preview.amount),
        positionName: preview.positionName || null,
        categoryName: preview.categoryName || null,
        departmentName: preview.departmentName || null,
      }
    : null;

// ─────────────────────────────────────────────────────────────────────────
// OYLIK
// ─────────────────────────────────────────────────────────────────────────

const payrollOverview = defineTool({
  name: "payroll_overview",
  toolset: TOOLSET,
  label: "Oylik bo'yicha umumiy holat",
  description:
    "Payroll summary for one month, exactly as the finance dashboard shows it: sealed payroll (accrued, paid, debt, " +
    "unpaid count), the live ASSIGNED total computed from current salary rules/positions/categories by the payroll " +
    "engine, month-over-month changes versus the previous month, the number of cancelled entries (a cancelled entry " +
    "permanently blocks that month for that person) and the per-staff list of sealed entries (top 30 by amount). " +
    "Use it first for questions like 'how much do we pay staff this month' or 'is payroll generated'. Money is 2-decimal " +
    "strings in so'm; month is YYYYMM.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { month: monthSchema() },
  },
  timeoutMs: 45000,
  async handler(args) {
    const month = monthArg(args.month);
    const [dashboard, cancelledCount] = await Promise.all([
      financeDashboardService.getDashboard(
        { month, trendMonths: 3 },
        { includePayrollStaff: true },
      ),
      prisma.payrollEntry.count({ where: { month, status: "cancelled" } }),
    ]);
    const p = dashboard.payroll;
    const staff = sliceList(p.items, 30);

    return {
      month: p.month,
      monthLabel: p.monthLabel,
      compareMonthLabel: monthLabel(prevMonth(month)),
      sealed: {
        accrued: p.accrued,
        accruedLabel: formatMoneyUz(p.accrued),
        paid: p.paid,
        paidLabel: formatMoneyUz(p.paid),
        debt: p.debt,
        debtLabel: formatMoneyUz(p.debt),
        entryCount: p.staffCount,
        unpaidCount: p.unpaidCount,
        cancelledCount,
        previousAccrued: p.previousAccrued,
        previousPaid: p.previousPaid,
        accruedChangePercent: p.accruedChange,
        paidChangePercent: p.paidChange,
      },
      assigned: {
        amount: p.assigned,
        amountLabel: formatMoneyUz(p.assigned),
        previousAmount: p.previousAssigned,
        changePercent: p.assignedChange,
        note: "Belgilangan summa amaldagi qoidalar, lavozim va toifalardan jonli hisoblanadi; muhrlangan summadan farq qilishi mumkin.",
      },
      generated: p.staffCount > 0,
      staff: {
        total: staff.total,
        truncated: staff.truncated,
        items: staff.items.map((row) => ({
          staffId: row.staffId,
          fullName: row.fullName,
          role: row.role,
          ...(row.isArchived ? { isArchived: true } : {}),
          amount: row.amount,
          paidAmount: row.paidAmount,
          debt: row.debt,
          statusLabel: ENTRY_STATUS_LABELS[row.status] ?? row.status,
          salaryTypeLabel: row.salaryTypeLabel,
          ...(row.hoursWorked != null ? { lessonHours: row.hoursWorked } : {}),
          sharePercent: row.share,
        })),
      },
    };
  },
});

const payrollDebts = defineTool({
  name: "payroll_debts",
  toolset: TOOLSET,
  label: "Xodimlarga oylik qarzi",
  description:
    "Unpaid and partially paid payroll entries (what the school still owes staff), newest month first. Without month " +
    "it covers ALL months, so totals.debt is the all-time salary debt. Each row has entryId, staffId, staffName, " +
    "monthLabel, amount, paidAmount, debt, statusLabel. Use before proposing a salary payment. List is truncated to " +
    "limit (see total).",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      month: monthSchema("Month as YYYYMM to restrict to one month. Omit for all months."),
      limit: limitSchema(80),
    },
  },
  async handler(args, ctx) {
    const month = args.month === undefined ? undefined : monthArg(args.month);
    const limit = args.limit ?? 20;
    const result = await payrollService.getEntries(
      reqLike(ctx, { debtOnly: "true", month, limit }),
    );

    if (result.pagination.total === 0) {
      return {
        empty: true,
        reason: month
          ? `${monthLabel(month)} uchun to'lanmagan oylik yo'q`
          : "Hech qaysi oy uchun to'lanmagan oylik yo'q",
      };
    }

    return {
      scope: month ? monthLabel(month) : "Barcha oylar",
      totalDebt: result.totals.debt,
      totalDebtLabel: formatMoneyUz(result.totals.debt),
      total: result.pagination.total,
      truncated: result.pagination.total > result.data.length,
      items: result.data.map((row) => ({
        entryId: row.id,
        staffId: row.staffId,
        staffName: row.staffName,
        month: row.month,
        monthLabel: row.monthLabel,
        amount: row.amount,
        paidAmount: row.paidAmount,
        debt: row.debt,
        statusLabel: row.statusLabel,
      })),
    };
  },
});

const payrollStaff = defineTool({
  name: "payroll_staff",
  toolset: TOOLSET,
  label: "Xodim oyligi tafsiloti",
  description:
    "Full payroll picture for ONE staff member (resolve the id with search_people first): position/category assignment, " +
    "live engine preview of this month's pay (fixed + KPI hours × rate + allowances), salary rule history (periods), " +
    "sealed payroll entries with debt (last 12), cancelled months (these months can never be regenerated), and the " +
    "last 10 salary payments. Use it before proposing any salary change or payment for that person.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["staffId"],
    properties: { staffId: idSchema("Staff user id (24-hex).") },
  },
  async handler(args, ctx) {
    const staffId = requireId(args.staffId, "Xodim id");
    const user = await loadPayrollUser(staffId);
    if (user.role === ROLES.STUDENT) {
      throw new AiToolError("Bu foydalanuvchi o'quvchi — o'quvchida oylik bo'lmaydi");
    }

    const [history, entries, payments, cancelled, engineCtx] = await Promise.all([
      staffSalaryService.getStaffHistory(staffId),
      payrollService.getStaffEntries(staffId),
      salaryPaymentService.getPayments(reqLike(ctx, { staffId, limit: 10 })),
      prisma.payrollEntry.findMany({
        where: { staffId, status: "cancelled" },
        select: { month: true, cancelReason: true, cancelledAt: true },
        orderBy: { month: "desc" },
      }),
      payrollEngine.loadContext(ctx.monthKey, [user]),
    ]);

    const live = payrollEngine.previewForStaff(user, ctx.monthKey, engineCtx);
    const rules = sliceList(history.items, 12);
    const entryList = sliceList(entries.items, 12);

    return {
      staff: {
        id: user.id,
        name: personName(user),
        role: user.role,
        isArchived: user.isArchived,
      },
      assignment: {
        positionId: user.positionId,
        positionName: live?.positionName || null,
        salaryCategoryId: user.salaryCategoryId,
        categoryName: live?.categoryName || null,
        departmentName: live?.departmentName || null,
      },
      livePreview: {
        month: ctx.monthKey,
        monthLabel: monthLabel(ctx.monthKey),
        eligible: Boolean(live),
        ...(live
          ? compactPreview(live)
          : { reason: "Lavozim, toifa yoki oylik qoidasi yo'q — oylik hisoblanmaydi" }),
      },
      salaryRules: {
        currentRuleId: history.current?.id ?? null,
        total: rules.total,
        truncated: rules.truncated,
        items: rules.items.map((rule) => ({
          id: rule.id,
          periodLabel: rule.periodLabel,
          startMonth: rule.startMonth,
          endMonth: rule.endMonth,
          isOpen: rule.isOpen,
          typeLabel: rule.typeLabel,
          fixedAmount: rule.fixedAmount,
          perHourRate: rule.perHourRate,
          allowances: rule.allowances,
          note: rule.note || null,
        })),
      },
      entries: {
        accrued: entries.totals.accrued,
        paid: entries.totals.paid,
        debt: entries.totals.debt,
        debtLabel: formatMoneyUz(entries.totals.debt),
        unpaidCount: entries.totals.unpaidCount,
        total: entryList.total,
        truncated: entryList.truncated,
        items: entryList.items.map(compactEntry),
      },
      cancelledMonths: cancelled.map((row) => ({
        month: row.month,
        monthLabel: monthLabel(row.month),
        reason: row.cancelReason || null,
        cancelledAtLabel: formatDateTimeUz(row.cancelledAt),
      })),
      recentPayments: {
        totalCount: payments.pagination.total,
        items: payments.data.map((payment) => ({
          id: payment.id,
          paidAtLabel: formatDateUz(payment.paidAt),
          amount: payment.amount,
          accountName: payment.accountName,
          months: (payment.allocations || []).map((a) => a.monthLabel),
          note: payment.note || null,
        })),
      },
    };
  },
});

const payrollProjection = defineTool({
  name: "payroll_projection",
  toolset: TOOLSET,
  label: "Bo'lim yoki toifa bo'yicha oylik prognozi",
  description:
    "Live payroll projection (not sealed values) for everyone in ONE staff department (pass departmentId; pay = position " +
    "base + extra fixed + allowances) or ONE teaching salary category (pass categoryId; pay = rate × scheduled lesson " +
    "hours + extras), computed by the payroll engine for the month. Returns department/category info, totals and up " +
    "to 100 people. Get ids from payroll_catalog.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      departmentId: idSchema("Staff department id (kind 'staff'). Use either departmentId or categoryId."),
      categoryId: idSchema("Teaching salary category id. Use either departmentId or categoryId."),
      month: monthSchema(),
      search: { type: "string", maxLength: 60, description: "Optional name filter." },
    },
  },
  async handler(args, ctx) {
    if (Boolean(args.departmentId) === Boolean(args.categoryId)) {
      throw new AiToolError("departmentId yoki categoryId dan aynan bittasini bering");
    }
    const month = monthArg(args.month);
    const query = { month, search: args.search, limit: 100 };

    const result = args.departmentId
      ? await payrollViewService.getStaffPayroll(reqLike(ctx, { ...query, departmentId: args.departmentId }))
      : await payrollViewService.getTeacherPayroll(reqLike(ctx, { ...query, categoryId: args.categoryId }));

    return {
      scope: result.department
        ? { type: "department", id: result.department.id, name: result.department.name, kind: result.department.kind }
        : {
            type: "category",
            id: result.category.id,
            name: result.category.name,
            perHourRate: result.category.perHourRate,
            departmentName: result.category.department?.name ?? null,
          },
      month: result.month,
      monthLabel: result.monthLabel,
      totals: {
        ...result.totals,
        amountLabel: formatMoneyUz(result.totals.amount),
      },
      total: result.pagination.total,
      truncated: result.pagination.total > result.data.length,
      items: result.data.map((row) => ({
        id: row.id,
        fullName: row.fullName,
        role: row.role,
        positionName: row.positionName || null,
        categoryName: row.categoryName || null,
        salaryTypeLabel: row.salaryType ? SALARY_TYPE_LABELS[row.salaryType] : null,
        fixedAmount: row.fixedAmount ?? null,
        kpiAmount: row.kpiAmount ?? null,
        lessonHours: row.lessonHours ?? null,
        allowanceAmount: row.allowanceAmount ?? null,
        amount: row.amount ?? null,
      })),
    };
  },
});

const payrollCatalog = defineTool({
  name: "payroll_catalog",
  toolset: TOOLSET,
  label: "Oylik va xarajat kataloglari",
  description:
    "Reference ids for payroll and expense actions: departments (staff/teaching), positions with base salary and " +
    "number of non-archived holders, teaching salary categories with hourly rate and teacher count, expense " +
    "categories, and active payment accounts (to'lov turi) with balances. Call it to resolve positionId, " +
    "salaryCategoryId, categoryId (expense) or accountId before proposing an action.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async handler() {
    const [departments, positions, categories, expenseCategories, accounts] = await Promise.all([
      departmentService.getDepartments({}),
      positionService.getPositions({}),
      salaryCategoryService.getCategories({}),
      expenseCategoryService.getCategories({}),
      paymentAccountService.getAccounts({ status: "active" }),
    ]);

    return {
      departments: departments.map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind,
        isActive: d.isActive,
        positionCount: d.positionCount,
        categoryCount: d.categoryCount,
      })),
      positions: positions.map((p) => ({
        id: p.id,
        name: p.name,
        departmentId: p.departmentId,
        departmentName: p.departmentName,
        baseSalary: p.baseSalary,
        baseSalaryLabel: formatMoneyUz(p.baseSalary),
        staffCount: p.staffCount,
        isActive: p.isActive,
      })),
      salaryCategories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        departmentName: c.departmentName,
        perHourRate: c.perHourRate,
        teacherCount: c.usageCount,
        isActive: c.isActive,
      })),
      expenseCategories: expenseCategories.items.map((c) => ({
        id: c.id,
        name: c.name,
        isActive: c.isActive,
        excludeFromEbitda: c.excludeFromEbitda,
        expenseCount: c.usageCount,
      })),
      paymentAccounts: accounts.items.map((a) => ({
        id: a.id,
        name: a.name,
        balance: a.balance,
        balanceLabel: formatMoneyUz(a.balance),
      })),
    };
  },
});

const payrollUnconfiguredStaff = defineTool({
  name: "payroll_unconfigured_staff",
  toolset: TOOLSET,
  label: "Oyligi belgilanmagan xodimlar",
  description:
    "Anomaly check: non-archived, non-student users who get NO pay for the month because they have no position, no " +
    "salary category and no salary rule covering that month (the payroll engine skips them). Also returns people " +
    "whose engine amount is zero (e.g. hourly teachers without lessons). Up to 100 rows each.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { month: monthSchema() },
  },
  async handler(args) {
    const month = monthArg(args.month);
    const salaryRules = await staffSalaryService.resolveSalariesForMonth(month);

    const staff = await prisma.user.findMany({
      where: { isArchived: false, role: { not: ROLES.STUDENT } },
      select: PAYROLL_USER_SELECT,
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    });

    const unconfigured = staff.filter(
      (u) => !u.positionId && !u.salaryCategoryId && !salaryRules.has(u.id),
    );
    const configured = staff.filter(
      (u) => u.positionId || u.salaryCategoryId || salaryRules.has(u.id),
    );

    const engineCtx = configured.length
      ? await payrollEngine.loadContext(month, configured, { salaryRules })
      : null;
    const zeroAmount = configured.filter((u) => {
      const preview = payrollEngine.previewForStaff(u, month, engineCtx);
      return preview && Number(preview.amount) <= 0;
    });

    const toRow = (u) => ({ id: u.id, name: personName(u), role: u.role });
    const unconfiguredList = sliceList(unconfigured, 100);
    const zeroList = sliceList(zeroAmount, 100);

    return {
      month,
      monthLabel: monthLabel(month),
      staffTotal: staff.length,
      configuredCount: configured.length,
      unconfigured: { ...unconfiguredList, items: unconfiguredList.items.map(toRow) },
      zeroAmount: { ...zeroList, items: zeroList.items.map(toRow) },
    };
  },
});

const payrollRequests = defineTool({
  name: "payroll_requests",
  toolset: TOOLSET,
  label: "Oylik bo'yicha arizalar",
  description:
    "Staff payroll requests (category change or allowance/bonus requests submitted from the staff panel) with status, " +
    "reason, requested category or bonus terms and review info, newest first (all statuses unless filtered). " +
    "Includes the overall pendingCount. Use before proposing propose_review_payroll_request.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: ["pending", "approved", "rejected"], description: "Filter by status." },
      kind: { type: "string", enum: ["category", "bonus"], description: "Filter by request kind." },
      limit: limitSchema(50),
    },
  },
  async handler(args) {
    const result = await payrollRequestService.getAllRequests({
      status: args.status,
      kind: args.kind,
      limit: args.limit ?? 20,
    });

    if (result.pagination.total === 0) {
      return {
        empty: true,
        pendingCount: result.pendingCount,
        reason: "Tanlangan filtr bo'yicha oylik arizasi topilmadi",
      };
    }

    return {
      pendingCount: result.pendingCount,
      total: result.pagination.total,
      truncated: result.pagination.total > result.data.length,
      items: result.data.map((r) => ({
        id: r.id,
        staffId: r.staffId,
        staffName: r.staffName,
        kind: r.kind,
        kindLabel: REQUEST_KIND_LABELS[r.kind] ?? r.kind,
        status: r.status,
        statusLabel: REVIEW_STATUS_LABELS[r.status] ?? r.status,
        reason: r.reason || null,
        requestedCategoryId: r.requestedCategoryId,
        requestedCategoryName: r.requestedCategoryName,
        bonus:
          r.kind === "bonus"
            ? {
                label: r.bonusLabel,
                type: r.bonusType,
                value: r.bonusValue,
                startMonthLabel: r.bonusStartMonthLabel,
                endMonthLabel: r.bonusEndMonthLabel,
              }
            : null,
        attachmentCount: r.attachments.length,
        createdAtLabel: r.createdAtLabel,
        reviewerName: r.reviewerName,
        reviewedAtLabel: r.reviewedAtLabel,
        rejectionReason: r.rejectionReason,
      })),
    };
  },
});

const payrollAuditLog = defineTool({
  name: "payroll_audit_log",
  toolset: TOOLSET,
  label: "Oylik tuzilmasi o'zgarishlari jurnali",
  description:
    "Audit log of payroll structure decisions, newest first: position base salary changes (position.update), staff " +
    "position/category assignments (staff.assign), category assignments and bonus approvals from requests " +
    "(category.assign, bonus.approve, request.reject) and salary rule changes made by the assistant (salary.change). " +
    "Each row: who, when, summary, old/new values. Answers 'why did this person's salary change'.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: ["position.update", "staff.assign", "category.assign", "bonus.approve", "request.reject", "salary.change"],
        description: "Filter by audit action.",
      },
      targetId: idSchema("Filter by target id (user, position, bonus or request id)."),
      limit: limitSchema(100),
    },
  },
  async handler(args) {
    const result = await payrollAuditService.list({
      action: args.action,
      targetId: args.targetId,
      limit: args.limit ?? 20,
    });
    if (result.pagination.total === 0) {
      return { empty: true, reason: "Oylik tuzilmasi bo'yicha audit yozuvi topilmadi" };
    }
    return {
      total: result.pagination.total,
      truncated: result.pagination.total > result.data.length,
      items: result.data.map((row) => ({
        id: row.id,
        createdAtLabel: row.createdAtLabel,
        actorName: row.actorName,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        summary: row.summary,
        oldValue: row.oldValue,
        newValue: row.newValue,
      })),
    };
  },
});

const payrollLessonHours = defineTool({
  name: "payroll_lesson_hours",
  toolset: TOOLSET,
  label: "O'qituvchilar dars soati",
  description:
    "Lesson-hour load from the timetable for the month (1 hour = 1 lesson): scheduled hours, hours given to / taken " +
    "from substitutes (o'rinbosar), final paid hours, hours taught so far this month, weekly load, and the payroll " +
    "engine's projected pay (KPI = category hourly rate × hours) for each teacher. Without teacherId: every teacher " +
    "who has timetable lessons or a salary category, sorted by hours (max 60). With teacherId: one teacher with " +
    "breakdown by weekday, class and subject.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      teacherId: idSchema("Teacher user id for a detailed breakdown."),
      month: monthSchema(),
    },
  },
  async handler(args) {
    const month = monthArg(args.month);
    const cutoff = lessonHoursService.cutoffForMonth(month);

    let users;
    if (args.teacherId) {
      const user = await loadPayrollUser(requireId(args.teacherId, "O'qituvchi id"), "O'qituvchi");
      if (user.role === ROLES.STUDENT) throw new AiToolError("O'qituvchi topilmadi");
      users = [user];
    } else {
      const lessonTeachers = await prisma.scheduleLesson.findMany({
        distinct: ["teacherId"],
        select: { teacherId: true },
      });
      users = await prisma.user.findMany({
        where: {
          isArchived: false,
          role: { not: ROLES.STUDENT },
          OR: [
            { id: { in: lessonTeachers.map((row) => row.teacherId) } },
            { salaryCategoryId: { not: null } },
          ],
        },
        select: PAYROLL_USER_SELECT,
      });
    }

    if (users.length === 0) {
      return { empty: true, reason: "Dars jadvalida darsi bor yoki toifaga biriktirilgan o'qituvchi topilmadi" };
    }

    const [hoursMap, engineCtx] = await Promise.all([
      lessonHoursService.getTeachersHours(
        users.map((u) => u.id),
        month,
        { asOfDayOfMonth: cutoff },
      ),
      payrollEngine.loadContext(month, users),
    ]);

    const rowOf = (user) => {
      const info = hoursMap.get(user.id);
      const pay = payrollEngine.previewForStaff(user, month, engineCtx);
      return {
        id: user.id,
        name: personName(user),
        categoryName: pay?.categoryName || null,
        weeklyHours: info?.weeklyHours ?? 0,
        scheduledHours: info?.scheduledHours ?? 0,
        substitutedOutHours: info?.substitutedOutHours ?? 0,
        substitutedInHours: info?.substitutedInHours ?? 0,
        hours: info?.hours ?? 0,
        taughtHours: info?.taughtHours ?? 0,
        remainingHours: info?.remainingHours ?? 0,
        perHourRate: pay?.perHourRate ?? null,
        kpiAmount: pay?.kpiAmount ?? null,
        projectedPay: pay?.amount ?? null,
        payConfigured: Boolean(pay),
      };
    };

    const sample = hoursMap.values().next().value;
    const calendar = {
      month,
      monthLabel: monthLabel(month),
      isVacationMonth: sample?.isVacationMonth ?? false,
      teachingDays: sample?.teachingDays ?? 0,
      taughtDays: sample?.taughtDays ?? 0,
      holidayCount: sample?.holidayCount ?? 0,
    };

    if (args.teacherId) {
      const user = users[0];
      const info = hoursMap.get(user.id);
      return {
        ...calendar,
        teacher: rowOf(user),
        byDay: (info?.byDay ?? []).map((d) => ({ dayLabel: d.dayLabel, hours: d.hours, occurrences: d.occurrences })),
        byClass: sliceList(info?.byClass ?? [], 15),
        bySubject: sliceList(info?.bySubject ?? [], 15),
      };
    }

    const rows = users.map(rowOf).sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));
    const list = sliceList(rows, 60);
    return {
      ...calendar,
      teacherCount: rows.length,
      totalHours: rows.reduce((sum, row) => sum + row.hours, 0),
      withoutPayConfig: rows.filter((row) => !row.payConfigured).length,
      ...list,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// XARAJATLAR
// ─────────────────────────────────────────────────────────────────────────

const expensesReport = defineTool({
  name: "expenses_report",
  toolset: TOOLSET,
  label: "Chiqim hisoboti",
  description:
    "Outflow report for a day range (default: last 365 days): total outflow = PAID salaries + expenses, split salary vs " +
    "other, expenses by category with share, monthly series, the 10 latest expenses, and the current all-time unpaid " +
    "salary debt (not included in outflow). Dates are 'YYYY-MM-DD' (Tashkent).",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      from: daySchema("Start day 'YYYY-MM-DD'. Default: 364 days before 'to'."),
      to: daySchema("End day 'YYYY-MM-DD'. Default: today."),
    },
  },
  async handler(args) {
    const report = await financeReportService.getExpenseReport({ from: args.from, to: args.to });
    return {
      rangeLabel: `${formatDateUz(report.from, { utc: true })} — ${formatDateUz(report.to, { utc: true })}`,
      totals: {
        ...report.totals,
        amountLabel: formatMoneyUz(report.totals.amount),
        salaryLabel: formatMoneyUz(report.totals.salary),
        otherLabel: formatMoneyUz(report.totals.other),
        salaryDebtLabel: formatMoneyUz(report.totals.salaryDebt),
      },
      bySource: report.bySource,
      byCategory: sliceList(report.byCategory, 30),
      series: report.series.map((row) => ({
        monthLabel: row.monthLabel,
        salary: row.salary,
        other: row.other,
        total: row.total,
      })),
      recent: report.recent.map((row) => ({
        id: row.id,
        occurredAtLabel: formatDateUz(row.occurredAt),
        categoryName: row.categoryName,
        amount: row.amount,
        payee: row.payee || null,
        accountName: row.accountName,
      })),
    };
  },
});

const expensesBudgets = defineTool({
  name: "expenses_budgets",
  toolset: TOOLSET,
  label: "Xarajat limitlari",
  description:
    "Monthly expense limits by category for the month: limit, spent (non-voided expenses in the Tashkent month; " +
    "salaries excluded), remaining (negative = over), rate %, status ok (≤90%) / warning (≤100%) / over / none (no " +
    "limit), plus totals and overCount. Limits never block spending. Use before proposing propose_set_expense_budget.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { month: monthSchema() },
  },
  async handler(args) {
    const month = monthArg(args.month);
    const result = await expenseBudgetService.getBudgets({ month });
    return {
      month: result.month,
      monthLabel: result.monthLabel,
      totals: {
        ...result.totals,
        limitLabel: formatMoneyUz(result.totals.limit),
        spentLabel: formatMoneyUz(result.totals.spent),
      },
      items: result.items.map((row) => ({
        categoryId: row.categoryId,
        name: row.name,
        isActive: row.isActive,
        isArchived: Boolean(row.isArchived),
        limit: row.limit,
        spent: row.spent,
        remaining: row.remaining,
        ratePercent: row.rate,
        status: row.status,
        expenseCount: row.expenseCount,
        note: row.note || null,
      })),
    };
  },
});

const expensesList = defineTool({
  name: "expenses_list",
  toolset: TOOLSET,
  label: "Xarajatlar ro'yxati",
  description:
    "Expense ledger rows (non-voided), newest first, filtered by day range, expense category and/or payment account: " +
    "date, category, amount, payee, note, payment account; totals.amount and totals.count cover the WHOLE filter, not " +
    "just the returned page.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      from: daySchema("Start day 'YYYY-MM-DD'."),
      to: daySchema("End day 'YYYY-MM-DD'."),
      categoryId: idSchema("Expense category id."),
      accountId: idSchema("Payment account id."),
      limit: limitSchema(100),
    },
  },
  async handler(args, ctx) {
    const result = await expenseService.getExpenses(
      reqLike(ctx, {
        from: args.from,
        to: args.to,
        categoryId: args.categoryId,
        accountId: args.accountId,
        limit: args.limit ?? 20,
      }),
    );
    if (result.pagination.total === 0) {
      return { empty: true, reason: "Tanlangan filtr bo'yicha xarajat topilmadi" };
    }
    return {
      totals: { ...result.totals, amountLabel: formatMoneyUz(result.totals.amount) },
      total: result.pagination.total,
      truncated: result.pagination.total > result.data.length,
      items: result.data.map((row) => ({
        id: row.id,
        occurredAtLabel: formatDateUz(row.occurredAt),
        categoryName: row.categoryName,
        amount: row.amount,
        payee: row.payee || null,
        note: row.note || null,
        accountName: row.accountName,
      })),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// JARIMALAR
// ─────────────────────────────────────────────────────────────────────────

const compactPenalty = (row) => ({
  id: row.id,
  type: row.type,
  typeLabel: PENALTY_TYPE_LABELS[row.type] ?? row.type,
  status: row.status,
  statusLabel: REVIEW_STATUS_LABELS[row.status] ?? row.status,
  title: row.title || row.category?.title || null,
  description: row.description || null,
  points: row.points,
  isCustom: row.isCustom,
  ...(row.user !== undefined
    ? {
        user: row.user
          ? {
              id: row.user.id,
              name: personName(row.user),
              role: row.user.role,
              penaltyPoints: row.user.penaltyPoints,
            }
          : null,
      }
    : {}),
  givenByName: row.givenBy && typeof row.givenBy === "object" ? personName(row.givenBy) : null,
  reviewedByName: row.reviewedBy && typeof row.reviewedBy === "object" ? personName(row.reviewedBy) : null,
  rejectionReason: row.rejectionReason || null,
  attachmentCount: Array.isArray(row.attachments) ? row.attachments.length : 0,
  createdAtLabel: formatDateTimeUz(row.createdAt),
});

const penaltiesStats = defineTool({
  name: "penalties_stats",
  toolset: TOOLSET,
  label: "Jarimalar statistikasi",
  description:
    "Penalty points overview (points, not money; penalties never change payroll): all-time approved penalty and " +
    "reduction points, pending count, top 10 staff and top 10 students by current penalty points, 30-day daily " +
    "trend (non-zero days only), the active penalty categories (ids for propose_give_penalty) and fine amount " +
    "snapshots per role. Student market is blocked above 3 points.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async handler() {
    const [stats, categories, settings] = await Promise.all([
      penaltyService.getPenaltyStats(),
      penaltyService.getCategories(),
      penaltyService.getSettings(),
    ]);
    const toTop = (u) => ({ name: personName(u), role: u.role, penaltyPoints: u.penaltyPoints });

    return {
      totalApprovedPoints: stats.totalApprovedPoints,
      totalReducedPoints: stats.totalReducedPoints,
      pendingCount: stats.pendingCount,
      topStaff: stats.topUsers.map(toTop),
      topStudents: stats.topStudents.map(toTop),
      last30Days: compactDailyTrend(stats.dailyTrend, ["penaltyPoints", "reductionPoints"]),
      categories: categories.map((c) => ({
        id: c.id,
        title: c.title,
        points: c.points,
        targetRole: c.targetRole,
      })),
      fineAmountsByRole: settings.fineAmounts || {},
    };
  },
});

const penaltiesPending = defineTool({
  name: "penalties_pending",
  toolset: TOOLSET,
  label: "Tasdiq kutayotgan jarimalar",
  description:
    "Penalties and point reductions waiting for review (submitted by teachers or reception), newest first: user with " +
    "current penalty points, who gave it, title, points, attachment count. Use before propose_review_penalty.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { limit: limitSchema(50) },
  },
  async handler(args, ctx) {
    const result = await penaltyService.getPendingPenalties(reqLike(ctx, { limit: args.limit ?? 20 }));
    if (result.pagination.total === 0) {
      return { empty: true, reason: "Tasdiq kutayotgan jarima yo'q" };
    }
    return {
      total: result.pagination.total,
      truncated: result.pagination.total > result.data.length,
      items: result.data.map(compactPenalty),
    };
  },
});

const penaltiesUser = defineTool({
  name: "penalties_user",
  toolset: TOOLSET,
  label: "Foydalanuvchi jarimalari",
  description:
    "Penalty history of ONE user (student or staff): current penalty points, penalties (all statuses, newest first) " +
    "and point reductions. Resolve the user id with search_people first.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["userId"],
    properties: {
      userId: idSchema("User id (24-hex)."),
      limit: limitSchema(50),
    },
  },
  async handler(args, ctx) {
    const userId = requireId(args.userId, "Foydalanuvchi id");
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, firstName: true, lastName: true, username: true, role: true, penaltyPoints: true, isArchived: true },
    });
    if (!user) throw new AiToolError("Foydalanuvchi topilmadi");

    const [penalties, reductions] = await Promise.all([
      penaltyService.getUserPenalties(userId, reqLike(ctx, { limit: args.limit ?? 20 })),
      penaltyService.getReductions(reqLike(ctx, { userId, limit: 10 })),
    ]);

    return {
      user: {
        id: user.id,
        name: personName(user),
        role: user.role,
        isArchived: user.isArchived,
        penaltyPoints: user.penaltyPoints,
      },
      penalties: {
        total: penalties.pagination.total,
        truncated: penalties.pagination.total > penalties.data.length,
        items: penalties.data.map(compactPenalty),
      },
      reductions: {
        total: reductions.pagination.total,
        truncated: reductions.pagination.total > reductions.data.length,
        items: reductions.data.map((row) => {
          const compact = compactPenalty(row);
          delete compact.user;
          return compact;
        }),
      },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// PREMIUM VA TANGALAR
// ─────────────────────────────────────────────────────────────────────────

const premiumStats = defineTool({
  name: "premium_stats",
  toolset: TOOLSET,
  label: "Premium obuna holati",
  description:
    "Student premium subscriptions: active count, expiring within 7 days, totals by source (coin purchase vs manual " +
    "grant), coins spent on premium, 30-day trend (non-zero days). With studentId: that student's premium status and " +
    "last 10 subscriptions. Use before propose_grant_premium / propose_revoke_premium.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { studentId: idSchema("Optional student id for per-student subscription history.") },
  },
  async handler(args, ctx) {
    const stats = await premiumService.getStats();
    const out = {
      activeCount: stats.activeCount,
      expiringSoon: stats.expiringSoon,
      totalSubscriptions: stats.totalSubscriptions,
      purchaseCount: stats.purchaseCount,
      grantCount: stats.grantCount,
      coinsSpentOnPremium: stats.totalRevenue,
      last30Days: compactDailyTrend(stats.dailyTrend, ["count", "revenue"]),
    };

    if (!args.studentId) return out;

    const studentId = requireId(args.studentId, "O'quvchi id");
    const student = await prisma.user.findUnique({
      where: { id: studentId },
      select: { id: true, firstName: true, lastName: true, username: true, role: true, premiumIsActive: true, premiumExpiresAt: true, coinBalance: true },
    });
    if (!student) throw new AiToolError("O'quvchi topilmadi");

    const subscriptions = await premiumService.getSubscriptions(reqLike(ctx, { studentId, limit: 10 }));
    out.student = {
      id: student.id,
      name: personName(student),
      role: student.role,
      premiumActive: student.premiumIsActive && Boolean(student.premiumExpiresAt) && student.premiumExpiresAt > ctx.now,
      premiumExpiresAtLabel: formatDateTimeUz(student.premiumExpiresAt),
      coinBalance: student.coinBalance,
      subscriptions: subscriptions.data.map((row) => ({
        id: row.id,
        status: row.status,
        statusLabel: PREMIUM_STATUS_LABELS[row.status] ?? row.status,
        sourceLabel: PREMIUM_SOURCE_LABELS[row.source ?? "purchase"] ?? row.source,
        durationDays: row.durationDays,
        coinCost: row.coinCost,
        periodLabel: `${formatDateUz(row.startDate)} — ${formatDateUz(row.endDate)}`,
        grantedByName: row.grantedBy ? personName(row.grantedBy) : null,
      })),
    };
    return out;
  },
});

const coinsStats = defineTool({
  name: "coins_stats",
  toolset: TOOLSET,
  label: "Tanga iqtisodiyoti",
  description:
    "Coin economy: sum of all coin transaction amounts (includes spends and manual takes, amounts are stored positive), " +
    "coins currently held by active users, active student count, top 10 students by balance, 30-day daily distribution " +
    "(non-zero days) and the automatic coin settings. With studentId: that student's balance and last 20 coin " +
    "transactions.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { studentId: idSchema("Optional student id for transaction history.") },
  },
  async handler(args) {
    const [stats, settings] = await Promise.all([coinService.getCoinStats(), coinService.getSettings()]);
    const out = {
      totalTransactionAmount: stats.totalCoinsDistributed,
      coinsHeldByActiveUsers: stats.availableCoins,
      activeStudents: stats.totalStudents,
      topStudents: stats.topEarners.map((u) => ({
        id: u.id,
        name: u.fullName,
        coinBalance: u.coinBalance,
        classes: (u.classes || []).map((c) => c.name),
      })),
      last30Days: compactDailyTrend(stats.dailyDistribution, ["totalDistributed"]),
      settings: {
        dailyCoinPercentage: settings.dailyCoinPercentage,
        schoolRankBonus: settings.schoolRankBonus,
        classRankBonus: settings.classRankBonus,
        minDailyGradeForCoin: settings.minDailyGradeForCoin,
      },
    };

    if (!args.studentId) return out;

    const studentId = requireId(args.studentId, "O'quvchi id");
    const student = await prisma.user.findUnique({
      where: { id: studentId },
      select: { id: true, firstName: true, lastName: true, username: true, role: true, coinBalance: true },
    });
    if (!student) throw new AiToolError("O'quvchi topilmadi");

    const history = await coinService.getStudentTransactions(studentId, 1, 20);
    out.student = {
      id: student.id,
      name: personName(student),
      role: student.role,
      coinBalance: student.coinBalance,
      transactionTotal: history.pagination.total,
      transactions: history.transactions.map((t) => ({
        dateLabel: formatDateTimeUz(t.date),
        type: t.type,
        amount: t.amount,
        balanceAfter: t.balanceAfter,
        description: t.description,
      })),
    };
    return out;
  },
});

module.exports = [
  payrollOverview,
  payrollDebts,
  payrollStaff,
  payrollProjection,
  payrollCatalog,
  payrollUnconfiguredStaff,
  payrollRequests,
  payrollAuditLog,
  payrollLessonHours,
  expensesReport,
  expensesBudgets,
  expensesList,
  penaltiesStats,
  penaltiesPending,
  penaltiesUser,
  premiumStats,
  coinsStats,
];
