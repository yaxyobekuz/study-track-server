/**
 * DARS SOATI VA MAOSH — controller (yupqa, mantiq service'da).
 *
 * ⚠️ `/my` endpoint'lari RUXSAT KALITISIZ: identifikator token'dan olinadi,
 * ya'ni odam faqat O'ZINING soatini ko'radi. `payroll.view` talab qilinsa,
 * o'qituvchi o'z maoshini ko'rish uchun butun maktabning qarzdorlik
 * registriga huquq olishi kerak bo'lardi (`getMySalary` bilan bir xil
 * mulohaza).
 */

const asyncHandler = require("../middleware/async.middleware");
const dashboardService = require("../services/lessonHoursDashboard.service");
const lessonHoursService = require("../services/lessonHours.service");
const substitutionService = require("../services/lessonSubstitution.service");
const { ROLES } = require("../utils/constants");
const { ForbiddenError } = require("../utils/errors");
// SOAT OCHIQ, PUL YOPIQ — darvoza bitta joyda (`selfPayroll.helpers.js`)
const {
  isSelfPayrollVisible,
  stripSalaryAmounts,
} = require("../helpers/selfPayroll.helpers");

const assertNotStudent = (user) => {
  if (user.role === ROLES.STUDENT) {
    throw new ForbiddenError("Dars soatlari faqat xodimlar uchun");
  }
};

// ── Boshliq ko'rinishi ───────────────────────

const getOverview = asyncHandler(async (req, res) => {
  const month = lessonHoursService.parseHoursMonth(req.query.month);
  const data = await dashboardService.getOverview(month);
  res.json({ success: true, data });
});

const getLedger = asyncHandler(async (req, res) => {
  const month = lessonHoursService.parseHoursMonth(req.query.month);
  const data = await dashboardService.getLedger(month, req.query);
  res.json({ success: true, data });
});

const getTeacherDetail = asyncHandler(async (req, res) => {
  const month = lessonHoursService.parseHoursMonth(req.query.month);
  const data = await dashboardService.getTeacherDetail(req.params.teacherId, month);
  res.json({ success: true, data });
});

/**
 * VEDOMOSTNI EXCEL'GA YUKLAB OLISH.
 *
 * ⚠️ FILTRLAR EKRANDAGIDEK QO'LLANADI. `req.query` o'zgarishsiz
 * `getLedger` ga uzatiladi: foydalanuvchi "KPI" filtrini qo'yib Excel
 * bossa, faylda ham aynan o'sha qatorlar bo'lishi kerak. Fayl ekrandan
 * boshqa ma'lumot bersa, ikkalasiga ham ishonch yo'qolardi.
 *
 * ⚠️ MA'LUMOT QAYTA HISOBLANMAYDI — `getLedger` AYNI o'zi chaqiriladi.
 * Ikkinchi yig'uvchi yozilsa, Excel va ekran vaqt o'tib bir-biridan
 * uzoqlashardi (`lessonHoursDashboard.service.js` sarlavhasi bilan bir
 * xil sabab).
 */
const exportLedger = asyncHandler(async (req, res) => {
  const month = lessonHoursService.parseHoursMonth(req.query.month);
  const data = await dashboardService.getLedger(month, req.query);
  await dashboardService.exportLedgerToExcel(res, data);
});

// ── O'zimniki (o'qituvchi paneli) ────────────

const getMyHours = asyncHandler(async (req, res) => {
  assertNotStudent(req.user);

  const month = lessonHoursService.parseHoursMonth(req.query.month);
  const data = await dashboardService.getTeacherDetail(req.user.id, month);

  // ⚠️ SOAT FAKTI QOLADI, SUMMA KETADI. O'qituvchi "nega soatim kam"
  // degan savolga o'zi javob topishi kerak (o'tilmagan darslar, kelmagan
  // kun, o'rinbosarlik) — shuning uchun bu yo'l 403 qilinmaydi, faqat pul
  // maydonlari olib tashlanadi.
  //
  // `history` BUTUNLAY pul (muhrlangan oyliklar egri chizig'i): summalari
  // olingach ma'nosiz ustunlar qolardi, shuning uchun u umuman berilmaydi.
  if (!isSelfPayrollVisible()) {
    const visible = stripSalaryAmounts(data);
    delete visible.history;
    res.json({ success: true, data: visible });
    return;
  }

  res.json({ success: true, data });
});

const getMySubstitutions = asyncHandler(async (req, res) => {
  assertNotStudent(req.user);

  const data = await substitutionService.getMySubstitutions(req.user.id);
  res.json({ success: true, data });
});

module.exports = {
  getOverview,
  getLedger,
  exportLedger,
  getTeacherDetail,
  getMyHours,
  getMySubstitutions,
};
