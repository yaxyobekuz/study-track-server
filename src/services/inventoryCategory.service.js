/**
 * JIHOZ TOIFALARI — katalog.
 *
 * "Mebel", "Texnika", "Oshxona buyumlari", "Sport inventari" — moddiy-texnik
 * bazani kesimlarga ajratadi. Shakli `expenseCategory.service.js` bilan
 * AYNAN bir xil, chunki mulohaza ham bir xil.
 *
 * ⚠️ Toifa HECH QACHON O'CHIRILMAYDI — arxivlanadi. Unga jihozlar, ularga
 * esa o'tgan zarar yozuvlari ishora qiladi; o'chirilsa "bu yil qaysi
 * toifadagi jihozlar ko'p sindi" degan hisobot yo'qolardi. FK ham `Restrict`.
 *
 * ⚠️ FILIAL SCHEMA'SIDA. Tarif/chegirma katalogidan farqli o'laroq bu
 * katalog UMUMIY EMAS: har filialning o'z jihozlari va o'z xonalari bor,
 * shuning uchun `catalogUsage.service.js` (filiallar bo'ylab sanoq) bu
 * yerda KERAK EMAS — sanoq joriy filial bo'yicha to'g'ri javob.
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");

const serializeCategory = (row, { itemCount } = {}) => ({
  ...row,
  ...(itemCount != null ? { itemCount } : {}),
});

/**
 * Toifalar ro'yxati (sahifalanmaydi — ular o'nlab).
 *
 * @param {object} query - { status: "active" | "inactive" | "archived" }
 */
const getCategories = async (query = {}) => {
  const filter = {};
  if (query.status === "archived") filter.isArchived = true;
  else {
    filter.isArchived = false;
    if (query.status === "active") filter.isActive = true;
    if (query.status === "inactive") filter.isActive = false;
  }

  const rows = await prisma.inventoryCategory.findMany({
    where: filter,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  // Nechta jihoz turi bog'langan — "arxivlab bo'lmaydi" xabarini oldindan
  // ko'rsatish uchun. Bitta guruhlangan so'rov.
  const usage = await prisma.inventoryItem.groupBy({
    by: ["categoryId"],
    where: { isArchived: false },
    _count: { _all: true },
  });
  const countById = new Map(usage.map((u) => [u.categoryId, u._count._all]));

  return {
    items: rows.map((row) =>
      serializeCategory(row, { itemCount: countById.get(row.id) ?? 0 }),
    ),
    totals: { count: rows.length },
  };
};

/**
 * Faol toifa mavjudligini tekshiradi (jihoz yaratishdan oldin).
 * @param {string} categoryId
 */
const assertActiveCategory = async (categoryId) => {
  if (!categoryId) throw new BadRequestError("Toifa tanlanmagan");

  const category = await prisma.inventoryCategory.findUnique({
    where: { id: categoryId },
  });
  if (!category) throw new NotFoundError("Toifa topilmadi");

  if (category.isArchived || !category.isActive) {
    throw new BadRequestError(`"${category.name}" faol emas`);
  }

  return category;
};

const parseName = async (rawName, { excludeId } = {}) => {
  const name = rawName?.trim();
  if (!name) throw new BadRequestError("Toifa nomi majburiy");

  const existing = await prisma.inventoryCategory.findUnique({ where: { name } });
  if (existing && existing.id !== excludeId) {
    throw new BadRequestError(`"${name}" nomli toifa allaqachon bor`);
  }

  return name;
};

/** @param {object} data - { name, sortOrder } */
const createCategory = async (data, userId) => {
  const name = await parseName(data.name);

  const row = await prisma.inventoryCategory.create({
    data: {
      name,
      sortOrder: Number.isInteger(Number(data.sortOrder)) ? Number(data.sortOrder) : 0,
      createdBy: userId,
    },
  });

  return serializeCategory(row, { itemCount: 0 });
};

/**
 * Nomni o'zgartirish MUMKIN: zarar hujjatida toifa nomi `itemSnapshot`
 * ichida MUHRLANGAN, ya'ni o'tgan yozuvlar o'z matnini saqlaydi.
 *
 * @param {object} data - { name, isActive, sortOrder }
 */
const updateCategory = async (id, data) => {
  const category = await prisma.inventoryCategory.findUnique({ where: { id } });
  if (!category) throw new NotFoundError("Toifa topilmadi");

  const payload = {};
  if (data.name !== undefined) payload.name = await parseName(data.name, { excludeId: id });
  if (data.isActive !== undefined) payload.isActive = Boolean(data.isActive);
  if (data.sortOrder !== undefined) payload.sortOrder = Number(data.sortOrder) || 0;

  const updated = await prisma.inventoryCategory.update({ where: { id }, data: payload });
  return serializeCategory(updated);
};

/**
 * Arxivlash / arxivdan qaytarish.
 *
 * ⚠️ Ichida ARXIVLANMAGAN jihoz turlari bo'lsa arxivlashga yo'l qo'yilmaydi:
 * aks holda katalogda "toifasiz" jihozlar paydo bo'lardi va yangi jihoz
 * qo'shishda ular ro'yxatda ko'rinmay qolardi.
 */
const archiveCategory = async (id, isArchived) => {
  const category = await prisma.inventoryCategory.findUnique({ where: { id } });
  if (!category) throw new NotFoundError("Toifa topilmadi");

  const archive = Boolean(isArchived);

  if (archive) {
    const activeItems = await prisma.inventoryItem.count({
      where: { categoryId: id, isArchived: false },
    });
    if (activeItems > 0) {
      throw new BadRequestError(
        `"${category.name}" ichida ${activeItems} ta faol jihoz turi bor — ` +
          `avval ularni arxivlang`,
      );
    }
  }

  const updated = await prisma.inventoryCategory.update({
    where: { id },
    data: { isArchived: archive },
  });

  return {
    ...serializeCategory(updated),
    message: archive
      ? `"${category.name}" arxivlandi`
      : `"${category.name}" arxivdan qaytarildi`,
  };
};

module.exports = {
  serializeCategory,
  getCategories,
  assertActiveCategory,
  createCategory,
  updateCategory,
  archiveCategory,
};
