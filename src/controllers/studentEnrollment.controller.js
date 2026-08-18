const asyncHandler = require("../middleware/async.middleware");
const enrollmentService = require("../services/studentEnrollment.service");
const invoiceGenerationService = require("../services/invoiceGeneration.service");
const { PERMISSIONS, hasPermission } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");
const { ForbiddenError } = require("../utils/errors");
const { currentMonthKey, monthKeyOfDate, parseDayDate } = require("../helpers/month.helpers");

const canAdjust = (req) =>
  req.user.role === ROLES.OWNER ||
  hasPermission(req.user.permissions, PERMISSIONS.FINANCE_ADJUST);

/**
 * O'tgan sanadan davr ochish narx kutilmasini orqaga qarab o'zgartiradi —
 * `finance.adjust` talab qilinadi (`studentFinanceStatus` dagi bir xil naqsh).
 */
const assertPastAllowed = (req, startDate) => {
  if (startDate == null || startDate === "") return false;
  if (monthKeyOfDate(parseDayDate(startDate, "Boshlanish sanasi")) >= currentMonthKey()) {
    return false;
  }
  if (!canAdjust(req)) {
    throw new ForbiddenError(
      "O'tgan oydan boshlanadigan o'qish davri qo'shish uchun ruxsatingiz yo'q",
    );
  }
  return true;
};

/**
 * Davr ochilgach o'sha oy uchun hisob-fakturani DARHOL shakllantiradi.
 *
 * Aks holda oy o'rtasida kelgan o'quvchi faqat `catchUpMonths >= 1`
 * tufayli, keyingi oy passida tasodifan hisobga olinardi — sozlamada 0
 * qo'yilsa esa umuman hisob yozilmasdi. Idempotent
 * (`@@unique([studentId, month])` + `skipDuplicates`), shuning uchun
 * takroriy chaqiruv zararsiz.
 */
const generateForNewPeriod = async (req, enrollment) => {
  if (!enrollment?.startDate) return null;

  const month = monthKeyOfDate(parseDayDate(enrollment.startDate));
  if (month > currentMonthKey()) return null;

  try {
    return await invoiceGenerationService.generateForMonth(month, {
      actorId: req.user.id,
      source: "manual",
      studentIds: [enrollment.studentId],
    });
  } catch {
    // Hisob-faktura shakllanmasligi davr ochilishini bekor qilmaydi —
    // admin ogohlantirishlarda ko'radi va qo'lda shakllantira oladi
    return null;
  }
};

const getEnrollments = asyncHandler(async (req, res) => {
  const result = await enrollmentService.getEnrollments(req);
  res.json(result);
});

const getStudentEnrollments = asyncHandler(async (req, res) => {
  const data = await enrollmentService.getStudentEnrollments(req.params.studentId);
  res.json({ success: true, data });
});

const getEnrollment = asyncHandler(async (req, res) => {
  const data = await enrollmentService.getEnrollmentById(req.params.id);
  res.json({ success: true, data });
});

const createEnrollment = asyncHandler(async (req, res) => {
  const allowPast = assertPastAllowed(req, req.body.startDate);

  const data = await enrollmentService.createEnrollment(req.body, req.user.id, {
    allowPast,
  });

  const generated = await generateForNewPeriod(req, data);

  res.status(201).json({ success: true, data: { ...data, generated } });
});

const updateEnrollment = asyncHandler(async (req, res) => {
  const allowPast =
    req.body.startDate !== undefined
      ? assertPastAllowed(req, req.body.startDate)
      : canAdjust(req);

  const data = await enrollmentService.updateEnrollment(req.params.id, req.body, {
    allowPast,
  });

  res.json({ success: true, data });
});

const closeEnrollment = asyncHandler(async (req, res) => {
  const data = await enrollmentService.closeEnrollment(req.params.id, req.body, {
    allowPast: canAdjust(req),
  });
  res.json({ success: true, data });
});

const deleteEnrollment = asyncHandler(async (req, res) => {
  const result = await enrollmentService.deleteEnrollment(req.params.id);
  res.json({ success: true, ...result });
});

module.exports = {
  getEnrollments,
  getStudentEnrollments,
  getEnrollment,
  createEnrollment,
  updateEnrollment,
  closeEnrollment,
  deleteEnrollment,
};
