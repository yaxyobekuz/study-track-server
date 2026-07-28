const asyncHandler = require("../middleware/async.middleware");
const permissionService = require("../services/permission.service");

/**
 * Grant qilinadigan ruxsatlar katalogini olish.
 * @route GET /api/permissions/catalog
 * @access Owner only
 */
const getCatalog = asyncHandler(async (req, res) => {
  const catalog = permissionService.getCatalog();

  res.json({
    success: true,
    data: catalog,
  });
});

/**
 * Ruxsat berish mumkin bo'lgan xodimlarni ruxsatlari bilan olish.
 * @route GET /api/permissions/staff
 * @access Owner only
 */
const getStaff = asyncHandler(async (req, res) => {
  const staff = await permissionService.getStaff();

  res.json({
    success: true,
    data: staff,
  });
});

/**
 * Foydalanuvchining ruxsatlar to'plamini yangilash.
 * @route PUT /api/permissions/users/:id
 * @access Owner only
 */
const updateUserPermissions = asyncHandler(async (req, res) => {
  const user = await permissionService.setUserPermissions(
    req.params.id,
    req.body.permissions,
  );

  res.json({
    success: true,
    message: "Ruxsatlar muvaffaqiyatli yangilandi",
    data: user,
  });
});

module.exports = { getCatalog, getStaff, updateUserPermissions };
