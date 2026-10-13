/**
 * CHIQIMLAR → EXCEL.
 *
 * ⚠️ QATORLAR `getExpenses` DAN OLINADI, bu yerda qayta yig'ilmaydi.
 * Fayl ekrandagi registrning NUSXASI bo'lishi kerak: ikkinchi yig'uvchi
 * yozilsa, "xarajat + to'langan oylik" birlashuvi yoki bekor qilinganni
 * sanash qoidasi bir kuni ikki joyda ikki xil bo'lib, faylda ekrandagidan
 * boshqa summa chiqardi (`activityExport.service.js` bilan bir xil sabab).
 *
 * ⚠️ SAHIFALASH CHETLAB O'TILADI, filtr esa O'TILMAYDI. Foydalanuvchi
 * 20 qatorlik sahifani emas, FILTRGA TUSHGAN HAMMA yozuvni kutadi —
 * shuning uchun `limit` katta qilib beriladi, `categoryId`/`accountId`/
 * `from`/`to` esa ekrandagidek uzatiladi.
 *
 * ⚠️ PUL MATN EMAS, SON bo'lib yoziladi (`numFmt` bilan ko'rinish
 * beriladi): Excel'da ustunni yig'ish va saralash kerak bo'ladi, string
 * ustunda bu imkonsiz. Lekin SUMMA ISHORASI — manfiy emas: registr
 * chiqimlar ro'yxati, har bir qator allaqachon "chiqim" degani
 * (daftardagi manfiy qator — `AccountEntry`, bu esa hujjatlar ro'yxati).
 */

const expenseService = require("./expense.service");
const ExcelService = require("./excel.service");
const { formatDateUz, formatDateTimeUz } = require("../helpers/date.helpers");
// Sarlavha matni ODAMGA ketadi → `formatSum` ("5 750 000 so'm"),
// `formatAmount` emas: u API maydoni uchun ("5750000.00")
const { formatSum } = require("../helpers/money.helpers");

// Chiqim bo'limining rangi — kirim (yashil) dan farqli, to'q sariq
const COLOR = {
  header: "FFED7D31",
  zebra: "FFFDF4EC",
  total: "FFFEF3C7",
  voided: "FF9CA3AF",
  salary: "FF4F46E5",
  text: "FF1F2937",
};

const MONEY_FMT = "#,##0";

/**
 * Ro'yxatning HAMMASI — sahifasiz.
 *
 * ⚠️ `getExpenses` sahifalashni ENG OXIRIDA qo'llaydi (butun ro'yxatni
 * yig'ib, so'ng `slice`), shuning uchun katta `limit` bermoq — qatorlarni
 * to'liq olishning yagona yo'li va u hech qanday qo'shimcha so'rov
 * yaratmaydi.
 */
const EXPORT_LIMIT = 100000;

const fetchAllRows = async (query) => {
  const data = await expenseService.getExpenses({
    query: { ...query, page: "1", limit: String(EXPORT_LIMIT) },
  });

  return { rows: data.data ?? [], totals: data.totals ?? null };
};

/**
 * Sarlavha ostidagi izoh — fayl bosib chiqarilganda "bu qaysi ro'yxat"
 * degan savolga javob SHU qator. Filtr nomlari ID emas, NOM bilan
 * yoziladi: fayl boshqa odamga yuborilganda ID hech narsa demaydi.
 */
const buildSubtitle = ({ totals, rowCount, categoryName, accountName, from, to, includeVoided }) => {
  const parts = [];

  if (from || to) {
    parts.push(
      `Davr: ${from ? formatDateUz(from, { utc: true }) : "boshidan"} — ` +
        `${to ? formatDateUz(to, { utc: true }) : "hozirgacha"}`,
    );
  } else {
    parts.push("Davr: butun tarix");
  }

  if (categoryName) parts.push(`Kategoriya: ${categoryName}`);
  if (accountName) parts.push(`To'lov turi: ${accountName}`);

  parts.push(`Yozuv: ${rowCount} ta`);

  if (totals) {
    // ⚠️ JAMI `getExpenses` DAN — bu yerda qayta qo'shilmaydi: ekranda
    // turgan raqam bilan faylniki bir xil bo'lishi SHU bilan kafolatlanadi
    parts.push(`Jami chiqim: ${formatSum(totals.amount)}`);
    if (includeVoided) parts.push("(bekor qilinganlar jamiga kirmaydi)");
  }

  parts.push(`Yuklandi: ${formatDateTimeUz(new Date())}`);

  return parts.join(" · ");
};

/**
 * CHIQIMLAR REGISTRI → EXCEL.
 *
 * @param {import("express").Response} res
 * @param {object} query - ekrandagi filtrlar (`req.query`) o'zgarishsiz
 * @param {{categoryName?: string, accountName?: string}} [labels] - filtr nomlari
 */
async function exportExpensesToExcel(res, query = {}, labels = {}) {
  const { rows, totals } = await fetchAllRows(query);

  const columns = [
    { header: "№", key: "no", width: 6, align: "center" },
    { header: "Sana", key: "date", width: 18 },
    { header: "Turi", key: "kind", width: 12, align: "center" },
    { header: "Kategoriya", key: "categoryName", width: 24 },
    { header: "Kimga", key: "payee", width: 24 },
    { header: "To'lov turi", key: "accountName", width: 20 },
    { header: "Izoh", key: "note", width: 32 },
    { header: "Summa", key: "amount", width: 18, align: "right" },
    { header: "Holat", key: "status", width: 16, align: "center" },
    { header: "Bekor qilish sababi", key: "voidReason", width: 28 },
  ];

  const workbook = ExcelService.createWorkbook();
  const sheet = ExcelService.addTitledSheet(workbook, {
    name: "Chiqimlar",
    title: "Chiqimlar registri",
    subtitle: buildSubtitle({
      totals,
      rowCount: rows.length,
      categoryName: labels.categoryName,
      accountName: labels.accountName,
      from: query.from,
      to: query.to,
      includeVoided: query.includeVoided === "true",
    }),
    columns,
    headerColor: COLOR.header,
  });

  ExcelService.fillTitledRows(
    sheet,
    columns,
    rows.map((row, index) => ({
      no: index + 1,
      date: formatDateUz(row.occurredAt),
      // "Oylik" — xarajat EMAS, to'langan oylik (ro'yxatda birga ko'rinadi).
      // Faylda ham ajratilgan bo'lishi kerak: aks holda "kommunal xarajat"
      // bilan "xodim oyligi" bitta ustunda aralashib ketardi.
      kind: row.kind === "salary" ? "Oylik" : "Xarajat",
      categoryName: row.categoryName ?? "—",
      payee: row.payee || "—",
      accountName: row.accountName ?? "—",
      note: row.note || "—",
      amount: Number(row.amount),
      status: row.isVoided ? "Bekor qilingan" : "Amalda",
      voidReason: row.voidReason || "—",
      // Stil uchun xom bayroqlar
      isVoided: row.isVoided,
      isSalary: row.kind === "salary",
    })),
    {
      emptyText: "Tanlangan filtr bo'yicha chiqim topilmadi",
      zebraColor: COLOR.zebra,
      styleCell: (cell, column, row) => {
        if (column.key === "amount") cell.numFmt = MONEY_FMT;

        // Bekor qilingan qator butunlay so'nadi — "amalda" yozuvlar bilan
        // bir xil ko'rinsa, fayl o'qigan odam ularni ham qo'shib hisoblardi
        if (row.isVoided) {
          cell.font = { color: { argb: COLOR.voided }, strike: column.key === "amount" };
          return;
        }

        if (column.key === "kind" && row.isSalary) {
          cell.font = { bold: true, color: { argb: COLOR.salary } };
        }
        if (column.key === "amount") {
          cell.font = { bold: true, color: { argb: COLOR.text } };
        }
      },
    },
  );

  // ── JAMI qatori ──────────────────────────────────────────────────────
  // ⚠️ Faqat qatorlar bo'lsa. Bo'sh ro'yxatda `fillTitledRows` izoh
  // qatorini yozadi va uning ostiga "JAMI: 0" qo'shilsa, u izohni
  // ma'lumot deb ko'rsatib qo'yardi.
  if (rows.length && totals) {
    const totalRow = sheet.addRow(
      columns.map((column) => {
        if (column.key === "note") return "JAMI (bekor qilinganlarsiz):";
        if (column.key === "amount") return Number(totals.amount);
        if (column.key === "status") return `${totals.count} ta`;
        return null;
      }),
    );

    totalRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const column = columns[colNumber - 1];
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.total } };
      if (cell.value == null) return;
      cell.font = { bold: true, color: { argb: COLOR.text } };
      cell.alignment = {
        vertical: "middle",
        horizontal: column.key === "note" ? "right" : (column.align ?? "left"),
      };
      if (column.key === "amount") cell.numFmt = MONEY_FMT;
    });
  }

  await ExcelService.sendWorkbookAs(res, workbook, "chiqimlar", {
    fallbackName: "chiqimlar",
  });
}

module.exports = { exportExpensesToExcel };
