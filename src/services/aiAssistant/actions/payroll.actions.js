/**
 * AI YORDAMCHI — CHIQIM bo'limi amallari (taklif → ko'rinish → tasdiq → bajarish).
 *
 * Har bir `execute` HTTP controller qanday chaqirsa AYNAN shunday servisni
 * chaqiradi (aktyor `ctx.user.id`, controller'dagi qo'shimcha shartlar
 * `prepare` da). Biznes hisobi bu yerda qayta yozilmaydi: oylik summasi
 * `payrollEngine` dan, taqsimot `previewPayment` dan, shakllantirish
 * `generateForMonth({ dryRun: true })` dan olinadi.
 *
 * ⚠️ ATAYLAB YO'Q amallar (`design.md` §3.2.6 va xarita D3):
 *   - oylik majburiyatini bekor qilish — keyingi shakllantirish uni o'sha
 *     qatorda qayta hisoblab tiklaydi (`generateForMonth`, `restored`), lekin
 *     oraliqda xodimning qarzi registrdan yo'qoladi; bu qaror admin panelda;
 *   - oylik to'lovini va xarajatni bekor qilish (void) — pulni teskari
 *     harakatlantiradi, faqat admin paneldan.
 *
 * ⚠️ OYLIK O'ZGARTIRISH `.claude/rules/finance.md` §10 bo'yicha EMAS, KOD
 * bo'yicha (payroll v2): muhrlangan oy qayta hisoblanmaydi, shuning uchun
 * o'zgarish majburiyati YO'Q birinchi oydan qo'llanadi.
 */

const prisma = require("../../../config/prisma");
const logger = require("../../../utils/logger");
const { ROLES } = require("../../../utils/constants");
const {
  defineAction,
  AiToolError,
  idSchema,
  monthSchema,
  daySchema,
  requireId,
  monthArg,
  dayArg,
  formatMoneyUz,
  monthLabel,
  personName,
} = require("../assistant.toolkit");
const { Decimal, parseAmount, formatAmount } = require("../../../helpers/money.helpers");
const {
  nextMonth,
  prevMonth,
  formatMonthRange,
  OPEN_END_MONTH,
} = require("../../../helpers/month.helpers");
const { formatDateUz } = require("../../../helpers/date.helpers");
const { normalizeAllowances } = require("../../../helpers/salaryRules.helpers");
const { escapeHtml } = require("../../../helpers/changelogMessage.helpers");

const payrollService = require("../../payroll.service");
const payrollEngine = require("../../payrollEngine.service");
const payrollAuditService = require("../../payrollAudit.service");
const payrollRequestService = require("../../payrollRequest.service");
const staffSalaryService = require("../../staffSalary.service");
const salaryPaymentService = require("../../salaryPayment.service");
const departmentService = require("../../department.service");
const positionService = require("../../position.service");
const expenseService = require("../../expense.service");
const expenseCategoryService = require("../../expenseCategory.service");
const expenseBudgetService = require("../../expenseBudget.service");
const paymentAccountService = require("../../paymentAccount.service");
const penaltyService = require("../../penalty.service");
const premiumService = require("../../premium.service");
const coinService = require("../../coin.service");
const { getPremiumSettings, getFinanceSettings } = require("../../settings.service");

const TOOLSET = "payroll";

/** Engine kutadigan foydalanuvchi maydonlari (`payroll.service` dagi to'plam eksport qilinmagan). */
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

const ENTRY_STATUS_LABELS = payrollService.STATUS_LABELS;
const SALARY_TYPE_LABELS = staffSalaryService.TYPE_LABELS;
const DECISIONS = ["approved", "rejected"];
const GENDER_LABELS = { male: "O'g'il bolalar / erkaklar", female: "Qizlar / ayollar" };

// ─────────────────────────────────────────────────────────────────────────
// Yordamchilar
// ─────────────────────────────────────────────────────────────────────────

/**
 * Servisning "kutilgan" xatosini (4xx) egaga ko'rinadigan `AiToolError` ga
 * aylantiradi. `prepare` da ishlatiladi: xato tasdiqdan OLDIN chiqishi kerak.
 */
const asToolError = async (work) => {
  try {
    return await work();
  } catch (err) {
    if (err instanceof AiToolError) throw err;
    if (err?.statusCode && err.statusCode < 500) throw new AiToolError(err.message);
    throw err;
  }
};

/**
 * `penalty.service` va `coin.service` validatsiya xatolarini oddiy `Error`
 * bilan tashlaydi (statusCode yo'q → HTTP'da 500). Xabarlari o'zbekcha va
 * egaga mo'ljallangan, shuning uchun ular 400 sifatida ko'rsatiladi.
 * ⚠️ Faqat AYNAN `Error` klassi: Prisma va boshqa ichki xatolar subklass —
 * ular yashirilmaydi.
 */
const surfacePlainError = async (work) => {
  try {
    return await work();
  } catch (err) {
    if (err?.constructor === Error) throw new AiToolError(err.message);
    throw err;
  }
};

/** Pul argumenti → Decimal (servis bilan bir xil `parseAmount`). */
const parseMoneyArg = (value, label, { allowZero = false } = {}) => {
  let amount;
  try {
    amount = parseAmount(value, label);
  } catch (err) {
    throw new AiToolError(err.message);
  }
  if (!allowZero && amount.lessThanOrEqualTo(0)) {
    throw new AiToolError(`${label} noldan katta bo'lishi kerak`);
  }
  return amount;
};

const money = (value) => formatMoneyUz(formatAmount(value));

/** Butun son (tanga, ball) — minglik bo'shliq bilan: 12 500. */
const groupDigits = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/** Xodimni o'qiydi. O'quvchi rad etiladi (`assertStaff` bilan bir xil qoida). */
const loadStaff = async (staffId) => {
  const user = await prisma.user.findUnique({ where: { id: staffId }, select: PAYROLL_USER_SELECT });
  if (!user) throw new AiToolError("Xodim topilmadi");
  if (user.role === ROLES.STUDENT) throw new AiToolError("O'quvchiga oylik biriktirib bo'lmaydi");
  return user;
};

/**
 * Xodimning AMALDAGI majburiyati bor (muhrlangan) oylari.
 * ⚠️ Bekor qilingan qator oyni TO'SMAYDI: `generateForMonth` uni o'sha
 * qatorda joriy qoida bilan qayta hisoblab tiklaydi (`restored`), ya'ni
 * o'zgarish o'sha oyga ham yetib boradi.
 */
const loadSealedMonths = async (staffIds) => {
  const rows = await prisma.payrollEntry.findMany({
    where: { staffId: { in: staffIds }, status: { not: "cancelled" } },
    select: { staffId: true, month: true, status: true },
  });
  const byStaff = new Map(staffIds.map((id) => [id, new Map()]));
  for (const row of rows) byStaff.get(row.staffId)?.set(row.month, row.status);
  return byStaff;
};

/** `from` dan boshlab majburiyati YO'Q birinchi oy — o'zgarish shu oydan qo'llanadi. */
const firstUnsealedMonth = (sealed, from) => {
  let month = from;
  while (sealed.has(month)) month = nextMonth(month);
  return month;
};

/**
 * Kunlik pass (`runInvoiceGenerationPass`) joriy oy bilan birga
 * `catchUpMonths` ORQAGA ham oylik shakllantiradi. Shu oylardan xodimda
 * majburiyati hali YO'Qlari davrsiz o'zgarish (lavozim/toifa biriktirish,
 * lavozim bazasi, ustama) bilan birga YANGI holat bo'yicha muhrlanadi.
 *
 * @param {Set<number>|Map<number,*>} sealed - xodimning majburiyati bor oylari
 * @param {number} currentMonth
 * @param {(month: number) => Promise<object|null>} previewAfter - o'sha oy uchun engine preview'i (yangi holat)
 * @returns {Promise<string|null>} ogohlantirish matni
 */
const describeCatchUpExposure = async (sealed, currentMonth, previewAfter) => {
  const settings = await getFinanceSettings();
  if (!settings.autoGenerateEnabled || settings.catchUpMonths <= 0) return null;

  const rows = [];
  let total = new Decimal(0);
  let month = currentMonth;
  for (let i = 0; i < settings.catchUpMonths; i += 1) {
    month = prevMonth(month);
    if (sealed.has(month)) continue;
    const preview = await previewAfter(month);
    if (preview && new Decimal(preview.amount).greaterThan(0)) {
      rows.unshift(`${monthLabel(month)} (${formatMoneyUz(preview.amount)})`);
      total = total.plus(preview.amount);
    }
  }
  if (rows.length === 0) return null;

  const listed = rows.length <= 6 ? rows.join(", ") : `${rows.slice(0, 6).join(", ")} va yana ${rows.length - 6} oy`;
  return (
    `O'tgan ${rows.length} oy uchun bu xodimda oylik hali shakllanmagan — kunlik avtomatik shakllantirish (orqaga ${settings.catchUpMonths} oygacha) ` +
    `ularni ham yangi holat bo'yicha muhrlaydi, jami ${money(total)}: ${listed}`
  );
};

/** Bitta xodim uchun faraziy holatda engine preview'i (o'sha oyning qoidalari bilan). */
const previewStaffMonth = async (user, month, { bonus = null } = {}) => {
  const salaryRules = await staffSalaryService.resolveSalariesForMonth(month);
  const engineCtx = await payrollEngine.loadContext(month, [user], { salaryRules });
  if (bonus) {
    const bonusMap = new Map(engineCtx.bonusMap);
    bonusMap.set(user.id, [...(bonusMap.get(user.id) ?? []), bonus]);
    return payrollEngine.previewForStaff(user, month, { ...engineCtx, bonusMap });
  }
  return payrollEngine.previewForStaff(user, month, engineCtx);
};

/** `before` dan oldingi eng so'nggi muhrlangan oy (effekt matni uchun). */
const lastSealedBefore = (sealed, before) =>
  [...sealed.keys()].filter((month) => month < before).sort((a, b) => b - a)[0] ?? null;

/** Engine preview'idagi ustamasiz oylik: fiksa + KPI. */
const preBonusOf = (preview) =>
  preview ? new Decimal(preview.fixedAmount).plus(preview.kpiAmount) : null;

const previewAmountLabel = (preview) => (preview ? formatMoneyUz(preview.amount) : "Hisoblanmaydi");

/** Oylik manbai: lavozim, toifa yoki (ikkalasi yo'q, lekin engine hisoblagan bo'lsa) shaxsiy qoida. */
const assignmentLabel = (preview) => {
  if (!preview) return "Oylik belgilanmagan";
  if (preview.positionName) return `Lavozim: ${preview.positionName}`;
  if (preview.categoryName) return `Toifa: ${preview.categoryName}`;
  return "Shaxsiy oylik qoidasi";
};

/** Audit yozuvi asosiy amal bajarilgandan KEYIN — uning xatosi bajarilgan amalni "bajarilmadi" qilib ko'rsatmasligi kerak. */
const recordPayrollAudit = async (entry) => {
  try {
    await payrollAuditService.record(entry);
  } catch (err) {
    logger.error(`[AiAction] payroll audit yozilmadi: ${err.message}`, { action: entry.action, targetId: entry.targetId });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// 1. OYLIKNI O'ZGARTIRISH (bitta xodim)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Oylik o'zgarishi rejasi.
 *
 *   create        — E oyni hech qaysi qoida qamramaydi → yangi qoida
 *   close_create  — qoida E dan oldin boshlangan → prev(E) da yopiladi + yangi
 *   update        — qoida aynan E da boshlangan → joyida yangilanadi
 *   close         — lavozim bazasi = so'ralgan summa, qoida E dan oldin boshlangan → yopiladi
 *   delete        — lavozim bazasi = so'ralgan summa, qoida aynan E da boshlangan → o'chiriladi
 *
 * ⚠️ E dan oldin boshlangan qoida HECH QACHON `updateSalary` bilan
 * tahrirlanmaydi: u o'tgan oylarning "belgilangan" raqamini va hali
 * shakllanmagan catch-up oylarini ham qayta yozib yuborardi (xarita §3.6).
 */
const changeStaffSalary = defineAction({
  type: "payroll.change_salary",
  toolName: "propose_change_staff_salary",
  toolset: TOOLSET,
  title: "Xodim oyligini o'zgartirish",
  risk: "high",
  permission: "payroll.assign",
  timeoutMs: 45000,
  description:
    "Propose changing ONE staff member's monthly salary to monthlyAmount (so'm, before allowances/bonuses: fixed part + " +
    "projected KPI). Already generated (sealed) months never change, so it takes effect from the first month without a " +
    "payroll entry (usually next month) or from fromMonth if later. Staff with a position: pay = position base + personal " +
    "fixed part, so the personal part becomes monthlyAmount − base (a lower amount than the base is refused with options). " +
    "Teachers paid by salary category (hours × rate): refused unless categoryTeacherTopUp is true, which the owner must " +
    "explicitly request; then a fixed top-up = monthlyAmount − projected KPI is set. Preview shows engine before/after.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["staffId", "monthlyAmount"],
    properties: {
      staffId: idSchema("Staff user id (resolve with search_people)."),
      monthlyAmount: {
        type: ["number", "string"],
        description: "New monthly salary in so'm before allowances/bonuses, e.g. 5000000.",
      },
      fromMonth: monthSchema(
        "Optional first month (YYYYMM) the new salary applies to. Must not be an already generated month. Omit to use the earliest possible month.",
      ),
      categoryTeacherTopUp: {
        type: "boolean",
        description:
          "Only for teachers paid by salary category: true ONLY if the owner explicitly asked for a fixed monthly top-up on top of hourly KPI.",
      },
      note: { type: "string", maxLength: 300, description: "Optional note stored on the salary rule." },
    },
  },

  async prepare(args, ctx) {
    const staffId = requireId(args.staffId, "Xodim id");
    const user = await loadStaff(staffId);
    const name = personName(user);
    const target = parseMoneyArg(args.monthlyAmount, "Oylik summasi");

    const sealed = (await loadSealedMonths([staffId])).get(staffId);
    const firstOpen = firstUnsealedMonth(sealed, ctx.monthKey);

    let month = firstOpen;
    if (args.fromMonth !== undefined) {
      const requested = monthArg(args.fromMonth, "Boshlanish oyi");
      if (requested < firstOpen) {
        const reason = sealed.has(requested)
          ? `${monthLabel(requested)} uchun oylik allaqachon shakllantirilgan (${ENTRY_STATUS_LABELS[sealed.get(requested)]})`
          : `${monthLabel(requested)} o'tgan oy`;
        throw new AiToolError(
          `${reason}. Shakllangan oylik qayta hisoblanmaydi — yangi oylik eng erta ${monthLabel(firstOpen)} dan qo'llanishi mumkin.`,
        );
      }
      month = requested;
    }

    const [rules, salaryRules] = await Promise.all([
      prisma.staffSalary.findMany({ where: { staffId }, orderBy: { startMonth: "asc" } }),
      staffSalaryService.resolveSalariesForMonth(month),
    ]);
    // Engine bilan AYNI tanlov: oyni qamragan qoidalardan eng kech boshlangani
    const current = salaryRules.get(staffId) ?? null;
    const nextRule = rules.find((rule) => rule.startMonth > month && rule.id !== current?.id) ?? null;

    const engineCtx = await payrollEngine.loadContext(month, [user], { salaryRules });
    const before = payrollEngine.previewForStaff(user, month, engineCtx);
    const position = user.positionId ? engineCtx.positionMap.get(user.positionId) ?? null : null;
    const category = user.salaryCategoryId ? engineCtx.categoryMap.get(user.salaryCategoryId) ?? null : null;
    const warnings = [];

    // ── Summa qaysi qoida maydoniga tushadi ────────────────────────────
    let ruleFixed;
    // Shaxsiy maosh bo'lsa baza o'sha (engine bilan AYNI tanlov)
    const base = payrollEngine.resolvePositionBase(user, position, engineCtx).amount;
    const projectedKpi = new Decimal(before ? before.kpiAmount : 0);

    if (category) {
      if (args.categoryTeacherTopUp !== true) {
        throw new AiToolError(
          `${name} "${category.name}" toifasi bo'yicha soatbay oylik oladi: ${monthLabel(month)} uchun ` +
            `${before?.lessonHours ?? 0} soat × ${money(category.perHourRate)} = ${money(projectedKpi)} (prognoz). ` +
            "Bunday oylikni bitta summa bilan belgilab bo'lmaydi. Variantlar: (1) boshqa toifaga o'tkazish " +
            "(propose_assign_staff_position), (2) toifa stavkasini o'zgartirish (admin panel, toifadagi hamma o'qituvchiga ta'sir qiladi), " +
            "(3) ega aniq so'rasa — soatbay oylik ustiga qat'iy qo'shimcha summa belgilash.",
        );
      }
      ruleFixed = target.minus(projectedKpi);
      if (ruleFixed.lessThanOrEqualTo(0)) {
        throw new AiToolError(
          `${monthLabel(month)} uchun soatbay qism (${money(projectedKpi)}) so'ralgan summadan (${money(target)}) kam emas — ` +
            "qo'shimcha summa kerak emas. Soatbay qismni kamaytirish uchun toifani o'zgartirish kerak.",
        );
      }
      warnings.push(
        `Soatbay qism dars jadvalidan hisoblanadi: ${money(target)} — ${monthLabel(month)} uchun prognoz. ` +
          `Qo'shimcha qat'iy summa har oy ${money(ruleFixed)} bo'lib qoladi, jami esa soatga qarab o'zgaradi.`,
      );
    } else if (position) {
      ruleFixed = target.minus(base);
      if (ruleFixed.isNegative()) {
        const holders = await positionService.getPositions({ departmentId: position.departmentId });
        const staffCount = holders.find((row) => row.id === position.id)?.staffCount ?? 0;
        throw new AiToolError(
          `${name} "${position.name}" lavozimida, lavozim bazaviy maoshi ${money(base)} — so'ralgan ${money(target)} undan kam. ` +
            "Shaxsiy qism manfiy bo'la olmaydi. Variantlar: (1) boshqa lavozimga o'tkazish (propose_assign_staff_position), " +
            "(2) lavozimdan chiqarib, shaxsiy oylikni to'liq belgilash, " +
            `(3) lavozim bazaviy maoshini o'zgartirish (propose_update_position_base_salary) — bu lavozimdagi ${staffCount} ta xodimning hammasiga ta'sir qiladi.`,
        );
      }
    } else {
      ruleFixed = target;
    }

    const currentFixed = current ? new Decimal(current.fixedAmount) : new Decimal(0);
    if (currentFixed.equals(ruleFixed)) {
      throw new AiToolError(`${name} oyligi ${monthLabel(month)} uchun allaqachon ${money(target)} (ustamalarsiz)`);
    }

    // ── Eski qoidadan saqlanadigan qismlar ────────────────────────────
    let keepAllowances = [];
    let keepCategoryId = null;
    let keepRate = "0.00";
    // `createSalary` arxivlangan toifani rad etadi — yangi qoidaga ko'chirilmaydi
    let droppedRuleCategory = false;
    if (current) {
      keepAllowances = await asToolError(async () => normalizeAllowances(current.allowances));
      keepRate = formatAmount(current.perHourRate);
      if (current.categoryId) {
        const ruleCategory = await prisma.salaryCategory.findUnique({
          where: { id: current.categoryId },
          select: { id: true, name: true, isArchived: true },
        });
        if (ruleCategory && !ruleCategory.isArchived) keepCategoryId = ruleCategory.id;
        else droppedRuleCategory = true;
      }
    }

    // ── Reja ───────────────────────────────────────────────────────────
    let plan;
    let newRule = null;
    if (ruleFixed.isZero()) {
      if (keepAllowances.length > 0 || new Decimal(current.perHourRate).greaterThan(0) || current.categoryId) {
        throw new AiToolError(
          `So'ralgan summa lavozim bazasiga (${money(base)}) teng, lekin shaxsiy qoidada ustama yoki stavka ham bor — ` +
            "uni olib tashlash ularni ham yo'qotadi. Summani aniqlashtiring yoki qoidani admin panelda tahrirlang.",
        );
      }
      plan = current.startMonth < month ? "close" : "delete";
    } else {
      const endCandidates = [
        current && current.startMonth < month ? current.endMonth : null,
        nextRule ? prevMonth(nextRule.startMonth) : null,
      ].filter((value) => value != null);
      const endMonth = endCandidates.length ? Math.min(...endCandidates) : null;

      if (!current || current.startMonth < month) {
        plan = current ? "close_create" : "create";
        // `createSalary` ichidagi kesishuv tekshiruvi — tasdiqdan OLDIN
        const conflict = rules.find(
          (rule) =>
            rule.id !== current?.id &&
            rule.startMonth <= (endMonth ?? OPEN_END_MONTH) &&
            (rule.endMonth == null || rule.endMonth >= month),
        );
        if (conflict) {
          throw new AiToolError(
            `Bu xodimda ${formatMonthRange(conflict.startMonth, conflict.endMonth)} davri uchun boshqa oylik qoidasi bor — ` +
              "yangi qoida u bilan kesishadi. Qoidalarni admin panelda tekshiring.",
          );
        }
      } else {
        plan = "update";
      }

      newRule = {
        fixedAmount: formatAmount(ruleFixed),
        perHourRate: keepCategoryId ? "0.00" : keepRate,
        categoryId: keepCategoryId,
        allowances: keepAllowances,
        startMonth: plan === "update" ? current.startMonth : month,
        endMonth: plan === "update" ? current.endMonth : endMonth,
      };
    }

    // ── Engine: oldin / keyin (bir xil kontekst, faqat qoida almashadi) ──
    const hypothetical = new Map(salaryRules);
    if (newRule) {
      hypothetical.set(staffId, {
        ...(current ?? {}),
        staffId,
        fixedAmount: newRule.fixedAmount,
        perHourRate: newRule.perHourRate,
        categoryId: newRule.categoryId,
        allowances: newRule.allowances,
      });
    } else {
      hypothetical.delete(staffId);
    }
    const after = payrollEngine.previewForStaff(user, month, { ...engineCtx, salaryRules: hypothetical });

    const fields = [
      {
        label: "Oylik (ustamalarsiz)",
        before: before ? money(preBonusOf(before)) : "Belgilanmagan",
        after: money(target),
      },
    ];
    if (position) {
      fields.push({ label: `Lavozim bazasi (${position.name})`, before: money(base), after: money(base) });
    }
    if (position || category) {
      fields.push({
        label: "Shaxsiy qat'iy qism",
        before: current ? money(currentFixed) : "—",
        after: newRule ? money(ruleFixed) : "—",
      });
    }
    if (category) {
      fields.push({
        label: `Soatbay qism (${before?.lessonHours ?? 0} soat, prognoz)`,
        before: money(projectedKpi),
        after: money(projectedKpi),
      });
    }
    const hasAllowances = [before, after].some((row) => row && new Decimal(row.allowanceAmount).greaterThan(0));
    if (hasAllowances) {
      fields.push({
        label: "Ustamalar",
        before: before ? money(before.allowanceAmount) : "—",
        after: after ? money(after.allowanceAmount) : "—",
      });
    }
    fields.push({ label: "Jami oylik (prognoz)", before: previewAmountLabel(before), after: previewAmountLabel(after) });

    const effects = [`Yangi oylik ${monthLabel(month)} dan qo'llanadi`];
    const lastSealed = lastSealedBefore(sealed, month);
    if (lastSealed) effects.push(`${monthLabel(lastSealed)} uchun shakllangan oylik o'zgarmaydi`);
    if (firstOpen > ctx.monthKey) {
      effects.push(`Joriy oy (${monthLabel(ctx.monthKey)}) oyligi allaqachon shakllantirilgan — o'zgarish keyingi oydan`);
    } else if (month === ctx.monthKey) {
      effects.push(`Joriy oy (${monthLabel(ctx.monthKey)}) oyligi hali shakllantirilmagan — yangi summa shu oydan hisoblanadi`);
    }
    if (month > firstOpen) {
      const gap = month === nextMonth(firstOpen) ? monthLabel(firstOpen) : formatMonthRange(firstOpen, prevMonth(month));
      effects.push(`${gap} eski qoida bo'yicha hisoblanadi`);
    }
    if (plan === "close_create") {
      effects.push(
        `Amaldagi qoida (${formatMonthRange(current.startMonth, current.endMonth)}) ${monthLabel(prevMonth(month))} bilan yopiladi, ` +
          `yangi qoida ochiladi: ${formatMonthRange(newRule.startMonth, newRule.endMonth)}`,
      );
    } else if (plan === "create") {
      effects.push(`Yangi oylik qoidasi ochiladi: ${formatMonthRange(newRule.startMonth, newRule.endMonth)}`);
    } else if (plan === "update") {
      effects.push(`${monthLabel(current.startMonth)} dan boshlangan qoida joyida yangilanadi (u hali hech qaysi shakllangan oyga tegishli emas)`);
    } else if (plan === "close") {
      effects.push(`Shaxsiy qism ${monthLabel(prevMonth(month))} bilan yopiladi — keyin faqat lavozim bazasi to'lanadi`);
    } else {
      effects.push(`${monthLabel(month)} dan boshlangan shaxsiy qoida o'chiriladi — faqat lavozim bazasi to'lanadi`);
    }
    if (nextRule) {
      effects.push(`${monthLabel(nextRule.startMonth)} dan boshlanadigan keyingi qoida o'zgarmaydi`);
    }
    if (keepAllowances.length > 0) {
      effects.push("Mavjud ustamalar yangi qoidada saqlanadi; foizli ustamalar yangi summadan hisoblanadi");
    }

    if (droppedRuleCategory && (plan === "create" || plan === "close_create")) {
      warnings.push(
        "Eski qoidadagi toifa arxivlangan yoki o'chirilgan — yangi qoidaga ko'chirilmaydi (bu maydon oylik summasiga ta'sir qilmaydi).",
      );
    }
    if (user.isArchived) warnings.push("Xodim arxivlangan — arxivdan chiqarilmaguncha unga oylik shakllantirilmaydi.");

    const params = {
      staffId,
      staffName: name,
      month,
      amount: formatAmount(target),
      plan,
      ruleId: current?.id ?? null,
      ruleEndMonth: current?.endMonth ?? null,
      closeAt: plan === "close" || plan === "close_create" ? prevMonth(month) : null,
      previousFixedAmount: current ? formatAmount(currentFixed) : null,
      newRule,
      note: args.note ?? null,
      beforeAmount: before?.amount ?? null,
      afterAmount: after?.amount ?? null,
    };
    const preview = {
      summary: `${name} oyligi ${monthLabel(month)} dan ${money(target)} bo'ladi${category ? " (prognoz)" : ""}`,
      target: `${name} — ${assignmentLabel(before ?? after)}`,
      fields,
      effects,
      warnings,
    };

    return {
      params,
      // `execute` qaysi qoidaga (id, davr, ustamalar) qanday reja bilan
      // tegishini ko'rinish matni to'liq aks ettirmaydi — ular ham barmoq izida.
      fingerprint: {
        preview,
        plan,
        ruleId: params.ruleId,
        ruleEndMonth: params.ruleEndMonth,
        closeAt: params.closeAt,
        newRule,
        rules: rules.map((rule) => [
          rule.id,
          rule.startMonth,
          rule.endMonth,
          formatAmount(rule.fixedAmount),
          formatAmount(rule.perHourRate),
          rule.categoryId,
          rule.allowances,
        ]),
      },
      preview,
    };
  },

  async execute(params, ctx) {
    const actorId = ctx.user.id;
    const { staffId, plan, ruleId, closeAt, newRule } = params;
    const createBody = () => ({
      staffId,
      fixedAmount: newRule.fixedAmount,
      perHourRate: newRule.perHourRate,
      categoryId: newRule.categoryId,
      allowances: newRule.allowances,
      startMonth: newRule.startMonth,
      endMonth: newRule.endMonth,
      note: params.note ?? "",
    });

    let rule = null;
    if (plan === "create") {
      // POST /api/payroll/salaries → createSalary(req.body, req.user.id)
      rule = await staffSalaryService.createSalary(createBody(), actorId);
    } else if (plan === "update") {
      // PUT /api/payroll/salaries/:id → updateSalary(req.params.id, req.body)
      rule = await staffSalaryService.updateSalary(ruleId, {
        fixedAmount: newRule.fixedAmount,
        ...(params.note != null ? { note: params.note } : {}),
      });
    } else if (plan === "close") {
      // PATCH /api/payroll/salaries/:id/close → closeSalary(req.params.id, req.body.endMonth)
      rule = await staffSalaryService.closeSalary(ruleId, closeAt);
    } else if (plan === "delete") {
      // DELETE /api/payroll/salaries/:id → deleteSalary(req.params.id)
      await staffSalaryService.deleteSalary(ruleId);
    } else {
      // Ikki alohida tranzaksiya (birlashgan servis yo'q): yopish → yaratish.
      await staffSalaryService.closeSalary(ruleId, closeAt);
      try {
        rule = await staffSalaryService.createSalary(createBody(), actorId);
      } catch (err) {
        // KOMPENSATSIYA: yangi qoida yozilmasa eski qoida asl davriga qaytadi,
        // aks holda xodim yangi oydan umuman oyliksiz qolardi.
        try {
          await staffSalaryService.updateSalary(ruleId, { endMonth: params.ruleEndMonth });
        } catch (restoreErr) {
          logger.error("[AiAction] payroll.change_salary: eski qoidani qayta ochib bo'lmadi", {
            ruleId,
            staffId,
            createError: err.message,
            restoreError: restoreErr.message,
          });
          throw new AiToolError(
            `Yangi oylik qoidasi yozilmadi (${err.message}) va eski qoida ${monthLabel(closeAt)} bilan yopiq qoldi. ` +
              "Xodimning oylik qoidalarini admin panelda darhol tekshiring.",
          );
        }
        throw err;
      }
    }

    await recordPayrollAudit({
      actorId,
      action: "salary.change",
      targetType: "user",
      targetId: staffId,
      summary: `${params.staffName} — oylik ${monthLabel(params.month)} dan ${formatMoneyUz(params.amount)} (AI yordamchi orqali)`,
      oldValue: { ruleId, fixedAmount: params.previousFixedAmount, projectedAmount: params.beforeAmount },
      newValue: {
        ruleId: rule?.id ?? null,
        plan,
        fixedAmount: newRule?.fixedAmount ?? null,
        startMonth: params.month,
        projectedAmount: params.afterAmount,
      },
    });

    const details = [{ label: "Qo'llanadigan oy", value: monthLabel(params.month) }];
    if (rule && plan !== "close") {
      details.push({ label: "Oylik qoidasi", value: `${rule.typeLabel}, ${rule.periodLabel}` });
      details.push({ label: "Shaxsiy qat'iy qism", value: formatMoneyUz(rule.fixedAmount) });
    }
    if (params.afterAmount) details.push({ label: "Jami oylik (prognoz)", value: formatMoneyUz(params.afterAmount) });

    return {
      summary: `${params.staffName} oyligi ${monthLabel(params.month)} dan ${formatMoneyUz(params.amount)} qilib belgilandi`,
      details,
      data: { staffId, plan, ruleId: rule?.id ?? ruleId },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 2. LAVOZIM / TOIFAGA BIRIKTIRISH
// ─────────────────────────────────────────────────────────────────────────

const assignStaffPosition = defineAction({
  type: "payroll.assign_position",
  toolName: "propose_assign_staff_position",
  toolset: TOOLSET,
  title: "Xodimni lavozim yoki toifaga biriktirish",
  risk: "high",
  permission: "payroll.assign",
  timeoutMs: 45000,
  description:
    "Propose assigning a staff member to a position (staff departments, pay = position base salary) OR a teaching salary " +
    "category (pay = hourly rate × scheduled lessons), or removing the current assignment. Setting one clears the other. " +
    "Not periodised: applies to every month not yet generated. Pass exactly one of positionId, salaryCategoryId or " +
    "removeAssignment=true. Get ids from payroll_catalog. Preview shows engine pay before/after.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["staffId"],
    properties: {
      staffId: idSchema("Staff user id."),
      positionId: idSchema("Target position id."),
      salaryCategoryId: idSchema("Target teaching salary category id."),
      removeAssignment: { type: "boolean", description: "true to remove the current position or category." },
    },
  },

  async prepare(args, ctx) {
    const staffId = requireId(args.staffId, "Xodim id");
    const chosen = [args.positionId, args.salaryCategoryId, args.removeAssignment === true ? true : undefined]
      .filter((value) => value !== undefined);
    if (chosen.length !== 1) {
      throw new AiToolError("positionId, salaryCategoryId yoki removeAssignment dan aynan bittasini bering");
    }

    const user = await loadStaff(staffId);
    const name = personName(user);
    const warnings = [];
    let data;
    let hypothetical;
    let targetLabel;

    if (args.positionId) {
      const position = await prisma.position.findUnique({
        where: { id: requireId(args.positionId, "Lavozim id") },
        include: { department: { select: { name: true } } },
      });
      if (!position) throw new AiToolError("Lavozim topilmadi");
      if (position.id === user.positionId) throw new AiToolError(`${name} allaqachon "${position.name}" lavozimida`);
      if (!position.isActive) warnings.push(`"${position.name}" lavozimi nofaol deb belgilangan.`);
      data = { positionId: position.id };
      hypothetical = { ...user, positionId: position.id, salaryCategoryId: null };
      targetLabel = `lavozim "${position.name}" (${position.department?.name ?? "bo'limsiz"})`;
    } else if (args.salaryCategoryId) {
      const category = await prisma.salaryCategory.findUnique({
        where: { id: requireId(args.salaryCategoryId, "Toifa id") },
        include: { department: { select: { name: true } } },
      });
      if (!category) throw new AiToolError("Toifa topilmadi");
      if (category.isArchived) throw new AiToolError(`"${category.name}" toifasi arxivlangan — unga biriktirilmaydi`);
      if (category.id === user.salaryCategoryId) throw new AiToolError(`${name} allaqachon "${category.name}" toifasida`);
      if (!category.isActive) warnings.push(`"${category.name}" toifasi nofaol deb belgilangan.`);
      data = { salaryCategoryId: category.id };
      hypothetical = { ...user, salaryCategoryId: category.id, positionId: null };
      targetLabel = `toifa "${category.name}"`;
    } else if (user.positionId) {
      data = { positionId: null };
      hypothetical = { ...user, positionId: null };
      targetLabel = "lavozimdan chiqarish";
    } else if (user.salaryCategoryId) {
      data = { salaryCategoryId: null };
      hypothetical = { ...user, salaryCategoryId: null };
      targetLabel = "toifadan chiqarish";
    } else {
      throw new AiToolError(`${name} hech qaysi lavozim yoki toifaga biriktirilmagan`);
    }

    const sealed = (await loadSealedMonths([staffId])).get(staffId);
    const month = firstUnsealedMonth(sealed, ctx.monthKey);
    const salaryRules = await staffSalaryService.resolveSalariesForMonth(month);
    const [beforeCtx, afterCtx] = await Promise.all([
      payrollEngine.loadContext(month, [user], { salaryRules }),
      payrollEngine.loadContext(month, [hypothetical], { salaryRules }),
    ]);
    const before = payrollEngine.previewForStaff(user, month, beforeCtx);
    const after = payrollEngine.previewForStaff(hypothetical, month, afterCtx);

    const fields = [
      { label: "Biriktirma", before: assignmentLabel(before), after: assignmentLabel(after) },
      {
        label: "Oylik turi",
        before: before ? SALARY_TYPE_LABELS[before.salaryType] : "—",
        after: after ? SALARY_TYPE_LABELS[after.salaryType] : "—",
      },
      { label: "Qat'iy qism", before: before ? money(before.fixedAmount) : "—", after: after ? money(after.fixedAmount) : "—" },
      { label: `Jami oylik (${monthLabel(month)}, prognoz)`, before: previewAmountLabel(before), after: previewAmountLabel(after) },
    ];
    // Soatbay qism faqat toifa ishtirok etsa ma'noli — aks holda "0 so'm (0 soat)" shovqin
    if (user.salaryCategoryId || hypothetical.salaryCategoryId) {
      fields.splice(3, 0, {
        label: "Soatbay qism",
        before: before ? `${money(before.kpiAmount)} (${before.lessonHours} soat)` : "—",
        after: after ? `${money(after.kpiAmount)} (${after.lessonHours} soat)` : "—",
      });
    }

    const effects = [
      `Biriktirma davr bilan saqlanmaydi: hali shakllantirilmagan har bir oy (eng yaqini — ${monthLabel(month)}) yangi biriktirma bo'yicha hisoblanadi`,
    ];
    const lastSealed = lastSealedBefore(sealed, month);
    if (lastSealed) effects.push(`${monthLabel(lastSealed)} va undan oldingi shakllangan oyliklar o'zgarmaydi`);
    if (salaryRules.has(staffId)) {
      effects.push(`Shaxsiy oylik qoidasi (qat'iy qism ${money(salaryRules.get(staffId).fixedAmount)}) ham qo'shilib hisoblanishda davom etadi`);
    }

    if (!after) warnings.push("Bu o'zgarishdan keyin xodimga oylik hisoblanmaydi (lavozim, toifa va shaxsiy qoida yo'q).");
    if (data.salaryCategoryId && after && after.lessonHours === 0) {
      warnings.push(`${monthLabel(month)} uchun dars jadvalida bu xodimning darsi yo'q — soatbay qism 0 bo'ladi.`);
    }
    if (user.isArchived) {
      warnings.push("Xodim arxivlangan — unga oylik shakllantirilmaydi.");
    } else {
      const exposure = await describeCatchUpExposure(sealed, ctx.monthKey, (m) => previewStaffMonth(hypothetical, m));
      if (exposure) warnings.push(exposure);
    }

    return {
      params: { staffId, staffName: name, data, month, targetLabel },
      preview: {
        summary: `${name}: ${targetLabel}`,
        target: `${name} — ${assignmentLabel(before)}`,
        fields,
        effects,
        warnings,
      },
    };
  },

  async execute(params, ctx) {
    // PATCH /api/payroll/staff/:staffId/assign → assignStaff(req.params.staffId, req.body, req.user.id)
    const updated = await departmentService.assignStaff(params.staffId, params.data, ctx.user.id);
    return {
      summary: `${params.staffName}: ${params.targetLabel} saqlandi`,
      details: [{ label: "Birinchi ta'sir qiladigan oy", value: monthLabel(params.month) }],
      data: { staffId: updated.id, positionId: updated.positionId, salaryCategoryId: updated.salaryCategoryId },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 3. LAVOZIM BAZAVIY MAOSHI
// ─────────────────────────────────────────────────────────────────────────

const updatePositionBaseSalary = defineAction({
  type: "payroll.update_position_base",
  toolName: "propose_update_position_base_salary",
  toolset: TOOLSET,
  title: "Lavozim bazaviy maoshini o'zgartirish",
  risk: "critical",
  permission: "payroll.assign",
  timeoutMs: 60000,
  description:
    "Propose changing a position's base salary (so'm). It affects EVERY holder of the position in every month not yet " +
    "generated; sealed months never change. Preview shows holder count and the engine's total payroll of the holders " +
    "before/after. Use only when the owner asks to change the position itself, not one person.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["positionId", "baseSalary"],
    properties: {
      positionId: idSchema("Position id (from payroll_catalog)."),
      baseSalary: { type: ["number", "string"], description: "New base salary in so'm, e.g. 4500000." },
    },
  },

  async prepare(args, ctx) {
    const positionId = requireId(args.positionId, "Lavozim id");
    const position = await asToolError(() => positionService.getById(positionId));
    const newBase = parseMoneyArg(args.baseSalary, "Bazaviy maosh", { allowZero: true });
    const oldBase = new Decimal(position.baseSalary);
    if (oldBase.equals(newBase)) {
      throw new AiToolError(`"${position.name}" lavozimi bazaviy maoshi allaqachon ${money(newBase)}`);
    }

    const [holders, catalog] = await Promise.all([
      prisma.user.findMany({
        where: { positionId, isArchived: false, role: { not: ROLES.STUDENT } },
        select: PAYROLL_USER_SELECT,
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      }),
      positionService.getPositions({ departmentId: position.departmentId }),
    ]);
    const staffCount = catalog.find((row) => row.id === positionId)?.staffCount ?? holders.length;

    const fields = [
      { label: "Bazaviy maosh", before: money(oldBase), after: money(newBase) },
      { label: "Lavozimdagi xodimlar", before: String(staffCount), after: String(staffCount) },
    ];
    const effects = [
      `Maosh davr bilan saqlanmaydi: keyingi shakllantirishdan boshlab lavozimdagi ${staffCount} ta xodim yangi bazani oladi`,
      "Allaqachon shakllangan oyliklar o'zgarmaydi",
    ];
    const warnings = [];

    if (holders.length === 0) {
      warnings.push("Bu lavozimda hozir faol xodim yo'q — o'zgarish faqat keyin biriktiriladiganlarga ta'sir qiladi.");
    } else {
      const sealedCurrent = await prisma.payrollEntry.count({
        where: { month: ctx.monthKey, staffId: { in: holders.map((u) => u.id) } },
      });
      const openCurrent = holders.length - sealedCurrent;
      // Prognoz oyi: kamida bitta xodimda joriy oy ochiq bo'lsa — joriy oy
      const month = openCurrent > 0 ? ctx.monthKey : nextMonth(ctx.monthKey);

      const salaryRules = await staffSalaryService.resolveSalariesForMonth(month);
      const engineCtx = await payrollEngine.loadContext(month, holders, { salaryRules });
      const changedPositionMap = new Map(engineCtx.positionMap);
      changedPositionMap.set(positionId, { ...engineCtx.positionMap.get(positionId), baseSalary: newBase });
      const afterCtx = { ...engineCtx, positionMap: changedPositionMap };

      const sumAll = (context) =>
        holders.reduce((sum, user) => {
          const row = payrollEngine.computeForStaff(user, month, context);
          return row ? sum.plus(row.amount) : sum;
        }, new Decimal(0));

      fields.push({
        label: `Lavozim bo'yicha jami oylik (${monthLabel(month)}, prognoz)`,
        before: money(sumAll(engineCtx)),
        after: money(sumAll(afterCtx)),
      });

      if (sealedCurrent > 0) {
        effects.push(
          `${monthLabel(ctx.monthKey)} uchun ${sealedCurrent} ta xodimda oylik allaqachon shakllangan — ularga ${monthLabel(nextMonth(ctx.monthKey))} dan ta'sir qiladi`,
        );
      }

      // Kunlik pass orqaga `catchUpMonths` oy ham shakllantiradi: majburiyati
      // hali yo'q o'tgan oylar YANGI baza bilan muhrlanadi.
      const financeSettings = await getFinanceSettings();
      if (financeSettings.autoGenerateEnabled && financeSettings.catchUpMonths > 0) {
        const pastMonths = [];
        for (let m = prevMonth(ctx.monthKey), i = 0; i < financeSettings.catchUpMonths; i += 1, m = prevMonth(m)) {
          pastMonths.unshift(m);
        }
        const pastEntries = await prisma.payrollEntry.findMany({
          where: { staffId: { in: holders.map((u) => u.id) }, month: { in: pastMonths } },
          select: { staffId: true, month: true },
        });
        const sealedPairs = new Set(pastEntries.map((row) => `${row.staffId}:${row.month}`));
        const exposed = [];
        let exposedTotal = new Decimal(0);
        for (const m of pastMonths) {
          const open = holders.filter((u) => !sealedPairs.has(`${u.id}:${m}`));
          if (open.length === 0) continue;
          const monthRules = await staffSalaryService.resolveSalariesForMonth(m);
          const monthCtx = await payrollEngine.loadContext(m, open, { salaryRules: monthRules });
          const positionMap = new Map(monthCtx.positionMap);
          positionMap.set(positionId, { ...monthCtx.positionMap.get(positionId), baseSalary: newBase });
          let count = 0;
          let total = new Decimal(0);
          for (const u of open) {
            const row = payrollEngine.computeForStaff(u, m, { ...monthCtx, positionMap });
            if (row && row.amount.greaterThan(0)) {
              count += 1;
              total = total.plus(row.amount);
            }
          }
          if (count > 0) {
            exposed.push(`${monthLabel(m)} — ${count} ta xodim, ${money(total)}`);
            exposedTotal = exposedTotal.plus(total);
          }
        }
        if (exposed.length > 0) {
          const listed =
            exposed.length <= 6 ? exposed.join("; ") : `${exposed.slice(0, 6).join("; ")} va yana ${exposed.length - 6} oy`;
          warnings.push(
            `O'tgan ${exposed.length} oy uchun ayrim xodimlarda oylik hali shakllanmagan — kunlik avtomatik shakllantirish ularni YANGI baza bilan muhrlaydi, jami ${money(exposedTotal)}: ${listed}`,
          );
        }
      }
      if (openCurrent > 0) {
        effects.push(`${openCurrent} ta xodimda ${monthLabel(ctx.monthKey)} oyligi hali shakllanmagan — ularga joriy oydan ta'sir qiladi`);
      }
      const names = holders.slice(0, 8).map(personName).join(", ");
      effects.push(`Xodimlar: ${names}${holders.length > 8 ? ` va yana ${holders.length - 8} ta` : ""}`);
    }

    if (newBase.lessThan(oldBase)) warnings.push("Bazaviy maosh KAMAYADI — lavozimdagi hamma xodimning oyligi pasayadi.");
    if (!position.isActive) warnings.push(`"${position.name}" lavozimi nofaol deb belgilangan.`);

    return {
      params: {
        positionId,
        positionName: position.name,
        baseSalary: formatAmount(newBase),
        previousBaseSalary: formatAmount(oldBase),
        staffCount,
      },
      preview: {
        summary: `"${position.name}" lavozimi bazaviy maoshi ${money(newBase)} bo'ladi (${staffCount} ta xodimga ta'sir qiladi)`,
        target: `Lavozim: ${position.name} — ${position.departmentName ?? "bo'limsiz"}`,
        fields,
        effects,
        warnings,
      },
    };
  },

  async execute(params, ctx) {
    // PUT /api/payroll/positions/:id → updatePosition(req.params.id, req.body, req.user.id)
    // (bazaviy maosh o'zgarsa servisning o'zi `position.update` auditini yozadi)
    const updated = await positionService.updatePosition(
      params.positionId,
      { baseSalary: params.baseSalary },
      ctx.user.id,
    );
    return {
      summary: `"${updated.name}" lavozimi bazaviy maoshi ${formatMoneyUz(updated.baseSalary)} qilib o'zgartirildi`,
      details: [
        { label: "Oldingi baza", value: formatMoneyUz(params.previousBaseSalary) },
        { label: "Lavozimdagi xodimlar", value: String(params.staffCount) },
      ],
      data: { positionId: updated.id, baseSalary: updated.baseSalary },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 4. OYLIKNI SHAKLLANTIRISH
// ─────────────────────────────────────────────────────────────────────────

const generatePayroll = defineAction({
  type: "payroll.generate_month",
  toolName: "propose_generate_payroll",
  toolset: TOOLSET,
  title: "Oylik majburiyatlarini shakllantirish",
  risk: "high",
  permission: "payroll.generate",
  timeoutMs: 90000,
  description:
    "Propose generating (sealing) payroll entries for a month — for all eligible staff or only staffIds. Only people " +
    "without an entry for that month get one; amounts are computed by the payroll engine and can never be edited " +
    "afterwards. Future months are refused. Preview is an exact dry run: count, totals and skipped reasons.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      month: monthSchema("Month as YYYYMM (current or past). Omit for the current month."),
      staffIds: {
        type: "array",
        items: { type: "string", pattern: "^[a-fA-F0-9]{24}$" },
        minItems: 1,
        maxItems: 200,
        description: "Optional subset of staff user ids. Omit to generate for everyone eligible.",
      },
    },
  },

  async prepare(args, ctx) {
    const month = monthArg(args.month);
    if (month > ctx.monthKey) {
      throw new AiToolError(`${monthLabel(month)} — kelajakdagi oy. Oylik faqat joriy yoki o'tgan oy uchun shakllantiriladi.`);
    }
    const staffIds = args.staffIds ? [...new Set(args.staffIds.map((id) => requireId(id, "Xodim id")))].sort() : null;

    const dry = await asToolError(() =>
      payrollService.generateForMonth(month, {
        dryRun: true,
        staffIds: staffIds ?? undefined,
        actorId: ctx.user.id,
      }),
    );

    const skippedText =
      `allaqachon shakllangan: ${dry.skipped.alreadyExists}, oylik belgilanmagan: ${dry.skipped.noSalary}, ` +
      `summasi nol: ${dry.skipped.zeroAmount}`;
    if (dry.created + dry.restored === 0) {
      throw new AiToolError(
        `${monthLabel(month)} uchun yangi yoziladigan oylik majburiyati yo'q (${dry.eligible} ta xodim tekshirildi; ${skippedText}).`,
      );
    }

    const warnings = [];
    if (dry.restored > 0) {
      warnings.push(
        `${dry.restored} ta xodimning ${monthLabel(month)} uchun bekor qilingan majburiyati joriy qoida bo'yicha qayta hisoblanib tiklanadi.`,
      );
    }
    if (dry.skipped.zeroAmount > 0) {
      warnings.push(`${dry.skipped.zeroAmount} ta xodimning summasi 0 — o'tkazib yuboriladi (masalan, darsi yo'q soatbay o'qituvchi yoki ta'til oyi).`);
    }
    if (month === ctx.monthKey && new Decimal(dry.kpiTotal).greaterThan(0)) {
      warnings.push("Joriy oy: soatbay qism butun oy jadvali bo'yicha oldindan hisoblanadi va muhrlanadi.");
    }
    if (month < ctx.monthKey && new Decimal(dry.kpiTotal).greaterThan(0)) {
      // `lessonHours.service`: jadval versiyasiz — o'tgan oy soati ham AMALDAGI jadvaldan yoyiladi
      warnings.push(
        `${monthLabel(month)} — o'tgan oy: soatbay qism o'sha oydagi emas, HOZIRGI dars jadvali bo'yicha hisoblanadi va muhrlanadi (jadval tarixi saqlanmaydi).`,
      );
    }

    return {
      params: { month, staffIds, created: dry.created, totalAmount: dry.totalAmount },
      preview: {
        summary: `${monthLabel(month)} uchun ${dry.created + dry.restored} ta xodimga jami ${formatMoneyUz(dry.totalAmount)} oylik shakllantiriladi`,
        target: staffIds ? `${staffIds.length} ta tanlangan xodim` : "Oylik oladigan barcha xodimlar",
        fields: [
          { label: "Yoziladigan majburiyatlar", before: "—", after: String(dry.created) },
          ...(dry.restored > 0 ? [{ label: "Bekordan tiklanadi", before: "—", after: String(dry.restored) }] : []),
          { label: "Jami summa", before: "—", after: formatMoneyUz(dry.totalAmount) },
          { label: "Qat'iy qism va ustamalar", before: "—", after: formatMoneyUz(dry.fixedTotal) },
          { label: "Soatbay qism", before: "—", after: formatMoneyUz(dry.kpiTotal) },
        ],
        effects: [
          `${dry.created + dry.restored} ta majburiyat muhrlanadi va xodimlarga qarz sifatida ko'rinadi`,
          "Muhrlangan summa keyin o'zgartirilmaydi — tuzatish faqat keyingi oydan",
          ...(dry.eligible > dry.created + dry.restored ? [`O'tkazib yuboriladi — ${skippedText}`] : []),
        ],
        warnings,
      },
    };
  },

  async execute(params, ctx) {
    // POST /api/payroll/generate → generateForMonth(req.body.month, { dryRun: req.body.dryRun === true, staffIds: req.body.staffIds, actorId: req.user.id })
    const result = await payrollService.generateForMonth(params.month, {
      dryRun: false,
      staffIds: params.staffIds ?? undefined,
      actorId: ctx.user.id,
    });
    return {
      summary: `${result.monthLabel} uchun ${result.created} ta oylik majburiyati shakllantirildi (jami ${formatMoneyUz(result.totalAmount)})`,
      details: [
        { label: "Yozildi", value: String(result.created) },
        { label: "Bekordan tiklandi", value: String(result.restored) },
        { label: "Allaqachon bor edi", value: String(result.skipped.alreadyExists) },
        { label: "Oylik belgilanmagan", value: String(result.skipped.noSalary) },
        { label: "Summasi nol", value: String(result.skipped.zeroAmount) },
      ],
      data: { month: result.month, created: result.created, totalAmount: result.totalAmount },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 5. OYLIK TO'LASH
// ─────────────────────────────────────────────────────────────────────────

const paySalary = defineAction({
  type: "payroll.pay_salary",
  toolName: "propose_pay_salary",
  toolset: TOOLSET,
  title: "Xodimga oylik to'lash",
  risk: "critical",
  permission: "payroll.pay",
  description:
    "Propose recording a salary payment to ONE staff member from a payment account (to'lov turi). The amount is " +
    "allocated to the oldest unpaid payroll entries first; paying more than the outstanding debt is refused (no advances). " +
    "Money leaves the chosen account. Get the debt with payroll_staff or payroll_debts and accountId from payroll_catalog.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["staffId", "accountId", "amount"],
    properties: {
      staffId: idSchema("Staff user id."),
      accountId: idSchema("Active payment account id the money is paid from."),
      amount: { type: ["number", "string"], description: "Payment amount in so'm, e.g. 6254000." },
      paidDate: daySchema("Payment day 'YYYY-MM-DD' (not in the future). Omit for now."),
      note: { type: "string", maxLength: 300, description: "Optional note." },
    },
  },

  async prepare(args, ctx) {
    const staffId = requireId(args.staffId, "Xodim id");
    const accountId = requireId(args.accountId, "To'lov turi id");
    const amount = parseMoneyArg(args.amount, "Summa");
    const paidDate = args.paidDate === undefined ? null : dayArg(args.paidDate, "To'lov sanasi");
    if (paidDate && paidDate > ctx.today) throw new AiToolError("Kelajakdagi sana bilan to'lov qayd etib bo'lmaydi");

    const [preview, account] = await Promise.all([
      asToolError(() => salaryPaymentService.previewPayment({ staffId, amount: formatAmount(amount) })),
      asToolError(() => paymentAccountService.assertActiveAccount(accountId)),
    ]);
    const name = personName(preview.staff);
    const outstanding = new Decimal(preview.outstanding);

    if (outstanding.isZero()) {
      throw new AiToolError(`${name} ga to'lanmagan oylik yo'q — avval oylik majburiyatini shakllantiring`);
    }
    if (preview.exceedsDebt) {
      throw new AiToolError(
        `To'lov qarzdan ko'p: qarz ${formatMoneyUz(preview.outstanding)}, to'lov ${formatMoneyUz(preview.amount)}. Avans qo'llab-quvvatlanmaydi.`,
      );
    }

    const balance = new Decimal(account.balance);
    const warnings = [];
    if (balance.lessThan(amount)) {
      warnings.push(`"${account.name}" qoldig'i (${money(balance)}) to'lovdan kam — qoldiq manfiy bo'ladi.`);
    }
    if (preview.staff.isArchived) warnings.push("Xodim arxivlangan.");

    // ⚠️ Bugungi sana HOZIRGI payt sifatida yuboriladi: "YYYY-MM-DD" UTC yarim
    // tuni bo'lib o'qiladi va Toshkentda 05:00 dan oldin "kelajak" deb rad etilardi.
    const paidAt = paidDate && paidDate !== ctx.today ? paidDate : null;

    const allocations = preview.allocations.map((a) => ({
      payrollEntryId: a.payrollEntryId,
      month: a.month,
      amount: a.amount,
      status: a.status,
    }));

    return {
      params: {
        staffId,
        staffName: name,
        accountId,
        accountName: account.name,
        amount: preview.amount,
        paidAt,
        note: args.note ?? null,
      },
      preview: {
        summary: `${name} ga ${formatMoneyUz(preview.amount)} oylik "${account.name}" dan to'lanadi`,
        target: `${name} — qarz ${formatMoneyUz(preview.outstanding)}`,
        fields: [
          { label: "Oylik qarzi", before: formatMoneyUz(preview.outstanding), after: money(outstanding.minus(amount)) },
          { label: `"${account.name}" qoldig'i`, before: money(balance), after: money(balance.minus(amount)) },
          { label: "To'lov sanasi", before: "—", after: paidAt ? formatDateUz(paidAt, { utc: true }) : "Hozir" },
        ],
        effects: [
          ...preview.allocations.map(
            (a) => `${a.monthLabel}: ${formatMoneyUz(a.amount)} → ${ENTRY_STATUS_LABELS[a.status] ?? a.status}`,
          ),
          `Pul "${account.name}" to'lov turidan chiqadi (daftarga manfiy qator yoziladi)`,
        ],
        warnings,
      },
      // Kassa qoldig'i boshqa to'lovlar bilan o'zgaradi — tasdiqni behuda
      // eskirtirmasligi uchun barmoq izi faqat taqsimotga bog'lanadi.
      fingerprint: { params: { staffId, accountId, amount: preview.amount, paidAt }, outstanding: preview.outstanding, allocations },
    };
  },

  async execute(params, ctx) {
    // POST /api/payroll/payments → createPayment(req.body, req.user.id)
    const payment = await salaryPaymentService.createPayment(
      {
        staffId: params.staffId,
        accountId: params.accountId,
        amount: params.amount,
        paidAt: params.paidAt ?? undefined,
        note: params.note ?? undefined,
      },
      ctx.user.id,
    );
    return {
      summary: `${payment.staffName} ga ${formatMoneyUz(payment.amount)} oylik to'landi ("${payment.accountName}")`,
      details: payment.allocations.map((a) => ({ label: a.monthLabel, value: formatMoneyUz(a.amount) })),
      data: { paymentId: payment.id, amount: payment.amount },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 6. OYLIK ARIZASINI KO'RIB CHIQISH
// ─────────────────────────────────────────────────────────────────────────

const reviewPayrollRequest = defineAction({
  type: "payroll.review_request",
  toolName: "propose_review_payroll_request",
  toolset: TOOLSET,
  title: "Oylik arizasini ko'rib chiqish",
  risk: "medium",
  permission: "payrollRequests.review",
  timeoutMs: 45000,
  description:
    "Propose approving or rejecting a pending staff payroll request (from payroll_requests). Approving a category " +
    "request immediately moves the teacher to that salary category (and removes any position); approving a bonus " +
    "request creates an active allowance for its months. Preview shows engine pay before/after for approvals.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["requestId", "decision"],
    properties: {
      requestId: idSchema("Payroll request id."),
      decision: { type: "string", enum: DECISIONS, description: "approved or rejected." },
      rejectionReason: { type: "string", maxLength: 500, description: "Reason shown to the staff member when rejecting." },
    },
  },

  async prepare(args, ctx) {
    const requestId = requireId(args.requestId, "Ariza id");
    const request = await prisma.payrollRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new AiToolError("Ariza topilmadi");
    if (request.status !== "pending") throw new AiToolError("Ariza allaqachon ko'rib chiqilgan");

    const user = await prisma.user.findUnique({ where: { id: request.staffId }, select: PAYROLL_USER_SELECT });
    if (!user) throw new AiToolError("Ariza egasi (xodim) topilmadi");
    const name = personName(user);
    const kindLabel = request.kind === "category" ? "toifa o'zgartirish" : "ustama";

    if (args.decision === "rejected") {
      return {
        params: { requestId, decision: "rejected", rejectionReason: args.rejectionReason ?? null, staffName: name, kindLabel },
        preview: {
          summary: `${name} ning ${kindLabel} arizasi rad etiladi`,
          target: `${name} — ${kindLabel} arizasi`,
          fields: [{ label: "Holat", before: "Kutilmoqda", after: "Rad etilgan" }],
          effects: ["Oylikka ta'sir qilmaydi", "Rad etish oylik tuzilmasi jurnaliga yoziladi"],
          warnings: args.rejectionReason ? [] : ["Rad etish sababi ko'rsatilmagan — xodim sababni ko'rmaydi."],
        },
      };
    }

    const sealed = (await loadSealedMonths([user.id])).get(user.id);
    const firstOpen = firstUnsealedMonth(sealed, ctx.monthKey);
    const warnings = [];
    let month = firstOpen;
    let hypotheticalUser = user;
    let approvedBonus = null;
    const fields = [{ label: "Holat", before: "Kutilmoqda", after: "Tasdiqlangan" }];
    const effects = [];

    if (request.kind === "category") {
      const category = await prisma.salaryCategory.findUnique({
        where: { id: request.requestedCategoryId },
        select: { id: true, name: true, isArchived: true },
      });
      if (!category || category.isArchived) throw new AiToolError("So'ralgan toifa endi mavjud emas — arizani faqat rad etish mumkin");
      if (category.id === user.salaryCategoryId) warnings.push(`${name} allaqachon "${category.name}" toifasida — tasdiq oylikni o'zgartirmaydi.`);
      hypotheticalUser = { ...user, salaryCategoryId: category.id, positionId: null };
      effects.push(
        `${name} darhol "${category.name}" toifasiga o'tkaziladi${user.positionId ? " va lavozimdan chiqariladi" : ""}`,
        `Hali shakllanmagan har bir oy (eng yaqini — ${monthLabel(month)}) yangi toifa stavkasi bo'yicha hisoblanadi`,
      );
    } else {
      const start = request.bonusStartMonth ?? ctx.monthKey;
      month = Math.max(start, firstOpen);
      if (request.bonusEndMonth != null && request.bonusEndMonth < month) {
        warnings.push("Ustama davri hali shakllanmagan oylarga tushmaydi — tasdiqlansa ham oylikka ta'sir qilmaydi.");
      }
      if (start < firstOpen) {
        warnings.push(
          `Ustama ${monthLabel(start)} dan boshlanadi, lekin allaqachon shakllangan oylar qayta hisoblanmaydi — joriy oylik ta'siri ${monthLabel(firstOpen)} dan.`,
        );
      }
      effects.push(
        `"${request.bonusLabel ?? "Ustama"}" ustamasi yaratiladi: ${request.bonusType === "percent" ? `${Number(request.bonusValue)}%` : formatMoneyUz(request.bonusValue)}, ` +
          `${formatMonthRange(start, request.bonusEndMonth)}`,
        "Ustamani keyin o'chiradigan tugma yo'q",
      );
      approvedBonus = { label: request.bonusLabel ?? "Ustama", type: request.bonusType ?? "fixed", value: request.bonusValue ?? 0 };
    }

    const salaryRules = await staffSalaryService.resolveSalariesForMonth(month);
    const [beforeCtx, afterBaseCtx] = await Promise.all([
      payrollEngine.loadContext(month, [user], { salaryRules }),
      request.kind === "category" ? payrollEngine.loadContext(month, [hypotheticalUser], { salaryRules }) : null,
    ]);
    let afterCtx = afterBaseCtx;
    if (approvedBonus) {
      const bonusMap = new Map(beforeCtx.bonusMap);
      const inPeriod = request.bonusEndMonth == null || request.bonusEndMonth >= month;
      if (inPeriod) bonusMap.set(user.id, [...(bonusMap.get(user.id) ?? []), approvedBonus]);
      afterCtx = { ...beforeCtx, bonusMap };
    }
    const before = payrollEngine.previewForStaff(user, month, beforeCtx);
    const after = payrollEngine.previewForStaff(hypotheticalUser, month, afterCtx);

    fields.push(
      { label: "Biriktirma", before: assignmentLabel(before), after: assignmentLabel(after) },
      { label: "Ustamalar", before: before ? money(before.allowanceAmount) : "—", after: after ? money(after.allowanceAmount) : "—" },
      { label: `Jami oylik (${monthLabel(month)}, prognoz)`, before: previewAmountLabel(before), after: previewAmountLabel(after) },
    );
    effects.push("Qaror oylik tuzilmasi jurnaliga yoziladi");
    if (user.isArchived) {
      warnings.push("Xodim arxivlangan — unga oylik shakllantirilmaydi.");
    } else {
      // Toifa davrsiz, ustama esa o'z davri bilan: ikkalasi ham majburiyati
      // hali yo'q o'tgan catch-up oylariga tushadi.
      const exposure = await describeCatchUpExposure(sealed, ctx.monthKey, async (m) => {
        if (request.kind === "category") return previewStaffMonth(hypotheticalUser, m);
        const start = request.bonusStartMonth ?? ctx.monthKey;
        if (m < start || (request.bonusEndMonth != null && m > request.bonusEndMonth)) return null;
        return previewStaffMonth(user, m, { bonus: approvedBonus });
      });
      if (exposure) warnings.push(exposure);
    }
    if (request.kind === "bonus" && !before && !after) {
      warnings.push("Xodimda lavozim, toifa yoki oylik qoidasi yo'q — ustama o'zi oylik hosil qilmaydi.");
    }

    return {
      params: { requestId, decision: "approved", rejectionReason: null, staffName: name, kindLabel },
      preview: {
        summary: `${name} ning ${kindLabel} arizasi tasdiqlanadi`,
        target: `${name} — ${kindLabel} arizasi`,
        fields,
        effects,
        warnings,
      },
    };
  },

  async execute(params, ctx) {
    // POST /api/payroll-requests/:id/review → reviewRequest(req.params.id, req.body, req.user.id)
    const result = await payrollRequestService.reviewRequest(
      params.requestId,
      { status: params.decision, rejectionReason: params.rejectionReason ?? undefined },
      ctx.user.id,
    );
    return {
      summary: `${result.staffName} ning ${params.kindLabel} arizasi ${params.decision === "approved" ? "tasdiqlandi" : "rad etildi"}`,
      details: [{ label: "Ko'rib chiqilgan vaqt", value: result.reviewedAtLabel ?? "—" }],
      data: { requestId: result.id, status: result.status },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 7. XARAJAT
// ─────────────────────────────────────────────────────────────────────────

const createExpense = defineAction({
  type: "expenses.create",
  toolName: "propose_create_expense",
  toolset: TOOLSET,
  title: "Xarajat qayd etish",
  risk: "high",
  permission: "expenses.create",
  description:
    "Propose recording a one-off expense (rent, utilities, repairs, supplies — NOT salaries) paid from a payment account. " +
    "Money leaves the account immediately; there is no balance check. Preview warns when the category's monthly limit " +
    "would be exceeded. Get categoryId and accountId from payroll_catalog.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["categoryId", "accountId", "amount"],
    properties: {
      categoryId: idSchema("Active expense category id."),
      accountId: idSchema("Active payment account id."),
      amount: { type: ["number", "string"], description: "Expense amount in so'm." },
      date: daySchema("Expense day 'YYYY-MM-DD' (not in the future). Omit for now."),
      payee: { type: "string", maxLength: 120, description: "Who was paid (optional)." },
      note: { type: "string", maxLength: 300, description: "Optional note." },
    },
  },

  async prepare(args, ctx) {
    const categoryId = requireId(args.categoryId, "Kategoriya id");
    const accountId = requireId(args.accountId, "To'lov turi id");
    const amount = parseMoneyArg(args.amount, "Summa");
    const day = args.date === undefined ? ctx.today : dayArg(args.date, "Xarajat sanasi");
    if (day > ctx.today) throw new AiToolError("Kelajakdagi sana bilan xarajat qayd etib bo'lmaydi");

    const [category, account] = await Promise.all([
      asToolError(() => expenseCategoryService.assertActiveCategory(categoryId)),
      asToolError(() => paymentAccountService.assertActiveAccount(accountId)),
    ]);

    const month = Number(`${day.slice(0, 4)}${day.slice(5, 7)}`);
    const budgets = await expenseBudgetService.getBudgets({ month });
    const budget = budgets.items.find((row) => row.categoryId === categoryId) ?? null;

    const fields = [
      { label: "Kategoriya", before: "—", after: category.name },
      { label: "Summa", before: "—", after: money(amount) },
      { label: "Sana", before: "—", after: formatDateUz(day, { utc: true }) },
    ];
    if (args.payee) fields.push({ label: "Oluvchi", before: "—", after: args.payee });

    const balance = new Decimal(account.balance);
    fields.push({ label: `"${account.name}" qoldig'i`, before: money(balance), after: money(balance.minus(amount)) });

    const warnings = [];
    const spent = new Decimal(budget?.spent ?? 0);
    const spentAfter = spent.plus(amount);
    if (budget?.limit != null) {
      const limit = new Decimal(budget.limit);
      fields.push({
        label: `${monthLabel(month)} limiti (${formatMoneyUz(budget.limit)}) bo'yicha sarf`,
        before: money(spent),
        after: money(spentAfter),
      });
      if (spentAfter.greaterThan(limit)) {
        warnings.push(
          `"${category.name}" uchun ${monthLabel(month)} limiti oshadi: limit ${formatMoneyUz(budget.limit)}, ` +
            `sarf ${money(spentAfter)} bo'ladi (${money(spentAfter.minus(limit))} ortiq). Limit xarajatni to'smaydi.`,
        );
      }
    }
    if (balance.lessThan(amount)) {
      warnings.push(`"${account.name}" qoldig'i xarajatdan kam — qoldiq manfiy bo'ladi.`);
    }

    // Bugungi kun HOZIRGI payt sifatida yuboriladi (UTC yarim tuni Toshkentda ertalab "kelajak" bo'lib qolmasin)
    const occurredAt = day !== ctx.today ? day : null;

    return {
      params: {
        categoryId,
        categoryName: category.name,
        accountId,
        accountName: account.name,
        amount: formatAmount(amount),
        occurredAt,
        payee: args.payee ?? null,
        note: args.note ?? null,
      },
      preview: {
        summary: `"${category.name}" bo'yicha ${money(amount)} xarajat "${account.name}" dan qayd etiladi`,
        target: `${category.name} — ${formatDateUz(day, { utc: true })}`,
        fields,
        effects: [
          `Pul "${account.name}" to'lov turidan chiqadi (daftarga manfiy qator yoziladi)`,
          "Xarajat keyin tahrirlanmaydi — xato bo'lsa admin panelda bekor qilinadi",
        ],
        warnings,
      },
      fingerprint: {
        params: { categoryId, accountId, amount: formatAmount(amount), occurredAt, payee: args.payee ?? null, note: args.note ?? null },
        limit: budget?.limit ?? null,
        spent: budget?.spent ?? null,
      },
    };
  },

  async execute(params, ctx) {
    // POST /api/expenses → createExpense(req.body, req.user.id)
    const expense = await expenseService.createExpense(
      {
        categoryId: params.categoryId,
        accountId: params.accountId,
        amount: params.amount,
        payee: params.payee ?? undefined,
        note: params.note ?? undefined,
        occurredAt: params.occurredAt ?? undefined,
      },
      ctx.user.id,
    );
    return {
      summary: `"${expense.categoryName}" bo'yicha ${formatMoneyUz(expense.amount)} xarajat qayd etildi ("${expense.accountName}")`,
      details: [{ label: "Sana", value: formatDateUz(expense.occurredAt) }],
      data: { expenseId: expense.id, amount: expense.amount },
    };
  },
});

const setExpenseBudget = defineAction({
  type: "expenses.set_budget",
  toolName: "propose_set_expense_budget",
  toolset: TOOLSET,
  title: "Xarajat limitini belgilash",
  risk: "low",
  permission: "reports.plan",
  description:
    "Propose setting or removing ONE expense category's monthly limit for a month. Other categories' limits are left " +
    "untouched. Limits only warn; they never block expenses. Pass limitAmount to set, or removeLimit=true to remove.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["month", "categoryId"],
    properties: {
      month: monthSchema("Month as YYYYMM the limit applies to."),
      categoryId: idSchema("Expense category id."),
      limitAmount: { type: ["number", "string"], description: "Monthly limit in so'm." },
      removeLimit: { type: "boolean", description: "true to remove the limit for that month." },
      note: { type: "string", maxLength: 300, description: "Optional note; omit to keep the existing note." },
    },
  },

  async prepare(args, ctx) {
    const month = monthArg(args.month);
    const categoryId = requireId(args.categoryId, "Kategoriya id");
    const remove = args.removeLimit === true;
    if (remove === (args.limitAmount !== undefined)) {
      throw new AiToolError("limitAmount yoki removeLimit dan aynan bittasini bering");
    }

    const [category, existing, budgets] = await Promise.all([
      prisma.expenseCategory.findUnique({ where: { id: categoryId }, select: { id: true, name: true, isActive: true, isArchived: true } }),
      prisma.expenseBudget.findUnique({ where: { month_categoryId: { month, categoryId } } }),
      expenseBudgetService.getBudgets({ month }),
    ]);
    if (!category) throw new AiToolError("Xarajat kategoriyasi topilmadi");

    const limit = remove ? null : parseMoneyArg(args.limitAmount, `"${category.name}" limiti`, { allowZero: true });
    const note = args.note !== undefined ? args.note : existing?.note ?? "";
    const oldLimit = existing ? new Decimal(existing.limitAmount) : null;

    if (remove && !existing) throw new AiToolError(`"${category.name}" uchun ${monthLabel(month)} limiti belgilanmagan`);
    if (!remove && oldLimit && oldLimit.equals(limit) && note === (existing.note ?? "")) {
      throw new AiToolError(`"${category.name}" uchun ${monthLabel(month)} limiti allaqachon ${money(limit)}`);
    }

    const spent = new Decimal(budgets.items.find((row) => row.categoryId === categoryId)?.spent ?? 0);
    const fields = [
      { label: "Oylik limit", before: oldLimit ? money(oldLimit) : "Belgilanmagan", after: limit ? money(limit) : "Belgilanmagan" },
      { label: "Sarflangan", before: money(spent), after: money(spent) },
      {
        label: "Qoldiq",
        before: oldLimit ? money(oldLimit.minus(spent)) : "—",
        after: limit ? money(limit.minus(spent)) : "—",
      },
    ];
    if (args.note !== undefined) fields.push({ label: "Izoh", before: existing?.note || "—", after: note || "—" });

    const warnings = [];
    if (limit && spent.greaterThan(limit)) {
      warnings.push(`Bu oyda allaqachon ${money(spent)} sarflangan — limit darhol oshgan holatda bo'ladi.`);
    }
    if (category.isArchived || !category.isActive) warnings.push(`"${category.name}" kategoriyasi faol emas.`);
    if (month < ctx.monthKey) warnings.push(`${monthLabel(month)} — o'tgan oy.`);

    return {
      params: {
        month,
        categoryId,
        categoryName: category.name,
        limitAmount: limit ? formatAmount(limit) : null,
        note,
      },
      preview: {
        summary: remove
          ? `"${category.name}" uchun ${monthLabel(month)} limiti olib tashlanadi`
          : `"${category.name}" uchun ${monthLabel(month)} limiti ${money(limit)} bo'ladi`,
        target: `${category.name} — ${monthLabel(month)}`,
        fields,
        effects: [
          "Faqat shu kategoriya limiti o'zgaradi; boshqa kategoriyalar limitlariga tegilmaydi",
          "Limit xarajatni to'smaydi — oshsa hisobotda ogohlantirish sifatida ko'rinadi",
        ],
        warnings,
      },
    };
  },

  async execute(params, ctx) {
    // PUT /api/finance-reports/expense-budgets → upsertBudgets(req.body, req.user.id)
    const result = await expenseBudgetService.upsertBudgets(
      {
        month: params.month,
        items: [{ categoryId: params.categoryId, limitAmount: params.limitAmount, note: params.note }],
      },
      ctx.user.id,
    );
    const row = result.items.find((item) => item.categoryId === params.categoryId);
    return {
      summary: params.limitAmount
        ? `"${params.categoryName}" uchun ${result.monthLabel} limiti ${formatMoneyUz(params.limitAmount)} qilib belgilandi`
        : `"${params.categoryName}" uchun ${result.monthLabel} limiti olib tashlandi`,
      details: row
        ? [
            { label: "Sarflangan", value: formatMoneyUz(row.spent) },
            { label: "Qoldiq", value: row.remaining != null ? formatMoneyUz(row.remaining) : "—" },
          ]
        : [],
      data: { month: result.month, categoryId: params.categoryId, limit: row?.limit ?? null },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 8. JARIMALAR
// ─────────────────────────────────────────────────────────────────────────

const PENALTY_USER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  role: true,
  penaltyPoints: true,
  isArchived: true,
  telegramIds: true,
};

/** O'quvchi uchun Telegram xabari boradigan faol chatlar soni (`sendPenaltyNotification` sharti). */
const penaltyNoticeChats = async (user) => {
  if (user.role !== ROLES.STUDENT || !user.telegramIds?.length) return 0;
  return prisma.tgUser.count({ where: { student: user.id, isActive: true, notificationsEnabled: true } });
};

/** Jami ball ta'siri — `market.service` (>3) va Telegram xabari (≥12) chegaralari. */
const penaltyThresholdEffects = (user, pointsAfter) => {
  if (user.role !== ROLES.STUDENT) return ["Jarima bali oylikka ta'sir qilmaydi"];
  const effects = [];
  if (pointsAfter >= 12) effects.push("Jami ball 12 ga yetadi — Telegram xabarida profil bloklangani aytiladi");
  else if (pointsAfter > 3) effects.push("Jami ball 3 dan oshadi — o'quvchiga do'kondan foydalanish cheklanadi");
  return effects;
};

const givePenalty = defineAction({
  type: "penalties.create",
  toolName: "propose_give_penalty",
  toolset: TOOLSET,
  title: "Jarima yozish",
  risk: "medium",
  permission: "penalties.create",
  description:
    "Propose giving a penalty (points, not money) to a student or staff member, either by an existing category " +
    "(categoryId from penalties_stats; its title and points are used) or a custom one (title + points). A penalty " +
    "given by the owner is approved immediately and adds points; for students the parents get a Telegram notice.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["userId"],
    properties: {
      userId: idSchema("User id receiving the penalty."),
      categoryId: idSchema("Penalty category id. Omit for a custom penalty."),
      title: { type: "string", maxLength: 200, description: "Custom penalty title (required without categoryId)." },
      points: { type: "integer", minimum: 1, maximum: 100, description: "Custom penalty points (required without categoryId)." },
      description: { type: "string", maxLength: 500, description: "Optional description." },
    },
  },

  async prepare(args) {
    const userId = requireId(args.userId, "Foydalanuvchi id");
    const user = await prisma.user.findUnique({ where: { id: userId }, select: PENALTY_USER_SELECT });
    if (!user) throw new AiToolError("Foydalanuvchi topilmadi");
    if (user.role === ROLES.OWNER) throw new AiToolError("Ownerga jarima yozib bo'lmaydi");

    const warnings = [];
    let category = null;
    if (args.categoryId) {
      category = await prisma.penaltyCategory.findUnique({ where: { id: requireId(args.categoryId, "Kategoriya id") } });
      if (!category || !category.isActive) throw new AiToolError("Jarima kategoriyasi topilmadi");
      if (category.targetRole && category.targetRole !== user.role) {
        warnings.push(`"${category.title}" kategoriyasi "${category.targetRole}" roli uchun, foydalanuvchi roli esa "${user.role}".`);
      }
      if (args.points !== undefined && args.points !== category.points) {
        warnings.push(`Kategoriya bo'yicha ball ishlatiladi: ${category.points} (so'ralgan ${args.points} emas).`);
      }
    } else if (!args.title || args.points === undefined) {
      throw new AiToolError("Kategoriyasiz jarima uchun sarlavha (title) va ball (points) majburiy");
    }

    const points = category ? category.points : args.points;
    const title = category ? category.title : args.title;
    const [settings, chats] = await Promise.all([penaltyService.getSettings(), penaltyNoticeChats(user)]);
    const fineAmount = settings.fineAmounts?.[user.role] || 0;
    const name = personName(user);
    const pointsAfter = user.penaltyPoints + points;

    const fields = [
      { label: "Sabab", before: "—", after: title },
      { label: "Jarima bali", before: String(user.penaltyPoints), after: String(pointsAfter) },
    ];
    if (fineAmount > 0) fields.push({ label: "Jarima summasi (qayd uchun)", before: "—", after: formatMoneyUz(fineAmount) });

    const effects = ["Egasi yozgan jarima darhol tasdiqlanadi va ball qo'shiladi", ...penaltyThresholdEffects(user, pointsAfter)];
    if (chats > 0) effects.push(`Ota-onaga Telegram orqali xabar yuboriladi (${chats} ta chat)`);
    if (user.isArchived) warnings.push("Foydalanuvchi arxivlangan.");

    return {
      params: {
        userId,
        userName: name,
        categoryId: category?.id ?? null,
        isCustom: !category,
        title: category ? null : args.title,
        points,
        description: args.description ?? null,
      },
      preview: {
        summary: `${name} ga "${title}" uchun ${points} ball jarima yoziladi`,
        target: `${name} — ${user.role}`,
        fields,
        effects,
        warnings,
      },
    };
  },

  async execute(params, ctx) {
    // POST /api/penalties → createPenalty({ userId, categoryId, title, description, points: Number(points),
    //   givenBy: req.user.id, givenByRole: req.user.role, isCustom, files: req.files || [] })
    // ⚠️ Matn Telegram'ga HTML rejimida ketadi; HTTP yo'lida xss-clean `<` ni
    // tozalaydi, bu yerda esa servis to'g'ridan-to'g'ri chaqiriladi — escape majburiy.
    const penalty = await surfacePlainError(() =>
      penaltyService.createPenalty({
        userId: params.userId,
        categoryId: params.categoryId ?? undefined,
        title: params.title != null ? escapeHtml(params.title) : undefined,
        description: params.description != null ? escapeHtml(params.description) : undefined,
        points: Number(params.points),
        givenBy: ctx.user.id,
        givenByRole: ctx.user.role,
        isCustom: params.isCustom,
        files: [],
      }),
    );
    return {
      summary: `${params.userName} ga ${penalty.points} ball jarima yozildi va tasdiqlandi`,
      details: [{ label: "Sabab", value: penalty.title ?? "—" }],
      data: { penaltyId: penalty.id, status: penalty.status, points: penalty.points },
    };
  },
});

const reducePenalty = defineAction({
  type: "penalties.reduce",
  toolName: "propose_reduce_penalty",
  toolset: TOOLSET,
  title: "Jarima balini kamaytirish",
  risk: "medium",
  permission: "penalties.reduce",
  description:
    "Propose reducing a user's current penalty points (cannot exceed the points they have). A reduction by the owner " +
    "is approved immediately. Check current points with penalties_user first.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["userId", "points", "reason"],
    properties: {
      userId: idSchema("User id."),
      points: { type: "integer", minimum: 1, maximum: 1000, description: "Points to remove." },
      reason: { type: "string", minLength: 1, maxLength: 500, description: "Reason for the reduction." },
    },
  },

  async prepare(args) {
    const userId = requireId(args.userId, "Foydalanuvchi id");
    const user = await prisma.user.findUnique({ where: { id: userId }, select: PENALTY_USER_SELECT });
    if (!user) throw new AiToolError("Foydalanuvchi topilmadi");
    const name = personName(user);
    if (user.penaltyPoints <= 0) throw new AiToolError(`${name} da jarima bali yo'q`);
    if (args.points > user.penaltyPoints) {
      throw new AiToolError(`Kamaytirilayotgan ball foydalanuvchida mavjud balldan (${user.penaltyPoints}) ko'p bo'lishi mumkin emas`);
    }
    const pointsAfter = user.penaltyPoints - args.points;

    return {
      params: { userId, userName: name, points: args.points, reason: args.reason },
      preview: {
        summary: `${name} jarima bali ${args.points} ga kamaytiriladi`,
        target: `${name} — ${user.role}`,
        fields: [
          { label: "Jarima bali", before: String(user.penaltyPoints), after: String(pointsAfter) },
          { label: "Sabab", before: "—", after: args.reason },
        ],
        effects: ["Egasi kiritgan kamaytirish darhol tasdiqlanadi", "Kamaytirish jarimalar tarixida alohida qator bo'lib qoladi"],
        warnings: user.isArchived ? ["Foydalanuvchi arxivlangan."] : [],
      },
    };
  },

  async execute(params, ctx) {
    // POST /api/penalties/reduce → reducePenalty({ userId, points: Number(points), reason, reducedBy: req.user.id, reducedByRole: req.user.role })
    const reduction = await surfacePlainError(() =>
      penaltyService.reducePenalty({
        userId: params.userId,
        points: Number(params.points),
        reason: params.reason,
        reducedBy: ctx.user.id,
        reducedByRole: ctx.user.role,
      }),
    );
    return {
      summary: `${params.userName} jarima bali ${reduction.points} ga kamaytirildi`,
      data: { reductionId: reduction.id, status: reduction.status },
    };
  },
});

const reviewPenalty = defineAction({
  type: "penalties.review",
  toolName: "propose_review_penalty",
  toolset: TOOLSET,
  title: "Jarimani ko'rib chiqish",
  risk: "medium",
  permission: "penalties.review",
  description:
    "Propose approving or rejecting a pending penalty or point reduction (from penalties_pending). Approving a penalty " +
    "adds its points (students' parents get a Telegram notice); approving a reduction removes points. Rejecting " +
    "requires a reason.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["penaltyId", "decision"],
    properties: {
      penaltyId: idSchema("Pending penalty id."),
      decision: { type: "string", enum: DECISIONS, description: "approved or rejected." },
      rejectionReason: { type: "string", maxLength: 500, description: "Required when rejecting." },
    },
  },

  async prepare(args) {
    const penaltyId = requireId(args.penaltyId, "Jarima id");
    const penalty = await surfacePlainError(() => penaltyService.getPenaltyById(penaltyId));
    if (penalty.status !== "pending") {
      throw new AiToolError("Faqat kutilayotgan holatdagi jarimani tasdiqlash yoki rad etish mumkin");
    }
    if (args.decision === "rejected" && !args.rejectionReason) {
      throw new AiToolError("Rad etish sababi majburiy");
    }

    const target = await prisma.user.findUnique({ where: { id: penalty.userId }, select: PENALTY_USER_SELECT });
    if (!target) throw new AiToolError("Jarima egasi (foydalanuvchi) topilmadi");
    const name = personName(target);
    const isReduction = penalty.type === "reduction";
    const kind = isReduction ? "ball kamaytirish" : "jarima";
    const title = penalty.title || penalty.category?.title || penalty.description || "—";
    const warnings = [];
    const fields = [
      { label: "Holat", before: "Kutilmoqda", after: args.decision === "approved" ? "Tasdiqlangan" : "Rad etilgan" },
      { label: "Sabab", before: title, after: title },
    ];
    const effects = [];

    if (args.decision === "approved") {
      const pointsAfter = target.penaltyPoints + (isReduction ? -penalty.points : penalty.points);
      fields.push({ label: "Jarima bali", before: String(target.penaltyPoints), after: String(pointsAfter) });
      if (isReduction && pointsAfter < 0) warnings.push("Kamaytirish mavjud balldan ko'p — ball manfiy bo'lib qoladi.");
      if (!isReduction) {
        effects.push(...penaltyThresholdEffects(target, pointsAfter));
        const chats = await penaltyNoticeChats(target);
        if (chats > 0) effects.push(`Ota-onaga Telegram orqali xabar yuboriladi (${chats} ta chat)`);
      }
    } else {
      fields.push({ label: "Rad etish sababi", before: "—", after: args.rejectionReason });
      effects.push("Ball o'zgarmaydi");
    }

    return {
      params: {
        penaltyId,
        decision: args.decision,
        rejectionReason: args.rejectionReason ?? null,
        userName: name,
        kind,
      },
      preview: {
        summary: `${name} ga yozilgan ${kind} (${penalty.points} ball) ${args.decision === "approved" ? "tasdiqlanadi" : "rad etiladi"}`,
        target: `${name} — ${penalty.givenBy ? `yozgan: ${personName(penalty.givenBy)}` : target.role}`,
        fields,
        effects,
        warnings,
      },
    };
  },

  async execute(params, ctx) {
    // PUT /api/penalties/:id/review → reviewPenalty(req.params.id, { status, rejectionReason, reviewedBy: req.user.id })
    const updated = await surfacePlainError(() =>
      penaltyService.reviewPenalty(params.penaltyId, {
        status: params.decision,
        rejectionReason: params.rejectionReason ?? undefined,
        reviewedBy: ctx.user.id,
      }),
    );
    return {
      summary: `${params.userName} ga yozilgan ${params.kind} ${updated.status === "approved" ? "tasdiqlandi" : "rad etildi"}`,
      data: { penaltyId: updated.id, status: updated.status },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 9. PREMIUM
// ─────────────────────────────────────────────────────────────────────────

const PREMIUM_USER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  role: true,
  isArchived: true,
  premiumIsActive: true,
  premiumExpiresAt: true,
};

/** Servis qaytargan TO'LIQ `User` qatoridan (parol xeshlari bilan) faqat xavfsiz maydonlar. */
const safePremiumUser = (user) => ({
  id: user.id,
  premiumIsActive: user.premiumIsActive,
  premiumExpiresAtLabel: formatDateUz(user.premiumExpiresAt),
});

const grantPremium = defineAction({
  type: "premium.grant",
  toolName: "propose_grant_premium",
  toolset: TOOLSET,
  title: "O'quvchiga premium berish",
  risk: "medium",
  permission: "premium.grant",
  description:
    "Propose granting premium to a STUDENT for free (no coins charged) for durationDays (default: premium settings). If " +
    "premium is already active the days are added to the current expiry. The student is notified via Telegram.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["studentId"],
    properties: {
      studentId: idSchema("Student user id."),
      durationDays: { type: "integer", minimum: 1, maximum: 366, description: "Days of premium. Omit for the default duration." },
    },
  },

  async prepare(args, ctx) {
    const studentId = requireId(args.studentId, "O'quvchi id");
    const student = await prisma.user.findUnique({ where: { id: studentId }, select: PREMIUM_USER_SELECT });
    if (!student) throw new AiToolError("Foydalanuvchi topilmadi");
    // Servis rolni TEKSHIRMAYDI — xodimga premium berilib qolmasligi uchun shu yerda
    if (student.role !== ROLES.STUDENT) throw new AiToolError("Premium faqat o'quvchiga beriladi");

    const settings = await getPremiumSettings();
    const days = args.durationDays ?? settings.durationDays;
    const isActive = student.premiumIsActive && student.premiumExpiresAt && student.premiumExpiresAt > ctx.now;
    const baseDate = isActive ? new Date(student.premiumExpiresAt) : new Date(ctx.now);
    const expiresAt = new Date(baseDate);
    expiresAt.setDate(expiresAt.getDate() + days);
    const name = personName(student);

    const warnings = [];
    if (!settings.isEnabled) warnings.push("Premium tizimi sozlamalarda o'chirilgan.");
    if (student.isArchived) warnings.push("O'quvchi arxivlangan.");

    return {
      params: { studentId, studentName: name, durationDays: args.durationDays ?? null, days },
      preview: {
        summary: `${name} ga ${days} kunlik premium bepul beriladi`,
        target: `${name} — o'quvchi`,
        fields: [
          {
            label: "Premium",
            before: isActive ? `Faol (${formatDateUz(student.premiumExpiresAt)} gacha)` : "Faol emas",
            after: `Faol (taxminan ${formatDateUz(expiresAt)} gacha)`,
          },
          { label: "Muddat", before: "—", after: `${days} kun` },
        ],
        effects: [
          "Tanga yechilmaydi (qo'lda berilgan obuna)",
          ...(isActive ? ["Kunlar amaldagi muddat ustiga qo'shiladi"] : []),
          "O'quvchiga Telegram orqali xabar yuboriladi",
        ],
        warnings,
      },
      fingerprint: {
        params: { studentId, days },
        isActive: Boolean(isActive),
        currentExpiry: isActive ? student.premiumExpiresAt.toISOString() : null,
        enabled: settings.isEnabled,
      },
    };
  },

  async execute(params, ctx) {
    // POST /api/premium/admin/grant → grantPremium(studentId, durationDays, req.user.id)
    const user = await premiumService.grantPremium(params.studentId, params.durationDays ?? undefined, ctx.user.id);
    const safe = safePremiumUser(user);
    return {
      summary: `${params.studentName} ga ${params.days} kunlik premium berildi (${safe.premiumExpiresAtLabel} gacha)`,
      data: safe,
    };
  },
});

const revokePremium = defineAction({
  type: "premium.revoke",
  toolName: "propose_revoke_premium",
  toolset: TOOLSET,
  title: "Premiumni bekor qilish",
  risk: "medium",
  permission: "premium.revoke",
  description:
    "Propose revoking a user's active premium immediately (all active subscriptions become revoked, no coin refund). " +
    "The student is notified via Telegram.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["studentId"],
    properties: { studentId: idSchema("Student user id.") },
  },

  async prepare(args) {
    const studentId = requireId(args.studentId, "O'quvchi id");
    const student = await prisma.user.findUnique({ where: { id: studentId }, select: PREMIUM_USER_SELECT });
    if (!student) throw new AiToolError("Foydalanuvchi topilmadi");
    // Servis bilan AYNI shart: faqat bayroq (muddat emas) tekshiriladi
    if (!student.premiumIsActive) throw new AiToolError("Foydalanuvchida faol premium mavjud emas");
    const [activeCount, coinPaid] = await Promise.all([
      prisma.premium.count({ where: { student: studentId, status: "active" } }),
      prisma.premium.aggregate({ where: { student: studentId, status: "active" }, _sum: { coinCost: true } }),
    ]);
    const name = personName(student);

    return {
      params: { studentId, studentName: name },
      preview: {
        summary: `${name} premiumi darhol bekor qilinadi`,
        target: `${name} — ${student.role}`,
        fields: [
          { label: "Premium", before: `Faol (${formatDateUz(student.premiumExpiresAt)} gacha)`, after: "Faol emas" },
          { label: "Faol obunalar", before: String(activeCount), after: "0" },
        ],
        effects: ["Barcha faol obunalar \"bekor qilingan\" holatiga o'tadi", "O'quvchiga Telegram orqali xabar yuboriladi"],
        warnings: coinPaid._sum.coinCost
          ? [`Faol obunalar uchun ${coinPaid._sum.coinCost} tanga to'langan — tangalar qaytarilmaydi.`]
          : [],
      },
    };
  },

  async execute(params, ctx) {
    // POST /api/premium/admin/revoke → revokePremium(studentId, req.user.id)
    const user = await premiumService.revokePremium(params.studentId, ctx.user.id);
    return {
      summary: `${params.studentName} premiumi bekor qilindi`,
      data: safePremiumUser(user),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 10. TANGALAR
// ─────────────────────────────────────────────────────────────────────────

const FILTER_TYPES = ["role", "class", "gender", "individual"];

const distributeCoins = defineAction({
  type: "coins.distribute_manual",
  toolName: "propose_distribute_coins",
  toolset: TOOLSET,
  title: "Tanga berish yoki olish",
  risk: "high",
  permission: "coins.distribute",
  description:
    "Propose giving or taking coins manually for all ACTIVE users matching one filter: role (e.g. 'student'), class " +
    "(classId), gender ('male'/'female') or individual (userId). Warning: the role/class filters are not limited to " +
    "students. 'take' skips users whose balance is too small. Preview shows the exact recipient count.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["action", "amount", "reason", "filterType", "filterValue"],
    properties: {
      action: { type: "string", enum: ["give", "take"], description: "give adds coins, take removes coins." },
      amount: { type: "integer", minimum: 1, maximum: 1000000, description: "Coins per user." },
      reason: { type: "string", minLength: 1, maxLength: 300, description: "Reason stored on every coin transaction." },
      filterType: { type: "string", enum: FILTER_TYPES, description: "Recipient filter type." },
      filterValue: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        description: "Role value, class id, 'male'/'female', or user id — matching filterType.",
      },
    },
  },

  async prepare(args) {
    const { action, amount, filterType } = args;
    const reason = args.reason.trim();
    let filterValue = args.filterValue;
    let scopeLabel;

    if (filterType === "class") {
      filterValue = requireId(filterValue, "Sinf id");
      const cls = await prisma.class.findUnique({ where: { id: filterValue }, select: { name: true } });
      if (!cls) throw new AiToolError("Sinf topilmadi");
      scopeLabel = `${cls.name} sinfi`;
    } else if (filterType === "gender") {
      if (!GENDER_LABELS[filterValue]) throw new AiToolError("Jins qiymati 'male' yoki 'female' bo'lishi kerak");
      scopeLabel = GENDER_LABELS[filterValue];
    } else if (filterType === "individual") {
      filterValue = requireId(filterValue, "Foydalanuvchi id");
      scopeLabel = null;
    } else {
      scopeLabel = `"${filterValue}" roli`;
    }

    const preview = await surfacePlainError(() => coinService.getFilteredUsersPreview(filterType, filterValue));
    if (preview.totalCount === 0) {
      throw new AiToolError("Filtrga mos faol foydalanuvchi topilmadi");
    }
    if (filterType === "individual") scopeLabel = personName(preview.users[0]);

    const sampleIsComplete = preview.totalCount <= preview.users.length;
    const insufficient = action === "take" ? preview.users.filter((u) => (u.coinBalance || 0) < amount).length : 0;
    const nonStudents = preview.users.filter((u) => u.role !== ROLES.STUDENT).length;
    const affected = preview.totalCount - (sampleIsComplete ? insufficient : 0);
    if (action === "take" && affected === 0) {
      throw new AiToolError(`Filtrga mos ${preview.totalCount} ta foydalanuvchining hech birida ${amount} tanga yo'q — olinadigan tanga yo'q`);
    }

    const fields = [
      { label: "Filtr", before: "—", after: scopeLabel },
      { label: "Mos foydalanuvchilar", before: "—", after: String(preview.totalCount) },
      { label: action === "give" ? "Har biriga beriladi" : "Har biridan olinadi", before: "—", after: `${groupDigits(amount)} tanga` },
      {
        label: "Jami tanga",
        before: "—",
        after: `${sampleIsComplete ? "" : "ko'pi bilan "}${groupDigits(affected * amount)} tanga`,
      },
    ];
    if (filterType === "individual") {
      const balance = preview.users[0].coinBalance || 0;
      fields.push({
        label: "Balans",
        before: groupDigits(balance),
        after: groupDigits(action === "give" ? balance + amount : balance - amount),
      });
    }

    const effects = [
      `Har bir foydalanuvchiga tanga tranzaksiyasi yoziladi (sabab: ${reason})`,
      "Hammasi bitta tranzaksiyada yoziladi: xato bo'lsa hech kimga yozilmaydi",
    ];
    if (preview.totalCount <= 10) {
      effects.push(`Qabul qiluvchilar: ${preview.users.map(personName).join(", ")}`);
    }

    const warnings = [];
    if (action === "take" && insufficient > 0) {
      warnings.push(
        sampleIsComplete
          ? `${insufficient} ta foydalanuvchida balans yetarli emas — ular o'tkazib yuboriladi.`
          : `Birinchi ${preview.users.length} ta foydalanuvchidan ${insufficient} tasida balans yetarli emas — ular o'tkazib yuboriladi.`,
      );
    }
    if (filterType === "individual" && nonStudents > 0) {
      warnings.push(`${scopeLabel} o'quvchi emas (rol: ${preview.users[0].role}).`);
    } else if (nonStudents > 0) {
      warnings.push(
        `Filtrga o'quvchi bo'lmagan ${nonStudents}${sampleIsComplete ? "" : "+"} ta foydalanuvchi ham tushadi (xodimlar ham tanga oladi/beradi).`,
      );
    }
    if (!sampleIsComplete) warnings.push(`Ko'rinish birinchi ${preview.users.length} ta foydalanuvchi asosida hisoblangan.`);

    return {
      params: { action, amount, reason, filterType, filterValue, scopeLabel, totalCount: preview.totalCount },
      preview: {
        summary: `${scopeLabel}: ${preview.totalCount} ta foydalanuvchi${action === "give" ? "ga" : "dan"} ${groupDigits(amount)} tangadan ${action === "give" ? "beriladi" : "olinadi"}`,
        target: scopeLabel,
        fields,
        effects,
        warnings,
      },
      fingerprint: {
        params: { action, amount, reason, filterType, filterValue },
        totalCount: preview.totalCount,
        insufficient,
        nonStudents,
      },
    };
  },

  async execute(params, ctx) {
    // POST /api/coins/distribute → distributeManualCoins({ action, amount: parseInt(amount), reason: reason.trim(), filterType, filterValue, givenBy: req.user.id })
    const result = await surfacePlainError(() =>
      coinService.distributeManualCoins({
        action: params.action,
        amount: params.amount,
        reason: params.reason,
        filterType: params.filterType,
        filterValue: params.filterValue,
        givenBy: ctx.user.id,
      }),
    );
    // Servis paket xatosini TASHLAMAYDI, `errorCount` bilan qaytaradi — yashirilsa
    // "bajarildi" deb ko'rinib, hech kimga tanga yozilmagan bo'lardi.
    if (result.errorCount > 0) {
      throw new AiToolError(
        `Tangalarni yozishda xato yuz berdi — ${result.errorCount} ta foydalanuvchiga hech narsa yozilmadi. Keyinroq qayta urinib ko'ring.`,
      );
    }
    const verb = params.action === "give" ? "berildi" : "olindi";
    return {
      summary: `${params.scopeLabel}: ${result.successCount} ta foydalanuvchi${params.action === "give" ? "ga" : "dan"} ${groupDigits(params.amount)} tangadan ${verb}`,
      details: [
        { label: "Topildi", value: String(result.totalFound) },
        { label: "Bajarildi", value: String(result.successCount) },
        { label: "O'tkazib yuborildi", value: String(result.skippedCount) },
      ],
      data: result,
    };
  },
});

module.exports = [
  changeStaffSalary,
  assignStaffPosition,
  updatePositionBaseSalary,
  generatePayroll,
  paySalary,
  reviewPayrollRequest,
  createExpense,
  setExpenseBudget,
  givePenalty,
  reducePenalty,
  reviewPenalty,
  grantPremium,
  revokePremium,
  distributeCoins,
];
