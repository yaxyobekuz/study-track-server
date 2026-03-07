const ExcelService = require("../services/excel.service");
const User = require("../models/user.model");
const Class = require("../models/class.model");
const TgUser = require("../models/tguser.model");

// Get user statistics (Owner only)
const getStats = async (req, res) => {
  try {
    const [telegramUsers, teachers, students] = await Promise.all([
      TgUser.countDocuments(),
      User.countDocuments({ role: "teacher" }),
      User.countDocuments({ role: "student" }),
    ]);

    res.json({
      success: true,
      data: {
        telegramUsers,
        teachers,
        students,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Get all users (Owner only)
const getAllUsers = async (req, res) => {
  try {
    const { role, class: classId, page = 1, limit = 24, search } = req.query;

    let query = {};
    if (role) query.role = role;
    if (classId) query.classes = classId;

    // Search by fullName or username
    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), "i");
      query.$or = [
        { firstName: searchRegex },
        { lastName: searchRegex },
        { username: searchRegex },
      ];
    }

    // Convert to numbers
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const [total, users] = await Promise.all([
      User.countDocuments(query),
      User.find(query)
        .populate("classes", "name")
        .select("-password")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
    ]);

    // Calculate pagination info
    const totalPages = Math.ceil(total / limitNum);
    const hasNextPage = pageNum < totalPages;
    const hasPrevPage = pageNum > 1;

    res.json({
      success: true,
      data: users,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages,
        hasNextPage,
        hasPrevPage,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Create new user (Owner only)
const createUser = async (req, res) => {
  try {
    const {
      username,
      password,
      firstName,
      lastName,
      role,
      classes: userClasses,
    } = req.body;

    // Validation
    if (!username || !password || !firstName || !lastName || !role) {
      return res.status(400).json({
        success: false,
        message: "Barcha majburiy maydonlarni to'ldiring",
      });
    }

    // Role validation
    if (!["teacher", "student"].includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Faqat o'qituvchi yoki o'quvchi rolini yaratish mumkin",
      });
    }

    // Check classes for student
    if (role === "student" && userClasses && userClasses.length > 0) {
      for (const classId of userClasses) {
        const classExists = await Class.findById(classId);
        if (!classExists) {
          return res.status(400).json({
            success: false,
            message: `Sinf topilmadi: ${classId}`,
          });
        }
      }
    }

    // Create user
    const user = await User.create({
      username: username.toLowerCase(),
      password,
      firstName,
      lastName,
      role,
      classes: role === "student" ? userClasses : [],
    });

    const populatedUser = await User.findById(user._id)
      .populate("classes", "name")
      .select("-password");

    res.status(201).json({
      success: true,
      message: "Foydalanuvchi muvaffaqiyatli yaratildi",
      data: populatedUser,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Update user (Owner only)
const updateUser = async (req, res) => {
  try {
    const { firstName, lastName, classes: userClasses, isActive } = req.body;

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Foydalanuvchi topilmadi",
      });
    }

    // Owner cannot be modified
    if (user.role === "owner") {
      return res.status(403).json({
        success: false,
        message: "Egasi foydalanuvchisini o'zgartirish mumkin emas",
      });
    }

    // Update data
    if (firstName) user.firstName = firstName;
    if (lastName) user.lastName = lastName;
    if (isActive !== undefined) user.isActive = isActive;

    if (user.role === "student" && userClasses) {
      // Validate all classes
      for (const classId of userClasses) {
        const classExists = await Class.findById(classId);
        if (!classExists) {
          return res.status(400).json({
            success: false,
            message: `Sinf topilmadi: ${classId}`,
          });
        }
      }
      user.classes = userClasses;
    }

    await user.save();

    const updatedUser = await User.findById(user._id)
      .populate("classes", "name")
      .select("-password");

    res.json({
      success: true,
      message: "Foydalanuvchi muvaffaqiyatli yangilandi",
      data: updatedUser,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Reset user password (Owner only)
const resetPassword = async (req, res) => {
  try {
    const { newPassword } = req.body;

    if (!newPassword) {
      return res.status(400).json({
        success: false,
        message: "Yangi parol majburiy",
      });
    }

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Foydalanuvchi topilmadi",
      });
    }

    // Owner password cannot be reset by others
    if (user.role === "owner") {
      return res.status(403).json({
        success: false,
        message: "Egasi foydalanuvchisi parolini tiklash mumkin emas",
      });
    }

    user.password = newPassword;
    await user.save();

    res.json({
      success: true,
      message: "Parol muvaffaqiyatli tiklandi",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Get user password (Owner only)
const getUserPassword = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("+plainPassword");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Foydalanuvchi topilmadi",
      });
    }

    res.json({
      success: true,
      data: {
        password:
          user.plainPassword || "Hisob eski, parolni ko'rsatib bo'lmaydi",
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Delete user (Owner only)
const deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Foydalanuvchi topilmadi",
      });
    }

    // Owner cannot be deleted
    if (user.role === "owner") {
      return res.status(403).json({
        success: false,
        message: "Egasi foydalanuvchisini o'chirish mumkin emas",
      });
    }

    await user.deleteOne();

    res.json({
      success: true,
      message: "Foydalanuvchi muvaffaqiyatli o'chirildi",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Export users to Excel (Owner only)
const exportUsersToExcel = async (req, res) => {
  try {
    const { role } = req.query;

    // Build query
    let query = {};
    if (role === "teacher") {
      query.role = "teacher";
    } else if (role === "student") {
      query.role = "student";
    } else {
      query.role = { $in: ["teacher", "student"] };
    }

    // Fetch users with plainPassword
    const users = await User.find(query)
      .populate("classes", "name")
      .select("+plainPassword")
      .sort({ role: 1, firstName: 1 });

    // Prepare data
    const data = users.map((user) => ({
      fullName: `${user.firstName} ${user.lastName || ""}`.trim(),
      username: user.username,
      password: user.plainPassword || "N/A",
      role: user.role === "teacher" ? "O'qituvchi" : "O'quvchi",
      classes:
        user.classes && user.classes.length > 0
          ? user.classes.map((c) => c.name).join(", ")
          : "-",
    }));

    // Create Excel with service
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

    // Generate filename
    let baseName = "users";
    if (role === "teacher") baseName = "teachers";
    else if (role === "student") baseName = "students";
    const filename = ExcelService.generateFileName(baseName);

    // Send file
    await ExcelService.sendWorkbook(res, workbook, filename);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Get students list (Owner + Teacher)
const getStudents = async (req, res) => {
  try {
    const { search, limit = 500 } = req.query;

    const query = { role: "student" };

    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), "i");
      query.$or = [
        { firstName: searchRegex },
        { lastName: searchRegex },
        { username: searchRegex },
      ];
    }

    const students = await User.find(query)
      .select("firstName lastName username classes penaltyPoints")
      .populate("classes", "name")
      .sort({ firstName: 1 })
      .limit(parseInt(limit, 10));

    res.json({ success: true, data: students });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

module.exports = {
  getAllUsers,
  createUser,
  updateUser,
  resetPassword,
  getUserPassword,
  deleteUser,
  getStats,
  exportUsersToExcel,
  getStudents,
};

