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

const COLOR = {
  header: "FF7030A0", // violet — faollik bo'limining rangi
  zebra: "FFF7F5FC",
  good: "FF047857",
  warn: "FFB45309",
};

// Varaq sarlavhasi va qatorlari — umumiy `ExcelService.addTitledSheet` /
// `fillTitledRows`, faqat bo'lim ranglari bilan.
const addSheet = (workbook, config) =>
  ExcelService.addTitledSheet(workbook, { ...config, headerColor: COLOR.header });

const fillRows = (sheet, columns, rows, options = {}) =>
  ExcelService.fillTitledRows(sheet, columns, rows, { ...options, zebraColor: COLOR.zebra });

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

  await ExcelService.sendWorkbookAs(res, workbook, `bot-qamrovi_${info.name}`, {
    fallbackName: "sinf",
  });
}

module.exports = { exportClassToExcel };
