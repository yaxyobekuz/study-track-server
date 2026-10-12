/**
 * FILIALLARARO KO'CHIRISH — o'quvchi, xodim va sinf.
 *
 * ═════════════════════════════════════════════
 * IKKI QADAM: KO'RIB CHIQISH → TASDIQLASH
 *
 *   1) `preview*` — hech narsa yozmaydi. Har bir odam uchun REJA qaytaradi:
 *      nima ko'chadi, nima qoladi, qaysi oy qayerda hisoblanadi, nima
 *      to'sadi (`blockers`), nimaga e'tibor (`warnings`) va tasdiqlanishi
 *      SHART bo'lgan oqibatlar (`acknowledgements`). Rejaning xeshi
 *      (`planHash`) ham qaytadi.
 *   2) `transfer*` — AYNI rejani tranzaksiya ichida QAYTA quradi va xeshini
 *      solishtiradi. Oraliqda nimadir o'zgargan bo'lsa (to'lov tushdi, sinf
 *      o'zgardi, kun almashdi) — 409, odam qayta ko'rib chiqadi: odam
 *      ko'rmagan narsa yozilmaydi (`scheduleSync` "activeHash" doktrinasi).
 *      Har bir oqibat server tomonda ham tasdiqlangan bo'lishi shart —
 *      oynadagi belgi chetlab o'tilsa ham rad etiladi.
 *
 * BITTA TRANZAKSIYA: barcha filial schema'lari va platforma bitta bazada,
 * shuning uchun manba, maqsad va login yo'naltirgichi bir vaqtda o'zgaradi.
 * Bir nechta odam tanlansa — HAMMASI YOKI HECH NARSA: "10 tadan 8 tasi
 * ko'chdi" degan yarim holat qo'lda qidirib topiladigan xato bo'lardi
 * (`TutorGroup` ko'p sinf doktrinasi). Bitta odam to'sqinlik qilsa, reja
 * uni ko'rsatadi va u ro'yxatdan olinadi.
 *
 * TRANZAKSIYADAN KEYIN (har biri o'z servisi orqali, yiqilsa — jurnalda
 * "e'tibor talab"): manba filialda ortiqcha hisob-fakturani bekor qilish,
 * qurilmani chekovdan chiqarish, tyutor guruhini yopish, seanslarni yopish.
 * ═════════════════════════════════════════════
 *
 * Nima ko'chadi va nima qoladi — `branchTransferStudent.service.js` va
 * `branchTransferStaff.service.js` sarlavhalarida.
 */

const crypto = require("crypto");
const prisma = require("../config/prisma");
const platformPrisma = require("../config/platformPrisma");
const { config } = require("../config/env.config");
const { getBranch, runWithBranch } = require("../config/branchContext");
const branchService = require("./branch.service");
const { generateId } = require("../utils/idGenerator");
const { isValidId } = require("../utils/objectId");
const {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const logger = require("../utils/logger");
const { hasRole, hasPermission, PERMISSIONS } = require("../utils/permissions");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");
const {
  qualified,
  schemaType,
  createShapeCache,
  assertMigrationParity,
  advisoryLock,
} = require("../helpers/crossSchema.helpers");
const {
  currentDayDate,
  currentMonthKey,
  parseDayDate,
  monthKeyOfDate,
  monthStartDate,
  formatMonthKey,
  prevMonth,
} = require("../helpers/month.helpers");
const { formatDateUz, formatDateTimeUz } = require("../helpers/date.helpers");
const { Decimal, formatAmount, sumAmounts } = require("../helpers/money.helpers");
const studentTransfer = require("./branchTransferStudent.service");
const staffTransfer = require("./branchTransferStaff.service");
const scheduleTransfer = require("./branchTransferSchedule.service");

const LIMITS = Object.freeze({ students: 300, staff: 50, classes: 20 });
const REASON_MIN = 5;
const REASON_MAX = 500;
// Bitta tranzaksiyada bir necha yuz o'quvchi.
//
// ⚠️ 15 DAQIQA, 3 emas. Har bir odam uchun o'nlab alohida yozuv ketadi
// (davr, qoida, moliya, tarix) va ularning har biri — bazaga alohida
// borib-kelish. Server yonida bu soniyalar, lekin baza masofada bo'lsa
// kechikish yig'ilib, 97 ta o'quvchi 3 daqiqaga sig'may qoldi va butun
// ko'chirish oxirida orqaga qaytdi (prodda tekshirilgan). Chegara faqat
// ZAXIRA to'siq: u ishga tushsa ham yarim holat qolmaydi.
const TX_OPTIONS = { maxWait: 30000, timeout: 900000 };

const KINDS = Object.freeze({ STUDENT: "student", STAFF: "staff", CLASS: "class" });
const PERMISSION_FOR = {
  [KINDS.STUDENT]: PERMISSIONS.TRANSFERS_STUDENTS,
  [KINDS.STAFF]: PERMISSIONS.TRANSFERS_STAFF,
  [KINDS.CLASS]: PERMISSIONS.TRANSFERS_CLASSES,
};

const toIso = (date) => date.toISOString().slice(0, 10);
const dayLabel = (date) => formatDateUz(date, { utc: true });

// ─────────────────────────────────────────────
// Kirish ma'lumoti
// ─────────────────────────────────────────────

const parseIds = (value, label, max) => {
  const list = Array.isArray(value) ? [...new Set(value.map(String))] : [];
  if (list.length === 0) throw new BadRequestError(`Kamida bitta ${label} tanlang`);
  if (list.length > max) {
    throw new BadRequestError(`Bir martada ko'pi bilan ${max} ta ${label} ko'chiriladi`);
  }
  const bad = list.find((id) => !isValidId(id));
  if (bad) throw new BadRequestError(`Noto'g'ri ${label} identifikatori`);
  return list;
};

/**
 * Ko'chish sanasi — maqsad filialdagi BIRINCHI kun.
 *
 * ⚠️ Faqat JORIY oy ichida va bugundan kech emas. Kelajak sanasi login
 * hozir ko'chib, o'qish esa keyin boshlanadigan oraliq holat yaratardi;
 * o'tgan oy — yopilgan (muhrlangan) oylik va hisob-fakturani orqaga
 * qayta yozardi.
 */
const parseEffectiveDate = (value) => {
  const today = currentDayDate();
  if (value == null || value === "") return today;
  const day = parseDayDate(value, "Ko'chish sanasi");
  if (day > today) throw new BadRequestError("Ko'chish sanasi bugundan keyin bo'lishi mumkin emas");
  if (day < monthStartDate(currentMonthKey())) {
    throw new BadRequestError("Ko'chish sanasi joriy oy ichida bo'lishi kerak");
  }
  return day;
};

const parseReason = (value) => {
  const reason = String(value ?? "").trim();
  if (reason.length < REASON_MIN) {
    throw new BadRequestError(`Ko'chirish sababini yozing (kamida ${REASON_MIN} belgi)`);
  }
  if (reason.length > REASON_MAX) throw new BadRequestError("Sabab juda uzun");
  return reason;
};

/**
 * Ko'chirish konteksti. Manba — DOIM joriy filial (amal o'sha filialdan
 * boshlanadi va o'sha filial ma'lumoti bilan ko'rsatiladi).
 */
const buildContext = async (actor, input) => {
  const current = getBranch();
  const source = current ? await branchService.findById(current.id) : null;
  if (!source) throw new BadRequestError("Joriy filial aniqlanmadi");

  if (!input.targetBranchId || !isValidId(String(input.targetBranchId))) {
    throw new BadRequestError("Maqsad filialni tanlang");
  }
  const target = await branchService.getUsableById(String(input.targetBranchId));
  if (target.id === source.id) {
    throw new BadRequestError("Maqsad filial joriy filialning o'zi bo'lishi mumkin emas");
  }

  const day = parseEffectiveDate(input.effectiveDate);
  return {
    source: { id: source.id, name: source.name, schemaName: source.schemaName },
    target: { id: target.id, name: target.name, schemaName: target.schemaName },
    day,
    dayIso: toIso(day),
    todayIso: toIso(currentDayDate()),
    month: monthKeyOfDate(day),
    actor: {
      id: actor.id,
      name: `${actor.firstName ?? ""} ${actor.lastName ?? ""}`.trim(),
      isOwner: hasRole(actor, ROLES.OWNER),
    },
    platformSchema: config.platformSchema,
    cache: createShapeCache(),
    reason: "",
    transferId: null,
  };
};

/**
 * Ruxsat MAQSAD filialda ham bo'lishi shart: ruxsatlar har filialda alohida
 * (`User.permissions`), odam esa maqsad bazaga kiritiladi. Owner — istisno.
 */
const assertActorInTarget = async (actor, ctx, permission) => {
  if (ctx.actor.isOwner) return;

  const access = await platformPrisma.userBranchAccess.findUnique({
    where: { userId_branchId: { userId: actor.id, branchId: ctx.target.id } },
  });
  const target = await branchService.findById(ctx.target.id);
  const profile = access
    ? await runWithBranch(target, () =>
        prisma.user.findUnique({
          where: { id: actor.id },
          select: { isActive: true, isArchived: true, permissions: true },
        }),
      )
    : null;

  if (!profile || !profile.isActive || profile.isArchived || !hasPermission(profile.permissions, permission)) {
    throw new ForbiddenError(
      `"${ctx.target.name}" filialida ham shu amalga ruxsatingiz bo'lishi kerak`,
    );
  }
};

/**
 * Manba, maqsad va platforma BITTA bazadami? `PLATFORM_DATABASE_URL`
 * qo'lda boshqa bazaga qaratilgan bo'lsa, bitta tranzaksiya kafolati yo'q —
 * ko'chirish umuman boshlanmaydi.
 */
const assertSameDatabase = async (db, ctx) => {
  const rows = await db.$queryRawUnsafe(
    `SELECT n FROM unnest($1::text[]) AS t(n) WHERE to_regnamespace(n) IS NULL`,
    [ctx.source.schemaName, ctx.target.schemaName, ctx.platformSchema],
  );
  if (rows.length > 0) {
    throw new ConflictError(
      "Filiallar va platforma bitta bazada emas — ko'chirishni bitta tranzaksiyada bajarib bo'lmaydi",
      { reason: "different_database" },
    );
  }
};

/** Barqaror JSON (kalitlar tartiblangan) → sha256. */
const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value instanceof Date ? value.toISOString() : value);
};
const hashOf = (value) => crypto.createHash("sha256").update(stableStringify(value)).digest("hex");

/** Javob — oldindan ko'rish (va tranzaksiya ichida xesh uchun). */
const describePlan = ({
  kind,
  mode,
  ctx,
  options,
  items,
  classes = null,
  acknowledgements,
  // Ta'lim tarixi uchun maqsadda ochiladigan katalog qatorlari. Xeshga
  // KIRADI: oraliqda o'sha filialda shu nomli fan/sinf ochilsa, reja
  // "ochiladi" deb ko'rsatgan narsa endi mavjud — odam buni qayta ko'rsin.
  historyCatalog = null,
}) => {
  const ready = items.filter((item) => item.status === "ready").length;
  const body = {
    kind,
    mode,
    source: { id: ctx.source.id, name: ctx.source.name },
    target: { id: ctx.target.id, name: ctx.target.name },
    effectiveDate: ctx.dayIso,
    effectiveDateLabel: dayLabel(ctx.day),
    lastSourceDayLabel: dayLabel(new Date(ctx.day.getTime() - 86400000)),
    monthLabel: formatMonthKey(ctx.month),
    options,
    items,
    ...(classes ? { classes } : {}),
    ...(historyCatalog ? { historyCatalog } : {}),
    counts: { total: items.length, ready, blocked: items.length - ready },
    acknowledgements,
  };
  return {
    ...body,
    planHash: hashOf(body),
    canExecute: items.length > 0 && ready === items.length,
  };
};

const assertAcknowledged = (acknowledgements, given) => {
  const set = new Set(Array.isArray(given) ? given.map(String) : []);
  const missing = acknowledgements.filter((ack) => !set.has(ack.code));
  if (missing.length) {
    throw new BadRequestError(
      `Tasdiqlanmagan oqibatlar: ${missing.map((ack) => ack.title).join("; ")}`,
      { reason: "not_acknowledged", codes: missing.map((ack) => ack.code) },
    );
  }
};

// ─────────────────────────────────────────────
// Jurnal
// ─────────────────────────────────────────────

const writeLog = async (db, ctx, { kind, mode, options, items, classes, details }) => {
  const plat = (t) => qualified(ctx.platformSchema, t);
  const logged = [
    ...(classes ?? []).map((c) => ({
      subjectType: "class",
      id: c.id,
      label: c.name,
      role: "",
      details: { targetClassName: c.targetName, merged: !c.create, students: c.studentIds.length },
    })),
    ...items.map((item) => ({
      subjectType: "user",
      id: item.id,
      label: item.label,
      role: item.role ?? "",
      details: details.get(item.id) ?? {},
    })),
  ];

  await db.$executeRawUnsafe(
    `INSERT INTO ${plat("branch_transfers")}
       (id, kind, mode, source_branch_id, target_branch_id, effective_date, reason, options,
        item_count, status, created_by, created_by_name, created_at)
     VALUES ($1, $2::text::${schemaType(ctx.platformSchema, "BranchTransferKind")},
             $3::text::${schemaType(ctx.platformSchema, "BranchTransferMode")}, $4, $5, $6::date, $7, $8::jsonb,
             $9, 'completed', $10, $11, NOW())`,
    ctx.transferId,
    kind,
    mode,
    ctx.source.id,
    ctx.target.id,
    ctx.dayIso,
    ctx.reason,
    JSON.stringify(options),
    items.length,
    ctx.actor.id,
    ctx.actor.name,
  );

  const itemIds = new Map();
  for (const entry of logged) {
    const id = generateId();
    itemIds.set(`${entry.subjectType}:${entry.id}`, id);
    await db.$executeRawUnsafe(
      `INSERT INTO ${plat("branch_transfer_items")}
         (id, transfer_id, subject_type, subject_id, label, role, details, warnings, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::text[], NOW())`,
      id,
      ctx.transferId,
      entry.subjectType,
      entry.id,
      entry.label,
      entry.role,
      JSON.stringify(entry.details),
      items.find((i) => i.id === entry.id)?.warnings ?? [],
    );
  }
  return itemIds;
};

/**
 * Tranzaksiyadan keyingi ogohlantirishlarni jurnalga qo'shadi. Bittasi
 * bo'lsa ham ko'chirish "e'tibor talab" bo'ladi.
 */
const recordAfterWarnings = async (ctx, itemIds, warnings) => {
  let any = false;
  for (const [userId, list] of warnings) {
    if (!list.length) continue;
    any = true;
    const itemId = itemIds.get(`user:${userId}`);
    if (!itemId) continue;
    try {
      await platformPrisma.branchTransferItem.update({
        where: { id: itemId },
        data: { warnings: { push: list } },
      });
    } catch (error) {
      logger.warn(`[branchTransfer] ogohlantirish yozilmadi (${itemId}): ${error.message}`);
    }
  }
  if (any) {
    await platformPrisma.branchTransfer
      .update({ where: { id: ctx.transferId }, data: { status: "attention" } })
      .catch((error) => logger.warn(`[branchTransfer] holat yozilmadi: ${error.message}`));
  }
  return any;
};

// ─────────────────────────────────────────────
// Umumiy bajaruvchi
// ─────────────────────────────────────────────

/**
 * Rejani tranzaksiyada qayta quradi, xeshni solishtiradi, yozadi va
 * jurnalga qo'shadi. Keyin tranzaksiyadan tashqari qadamlarni bajaradi.
 *
 * @param {object} spec
 * @param {object} spec.ctx
 * @param {string} spec.kind
 * @param {string} spec.mode
 * @param {object} spec.options
 * @param {object} spec.input - `planHash`, `acknowledged`
 * @param {(db: object) => Promise<object>} spec.plan - `describePlan` qaytaradi (+ ichki ma'lumot)
 * @param {(plan: object) => string[]} spec.lockKeys
 * @param {(db: object, plan: object) => Promise<Map>} spec.write
 * @param {(plan: object) => Promise<Map<string, string[]>>} spec.after
 */
const execute = async ({ ctx, kind, mode, options, input, plan, lockKeys, write, after }) => {
  if (!input.planHash || typeof input.planHash !== "string") {
    throw new BadRequestError("Avval ko'chirishni ko'rib chiqing");
  }
  ctx.reason = parseReason(input.reason);
  ctx.transferId = generateId();

  let committed = null;
  let itemIds = null;

  await platformPrisma.$transaction(async (tx) => {
    await assertSameDatabase(tx, ctx);
    await assertMigrationParity(tx, [ctx.source.schemaName, ctx.target.schemaName]);

    // Avval o'qib qulf kalitlarini aniqlaymiz, qulfdan KEYIN qayta o'qiymiz —
    // xesh qulf ostidagi holatdan
    const first = await plan(tx);
    await advisoryLock(tx, lockKeys(first));
    const current = await plan(tx);

    if (current.planHash !== input.planHash) {
      throw new ConflictError(
        "Ko'rib chiqilgandan keyin ma'lumot o'zgardi — qayta ko'rib chiqing",
        { reason: "stale_plan" },
      );
    }
    if (!current.canExecute) {
      throw new BadRequestError("Ro'yxatda ko'chirib bo'lmaydiganlar bor — ularni olib tashlang");
    }
    assertAcknowledged(current.acknowledgements, input.acknowledged);

    const userIds = current.items.map((item) => item.id);
    await tx.$executeRawUnsafe(
      `SELECT id FROM ${qualified(ctx.source.schemaName, "users")} WHERE id = ANY($1::text[]) FOR UPDATE`,
      userIds,
    );

    const details = await write(tx, current);
    itemIds = await writeLog(tx, ctx, {
      kind,
      mode,
      options,
      items: current.items,
      classes: current.classes,
      details,
    });
    committed = current;
  }, TX_OPTIONS);

  logger.info(
    `[branchTransfer] ${kind}/${mode}: ${committed.items.length} ta — ` +
      `"${ctx.source.name}" → "${ctx.target.name}" (${ctx.dayIso}) actor=${ctx.actor.id} id=${ctx.transferId}`,
  );

  let warnings = new Map();
  try {
    warnings = await after(committed);
  } catch (error) {
    logger.error(`[branchTransfer] keyingi qadamlar yiqildi (${ctx.transferId}): ${error.message}`);
    warnings = new Map(
      committed.items.map((item) => [item.id, [`Keyingi qadamlar bajarilmadi: ${error.message}`]]),
    );
  }
  const attention = await recordAfterWarnings(ctx, itemIds, warnings);
  const what = committed.classes
    ? `${committed.classes.length} ta sinf (${committed.items.length} ta o'quvchi)`
    : `${committed.items.length} ta`;

  return {
    transferId: ctx.transferId,
    status: attention ? "attention" : "completed",
    source: { id: ctx.source.id, name: ctx.source.name },
    target: { id: ctx.target.id, name: ctx.target.name },
    count: committed.items.length,
    items: committed.items.map((item) => ({
      id: item.id,
      label: item.label,
      warnings: warnings.get(item.id) ?? [],
    })),
    message: attention
      ? `${what} ko'chirildi, lekin ba'zi qadamlar qo'lda hal qilinishi kerak`
      : `${what} "${ctx.target.name}" filialiga ko'chirildi`,
  };
};

// ─────────────────────────────────────────────
// O'QUVCHILAR
// ─────────────────────────────────────────────

const parseStudentOptions = (input) => ({
  tariffMode: input.tariffMode === "targetDefault" ? "targetDefault" : "keep",
  keepDiscounts: input.keepDiscounts !== false,
  targetClassId: input.targetClassId ? String(input.targetClassId) : null,
});

/** Maqsad sinf (ixtiyoriy) — maqsad filialda faol bo'lishi shart. */
const loadTargetClass = async (db, ctx, classId) => {
  if (!classId) return null;
  if (!isValidId(classId)) throw new BadRequestError("Noto'g'ri sinf");
  const [row] = await db.$queryRawUnsafe(
    `SELECT id, name, is_active AS "isActive" FROM ${qualified(ctx.target.schemaName, "classes")} WHERE id = $1`,
    classId,
  );
  if (!row) throw new NotFoundError(`"${ctx.target.name}" filialida bunday sinf topilmadi`);
  if (!row.isActive) throw new BadRequestError("Tanlangan sinf faol emas");
  return row;
};

const studentPlanFn = (ctx, ids, options) => async (db) => {
  const targetClass = await loadTargetClass(db, ctx, options.targetClassId);
  const targetClassIds = new Map(ids.map((id) => [id, targetClass ? [targetClass.id] : []]));
  const { items, acknowledgements, historyCatalog } = await studentTransfer.planStudents(
    db,
    ctx,
    ids,
    { ...options, targetClassIds },
  );
  return describePlan({
    kind: KINDS.STUDENT,
    mode: "move",
    ctx,
    options: { ...options, targetClassName: targetClass?.name ?? null },
    items,
    acknowledgements,
    historyCatalog,
  });
};

const studentLockKeys = (plan) =>
  plan.items.flatMap((item) => [`branch_transfer:user:${item.id}`, `student_classes:${item.id}`]);

const previewStudents = async (actor, input) => {
  const ctx = await buildContext(actor, input);
  await assertActorInTarget(actor, ctx, PERMISSIONS.TRANSFERS_STUDENTS);
  const ids = parseIds(input.studentIds, "o'quvchi", LIMITS.students);
  return studentPlanFn(ctx, ids, parseStudentOptions(input))(platformPrisma);
};

const transferStudents = async (actor, input) => {
  const ctx = await buildContext(actor, input);
  await assertActorInTarget(actor, ctx, PERMISSIONS.TRANSFERS_STUDENTS);
  const ids = parseIds(input.studentIds, "o'quvchi", LIMITS.students);
  const options = parseStudentOptions(input);

  return execute({
    ctx,
    kind: KINDS.STUDENT,
    mode: "move",
    options,
    input,
    plan: studentPlanFn(ctx, ids, options),
    lockKeys: studentLockKeys,
    write: (db, plan) => studentTransfer.writeStudents(db, ctx, plan.items, plan.historyCatalog),
    after: (plan) => studentTransfer.afterStudents(ctx, plan.items),
  });
};

// ─────────────────────────────────────────────
// XODIMLAR
// ─────────────────────────────────────────────

const parseStaffOptions = (input, ctx) => {
  const mode = input.mode === "move" ? "move" : input.mode === "share" ? "share" : null;
  if (!mode) throw new BadRequestError("Ko'chirish turini tanlang");
  const permissionsMode = input.permissionsMode === "copy" ? "copy" : "roleDefaults";
  // Ruxsatlarni nusxalash = boshqa filialda kassa/moliya huquqini berish.
  // Faqat owner (har filialda hamma huquqqa ega) buni qila oladi.
  if (permissionsMode === "copy" && !ctx.actor.isOwner) {
    throw new ForbiddenError("Ruxsatlarni nusxalash faqat tizim egasiga mumkin");
  }
  return {
    mode,
    keepSource: mode === "move" ? Boolean(input.keepSource) : true,
    role: input.role ? String(input.role) : null,
    permissionsMode,
  };
};

const staffPlanFn = (ctx, ids, options) => async (db) => {
  const { items, acknowledgements } = await staffTransfer.planStaff(db, ctx, ids, options);
  return describePlan({ kind: KINDS.STAFF, mode: options.mode, ctx, options, items, acknowledgements });
};

const previewStaff = async (actor, input) => {
  const ctx = await buildContext(actor, input);
  await assertActorInTarget(actor, ctx, PERMISSIONS.TRANSFERS_STAFF);
  const ids = parseIds(input.staffIds, "xodim", LIMITS.staff);
  return staffPlanFn(ctx, ids, parseStaffOptions(input, ctx))(platformPrisma);
};

const transferStaff = async (actor, input) => {
  const ctx = await buildContext(actor, input);
  await assertActorInTarget(actor, ctx, PERMISSIONS.TRANSFERS_STAFF);
  const ids = parseIds(input.staffIds, "xodim", LIMITS.staff);
  const options = parseStaffOptions(input, ctx);
  if (ids.includes(actor.id) && options.mode === "move" && !options.keepSource) {
    throw new BadRequestError("O'zingizni shu filialdan chiqarib bo'lmaydi");
  }

  return execute({
    ctx,
    kind: KINDS.STAFF,
    mode: options.mode,
    options,
    input,
    plan: staffPlanFn(ctx, ids, options),
    lockKeys: (plan) => plan.items.map((item) => `branch_transfer:user:${item.id}`),
    write: (db, plan) => staffTransfer.writeStaff(db, ctx, plan.items, options),
    after: (plan) => staffTransfer.afterStaff(ctx, plan.items, options),
  });
};

// ─────────────────────────────────────────────
// SINFLAR — sinf o'quvchilari bilan birga
// ─────────────────────────────────────────────
//
// Sinf maqsad filialda AYNI nom bilan ochiladi (shu nomli sinf bo'lsa —
// o'quvchilar unga qo'shiladi). Har bir o'quvchi o'quvchi ko'chirishining
// O'ZI bilan ko'chadi (bitta yadro). Manba filialdagi sinf qatori QOLADI:
// baholar, davomat, hisob-faktura snapshot'lari unga ishora qiladi.
//
// ⚠️ DARS JADVALI KO'CHMAYDI: o'qituvchi va fanlar har filialning o'ziniki.
// Manba filialdagi jadvaliga TEGILMAYDI — jadval sanasiz shablon, uni oy
// o'rtasida o'chirish shu oy allaqachon o'tilgan darslarni ham o'qituvchi
// oyligidan olib tashlardi. Oldindan ko'rishda aytiladi.

const classPlanFn = (ctx, classIds, options) => async (db) => {
  const src = (t) => qualified(ctx.source.schemaName, t);
  const tgt = (t) => qualified(ctx.target.schemaName, t);
  const q = (sql, ...params) => db.$queryRawUnsafe(sql, ...params);

  const classes = await q(
    `SELECT id, name, capacity FROM ${src("classes")} WHERE id = ANY($1::text[]) ORDER BY name`,
    classIds,
  );
  if (classes.length !== classIds.length) throw new NotFoundError("Tanlangan sinflardan biri topilmadi");

  const targetClasses = await q(
    `SELECT id, name, is_active AS "isActive" FROM ${tgt("classes")} WHERE name = ANY($1::text[])`,
    classes.map((c) => c.name),
  );
  const members = await q(
    `SELECT uc.class_id AS "classId", u.id AS "studentId" FROM ${src("user_classes")} uc
     JOIN ${src("users")} u ON u.id = uc.user_id
     WHERE uc.class_id = ANY($1::text[]) AND u.role = 'student' AND u.is_archived = false
     ORDER BY u.id`,
    classIds,
  );
  const studentIds = [...new Set(members.map((m) => m.studentId))].sort();
  const otherClasses = studentIds.length
    ? await q(
        `SELECT uc.user_id AS "studentId", c.name FROM ${src("user_classes")} uc
         JOIN ${src("classes")} c ON c.id = uc.class_id
         WHERE uc.user_id = ANY($1::text[]) AND NOT (uc.class_id = ANY($2::text[]))`,
        studentIds,
        classIds,
      )
    : [];
  // DARS JADVALI — sanoq emas, TO'LIQ reja: qaysi dars ko'chadi, qaysi biri
  // (o'qituvchi maqsadda yo'q / band) qo'lda qoladi
  const schedulePlans = await scheduleTransfer.planClassSchedules(db, ctx, classes);
  const tutorGroups = await q(
    `SELECT id, class_id AS "classId" FROM ${src("tutor_groups")}
     WHERE class_id = ANY($1::text[]) AND (end_month IS NULL OR end_month >= $2)`,
    classIds,
    ctx.month,
  );

  const targetByName = new Map(targetClasses.map((c) => [c.name, c]));
  const classPlans = classes.map((c) => {
    const existing = targetByName.get(c.name) ?? null;
    const memberIds = members.filter((m) => m.classId === c.id).map((m) => m.studentId);
    const otherNames = [
      ...new Set(otherClasses.filter((o) => memberIds.includes(o.studentId)).map((o) => o.name)),
    ];
    const warnings = [];
    const notes = [];
    if (existing) {
      notes.push(`"${ctx.target.name}" filialida "${c.name}" sinfi bor — o'quvchilar unga qo'shiladi`);
      if (!existing.isActive) {
        notes.push(
          `"${ctx.target.name}" dagi "${c.name}" sinfi hozir nofaol (tarix uchun ochilgan) — ` +
            "ko'chirishda u FAOLLASHTIRILADI",
        );
      }
    } else {
      notes.push(`"${ctx.target.name}" filialida "${c.name}" sinfi ochiladi`);
    }
    const schedule = schedulePlans.get(c.id) ?? null;
    if (schedule) {
      notes.push(
        `Dars jadvali ko'chadi: ${schedule.total} ta darsdan ${schedule.moving} tasi yangi ` +
          `filialga yoziladi; shu filialdagi jadval ${formatMonthKey(schedule.removalMonth)} ` +
          "boshida olib tashlanadi",
      );
      const missing = schedule.skipped.filter((l) => l.reason === "teacher_missing");
      if (missing.length) {
        warnings.push(
          `${missing.length} ta dars o'qituvchisiz qoladi — ` +
            `${[...new Set(missing.map((l) => l.teacher))].join(", ")} yangi filialda yo'q. ` +
            "Avval xodimni ko'chiring/ulashing yoki jadvalni qo'lda to'ldiring",
        );
      }
      const busy = schedule.skipped.filter((l) => l.reason === "teacher_busy");
      if (busy.length) {
        warnings.push(
          `${busy.length} ta dars ko'chmaydi — o'qituvchi yangi filialda o'sha katakda band ` +
            `(${[...new Set(busy.map((l) => l.teacher))].join(", ")})`,
        );
      }
    }
    const groups = tutorGroups.filter((g) => g.classId === c.id);
    if (groups.length) {
      warnings.push(`Sinf tyutor guruhi ${formatMonthKey(ctx.month)} oxirida yopiladi`);
    }
    if (otherNames.length) {
      warnings.push(
        `O'quvchilarning bir qismi boshqa sinflarda ham bor (${otherNames.join(", ")}) — ` +
          "ular o'sha sinflardan ham chiqadi (o'quvchi butunlay ko'chadi)",
      );
    }
    if (memberIds.length === 0) notes.push("Sinfda o'quvchi yo'q — faqat sinf ochiladi");
    return {
      id: c.id,
      name: c.name,
      capacity: c.capacity,
      create: !existing,
      targetId: existing?.id ?? `new:${c.id}`,
      targetName: c.name,
      studentIds: memberIds,
      tutorGroupIds: groups.map((g) => g.id),
      schedule,
      warnings,
      notes,
    };
  });

  const targetClassIds = new Map(studentIds.map((id) => [id, []]));
  for (const cp of classPlans) {
    for (const id of cp.studentIds) targetClassIds.get(id).push(cp.targetId);
  }

  const { items, acknowledgements, historyCatalog } = studentIds.length
    ? await studentTransfer.planStudents(db, ctx, studentIds, { ...options, targetClassIds })
    : { items: [], acknowledgements: [], historyCatalog: null };

  const withSchedule = classPlans.filter((cp) => cp.schedule);
  if (withSchedule.length) {
    const moving = withSchedule.reduce((sum, cp) => sum + cp.schedule.moving, 0);
    const total = withSchedule.reduce((sum, cp) => sum + cp.schedule.total, 0);
    const removalMonth = formatMonthKey(withSchedule[0].schedule.removalMonth);
    acknowledgements.push(
      moving > 0
        ? {
            code: "schedule_moves",
            title: "Dars jadvali ko'chadi, bu filialdan keyingi oydan o'chadi",
            message:
              `${total} ta darsdan ${moving} tasi yangi filial jadvaliga yoziladi (fan nomi ` +
              "bo'yicha moslanadi, o'qituvchi esa o'sha filialda bor bo'lsa). Shu filialdagi " +
              `jadval DARHOL emas, ${removalMonth} boshida olib tashlanadi: jadval sanasiz ` +
              "shablon va uni oy o'rtasida o'chirish shu oy ALLAQACHON O'TILGAN darslarni ham " +
              "o'qituvchi oyligidan olib tashlardi. Ko'chishdan keyingi darslar baribir " +
              "o'tilmagan hisoblanadi.",
          }
        : {
            // ⚠️ Birorta dars ko'chmasa manbadagi jadval ham O'CHIRILMAYDI:
            // aks holda jadval ikkala filialdan ham yo'qolardi
            code: "schedule_manual",
            title: "Dars jadvali ko'chmaydi — yangi filialda qo'lda tuziladi",
            message:
              `${total} ta darsning birortasi ham yangi filialga yozilmaydi, chunki ularning ` +
              "o'qituvchilari o'sha filialda yo'q (xodim nomi bo'yicha moslanmaydi — u login, " +
              "ruxsat va oylik egasi). Shuning uchun shu filialdagi jadval ham O'CHIRILMAYDI. " +
              "Avval o'qituvchilarni yangi filialga ko'chiring yoki ulashing, so'ng jadvalni " +
              "o'sha yerda tuzing; keyin bu filialdagi darslarni jadvaldan olib tashlang.",
          },
    );
  }

  const described = describePlan({
    kind: KINDS.CLASS,
    mode: "move",
    ctx,
    options,
    items,
    classes: classPlans,
    acknowledgements,
    historyCatalog,
  });
  // Bo'sh sinf ham ko'chiriladi (faqat sinf ochiladi)
  return { ...described, canExecute: described.counts.blocked === 0 && classPlans.length > 0 };
};

const parseClassOptions = (input) => ({
  tariffMode: input.tariffMode === "targetDefault" ? "targetDefault" : "keep",
  keepDiscounts: input.keepDiscounts !== false,
});

const previewClasses = async (actor, input) => {
  const ctx = await buildContext(actor, input);
  await assertActorInTarget(actor, ctx, PERMISSIONS.TRANSFERS_CLASSES);
  const ids = parseIds(input.classIds, "sinf", LIMITS.classes);
  const plan = await classPlanFn(ctx, ids, parseClassOptions(input))(platformPrisma);
  if (plan.items.length > LIMITS.students) {
    throw new BadRequestError(
      `Tanlangan sinflarda ${plan.items.length} ta o'quvchi — bir martada ko'pi bilan ${LIMITS.students} ta`,
    );
  }
  return plan;
};

const transferClasses = async (actor, input) => {
  const ctx = await buildContext(actor, input);
  await assertActorInTarget(actor, ctx, PERMISSIONS.TRANSFERS_CLASSES);
  const ids = parseIds(input.classIds, "sinf", LIMITS.classes);
  const options = parseClassOptions(input);

  return execute({
    ctx,
    kind: KINDS.CLASS,
    mode: "move",
    options,
    input,
    plan: classPlanFn(ctx, ids, options),
    lockKeys: (plan) => [
      ...ids.map((id) => `branch_transfer:class:${ctx.source.schemaName}:${id}`),
      ...studentLockKeys(plan),
    ],
    write: async (db, plan) => {
      // Yangi sinflar — `id` endi tug'iladi (rejada `new:<id>` belgisi edi:
      // xesh oldindan ko'rish va tasdiqlashda bir xil bo'lishi uchun)
      const realId = new Map();
      for (const cp of plan.classes) {
        if (!cp.create) continue;
        const id = generateId();
        realId.set(cp.targetId, id);
        await db.$executeRawUnsafe(
          `INSERT INTO ${qualified(ctx.target.schemaName, "classes")}
             (id, name, is_active, created_by, created_at, updated_at, capacity)
           VALUES ($1, $2, true, $3, NOW(), NOW(), $4)`,
          id,
          cp.name,
          ctx.actor.id,
          cp.capacity ?? null,
        );
      }
      // Haqiqiy maqsad `id` rejaning o'ziga yoziladi: tranzaksiyadan
      // keyingi qadam (jadval nusxasi) shu obyektni oladi
      for (const cp of plan.classes) cp.resolvedTargetId = realId.get(cp.targetId) ?? cp.targetId;

      // ⚠️ NOFAOL SINF FAOLLASHTIRILADI. Maqsadda shu nomli sinf allaqachon
      // bo'lishi mumkin — masalan oldingi ko'chirishda TARIX uchun nofaol
      // ochilgani (`mapClasses`, `active: false`). Endi u yerda haqiqatan
      // dars o'tiladi: nofaol qoldirilsa sinf joriy ro'yxatlarda, jurnalda
      // va davomatda umuman ko'rinmasdi.
      const attaching = plan.classes.map((cp) => cp.resolvedTargetId).filter(Boolean);
      if (attaching.length) {
        await db.$executeRawUnsafe(
          `UPDATE ${qualified(ctx.target.schemaName, "classes")}
           SET is_active = true, updated_at = NOW()
           WHERE id = ANY($1::text[]) AND is_active = false`,
          attaching,
        );
      }

      // Jadvalni manbadan olib tashlash NAVBATI — ko'chirish bilan bitta
      // atomda. Maqsadga nusxalash o'tmasa, navbat keyin bekor qilinadi.
      await scheduleTransfer.queueSourceRemoval(db, ctx, plan.classes);

      const items = plan.items.map((item) => ({
        ...item,
        plan: {
          ...item.plan,
          targetClassIds: item.plan.targetClassIds.map((id) => realId.get(id) ?? id),
        },
      }));
      return items.length
        ? studentTransfer.writeStudents(db, ctx, items, plan.historyCatalog)
        : new Map();
    },
    after: async (plan) => {
      const warnings = plan.items.length
        ? await studentTransfer.afterStudents(ctx, plan.items)
        : new Map();

      // ── DARS JADVALI MAQSAD FILIALGA ──
      // Tranzaksiyadan TASHQARIDA: amaldagi jadvalga yozadigan har yo'l
      // `withScheduleWriteLock` + `assertPlatformMode` dan o'tadi
      // (`education.md` §10), u esa filialga bog'langan tranzaksiya.
      const scheduled = plan.classes
        .filter((cp) => cp.schedule)
        .map((cp) => ({
          id: cp.id,
          name: cp.name,
          targetId: cp.resolvedTargetId ?? cp.targetId,
          schedule: cp.schedule,
        }));
      if (scheduled.length) {
        const copy = await scheduleTransfer.copySchedulesToTarget(ctx, scheduled);
        if (copy.failedClassIds.length) {
          await scheduleTransfer
            .cancelQueuedRemoval(
              ctx,
              copy.failedClassIds,
              "Jadval yangi filialga nusxalanmadi — shu filialda qoldirildi",
            )
            .catch((error) =>
              logger.warn(`[branchTransfer] jadval navbati bekor qilinmadi: ${error.message}`),
            );
        }
        // Sinf ogohlantirishi o'sha sinfning BIRINCHI o'quvchisi qatoriga
        // yoziladi (jurnal odam bo'yicha tuzilgan); o'quvchisiz sinfda
        // faqat logga tushadi
        for (const message of copy.warnings) {
          const anchor = plan.items[0]?.id;
          if (anchor && warnings.has(anchor)) warnings.get(anchor).push(message);
          else logger.warn(`[branchTransfer] ${message}`);
        }
      }
      // Sinf tyutor guruhi "keyingi oydan" yopiladi: ko'chish oyi shu filialda
      await runWithBranch(ctx.source, async () => {
        const { removeGroup } = require("./tutorGroup.service");
        for (const cp of plan.classes) {
          for (const groupId of cp.tutorGroupIds) {
            try {
              await removeGroup(groupId, { effective: "next" }, ctx.actor.id);
            } catch (error) {
              const first = cp.studentIds[0];
              if (first && warnings.has(first)) {
                warnings.get(first).push(`"${cp.name}" tyutor guruhi yopilmadi — qo'lda yoping (${error.message})`);
              }
              logger.warn(`[branchTransfer] sinf tyutor guruhi ${groupId} yopilmadi: ${error.message}`);
            }
          }
        }
      });
      return warnings;
    },
  });
};

/**
 * Maqsad filialning faol sinflari — o'quvchini ko'chirishda darhol sinfga
 * biriktirish uchun. Faqat o'sha filialga kira oladigan (yoki owner) ko'radi.
 */
const listTargetClasses = async (actor, branchId) => {
  if (!branchId || !isValidId(String(branchId))) throw new BadRequestError("Filialni tanlang");
  const target = await branchService.getUsableById(String(branchId));
  if (!hasRole(actor, ROLES.OWNER)) {
    const access = await platformPrisma.userBranchAccess.findUnique({
      where: { userId_branchId: { userId: actor.id, branchId: target.id } },
    });
    if (!access) throw new ForbiddenError(`"${target.name}" filialiga kirish huquqingiz yo'q`);
  }
  return runWithBranch(target, () =>
    prisma.class.findMany({
      where: { isActive: true },
      select: { id: true, name: true, capacity: true },
      orderBy: { name: "asc" },
    }),
  );
};

// ─────────────────────────────────────────────
// JURNAL VA TARIX
// ─────────────────────────────────────────────

const serializeTransfer = (row) => ({
  id: row.id,
  kind: row.kind,
  mode: row.mode,
  status: row.status,
  source: { id: row.sourceBranchId, name: row.sourceBranch?.name ?? "—" },
  target: { id: row.targetBranchId, name: row.targetBranch?.name ?? "—" },
  effectiveDate: toIso(row.effectiveDate),
  effectiveDateLabel: dayLabel(row.effectiveDate),
  reason: row.reason,
  options: row.options,
  itemCount: row.itemCount,
  createdBy: { id: row.createdBy, name: row.createdByName },
  createdAt: row.createdAt,
  createdAtLabel: formatDateTimeUz(row.createdAt),
  items: (row.items ?? []).map((item) => ({
    id: item.id,
    subjectType: item.subjectType,
    subjectId: item.subjectId,
    label: item.label,
    role: item.role,
    details: item.details,
    warnings: item.warnings,
  })),
});

/**
 * Ko'chirishlar jurnali. Owner hammasini, qolganlar faqat JORIY filialga
 * tegishlisini (chiqgan yoki kirgan) ko'radi.
 */
const listTransfers = async (req) => {
  const { page, limit, skip } = getPaginationParams(req, 20);
  const current = getBranch();
  const isOwner = hasRole(req.user, ROLES.OWNER);
  const { kind, search, direction } = req.query;

  const where = {};
  if (!isOwner || direction) {
    if (direction === "out") where.sourceBranchId = current.id;
    else if (direction === "in") where.targetBranchId = current.id;
    else where.OR = [{ sourceBranchId: current.id }, { targetBranchId: current.id }];
  }
  if (Object.values(KINDS).includes(kind)) where.kind = kind;
  if (search?.trim()) {
    where.items = { some: { label: { contains: search.trim(), mode: "insensitive" } } };
  }

  const [rows, total] = await Promise.all([
    platformPrisma.branchTransfer.findMany({
      where,
      include: {
        sourceBranch: { select: { name: true } },
        targetBranch: { select: { name: true } },
        items: { orderBy: [{ subjectType: "asc" }, { label: "asc" }] },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    platformPrisma.branchTransfer.count({ where }),
  ]);

  return formatPaginationResponse(rows.map(serializeTransfer), total, page, limit);
};

/** Bitta odamning filiallararo tarixi (profil kartasi). */
const getUserTransfers = async (userId) => {
  const items = await platformPrisma.branchTransferItem.findMany({
    where: { subjectType: "user", subjectId: userId },
    include: {
      transfer: {
        include: {
          sourceBranch: { select: { name: true } },
          targetBranch: { select: { name: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return items.map((item) => ({
    ...serializeTransfer({ ...item.transfer, items: [] }),
    item: { label: item.label, details: item.details, warnings: item.warnings },
  }));
};

/**
 * XODIMNING OYLIGI FILIALLAR KESIMIDA — "bir filialda to'langan oylik
 * ikkinchisida ham ko'rinsin".
 *
 * Har oy uchun: asosiy oylik EGASI qaysi filial (`payrollOwnership`) va har
 * filialdagi majburiyat (summa, to'langani, holati). Pul faqat o'z filialida
 * to'lanadi, bu yerda faqat KO'RINADI.
 *
 * @param {string} userId
 * @param {{months?: number}} options
 */
const getStaffPayrollAcrossBranches = async (userId, { months = 6 } = {}) => {
  const count = Math.min(Math.max(Number.parseInt(months, 10) || 6, 1), 12);
  const keys = [];
  let m = currentMonthKey();
  for (let i = 0; i < count; i += 1) {
    keys.push(m);
    m = prevMonth(m);
  }

  // Odam bo'lgan filiallar: hozirgi biriktirishlar + ko'chirish tarixidagilar
  const [access, transferRows, owners] = await Promise.all([
    platformPrisma.userBranchAccess.findMany({ where: { userId }, select: { branchId: true } }),
    platformPrisma.branchTransferItem.findMany({
      where: { subjectType: "user", subjectId: userId },
      select: { transfer: { select: { sourceBranchId: true, targetBranchId: true } } },
    }),
    platformPrisma.payrollMonthOwner.findMany({
      where: { userId, month: { in: keys } },
      select: { month: true, branchId: true },
    }),
  ]);
  const branchIds = new Set([
    ...access.map((a) => a.branchId),
    ...transferRows.flatMap((r) => [r.transfer.sourceBranchId, r.transfer.targetBranchId]),
  ]);
  const current = getBranch();
  if (current) branchIds.add(current.id);

  const branches = (await Promise.all([...branchIds].map((id) => branchService.findById(id)))).filter(Boolean);
  const perBranch = await Promise.all(
    branches.map(async (branch) => {
      try {
        const entries = await runWithBranch(branch, () =>
          prisma.payrollEntry.findMany({
            where: { staffId: userId, month: { in: keys }, status: { not: "cancelled" } },
            select: {
              month: true,
              amount: true,
              paidAmount: true,
              status: true,
              fixedAmount: true,
              kpiAmount: true,
              allowanceAmount: true,
            },
          }),
        );
        return { branch, entries };
      } catch (error) {
        logger.warn(`[branchTransfer] "${branch.name}" oyliklari o'qilmadi: ${error.message}`);
        return { branch, entries: [] };
      }
    }),
  );

  const ownerOf = new Map(owners.map((o) => [o.month, o.branchId]));
  const { resolveOwners } = require("./payrollOwnership.service");
  const nameOf = new Map(branches.map((b) => [b.id, b.name]));

  const rows = [];
  for (const month of keys) {
    let ownerId = ownerOf.get(month) ?? null;
    if (!ownerId) ownerId = (await resolveOwners(month, [userId])).get(userId)?.branchId ?? null;
    const lines = perBranch
      .map(({ branch, entries }) => {
        const entry = entries.find((e) => e.month === month);
        if (!entry) return null;
        return {
          branch: { id: branch.id, name: branch.name },
          isCurrent: branch.id === current?.id,
          amount: formatAmount(entry.amount),
          paidAmount: formatAmount(entry.paidAmount),
          status: entry.status,
          fixedAmount: formatAmount(entry.fixedAmount),
          kpiAmount: formatAmount(entry.kpiAmount),
          allowanceAmount: formatAmount(entry.allowanceAmount),
        };
      })
      .filter(Boolean);
    rows.push({
      month,
      monthLabel: formatMonthKey(month),
      owner: ownerId ? { id: ownerId, name: nameOf.get(ownerId) ?? "boshqa filial" } : null,
      pinned: ownerOf.has(month),
      branches: lines,
    });
  }

  return {
    branches: branches.map((b) => ({ id: b.id, name: b.name, isCurrent: b.id === current?.id })),
    months: rows,
  };
};

/**
 * O'QUVCHINING BOSHQA FILIALLARDAGI MOLIYA TARIXI.
 *
 * Ko'chishda OCHIQ holat (qarz va depozit) o'quvchi bilan ketadi, YOPILGAN
 * fakt esa o'z filialida qoladi: to'langan oy va uning cheki o'sha filial
 * kassasiga tushgan pul (`branchTransferFinance.service.js` sarlavhasi).
 *
 * Shu sababli tarix NUSXALANMAYDI — u shu yerda JONLI o'qiladi. Nusxa
 * olinganda bitta to'lov ikki filialning tushum hisobotida ikki marta
 * sanalardi; jonli o'qishda esa har qator faqat o'z filialida bir marta
 * turadi va keyin o'zgarsa ham mos qoladi.
 *
 * `getStaffPayrollAcrossBranches` bilan AYNI naqsh: filiallar o'quvchining
 * uy filiali va ko'chirish jurnalidan topiladi, har biri `runWithBranch`
 * bilan alohida o'qiladi va yiqilgani butun javobni yiqitmaydi.
 *
 * @param {string} studentId
 * @param {{limit?: number}} options
 */
const getStudentFinanceAcrossBranches = async (studentId, { limit = 50 } = {}) => {
  const take = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);

  const [directory, transferRows] = await Promise.all([
    platformPrisma.userDirectory.findUnique({
      where: { id: studentId },
      select: { branchId: true },
    }),
    platformPrisma.branchTransferItem.findMany({
      where: { subjectType: "user", subjectId: studentId },
      select: { transfer: { select: { sourceBranchId: true, targetBranchId: true } } },
    }),
  ]);

  const current = getBranch();

  // ⚠️ FAQAT SHU FILIALGA ALOQADOR O'QUVCHI. `finance.view` — joriy
  // filialning huquqi; usiz har qanday `id` bilan begona filialning
  // moliyaviy ma'lumotini o'qib olish mumkin bo'lardi. Aloqador degani:
  // o'quvchining shu filialda qatori bor (hozir yoki arxivda), yoki
  // ko'chirish jurnalida shu filial qatnashgan.
  const here = await prisma.user
    .findUnique({ where: { id: studentId }, select: { id: true } })
    .catch(() => null);
  const involved =
    Boolean(here) ||
    transferRows.some(
      (r) =>
        r.transfer.sourceBranchId === current?.id || r.transfer.targetBranchId === current?.id,
    );
  if (!involved) {
    throw new ForbiddenError("Bu o'quvchi shu filialga aloqador emas");
  }
  const branchIds = new Set([
    ...(directory?.branchId ? [directory.branchId] : []),
    ...transferRows.flatMap((r) => [r.transfer.sourceBranchId, r.transfer.targetBranchId]),
  ]);
  branchIds.delete(current?.id);
  if (branchIds.size === 0) return { branches: [] };

  const branches = (
    await Promise.all([...branchIds].map((id) => branchService.findById(id)))
  ).filter(Boolean);

  const rows = await Promise.all(
    branches.map(async (branch) => {
      try {
        const data = await runWithBranch(branch, async () => {
          const [invoices, payments, account] = await Promise.all([
            prisma.monthlyInvoice.findMany({
              where: { studentId },
              select: {
                id: true,
                month: true,
                amount: true,
                paidAmount: true,
                status: true,
                cancelReason: true,
              },
              orderBy: { month: "desc" },
              take,
            }),
            prisma.payment.findMany({
              where: { studentId },
              select: {
                id: true,
                receiptNo: true,
                amount: true,
                paidAt: true,
                isVoided: true,
                note: true,
                account: { select: { name: true } },
              },
              orderBy: { paidAt: "desc" },
              take,
            }),
            prisma.studentAccount.findUnique({
              where: { studentId },
              select: { balance: true },
            }),
          ]);
          return { invoices, payments, account };
        });

        const live = data.invoices.filter((row) => row.status !== "cancelled");
        const paidTotal = sumAmounts(
          data.payments.filter((row) => !row.isVoided).map((row) => row.amount),
        );
        return {
          branch: { id: branch.id, name: branch.name },
          totals: {
            billed: formatAmount(sumAmounts(live.map((row) => row.amount))),
            paid: formatAmount(paidTotal),
            debt: formatAmount(
              sumAmounts(
                live
                  .map((row) => new Decimal(row.amount).minus(row.paidAmount))
                  .filter((value) => value.greaterThan(0)),
              ),
            ),
            deposit: formatAmount(data.account?.balance ?? 0),
          },
          invoices: data.invoices.map((row) => ({
            id: row.id,
            month: row.month,
            monthLabel: formatMonthKey(row.month),
            amount: formatAmount(row.amount),
            paidAmount: formatAmount(row.paidAmount),
            status: row.status,
            cancelReason: row.cancelReason,
          })),
          payments: data.payments.map((row) => ({
            id: row.id,
            receiptNo: row.receiptNo,
            amount: formatAmount(row.amount),
            paidAt: row.paidAt,
            paidAtLabel: formatDateUz(row.paidAt),
            accountName: row.account?.name ?? "—",
            isVoided: row.isVoided,
            note: row.note,
          })),
        };
      } catch (error) {
        logger.warn(
          `[branchTransfer] "${branch.name}" moliya tarixi o'qilmadi: ${error.message}`,
        );
        return {
          branch: { id: branch.id, name: branch.name },
          error: "Ma'lumot o'qilmadi",
          totals: null,
          invoices: [],
          payments: [],
        };
      }
    }),
  );

  // Butunlay bo'sh filial ko'rsatilmaydi: o'quvchi u yerda hech qachon
  // bo'lmagan (masalan, faqat sinf ko'chirish jurnalida uchragan)
  return {
    branches: rows.filter(
      (row) => row.error || row.invoices.length > 0 || row.payments.length > 0,
    ),
  };
};

module.exports = {
  KINDS,
  LIMITS,
  PERMISSION_FOR,
  previewStudents,
  transferStudents,
  previewStaff,
  transferStaff,
  previewClasses,
  transferClasses,
  listTargetClasses,
  listTransfers,
  getUserTransfers,
  getStaffPayrollAcrossBranches,
  getStudentFinanceAcrossBranches,
  // test uchun
  stableStringify,
  parseEffectiveDate,
};
