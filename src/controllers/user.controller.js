const User = require("../models/user.model");
const Class = require("../models/class.model");

// Get all users (Owner only)
exports.getAllUsers = async (req, res) => {
  try {
    const { role, class: classId } = req.query;

    let query = {};
    if (role) query.role = role;
    if (classId) query.class = classId;

    const users = await User.find(query)
      .populate("assignedClasses", "name grade section")
      .populate("class", "name grade section")
      .select("-password")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: users.length,
      data: users,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// Get single user
exports.getUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .populate("assignedClasses", "name grade section")
      .populate("class", "name grade section")
      .select("-password");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

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

// Create new user (Owner only)
exports.createUser = async (req, res) => {
  try {
    const {
      username,
      password,
      firstName,
      lastName,
      role,
      assignedClasses,
      class: userClass,
    } = req.body;

    // Validation
    if (!username || !password || !firstName || !lastName || !role) {
      return res.status(400).json({
        success: false,
        message: "All required fields must be filled",
      });
    }

    // Role validation
    if (!["teacher", "student"].includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Only teacher or student role can be created",
      });
    }

    // Check assignedClasses for teacher
    if (role === "teacher" && assignedClasses && assignedClasses.length > 0) {
      const classes = await Class.find({ _id: { $in: assignedClasses } });
      if (classes.length !== assignedClasses.length) {
        return res.status(400).json({
          success: false,
          message: "Some classes not found",
        });
      }
    }

    // Check class for student
    if (role === "student" && userClass) {
      const classExists = await Class.findById(userClass);
      if (!classExists) {
        return res.status(400).json({
          success: false,
          message: "Class not found",
        });
      }
    }

    // Create user
    const user = await User.create({
      username: username.toLowerCase(),
      password,
      firstName,
      lastName,
      role,
      assignedClasses: role === "teacher" ? assignedClasses : undefined,
      class: role === "student" ? userClass : undefined,
    });

    const populatedUser = await User.findById(user._id)
      .populate("assignedClasses", "name grade section")
      .populate("class", "name grade section")
      .select("-password");

    res.status(201).json({
      success: true,
      message: "User successfully created",
      data: populatedUser,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// Update user (Owner only)
exports.updateUser = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      assignedClasses,
      class: userClass,
      isActive,
    } = req.body;

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Owner cannot be modified
    if (user.role === "owner") {
      return res.status(403).json({
        success: false,
        message: "Owner user cannot be modified",
      });
    }

    // Update data
    if (firstName) user.firstName = firstName;
    if (lastName) user.lastName = lastName;
    if (isActive !== undefined) user.isActive = isActive;

    if (user.role === "teacher" && assignedClasses) {
      const classes = await Class.find({ _id: { $in: assignedClasses } });
      if (classes.length !== assignedClasses.length) {
        return res.status(400).json({
          success: false,
          message: "Some classes not found",
        });
      }
      user.assignedClasses = assignedClasses;
    }

    if (user.role === "student" && userClass) {
      const classExists = await Class.findById(userClass);
      if (!classExists) {
        return res.status(400).json({
          success: false,
          message: "Class not found",
        });
      }
      user.class = userClass;
    }

    await user.save();

    const updatedUser = await User.findById(user._id)
      .populate("assignedClasses", "name grade section")
      .populate("class", "name grade section")
      .select("-password");

    res.json({
      success: true,
      message: "User successfully updated",
      data: updatedUser,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// Reset user password (Owner only)
exports.resetPassword = async (req, res) => {
  try {
    const { newPassword } = req.body;

    if (!newPassword) {
      return res.status(400).json({
        success: false,
        message: "New password is required",
      });
    }

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Owner password cannot be reset by others
    if (user.role === "owner") {
      return res.status(403).json({
        success: false,
        message: "Owner user password cannot be reset",
      });
    }

    user.password = newPassword;
    await user.save();

    res.json({
      success: true,
      message: "Password successfully reset",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// Delete user (Owner only)
exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Owner cannot be deleted
    if (user.role === "owner") {
      return res.status(403).json({
        success: false,
        message: "Owner user cannot be deleted",
      });
    }

    await user.deleteOne();

    res.json({
      success: true,
      message: "User successfully deleted",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};
