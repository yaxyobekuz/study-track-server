/**
 * JIHOZ NOMLARI — katalog. "Parta", "Stul", "Piyola", "Qoshiq", "Proyektor".
 *
 * ⚠️ RO'YXAT OLDINDAN BELGILANMAGAN va belgilanmasligi ham kerak. Oshxonada
 * piyola va qoshiq, sport zalida to'p va gantel, laboratoriyada probirka
 * bo'ladi — maktab ishi davomida "biz o'ylamagan" buyum har doim chiqadi.
 * Shuning uchun jihoz turi ENUM emas, KATALOG: yangi qator qo'shish oddiy
 * ma'lumot kiritish amali, kod o'zgarishi emas.
 *
 * ⚠️ NARX VERSIYALANMAYDI — `Tariff` bilan ATAYLAB QARAMA-QARSHI.
 * Tarifda narx versiyalanadi, chunki hisob-faktura KELAJAKDA shakllanadi
 * ("avgustdan boshlab 600 000"). Zararda esa narx O'TMISHDAGI BITTA ONGA
 * tegishli: parta AYNAN 12-sentabrda sindi. Shuning uchun narx hodisa
 * paytida `InventoryDamage.unitPrice` ga MUHRLANADI va katalogdagi qiymat
 * keyin oshsa ham o'tgan zararga tegilmaydi — narx versiyalari jadvali
 * bu yerda faqat ortiqcha murakkablik bo'lardi.
 */

const prisma = require("../config/prisma");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const logger = require("../utils/logger");
const { parseAmount, formatAmount, Decimal } = require("../helpers/money.helpers");

const serializeItem = (row, { stockCount, totalQuantity } = {}) => {
  const { category, ...rest } = row;

  return {
    ...rest,
    unitPrice: formatAmount(row.unitPrice),
    categoryName: category?.name ?? null,
    ...(stockCount != null ? { stockCount } : {}),
    ...(totalQuantity != null ? { totalQuantity } : {}),
  };
};

/**
 * Jihoz turlari (sahifalangan — katalog yuzlab qatorga yetishi mumkin:
 * oshxona buyumlarining o'zi o'nlab bo'ladi).
 *
 * @param {object} req - query: { categoryId, search, status, page, limit }
 */
const getItems = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const where = {};
  if (query.categoryId) where.categoryId = query.categoryId;
  where.isArchived = query.status === "archived";

  if (query.search?.trim()) {
    where.name = { contains: query.search.trim(), mode: "insensitive" };
  }

  const [rows, total] = await Promise.all([
    prisma.inventoryItem.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      skip,
      take: limit,
      include: { category: { select: { name: true } } },
    }),
    prisma.inventoryItem.count({ where }),
  ]);

  // Xatlovdagi jami miqdor — "bu jihozdan maktabda nechta bor" savoliga
  // javob. Bitta guruhlangan so'rov, jihoz soniga bog'liq emas.
  const stocks = rows.length
    ? await prisma.inventoryStock.groupBy({
        by: ["itemId"],
        where: { itemId: { in: rows.map((r) => r.id) } },
        _sum: { quantity: true },
        _count: { _all: true },
      })
    : [];
  const stockById = new Map(stocks.map((s) => [s.itemId, s]));

  return formatPaginationResponse(
    rows.map((row) => {
      const stock = stockById.get(row.id);
      return serializeItem(row, {
        stockCount: stock?._count._all ?? 0,
        totalQuantity: stock?._sum.quantity ?? 0,
      });
    }),
    total,
    page,
    limit,
  );
};

/**
 * Faol jihoz turlari — tanlagichlar uchun (sahifalanmaydi).
 * Xatlovga qator qo'shishda va zarar kiritishda ishlatiladi.
 */
const getActiveItems = async (query = {}) => {
  const where = { isArchived: false };
  if (query.categoryId) where.categoryId = query.categoryId;

  const rows = await prisma.inventoryItem.findMany({
    where,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { category: { select: { name: true } } },
  });

  return rows.map((row) => serializeItem(row));
};

/**
 * Jihoz turi mavjud va arxivlanmaganligini tekshiradi.
 * @param {string} itemId
 */
const assertActiveItem = async (itemId) => {
  if (!itemId) throw new BadRequestError("Jihoz tanlanmagan");

  const item = await prisma.inventoryItem.findUnique({
    where: { id: itemId },
    include: { category: { select: { name: true } } },
  });
  if (!item) throw new NotFoundError("Jihoz topilmadi");
  if (item.isArchived) throw new BadRequestError(`"${item.name}" arxivlangan`);

  return item;
};

const parseName = async (rawName, { excludeId } = {}) => {
  const name = rawName?.trim();
  if (!name) throw new BadRequestError("Jihoz nomi majburiy");

  const existing = await prisma.inventoryItem.findUnique({ where: { name } });
  if (existing && existing.id !== excludeId) {
    throw new BadRequestError(`"${name}" nomli jihoz allaqachon bor`);
  }

  return name;
};

const parseUnit = (value) => {
  const unit = value?.trim();
  if (!unit) return "dona";
  if (unit.length > 24) throw new BadRequestError("O'lchov birligi juda uzun");
  return unit;
};

/** @param {object} data - { categoryId, name, unit, unitPrice, description, sortOrder } */
const createItem = async (data, userId) => {
  const { assertActiveCategory } = require("./inventoryCategory.service");

  const [category, name] = await Promise.all([
    assertActiveCategory(data.categoryId),
    parseName(data.name),
  ]);

  // Nol qonuniy: qiymati hisoblanmaydigan buyum uchun zarar qayd etiladi-yu,
  // pul undirilmaydi (grant tarifi 0 bo'lgani bilan bir xil mulohaza).
  const unitPrice = parseAmount(data.unitPrice ?? 0, "Narx");

  const row = await prisma.inventoryItem.create({
    data: {
      categoryId: category.id,
      name,
      unit: parseUnit(data.unit),
      unitPrice,
      description: data.description?.trim() || "",
      sortOrder: Number.isInteger(Number(data.sortOrder)) ? Number(data.sortOrder) : 0,
      createdBy: userId,
    },
    include: { category: { select: { name: true } } },
  });

  return serializeItem(row, { stockCount: 0, totalQuantity: 0 });
};

/**
 * Tahrirlash — narx ham o'zgartiriladi.
 *
 * ⚠️ Narxni o'zgartirish O'TGAN ZARARLARGA TA'SIR QILMAYDI: ular
 * `InventoryDamage.unitPrice` da muhrlangan. Yangi narx faqat BUNDAN
 * KEYINGI hodisalarga qo'llanadi — tarif narxi oshganda o'tgan
 * hisob-fakturalarga tegilmagani bilan bir xil qoida.
 */
const updateItem = async (id, data) => {
  const item = await prisma.inventoryItem.findUnique({ where: { id } });
  if (!item) throw new NotFoundError("Jihoz topilmadi");

  const payload = {};

  if (data.name !== undefined) payload.name = await parseName(data.name, { excludeId: id });
  if (data.categoryId !== undefined && data.categoryId !== item.categoryId) {
    const { assertActiveCategory } = require("./inventoryCategory.service");
    const category = await assertActiveCategory(data.categoryId);
    payload.categoryId = category.id;
  }
  if (data.unit !== undefined) payload.unit = parseUnit(data.unit);
  if (data.unitPrice !== undefined) payload.unitPrice = parseAmount(data.unitPrice, "Narx");
  if (data.description !== undefined) payload.description = data.description?.trim() || "";
  if (data.sortOrder !== undefined) payload.sortOrder = Number(data.sortOrder) || 0;

  const updated = await prisma.inventoryItem.update({
    where: { id },
    data: payload,
    include: { category: { select: { name: true } } },
  });

  return serializeItem(updated);
};

/**
 * Arxivlash / arxivdan qaytarish.
 *
 * ⚠️ Xatlovda MIQDORI BOR jihozni arxivlab bo'lmaydi: "xonada 20 ta parta
 * bor, lekin parta katalogda yo'q" degan holat kunlik hisobotni buzardi.
 * Avval hisobdan chiqariladi (`write_off`), keyin arxivlanadi.
 */
const archiveItem = async (id, isArchived) => {
  const item = await prisma.inventoryItem.findUnique({ where: { id } });
  if (!item) throw new NotFoundError("Jihoz topilmadi");

  const archive = Boolean(isArchived);

  if (archive) {
    const stock = await prisma.inventoryStock.aggregate({
      where: { itemId: id },
      _sum: { quantity: true },
    });
    const remaining = stock._sum.quantity ?? 0;

    if (remaining > 0) {
      throw new BadRequestError(
        `"${item.name}" xatlovda ${remaining} ta turibdi — avval hisobdan ` +
          `chiqaring, keyin arxivlang`,
      );
    }
  }

  const updated = await prisma.inventoryItem.update({
    where: { id },
    data: { isArchived: archive },
    include: { category: { select: { name: true } } },
  });

  return {
    ...serializeItem(updated),
    message: archive
      ? `"${item.name}" arxivlandi`
      : `"${item.name}" arxivdan qaytarildi`,
  };
};

// ─────────────────────────────────────────────
// O'CHIRISH — ARXIVLASHDAN FARQLI
// ─────────────────────────────────────────────

/**
 * Jihoz bilan bog'liq hamma narsani bitta o'qishda sanaydi.
 *
 * `deleteItem` ham, `getItemUsage` ham SHU funksiyani chaqiradi: to'siq
 * matni ikki joyda yozilsa, oyna "o'chirish mumkin" deb ko'rsatib turgan
 * qator serverda rad etilib qolardi.
 *
 * @param {string} itemId
 * @param {object} [client=prisma] - `prisma` yoki TRANZAKSIYA klienti.
 *   `deleteItem` uni tranzaksiya ICHIDA chaqiradi: sanoq tashqarida
 *   o'qilsa, "sanadim → omborchi jihoz kiritdi → o'chirdim" oynasi
 *   ochilib qolardi.
 */
const countItemUsage = async (itemId, client = prisma) => {
  const [stockAgg, occupiedRooms, movements, transferLines, damages, submitted, drafts] =
    await Promise.all([
      client.inventoryStock.aggregate({
        where: { itemId },
        _sum: { quantity: true },
        _count: { _all: true },
      }),
      client.inventoryStock.count({ where: { itemId, quantity: { gt: 0 } } }),
      client.inventoryMovement.count({ where: { itemId } }),
      client.inventoryTransferLine.count({ where: { itemId } }),
      client.inventoryDamage.count({ where: { itemId } }),
      client.inventoryCheckLine.count({
        where: { itemId, check: { submittedAt: { not: null } } },
      }),
      client.inventoryCheckLine.count({
        where: { itemId, check: { submittedAt: null } },
      }),
    ]);

  return {
    stockRows: stockAgg._count._all ?? 0,
    totalQuantity: stockAgg._sum.quantity ?? 0,
    occupiedRooms,
    movements,
    transferLines,
    damages,
    submittedCheckLines: submitted,
    draftCheckLines: drafts,
  };
};

/**
 * To'siqlar — foydalanuvchiga ko'rsatiladigan jumlalar.
 *
 * ⚠️ Hammasi BITTA ro'yxatda sanab o'tiladi: birinchisini tuzatib qaytgan
 * xodim ikkinchisiga urilsa, bu "har safar boshqa xato" degan taassurot
 * qoldirardi.
 */
const itemDeleteBlockers = (name, usage) => {
  const blockers = [];

  if (usage.totalQuantity > 0) {
    blockers.push(
      `"${name}" hozir ${usage.occupiedRooms} ta xonada ` +
        `${usage.totalQuantity} ta turibdi — avval hisobdan chiqaring.`,
    );
  }
  if (usage.damages > 0) {
    blockers.push(
      `"${name}" bo'yicha ${usage.damages} ta zarar yozuvi bor — ` +
        `bu pul bilan bog'liq.`,
    );
  }
  if (usage.transferLines > 0) {
    blockers.push(
      `"${name}" ${usage.transferLines} ta topshirish-qabul qilish aktida ` +
        `qayd etilgan — akt muhrlangan hujjat.`,
    );
  }
  if (usage.submittedCheckLines > 0) {
    blockers.push(
      `"${name}" ${usage.submittedCheckLines} ta yuborilgan kunlik hisobotda ` +
        `qayd etilgan — o'chirish muhrlangan hisobotni qayta yozardi.`,
    );
  }

  return blockers;
};

/**
 * KATALOGDAN O'CHIRISH — "bu jihoz umuman bo'lmasligi kerak edi".
 *
 * ⚠️ Bu ARXIVLASH EMAS. Arxivlash jihozni tanlagichlardan olib tashlaydi,
 * lekin tarixni saqlaydi: o'tgan zararlar, aktlar va hisobotlar unga
 * ishora qilib turaveradi. O'chirish esa KIRITISH XATOSI uchun —
 * "Proyekter" deb xato yozilgan, ikki marta kiritilgan, sinab ko'rilgan
 * qator. Shuning uchun tarixi bor jihoz O'CHIRILMAYDI, arxivlanadi.
 *
 * @param {string} id
 * @param {string} userId
 */
const deleteItem = async (id, userId) => {
  const item = await prisma.inventoryItem.findUnique({ where: { id } });
  if (!item) throw new NotFoundError("Jihoz topilmadi");

  const result = await prisma.$transaction(async (tx) => {
    // ⚠️ TO'SIQLAR TRANZAKSIYA ICHIDA sanaladi. Tashqarida sanalganda
    // "sanadim → omborchi 20 ta parta kiritdi → o'chirdim" oynasi ochiq
    // qolardi va omborchiga muvaffaqiyat deb aytilgan kirim daftar
    // qatori bilan birga jimgina yo'q bo'lardi.
    const usage = await countItemUsage(id, tx);
    const blockers = itemDeleteBlockers(item.name, usage);

    if (blockers.length > 0) {
      throw new BadRequestError(
        `${blockers.join(" ")} O'chirish o'rniga arxivlang.`,
      );
    }

    // Faqat QORALAMA satrlar o'chadi — filtr MAJBURIY, yuqoridagi sanoqqa
    // ishonib qolmaydi (`deleteStock` dagi bilan bir xil mulohaza).
    const checkLines = await tx.inventoryCheckLine.deleteMany({
      where: { itemId: id, check: { submittedAt: null } },
    });
    const movements = await tx.inventoryMovement.deleteMany({ where: { itemId: id } });
    // ⚠️ FAQAT BO'SH xatlov qatorlari. Sanoq bilan o'chirish orasida
    // kiritilgan miqdor shu filtrda QOLADI va `InventoryStock.item`
    // dagi `Restrict` FK butun tranzaksiyani yiqitadi — jihozni miqdori
    // bilan birga o'chirish STRUKTURAVIY IMKONSIZ bo'ladi.
    const stocks = await tx.inventoryStock.deleteMany({
      where: { itemId: id, quantity: 0 },
    });
    await tx.inventoryItem.delete({ where: { id } });

    return {
      checkLines: checkLines.count,
      movements: movements.count,
      stocks: stocks.count,
    };
    // Uzoq katalog tarixi bo'lsa uchta `deleteMany` standart 5 soniyaga
    // sig'masligi mumkin — xatlov tomonidagi `TX_OPTIONS` bilan bir xil.
  }, { timeout: 20000 });

  logger.warn(
    `[inventory] Katalogdan O'CHIRILDI: "${item.name}" · ` +
      `daftar=${result.movements} qator · xatlov=${result.stocks} qator · ` +
      `qoralama=${result.checkLines} satr · actor=${userId}`,
  );

  return {
    id,
    name: item.name,
    movementsDeleted: result.movements,
    stocksDeleted: result.stocks,
    message: `"${item.name}" o'chirildi`,
  };
};

/**
 * O'CHIRISHDAN OLDINGI TEKSHIRUV — oyna tugmani bosishdan OLDIN o'qiydi.
 * @param {string} id
 */
const getItemUsage = async (id) => {
  const item = await prisma.inventoryItem.findUnique({ where: { id } });
  if (!item) throw new NotFoundError("Jihoz topilmadi");

  const usage = await countItemUsage(id);
  const blockers = itemDeleteBlockers(item.name, usage);

  return {
    item: { id: item.id, name: item.name, unit: item.unit },
    stockRows: usage.stockRows,
    totalQuantity: usage.totalQuantity,
    movements: usage.movements,
    transferLines: usage.transferLines,
    damages: usage.damages,
    submittedCheckLines: usage.submittedCheckLines,
    draftCheckLines: usage.draftCheckLines,
    canDelete: blockers.length === 0,
    blockers,
  };
};

module.exports = {
  serializeItem,
  getItems,
  getActiveItems,
  assertActiveItem,
  createItem,
  updateItem,
  archiveItem,
  deleteItem,
  getItemUsage,
};
