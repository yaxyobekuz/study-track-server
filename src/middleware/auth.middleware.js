// Models
const User = require("../models/user.model");

// Utils
const { verifyToken } = require("../utils/jwt");

// Auth middleware
const protect = async (req, res, next) => {
  try {
    let token;

    // Tokenni headerdan olish
    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer")
    ) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Tizimga kirish uchun autentifikatsiya talab qilinadi",
      });
    }

    // Tokenni tekshirish
    const decoded = verifyToken(token);

    if (!decoded) {
      return res.status(401).json({
        success: false,
        message: "Noto'g'ri yoki muddati o'tgan token",
      });
    }

    // Find user by ID from token
    const user = await User.findById(decoded.id).select("-password");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Foydalanuvchi topilmadi",
      });
    }

    if (!user.isActive) {
      return res.status(401).json({
        success: false,
        message: "Sizning hisobingiz faol emas",
      });
    }

    // Add user to request object
    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      error: error.message,
      message: "Autentifikatsiya xatosi",
    });
  }
};

// Role-based access control
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `${req.user.role} roli uchun ruxsat berilmagan`,
      });
    }
    next();
  };
};

module.exports = { protect, authorize };
