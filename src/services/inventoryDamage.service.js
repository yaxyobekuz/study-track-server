/**
 * ZARAR HODISASI — MUHRLANGAN FAKT (`MonthlyInvoice` doktrinasi).
 *
 *   amount = quantity × unitPrice     ← MUHRLANADI
 *
 * ⚠️ `amount` NI O'ZGARTIRADIGAN ENDPOINT YO'Q. Katalogdagi narx keyin
 * to'g'rilansa bu qatorga tegilmaydi: hodisa o'z kunidagi narxda qoladi.
 * Xato bo'lsa yagona yo'l — bekor qilish (`cancelled`) va qayta kiritish.
 *
 * ── UCH XIL "ZARAR YO'Q" HOLATI, UCHTASI HAM BOSHQA ──
 *
 *   pending   — zarar bor, aybdor HALI aniqlanmagan (tergov davom etyapti)
 *   waived    — zarar bor, lekin UNDIRILMAYDI (tabiiy eskirish, forsmajor)
 *   cancelled — zararning O'ZI xato yozilgan (aslida sinmagan)
 *
 * Ularni bitta holatga qo'shish eng ko'p uchraydigan xato bo'lardi:
 * `waived` hisobotda "maktab ko'rgan zarar" ichida QOLADI, `cancelled`
 * esa umuman chiqmaydi. Qo'shib yuborilsa, "bu yil qancha zarar ko'rdik"
 * degan raqam har doim past chiqardi.
 *
 * ⚠️ ZARAR XATLOVGA HAM TA'SIR QILADI: hodisa qayd etilganda miqdor
 * daftariga qator yoziladi (`damage`), bekor qilinganda esa TESKARI qator
 * (`damage_revert`). Ikkalasi bitta tranzaksiyada — aks holda "singan deb
 * yozilgan-u xatlovda yaroqli turgan" holat paydo bo'lardi.
 */

const prisma = require("../config/prisma");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
} = require("../utils/errors");
const logger = require("../utils/logger");
const { Decimal, formatAmount, parseAmount, sumAmounts } = require("../helpers/money.helpers");
const {
  parseQuantity,
  damageAmountOf,
  DAMAGE_KIND_LABELS,
  DAMAGE_STATUS_LABELS,
  itemSnapshotOf,
  locationSnapshotOf,
} = require("../helpers/inventory.helpers");
const { uploadAttachments, deleteAttachments } = require("./file.service");
const { assertActiveItem } = require("./inventoryItem.service");
const { assertActiveLocation } = require("./inventoryLocation.service");
const {
  TX_OPTIONS,
  postMovement,
  ensureStock,
  parseOccurredAt,
} = require("./inventoryStock.service");
const { getInventorySettings } = require("./settings.service");

const DAMAGE_KINDS = Object.keys(DAMAGE_KIND_LABELS);

const serializeDamage = (row, { charges } = {}) => {
  const { item, location, check, ...rest } = row;

  const amount = new Decimal(row.amount);
  const chargedAmount = new Decimal(row.chargedAmount);

  return {
    ...rest,
    unitPrice: formatAmount(row.unitPrice),
    amount: formatAmount(row.amount),
    chargedAmount: formatAmount(row.chargedAmount),
    // Hali hech kimga yozilmagan qism — "kim to'laydi?" savolining qoldig'i
    unchargedAmount: formatAmount(amount.minus(chargedAmount)),
    kindLabel: DAMAGE_KIND_LABELS[row.kind] ?? row.kind,
    statusLabel: DAMAGE_STATUS_LABELS[row.status] ?? row.status,
    itemName: item?.name ?? row.itemSnapshot?.name ?? "Noma'lum",
    unit: item?.unit ?? row.itemSnapshot?.unit ?? "dona",
    locationName: location?.name ?? row.locationSnapshot?.name ?? "Noma'lum",
    checkDate: check?.date ?? null,
    ...(charges ? { charges } : {}),
  };
};

/**
 * Zarar xatlovga qanday ta'sir qiladi — TURIGA bog'liq.
 *
 *   broken  → buyum xonada turibdi, lekin ishlatib bo'lmaydi:
 *             jami O'ZGARMAYDI, yaroqsizlar ORTADI
 *   missing → buyum yo'q: jami KAMAYADI, yaroqsizlar o'zgarmaydi
 *
 * Bitta maydonga qo'shilsa, "xonada nechta stul bor" degan savol noto'g'ri
 * javob berardi (`InventoryDamageKind` izohiga qarang).
 */
const movementDeltasFor = (kind, quantity, revert = false) => {
  const sign = revert ? -1 : 1;

  return kind === "missing"
    ? { quantityDelta: -quantity * sign, brokenDelta: 0 }
    : { quantityDelta: 0, brokenDelta: quantity * sign };
};

const parseKind = (value) => {
  if (value == null || value === "") return "broken";
  if (!DAMAGE_KINDS.includes(value)) throw new BadRequestError("Zarar turi noto'g'ri");
  return value;
};

// ─────────────────────────────────────────────
// YARATISH
// ─────────────────────────────────────────────

/**
 * Zarar hodisasini tranzaksiya ICHIDA yaratadi va xatlovga qator yozadi.
 *
 * Alohida funksiya, chunki chaqiruvchisi IKKITA: qo'lda kiritilgan zarar
 * (`createDamage`) va kunlik hisobot yuborilishi (`inventoryCheck.service`).
 * Ikkalasi bir xil qoida bo'yicha ishlashi SHART — aks holda hisobotdan
 * kelgan zararning narxi muhrlanmay qolishi mumkin edi
 * (`invoiceBuilder.service.js` bilan bir xil mulohaza: summa mantig'i
 * BITTA joyda).
 *
 * @param {object} tx
 * @param {object} params - { location, item, stock, kind, quantity, occurredAt,
 *                            description, attachments, checkId, unitPrice }
 * @param {string} userId
 * @returns {Promise<object>} yaratilgan zarar (xom)
 */
const createDamageInTx = async (tx, params, userId) => {
  const { location, item, stock, kind, quantity, occurredAt } = params;

  // Narx hodisa PAYTIDA muhrlanadi. `params.unitPrice` — kunlik hisobot
  // varag'i ochilgan paytdagi narx (varaqni to'ldirish davomida katalog
  // o'zgarsa ham hisobot o'z raqamida qolsin).
  const unitPrice = params.unitPrice != null
    ? parseAmount(params.unitPrice, "Narx")
    : new Decimal(item.unitPrice);

  const amount = damageAmountOf(quantity, unitPrice);

  const damage = await tx.inventoryDamage.create({
    data: {
      locationId: location.id,
      itemId: item.id,
      stockId: stock.id,
      checkId: params.checkId ?? null,
      kind,
      quantity,
      unitPrice,
      amount,
      description: params.description?.trim() || "",
      attachments: params.attachments ?? [],
      occurredAt,
      reportedBy: params.reportedBy ?? userId,
      itemSnapshot: itemSnapshotOf(item),
      locationSnapshot: locationSnapshotOf(location),
      createdBy: userId,
    },
  });

  const { quantityDelta, brokenDelta } = movementDeltasFor(kind, quantity);

  await postMovement(tx, {
    stock,
    type: "damage",
    quantityDelta,
    brokenDelta,
    occurredAt,
    itemName: item.name,
    damageId: damage.id,
    checkId: params.checkId ?? null,
    note: `${DAMAGE_KIND_LABELS[kind]} · ${quantity} ${item.unit}`,
    createdBy: userId,
  });

  return damage;
};

/**
 * Qo'lda zarar kiritish — kunlik hisobotdan TASHQARI hodisa uchun
 * ("darsdan keyin proyektor tushib ketdi").
 *
 * @param {object} data - { locationId, itemId, kind, quantity, occurredAt,
 *                          description, files }
 * @param {string} userId
 */
const createDamage = async (data, userId) => {
  const [location, item, settings] = await Promise.all([
    assertActiveLocation(data.locationId),
    assertActiveItem(data.itemId),
    getInventorySettings(),
  ]);

  const kind = parseKind(data.kind);
  const quantity = parseQuantity(data.quantity, "Miqdor");
  if (quantity <= 0) throw new BadRequestError("Miqdor noldan katta bo'lishi kerak");

  const occurredAt = parseOccurredAt(data.occurredAt);
  const files = Array.isArray(data.files) ? data.files : [];

  // Rasm majburiyligi — SOZLAMA. Standart holatda o'chirilgan: oshxonada
  // kuniga bir necha piyola sinadi va har biriga rasm talab qilish
  // hisobotni umuman yozilmaydigan qilib qo'yardi.
  if (settings.requirePhoto && files.length === 0) {
    throw new BadRequestError(
      "Sozlamalarga ko'ra zararga rasm biriktirish majburiy",
    );
  }

  // Fayllar TRANZAKSIYADAN OLDIN yuklanadi: tashqi saqlash (S3) chaqiruvi
  // tranzaksiya ichida bo'lsa, tarmoq sekinlashganda DB qatorlari lock
  // ostida turib qolardi. Yozuv yaratilmasa esa fayllar tozalanadi.
  const attachments = files.length > 0 ? await uploadAttachments(files) : [];

  let damage;
  try {
    damage = await prisma.$transaction(async (tx) => {
      const stock = await ensureStock(tx, location.id, item.id, userId);

      return createDamageInTx(
        tx,
        {
          location,
          item,
          stock,
          kind,
          quantity,
          occurredAt,
          description: data.description,
          attachments,
          reportedBy: userId,
        },
        userId,
      );
    }, TX_OPTIONS);
  } catch (error) {
    // Yetim fayl qolmasin — yozuv yaratilmadi
    await deleteAttachments(attachments);
    throw error;
  }

  logger.info(
    `[inventory] Zarar: ${item.name} ×${quantity} (${kind}) · ${location.name} · ` +
      `${formatAmount(damage.amount)} · actor=${userId}`,
  );

  return serializeDamage({ ...damage, item, location });
};

// ─────────────────────────────────────────────
// O'QISH
// ─────────────────────────────────────────────

/**
 * Zararlar registri (sahifalangan).
 * @param {object} req - query: { locationId, itemId, status, kind, from, to, page, limit }
 */
const getDamages = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const where = {};
  if (query.locationId) where.locationId = query.locationId;
  if (query.itemId) where.itemId = query.itemId;
  if (query.status) where.status = query.status;
  if (query.kind) where.kind = query.kind;
  if (query.checkId) where.checkId = query.checkId;
  // Bekor qilinganlari — XATO yozuvlar, standart holatda ko'rinmaydi
  if (query.includeCancelled !== "true" && !query.status) {
    where.status = { not: "cancelled" };
  }

  if (query.from || query.to) {
    where.occurredAt = {};
    if (query.from) where.occurredAt.gte = new Date(`${query.from}T00:00:00+05:00`);
    if (query.to) where.occurredAt.lte = new Date(`${query.to}T23:59:59.999+05:00`);
  }

  const [rows, total, agg] = await Promise.all([
    prisma.inventoryDamage.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
      include: {
        item: { select: { name: true, unit: true } },
        location: { select: { name: true } },
        check: { select: { date: true } },
      },
    }),
    prisma.inventoryDamage.count({ where }),
    // Jami — SAHIFA bo'yicha emas, butun filtr bo'yicha. Bekor
    // qilinganlari HISOBGA OLINMAYDI (ular zarar emas, xato yozuv).
    prisma.inventoryDamage.aggregate({
      where: { ...where, status: { not: "cancelled" } },
      _sum: { amount: true, chargedAmount: true, quantity: true },
      _count: { _all: true },
    }),
  ]);

  const amount = new Decimal(agg._sum.amount ?? 0);
  const charged = new Decimal(agg._sum.chargedAmount ?? 0);

  return {
    ...formatPaginationResponse(rows.map((row) => serializeDamage(row)), total, page, limit),
    totals: {
      count: agg._count._all,
      quantity: agg._sum.quantity ?? 0,
      amount: formatAmount(amount),
      chargedAmount: formatAmount(charged),
      // Hali hech kimga yozilmagan zarar — "kim to'laydi?" ro'yxati
      unchargedAmount: formatAmount(amount.minus(charged)),
    },
  };
};

/** Bitta zarar + unga yozilgan qarzlar. */
const getDamageById = async (id) => {
  const damage = await prisma.inventoryDamage.findUnique({
    where: { id },
    include: {
      item: { select: { name: true, unit: true } },
      location: { select: { name: true } },
      check: { select: { date: true } },
      charges: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!damage) throw new NotFoundError("Zarar yozuvi topilmadi");

  const { charges, ...rest } = damage;
  const { serializeCharge } = require("./damageCharge.service");

  return serializeDamage(rest, { charges: charges.map((c) => serializeCharge(c)) });
};

/**
 * Zarar mavjud va unga qarz yozish MUMKINligini tekshiradi.
 * `damageCharge.service.js` chaqiradi.
 */
const assertChargeableDamage = async (tx, damageId) => {
  if (!damageId) throw new BadRequestError("Zarar tanlanmagan");

  const client = tx ?? prisma;
  const damage = await client.inventoryDamage.findUnique({
    where: { id: damageId },
    include: { item: { select: { name: true } }, location: { select: { name: true } } },
  });
  if (!damage) throw new NotFoundError("Zarar yozuvi topilmadi");

  if (damage.status === "cancelled") {
    throw new BadRequestError("Bekor qilingan zararga qarz yozib bo'lmaydi");
  }
  if (damage.status === "waived") {
    throw new BadRequestError(
      "Zarar maktab hisobidan deb belgilangan — avval bu qarorni qaytaring",
    );
  }

  return damage;
};

// ─────────────────────────────────────────────
// HOLATNI O'ZGARTIRISH
// ─────────────────────────────────────────────

/**
 * MAKTAB HISOBIDAN — undirilmaydi.
 *
 * Bu "bekor qilish" EMAS: zarar bo'lgan va hisobotda QOLADI, faqat aybdor
 * yo'q (tabiiy eskirish, forsmajor). Shuning uchun xatlovga tegilmaydi.
 */
const waiveDamage = async (id, reason, userId) => {
  const damage = await prisma.inventoryDamage.findUnique({ where: { id } });
  if (!damage) throw new NotFoundError("Zarar yozuvi topilmadi");

  if (damage.status === "cancelled") {
    throw new BadRequestError("Bekor qilingan zarar ustida amal bajarib bo'lmaydi");
  }
  if (damage.status === "waived") {
    throw new BadRequestError("Zarar allaqachon maktab hisobidan deb belgilangan");
  }

  const trimmed = reason?.trim();
  if (!trimmed) throw new BadRequestError("Sabab majburiy");

  // Aybdorga yozilgan qarz turgan bo'lsa — avval u hal qilinishi kerak.
  // Aks holda "maktab ham to'laydi, o'quvchi ham qarzdor" holati chiqardi.
  const activeCharges = await prisma.damageCharge.count({
    where: { damageId: id, status: { not: "cancelled" } },
  });
  if (activeCharges > 0) {
    throw new BadRequestError(
      `Bu zararga ${activeCharges} ta qarz yozilgan — avval ularni bekor qiling`,
    );
  }

  const updated = await prisma.inventoryDamage.updateMany({
    where: { id, status: { in: ["pending", "charged"] } },
    data: {
      status: "waived",
      waiveReason: trimmed,
      waivedAt: new Date(),
      waivedBy: userId,
    },
  });
  if (updated.count !== 1) {
    throw new ConflictError("Zarar holati shu orada o'zgardi — qaytadan urinib ko'ring");
  }

  logger.info(
    `[inventory] Zarar maktab hisobidan: damage=${id} actor=${userId} sabab="${trimmed}"`,
  );

  return getDamageById(id);
};

/** `waived` qarorini qaytaradi — aybdor keyinroq aniqlangan holat. */
const unwaiveDamage = async (id, userId) => {
  const damage = await prisma.inventoryDamage.findUnique({ where: { id } });
  if (!damage) throw new NotFoundError("Zarar yozuvi topilmadi");
  if (damage.status !== "waived") {
    throw new BadRequestError("Zarar maktab hisobidan deb belgilanmagan");
  }

  await prisma.inventoryDamage.update({
    where: { id },
    data: { status: "pending", waiveReason: "", waivedAt: null, waivedBy: null },
  });

  logger.info(`[inventory] Zarar qaytarildi (waived → pending): damage=${id} actor=${userId}`);

  return getDamageById(id);
};

/**
 * BEKOR QILISH — zararning O'ZI xato yozilgan.
 *
 * Uch narsa BIRGA bo'ladi: holat `cancelled` ga o'tadi, xatlovga TESKARI
 * qator yoziladi va (agar bo'lsa) hech qanday faol qarz qolmasligi
 * tekshiriladi. Ularning biri qolib ketsa xatlov va hisobot bir-biriga
 * to'g'ri kelmasdi.
 */
const cancelDamage = async (id, reason, userId) => {
  const damage = await prisma.inventoryDamage.findUnique({
    where: { id },
    include: { item: { select: { name: true, unit: true } }, location: { select: { name: true } } },
  });
  if (!damage) throw new NotFoundError("Zarar yozuvi topilmadi");
  if (damage.status === "cancelled") {
    throw new BadRequestError("Zarar allaqachon bekor qilingan");
  }

  const trimmed = reason?.trim();
  if (!trimmed) throw new BadRequestError("Bekor qilish sababi majburiy");

  const activeCharges = await prisma.damageCharge.count({
    where: { damageId: id, status: { not: "cancelled" } },
  });
  if (activeCharges > 0) {
    throw new BadRequestError(
      `Bu zararga ${activeCharges} ta qarz yozilgan — avval ularni bekor qiling`,
    );
  }

  logger.warn(
    `[inventory] Zarar bekor qilindi: damage=${id} ${damage.item.name} ` +
      `×${damage.quantity} summa=${formatAmount(damage.amount)} ` +
      `actor=${userId} sabab="${trimmed}"`,
  );

  await prisma.$transaction(async (tx) => {
    const cancelled = await tx.inventoryDamage.updateMany({
      where: { id, status: { not: "cancelled" } },
      data: {
        status: "cancelled",
        cancelReason: trimmed,
        cancelledAt: new Date(),
        cancelledBy: userId,
      },
    });
    if (cancelled.count !== 1) {
      throw new ConflictError("Zarar allaqachon bekor qilingan");
    }

    const stock = await tx.inventoryStock.findUnique({ where: { id: damage.stockId } });
    if (!stock) throw new NotFoundError("Xatlov qatori topilmadi");

    // TESKARI qator — daftar append-only, yozuv o'chirilmaydi
    const { quantityDelta, brokenDelta } = movementDeltasFor(
      damage.kind,
      damage.quantity,
      true,
    );

    await postMovement(tx, {
      stock,
      type: "damage_revert",
      quantityDelta,
      brokenDelta,
      occurredAt: new Date(),
      itemName: damage.item.name,
      damageId: damage.id,
      note: `Bekor qilindi: ${trimmed}`,
      createdBy: userId,
    });
  }, TX_OPTIONS);

  return getDamageById(id);
};

/**
 * `chargedAmount` ni qayta hisoblab yozadi va zarar holatini yangilaydi.
 *
 * `damageCharge.service.js` qarz yozganda va bekor qilganda chaqiradi.
 * Bitta joyda, chunki holat (`pending` ↔ `charged`) `chargedAmount` DAN
 * KELIB CHIQADI va hech qachon qo'lda qo'yilmaydi (`deriveStatus` bilan
 * bir xil mulohaza).
 *
 * @param {object} tx
 * @param {string} damageId
 */
const syncChargedAmount = async (tx, damageId) => {
  const charges = await tx.damageCharge.findMany({
    where: { damageId, status: { not: "cancelled" } },
    select: { amount: true },
  });

  const chargedAmount = sumAmounts(charges.map((c) => c.amount));

  const damage = await tx.inventoryDamage.findUnique({ where: { id: damageId } });
  if (!damage) throw new NotFoundError("Zarar yozuvi topilmadi");

  // `waived` va `cancelled` — QO'LDA qo'yilgan qarorlar, ular avtomatik
  // o'zgarmaydi. Faqat `pending` ↔ `charged` hosila.
  const status =
    damage.status === "waived" || damage.status === "cancelled"
      ? damage.status
      : chargedAmount.greaterThan(0)
        ? "charged"
        : "pending";

  await tx.inventoryDamage.update({
    where: { id: damageId },
    data: { chargedAmount, status },
  });

  return { chargedAmount, status };
};

module.exports = {
  DAMAGE_KINDS,
  serializeDamage,
  movementDeltasFor,
  createDamageInTx,
  createDamage,
  getDamages,
  getDamageById,
  assertChargeableDamage,
  waiveDamage,
  unwaiveDamage,
  cancelDamage,
  syncChargedAmount,
};
