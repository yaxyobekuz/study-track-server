const prisma = require("../config/prisma");
const asyncHandler = require("../middleware/async.middleware");
const attendanceService = require("../services/attendance.service");
const { BadRequestError, NotFoundError } = require("../utils/errors");

const getToday = asyncHandler(async (req, res) => {
  const record = await attendanceService.getTodayRecord(req.user.id);
  res.json({ success: true, data: record });
});

const checkIn = asyncHandler(async (req, res) => {
  const { lat, lng, accuracy } = req.body;

  // Admin (owner) userId ni topish - jarima "givenBy" uchun
  const adminUser = await prisma.user.findFirst({
    where: { role: "owner" },
    select: { id: true },
  });
  const adminUserId = adminUser?.id || req.user.id;

  const record = await attendanceService.checkIn(
    req.user.id,
    lat,
    lng,
    accuracy,
    adminUserId,
  );

  res.status(201).json({ success: true, data: record });
});

const checkOut = asyncHandler(async (req, res) => {
  const { lat, lng, accuracy } = req.body;

  const adminUser = await prisma.user.findFirst({
    where: { role: "owner" },
    select: { id: true },
  });
  const adminUserId = adminUser?.id || req.user.id;

  const record = await attendanceService.checkOut(
    req.user.id,
    lat,
    lng,
    accuracy,
    adminUserId,
  );

  res.json({ success: true, data: record });
});

const getMySchedule = asyncHandler(async (req, res) => {
  const schedule = await attendanceService.getScheduleForUser(req.user.id);
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
    req.user.id,
    month,
    year,
  );
  res.json({ success: true, ...result });
});

const getTodayAll = asyncHandler(async (req, res) => {
  const result = await attendanceService.getTodayAllRecords(
    req.query.role || null,
    req.query.date || null,
  );
  res.json({ success: true, ...result });
});

const markStaff = asyncHandler(async (req, res) => {
  const { date, records } = req.body;
  const result = await attendanceService.markStaffAttendance(
    { date, records },
    req.user.id,
  );
  res.json({ success: true, data: result });
});

const getSettings = asyncHandler(async (req, res) => {
  const settings = await attendanceService.getSettings();
  res.json({ success: true, data: settings });
});

const updateSettings = asyncHandler(async (req, res) => {
  const settings = await attendanceService.updateSettings(
    req.body,
    req.user.id,
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
  const record = await prisma.attendance.findUnique({
    where: { id: req.params.id },
  });

  if (!record) throw new NotFoundError("Davomat yozuvi topilmadi");

  // user va penaltyRef — soft ref (relation YO'Q), qo'lda yuklaymiz
  const [user, penaltyRef] = await Promise.all([
    record.userId
      ? prisma.user.findUnique({
          where: { id: record.userId },
          select: { id: true, firstName: true, lastName: true, username: true, role: true },
        })
      : null,
    record.penaltyRef
      ? prisma.penalty.findUnique({
          where: { id: record.penaltyRef },
          select: { id: true, title: true, points: true, status: true },
        })
      : null,
  ]);

  res.json({
    success: true,
    data: { ...record, user, penaltyRef },
  });
});

const createExcuseRequest = asyncHandler(async (req, res) => {
  const { date, reason, type, absenceReason } = req.body;

  if (!date) throw new BadRequestError("Sana majburiy");
  if (!absenceReason) throw new BadRequestError("Sabab tanlanishi shart");
  if (!type || !["advance", "after"].includes(type)) {
    throw new BadRequestError("So'rov turi noto'g'ri (advance | after)");
  }

  const excuse = await attendanceService.createExcuseRequest(req.user.id, {
    date,
    reason,
    type,
    absenceReason,
  });

  res.status(201).json({ success: true, data: excuse });
});

const getMyExcuses = asyncHandler(async (req, res) => {
  const result = await attendanceService.getMyExcuses(req.user.id, req);
  res.json(result);
});

const cancelExcuseRequest = asyncHandler(async (req, res) => {
  await attendanceService.cancelExcuseRequest(req.params.id, req.user.id);
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
  const excuse = await prisma.excuseRequest.findUnique({
    where: { id: req.params.id },
  });

  if (!excuse) throw new NotFoundError("So'rov topilmadi");

  // user, reviewedBy, absenceReason — soft ref (relation YO'Q), qo'lda yuklaymiz
  const [user, reviewedBy, absenceReason] = await Promise.all([
    excuse.userId
      ? prisma.user.findUnique({
          where: { id: excuse.userId },
          select: { id: true, firstName: true, lastName: true, username: true, role: true },
        })
      : null,
    excuse.reviewedBy
      ? prisma.user.findUnique({
          where: { id: excuse.reviewedBy },
          select: { id: true, firstName: true, lastName: true },
        })
      : null,
    excuse.absenceReason
      ? prisma.absenceReason.findUnique({
          where: { id: excuse.absenceReason },
          select: { id: true, title: true },
        })
      : null,
  ]);

  res.json({
    success: true,
    data: { ...excuse, user, reviewedBy, absenceReason },
  });
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
    req.user.id,
  );

  res.json({ success: true, data: excuse });
});

module.exports = {
  getToday,
  getTodayAll,
  markStaff,
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
