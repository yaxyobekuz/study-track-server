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
  const user = await authService.getMe(req.user._id);

  res.json({
    success: true,
    data: user,
  });
});

module.exports = { login, getMe };
