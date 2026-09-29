/**
 * FAOLLIK → EXCEL.
 *
 * Bitta sinfning bot qamrovi: kim botga bog'langan (va undan
 * foydalanadimi), kim umuman bog'lanmagan. Fayl sinf rahbariga beriladi —
 * u ro'yxat bo'yicha ota-onalarga qo'ng'iroq qiladi.
 *
 * ⚠️ QATORLAR `getClass` DAN OLINADI, bu yerda qayta hisoblanmaydi.
 * Excel modalning NUSXASI bo'lishi kerak: ikkinchi yig'uvchi yozilsa,
 * "faol" ta'rifi yoki sinfga biriktirish qoidasi bir kuni ikki joyda
 * ikki xil bo'lib, faylda ekrandagidan boshqa odamlar chiqardi.
 * Faylga qo'shiladigan yagona narsa — telefon va login: ular modalda
 * kerak emas, qo'ng'iroq qilish uchun esa aynan shular kerak.
 *
 * ⚠️ IKKI VARAQ, bitta varaqda aralash ro'yxat EMAS. Ikki ro'yxat bilan
 * ikki xil ish qilinadi: bog'lanmaganlarga havola beriladi, bog'langan-u
 * jim turganlarga esa eslatiladi. Har varaqning sarlavhasida ikkala son
 * ham turadi — ikkinchi varaq borligi ko'zdan qochmasin.
 */

const prisma = require("../config/prisma");
const ExcelService = require("./excel.service");
const activityDashboard = require("./activityDashboard.service");
const { getTashkentDateUtc } = require("../helpers/date.helpers");

const BORDER = { style: "thin", color: { argb: "FFE5E7EB" } };
const HEADER_ROW = 4;

const COLOR = {
  title: "FF1F2937",
  sub: "FF6B7280",
  header: "FF7030A0", // violet — faollik bo'limining rangi
  zebra: "FFF7F5FC",
  good: "FF047857",
  warn: "FFB45309",
  muted: "FF9CA3AF",
};

/**
 * Sarlavha bloki (2 qator) + ustun sarlavhalari (4-qator) bilan varaq.
 *
 * @param {import("exceljs").Workbook} workbook
 * @param {object} config
 * @returns {import("exceljs").Worksheet}
 */
function addSheet(workbook, { name, title, subtitle, columns }) {
  const sheet = ExcelService.addWorksheet(workbook, name, { freezeHeader: false });

  columns.forEach((column, index) => {
    sheet.getColumn(index + 1).width = column.width;
  });

  sheet.mergeCells(1, 1, 1, columns.length);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { bold: true, size: 14, color: { argb: COLOR.title } };
  titleCell.alignment = { vertical: "middle", horizontal: "left" };
  sheet.getRow(1).height = 26;

  sheet.mergeCells(2, 1, 2, columns.length);
  const subCell = sheet.getCell(2, 1);
  subCell.value = subtitle;
  subCell.font = { size: 11, color: { argb: COLOR.sub } };
  sheet.getRow(2).height = 20;

  const headerRow = sheet.getRow(HEADER_ROW);
  headerRow.values = columns.map((column) => column.header);
  headerRow.height = 22;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.header } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
  });

  sheet.views = [{ state: "frozen", ySplit: HEADER_ROW }];

  return sheet;
}

/**
 * Ma'lumot qatorlari. Bo'sh ro'yxatda bitta izoh qatori yoziladi —
 * faqat sarlavhadan iborat varaq "fayl buzilgan" deb o'qilardi.
 */
function fillRows(sheet, columns, rows, { emptyText, styleCell } = {}) {
  if (rows.length === 0) {
    const index = HEADER_ROW + 1;
    sheet.mergeCells(index, 1, index, columns.length);
    const cell = sheet.getCell(index, 1);
    cell.value = emptyText;
    cell.font = { italic: true, color: { argb: COLOR.muted } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    return;
  }

  rows.forEach((row, rowIndex) => {
    const excelRow = sheet.addRow(columns.map((column) => row[column.key] ?? ""));

    if (rowIndex % 2 === 1) {
      excelRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.zebra } };
    }

    excelRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const column = columns[colNumber - 1];
      cell.border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
      cell.alignment = {
        vertical: "middle",
        horizontal: column.align ?? "left",
      };
      styleCell?.(cell, column, row);
    });
  });

  sheet.autoFilter = {
    from: { row: HEADER_ROW, column: 1 },
    to: { row: HEADER_ROW, column: columns.length },
  };
}

/**
 * `Content-Disposition` — ASCII zaxira nom + UTF-8 asl nom (RFC 5987).
 *
 * ⚠️ Sinf nomi kirillcha yoki apostrofli bo'lishi mumkin ("1-sinf
 * o'zbek"). Node sarlavhada 255 dan katta belgini rad etadi (500),
 * qo'shtirnoqsiz nomda esa bo'shliqdan keyingisi yo'qolardi. Admin paneli `filename*` ni
 * birinchi o'qiydi (`downloadBlob`).
 */
async function sendWithName(res, workbook, baseName) {
  const day = getTashkentDateUtc().toISOString().slice(0, 10);
  const utf8Name = `${baseName}_${day}.xlsx`;
  const asciiName =
    `${baseName.normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/_-+|-+_/g, "_").replace(/^-+|-+$/g, "") || "sinf"}_${day}.xlsx`;
  const encoded = encodeURIComponent(utf8Name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`,
  );

  await workbook.xlsx.write(res);
  res.end();
}

/**
 * SINF BOT QAMROVI → EXCEL.
 *
 * @param {import("express").Response} res
 * @param {string} classId
 * @param {{ days?: number|string }} params - modal bilan AYNI davr
 */
async function exportClassToExcel(res, classId, { days } = {}) {
  const data = await activityDashboard.getClass(classId, { days });

  const info = data.class;
  const parents = data.parents ?? [];
  const unlinked = data.unlinked ?? [];

  const studentIds = [
    ...new Set([...parents.map((row) => row.studentId), ...unlinked.map((row) => row.id)]),
  ];
  const contacts = studentIds.length
    ? await prisma.user.findMany({
        where: { id: { in: studentIds } },
        select: { id: true, username: true, phone: true, parentPhone: true },
      })
    : [];
  const contactOf = new Map(contacts.map((user) => [user.id, user]));

  const subtitle =
    `${data.period.rangeLabel} · O'quvchi: ${info.students ?? 0}` +
    ` · Bog'langan: ${info.linkedStudents ?? 0}` +
    ` · Bog'lanmagan: ${unlinked.length}` +
    ` · Foydalanadi: ${info.active ?? 0} / ${info.linked ?? 0}`;

  const workbook = ExcelService.createWorkbook();

  /* ── 1. Bog'langanlar ─────────────────────────────────────────── */
  // ⚠️ Qator — ota-onaning TELEGRAM HISOBI, o'quvchi emas: bitta
  // o'quvchida ona va ota alohida bog'lanishi mumkin (modal bilan AYNI).
  const linkedColumns = [
    { header: "№", key: "no", width: 6, align: "center" },
    { header: "O'quvchi", key: "studentName", width: 28 },
    { header: "Ota-ona (Telegram)", key: "contactName", width: 26 },
    { header: "Ota-ona telefoni", key: "parentPhone", width: 18 },
    { header: "Holat", key: "status", width: 18, align: "center" },
    { header: "Faol kunlar", key: "days", width: 12, align: "right" },
    { header: "Harakatlar", key: "events", width: 12, align: "right" },
    { header: "Oxirgi kirish", key: "lastSeen", width: 20 },
    { header: "Bog'langan sana", key: "linkedAt", width: 18 },
    { header: "Bildirishnoma", key: "notifications", width: 15, align: "center" },
  ];

  const linkedSheet = addSheet(workbook, {
    name: "Bog'langanlar",
    title: `${info.name} — botga bog'langan ota-onalar`,
    subtitle,
    columns: linkedColumns,
  });

  fillRows(
    linkedSheet,
    linkedColumns,
    parents.map((row, index) => ({
      no: index + 1,
      studentName: row.studentName,
      contactName: row.contactName,
      parentPhone: contactOf.get(row.studentId)?.parentPhone || "—",
      status: row.active ? "Foydalanadi" : "Foydalanmayapti",
      active: row.active,
      days: row.days ?? 0,
      events: row.events ?? 0,
      lastSeen: row.lastSeenLabel || "Hech qachon",
      linkedAt: row.linkedLabel || "—",
      notifications: row.notificationsEnabled === false ? "O'chirilgan" : "Yoqilgan",
      notificationsOff: row.notificationsEnabled === false,
    })),
    {
      emptyText: "Bu sinfda botga bog'langan ota-ona yo'q",
      styleCell: (cell, column, row) => {
        if (column.key === "status") {
          cell.font = { bold: true, color: { argb: row.active ? COLOR.good : COLOR.warn } };
        }
        if (column.key === "notifications" && row.notificationsOff) {
          cell.font = { color: { argb: COLOR.warn } };
        }
      },
    },
  );

  /* ── 2. Bog'lanmaganlar ───────────────────────────────────────── */
  const unlinkedColumns = [
    { header: "№", key: "no", width: 6, align: "center" },
    { header: "O'quvchi", key: "name", width: 28 },
    { header: "Login", key: "username", width: 18 },
    { header: "Ota-ona telefoni", key: "parentPhone", width: 18 },
    { header: "O'quvchi telefoni", key: "phone", width: 18 },
  ];

  const unlinkedSheet = addSheet(workbook, {
    name: "Bog'lanmaganlar",
    title: `${info.name} — botga bog'lanmagan o'quvchilar`,
    subtitle,
    columns: unlinkedColumns,
  });

  fillRows(
    unlinkedSheet,
    unlinkedColumns,
    unlinked.map((row, index) => {
      const contact = contactOf.get(row.id);
      return {
        no: index + 1,
        name: row.name,
        username: contact?.username || "—",
        parentPhone: contact?.parentPhone || "—",
        phone: contact?.phone || "—",
      };
    }),
    { emptyText: "Bu sinfning hamma o'quvchisi botga bog'langan" },
  );

  await sendWithName(res, workbook, `bot-qamrovi_${info.name}`);
}

module.exports = { exportClassToExcel };
