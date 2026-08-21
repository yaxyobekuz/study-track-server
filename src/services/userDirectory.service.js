/**
 * LOGIN YO'NALTIRGICHI — `username` → qaysi filial.
 *
 * Foydalanuvchi qatori (`User`) filial schema'sida qoladi, chunki unga
 * `classes` relation'i bilan 94 joyda murojaat qilinadi. Platformada esa
 * faqat yupqa indeks turadi: login qaysi schema'ga borishni shu yerdan
 * biladi va username butun tizim bo'ylab yagona bo'ladi.
 *
 * ⚠️ IKKI SCHEMA, BITTA TRANZAKSIYA YO'Q. `platform.user_directory` va
 * `br_x.users` alohida ulanishlarda, ya'ni atomar yozib bo'lmaydi. Shuning
 * uchun TARTIB qat'iy:
 *
 *     1) platformada username BAND QILINADI (unique cheklov — haqiqiy hakam)
 *     2) filialda `User` yaratiladi
 *     3) 2-qadam xato bersa — 1-qadam ORQAGA OLINADI
 *
 * Teskari tartibda (avval filial) ikki filialda bir xil username paydo
 * bo'lishi mumkin edi va login qaysi biriga borishini aytib bo'lmasdi.
 */

const platformPrisma = require("../config/platformPrisma");
const { ConflictError, NotFoundError } = require("../utils/errors");
const logger = require("../utils/logger");

const normalize = (username) => String(username ?? "").toLowerCase().trim();

/**
 * Username bo'yicha yozuv (login uchun yagona kirish nuqtasi).
 * @param {string} username
 * @returns {Promise<object|null>} { id, username, branchId, role, ... }
 */
const findByUsername = async (username) => {
  const value = normalize(username);
  if (!value) return null;
  return platformPrisma.userDirectory.findUnique({ where: { username: value } });
};

/**
 * Foydalanuvchi ID bo'yicha yozuv — "bu odam qaysi filialda?".
 * @param {string} userId
 */
const findByUserId = async (userId) => {
  if (!userId) return null;
  return platformPrisma.userDirectory.findUnique({ where: { id: userId } });
};

/**
 * Username band emasligini tekshiradi (yaratishdan OLDIN).
 * @param {string} username
 * @param {string} [exceptUserId] - tahrirlashda o'zini hisobga olmaslik uchun
 * @throws {ConflictError}
 */
const assertUsernameFree = async (username, exceptUserId = null) => {
  const existing = await findByUsername(username);
  if (existing && existing.id !== exceptUserId) {
    throw new ConflictError("Bu username allaqachon band");
  }
};

/**
 * Username'ni BAND QILADI (filialda `User` yaratishdan oldin).
 *
 * Unique cheklov — haqiqiy hakam: ikki so'rov bir vaqtda kelsa, biri
 * P2002 bilan yiqiladi va `ConflictError` ga aylantiriladi.
 *
 * @param {object} entry
 * @param {string} entry.id - bo'lajak `User.id` (oldindan generatsiya qilinadi)
 * @param {string} entry.username
 * @param {string} entry.branchId
 * @param {string} entry.role
 * @param {string} [entry.firstName]
 * @param {string} [entry.lastName]
 * @returns {Promise<object>}
 */
const claim = async (entry) => {
  try {
    return await platformPrisma.userDirectory.create({
      data: {
        id: entry.id,
        username: normalize(entry.username),
        branchId: entry.branchId,
        role: entry.role,
        firstName: entry.firstName ?? "",
        lastName: entry.lastName ?? "",
        isActive: entry.isActive ?? true,
        isArchived: entry.isArchived ?? false,
      },
    });
  } catch (error) {
    if (error.code === "P2002") {
      throw new ConflictError("Bu username allaqachon band");
    }
    throw error;
  }
};

/**
 * Band qilishni ORQAGA OLADI — filialda `User` yaratish xato bergan holat.
 * Xatoni yutadi: asosiy xato mijozga yetib borishi kerak, bu esa tozalash.
 *
 * @param {string} userId
 */
const release = async (userId) => {
  try {
    await platformPrisma.userDirectory.delete({ where: { id: userId } });
  } catch (error) {
    logger.warn(
      `[UserDirectory] Band qilishni orqaga olib bo'lmadi (${userId}): ${error.message}`,
    );
  }
};

/**
 * Yozuvni yangilaydi (username, ism, holat o'zgarganda).
 * Yozuv topilmasa — YARATADI: filiallashtirishdan oldin yaratilgan
 * foydalanuvchilar uchun lazy migratsiya.
 *
 * @param {object} entry - `claim` bilan bir xil shakl
 */
const sync = async (entry) => {
  const data = {
    username: normalize(entry.username),
    branchId: entry.branchId,
    role: entry.role,
    firstName: entry.firstName ?? "",
    lastName: entry.lastName ?? "",
    isActive: entry.isActive ?? true,
    isArchived: entry.isArchived ?? false,
  };

  try {
    return await platformPrisma.userDirectory.upsert({
      where: { id: entry.id },
      create: { id: entry.id, ...data },
      update: data,
    });
  } catch (error) {
    if (error.code === "P2002") {
      throw new ConflictError("Bu username allaqachon band");
    }
    throw error;
  }
};

/**
 * Yozuvni o'chiradi (xodim butunlay o'chirilganda).
 * O'quvchi hech qachon o'chirilmaydi — arxivlanadi (`sync` bilan).
 */
const remove = async (userId) => {
  await platformPrisma.userDirectory.deleteMany({ where: { id: userId } });
};

/**
 * Filialdagi foydalanuvchilar soni (rol kesimida) — yig'ma dashboard uchun
 * filial bazasiga bormasdan.
 * @param {string} branchId
 */
const countByRole = async (branchId) => {
  const rows = await platformPrisma.userDirectory.groupBy({
    by: ["role"],
    where: { branchId, isArchived: false },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.role, r._count._all]));
};

/**
 * Yozuv bor-yo'qligini talab qiladi (login xatolarini aniq qilish uchun).
 * @param {string} username
 * @returns {Promise<object>}
 */
const requireByUsername = async (username) => {
  const entry = await findByUsername(username);
  if (!entry) throw new NotFoundError("Foydalanuvchi topilmadi");
  return entry;
};

module.exports = {
  normalize,
  findByUsername,
  findByUserId,
  requireByUsername,
  assertUsernameFree,
  claim,
  release,
  sync,
  remove,
  countByRole,
};
