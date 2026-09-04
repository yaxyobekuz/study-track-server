const prisma = require("../config/prisma");
const { runWithBranch } = require("../config/branchContext");
const { verifyToken } = require("../utils/jwt");
const asyncHandler = require("./async.middleware");
const { UnauthorizedError, ForbiddenError } = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const { hasPermission, hasSection } = require("../utils/permissions");
const branchService = require("../services/branch.service");

/**
 * JWT token orqali foydalanuvchini autentifikatsiya qiladi.
 *
 * FILIAL KONTEKSTI SHU YERDA YOQILADI. Token ichida `branchId` bor va
 * `runWithBranch()` qolgan butun so'rov zanjiriga o'sha filialni tarqatadi —
 * shundan keyin `prisma.<model>` avtomatik ravishda o'sha filialning
 * schema'siga boradi (config/prisma.js).
 *
 * ⚠️ `next()` ATAYLAB `runWithBranch` ICHIDA chaqiriladi: undan tashqarida
 * chaqirilsa kontekst tarqamaydi va birinchi service so'rovi
 * "Filial konteksti yo'q" xatosi bilan yiqiladi.
 */
const protect = asyncHandler(async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    throw new UnauthorizedError("Tizimga kirish uchun autentifikatsiya talab qilinadi");
  }

  const decoded = verifyToken(token);

  if (!decoded) {
    throw new UnauthorizedError("Noto'g'ri yoki muddati o'tgan token");
  }

  // ORQAGA MOSLIK: filiallashtirishdan oldin berilgan tokenlarda `branchId`
  // yo'q. Ularni default filialga yo'naltiramiz — joriy etish paytida hech
  // kim tizimdan chiqib ketmaydi.
  const branch = decoded.branchId
    ? await branchService.getUsableById(decoded.branchId)
    : await branchService.getDefaultBranch();

  if (!branch) {
    throw new UnauthorizedError("Filial aniqlanmadi — administratorga murojaat qiling");
  }

  return runWithBranch(branch, async () => {
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      omit: { password: true, plainPassword: true },
      include: { classes: { include: { class: true } } },
    });

    if (!user) {
      // Owner boshqa filialga o'tgan, lekin u yerda profili yo'q — token
      // hali ham amal qiladi, faqat bu filialga kira olmaydi.
      throw new UnauthorizedError("Foydalanuvchi topilmadi");
    }

    if (!user.isActive) {
      throw new UnauthorizedError("Sizning hisobingiz faol emas");
    }

    if (user.isArchived) {
      throw new UnauthorizedError("Sizning hisobingiz arxivlangan");
    }

    // Lazy premium expiry check
    if (user.premiumIsActive && user.premiumExpiresAt && user.premiumExpiresAt < new Date()) {
      prisma.user
        .update({ where: { id: user.id }, data: { premiumIsActive: false } })
        .catch(() => {});
      user.premiumIsActive = false;
    }

    // Junction M2M → eski `classes: [Class]` shakliga flatten (frontend mosligi)
    user.classes = (user.classes || []).map((uc) => uc.class);

    req.user = user;
    req.branch = branch;
    next();
  });
});

/**
 * Rolga asoslangan ruxsat tekshirish middleware
 * @param {...string} roles - Ruxsat berilgan rollar ro'yxati
 * @returns {Function} Express middleware
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      throw new ForbiddenError(`${req.user.role} roli uchun ruxsat berilmagan`);
    }
    next();
  };
};

/**
 * Amal darajasidagi ruxsat tekshiruvi (additiv — hech kimning mavjud ruxsatini
 * kamaytirmaydi, faqat qo'shadi).
 *
 * O'tkaziladi, agar:
 *   - foydalanuvchi owner bo'lsa (u doim hammaga ega), YOKI
 *   - roli `extraRoles` ichida bo'lsa (eski rol asosidagi kirish saqlanadi —
 *     boshqa panellar buzilmasligi uchun), YOKI
 *   - `permissions` massivida `permission` kaliti bo'lsa (yoki eski, amalga
 *     bo'linmagan bare bo'lim kaliti — `hasPermission` ga qarang).
 *
 * @param {string} permission - talab qilinadigan kalit, "<bo'lim>.<amal>" (utils/permissions.js)
 * @param {...string} extraRoles - shu route'ga avvaldan ruxsati bor rollar (owner'dan tashqari)
 * @returns {Function} Express middleware
 */
const authorizePermission = (permission, ...extraRoles) => {
  return (req, res, next) => {
    const { role, permissions: userPermissions = [] } = req.user;

    if (role === ROLES.OWNER) return next();
    if (extraRoles.includes(role)) return next();
    if (hasPermission(userPermissions, permission)) return next();

    throw new ForbiddenError("Bu amal uchun ruxsatingiz yo'q");
  };
};

/**
 * Bir nechta ruxsatdan HECH BO'LMASA BITTASI bo'lsa o'tkazadi.
 *
 * Ma'lumotnoma ro'yxatlari uchun: bitta endpoint bir nechta bo'limning
 * ekraniga xizmat qiladi (masalan, faol xonalar ro'yxati xatlovga ham,
 * kunlik hisobotga ham, zarar oynasiga ham kerak). Har bir bo'lim uchun
 * alohida nusxa endpoint ochish o'rniga bitta yo'l bir nechta kalitni
 * qabul qiladi. `authorizePermission` bilan bir xil qoida: owner va
 * `extraRoles` doim o'tadi.
 *
 * @param {string[]} permissions - kalitlardan biri yetarli ("<bo'lim>.<amal>")
 * @param {...string} extraRoles - shu route'ga avvaldan ruxsati bor rollar
 * @returns {Function} Express middleware
 */
const authorizeAnyPermission = (permissions = [], ...extraRoles) => {
  return (req, res, next) => {
    const { role, permissions: userPermissions = [] } = req.user;

    if (role === ROLES.OWNER) return next();
    if (extraRoles.includes(role)) return next();
    if (permissions.some((key) => hasPermission(userPermissions, key))) {
      return next();
    }

    throw new ForbiddenError("Bu amal uchun ruxsatingiz yo'q");
  };
};

/**
 * Bo'limga umumiy darvoza: foydalanuvchida bo'limning hech bo'lmasa bitta amali
 * bo'lsa o'tkazadi. `router.use(...)` uchun mo'ljallangan — aniq amal tekshiruvi
 * har bir route'da `authorizePermission` bilan qilinadi.
 *
 * @param {string} section - bo'lim kaliti ("users")
 * @param {...string} extraRoles - shu bo'limga avvaldan ruxsati bor rollar
 * @returns {Function} Express middleware
 */
const authorizeSection = (section, ...extraRoles) => {
  return (req, res, next) => {
    const { role, permissions: userPermissions = [] } = req.user;

    if (role === ROLES.OWNER) return next();
    if (extraRoles.includes(role)) return next();
    if (hasSection(userPermissions, section)) return next();

    throw new ForbiddenError("Bu bo'lim uchun ruxsatingiz yo'q");
  };
};

module.exports = {
  protect,
  authorize,
  authorizePermission,
  authorizeAnyPermission,
  authorizeSection,
};
