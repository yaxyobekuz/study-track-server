const asyncHandler = require("../middleware/async.middleware");
const attendanceService = require("../services/attendance.service");
const { BadRequestError, NotFoundError } = require("../utils/errors");

/**
 * @desc  Bugungi davomat yozuvini olish
 * @route GET /api/attendance/today
 * @access Private
 */
const getToday = asyncHandler(async (req, res) => {
  const record = await attendanceService.getTodayRecord(req.user._id);
  res.json({ success: true, data: record });
});

/**
 * @desc  Check-in (Men keldim)
 * @route POST /api/attendance/check-in
 * @access Private
 */
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
    adminUserId
  );

  res.status(201).json({ success: true, data: record });
});

/**
 * @desc  Check-out (Men ketdim)
 * @route POST /api/attendance/check-out
 * @access Private
 */
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
    adminUserId
  );

  res.json({ success: true, data: record });
});

/**
 * @desc  O'z davomat tarixini olish
 * @route GET /api/attendance/my?month=4&year=2026
 * @access Private
 */
const getMyHistory = asyncHandler(async (req, res) => {
  const month = req.query.month || new Date().getMonth() + 1;
  const year = req.query.year || new Date().getFullYear();

  const result = await attendanceService.getMyHistory(req.user._id, month, year);
  res.json({ success: true, ...result });
});

/**
 * @desc  Davomat sozlamalarini olish
 * @route GET /api/attendance/settings
 * @access Private (owner)
 */
const getSettings = asyncHandler(async (req, res) => {
  const settings = await attendanceService.getSettings();
  res.json({ success: true, data: settings });
});

/**
 * @desc  Davomat sozlamalarini yangilash
 * @route PUT /api/attendance/settings
 * @access Private (owner)
 */
const updateSettings = asyncHandler(async (req, res) => {
  const settings = await attendanceService.updateSettings(req.body, req.user._id);
  res.json({ success: true, data: settings });
});

/**
 * @desc  Barcha foydalanuvchilar davomatini olish (admin)
 * @route GET /api/attendance?userId=&role=&month=&year=&page=&limit=
 * @access Private (owner)
 */
const getAllRecords = asyncHandler(async (req, res) => {
  const result = await attendanceService.getAllRecords(req.query);
  res.json(result);
});

/**
 * @desc  Bitta foydalanuvchining oylik davomatini olish (admin)
 * @route GET /api/attendance/user/:userId?month=&year=
 * @access Private (owner)
 */
const getUserMonthRecords = asyncHandler(async (req, res) => {
  const month = req.query.month || new Date().getMonth() + 1;
  const year = req.query.year || new Date().getFullYear();

  const result = await attendanceService.getUserMonthRecords(
    req.params.userId,
    month,
    year
  );
  res.json({ success: true, ...result });
});

/**
 * @desc  Bitta davomat yozuvini olish
 * @route GET /api/attendance/:id
 * @access Private (owner)
 */
const getRecord = asyncHandler(async (req, res) => {
  const Attendance = require("../models/attendance.model");
  const record = await Attendance.findById(req.params.id)
    .populate("user", "firstName lastName username role")
    .populate("penaltyRef", "title points status")
    .lean();

  if (!record) throw new NotFoundError("Davomat yozuvi topilmadi");
  res.json({ success: true, data: record });
});

/**
 * @desc  Excuse so'rov yuborish
 * @route POST /api/attendance/excuse
 * @access Private
 */
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
    type
  );

  res.status(201).json({ success: true, data: excuse });
});

/**
 * @desc  O'z excuse so'rovlarini olish
 * @route GET /api/attendance/excuse/my
 * @access Private
 */
const getMyExcuses = asyncHandler(async (req, res) => {
  const result = await attendanceService.getMyExcuses(req.user._id, req);
  res.json(result);
});

/**
 * @desc  Barcha excuse so'rovlarini olish (admin)
 * @route GET /api/attendance/excuse
 * @access Private (owner)
 */
const getAllExcuses = asyncHandler(async (req, res) => {
  const result = await attendanceService.getAllExcuses(req);
  res.json(result);
});

/**
 * @desc  Bitta excuse so'rovni olish (admin)
 * @route GET /api/attendance/excuse/:id
 * @access Private (owner)
 */
const getExcuse = asyncHandler(async (req, res) => {
  const ExcuseRequest = require("../models/excuseRequest.model");
  const excuse = await ExcuseRequest.findById(req.params.id)
    .populate("user", "firstName lastName username role")
    .populate("reviewedBy", "firstName lastName")
    .lean();

  if (!excuse) throw new NotFoundError("So'rov topilmadi");
  res.json({ success: true, data: excuse });
});

/**
 * @desc  Excuse so'rovni ko'rib chiqish (tasdiqlash / rad etish)
 * @route PUT /api/attendance/excuse/:id/review
 * @access Private (owner)
 */
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
    req.user._id
  );

  res.json({ success: true, data: excuse });
});

module.exports = {
  getToday,
  checkIn,
  checkOut,
  getMyHistory,
  getSettings,
  updateSettings,
  getAllRecords,
  getUserMonthRecords,
  getRecord,
  createExcuseRequest,
  getMyExcuses,
  getAllExcuses,
  getExcuse,
  reviewExcuse,
};
