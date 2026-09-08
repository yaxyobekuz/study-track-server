/**
 * XARAJAT KATEGORIYALARI — katalog.
 *
 * "Kommunal", "Ta'mirlash", "Oziq-ovqat" — maktab pulini qayerga sarflayotgani.
 *
 * ⚠️ XODIM OYLIGI BU YERDA EMAS. U alohida mexanizm (PayrollEntry +
 * SalaryPayment), chunki oylik har oy avtomat hisoblanadi va qarz hosil
 * qiladi; xarajat esa bir martalik hodisa. Shakli `paymentAccount.service.js` dagi
 * katalog bilan bir xil.
 *
 * ⚠️ ISHLATILGAN kategoriya HECH QACHON O'CHIRILMAYDI — arxivlanadi. O'tgan
 * xarajatlar unga ishora qiladi va hisobotlar shu kesim bo'yicha quriladi;
 * o'chirilsa tarix yo'qolardi. FK ham `Restrict`.
 *
 * Bironta xarajatda ishlatilmagan kategoriya esa O'CHIRILADI: u hali hech
 * qanday tarixning bir qismi emas, xato yozilgan qatorni "arxivlangan" deb
 * saqlab yurish katalogni keraksiz qatorlar bilan to'ldirardi. Chegara
 * bitta va u ISHLATILGANLIKDA (`staffSalary` va `studentTariff` bilan bir
 * xil qoida).
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

  const rows = await prisma.expenseCategory.findMany({
    where: filter,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  // Nechta xarajatda ishlatilgani — "o'chirib bo'lmaydi" xabarini oldindan
  // ko'rsatish uchun. Bitta guruhlangan so'rov, kategoriya soniga bog'liq emas.
  const usage = await prisma.expense.groupBy({
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
 * Faol kategoriya mavjudligini tekshiradi (xarajat yozishdan oldin).
 * `assertActiveAccount` bilan bir xil vazifa.
 *
 * @param {string} categoryId
 * @returns {Promise<object>}
 */
const assertActiveCategory = async (categoryId) => {
  if (!categoryId) throw new BadRequestError("Kategoriya tanlanmagan");

  const category = await prisma.expenseCategory.findUnique({
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

  const existing = await prisma.expenseCategory.findUnique({ where: { name } });
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

  const row = await prisma.expenseCategory.create({
    data: {
      name,
      // EBITDA'dan chiqarish — soliq va amortizatsiya uchun. Sukut false:
      // belgilanmagunicha EBITDA sof foydaga teng bo'lib turadi.
      excludeFromEbitda: Boolean(data.excludeFromEbitda),
      sortOrder: Number.isInteger(Number(data.sortOrder)) ? Number(data.sortOrder) : 0,
      createdBy: userId,
    },
  });

  return serializeCategory(row, { usageCount: 0 });
};

/**
 * Nomni o'zgartirish MUMKIN, lekin u o'tgan xarajatlarga ta'sir qilmaydi:
 * xarajat hujjatida nom MUHRLANGAN (`categoryName`).
 *
 * @param {string} id
 * @param {object} data - { name, isActive, sortOrder }
 */
const updateCategory = async (id, data) => {
  const category = await prisma.expenseCategory.findUnique({ where: { id } });
  if (!category) throw new NotFoundError("Kategoriya topilmadi");

  const payload = {};

  if (data.name !== undefined) {
    payload.name = await parseName(data.name, { excludeId: id });
  }
  if (data.isActive !== undefined) payload.isActive = Boolean(data.isActive);
  if (data.sortOrder !== undefined) payload.sortOrder = Number(data.sortOrder) || 0;
  // ⚠️ Bayroq JORIY qaror, snapshot emas: uni o'zgartirish o'tgan oylarning
  // EBITDA raqamini ham qayta hisoblaydi. Bu ATAYLAB — "soliqni EBITDA'ga
  // qo'shib yuborgan ekanmiz" degan xato butun tarixda tuzatilishi kerak.
  if (data.excludeFromEbitda !== undefined) {
    payload.excludeFromEbitda = Boolean(data.excludeFromEbitda);
  }

  const updated = await prisma.expenseCategory.update({ where: { id }, data: payload });
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
  const category = await prisma.expenseCategory.findUnique({ where: { id } });
  if (!category) throw new NotFoundError("Kategoriya topilmadi");

  const updated = await prisma.expenseCategory.update({
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

/**
 * O'chirish — FAQAT bironta xarajatda ishlatilmagan kategoriya.
 * Aks holda arxivlanadi (oylik qoidasi bilan bir xil qoida).
 *
 * @param {string} id
 */
const deleteCategory = async (id) => {
  const category = await prisma.expenseCategory.findUnique({ where: { id } });
  if (!category) throw new NotFoundError("Kategoriya topilmadi");

  const used = await prisma.expense.count({ where: { categoryId: id } });

  if (used > 0) {
    throw new BadRequestError(
      `"${category.name}" ${used} ta xarajatda ishlatilgan — o'chirib bo'lmaydi. ` +
        "Kategoriyani arxivlang.",
    );
  }

  // Byudjet limiti — kategoriyaning o'ziga tegishli sozlama, xarajat emas.
  // Kategoriya o'chsa limit yetim qolardi, shuning uchun u ham ketadi.
  await prisma.$transaction([
    prisma.expenseBudget.deleteMany({ where: { categoryId: id } }),
    prisma.expenseCategory.delete({ where: { id } }),
  ]);

  return { message: `"${category.name}" o'chirildi` };
};

module.exports = {
  serializeCategory,
  getCategories,
  assertActiveCategory,
  createCategory,
  updateCategory,
  archiveCategory,
  deleteCategory,
};
