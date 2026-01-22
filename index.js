// Load environment variables
require("dotenv").config();

// Express
const express = require("express");

// Security middleware
const cors = require("cors");
const helmet = require("helmet");
const xss = require("xss-clean");
const rateLimit = require("express-rate-limit");
const mongoSanitize = require("express-mongo-sanitize");

// Routes
const routes = require("./src/routes");

// Database connection
const connectDB = require("./src/config/database");

// Middlewares
const { errorHandler, notFound } = require("./src/middleware/error.middleware");

// ================================

// Initialize app
const app = express();

// Connect to database
connectDB();

// Initialize default owner
require("./src/utils/initOwner")();

// Trust proxy
app.set("trust proxy", 1);

// Security middleware
app.use(helmet());
app.use(cors());
app.use(mongoSanitize());
app.use(xss());

// Rate limiting
const limiter = rateLimit({
  max: 100,
  windowMs: 1 * 60 * 1000,
  message: { message: "Juda ko'p so'rov yuborildi, iltimos biroz kuting." },
});
app.use("/api", limiter);

// Stricter rate limit for login (brute force protection)
const loginLimiter = rateLimit({
  max: 10,
  windowMs: 15 * 60 * 1000,
  message: {
    message: "Juda ko'p urinish. 15 daqiqadan so'ng qayta urinib ko'ring.",
  },
});
app.use("/api/auth/login", loginLimiter);

// Body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/api", routes);

// Error handling
app.use(notFound);
app.use(errorHandler);

// Start server
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
});

module.exports = app;
