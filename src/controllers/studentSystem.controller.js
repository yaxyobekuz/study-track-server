const studentSystemService = require("../services/studentSystem.service");
const studentSystemExport = require("../services/studentSystemExport.service");
const systemsReport = require("../services/studentSystemReport.service");
const systemsNetwork = require("../services/studentSystemNetwork.service");
const systemsReportExport = require("../services/studentSystemReportExport.service");
const { formatPaginationResponse } = require("../utils/pagination");
const asyncHandler = require("../middleware/async.middleware");

// O'quvchilar ro'yxati — ERP va Kundalik.com belgilari, sinf kesimidagi sanoq bilan
const getStudentSystems = asyncHandler(async (req, res) => {
  const { data, total, page, limit, summary } =
    await studentSystemService.listStudentSystems(req.query);

  res.json({ ...formatPaginationResponse(data, total, page, limit), summary });
});

// "Bor" / "yo'q" belgisi — bitta yoki bir nechta o'quvchi
const setStudentSystemMarks = asyncHandler(async (req, res) => {
  const { studentIds, system, present } = req.body;
  const data = await studentSystemService.setStudentSystemMarks(
    { studentIds, system, present },
    { actorId: req.user.id },
  );

  res.json({
    success: true,
    message: present ? "Belgi qo'yildi" : "Belgi olib tashlandi",
    data,
  });
});

// Excel — butun maktab yoki tanlangan sinflar, to'liq hisobot yoki bitta ro'yxat
const exportStudentSystems = asyncHandler(async (req, res) => {
  await studentSystemExport.exportStudentSystems(res, req.query);
});

/**
 * BOSH SAHIFADAGI KARTA — "nechtasi ERP da, nechtasi Kundalik.com da".
 *
 * ⚠️ RO'YXAT SO'ROVIDAN (`getStudentSystems`) ALOHIDA: u sahifalangan
 * jadval uchun o'quvchilarni ham yuklaydi, karta esa faqat sanoqchi
 * kutadi. Bosh sahifa har ochilganda chaqiriladigan yo'l yengil
 * bo'lishi kerak.
 *
 * ⚠️ Umumiy ko'rinishda javob filiallar bo'ylab BIRLASHTIRILADI
 * (`aggregateRoute.registry.js` → `mode: "object"`): sanoqlar qo'shiladi
 * va karta ostidagi filiallar kesimi (`BranchSplit`) shundan chiqadi.
 */
const getSystemsSummary = asyncHandler(async (req, res) => {
  const data = await systemsReport.getSystemsSummary();
  res.json({ success: true, data });
});

/**
 * HISOBOT — ekran va Word uchun BITTA obyekt.
 *
 * ⚠️ DARVOZA YO'Q (o'quvchilar harakatidan farqi, `studentEnrollment.
 * controller.js`): savol filial ichida ham ma'noli — "MBSI da nechta
 * o'quvchi ERP ga kiritilmagan" degan ro'yxat o'sha filial xodimining
 * kundalik ishi. Umumiy ko'rinishda esa u tarmoq savoliga aylanadi va
 * filiallar bo'ylab o'zi yig'iladi.
 */
const loadSystemsReport = (req) => {
  const branches = req.aggregateScope?.branches;

  if (branches?.length) return systemsNetwork.getNetworkSystemsReport(branches);

  return systemsReport.getSystemsReport({
    branch: req.branch ? { id: req.branch.id, name: req.branch.name } : null,
  });
};

const getSystemsReport = asyncHandler(async (req, res) => {
  const data = await loadSystemsReport(req);
  res.json({ success: true, data });
});

/**
 * AYNI hisobot — Word (.docx) fayli sifatida.
 *
 * ⚠️ Fayl EKRANDAGI AYNI OBYEKTDAN quriladi: hisobot bir marta
 * hisoblanib, quruvchiga BERILADI (u qayta hisoblamaydi). Ikkinchi hisob
 * bo'lsa, ekrandagi foiz bilan fayldagi foiz asta-sekin uzoqlashardi.
 */
const exportSystemsReport = asyncHandler(async (req, res) => {
  const report = await loadSystemsReport(req);
  await systemsReportExport.sendSystemsDocx(res, report);
});

module.exports = {
  getStudentSystems,
  setStudentSystemMarks,
  exportStudentSystems,
  getSystemsSummary,
  getSystemsReport,
  exportSystemsReport,
};
