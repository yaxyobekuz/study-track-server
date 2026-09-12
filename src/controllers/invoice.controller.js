const asyncHandler = require("../middleware/async.middleware");
const invoiceService = require("../services/invoice.service");
const invoiceGenerationService = require("../services/invoiceGeneration.service");
const debtReminderService = require("../services/debtReminder.service");
const paymentService = require("../services/payment.service");
const { PERMISSIONS, hasPermission } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");
const { ForbiddenError } = require("../utils/errors");
const { currentMonthKey, parseMonthKey } = require("../helpers/month.helpers");

const canAdjust = (req) =>
  req.user.role === ROLES.OWNER ||
  hasPermission(req.user.permissions, PERMISSIONS.FINANCE_ADJUST);

// ── O'quvchining o'z ma'lumoti ───────────────

/**
 * O'quvchi o'z moliyaviy manzarasini ko'radi. `studentId` FAQAT tokendan —
 * query'dan olinsa, har kim boshqaning qarzini ko'rib qolardi.
 */
const getMyFinance = asyncHandler(async (req, res) => {
  const data = await invoiceService.getMyFinance(req.user.id);
  res.json({ success: true, data });
});

// ── Admin ────────────────────────────────────

const getInvoices = asyncHandler(async (req, res) => {
  const result = await invoiceService.getInvoices(req);
  res.json(result);
});

const getSummary = asyncHandler(async (req, res) => {
  const data = await invoiceService.getSummary(req.query.month);
  res.json({ success: true, data });
});

/** Kassirning asosiy ekrani — o'quvchilar kesimida tarif, depozit va qarz. */
const getStudentRegistry = asyncHandler(async (req, res) => {
  const result = await invoiceService.getStudentRegistry(req);
  res.json(result);
});

/** Moliya bosh sahifasi — sanoq, pul, sinf va yo'nalish kesimi (bir oy). */
const getOverviewDashboard = asyncHandler(async (req, res) => {
  const data = await invoiceService.getOverviewDashboard(req.query.month);
  res.json({ success: true, data });
});

/** Qarzdorlar registri — "kim qancha qarzdor va qachondan beri". */
const getDebtors = asyncHandler(async (req, res) => {
  const result = await invoiceService.getDebtors(req);
  res.json(result);
});

/**
 * Qarzdorlar ro'yxatini Excel'ga yuklab olish (butun maktab yoki bitta sinf).
 * Chiroyli formatli xlsx: sarlavha, jami qatori, telefonlar bilan.
 */
const exportDebtors = asyncHandler(async (req, res) => {
  const ExcelService = require("../services/excel.service");
  const { formatMonthKey, currentMonthKey } = require("../helpers/month.helpers");

  const { rows, totals, className } = await invoiceService.getDebtorsForExport({
    classId: req.query.classId || null,
  });

  const scopeLabel = className ? className : "Butun maktab";
  const monthLabel = formatMonthKey(currentMonthKey());

  const columns = [
    { header: "№", key: "no", width: 6 },
    { header: "Ism", key: "firstName", width: 18 },
    { header: "Familiya", key: "lastName", width: 18 },
    { header: "Sinf", key: "className", width: 12 },
    { header: "Telefon", key: "phone", width: 18 },
    { header: "Ota-ona tel.", key: "parentPhone", width: 18 },
    { header: "Qarzdor oylar", key: "unpaidCount", width: 14 },
    { header: "Eng eski qarz", key: "oldestMonthLabel", width: 18 },
    { header: "Hisoblangan", key: "charged", width: 16 },
    { header: "To'langan", key: "paid", width: 16 },
    { header: "Qolgan qarz", key: "debt", width: 16 },
  ];

  const workbook = ExcelService.createWorkbook();
  const worksheet = ExcelService.addWorksheet(workbook, "Qarzdorlar", {
    freezeHeader: false,
  });

  // Sarlavha bloki (2 qator) — ustunlardan oldin qo'lda yoziladi
  worksheet.mergeCells(1, 1, 1, columns.length);
  const titleCell = worksheet.getCell(1, 1);
  titleCell.value = `Qarzdorlar ro'yxati — ${scopeLabel}`;
  titleCell.font = { bold: true, size: 14, color: { argb: "FF1F2937" } };
  titleCell.alignment = { vertical: "middle", horizontal: "left" };
  worksheet.getRow(1).height = 26;

  worksheet.mergeCells(2, 1, 2, columns.length);
  const subCell = worksheet.getCell(2, 1);
  subCell.value =
    `Holat: ${monthLabel} · Qarzdorlar: ${totals.debtorCount} ta · ` +
    `Jami qarz: ${totals.totalDebt} so'm`;
  subCell.font = { size: 11, color: { argb: "FF6B7280" } };
  worksheet.getRow(2).height = 20;

  // Ustun sarlavhalari 4-qatordan (3-qator bo'sh ajratgich)
  const headerRowIndex = 4;
  columns.forEach((c, i) => {
    worksheet.getColumn(i + 1).width = c.width;
  });
  const headerRow = worksheet.getRow(headerRowIndex);
  headerRow.values = columns.map((c) => c.header);
  headerRow.height = 22;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = {
      top: { style: "thin", color: { argb: "FFD0D0D0" } },
      left: { style: "thin", color: { argb: "FFD0D0D0" } },
      bottom: { style: "thin", color: { argb: "FFD0D0D0" } },
      right: { style: "thin", color: { argb: "FFD0D0D0" } },
    };
  });

  // Ma'lumot qatorlari
  const moneyCols = new Set(["charged", "paid", "debt"]);
  rows.forEach((row, index) => {
    const excelRow = worksheet.addRow(columns.map((c) => row[c.key]));
    if (index % 2 === 0) {
      excelRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F6FC" } };
    }
    excelRow.eachCell((cell, colNumber) => {
      const col = columns[colNumber - 1];
      cell.border = {
        top: { style: "thin", color: { argb: "FFE5E7EB" } },
        left: { style: "thin", color: { argb: "FFE5E7EB" } },
        bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
        right: { style: "thin", color: { argb: "FFE5E7EB" } },
      };
      cell.alignment = {
        vertical: "middle",
        horizontal: moneyCols.has(col.key)
          ? "right"
          : col.key === "no"
            ? "center"
            : "left",
      };
      if (col.key === "debt") cell.font = { bold: true, color: { argb: "FFB91C1C" } };
    });
  });

  // Jami qatori
  const totalRow = worksheet.addRow([
    "", "", "", "", "", "", "", "JAMI:",
    totals.totalCharged, totals.totalPaid, totals.totalDebt,
  ]);
  totalRow.eachCell((cell, colNumber) => {
    if (colNumber >= 8) {
      cell.font = {
        bold: true,
        color: { argb: colNumber === 11 ? "FFB91C1C" : "FF1F2937" },
      };
      cell.alignment = { vertical: "middle", horizontal: "right" };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } };
    }
  });

  worksheet.autoFilter = {
    from: { row: headerRowIndex, column: 1 },
    to: { row: headerRowIndex, column: columns.length },
  };
  worksheet.views = [{ state: "frozen", ySplit: headerRowIndex }];

  const safeScope = (className || "butun-maktab").replace(/[^\p{L}\p{N}_-]+/gu, "-");
  const filename = ExcelService.generateFileName(`qarzdorlar_${safeScope}`);
  await ExcelService.sendWorkbook(res, workbook, filename);
});

/**
 * Qarzdorlarga Telegram eslatmasi.
 *
 * Ro'yxatdagi summaga ISHONILMAYDI — qarz service ichida qayta hisoblanadi:
 * ekran ochilgandan keyin to'lov tushgan bo'lishi mumkin va ota-onaga
 * yopilgan qarz haqida xabar ketishi eng yomon natija bo'lardi.
 */
const remindDebtors = asyncHandler(async (req, res) => {
  const result = await debtReminderService.remindDebtors(req.body.studentIds, {
    note: req.body.note,
    actorId: req.user.id,
  });

  res.json({
    success: true,
    message: "Eslatmalar navbatga qo'shildi",
    data: result,
  });
});

const getStudentInvoices = asyncHandler(async (req, res) => {
  const data = await invoiceService.getStudentInvoices(req.params.studentId, {
    includeCancelled: req.query.includeCancelled === "true",
  });
  res.json({ success: true, data });
});

const getInvoice = asyncHandler(async (req, res) => {
  const invoice = await invoiceService.getInvoiceById(req.params.id, {
    includeVoided: req.query.includeVoided === "true",
  });
  res.json({ success: true, data: invoice });
});

/**
 * Majburiyatlarni shakllantirish. Natija — paket hisoboti, yaratilgan resurs
 * emas, shuning uchun 201 emas 200.
 *
 * O'tgan oy uchun shakllantirish tarixga qarz qo'shadi — `finance.adjust`
 * talab qilinadi (dryRun bundan mustasno: u hech narsa yozmaydi).
 */
const generateInvoices = asyncHandler(async (req, res) => {
  const month = parseMonthKey(req.body.month, "Oy");
  const dryRun = req.body.dryRun === true;

  if (!dryRun && month < currentMonthKey() && !canAdjust(req)) {
    throw new ForbiddenError(
      "O'tgan oy uchun majburiyat shakllantirish uchun ruxsatingiz yo'q",
    );
  }

  const summary = await invoiceGenerationService.generateForMonth(month, {
    actorId: req.user.id,
    source: "manual",
    studentIds: req.body.studentIds,
    classId: req.body.classId,
    dryRun,
  });

  res.json({ success: true, data: summary });
});

const updateInvoice = asyncHandler(async (req, res) => {
  const invoice = await invoiceService.updateNote(req.params.id, req.body.note);
  res.json({ success: true, data: invoice });
});

const cancelInvoice = asyncHandler(async (req, res) => {
  const invoice = await invoiceService.getInvoiceById(req.params.id);

  // O'tgan oyni bekor qilish — tarixni qayta yozish
  if (invoice.month < currentMonthKey() && !canAdjust(req)) {
    throw new ForbiddenError(
      "O'tgan oy hisob-fakturasini bekor qilish uchun ruxsatingiz yo'q",
    );
  }

  const updated = await invoiceService.cancelInvoice(
    req.params.id,
    req.body.reason,
    req.user.id,
  );
  res.json({ success: true, data: updated });
});

/**
 * BIR OYNI BUTUNLAY BEKOR QILISH — ommaviy amal.
 *
 * ⚠️ O'TGAN OY uchun `finance.adjust` ham talab qilinadi: bittalik
 * bekor qilishdagi bilan AYNI shart (`cancelInvoice` ga qarang). Ommaviy
 * yo'lda tekshiruv tushib qolsa, bittalab qilib bo'lmaydigan ish bitta
 * tugma bilan bajarilib ketardi.
 */
const cancelInvoiceMonth = asyncHandler(async (req, res) => {
  const month = parseMonthKey(req.body.month, "Oy");

  if (month < currentMonthKey() && !canAdjust(req)) {
    throw new ForbiddenError(
      "O'tgan oy hisob-fakturalarini bekor qilish uchun ruxsatingiz yo'q",
    );
  }

  const summary = await invoiceService.cancelMonth(
    { month, reason: req.body.reason },
    req.user.id,
  );
  res.json({ success: true, data: summary });
});

/** Bir oyning hamma hisob-fakturasini qayta shakllantirish — ommaviy amal. */
const regenerateInvoiceMonth = asyncHandler(async (req, res) => {
  const summary = await invoiceService.regenerateMonth(req.body, req.user.id);
  res.json({ success: true, data: summary });
});

const restoreInvoice = asyncHandler(async (req, res) => {
  const invoice = await invoiceService.restoreInvoice(req.params.id, req.user.id);
  res.json({ success: true, data: invoice });
});

/**
 * Chegirma kech qo'shilganda yoki tarif narxi xato kiritilganda: summa
 * muhrlangani uchun uni tahrirlab bo'lmaydi, shuning uchun bekor qilib
 * qayta yaratiladi. Bu tarixni qayta yozish — `finance.adjust` talab qilinadi
 * (route darajasida).
 */
const regenerateInvoice = asyncHandler(async (req, res) => {
  const invoice = await invoiceService.regenerateInvoice(
    req.params.id,
    req.body.reason,
    req.user.id,
  );
  res.json({ success: true, data: invoice });
});

// ── Hisob-fakturaga tushgan to'lovlar ────────
// To'lov QABUL QILISH bu yerda emas: kassir o'quvchiga bitta summa
// kiritadi va tizim uni oylarga taqsimlaydi → `POST /api/payments`.

const getInvoicePayments = asyncHandler(async (req, res) => {
  const payments = await paymentService.getInvoiceAllocations(req.params.id, {
    includeVoided: req.query.includeVoided === "true",
  });
  res.json({ success: true, data: payments });
});

module.exports = {
  getMyFinance,
  getInvoices,
  getSummary,
  getStudentRegistry,
  getOverviewDashboard,
  getDebtors,
  exportDebtors,
  remindDebtors,
  getStudentInvoices,
  getInvoice,
  generateInvoices,
  updateInvoice,
  cancelInvoice,
  cancelInvoiceMonth,
  regenerateInvoice,
  regenerateInvoiceMonth,
  restoreInvoice,
  getInvoicePayments,
};
