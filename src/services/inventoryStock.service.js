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
  parseOptionalQuantity,
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

/**
 * XONA yoki JIHOZ ALMASHTIRILGANDA — MIQDORNI BOSHQA QATORGA KO'CHIRISH.
 *
 * ⚠️ Bu "qatorni tahrirlash" EMAS. Xatlov qatorining kaliti
 * `@@unique([locationId, itemId])`, ya'ni juftlik O'ZI qatorning kimligi:
 * uni joyida o'zgartirish "Doska 206-xonada" degan qatorni jimgina
 * "Parta 105-xonada" ga aylantirardi va daftardagi butun tarix (zarar,
 * ta'mirlash, hisobot satrlari) noto'g'ri jihozga osilib qolardi.
 *
 * Shuning uchun bu KO'CHIRISH: eskisidan chiqim, yangisiga kirim —
 * `inventoryTransfer.service.js` dagi juftlik bilan AYNAN bir xil shakl.
 *
 * ── NIMA UCHUN `transfer_out` / `transfer_in`, `adjustment` EMAS ──
 *
 * Miqdor haqiqatda bir qatordan ikkinchisiga o'tyapti va `MOVEMENT_RULES`
 * da bu shaklning tayyor juftligi bor: `transfer_out` sof MANFIY,
 * `transfer_in` sof MUSBAT. `adjustment` ("any/any") ham o'tardi, lekin u
 * SANOQ FARQI degani — daftarni o'qiganda "205-xonada 5 ta parta yo'qoldi,
 * 105-xonada 5 tasi paydo bo'ldi" degan ikkita bog'lanmagan xato bo'lib
 * ko'rinardi. Shu sababli helper (`assertMovementSigns`) ga TEGILMADI.
 *
 * ⚠️ `transferId` bu yerda `null` bo'lib qoladi: u `InventoryTransfer`
 * hujjatiga FK, hujjat esa faqat topshirish-qabul qilish aktida tug'iladi
 * (kim topshirdi, kim qabul qildi). Bu yerda hodisa boshqa — KIRITISH
 * XATOSINI to'g'rilash, — shuning uchun juftlik `counterpartLocationId`
 * va bir xil izoh matni bilan bog'lanadi.
 *
 * @param {object} params
 * @returns {Promise<object>} ko'chirish natijasi (NISHON qator)
 */
const moveStockRow = async ({
  stock,
  targetLocationId,
  targetItemId,
  targetQuantity,
  targetBroken,
  reason,
  occurredAt,
  note,
  noteProvided,
  userId,
}) => {
  // Arxivlangan xona yoki jihozga ko'chirib bo'lmaydi — u endi "bor" degan
  // joy emas (`createTransfer` dagi bilan bir xil qoida).
  const [targetLocation, targetItem] = await Promise.all([
    assertActiveLocation(targetLocationId),
    assertActiveItem(targetItemId),
  ]);

  const fromLocationName = stock.location?.name ?? "Noma'lum";
  const fromItemName = stock.item?.name ?? "Jihoz";

  // Ikkala daftar qatorida BIR XIL matn — registrda juftlik ko'zga
  // tashlanib tursin (`transferId` bu yerda yo'q, yuqoridagi izoh).
  const ledgerNote =
    `${fromLocationName} · ${fromItemName} → ` +
    `${targetLocation.name} · ${targetItem.name}: ${reason}`;

  const result = await prisma.$transaction(async (tx) => {
    // Nishon qator bo'lmasa NOL miqdor bilan ochiladi — qatorning o'zi
    // hech narsani anglatmaydi, miqdor faqat daftardan keladi.
    const targetStock = await ensureStock(
      tx,
      targetLocation.id,
      targetItem.id,
      userId,
    );

    // ⚠️ LOCK TARTIBI — HAR DOIM xatlov qatori `id` si bo'yicha O'SISH
    // tartibida, yo'nalishdan qat'i nazar. A→B va B→A ko'chirish bir
    // vaqtda kelsa, har biri o'z manbasini lock qilib ikkinchisining
    // manzilini kutardi (`accountTransfer.service.js` bilan aynan bir xil
    // mulohaza). Shu sababli movement YOZISHDAN OLDIN ikkala qatorga
    // bittadan `update` yuboriladi — u lock oladi VA joriy miqdorni
    // qaytaradi.
    const ordered = [
      { id: stock.id, isTarget: false },
      { id: targetStock.id, isTarget: true },
    ].sort((a, b) => a.id.localeCompare(b.id));

    const locked = {};
    for (const row of ordered) {
      // Izoh NISHON qatorga yoziladi (miqdor u yerga ko'chdi). Izoh
      // berilmagan bo'lsa ham HAQIQIY update yuboriladi (`updatedAt`):
      // bo'sh `data` bilan lock kafolatlanmasdi.
      const updated = await tx.inventoryStock.update({
        where: { id: row.id },
        data: row.isTarget && noteProvided ? { note } : { updatedAt: new Date() },
      });
      locked[row.isTarget ? "target" : "source"] = updated;
    }

    // ⚠️ ZARAR BOG'LANGAN QATORDAN YAROQSIZLARNI KO'CHIRIB BO'LMAYDI.
    //
    // `cancelDamage` teskari qatorni HAR DOIM `damage.stockId` ga yozadi
    // (`inventoryDamage.service.js`), ya'ni MANBA qatorga. Yaroqsizlar
    // ko'chib ketsa o'sha qatorda `brokenQuantity = 0` qoladi va bekor
    // qilish `assertStockConsistency` ga urilib RAD ETILADI — xato zarar
    // yozuvi abadiy `pending` bo'lib, "bu yil qancha zarar ko'rdik"
    // hisobotida turib qolardi.
    //
    // Bu KO'CHIRISHDAGI YAGONA to'siq: qolgan hollarda hech narsa
    // yo'qolmaydi (yuqoridagi izoh). `missing` zarari hisobga olinmaydi —
    // uning teskari qatori miqdorni QO'SHADI va hech qachon yiqilmaydi.
    if (locked.source.brokenQuantity > 0) {
      const openDamages = await tx.inventoryDamage.count({
        where: {
          stockId: locked.source.id,
          kind: { not: "missing" },
          status: { not: "cancelled" },
        },
      });

      if (openDamages > 0) {
        throw new BadRequestError(
          `"${fromItemName}" (${fromLocationName}) qatorida ${openDamages} ta ` +
            `bekor qilinmagan zarar yozuvi bor. Yaroqsizlar boshqa qatorga ` +
            `ko'chsa, o'sha zararni keyin bekor qilib bo'lmaydi — avval ` +
            `zararni bekor qiling yoki ta'mirlashni qayd eting.`,
        );
      }
    }

    const movements = [];

    // MIQDOR SAQLANADI — ko'chirish juftligi HAR DOIM BALANSLASHADI.
    //
    // ⚠️ Ikkala oyoq ham AYNAN BIR XIL songa yoziladi: manbadan chiqqan
    // miqdor nishonga to'liq kiradi. Bir vaqtlar chiqim `locked.source`
    // dan, kirim esa oynadagi `targetQuantity` dan olinardi va ikkalasi
    // orasidagi farq JIMGINA yo'qolardi (yoki yo'qdan paydo bo'lardi):
    // "20 ta ketdi, 5 tasi keldi" degan daftarni birorta tekshiruv
    // topa olmasdi, chunki har bir qator alohida o'z yig'indisiga mos
    // tushardi. Oynada kiritilgan miqdor bilan farq bo'lsa, u ALOHIDA
    // `adjustment` qatori bo'lib yoziladi (3-band).
    const movedQuantity = locked.source.quantity;
    const movedBroken = locked.source.brokenQuantity;

    // 1) ESKI QATOR NOLGA TUSHADI — hammasi ko'chadi. Miqdor lock ostida
    //    o'qilgan qiymatdan olinadi, oldin o'qilgan `stock` dan emas.
    if (movedQuantity > 0) {
      movements.push({
        row: await postMovement(tx, {
          stock: locked.source,
          type: "transfer_out",
          quantityDelta: -movedQuantity,
          brokenDelta: -movedBroken,
          occurredAt,
          itemName: fromItemName,
          counterpartLocationId: targetLocation.id,
          note: ledgerNote,
          createdBy: userId,
        }),
        item: stock.item,
        location: stock.location,
      });

      // 2) NISHON QATORGA O'SHA MIQDOR QO'SHILADI.
      //    ⚠️ Ustiga yozilmaydi: nishon qatorda allaqachon miqdor bo'lishi
      //    mumkin ("105-xonada Doska 2 ta bor") va unique kalit bitta qator
      //    talab qiladi — ikkalasi bitta sonda yashaydi.
      movements.push({
        row: await postMovement(tx, {
          stock: locked.target,
          type: "transfer_in",
          quantityDelta: movedQuantity,
          brokenDelta: movedBroken,
          occurredAt,
          itemName: targetItem.name,
          counterpartLocationId: stock.locationId,
          note: ledgerNote,
          createdBy: userId,
        }),
        item: targetItem,
        location: targetLocation,
      });
    }

    // 3) OYNADA MIQDOR HAM TO'G'RILANGAN BO'LSA — ALOHIDA `adjustment`.
    //    Ko'chirish va sanoq farqi IKKI XIL hodisa: birinchisi miqdorni
    //    joyidan qimirlatadi, ikkinchisi uni yo'qdan yaratadi yoki
    //    yo'qotadi. Bitta qatorga qo'shilsa, daftar "qancha ko'chdi"
    //    degan savolga yolg'on javob berardi.
    const quantityDelta = targetQuantity - movedQuantity;
    const brokenDelta = targetBroken - movedBroken;

    if (quantityDelta !== 0 || brokenDelta !== 0) {
      movements.push({
        row: await postMovement(tx, {
          stock: locked.target,
          type: "adjustment",
          quantityDelta,
          brokenDelta,
          occurredAt,
          itemName: targetItem.name,
          note:
            `${ledgerNote} (ko'chirishda miqdor to'g'rilandi: ` +
            `${movedQuantity}/${movedBroken} → ${targetQuantity}/${targetBroken})`,
          createdBy: userId,
        }),
        item: targetItem,
        location: targetLocation,
      });
    }

    // Ikkala tomon ham nol — ko'chiradigan narsa yo'q. Bu daftarga ikkita
    // bo'sh qator yozishga urinish bo'lardi (`assertMovementSigns` ham uni
    // rad etadi), lekin xato xabari kod xatosidek ko'rinardi.
    if (movements.length === 0) {
      throw new BadRequestError(
        "Ko'chirish uchun miqdor noldan katta bo'lishi kerak",
      );
    }

    const fresh = await tx.inventoryStock.findUnique({
      where: { id: locked.target.id },
      include: {
        item: {
          select: { name: true, unit: true, category: { select: { name: true } } },
        },
        location: { select: { name: true } },
      },
    });

    return { fresh, movements, before: locked.source };
  }, TX_OPTIONS);

  logger.warn(
    `[inventory] Xatlov qatori KO'CHIRILDI: ${fromLocationName} · ${fromItemName} ` +
      `(${result.before.quantity}/${result.before.brokenQuantity}) → ` +
      `${targetLocation.name} · ${targetItem.name} ` +
      `(+${result.before.quantity}/${result.before.brokenQuantity}) · ` +
      `to'g'rilash=${targetQuantity - result.before.quantity}/` +
      `${targetBroken - result.before.brokenQuantity} · ` +
      `actor=${userId} sabab="${reason}"`,
  );

  return {
    ...serializeStock(result.fresh),
    moved: true,
    from: {
      stockId: stock.id,
      locationId: stock.locationId,
      locationName: fromLocationName,
      itemId: stock.itemId,
      itemName: fromItemName,
      quantity: result.before.quantity,
      brokenQuantity: result.before.brokenQuantity,
    },
    movements: result.movements.map(({ row, item, location }) =>
      serializeMovement({ ...row, item, location }),
    ),
  };
};

/**
 * XATLOV QATORINI TAHRIRLASH — ANIQ MIQDOR bilan.
 *
 * `adjustStock` bilan bir xil daftar qatorini (`adjustment`) yozadi, lekin
 * kirish shakli boshqa: u yerda FARQ ("-1"), bu yerda ANIQ QIYMAT ("hozir
 * 1 → 3"). Sabab foydalanuvchi tilida: xodim xonada 3 ta parta ko'rib
 * turibdi, "-1" ni esa u hisoblab chiqarishi kerak edi — va aynan shu
 * hisobda xatolashardi.
 *
 * ⚠️ MIQDOR TO'G'RIDAN-TO'G'RI YOZILMAYDI. `postMovement()` daftarning
 * yagona yozuv nuqtasi bo'lib qoladi: farq LOCK OSTIDA hisoblanadi va
 * `adjustment` qatori sifatida yoziladi. Aks holda bu "o'qi → hisobla →
 * yoz" bo'lib qolardi va ikkita parallel tahrir bir-birini yo'q qilardi.
 *
 * ⚠️ `adjustStock` (delta) VA `POST /stocks/adjust` SAQLANADI — eski
 * mijoz buzilmasin.
 *
 * ── IKKI YO'L ────────────────────────────────
 *
 * `locationId` / `itemId` ixtiyoriy: oynada xona va jihoz ham qayta
 * tanlanadi, qotib turmaydi.
 *
 *   A) Juftlik O'ZGARMAGAN → bitta `adjustment` qatori (quyidagi yo'l).
 *   B) Juftlik O'ZGARGAN   → KO'CHIRISH (`moveStockRow`): eskisidan
 *      chiqim, yangisiga kirim. Sabab — kalit `@@unique([locationId,
 *      itemId])`, ya'ni bu boshqa QATOR.
 *
 * ⚠️ Ko'chirishga deyarli TO'SIQ QO'YILMAYDI: muhrlangan hisobot yoki
 * o'tkazma akti bo'lsa ham hech narsa o'chmaydi — tarix eski qatorda
 * qoladi va daftar ikkala tomonni yozadi. Bu `deleteStock` dan FARQLI
 * (u yerda yozuvning O'ZI yo'qolardi), shuning uchun u yerdagi to'siqlar
 * bu yerga KO'CHIRILMAGAN.
 *
 * YAGONA istisno — bekor qilinmagan `broken` zarari bo'lgan qator:
 * `cancelDamage` teskari qatorni MANBA qatorga yozadi, ya'ni yaroqsizlar
 * ko'chib ketsa zararni umuman bekor qilib bo'lmay qolardi
 * (`moveStockRow` ichidagi izoh).
 *
 * @param {string} stockId
 * @param {object} data - { quantity, brokenQuantity, note, reason,
 *   occurredAt, locationId?, itemId? }
 *   `quantity` / `brokenQuantity` — ABSOLYUT qiymatlar
 * @param {string} userId
 */
const updateStock = async (stockId, data, userId) => {
  const targetQuantity = parseQuantity(data.quantity, "Jami miqdor");
  // Bo'sh maydon = 0 (`parseOptionalQuantity` ichida o'sha `parseQuantity`):
  // oyna yaroqsizlar katagini bo'sh qoldirsa ham tahrir o'tishi kerak.
  const targetBroken = parseOptionalQuantity(data.brokenQuantity, "Yaroqsiz miqdor");

  if (targetBroken > targetQuantity) {
    throw new BadRequestError(
      "Yaroqsizlar soni jami miqdordan ko'p bo'lishi mumkin emas",
    );
  }

  // Sabab MAJBURIY — `adjustStock` dagi bilan bir xil mulohaza: sababsiz
  // bu "xatoni yashirish tugmasi" bo'lib qolardi.
  const reason = data.reason?.trim();
  if (!reason) throw new BadRequestError("Tahrirlash sababi majburiy");

  const occurredAt = parseOccurredAt(data.occurredAt);
  const noteProvided = data.note !== undefined;
  const note = noteProvided ? data.note?.trim() || "" : undefined;

  const stock = await prisma.inventoryStock.findUnique({
    where: { id: stockId },
    include: {
      item: { select: { name: true, unit: true, category: { select: { name: true } } } },
      location: { select: { name: true } },
    },
  });
  if (!stock) throw new NotFoundError("Xatlov qatori topilmadi");

  // Bo'sh satr "tanlanmagan" degani, "boshqasiga o'tkaz" degani emas
  const targetLocationId = data.locationId || stock.locationId;
  const targetItemId = data.itemId || stock.itemId;

  if (targetLocationId !== stock.locationId || targetItemId !== stock.itemId) {
    return moveStockRow({
      stock,
      targetLocationId,
      targetItemId,
      targetQuantity,
      targetBroken,
      reason,
      occurredAt,
      note,
      noteProvided,
      userId,
    });
  }

  const result = await prisma.$transaction(async (tx) => {
    // 1) `update` — qator LOCK'ini oladi VA joriy miqdorni qaytaradi.
    //    Farq AYNAN shu lock ostida hisoblanishi shart; oldin o'qilgan
    //    `stock` faqat nom va tekshiruvlar uchun.
    //    Izoh berilmagan bo'lsa ham HAQIQIY update yuboriladi
    //    (`updatedAt`): bo'sh `data` bilan lock kafolatlanmasdi.
    const locked = await tx.inventoryStock.update({
      where: { id: stockId },
      data: noteProvided ? { note } : { updatedAt: new Date() },
    });

    const quantityDelta = targetQuantity - locked.quantity;
    const brokenDelta = targetBroken - locked.brokenQuantity;

    // Miqdor o'zgarmagan bo'lsa daftarga YOZILMAYDI — faqat izoh
    // o'zgargan bo'lishi mumkin. Bo'sh qator daftarni shovqin bilan
    // to'ldirardi (`assertMovementSigns` ham uni rad etadi).
    const movement =
      quantityDelta === 0 && brokenDelta === 0
        ? null
        : await postMovement(tx, {
            stock: locked,
            type: "adjustment",
            quantityDelta,
            brokenDelta,
            occurredAt,
            itemName: stock.item.name,
            note: reason,
            createdBy: userId,
          });

    const fresh = await tx.inventoryStock.findUnique({
      where: { id: stockId },
      include: {
        item: {
          select: { name: true, unit: true, category: { select: { name: true } } },
        },
        location: { select: { name: true } },
      },
    });

    return { fresh, movement, before: locked };
  }, TX_OPTIONS);

  logger.warn(
    `[inventory] Xatlov qatori tahrirlandi: ${stock.location.name} · ` +
      `${stock.item.name} · ${result.before.quantity}/${result.before.brokenQuantity} → ` +
      `${targetQuantity}/${targetBroken} · actor=${userId} sabab="${reason}"`,
  );

  return {
    ...serializeStock(result.fresh),
    moved: false,
    movement: result.movement
      ? serializeMovement({
          ...result.movement,
          item: stock.item,
          location: stock.location,
        })
      : null,
  };
};

/**
 * O'chirishga to'sqinlik qiladigan bog'lanishlar — foydalanuvchiga
 * ko'rsatiladigan jumlalar.
 *
 * `deleteStock` ham, `getStockUsage` ham SHU funksiyani chaqiradi: matn
 * ikki joyda yozilsa, oyna "o'chirish mumkin" deb ko'rsatib turgan qator
 * serverda rad etilib qolardi.
 */
const stockDeleteBlockers = (
  itemName,
  locationName,
  { damages, submittedCheckLines, transferMovements },
) => {
  const blockers = [];

  if (damages > 0) {
    blockers.push(
      `"${itemName}" (${locationName}) ga bog'liq ${damages} ta zarar yozuvi ` +
        `bor — bu pul bilan bog'liq. O'chirish o'rniga hisobdan chiqaring.`,
    );
  }
  if (submittedCheckLines > 0) {
    blockers.push(
      `"${itemName}" (${locationName}) ${submittedCheckLines} ta yuborilgan ` +
        `kunlik hisobotda qayd etilgan — o'chirish muhrlangan hisobotni ` +
        `qayta yozardi. Hisobdan chiqaring.`,
    );
  }
  // ⚠️ O'TKAZMA AKTI — `itemDeleteBlockers` dagi bilan AYNAN bir xil
  // qoida. Akt "kim topshirdi, kim qabul qildi" degan javobgarlik
  // hujjati; uning daftardagi oyog'i o'chirilsa, akt mavjud bo'lmagan
  // jihozga ishora qilib turardi va `inventoryReconcile` buni topa
  // olmasdi (qatorning o'zi yo'q).
  if (transferMovements > 0) {
    blockers.push(
      `"${itemName}" (${locationName}) ${transferMovements} ta topshirish-qabul ` +
        `qilish aktida qayd etilgan — akt muhrlangan hujjat. Hisobdan chiqaring.`,
    );
  }

  return blockers;
};

/**
 * O'chirishga to'sqinlik qiladigan bog'lanishlarni SANAYDI.
 *
 * `client` — `prisma` yoki TRANZAKSIYA klienti. `deleteStock` uni
 * tranzaksiya ICHIDA, qator lock'i olingandan KEYIN chaqiradi: sanoq
 * tashqarida o'qilsa, "sanadim → hisobot yuborildi → o'chirdim" oynasi
 * ochilib qolardi va muhrlangan hisobotning satri yo'q bo'lardi.
 */
const countStockBlockers = async (client, stockId) => {
  const [damages, submittedCheckLines, transferMovements] = await Promise.all([
    client.inventoryDamage.count({ where: { stockId } }),
    client.inventoryCheckLine.count({
      where: { stockId, check: { submittedAt: { not: null } } },
    }),
    client.inventoryMovement.count({
      where: { stockId, transferId: { not: null } },
    }),
  ]);

  return { damages, submittedCheckLines, transferMovements };
};

/**
 * XATLOV QATORINI O'CHIRISH — "bu yozuv umuman bo'lmasligi kerak edi".
 *
 * ⚠️ Bu `write_off` EMAS. Hisobdan chiqarish HODISANI qayd etadi (jihoz
 * bor edi, sindi/eskirdi, endi yo'q) va tarixni SAQLAYDI. O'chirish esa
 * KIRITISH XATOSINI tuzatadi: qator noto'g'ri xonaga kiritilgan yoki
 * ikki marta kiritilgan — ya'ni bu miqdor hech qachon mavjud bo'lmagan.
 * Shuning uchun u haqiqiy DELETE va daftar qatorlarini ham olib tashlaydi.
 *
 * ⚠️ PUL yoki MUHRLANGAN HUJJAT bog'langan bo'lsa RAD ETILADI:
 *   - zarar yozuvi (`InventoryDamage`) — undiruv va pul bilan bog'liq;
 *   - yuborilgan kunlik hisobot satri — muhrlangan hujjat, uni qayta
 *     yozish "bugun nechta sindi" degan javobni jimgina o'zgartirardi;
 *   - topshirish-qabul qilish akti (`transferId` li daftar qatori) —
 *     "kim topshirdi, kim qabul qildi" degan javobgarlik hujjati.
 * QORALAMA hisobot satrlari esa hali hech narsani anglatmaydi va
 * o'chiriladi (varaq yuborilganda sanoqlar qaytadan hisoblanadi).
 *
 * ⚠️ To'siqlar TRANZAKSIYA ICHIDA, qator lock'i olingandan KEYIN
 * tekshiriladi va `deleteMany` qoralama bo'yicha FILTRLANADI — ikkalasi
 * birga "sanadim → hisobot yuborildi → o'chirdim" oynasini yopadi.
 *
 * @param {string} stockId
 * @param {object} data - { reason }
 * @param {string} userId
 */
const deleteStock = async (stockId, data, userId) => {
  const reason = data?.reason?.trim();
  if (!reason) throw new BadRequestError("O'chirish sababi majburiy");

  const stock = await prisma.inventoryStock.findUnique({
    where: { id: stockId },
    include: {
      item: { select: { name: true, unit: true, category: { select: { name: true } } } },
      location: { select: { name: true } },
    },
  });
  if (!stock) throw new NotFoundError("Xatlov qatori topilmadi");

  const itemName = stock.item?.name ?? "Jihoz";
  const locationName = stock.location?.name ?? "Noma'lum";

  const result = await prisma.$transaction(async (tx) => {
    // 1) QATOR LOCK'i — sanoqdan OLDIN. `postMovement` miqdorni
    //    `increment` bilan yozadi, ya'ni kunlik hisobotni yuborish ham,
    //    zarar qayd etish ham shu qatorni lock qiladi. Lock avval
    //    olinmasa, "sanadim → hisobot yuborildi → o'chirdim" oynasi
    //    ochilib qolardi.
    await tx.inventoryStock.update({
      where: { id: stockId },
      data: { updatedAt: new Date() },
    });

    // 2) TO'SIQLAR TRANZAKSIYA ICHIDA qayta o'qiladi. `getStockUsage`
    //    tashqarida o'qiydi (oyna uchun), lekin QAROR shu yerda
    //    qabul qilinadi.
    const counts = await countStockBlockers(tx, stockId);
    const blockers = stockDeleteBlockers(itemName, locationName, counts);
    if (blockers.length > 0) throw new BadRequestError(blockers.join(" "));

    // 3) ⚠️ FAQAT QORALAMA satrlar o'chadi — filtr MAJBURIY, yuqoridagi
    //    sanoqqa ishonib qolmaydi. Yuborilgan satr qolsa,
    //    `InventoryCheckLine.stock` dagi `Restrict` FK butun o'chirishni
    //    yiqitadi: muhrlangan hisobotni buzish STRUKTURAVIY IMKONSIZ
    //    bo'ladi, sanoq bilan o'chirish orasidagi oyna qanchalik tor
    //    bo'lishidan qat'i nazar.
    const checkLines = await tx.inventoryCheckLine.deleteMany({
      where: { stockId, check: { submittedAt: null } },
    });
    const movements = await tx.inventoryMovement.deleteMany({ where: { stockId } });
    await tx.inventoryStock.delete({ where: { id: stockId } });

    return { checkLines: checkLines.count, movements: movements.count };
  }, TX_OPTIONS);

  logger.warn(
    `[inventory] Xatlov qatori O'CHIRILDI: ${locationName} · ${itemName} · ` +
      `miqdor=${stock.quantity}/${stock.brokenQuantity} · ` +
      `daftar=${result.movements} qator · qoralama=${result.checkLines} satr · ` +
      `actor=${userId} sabab="${reason}"`,
  );

  return {
    id: stockId,
    itemName,
    locationName,
    quantity: stock.quantity,
    brokenQuantity: stock.brokenQuantity,
    movementsDeleted: result.movements,
    checkLinesDeleted: result.checkLines,
    message: `"${itemName}" xatlovdan o'chirildi`,
  };
};

/**
 * O'CHIRISHDAN OLDINGI TEKSHIRUV — "nima yo'qoladi va nima to'sib turibdi".
 *
 * Oyna o'chirish tugmasini bosishdan OLDIN shu javobni o'qiydi: to'siqni
 * xato xabari sifatida ko'rsatish kech bo'lardi.
 *
 * @param {string} stockId
 */
const getStockUsage = async (stockId) => {
  const stock = await prisma.inventoryStock.findUnique({
    where: { id: stockId },
    include: {
      item: { select: { name: true, unit: true, category: { select: { name: true } } } },
      location: { select: { name: true } },
    },
  });
  if (!stock) throw new NotFoundError("Xatlov qatori topilmadi");

  const [movements, draftCheckLines, counts] = await Promise.all([
    prisma.inventoryMovement.count({ where: { stockId } }),
    prisma.inventoryCheckLine.count({
      where: { stockId, check: { submittedAt: null } },
    }),
    // To'siqlar `deleteStock` bilan BITTA funksiyadan — matn ikki joyda
    // hisoblansa, oyna "o'chirish mumkin" deb ko'rsatib turgan qator
    // serverda rad etilib qolardi.
    countStockBlockers(prisma, stockId),
  ]);

  const itemName = stock.item?.name ?? "Jihoz";
  const locationName = stock.location?.name ?? "Noma'lum";

  const blockers = stockDeleteBlockers(itemName, locationName, counts);

  return {
    stock: serializeStock(stock),
    movements,
    draftCheckLines,
    submittedCheckLines: counts.submittedCheckLines,
    damages: counts.damages,
    transferMovements: counts.transferMovements,
    canDelete: blockers.length === 0,
    blockers,
  };
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
  updateStock,
  deleteStock,
  getStockUsage,
};
