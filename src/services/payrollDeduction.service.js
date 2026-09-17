/**
 * OYLIKDAN USHLAB QOLISH.
 *
 * Moliya → "Ushlab qolish": boshliq xodimlarni (hammasi / tanlab / bitta)
 * belgilaydi va so'mda, foizda yoki dars soatida qancha ushlab qolishni yozadi.
 *
 * ── QAYERDA HISOBLANADI ─────────────────────
 *
 * ⚠️ FORMULA BU YERDA YOZILMAYDI. Summa `payrollEngine.computeForStaff` da
 * (`helpers/salaryRules.helpers.js` → `computeDeductions`): vedomost, oylik
 * shakllantirish, dashboard va bu ekrandagi oldindan hisob bitta raqamni
 * ko'rishi SHART (`finance.md` §10 — formula bitta joyda).
 *
 *   yalpi  = fiksa + soat + ustamalar
 *   ushlab = Σ (percent → yalpi × foiz, fixed → summa, hours → soat × soat
 *            narxi), yalpidan oshmaydi
 *   oylik  = yalpi − ushlab
 *
 * ── MUHRLANGAN OYLIK ────────────────────────
 *
 * ⚠️ BIR SO'M HAM TO'LANMAGAN muhrlangan oylik qayta hisoblanadi (biznes
 * qarori): fiksa oylik oy boshida muhrlanadi, busiz joriy oyga ushlab qolish
 * deyarli hech kimga ta'sir qilmasdi. Qoidalar:
 *   · faqat `paidAmount = 0` qator — to'lov tushgani o'zgarmaydi
 *     ("qulflangan" bo'lib hisobotda qaytadi);
 *   · YALPI QISMLAR (fiksa/soat/ustama) TEGILMAYDI — faqat ushlab qolish va
 *     `amount`. Aks holda oradagi qoida o'zgarishi jimgina muhrga kirardi;
 *   · yozuv COMPARE-AND-SWAP (`amount` + `paidAmount` + `status`), to'lov esa
 *     o'z CAS ida `amount` ni ham tekshiradi — poyga ikkala tomonda ham
 *     xato bilan tugaydi, ortiqcha to'lov bilan emas.
 *
 * ── "HAMMASI" KEYIN KELGANLARGA HAM ─────────
 *
 * ⚠️ "Hammasi" tanlab yozilgan guruh (`appliesToAll`) keyin oyligi
 * belgilangan xodimga ham yoyiladi (biznes qarori): "hammadan 10%" — siyosat,
 * saqlash paytidagi ro'yxat emas. Yoyish ham ALOHIDA QATOR yozadi (registr,
 * bekor qilish va xodimning o'z ekrani qator bilan ishlaydi). Chaqiriladigan
 * joylar: lavozim/toifa biriktirish, oylik qoidasi, shartnoma sharti,
 * toifa zayavkasini tasdiqlash va — zaxira sifatida — oylik shakllantirish.
 */

const prisma = require("../config/prisma");
const { ROLES } = require("../utils/constants");
const { BadRequestError, NotFoundError, ConflictError } = require("../utils/errors");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");
const { generateId } = require("../utils/idGenerator");
const {
  currentMonthKey,
  parseMonthKey,
  formatMonthKey,
  formatMonthRange,
  nextMonth,
} = require("../helpers/month.helpers");
const { Decimal, formatAmount, parseAmount, sumAmounts } = require("../helpers/money.helpers");
const { formatDateTimeUz } = require("../helpers/date.helpers");
const { computeDeductions } = require("../helpers/salaryRules.helpers");
const { resolveSalariesForMonth } = require("./staffSalary.service");
const { loadContext, computeForStaff } = require("./payrollEngine.service");
const { resolveTutorIdsForMonth } = require("./tutorGroup.service");
const payrollAudit = require("./payrollAudit.service");
const logger = require("../utils/logger");

const TYPES = ["fixed", "percent", "hours"];
/** Bir amalda ushlab qolinadigan dars soati chegarasi (xato kiritishga qarshi). */
const MAX_HOURS = 500;
const MAX_STAFF = 1000;
const REASON_MAX = 200;
const NOTE_MAX = 500;
/** Qoralama ushlab qolishning vaqtinchalik id'si (oldindan hisobda). */
const DRAFT_ID = "draft";

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

const fullName = (person) =>
  person ? `${person.firstName ?? ""} ${person.lastName ?? ""}`.trim() || "Noma'lum" : "Noma'lum";

/** Davr matni: bitta oy → "Sentabr, 2026", aks holda oraliq. */
const periodLabelOf = (startMonth, endMonth) =>
  endMonth === startMonth ? formatMonthKey(startMonth) : formatMonthRange(startMonth, endMonth);

/** Qiymat matni: "10%", "3 soat", "500000.00 so'm". */
const valueLabelOf = (type, value) =>
  type === "percent"
    ? `${Number(value)}%`
    : type === "hours"
      ? `${Number(value)} soat`
      : `${formatAmount(value)} so'm`;

/** `[from, to]` oylar ro'yxati (INKLYUZIV). */
const monthsBetween = (from, to) => {
  const months = [];
  for (let m = from; m <= to; m = nextMonth(m)) months.push(m);
  return months;
};

/**
 * MUHRLANGAN QATOR HOLATI — ushlab qolish unga yetib boradimi.
 *   none   — shu oy hali shakllantirilmagan: jonli hisob, keyin muhrlanadi
 *   resync — muhrlangan, bir so'm ham to'lanmagan: qayta hisoblanadi
 *   locked — to'lov tushgan: O'ZGARMAYDI
 */
const sealStateOf = (entry) => {
  if (!entry || entry.status === "cancelled") return "none";
  return new Decimal(entry.paidAmount).isZero() ? "resync" : "locked";
};

/* ─────────────────────── Qoralama ─────────────────────── */

/**
 * Formadan kelgan qoralamani o'qiydi va tekshiradi.
 *
 * `endMonth`: son → oraliq; `null` → muddatsiz; berilmasa → faqat
 * `startMonth` (bir martalik — eng xavfsiz standart).
 *
 * @param {object} data - { staffIds, scope, type, value, reason, note, startMonth, endMonth }
 */
const parseDraft = (data = {}) => {
  const staffIds = Array.isArray(data.staffIds)
    ? [...new Set(data.staffIds.map((id) => String(id).trim()).filter(Boolean))]
    : [];
  if (staffIds.length === 0) throw new BadRequestError("Kamida bitta xodim tanlang");
  if (staffIds.length > MAX_STAFF) {
    throw new BadRequestError(`Bir amalda ${MAX_STAFF} tadan ortiq xodim tanlab bo'lmaydi`);
  }
  if (staffIds.some((id) => !/^[a-f\d]{24}$/i.test(id))) {
    throw new BadRequestError("Xodim identifikatori noto'g'ri");
  }

  const type = data.type;
  if (!TYPES.includes(type)) {
    throw new BadRequestError("Turi: so'm, foiz yoki dars soati bo'lishi kerak");
  }

  const value = parseAmount(
    data.value,
    type === "percent" ? "Foiz" : type === "hours" ? "Dars soati" : "Summa",
  );
  if (!value.greaterThan(0)) throw new BadRequestError("Qiymat noldan katta bo'lishi kerak");
  if (type === "percent" && value.greaterThan(100)) {
    throw new BadRequestError("Foiz 100 dan oshmasligi kerak");
  }
  // Soat = dars soni — butun son (`helpers/lessonHours.js`: "SOAT = DARS")
  if (type === "hours" && (!value.isInteger() || value.greaterThan(MAX_HOURS))) {
    throw new BadRequestError(`Dars soati 1 dan ${MAX_HOURS} gacha butun son bo'lishi kerak`);
  }

  const reason = typeof data.reason === "string" ? data.reason.trim() : "";
  if (!reason) throw new BadRequestError("Ushlab qolish sababini yozing");
  if (reason.length > REASON_MAX) {
    throw new BadRequestError(`Sabab ${REASON_MAX} belgidan oshmasligi kerak`);
  }

  const note = typeof data.note === "string" ? data.note.trim().slice(0, NOTE_MAX) : "";

  const startMonth = parseMonthKey(data.startMonth, "Qaysi oydan");
  const endMonth =
    data.endMonth === undefined
      ? startMonth
      : data.endMonth === null || data.endMonth === ""
        ? null
        : parseMonthKey(data.endMonth, "Qaysi oygacha");
  if (endMonth != null && endMonth < startMonth) {
    throw new BadRequestError("Tugash oyi boshlanish oyidan oldin bo'lishi mumkin emas");
  }

  // "Hammasi" — keyin oyligi belgilanganlarga ham yoyiladi
  const appliesToAll = data.scope === "all";

  return { staffIds, type, value, reason, note, startMonth, endMonth, appliesToAll };
};

/**
 * Tanlangan xodimlar — hammasi mavjud, o'quvchi emas, arxivlanmagan.
 * ⚠️ Birortasi yaroqsiz bo'lsa BUTUN amal rad etiladi: "30 kishidan
 * ushlab qoldim" deb o'ylagan boshliq 28 tasidan ushlaganini bilmay qolardi.
 */
const loadStaff = async (staffIds) => {
  const users = await prisma.user.findMany({
    where: { id: { in: staffIds } },
    select: STAFF_SELECT,
  });

  if (users.length !== staffIds.length) {
    throw new NotFoundError(`${staffIds.length - users.length} ta xodim topilmadi`);
  }
  if (users.some((u) => u.role === ROLES.STUDENT)) {
    throw new BadRequestError("O'quvchidan oylik ushlab qolib bo'lmaydi");
  }
  const archived = users.filter((u) => u.isArchived);
  if (archived.length) {
    throw new BadRequestError(
      `Arxivlangan xodimdan ushlab qolib bo'lmaydi: ${archived.map(fullName).join(", ")}`,
    );
  }

  return users;
};

/* ─────────────────────── Nomzodlar ─────────────────────── */

/**
 * KIMDAN USHLAB QOLISH MUMKIN — shu oyda oyligi bor xodimlar.
 *
 * Ro'yxat oylik shakllantirish bilan AYNI qoidadan: lavozim, toifa yoki
 * oylik qoidasi bor, arxivlanmagan, o'quvchi emas. Oyligi yo'q odamdan
 * ushlab qolish ma'nosiz — tanlovda umuman ko'rinmaydi.
 *
 * @param {*} monthInput - YYYYMM (bo'sh → joriy oy)
 */
const getCandidates = async (monthInput) => {
  const month = monthInput ? parseMonthKey(monthInput, "Oy") : currentMonthKey();
  const [salaryRules, tutorIds] = await Promise.all([
    resolveSalariesForMonth(month),
    resolveTutorIdsForMonth(month),
  ]);
  const ruleIds = [...salaryRules.keys()];

  const users = await prisma.user.findMany({
    where: {
      isArchived: false,
      role: { not: ROLES.STUDENT },
      OR: [
        { positionId: { not: null } },
        { salaryCategoryId: { not: null } },
        ...(ruleIds.length ? [{ id: { in: ruleIds } }] : []),
        // Faqat tyutor guruhi bor xodim ham oylik oladi (`payrollEngine`)
        ...(tutorIds.length ? [{ id: { in: tutorIds } }] : []),
      ],
    },
    select: STAFF_SELECT,
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });

  const [ctx, entries] = await Promise.all([
    loadContext(month, users, { salaryRules }),
    users.length
      ? prisma.payrollEntry.findMany({
          where: { month, staffId: { in: users.map((u) => u.id) }, status: { not: "cancelled" } },
          select: { staffId: true, status: true, paidAmount: true },
        })
      : [],
  ]);
  const entryMap = new Map(entries.map((e) => [e.staffId, e]));

  const items = [];
  for (const user of users) {
    const c = computeForStaff(user, month, ctx);
    if (!c || c.grossAmount.lessThanOrEqualTo(0)) continue;

    items.push({
      id: user.id,
      fullName: fullName(user),
      username: user.username,
      role: user.role,
      departmentName: c.departmentName || null,
      positionName: c.positionName || null,
      categoryName: c.categoryName || null,
      grossAmount: formatAmount(c.grossAmount),
      deductionAmount: formatAmount(c.deductionAmount),
      amount: formatAmount(c.amount),
      // Dars soati bo'yicha ushlab qolish shu narxdan hisoblanadi (0 — ushlanmaydi)
      perHourRate: formatAmount(c.perHourRate),
      sealState: sealStateOf(entryMap.get(user.id)),
    });
  }

  return { month, monthLabel: formatMonthKey(month), items };
};

/* ─────────────────────── Oldindan hisob ─────────────────────── */

/**
 * JONLI HISOB — qoralama saqlansa `startMonth` da kimdan qancha ushlanadi.
 * Hech narsa yozilmaydi.
 *
 * Qoralama dvigatelga MAVJUD ushlab qolishlardan KEYIN qo'shiladi — saqlangan
 * paytda ham u eng oxirgi yaratilgan bo'ladi, chegara ham xuddi shunday.
 *
 * ⚠️ Muhrlangan oylikda yalpi MUHRDAN olinadi (`resync` bilan AYNI), jonli
 * dvigateldan emas: saqlangandan keyin aynan shu raqam yoziladi.
 */
const previewDeductions = async (data) => {
  const draft = parseDraft(data);
  const users = await loadStaff(draft.staffIds);
  const month = draft.startMonth;

  const [ctx, entries] = await Promise.all([
    loadContext(month, users),
    prisma.payrollEntry.findMany({
      where: { month, staffId: { in: draft.staffIds }, status: { not: "cancelled" } },
    }),
  ]);
  const entryMap = new Map(entries.map((e) => [e.staffId, e]));
  const draftItem = { id: DRAFT_ID, reason: draft.reason, type: draft.type, value: draft.value };

  const items = [];
  let noSalary = 0;

  for (const user of users) {
    const entry = entryMap.get(user.id);
    const sealState = sealStateOf(entry);
    const existing = ctx.deductionMap.get(user.id) || [];

    let gross;
    let perHourRate;
    if (sealState === "none") {
      const c = computeForStaff(user, month, ctx);
      if (!c || c.grossAmount.lessThanOrEqualTo(0)) {
        noSalary += 1;
        continue;
      }
      gross = c.grossAmount;
      perHourRate = c.perHourRate;
    } else {
      gross = sealedGrossOf(entry);
      perHourRate = entry.perHourRate;
    }

    const before = computeDeductions(gross, existing, { perHourRate });
    const after = computeDeductions(gross, [...existing, draftItem], { perHourRate });
    const draftRow = after.breakdown.find((row) => row.id === DRAFT_ID);

    items.push({
      staffId: user.id,
      fullName: fullName(user),
      sealState,
      grossAmount: formatAmount(gross),
      // "locked" — to'lov tushgan muhr o'zgarmaydi, lekin keyingi oylarda
      // qoida ishlaydi: shuning uchun summa ko'rsatiladi, `applies: false` bilan
      applies: sealState !== "locked",
      draftAmount: draftRow.amount,
      capped: draftRow.capped,
      // `hours`: soat narxi va narx yo'qligi (ushlanmaydi)
      perHourRate: formatAmount(perHourRate),
      noRate: Boolean(draftRow.noRate),
      netBefore: formatAmount(gross.minus(before.total)),
      netAfter: formatAmount(gross.minus(after.total)),
    });
  }

  items.sort((a, b) => Number(b.draftAmount) - Number(a.draftAmount) || a.fullName.localeCompare(b.fullName, "uz"));

  const applied = items.filter((row) => row.applies);

  return {
    month,
    monthLabel: formatMonthKey(month),
    periodLabel: draft.endMonth == null
      ? formatMonthRange(draft.startMonth, null)
      : periodLabelOf(draft.startMonth, draft.endMonth),
    totals: {
      staffCount: items.length,
      totalAmount: formatAmount(sumAmounts(applied.map((row) => row.draftAmount))),
      resyncCount: items.filter((row) => row.sealState === "resync").length,
      lockedCount: items.filter((row) => row.sealState === "locked").length,
      cappedCount: items.filter((row) => row.capped && !row.noRate).length,
      noRateCount: items.filter((row) => row.noRate).length,
      noSalaryCount: noSalary,
    },
    items,
  };
};

/* ─────────────────────── Muhrni qayta hisoblash ─────────────────────── */

/** Muhrlangan YALPI — qismlar yig'indisi (ushlab qolishdan oldingi). */
const sealedGrossOf = (entry) =>
  new Decimal(entry.fixedAmount).plus(entry.kpiAmount).plus(entry.allowanceAmount);

const breakdownKey = (list) =>
  JSON.stringify((Array.isArray(list) ? list : []).map((row) => [row.id, row.amount]));

/**
 * TO'LANMAGAN MUHRLANGAN OYLIKNI qayta hisoblaydi — ushlab qolish qo'shilgan
 * yoki bekor qilingandan keyin.
 *
 * Har qator ALOHIDA compare-and-swap: bittasi shu orada to'langan bo'lsa,
 * qolganlari baribir yangilanadi, u esa `conflicts` da qaytadi.
 *
 * @param {string[]} staffIds
 * @param {number[]} months
 * @returns {Promise<{updated: number, locked: Array, conflicts: number}>}
 */
const resyncSealedEntries = async (staffIds, months) => {
  const result = { updated: 0, locked: [], conflicts: 0 };
  const current = currentMonthKey();

  // Kelajak oyda muhr bo'lmaydi (shakllantirish uni rad etadi)
  for (const month of months.filter((m) => m <= current)) {
    const entries = await prisma.payrollEntry.findMany({
      where: { month, staffId: { in: staffIds }, status: { not: "cancelled" } },
      orderBy: [{ month: "asc" }, { id: "asc" }],
    });
    if (entries.length === 0) continue;

    const deductions = await prisma.payrollDeduction.findMany({
      where: {
        staffId: { in: entries.map((e) => e.staffId) },
        status: "active",
        startMonth: { lte: month },
        OR: [{ endMonth: null }, { endMonth: { gte: month } }],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const byStaff = new Map();
    for (const d of deductions) {
      if (!byStaff.has(d.staffId)) byStaff.set(d.staffId, []);
      byStaff.get(d.staffId).push(d);
    }

    for (const entry of entries) {
      const gross = sealedGrossOf(entry);
      const { total, breakdown } = computeDeductions(gross, byStaff.get(entry.staffId) || [], {
        perHourRate: entry.perHourRate,
      });

      const unchanged =
        new Decimal(entry.deductionAmount).equals(total) &&
        breakdownKey(entry.deductionBreakdown) === breakdownKey(breakdown);
      if (unchanged) continue;

      if (sealStateOf(entry) === "locked") {
        result.locked.push({
          staffId: entry.staffId,
          staffName: fullName(entry.staffSnapshot),
          month,
          monthLabel: formatMonthKey(month),
          status: entry.status,
        });
        continue;
      }

      const amount = gross.minus(total);
      const updated = await prisma.payrollEntry.updateMany({
        where: {
          id: entry.id,
          amount: entry.amount,
          paidAmount: 0,
          status: entry.status,
        },
        data: {
          amount,
          deductionAmount: total,
          deductionBreakdown: breakdown,
          // To'liq ushlab qolingan — to'lanadigan narsa yo'q; bekor qilinsa
          // yana qarzga qaytadi
          status: amount.greaterThan(0) ? "unpaid" : "paid",
        },
      });

      if (updated.count === 1) result.updated += 1;
      else result.conflicts += 1;
    }
  }

  return result;
};

/** Qoida davridagi (joriy oygacha) oylar — muhr faqat shularda bo'ladi. */
const affectedMonths = (startMonth, endMonth) => {
  const current = currentMonthKey();
  const to = endMonth == null ? current : Math.min(endMonth, current);
  return startMonth > to ? [] : monthsBetween(startMonth, to);
};

/* ─────────────────────── Yaratish ─────────────────────── */

/**
 * USHLAB QOLISH YOZISH — har tanlangan xodimga alohida qator, bitta guruh.
 *
 * ⚠️ AYNAN TAKROR RAD ETILMAYDI, O'TKAZIB YUBORILADI: shu xodimda xuddi shu
 * sabab, tur, qiymat va davr bilan faol ushlab qolish bo'lsa, u qayta
 * yozilmaydi (ikki marta bosilgan tugma pulni ikki marta ushlamasligi
 * uchun) va javobda ro'yxati qaytadi.
 *
 * @param {object} data - qoralama (`parseDraft`)
 * @param {string} actorId
 */
const createDeductions = async (data, actorId) => {
  const draft = parseDraft(data);
  const users = await loadStaff(draft.staffIds);
  const userMap = new Map(users.map((u) => [u.id, u]));
  const batchId = generateId();

  const created = await prisma.$transaction(async (tx) => {
    const duplicates = await tx.payrollDeduction.findMany({
      where: {
        staffId: { in: draft.staffIds },
        status: "active",
        reason: draft.reason,
        type: draft.type,
        value: draft.value,
        startMonth: draft.startMonth,
        endMonth: draft.endMonth,
      },
      select: { staffId: true },
    });
    const duplicateIds = new Set(duplicates.map((d) => d.staffId));
    const targets = draft.staffIds.filter((id) => !duplicateIds.has(id));

    if (targets.length === 0) {
      throw new ConflictError("Tanlangan xodimlarda bu ushlab qolish allaqachon yozilgan");
    }

    await tx.payrollDeduction.createMany({
      data: targets.map((staffId) => ({
        staffId,
        batchId,
        reason: draft.reason,
        type: draft.type,
        value: draft.value,
        startMonth: draft.startMonth,
        endMonth: draft.endMonth,
        note: draft.note,
        appliesToAll: draft.appliesToAll,
        createdBy: actorId,
      })),
    });

    await payrollAudit.record(
      {
        actorId,
        action: "deduction.create",
        targetType: "deduction",
        targetId: batchId,
        summary:
          `${targets.length} ta xodimdan ushlab qolish: ${draft.reason} — ` +
          `${valueLabelOf(draft.type, draft.value)} ` +
          `(${draft.endMonth == null ? formatMonthRange(draft.startMonth, null) : periodLabelOf(draft.startMonth, draft.endMonth)})`,
        newValue: {
          batchId,
          staffIds: targets,
          type: draft.type,
          value: formatAmount(draft.value),
          startMonth: draft.startMonth,
          endMonth: draft.endMonth,
          appliesToAll: draft.appliesToAll,
        },
      },
      tx,
    );

    return { targets, duplicateIds };
  });

  // ⚠️ TRANZAKSIYADAN TASHQARIDA: har muhr alohida CAS bilan yangilanadi.
  // Bittasi to'lov bilan to'qnashsa, ushlab qolishning o'zi orqaga qaytmaydi
  // — keyingi qayta hisoblashda (bekor qilish/qo'shish) yana urinadi va
  // oylik shakllantirilmagan oylarda dvigatel uni baribir hisobga oladi.
  const resync = await resyncSealedEntries(
    created.targets,
    affectedMonths(draft.startMonth, draft.endMonth),
  );

  // "Hammasi": formadagi ro'yxat shu oyda oyligi > 0 bo'lganlar edi —
  // oyligi bor, lekin shu oyda 0 chiqqanlar ham darhol qo'shiladi
  const extended = draft.appliesToAll
    ? await extendAllScopeDeductionsSafe(null, { batchIds: [batchId] })
    : null;
  if (extended) mergeResync(resync, extended.resync);

  return {
    batchId,
    created: created.targets.length,
    extended: extended?.created ?? 0,
    skippedDuplicates: [...created.duplicateIds].map((id) => fullName(userMap.get(id))),
    resync,
  };
};

/* ─────────────────────── "Hammasi" — yangi xodimlarga ─────────────────────── */

const mergeResync = (into, part) => {
  into.updated += part.updated;
  into.conflicts += part.conflicts;
  into.locked.push(...part.locked);
  return into;
};

/**
 * "HAMMAGA" GURUHLARNI keyin oyligi belgilangan xodimlarga yoyadi.
 *
 * Kimga: arxivlanmagan, o'quvchi emas, oyligi bor (lavozim, toifa yoki
 * guruh davriga tushadigan oylik qoidasi) va shu guruhda HALI QATORI YO'Q.
 *   · qatori BEKOR QILINGAN xodimga qayta yozilmaydi — u admin qarori;
 *   · xuddi shu ushlab qolish (sabab + tur + qiymat + davr) boshqa guruhda
 *     faol bo'lsa ham yozilmaydi — ikki marta ushlanmasin (`createDeductions`
 *     dagi takror qoidasi bilan AYNI);
 *   · muddati tugagan guruh yoyilmaydi.
 *
 * Yangi qator guruh bilan AYNI davr va `createdAt` ni oladi: chegara
 * (`computeDeductions`) yaratilish tartibida qo'llanadi, siyosat esa guruh
 * yozilgan paytdagi o'rnida qolishi kerak.
 *
 * IDEMPOTENT: `(batchId, staffId)` yagona, `skipDuplicates` — parallel
 * chaqiruv ikkinchi qator yoza olmaydi.
 *
 * @param {string[]|null} staffIds - null → hamma xodim
 * @param {{ batchIds?: string[] }} [options]
 * @returns {Promise<{created: number, resync: object}>}
 */
const extendAllScopeDeductions = async (staffIds = null, { batchIds = null } = {}) => {
  const result = { created: 0, resync: { updated: 0, locked: [], conflicts: 0 } };
  if (Array.isArray(staffIds) && staffIds.length === 0) return result;

  const templates = await prisma.payrollDeduction.findMany({
    where: {
      appliesToAll: true,
      status: "active",
      OR: [{ endMonth: null }, { endMonth: { gte: currentMonthKey() } }],
      ...(batchIds ? { batchId: { in: batchIds } } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const byBatch = new Map();
  for (const row of templates) if (!byBatch.has(row.batchId)) byBatch.set(row.batchId, row);
  if (byBatch.size === 0) return result;

  // Oyligi bor xodimlar — `getCandidates` bilan AYNI shart, oyga bog'lanmagan
  const minStart = Math.min(...[...byBatch.values()].map((t) => t.startMonth));
  const rules = await prisma.staffSalary.findMany({
    where: {
      ...(staffIds ? { staffId: { in: staffIds } } : {}),
      OR: [{ endMonth: null }, { endMonth: { gte: minStart } }],
    },
    select: { staffId: true },
  });
  const ruleIds = [...new Set(rules.map((r) => r.staffId))];
  const tutorIds = await resolveTutorIdsForMonth(minStart, { fromMonth: true });

  const staff = await prisma.user.findMany({
    where: {
      ...(staffIds ? { id: { in: staffIds } } : {}),
      isArchived: false,
      role: { not: ROLES.STUDENT },
      OR: [
        { positionId: { not: null } },
        { salaryCategoryId: { not: null } },
        ...(ruleIds.length ? [{ id: { in: ruleIds } }] : []),
        ...(tutorIds.length ? [{ id: { in: tutorIds } }] : []),
      ],
    },
    select: { id: true },
  });
  if (staff.length === 0) return result;
  const eligibleIds = staff.map((u) => u.id);

  const existing = await prisma.payrollDeduction.findMany({
    where: { batchId: { in: [...byBatch.keys()] }, staffId: { in: eligibleIds } },
    select: { batchId: true, staffId: true },
  });
  const hasRow = new Set(existing.map((r) => `${r.batchId}|${r.staffId}`));

  for (const t of byBatch.values()) {
    let targets = eligibleIds.filter((id) => !hasRow.has(`${t.batchId}|${id}`));
    if (targets.length === 0) continue;

    const twins = await prisma.payrollDeduction.findMany({
      where: {
        staffId: { in: targets },
        batchId: { not: t.batchId },
        status: "active",
        reason: t.reason,
        type: t.type,
        value: t.value,
        startMonth: t.startMonth,
        endMonth: t.endMonth,
      },
      select: { staffId: true },
    });
    const twinIds = new Set(twins.map((r) => r.staffId));
    targets = targets.filter((id) => !twinIds.has(id));
    if (targets.length === 0) continue;

    const count = await prisma.$transaction(async (tx) => {
      const res = await tx.payrollDeduction.createMany({
        data: targets.map((staffId) => ({
          staffId,
          batchId: t.batchId,
          reason: t.reason,
          type: t.type,
          value: t.value,
          startMonth: t.startMonth,
          endMonth: t.endMonth,
          note: t.note,
          appliesToAll: true,
          createdBy: t.createdBy,
          createdAt: t.createdAt,
        })),
        skipDuplicates: true,
      });
      if (res.count > 0) {
        await payrollAudit.record(
          {
            actorId: t.createdBy,
            action: "deduction.extend",
            targetType: "deduction",
            targetId: t.batchId,
            summary:
              `"Hammaga" ushlab qolish ${res.count} ta yangi xodimga avtomatik qo'llandi: ` +
              `${t.reason} — ${valueLabelOf(t.type, t.value)}`,
            newValue: { batchId: t.batchId, staffIds: targets },
          },
          tx,
        );
      }
      return res.count;
    });

    result.created += count;
    mergeResync(
      result.resync,
      await resyncSealedEntries(targets, affectedMonths(t.startMonth, t.endMonth)),
    );
  }

  return result;
};

/**
 * Biriktirish nuqtalari uchun: HECH QACHON xato tashlamaydi. Asosiy amal
 * (lavozim, qoida) allaqachon saqlangan — yoyish yiqilsa ham u orqaga
 * qaytmasligi kerak; oylik shakllantirish keyin yana urinadi.
 */
const extendAllScopeDeductionsSafe = async (staffIds = null, options = {}) => {
  try {
    return await extendAllScopeDeductions(staffIds, options);
  } catch (error) {
    logger.warn(`"Hammaga" ushlab qolishni yoyib bo'lmadi: ${error.message}`);
    return null;
  }
};

/**
 * MAVJUD GURUHNI "HAMMAGA" QILISH — belgi paydo bo'lishidan oldin yozilgan
 * guruhlar uchun (ular qanday tanlangani saqlanmagan) va keyin fikr
 * o'zgarganda. Darhol yoyiladi.
 *
 * @param {string} batchId
 * @param {string} actorId
 */
const applyBatchToAll = async (batchId, actorId) => {
  const rows = await prisma.payrollDeduction.findMany({ where: { batchId } });
  if (rows.length === 0) throw new NotFoundError("Ushlab qolish guruhi topilmadi");

  const active = rows.filter((r) => r.status === "active");
  if (active.length === 0) {
    throw new BadRequestError("Guruh bekor qilingan — yangi xodimlarga qo'llab bo'lmaydi");
  }
  const sample = active[0];
  if (sample.endMonth != null && sample.endMonth < currentMonthKey()) {
    throw new BadRequestError(
      `Guruh muddati tugagan (${periodLabelOf(sample.startMonth, sample.endMonth)}) — yoyiladigan oy qolmagan`,
    );
  }
  if (rows.every((r) => r.appliesToAll)) {
    throw new BadRequestError("Bu ushlab qolish allaqachon yangi xodimlarga ham qo'llanadi");
  }

  await prisma.$transaction(async (tx) => {
    await tx.payrollDeduction.updateMany({ where: { batchId }, data: { appliesToAll: true } });
    await payrollAudit.record(
      {
        actorId,
        action: "deduction.apply_all",
        targetType: "deduction",
        targetId: batchId,
        summary: `Ushlab qolish endi yangi xodimlarga ham qo'llanadi: ${sample.reason} — ${valueLabelOf(sample.type, sample.value)}`,
        newValue: { batchId, appliesToAll: true },
      },
      tx,
    );
  });

  const extended = await extendAllScopeDeductions(null, { batchIds: [batchId] });
  return { batchId, created: extended.created, resync: extended.resync };
};

/* ─────────────────────── Bekor qilish ─────────────────────── */

const parseCancelReason = (reason) => {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text) throw new BadRequestError("Bekor qilish sababini yozing");
  return text.slice(0, REASON_MAX);
};

/**
 * Bitta yoki butun guruhni bekor qilish — `where` bilan farqlanadi.
 * Faqat FAOL qatorlar o'zgaradi (CAS: `status: active`).
 */
const cancelWhere = async (where, reason, actorId, auditTarget) => {
  const cancelReason = parseCancelReason(reason);

  const rows = await prisma.payrollDeduction.findMany({ where: { ...where, status: "active" } });
  if (rows.length === 0) {
    throw new NotFoundError("Faol ushlab qolish topilmadi (allaqachon bekor qilingan bo'lishi mumkin)");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.payrollDeduction.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, status: "active" },
      data: {
        status: "cancelled",
        cancelReason,
        cancelledAt: new Date(),
        cancelledBy: actorId,
      },
    });

    await payrollAudit.record(
      {
        actorId,
        action: "deduction.cancel",
        targetType: "deduction",
        targetId: auditTarget,
        summary: `${res.count} ta ushlab qolish bekor qilindi: ${rows[0].reason} — ${cancelReason}`,
        oldValue: { ids: rows.map((r) => r.id) },
      },
      tx,
    );

    return res.count;
  });

  // Qayta hisoblash — har xodimning o'z davri bo'yicha
  const resync = { updated: 0, locked: [], conflicts: 0 };
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.startMonth}|${row.endMonth}`;
    if (!groups.has(key)) groups.set(key, { row, staffIds: new Set() });
    groups.get(key).staffIds.add(row.staffId);
  }
  for (const { row, staffIds } of groups.values()) {
    const part = await resyncSealedEntries([...staffIds], affectedMonths(row.startMonth, row.endMonth));
    resync.updated += part.updated;
    resync.conflicts += part.conflicts;
    resync.locked.push(...part.locked);
  }

  return { cancelled: updated, resync };
};

const cancelDeduction = (id, reason, actorId) => cancelWhere({ id }, reason, actorId, id);

const cancelBatch = (batchId, reason, actorId) =>
  cancelWhere({ batchId }, reason, actorId, batchId);

/* ─────────────────────── Ro'yxat ─────────────────────── */

/**
 * Tanlangan oyda har bir ushlab qolish qancha bo'lgani.
 *
 * ⚠️ MUHR USTUN: oylik shakllantirilgan bo'lsa, summa muhrlangan
 * tafsilotdan olinadi (aynan shuncha ushlangan). Muhrda yo'q bo'lsa — to'lov
 * tushganidan keyin qo'shilgan, ya'ni shu oyga TA'SIR QILMAGAN (`null`).
 * Shakllantirilmagan oyda — jonli dvigatel.
 */
const resolveMonthAmounts = async (month, rows) => {
  const staffIds = [...new Set(rows.map((r) => r.staffId))];
  if (staffIds.length === 0) return new Map();

  const [entries, users] = await Promise.all([
    prisma.payrollEntry.findMany({
      where: { month, staffId: { in: staffIds }, status: { not: "cancelled" } },
      select: { staffId: true, deductionBreakdown: true },
    }),
    prisma.user.findMany({ where: { id: { in: staffIds } }, select: STAFF_SELECT }),
  ]);
  const entryMap = new Map(entries.map((e) => [e.staffId, e]));

  const live = users.filter((u) => !entryMap.has(u.id));
  const ctx = live.length ? await loadContext(month, live) : null;

  const amounts = new Map();
  for (const user of live) {
    const c = computeForStaff(user, month, ctx);
    for (const row of c?.deductionBreakdown ?? []) {
      amounts.set(row.id, { amount: row.amount, capped: row.capped, sealed: false });
    }
  }
  for (const entry of entries) {
    for (const row of Array.isArray(entry.deductionBreakdown) ? entry.deductionBreakdown : []) {
      amounts.set(row.id, { amount: row.amount, capped: row.capped, sealed: true });
    }
  }
  return amounts;
};

/**
 * Ushlab qolishlar registri (sahifalangan).
 *
 * @param {object} req - query: { month, status, search, batchId, staffId, page, limit }
 */
const listDeductions = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const month = query.month ? parseMonthKey(query.month, "Oy") : currentMonthKey();
  const status = ["active", "cancelled"].includes(query.status) ? query.status : null;

  const where = {
    ...(status ? { status } : {}),
    ...(query.batchId ? { batchId: String(query.batchId) } : {}),
    ...(query.staffId ? { staffId: String(query.staffId) } : {}),
    // Oy kesimi — shu oyni qamragan qoidalar
    startMonth: { lte: month },
    OR: [{ endMonth: null }, { endMonth: { gte: month } }],
  };

  if (query.search) {
    const needle = String(query.search).trim();
    const matched = await prisma.user.findMany({
      where: {
        OR: [
          { firstName: { contains: needle, mode: "insensitive" } },
          { lastName: { contains: needle, mode: "insensitive" } },
          { username: { contains: needle, mode: "insensitive" } },
        ],
      },
      select: { id: true },
    });
    where.AND = [
      {
        OR: [
          { staffId: { in: matched.map((u) => u.id) } },
          { reason: { contains: needle, mode: "insensitive" } },
        ],
      },
    ];
  }

  const [rows, total, activeRows] = await Promise.all([
    prisma.payrollDeduction.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip,
      take: limit,
    }),
    prisma.payrollDeduction.count({ where }),
    // Oy jamisi — sahifadan QAT'IY NAZAR, faqat faollar
    prisma.payrollDeduction.findMany({
      where: { ...where, status: "active" },
      select: { id: true, staffId: true },
    }),
  ]);

  const personIds = [
    ...new Set(rows.flatMap((r) => [r.staffId, r.createdBy, r.cancelledBy]).filter(Boolean)),
  ];
  const batchIds = [...new Set(rows.map((r) => r.batchId))];

  const [people, batchSizes, monthAmounts] = await Promise.all([
    personIds.length
      ? prisma.user.findMany({
          where: { id: { in: personIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [],
    batchIds.length
      ? prisma.payrollDeduction.groupBy({
          by: ["batchId"],
          where: { batchId: { in: batchIds }, status: "active" },
          _count: { _all: true },
        })
      : [],
    resolveMonthAmounts(month, activeRows),
  ]);
  const peopleMap = new Map(people.map((p) => [p.id, p]));
  const batchMap = new Map(batchSizes.map((b) => [b.batchId, b._count._all]));

  const items = rows.map((row) => {
    const monthInfo = row.status === "active" ? monthAmounts.get(row.id) : null;
    return {
      id: row.id,
      batchId: row.batchId,
      batchActiveCount: batchMap.get(row.batchId) ?? 0,
      staffId: row.staffId,
      staffName: fullName(peopleMap.get(row.staffId)),
      reason: row.reason,
      note: row.note,
      type: row.type,
      value: formatAmount(row.value),
      startMonth: row.startMonth,
      endMonth: row.endMonth,
      periodLabel:
        row.endMonth == null
          ? formatMonthRange(row.startMonth, null)
          : periodLabelOf(row.startMonth, row.endMonth),
      status: row.status,
      appliesToAll: row.appliesToAll,
      // Tanlangan oyda: summa | null (ta'sir qilmagan)
      monthAmount: monthInfo?.amount ?? null,
      monthCapped: monthInfo?.capped ?? false,
      monthSealed: monthInfo?.sealed ?? false,
      createdByName: fullName(peopleMap.get(row.createdBy)),
      createdAtLabel: formatDateTimeUz(row.createdAt),
      cancelReason: row.cancelReason || null,
      cancelledByName: row.cancelledBy ? fullName(peopleMap.get(row.cancelledBy)) : null,
      cancelledAtLabel: row.cancelledAt ? formatDateTimeUz(row.cancelledAt) : null,
    };
  });

  const monthTotal = sumAmounts(
    activeRows.map((row) => monthAmounts.get(row.id)?.amount).filter(Boolean),
  );

  return {
    ...formatPaginationResponse(items, total, page, limit),
    month,
    monthLabel: formatMonthKey(month),
    totals: {
      monthAmount: formatAmount(monthTotal),
      activeCount: activeRows.length,
      staffCount: new Set(activeRows.map((r) => r.staffId)).size,
    },
  };
};

/* ─────────────────────── Xodimning o'zi ─────────────────────── */

/**
 * MENING USHLAB QOLISHLARIM — xodim panelidagi "Oylik" tabi va bosh sahifa.
 *
 * Xodim NIMA UCHUN (sabab + izoh), QANCHA va QAYSI OYDA ushlanganini
 * ko'radi — oylik summasi kutganidan kam chiqqanda javob shu yerda.
 *
 * ⚠️ SUMMA MUHRDAN: shakllantirilgan oyda aynan ushlangan summa
 * (`PayrollEntry.deductionBreakdown`), joriy shakllanmagan oyda — jonli
 * dvigatel (`sealed: false`, "hisoblanmoqda").
 *
 * ⚠️ BEKOR QILINGAN ushlab qolish ham ko'rinadi, agar u biror MUHRLANGAN
 * oyda ushlangan bo'lsa: to'lov tushgan oyga bekor qilish tegmaydi va pul
 * haqiqatan ushlangan — xodim buni ko'rishi kerak.
 *
 * @param {string} staffId - HAR DOIM `req.user.id`
 */
const listMyDeductions = async (staffId) => {
  const rows = await prisma.payrollDeduction.findMany({
    where: { staffId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
  if (rows.length === 0) {
    return { items: [], totals: { withheld: formatAmount(0), currentMonth: formatAmount(0) } };
  }

  const month = currentMonthKey();
  const entries = await prisma.payrollEntry.findMany({
    where: { staffId, status: { not: "cancelled" } },
    select: { month: true, deductionBreakdown: true },
  });

  // Ushlab qolish → oylar bo'yicha summalar
  const byId = new Map();
  const push = (id, item) => {
    const list = byId.get(id);
    if (list) list.push(item);
    else byId.set(id, [item]);
  };

  for (const entry of entries) {
    for (const row of Array.isArray(entry.deductionBreakdown) ? entry.deductionBreakdown : []) {
      push(row.id, { month: entry.month, amount: row.amount, capped: Boolean(row.capped), noRate: Boolean(row.noRate), sealed: true });
    }
  }

  // Joriy oy hali shakllanmagan — jonli hisob
  if (!entries.some((entry) => entry.month === month) && rows.some((r) => r.status === "active")) {
    const user = await prisma.user.findUnique({ where: { id: staffId }, select: STAFF_SELECT });
    if (user) {
      const ctx = await loadContext(month, [user]);
      const computed = computeForStaff(user, month, ctx);
      for (const row of computed?.deductionBreakdown ?? []) {
        push(row.id, { month, amount: row.amount, capped: Boolean(row.capped), noRate: Boolean(row.noRate), sealed: false });
      }
    }
  }

  const items = rows
    .filter((row) => row.status === "active" || byId.get(row.id)?.some((m) => m.sealed))
    .map((row) => {
      const months = (byId.get(row.id) ?? [])
        .sort((a, b) => b.month - a.month)
        .map((m) => ({ ...m, amount: formatAmount(m.amount), monthLabel: formatMonthKey(m.month) }));

      return {
        id: row.id,
        reason: row.reason,
        note: row.note,
        type: row.type,
        value: formatAmount(row.value),
        periodLabel:
          row.endMonth == null
            ? formatMonthRange(row.startMonth, null)
            : periodLabelOf(row.startMonth, row.endMonth),
        status: row.status,
        createdAtLabel: formatDateTimeUz(row.createdAt),
        cancelReason: row.status === "cancelled" ? row.cancelReason || null : null,
        cancelledAtLabel: row.cancelledAt ? formatDateTimeUz(row.cancelledAt) : null,
        months,
        // Muhrlangan oylarda jami ushlangani
        withheldAmount: formatAmount(sumAmounts(months.filter((m) => m.sealed).map((m) => m.amount))),
      };
    });

  const allMonths = items.flatMap((item) => item.months);
  return {
    items,
    month,
    monthLabel: formatMonthKey(month),
    totals: {
      withheld: formatAmount(sumAmounts(allMonths.filter((m) => m.sealed).map((m) => m.amount))),
      currentMonth: formatAmount(sumAmounts(allMonths.filter((m) => m.month === month).map((m) => m.amount))),
    },
  };
};

module.exports = {
  DRAFT_ID,
  parseDraft,
  getCandidates,
  previewDeductions,
  createDeductions,
  cancelDeduction,
  cancelBatch,
  applyBatchToAll,
  extendAllScopeDeductions,
  extendAllScopeDeductionsSafe,
  listDeductions,
  listMyDeductions,
  resyncSealedEntries,
};
