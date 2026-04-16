const asyncHandler = require("../middleware/async.middleware");
const leadCategoryService = require("../services/leadCategory.service");

// Get all lead categories
const getAllCategories = asyncHandler(async (req, res) => {
  const categories = await leadCategoryService.getAllCategories(req.query);

  res.json({ success: true, data: categories });
});

// Create lead category
const createCategory = asyncHandler(async (req, res) => {
  const category = await leadCategoryService.createCategory(req.body);

  res.status(201).json({
    success: true,
    message: "Toifa muvaffaqiyatli yaratildi",
    data: category,
  });
});

// Update lead category
const updateCategory = asyncHandler(async (req, res) => {
  const category = await leadCategoryService.updateCategory(req.params.id, req.body);

  res.json({
    success: true,
    message: "Toifa muvaffaqiyatli yangilandi",
    data: category,
  });
});

// Delete lead category
const deleteCategory = asyncHandler(async (req, res) => {
  await leadCategoryService.deleteCategory(req.params.id);

  res.json({
    success: true,
    message: "Toifa muvaffaqiyatli o'chirildi",
  });
});

module.exports = {
  getAllCategories,
  createCategory,
  updateCategory,
  deleteCategory,
};
