// Express
const express = require("express");
const router = express.Router();

// Routes imports
const authRoutes = require("./auth.routes");
const userRoutes = require("./user.routes");
const subjectRoutes = require("./subject.routes");
const classRoutes = require("./class.routes");
const scheduleRoutes = require("./schedule.routes");
const gradeRoutes = require("./grade.routes");
const holidayRoutes = require("./holiday.routes");
const messageRoutes = require("./message.routes");
const statisticsRoutes = require("./statistics.routes");
const topicRoutes = require("./topic.routes");

// Routes
router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/subjects", subjectRoutes);
router.use("/classes", classRoutes);
router.use("/schedules", scheduleRoutes);
router.use("/grades", gradeRoutes);
router.use("/holidays", holidayRoutes);
router.use("/messages", messageRoutes);
router.use("/statistics", statisticsRoutes);
router.use("/topics", topicRoutes);

// Health check
router.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Server is running",
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
