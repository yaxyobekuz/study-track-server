const asyncHandler = require("../middleware/async.middleware");
const topicService = require("../services/topic.service");
const topicExportService = require("../services/topicExport.service");
const {
  TEACHING_LANGUAGES,
  TEACHING_LANGUAGE_LABELS,
  TEACHING_LANGUAGE_CLASS_LABELS,
} = require("../helpers/teachingLanguage.helpers");

/**
 * Upload Excel file with topics
 * @route POST /api/topics/upload
 * @access Owner only
 */
const uploadTopics = asyncHandler(async (req, res) => {
  const singleSubjectId = req.body.subjectId || req.query.subjectId;
  // ⚠️ TIL — `multipart/form-data` da ham matn maydoni: oyna uni fayl bilan
  // birga yuboradi (`language`). Berilmasa `uz` (eski mijozlar uchun).
  const language = req.body.language || req.query.language;
  const result = await topicService.uploadTopics(singleSubjectId, req.file, req.user.id, {
    language,
  });

  res.json({
    success: true,
    message:
      `Muvaffaqiyatli yuklandi (${result.languageLabel}): ` +
      `${result.processedSubjects} ta fan, ${result.totalTopics} ta mavzu`,
    data: result,
  });
});

/**
 * Get all topics for a subject
 * @route GET /api/topics/subject/:id
 * @access Protected
 */
const getTopicsBySubject = asyncHandler(async (req, res) => {
  const topics = await topicService.getTopicsBySubject(req.params.id, {
    language: req.query.language,
  });

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
  await topicExportService.exportTopics(res, req.query.subjectId || null, req.query.language);
});

/**
 * Fanlar bo'yicha mavzu holati: qaysi fanga yuklangan, qaysiga yo'q.
 *
 * @route GET /api/topics/subjects
 * @access `topics.view`
 */
const getSubjectTopicStatus = asyncHandler(async (req, res) => {
  const data = await topicService.getSubjectTopicStatus({
    language: req.query.language || null,
  });

  res.json({ success: true, data });
});

/**
 * O'QUV TILLARI KATALOGI — tanlagichlar uchun.
 *
 * ⚠️ RO'YXAT SERVERDAN: panel yorliqlarini o'zi yozib qo'ysa, server va
 * panel ikki xil nom ko'rsatib qolardi (`GET /leads/stages` bilan AYNI
 * mulohaza — paneldagi nusxa faqat ZAXIRA).
 *
 * @route GET /api/topics/languages
 * @access `topics.view`
 */
const getTeachingLanguages = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: TEACHING_LANGUAGES.map((key) => ({
      language: key,
      label: TEACHING_LANGUAGE_LABELS[key],
      classLabel: TEACHING_LANGUAGE_CLASS_LABELS[key],
    })),
  });
});

/**
 * Delete all topics for a subject
 * @route DELETE /api/topics/subject/:id
 * @access Owner only
 */
const deleteTopicsBySubject = asyncHandler(async (req, res) => {
  const result = await topicService.deleteTopicsBySubject(req.params.id, {
    language: req.query.language,
  });

  res.json({
    success: true,
    message: `${result.deletedCount} ta mavzu o'chirildi (${result.languageLabel})`,
    data: result,
  });
});

module.exports = {
  uploadTopics,
  getTopicsBySubject,
  getSubjectTopicStatus,
  getTeachingLanguages,
  exportTopics,
  deleteTopicsBySubject,
};
