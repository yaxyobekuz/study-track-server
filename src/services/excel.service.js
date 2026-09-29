const ExcelJS = require("exceljs");
const { getTashkentDateUtc } = require("../helpers/date.helpers");

/**
 * Excel Service - Excel fayllarni yaratish uchun yordamchi service
 */
class ExcelService {
  /**
   * Yangi workbook yaratish
   * @param {Object} options - Workbook opsiyalari
   * @param {string} options.creator - Yaratuvchi nomi
   * @returns {ExcelJS.Workbook}
   */
  static createWorkbook(options = {}) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = options.creator || "MBSI School";
    workbook.created = new Date();
    return workbook;
  }

  /**
   * Worksheet yaratish va sozlash
   * @param {ExcelJS.Workbook} workbook - Workbook
   * @param {string} sheetName - Sheet nomi
   * @param {Object} options - Worksheet opsiyalari
   * @param {boolean} options.freezeHeader - Birinchi qatorni muzlatish
   * @returns {ExcelJS.Worksheet}
   */
  static addWorksheet(workbook, sheetName, options = {}) {
    const worksheetOptions = {};

    if (options.freezeHeader !== false) {
      worksheetOptions.views = [{ state: "frozen", ySplit: 1 }];
    }

    return workbook.addWorksheet(sheetName, worksheetOptions);
  }

  /**
   * Ustunlarni sozlash
   * @param {ExcelJS.Worksheet} worksheet - Worksheet
   * @param {Array} columns - Ustunlar ro'yxati [{header, key, width}]
   */
  static setColumns(worksheet, columns) {
    worksheet.columns = columns;
  }

  /**
   * Header stilini qo'llash
   * @param {ExcelJS.Worksheet} worksheet - Worksheet
   * @param {Object} options - Stil opsiyalari
   * @param {string} options.bgColor - Fon rangi (ARGB)
   * @param {string} options.textColor - Matn rangi (ARGB)
   * @param {number} options.height - Qator balandligi
   */
  static styleHeader(worksheet, options = {}) {
    const { bgColor = "6366f2", textColor = "FFFFFFFF", height = 25 } = options;

    const headerRow = worksheet.getRow(1);

    headerRow.font = {
      bold: true,
      color: { argb: textColor },
      size: 12,
    };

    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: bgColor },
    };

    headerRow.alignment = {
      vertical: "middle",
      horizontal: "center",
    };

    headerRow.height = height;

    // Border qo'shish
    headerRow.eachCell((cell) => {
      cell.border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      };
    });
  }

  /**
   * Ma'lumot qatorlarini qo'shish
   * @param {ExcelJS.Worksheet} worksheet - Worksheet
   * @param {Array} data - Ma'lumotlar massivi
   * @param {Object} options - Stil opsiyalari
   * @param {boolean} options.alternateRows - Qatorlarni navbatma-navbat ranglash
   * @param {string} options.alternateBgColor - Alernate qator rangi
   * @param {string} options.borderColor - Border rangi
   */
  static addRows(worksheet, data, options = {}) {
    const {
      alternateRows = true,
      alternateBgColor = "FFF2F2F2", // Och kulrang
      borderColor = "FFD0D0D0",
    } = options;

    data.forEach((rowData, index) => {
      const row = worksheet.addRow(rowData);

      // Alternate row rangi
      if (alternateRows && index % 2 === 0) {
        row.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: alternateBgColor },
        };
      }

      // Border va alignment
      row.eachCell((cell) => {
        cell.border = {
          top: { style: "thin", color: { argb: borderColor } },
          left: { style: "thin", color: { argb: borderColor } },
          bottom: { style: "thin", color: { argb: borderColor } },
          right: { style: "thin", color: { argb: borderColor } },
        };
        cell.alignment = { vertical: "middle" };
      });
    });
  }

  /**
   * Auto-filter qo'shish
   * @param {ExcelJS.Worksheet} worksheet - Worksheet
   * @param {number} columnCount - Ustunlar soni
   */
  static addAutoFilter(worksheet, columnCount) {
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: columnCount },
    };
  }

  /**
   * Response headers sozlash va faylni yuborish
   * @param {Object} res - Express response
   * @param {ExcelJS.Workbook} workbook - Workbook
   * @param {string} filename - Fayl nomi
   */
  static async sendWorkbook(res, workbook, filename) {
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

    await workbook.xlsx.write(res);
    res.end();
  }

  /**
   * Fayl nomini sana bilan generatsiya qilish
   * @param {string} baseName - Asosiy nom
   * @param {string} extension - Fayl kengaytmasi
   * @returns {string}
   */
  static generateFileName(baseName, extension = "xlsx") {
    const today = new Date().toISOString().split("T")[0];
    return `${baseName}_${today}.${extension}`;
  }

  /**
   * Tayyor Excel fayl yaratish (soddalashtirilgan metod)
   * @param {Object} config - Konfiguratsiya
   * @param {string} config.sheetName - Sheet nomi
   * @param {Array} config.columns - Ustunlar [{header, key, width}]
   * @param {Array} config.data - Ma'lumotlar
   * @param {Object} config.headerStyle - Header stil opsiyalari
   * @param {Object} config.rowStyle - Qator stil opsiyalari
   * @returns {ExcelJS.Workbook}
   */
  static createExcel(config) {
    const workbook = this.createWorkbook();
    this.addSheet(workbook, config);
    return workbook;
  }

  /**
   * Mavjud workbook'ga tayyor (stil berilgan) varaq qo'shadi — bir faylda
   * bir nechta sheet kerak bo'lganda (masalan "O'quvchilar" + "Qarzdorlar").
   *
   * @param {ExcelJS.Workbook} workbook
   * @param {Object} config - { sheetName, columns, data, headerStyle, rowStyle }
   * @returns {ExcelJS.Worksheet}
   */
  static addSheet(workbook, config) {
    const {
      sheetName = "Sheet1",
      columns = [],
      data = [],
      headerStyle = {},
      rowStyle = {},
    } = config;

    const worksheet = this.addWorksheet(workbook, sheetName);
    this.setColumns(worksheet, columns);
    this.styleHeader(worksheet, headerStyle);
    this.addRows(worksheet, data, rowStyle);
    this.addAutoFilter(worksheet, columns.length);

    return worksheet;
  }

  /**
   * SARLAVHALI VARAQ — hisobot ko'rinishi: 1-qator sarlavha, 2-qator izoh
   * (sanoqlar, davr), 4-qator ustun sarlavhalari. Qatorlar `fillTitledRows`
   * bilan to'ldiriladi.
   *
   * ⚠️ Sarlavha va izoh faylning O'ZIDA turishi shart: varaq chop etilganda
   * yoki boshqa odamga yuborilganda "bu qaysi sinf, qaysi holat" degan
   * savolga javob faqat shu qatorlar.
   *
   * @param {ExcelJS.Workbook} workbook
   * @param {object} config
   * @param {string} config.name - varaq nomi (≤ 31 belgi)
   * @param {string} config.title
   * @param {string} config.subtitle
   * @param {Array<{header: string, key: string, width: number, align?: string}>} config.columns
   * @param {string} [config.headerColor] - ustun sarlavhasi foni (ARGB)
   * @returns {ExcelJS.Worksheet}
   */
  static addTitledSheet(
    workbook,
    { name, title, subtitle, columns, headerColor = TITLED.header },
  ) {
    const sheet = this.addWorksheet(workbook, name, { freezeHeader: false });

    columns.forEach((column, index) => {
      sheet.getColumn(index + 1).width = column.width;
    });

    sheet.mergeCells(1, 1, 1, columns.length);
    const titleCell = sheet.getCell(1, 1);
    titleCell.value = title;
    titleCell.font = { bold: true, size: 14, color: { argb: TITLED.title } };
    titleCell.alignment = { vertical: "middle", horizontal: "left" };
    sheet.getRow(1).height = 26;

    // Tor varaqda (3-4 ustun) uzun sarlavha birlashtirilgan katakdan
    // sig'maydi va Excel uni KESIB tashlaydi (qo'shni katakka o'tmaydi) —
    // shunday bo'lsa matn qatorga o'raladi va qator balandlashadi.
    const capacity = columns.reduce((sum, column) => sum + (column.width ?? 10), 0);
    wrapIfOverflow(sheet, 1, { text: title, capacity, charWidth: 1.4, lineHeight: 20 });

    sheet.mergeCells(2, 1, 2, columns.length);
    const subCell = sheet.getCell(2, 1);
    subCell.value = subtitle;
    subCell.font = { size: 11, color: { argb: TITLED.sub } };
    sheet.getRow(2).height = 20;
    wrapIfOverflow(sheet, 2, { text: subtitle, capacity, charWidth: 1.05, lineHeight: 15 });

    const headerRow = sheet.getRow(TITLED_HEADER_ROW);
    headerRow.values = columns.map((column) => column.header);
    headerRow.height = 22;
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: headerColor } };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border = { top: TITLED_BORDER, left: TITLED_BORDER, bottom: TITLED_BORDER, right: TITLED_BORDER };
    });

    sheet.views = [{ state: "frozen", ySplit: TITLED_HEADER_ROW }];

    return sheet;
  }

  /**
   * `addTitledSheet` varag'ining ma'lumot qatorlari.
   *
   * ⚠️ Bo'sh ro'yxatda bitta izoh qatori yoziladi — faqat sarlavhadan
   * iborat varaq "fayl buzilgan" deb o'qilardi.
   *
   * @param {ExcelJS.Worksheet} sheet
   * @param {Array<{key: string, align?: string}>} columns
   * @param {object[]} rows - `row[column.key]` qiymatlari
   * @param {object} [options]
   * @param {string} [options.emptyText]
   * @param {(cell: ExcelJS.Cell, column: object, row: object) => void} [options.styleCell]
   * @param {string} [options.zebraColor] - juft qatorlar foni (ARGB)
   */
  static fillTitledRows(
    sheet,
    columns,
    rows,
    { emptyText = "Ma'lumot yo'q", styleCell, zebraColor = TITLED.zebra } = {},
  ) {
    if (rows.length === 0) {
      const index = TITLED_HEADER_ROW + 1;
      sheet.mergeCells(index, 1, index, columns.length);
      const cell = sheet.getCell(index, 1);
      cell.value = emptyText;
      cell.font = { italic: true, color: { argb: TITLED.muted } };
      cell.alignment = { vertical: "middle", horizontal: "center" };
      return;
    }

    rows.forEach((row, rowIndex) => {
      const excelRow = sheet.addRow(columns.map((column) => row[column.key] ?? ""));

      if (rowIndex % 2 === 1) {
        excelRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: zebraColor } };
      }

      excelRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const column = columns[colNumber - 1];
        cell.border = { top: TITLED_BORDER, left: TITLED_BORDER, bottom: TITLED_BORDER, right: TITLED_BORDER };
        cell.alignment = {
          vertical: "middle",
          horizontal: column.align ?? "left",
        };
        styleCell?.(cell, column, row);
      });
    });

    sheet.autoFilter = {
      from: { row: TITLED_HEADER_ROW, column: 1 },
      to: { row: TITLED_HEADER_ROW, column: columns.length },
    };
  }

  /**
   * Faylni yuborish — nomi `<baseName>_<Toshkent kuni>.xlsx`.
   *
   * `Content-Disposition` — ASCII zaxira nom + UTF-8 asl nom (RFC 5987).
   *
   * ⚠️ Nom sinf nomidan yig'iladi va u kirillcha yoki apostrofli bo'lishi
   * mumkin ("1-sinf o'zbek"). Node sarlavhada 255 dan katta belgini rad
   * etadi (500), qo'shtirnoqsiz nomda esa bo'shliqdan keyingisi yo'qolardi.
   * Admin paneli `filename*` ni birinchi o'qiydi (`downloadBlob`).
   *
   * @param {import("express").Response} res
   * @param {ExcelJS.Workbook} workbook
   * @param {string} baseName
   * @param {{ fallbackName?: string }} [options] - ASCII ga aylantirilgan nom bo'sh qolsa
   */
  static async sendWorkbookAs(res, workbook, baseName, { fallbackName = "hisobot" } = {}) {
    const day = getTashkentDateUtc().toISOString().slice(0, 10);
    const utf8Name = `${baseName}_${day}.xlsx`;
    const asciiName =
      `${baseName.normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/_-+|-+_/g, "_").replace(/^-+|-+$/g, "") || fallbackName}_${day}.xlsx`;
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
}

/**
 * Birlashtirilgan sarlavha katagi: matn ustunlar kengligidan oshsa —
 * qatorga o'raladi va qator shuncha balandlashadi (Excel birlashtirilgan
 * katak balandligini o'zi moslamaydi). Sig'sa hech narsa o'zgarmaydi.
 *
 * `charWidth` — shriftning bir belgisi taxminan necha ustun birligi
 * (11-o'lcham ≈ 1, 14-o'lcham qalin ≈ 1.4).
 */
function wrapIfOverflow(sheet, rowNumber, { text, capacity, charWidth, lineHeight }) {
  const needed = String(text ?? "").length * charWidth;
  if (needed <= capacity) return;

  const lines = Math.ceil(needed / capacity);
  const cell = sheet.getCell(rowNumber, 1);
  cell.alignment = { ...cell.alignment, wrapText: true };
  const row = sheet.getRow(rowNumber);
  row.height = row.height + (lines - 1) * lineHeight;
}

// Sarlavhali varaq (`addTitledSheet`) — ustun sarlavhalari qatori va ranglari
const TITLED_HEADER_ROW = 4;
const TITLED_BORDER = { style: "thin", color: { argb: "FFE5E7EB" } };
const TITLED = {
  title: "FF1F2937",
  sub: "FF6B7280",
  header: "FF4472C4",
  zebra: "FFF2F2F2",
  muted: "FF9CA3AF",
};

ExcelService.TITLED_HEADER_ROW = TITLED_HEADER_ROW;

// Oldindan belgilangan ranglar
ExcelService.COLORS = {
  // Header ranglar
  HEADER_BLUE: "FF4472C4",
  HEADER_GREEN: "FF70AD47",
  HEADER_ORANGE: "FFED7D31",
  HEADER_PURPLE: "FF7030A0",
  HEADER_DARK: "FF404040",

  // Matn ranglar
  TEXT_WHITE: "FFFFFFFF",
  TEXT_BLACK: "FF000000",

  // Fon ranglar
  BG_LIGHT_GRAY: "FFF2F2F2",
  BG_LIGHT_BLUE: "FFE7F3FF",
  BG_LIGHT_GREEN: "FFE7F7E7",

  // Border ranglar
  BORDER_GRAY: "FFD0D0D0",
  BORDER_DARK: "FF808080",
};

module.exports = ExcelService;
