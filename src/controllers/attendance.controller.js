const asyncHandler = require("../middleware/async.middleware");
const attendanceService = require("../services/attendance.service");
const { BadRequestError, NotFoundError } = require("../utils/errors");

const getToday = asyncHandler(async (req, res) => {
  const record = await attendanceService.getTodayRecord(req.user._id);
  res.json({ success: true, data: record });
});

const checkIn = asyncHandler(async (req, res) => {
  const { lat, lng, accuracy } = req.body;

  // Admin (owner) userId ni topish — jarima "givenBy" uchun
  const User = require("../models/user.model");
  const adminUser = await User.findOne({ role: "owner" }, "_id").lean();
  const adminUserId = adminUser?._id || req.user._id;

  const record = await attendanceService.checkIn(
    req.user._id,
    lat,
    lng,
    accuracy,
    adminUserId,
  );

  res.status(201).json({ success: true, data: record });
});

const checkOut = asyncHandler(async (req, res) => {
  const { lat, lng, accuracy } = req.body;

  const User = require("../models/user.model");
  const adminUser = await User.findOne({ role: "owner" }, "_id").lean();
  const adminUserId = adminUser?._id || req.user._id;

  const record = await attendanceService.checkOut(
    req.user._id,
    lat,
    lng,
    accuracy,
    adminUserId,
  );

  res.json({ success: true, data: record });
});

const getMySchedule = asyncHandler(async (req, res) => {
  const schedule = await attendanceService.getScheduleForUser(req.user._id);
  res.json({ success: true, data: schedule });
});

const getUserSchedule = asyncHandler(async (req, res) => {
  const schedule = await attendanceService.getScheduleForUser(
    req.params.userId,
  );
  res.json({ success: true, data: schedule });
});

const getMyHistory = asyncHandler(async (req, res) => {
  const month = req.query.month || new Date().getMonth() + 1;
  const year = req.query.year || new Date().getFullYear();

  const result = await attendanceService.getMyHistory(
    req.user._id,
    month,
    year,
  );
  res.json({ success: true, ...result });
});

const getTodayAll = asyncHandler(async (req, res) => {
  const result = await attendanceService.getTodayAllRecords(req.query.role || null);
  res.json({ success: true, ...result });
});

const getSettings = asyncHandler(async (req, res) => {
  const settings = await attendanceService.getSettings();
  res.json({ success: true, data: settings });
});

const updateSettings = asyncHandler(async (req, res) => {
  const settings = await attendanceService.updateSettings(
    req.body,
    req.user._id,
  );
  res.json({ success: true, data: settings });
});

const getAllRecords = asyncHandler(async (req, res) => {
  const result = await attendanceService.getAllRecords(req.query);
  res.json(result);
});

const getUserMonthRecords = asyncHandler(async (req, res) => {
  const month = req.query.month || new Date().getMonth() + 1;
  const year = req.query.year || new Date().getFullYear();

  const result = await attendanceService.getUserMonthRecords(
    req.params.userId,
    month,
    year,
  );
  res.json({ success: true, ...result });
});

const getRecord = asyncHandler(async (req, res) => {
  const Attendance = require("../models/attendance.model");
  const record = await Attendance.findById(req.params.id)
    .populate("user", "firstName lastName username role")
    .populate("penaltyRef", "title points status")
    .lean();

  if (!record) throw new NotFoundError("Davomat yozuvi topilmadi");
  res.json({ success: true, data: record });
});

const createExcuseRequest = asyncHandler(async (req, res) => {
  const { date, reason, type } = req.body;

  if (!date) throw new BadRequestError("Sana majburiy");
  if (!reason) throw new BadRequestError("Sabab majburiy");
  if (!type || !["advance", "after"].includes(type)) {
    throw new BadRequestError("So'rov turi noto'g'ri (advance | after)");
  }

  const excuse = await attendanceService.createExcuseRequest(
    req.user._id,
    date,
    reason,
    type,
  );

  res.status(201).json({ success: true, data: excuse });
});

const getMyExcuses = asyncHandler(async (req, res) => {
  const result = await attendanceService.getMyExcuses(req.user._id, req);
  res.json(result);
});

const cancelExcuseRequest = asyncHandler(async (req, res) => {
  await attendanceService.cancelExcuseRequest(req.params.id, req.user._id);
  res.json({ success: true });
});

const getRecentExcuses = asyncHandler(async (req, res) => {
  const result = await attendanceService.getRecentExcuses();
  res.json({ success: true, data: result });
});

const getAllExcuses = asyncHandler(async (req, res) => {
  const result = await attendanceService.getAllExcuses(req);
  res.json(result);
});

const getExcuse = asyncHandler(async (req, res) => {
  const ExcuseRequest = require("../models/excuseRequest.model");
  const excuse = await ExcuseRequest.findById(req.params.id)
    .populate("user", "firstName lastName username role")
    .populate("reviewedBy", "firstName lastName")
    .lean();

  if (!excuse) throw new NotFoundError("So'rov topilmadi");
  res.json({ success: true, data: excuse });
});

const reviewExcuse = asyncHandler(async (req, res) => {
  const { status, rejectionReason } = req.body;

  if (!status || !["approved", "rejected"].includes(status)) {
    throw new BadRequestError("Status noto'g'ri (approved | rejected)");
  }
  if (status === "rejected" && !rejectionReason) {
    throw new BadRequestError("Rad etish sababi majburiy");
  }

  const excuse = await attendanceService.reviewExcuse(
    req.params.id,
    status,
    rejectionReason,
    req.user._id,
  );

  res.json({ success: true, data: excuse });
});

module.exports = {
  getToday,
  getTodayAll,
  checkIn,
  checkOut,
  getMySchedule,
  getUserSchedule,
  getMyHistory,
  getSettings,
  updateSettings,
  getAllRecords,
  getUserMonthRecords,
  getRecord,
  createExcuseRequest,
  cancelExcuseRequest,
  getRecentExcuses,
  getMyExcuses,
  getAllExcuses,
  getExcuse,
  reviewExcuse,
};
