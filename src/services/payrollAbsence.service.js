/**
 * KELMAGAN KUNLAR — fiksa oylikdan kunlik ayirmaning MA'LUMOT qatlami.
 *
 * Biznes qarori (2026-10-02): fiksa oylikdagi xodim (o'qituvchi ham, texnik
 * xodim ham) ish kuni kelmasa, o'sha kun uchun kunlik summa oylikdan ayriladi.
 *
 *   bo'luvchi    = oy kunlari − yakshanbalar (dam olish kunlari ICHIDA)
 *   kunlik summa = fiksa ÷ bo'luvchi
 *   kelmagan kun = ISH kunida (yakshanba va dam olish kunisiz) davomatda
 *                  "kelmadi" YOKI "sababli" (kech kelgan — kelgan)
 *
 * ⚠️ FORMULA BU YERDA YOZILMAYDI — `computeAbsenceDeduction`
 * (`helpers/salaryRules.helpers.js`). Bu fayl faqat FAKTLARNI yig'adi
 * (davomat, dam olish kunlari, sozlama) va muhrlangan oylikni davomat o'zgarganda
 * yangilaydi.
 *
 * ⚠️ FAKT — DAVOMAT. "Kelmadi" ni kun oxirida avtomat job qo'yadi
 * (`attendanceAbsent.job.js`, faqat xodimning ish kunida); admin davomatni
 * to'g'rilasa ayirma ham qaytadi (`resyncAfterAttendanceChange`).
 */

const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const { getFinanceSettings } = require("./settings.service");
const { buildHolidaySet } = require("./holiday.service");
const {
  currentMonthKey,
  monthKeyOfDate,
  monthStartDate,
  monthEndDate,
} = require("../helpers/month.helpers");
const { teachingDaysOfMonth, dayKey } = require("../helpers/lessonHours");
const {
  ABSENCE_STATUSES,
  ABSENCE_STATUS_LABELS,
} = require("../helpers/salaryRules.helpers");
const { formatAmount } = require("../helpers/money.helpers");
const { formatDateUz } = require("../helpers/date.helpers");

/**
 * Ayirma shu oyda qo'llanadimi. `null` sozlama — o'chirilgan; boshlanish
 * oyidan oldingi oylarga tegilmaydi (o'tgan oylar o'zgarmasin).
 *
 * @param {number|null} fromMonth - `FinanceSettings.absenceDeductionFromMonth`
 * @param {number} month - YYYYMM
 */
const isAbsenceDeductionActive = (fromMonth, month) =>
  fromMonth != null && month >= fromMonth;

/**
 * Oyning ISH KUNLARI — yakshanba va dam olish kunlari chiqarilgan. Kelmaslik
 * faqat shu kunlarda sanaladi. Dars soati hisobidagi "dars kunlari" bilan
 * AYNI ro'yxat (`teachingDaysOfMonth`): ikkinchi kalendar yozilmaydi.
 *
 * @param {number} month - YYYYMM
 * @returns {Promise<string[]>} "YYYY-MM-DD"
 */
const loadWorkDays = async (month) => {
  const holidaySet = await buildHolidaySet(monthStartDate(month), monthEndDate(month));
  return teachingDaysOfMonth(month, { holidaySet }).map((day) => day.key);
};

/**
 * KUNLIK SUMMA BO'LUVCHISI — oy kunlari, faqat yakshanbalar chiqarilgan
 * (biznes qarori, 2026-10-03). Dam olish kunlari ICHIDA: fiksa ularni ham
 * qamraydi, ya'ni ular kunlik summani kichraytiradi, lekin o'sha kuni
 * kelmaslik ayirilmaydi (`loadWorkDays` da yo'q).
 *
 * @param {number} month - YYYYMM
 * @returns {number}
 */
const countRateDays = (month) => teachingDaysOfMonth(month).length;

/**
 * Oy uchun ayirma faktlari — bir marta, xodimlar bo'yicha (N+1 so'rovsiz).
 *
 * `enabled: false` bo'lsa davomat umuman o'qilmaydi.
 *
 * @param {number} month - YYYYMM
 * @param {string[]} staffIds
 * @returns {Promise<{ enabled: boolean, workDays: string[], rateDayCount: number,
 *   byStaff: Map<string, Array<{day: string, status: string}>> }>}
 */
const loadAbsenceFacts = async (month, staffIds) => {
  const settings = await getFinanceSettings();
  if (!isAbsenceDeductionActive(settings.absenceDeductionFromMonth, month)) {
    return { enabled: false, workDays: [], rateDayCount: 0, byStaff: new Map() };
  }

  const [workDays, rows] = await Promise.all([
    loadWorkDays(month),
    staffIds.length
      ? // `Attendance.date` — Toshkent kunining UTC yarim tuni
        // (`attendance.service.js` → `getTodayNormalized`)
        prisma.attendance.findMany({
          where: {
            userId: { in: staffIds },
            date: { gte: monthStartDate(month), lte: monthEndDate(month) },
            status: { in: ABSENCE_STATUSES },
          },
          select: { userId: true, date: true, status: true },
        })
      : [],
  ]);

  const byStaff = new Map();
  for (const row of rows) {
    if (!byStaff.has(row.userId)) byStaff.set(row.userId, []);
    byStaff.get(row.userId).push({ day: dayKey(row.date), status: row.status });
  }

  return { enabled: true, workDays, rateDayCount: countRateDays(month), byStaff };
};

/**
 * Davomat o'zgargandan keyin shu xodim(lar)ning shu oydagi MUHRLANGAN
 * oyligini yangilaydi (ayirma kun bo'yicha qayta hisoblanadi). Jonli ekranlar
 * (vedomost, profil) baribir dvigateldan o'qiydi — bu faqat moliyadagi
 * majburiyat ertangi kunlik passni kutmasligi uchun.
 *
 * ⚠️ HECH QACHON OTILMAYDI va chaqiruvchi KUTMAYDI: oylik qayta hisobidagi
 * xato davomat yozuvini yiqitmasligi kerak — kunlik pass (06:00) zaxira.
 * Ko'p xodim bir amalda belgilansa — BITTA chaqiruv (ro'yxat bilan).
 *
 * @param {string|string[]} userIds
 * @param {Date} date - davomat kuni (UTC yarim tuni)
 */
const resyncAfterAttendanceChange = (userIds, date) => {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean))];
  if (ids.length === 0 || !(date instanceof Date) || Number.isNaN(date.getTime())) return;

  const run = async () => {
    const month = monthKeyOfDate(date);
    if (month > currentMonthKey()) return;
    const { resyncSealedEntries } = require("./payrollDeduction.service");
    await resyncSealedEntries(ids, [month]);
  };
  run().catch((error) => {
    logger.warn(
      `[payrollAbsence] Davomatdan keyin oylikni yangilab bo'lmadi ` +
        `(${ids.length} xodim): ${error.message}`,
    );
  });
};

/**
 * Kelmagan kunlar tafsiloti — ekranga tayyor shakl (muhrdan ham, jonli
 * hisobdan ham BIR XIL). `{}` (ayirma qo'llanmagan oy) → `null`.
 *
 * Kun `@db.Date` kabi UTC yarim tuni kaliti ("2026-10-05") — `utc: true`.
 *
 * @param {object} breakdown - `computeAbsenceDeduction(...).breakdown`
 * @param {Decimal|string|number} amount - jami ayirma
 * @returns {null|{amount, workDays, dailyRate, dayCount, days: Array}}
 */
const serializeAbsence = (breakdown, amount) => {
  if (!breakdown || !Array.isArray(breakdown.days)) return null;
  return {
    amount: formatAmount(amount ?? 0),
    workDays: breakdown.workDays ?? 0,
    dailyRate: breakdown.dailyRate ?? "0.00",
    dayCount: breakdown.days.length,
    days: breakdown.days.map((day) => ({
      date: day.date,
      dateLabel: formatDateUz(new Date(`${day.date}T00:00:00Z`), { utc: true }),
      status: day.status,
      statusLabel: ABSENCE_STATUS_LABELS[day.status] ?? day.status,
      amount: day.amount,
    })),
  };
};

module.exports = {
  isAbsenceDeductionActive,
  serializeAbsence,
  loadWorkDays,
  countRateDays,
  loadAbsenceFacts,
  resyncAfterAttendanceChange,
};
