/**
 * OYLIKNI TO'XTATISH.
 *
 * Moliya → "Oylikni to'xtatish": boshliq bitta/tanlangan xodimlar yoki BARCHA
 * xodimlar uchun tanlangan oy(lar)da oylikning butunini yoki bir qismini
 * to'xtatadi — o'sha qism HISOBLANMAYDI:
 *
 *   all        — butun oylik
 *   base       — asosiy oylik (lavozim maoshi + dars soati)
 *   tutor      — barcha tyutor sinflari
 *   allowances — tyutordan boshqa barcha qo'shimchalar
 *   item       — bitta aniq qo'shimcha (tyutor sinfi, bonus, qoida ustamasi)
 *
 * ── QAYERDA HISOBLANADI ─────────────────────
 *
 * ⚠️ FORMULA BU YERDA YOZILMAYDI — `computeSuspensions`
 * (`helpers/salaryRules.helpers.js`), uni `payrollEngine` (jonli hisob, vedomost,
 * shakllantirish) va `resyncSealedEntries` (muhrlangan oylik) chaqiradi. Bu
 * servis faqat qoidani saqlaydi, oldindan ko'rsatadi va bekor qiladi.
 *
 * ── XAVFSIZLIK ─────────────────────────────
 *
 *   · alohida huquq `payroll.suspend` (ro'yxat — `payroll.view`);
 *   · davr IKKALA tomondan majburiy, ko'pi bilan 12 oy — muddatsiz to'xtatish
 *     oylikni jimgina abadiy o'chirib qo'yardi;
 *   · "barcha xodimlar" — serverda ALOHIDA tasdiq (`confirmAll: true`);
 *   · O'CHIRILMAYDI — bekor qilinadi (sabab + aktyor), har amal audit'ga;
 *   · muhrlangan oylikka faqat CAS bilan yoziladi; to'langan puldan kam bo'lib
 *     qoladigan o'zgarish BLOKLANADI (`isResyncBlocked`) — ortiqcha to'lov yo'q;
 *   · bir xil to'xtatish (xodim + qism + davr) qayta yozilmaydi.
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
const { Decimal, formatAmount, sumAmounts } = require("../helpers/money.helpers");
const { formatDateTimeUz } = require("../helpers/date.helpers");
const {
  SUSPENSION_COMPONENTS,
  SUSPENSION_COMPONENT_LABELS,
  buildPayUnits,
} = require("../helpers/salaryRules.helpers");
const { resolveSalariesForMonth } = require("./staffSalary.service");
const { loadContext, computeForStaff } = require("./payrollEngine.service");
const { resolveTutorIdsForMonth } = require("./tutorGroup.service");
const {
  resyncSealedEntries,
  recomputeSealedEntry,
  isResyncBlocked,
  loadResyncSources,
  sealStateOf,
} = require("./payrollDeduction.service");
const payrollAudit = require("./payrollAudit.service");
const logger = require("../utils/logger");

const MAX_STAFF = 1000;
const MAX_MONTHS = 12;
const REASON_MAX = 200;
const NOTE_MAX = 500;
const DRAFT_PREFIX = "draft-";
const MAX_PARTS = 20;
const ITEM_KEY_PATTERN = /^(tutor|bonus|rule):.{1,200}$/;
const ALL_STAFF_LABEL = "Barcha xodimlar";

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

const periodLabelOf = (startMonth, endMonth) =>
  endMonth === startMonth ? formatMonthKey(startMonth) : formatMonthRange(startMonth, endMonth);

/** `[from, to]` oylar ro'yxati (INKLYUZIV). */
const monthsBetween = (from, to) => {
  const months = [];
  for (let m = from; m <= to; m = nextMonth(m)) months.push(m);
  return months;
};

/** Muhr faqat joriy oygacha bo'ladi — qayta hisoblanadigan oylar. */
const sealedMonthsOf = (startMonth, endMonth) => {
  const to = Math.min(endMonth, currentMonthKey());
  return startMonth > to ? [] : monthsBetween(startMonth, to);
};

const componentLabelOf = (row) =>
  row.component === "item"
    ? row.itemLabel || SUSPENSION_COMPONENT_LABELS.item
    : SUSPENSION_COMPONENT_LABELS[row.component] ?? row.component;

/* ─────────────────────── Qoralama ─────────────────────── */

/**
 * Formadan kelgan qoralamani o'qiydi va tekshiradi.
 *
 * @param {object} data - { scope, staffIds, parts: [{component, itemKey}], startMonth, endMonth, reason, note, confirmAll }
 *   (eski shakl: `component` + `itemKey` — bitta qism)
 */
const parseDraft = (data = {}) => {
  const scope = data.scope === "all" ? "all" : data.scope === "staff" ? "staff" : null;
  if (!scope) throw new BadRequestError("Kimning oyligi to'xtatilishini tanlang");

  let staffIds = [];
  if (scope === "staff") {
    staffIds = Array.isArray(data.staffIds)
      ? [...new Set(data.staffIds.map((id) => String(id).trim()).filter(Boolean))]
      : [];
    if (staffIds.length === 0) throw new BadRequestError("Kamida bitta xodim tanlang");
    if (staffIds.length > MAX_STAFF) {
      throw new BadRequestError(`Bir amalda ${MAX_STAFF} tadan ortiq xodim tanlab bo'lmaydi`);
    }
    if (staffIds.some((id) => !/^[a-f\d]{24}$/i.test(id))) {
      throw new BadRequestError("Xodim identifikatori noto'g'ri");
    }
  } else if (data.confirmAll !== true) {
    // ⚠️ Ikkinchi qavat: oynadagi tasdiq belgisi chetlab o'tilsa ham server
    // butun maktab oyligini "tasodifan" to'xtatmaydi
    throw new BadRequestError("Barcha xodimlar oyligini to'xtatish uchun tasdiqlang");
  }

  // QISMLAR — bir amalda bir nechtasi (masalan asosiy oylik + bitta tyutor
  // sinfi). Eski shakl (`component` + `itemKey`) ham qabul qilinadi.
  const rawParts = Array.isArray(data.parts)
    ? data.parts
    : [{ component: data.component, itemKey: data.itemKey }];
  if (rawParts.length === 0) throw new BadRequestError("Oylikning qaysi qismi to'xtatilishini tanlang");
  if (rawParts.length > MAX_PARTS) {
    throw new BadRequestError(`Bir amalda ko'pi bilan ${MAX_PARTS} ta qism tanlash mumkin`);
  }

  const parts = [];
  const seen = new Set();
  for (const raw of rawParts) {
    const component = raw?.component;
    if (!SUSPENSION_COMPONENTS.includes(component)) {
      throw new BadRequestError("Oylikning qaysi qismi to'xtatilishini tanlang");
    }
    let itemKey = "";
    if (component === "item") {
      if (scope !== "staff" || staffIds.length !== 1) {
        throw new BadRequestError("Aniq qo'shimchani faqat bitta xodim uchun to'xtatish mumkin");
      }
      itemKey = typeof raw.itemKey === "string" ? raw.itemKey.trim() : "";
      if (!ITEM_KEY_PATTERN.test(itemKey)) throw new BadRequestError("Qo'shimchani tanlang");
    }
    const key = `${component}|${itemKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push({ component, itemKey });
  }
  // "Butun oylik" qolganlarini o'z ichiga oladi — ortiqcha qator yozilmasin
  const normalizedParts = parts.some((part) => part.component === "all")
    ? [{ component: "all", itemKey: "" }]
    : parts;

  const startMonth = parseMonthKey(data.startMonth, "Qaysi oydan");
  const endMonth =
    data.endMonth === undefined || data.endMonth === null || data.endMonth === ""
      ? startMonth
      : parseMonthKey(data.endMonth, "Qaysi oygacha");
  if (endMonth < startMonth) {
    throw new BadRequestError("Tugash oyi boshlanish oyidan oldin bo'lishi mumkin emas");
  }
  if (monthsBetween(startMonth, endMonth).length > MAX_MONTHS) {
    throw new BadRequestError(`Bir amalda ko'pi bilan ${MAX_MONTHS} oy to'xtatish mumkin`);
  }

  const reason = typeof data.reason === "string" ? data.reason.trim() : "";
  if (!reason) throw new BadRequestError("To'xtatish sababini yozing");
  if (reason.length > REASON_MAX) {
    throw new BadRequestError(`Sabab ${REASON_MAX} belgidan oshmasligi kerak`);
  }
  const note = typeof data.note === "string" ? data.note.trim().slice(0, NOTE_MAX) : "";

  return { scope, staffIds, parts: normalizedParts, startMonth, endMonth, reason, note };
};

/**
 * Tanlangan xodimlar — hammasi mavjud, o'quvchi emas, arxivlanmagan.
 * ⚠️ Birortasi yaroqsiz bo'lsa BUTUN amal rad etiladi.
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
    throw new BadRequestError("O'quvchiga oylik yo'q");
  }
  const archived = users.filter((u) => u.isArchived);
  if (archived.length) {
    throw new BadRequestError(`Arxivlangan xodim: ${archived.map(fullName).join(", ")}`);
  }
  return users;
};

/**
 * Oyda oylik oladigan xodimlar — oylik shakllantirish bilan AYNI qoida:
 * lavozim, toifa, oylik qoidasi yoki tyutor guruhi bor, arxivlanmagan.
 */
const loadPayrollStaff = async (month) => {
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
        ...(tutorIds.length ? [{ id: { in: tutorIds } }] : []),
      ],
    },
    select: STAFF_SELECT,
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
  return { users, salaryRules };
};

/** Oyning amaldagi (bekor qilinmagan) majburiyatlari — xodim bo'yicha. */
const loadEntryMap = async (month, staffIds) => {
  if (staffIds.length === 0) return new Map();
  const entries = await prisma.payrollEntry.findMany({
    where: { month, staffId: { in: staffIds }, status: { not: "cancelled" } },
  });
  return new Map(entries.map((e) => [e.staffId, e]));
};

/* ─────────────────────── Nomzodlar va qismlar ─────────────────────── */

/**
 * KIMNING OYLIGINI TO'XTATISH MUMKIN — shu oyda oyligi bor xodimlar.
 * @param {*} monthInput - YYYYMM (bo'sh → joriy oy)
 */
const getCandidates = async (monthInput) => {
  const month = monthInput ? parseMonthKey(monthInput, "Oy") : currentMonthKey();
  const { users, salaryRules } = await loadPayrollStaff(month);
  const [ctx, entryMap] = await Promise.all([
    loadContext(month, users, { salaryRules }),
    loadEntryMap(month, users.map((u) => u.id)),
  ]);

  const items = [];
  for (const user of users) {
    const entry = entryMap.get(user.id);
    const c = computeForStaff(user, month, ctx);
    const gross = entry
      ? new Decimal(entry.fixedAmount).plus(entry.kpiAmount).plus(entry.allowanceAmount)
      : c?.grossAmount;
    if (!gross || gross.lessThanOrEqualTo(0)) continue;

    items.push({
      id: user.id,
      fullName: fullName(user),
      username: user.username,
      role: user.role,
      departmentName: c?.departmentName || entry?.departmentName || null,
      positionName: c?.positionName || entry?.positionName || null,
      categoryName: c?.categoryName || entry?.categoryName || null,
      grossAmount: formatAmount(gross),
      amount: formatAmount(entry ? entry.amount : c.amount),
      suspendedAmount: formatAmount(entry ? entry.suspendedAmount : c.suspendedAmount),
      sealState: sealStateOf(entry),
    });
  }

  return { month, monthLabel: formatMonthKey(month), items };
};

/**
 * BITTA XODIMNING OYLIK QISMLARI — "aniq qo'shimchani to'xtatish" tanlovi.
 * Muhrlangan oyda muhrdan (aynan shu qatorlar to'xtatiladi), aks holda jonli.
 *
 * @param {string} staffId
 * @param {*} monthInput
 */
const getUnits = async (staffId, monthInput) => {
  const id = String(staffId ?? "").trim();
  if (!/^[a-f\d]{24}$/i.test(id)) throw new BadRequestError("Xodim identifikatori noto'g'ri");
  const month = monthInput ? parseMonthKey(monthInput, "Oy") : currentMonthKey();
  const [user] = await loadStaff([id]);

  const entry = (await loadEntryMap(month, [user.id])).get(user.id) ?? null;
  let parts;
  if (entry) {
    parts = entry;
  } else {
    const ctx = await loadContext(month, [user]);
    parts = computeForStaff(user, month, ctx);
  }
  if (!parts) {
    return { month, monthLabel: formatMonthKey(month), sealed: false, base: null, items: [] };
  }

  const units = buildPayUnits({
    fixedAmount: parts.fixedAmount,
    kpiAmount: parts.kpiAmount,
    allowanceBreakdown: parts.allowanceBreakdown,
  });
  const [base, ...rest] = units;

  return {
    month,
    monthLabel: formatMonthKey(month),
    sealed: Boolean(entry),
    base: { amount: formatAmount(base.amount) },
    // Faqat barqaror kalitli qatorlar tanlanadi (eski muhrdagi manbasiz qator
    // "Barcha qo'shimchalar" bilan to'xtatiladi)
    items: rest
      .filter((unit) => ITEM_KEY_PATTERN.test(unit.key))
      .map((unit) => ({
        key: unit.key,
        kind: unit.kind,
        label: unit.label,
        amount: formatAmount(unit.amount),
      })),
  };
};

/**
 * Qismlarga nom beradi. `item` — shu oyda xodimda bor bo'lishi SHART (qismlar
 * bir marta yuklanadi).
 *
 * @returns {Promise<Array<{component, itemKey, itemLabel, label}>>}
 */
const resolvePartLabels = async (parts, staffId, month) => {
  const needsUnits = parts.some((part) => part.component === "item");
  const units = needsUnits ? await getUnits(staffId, month) : null;
  return parts.map((part) => {
    if (part.component !== "item") {
      return { ...part, itemLabel: "", label: SUSPENSION_COMPONENT_LABELS[part.component] };
    }
    const unit = units.items.find((item) => item.key === part.itemKey);
    if (!unit) {
      throw new BadRequestError(
        `Tanlangan qo'shimcha ${formatMonthKey(month)} da bu xodimda topilmadi — ro'yxatni yangilang`,
      );
    }
    return { ...part, itemLabel: unit.label, label: unit.label };
  });
};

const partsLabelOf = (parts) => parts.map((part) => part.label).join(", ");

/* ─────────────────────── Oldindan hisob ─────────────────────── */

/**
 * JONLI HISOB — qoralama saqlansa `startMonth` da kimning oyligi qanchaga
 * o'zgaradi. Hech narsa yozilmaydi.
 *
 * Qoralama MAVJUD to'xtatishlardan KEYIN qo'shiladi (saqlanganda ham u eng
 * oxirgi bo'ladi). Muhrlangan oylik muhrdan (`recomputeSealedEntry`), qolgani
 * dvigateldan — saqlangandan keyin aynan shu raqam yoziladi.
 */
const previewSuspension = async (data) => {
  const draft = parseDraft(data);
  const month = draft.startMonth;

  const users =
    draft.scope === "all" ? (await loadPayrollStaff(month)).users : await loadStaff(draft.staffIds);
  const parts = await resolvePartLabels(draft.parts, users[0]?.id, month);

  const staffIds = users.map((u) => u.id);
  const [ctx, entryMap] = await Promise.all([
    loadContext(month, users),
    loadEntryMap(month, staffIds),
  ]);
  const sealedIds = [...entryMap.keys()];
  const sources = sealedIds.length ? await loadResyncSources(month, sealedIds) : null;

  const draftFor = (staffId) =>
    parts.map((part, index) => ({
      id: `${DRAFT_PREFIX}${index}`,
      staffId: draft.scope === "all" ? null : staffId,
      component: part.component,
      itemKey: part.itemKey,
      itemLabel: part.itemLabel,
      reason: draft.reason,
    }));
  const draftSum = (lines) =>
    sumAmounts(lines.filter((line) => String(line.id).startsWith(DRAFT_PREFIX)).map((line) => line.amount));

  const items = [];
  for (const user of users) {
    const entry = entryMap.get(user.id);
    let before;
    let after;
    let draftAmount;
    let sealState = "none";

    if (entry) {
      const src = sources.forStaff(user.id);
      const next = recomputeSealedEntry(entry, {
        ...src,
        suspensions: [...src.suspensions, ...draftFor(user.id)],
      });
      before = new Decimal(entry.amount);
      after = next.amount;
      draftAmount = draftSum(next.data.suspensionBreakdown);
      sealState = isResyncBlocked(entry, next) ? "locked" : "resync";
    } else {
      const c = computeForStaff(user, month, ctx);
      if (!c || c.grossAmount.lessThanOrEqualTo(0)) continue;
      const withDraft = computeForStaff(user, month, {
        ...ctx,
        suspensions: [...(ctx.suspensions || []), ...draftFor(user.id)],
      });
      before = c.amount;
      after = withDraft.amount;
      draftAmount = draftSum(withDraft.suspensionBreakdown);
    }

    items.push({
      staffId: user.id,
      fullName: fullName(user),
      sealState,
      applies: sealState !== "locked",
      beforeAmount: formatAmount(before),
      afterAmount: formatAmount(sealState === "locked" ? before : after),
      draftAmount: formatAmount(draftAmount),
    });
  }

  const applied = items.filter((row) => row.applies);
  return {
    month,
    monthLabel: formatMonthKey(month),
    periodLabel: periodLabelOf(draft.startMonth, draft.endMonth),
    componentLabel: partsLabelOf(parts),
    totals: {
      staffCount: items.length,
      beforeAmount: formatAmount(sumAmounts(applied.map((row) => row.beforeAmount))),
      afterAmount: formatAmount(sumAmounts(applied.map((row) => row.afterAmount))),
      stoppedAmount: formatAmount(
        sumAmounts(applied.map((row) => row.beforeAmount)).minus(
          sumAmounts(applied.map((row) => row.afterAmount)),
        ),
      ),
      resyncCount: items.filter((row) => row.sealState === "resync").length,
      lockedCount: items.filter((row) => row.sealState === "locked").length,
      noEffectCount: applied.filter((row) => new Decimal(row.draftAmount).isZero()).length,
    },
    items,
  };
};

/* ─────────────────────── Yaratish ─────────────────────── */

/**
 * OYLIKNI TO'XTATISH — "barcha xodimlar" uchun BITTA qator (`staffId: null`,
 * keyin oyligi belgilanganlarga ham), aks holda har xodimga alohida qator.
 *
 * ⚠️ AYNAN TAKROR (xodim + qism + qo'shimcha + davr) o'tkazib yuboriladi —
 * ikki marta bosilgan tugma summani ikki marta ayirmaydi (dvigatel ham bir
 * qismni bir marta sanaydi, lekin registr ifloslanmasin).
 */
const createSuspension = async (data, actorId) => {
  const draft = parseDraft(data);
  const users = draft.scope === "staff" ? await loadStaff(draft.staffIds) : [];
  const parts = await resolvePartLabels(draft.parts, draft.staffIds[0], draft.startMonth);
  const componentLabel = partsLabelOf(parts);

  const batchId = generateId();
  const created = await prisma.$transaction(async (tx) => {
    // ⚠️ QULF: takror tekshiruvi va yozuv bitta navbatda — ikki parallel
    // so'rov (ikki marta bosilgan tugma) ikkala qatorni ham yoza olmasin
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('payroll_suspension:create'))`;

    const duplicates = await tx.payrollSuspension.findMany({
      where: {
        status: "active",
        startMonth: draft.startMonth,
        endMonth: draft.endMonth,
        staffId: draft.scope === "all" ? null : { in: draft.staffIds },
        OR: parts.map((part) => ({ component: part.component, itemKey: part.itemKey })),
      },
      select: { staffId: true, component: true, itemKey: true },
    });
    const duplicateKeys = new Set(
      duplicates.map((d) => `${d.staffId ?? "ALL"}|${d.component}|${d.itemKey}`),
    );

    const targets = draft.scope === "all" ? [null] : draft.staffIds;
    const rows = [];
    for (const staffId of targets) {
      for (const part of parts) {
        if (duplicateKeys.has(`${staffId ?? "ALL"}|${part.component}|${part.itemKey}`)) continue;
        rows.push({
          staffId,
          batchId,
          component: part.component,
          itemKey: part.itemKey,
          itemLabel: part.itemLabel,
          startMonth: draft.startMonth,
          endMonth: draft.endMonth,
          reason: draft.reason,
          note: draft.note,
          createdBy: actorId,
        });
      }
    }
    if (rows.length === 0) {
      throw new ConflictError("Bu to'xtatish allaqachon yozilgan");
    }

    await tx.payrollSuspension.createMany({ data: rows });

    const writtenStaff = [...new Set(rows.map((row) => row.staffId))];
    await payrollAudit.record(
      {
        actorId,
        action: "suspension.create",
        targetType: "suspension",
        targetId: batchId,
        summary:
          `Oylik to'xtatildi (${componentLabel}): ` +
          `${draft.scope === "all" ? ALL_STAFF_LABEL : `${writtenStaff.length} ta xodim`} — ` +
          `${periodLabelOf(draft.startMonth, draft.endMonth)}. Sabab: ${draft.reason}`,
        newValue: {
          batchId,
          staffIds: writtenStaff,
          parts: parts.map(({ component, itemKey }) => ({ component, itemKey })),
          startMonth: draft.startMonth,
          endMonth: draft.endMonth,
        },
      },
      tx,
    );

    const skippedStaff = targets.filter((staffId) => !writtenStaff.includes(staffId));
    return { writtenStaff, skippedStaff, rowCount: rows.length };
  });

  logger.warn(
    `[payroll] Oylik to'xtatildi: batch=${batchId} ` +
      `parts=${parts.map((p) => p.itemKey || p.component).join(",")} ` +
      `staff=${draft.scope === "all" ? "ALL" : created.writtenStaff.join(",")} ` +
      `period=${draft.startMonth}-${draft.endMonth} actor=${actorId}`,
  );

  // ⚠️ TRANZAKSIYADAN TASHQARIDA: har muhr alohida CAS bilan. Bittasi to'lov
  // bilan to'qnashsa, to'xtatishning o'zi orqaga qaytmaydi — kunlik
  // shakllantirish yana urinadi.
  const resync = await resyncSealedEntries(
    draft.scope === "all" ? null : created.writtenStaff,
    sealedMonthsOf(draft.startMonth, draft.endMonth),
  );

  const userMap = new Map(users.map((u) => [u.id, u]));
  return {
    batchId,
    created: created.writtenStaff.length,
    rows: created.rowCount,
    componentLabel,
    skippedDuplicates: created.skippedStaff.filter(Boolean).map((id) => fullName(userMap.get(id))),
    resync,
  };
};

/* ─────────────────────── Bekor qilish ─────────────────────── */

const parseCancelReason = (reason) => {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text) throw new BadRequestError("Bekor qilish sababini yozing");
  return text.slice(0, REASON_MAX);
};

/**
 * Bitta yoki butun guruhni bekor qilish. Faqat FAOL qatorlar (CAS:
 * `status: active`). Keyin muhrlangan oylik qayta hisoblanadi — to'xtatilgan
 * qism qaytadi (to'langan qator ham, chunki summa faqat oshadi).
 */
const cancelWhere = async (where, reason, actorId, auditTarget) => {
  const cancelReason = parseCancelReason(reason);

  const rows = await prisma.payrollSuspension.findMany({ where: { ...where, status: "active" } });
  if (rows.length === 0) {
    throw new NotFoundError("Faol to'xtatish topilmadi (allaqachon bekor qilingan bo'lishi mumkin)");
  }

  const cancelled = await prisma.$transaction(async (tx) => {
    const res = await tx.payrollSuspension.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, status: "active" },
      data: { status: "cancelled", cancelReason, cancelledAt: new Date(), cancelledBy: actorId },
    });
    if (res.count !== rows.length) {
      throw new ConflictError("To'xtatish shu orada o'zgardi — sahifani yangilab qayta urinib ko'ring");
    }

    await payrollAudit.record(
      {
        actorId,
        action: "suspension.cancel",
        targetType: "suspension",
        targetId: auditTarget,
        summary: `${res.count} ta oylik to'xtatish bekor qilindi: ${rows[0].reason} — ${cancelReason}`,
        oldValue: { ids: rows.map((r) => r.id) },
      },
      tx,
    );
    return res.count;
  });

  logger.warn(
    `[payroll] Oylik to'xtatish bekor qilindi: ids=${rows.map((r) => r.id).join(",")} actor=${actorId}`,
  );

  const resync = { updated: 0, locked: [], conflicts: 0 };
  for (const row of rows) {
    const part = await resyncSealedEntries(
      row.staffId ? [row.staffId] : null,
      sealedMonthsOf(row.startMonth, row.endMonth),
    );
    resync.updated += part.updated;
    resync.conflicts += part.conflicts;
    resync.locked.push(...part.locked);
  }

  return { cancelled, resync };
};

const cancelSuspension = (id, reason, actorId) => cancelWhere({ id }, reason, actorId, id);

const cancelBatch = (batchId, reason, actorId) =>
  cancelWhere({ batchId }, reason, actorId, batchId);

/* ─────────────────────── Ro'yxat ─────────────────────── */

/**
 * Tanlangan oyda har bir to'xtatish qancha va nechta xodimga ta'sir qilgani.
 * Muhrlangan oylikda — muhrdan, shakllanmaganda — jonli dvigateldan.
 *
 * @returns {Promise<Map<string, {amount: Decimal, staffCount: number}>>}
 */
const resolveMonthAmounts = async (month, rows) => {
  const result = new Map();
  if (rows.length === 0) return result;

  const hasGlobal = rows.some((row) => row.staffId == null);
  const users = hasGlobal
    ? (await loadPayrollStaff(month)).users
    : await prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.staffId))] }, isArchived: false },
        select: STAFF_SELECT,
      });
  const entryMap = await loadEntryMap(month, users.map((u) => u.id));

  const add = (lines) => {
    for (const line of Array.isArray(lines) ? lines : []) {
      const amount = new Decimal(line.amount || 0);
      if (!amount.greaterThan(0)) continue;
      const bucket = result.get(line.id) ?? { amount: new Decimal(0), staffCount: 0 };
      bucket.amount = bucket.amount.plus(amount);
      bucket.staffCount += 1;
      result.set(line.id, bucket);
    }
  };

  const live = users.filter((u) => !entryMap.has(u.id));
  const ctx = live.length ? await loadContext(month, live) : null;
  for (const user of live) add(computeForStaff(user, month, ctx)?.suspensionBreakdown);
  for (const entry of entryMap.values()) add(entry.suspensionBreakdown);
  return result;
};

/**
 * To'xtatishlar registri (sahifalangan) — tanlangan oyni qamraganlari.
 *
 * @param {object} req - query: { month, status, search, page, limit }
 */
const listSuspensions = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const month = query.month ? parseMonthKey(query.month, "Oy") : currentMonthKey();
  const status = ["active", "cancelled"].includes(query.status) ? query.status : null;

  const where = {
    ...(status ? { status } : {}),
    startMonth: { lte: month },
    endMonth: { gte: month },
  };

  const needle = typeof query.search === "string" ? query.search.trim().slice(0, 100) : "";
  if (needle) {
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
          { itemLabel: { contains: needle, mode: "insensitive" } },
        ],
      },
    ];
  }

  const [rows, total, activeRows] = await Promise.all([
    prisma.payrollSuspension.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip,
      take: limit,
    }),
    prisma.payrollSuspension.count({ where }),
    prisma.payrollSuspension.findMany({
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
      ? prisma.payrollSuspension.groupBy({
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
      isAllStaff: row.staffId == null,
      staffName: row.staffId == null ? ALL_STAFF_LABEL : fullName(peopleMap.get(row.staffId)),
      component: row.component,
      componentLabel: componentLabelOf(row),
      itemKey: row.itemKey,
      reason: row.reason,
      note: row.note,
      startMonth: row.startMonth,
      endMonth: row.endMonth,
      periodLabel: periodLabelOf(row.startMonth, row.endMonth),
      status: row.status,
      monthAmount: monthInfo ? formatAmount(monthInfo.amount) : null,
      monthStaffCount: monthInfo?.staffCount ?? 0,
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
      hasAllStaff: activeRows.some((row) => row.staffId == null),
    },
  };
};

/* ─────────────────────── Xodimning o'zi ─────────────────────── */

/**
 * MENING TO'XTATILGAN OYLIGIM — xodim panelidagi "Oylik" tabi.
 *
 * Xodim qaysi oyda, oylikning qaysi qismi, NIMA UCHUN (sabab + izoh) va
 * qancha to'xtatilganini ko'radi. Summa muhrlangan oyda muhrdan, joriy
 * shakllanmagan oyda jonli ("hisoblanmoqda").
 *
 * @param {string} staffId - HAR DOIM `req.user.id`
 */
const listMySuspensions = async (staffId) => {
  const rows = await prisma.payrollSuspension.findMany({
    where: { OR: [{ staffId }, { staffId: null }] },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
  const month = currentMonthKey();
  if (rows.length === 0) {
    return { items: [], month, monthLabel: formatMonthKey(month) };
  }

  const entries = await prisma.payrollEntry.findMany({
    where: { staffId, status: { not: "cancelled" } },
    select: { month: true, suspensionBreakdown: true },
  });

  const byId = new Map();
  const push = (id, item) => {
    const list = byId.get(id);
    if (list) list.push(item);
    else byId.set(id, [item]);
  };
  for (const entry of entries) {
    for (const line of Array.isArray(entry.suspensionBreakdown) ? entry.suspensionBreakdown : []) {
      if (new Decimal(line.amount || 0).greaterThan(0)) {
        push(line.id, { month: entry.month, amount: line.amount, sealed: true });
      }
    }
  }

  if (!entries.some((e) => e.month === month) && rows.some((r) => r.status === "active")) {
    const user = await prisma.user.findUnique({ where: { id: staffId }, select: STAFF_SELECT });
    if (user && !user.isArchived) {
      const ctx = await loadContext(month, [user]);
      for (const line of computeForStaff(user, month, ctx)?.suspensionBreakdown ?? []) {
        if (new Decimal(line.amount || 0).greaterThan(0)) {
          push(line.id, { month, amount: line.amount, sealed: false });
        }
      }
    }
  }

  // Faqat shu xodimga haqiqatan ta'sir qilganlari (yoki faol shaxsiylari)
  const items = rows
    .filter((row) => byId.has(row.id) || (row.status === "active" && row.staffId === staffId))
    .map((row) => ({
      id: row.id,
      componentLabel: componentLabelOf(row),
      reason: row.reason,
      note: row.note,
      periodLabel: periodLabelOf(row.startMonth, row.endMonth),
      status: row.status,
      createdAtLabel: formatDateTimeUz(row.createdAt),
      months: (byId.get(row.id) ?? [])
        .sort((a, b) => b.month - a.month)
        .map((m) => ({ ...m, amount: formatAmount(m.amount), monthLabel: formatMonthKey(m.month) })),
    }));

  return { items, month, monthLabel: formatMonthKey(month) };
};

module.exports = {
  parseDraft,
  getCandidates,
  getUnits,
  previewSuspension,
  createSuspension,
  cancelSuspension,
  cancelBatch,
  listSuspensions,
  listMySuspensions,
};
