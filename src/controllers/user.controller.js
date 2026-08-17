const asyncHandler = require("../middleware/async.middleware");
const prisma = require("../config/prisma");
const { NotFoundError } = require("../utils/errors");
const ExcelService = require("../services/excel.service");
const userService = require("../services/user.service");

// Get user statistics (Owner only)
const getStats = asyncHandler(async (req, res) => {
  const data = await userService.getStats();

  res.json({ success: true, data });
});

// Get all users (Owner only)
const getAllUsers = asyncHandler(async (req, res) => {
  const { users, pagination } = await userService.getAllUsers(req.query);

  res.json({ success: true, data: users, pagination });
});

// Create new user (Owner only)
const createUser = asyncHandler(async (req, res) => {
  const user = await userService.createUser(req.body);

  res.status(201).json({
    success: true,
    message: "Foydalanuvchi muvaffaqiyatli yaratildi",
    data: user,
  });
});

// Get single user (Owner only)
const getUser = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    // plainPassword ham yashiriladi — parolni ko'rish alohida ruxsatli
    // endpoint orqali beriladi (`GET /:id/password`)
    omit: { password: true, plainPassword: true },
    include: {
      classes: { include: { class: { select: { id: true, name: true } } } },
    },
  });
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");

  // Junction M2M classes → eski `classes: [{_id,name}]` shakliga tekislaymiz
  const data = { ...user };
  data.classes = (user.classes || []).map((uc) => ({
    ...uc.class,
  }));

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

  const workbook = ExcelService.createExcel({
    sheetName: "Foydalanuvchilar",
    columns: [
      { header: "F.I.O", key: "fullName", width: 30 },
      { header: "Username", key: "username", width: 20 },
      { header: "Parol", key: "password", width: 18 },
      { header: "Rol", key: "role", width: 15 },
      { header: "Sinflar", key: "classes", width: 40 },
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
  exportUsersToExcel,
  getStudents,
  updateMe,
};
