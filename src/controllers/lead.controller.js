const asyncHandler = require("../middleware/async.middleware");
const leadService = require("../services/lead.service");
const leadActivityService = require("../services/leadActivity.service");

// Get all leads (paginated, filtered)
const getAllLeads = asyncHandler(async (req, res) => {
  const { leads, pagination } = await leadService.getAllLeads(req.query);

  res.json({ success: true, data: leads, pagination });
});

// Get lead by ID
const getLeadById = asyncHandler(async (req, res) => {
  const data = await leadService.getLeadById(req.params.id);

  res.json({ success: true, data });
});

// Create new lead
const createLead = asyncHandler(async (req, res) => {
  const lead = await leadService.createLead(req.body, req.user._id);

  res.status(201).json({
    success: true,
    message: "Lead muvaffaqiyatli yaratildi",
    data: lead,
  });
});

// Update lead
const updateLead = asyncHandler(async (req, res) => {
  const lead = await leadService.updateLead(req.params.id, req.body);

  res.json({
    success: true,
    message: "Lead muvaffaqiyatli yangilandi",
    data: lead,
  });
});

// Update lead status
const updateLeadStatus = asyncHandler(async (req, res) => {
  const { status, description, lostReason } = req.body;
  const lead = await leadService.updateLeadStatus(
    req.params.id,
    status,
    description,
    lostReason,
    req.user._id,
  );

  res.json({
    success: true,
    message: "Lead statusi muvaffaqiyatli yangilandi",
    data: lead,
  });
});

// Delete lead
const deleteLead = asyncHandler(async (req, res) => {
  await leadService.deleteLead(req.params.id);

  res.json({
    success: true,
    message: "Lead muvaffaqiyatli o'chirildi",
  });
});

// Get lead activities
const getLeadActivities = asyncHandler(async (req, res) => {
  const { activities, pagination } = await leadActivityService.getActivitiesByLead(
    req.params.id,
    req.query,
  );

  res.json({ success: true, data: activities, pagination });
});

// Create lead activity
const createLeadActivity = asyncHandler(async (req, res) => {
  const activity = await leadActivityService.createActivity(
    req.params.id,
    req.body,
    req.user._id,
  );

  res.status(201).json({
    success: true,
    message: "Harakat muvaffaqiyatli qo'shildi",
    data: activity,
  });
});

// Get analytics overview
const getAnalyticsOverview = asyncHandler(async (req, res) => {
  const data = await leadService.getAnalyticsOverview(req.query);

  res.json({ success: true, data });
});

// Get source analytics
const getSourceAnalytics = asyncHandler(async (req, res) => {
  const data = await leadService.getSourceAnalytics(req.query);

  res.json({ success: true, data });
});

// Get conversion funnel
const getConversionFunnel = asyncHandler(async (req, res) => {
  const data = await leadService.getConversionFunnel(req.query);

  res.json({ success: true, data });
});

// Get trend analytics
const getTrendAnalytics = asyncHandler(async (req, res) => {
  const data = await leadService.getTrendAnalytics(req.query);

  res.json({ success: true, data });
});

module.exports = {
  getAllLeads,
  getLeadById,
  createLead,
  updateLead,
  updateLeadStatus,
  deleteLead,
  getLeadActivities,
  createLeadActivity,
  getAnalyticsOverview,
  getSourceAnalytics,
  getConversionFunnel,
  getTrendAnalytics,
};
