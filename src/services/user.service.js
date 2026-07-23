const prisma = require("../config/prisma");
const {
  NotFoundError,
  ForbiddenError,
  BadRequestError,
} = require("../utils/errors");
const logger = require("../utils/logger");
const { hashPassword, matchPassword } = require("../utils/password");
const {
  recalculateCurrentWeekForStudent,
  createWeeklyStatsForStudent,
} = require("./weeklystats.service");
const { getCurrentWeekRange } = require("../helpers/statistics.helpers");

// Junction M2M classes → eski `classes: [{_id,name}]` shakliga tekislaydi
function flattenClasses(user) {
  if (!user) return user;
  const out = { ...user, _id: user.id };
  if (Array.isArray(user.classes)) {
    out.classes = user.classes.map((uc) => (uc.class ? uc.class : uc));
  }
  return out;
}

// classes junction bilan user'ni yuklab, password'siz tekislangan shaklda qaytaradi
async function loadUser(id, { withPassword = false, withPlain = false } = {}) {
  const user = await prisma.user.findUnique({
    where: { id },
    include: { classes: { include: { class: { select: { id: true, name: true } } } } },
    ...(withPassword ? {} : { omit: { password: true, plainPassword: !withPlain } }),
  });
  return flattenClasses(user);
}

async function getStats() {
  const [telegramUsers, workers, students, premiumUsers] = await Promise.all([
    prisma.tgUser.count(),
    prisma.user.count({ where: { role: { notIn: ["owner", "student"] } } }),
    prisma.user.count({ where: { role: "student", isArchived: false } }),
    prisma.premium.count({ where: { status: "active" } }),
  ]);

  return { telegramUsers, workers, students, premiumUsers };
}

/**
 * Barcha foydalanuvchilarni sahifalangan holda olish.
 */
async function getAllUsers(query) {
  const { role, class: classId, page = 1, limit = 24, search, archived } = query;

  const where = {};
  if (role) where.role = role;
  if (classId) where.classes = { some: { classId } };

  // Arxivlangan tab faqat arxivlanganlarni, Asosiy tab esa qolganlarni ko'rsatadi
  if (archived === "true" || archived === true) {
    where.isArchived = true;
  } else {
    where.isArchived = false;
  }

  if (search && search.trim()) {
    const s = search.trim();
    where.OR = [
      { firstName: { contains: s, mode: "insensitive" } },
      { lastName: { contains: s, mode: "insensitive" } },
      { username: { contains: s, mode: "insensitive" } },
    ];
  }

  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);
  const skip = (pageNum - 1) * limitNum;

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      omit: { password: true, plainPassword: true },
      include: { classes: { include: { class: { select: { id: true, name: true } } } } },
      orderBy: { createdAt: "desc" },
      skip,
      take: limitNum,
    }),
  ]);

  // Har bir foydalanuvchi uchun effektiv default ish vaqti (rol → user merosi).
  const roles = await prisma.role.findMany({
    select: { value: true, workStartTime: true, workEndTime: true },
  });
  const roleMap = {};
  roles.forEach((r) => {
    roleMap[r.value] = r;
  });

  const usersWithSchedule = users.map((u) => {
    const obj = flattenClasses(u);
    if (u.role === "student" || u.role === "owner") {
      obj.effectiveSchedule = null;
    } else {
      const role = roleMap[u.role];
      const hasUserOverride = u.workStartTime && u.workEndTime;
      obj.effectiveSchedule = {
        workStartTime: hasUserOverride
          ? u.workStartTime
          : role?.workStartTime || null,
        workEndTime: hasUserOverride
          ? u.workEndTime
          : role?.workEndTime || null,
        source: hasUserOverride ? "user" : "role",
      };
    }
    return obj;
  });

  const totalPages = Math.ceil(total / limitNum);

  return {
    users: usersWithSchedule,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages,
      hasNextPage: pageNum < totalPages,
      hasPrevPage: pageNum > 1,
    },
  };
}

/**
 * Yangi foydalanuvchi yaratish.
 */
async function createUser(data) {
  const {
    username,
    password,
    firstName,
    lastName,
    role,
    gender,
    classes: userClasses,
    workStartTime,
    workEndTime,
    workDays,
    weeklySchedule,
  } = data;

  if (!username || !password || !firstName || !lastName || !role) {
    throw new BadRequestError("Barcha majburiy maydonlarni to'ldiring");
  }

  if (role === "owner") {
    throw new BadRequestError("Owner rolini yaratish mumkin emas");
  }

  const roleExists = await prisma.role.findUnique({ where: { value: role } });
  if (!roleExists) {
    throw new BadRequestError("Noto'g'ri rol");
  }

  if (role === "student" && userClasses && userClasses.length > 0) {
    for (const classId of userClasses) {
      const classExists = await prisma.class.findUnique({ where: { id: classId } });
      if (!classExists) {
        throw new BadRequestError(`Sinf topilmadi: ${classId}`);
      }
    }
  }

  const hashed = await hashPassword(password);

  const created = await prisma.user.create({
    data: {
      username: username.toLowerCase(),
      password: hashed,
      plainPassword: password,
      firstName,
      lastName,
      role,
      gender: gender || null,
      ...(role === "student" && userClasses && userClasses.length > 0
        ? { classes: { create: userClasses.map((classId) => ({ classId })) } }
        : {}),
      ...(role !== "student" && {
        workStartTime: workStartTime || null,
        workEndTime: workEndTime || null,
        workDays: workDays || [],
        weeklySchedule: weeklySchedule || {},
      }),
    },
  });

  // Mongoose post-save hook o'rniga: yangi student uchun WeeklyStats yaratish
  if (role === "student") {
    try {
      const { weekNumber, year } = getCurrentWeekRange();
      await createWeeklyStatsForStudent(created.id, weekNumber, year);
      logger.info(`WeeklyStats yaratildi yangi o'quvchi uchun: ${created.id}`);
    } catch (error) {
      logger.error("Yangi o'quvchi uchun WeeklyStats yaratishda xato:", error);
    }
  }

  return loadUser(created.id);
}

/**
 * Foydalanuvchini yangilash.
 */
async function updateUser(id, data) {
  const {
    firstName,
    lastName,
    gender,
    classes: userClasses,
    isActive,
    workStartTime,
    workEndTime,
    workDays,
    weeklySchedule,
  } = data;

  const user = await prisma.user.findUnique({
    where: { id },
    include: { classes: { select: { classId: true } } },
  });
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  if (user.role === "owner") {
    throw new ForbiddenError("Egasi foydalanuvchisini o'zgartirish mumkin emas");
  }

  const update = {};
  if (firstName) update.firstName = firstName;
  if (lastName) update.lastName = lastName;
  if (isActive !== undefined) update.isActive = isActive;
  if (gender !== undefined) update.gender = gender || null;

  // Ish jadvali override (davomat uchun)
  if (user.role !== "student") {
    if (workStartTime !== undefined) update.workStartTime = workStartTime || null;
    if (workEndTime !== undefined) update.workEndTime = workEndTime || null;
    if (workDays !== undefined) update.workDays = workDays || [];
    if (weeklySchedule !== undefined) update.weeklySchedule = weeklySchedule || {};
  }

  let classesChanged = false;
  let nextClassIds = null;
  if (user.role === "student" && userClasses) {
    if (user.isArchived && userClasses.length > 0) {
      throw new BadRequestError(
        "Arxivlangan o'quvchiga sinf biriktirish mumkin emas",
      );
    }
    for (const classId of userClasses) {
      const classExists = await prisma.class.findUnique({ where: { id: classId } });
      if (!classExists) {
        throw new BadRequestError(`Sinf topilmadi: ${classId}`);
      }
    }

    const prevClasses = user.classes.map((c) => c.classId).sort();
    nextClassIds = [...userClasses].sort();
    classesChanged =
      prevClasses.length !== nextClassIds.length ||
      prevClasses.some((c, i) => c !== nextClassIds[i]);
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: update });
    if (classesChanged) {
      await tx.userClass.deleteMany({ where: { userId: id } });
      await tx.userClass.createMany({
        data: userClasses.map((classId) => ({ userId: id, classId })),
        skipDuplicates: true,
      });
    }
  });

  // Sinf o'zgargan bo'lsa, joriy hafta statistikasini darhol qayta hisoblaymiz.
  if (classesChanged) {
    try {
      await recalculateCurrentWeekForStudent(id);
    } catch (error) {
      logger.error(
        "Sinf o'zgarganda haftalik statistikani yangilashda xato:",
        error,
      );
    }
  }

  return loadUser(id);
}

/**
 * Foydalanuvchi parolini tiklash.
 */
async function resetPassword(id, newPassword) {
  if (!newPassword) {
    throw new BadRequestError("Yangi parol majburiy");
  }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  if (user.role === "owner") {
    throw new ForbiddenError(
      "Egasi foydalanuvchisi parolini tiklash mumkin emas",
    );
  }

  const hashed = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id },
    data: { password: hashed, plainPassword: newPassword },
  });
}

/**
 * Foydalanuvchi parolini olish (plainPassword).
 */
async function getUserPassword(id) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { plainPassword: true },
  });
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  return user.plainPassword || "Hisob eski, parolni ko'rsatib bo'lmaydi";
}

/**
 * Foydalanuvchini o'chirish.
 */
async function deleteUser(id) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  if (user.role === "owner") {
    throw new ForbiddenError("Egasi foydalanuvchisini o'chirish mumkin emas");
  }

  if (user.role === "student") {
    throw new BadRequestError(
      "O'quvchini o'chirib bo'lmaydi. Uning o'rniga arxivlang",
    );
  }

  await prisma.user.delete({ where: { id } });
}

/**
 * O'quvchini arxivlash (yumshoq o'chirish).
 */
async function archiveStudent(id, options = {}) {
  const { resetCoins = false, resetPenalties = false } = options;

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  if (user.role !== "student") {
    throw new BadRequestError("Faqat o'quvchini arxivlash mumkin");
  }

  if (user.isArchived) {
    throw new BadRequestError("O'quvchi allaqachon arxivlangan");
  }

  const update = {
    // 0lashtirishdan oldingi asl qiymatlarni saqlab qo'yamiz
    archiveSnapshot: {
      coinBalance: user.coinBalance,
      penaltyPoints: user.penaltyPoints,
    },
    isArchived: true,
    archivedAt: new Date(),
  };
  if (resetCoins) update.coinBalance = 0;
  if (resetPenalties) update.penaltyPoints = 0;

  // Arxivlangan o'quvchi barcha sinflardan avtomatik chiqariladi
  await prisma.$transaction([
    prisma.user.update({ where: { id }, data: update }),
    prisma.userClass.deleteMany({ where: { userId: id } }),
  ]);

  return loadUser(id);
}

/**
 * Arxivlangan o'quvchini qaytarish.
 */
async function restoreStudent(id) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  if (!user.isArchived) {
    throw new BadRequestError("O'quvchi arxivlanmagan");
  }

  await prisma.user.update({
    where: { id },
    data: { isArchived: false, archivedAt: null },
  });

  return loadUser(id);
}

/**
 * Excel eksport uchun foydalanuvchilar ma'lumotlarini tayyorlash.
 */
async function getUsersForExport(role) {
  const where = {};
  if (role) {
    where.role = role;
  } else {
    where.role = { not: "owner" };
  }

  const users = await prisma.user.findMany({
    where,
    include: { classes: { include: { class: { select: { name: true } } } } },
    orderBy: [{ role: "asc" }, { firstName: "asc" }],
  });

  const allRoles = await prisma.role.findMany();
  const roleMap = {};
  allRoles.forEach((r) => {
    roleMap[r.value] = r.name;
  });

  return users.map((user) => ({
    fullName: `${user.firstName} ${user.lastName || ""}`.trim(),
    username: user.username,
    password: user.plainPassword || "N/A",
    role: roleMap[user.role] || user.role,
    classes:
      user.classes && user.classes.length > 0
        ? user.classes.map((c) => c.class.name).join(", ")
        : "-",
  }));
}

/**
 * Barcha faol foydalanuvchilarning qisqa ro'yxatini olish (owner bundan mustasno).
 */
async function getAllUsersShort() {
  return prisma.user.findMany({
    where: { isActive: true, isArchived: false, role: { not: "owner" } },
    select: { id: true, firstName: true, lastName: true, role: true },
    orderBy: [{ role: "asc" }, { firstName: "asc" }],
  });
}

/**
 * Talabalar ro'yxatini olish (qidiruv bilan).
 */
async function getStudents(query) {
  const { search, limit = 500 } = query;

  const where = { role: "student", isArchived: false };

  if (search && search.trim()) {
    const s = search.trim();
    where.OR = [
      { firstName: { contains: s, mode: "insensitive" } },
      { lastName: { contains: s, mode: "insensitive" } },
      { username: { contains: s, mode: "insensitive" } },
    ];
  }

  const users = await prisma.user.findMany({
    where,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      username: true,
      penaltyPoints: true,
      classes: { include: { class: { select: { id: true, name: true } } } },
    },
    orderBy: { firstName: "asc" },
    take: parseInt(limit, 10),
  });

  return users.map(flattenClasses);
}

/**
 * Foydalanuvchining o'z profilini yangilash.
 */
async function updateSelfProfile(userId, data) {
  const { firstName, lastName, username, currentPassword, newPassword } = data;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  const update = {};
  if (firstName !== undefined) update.firstName = firstName;
  if (lastName !== undefined) update.lastName = lastName;

  // Username o'zgartirish - unikallik tekshiruvi bilan
  if (username !== undefined) {
    const normalizedUsername = String(username).toLowerCase().trim();
    if (normalizedUsername !== user.username) {
      const usernameTaken = await prisma.user.findFirst({
        where: { username: normalizedUsername, id: { not: userId } },
      });
      if (usernameTaken) {
        throw new BadRequestError("Bu username allaqachon band");
      }
      update.username = normalizedUsername;
    }
  }

  // Parol o'zgartirish - joriy parolni tasdiqlash talab qilinadi
  if (newPassword) {
    if (!currentPassword) {
      throw new BadRequestError("Joriy parolni kiriting");
    }

    const isMatch = await matchPassword(currentPassword, user.password);
    if (!isMatch) {
      throw new BadRequestError("Joriy parol noto'g'ri");
    }

    update.password = await hashPassword(newPassword);
    update.plainPassword = newPassword;
  }

  await prisma.user.update({ where: { id: userId }, data: update });

  return loadUser(userId);
}

module.exports = {
  getStats,
  getAllUsers,
  createUser,
  updateUser,
  resetPassword,
  getUserPassword,
  deleteUser,
  archiveStudent,
  restoreStudent,
  getUsersForExport,
  getAllUsersShort,
  getStudents,
  updateSelfProfile,
};
