const asyncHandler = require("../middleware/async.middleware");
const { BadRequestError } = require("../utils/errors");
const scheduleService = require("../services/taskSchedule.service");

/**
 * multipart/form-data'da massivlar JSON satri bo'lib keladi.
 * @param {unknown} value
 * @param {string} label
 */
const parseList = (value, label) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("not array");
    return parsed;
  } catch {
    throw new BadRequestError(`${label} formati noto'g'ri`);
  }
};

/** So'rov tanasini servis kutgan shaklga keltiradi (yaratish ham, tahrir ham). */
const buildPayload = (req) => ({
  ...req.body,
  assigneeIds: parseList(req.body.assigneeIds, "Ijrochilar"),
  weekdays: parseList(req.body.weekdays, "Hafta kunlari"),
  monthDays: parseList(req.body.monthDays, "Oy kunlari"),
  links: req.body.links,
  files: req.files || [],
});

/**
 * Doimiy topshiriq qoidasini yaratadi
 * POST /task-schedules
 */
const createSchedule = asyncHandler(async (req, res) => {
  const data = await scheduleService.createSchedule(
    buildPayload(req),
    req.user.id,
    req.taskScope,
  );
  return res.status(201).json({
    success: true,
    data,
    message: data.generatedCount
      ? `Doimiy topshiriq yaratildi · ${data.generatedCount} ta topshiriq darhol yozildi`
      : "Doimiy topshiriq yaratildi",
  });
});

/**
 * Qoidalar ro'yxati
 * GET /task-schedules
 */
const getSchedules = asyncHandler(async (req, res) => {
  const result = await scheduleService.listSchedules(req, req.taskScope);
  return res.json(result);
});

/**
 * Qoidani tahrirlash
 * PUT /task-schedules/:id
 */
const updateSchedule = asyncHandler(async (req, res) => {
  const data = await scheduleService.updateSchedule(
    req.params.id,
    buildPayload(req),
    req.user.id,
    req.taskScope,
  );
  return res.json({ success: true, data, message: "Doimiy topshiriq yangilandi" });
});

/**
 * Qoidani to'xtatish (sabab majburiy)
 * PUT /task-schedules/:id/stop
 */
const stopSchedule = asyncHandler(async (req, res) => {
  const data = await scheduleService.stopSchedule(
    req.params.id,
    { reason: req.body.reason, userId: req.user.id },
    req.taskScope,
  );
  return res.json({ success: true, data, message: "Doimiy topshiriq to'xtatildi" });
});

/**
 * To'xtatilgan qoidani qayta yoqish
 * PUT /task-schedules/:id/resume
 */
const resumeSchedule = asyncHandler(async (req, res) => {
  const data = await scheduleService.resumeSchedule(
    req.params.id,
    req.user.id,
    req.taskScope,
  );
  return res.json({ success: true, data, message: "Doimiy topshiriq qayta yoqildi" });
});

/**
 * Qoidani o'chirish (faqat hali topshiriq yaratilmagan bo'lsa)
 * DELETE /task-schedules/:id
 */
const deleteSchedule = asyncHandler(async (req, res) => {
  const data = await scheduleService.deleteSchedule(
    req.params.id,
    req.user.id,
    req.taskScope,
  );
  return res.json({ success: true, data, message: "Doimiy topshiriq o'chirildi" });
});

module.exports = {
  createSchedule,
  getSchedules,
  updateSchedule,
  stopSchedule,
  resumeSchedule,
  deleteSchedule,
};
