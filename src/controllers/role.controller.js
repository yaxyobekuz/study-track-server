const Role = require("../models/role.model");
const User = require("../models/user.model");

/**
 * Get all roles with user counts.
 * @route GET /api/roles
 * @access Owner only
 */
const getAllRoles = async (req, res) => {
  try {
    const roles = await Role.find()
      .populate("createdBy", "firstName lastName")
      .sort({ isSystem: -1, createdAt: 1 })
      .lean();

    // Get user counts for each role
    const rolesWithCounts = await Promise.all(
      roles.map(async (role) => {
        const usersCount = await User.countDocuments({ role: role.value });
        return { ...role, usersCount };
      })
    );

    res.json({
      success: true,
      count: rolesWithCounts.length,
      data: rolesWithCounts,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

/**
 * Get role options for select/dropdown (lightweight).
 * @route GET /api/roles/options
 * @access Owner only
 */
const getRoleOptions = async (req, res) => {
  try {
    const roles = await Role.find()
      .select("name value isSystem")
      .sort({ isSystem: -1, name: 1 })
      .lean();

    res.json({
      success: true,
      data: roles,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

/**
 * Create a new dynamic role.
 * @route POST /api/roles
 * @access Owner only
 */
const createRole = async (req, res) => {
  try {
    const { name, value } = req.body;

    if (!name || !value) {
      return res.status(400).json({
        success: false,
        message: "Rol nomi va qiymati majburiy",
      });
    }

    const role = await Role.create({
      name,
      value,
      createdBy: req.user._id,
    });

    res.status(201).json({
      success: true,
      message: "Rol muvaffaqiyatli yaratildi",
      data: role,
    });
  } catch (error) {
    // Handle duplicate key error
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      const message =
        field === "value"
          ? "Bu rol qiymati allaqachon mavjud"
          : "Bu rol nomi allaqachon mavjud";
      return res.status(400).json({ success: false, message });
    }

    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

/**
 * Update an existing role.
 * System roles cannot be updated.
 * Role value cannot be changed if users exist with that role.
 * @route PUT /api/roles/:id
 * @access Owner only
 */
const updateRole = async (req, res) => {
  try {
    const { name, value } = req.body;

    const role = await Role.findById(req.params.id);

    if (!role) {
      return res.status(404).json({
        success: false,
        message: "Rol topilmadi",
      });
    }

    // System roles cannot be updated
    if (role.isSystem) {
      return res.status(400).json({
        success: false,
        message: "Tizim rollarini o'zgartirib bo'lmaydi",
      });
    }

    // Check if value is being changed and users exist
    if (value && value !== role.value) {
      const usersCount = await User.countDocuments({ role: role.value });
      if (usersCount > 0) {
        return res.status(400).json({
          success: false,
          message:
            "Bu rol qiymatini o'zgartirib bo'lmaydi, chunki foydalanuvchilar mavjud",
        });
      }
      role.value = value;
    }

    if (name) role.name = name;

    await role.save();

    res.json({
      success: true,
      message: "Rol muvaffaqiyatli yangilandi",
      data: role,
    });
  } catch (error) {
    // Handle duplicate key error
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      const message =
        field === "value"
          ? "Bu rol qiymati allaqachon mavjud"
          : "Bu rol nomi allaqachon mavjud";
      return res.status(400).json({ success: false, message });
    }

    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

/**
 * Delete a role.
 * System roles cannot be deleted.
 * Roles with existing users cannot be deleted.
 * @route DELETE /api/roles/:id
 * @access Owner only
 */
const deleteRole = async (req, res) => {
  try {
    const role = await Role.findById(req.params.id);

    if (!role) {
      return res.status(404).json({
        success: false,
        message: "Rol topilmadi",
      });
    }

    // System roles cannot be deleted
    if (role.isSystem) {
      return res.status(400).json({
        success: false,
        message: "Tizim rollarini o'chirib bo'lmaydi",
      });
    }

    // Check if users exist with this role
    const usersCount = await User.countDocuments({ role: role.value });
    if (usersCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Bu rolni o'chirib bo'lmaydi, chunki ${usersCount} ta foydalanuvchi mavjud`,
      });
    }

    await role.deleteOne();

    res.json({
      success: true,
      message: "Rol muvaffaqiyatli o'chirildi",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

module.exports = {
  getAllRoles,
  getRoleOptions,
  createRole,
  updateRole,
  deleteRole,
};
