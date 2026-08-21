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
        // Uy filialiga biriktirish yozuvi DARHOL yaratiladi: "qaysi
        // filiallarga kira oladi" savoliga javob beradigan yagona jadval shu,
        // uy filiali esa ro'yxatdan tashqarida qolmasligi kerak.
        branchAccess: {
          create: {
            branchId: entry.branchId,
            role: entry.role,
            isHome: true,
          },
        },
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
    const row = await platformPrisma.userDirectory.upsert({
      where: { id: entry.id },
      create: { id: entry.id, ...data },
      update: data,
    });

    // Uy filiali biriktirishi ham yangilanadi. Upsert, chunki
    // filiallashtirishdan OLDIN yaratilgan foydalanuvchilarda bu qator
    // bo'lmasligi mumkin (lazy migratsiya).
    await platformPrisma.userBranchAccess.upsert({
      where: { userId_branchId: { userId: row.id, branchId: data.branchId } },
      create: {
        userId: row.id,
        branchId: data.branchId,
        role: data.role,
        isHome: true,
      },
      update: { role: data.role, isHome: true },
    });

    return row;
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


// ─────────────────────────────────────────────
// FILIALGA BIRIKTIRISH
// ─────────────────────────────────────────────
//
// "Bu odam qaysi filiallarga kira oladi" — YAGONA manba. Ruxsatlarning o'zi
// bu yerda emas: ular har filialning `users.permissions` ustunida yotadi,
// ya'ni bir odam Chilonzorda kassir, Yunusobodda o'qituvchi bo'la oladi.

/**
 * Foydalanuvchi kira oladigan filiallar (uy filiali ham ro'yxatda).
 * @param {string} userId
 * @returns {Promise<Array<{branchId: string, role: string, isHome: boolean}>>}
 */
const listAccess = async (userId) =>
  platformPrisma.userBranchAccess.findMany({
    where: { userId },
    orderBy: [{ isHome: "desc" }, { createdAt: "asc" }],
  });

/**
 * Shu filialga kirish huquqi bormi?
 * @param {string} userId
 * @param {string} branchId
 * @returns {Promise<object|null>}
 */
const findAccess = async (userId, branchId) =>
  platformPrisma.userBranchAccess.findUnique({
    where: { userId_branchId: { userId, branchId } },
  });

/**
 * Filialga biriktiradi (yoki mavjud biriktirishning rolini yangilaydi).
 *
 * Bu FAQAT reyestr yozuvi — filial bazasidagi `User` qatorini
 * `user.service.js` yaratadi. Ikkalasi doim birga chaqiriladi.
 *
 * @param {{userId: string, branchId: string, role: string, actorId?: string}} params
 */
const grantAccess = async ({ userId, branchId, role, actorId = null }) =>
  platformPrisma.userBranchAccess.upsert({
    where: { userId_branchId: { userId, branchId } },
    create: { userId, branchId, role, isHome: false, createdBy: actorId },
    update: { role },
  });

/**
 * Biriktirishni bekor qiladi.
 *
 * UY filialini yechib bo'lmaydi: login aynan o'sha yerga tushadi, ya'ni
 * uni olib tashlash odamni tizimdan butunlay chiqarib yuborardi.
 *
 * @param {string} userId
 * @param {string} branchId
 */
const revokeAccess = async (userId, branchId) => {
  const access = await findAccess(userId, branchId);
  if (!access) return null;

  if (access.isHome) {
    throw new ConflictError(
      "Asosiy filialdan chiqarib bo'lmaydi — foydalanuvchi tizimga aynan o'sha filial orqali kiradi",
    );
  }

  await platformPrisma.userBranchAccess.delete({
    where: { userId_branchId: { userId, branchId } },
  });
  return access;
};

/**
 * Filialga biriktirilgan xodimlar (filial arxivlanayotganda ogohlantirish uchun).
 * @param {string} branchId
 */
const countAccessByBranch = async (branchId) =>
  platformPrisma.userBranchAccess.count({ where: { branchId } });

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
  listAccess,
  findAccess,
  grantAccess,
  revokeAccess,
  countAccessByBranch,
};
