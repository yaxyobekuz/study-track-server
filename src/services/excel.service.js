const ExcelJS = require("exceljs");

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
    const {
      sheetName = "Sheet1",
      columns = [],
      data = [],
      headerStyle = {},
      rowStyle = {},
    } = config;

    const workbook = this.createWorkbook();
    const worksheet = this.addWorksheet(workbook, sheetName);

    this.setColumns(worksheet, columns);
    this.styleHeader(worksheet, headerStyle);
    this.addRows(worksheet, data, rowStyle);
    this.addAutoFilter(worksheet, columns.length);

    return workbook;
  }
}

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
