// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controllers
const {
  getOverview,
  getLedger,
  getTeacherDetail,
  getMyHours,
  getMySubstitutions,
} = require("../controllers/lessonHours.controller");

const {
  getTeacherOptions,
  getSubstitutions,
  getSubstitution,
  getAvailableLessons,
  createSubstitution,
  cancelSubstitution,
} = require("../controllers/lessonSubstitution.controller");

// ── O'zimniki (o'qituvchi paneli) ────────────
//
// ⚠️ RUXSAT KALITI YO'Q va bu ATAYLAB: identifikator token'dan olinadi,
// o'quvchi controller'da rad etiladi. `payroll.view` talab qilinsa,
// o'qituvchi o'z soatini ko'rish uchun butun maktabning qarzdorlik
// registrini ochib olishi kerak bo'lardi.
//
// `/my` `/teacher/:teacherId` DAN OLDIN — "my" id deb o'qilmasligi uchun.
router.get("/my", protect, getMyHours);
router.get("/my/substitutions", protect, getMySubstitutions);

// ── O'rinbosarlik ────────────────────────────
//
// `/substitutions` `/teacher/:teacherId` dan oldin turishi shart emas
// (prefikslar farq qiladi), lekin `/substitutions/:id` `/substitutions`
// dan KEYIN kelishi kerak.
router.get(
  "/substitutions",
  protect,
  authorizePermission(PERMISSIONS.SUBSTITUTIONS_VIEW),
  getSubstitutions,
);

router.post(
  "/substitutions",
  protect,
  authorizePermission(PERMISSIONS.SUBSTITUTIONS_CREATE),
  createSubstitution,
);

// O'qituvchilar ro'yxati — KO'RISH huquqi bilan yetarli: ro'yxatning
// o'zi sir emas, u faqat ekranni to'ldiradi.
router.get(
  "/substitutions/teachers",
  protect,
  authorizePermission(PERMISSIONS.SUBSTITUTIONS_VIEW),
  getTeacherOptions,
);

// Tanlov ekrani — yaratish huquqi bilan: bu ro'yxatning o'zi "kimning
// qaysi darsini olish mumkin" degan javob.
router.get(
  "/substitutions/available/:teacherId",
  protect,
  validateObjectId("teacherId"),
  authorizePermission(PERMISSIONS.SUBSTITUTIONS_CREATE),
  getAvailableLessons,
);

router.get(
  "/substitutions/:id",
  protect,
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.SUBSTITUTIONS_VIEW),
  getSubstitution,
);

// Bekor qilish ALOHIDA huquq: u o'tgan davr soatini egasiga qaytaradi,
// ya'ni pulga tegadi.
router.post(
  "/substitutions/:id/cancel",
  protect,
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.SUBSTITUTIONS_CANCEL),
  cancelSubstitution,
);

// ── Soat hisoboti (boshliq) ──────────────────
router.get(
  "/ledger",
  protect,
  authorizePermission(PERMISSIONS.PAYROLL_HOURS),
  getLedger,
);

router.get(
  "/teacher/:teacherId",
  protect,
  validateObjectId("teacherId"),
  authorizePermission(PERMISSIONS.PAYROLL_HOURS),
  getTeacherDetail,
);

router.get("/", protect, authorizePermission(PERMISSIONS.PAYROLL_HOURS), getOverview);

module.exports = router;
