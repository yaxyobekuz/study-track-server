const User = require("../models/user.model");
const { generateToken } = require("../utils/jwt");

// Login
const login = async (req, res) => {
  try {
    const { username, password } = req.body;

    // Validation
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: "Username and password are required",
      });
    }

    // Find user
    const user = await User.findOne({ username: username.toLowerCase() }).populate("classes", "name");

    if (!user || !(await user.matchPassword(password))) {
      return res.status(400).json({
        success: false,
        message: "Incorrect username or password",
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: "Your account is not active",
      });
    }

    // Generate token
    const token = generateToken(user._id);

    // Return response
    res.json({
      success: true,
      data: {
        user: {
          id: user._id,
          username: user.username,
          firstName: user.firstName,
          lastName: user.lastName,
          fullName: user.fullName,
          role: user.role,
          classes: user.classes,
        },
        token,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// Get current user data
const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate("classes", "name");

    res.json({
      success: true,
      data: user,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

module.exports = { login, getMe };
