const asyncHandler = require("../middleware/async.middleware");
const incomeCategoryService = require("../services/incomeCategory.service");

const getCategories = asyncHandler(async (req, res) => {
  const data = await incomeCategoryService.getCategories(req.query);
  res.json({ success: true, ...data });
});

const createCategory = asyncHandler(async (req, res) => {
  const data = await incomeCategoryService.createCategory(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const updateCategory = asyncHandler(async (req, res) => {
  const data = await incomeCategoryService.updateCategory(req.params.id, req.body);
  res.json({ success: true, data });
});

const archiveCategory = asyncHandler(async (req, res) => {
  const data = await incomeCategoryService.archiveCategory(
    req.params.id,
    req.body.isArchived,
  );
  res.json({ success: true, data, message: data.message });
});

module.exports = { getCategories, createCategory, updateCategory, archiveCategory };
