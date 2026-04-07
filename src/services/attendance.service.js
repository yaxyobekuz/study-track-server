const Attendance = require("../models/attendance.model");
const AttendanceSettings = require("../models/attendanceSettings.model");
const ExcuseRequest = require("../models/excuseRequest.model");
const Penalty = require("../models/penalty.model");
const User = require("../models/user.model");
const Role = require("../models/role.model");
const Holiday = require("../models/holiday.model");
const { checkOfficeLocation } = require("../helpers/geolocation.helpers");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");
const { BadRequestError, NotFoundError, ForbiddenError } = require("../utils/errors");
const logger = require("../utils/logger");

// ─── Yordamchi funksiyalar ────────────────────────────────────────────────────

/**
 * Toshkent vaqti bo'yicha bugungi sanani UTC midnight sifatida qaytaradi
 * @returns {Date}
 */
function getTodayNormalized() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const tashkentMs = utcMs + 5 * 3600000; // UTC+5
  const t = new Date(tashkentMs);
  return new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()));
}

/**
 * Berilgan sana uchun UTC midnight qaytaradi (Toshkent vaqtiga asoslanib)
 * @param {Date|string} dateInput
 * @returns {Date}
 */
function normalizeDateTashkent(dateInput) {
  const d = new Date(dateInput);
  const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
  const tashkentMs = utcMs + 5 * 3600000;
  const t = new Date(tashkentMs);
  return new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()));
}

/**
 * "HH:MM" stringni daqiqalarga o'giradi
 * @param {string} timeStr
 * @returns {number}
 */
function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Toshkent vaqtida hozirgi HH:MM ni daqiqalarda qaytaradi
 * @param {Date} date
 * @returns {number}
 */
function getCurrentMinutesTashkent(date = new Date()) {
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60000;
  const tashkentMs = utcMs + 5 * 3600000;
  const t = new Date(tashkentMs);
  return t.getHours() * 60 + t.getMinutes();
}

/**
 * Toshkent vaqtida haftaning kuni raqamini qaytaradi (0=Yakshanba)
 * @param {Date} date
 * @returns {number}
 */
function getDayOfWeekTashkent(date = new Date()) {
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60000;
  const tashkentMs = utcMs + 5 * 3600000;
  return new Date(tashkentMs).getDay();
}

/**
 * Foydalanuvchining effektiv ish jadvalini qaytaradi.
 * User darajasida override bo'lsa, uni qaytaradi. Aks holda roldan oladi.
 * @param {Object} user Mongoose user hujjati (lean yoki to'liq)
 * @returns {Promise<{ workStartTime: string|null, workEndTime: string|null, workDays: number[] }>}
 */
async function getEffectiveSchedule(user) {
  // User darajasida override bo'lsa (kamida bitta ish vaqti belgilangan bo'lsa)
  if (user.workStartTime && user.workEndTime) {
    return {
      workStartTime: user.workStartTime,
      workEndTime: user.workEndTime,
      workDays: user.workDays && user.workDays.length > 0 ? user.workDays : [1, 2, 3, 4, 5],
    };
  }
  // Roldan olish
  const role = await Role.findOne({ value: user.role }).lean();
  return {
    workStartTime: role?.workStartTime ?? null,
    workEndTime: role?.workEndTime ?? null,
    workDays:
      role?.workDays && role.workDays.length > 0 ? role.workDays : [1, 2, 3, 4, 5],
  };
}

/**
 * Foydalanuvchi uchun jarima pauza qilinganligini tekshiradi
 * @param {Object} settings AttendanceSettings hujjati
 * @param {string} userId
 * @param {string} userRole
 * @returns {boolean}
 */
function isPenaltyPaused(settings, userId, userRole) {
  if (settings.penaltyPaused) return true;
  if (settings.pausedRoles && settings.pausedRoles.includes(userRole)) return true;
  if (settings.pausedUsers && settings.pausedUsers.some((id) => id.toString() === userId.toString())) return true;
  return false;
}

/**
 * Davomat jarimasi yozadi va foydalanuvchi penaltyPoints ni yangilaydi
 * @param {string} userId
 * @param {string} givenByUserId
 * @param {string} title
 * @param {number} points
 * @returns {Promise<Object>} Yaratilgan Penalty hujjati
 */
async function createAttendancePenalty(userId, givenByUserId, title, points) {
  const penalty = await Penalty.create({
    user: userId,
    givenBy: givenByUserId,
    title,
    description: "Avtomatik davomat jarimasi",
    points,
    status: "approved",
    isCustom: true,
    reviewedBy: givenByUserId,
    reviewedAt: new Date(),
  });
  await User.findByIdAndUpdate(userId, { $inc: { penaltyPoints: points } });
  return penalty;
}

// ─── Asosiy service funksiyalari ──────────────────────────────────────────────

/**
 * Foydalanuvchi uchun check-in amalga oshiradi
 * @param {string} userId
 * @param {number} lat
 * @param {number} lng
 * @param {number} accuracy GPS aniqligi (metr)
 * @param {string} adminUserId Jarima uchun "givenBy" (owner user)
 * @returns {Promise<Object>} AttendanceRecord
 */
async function checkIn(userId, lat, lng, accuracy, adminUserId) {
  const user = await User.findById(userId).lean();
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");

  // Student va owner uchun davomat tizimi yo'q
  if (user.role === "student" || user.role === "owner") {
    throw new ForbiddenError("Bu funksiya sizga tegishli emas");
  }

  const today = getTodayNormalized();

  // Bugun allaqachon check-in qilganmi?
  const existing = await Attendance.findOne({ user: userId, date: today });
  if (existing && existing.checkIn) {
    throw new BadRequestError("Bugun allaqachon kelganlik qayd etilgan");
  }

  const settings = await AttendanceSettings.getSettings();

  // Geolokatsiya tekshiruvi
  let outOfOffice = false;
  let locationWarning = false;
  let checkInLocation = null;

  if (lat !== undefined && lng !== undefined) {
    checkInLocation = { lat, lng, accuracy: accuracy || 0 };

    if (settings.officeLocation && settings.officeLocation.lat && settings.officeLocation.lng) {
      const geoResult = checkOfficeLocation(
        lat,
        lng,
        accuracy || 0,
        settings.officeLocation.lat,
        settings.officeLocation.lng,
        settings.officeRadius
      );
      outOfOffice = geoResult.outOfOffice;
      locationWarning = geoResult.locationWarning;
    }
  }

  // Kech kelish tekshiruvi
  const schedule = await getEffectiveSchedule(user);
  const now = new Date();
  let isLate = false;
  let lateMinutes = 0;
  let status = "present";

  if (schedule.workStartTime) {
    const workStartMin = timeToMinutes(schedule.workStartTime);
    const currentMin = getCurrentMinutesTashkent(now);
    const graceMin = settings.lateArrivalGraceMinutes || 10;
    const allowedMin = workStartMin + graceMin;

    if (currentMin > allowedMin) {
      isLate = true;
      lateMinutes = currentMin - workStartMin;
      status = "late";
    }
  }

  // Yozuv yaratish yoki yangilash
  let record;
  if (existing) {
    existing.checkIn = now;
    existing.status = status;
    existing.isLate = isLate;
    existing.lateMinutes = lateMinutes;
    existing.checkInLocation = checkInLocation;
    existing.outOfOffice = outOfOffice;
    existing.locationWarning = locationWarning;
    record = await existing.save();
  } else {
    record = await Attendance.create({
      user: userId,
      date: today,
      checkIn: now,
      status,
      isLate,
      lateMinutes,
      checkInLocation,
      outOfOffice,
      locationWarning,
      createdBy: userId,
    });
  }

  // Kech kelish jarimasi
  if (isLate && settings.lateArrivalPenaltyPoints > 0) {
    const penaltyPaused = isPenaltyPaused(settings, userId, user.role);
    if (!penaltyPaused) {
      const dateStr = today.toISOString().split("T")[0];
      const penalty = await createAttendancePenalty(
        userId,
        adminUserId || userId,
        `Kech kelish: ${dateStr} (${lateMinutes} daqiqa)`,
        settings.lateArrivalPenaltyPoints
      );
      record.penaltyApplied = true;
      record.penaltyRef = penalty._id;
      await record.save();
    }
  }

  return record;
}

/**
 * Foydalanuvchi uchun check-out amalga oshiradi
 * @param {string} userId
 * @param {number} lat
 * @param {number} lng
 * @param {number} accuracy
 * @param {string} adminUserId
 * @returns {Promise<Object>} AttendanceRecord
 */
async function checkOut(userId, lat, lng, accuracy, adminUserId) {
  const user = await User.findById(userId).lean();
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");

  if (user.role === "student" || user.role === "owner") {
    throw new ForbiddenError("Bu funksiya sizga tegishli emas");
  }

  const today = getTodayNormalized();

  const record = await Attendance.findOne({ user: userId, date: today });
  if (!record || !record.checkIn) {
    throw new BadRequestError("Avval kelganlikni qayd etish kerak");
  }
  if (record.checkOut) {
    throw new BadRequestError("Bugun allaqachon ketganlik qayd etilgan");
  }

  const settings = await AttendanceSettings.getSettings();

  // Geolokatsiya tekshiruvi
  let checkOutLocation = null;
  let checkOutOutOfOffice = false;
  let checkOutWarning = false;

  if (lat !== undefined && lng !== undefined) {
    checkOutLocation = { lat, lng, accuracy: accuracy || 0 };

    if (settings.officeLocation && settings.officeLocation.lat && settings.officeLocation.lng) {
      const geoResult = checkOfficeLocation(
        lat,
        lng,
        accuracy || 0,
        settings.officeLocation.lat,
        settings.officeLocation.lng,
        settings.officeRadius
      );
      checkOutOutOfOffice = geoResult.outOfOffice;
      checkOutWarning = geoResult.locationWarning;
    }
  }

  // Erta ketish tekshiruvi
  const schedule = await getEffectiveSchedule(user);
  const now = new Date();
  let isEarlyOut = false;
  let earlyOutMinutes = 0;

  if (schedule.workEndTime) {
    const workEndMin = timeToMinutes(schedule.workEndTime);
    const currentMin = getCurrentMinutesTashkent(now);
    const graceMin = settings.earlyDepartureGraceMinutes || 10;
    const allowedMin = workEndMin - graceMin;

    if (currentMin < allowedMin) {
      isEarlyOut = true;
      earlyOutMinutes = workEndMin - currentMin;
    }
  }

  // Yozuvni yangilash
  record.checkOut = now;
  record.isEarlyOut = isEarlyOut;
  record.earlyOutMinutes = earlyOutMinutes;
  record.checkOutLocation = checkOutLocation;

  // Agar check-out ham ofisdan tashqarida bo'lsa, locationWarning ni yangilash
  if (checkOutOutOfOffice && !record.locationWarning) {
    record.locationWarning = true;
    record.outOfOffice = true;
  }

  // Erta ketish jarimasi (avval penaltyApplied bo'lmagan bo'lsa)
  if (isEarlyOut && settings.earlyDeparturePenaltyPoints > 0 && !record.penaltyApplied) {
    const penaltyPaused = isPenaltyPaused(settings, userId, user.role);
    if (!penaltyPaused) {
      const dateStr = today.toISOString().split("T")[0];
      const penalty = await createAttendancePenalty(
        userId,
        adminUserId || userId,
        `Erta ketish: ${dateStr} (${earlyOutMinutes} daqiqa)`,
        settings.earlyDeparturePenaltyPoints
      );
      record.penaltyApplied = true;
      record.penaltyRef = penalty._id;
    }
  }

  await record.save();
  return record;
}

/**
 * Bugungi davomat yozuvini qaytaradi
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function getTodayRecord(userId) {
  const today = getTodayNormalized();
  return Attendance.findOne({ user: userId, date: today })
    .populate("penaltyRef", "title points status")
    .lean();
}

/**
 * Foydalanuvchining oylik davomat tarixini qaytaradi
 * @param {string} userId
 * @param {number} month 1-12
 * @param {number} year
 * @returns {Promise<{ records: Object[], summary: Object }>}
 */
async function getMyHistory(userId, month, year) {
  const m = parseInt(month, 10);
  const y = parseInt(year, 10);

  const startDate = new Date(Date.UTC(y, m - 1, 1));
  const endDate = new Date(Date.UTC(y, m, 1));

  const records = await Attendance.find({
    user: userId,
    date: { $gte: startDate, $lt: endDate },
  })
    .sort({ date: 1 })
    .populate("penaltyRef", "title points status")
    .lean();

  const summary = {
    present: records.filter((r) => r.status === "present").length,
    late: records.filter((r) => r.status === "late").length,
    absent: records.filter((r) => r.status === "absent").length,
    excused: records.filter((r) => r.status === "excused").length,
    total: records.length,
  };

  return { records, summary };
}

/**
 * Admin uchun barcha foydalanuvchilar davomat ro'yxatini qaytaradi
 * @param {Object} query { userId, role, month, year, page, limit }
 * @returns {Promise<Object>} Paginated response
 */
async function getAllRecords(query) {
  const { userId, role, month, year } = query;
  const page = parseInt(query.page, 10) || 1;
  const limit = parseInt(query.limit, 10) || 30;
  const skip = (page - 1) * limit;

  const filter = {};

  if (userId) filter.user = userId;
  if (month && year) {
    const m = parseInt(month, 10);
    const y = parseInt(year, 10);
    filter.date = {
      $gte: new Date(Date.UTC(y, m - 1, 1)),
      $lt: new Date(Date.UTC(y, m, 1)),
    };
  }

  // Role bo'yicha filtrlash uchun avval userlarni topamiz
  if (role && !userId) {
    const users = await User.find({ role, isActive: true }, "_id").lean();
    filter.user = { $in: users.map((u) => u._id) };
  }

  const [records, total] = await Promise.all([
    Attendance.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("user", "firstName lastName username role")
      .populate("penaltyRef", "title points status")
      .lean(),
    Attendance.countDocuments(filter),
  ]);

  return formatPaginationResponse(records, total, page, limit);
}

/**
 * Bitta foydalanuvchining oylik davomatini qaytaradi (admin uchun)
 * @param {string} userId
 * @param {number} month
 * @param {number} year
 * @returns {Promise<{ user: Object, records: Object[], summary: Object }>}
 */
async function getUserMonthRecords(userId, month, year) {
  const user = await User.findById(userId, "firstName lastName username role").lean();
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");

  const { records, summary } = await getMyHistory(userId, month, year);
  return { user, records, summary };
}

/**
 * Davomat sozlamalarini qaytaradi
 * @returns {Promise<Object>}
 */
async function getSettings() {
  return AttendanceSettings.getSettings();
}

/**
 * Davomat sozlamalarini yangilaydi
 * @param {Object} data
 * @param {string} updatedBy
 * @returns {Promise<Object>}
 */
async function updateSettings(data, updatedBy) {
  const settings = await AttendanceSettings.getSettings();

  const allowed = [
    "officeLocation",
    "officeRadius",
    "lateArrivalPenaltyPoints",
    "lateArrivalGraceMinutes",
    "earlyDeparturePenaltyPoints",
    "earlyDepartureGraceMinutes",
    "absentPenaltyPoints",
    "penaltyPaused",
    "pausedRoles",
    "pausedUsers",
  ];

  allowed.forEach((key) => {
    if (data[key] !== undefined) settings[key] = data[key];
  });

  settings.updatedBy = updatedBy;
  await settings.save();
  return settings;
}

/**
 * Excuse so'rov yaratadi
 * @param {string} userId
 * @param {string} date
 * @param {string} reason
 * @param {string} type advance | after
 * @returns {Promise<Object>}
 */
async function createExcuseRequest(userId, date, reason, type) {
  const normalizedDate = normalizeDateTashkent(date);

  // Bir kun uchun bir so'rov
  const existing = await ExcuseRequest.findOne({
    user: userId,
    date: normalizedDate,
    status: { $ne: "rejected" },
  });
  if (existing) {
    throw new BadRequestError("Bu kun uchun allaqachon so'rov yuborilgan");
  }

  return ExcuseRequest.create({
    user: userId,
    date: normalizedDate,
    reason,
    type: type || "after",
  });
}

/**
 * Foydalanuvchining o'z excuse so'rovlarini qaytaradi
 * @param {string} userId
 * @param {Object} req
 * @returns {Promise<Object>}
 */
async function getMyExcuses(userId, req) {
  const { page, limit, skip } = getPaginationParams(req);

  const filter = { user: userId };
  if (req.query.status) filter.status = req.query.status;

  const [data, total] = await Promise.all([
    ExcuseRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ExcuseRequest.countDocuments(filter),
  ]);

  return formatPaginationResponse(data, total, page, limit);
}

/**
 * Admin uchun barcha excuse so'rovlarini qaytaradi
 * @param {Object} req
 * @returns {Promise<Object>}
 */
async function getAllExcuses(req) {
  const { page, limit, skip } = getPaginationParams(req);

  const filter = {};
  if (req.query.status) filter.status = req.query.status;

  const [data, total] = await Promise.all([
    ExcuseRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("user", "firstName lastName username role")
      .populate("reviewedBy", "firstName lastName")
      .lean(),
    ExcuseRequest.countDocuments(filter),
  ]);

  return formatPaginationResponse(data, total, page, limit);
}

/**
 * Excuse so'rovni ko'rib chiqadi (tasdiqlash / rad etish)
 * Tasdiqlanganda: AttendanceRecord ni excused ga o'zgartiradi, jarimani bekor qiladi
 * @param {string} excuseId
 * @param {string} status approved | rejected
 * @param {string|null} rejectionReason
 * @param {string} reviewedBy
 * @returns {Promise<Object>}
 */
async function reviewExcuse(excuseId, status, rejectionReason, reviewedBy) {
  const excuse = await ExcuseRequest.findById(excuseId);
  if (!excuse) throw new NotFoundError("So'rov topilmadi");
  if (excuse.status !== "pending") throw new BadRequestError("So'rov allaqachon ko'rib chiqilgan");

  excuse.status = status;
  excuse.reviewedBy = reviewedBy;
  excuse.reviewedAt = new Date();
  if (status === "rejected" && rejectionReason) {
    excuse.rejectionReason = rejectionReason;
  }
  await excuse.save();

  if (status === "approved") {
    const settings = await AttendanceSettings.getSettings();
    let record = await Attendance.findOne({ user: excuse.user, date: excuse.date });

    if (record && record.status === "absent" && record.penaltyApplied && record.penaltyRef) {
      // Yozilgan jarimani bekor qilish
      await Penalty.findByIdAndUpdate(record.penaltyRef, { status: "rejected" });
      await User.findByIdAndUpdate(excuse.user, {
        $inc: { penaltyPoints: -settings.absentPenaltyPoints },
      });
      record.status = "excused";
      record.penaltyApplied = false;
      await record.save();
    } else if (record && record.status === "absent") {
      record.status = "excused";
      await record.save();
    } else if (!record) {
      await Attendance.create({
        user: excuse.user,
        date: excuse.date,
        status: "excused",
        autoMarked: true,
        createdBy: reviewedBy,
      });
    }
  }

  return excuse;
}

module.exports = {
  checkIn,
  checkOut,
  getTodayRecord,
  getMyHistory,
  getAllRecords,
  getUserMonthRecords,
  getSettings,
  updateSettings,
  createExcuseRequest,
  getMyExcuses,
  getAllExcuses,
  reviewExcuse,
  getTodayNormalized,
  getEffectiveSchedule,
  isPenaltyPaused,
  createAttendancePenalty,
  getDayOfWeekTashkent,
  normalizeDateTashkent,
};
