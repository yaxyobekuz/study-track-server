const asyncHandler = require("../middleware/async.middleware");
const topicService = require("../services/topic.service");
const topicExportService = require("../services/topicExport.service");

/**
 * Upload Excel file with topics
 * @route POST /api/topics/upload
 * @access Owner only
 */
const uploadTopics = asyncHandler(async (req, res) => {
  const singleSubjectId = req.body.subjectId || req.query.subjectId;
  const result = await topicService.uploadTopics(singleSubjectId, req.file, req.user.id);

  res.json({
    success: true,
    message: `Muvaffaqiyatli yuklandi: ${result.processedSubjects} ta fan, ${result.totalTopics} ta mavzu`,
    data: result,
  });
});

/**
 * Get all topics for a subject
 * @route GET /api/topics/subject/:id
 * @access Protected
 */
const getTopicsBySubject = asyncHandler(async (req, res) => {
  const topics = await topicService.getTopicsBySubject(req.params.id);

  res.json({
    success: true,
    data: topics,
  });
});

/**
 * Mavzular rejasini Excel'ga yuklab olish.
 *
 * ⚠️ Fayl — QAYTA YUKLASH SHABLONI: `subjectId` berilsa bitta fan, aks
 * holda mavzusi bor hamma fan (har biri alohida varaqda). Import bilan
 * AYNI ikki rejim.
 *
 * @route GET /api/topics/export
 * @access `topics.view`
 */
const exportTopics = asyncHandler(async (req, res) => {
  await topicExportService.exportTopics(res, req.query.subjectId || null);
});

/**
 * Delete all topics for a subject
 * @route DELETE /api/topics/subject/:id
 * @access Owner only
 */
const deleteTopicsBySubject = asyncHandler(async (req, res) => {
  const result = await topicService.deleteTopicsBySubject(req.params.id);

  res.json({
    success: true,
    message: `${result.deletedCount} ta mavzu o'chirildi`,
    data: result,
  });
});

module.exports = {
  uploadTopics,
  getTopicsBySubject,
  exportTopics,
  deleteTopicsBySubject,
};
