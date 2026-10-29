const asyncHandler = require("../middleware/async.middleware");
const activityDashboard = require("../services/activityDashboard.service");
const activityExport = require("../services/activityExport.service");
const botNetwork = require("../services/botReportNetwork.service");
const botReportExport = require("../services/botReportExport.service");
const {
  hasPermission,
  hasRole,
  PERMISSIONS,
} = require("../utils/permissions");
const { ROLES } = require("../utils/constants");
const { ForbiddenError } = require("../utils/errors");

/**
 * FAOLLIK MANZARASI.
 *
 * ⚠️ RO'YXAT ALOHIDA RUXSAT BILAN. `activity.view` umumiy foizlarni
 * ochadi, `activity.roster` esa FOYDALANMAYOTGANLARNING ISM-RO'YXATINI:
 * birinchisi hisobot, ikkinchisi aniq odamlar haqidagi ma'lumot va u
 * bilan ota-onaga qo'ng'iroq qilinadi. Shuning uchun qaror
 * CONTROLLER'da: service ikkalasini ham hisoblay oladi, lekin nimani
 * yuborishni HTTP qatlami hal qiladi.
 */
const canSeeRoster = (req) =>
  hasRole(req.user, ROLES.OWNER) ||
  hasPermission(req.user.permissions, PERMISSIONS.ACTIVITY_ROSTER);

const getOverview = asyncHandler(async (req, res) => {
  const withRoster = canSeeRoster(req);

  const data = await activityDashboard.getOverview({
    days: req.query.days,
    granularity: req.query.granularity,
    count: req.query.count,
    withRoster,
  });

  res.json({ success: true, data });
});

/**
 * BITTA ODAMNING FAOLLIK TARIXI — xodim yoki bog'langan Telegram hisobi.
 */
const getSubject = asyncHandler(async (req, res) => {
  const data = await activityDashboard.getSubject({
    userId: req.query.userId,
    telegramId: req.query.telegramId,
    days: req.query.days,
  });

  res.json({ success: true, data });
});

/**
 * BITTA SINFNING KESIMI — kim foydalanadi, kim yo'q.
 *
 * ⚠️ `activity.roster` TALAB QILINADI (route darajasida): bu ISM
 * RO'YXATI va u umumiy foizdan boshqa qaror — u bilan ota-onaga
 * qo'ng'iroq qilinadi.
 */
const getClass = asyncHandler(async (req, res) => {
  const data = await activityDashboard.getClass(req.params.classId, {
    days: req.query.days,
  });

  res.json({ success: true, data });
});

/**
 * BITTA SINFNING BOT QAMROVI → EXCEL (bog'langanlar / bog'lanmaganlar).
 *
 * ⚠️ Davr modal bilan AYNI (`days`): fayl ekrandagi ro'yxatning nusxasi.
 */
const exportClass = asyncHandler(async (req, res) => {
  await activityExport.exportClassToExcel(res, req.params.classId, {
    days: req.query.days,
  });
});

/**
 * BOT FOYDALANUVCHILARI — HUJJAT KO'RINISHIDAGI HISOBOT.
 *
 * ⚠️ FAQAT "UMUMIY — BARCHA FILIALLAR" KO'RINISHIDA (biznes qarori,
 * 2026-10-29), ya'ni faqat tizim egasida — davomat hisobotlari
 * (`attendanceStats.controller.js`) va o'quvchilar harakati bilan AYNI
 * darvoza. Hisobot TARMOQ savoliga javob beradi: "qaysi filialda qamrov
 * past". Bitta filialning kesimi Faollik bo'limida allaqachon bor.
 *
 * ⚠️ DARVOZA SERVERDA, faqat panelda EMAS: ekranda belgi bosilmasa ham,
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

/**
 * ⚠️ RO'YXATLAR SHU YERDA HAL QILINADI (`getOverview` bilan AYNI qoida):
 * "ulanmaganlar" va "jim turganlar" — ism ro'yxati, u `activity.roster`
 * ortida. Hujjat ularsiz ham to'liq quriladi va buni ochiq aytadi.
 */
const loadBotReport = (req) =>
  botNetwork.getNetworkBotReport(
    { days: req.query.days },
    assertAggregateView(req),
    { withRoster: canSeeRoster(req) },
  );

const getBotReport = asyncHandler(async (req, res) => {
  const data = await loadBotReport(req);
  res.json({ success: true, data });
});

/**
 * AYNI hisobot — Word (.docx) fayli sifatida.
 *
 * ⚠️ Fayl EKRANDAGI AYNI OBYEKTDAN quriladi: hisobot bir marta
 * hisoblanib, quruvchiga BERILADI (u qayta hisoblamaydi).
 */
const exportBotReport = asyncHandler(async (req, res) => {
  const report = await loadBotReport(req);
  await botReportExport.sendBotReportDocx(res, report);
});

module.exports = {
  getOverview,
  getSubject,
  getClass,
  exportClass,
  getBotReport,
  exportBotReport,
};
