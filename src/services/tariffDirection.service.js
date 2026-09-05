/**
 * YO'NALISHLAR — tarif ustidagi daraja.
 *
 * "Maktab", "Bog'cha", "Yotoqxona", "O'quv markazi". Bitta yo'nalishda
 * bir nechta narx darajasi bo'ladi ("Maktab / Birinchi", "Maktab /
 * Ikkinchi"), shuning uchun rahbar hisobotni yo'nalish kesimida ko'radi,
 * buxgalter esa tarif kesimida.
 *
 * ⚠️ PLATFORMADA yashaydi (`platformPrisma`) — narx katalogi barcha
 * filiallarga umumiy, ya'ni uning guruhlagichi ham umumiy.
 *
 * ⚠️ O'CHIRILMAYDI — arxivlanadi. O'tgan hisob-fakturalar unga ishora
 * qiladi va hisobot shu kesim bo'yicha quriladi; o'chirilsa tarix
 * yo'qolardi. FK ham `Restrict`.
 */

const platformPrisma = require("../config/platformPrisma");
const { BadRequestError, NotFoundError, ConflictError } = require("../utils/errors");

const serializeDirection = (row, extra = {}) => ({ ...row, ...extra });

/** Nomni tekshiradi — bo'sh emas va takrorlanmaydi. */
const parseName = async (rawName, { excludeId } = {}) => {
  const name = rawName?.trim();
  if (!name) throw new BadRequestError("Yo'nalish nomi majburiy");
  if (name.length > 60) throw new BadRequestError("Yo'nalish nomi juda uzun");

  const existing = await platformPrisma.tariffDirection.findUnique({ where: { name } });
  if (existing && existing.id !== excludeId) {
    throw new BadRequestError(`"${name}" nomli yo'nalish allaqachon bor`);
  }

  return name;
};

/**
 * Yo'nalishlar ro'yxati + har biriga biriktirilgan tariflar soni.
 *
 * ⚠️ Tarif soni PLATFORMADAN olinadi (katalog umumiy), o'quvchi soni esa
 * BU YERDA ATAYLAB YO'Q: u filialga bog'liq va `catalogUsage.service.js`
 * orqali alohida so'raladi.
 *
 * @param {{status?: "active"|"inactive"|"archived"}} query
 */
const getDirections = async (query = {}) => {
  const filter = {};
  if (query.status === "archived") filter.isArchived = true;
  else {
    filter.isArchived = false;
    if (query.status === "active") filter.isActive = true;
    if (query.status === "inactive") filter.isActive = false;
  }

  const [rows, usage] = await Promise.all([
    platformPrisma.tariffDirection.findMany({
      where: filter,
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    platformPrisma.tariff.groupBy({
      by: ["directionId"],
      where: { directionId: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const usageById = new Map(usage.map((row) => [row.directionId, row._count._all]));

  return {
    items: rows.map((row) =>
      serializeDirection(row, { tariffCount: usageById.get(row.id) ?? 0 }),
    ),
    totals: { count: rows.length },
  };
};

/**
 * Faol yo'nalish mavjudligini tekshiradi (tarifga biriktirishdan oldin).
 * @param {string|null} directionId
 * @returns {Promise<object|null>}
 */
const assertActiveDirection = async (directionId) => {
  if (!directionId) return null;

  const direction = await platformPrisma.tariffDirection.findUnique({
    where: { id: directionId },
  });
  if (!direction) throw new NotFoundError("Yo'nalish topilmadi");

  if (direction.isArchived || !direction.isActive) {
    throw new BadRequestError(`"${direction.name}" yo'nalishi faol emas`);
  }

  return direction;
};

/**
 * @param {{name: string, description?: string, sortOrder?: number}} data
 * @param {string} userId
 */
const createDirection = async (data, userId) => {
  const name = await parseName(data.name);

  const row = await platformPrisma.tariffDirection.create({
    data: {
      name,
      description: data.description?.trim() || "",
      sortOrder: Number.isInteger(Number(data.sortOrder)) ? Number(data.sortOrder) : 0,
      createdBy: userId,
    },
  });

  return serializeDirection(row, { tariffCount: 0 });
};

/**
 * Nomni o'zgartirish MUMKIN, lekin u o'tgan hisob-fakturalarga ta'sir
 * qilmaydi: ularda yo'nalish nomi MUHRLANGAN (`directionName`).
 *
 * @param {string} id
 * @param {{name?: string, description?: string, isActive?: boolean, sortOrder?: number}} data
 */
const updateDirection = async (id, data) => {
  const direction = await platformPrisma.tariffDirection.findUnique({ where: { id } });
  if (!direction) throw new NotFoundError("Yo'nalish topilmadi");

  const payload = {};
  if (data.name !== undefined) payload.name = await parseName(data.name, { excludeId: id });
  if (data.description !== undefined) payload.description = data.description?.trim() || "";
  if (data.isActive !== undefined) payload.isActive = Boolean(data.isActive);
  if (data.sortOrder !== undefined) payload.sortOrder = Number(data.sortOrder) || 0;

  const updated = await platformPrisma.tariffDirection.update({
    where: { id },
    data: payload,
  });

  return serializeDirection(updated);
};

/**
 * Arxivlash / arxivdan qaytarish.
 *
 * ⚠️ Tariflari BOR yo'nalishni arxivlab bo'lmaydi: arxivlangan yo'nalish
 * tanlagichda ko'rinmaydi, lekin tarif unga ishora qilib turaveradi va
 * "yo'nalishi bor-u ro'yxatda yo'q" degan ko'rinmas holat paydo bo'lardi.
 *
 * @param {string} id
 * @param {boolean} isArchived
 */
const setDirectionArchived = async (id, isArchived) => {
  const direction = await platformPrisma.tariffDirection.findUnique({ where: { id } });
  if (!direction) throw new NotFoundError("Yo'nalish topilmadi");

  if (isArchived) {
    const attached = await platformPrisma.tariff.count({
      where: { directionId: id, isArchived: false },
    });
    if (attached > 0) {
      throw new ConflictError(
        `"${direction.name}" yo'nalishiga ${attached} ta tarif biriktirilgan — ` +
          "avval ularni boshqa yo'nalishga o'tkazing",
      );
    }
  }

  const updated = await platformPrisma.tariffDirection.update({
    where: { id },
    data: {
      isArchived: Boolean(isArchived),
      archivedAt: isArchived ? new Date() : null,
    },
  });

  return {
    ...serializeDirection(updated),
    message: isArchived
      ? `"${direction.name}" arxivlandi`
      : `"${direction.name}" arxivdan qaytarildi`,
  };
};

module.exports = {
  serializeDirection,
  getDirections,
  assertActiveDirection,
  createDirection,
  updateDirection,
  setDirectionArchived,
};
