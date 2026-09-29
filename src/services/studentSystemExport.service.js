/**
 * ERP VA KUNDALIK.COM → EXCEL.
 *
 * Qamrov: butun maktab yoki tanlangan sinflar. Ro'yxat:
 *   · `all` — to'liq hisobot: umumiy ro'yxat, to'rtta "bor / yo'q" ro'yxati
 *     (har biri ALOHIDA varaqda) va sinflar kesimi;
 *   · `erp_yes` / `erp_no` / `kundalik_yes` / `kundalik_no` — bitta ro'yxat.
 *
 * ⚠️ Ma'lumot `studentSystem.service.js` dagi `loadExportData` dan —
 * "bor / yo'q" ta'rifi va qamrov ekrandagi ro'yxat bilan bitta joyda.
 * Bu fayl faqat varaqlarni chizadi.
 *
 * ⚠️ "Bor / yo'q" ro'yxatlari alohida VARAQ, bitta varaqda filtr EMAS:
 * fayl tashqi tizimga kirituvchi odamga beriladi va u "ERP da yo'q"
 * ro'yxatini ochib, darhol ish boshlashi kerak.
 */

const ExcelService = require("./excel.service");
const {
  SYSTEMS,
  SYSTEM_LABELS,
  EXPORT_LISTS,
  EXPORT_SCOPES,
  parseExportQuery,
  loadExportData,
} = require("./studentSystem.service");
const { formatDateTimeUz } = require("../helpers/date.helpers");

const COLOR = {
  header: ExcelService.COLORS.HEADER_BLUE,
  zebra: "FFF3F6FC",
  yes: "FF047857",
  no: "FFB91C1C",
};

// Sarlavhada sinf nomlari shu songacha sanaladi, ko'pi "N ta sinf" bo'ladi
const SCOPE_NAMES_MAX = 4;

const STATUS_TEXT = { true: "Bor", false: "Yo'q" };

const BASE_COLUMNS = [
  { header: "№", key: "no", width: 6, align: "center" },
  { header: "O'quvchi (F.I.O)", key: "name", width: 34 },
  { header: "Sinf", key: "classNames", width: 24 },
];

const STATUS_COLUMNS = SYSTEMS.map((system) => ({
  header: SYSTEM_LABELS[system],
  key: system,
  width: 15,
  align: "center",
  status: true,
}));

const SUMMARY_COLUMNS = [
  { header: "№", key: "no", width: 6, align: "center" },
  { header: "Sinf", key: "name", width: 26 },
  { header: "O'quvchilar", key: "students", width: 13, align: "right" },
  // Kenglik sarlavhadan: "Kundalik.com da yo'q" ikki qatorga bo'linib kesilmasin
  ...SYSTEMS.flatMap((system) =>
    [
      { header: `${SYSTEM_LABELS[system]} da bor`, key: `${system}Yes` },
      { header: `${SYSTEM_LABELS[system]} da yo'q`, key: `${system}No` },
    ].map((column) => ({ ...column, width: Math.max(13, column.header.length + 4), align: "right" })),
  ),
];

/** "Bor" — yashil, "Yo'q" — qizil. */
function styleStatusCell(cell, column, row) {
  if (!column.status) return;
  cell.value = STATUS_TEXT[row[column.key]];
  cell.font = { bold: true, color: { argb: row[column.key] ? COLOR.yes : COLOR.no } };
}

const numbered = (rows) => rows.map((row, index) => ({ ...row, no: index + 1 }));

/**
 * Chop etish: ro'yxat sinf rahbariga qog'ozda ham beriladi — barcha ustunlar
 * bitta sahifa kengligiga sig'adi (oxirgi ustun keyingi varaqqa tushmaydi),
 * sarlavha qatori har sahifada takrorlanadi.
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

function scopeLabel({ scope, classes }) {
  if (scope === EXPORT_SCOPES.SCHOOL) return "butun maktab";
  if (classes.length <= SCOPE_NAMES_MAX) return classes.map((cls) => cls.name).join(", ");
  return `${classes.length} ta sinf`;
}

function fileScopePart({ scope, classes }) {
  if (scope === EXPORT_SCOPES.SCHOOL) return "butun_maktab";
  if (classes.length === 1) return classes[0].name;
  return `${classes.length}_ta_sinf`;
}

function subtitleOf(totals) {
  const parts = [
    `Holat: ${formatDateTimeUz(new Date())}`,
    `O'quvchilar: ${totals.students}`,
    ...SYSTEMS.map((system) => {
      const { yes, no } = totals.systems[system];
      return `${SYSTEM_LABELS[system]}: ${yes} bor, ${no} yo'q`;
    }),
  ];
  return parts.join(" · ");
}

/** Bitta "bor / yo'q" ro'yxati varag'i. */
function addListSheet(workbook, listKey, { rows, label, subtitle }) {
  const list = EXPORT_LISTS[listKey];
  const listRows = rows.filter((row) => row[list.system] === list.present);

  const sheet = ExcelService.addTitledSheet(workbook, {
    name: list.sheet,
    title: `${list.title} — ${label} (${listRows.length} ta)`,
    subtitle,
    columns: BASE_COLUMNS,
    headerColor: COLOR.header,
  });
  setPrintLayout(sheet);
  ExcelService.fillTitledRows(sheet, BASE_COLUMNS, numbered(listRows), {
    emptyText: list.emptyText,
    zebraColor: COLOR.zebra,
  });
}

/** Umumiy ro'yxat — har o'quvchi, ikkala tizim holati bilan. */
function addOverviewSheet(workbook, { rows, label, subtitle }) {
  const columns = [...BASE_COLUMNS, ...STATUS_COLUMNS];
  const sheet = ExcelService.addTitledSheet(workbook, {
    name: "Umumiy ro'yxat",
    title: `ERP va Kundalik.com — ${label} (${rows.length} ta o'quvchi)`,
    subtitle,
    columns,
    headerColor: COLOR.header,
  });
  setPrintLayout(sheet);
  ExcelService.fillTitledRows(sheet, columns, numbered(rows), {
    emptyText: "Tanlangan qamrovda o'quvchi yo'q",
    zebraColor: COLOR.zebra,
    styleCell: styleStatusCell,
  });
}

/** Sinflar kesimi + oxirida takrorsiz jami. */
function addSummarySheet(workbook, { classSummary, totals, label, subtitle }) {
  const flatten = (item) => ({
    name: item.name,
    students: item.students,
    ...Object.fromEntries(
      SYSTEMS.flatMap((system) => [
        [`${system}Yes`, item.systems[system].yes],
        [`${system}No`, item.systems[system].no],
      ]),
    ),
  });

  const sheet = ExcelService.addTitledSheet(workbook, {
    name: "Sinflar kesimi",
    title: `Sinflar kesimi — ${label}`,
    subtitle,
    columns: SUMMARY_COLUMNS,
    headerColor: COLOR.header,
  });
  setPrintLayout(sheet);
  ExcelService.fillTitledRows(sheet, SUMMARY_COLUMNS, numbered(classSummary.map(flatten)), {
    emptyText: "Tanlangan qamrovda o'quvchi yo'q",
    zebraColor: COLOR.zebra,
  });

  if (classSummary.length === 0) return;

  // Jami — takrorsiz o'quvchilar (ikki sinfdagi o'quvchi ikki marta sanalmaydi)
  const total = { ...flatten(totals), name: "Jami" };
  const totalRow = sheet.addRow(SUMMARY_COLUMNS.map((column) => total[column.key] ?? ""));
  totalRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    const column = SUMMARY_COLUMNS[colNumber - 1];
    cell.font = { bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
    cell.alignment = { vertical: "middle", horizontal: column.align ?? "left" };
    cell.border = { top: { style: "thin", color: { argb: "FF9CA3AF" } } };
  });
}

/**
 * @param {import("express").Response} res
 * @param {Record<string, unknown>} query - `list`, `scope`, `classIds`
 */
async function exportStudentSystems(res, query) {
  const params = parseExportQuery(query);
  const { rows, totals, classSummary, classes } = await loadExportData(params);

  const context = {
    rows,
    totals,
    classSummary,
    label: scopeLabel({ scope: params.scope, classes }),
    subtitle: subtitleOf(totals),
  };

  const workbook = ExcelService.createWorkbook();

  if (params.list === "all") {
    addOverviewSheet(workbook, context);
    for (const listKey of Object.keys(EXPORT_LISTS)) {
      if (listKey !== "all") addListSheet(workbook, listKey, context);
    }
    addSummarySheet(workbook, context);
  } else {
    addListSheet(workbook, params.list, context);
  }

  const baseName = `${EXPORT_LISTS[params.list].fileName}_${fileScopePart({ scope: params.scope, classes })}`;
  await ExcelService.sendWorkbookAs(res, workbook, baseName, { fallbackName: "sinf" });
}

module.exports = { exportStudentSystems };
