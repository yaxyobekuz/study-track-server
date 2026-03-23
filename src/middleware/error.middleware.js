const logger = require("../utils/logger");
const { config } = require("../config/env.config");

// Error handling middleware
const errorHandler = (err, req, res, next) => {
  // Log xatoni logger orqali
  logger.error({
    message: err.message,
    stack: err.stack,
    statusCode: err.statusCode || 500,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    userId: req.user?._id,
    timestamp: new Date().toISOString(),
  });

  // Mongoose validation error
  if (err.name === "ValidationError") {
    const errors = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({
      success: false,
      message: "Validatsiya xatosi",
      errors,
    });
  }

  // Mongoose duplicate key error
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern)[0];
    return res.status(400).json({
      success: false,
      message: `${field} allaqachon mavjud`,
    });
  }

  // Mongoose cast error
  if (err.name === "CastError") {
    return res.status(400).json({
      success: false,
      message: "Noto'g'ri ID formati",
    });
  }

  // JWT errors
  if (err.name === "JsonWebTokenError") {
    return res.status(401).json({
      success: false,
      message: "Token noto'g'ri",
    });
  }

  if (err.name === "TokenExpiredError") {
    return res.status(401).json({
      success: false,
      message: "Token muddati tugagan",
    });
  }

  // Default error
  res.status(err.statusCode || 500).json({
    success: false,
    message: err.message || "Server xatosi",
    ...(config.isDevelopment && { stack: err.stack }),
  });
};

// 404 error
const notFound = (req, res, next) => {
  res.status(404).json({
    success: false,
    message: `Yo'nalish topilmadi - ${req.originalUrl}`,
  });
};

module.exports = { errorHandler, notFound };
