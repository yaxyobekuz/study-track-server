const asyncHandler = require("../middleware/async.middleware");
const expenseCategoryService = require("../services/expenseCategory.service");

const getCategories = asyncHandler(async (req, res) => {
  const data = await expenseCategoryService.getCategories(req.query);
  res.json({ success: true, ...data });
});

const createCategory = asyncHandler(async (req, res) => {
  const data = await expenseCategoryService.createCategory(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const updateCategory = asyncHandler(async (req, res) => {
  const data = await expenseCategoryService.updateCategory(req.params.id, req.body);
  res.json({ success: true, data });
});

const archiveCategory = asyncHandler(async (req, res) => {
  const data = await expenseCategoryService.archiveCategory(
    req.params.id,
    req.body.isArchived,
  );
  res.json({ success: true, data, message: data.message });
});

module.exports = { getCategories, createCategory, updateCategory, archiveCategory };
