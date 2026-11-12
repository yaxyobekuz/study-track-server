/**
 * O'QUVCHINING SHAXSIY MAVZU REJASI — kontroller (yupqa).
 *
 * ⚠️ RUXSAT MANTIG'I YO'Q BU YERDA: u route'da (`topics.view` /
 * `topics.assign`). Qoidalar esa `studentTopicPlan.service.js` da.
 */

const asyncHandler = require("../middleware/async.middleware");
const service = require("../services/studentTopicPlan.service");
const { ValidationError } = require("../utils/errors");
const { isValidId } = require("../utils/objectId");

/** Yo'lda emas, so'rov parametrida kelgan id — `validateObjectId` ushlamaydi. */
function requireId(value, label) {
  if (!value || !isValidId(value)) {
    throw new ValidationError(`Noto'g'ri ${label} ID formati`);
  }
  return value;
}

/**
 * GURUH + FAN → o'quvchilar va har birining mavzu o'rni.
 *
 * @route GET /api/student-topic-plans?classId=&subjectId=
 * @access `topics.view`
 */
const listClassStudentTopics = asyncHandler(async (req, res) => {
  const data = await service.listClassStudentTopics({
    classId: requireId(req.query.classId, "sinf"),
    subjectId: requireId(req.query.subjectId, "fan"),
    actorId: req.user.id,
  });
  res.json({ success: true, data });
});

/**
 * MAVZU O'RNI VA QADAMNI BELGILASH (bitta yoki bir nechta o'quvchiga).
 *
 * @route POST /api/student-topic-plans
 * @access `topics.assign`
 */
const setStudentTopicPlans = asyncHandler(async (req, res) => {
  const data = await service.setStudentTopicPlans({
    classId: requireId(req.body.classId, "sinf"),
    subjectId: requireId(req.body.subjectId, "fan"),
    studentIds: req.body.studentIds,
    topicOrder: req.body.topicOrder,
    step: req.body.step,
    startOrder: req.body.startOrder,
    note: req.body.note,
    actorId: req.user.id,
  });

  res.status(201).json({
    success: true,
    message:
      `${data.totals.written} o'quvchiga ${data.topic.order}-mavzu belgilandi ` +
      `(bitta darsda ${data.step} mavzu)` +
      (data.totals.skipped ? `, ${data.totals.skipped} tasi chetda qoldi` : ""),
    data,
  });
});

/**
 * SHAXSIY REJANI BEKOR QILISH — o'quvchi SINFDAN MEROS olishga qaytadi.
 *
 * @route DELETE /api/student-topic-plans/:id
 * @access `topics.assign`
 */
const revokeStudentTopicPlan = asyncHandler(async (req, res) => {
  const data = await service.revokeStudentTopicPlan({
    id: req.params.id,
    actorId: req.user.id,
  });
  res.json({ success: true, message: "Shaxsiy reja bekor qilindi", data });
});

/**
 * BITTA O'QUVCHINING REJA TARIXI.
 *
 * @route GET /api/student-topic-plans/history?studentId=&subjectId=
 * @access `topics.view`
 */
const listStudentTopicPlans = asyncHandler(async (req, res) => {
  const data = await service.listStudentTopicPlans({
    studentId: requireId(req.query.studentId, "o'quvchi"),
    subjectId: req.query.subjectId ? requireId(req.query.subjectId, "fan") : null,
    limit: req.query.limit,
  });
  res.json({ success: true, data });
});

module.exports = {
  listClassStudentTopics,
  setStudentTopicPlans,
  revokeStudentTopicPlan,
  listStudentTopicPlans,
};
