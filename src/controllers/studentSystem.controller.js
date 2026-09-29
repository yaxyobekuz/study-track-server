const studentSystemService = require("../services/studentSystem.service");
const studentSystemExport = require("../services/studentSystemExport.service");
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

module.exports = { getStudentSystems, setStudentSystemMarks, exportStudentSystems };
