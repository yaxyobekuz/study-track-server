/**
 * TASHQI KIRIM KATEGORIYALARI — katalog.
 *
 * "Ijara", "Kitob sotuvi", "Homiylik" — maktabga o'quvchi to'lovidan tashqari
 * pul qaysi yo'l bilan kelayotgani. Shakli `paymentAccount.service.js` dagi
 * katalog bilan bir xil.
 *
 * ⚠️ Kategoriya HECH QACHON O'CHIRILMAYDI — arxivlanadi. O'tgan kirimlar unga
 * ishora qiladi va hisobotlar shu kesim bo'yicha quriladi; o'chirilsa tarix
 * yo'qolardi. FK ham `Restrict`.
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");

const serializeCategory = (row, { usageCount } = {}) => ({
  ...row,
  ...(usageCount != null ? { usageCount } : {}),
});

/**
 * Kategoriyalar ro'yxati (sahifalanmaydi — ular o'nlab, yuzlab emas).
 *
 * @param {object} query - { status: "active" | "inactive" | "archived" }
 * @returns {Promise<{items: object[], totals: object}>}
 */
const getCategories = async (query = {}) => {
  const filter = {};
  if (query.status === "archived") filter.isArchived = true;
  else {
    filter.isArchived = false;
    if (query.status === "active") filter.isActive = true;
    if (query.status === "inactive") filter.isActive = false;
  }

  const rows = await prisma.incomeCategory.findMany({
    where: filter,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  // Nechta kirimda ishlatilgani — "o'chirib bo'lmaydi" xabarini oldindan
  // ko'rsatish uchun. Bitta guruhlangan so'rov, kategoriya soniga bog'liq emas.
  const usage = await prisma.externalIncome.groupBy({
    by: ["categoryId"],
    _count: { _all: true },
  });
  const usageById = new Map(usage.map((u) => [u.categoryId, u._count._all]));

  return {
    items: rows.map((row) =>
      serializeCategory(row, { usageCount: usageById.get(row.id) ?? 0 }),
    ),
    totals: { count: rows.length },
  };
};

/**
 * Faol kategoriya mavjudligini tekshiradi (kirim yozishdan oldin).
 * `assertActiveAccount` bilan bir xil vazifa.
 *
 * @param {string} categoryId
 * @returns {Promise<object>}
 */
const assertActiveCategory = async (categoryId) => {
  if (!categoryId) throw new BadRequestError("Kategoriya tanlanmagan");

  const category = await prisma.incomeCategory.findUnique({
    where: { id: categoryId },
  });
  if (!category) throw new NotFoundError("Kategoriya topilmadi");

  if (category.isArchived || !category.isActive) {
    throw new BadRequestError(`"${category.name}" faol emas`);
  }

  return category;
};

const parseName = async (rawName, { excludeId } = {}) => {
  const name = rawName?.trim();
  if (!name) throw new BadRequestError("Kategoriya nomi majburiy");

  const existing = await prisma.incomeCategory.findUnique({ where: { name } });
  if (existing && existing.id !== excludeId) {
    throw new BadRequestError(`"${name}" nomli kategoriya allaqachon bor`);
  }

  return name;
};

/**
 * @param {object} data - { name, sortOrder }
 * @param {string} userId
 */
const createCategory = async (data, userId) => {
  const name = await parseName(data.name);

  const row = await prisma.incomeCategory.create({
    data: {
      name,
      sortOrder: Number.isInteger(Number(data.sortOrder)) ? Number(data.sortOrder) : 0,
      createdBy: userId,
    },
  });

  return serializeCategory(row, { usageCount: 0 });
};

/**
 * Nomni o'zgartirish MUMKIN, lekin u o'tgan kirimlarga ta'sir qilmaydi:
 * kirim hujjatida nom MUHRLANGAN (`categoryName`).
 *
 * @param {string} id
 * @param {object} data - { name, isActive, sortOrder }
 */
const updateCategory = async (id, data) => {
  const category = await prisma.incomeCategory.findUnique({ where: { id } });
  if (!category) throw new NotFoundError("Kategoriya topilmadi");

  const payload = {};

  if (data.name !== undefined) {
    payload.name = await parseName(data.name, { excludeId: id });
  }
  if (data.isActive !== undefined) payload.isActive = Boolean(data.isActive);
  if (data.sortOrder !== undefined) payload.sortOrder = Number(data.sortOrder) || 0;

  const updated = await prisma.incomeCategory.update({ where: { id }, data: payload });
  return serializeCategory(updated);
};

/**
 * Arxivlash / arxivdan qaytarish.
 *
 * O'chirish YO'Q: ishlatilgan kategoriyani o'chirish o'tgan hisobotni buzardi,
 * ishlatilmaganini o'chirishga esa alohida yo'l ochishning ma'nosi yo'q —
 * arxivlangani ro'yxatlarda ko'rinmaydi.
 *
 * @param {string} id
 * @param {boolean} isArchived
 */
const archiveCategory = async (id, isArchived) => {
  const category = await prisma.incomeCategory.findUnique({ where: { id } });
  if (!category) throw new NotFoundError("Kategoriya topilmadi");

  const updated = await prisma.incomeCategory.update({
    where: { id },
    data: { isArchived: Boolean(isArchived) },
  });

  return {
    ...serializeCategory(updated),
    message: isArchived
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
