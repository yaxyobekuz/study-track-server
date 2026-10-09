const asyncHandler = require("../middleware/async.middleware");
const issueService = require("../services/issue.service");
const issueReportService = require("../services/issueReport.service");

// ─────────────────────────────────────────────
// KATEGORIYALAR
// ─────────────────────────────────────────────

const createCategory = asyncHandler(async (req, res) => {
  const category = await issueService.createCategory(req.body, req.user.id);
  res.status(201).json({ success: true, data: category });
});

const getCategories = asyncHandler(async (req, res) => {
  const categories = await issueService.getCategories();
  res.json({ success: true, data: categories });
});

const getActiveCategories = asyncHandler(async (req, res) => {
  const categories = await issueService.getActiveCategories();
  res.json({ success: true, data: categories });
});

const updateCategory = asyncHandler(async (req, res) => {
  const category = await issueService.updateCategory(req.params.id, req.body);
  res.json({ success: true, data: category });
});

const deleteCategory = asyncHandler(async (req, res) => {
  const result = await issueService.deleteCategory(req.params.id);
  res.json({ success: true, data: result });
});

// ─────────────────────────────────────────────
// MUAMMOLAR
// ─────────────────────────────────────────────

const getAll = asyncHandler(async (req, res) => {
  const result = await issueService.getIssues(req);
  res.json(result);
});

const getCounts = asyncHandler(async (req, res) => {
  const counts = await issueService.getStatusCounts();
  res.json({ success: true, data: counts });
});

const getOne = asyncHandler(async (req, res) => {
  const issue = await issueService.getIssueById(req.params.id);
  res.json({ success: true, data: issue });
});

const review = asyncHandler(async (req, res) => {
  const issue = await issueService.reviewIssue(
    req.params.id,
    req.body,
    req.user.id,
  );
  res.json({ success: true, data: issue });
});

const remove = asyncHandler(async (req, res) => {
  await issueService.deleteIssue(req.params.id);
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// HISOBOT
// ─────────────────────────────────────────────

const getReport = asyncHandler(async (req, res) => {
  const report = await issueReportService.getIssueReport(req.query);
  res.json({ success: true, data: report });
});

module.exports = {
  createCategory,
  getCategories,
  getActiveCategories,
  updateCategory,
  deleteCategory,
  getAll,
  getCounts,
  getOne,
  review,
  remove,
  getReport,
};
