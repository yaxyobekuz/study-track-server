/**
 * DARS JADVALI PUSH XABARI — matn va `data` ni quradi (sof funksiya).
 *
 * Hozircha bitta hodisa:
 *   sheet_pending — Google Sheets'da o'qituvchining darsi o'zgardi, lekin
 *                   amaldagi jadval hali tasdiqlanmagan (`education.md` §10).
 *
 * ⚠️ `data` MOBIL ILOVA BILAN SHARTNOMA: ilova bosilgan bildirishnomadan
 * dars jadvali ekranini ochadi va `revisionId` bo'yicha o'zi ko'rsatayotgan
 * ogohlantirish bilan AYNI tahrir ekanini biladi
 * (`GET /schedule-sync/pending/my`). Kalitlarni o'zgartirish ilovani ham
 * yangilashni talab qiladi.
 *
 * ⚠️ Android KANALI BERILMAYDI: ilovada "schedule" kanali yo'q, noma'lum
 * kanal bilan yuborilgan xabar esa ba'zi qurilmalarda umuman ko'rinmaydi.
 * Kanal ilovaga qo'shilgandan keyin shu yerga yoziladi (bitta joy).
 */

const SCHEDULE_PUSH_EVENTS = Object.freeze({
  SHEET_PENDING: "sheet_pending",
});

/**
 * @param {{revisionId: string, branchId?: string, lessonCount?: number}} input
 * @returns {{title: string, body: string, data: object}}
 */
function buildSheetPendingPush({ revisionId, branchId, lessonCount = 0 }) {
  const lines = ["Dars jadvalingiz sheetda o'zgardi, hali tasdiqlanmagan"];
  if (lessonCount > 0) lines.push(`${lessonCount} ta darsga ta'sir qiladi`);

  return {
    title: "Dars jadvali o'zgardi",
    body: lines.join("\n"),
    data: {
      type: "schedule",
      event: SCHEDULE_PUSH_EVENTS.SHEET_PENDING,
      revisionId,
      branchId,
    },
  };
}

module.exports = { SCHEDULE_PUSH_EVENTS, buildSheetPendingPush };
