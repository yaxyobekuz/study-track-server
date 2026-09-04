const asyncHandler = require("../middleware/async.middleware");
const { NotFoundError } = require("../utils/errors");
const ExcelService = require("../services/excel.service");
const userService = require("../services/user.service");
const staffReportService = require("../services/staffReport.service");
const { PERMISSIONS, hasPermission } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");

// Get user statistics (Owner only)
const getStats = asyncHandler(async (req, res) => {
  const data = await userService.getStats();

  res.json({ success: true, data });
});

// Xodimlar bo'limining "Hisobotlar" tabi.
//
// Davomat bloki ALOHIDA ruxsat ostida: `users.reports` shtat manzarasini
// ochadi, xodimlarning kelish-ketish tarixini emas. Ruxsati bo'lmasa blok
// umuman kelmaydi va frontend uni chizmaydi.
const getStaffReport = asyncHandler(async (req, res) => {
  const now = new Date();
  // Oy/yil ixtiyoriy: berilmasa yoki noto'g'ri kelsa joriy oy olinadi
  const rawMonth = parseInt(req.query.month, 10);
  const rawYear = parseInt(req.query.year, 10);
  const month = rawMonth >= 1 && rawMonth <= 12 ? rawMonth : now.getMonth() + 1;
  const year =
    rawYear >= 2000 && rawYear <= 2100 ? rawYear : now.getFullYear();

  const withAttendance =
    req.user.role === ROLES.OWNER ||
    hasPermission(req.user.permissions, PERMISSIONS.ATTENDANCE_REPORTS);

  const data = await staffReportService.getStaffReport(month, year, {
    withAttendance,
  });

  res.json({ success: true, data });
});

// Get all users (Owner only)
const getAllUsers = asyncHandler(async (req, res) => {
  const { users, pagination } = await userService.getAllUsers(req.query);

  res.json({ success: true, data: users, pagination });
});

// Create new user (Owner only)
const createUser = asyncHandler(async (req, res) => {
  const user = await userService.createUser(req.body, req.user?.id);

  res.status(201).json({
    success: true,
    message: "Foydalanuvchi muvaffaqiyatli yaratildi",
    data: user,
  });
});

// Get single user (Owner only)
const getUser = asyncHandler(async (req, res) => {
  // Service orqali: u `classes` va `subjects` junction'larini BIRGA yuklab
  // tekislaydi va parollarni o'zi yashiradi (parolni ko'rish alohida
  // ruxsatli endpoint — `GET /:id/password`).
  const data = await userService.getUserById(req.params.id);
  if (!data) throw new NotFoundError("Foydalanuvchi topilmadi");

  res.json({ success: true, data });
});

// Update user (Owner only)
const updateUser = asyncHandler(async (req, res) => {
  const user = await userService.updateUser(req.params.id, req.body);

  res.json({
    success: true,
    message: "Foydalanuvchi muvaffaqiyatli yangilandi",
    data: user,
  });
});

// Reset user password (Owner only)
const resetPassword = asyncHandler(async (req, res) => {
  await userService.resetPassword(req.params.id, req.body.newPassword);

  res.json({
    success: true,
    message: "Parol muvaffaqiyatli tiklandi",
  });
});

// Get user password (Owner only)
const getUserPassword = asyncHandler(async (req, res) => {
  const password = await userService.getUserPassword(req.params.id);

  res.json({
    success: true,
    data: { password },
  });
});

// Delete user (Owner only)
const deleteUser = asyncHandler(async (req, res) => {
  await userService.deleteUser(req.params.id);

  res.json({
    success: true,
    message: "Foydalanuvchi muvaffaqiyatli o'chirildi",
  });
});

// Archive user — student or staff (Owner only)
const archiveUser = asyncHandler(async (req, res) => {
  const { resetCoins, resetPenalties } = req.body;

  const user = await userService.archiveUser(req.params.id, {
    resetCoins: Boolean(resetCoins),
    resetPenalties: Boolean(resetPenalties),
  });

  res.json({
    success: true,
    message: "Foydalanuvchi muvaffaqiyatli arxivlandi",
    data: user,
  });
});

// Restore archived user (Owner only)
const restoreUser = asyncHandler(async (req, res) => {
  const user = await userService.restoreUser(req.params.id);

  res.json({
    success: true,
    message: "Foydalanuvchi arxivdan qaytarildi",
    data: user,
  });
});

// Export users to Excel (Owner only)
const exportUsersToExcel = asyncHandler(async (req, res) => {
  const { role } = req.query;
  const data = await userService.getUsersForExport(role);

  // Tanga faqat o'quvchida bo'ladi (`coin.service.js` butunlay `role:
  // "student"` bilan ishlaydi), jarima esa xodimda ham — shuning uchun
  // "Tangalar" ustuni faqat o'quvchi tushadigan eksportda chiziladi, aks
  // holda xodimlar faylida boshdan-oyoq nol turgan ustun paydo bo'lardi.
  const withCoins = !role || role === "all" || role === "student";

  const workbook = ExcelService.createExcel({
    sheetName: "Foydalanuvchilar",
    columns: [
      { header: "F.I.O", key: "fullName", width: 30 },
      { header: "Username", key: "username", width: 20 },
      { header: "Parol", key: "password", width: 18 },
      { header: "Rol", key: "role", width: 15 },
      { header: "Sinflar", key: "classes", width: 40 },
      ...(withCoins
        ? [{ header: "Tangalar", key: "coinBalance", width: 12 }]
        : []),
      { header: "Jarimalar", key: "penaltyPoints", width: 12 },
    ],
    data,
  });

  let baseName = "users";
  if (role === "teacher") baseName = "teachers";
  else if (role === "student") baseName = "students";
  const filename = ExcelService.generateFileName(baseName);

  await ExcelService.sendWorkbook(res, workbook, filename);
});

// Get all users short list (Owner only)
const getAllUsersShort = asyncHandler(async (req, res) => {
  const users = await userService.getAllUsersShort();

  res.json({ success: true, data: users });
});

// Get students list (Owner + Teacher)
const getStudents = asyncHandler(async (req, res) => {
  const students = await userService.getStudents(req.query);

  res.json({ success: true, data: students });
});

// Update own profile (any authenticated user)
const updateMe = asyncHandler(async (req, res) => {
  const { firstName, lastName, username, currentPassword, newPassword } = req.body;

  const user = await userService.updateSelfProfile(req.user.id, {
    firstName,
    lastName,
    username,
    currentPassword,
    newPassword,
  });

  res.json({
    success: true,
    message: "Profil muvaffaqiyatli yangilandi",
    data: user,
  });
});

// ─── FILIALGA BIRIKTIRISH ──────────────────────────────────────────

/**
 * Xodim qaysi filiallarda ishlaydi — har birida o'z roli va ruxsatlari bilan.
 * @route GET /api/users/:id/branches
 */
const getUserBranches = asyncHandler(async (req, res) => {
  const data = await userService.getUserBranches(req.params.id);

  res.json({ success: true, data });
});

/**
 * Xodimni boshqa filialga biriktirish.
 * @route POST /api/users/:id/branches
 */
const attachUserToBranch = asyncHandler(async (req, res) => {
  const data = await userService.attachToBranch(req.params.id, {
    branchId: req.body.branchId,
    role: req.body.role,
    actorId: req.user.id,
  });

  res.json({
    success: true,
    message: "Xodim filialga biriktirildi",
    data,
  });
});

/**
 * Xodimni filialdan chiqarish (asosiy filialdan chiqarib bo'lmaydi).
 * @route DELETE /api/users/:id/branches/:branchId
 */
const detachUserFromBranch = asyncHandler(async (req, res) => {
  const data = await userService.detachFromBranch(
    req.params.id,
    req.params.branchId,
  );

  res.json({
    success: true,
    message: "Xodim filialdan chiqarildi",
    data,
  });
});

module.exports = {
  getAllUsers,
  getAllUsersShort,
  getUser,
  createUser,
  updateUser,
  resetPassword,
  getUserPassword,
  deleteUser,
  archiveUser,
  restoreUser,
  getStats,
  getStaffReport,
  exportUsersToExcel,
  getStudents,
  updateMe,
  getUserBranches,
  attachUserToBranch,
  detachUserFromBranch,
};
