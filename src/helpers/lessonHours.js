/**
 * DARS SOATLARI — SOF HISOB, DB'siz.
 *
 * Domenda dars jadvali HAFTALIK SHABLON: `Schedule` (sinf + hafta kuni) va
 * uning ichidagi `ScheduleLesson`. Kalendar sanasiga bog'langan dars yozuvi
 * BUTUN BAZADA YO'Q. Ya'ni "bu oyda necha soat o'tildi" degan savolga javob
 * berish uchun shablonni oyning kunlariga YOYISH kerak.
 *
 * ⚠️ SOAT = DARS. Butun domenda "soat" har doim dars sonini bildiradi
 * (`teacherWorkload.service.js`, `PlannerLoad.weeklyHours` bilan bir xil
 * o'lchov), astronomik soat EMAS. Ikkinchi o'lchov kiritilsa reja, jadval va
 * oylik raqamlari bir-biriga taqqoslanmay qolardi.
 *
 * ── NIMA UCHUN AYNAN SHU FAYL ────────────────
 *
 * Bu yerda FAQAT arifmetika turadi: kirim — oy kaliti, bayram kunlari
 * to'plami va hafta kuni bo'yicha darslar; chiqim — sonlar. DB so'rovi ham,
 * Prisma ham, taymzona hiylasi ham yo'q. Sabab `allocation.helpers.js`
 * bilan bir xil: chaqiruvchisi ikkita (jonli dashboard va oylik
 * shakllantirish) va ular BIR XIL raqam berishi SHART. Ikkita mustaqil
 * hisoblagich bo'lsa, "panelda 84 soat, oylikda 82 soat" degan tushuntirib
 * bo'lmas holat chiqardi.
 *
 * ⚠️ DARS BO'LMAYDIGAN KUNLAR IKKI XIL: yakshanba (`ScheduleDay` enumida
 * umuman yo'q) va bayram (alohida to'plam bilan keladi). Ikkalasi ham
 * `teachingDaysOfMonth` da filtrlanadi — ro'yxatning UZUNLIGI "oyda necha
 * dars kuni bor" degan raqam sifatida ishlatilgani uchun (pastdagi izohga
 * qarang).
 */

const { Decimal } = require("./money.helpers");
const { daysInMonth } = require("./month.helpers");

/**
 * Sanani kun kaliti ("2026-09-21") ga aylantiradi.
 *
 * ⚠️ FAQAT `getUTC*`. Sana `@db.Date` va UTC yarim tunida yotadi; lokal
 * getter'lar UTC−5 hostda bir kun orqaga o'qib, oy chegarasidagi kunni
 * boshqa oyga tashlab yuborardi (`month.helpers.js` bilan bir xil qoida).
 *
 * @param {Date} date
 * @returns {string} "YYYY-MM-DD"
 */
function dayKey(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Oyning barcha kunlari — UTC yarim tunidagi `Date` va hafta kuni raqami.
 *
 * Hafta kuni `getUTCDay()` bilan olinadi (0 = yakshanba), ya'ni
 * `DAYS_UZ` / `DAY_TO_NUMBER` bilan AYNAN bir xil koordinatada.
 *
 * @param {number} monthKey - YYYYMM
 * @returns {Array<{date: Date, key: string, dayNumber: number, dayOfMonth: number}>}
 */
function eachDayOfMonth(monthKey) {
  const year = Math.trunc(monthKey / 100);
  const month = monthKey % 100;
  const total = daysInMonth(monthKey);
  const days = [];

  for (let day = 1; day <= total; day += 1) {
    const date = new Date(Date.UTC(year, month - 1, day));
    days.push({
      date,
      key: dayKey(date),
      dayNumber: date.getUTCDay(),
      dayOfMonth: day,
    });
  }

  return days;
}

/**
 * Oyning DARS O'TILADIGAN kunlari — yakshanba va bayramlar chiqarilgan.
 *
 * ⚠️ YAKSHANBA HAM FILTRLANADI. Soat hisobiga u baribir ta'sir qilmasdi
 * (`ScheduleDay` enumida yakshanba yo'q, ya'ni `weeklyByDay` da 0 kaliti
 * hech qachon bo'lmaydi), LEKIN bu ro'yxatning UZUNLIGI "oyda necha dars
 * kuni bor" degan raqam sifatida ishlatiladi va u panelda ko'rsatiladi,
 * `hoursSnapshot` ga esa muhrlanadi. Yakshanbani qoldirish o'sha raqamni
 * o'z-o'ziga zid qilardi: bayram (dars bo'lmaydigan kun) chiqarilgan-u,
 * yakshanba (u ham dars bo'lmaydigan kun) qolgan bo'lardi.
 *
 * @param {number} monthKey - YYYYMM
 * @param {object} [options]
 * @param {Set<string>} [options.holidaySet] - "YYYY-MM-DD" bayram kunlari
 * @param {number} [options.untilDayOfMonth] - shu kungacha (INKLYUZIV).
 *   Joriy oy uchun "bugungacha o'tilgani" ni ajratishga kerak.
 * @returns {Array<{date, key, dayNumber, dayOfMonth}>}
 */
function teachingDaysOfMonth(monthKey, { holidaySet, untilDayOfMonth } = {}) {
  return eachDayOfMonth(monthKey).filter((day) => {
    if (day.dayNumber === 0) return false; // yakshanba — dars yo'q
    if (untilDayOfMonth != null && day.dayOfMonth > untilDayOfMonth) return false;
    if (holidaySet && holidaySet.has(day.key)) return false;
    return true;
  });
}

/**
 * Haftalik shablonni oy kunlariga yoyadi.
 *
 * @param {Array<{dayNumber: number}>} days - `teachingDaysOfMonth` natijasi
 * @param {Map<number, number>} weeklyByDay - hafta kuni raqami → dars soni
 * @returns {number} oydagi jami soat
 */
function expandWeeklyHours(days, weeklyByDay) {
  let total = 0;
  for (const day of days) total += weeklyByDay.get(day.dayNumber) ?? 0;
  return total;
}

/**
 * MAOSH FORMULASI — uch rejim bitta joyda.
 *
 * ⚠️ Bu funksiya PULNI hisoblaydigan YAGONA nuqta. Oylik shakllantirish ham,
 * paneldagi jonli hisob ham shuni chaqiradi. Ikkita nusxa bo'lsa,
 * o'qituvchi panelda bir raqam, vedomostda boshqa raqam ko'rardi — bu esa
 * modulning butun mohiyatini (shaffoflik) yo'qqa chiqarardi.
 *
 *   fixed  → amount
 *   hourly → hours × hourlyRate
 *   mixed  → amount + max(0, hours − norm) × hourlyRate
 *
 * ⚠️ `mixed` da normadan KAM ishlangani uchun BAZAVIY summa KAMAYTIRILMAYDI.
 * Bu biznes qarori: fiksa — kelishilgan minimal kafolat, jarima emas. Kam
 * o'tilgan soat uchun ushlab qolish kerak bo'lsa, u alohida jarima
 * mexanizmi bilan yechiladi (`Penalty`), oylik formulasi bilan emas.
 *
 * @param {object} rule - { type, amount, hourlyRate, monthlyHourNorm }
 * @param {number} hours - o'tilgan akademik soat (butun son)
 * @returns {{
 *   baseAmount: Prisma.Decimal,
 *   hoursAmount: Prisma.Decimal,
 *   amount: Prisma.Decimal,
 *   payableHours: number,
 *   extraHours: number
 * }}
 */
function computeSalary(rule, hours) {
  const worked = Number.isFinite(hours) && hours > 0 ? Math.trunc(hours) : 0;
  const base = new Decimal(rule.amount ?? 0);
  const rate = rule.hourlyRate != null ? new Decimal(rule.hourlyRate) : null;

  if (rule.type === "hourly") {
    const payable = worked;
    const hoursAmount = rate ? rate.times(payable) : new Decimal(0);

    return {
      baseAmount: new Decimal(0),
      hoursAmount,
      amount: hoursAmount,
      payableHours: payable,
      extraHours: 0,
    };
  }

  if (rule.type === "mixed") {
    const norm = Number.isFinite(rule.monthlyHourNorm) ? rule.monthlyHourNorm : 0;
    const extra = Math.max(0, worked - norm);
    const hoursAmount = rate ? rate.times(extra) : new Decimal(0);

    return {
      baseAmount: base,
      hoursAmount,
      amount: base.plus(hoursAmount),
      payableHours: extra,
      extraHours: extra,
    };
  }

  // fixed — dars soati summaga TA'SIR QILMAYDI (soat baribir ko'rsatiladi:
  // "shu oyda 96 soat o'tdi" degan ma'lumot fiksadagi odam uchun ham kerak).
  return {
    baseAmount: base,
    hoursAmount: new Decimal(0),
    amount: base,
    payableHours: 0,
    extraHours: 0,
  };
}

/**
 * Normaning bajarilgan ulushi — faqat KO'RSATISH uchun (progress halqasi).
 * `hourly` da norma yo'q, shuning uchun `null`.
 *
 * @param {object} rule
 * @param {number} hours
 * @returns {number|null} 0..100+ (oshib ketishi MUMKIN va shunday ko'rsatiladi)
 */
function normProgress(rule, hours) {
  if (rule?.type !== "mixed" || !rule.monthlyHourNorm) return null;
  return Math.round((hours / rule.monthlyHourNorm) * 100);
}

module.exports = {
  dayKey,
  eachDayOfMonth,
  teachingDaysOfMonth,
  expandWeeklyHours,
  computeSalary,
  normProgress,
};
