/**
 * MUHRLANGAN OYLIKNI QAYTA HISOBLASH — "Qayta hisoblash" tugmasi.
 *
 * Muammo: majburiyat muhrlangandan keyin xodimning shartnomasi o'zgarsa
 * (soatbaydan fiksaga o'tdi, maosh oshdi) yoki ushlab qolish bekor qilinsa,
 * vedomost va o'qituvchi profili (jonli hisob) yangi summani, moliya esa eski
 * muhrni ko'rsatardi. To'lanmagan qatorni avtomat passlar o'zi tuzatadi,
 * lekin BIR SO'M TO'LANGAN qator qulflanadi — yagona yo'l to'lovni bekor
 * qilib qayta kiritish edi (kassada teskari qator, yangi chek raqami).
 *
 * Bu yerda qator O'SHA JOYIDA amaldagi qoidadan qayta yoziladi:
 *   - to'lov cheki, taqsimot va kassa TEGILMAYDI — faqat summa va holat;
 *   - summa `payrollEngine` dan (vedomost va shakllantirish bilan AYNI).
 *
 * Himoya (biznes qarori, 2026-09-18):
 *   ⚠️ Yangi summa TO'LANGANIDAN KAM bo'lsa — yozilmaydi: ortiqcha to'lov
 *      paydo bo'lardi (`overpaid`).
 *   ⚠️ OCHIQ OYDA soatbay qismi bor oylikning lavozim maoshi va dars soati
 *      TEGILMAYDI (`hoursPending`): fakt faqat o'tgan kunlar uchun bor, oy
 *      o'rtasida yozilsa hali o'tilmagan darslar pulga aylanardi
 *      (`finance.md` §10). Bunday qatorda faqat tyutor, to'xtatish va ushlab
 *      qolish yangilanadi — `resyncSealedEntries` bilan AYNI hisob.
 *   ⚠️ Joriy qoidada oylik bo'lmasa — tegilmaydi (`noSalary`): nolga
 *      tushirish emas, bekor qilish kerak.
 *   - Arxivlangan xodimga tegilmaydi (unga majburiyat yozilmaydi).
 *   - Sabab majburiy, har qator audit'ga (`entry.recalc`).
 *
 * Har qator ALOHIDA tranzaksiyada va compare-and-swap bilan: oraliqda to'lov
 * tushgan yoki summa o'zgargan qator yozilmaydi (`conflicts`), qolganlari
 * baribir o'tadi. To'lov ham o'z CAS ida `amount` ni tekshiradi — poyga
 * ortiqcha to'lov bilan emas, `ConflictError` bilan tugaydi.
 */

const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const { BadRequestError } = require("../utils/errors");
const {
  currentMonthKey,
  parseMonthKey,
  formatMonthKey,
} = require("../helpers/month.helpers");
const { Decimal, formatAmount } = require("../helpers/money.helpers");
const { resolveSalariesForMonth, TYPE_LABELS } = require("./staffSalary.service");
const payrollEngine = require("./payrollEngine.service");
const { recomputeSealedEntry, loadResyncSources } = require("./payrollDeduction.service");
const payrollAudit = require("./payrollAudit.service");
const { PAYROLL_USER_SELECT } = require("./payroll.service");

const MAX_ENTRY_IDS = 500;

const BLOCK_LABELS = {
  overpaid: "To'langan pul yangi summadan ko'p — summa o'zgarmaydi",
  noSalary: "Joriy shartnomada bu oy uchun oylik yo'q — kerak bo'lsa majburiyatni bekor qiling",
};

// Qator "o'zgardi" deb shular bo'yicha topiladi. Tafsilot (breakdown) JSON
// solishtirilmaydi: eski kod versiyasida muhrlangan qatorda kalitlar boshqacha
// bo'lishi mumkin va ro'yxat summasi o'zgarmagan "o'zgarish"lar bilan to'lardi.
// Yozishda esa tafsilot ham yangilanadi.
const MONEY_FIELDS = [
  "amount",
  "fixedAmount",
  "kpiAmount",
  "allowanceAmount",
  "suspendedAmount",
  "deductionAmount",
  "lessonHours",
  "perHourRate",
];

const statusFor = (amount, paidAmount) => {
  if (amount.lessThanOrEqualTo(0) || paidAmount.greaterThanOrEqualTo(amount)) return "paid";
  return paidAmount.greaterThan(0) ? "partial" : "unpaid";
};

const staffNameOf = (user, snapshot) =>
  (user
    ? `${user.firstName ?? ""} ${user.lastName ?? ""}`
    : `${snapshot?.firstName ?? ""} ${snapshot?.lastName ?? ""}`
  ).trim() || "Noma'lum";

/** Qatorning ekranda ko'rsatiladigan tarkibi (oldin / keyin). */
const summaryOf = (row) => ({
  amount: formatAmount(row.amount),
  // "Oylik" ustuni: lavozim maoshi + dars soati puli
  baseAmount: formatAmount(new Decimal(row.fixedAmount ?? 0).plus(row.kpiAmount ?? 0)),
  allowanceAmount: formatAmount(row.allowanceAmount ?? 0),
  suspendedAmount: formatAmount(row.suspendedAmount ?? 0),
  deductionAmount: formatAmount(row.deductionAmount ?? 0),
  lessonHours: Number(row.lessonHours ?? 0),
  kpiAmount: formatAmount(row.kpiAmount ?? 0),
  categoryName: row.categoryName ?? "",
  salaryTypeLabel: TYPE_LABELS[row.salaryType] ?? row.salaryType ?? "",
});

/** Qatorning yangi qiymatlari amaldagisidan farq qiladimi. */
const differs = (entry, data) =>
  MONEY_FIELDS.some(
    (key) => key in data && !new Decimal(entry[key] ?? 0).equals(new Decimal(data[key] ?? 0)),
  ) ||
  ("salaryType" in data && data.salaryType !== entry.salaryType);

/**
 * TO'LIQ qayta hisob — amaldagi qoidadan, shakllantirish (`generateForMonth`)
 * yozadigan AYNI maydonlar.
 */
const fullData = (c) => ({
  amount: c.amount,
  fixedAmount: c.fixedAmount,
  allowanceAmount: c.allowanceAmount,
  allowanceBreakdown: c.allowanceBreakdown,
  suspendedAmount: c.suspendedAmount,
  suspensionBreakdown: c.suspensionBreakdown,
  deductionAmount: c.deductionAmount,
  deductionBreakdown: c.deductionBreakdown,
  kpiAmount: c.kpiAmount,
  lessonHours: c.lessonHours,
  perHourRate: c.perHourRate,
  categoryName: c.categoryName,
  positionName: c.positionName,
  departmentName: c.departmentName,
  salaryType: c.salaryType,
});

/**
 * Bitta qator uchun reja (sof, DB'siz): nima yoziladi yoki nega yozilmaydi.
 *
 * @returns {null | { status: "changed"|"blocked", reason, hoursPending, data, amount }}
 *   null — qator amaldagi qoida bilan allaqachon bir xil. `data` — yangi
 *   qiymatlar (bloklanganda ham, oynada "nima bo'lardi" ko'rinsin).
 */
const planEntry = (entry, c, sources, monthOpen) => {
  if (!c || c.grossAmount.lessThanOrEqualTo(0)) {
    return { status: "blocked", reason: "noSalary", hoursPending: false, data: null, amount: null };
  }

  // Soatbay qismi bor oylik ochiq oyda — lavozim maoshi va soat muhrdagicha
  const hoursPending = monthOpen && c.perHourRate.greaterThan(0);
  let data;
  if (hoursPending) {
    const next = recomputeSealedEntry(entry, sources);
    if (!next.changed) return null;
    const { status: _status, ...rest } = next.data;
    data = rest;
  } else {
    data = fullData(c);
  }

  if (!differs(entry, data)) return null;

  const amount = data.amount;
  const paid = new Decimal(entry.paidAmount);
  if (amount.lessThan(paid)) {
    return { status: "blocked", reason: "overpaid", hoursPending, data, amount };
  }

  const status = statusFor(amount, paid);
  return {
    status: "changed",
    reason: null,
    hoursPending,
    amount,
    data: {
      ...data,
      status,
      // `salaryPayment` bilan AYNI qoida: to'liq to'lanmagan qatorda sana yo'q
      paidAt: status === "paid" ? entry.paidAt : null,
    },
  };
};

const parseEntryIds = (value) => {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new BadRequestError("Majburiyatlar ro'yxati noto'g'ri");
  const ids = [...new Set(value.map((id) => String(id).trim()).filter(Boolean))];
  if (ids.length === 0) throw new BadRequestError("Majburiyat tanlanmagan");
  if (ids.length > MAX_ENTRY_IDS) {
    throw new BadRequestError(`Bir amalda ko'pi bilan ${MAX_ENTRY_IDS} ta majburiyat`);
  }
  return ids;
};

/**
 * Oy (yoki tanlangan qatorlar) bo'yicha qayta hisoblash.
 *
 * `dryRun: true` — faqat ro'yxat (oynadagi "eski → yangi"), hech narsa
 * yozilmaydi. Aks holda `changed` qatorlar yoziladi.
 *
 * @param {object} input - { month, entryIds?, reason?, dryRun? }
 * @param {string|null} actorId
 */
const recalcEntries = async (input = {}, actorId = null) => {
  const month = parseMonthKey(input.month, "Oy");
  const current = currentMonthKey();
  if (month > current) {
    throw new BadRequestError("Kelajakdagi oy uchun oylik qayta hisoblanmaydi");
  }
  const entryIds = parseEntryIds(input.entryIds);
  const dryRun = input.dryRun === true;

  const reason = String(input.reason ?? "").trim();
  if (!dryRun && !reason) throw new BadRequestError("Qayta hisoblash sababi majburiy");
  if (reason.length > 200) throw new BadRequestError("Sabab 200 belgidan oshmasin");

  const entries = await prisma.payrollEntry.findMany({
    where: {
      month,
      status: { not: "cancelled" },
      ...(entryIds ? { id: { in: entryIds } } : {}),
    },
    orderBy: [{ month: "asc" }, { id: "asc" }],
  });

  const result = {
    month,
    monthLabel: formatMonthKey(month),
    dryRun,
    items: [],
    totals: {
      entries: entries.length,
      changed: 0,
      blocked: 0,
      same: 0,
      archived: 0,
      beforeAmount: "0.00",
      afterAmount: "0.00",
      diffAmount: "0.00",
    },
    updated: 0,
    conflicts: 0,
  };
  if (entries.length === 0) return result;

  const staffIds = [...new Set(entries.map((e) => e.staffId))];
  const [users, salaryRules, sources] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: staffIds } }, select: PAYROLL_USER_SELECT }),
    resolveSalariesForMonth(month),
    loadResyncSources(month, staffIds),
  ]);
  const userMap = new Map(users.map((u) => [u.id, u]));

  // Arxivlangan xodimga majburiyat yozilmaydi — qayta hisob ham yo'q
  const active = users.filter((u) => !u.isArchived);
  const ctx = await payrollEngine.loadContext(month, active, { salaryRules });
  const monthOpen = month >= current;

  const plans = [];
  let before = new Decimal(0);
  let after = new Decimal(0);

  for (const entry of entries) {
    const user = userMap.get(entry.staffId);
    if (!user || user.isArchived) {
      result.totals.archived += 1;
      continue;
    }

    const c = payrollEngine.computeForStaff(user, month, ctx);
    const plan = planEntry(entry, c, sources.forStaff(entry.staffId), monthOpen);
    if (!plan) {
      result.totals.same += 1;
      continue;
    }

    const afterSummary = plan.data ? summaryOf({ ...entry, ...plan.data }) : null;

    result.items.push({
      entryId: entry.id,
      staffId: entry.staffId,
      staffName: staffNameOf(user, entry.staffSnapshot),
      roleLabel: user.role ?? entry.staffSnapshot?.role ?? null,
      status: plan.status,
      reason: plan.reason,
      reasonLabel: plan.reason ? BLOCK_LABELS[plan.reason] : null,
      hoursPending: plan.hoursPending,
      paidAmount: formatAmount(entry.paidAmount),
      before: summaryOf(entry),
      after: afterSummary,
      diffAmount: plan.amount ? formatAmount(plan.amount.minus(entry.amount)) : null,
    });

    if (plan.status === "changed") {
      result.totals.changed += 1;
      before = before.plus(entry.amount);
      after = after.plus(plan.amount);
      plans.push({ entry, plan, user });
    } else {
      result.totals.blocked += 1;
    }
  }

  result.items.sort(
    (a, b) =>
      (a.status === b.status ? 0 : a.status === "changed" ? -1 : 1) ||
      a.staffName.localeCompare(b.staffName),
  );
  result.totals.beforeAmount = formatAmount(before);
  result.totals.afterAmount = formatAmount(after);
  result.totals.diffAmount = formatAmount(after.minus(before));

  if (dryRun || plans.length === 0) return result;

  // ── Yozish: har qator alohida, compare-and-swap ──
  for (const { entry, plan, user } of plans) {
    const written = await prisma.$transaction(async (tx) => {
      const updated = await tx.payrollEntry.updateMany({
        where: {
          id: entry.id,
          amount: entry.amount,
          paidAmount: entry.paidAmount,
          status: entry.status,
        },
        data: plan.data,
      });
      if (updated.count !== 1) return false;

      await payrollAudit.record(
        {
          actorId,
          action: "entry.recalc",
          targetType: "payrollEntry",
          targetId: entry.id,
          summary:
            `${staffNameOf(user, entry.staffSnapshot)} — ${formatMonthKey(month)} oyligi qayta ` +
            `hisoblandi: ${formatAmount(entry.amount)} → ${formatAmount(plan.amount)}. Sabab: ${reason}`,
          oldValue: { ...summaryOf(entry), paidAmount: formatAmount(entry.paidAmount), status: entry.status },
          newValue: { ...summaryOf({ ...entry, ...plan.data }), status: plan.data.status, reason },
        },
        tx,
      );
      return true;
    });

    if (written) result.updated += 1;
    else result.conflicts += 1;
  }

  logger.warn(
    `[payroll] ${formatMonthKey(month)}: ${result.updated} ta oylik qayta hisoblandi ` +
      `(${result.totals.beforeAmount} → ${result.totals.afterAmount}), ` +
      `conflicts=${result.conflicts} actor=${actorId} sabab="${reason}"`,
  );

  return result;
};

module.exports = {
  recalcEntries,
};
