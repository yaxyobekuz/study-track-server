const scheduleSyncService = require("../services/scheduleSheetSync.service");
const asyncHandler = require("../middleware/async.middleware");

/**
 * GET /api/schedule-sync/mode
 * Jadval manbai (platform | sheet) — tahrir sahifalari uchun.
 * @access Private (schedules.view, scheduleSync.*, teacher)
 */
exports.getMode = asyncHandler(async (req, res) => {
  const data = await scheduleSyncService.getMode();
  return res.json({ success: true, data });
});

/**
 * GET /api/schedule-sync/status
 * @access Private (scheduleSync.*)
 */
exports.getStatus = asyncHandler(async (req, res) => {
  const data = await scheduleSyncService.getStatus(req.user);
  return res.json({ success: true, data });
});

/**
 * PUT /api/schedule-sync/config
 * @access Private (scheduleSync.source)
 */
exports.updateConfig = asyncHandler(async (req, res) => {
  const data = await scheduleSyncService.updateConfig(req.body, req.user);
  return res.json({ success: true, message: "Google Sheets sozlandi", data });
});

/**
 * POST /api/schedule-sync/inspect
 * @access Private (scheduleSync.source)
 */
exports.inspectSheet = asyncHandler(async (req, res) => {
  const data = await scheduleSyncService.inspectSheet(req.body);
  return res.json({ success: true, data });
});

/**
 * POST /api/schedule-sync/check
 * @access Private (scheduleSync.review | scheduleSync.source)
 */
exports.checkSheet = asyncHandler(async (req, res) => {
  const data = await scheduleSyncService.checkSheet({ actorId: req.user.id });
  return res.json({
    success: true,
    message: data.created ? "Sheet'da yangi o'zgarish topildi" : "Sheet'da yangi o'zgarish yo'q",
    data,
  });
});

/**
 * GET /api/schedule-sync/revisions
 * @access Private (scheduleSync.*)
 */
exports.listRevisions = asyncHandler(async (req, res) => {
  const result = await scheduleSyncService.listRevisions(req);
  return res.json(result);
});

/**
 * GET /api/schedule-sync/revisions/:id
 * @access Private (scheduleSync.*)
 */
exports.getRevision = asyncHandler(async (req, res) => {
  const data = await scheduleSyncService.getRevisionReview(req.params.id, req.user);
  return res.json({ success: true, data });
});

/**
 * POST /api/schedule-sync/revisions/:id/apply
 * @access Private (scheduleSync.review)
 */
exports.applyRevision = asyncHandler(async (req, res) => {
  const data = await scheduleSyncService.applyRevision(req.params.id, req.body, req.user);
  return res.json({ success: true, message: "Sheet'dagi o'zgarish qo'llandi", data });
});

/**
 * POST /api/schedule-sync/revisions/:id/reject
 * @access Private (scheduleSync.review)
 */
exports.rejectRevision = asyncHandler(async (req, res) => {
  const data = await scheduleSyncService.rejectRevision(req.params.id, req.body, req.user);
  return res.json({ success: true, message: "O'zgarish rad etildi", data });
});

/**
 * GET /api/schedule-sync/mappings
 * @access Private (scheduleSync.*)
 */
exports.getMappings = asyncHandler(async (req, res) => {
  const data = await scheduleSyncService.getMappings();
  return res.json({ success: true, data });
});

/**
 * PUT /api/schedule-sync/mappings
 * @access Private (scheduleSync.review | scheduleSync.source)
 */
exports.saveMappings = asyncHandler(async (req, res) => {
  const data = await scheduleSyncService.saveMappings(req.body, req.user);
  return res.json({ success: true, message: "Moslash saqlandi", data });
});

/**
 * POST /api/schedule-sync/switch
 * @access Private (scheduleSync.source)
 */
exports.switchSource = asyncHandler(async (req, res) => {
  const data = await scheduleSyncService.switchSource(req.body, req.user);
  return res.json({
    success: true,
    message:
      data.mode === "sheet"
        ? "Jadval endi Google Sheets orqali boshqariladi"
        : "Jadval endi platformada boshqariladi",
    data,
  });
});

/**
 * GET /api/schedule-sync/snapshots
 * @access Private (scheduleSync.*)
 */
exports.listSnapshots = asyncHandler(async (req, res) => {
  const result = await scheduleSyncService.listSnapshots(req);
  return res.json(result);
});

/**
 * GET /api/schedule-sync/snapshots/:id
 * @access Private (scheduleSync.*)
 */
exports.getSnapshot = asyncHandler(async (req, res) => {
  const data = await scheduleSyncService.getSnapshotReview(req.params.id, req.user);
  return res.json({ success: true, data });
});

/**
 * POST /api/schedule-sync/snapshots/:id/restore
 * @access Private (scheduleSync.source)
 */
exports.restoreSnapshot = asyncHandler(async (req, res) => {
  const data = await scheduleSyncService.restoreSnapshot(req.params.id, req.body, req.user);
  return res.json({ success: true, message: "Arxiv versiya tiklandi", data });
});
