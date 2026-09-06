const asyncHandler = require("../middleware/async.middleware");
const authService = require("../services/auth.service");
const { clientInfo } = require("../helpers/request.helpers");

// Login
//
// ⚠️ `clientInfo(req)` SERVICE'GA UZATILADI, `req` emas: service HTTP
// qatlamini bilmasligi kerak. Aks holda uni cron'dan yoki skriptdan
// chaqirib bo'lmasdi va test yozish uchun soxta `req` qurish kerak bo'lardi.
const login = asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  const data = await authService.login(username, password, clientInfo(req));

  res.json({
    success: true,
    data,
  });
});

// Get current user data
const getMe = asyncHandler(async (req, res) => {
  const user = await authService.getMe(req.user.id, req.branch);

  res.json({
    success: true,
    data: user,
  });
});

// Filial almashtirish — yangi token qaytaradi. Xodim faqat O'ZI
// BIRIKTIRILGAN filiallarga o'ta oladi (owner esa hammasiga).
//
// ⚠️ `req.tokenJti` — `auth.middleware` qo'yadi. Eski seans shu qiymat
// bilan yopiladi, aks holda bir odamning bitta brauzerdagi ishi "ikkita
// bir vaqtdagi seans" bo'lib ko'rinardi.
const switchBranch = asyncHandler(async (req, res) => {
  const { branchId } = req.body;
  const data = await authService.switchBranch(req.user, branchId, {
    client: clientInfo(req),
    currentJti: req.tokenJti,
  });

  res.json({
    success: true,
    message: `"${data.branch.name}" filialiga o'tildi`,
    data,
  });
});

// Chiqish — seansni yopadi. Token o'zi bekor qilinmaydi (JWT stateless),
// lekin yopilgan seans `auth.middleware` dan o'tmaydi.
const logout = asyncHandler(async (req, res) => {
  await authService.logout(req.tokenJti);

  res.json({
    success: true,
    message: "Tizimdan chiqildi",
  });
});

module.exports = { login, getMe, switchBranch, logout };
