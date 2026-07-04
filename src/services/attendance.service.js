const Attendance = require("../models/attendance.model");
const AttendanceSettings = require("../models/attendanceSettings.model");
const ExcuseRequest = require("../models/excuseRequest.model");
const Penalty = require("../models/penalty.model");
const User = require("../models/user.model");
const Role = require("../models/role.model");
const { checkOfficeLocation } = require("../helpers/geolocation.helpers");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require("../utils/errors");
const logger = require("../utils/logger");

function getTodayNormalized() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const tashkentMs = utcMs + 5 * 3600000; // UTC+5
  const t = new Date(tashkentMs);
  return new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()));
}

function normalizeDateTashkent(dateInput) {
  const d = new Date(dateInput);
  const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
  const tashkentMs = utcMs + 5 * 3600000;
  const t = new Date(tashkentMs);
  return new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()));
}

function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

function getCurrentMinutesTashkent(date = new Date()) {
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60000;
  const tashkentMs = utcMs + 5 * 3600000;
  const t = new Date(tashkentMs);
  return t.getHours() * 60 + t.getMinutes();
}

function getDayOfWeekTashkent(date = new Date()) {
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60000;
  const tashkentMs = utcMs + 5 * 3600000;
  return new Date(tashkentMs).getDay();
}

function getWeeklyOverride(weeklySchedule, dayOfWeek) {
  if (!weeklySchedule) return null;
  const key = String(dayOfWeek);
  const entry = weeklySchedule instanceof Map
    ? weeklySchedule.get(key)
    : weeklySchedule[key];
  if (entry && entry.startTime && entry.endTime) {
    return { startTime: entry.startTime, endTime: entry.endTime };
  }
  return null;
}

async function getEffectiveSchedule(user, forDate) {
  const dayOfWeek = getDayOfWeekTashkent(forDate);

  // User darajasida override bo'lsa
  if (user.workStartTime && user.workEndTime) {
    let startTime = user.workStartTime;
    let endTime = user.workEndTime;

    // Kun uchun alohida vaqt belgilangan bo'lsa, uni ishlatamiz
    const dayOverride = getWeeklyOverride(user.weeklySchedule, dayOfWeek);
    if (dayOverride) {
      startTime = dayOverride.startTime;
      endTime = dayOverride.endTime;
    }

    return {
      workStartTime: startTime,
      workEndTime: endTime,
      workDays:
        user.workDays && user.workDays.length > 0
          ? user.workDays
          : [1, 2, 3, 4, 5],
    };
  }

  // Roldan olish
  const role = await Role.findOne({ value: user.role }).lean();

  let startTime = role?.workStartTime ?? null;
  let endTime = role?.workEndTime ?? null;

  // Rol darajasida kun uchun alohida vaqt belgilangan bo'lsa
  const dayOverride = getWeeklyOverride(role?.weeklySchedule, dayOfWeek);
  if (dayOverride) {
    startTime = dayOverride.startTime;
    endTime = dayOverride.endTime;
  }

  return {
    workStartTime: startTime,
    workEndTime: endTime,
    workDays:
      role?.workDays && role.workDays.length > 0
        ? role.workDays
        : [1, 2, 3, 4, 5],
  };
}

/**
 * Foydalanuvchining bugungi kun uchun effektiv ish jadvalini oladi.
 * @param {string} userId
 * @returns {Promise<{workStartTime, workEndTime, workDays, isWorkDayToday}>}
 */
async function getScheduleForUser(userId) {
  const user = await User.findById(userId).lean();
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");

  const schedule = await getEffectiveSchedule(user);
  const todayDayOfWeek = getDayOfWeekTashkent();

  return {
    ...schedule,
    isWorkDayToday: schedule.workDays.includes(todayDayOfWeek),
  };
}

function isPenaltyPaused(settings, userId, userRole) {
  if (settings.penaltyPaused) return true;
  if (settings.pausedRoles && settings.pausedRoles.includes(userRole))
    return true;
  if (
    settings.pausedUsers &&
    settings.pausedUsers.some((id) => id.toString() === userId.toString())
  )
    return true;
  return false;
}

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

    if (
      settings.officeLocation &&
      settings.officeLocation.lat &&
      settings.officeLocation.lng
    ) {
      const geoResult = checkOfficeLocation(
        lat,
        lng,
        accuracy || 0,
        settings.officeLocation.lat,
        settings.officeLocation.lng,
        settings.officeRadius,
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
        settings.lateArrivalPenaltyPoints,
      );
      record.penaltyApplied = true;
      record.penaltyRef = penalty._id;
      await record.save();
    }
  }

  return record;
}

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

    if (
      settings.officeLocation &&
      settings.officeLocation.lat &&
      settings.officeLocation.lng
    ) {
      const geoResult = checkOfficeLocation(
        lat,
        lng,
        accuracy || 0,
        settings.officeLocation.lat,
        settings.officeLocation.lng,
        settings.officeRadius,
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
  if (
    isEarlyOut &&
    settings.earlyDeparturePenaltyPoints > 0 &&
    !record.penaltyApplied
  ) {
    const penaltyPaused = isPenaltyPaused(settings, userId, user.role);
    if (!penaltyPaused) {
      const dateStr = today.toISOString().split("T")[0];
      const penalty = await createAttendancePenalty(
        userId,
        adminUserId || userId,
        `Erta ketish: ${dateStr} (${earlyOutMinutes} daqiqa)`,
        settings.earlyDeparturePenaltyPoints,
      );
      record.penaltyApplied = true;
      record.penaltyRef = penalty._id;
    }
  }

  await record.save();
  return record;
}

async function getTodayRecord(userId) {
  const today = getTodayNormalized();
  return Attendance.findOne({ user: userId, date: today })
    .populate("penaltyRef", "title points status")
    .lean();
}

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

async function getAllRecords(query) {
  const { userId, role, month, year } = query;
  const noPagination = query.noPagination === "true" || query.noPagination === true;
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

  if (noPagination) {
    const records = await Attendance.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .populate("user", "firstName lastName username role")
      .populate("penaltyRef", "title points status")
      .lean();
    return { success: true, data: records };
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

async function getUserMonthRecords(userId, month, year) {
  const user = await User.findById(
    userId,
    "firstName lastName username role",
  ).lean();
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");

  const { records, summary } = await getMyHistory(userId, month, year);
  return { user, records, summary };
}

async function getTodayAllRecords(roleFilter, dateInput) {
  // Sana berilsa o'sha kun, aks holda bugun (default)
  const day = dateInput ? normalizeDateTashkent(dateInput) : getTodayNormalized();

  const userFilter = { isActive: true, role: { $nin: ["owner", "student"] } };
  if (roleFilter) userFilter.role = roleFilter;

  const allUsers = await User.find(
    userFilter,
    "_id firstName lastName role workStartTime workEndTime workDays weeklySchedule",
  ).lean();
  const userIds = allUsers.map((u) => u._id);

  const records = await Attendance.find({ user: { $in: userIds }, date: day })
    .populate("user", "firstName lastName role")
    .lean();

  const recordByUser = {};
  records.forEach((r) => {
    const uid = r.user?._id?.toString() || r.user?.toString();
    recordByUser[uid] = r;
  });

  const rows = await Promise.all(
    allUsers.map(async (u) => {
      const rec = recordByUser[u._id.toString()];
      const schedule = await getEffectiveSchedule(u);
      return {
        user: {
          _id: u._id,
          firstName: u.firstName,
          lastName: u.lastName,
          role: u.role,
        },
        status: rec?.status || "not_marked",
        checkIn: rec?.checkIn || null,
        checkOut: rec?.checkOut || null,
        isLate: rec?.isLate || false,
        lateMinutes: rec?.lateMinutes || 0,
        excuseReason: rec?.excuseReason || null,
        absenceReason: rec?.absenceReason || null,
        outOfOffice: rec?.outOfOffice || false,
        expectedStart: schedule.workStartTime || null,
        expectedEnd: schedule.workEndTime || null,
      };
    }),
  );

  const summary = {
    total: rows.length,
    present: rows.filter((r) => r.status === "present").length,
    late: rows.filter((r) => r.status === "late").length,
    absent: rows.filter((r) => r.status === "absent").length,
    excused: rows.filter((r) => r.status === "excused").length,
    notMarked: rows.filter((r) => r.status === "not_marked").length,
  };

  return { rows, summary, date: day };
}

/**
 * Xodimlar davomatini qo'lda belgilash/o'zgartirish (istalgan kun uchun).
 * Geolokatsiyasiz, to'g'ridan-to'g'ri status qo'yiladi (admin tuzatishi).
 * @param {{date: string, records: Array<{userId, status, excuseReason}>}} payload
 * @param {string} markedBy - belgilayotgan admin _id
 */
async function markStaffAttendance({ date, records }, markedBy) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new BadRequestError("Belgilash uchun yozuvlar yo'q");
  }

  const normalizedDate = date ? normalizeDateTashkent(date) : getTodayNormalized();
  const validStatuses = ["present", "late", "absent", "excused"];

  const results = [];
  for (const rec of records) {
    const { userId, status, excuseReason, absenceReason } = rec;

    if (!validStatuses.includes(status)) {
      throw new BadRequestError(`Noto'g'ri status: ${status}`);
    }

    // "Sababli" holatda sabab (kategoriya) majburiy
    if (status === "excused" && !absenceReason) {
      throw new BadRequestError("'Sababli' holat uchun sabab tanlanishi shart");
    }

    const user = await User.findById(userId, "role").lean();
    if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");
    if (user.role === "student" || user.role === "owner") {
      throw new BadRequestError(
        "Bu foydalanuvchi uchun davomat belgilab bo'lmaydi",
      );
    }

    const isExcused = status === "excused";

    const updated = await Attendance.findOneAndUpdate(
      { user: userId, date: normalizedDate },
      {
        $set: {
          status,
          absenceReason: isExcused ? absenceReason : null,
          excuseReason: isExcused ? excuseReason || null : null,
          autoMarked: false,
          lastModifiedBy: markedBy,
        },
        $setOnInsert: {
          user: userId,
          date: normalizedDate,
          createdBy: markedBy,
        },
      },
      { upsert: true, new: true, runValidators: true },
    );

    results.push(updated);
  }

  return results;
}

async function getSettings() {
  return AttendanceSettings.getSettings();
}

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

const EXCUSE_STATUS_LABELS_UZ = {
  pending: "kutilmoqda",
  approved: "tasdiqlangan",
  rejected: "rad etilgan",
};

async function createExcuseRequest(userId, { date, reason, type, absenceReason }) {
  const normalizedDate = normalizeDateTashkent(date);
  const today = getTodayNormalized();

  // Sana cheklovi: juda eski yoki juda uzoq kelajak sanaga ruxsat berilmaydi
  const dayMs = 24 * 3600000;
  const diffDays = Math.round((normalizedDate.getTime() - today.getTime()) / dayMs);
  if (diffDays < -30) {
    throw new BadRequestError(
      "30 kundan eski sana uchun so'rov yuborib bo'lmaydi",
    );
  }
  if (diffDays > 90) {
    throw new BadRequestError(
      "90 kundan uzoq kelajak sana uchun so'rov yuborib bo'lmaydi",
    );
  }

  // Bir kun uchun bir so'rov
  const existing = await ExcuseRequest.findOne({
    user: userId,
    date: normalizedDate,
    status: { $ne: "rejected" },
  });
  if (existing) {
    const statusLabel =
      EXCUSE_STATUS_LABELS_UZ[existing.status] || existing.status;
    throw new BadRequestError(
      `Bu kun uchun allaqachon so'rov bor (holati: ${statusLabel})`,
    );
  }

  return ExcuseRequest.create({
    user: userId,
    date: normalizedDate,
    absenceReason: absenceReason || null,
    reason: reason || null,
    type: type || "after",
  });
}

/**
 * Foydalanuvchi o'zining kutilayotgan so'rovini bekor qiladi.
 * @param {string} excuseId
 * @param {string} userId
 */
async function cancelExcuseRequest(excuseId, userId) {
  const excuse = await ExcuseRequest.findById(excuseId);
  if (!excuse) throw new NotFoundError("So'rov topilmadi");

  if (excuse.user.toString() !== userId.toString()) {
    throw new ForbiddenError("Bu so'rov sizga tegishli emas");
  }
  if (excuse.status !== "pending") {
    throw new BadRequestError(
      "Faqat kutilayotgan so'rovni bekor qilish mumkin",
    );
  }

  await excuse.deleteOne();
}

/**
 * Admin bosh sahifasi uchun so'nggi uzrli so'rovlar.
 * So'nggi 10 ta "pending" so'rov; yetishmasa "approved" bilan to'ldiriladi.
 * @returns {Promise<{items: Array, pendingCount: number}>}
 */
async function getRecentExcuses() {
  const LIMIT = 10;
  const userFields = "firstName lastName username role";

  const [pending, pendingCount] = await Promise.all([
    ExcuseRequest.find({ status: "pending" })
      .sort({ createdAt: -1 })
      .limit(LIMIT)
      .populate("user", userFields)
      .populate("absenceReason", "title")
      .lean(),
    ExcuseRequest.countDocuments({ status: "pending" }),
  ]);

  let items = pending;

  if (items.length < LIMIT) {
    const approved = await ExcuseRequest.find({ status: "approved" })
      .sort({ reviewedAt: -1 })
      .limit(LIMIT - items.length)
      .populate("user", userFields)
      .populate("reviewedBy", "firstName lastName")
      .populate("absenceReason", "title")
      .lean();
    items = items.concat(approved);
  }

  return { items, pendingCount };
}

async function getMyExcuses(userId, req) {
  const { page, limit, skip } = getPaginationParams(req);

  const filter = { user: userId };
  if (req.query.status) filter.status = req.query.status;

  const [data, total] = await Promise.all([
    ExcuseRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("absenceReason", "title")
      .lean(),
    ExcuseRequest.countDocuments(filter),
  ]);

  return formatPaginationResponse(data, total, page, limit);
}

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
      .populate("absenceReason", "title")
      .lean(),
    ExcuseRequest.countDocuments(filter),
  ]);

  return formatPaginationResponse(data, total, page, limit);
}

async function reviewExcuse(excuseId, status, rejectionReason, reviewedBy) {
  const excuse = await ExcuseRequest.findById(excuseId);
  if (!excuse) throw new NotFoundError("So'rov topilmadi");
  if (excuse.status !== "pending")
    throw new BadRequestError("So'rov allaqachon ko'rib chiqilgan");

  excuse.status = status;
  excuse.reviewedBy = reviewedBy;
  excuse.reviewedAt = new Date();
  if (status === "rejected" && rejectionReason) {
    excuse.rejectionReason = rejectionReason;
  }
  await excuse.save();

  if (status === "approved") {
    const settings = await AttendanceSettings.getSettings();
    let record = await Attendance.findOne({
      user: excuse.user,
      date: excuse.date,
    });

    if (
      record &&
      record.status === "absent" &&
      record.penaltyApplied &&
      record.penaltyRef
    ) {
      // Yozilgan jarimani bekor qilish
      await Penalty.findByIdAndUpdate(record.penaltyRef, {
        status: "rejected",
      });
      await User.findByIdAndUpdate(excuse.user, {
        $inc: { penaltyPoints: -settings.absentPenaltyPoints },
      });
      record.status = "excused";
      record.penaltyApplied = false;
      record.absenceReason = excuse.absenceReason || null;
      record.excuseReason = excuse.reason || null;
      await record.save();
    } else if (record && record.status === "absent") {
      record.status = "excused";
      record.absenceReason = excuse.absenceReason || null;
      record.excuseReason = excuse.reason || null;
      await record.save();
    } else if (!record) {
      await Attendance.create({
        user: excuse.user,
        date: excuse.date,
        status: "excused",
        absenceReason: excuse.absenceReason || null,
        excuseReason: excuse.reason || null,
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
  getTodayAllRecords,
  markStaffAttendance,
  getMyHistory,
  getAllRecords,
  getUserMonthRecords,
  getSettings,
  updateSettings,
  createExcuseRequest,
  cancelExcuseRequest,
  getRecentExcuses,
  getMyExcuses,
  getAllExcuses,
  reviewExcuse,
  getTodayNormalized,
  getEffectiveSchedule,
  getScheduleForUser,
  isPenaltyPaused,
  createAttendancePenalty,
  getDayOfWeekTashkent,
  normalizeDateTashkent,
};
