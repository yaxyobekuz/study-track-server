/**
 * YOTOQXONA DAVOMATI → EXCEL.
 *
 * Uch varaq (sukut):
 *   · "Qolganlar"      — yotoqxonada qolgan o'quvchilar ro'yxati;
 *   · "Umumiy ro'yxat" — doiradagi hamma o'quvchi, holati bilan;
 *   · "Sinflar kesimi" — qaysi sinfdan nechta qoldi + takrorsiz jami.
 *
 * Holat filtri berilsa (`?status=`) — faqat o'sha bitta ro'yxat.
 *
 * ⚠️ MA'LUMOT `dormAttendance.service.js` DAGI `loadExportData` DAN: doira
 * (o'qish davri), "qoldi" ta'rifi va sinf kesimi ekrandagi ro'yxat bilan
 * BITTA joyda hal qilinadi. Bu fayl faqat varaqlarni chizadi — ikkinchi
 * so'rov yozilsa, fayldagi raqam ekrandagidan farq qilib, odam esa aynan
 * faylga ishonib ish qilardi.
 *
 * ⚠️ "QOLGANLAR" ALOHIDA VARAQ, bitta varaqdagi filtr EMAS: fayl
 * tarbiyachiga va rahbariyatga beriladi — ular "bugun kechqurun kim bor"
 * ro'yxatini ochib, darhol ish boshlashi kerak (`studentSystemExport`
 * bilan AYNI mulohaza).
 */

const ExcelService = require("./excel.service");
const { LIST_STATUS_FILTERS, loadExportData } = require("./dormAttendance.service");
const { formatTimeUz } = require("../helpers/date.helpers");

const COLOR = {
  header: ExcelService.COLORS.HEADER_BLUE,
  zebra: "FFF3F6FC",
  present: "FF047857",
  absent: "FFB91C1C",
  excused: "FF1D4ED8",
  unmarked: "FF9CA3AF",
};

const STATUS_COLOR = {
  present: COLOR.present,
  absent: COLOR.absent,
  excused: COLOR.excused,
};

const LIST_COLUMNS = [
  { header: "№", key: "no", width: 6, align: "center" },
  { header: "O'quvchi (F.I.O)", key: "name", width: 32 },
  { header: "Login", key: "username", width: 18 },
  { header: "Sinf", key: "className", width: 20 },
  { header: "Holat", key: "statusLabel", width: 16, align: "center", status: true },
  { header: "Izoh", key: "note", width: 30 },
  { header: "Belgilangan vaqt", key: "markedTime", width: 18, align: "center" },
];

// "Qolganlar" varag'ida "Holat" ustuni ortiqcha — hammasi "Keldi"
const STAYED_COLUMNS = LIST_COLUMNS.filter((column) => column.key !== "statusLabel");

const SUMMARY_COLUMNS = [
  { header: "№", key: "no", width: 6, align: "center" },
  { header: "Sinf", key: "name", width: 26 },
  { header: "O'quvchilar", key: "total", width: 13, align: "right" },
  { header: "Qoldi", key: "present", width: 11, align: "right" },
  { header: "Kelmadi", key: "absent", width: 11, align: "right" },
  { header: "Sababli", key: "excused", width: 11, align: "right" },
  { header: "Belgilanmagan", key: "unmarked", width: 15, align: "right" },
];

const numbered = (rows) => rows.map((row, index) => ({ ...row, no: index + 1 }));

/** Holat ustuni — "Keldi" yashil, "Kelmadi" qizil, "Sababli" ko'k. */
function styleStatusCell(cell, column, row) {
  if (!column.status) return;
  cell.font = {
    bold: true,
    color: { argb: STATUS_COLOR[row.status] ?? COLOR.unmarked },
  };
}

/**
 * Chop etish: ro'yxat tarbiyachiga qog'ozda ham beriladi — ustunlar bitta
 * sahifa kengligiga sig'adi, sarlavha har sahifada takrorlanadi.
 */
function setPrintLayout(sheet) {
  sheet.pageSetup = {
    ...sheet.pageSetup,
    paperSize: 9, // A4
    orientation: "portrait",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: `${ExcelService.TITLED_HEADER_ROW}:${ExcelService.TITLED_HEADER_ROW}`,
  };
}

function subtitleOf({ dateLabel, scopeLabel, summary }) {
  return [
    dateLabel,
    scopeLabel,
    `O'quvchilar: ${summary.total}`,
    `Qoldi: ${summary.present}`,
    `Kelmadi: ${summary.absent}`,
    `Sababli: ${summary.excused}`,
    `Belgilanmagan: ${summary.unmarked}`,
  ].join(" · ");
}

/** Vaqt ustuni — instant, Toshkent devor-soatiga suriladi (`dates.md` §4). */
const withTime = (rows) =>
  rows.map((row) => ({
    ...row,
    markedTime: row.markedAt ? formatTimeUz(row.markedAt) : "—",
  }));

function addStayedSheet(workbook, data) {
  const rows = data.rows.filter((row) => row.status === "present");

  const sheet = ExcelService.addTitledSheet(workbook, {
    name: "Qolganlar",
    title: `Yotoqxonada qolganlar — ${data.dateLabel} (${rows.length} ta)`,
    subtitle: subtitleOf(data),
    columns: STAYED_COLUMNS,
    headerColor: COLOR.header,
  });
  setPrintLayout(sheet);
  ExcelService.fillTitledRows(sheet, STAYED_COLUMNS, numbered(withTime(rows)), {
    emptyText: "Bu kuni hech kim \"keldi\" deb belgilanmagan",
    zebraColor: COLOR.zebra,
  });
}

function addListSheet(workbook, data, { name, title }) {
  const sheet = ExcelService.addTitledSheet(workbook, {
    name,
    title: `${title} — ${data.dateLabel} (${data.rows.length} ta)`,
    subtitle: subtitleOf(data),
    columns: LIST_COLUMNS,
    headerColor: COLOR.header,
  });
  setPrintLayout(sheet);
  ExcelService.fillTitledRows(sheet, LIST_COLUMNS, numbered(withTime(data.rows)), {
    emptyText: "Tanlangan qamrovda o'quvchi yo'q",
    zebraColor: COLOR.zebra,
    styleCell: styleStatusCell,
  });
}

function addSummarySheet(workbook, data) {
  const sheet = ExcelService.addTitledSheet(workbook, {
    name: "Sinflar kesimi",
    title: `Sinflar kesimi — ${data.dateLabel}`,
    // ⚠️ Kesim BUTUN MAKTAB bo'yicha (sinf filtri unga tegmaydi): "qaysi
    // sinfdan nechta qoldi" degan savol sinf tanlanganda ham butun
    // manzarani so'raydi. Izohda shu ochiq yoziladi.
    subtitle: `${subtitleOf({ ...data, scopeLabel: "Butun maktab" })} · Ikki sinfdagi o'quvchi har ikki qatorda, "Jami" da bir marta sanaladi`,
    columns: SUMMARY_COLUMNS,
    headerColor: COLOR.header,
  });
  setPrintLayout(sheet);
  ExcelService.fillTitledRows(sheet, SUMMARY_COLUMNS, numbered(data.breakdown), {
    emptyText: "Maktabda bu kuni o'qiyotgan o'quvchi yo'q",
    zebraColor: COLOR.zebra,
  });

  if (data.breakdown.length === 0) return;

  // Jami — TAKRORSIZ o'quvchilar bo'yicha
  const total = { ...data.summary, name: "Jami" };
  const totalRow = sheet.addRow(SUMMARY_COLUMNS.map((column) => total[column.key] ?? ""));
  totalRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    const column = SUMMARY_COLUMNS[colNumber - 1];
    cell.font = { bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
    cell.alignment = { vertical: "middle", horizontal: column.align ?? "left" };
    cell.border = { top: { style: "thin", color: { argb: "FF9CA3AF" } } };
  });
}

const STATUS_SHEET = {
  present: { name: "Qolganlar", title: "Yotoqxonada qolganlar", file: "yotoqxona_qolganlar" },
  absent: { name: "Kelmaganlar", title: "Yotoqxonaga kelmaganlar", file: "yotoqxona_kelmaganlar" },
  excused: { name: "Sababli", title: "Sababli ketganlar", file: "yotoqxona_sababli" },
  unmarked: { name: "Belgilanmaganlar", title: "Belgilanmaganlar", file: "yotoqxona_belgilanmagan" },
};

/**
 * @param {import("express").Response} res
 * @param {Record<string, unknown>} query - `date`, `classId`, `status`
 */
async function exportDormAttendance(res, query = {}) {
  const status = LIST_STATUS_FILTERS.includes(query.status) ? query.status : null;
  const data = await loadExportData({
    date: query.date,
    classId: query.classId,
    status,
  });

  const workbook = ExcelService.createWorkbook();

  if (status) {
    const sheet = STATUS_SHEET[status];
    // "Qolganlar" uchun holat ustuni ortiqcha — hammasi bir xil
    if (status === "present") addStayedSheet(workbook, data);
    else addListSheet(workbook, data, sheet);
  } else {
    addStayedSheet(workbook, data);
    addListSheet(workbook, data, { name: "Umumiy ro'yxat", title: "Yotoqxona davomati" });
    addSummarySheet(workbook, data);
  }

  // Fayl nomida KUN va QAMROV turadi: tarbiyachi "9-A" dan keyin "10-A" ni
  // yuklab olganda ikkinchi fayl birinchisining ustiga tushmasligi kerak
  // ("yotoqxona_davomati_26-oktabr-2026_9-A_2026-10-26.xlsx" — oxirgi sana
  // yuklab olingan kun, `sendWorkbookAs` qo'yadi; `expenseExport` bilan
  // AYNI naqsh). Vergul olib tashlanadi — fayl nomida u ortiqcha.
  const parts = [
    status ? STATUS_SHEET[status].file : "yotoqxona_davomati",
    data.dateLabel.replace(", ", "-"),
    ...(data.scopeLabel === "Butun maktab" ? [] : [data.scopeLabel]),
  ];

  await ExcelService.sendWorkbookAs(res, workbook, parts.join("_"), {
    fallbackName: "yotoqxona",
  });
}

module.exports = { exportDormAttendance };
