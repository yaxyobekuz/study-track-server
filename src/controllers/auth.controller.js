const asyncHandler = require("../middleware/async.middleware");
const authService = require("../services/auth.service");

// Login
const login = asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  const data = await authService.login(username, password);

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

// Filial almashtirish — yangi token qaytaradi (owner / branches.switch)
const switchBranch = asyncHandler(async (req, res) => {
  const { branchId } = req.body;
  const data = await authService.switchBranch(req.user, branchId);

  res.json({
    success: true,
    message: `"${data.branch.name}" filialiga o'tildi`,
    data,
  });
});

module.exports = { login, getMe, switchBranch };
