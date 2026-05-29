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
const coinRoutes = require("./coin.routes");
const marketRoutes = require("./market.routes");
const penaltyRoutes = require("./penalty.routes");
const taskRoutes = require("./task.routes");
const roleRoutes = require("./role.routes");
const socialNetworkRoutes = require("./socialNetwork.routes");
const monitorRoutes = require("./monitor.routes");
const attendanceRoutes = require("./attendance.routes");
const studentAttendanceRoutes = require("./studentAttendance.routes");
const leadRoutes = require("./lead.routes");
const premiumRoutes = require("./premium.routes");
const testSeasonRoutes = require("./testSeason.routes");
const teacherAssignmentRoutes = require("./teacherAssignment.routes");
const questionRoutes = require("./question.routes");
const testRoutes = require("./test.routes");
const testBindingRoutes = require("./testBinding.routes");
const testSessionRoutes = require("./testSession.routes");
const testResultRoutes = require("./testResult.routes");

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
router.use("/coins", coinRoutes);
router.use("/market", marketRoutes);
router.use("/penalties", penaltyRoutes);
router.use("/tasks", taskRoutes);
router.use("/roles", roleRoutes);
router.use("/social-networks", socialNetworkRoutes);
router.use("/monitor", monitorRoutes);
router.use("/attendance", attendanceRoutes);
router.use("/student-attendance", studentAttendanceRoutes);
router.use("/leads", leadRoutes);
router.use("/premium", premiumRoutes);
router.use("/test-seasons", testSeasonRoutes);
router.use("/teacher-assignments", teacherAssignmentRoutes);
router.use("/questions", questionRoutes);
router.use("/tests", testRoutes);
router.use("/bindings", testBindingRoutes);
router.use("/test-sessions", testSessionRoutes);
router.use("/test-results", testResultRoutes);

// Health check
router.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Server is running",
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
