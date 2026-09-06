const asyncHandler = require("../middleware/async.middleware");
const activityDashboard = require("../services/activityDashboard.service");
const {
  hasPermission,
  hasRole,
  PERMISSIONS,
} = require("../utils/permissions");
const { ROLES } = require("../utils/constants");

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
const getOverview = asyncHandler(async (req, res) => {
  const withRoster =
    hasRole(req.user, ROLES.OWNER) ||
    hasPermission(req.user.permissions, PERMISSIONS.ACTIVITY_ROSTER);

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

module.exports = { getOverview, getSubject, getClass };
