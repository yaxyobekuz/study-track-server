/**
 * Autentifikatsiya — FILIALGA yo'naltirish shu yerda boshlanadi.
 *
 * Login ikki qadam:
 *   1) platformada `UserDirectory` bo'yicha username → qaysi filial,
 *   2) o'sha filial schema'sida `User` o'qiladi va parol tekshiriladi.
 *
 * Parol platformada SAQLANMAYDI — u `User` qatorida, filial ichida qoladi.
 * Yo'naltirgich faqat "qayerga qarash kerak"ligini biladi.
 */

const prisma = require("../config/prisma");
const { runWithBranch } = require("../config/branchContext");
const { generateToken } = require("../utils/jwt");
const { matchPassword } = require("../utils/password");
const {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const branchService = require("./branch.service");
const userDirectory = require("./userDirectory.service");

/** Mijozga chiqadigan qisqa filial shakli. */
const publicBranch = (branch) =>
  branch
    ? {
        id: branch.id,
        code: branch.code,
        name: branch.name,
        shortName: branch.shortName || branch.name,
      }
    : null;

/**
 * Foydalanuvchi kira oladigan filiallar.
 *
 * OWNER — hammasi: u har filial schema'sida avtomatik mavjud (filial
 * ochilganda aynan o'sha `id` bilan seed qilinadi), shuning uchun unga
 * biriktirish yozuvi kerak emas.
 *
 * QOLGANLAR — faqat BIRIKTIRILGAN filiallar (`platform.user_branch_access`).
 * Ro'yxatning o'zi grant: alohida "almashtirish" ruxsati YO'Q, aks holda
 * ikkita haqiqat manbai bo'lardi.
 *
 * @param {object} user
 * @returns {Promise<object[]>}
 */
const availableBranchesFor = async (user) => {
  if (user.role === ROLES.OWNER) {
    const usable = await branchService.listUsable();
    return usable.map(publicBranch);
  }

  const access = await userDirectory.listAccess(user.id);
  const branches = await Promise.all(
    access.map((row) => branchService.findById(row.branchId)),
  );

  return branches
    .filter((b) => b && !b.isArchived && b.isActive && b.status === "ready")
    .map(publicBranch);
};

/**
 * Almashtirish tugmasi ko'rinsinmi? Ikkitadan kam filial bo'lsa — yo'q.
 * @param {object[]} available
 * @returns {boolean}
 */
const canSwitchBranch = (available = []) => available.length > 1;

/**
 * Foydalanuvchini login qilish.
 *
 * @param {string} username - foydalanuvchi nomi
 * @param {string} password - parol
 * @returns {Promise<{user: object, token: string, branch: object}>}
 */
async function login(username, password) {
  if (!username || !password) {
    throw new BadRequestError("Username va parol majburiy");
  }

  // ── 1. Qaysi filial? ──────────────────────
  const entry = await userDirectory.findByUsername(username);
  if (!entry) {
    // Ataylab bir xil xabar: mavjud username'ni oshkor qilmaslik uchun
    throw new BadRequestError("Username yoki parol noto'g'ri");
  }

  const branch = await branchService.getUsableById(entry.branchId);

  // ── 2. O'sha filialda parol tekshiruvi ────
  return runWithBranch(branch, async () => {
    const user = await prisma.user.findUnique({
      where: { id: entry.id },
      include: { classes: { include: { class: { select: { id: true, name: true } } } } },
    });

    if (!user || !(await matchPassword(password, user.password))) {
      throw new BadRequestError("Username yoki parol noto'g'ri");
    }

    if (!user.isActive) {
      throw new ForbiddenError("Sizning hisobingiz faol emas");
    }

    if (user.isArchived) {
      throw new ForbiddenError("Sizning hisobingiz arxivlangan");
    }

    const token = generateToken(user.id, branch.id);
    const available = await availableBranchesFor(user);

    return {
      user: {
        id: user.id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        fullName: user.fullName,
        role: user.role,
        classes: user.classes.map((uc) => uc.class),
        branch: publicBranch(branch),
      },
      token,
      branch: publicBranch(branch),
      availableBranches: available,
    };
  });
}

/**
 * Joriy foydalanuvchi ma'lumotlari.
 *
 * `branch` — hozir ishlanayotgan filial (owner uni almashtirgan bo'lishi
 * mumkin), `homeBranch` — foydalanuvchining o'z filiali.
 *
 * @param {string} userId
 * @param {object} activeBranch - `req.branch`
 * @returns {Promise<object|null>}
 */
async function getMe(userId, activeBranch) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      classes: { include: { class: { select: { id: true, name: true } } } },
      profileImage: true,
    },
  });

  if (!user) return null;

  const entry = await userDirectory.findByUserId(userId);
  const homeBranch = entry ? await branchService.findById(entry.branchId) : null;
  const available = await availableBranchesFor(user);

  return {
    ...user,
    classes: user.classes.map((uc) => uc.class),
    profilePicture: user.profileImage || null,
    branch: publicBranch(activeBranch),
    homeBranch: publicBranch(homeBranch ?? activeBranch),
    canSwitchBranch: canSwitchBranch(available),
    availableBranches: available,
  };
}

/**
 * Filial almashtirish — yangi token qaytaradi.
 *
 * Header bilan emas, TOKEN bilan: filial imzolangan yuk ichida bo'lsa, uni
 * mijoz tomondan o'zgartirib bo'lmaydi va har so'rovda qayta tekshirish
 * shart emas.
 *
 * @param {object} user - `req.user`
 * @param {string} branchId
 * @returns {Promise<{token: string, branch: object}>}
 */
async function switchBranch(user, branchId) {
  if (!branchId) throw new BadRequestError("Filial tanlanmadi");

  const branch = await branchService.getUsableById(branchId);

  // ── 1. Biriktirilganmi? ───────────────────
  // Owner ISTISNO: u har filialda avtomatik mavjud (filial ochilganda aynan
  // o'sha `id` bilan seed qilinadi), shuning uchun unga biriktirish yozuvi
  // kerak emas. Qolganlar uchun ro'yxatning O'ZI — grant.
  if (user.role !== ROLES.OWNER) {
    const access = await userDirectory.findAccess(user.id, branchId);
    if (!access) {
      throw new ForbiddenError(
        `Siz "${branch.name}" filialiga biriktirilmagansiz`,
      );
    }
  }

  // ── 2. Profil haqiqatan bormi? ────────────
  // Biriktirish bor, lekin qator yo'q bo'lishi mumkin (yarim qolgan
  // biriktirish). Bu holat JIM qolmasligi kerak — token berib qo'ysak,
  // foydalanuvchi "Foydalanuvchi topilmadi" bilan tizimdan uchib chiqardi.
  const profile = await runWithBranch(branch, () =>
    prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, isActive: true },
    }),
  );

  if (!profile) {
    throw new NotFoundError(
      `"${branch.name}" filialida sizning profilingiz yo'q`,
    );
  }

  if (!profile.isActive) {
    throw new ForbiddenError(
      `"${branch.name}" filialidagi profilingiz faol emas`,
    );
  }

  return { token: generateToken(user.id, branch.id), branch: publicBranch(branch) };
}

module.exports = { login, getMe, switchBranch, canSwitchBranch, publicBranch };
