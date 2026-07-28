const prisma = require("../config/prisma");
const { verifyToken } = require("../utils/jwt");
const asyncHandler = require("./async.middleware");
const { UnauthorizedError, ForbiddenError } = require("../utils/errors");
const { ROLES } = require("../utils/constants");

/**
 * JWT token orqali foydalanuvchini autentifikatsiya qiladi
 * Token headerdan olinadi va req.user ga foydalanuvchi biriktiriladi
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

  const user = await prisma.user.findUnique({
    where: { id: decoded.id },
    omit: { password: true, plainPassword: true },
    include: { classes: { include: { class: true } } },
  });

  if (!user) {
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
  next();
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
 * Bo'lim darajasidagi ruxsatga asoslangan tekshiruv (additiv — hech kimning
 * mavjud ruxsatini kamaytirmaydi, faqat qo'shadi).
 *
 * O'tkaziladi, agar:
 *   - foydalanuvchi owner bo'lsa (u doim hammaga ega), YOKI
 *   - roli `extraRoles` ichida bo'lsa (eski rol asosidagi kirish saqlanadi —
 *     boshqa panellar buzilmasligi uchun), YOKI
 *   - `permissions` massivida `permission` kaliti bo'lsa.
 *
 * @param {string} permission - talab qilinadigan bo'lim kaliti (utils/permissions.js)
 * @param {...string} extraRoles - shu route'ga avvaldan ruxsati bor rollar (owner'dan tashqari)
 * @returns {Function} Express middleware
 */
const authorizePermission = (permission, ...extraRoles) => {
  return (req, res, next) => {
    const { role, permissions: userPermissions = [] } = req.user;

    if (role === ROLES.OWNER) return next();
    if (extraRoles.includes(role)) return next();
    if (permission && userPermissions.includes(permission)) return next();

    throw new ForbiddenError("Bu bo'lim uchun ruxsatingiz yo'q");
  };
};

module.exports = { protect, authorize, authorizePermission };
