const asyncHandler = require("../middleware/async.middleware");
const {
  NotFoundError,
  BadRequestError,
  ForbiddenError,
} = require("../utils/errors");
const ExcelService = require("../services/excel.service");
const userService = require("../services/user.service");
const staffReportService = require("../services/staffReport.service");
const aggregateScope = require("../services/aggregateScope.service");
const invoiceGenerationService = require("../services/invoiceGeneration.service");
const { PERMISSIONS, hasPermission, hasRole } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");
const { isValidId } = require("../utils/objectId");
const {
  monthKeyOfDate,
  parseDayDate,
  parseOptionalMonthKey,
  currentMonthKey,
} = require("../helpers/month.helpers");
const logger = require("../utils/logger");

/**
 * Yangi o'quvchining BIRINCHI TO'LOV OYI hisob-fakturasini darhol
 * shakllantiradi — qarz (qo'lda kiritilgan birinchi oy summasi) darhol
 * ko'rinsin. To'lov oyi = firstMonthKey (bo'lmasa kirgan sana oyi).
 *
 * ⚠️ Xatolik o'quvchi yaratishni bekor QILMAYDI: idempotent generatsiya jim
 * qolmasligi uchun logga yoziladi (davr ochilgach shakllantirish naqshi).
 * Kelajak oy / ta'til oyi bo'lsa faktura chiqmaydi — bu normal.
 */
const generateFirstMonthInvoice = async (req, user, body = {}) => {
  if (user?.role !== ROLES.STUDENT) return null;

  let month;
  try {
    month =
      parseOptionalMonthKey(body.firstMonthKey, "To'lov oyi") ??
      (body.enrollmentDate
        ? monthKeyOfDate(parseDayDate(body.enrollmentDate))
        : currentMonthKey());
  } catch {
    return null;
  }
  if (month > currentMonthKey()) return null;

  try {
    return await invoiceGenerationService.generateForMonth(month, {
      actorId: req.user?.id,
      source: "manual",
      studentIds: [user.id],
    });
  } catch (error) {
    logger.warn(
      `[user] Yangi o'quvchiga hisob-faktura shakllantirilmadi: ` +
        `student=${user.id} oy=${month} — ${error.message}`,
    );
    return null;
  }
};

/**
 * Sanoqchilar (faqat tizim egasi).
 *
 * ⚠️ UMUMIY KO'RINISHDA SANOQ QO'SHILMAYDI — ODAMLAR BIRLASHTIRILADI.
 * Xodim bir nechta filialda ishlashi mumkin va har filialda AYNI `id`
 * bilan turadi (`user.service.js` → `attachToBranch`). Dispatcher
 * filiallarning sanoqlarini qo'shib yuborsa, ikki filialda ishlaydigan
 * odam "ikki xodim" bo'lib ko'rinardi. Shu sababli bu yo'l registrda
 * `anchor` deb belgilangan va sanoqni servisning O'ZI filiallar bo'ylab
 * yig'adi (`getStatsAcrossBranches`).
 *
 * Javobdagi `meta.aggregate` — dispatcher birlashtirgan javoblar bilan
 * AYNI shaklda (`helpers/aggregateMerge.helpers.js` → `byBranch`), ya'ni
 * panel uchun bu yo'l hech narsa bilan farq qilmaydi.
 */
const getStats = asyncHandler(async (req, res) => {
  const branches = req.aggregateScope?.branches ?? [];

  if (branches.length > 1) {
    const { totals, perBranch, shared } =
      await userService.getStatsAcrossBranches(branches);

    const labels = perBranch.map(({ branch }) =>
      aggregateScope.publicBranch(branch),
    );
    const values = {};
    for (const key of Object.keys(totals)) {
      values[`data.${key}`] = perBranch.map((row) => row[key]);
    }

    return res.json({
      success: true,
      data: totals,
      meta: {
        aggregate: {
          mode: "object",
          branches: labels,
          byBranch: { branches: labels, values },
          // Kesim yig'indisi jamidan katta bo'lishi mumkin — farqi shu.
          shared,
        },
      },
    });
  }

  const data = await userService.getStats();

  res.json({ success: true, data });
});

// Xodimlar bo'limining "Hisobotlar" tabi.
//
// Davomat bloki ALOHIDA ruxsat ostida: `users.reports` shtat manzarasini
// ochadi, xodimlarning kelish-ketish tarixini emas. Ruxsati bo'lmasa blok
// umuman kelmaydi va frontend uni chizmaydi.
const getStaffReport = asyncHandler(async (req, res) => {
  const now = new Date();
  // Oy/yil ixtiyoriy: berilmasa yoki noto'g'ri kelsa joriy oy olinadi
  const rawMonth = parseInt(req.query.month, 10);
  const rawYear = parseInt(req.query.year, 10);
  const month = rawMonth >= 1 && rawMonth <= 12 ? rawMonth : now.getMonth() + 1;
  const year =
    rawYear >= 2000 && rawYear <= 2100 ? rawYear : now.getFullYear();

  const withAttendance =
    req.user.role === ROLES.OWNER ||
    hasPermission(req.user.permissions, PERMISSIONS.ATTENDANCE_REPORTS);

  const data = await staffReportService.getStaffReport(month, year, {
    withAttendance,
  });

  res.json({ success: true, data });
});

// ASL SINFLAR KESIMI — har darajada nechta o'quvchi bor.
// Sinflar sanog'idan alohida endpoint: ular ikki boshqa savol.
const getActualGradeCounts = asyncHandler(async (req, res) => {
  const data = await userService.getActualGradeCounts();

  res.json({ success: true, data });
});

// Get all users (Owner only)
const getAllUsers = asyncHandler(async (req, res) => {
  // `coinPeriod` — faqat tanga kesimi so'ralganda qaytadi: qaysi hafta
  // hisoblangani (`from`/`to`) va u joriy haftami. Panel navigatorni
  // shundan chizadi.
  const { users, pagination, coinPeriod } = await userService.getAllUsers(
    req.query,
    req.user,
  );

  res.json({
    success: true,
    data: users,
    pagination,
    ...(coinPeriod && { coinPeriod }),
  });
});

// Create new user (Owner only)
const createUser = asyncHandler(async (req, res) => {
  // ⚠️ Aktyorning O'ZI ham beriladi: `createdBy` ni yozish uchun `id`,
  // "o'qituvchi faqat o'quvchi qo'shadi" cheklovi uchun esa `role` kerak.
  const user = await userService.createUser(req.body, req.user?.id, req.user);

  // O'quvchi bo'lsa — birinchi to'lov oyi hisob-fakturasini darhol
  // shakllantiramiz (qo'lda kiritilgan birinchi oy summasi darhol ko'rinsin).
  const generated = await generateFirstMonthInvoice(req, user, req.body);

  res.status(201).json({
    success: true,
    message: "Foydalanuvchi muvaffaqiyatli yaratildi",
    data: user,
    ...(generated ? { generated } : {}),
  });
});

// Get single user (Owner only)
const getUser = asyncHandler(async (req, res) => {
  // Service orqali: u `classes` va `subjects` junction'larini BIRGA yuklab
  // tekislaydi va parollarni o'zi yashiradi (parolni ko'rish alohida
  // ruxsatli endpoint — `GET /:id/password`).
  const data = await userService.getUserById(req.params.id);
  if (!data) throw new NotFoundError("Foydalanuvchi topilmadi");

  res.json({ success: true, data });
});

// Update user (Owner only)
const updateUser = asyncHandler(async (req, res) => {
  // Aktyor — sinf o'zgarishi jurnali uchun ("kim chiqardi / kim ko'chirdi")
  const user = await userService.updateUser(req.params.id, req.body, {
    actorId: req.user.id,
  });

  res.json({
    success: true,
    message: "Foydalanuvchi muvaffaqiyatli yangilandi",
    data: user,
  });
});

// Telefon raqamlari — alohida ruxsat (`users.phone`), `updateUser` dan
// ajratilgan. Faqat kelgan kalit yoziladi; bo'sh satr = raqam o'chirildi.
const updateUserPhone = asyncHandler(async (req, res) => {
  const { phone, parentPhone } = req.body;

  const user = await userService.updateUserPhone(req.params.id, {
    phone,
    parentPhone,
  });

  res.json({
    success: true,
    message: "Telefon raqamlari yangilandi",
    data: user,
  });
});

// Reset user password (Owner only)
// QO'SHIMCHA ROLLAR — faqat owner (route darajasida `authorize(OWNER)`).
//
// ⚠️ To'liq ro'yxat yuboriladi, "qo'sh"/"olib tashla" emas: qisman
// amallarda ikkita parallel so'rov bir-birining natijasini yo'q qilardi
// (ikkinchisi birinchisi ko'rmagan ro'yxat ustiga yozardi).
const setUserRoles = asyncHandler(async (req, res) => {
  const { extraRoles } = req.body;

  if (!Array.isArray(extraRoles)) {
    throw new BadRequestError("extraRoles massiv bo'lishi kerak");
  }

  const user = await userService.setExtraRoles(
    req.params.id,
    extraRoles,
    req.user,
  );

  res.json({
    success: true,
    message: "Rollar yangilandi",
    data: user,
  });
});

const resetPassword = asyncHandler(async (req, res) => {
  await userService.resetPassword(req.params.id, req.body.newPassword);

  res.json({
    success: true,
    message: "Parol muvaffaqiyatli tiklandi",
  });
});

// Get user password (Owner only)
const getUserPassword = asyncHandler(async (req, res) => {
  const password = await userService.getUserPassword(req.params.id);

  res.json({
    success: true,
    data: { password },
  });
});

// Delete user (Owner only)
const deleteUser = asyncHandler(async (req, res) => {
  await userService.deleteUser(req.params.id);

  res.json({
    success: true,
    message: "Foydalanuvchi muvaffaqiyatli o'chirildi",
  });
});

const ARCHIVE_NOTE_MAX = 500;

// Archive user — student or staff (Owner only)
const archiveUser = asyncHandler(async (req, res) => {
  const { resetCoins, resetPenalties, resetDebt } = req.body;
  const note = typeof req.body.note === "string" ? req.body.note.trim() : "";

  if (note.length > ARCHIVE_NOTE_MAX) {
    throw new BadRequestError(
      `Izoh ${ARCHIVE_NOTE_MAX} belgidan oshmasligi kerak`,
    );
  }

  // ⚠️ QARZNI 0 GA TUSHIRISH — MOLIYA AMALI, arxivlash huquqi yetmaydi.
  // Bittalik yo'l bilan AYNI shart: bekor qilish — `finance.cancel`, o'tgan
  // oy va oy summasini o'zgartirish — `finance.adjust` (qarz deyarli doim
  // o'tgan oylarda). Yumshoqroq bo'lsa, arxivlash tugmasi orqali pulni
  // harakatlantirish huquqi oshirib olinardi (`finance.md` §5).
  if (resetDebt && !hasRole(req.user, ROLES.OWNER)) {
    const canWriteOff =
      hasPermission(req.user.permissions, PERMISSIONS.FINANCE_CANCEL) &&
      hasPermission(req.user.permissions, PERMISSIONS.FINANCE_ADJUST);
    if (!canWriteOff) {
      throw new ForbiddenError(
        "Qarzdorlikni 0 ga tushirish uchun moliya ruxsatingiz yo'q",
      );
    }
  }

  const user = await userService.archiveUser(req.params.id, {
    resetCoins: Boolean(resetCoins),
    resetPenalties: Boolean(resetPenalties),
    resetDebt: Boolean(resetDebt),
    note,
    actorId: req.user.id,
  });

  res.json({
    success: true,
    message: "Foydalanuvchi muvaffaqiyatli arxivlandi",
    data: user,
  });
});

// Restore archived user (Owner only)
const restoreUser = asyncHandler(async (req, res) => {
  const user = await userService.restoreUser(req.params.id);

  res.json({
    success: true,
    message: "Foydalanuvchi arxivdan qaytarildi",
    data: user,
  });
});

// Export users to Excel (Owner only)
// Arxiv tanlovi — o'quvchilar eksportida: ikkalasi, faqat joriylar yoki
// faqat arxivlanganlar. Sukut `all`: moliyaviy eksport arxivlanganni
// ko'rsatishda davom etadi (`education.md` §4 "Istisno — moliya").
const ARCHIVE_SCOPES = ["all", "true", "false"];

const exportUsersToExcel = asyncHandler(async (req, res) => {
  const { role } = req.query;
  const classId = req.query.classId ? String(req.query.classId) : null;
  // ASL SINF (daraja) — sinf bilan MUSTAQIL o'lcham: ikkalasi berilsa
  // shart kesishadi ("IT 1 da o'qiydigan 5-sinf o'quvchilari"). Qiymat
  // `grade.helpers.js` da tekshiriladi (1 … 11 yoki "none").
  const actualGrade =
    req.query.actualGrade === undefined ? undefined : String(req.query.actualGrade);
  const archived =
    req.query.archived === undefined ? "all" : String(req.query.archived);

  // Daraja kesimi ham faqat O'QUVCHILAR eksportida ma'noga ega
  if (actualGrade !== undefined && actualGrade !== "" && role !== "student") {
    throw new BadRequestError("Asl sinf bo'yicha faqat o'quvchilar yuklanadi");
  }

  // Sinf kesimi faqat O'QUVCHILAR eksportida: xodim/umumiy eksportda uni
  // jim e'tiborsiz qoldirish "sinf tanladim, hamma chiqdi" holatini berardi.
  if (classId) {
    if (role !== "student") {
      throw new BadRequestError("Sinf bo'yicha faqat o'quvchilar yuklanadi");
    }
    if (!isValidId(classId)) {
      throw new BadRequestError("Sinf identifikatori noto'g'ri");
    }
  }

  // Arxiv tanlovi ham faqat o'quvchilarda — boshqa rollar eksportiga
  // arxivlangan xodim UMUMAN tushmaydi (`getUsersForExport`), ya'ni u yerda
  // tanlov "tanladim, lekin hech narsa o'zgarmadi" bo'lib qolardi.
  if (req.query.archived !== undefined) {
    if (role !== "student") {
      throw new BadRequestError("Arxiv tanlovi faqat o'quvchilar eksportida");
    }
    if (!ARCHIVE_SCOPES.includes(archived)) {
      throw new BadRequestError("Arxiv tanlovi noto'g'ri");
    }
  }

  // ⚠️ Arxivlangan o'quvchi arxivlashda BARCHA sinflardan chiqariladi
  // (`education.md` §5), ya'ni "sinf + faqat arxivlanganlar" har doim bo'sh
  // fayl bo'lardi — foydalanuvchi buni tizim nosozligi deb o'ylardi.
  // ⚠️ Faqat SINF kesimiga tegishli: asl sinf (daraja) arxivlashda
  // O'CHIRILMAYDI, ya'ni "arxiv + asl sinf" to'la ma'noli ro'yxat beradi.
  if (classId && archived === "true") {
    throw new BadRequestError(
      "Arxivlangan o'quvchilar sinflardan chiqarilgan — sinf bilan birga yuklanmaydi",
    );
  }

  // O'QUVCHILAR eksporti — MOLIYALI va IKKI VARAQLI:
  //   1) "O'quvchilar" — hamma o'quvchi + tarif/to'langan/qarz;
  //   2) "Qarzdorlar" — faqat to'liq to'lamaganlar.
  // Boshqa rollar (xodim/o'qituvchi) uchun moliya ustunlari mantiqsiz —
  // ular avvalgidek bitta varaqli eksport oladi.
  if (role === "student") {
    const { all, debtors } = await userService.getStudentsFinanceExport({
      classId,
      actualGrade,
      archived,
    });

    const workbook = ExcelService.createWorkbook();

    // "Holat" ustuni FAQAT aralash faylda: bitta turdagi faylda u boshdan-oyoq
    // bir xil qiymat turgan ustun bo'lib qolardi (varaq nomi buni aytadi).
    const mixedArchive = archived === "all";
    const onlyArchived = archived === "true";

    const studentColumns = [
      { header: "F.I.O", key: "fullName", width: 28 },
      { header: "Username", key: "username", width: 18 },
      { header: "Parol", key: "password", width: 16 },
      { header: "Sinf", key: "className", width: 14 },
      // ASL SINF — daraja (1-sinf … 11-sinf), o'quvchi o'qiyotgan guruhdan
      // farq qilishi mumkin. Ekrandagi ustun bilan AYNI.
      { header: "Asl sinfi", key: "actualGrade", width: 12 },
      ...(mixedArchive
        ? [{ header: "Holat", key: "status", width: 14 }]
        : []),
      { header: "Telefon", key: "phone", width: 18 },
      { header: "Ota-ona telefoni", key: "parentPhone", width: 18 },
      { header: "Tarif", key: "tariff", width: 20 },
      { header: "To'langan (so'm)", key: "paid", width: 18 },
      { header: "Qarzdorlik (so'm)", key: "debt", width: 18 },
      { header: "Tangalar", key: "coinBalance", width: 10 },
      { header: "Jarimalar", key: "penaltyPoints", width: 10 },
    ];

    ExcelService.addSheet(workbook, {
      // Varaq nomi faylning O'ZIDA nima borligini aytadi — fayl boshqa odamga
      // yuborilganda "bu joriylarmi yoki arxivmi" degan savol qolmasin
      sheetName: onlyArchived ? "Arxivlangan o'quvchilar" : "O'quvchilar",
      columns: studentColumns,
      data: all,
      headerStyle: { bgColor: ExcelService.COLORS.HEADER_BLUE },
    });

    // Ikkinchi varaq — faqat qarzdorlar (qarz ustuni bilan yakunlanadi)
    ExcelService.addSheet(workbook, {
      sheetName: "Qarzdorlar",
      columns: [
        { header: "F.I.O", key: "fullName", width: 28 },
        { header: "Sinf", key: "className", width: 14 },
        { header: "Asl sinfi", key: "actualGrade", width: 12 },
        ...(mixedArchive
          ? [{ header: "Holat", key: "status", width: 14 }]
          : []),
        { header: "Telefon", key: "phone", width: 18 },
        { header: "Ota-ona telefoni", key: "parentPhone", width: 18 },
        { header: "Tarif", key: "tariff", width: 20 },
        { header: "To'langan (so'm)", key: "paid", width: 18 },
        { header: "Qarzdorlik (so'm)", key: "debt", width: 18 },
      ],
      data: debtors,
      headerStyle: { bgColor: ExcelService.COLORS.HEADER_ORANGE },
    });

    let studentsBaseName = "students";
    if (onlyArchived) studentsBaseName = "students_archived";
    else if (archived === "false") studentsBaseName = "students_active";
    const filename = ExcelService.generateFileName(studentsBaseName);
    await ExcelService.sendWorkbook(res, workbook, filename);
    return;
  }

  const data = await userService.getUsersForExport(role);

  // Tanga faqat o'quvchida bo'ladi (`coin.service.js` butunlay `role:
  // "student"` bilan ishlaydi), jarima esa xodimda ham — shuning uchun
  // "Tangalar" ustuni faqat o'quvchi tushadigan eksportda chiziladi, aks
  // holda xodimlar faylida boshdan-oyoq nol turgan ustun paydo bo'lardi.
  // "Asl sinfi" ham faqat o'quvchida bo'ladi — AYNI shart bilan
  const withStudentColumns = !role || role === "all" || role === "student";

  const workbook = ExcelService.createExcel({
    sheetName: "Foydalanuvchilar",
    columns: [
      { header: "F.I.O", key: "fullName", width: 30 },
      { header: "Username", key: "username", width: 20 },
      { header: "Parol", key: "password", width: 18 },
      { header: "Rol", key: "role", width: 15 },
      { header: "Sinflar", key: "classes", width: 40 },
      ...(withStudentColumns
        ? [{ header: "Asl sinfi", key: "actualGrade", width: 12 }]
        : []),
      { header: "Telefon", key: "phone", width: 20 },
      { header: "Ota-ona telefoni", key: "parentPhone", width: 20 },
      ...(withStudentColumns
        ? [{ header: "Tangalar", key: "coinBalance", width: 12 }]
        : []),
      { header: "Jarimalar", key: "penaltyPoints", width: 12 },
    ],
    data,
  });

  let baseName = "users";
  if (role === "teacher") baseName = "teachers";
  else if (role === "student") baseName = "students";
  const filename = ExcelService.generateFileName(baseName);

  await ExcelService.sendWorkbook(res, workbook, filename);
});

// Get all users short list (Owner only)
const getAllUsersShort = asyncHandler(async (req, res) => {
  const users = await userService.getAllUsersShort();

  res.json({ success: true, data: users });
});

// Get students list (Owner + Teacher)
const getStudents = asyncHandler(async (req, res) => {
  const students = await userService.getStudents(req.query);

  res.json({ success: true, data: students });
});

// Update own profile (any authenticated user)
// ⚠️ `phone` / `parentPhone` ATAYLAB olinmaydi: o'quvchi o'z raqamini
// o'zgartira olmaydi (faqat `users.phone` ruxsati bilan, `PUT /:id/phone`).
const updateMe = asyncHandler(async (req, res) => {
  const { firstName, lastName, username, currentPassword, newPassword } = req.body;

  const user = await userService.updateSelfProfile(req.user.id, {
    firstName,
    lastName,
    username,
    currentPassword,
    newPassword,
  });

  res.json({
    success: true,
    message: "Profil muvaffaqiyatli yangilandi",
    data: user,
  });
});

// ─── FILIALGA BIRIKTIRISH ──────────────────────────────────────────

/**
 * Xodim qaysi filiallarda ishlaydi — har birida o'z roli va ruxsatlari bilan.
 * @route GET /api/users/:id/branches
 */
const getUserBranches = asyncHandler(async (req, res) => {
  const data = await userService.getUserBranches(req.params.id);

  res.json({ success: true, data });
});

/**
 * Xodimni boshqa filialga biriktirish.
 * @route POST /api/users/:id/branches
 */
const attachUserToBranch = asyncHandler(async (req, res) => {
  const data = await userService.attachToBranch(req.params.id, {
    branchId: req.body.branchId,
    role: req.body.role,
    actorId: req.user.id,
  });

  res.json({
    success: true,
    message: "Xodim filialga biriktirildi",
    data,
  });
});

/**
 * Xodimning asosiy (uy) filialini almashtirish — login shu filialga tushadi.
 * @route PATCH /api/users/:id/branches/:branchId/home
 */
const setUserHomeBranch = asyncHandler(async (req, res) => {
  const data = await userService.setHomeBranch(
    req.params.id,
    req.params.branchId,
  );

  res.json({
    success: true,
    message: "Asosiy filial o'zgartirildi",
    data,
  });
});

/**
 * Xodimni filialdan chiqarish.
 *
 * Asosiy filialdan ham chiqarish mumkin: login qaysi filialga tushishi
 * `nextHomeBranchId` da keladi (bitta filial qolsa — shart emas).
 *
 * @route DELETE /api/users/:id/branches/:branchId
 */
const detachUserFromBranch = asyncHandler(async (req, res) => {
  const data = await userService.detachFromBranch(
    req.params.id,
    req.params.branchId,
    { nextHomeBranchId: req.query.nextHomeBranchId || undefined },
  );

  res.json({
    success: true,
    message: "Xodim filialdan chiqarildi",
    data,
  });
});

module.exports = {
  setUserRoles,
  getAllUsers,
  getActualGradeCounts,
  getAllUsersShort,
  getUser,
  createUser,
  updateUser,
  updateUserPhone,
  resetPassword,
  getUserPassword,
  deleteUser,
  archiveUser,
  restoreUser,
  getStats,
  getStaffReport,
  exportUsersToExcel,
  getStudents,
  updateMe,
  getUserBranches,
  attachUserToBranch,
  setUserHomeBranch,
  detachUserFromBranch,
};
