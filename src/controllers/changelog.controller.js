const asyncHandler = require("../middleware/async.middleware");
const changelogService = require("../services/changelog.service");

const getAll = asyncHandler(async (req, res) => {
  const result = await changelogService.getChangelogs(req);
  res.json(result);
});

// Har bir panelning joriy versiyasi — sahifa sarlavhasi uchun
const getVersions = asyncHandler(async (req, res) => {
  const versions = await changelogService.getPanelVersions();
  res.json({ success: true, data: versions });
});

// Yozuv bo'lgan oylar — "Barchasi" tabidagi oy tanlash uchun
const getMonths = asyncHandler(async (req, res) => {
  const months = await changelogService.getAvailableMonths();
  res.json({ success: true, data: months });
});

const getOne = asyncHandler(async (req, res) => {
  const entry = await changelogService.getChangelogById(req.params.id);
  res.json({ success: true, data: entry });
});

const create = asyncHandler(async (req, res) => {
  const entry = await changelogService.createChangelog(req.body, req.user.id);
  res.status(201).json({ success: true, data: entry });
});

const update = asyncHandler(async (req, res) => {
  const entry = await changelogService.updateChangelog(req.params.id, req.body);
  res.json({ success: true, data: entry });
});

const remove = asyncHandler(async (req, res) => {
  await changelogService.deleteChangelog(req.params.id);
  res.json({ success: true });
});

module.exports = {
  getAll,
  getVersions,
  getMonths,
  getOne,
  create,
  update,
  remove,
};
