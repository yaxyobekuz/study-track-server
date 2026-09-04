/**
 * XATLOV VA MIQDOR DAFTARI.
 *
 * `paymentAccount.service.js` ning aynan ko'zgusi: u yerda hisob qoldig'i
 * va uning daftari, bu yerda xona×jihoz miqdori va uning daftari.
 * Miqdorni o'zgartiradigan YAGONA nuqta — `postMovement()`.
 *
 * `postMovement` ning ikki operatorli shakli MAJBURIY:
 *   1) `update({ quantity: { increment } })` — qator lock'ini oladi VA
 *      yangilangan miqdorni qaytaradi,
 *   2) shu qaytgan qiymat `quantityAfter` bo'lib yoziladi.
 * "O'qi → hisobla → yoz" aynan yo'qolgan yangilanish shakli va bu yerda
 * "ikki hisobot bir vaqtda keldi, bittasi yo'qoldi" degan holatga olib
 * kelardi.
 *
 * ⚠️ MANFIY MIQDOR TAQIQLANADI — kassadan FARQLI o'laroq.
 * Kassada manfiy qoldiq qonuniy edi (daftar haqiqatni yozadi, xodim
 * xarajatni kirita olishi kerak). Xatlovda esa manfiy miqdor haqiqat
 * EMAS: mavjud bo'lmagan partani sindirib bo'lmaydi, ya'ni bu har doim
 * kiritish xatosi. Tekshiruv `assertStockConsistency` da.
 */

const prisma = require("../config/prisma");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const logger = require("../utils/logger");
const {
  assertMovementSigns,
  assertStockConsistency,
  parseQuantity,
  parseSignedQuantity,
  MOVEMENT_TYPE_LABELS,
} = require("../helpers/inventory.helpers");
const { assertActiveItem } = require("./inventoryItem.service");
const { assertActiveLocation } = require("./inventoryLocation.service");

// Moliya modulidagi bilan bir xil: `Serializable` shart emas, lekin
// `postMovement` ning increment'i qator lock'ini oladi.
const TX_OPTIONS = { timeout: 20000 };

const serializeStock = (row) => {
  const { item, location, ...rest } = row;

  return {
    ...rest,
    // HOSILA — ustun EMAS (ikkita haqiqat manbai bo'lib qolardi)
    serviceableQuantity: row.quantity - row.brokenQuantity,
    itemName: item?.name ?? null,
    unit: item?.unit ?? "dona",
    categoryName: item?.category?.name ?? null,
    locationName: location?.name ?? null,
  };
};

const serializeMovement = (row) => {
  const { item, location, ...rest } = row;

  return {
    ...rest,
    // BigInt JSON'ga tushmaydi — string sifatida chiqadi
    seq: row.seq != null ? String(row.seq) : null,
    typeLabel: MOVEMENT_TYPE_LABELS[row.type] ?? row.type,
    itemName: item?.name ?? null,
    unit: item?.unit ?? "dona",
    locationName: location?.name ?? null,
  };
};

/** Sana kelajakda bo'la olmaydi (moliya modulidagi bilan bir xil qoida). */
const parseOccurredAt = (value) => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new BadRequestError("Sana noto'g'ri");
  if (date.getTime() > Date.now()) {
    throw new BadRequestError("Kelajakdagi sana bilan yozuv qayd etib bo'lmaydi");
  }
  return date;
};

// ─────────────────────────────────────────────
// Daftarga yozishning YAGONA nuqtasi
// ─────────────────────────────────────────────

/**
 * Miqdor daftariga bitta qator yozadi va xatlovni yangilaydi.
 *
 * HAR DOIM tranzaksiya ichida chaqiriladi.
 *
 * @param {object} tx - Prisma tranzaksiya klienti
 * @param {object} params
 * @param {object} params.stock - xatlov qatori (id, locationId, itemId)
 * @param {string} params.type - InventoryMovementType
 * @param {number} params.quantityDelta - ISHORALI
 * @param {number} [params.brokenDelta=0] - ISHORALI
 * @param {Date} params.occurredAt - BIZNES sanasi
 * @param {string} params.createdBy
 * @param {string} [params.itemName] - xato xabari uchun
 * @param {string} [params.checkId]
 * @param {string} [params.damageId]
 * @param {string} [params.transferId] - o'tkazma HUJJATI (ikkala qator uchun bitta)
 * @param {string} [params.counterpartLocationId]
 * @param {string} [params.note]
 * @returns {Promise<object>} yozilgan qator (xom)
 */
const postMovement = async (tx, params) => {
  const {
    stock,
    type,
    quantityDelta,
    brokenDelta = 0,
    occurredAt,
    createdBy,
  } = params;

  // Ishora turga mos kelishi — INVARIANT, kelishuv emas
  assertMovementSigns(type, quantityDelta, brokenDelta);

  // 1) increment BIRINCHI: qator lock'ini oladi va post-image qaytaradi
  const updated = await tx.inventoryStock.update({
    where: { id: stock.id },
    data: {
      quantity: { increment: quantityDelta },
      brokenQuantity: { increment: brokenDelta },
    },
  });

  // 2) Post-image mantiqan to'g'rimi — manfiy miqdor va "jamidan ko'p
  //    yaroqsiz" holatlari shu yerda to'xtaydi (tranzaksiya rollback)
  assertStockConsistency(
    updated.quantity,
    updated.brokenQuantity,
    params.itemName || "Jihoz",
  );

  // 3) quantityAfter — AYNAN shu qaytgan qiymat
  return tx.inventoryMovement.create({
    data: {
      stockId: stock.id,
      locationId: stock.locationId,
      itemId: stock.itemId,
      type,
      quantityDelta,
      brokenDelta,
      quantityAfter: updated.quantity,
      brokenAfter: updated.brokenQuantity,
      occurredAt,
      checkId: params.checkId ?? null,
      damageId: params.damageId ?? null,
      transferId: params.transferId ?? null,
      counterpartLocationId: params.counterpartLocationId ?? null,
      note: params.note?.trim() || "",
      createdBy,
    },
  });
};

/**
 * Xatlov qatorini topadi, yo'q bo'lsa NOL miqdor bilan ochadi.
 *
 * Qator o'zi hech narsani anglatmaydi — miqdor faqat daftardan keladi.
 * Shuning uchun "ochish" xavfsiz amal va `postMovement` ga yo'l ochadi.
 *
 * @param {object} tx
 * @param {string} locationId
 * @param {string} itemId
 * @param {string} userId
 */
const ensureStock = async (tx, locationId, itemId, userId) => {
  const existing = await tx.inventoryStock.findUnique({
    where: { locationId_itemId: { locationId, itemId } },
  });
  if (existing) return existing;

  return tx.inventoryStock.create({
    data: { locationId, itemId, createdBy: userId },
  });
};

// ─────────────────────────────────────────────
// O'QISH
// ─────────────────────────────────────────────

/**
 * Xatlov registri (sahifalangan).
 * @param {object} req - query: { locationId, itemId, categoryId, onlyBroken, page, limit }
 */
const getStocks = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const where = {};
  if (query.locationId) where.locationId = query.locationId;
  if (query.itemId) where.itemId = query.itemId;
  if (query.categoryId) where.item = { categoryId: query.categoryId };
  // "Ta'mirlash kutayotganlar" kesimi
  if (query.onlyBroken === "true") where.brokenQuantity = { gt: 0 };
  // Nol miqdorli qatorlar odatda shovqin (jihoz butunlay chiqarilgan)
  if (query.includeEmpty !== "true") where.quantity = { gt: 0 };

  const [rows, total, agg] = await Promise.all([
    prisma.inventoryStock.findMany({
      where,
      orderBy: [{ location: { name: "asc" } }, { item: { name: "asc" } }],
      skip,
      take: limit,
      include: {
        item: { select: { name: true, unit: true, category: { select: { name: true } } } },
        location: { select: { name: true } },
      },
    }),
    prisma.inventoryStock.count({ where }),
    // Jami — SAHIFA bo'yicha emas, butun filtr bo'yicha
    prisma.inventoryStock.aggregate({
      where,
      _sum: { quantity: true, brokenQuantity: true },
    }),
  ]);

  const totalQuantity = agg._sum.quantity ?? 0;
  const brokenQuantity = agg._sum.brokenQuantity ?? 0;

  return {
    ...formatPaginationResponse(rows.map(serializeStock), total, page, limit),
    totals: {
      rows: total,
      quantity: totalQuantity,
      brokenQuantity,
      serviceableQuantity: totalQuantity - brokenQuantity,
    },
  };
};

/**
 * Bitta xonaning to'liq xatlovi — sahifalanmaydi.
 * Kunlik hisobot varag'i shu ro'yxatdan quriladi.
 */
const getStockByLocation = async (locationId, { includeEmpty = false } = {}) => {
  const location = await assertActiveLocation(locationId);

  const where = { locationId };
  if (!includeEmpty) where.quantity = { gt: 0 };

  const rows = await prisma.inventoryStock.findMany({
    where,
    orderBy: [{ item: { sortOrder: "asc" } }, { item: { name: "asc" } }],
    include: {
      item: {
        select: {
          name: true,
          unit: true,
          unitPrice: true,
          category: { select: { name: true } },
        },
      },
    },
  });

  return {
    location: { id: location.id, name: location.name, type: location.type },
    items: rows.map(serializeStock),
  };
};

/**
 * Miqdor daftari registri — "shu jihoz bilan nima bo'ldi".
 *
 * Tartib `occurredAt desc, seq desc`: hisobot BIZNES sanasi bo'yicha
 * o'qiladi, `seq` esa bir kun ichidagi tartibni determinlashtiradi
 * (`AccountEntry` bilan bir xil qoida).
 */
const getMovements = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const where = {};
  if (query.stockId) where.stockId = query.stockId;
  if (query.locationId) where.locationId = query.locationId;
  if (query.itemId) where.itemId = query.itemId;
  if (query.type) where.type = query.type;
  if (query.checkId) where.checkId = query.checkId;
  if (query.damageId) where.damageId = query.damageId;
  if (query.transferId) where.transferId = query.transferId;

  if (query.from || query.to) {
    where.occurredAt = {};
    if (query.from) where.occurredAt.gte = new Date(`${query.from}T00:00:00+05:00`);
    if (query.to) where.occurredAt.lte = new Date(`${query.to}T23:59:59.999+05:00`);
  }

  const [rows, total] = await Promise.all([
    prisma.inventoryMovement.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { seq: "desc" }],
      skip,
      take: limit,
      include: {
        item: { select: { name: true, unit: true } },
        location: { select: { name: true } },
      },
    }),
    prisma.inventoryMovement.count({ where }),
  ]);

  return formatPaginationResponse(
    rows.map(serializeMovement),
    total,
    page,
    limit,
  );
};

// ─────────────────────────────────────────────
// YOZISH
// ─────────────────────────────────────────────

/**
 * BOSHLANG'ICH XATLOV yoki YANGI JIHOZ.
 *
 * Bitta amalda bir NECHTA qator kiritiladi: "1-A sinf xonasi — parta 20,
 * stul 40, doska 1, proyektor 1". Boshlang'ich xatlov aynan shunday
 * ishlaydi va uni qatorma-qator kiritish soatlab vaqt olardi.
 *
 * `type`:
 *   `initial`  — tizimga birinchi marta kiritish (yaroqsizi ham bo'lishi mumkin)
 *   `purchase` — yangi jihoz sotib olindi
 *
 * @param {object} data - { locationId, type, occurredAt, note, lines: [{ itemId, quantity, brokenQuantity, note }] }
 * @param {string} userId
 */
const addStock = async (data, userId) => {
  const type = data.type === "purchase" ? "purchase" : "initial";
  const location = await assertActiveLocation(data.locationId);
  const occurredAt = parseOccurredAt(data.occurredAt);

  const rawLines = Array.isArray(data.lines) ? data.lines : [];
  if (rawLines.length === 0) {
    throw new BadRequestError("Kamida bitta jihoz kiritilishi kerak");
  }

  // Bitta amalda bitta jihoz BIR MARTA: aks holda ikkita qator bir-birini
  // "to'ldirib", nima kiritilgani noaniq bo'lib qolardi.
  const seen = new Set();
  const lines = [];

  for (const raw of rawLines) {
    const item = await assertActiveItem(raw.itemId);
    if (seen.has(item.id)) {
      throw new BadRequestError(`"${item.name}" ro'yxatda ikki marta kelgan`);
    }
    seen.add(item.id);

    const quantity = parseQuantity(raw.quantity, `"${item.name}" miqdori`);
    if (quantity <= 0) {
      throw new BadRequestError(`"${item.name}" miqdori noldan katta bo'lishi kerak`);
    }

    // Yaroqsizi FAQAT boshlang'ich xatlovda bo'ladi: yangi sotib olingan
    // jihoz singan holda kelmaydi (kelsa — bu zarar, alohida hodisa).
    const brokenQuantity =
      type === "initial"
        ? parseQuantity(raw.brokenQuantity ?? 0, `"${item.name}" yaroqsiz miqdori`)
        : 0;

    if (brokenQuantity > quantity) {
      throw new BadRequestError(
        `"${item.name}": yaroqsizlar soni jami miqdordan ko'p bo'lishi mumkin emas`,
      );
    }

    lines.push({ item, quantity, brokenQuantity, note: raw.note?.trim() || "" });
  }

  const result = await prisma.$transaction(async (tx) => {
    const created = [];

    // Determinlashgan tartib — bir nechta parallel kiritish bir-birini
    // kutganda deadlock bo'lmasligi uchun (`AccountTransfer` bilan bir xil
    // mulohaza: lock tartibi HAR DOIM id bo'yicha o'sish tartibida).
    const ordered = [...lines].sort((a, b) => a.item.id.localeCompare(b.item.id));

    for (const line of ordered) {
      const stock = await ensureStock(tx, location.id, line.item.id, userId);

      const movement = await postMovement(tx, {
        stock,
        type,
        quantityDelta: line.quantity,
        brokenDelta: line.brokenQuantity,
        occurredAt,
        itemName: line.item.name,
        note: line.note || data.note?.trim() || "",
        createdBy: userId,
      });

      created.push({ item: line.item, movement });
    }

    return created;
  }, TX_OPTIONS);

  logger.info(
    `[inventory] ${MOVEMENT_TYPE_LABELS[type]}: ${location.name} · ` +
      `${result.length} ta qator · actor=${userId}`,
  );

  return {
    location: { id: location.id, name: location.name },
    type,
    lines: result.map(({ item, movement }) => ({
      itemId: item.id,
      itemName: item.name,
      quantityDelta: movement.quantityDelta,
      brokenDelta: movement.brokenDelta,
      quantityAfter: movement.quantityAfter,
      brokenAfter: movement.brokenAfter,
    })),
  };
};

/**
 * Bitta xatlov qatoriga bitta harakat yozadi (ta'mirlash, hisobdan
 * chiqarish, qo'lda to'g'rilash).
 *
 * @param {string} stockId
 * @param {object} params - { type, quantityDelta, brokenDelta, occurredAt, note }
 * @param {string} userId
 */
const applyMovement = async (stockId, params, userId) => {
  const stock = await prisma.inventoryStock.findUnique({
    where: { id: stockId },
    include: { item: { select: { name: true } }, location: { select: { name: true } } },
  });
  if (!stock) throw new NotFoundError("Xatlov qatori topilmadi");

  const occurredAt = parseOccurredAt(params.occurredAt);

  const movement = await prisma.$transaction(
    (tx) =>
      postMovement(tx, {
        stock,
        type: params.type,
        quantityDelta: params.quantityDelta,
        brokenDelta: params.brokenDelta ?? 0,
        occurredAt,
        itemName: stock.item.name,
        note: params.note,
        createdBy: userId,
      }),
    TX_OPTIONS,
  );

  logger.info(
    `[inventory] ${MOVEMENT_TYPE_LABELS[params.type]}: ${stock.location.name} · ` +
      `${stock.item.name} · Δ${params.quantityDelta}/${params.brokenDelta ?? 0} · actor=${userId}`,
  );

  return serializeMovement({ ...movement, item: stock.item, location: stock.location });
};

/**
 * TA'MIRLANDI — yaroqsizlar safidan chiqdi, jami o'zgarmaydi.
 * @param {object} data - { stockId, quantity, occurredAt, note }
 */
const repairStock = async (data, userId) => {
  const quantity = parseQuantity(data.quantity, "Ta'mirlangan miqdor");
  if (quantity <= 0) {
    throw new BadRequestError("Ta'mirlangan miqdor noldan katta bo'lishi kerak");
  }

  return applyMovement(
    data.stockId,
    {
      type: "repair",
      quantityDelta: 0,
      brokenDelta: -quantity,
      occurredAt: data.occurredAt,
      note: data.note,
    },
    userId,
  );
};

/**
 * HISOBDAN CHIQARISH — jami kamayadi.
 *
 * `fromBroken` — chiqarilayotgani yaroqsizlar ichidanmi. Odatda HA
 * (ta'mirlab bo'lmaydigan parta), lekin eskirgan-u ishlaydigan jihozni
 * ham chiqarish mumkin.
 *
 * @param {object} data - { stockId, quantity, fromBroken, occurredAt, note }
 */
const writeOffStock = async (data, userId) => {
  const quantity = parseQuantity(data.quantity, "Miqdor");
  if (quantity <= 0) {
    throw new BadRequestError("Miqdor noldan katta bo'lishi kerak");
  }

  const fromBroken = data.fromBroken !== false;

  return applyMovement(
    data.stockId,
    {
      type: "write_off",
      quantityDelta: -quantity,
      brokenDelta: fromBroken ? -quantity : 0,
      occurredAt: data.occurredAt,
      note: data.note,
    },
    userId,
  );
};

/**
 * QO'LDA TO'G'RILASH — sanoq farqi.
 *
 * Yagona ikki tomonlama harakat: inventarizatsiyada "hujjatda 20 ta,
 * aslida 19 ta" chiqsa, farq shu yerda yoziladi. Sabab MAJBURIY —
 * aks holda bu "xatoni yashirish tugmasi" bo'lib qolardi.
 *
 * @param {object} data - { stockId, quantityDelta, brokenDelta, reason, occurredAt }
 */
const adjustStock = async (data, userId) => {
  const quantityDelta = parseSignedQuantity(data.quantityDelta ?? 0, "Miqdor farqi");
  const brokenDelta = parseSignedQuantity(data.brokenDelta ?? 0, "Yaroqsiz farqi");

  const reason = data.reason?.trim();
  if (!reason) throw new BadRequestError("To'g'rilash sababi majburiy");

  if (quantityDelta === 0 && brokenDelta === 0) {
    throw new BadRequestError("Kamida bitta farq kiritilishi kerak");
  }

  logger.warn(
    `[inventory] Qo'lda to'g'rilash: stock=${data.stockId} ` +
      `Δ${quantityDelta}/${brokenDelta} actor=${userId} sabab="${reason}"`,
  );

  return applyMovement(
    data.stockId,
    {
      type: "adjustment",
      quantityDelta,
      brokenDelta,
      occurredAt: data.occurredAt,
      note: reason,
    },
    userId,
  );
};

// ⚠️ XONALAR ORASIDA KO'CHIRISH BU YERDA EMAS.
//
// U `inventoryTransfer.service.js` ga ko'chirildi va HUJJATGA aylandi
// (`InventoryTransfer` + `InventoryTransferLine`). Sabab: o'tkazma uch
// narsani saqlashi kerak — qaysi xonaga, KIMGA topshirildi va nima uchun,
// — daftar qatori esa faqat miqdorni biladi. Bir aktda bir nechta jihoz
// ham shu qatlamda paydo bo'ldi.
//
// Bu fayl daftarning YAGONA yozuv nuqtasi bo'lib qoladi: o'tkazma servisi
// ham miqdorni faqat `postMovement()` orqali o'zgartiradi.

module.exports = {
  TX_OPTIONS,
  serializeStock,
  serializeMovement,
  parseOccurredAt,
  postMovement,
  ensureStock,
  getStocks,
  getStockByLocation,
  getMovements,
  addStock,
  repairStock,
  writeOffStock,
  adjustStock,
};
