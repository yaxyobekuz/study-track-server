/**
 * GOOGLE SHEETS FAYLINI O'QISH — ALOHIDA ISH OQIMIDA (worker thread).
 *
 * ⚠️ Nima uchun asosiy jarayonda EMAS: ExcelJS kitobning HAMMA varag'ini
 * (yashirinlarini ham) to'liq xotiraga yuklaydi, keyingina kerakli varaq
 * tanlanadi. Sheet'ga kimdir katta ro'yxatli yangi varaq qo'shsa (sheet'ni
 * tahrirlash huquqi platformadagi huquqqa bog'liq emas), 20 MB siqilgan fayl
 * gigabaytlab xotira oladi — asosiy jarayonda bu BUTUN API'ni (hamma
 * filialni) yiqitardi, har 10 daqiqalik tekshiruv esa buni takrorlardi.
 * Bu yerda xotira va vaqt chegaralangan: oshib ketsa faqat shu oqim
 * to'xtaydi va foydalanuvchiga tushunarli xato qaytadi.
 *
 * Kirish (`workerData`): { buffer: Uint8Array, task: "parse"|"tabs", tabName? }
 * Chiqish (xabar): { ok: true, result } yoki { ok: false, message, statusCode }
 * Natija — oddiy JSON obyekt (ExcelJS obyektlari chegaradan o'tmaydi).
 */

const { parentPort, workerData } = require("worker_threads");
const ExcelJS = require("exceljs");
const sheet = require("./scheduleSheet.helpers");

(async () => {
  try {
    const { buffer, task, tabName } = workerData;
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(Buffer.from(buffer));
    } catch {
      parentPort.postMessage({ ok: false, message: "Sheet faylini o'qib bo'lmadi", statusCode: 400 });
      return;
    }

    const result =
      task === "tabs"
        ? { tabs: sheet.listVisibleSheets(workbook) }
        : { parsed: sheet.parseScheduleSheet(workbook, tabName) };
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      message: error?.message || "Sheet faylini o'qib bo'lmadi",
      statusCode: error?.statusCode || 500,
    });
  }
})();
