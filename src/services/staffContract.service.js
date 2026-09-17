/**
 * SHARTNOMA SHARTI — vedomostdan TO'G'RIDAN-TO'G'RI oylik yozish.
 *
 * Bitta o'qituvchining oyligi uch joyga tarqalgan:
 *   · `StaffSalary`            — fiksa, qo'lda soat narxi, ustamalar (DAVR bilan);
 *   · `User.salaryCategoryId`  — malaka toifasi (soat narxi katalogdan, DAVRSIZ);
 *   · `User.positionId`        — lavozim maoshi ("Struktura" bo'limida).
 *
 * Ilgari ularni to'g'rilash uchun uch xil ekranga kirish kerak edi. Bu
 * service ikkalasini (qoida + toifa) BITTA tranzaksiyada yozadi va
 * vedomostdagi "Shartnoma sharti" oynasi shu yerdan o'qiydi.
 *
 * ⚠️ PUL FORMULASI BU YERDA YOZILMAYDI. Jonli hisob ham `payrollEngine`
 * dan o'tadi (qoralama qoida va toifa bilan): oynada ko'ringan raqam
 * vedomost va muhrlangan majburiyat bilan bir xil bo'lishi SHART.
 *
 * ⚠️ OLDINDAN KO'RISH VA SAQLASH BITTA REJADAN O'QIYDI (`planRuleChange`).
 * Ikkita mustaqil shart bo'lsa, oynada "qoida yangilanadi" deb yozilib,
 * aslida yangi davr ochilib qolardi.
 *
 * ⚠️ MUHRLANGAN MAJBURIYATGA TEGILMAYDI (`finance.md` §10). O'zgarish faqat
 * hali shakllantirilmagan oylarga amal qiladi; shakllanganlari ro'yxat
 * bilan ogohlantiriladi.
 */

const prisma = require("../config/prisma");
const { ROLES } = require("../utils/constants");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const {
  parseMonthKey,
  currentMonthKey,
  prevMonth,
  formatMonthKey,
  formatMonthRange,
  periodCovers,
  coveringMonthWhere,
} = require("../helpers/month.helpers");
const { Decimal, formatAmount, parseAmount } = require("../helpers/money.helpers");
const { normalizeAllowances } = require("../helpers/salaryRules.helpers");
const { TYPE_LABELS, deriveSalaryType } = require("./staffSalary.service");
const { loadContext, computeForStaff } = require("./payrollEngine.service");
const { computeLessonHoursForMonth } = require("./lessonHours.service");
const payrollAudit = require("./payrollAudit.service");

/** Soat narxi qayerdan olinadi. */
const RATE_SOURCES = ["none", "category", "manual"];

const STAFF_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  role: true,
  isArchived: true,
  positionId: true,
  salaryCategoryId: true,
};

const fullName = (person) => `${person.firstName} ${person.lastName ?? ""}`.trim();

/** Summani matnga ("5 000 000") — `Intl` siz, har muhitda bir xil. */
const groupAmount = (value) =>
  new Decimal(value ?? 0)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toFixed(0)
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");

const loadStaff = async (staffId) => {
  const staff = await prisma.user.findUnique({ where: { id: staffId }, select: STAFF_SELECT });
  if (!staff) throw new NotFoundError("Xodim topilmadi");
  if (staff.role === ROLES.STUDENT) {
    throw new BadRequestError("O'quvchiga oylik biriktirib bo'lmaydi");
  }
  return staff;
};

const parseMonth = (value) =>
  value == null || value === "" ? currentMonthKey() : parseMonthKey(value, "Oy");

/**
 * Formadan kelgan qoralamani o'qiydi va tekshiradi.
 *
 * ⚠️ ARXIVLANGAN TOIFA faqat YANGI tanlovda rad etiladi. Hozir biriktirilgan
 * toifa keyin arxivlangan bo'lsa, fiksani o'zgartirish uchun ham toifani
 * almashtirishga majbur qilinmaydi.
 *
 * @param {object} data - { month, fixedAmount, rateSource, categoryId, perHourRate, allowances, note }
 * @param {object} staff - `STAFF_SELECT` shaklida
 */
const parseDraft = async (data = {}, staff) => {
  const month = parseMonthKey(data.month, "Qaysi oydan");

  const fixedAmount =
    data.fixedAmount == null || data.fixedAmount === ""
      ? new Decimal(0)
      : parseAmount(data.fixedAmount, "Fiksa oylik");

  const rateSource = data.rateSource ?? "none";
  if (!RATE_SOURCES.includes(rateSource)) {
    throw new BadRequestError("Soat narxi manbai noto'g'ri");
  }

  let category = null;
  if (rateSource === "category") {
    if (!data.categoryId) throw new BadRequestError("Toifa tanlanmagan");
    category = await prisma.salaryCategory.findUnique({ where: { id: data.categoryId } });
    if (!category) throw new NotFoundError("Toifa topilmadi");
    if (category.isArchived && category.id !== staff.salaryCategoryId) {
      throw new BadRequestError("Toifa arxivlangan");
    }
  }

  let perHourRate = new Decimal(0);
  if (rateSource === "manual") {
    perHourRate = parseAmount(data.perHourRate, "1 soat narxi");
    if (!perHourRate.greaterThan(0)) {
      throw new BadRequestError("1 soat narxi noldan katta bo'lishi kerak");
    }
  }

  return {
    month,
    fixedAmount,
    rateSource,
    category,
    perHourRate,
    allowances: normalizeAllowances(data.allowances),
    note: typeof data.note === "string" ? data.note.trim().slice(0, 500) : "",
  };
};

/** Qoralama `StaffSalary` qatorini talab qiladimi (toifa-faqat shart — yo'q). */
const needsRule = (draft) =>
  draft.fixedAmount.greaterThan(0) ||
  draft.perHourRate.greaterThan(0) ||
  draft.allowances.length > 0;

/**
 * Qoralamadan `StaffSalary` maydonlari.
 *
 * ⚠️ `categoryId` HAR DOIM null. Dvigatel toifani faqat
 * `User.salaryCategoryId` dan o'qiydi; qoidada ham saqlansa, ikki manba
 * bir-biridan ajrab ketib, "formada toifa bor, oylikda yo'q" holati chiqardi.
 */
const buildRuleData = (draft) => ({
  type: deriveSalaryType(
    draft.fixedAmount,
    Boolean(draft.category) || draft.perHourRate.greaterThan(0),
  ),
  fixedAmount: draft.fixedAmount,
  perHourRate: draft.perHourRate,
  categoryId: null,
  allowances: draft.allowances,
  note: draft.note,
});

/** Ustamalar ro'yxatini taqqoslash uchun barqaror kalit. */
const allowancesKey = (list) =>
  JSON.stringify(
    (Array.isArray(list) ? list : []).map((a) => [a.label, a.type, Number(a.value)]),
  );

const sameTerms = (row, ruleData) =>
  new Decimal(row.fixedAmount).equals(ruleData.fixedAmount) &&
  new Decimal(row.perHourRate).equals(ruleData.perHourRate) &&
  (row.categoryId ?? null) === ruleData.categoryId &&
  allowancesKey(row.allowances) === allowancesKey(ruleData.allowances);

/**
 * DAVR REJASI — qoida qatorlariga nima qilinadi.
 *
 *   · shart o'zgarmagan              → hech narsa (yoki faqat izoh);
 *   · amaldagi qoida SHU oydan boshlangan → o'sha qator yangilanadi
 *                                        (shart bo'sh bo'lsa o'chiriladi);
 *   · amaldagi qoida OLDINROQ boshlangan  → u oldingi oyda YOPILADI va yangi
 *                                        davr ochiladi: o'tgan oylar tarixi
 *                                        eski summada qoladi;
 *   · qoida yo'q                     → yangi davr, keyingi qoidagacha.
 *
 * ⚠️ Kesishuv strukturaviy imkonsiz: yangi davr yo yopilgan qoidaning
 * o'rnini egallaydi, yo keyingi qoida boshlanishidan oldin tugaydi.
 *
 * @param {Array} rules - xodimning barcha qoidalari (`startMonth asc`)
 * @param {number} month - qaysi oydan
 * @param {object} ruleData - `buildRuleData` natijasi
 * @param {boolean} needed - `needsRule` natijasi
 */
const planRuleChange = (rules, month, ruleData, needed) => {
  // Kesishuv bo'lsa eng KECH boshlangani yutadi (tarif doktrinasi)
  const covering = [...rules].reverse().find((r) => periodCovers(r, month)) ?? null;
  const next = rules.find((r) => r.startMonth > month) ?? null;

  if (covering && sameTerms(covering, ruleData)) {
    return {
      kind: covering.note === ruleData.note ? "none" : "note",
      covering,
      create: null,
    };
  }

  if (covering && covering.startMonth === month) {
    return { kind: needed ? "update" : "delete", covering, create: null };
  }

  if (covering) {
    return {
      kind: needed ? "split" : "close",
      covering,
      closeAt: prevMonth(month),
      create: needed ? { startMonth: month, endMonth: covering.endMonth } : null,
    };
  }

  if (!needed) return { kind: "none", covering: null, create: null };

  return {
    kind: "create",
    covering: null,
    create: {
      startMonth: month,
      endMonth: next ? prevMonth(next.startMonth) : null,
    },
  };
};

/** Rejaning odam o'qiydigan matni (sana matni serverda — `dates.md` §5.3). */
const describePlan = (plan) => {
  const range = plan.covering
    ? formatMonthRange(plan.covering.startMonth, plan.covering.endMonth)
    : null;

  switch (plan.kind) {
    case "note":
      return "Faqat izoh yangilanadi";
    case "update":
      return `Amaldagi qoida (${range}) yangilanadi`;
    case "delete":
      return `Qoida (${range}) olib tashlanadi`;
    case "split":
      return (
        `Eski shart ${formatMonthKey(plan.closeAt)} da yopiladi, yangisi ` +
        `${formatMonthRange(plan.create.startMonth, plan.create.endMonth)}`
      );
    case "close":
      return `Oylik qoidasi ${formatMonthKey(plan.closeAt)} da yopiladi`;
    case "create":
      return `Yangi shart: ${formatMonthRange(plan.create.startMonth, plan.create.endMonth)}`;
    default:
      return null;
  }
};

/** Qoralamaning qisqa matni — audit uchun. */
const describeDraft = (draft) => {
  const parts = [];
  if (draft.fixedAmount.greaterThan(0)) parts.push(`fiksa ${groupAmount(draft.fixedAmount)} so'm`);
  if (draft.category) parts.push(`toifa "${draft.category.name}"`);
  if (draft.perHourRate.greaterThan(0)) {
    parts.push(`soatiga ${groupAmount(draft.perHourRate)} so'm`);
  }
  if (draft.allowances.length) parts.push(`${draft.allowances.length} ta ustama`);
  return parts.length ? parts.join(" + ") : "oylik olib tashlandi";
};

/**
 * Qoralama qo'llangandagi xodim — dvigatel uchun.
 *
 * ⚠️ Toifa tanlansa LAVOZIM olib tashlanadi: "lavozim va toifa birga
 * bo'lmaydi" (`department.service.js` → `assignStaff`). Oyna buni oldindan
 * ogohlantiradi.
 */
const applyDraftToStaff = (staff, draft) => ({
  ...staff,
  salaryCategoryId: draft.category?.id ?? null,
  positionId: draft.category ? null : staff.positionId,
});

const snapshotRule = (row) =>
  row
    ? {
        id: row.id,
        fixedAmount: formatAmount(row.fixedAmount),
        perHourRate: formatAmount(row.perHourRate),
        allowances: row.allowances,
        startMonth: row.startMonth,
        endMonth: row.endMonth,
      }
    : null;

/** Shu oydan keyingi (shu oy ham) muhrlangan majburiyatlar. */
const loadSealedMonths = async (staffId, month) => {
  const rows = await prisma.payrollEntry.findMany({
    where: { staffId, month: { gte: month }, status: { not: "cancelled" } },
    select: { month: true, status: true },
    orderBy: { month: "asc" },
  });
  return rows.map((row) => ({
    month: row.month,
    monthLabel: formatMonthKey(row.month),
    status: row.status,
  }));
};

/**
 * JORIY SHARTNOMA SHARTI — forma shu qiymatlar bilan ochiladi.
 *
 * @param {string} staffId
 * @param {*} monthInput - YYYYMM (bo'sh → joriy oy)
 */
const getContract = async (staffId, monthInput) => {
  const month = parseMonth(monthInput);
  const staff = await loadStaff(staffId);

  const [rule, position, categories, bonuses] = await Promise.all([
    prisma.staffSalary.findFirst({
      where: { staffId, ...coveringMonthWhere(month) },
      orderBy: { startMonth: "desc" },
    }),
    staff.positionId
      ? prisma.position.findUnique({
          where: { id: staff.positionId },
          select: { id: true, name: true, baseSalary: true },
        })
      : null,
    // Biriktirilgan toifa nofaol/arxivlangan bo'lsa ham ro'yxatda turadi —
    // aks holda tanlov bo'sh ko'rinib, "toifasi yo'q" deb o'qilardi.
    prisma.salaryCategory.findMany({
      where: {
        OR: [
          { isArchived: false, isActive: true },
          ...(staff.salaryCategoryId ? [{ id: staff.salaryCategoryId }] : []),
        ],
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: { department: { select: { name: true } } },
    }),
    prisma.payrollBonus.findMany({
      where: {
        staffId,
        isActive: true,
        startMonth: { lte: month },
        OR: [{ endMonth: null }, { endMonth: { gte: month } }],
      },
      orderBy: { startMonth: "asc" },
    }),
  ]);

  const manualRate = rule ? new Decimal(rule.perHourRate) : new Decimal(0);

  return {
    staffId: staff.id,
    staffName: fullName(staff),
    month,
    monthLabel: formatMonthKey(month),

    // ── Forma qiymatlari ──
    rateSource: staff.salaryCategoryId
      ? "category"
      : manualRate.greaterThan(0)
        ? "manual"
        : "none",
    fixedAmount: rule ? formatAmount(rule.fixedAmount) : null,
    perHourRate: manualRate.greaterThan(0) ? formatAmount(manualRate) : null,
    categoryId: staff.salaryCategoryId,
    allowances: Array.isArray(rule?.allowances) ? rule.allowances : [],
    note: rule?.note ?? "",

    // ── Kontekst (tahrirlanmaydi) ──
    rule: rule
      ? {
          id: rule.id,
          startMonth: rule.startMonth,
          endMonth: rule.endMonth,
          periodLabel: formatMonthRange(rule.startMonth, rule.endMonth),
        }
      : null,
    position: position
      ? { id: position.id, name: position.name, baseSalary: formatAmount(position.baseSalary) }
      : null,
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      perHourRate: formatAmount(c.perHourRate),
      departmentName: c.department?.name ?? "",
      isArchived: c.isArchived || !c.isActive,
    })),
    approvedBonuses: bonuses.map((b) => ({
      id: b.id,
      label: b.label || "Ustama",
      type: b.type,
      value: Number(b.value),
    })),
  };
};

/**
 * JONLI HISOB — qoralama saqlansa shu oyda qancha chiqadi.
 * Hech narsa yozilmaydi.
 *
 * @param {string} staffId
 * @param {object} data - qoralama (`parseDraft`)
 */
const previewContract = async (staffId, data) => {
  const staff = await loadStaff(staffId);
  const draft = await parseDraft(data, staff);
  const { month } = draft;

  const needed = needsRule(draft);
  const ruleData = buildRuleData(draft);
  const user = applyDraftToStaff(staff, draft);

  const [rules, hoursMap, sealedMonths] = await Promise.all([
    prisma.staffSalary.findMany({ where: { staffId }, orderBy: { startMonth: "asc" } }),
    computeLessonHoursForMonth(month, [staff.id]),
    loadSealedMonths(staffId, month),
  ]);

  const salaryRules = new Map(needed ? [[staff.id, { staffId: staff.id, ...ruleData }]] : []);
  const ctx = await loadContext(month, [user], { salaryRules, hoursMap });
  const result = computeForStaff(user, month, ctx);

  const plan = planRuleChange(rules, month, ruleData, needed);
  const categoryChanged = (staff.salaryCategoryId ?? null) !== (draft.category?.id ?? null);
  const positionRemoved = Boolean(draft.category && staff.positionId);

  return {
    month,
    monthLabel: formatMonthKey(month),
    hours: hoursMap.get(staff.id)?.hours ?? 0,

    hasSalary: Boolean(result),
    salaryType: result?.salaryType ?? null,
    salaryTypeLabel: result ? (TYPE_LABELS[result.salaryType] ?? result.salaryType) : null,
    // Lavozim bazasi dvigatel hal qilgani: shaxsiy maosh bo'lsa — u.
    // Oyna lavozim katalogidagi maoshni ko'rsatsa, qatorlar jami bilan
    // mos kelmay qolardi.
    baseAmount: result ? formatAmount(result.baseAmount) : null,
    baseIsCustom: result?.baseIsCustom ?? false,
    fixedAmount: result ? formatAmount(result.fixedAmount) : null,
    perHourRate: result ? formatAmount(result.perHourRate) : null,
    kpiAmount: result ? formatAmount(result.kpiAmount) : null,
    allowanceAmount: result ? formatAmount(result.allowanceAmount) : null,
    allowanceBreakdown: result?.allowanceBreakdown ?? [],
    // ⚠️ `amount` — USHLAB QOLISHDAN KEYIN. Ushlab qolish qatorlari
    // yuborilmasa oynadagi qatorlar yig'indisi (yalpi) jamidan katta
    // chiqib, "jami noto'g'ri" bo'lib ko'rinardi.
    grossAmount: result ? formatAmount(result.grossAmount) : null,
    // To'xtatilgan qismlar ham `amount` dan ayirilgan — oynada qatorlar
    // yig'indisi jami bilan mos kelishi uchun yuboriladi
    suspendedAmount: result ? formatAmount(result.suspendedAmount) : null,
    suspensionBreakdown: result?.suspensionBreakdown ?? [],
    payableGrossAmount: result ? formatAmount(result.payableGrossAmount) : null,
    deductionAmount: result ? formatAmount(result.deductionAmount) : null,
    deductionBreakdown: result?.deductionBreakdown ?? [],
    amount: result ? formatAmount(result.amount) : null,
    positionName: result?.positionName || null,

    // ── Nima yoziladi ──
    // "none" — saqlash tugmasi o'chadi: yozadigan narsa yo'q
    changeKind:
      plan.kind !== "none" ? plan.kind : categoryChanged || positionRemoved ? "category" : "none",
    effectLabel: describePlan(plan),
    categoryChanged,
    // Lavozim maoshi yo'qoladi — oynada ogohlantirish sharti
    positionRemoved,
    sealedMonths,
  };
};

/**
 * SAQLASH — qoida va toifa BITTA tranzaksiyada.
 *
 * @param {string} staffId
 * @param {object} data - qoralama
 * @param {string} actorId
 */
const saveContract = async (staffId, data, actorId) => {
  const staff = await loadStaff(staffId);
  const draft = await parseDraft(data, staff);
  const { month } = draft;

  const needed = needsRule(draft);
  const ruleData = buildRuleData(draft);
  const nextCategoryId = draft.category?.id ?? null;

  await prisma.$transaction(async (tx) => {
    const rules = await tx.staffSalary.findMany({
      where: { staffId },
      orderBy: { startMonth: "asc" },
    });
    const plan = planRuleChange(rules, month, ruleData, needed);

    // 1 ── Toifa va lavozim (davrsiz, foydalanuvchi darajasida)
    const userPatch = {};
    if ((staff.salaryCategoryId ?? null) !== nextCategoryId) {
      userPatch.salaryCategoryId = nextCategoryId;
    }
    if (nextCategoryId && staff.positionId) {
      userPatch.positionId = null;
      // Shaxsiy maosh lavozimga tegishli — lavozim bilan birga ketadi
      userPatch.customBaseSalary = null;
    }

    if (Object.keys(userPatch).length) {
      await tx.user.update({ where: { id: staffId }, data: userPatch });
    }

    // 2 ── Qoida davri
    switch (plan.kind) {
      case "none":
      case "note":
        // Shart o'zgarmagan, lekin `type` hosila maydon: faqat toifa
        // qo'shilsa/olinsa ham "Fiksa" ↔ "Fiksa + KPI" o'zgaradi. Bu yangi
        // davr ochishga sabab EMAS — o'sha qatorda to'g'rilanadi.
        if (
          plan.covering &&
          (plan.covering.note !== ruleData.note || plan.covering.type !== ruleData.type)
        ) {
          await tx.staffSalary.update({
            where: { id: plan.covering.id },
            data: { note: ruleData.note, type: ruleData.type },
          });
        }
        break;
      case "update":
        await tx.staffSalary.update({ where: { id: plan.covering.id }, data: ruleData });
        break;
      case "delete":
        // Xavfsiz: `PayrollEntry` qoidaga ishora qilmaydi, summa ichida
        // muhrlangan (`finance.md` §10).
        await tx.staffSalary.delete({ where: { id: plan.covering.id } });
        break;
      case "split":
      case "close":
        await tx.staffSalary.update({
          where: { id: plan.covering.id },
          data: { endMonth: plan.closeAt },
        });
        if (plan.create) {
          await tx.staffSalary.create({
            data: { staffId, ...ruleData, ...plan.create, createdBy: actorId },
          });
        }
        break;
      case "create":
        await tx.staffSalary.create({
          data: { staffId, ...ruleData, ...plan.create, createdBy: actorId },
        });
        break;
      default:
        break;
    }

    if (plan.kind === "none" && !Object.keys(userPatch).length) return;

    await payrollAudit.record(
      {
        actorId,
        action: "salary.contract",
        targetType: "user",
        targetId: staffId,
        summary: `${fullName(staff)} — ${formatMonthKey(month)} dan: ${describeDraft(draft)}`,
        oldValue: {
          rule: snapshotRule(plan.covering),
          salaryCategoryId: staff.salaryCategoryId,
          positionId: staff.positionId,
        },
        newValue: {
          plan: plan.kind,
          fixedAmount: formatAmount(draft.fixedAmount),
          perHourRate: formatAmount(draft.perHourRate),
          allowances: draft.allowances,
          salaryCategoryId: nextCategoryId,
          positionId: nextCategoryId ? null : staff.positionId,
          period: plan.create ?? null,
        },
      },
      tx,
    );
  });

  // Oylik paydo bo'lgan bo'lishi mumkin — "hammaga" ushlab qolishlar yoyiladi
  await require("./payrollDeduction.service").extendAllScopeDeductionsSafe([staffId]);

  return getContract(staffId, month);
};

module.exports = {
  RATE_SOURCES,
  planRuleChange,
  getContract,
  previewContract,
  saveContract,
};
