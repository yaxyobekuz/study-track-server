/**
 * Chegirma turlari katalogi — "Aka-uka 10%", "Xodim farzandi 50%".
 *
 * Tarif katalogi bilan bir xil mantiq: bu QOIDA, o'tgan fakt emas. Chegirma
 * summasi hech qachon bu yerda saqlanmaydi — u hisob-faktura chiqarilganda
 * hisoblanib, `MonthlyInvoice.discountSnapshot` ga muhrlanadi.
 *
 * Katalog qatori o'chirilmaydi (arxivlanadi), chunki o'tgan hisob-fakturalar
 * unga `discountId` bilan ishora qiladi.
 */

// KATALOG PLATFORMADA — barcha filiallarga umumiy. Biriktirishlar
// (`StudentDiscount`) esa har filialning o'z schema'sida, shuning uchun
// "nechta o'quvchida ishlatilgan" savoli `catalogUsage.service.js` orqali,
// filiallar bo'ylab hisoblanadi.
const platformPrisma = require("../config/platformPrisma");
const catalogUsage = require("./catalogUsage.service");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { formatAmount } = require("../helpers/money.helpers");
const {
  TYPE_LABELS,
  parseDiscountType,
  parseDiscountValue,
} = require("../helpers/discount.helpers");
const { currentMonthKey, coveringMonthWhere } = require("../helpers/month.helpers");

/**
 * API javobi. `value` har doim 2 xonali string; `valueLabel` — UI uchun
 * tayyor matn, shunda "10.00%" va "10 %" panellar bo'yicha farq qilmaydi.
 */
const serializeDiscount = (row, extra = {}) => ({
  ...row,
  value: formatAmount(row.value),
  typeLabel: TYPE_LABELS[row.type] ?? row.type,
  valueLabel:
    row.type === "percent"
      ? `${Number(row.value)}%`
      : `${formatAmount(row.value)} so'm`,
  ...extra,
});

/**
 * Katalog ro'yxati. `withUsage=true` bo'lsa har bir chegirmaga joriy oyda
 * nechta o'quvchi biriktirilgani qo'shiladi (bitta groupBy so'rovi bilan —
 * qator boshiga so'rov EMAS).
 *
 * @param {object} req - query: page, limit, search, type, status, withUsage
 * @returns {Promise<object>}
 */
const getDiscounts = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const filter = {};
  const search = query.search?.trim();
  if (search) filter.name = { contains: search, mode: "insensitive" };
  if (query.type) filter.type = parseDiscountType(query.type);

  // Arxivlangan — alohida ko'rinish; boshqa hollarda yashiriladi
  if (query.status === "archived") filter.isArchived = true;
  else {
    filter.isArchived = false;
    if (query.status === "active") filter.isActive = true;
    if (query.status === "inactive") filter.isActive = false;
  }

  const [rows, total] = await Promise.all([
    platformPrisma.discount.findMany({
      where: filter,
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      skip,
      take: limit,
    }),
    platformPrisma.discount.count({ where: filter }),
  ]);

  let usage = new Map();
  if (query.withUsage === "true" && rows.length) {
    usage = await catalogUsage.countDiscountAssignments(
      rows.map((r) => r.id),
      coveringMonthWhere(currentMonthKey()),
    );
  }

  const items = rows.map((row) =>
    serializeDiscount(row, { studentCount: usage.get(row.id) ?? 0 }),
  );

  return formatPaginationResponse(items, total, page, limit);
};

/**
 * Bitta chegirma + unga biriktirilgan o'quvchilar soni.
 * @param {string} id
 * @returns {Promise<object>}
 */
const getDiscountById = async (id) => {
  const row = await platformPrisma.discount.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Chegirma topilmadi");

  const month = currentMonthKey();
  const [activeCount, totalCount] = await Promise.all([
    catalogUsage.countDiscountAssignment(id, coveringMonthWhere(month)),
    catalogUsage.countDiscountAssignment(id),
  ]);

  return serializeDiscount(row, { studentCount: activeCount, totalAssignments: totalCount });
};

const rethrowDuplicate = (error, message) => {
  if (error?.code === "P2002") throw new BadRequestError(message);
  throw error;
};

/**
 * Yangi chegirma turi.
 * @param {object} data - { name, description, type, value, isExclusive, isActive }
 * @param {string} userId
 * @returns {Promise<object>}
 */
const createDiscount = async (data, userId) => {
  const name = data.name?.trim();
  if (!name) throw new BadRequestError("Chegirma nomi kiritilmagan");

  const type = parseDiscountType(data.type);
  const value = parseDiscountValue(data.value, type);

  try {
    const row = await platformPrisma.discount.create({
      data: {
        name,
        description: data.description?.trim() || "",
        type,
        // STRING: qator PLATFORMA client'i orqali yoziladi, parseDiscountValue
        // esa FILIAL client'ining Decimal klassini qaytaradi (ikki xil runtime).
        value: formatAmount(value),
        isExclusive: data.isExclusive === true || data.isExclusive === "true",
        isActive: data.isActive === undefined ? true : Boolean(data.isActive),
        createdBy: userId,
      },
    });

    return serializeDiscount(row);
  } catch (error) {
    return rethrowDuplicate(error, "Bu nomdagi chegirma allaqachon mavjud");
  }
};

/**
 * Chegirmani tahrirlaydi.
 *
 * `type` va `value` BIRIKTIRISH BO'LSA o'zgarmaydi: o'zgartirilsa, kelasi
 * oydan boshlab hamma biriktirilgan o'quvchining summasi jimgina siljib
 * ketardi. Narxni o'zgartirish uchun yangi chegirma yaratiladi va o'quvchilar
 * unga ko'chiriladi — tarif versiyalari bilan bir xil doktrina.
 *
 * @param {string} id
 * @param {object} data
 * @returns {Promise<object>}
 */
const updateDiscount = async (id, data) => {
  const row = await platformPrisma.discount.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Chegirma topilmadi");

  const payload = {};

  if (data.name !== undefined) {
    const name = data.name?.trim();
    if (!name) throw new BadRequestError("Chegirma nomi kiritilmagan");
    payload.name = name;
  }
  if (data.description !== undefined) {
    payload.description = data.description?.trim() || "";
  }
  if (data.isActive !== undefined) payload.isActive = Boolean(data.isActive);
  if (data.isExclusive !== undefined) payload.isExclusive = Boolean(data.isExclusive);

  const wantsValueChange = data.type !== undefined || data.value !== undefined;

  if (wantsValueChange) {
    const assignmentCount = await catalogUsage.countDiscountAssignment(id);

    if (assignmentCount > 0) {
      throw new BadRequestError(
        `Bu chegirma ${assignmentCount} ta o'quvchiga biriktirilgan — miqdorini o'zgartirib bo'lmaydi. ` +
          "Yangi chegirma yarating va o'quvchilarni unga ko'chiring.",
      );
    }

    const type = data.type !== undefined ? parseDiscountType(data.type) : row.type;
    payload.type = type;
    // STRING — platformaga yozilyapti (yuqoridagi izohga qarang)
    payload.value = formatAmount(
      parseDiscountValue(data.value !== undefined ? data.value : row.value, type),
    );
  }

  if (Object.keys(payload).length === 0) return serializeDiscount(row);

  try {
    const updated = await platformPrisma.discount.update({ where: { id }, data: payload });
    return serializeDiscount(updated);
  } catch (error) {
    return rethrowDuplicate(error, "Bu nomdagi chegirma allaqachon mavjud");
  }
};

/**
 * Arxivlaydi/tiklaydi. Arxivlangan chegirma yangi biriktirishlarda
 * tanlanmaydi, lekin mavjud biriktirishlar ishlashda davom etadi —
 * o'tgan hisob-fakturalar jimgina o'zgarib ketmasligi kerak.
 *
 * @param {string} id
 * @param {boolean} isArchived
 * @returns {Promise<object>}
 */
const setDiscountArchived = async (id, isArchived) => {
  const row = await platformPrisma.discount.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Chegirma topilmadi");

  const updated = await platformPrisma.discount.update({
    where: { id },
    data: {
      isArchived,
      archivedAt: isArchived ? new Date() : null,
      ...(isArchived ? { isActive: false } : {}),
    },
  });

  return serializeDiscount(updated);
};

/**
 * O'chiradi — faqat hech qachon biriktirilmagan chegirmani.
 * @param {string} id
 * @returns {Promise<{message: string}>}
 */
const deleteDiscount = async (id) => {
  const row = await platformPrisma.discount.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Chegirma topilmadi");

  const used = await catalogUsage.countDiscountAssignment(id);
  if (used > 0) {
    throw new BadRequestError(
      `Bu chegirma ${used} ta biriktirishda ishlatilgan — o'chirib bo'lmaydi. Arxivlang.`,
    );
  }

  await platformPrisma.discount.delete({ where: { id } });

  return { message: "Chegirma o'chirildi" };
};

module.exports = {
  serializeDiscount,
  getDiscounts,
  getDiscountById,
  createDiscount,
  updateDiscount,
  setDiscountArchived,
  deleteDiscount,
};
