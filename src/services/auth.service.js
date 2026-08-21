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
 * Owner barcha filiallarda ishlay oladi. Qolganlar — faqat o'z filialida
 * (bitta foydalanuvchi = bitta filial).
 *
 * @param {object} user
 * @returns {boolean}
 */
const canSwitchBranch = (user) =>
  user.role === ROLES.OWNER ||
  (user.permissions ?? []).includes("branches.switch") ||
  (user.permissions ?? []).includes("branches");

/**
 * Foydalanuvchi kira oladigan filiallar ro'yxati.
 * @param {object} user
 * @param {object} homeBranch
 * @returns {Promise<object[]>}
 */
const availableBranchesFor = async (user, homeBranch) => {
  if (!canSwitchBranch(user)) return [publicBranch(homeBranch)].filter(Boolean);
  const usable = await branchService.listUsable();
  return usable.map(publicBranch);
};

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
      availableBranches: await availableBranchesFor(user, branch),
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

  return {
    ...user,
    classes: user.classes.map((uc) => uc.class),
    profilePicture: user.profileImage || null,
    branch: publicBranch(activeBranch),
    homeBranch: publicBranch(homeBranch ?? activeBranch),
    canSwitchBranch: canSwitchBranch(user),
    availableBranches: await availableBranchesFor(user, homeBranch ?? activeBranch),
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
  if (!canSwitchBranch(user)) {
    throw new ForbiddenError("Filial almashtirishga ruxsatingiz yo'q");
  }
  if (!branchId) throw new BadRequestError("Filial tanlanmadi");

  const branch = await branchService.getUsableById(branchId);

  // Owner har bir filialda AYNAN O'SHA `id` bilan mavjud (filial ochilganda
  // seed qilinadi). Boshqa rollarda `branches.switch` ruxsati bo'lsa ham,
  // o'sha filialda qatori yo'q bo'lsa kirita olmaymiz.
  const exists = await runWithBranch(branch, () =>
    prisma.user.findUnique({ where: { id: user.id }, select: { id: true } }),
  );

  if (!exists) {
    throw new NotFoundError(
      `"${branch.name}" filialida sizning profilingiz yo'q`,
    );
  }

  return { token: generateToken(user.id, branch.id), branch: publicBranch(branch) };
}

module.exports = { login, getMe, switchBranch, canSwitchBranch, publicBranch };
