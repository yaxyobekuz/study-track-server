const asyncHandler = require("../middleware/async.middleware");
const leadSourceService = require("../services/leadSource.service");

// Get all lead sources
const getAllSources = asyncHandler(async (req, res) => {
  const sources = await leadSourceService.getAllSources(req.query);

  res.json({ success: true, data: sources });
});

// Create lead source
const createSource = asyncHandler(async (req, res) => {
  const source = await leadSourceService.createSource(req.body);

  res.status(201).json({
    success: true,
    message: "Manba muvaffaqiyatli yaratildi",
    data: source,
  });
});

// Update lead source
const updateSource = asyncHandler(async (req, res) => {
  const source = await leadSourceService.updateSource(req.params.id, req.body);

  res.json({
    success: true,
    message: "Manba muvaffaqiyatli yangilandi",
    data: source,
  });
});

// Delete lead source
const deleteSource = asyncHandler(async (req, res) => {
  await leadSourceService.deleteSource(req.params.id);

  res.json({
    success: true,
    message: "Manba muvaffaqiyatli o'chirildi",
  });
});

module.exports = {
  getAllSources,
  createSource,
  updateSource,
  deleteSource,
};
