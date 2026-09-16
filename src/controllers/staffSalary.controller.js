const asyncHandler = require("../middleware/async.middleware");
const staffSalaryService = require("../services/staffSalary.service");
const staffContractService = require("../services/staffContract.service");
const { ROLES } = require("../utils/constants");
const { ForbiddenError } = require("../utils/errors");

const getSalaries = asyncHandler(async (req, res) => {
  const data = await staffSalaryService.getSalaries(req);
  res.json({ success: true, ...data });
});

const getStaffHistory = asyncHandler(async (req, res) => {
  const data = await staffSalaryService.getStaffHistory(req.params.staffId);
  res.json({ success: true, data });
});

// O'ZIMNING oylik qoidam — xodim panelidagi profil sahifasi.
//
// `payroll.view` talab qilinmaydi: u butun shtatning oyligini ochadi, bu
// yerda esa faqat tokendagi odamning o'zi. O'quvchi rad etiladi — unga
// oylik biriktirilmaydi, so'rovning o'zi ma'nosiz.
const getMySalary = asyncHandler(async (req, res) => {
  if (req.user.role === ROLES.STUDENT) {
    throw new ForbiddenError("Oylik faqat xodimlar uchun");
  }

  const data = await staffSalaryService.getStaffHistory(req.user.id);
  res.json({ success: true, data });
});

/** Xodimning berilgan oydagi dars soati — forma KPI preview'i uchun. */
const getLessonHours = asyncHandler(async (req, res) => {
  const data = await staffSalaryService.getLessonHoursPreview(
    req.params.staffId,
    req.query.month,
  );
  res.json({ success: true, data });
});

const createSalary = asyncHandler(async (req, res) => {
  const data = await staffSalaryService.createSalary(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const updateSalary = asyncHandler(async (req, res) => {
  const data = await staffSalaryService.updateSalary(req.params.id, req.body);
  res.json({ success: true, data });
});

const closeSalary = asyncHandler(async (req, res) => {
  const data = await staffSalaryService.closeSalary(req.params.id, req.body.endMonth);
  res.json({ success: true, data });
});

const deleteSalary = asyncHandler(async (req, res) => {
  const data = await staffSalaryService.deleteSalary(req.params.id);
  res.json({ success: true, ...data });
});

/**
 * SHARTNOMA SHARTI — vedomostdagi oynadan qoida va toifani bir yo'la
 * o'qish / jonli hisoblash / saqlash (`staffContract.service.js`).
 */
const getContract = asyncHandler(async (req, res) => {
  const data = await staffContractService.getContract(req.params.staffId, req.query.month);
  res.json({ success: true, data });
});

const previewContract = asyncHandler(async (req, res) => {
  const data = await staffContractService.previewContract(req.params.staffId, req.body);
  res.json({ success: true, data });
});

const saveContract = asyncHandler(async (req, res) => {
  const data = await staffContractService.saveContract(
    req.params.staffId,
    req.body,
    req.user.id,
  );
  res.json({ success: true, data });
});

module.exports = {
  getSalaries,
  getStaffHistory,
  getMySalary,
  getLessonHours,
  createSalary,
  updateSalary,
  closeSalary,
  deleteSalary,
  getContract,
  previewContract,
  saveContract,
};
