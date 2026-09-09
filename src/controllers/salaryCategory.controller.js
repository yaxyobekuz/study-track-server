const asyncHandler = require("../middleware/async.middleware");
const service = require("../services/salaryCategory.service");

const getCategories = asyncHandler(async (req, res) => {
  const data = await service.getCategories(req.query);
  res.json({ success: true, data });
});

const getActiveCategories = asyncHandler(async (req, res) => {
  const data = await service.getActiveCategories();
  res.json({ success: true, data });
});

const createCategory = asyncHandler(async (req, res) => {
  const data = await service.createCategory(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const updateCategory = asyncHandler(async (req, res) => {
  const data = await service.updateCategory(req.params.id, req.body);
  res.json({ success: true, data });
});

const archiveCategory = asyncHandler(async (req, res) => {
  const data = await service.archiveCategory(req.params.id, req.body.isArchived);
  res.json({ success: true, data });
});

const deleteCategory = asyncHandler(async (req, res) => {
  const data = await service.deleteCategory(req.params.id);
  res.json({ success: true, ...data });
});

module.exports = {
  getCategories,
  getActiveCategories,
  createCategory,
  updateCategory,
  archiveCategory,
  deleteCategory,
};
