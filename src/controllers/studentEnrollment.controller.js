const asyncHandler = require("../middleware/async.middleware");
const logger = require("../utils/logger");
const enrollmentService = require("../services/studentEnrollment.service");
const departureService = require("../services/studentDeparture.service");
const movementExport = require("../services/studentMovementExport.service");
const movementNetwork = require("../services/studentMovementNetwork.service");
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
  } catch (error) {
    // Hisob-faktura shakllanmasligi davr ochilishini bekor qilmaydi —
    // admin ogohlantirishlarda ko'radi va qo'lda shakllantira oladi.
    // ⚠️ Lekin JIM qolmaydi: sabab logga yoziladi, aks holda "davr
    // ochildi, hisob-faktura yo'q" holatini tekshirishning yo'li qolmasdi.
    logger.warn(
      `[enrollment] Davr ochilgach hisob-faktura shakllantirilmadi: ` +
        `student=${enrollment.studentId} oy=${month} — ${error.message}`,
    );
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

/**
 * CHIQIB KETGANLAR REGISTRI — yopilgan o'qish davrlari ("nega, qachon").
 *
 * Alohida jadval yo'q: ketish fakti davrning YOPILGANI
 * (`studentDeparture.service.js` dagi izoh). Shuning uchun ruxsat ham
 * o'sha — `enrollment.view`: davr sahifasida ketish sababi allaqachon
 * ko'rinadi, registr faqat uni bitta ekranga yig'adi.
 */
const getDepartures = asyncHandler(async (req, res) => {
  const result = await departureService.getDepartures(req);
  res.json(result);
});

/** Bosh sahifadagi karta — oxirgi 30 kun + so'nggi ketishlar. */
const getDepartureSummary = asyncHandler(async (req, res) => {
  const data = await departureService.getDepartureSummary();
  res.json({ success: true, data });
});

/**
 * O'QUVCHILAR HARAKATI — "nechtasi keldi, nechtasi ketdi, qancha foizga
 * o'zgardi" (`studentMovement.service.js`).
 *
 * Ruxsat — `enrollment.view`, chiqib ketganlar registri bilan AYNI: hisobot
 * o'sha BITTA faktdan (o'qish davrining ochilishi va yopilishi) quriladi,
 * yangi ma'lumot ochib bermaydi.
 */
/**
 * O'QUVCHILAR HARAKATI — FAQAT "UMUMIY — BARCHA FILIALLAR" KO'RINISHIDA
 * (biznes qarori, 2026-10-27).
 *
 * Savol tarmoq darajasida beriladi: "bu oy butun tarmoqda nechta bola
 * keldi, nechtasi ketdi, qaysi filial o'sdi". Bitta filial ichida u o'sha
 * filialning raqami bo'lib qolardi — ya'ni bir xil nomdagi bo'lim ikki
 * joyda ikki xil savolga javob berardi.
 *
 * ⚠️ DARVOZA SERVERDA, panelda EMAS. Panel bo'limni umumiy ko'rinishdan
 * tashqarida ko'rsatmaydi (menyu ham, kartadagi belgi ham), lekin saqlangan
 * havola yoki to'g'ridan-to'g'ri so'rov shu yerda to'siladi: aks holda
 * "faqat umumiy ko'rinishda" degan qoida faqat ekranga tegishli bo'lib
 * qolardi.
 *
 * ⚠️ 403 — ruxsat kaliti YETARLI, lekin REJIM noto'g'ri. Shuning uchun
 * xabar "ruxsatingiz yo'q" emas: odam qaysi tugmani bosishi kerakligini
 * bilib tursin.
 *
 * @returns {object[]} umumiy rejimdagi filiallar ro'yxati
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

const getMovement = asyncHandler(async (req, res) => {
  const branches = assertAggregateView(req);
  const data = await movementNetwork.getNetworkMovementReport(req.query, branches);
  res.json({ success: true, data });
});

/** Bosh sahifadagi "O'quvchilar" kartasi — joriy oy va joriy yil o'zgarishi. */
const getMovementSummary = asyncHandler(async (req, res) => {
  const branches = assertAggregateView(req);
  const data = await movementNetwork.getNetworkMovementSummary(branches);
  res.json({ success: true, data });
});

/**
 * AYNI hisobot — Word (.docx) fayli sifatida.
 *
 * ⚠️ Fayl EKRANDAGI AYNI OBYEKTDAN quriladi: hisobot bir marta hisoblanib,
 * `studentMovementExport` ga BERILADI (u qayta hisoblamaydi). Ikkinchi
 * hisob bo'lsa, ekrandagi foiz bilan fayldagi foiz asta-sekin
 * uzoqlashardi.
 */
const exportMovement = asyncHandler(async (req, res) => {
  const branches = assertAggregateView(req);
  const report = await movementNetwork.getNetworkMovementReport(req.query, branches);
  await movementExport.sendMovementDocx(res, report);
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
    allowPastCancel: canAdjust(req),
    actorId: req.user.id,
  });

  res.json({ success: true, data });
});

/**
 * Davr qamramay qolgan oylarning hisob-fakturalari bekor qilinadi. O'tgan
 * oyniki — faqat `finance.adjust` bilan (`allowPastCancel`): bittalab bekor
 * qilishdagi bilan AYNI shart (`invoice.controller.js` → `cancelInvoice`).
 */
const closeEnrollment = asyncHandler(async (req, res) => {
  const data = await enrollmentService.closeEnrollment(req.params.id, req.body, {
    allowPast: canAdjust(req),
    allowPastCancel: canAdjust(req),
    actorId: req.user.id,
  });
  res.json({ success: true, data });
});

/** Saqlashdan oldin: ketish oyi va bekor qilinadigan hisob-fakturalar. */
const previewEnrollment = asyncHandler(async (req, res) => {
  const data = await enrollmentService.previewEnrollmentChange(req.params.id, req.body, {
    allowPastCancel: canAdjust(req),
  });
  res.json({ success: true, data });
});

const deleteEnrollment = asyncHandler(async (req, res) => {
  const result = await enrollmentService.deleteEnrollment(req.params.id);
  res.json({ success: true, ...result });
});

module.exports = {
  getEnrollments,
  getDepartures,
  getDepartureSummary,
  getMovement,
  getMovementSummary,
  exportMovement,
  getStudentEnrollments,
  getEnrollment,
  createEnrollment,
  updateEnrollment,
  closeEnrollment,
  previewEnrollment,
  deleteEnrollment,
};
