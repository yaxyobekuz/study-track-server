const prisma = require("../config/prisma");
const { getAttendanceSettings } = require("./settings.service");
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
  const role = await prisma.role.findFirst({ where: { value: user.role } });

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
  const user = await prisma.user.findUnique({ where: { id: userId } });
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
  const penalty = await prisma.penalty.create({
    data: {
      userId,
      givenBy: givenByUserId,
      title,
      description: "Avtomatik davomat jarimasi",
      points,
      status: "approved",
      isCustom: true,
      reviewedBy: givenByUserId,
      reviewedAt: new Date(),
    },
  });
  await prisma.user.update({
    where: { id: userId },
    data: { penaltyPoints: { increment: points } },
  });
  return penalty;
}

async function checkIn(userId, lat, lng, accuracy, adminUserId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");

  // Student va owner uchun davomat tizimi yo'q
  if (user.role === "student" || user.role === "owner") {
    throw new ForbiddenError("Bu funksiya sizga tegishli emas");
  }

  const today = getTodayNormalized();

  // Bugun allaqachon check-in qilganmi?
  const existing = await prisma.attendance.findFirst({
    where: { userId, date: today },
  });
  if (existing && existing.checkIn) {
    throw new BadRequestError("Bugun allaqachon kelganlik qayd etilgan");
  }

  const settings = await getAttendanceSettings();

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
    record = await prisma.attendance.update({
      where: { id: existing.id },
      data: {
        checkIn: now,
        status,
        isLate,
        lateMinutes,
        checkInLocation,
        outOfOffice,
        locationWarning,
      },
    });
  } else {
    record = await prisma.attendance.create({
      data: {
        userId,
        date: today,
        checkIn: now,
        status,
        isLate,
        lateMinutes,
        checkInLocation,
        outOfOffice,
        locationWarning,
        createdBy: userId,
      },
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
      record = await prisma.attendance.update({
        where: { id: record.id },
        data: { penaltyApplied: true, penaltyRef: penalty.id },
      });
    }
  }

  return record;
}

async function checkOut(userId, lat, lng, accuracy, adminUserId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");

  if (user.role === "student" || user.role === "owner") {
    throw new ForbiddenError("Bu funksiya sizga tegishli emas");
  }

  const today = getTodayNormalized();

  const record = await prisma.attendance.findFirst({
    where: { userId, date: today },
  });
  if (!record || !record.checkIn) {
    throw new BadRequestError("Avval kelganlikni qayd etish kerak");
  }
  if (record.checkOut) {
    throw new BadRequestError("Bugun allaqachon ketganlik qayd etilgan");
  }

  const settings = await getAttendanceSettings();

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

  // Yozuvni yangilash uchun ma'lumot
  const updateData = {
    checkOut: now,
    isEarlyOut,
    earlyOutMinutes,
    checkOutLocation,
  };

  // Agar check-out ham ofisdan tashqarida bo'lsa, locationWarning ni yangilash
  if (checkOutOutOfOffice && !record.locationWarning) {
    updateData.locationWarning = true;
    updateData.outOfOffice = true;
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
      updateData.penaltyApplied = true;
      updateData.penaltyRef = penalty.id;
    }
  }

  return prisma.attendance.update({
    where: { id: record.id },
    data: updateData,
  });
}

async function getTodayRecord(userId) {
  const today = getTodayNormalized();
  const record = await prisma.attendance.findFirst({
    where: { userId, date: today },
  });
  if (!record) return null;

  // penaltyRef — soft ref (FK emas), qo'lda yuklaymiz
  let penaltyRef = null;
  if (record.penaltyRef) {
    penaltyRef = await prisma.penalty.findUnique({
      where: { id: record.penaltyRef },
      select: { id: true, title: true, points: true, status: true },
    });
  }
  return { ...record, penaltyRef };
}

async function getMyHistory(userId, month, year) {
  const m = parseInt(month, 10);
  const y = parseInt(year, 10);

  const startDate = new Date(Date.UTC(y, m - 1, 1));
  const endDate = new Date(Date.UTC(y, m, 1));

  const records = await prisma.attendance.findMany({
    where: {
      userId,
      date: { gte: startDate, lt: endDate },
    },
    orderBy: { date: "asc" },
  });

  // penaltyRef — soft ref, qo'lda yuklaymiz
  const penaltyIds = [
    ...new Set(records.map((r) => r.penaltyRef).filter(Boolean)),
  ];
  const penalties = penaltyIds.length
    ? await prisma.penalty.findMany({
        where: { id: { in: penaltyIds } },
        select: { id: true, title: true, points: true, status: true },
      })
    : [];
  const penaltyMap = new Map(penalties.map((p) => [p.id, p]));
  const recordsWithPenalty = records.map((r) => ({
    ...r,
    penaltyRef: r.penaltyRef ? penaltyMap.get(r.penaltyRef) || null : null,
  }));

  const summary = {
    present: recordsWithPenalty.filter((r) => r.status === "present").length,
    late: recordsWithPenalty.filter((r) => r.status === "late").length,
    absent: recordsWithPenalty.filter((r) => r.status === "absent").length,
    excused: recordsWithPenalty.filter((r) => r.status === "excused").length,
    total: recordsWithPenalty.length,
  };

  return { records: recordsWithPenalty, summary };
}

async function getAllRecords(query) {
  const { userId, role, month, year } = query;
  const noPagination = query.noPagination === "true" || query.noPagination === true;
  const page = parseInt(query.page, 10) || 1;
  const limit = parseInt(query.limit, 10) || 30;
  const skip = (page - 1) * limit;

  const filter = {};

  if (userId) filter.userId = userId;
  if (month && year) {
    const m = parseInt(month, 10);
    const y = parseInt(year, 10);
    filter.date = {
      gte: new Date(Date.UTC(y, m - 1, 1)),
      lt: new Date(Date.UTC(y, m, 1)),
    };
  }

  // Role bo'yicha filtrlash uchun avval userlarni topamiz
  if (role && !userId) {
    const users = await prisma.user.findMany({
      where: { role, isActive: true },
      select: { id: true },
    });
    filter.userId = { in: users.map((u) => u.id) };
  }

  // user va penaltyRef — soft ref'lar, qo'lda yuklaymiz
  const attachRefs = async (records) => {
    const uIds = [...new Set(records.map((r) => r.userId).filter(Boolean))];
    const pIds = [...new Set(records.map((r) => r.penaltyRef).filter(Boolean))];
    const [users, penalties] = await Promise.all([
      uIds.length
        ? prisma.user.findMany({
            where: { id: { in: uIds } },
            select: { id: true, firstName: true, lastName: true, username: true, role: true },
          })
        : [],
      pIds.length
        ? prisma.penalty.findMany({
            where: { id: { in: pIds } },
            select: { id: true, title: true, points: true, status: true },
          })
        : [],
    ]);
    const userMap = new Map(users.map((u) => [u.id, u]));
    const penaltyMap = new Map(penalties.map((p) => [p.id, p]));
    return records.map((r) => ({
      ...r,
      user: r.userId ? userMap.get(r.userId) || null : null,
      penaltyRef: r.penaltyRef ? penaltyMap.get(r.penaltyRef) || null : null,
    }));
  };

  if (noPagination) {
    const rows = await prisma.attendance.findMany({
      where: filter,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    });
    const records = await attachRefs(rows);
    return { success: true, data: records };
  }

  const [rows, total] = await Promise.all([
    prisma.attendance.findMany({
      where: filter,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
    }),
    prisma.attendance.count({ where: filter }),
  ]);

  const records = await attachRefs(rows);
  return formatPaginationResponse(records, total, page, limit);
}

async function getUserMonthRecords(userId, month, year) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, firstName: true, lastName: true, username: true, role: true },
  });
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");

  const { records, summary } = await getMyHistory(userId, month, year);
  return { user, records, summary };
}

async function getTodayAllRecords(roleFilter, dateInput) {
  // Sana berilsa o'sha kun, aks holda bugun (default)
  const day = dateInput ? normalizeDateTashkent(dateInput) : getTodayNormalized();

  const userFilter = { isActive: true, role: { notIn: ["owner", "student"] } };
  if (roleFilter) userFilter.role = roleFilter;

  const allUsers = await prisma.user.findMany({
    where: userFilter,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      role: true,
      workStartTime: true,
      workEndTime: true,
      workDays: true,
      weeklySchedule: true,
    },
  });
  const userIds = allUsers.map((u) => u.id);

  const records = await prisma.attendance.findMany({
    where: { userId: { in: userIds }, date: day },
  });

  const recordByUser = {};
  records.forEach((r) => {
    recordByUser[r.userId] = r;
  });

  const rows = await Promise.all(
    allUsers.map(async (u) => {
      const rec = recordByUser[u.id];
      const schedule = await getEffectiveSchedule(u);
      return {
        user: {
          id: u.id,
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

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");
    if (user.role === "student" || user.role === "owner") {
      throw new BadRequestError(
        "Bu foydalanuvchi uchun davomat belgilab bo'lmaydi",
      );
    }

    const isExcused = status === "excused";

    const updated = await prisma.attendance.upsert({
      where: { userId_date: { userId, date: normalizedDate } },
      update: {
        status,
        absenceReason: isExcused ? absenceReason : null,
        excuseReason: isExcused ? excuseReason || null : null,
        autoMarked: false,
        lastModifiedBy: markedBy,
      },
      create: {
        userId,
        date: normalizedDate,
        status,
        absenceReason: isExcused ? absenceReason : null,
        excuseReason: isExcused ? excuseReason || null : null,
        autoMarked: false,
        lastModifiedBy: markedBy,
        createdBy: markedBy,
      },
    });

    results.push(updated);
  }

  return results;
}

async function getSettings() {
  return getAttendanceSettings();
}

async function updateSettings(data, updatedBy) {
  const settings = await getAttendanceSettings();

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

  const update = {};
  allowed.forEach((key) => {
    if (data[key] !== undefined) update[key] = data[key];
  });

  update.updatedBy = updatedBy;

  return prisma.attendanceSettings.update({
    where: { id: settings.id },
    data: update,
  });
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
  const existing = await prisma.excuseRequest.findFirst({
    where: {
      userId,
      date: normalizedDate,
      status: { not: "rejected" },
    },
  });
  if (existing) {
    const statusLabel =
      EXCUSE_STATUS_LABELS_UZ[existing.status] || existing.status;
    throw new BadRequestError(
      `Bu kun uchun allaqachon so'rov bor (holati: ${statusLabel})`,
    );
  }

  return prisma.excuseRequest.create({
    data: {
      userId,
      date: normalizedDate,
      absenceReason: absenceReason || null,
      reason: reason || null,
      type: type || "after",
    },
  });
}

/**
 * Foydalanuvchi o'zining kutilayotgan so'rovini bekor qiladi.
 * @param {string} excuseId
 * @param {string} userId
 */
async function cancelExcuseRequest(excuseId, userId) {
  const excuse = await prisma.excuseRequest.findUnique({
    where: { id: excuseId },
  });
  if (!excuse) throw new NotFoundError("So'rov topilmadi");

  if (excuse.userId.toString() !== userId.toString()) {
    throw new ForbiddenError("Bu so'rov sizga tegishli emas");
  }
  if (excuse.status !== "pending") {
    throw new BadRequestError(
      "Faqat kutilayotgan so'rovni bekor qilish mumkin",
    );
  }

  await prisma.excuseRequest.delete({ where: { id: excuseId } });
}

/**
 * Admin bosh sahifasi uchun so'nggi uzrli so'rovlar.
 * So'nggi 10 ta "pending" so'rov; yetishmasa "approved" bilan to'ldiriladi.
 * @returns {Promise<{items: Array, pendingCount: number}>}
 */
async function getRecentExcuses() {
  const LIMIT = 10;

  const [pending, pendingCount] = await Promise.all([
    prisma.excuseRequest.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
    }),
    prisma.excuseRequest.count({ where: { status: "pending" } }),
  ]);

  let items = pending;

  if (items.length < LIMIT) {
    const approved = await prisma.excuseRequest.findMany({
      where: { status: "approved" },
      orderBy: { reviewedAt: "desc" },
      take: LIMIT - items.length,
    });
    items = items.concat(approved);
  }

  // user, reviewedBy, absenceReason — soft ref'lar, qo'lda yuklaymiz
  const items2 = await attachExcuseRefs(items);

  return { items: items2, pendingCount };
}

// user/reviewedBy/absenceReason soft ref'larni qo'lda yuklab xaritalaydi
async function attachExcuseRefs(records) {
  const userIds = [...new Set(records.map((r) => r.userId).filter(Boolean))];
  const reviewerIds = [
    ...new Set(records.map((r) => r.reviewedBy).filter(Boolean)),
  ];
  const reasonIds = [
    ...new Set(records.map((r) => r.absenceReason).filter(Boolean)),
  ];

  const [users, reviewers, reasons] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, firstName: true, lastName: true, username: true, role: true },
        })
      : [],
    reviewerIds.length
      ? prisma.user.findMany({
          where: { id: { in: reviewerIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [],
    reasonIds.length
      ? prisma.absenceReason.findMany({
          where: { id: { in: reasonIds } },
          select: { id: true, title: true },
        })
      : [],
  ]);

  const userMap = new Map(users.map((u) => [u.id, u]));
  const reviewerMap = new Map(reviewers.map((u) => [u.id, u]));
  const reasonMap = new Map(reasons.map((r) => [r.id, r]));

  return records.map((r) => ({
    ...r,
    user: r.userId ? userMap.get(r.userId) || null : null,
    reviewedBy: r.reviewedBy ? reviewerMap.get(r.reviewedBy) || null : null,
    absenceReason: r.absenceReason
      ? reasonMap.get(r.absenceReason) || null
      : null,
  }));
}

async function getMyExcuses(userId, req) {
  const { page, limit, skip } = getPaginationParams(req);

  const filter = { userId };
  if (req.query.status) filter.status = req.query.status;

  const [rows, total] = await Promise.all([
    prisma.excuseRequest.findMany({
      where: filter,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.excuseRequest.count({ where: filter }),
  ]);

  // absenceReason — soft ref, qo'lda yuklaymiz
  const reasonIds = [...new Set(rows.map((r) => r.absenceReason).filter(Boolean))];
  const reasons = reasonIds.length
    ? await prisma.absenceReason.findMany({
        where: { id: { in: reasonIds } },
        select: { id: true, title: true },
      })
    : [];
  const reasonMap = new Map(reasons.map((r) => [r.id, r]));
  const data = rows.map((r) => ({
    ...r,
    absenceReason: r.absenceReason
      ? reasonMap.get(r.absenceReason) || null
      : null,
  }));

  return formatPaginationResponse(data, total, page, limit);
}

async function getAllExcuses(req) {
  const { page, limit, skip } = getPaginationParams(req);

  const filter = {};
  if (req.query.status) filter.status = req.query.status;

  const [rows, total] = await Promise.all([
    prisma.excuseRequest.findMany({
      where: filter,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.excuseRequest.count({ where: filter }),
  ]);

  const data = await attachExcuseRefs(rows);

  return formatPaginationResponse(data, total, page, limit);
}

async function reviewExcuse(excuseId, status, rejectionReason, reviewedBy) {
  const excuse = await prisma.excuseRequest.findUnique({
    where: { id: excuseId },
  });
  if (!excuse) throw new NotFoundError("So'rov topilmadi");
  if (excuse.status !== "pending")
    throw new BadRequestError("So'rov allaqachon ko'rib chiqilgan");

  const excuseUpdate = {
    status,
    reviewedBy,
    reviewedAt: new Date(),
  };
  if (status === "rejected" && rejectionReason) {
    excuseUpdate.rejectionReason = rejectionReason;
  }
  const updatedExcuse = await prisma.excuseRequest.update({
    where: { id: excuseId },
    data: excuseUpdate,
  });

  if (status === "approved") {
    const settings = await getAttendanceSettings();
    const record = await prisma.attendance.findFirst({
      where: {
        userId: excuse.userId,
        date: excuse.date,
      },
    });

    if (
      record &&
      record.status === "absent" &&
      record.penaltyApplied &&
      record.penaltyRef
    ) {
      // Yozilgan jarimani bekor qilish
      await prisma.penalty.update({
        where: { id: record.penaltyRef },
        data: { status: "rejected" },
      });
      await prisma.user.update({
        where: { id: excuse.userId },
        data: { penaltyPoints: { increment: -settings.absentPenaltyPoints } },
      });
      await prisma.attendance.update({
        where: { id: record.id },
        data: {
          status: "excused",
          penaltyApplied: false,
          absenceReason: excuse.absenceReason || null,
          excuseReason: excuse.reason || null,
        },
      });
    } else if (record && record.status === "absent") {
      await prisma.attendance.update({
        where: { id: record.id },
        data: {
          status: "excused",
          absenceReason: excuse.absenceReason || null,
          excuseReason: excuse.reason || null,
        },
      });
    } else if (!record) {
      await prisma.attendance.create({
        data: {
          userId: excuse.userId,
          date: excuse.date,
          status: "excused",
          absenceReason: excuse.absenceReason || null,
          excuseReason: excuse.reason || null,
          autoMarked: true,
          createdBy: reviewedBy,
        },
      });
    }
  }

  return updatedExcuse;
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
