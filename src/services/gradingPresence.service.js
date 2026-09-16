/**
 * BAHO QO'YISH UCHUN MAKTABDA BO'LISH SHARTI.
 *
 * Bugungi darsga baho faqat MAKTABDA turgan o'qituvchi qo'yadi: davomatda
 * bugun kelgani qayd etilgan ("keldi" yoki "kech keldi") va hali ketmagan.
 * Uyda turib baho qo'yish yopiladi — baho darsni o'tilgan qiladi va soati
 * oylikka yoziladi (`helpers/lessonHours.js` → `judgeLesson`).
 *
 * ⚠️ GPS HAR BAHODA SO'RALMAYDI (biznes qarori): joylashuv "Men keldim"
 * bosilganda allaqachon tekshiriladi (`attendance.service.js` → `checkIn`).
 * Har bahoda so'ralsa, sinfda turgan o'qituvchi ham telefon GPS'iga qarab
 * qolardi.
 *
 * ⚠️ ADMIN QO'LDA "KELDI" BELGILAGANI HAM HISOB (`checkIn` vaqti bo'lmasa
 * ham): kelish tugmasi ishlamagan kuni boshliq davomatni to'g'rilaydi va
 * o'qituvchi darhol baho qo'ya oladi.
 *
 * ⚠️ OCHIB BERILGAN O'TGAN KUNGA BU SHART QO'YILMAYDI (`GradingUnlock`) —
 * u platforma sababli qoldirilgan baholarni to'ldirish uchun, istalgan joydan.
 *
 * Sozlama: `AttendanceSettings.gradingRequiresPresence` (sukut: yoqilgan).
 * O'chirish — "kelish" ishlamay qolgan kun uchun zaxira yo'l.
 */

const prisma = require("../config/prisma");
const { ROLES } = require("../utils/constants");
const { ForbiddenError } = require("../utils/errors");
const { currentDayDate } = require("../helpers/month.helpers");
const { formatTimeUz } = require("../helpers/date.helpers");
const { getAttendanceSettings } = require("./settings.service");

const NOT_AT_SCHOOL = "Siz maktabda emassiz";

/** Maktabda deb hisoblanadigan davomat holatlari. */
const PRESENT_STATUSES = new Set(["present", "late"]);

/**
 * Davomat qatoridan qaror — sof funksiya.
 *
 * @param {object|null} record - bugungi `Attendance`
 * @returns {{atSchool: boolean, state: string, message: string|null}}
 */
function judgePresence(record) {
  if (!record) {
    return {
      atSchool: false,
      state: "notArrived",
      message: `${NOT_AT_SCHOOL} — bugun kelganingiz qayd etilmagan. Baho qo'yish uchun avval "Men keldim" tugmasini bosing.`,
    };
  }

  if (record.status === "excused") {
    return {
      atSchool: false,
      state: "excused",
      message: `${NOT_AT_SCHOOL} — bugun davomatda sababli kelmagan deb belgilangansiz.`,
    };
  }

  if (!PRESENT_STATUSES.has(record.status)) {
    return {
      atSchool: false,
      state: "notArrived",
      message: `${NOT_AT_SCHOOL} — bugun davomatda "kelmadi" deb belgilangansiz. Kelgan bo'lsangiz, "Men keldim" tugmasini bosing.`,
    };
  }

  if (record.checkOut) {
    return {
      atSchool: false,
      state: "left",
      message: `${NOT_AT_SCHOOL} — bugun ${formatTimeUz(record.checkOut)} da ketganingiz qayd etilgan.`,
    };
  }

  return { atSchool: true, state: "atSchool", message: null };
}

/**
 * O'qituvchi HOZIR baho qo'ya oladimi (maktabda bo'lish sharti bo'yicha).
 *
 * @param {{id: string, role: string}} user
 * @returns {Promise<{required: boolean, atSchool: boolean, state: string, message: string|null}>}
 */
async function getGradingPresence(user) {
  // Owner'da davomat tizimi yo'q (`attendance.service.js` → `checkIn`)
  if (user.role === ROLES.OWNER) {
    return { required: false, atSchool: true, state: "exempt", message: null };
  }

  const settings = await getAttendanceSettings();
  if (!settings.gradingRequiresPresence) {
    return { required: false, atSchool: true, state: "disabled", message: null };
  }

  const record = await prisma.attendance.findUnique({
    where: { userId_date: { userId: user.id, date: currentDayDate() } },
    select: { status: true, checkIn: true, checkOut: true },
  });

  return { required: true, ...judgePresence(record) };
}

/**
 * Maktabda bo'lmasa — `ForbiddenError("Siz maktabda emassiz — ...")`.
 * @param {{id: string, role: string}} user
 */
async function assertAtSchool(user) {
  const presence = await getGradingPresence(user);
  if (!presence.atSchool) throw new ForbiddenError(presence.message);
  return presence;
}

module.exports = {
  NOT_AT_SCHOOL,
  judgePresence,
  getGradingPresence,
  assertAtSchool,
};
