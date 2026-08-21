// Express
const express = require("express");
const router = express.Router();

// Routes imports
const authRoutes = require("./auth.routes");
const branchRoutes = require("./branch.routes");
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
const permissionRoutes = require("./permission.routes");
const socialNetworkRoutes = require("./socialNetwork.routes");
const monitorRoutes = require("./monitor.routes");
const attendanceRoutes = require("./attendance.routes");
const studentAttendanceRoutes = require("./studentAttendance.routes");
const absenceReasonRoutes = require("./absenceReason.routes");
const attendanceReportRoutes = require("./attendanceReport.routes");
const leadRoutes = require("./lead.routes");
const premiumRoutes = require("./premium.routes");
const testSeasonRoutes = require("./testSeason.routes");
const teacherAssignmentRoutes = require("./teacherAssignment.routes");
const questionRoutes = require("./question.routes");
const testRoutes = require("./test.routes");
const testBindingRoutes = require("./testBinding.routes");
const testSessionRoutes = require("./testSession.routes");
const testResultRoutes = require("./testResult.routes");
const testSettingsRoutes = require("./testSettings.routes");
const scheduleSettingsRoutes = require("./scheduleSettings.routes");
const tariffRoutes = require("./tariff.routes");
const studentTariffRoutes = require("./studentTariff.routes");
const financeSettingsRoutes = require("./financeSettings.routes");
const studentFinanceStatusRoutes = require("./studentFinanceStatus.routes");
const invoiceRoutes = require("./invoice.routes");
const studentEnrollmentRoutes = require("./studentEnrollment.routes");
const paymentRoutes = require("./payment.routes");
const paymentAccountRoutes = require("./paymentAccount.routes");
const studentAccountRoutes = require("./studentAccount.routes");
const discountRoutes = require("./discount.routes");
const vacationMonthRoutes = require("./vacationMonth.routes");
const changelogRoutes = require("./changelog.routes");
const changelogSettingsRoutes = require("./changelogSettings.routes");

// Routes
router.use("/auth", authRoutes);
router.use("/branches", branchRoutes);
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
router.use("/permissions", permissionRoutes);
router.use("/social-networks", socialNetworkRoutes);
router.use("/monitor", monitorRoutes);
router.use("/attendance", attendanceRoutes);
router.use("/student-attendance", studentAttendanceRoutes);
router.use("/absence-reasons", absenceReasonRoutes);
router.use("/attendance-reports", attendanceReportRoutes);
router.use("/leads", leadRoutes);
router.use("/premium", premiumRoutes);
router.use("/test-seasons", testSeasonRoutes);
router.use("/teacher-assignments", teacherAssignmentRoutes);
router.use("/questions", questionRoutes);
router.use("/tests", testRoutes);
router.use("/bindings", testBindingRoutes);
router.use("/test-sessions", testSessionRoutes);
router.use("/test-results", testResultRoutes);
router.use("/test-settings", testSettingsRoutes);
router.use("/schedule-settings", scheduleSettingsRoutes);
router.use("/tariffs", tariffRoutes);
router.use("/student-tariffs", studentTariffRoutes);
router.use("/finance-settings", financeSettingsRoutes);
router.use("/student-finance-statuses", studentFinanceStatusRoutes);
router.use("/invoices", invoiceRoutes);
router.use("/student-enrollments", studentEnrollmentRoutes);
router.use("/payments", paymentRoutes);
router.use("/payment-accounts", paymentAccountRoutes);
router.use("/student-accounts", studentAccountRoutes);
router.use("/discounts", discountRoutes);
router.use("/vacation-months", vacationMonthRoutes);
router.use("/changelogs", changelogRoutes);
router.use("/changelog-settings", changelogSettingsRoutes);

// Health check
router.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Server is running",
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
