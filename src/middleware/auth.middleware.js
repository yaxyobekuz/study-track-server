const User = require("../models/user.model");
const { verifyToken } = require("../utils/jwt");
const asyncHandler = require("./async.middleware");
const { UnauthorizedError, ForbiddenError } = require("../utils/errors");

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

  const user = await User.findById(decoded.id).select("-password");

  if (!user) {
    throw new UnauthorizedError("Foydalanuvchi topilmadi");
  }

  if (!user.isActive) {
    throw new UnauthorizedError("Sizning hisobingiz faol emas");
  }

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

module.exports = { protect, authorize };
