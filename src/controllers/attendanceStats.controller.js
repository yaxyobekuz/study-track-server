const asyncHandler = require("../middleware/async.middleware");
const network = require("../services/attendanceStatsNetwork.service");
const statsExport = require("../services/attendanceStatsExport.service");
const { ForbiddenError } = require("../utils/errors");

/**
 * DAVOMAT STATISTIKASI — bosh sahifadagi kartalar va ularning hujjati.
 *
 * ⚠️ FAQAT "UMUMIY — BARCHA FILIALLAR" KO'RINISHIDA (biznes qarori,
 * 2026-10-28), ya'ni faqat tizim egasida — `studentEnrollment.controller.js`
 * (o'quvchilar harakati) va `task.controller.js` (xodimlar topshiriqlari)
 * bilan AYNI darvoza.
 *
 * Sabab: bu hisobot TARMOQ savoliga javob beradi — "qaysi filialda
 * davomat tushdi, qaysi sinf eng past". Bitta filialning kesimi Davomat →
 * Hisobotlar bo'limida allaqachon bor va u yerda kun/oy/sinf kesimlari
 * bilan batafsilroq.
 *
 * ⚠️ DARVOZA SERVERDA, faqat panelda EMAS: ekranda tugma ko'rinmasa ham,
 * saqlangan havola bilan kelinishi mumkin.
 */
const assertAggregateView = (req) => {
  const branches = req.aggregateScope?.branches;

  if (!branches?.length) {
    throw new ForbiddenError(
      "Bu hisobot faqat \"Umumiy — barcha filiallar\" ko'rinishida ochiladi",
    );
  }

  return branches;
};

const loadStudents = (req, options = {}) =>
  network.getNetworkStudentStats(req.query, assertAggregateView(req), options);

const loadTeachers = (req, options = {}) =>
  network.getNetworkTeacherStats(req.query, assertAggregateView(req), options);

/**
 * KARTA PROYEKSIYASI — hujjat bilan AYNI dvigateldan, lekin yengil javob.
 *
 * ⚠️ IKKINCHI HISOB EMAS: raqamlar o'sha hisobotdan olinadi, shunchaki
 * kartada ko'rinmaydigan qatorlar (kunlar, sinflar, ro'yxatlar) tashlab
 * yuboriladi. Yillik davrda ular javobni bir necha yuz qatorga
 * shishirardi.
 */
const pulseOf = (report) => ({
  period: {
    key: report.period.key,
    label: report.period.label,
    rangeLabel: report.period.rangeLabel,
    days: report.period.days,
    previous: {
      title: report.period.previous.title,
      label: report.period.previous.label,
    },
  },
  isNetwork: report.isNetwork,
  partial: report.partial,
  totals: report.totals,
  previous: { percent: report.previous.percent, came: report.previous.came, expected: report.previous.expected },
  change: report.change,
  byBranch: report.byBranch ?? [],
});

const getStudentPulse = asyncHandler(async (req, res) => {
  const report = await loadStudents(req, { detail: false });
  res.json({ success: true, data: pulseOf(report) });
});

const getTeacherPulse = asyncHandler(async (req, res) => {
  const report = await loadTeachers(req, { detail: false });
  res.json({
    success: true,
    data: {
      ...pulseOf(report),
      staffCount: report.staffCount,
      // ⚠️ Jonli blok kartaning UCHINCHI qatori: "hozir dars bo'lyapti,
      // o'qituvchi esa yo'q". Ro'yxatning o'zi hujjatda.
      live: report.live
        ? {
            closed: report.live.closed,
            message: report.live.message,
            nowLabel: report.live.nowLabel,
            summary: report.live.summary,
          }
        : null,
    },
  });
});

const getStudentAttendanceDoc = asyncHandler(async (req, res) => {
  const data = await loadStudents(req);
  res.json({ success: true, data });
});

const getTeacherAttendanceDoc = asyncHandler(async (req, res) => {
  const data = await loadTeachers(req);
  res.json({ success: true, data });
});

/**
 * AYNI hisobot — Word (.docx) fayli sifatida.
 *
 * ⚠️ Fayl EKRANDAGI AYNI OBYEKTDAN quriladi: hisobot bir marta hisoblanib,
 * quruvchiga BERILADI (u qayta hisoblamaydi). Ikkinchi hisob bo'lsa,
 * ekrandagi foiz bilan fayldagi foiz asta-sekin uzoqlashardi.
 */
const exportStudentAttendanceDoc = asyncHandler(async (req, res) => {
  const report = await loadStudents(req);
  await statsExport.sendAttendanceStatsDocx(res, report);
});

const exportTeacherAttendanceDoc = asyncHandler(async (req, res) => {
  const report = await loadTeachers(req);
  await statsExport.sendAttendanceStatsDocx(res, report);
});

module.exports = {
  getStudentPulse,
  getTeacherPulse,
  getStudentAttendanceDoc,
  getTeacherAttendanceDoc,
  exportStudentAttendanceDoc,
  exportTeacherAttendanceDoc,
};
