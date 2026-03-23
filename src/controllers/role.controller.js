const asyncHandler = require("../middleware/async.middleware");
const roleService = require("../services/role.service");

/**
 * Get all roles with user counts.
 * @route GET /api/roles
 * @access Owner only
 */
const getAllRoles = asyncHandler(async (req, res) => {
  const roles = await roleService.getAllRoles();

  res.json({
    success: true,
    data: roles,
  });
});

/**
 * Get role options for select/dropdown (lightweight).
 * @route GET /api/roles/options
 * @access Owner only
 */
const getRoleOptions = asyncHandler(async (req, res) => {
  const roles = await roleService.getRoleOptions();

  res.json({
    success: true,
    data: roles,
  });
});

/**
 * Create a new dynamic role.
 * @route POST /api/roles
 * @access Owner only
 */
const createRole = asyncHandler(async (req, res) => {
  const role = await roleService.createRole(req.body, req.user._id);

  res.status(201).json({
    success: true,
    message: "Rol muvaffaqiyatli yaratildi",
    data: role,
  });
});

/**
 * Update an existing role.
 * @route PUT /api/roles/:id
 * @access Owner only
 */
const updateRole = asyncHandler(async (req, res) => {
  const role = await roleService.updateRole(req.params.id, req.body);

  res.json({
    success: true,
    message: "Rol muvaffaqiyatli yangilandi",
    data: role,
  });
});

/**
 * Delete a role.
 * @route DELETE /api/roles/:id
 * @access Owner only
 */
const deleteRole = asyncHandler(async (req, res) => {
  await roleService.deleteRole(req.params.id);

  res.json({
    success: true,
    message: "Rol muvaffaqiyatli o'chirildi",
  });
});

module.exports = {
  getAllRoles,
  getRoleOptions,
  createRole,
  updateRole,
  deleteRole,
};
