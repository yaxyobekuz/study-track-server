/**
 * "BAHO QO'YMASLIK" JARIMASI — sarlavha (yagona manba).
 *
 * Kechki cron (`gradePenalty.job.js`) har bir darsga bittadan jarima yozadi
 * va darsga boshqa ishora saqlamaydi: dars SARLAVHADAN tanib olinadi.
 * Rahbariyat darsni "o'tildi" deb belgilaganda (`lessonCredit.service.js`)
 * aynan shu darsning jarimasi shu sarlavha bo'yicha topiladi. Ikki joyda
 * qo'lda yig'ilsa, birida bitta probel o'zgarib, jarima jimgina topilmay
 * qolardi.
 *
 * ⚠️ Sana — ISO kun kaliti ("2026-10-05"), ekran formati EMAS: u allaqachon
 * yozilgan jarimalar sarlavhasida shu ko'rinishda turibdi va o'zgartirilsa
 * eski jarimalar tanilmay qoladi.
 *
 * @param {string} className - sinf nomi (jarima yozilgan paytdagi)
 * @param {number} lessonOrder - dars tartibi
 * @param {string} day - "YYYY-MM-DD" (Toshkent kuni)
 * @param {boolean} [substituted] - dars o'rinbosarlik bilan o'tilishi kerak edi
 * @returns {string}
 */
const gradePenaltyTitle = (className, lessonOrder, day, substituted = false) =>
  `Baho qo'ymaslik: ${className} ${lessonOrder}-dars (${day})` +
  (substituted ? " — o'rinbosarlik" : "");

module.exports = { gradePenaltyTitle };
