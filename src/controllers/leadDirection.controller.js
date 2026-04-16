const asyncHandler = require("../middleware/async.middleware");
const leadDirectionService = require("../services/leadDirection.service");

// Get all lead directions
const getAllDirections = asyncHandler(async (req, res) => {
  const directions = await leadDirectionService.getAllDirections(req.query);

  res.json({ success: true, data: directions });
});

// Create lead direction
const createDirection = asyncHandler(async (req, res) => {
  const direction = await leadDirectionService.createDirection(req.body);

  res.status(201).json({
    success: true,
    message: "Yo'nalish muvaffaqiyatli yaratildi",
    data: direction,
  });
});

// Update lead direction
const updateDirection = asyncHandler(async (req, res) => {
  const direction = await leadDirectionService.updateDirection(req.params.id, req.body);

  res.json({
    success: true,
    message: "Yo'nalish muvaffaqiyatli yangilandi",
    data: direction,
  });
});

// Delete lead direction
const deleteDirection = asyncHandler(async (req, res) => {
  await leadDirectionService.deleteDirection(req.params.id);

  res.json({
    success: true,
    message: "Yo'nalish muvaffaqiyatli o'chirildi",
  });
});

module.exports = {
  getAllDirections,
  createDirection,
  updateDirection,
  deleteDirection,
};
