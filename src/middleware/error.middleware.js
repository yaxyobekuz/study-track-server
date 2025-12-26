// Error handling middleware
const errorHandler = (err, req, res, next) => {
  console.error(err.stack);

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

  // Default error
  res.status(err.statusCode || 500).json({
    success: false,
    message: err.message || "Server xatosi",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
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
