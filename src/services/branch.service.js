/**
 * FILIALLAR — platforma reyestri.
 *
 * Filial — bu qator + PostgreSQL schema. Qator platformada
 * (`platform.branches`), ma'lumot esa o'sha schema ichida. Ikkalasi doim
 * birga yuradi, shuning uchun:
 *
 *  - filial HECH QACHON o'chirilmaydi — arxivlanadi (`PaymentAccount` uslubi).
 *    Ortida hisob-fakturalar, to'lovlar va davomat tarixi bor;
 *  - `code` yaratilgandan keyin O'ZGARMAYDI — schema nomi shundan hosil
 *    bo'lgan, qayta nomlash esa migratsiya emas, ma'lumot yo'qotish xavfi;
 *  - `schemaName` — `code` dan HOSILA EMAS, alohida ustun. Sabab: mavjud baza
 *    "Bosh filial" bo'lishi kerak, uning schema'si esa `public`.
 *
 * KESH: `auth.middleware` har so'rovda filialni o'qiydi. Reyestr kichik va
 * kamdan-kam o'zgaradi, shuning uchun qisqa TTL'li xotira keshi qo'yilgan va
 * har qanday yozuv amali uni ATAYLAB butunlay tozalaydi (nozik invalidatsiya
 * emas — filiallar soni o'nlab, tejashga arzimaydi).
 */

const platformPrisma = require("../config/platformPrisma");
const { config } = require("../config/env.config");
const { evictSchema } = require("../config/branchRegistry");
const {
  assertSafeSchemaName,
  schemaNameForCode,
} = require("../helpers/schemaUrl.helpers");
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
} = require("../utils/errors");
const logger = require("../utils/logger");

// Filial kodi: lotin kichik harf, raqam, pastki chiziq. Schema nomiga
// aylanadi, shuning uchun qoida `schemaUrl.helpers.js` dagidan qat'iyroq
// (raqam bilan boshlanishi ham mumkin emas — prefiks qo'shilgach baribir
// harf bilan boshlanadi, lekin kod o'zi ham o'qiladigan bo'lishi kerak).
const CODE_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;

const CACHE_TTL_MS = 30 * 1000;
let cache = null; // { at: number, rows: Branch[] }

const clearCache = () => {
  cache = null;
};

/** Reyestrdagi BARCHA filiallar (arxivlangani ham) — keshlanadi. */
const loadAll = async () => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;

  const rows = await platformPrisma.branch.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  cache = { at: Date.now(), rows };
  return rows;
};

/**
 * Ishga yaroqli filiallar: arxivlanmagan, faol va provisioning tugagan.
 * @returns {Promise<object[]>}
 */
const listUsable = async () => {
  const rows = await loadAll();
  return rows.filter((b) => !b.isArchived && b.isActive && b.status === "ready");
};

/**
 * Cron va yig'ma hisobot uchun: arxivlanmagan va tayyor filiallar.
 * `isActive` ATAYLAB tekshirilmaydi — u LOGIN bayrog'i, ya'ni "filialga kirish
 * vaqtincha yopilgan" degani. Hisob-faktura va davomat baribir shakllanishi
 * kerak (`User.isActive` bilan bir xil mantiq — finance.md §4).
 * @returns {Promise<object[]>}
 */
const listOperational = async () => {
  const rows = await loadAll();
  return rows.filter((b) => !b.isArchived && b.status === "ready");
};

/** @returns {Promise<object|null>} */
const findById = async (branchId) => {
  if (!branchId) return null;
  const rows = await loadAll();
  return rows.find((b) => b.id === branchId) ?? null;
};

/** @returns {Promise<object|null>} */
const findByCode = async (code) => {
  const rows = await loadAll();
  return rows.find((b) => b.code === code) ?? null;
};

/**
 * Tokenida `branchId` bo'lmagan ESKI sessiyalar shu filialga tushadi.
 * `isDefault` qo'yilmagan bo'lsa — ro'yxatdagi birinchi ishlaydigan filial.
 * @returns {Promise<object|null>}
 */
const getDefaultBranch = async () => {
  const usable = await listUsable();
  return usable.find((b) => b.isDefault) ?? usable[0] ?? null;
};

/**
 * Filialni ID bo'yicha oladi va ishga yaroqliligini tekshiradi.
 * `auth.middleware` shu funksiyani ishlatadi.
 *
 * @param {string} branchId
 * @returns {Promise<object>}
 * @throws {NotFoundError|BadRequestError}
 */
const getUsableById = async (branchId) => {
  const branch = await findById(branchId);
  if (!branch) throw new NotFoundError("Filial topilmadi");
  if (branch.isArchived) throw new BadRequestError("Filial arxivlangan");
  if (!branch.isActive) throw new BadRequestError("Filial vaqtincha yopilgan");
  if (branch.status !== "ready") {
    throw new BadRequestError(
      branch.status === "provisioning"
        ? "Filial hali tayyorlanmoqda"
        : "Filial ochilmadi — administratorga murojaat qiling",
    );
  }
  return branch;
};

// ─────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────

/**
 * Ro'yxat (sahifalashsiz — filiallar soni o'nlab).
 * @param {{includeArchived?: boolean}} query
 */
const list = async (query = {}) => {
  const rows = await loadAll();
  const includeArchived =
    query.includeArchived === true || query.includeArchived === "true";

  const filtered = includeArchived ? rows : rows.filter((b) => !b.isArchived);

  // Har filialdagi foydalanuvchilar soni — YO'NALTIRGICHDAN o'qiladi, ya'ni
  // N ta filial bazasiga N ta so'rov yubormaymiz.
  const counts = await platformPrisma.userDirectory.groupBy({
    by: ["branchId", "role"],
    where: { isArchived: false },
    _count: { _all: true },
  });

  const byBranch = new Map();
  for (const row of counts) {
    const entry = byBranch.get(row.branchId) ?? { students: 0, staff: 0 };
    if (row.role === "student") entry.students += row._count._all;
    else entry.staff += row._count._all;
    byBranch.set(row.branchId, entry);
  }

  return filtered.map((branch) => ({
    ...branch,
    counts: byBranch.get(branch.id) ?? { students: 0, staff: 0 },
  }));
};

/** @param {string} id */
const getById = async (id) => {
  const branch = await platformPrisma.branch.findUnique({ where: { id } });
  if (!branch) throw new NotFoundError("Filial topilmadi");
  return branch;
};

/**
 * Yangi filial YARATADI (schema hali yaratilmaydi).
 *
 * Qator darhol `provisioning` holatida qaytadi, DDL va migratsiya esa fonda
 * bajariladi — `branchProvision.service.js`. Sabab: `migrate deploy` bir necha
 * soniya davom etadi va HTTP so'rovini ushlab turishi kerak emas.
 *
 * @param {object} data
 * @param {string} actorId
 */
const create = async (data, actorId) => {
  const code = String(data.code ?? "").toLowerCase().trim();
  const name = String(data.name ?? "").trim();

  if (!CODE_PATTERN.test(code)) {
    throw new BadRequestError(
      "Filial kodi: lotin kichik harf bilan boshlanib, 2-31 belgi (harf, raqam, pastki chiziq)",
    );
  }
  if (!name) throw new BadRequestError("Filial nomi majburiy");

  const schemaName = schemaNameForCode(code, config.branchSchemaPrefix);

  const existing = await platformPrisma.branch.findFirst({
    where: { OR: [{ code }, { schemaName }, { name }] },
  });
  if (existing) {
    throw new ConflictError(
      existing.name === name
        ? "Bu nomdagi filial allaqachon bor"
        : "Bu kodli filial allaqachon bor",
    );
  }

  const branch = await platformPrisma.branch.create({
    data: {
      code,
      name,
      schemaName,
      shortName: String(data.shortName ?? "").trim(),
      address: String(data.address ?? "").trim(),
      phone: String(data.phone ?? "").trim(),
      sortOrder: Number.isInteger(data.sortOrder) ? data.sortOrder : 0,
      status: "provisioning",
      createdBy: actorId ?? null,
    },
  });

  clearCache();
  logger.info(`[Branch] "${name}" (${code}) reyestrga yozildi → provisioning`);
  return branch;
};

/**
 * Filialni yangilaydi. `code` va `schemaName` O'ZGARTIRILMAYDI.
 */
const update = async (id, data) => {
  const branch = await getById(id);

  const patch = {};
  if (data.name !== undefined) {
    const name = String(data.name).trim();
    if (!name) throw new BadRequestError("Filial nomi majburiy");
    patch.name = name;
  }
  if (data.shortName !== undefined) patch.shortName = String(data.shortName).trim();
  if (data.address !== undefined) patch.address = String(data.address).trim();
  if (data.phone !== undefined) patch.phone = String(data.phone).trim();
  if (data.sortOrder !== undefined) patch.sortOrder = parseInt(data.sortOrder, 10) || 0;
  if (data.isActive !== undefined) patch.isActive = Boolean(data.isActive);

  if (data.code !== undefined && String(data.code).toLowerCase().trim() !== branch.code) {
    throw new BadRequestError(
      "Filial kodini o'zgartirib bo'lmaydi — baza schema'si shu koddan hosil qilingan",
    );
  }

  // Default filial — bittadan ortiq bo'lishi mumkin emas: eski tokenlar
  // qayerga tushishi ANIQ bo'lishi kerak.
  if (data.isDefault === true && !branch.isDefault) {
    await platformPrisma.branch.updateMany({
      where: { isDefault: true },
      data: { isDefault: false },
    });
    patch.isDefault = true;
  }

  const updated = await platformPrisma.branch.update({ where: { id }, data: patch });
  clearCache();
  return updated;
};

/**
 * Arxivlash — filialga kirish yopiladi, ma'lumot joyida qoladi.
 * Schema O'CHIRILMAYDI: hisobot va audit uchun kerak.
 */
const archive = async (id, reason = "") => {
  const branch = await getById(id);
  if (branch.isArchived) throw new BadRequestError("Filial allaqachon arxivlangan");
  if (branch.isDefault) {
    throw new BadRequestError(
      "Default filialni arxivlab bo'lmaydi — avval boshqa filialni default qiling",
    );
  }

  const active = await platformPrisma.userDirectory.count({
    where: { branchId: id, isArchived: false },
  });

  const updated = await platformPrisma.branch.update({
    where: { id },
    data: {
      isArchived: true,
      isActive: false,
      archivedAt: new Date(),
      provisionError: reason || null,
    },
  });

  clearCache();
  // Ochiq ulanishni yopamiz — arxivlangan filialga so'rov ketmasligi kerak
  await evictSchema(branch.schemaName);

  logger.info(
    `[Branch] "${branch.name}" arxivlandi (${active} ta faol foydalanuvchi qoldi)`,
  );
  return updated;
};

/** Arxivdan qaytarish. */
const restore = async (id) => {
  const branch = await getById(id);
  if (!branch.isArchived) throw new BadRequestError("Filial arxivlanmagan");

  const updated = await platformPrisma.branch.update({
    where: { id },
    data: { isArchived: false, isActive: true, archivedAt: null },
  });
  clearCache();
  return updated;
};

/** Provisioning natijasini yozadi (branchProvision.service.js chaqiradi). */
const setStatus = async (id, status, provisionError = null) => {
  const updated = await platformPrisma.branch.update({
    where: { id },
    data: { status, provisionError },
  });
  clearCache();
  return updated;
};

module.exports = {
  CODE_PATTERN,
  clearCache,
  listUsable,
  listOperational,
  findById,
  findByCode,
  getDefaultBranch,
  getUsableById,
  list,
  getById,
  create,
  update,
  archive,
  restore,
  setStatus,
  assertSafeSchemaName,
};
