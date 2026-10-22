const { BadRequestError } = require("../utils/errors");

/**
 * ASL SINF — o'quvchining MAKTAB DARAJASI (1-sinf … 11-sinf).
 *
 * ⚠️ Bu SINFLAR KATALOGI (`Class`) EMAS. Katalogdagi "IT 1", "Union 2",
 * "Bog'cha — katta guruh" — o'quvchi O'QIYDIGAN guruhlar, ularning nomidagi
 * raqam daraja bilan bog'liq emas. Asl sinf esa "bu bola nechanchi sinf
 * o'quvchisi" degan savolga javob beradi va u guruhdan FARQ QILISHI mumkin:
 * bilimi yaxshi 5-sinf o'quvchisi 6-sinflar guruhida o'qiydi.
 *
 * Shuning uchun u FK emas, oddiy son (`User.actualGrade`): daraja filialga
 * ham, katalogga ham bog'liq emas, saralash va guruhlash esa son bo'yicha
 * tabiiy chiqadi.
 */
const MIN_GRADE = 1;
const MAX_GRADE = 11;

/** [1 … 11] — tanlagichlar va hisobotlar shu ro'yxatdan quriladi. */
const GRADES = Array.from(
  { length: MAX_GRADE - MIN_GRADE + 1 },
  (_, i) => MIN_GRADE + i,
);

/**
 * "Hali belgilanmagan" filtrining qiymati.
 *
 * Bo'sh satr ishlatilmaydi: u "filtr yo'q" degani va paneldagi `Select`
 * ham `""` ni aynan shunday o'qiydi.
 */
const GRADE_NONE = "none";

/** @param {*} value @returns {boolean} */
const isGrade = (value) =>
  Number.isInteger(value) && value >= MIN_GRADE && value <= MAX_GRADE;

/**
 * Darajaning YAGONA matn ko'rinishi — "5-sinf".
 *
 * Panel ham, Excel ham, Telegram ham shundan oladi: ikkinchi shablon
 * yozilsa, bir ekranda "5-sinf", boshqasida "5 sinf" turardi
 * (`dates.md` dagi sana qoidasi bilan AYNI mulohaza).
 *
 * @param {number|null|undefined} grade
 * @returns {string|null}
 */
const formatGrade = (grade) => (isGrade(grade) ? `${grade}-sinf` : null);

/**
 * Kiruvchi qiymatni tekshirib normallashtiradi:
 *
 *   undefined               → undefined (maydonga TEGILMAYDI)
 *   null | "" | "none"      → null      (belgi olib tashlanadi)
 *   1 … 11 (son yoki matn)  → son
 *
 * Oraliqdan tashqari qiymat JIM tashlab yuborilmaydi: aks holda admin
 * "tanladim, lekin saqlanmadi" holatiga tushardi.
 *
 * @param {*} value
 * @returns {number|null|undefined}
 */
const parseGrade = (value) => {
  if (value === undefined) return undefined;
  if (value === null || value === "" || value === GRADE_NONE) return null;

  const grade = Number(value);
  if (!isGrade(grade)) {
    throw new BadRequestError(
      `Asl sinf ${MIN_GRADE} dan ${MAX_GRADE} gacha bo'lishi kerak`,
    );
  }
  return grade;
};

/**
 * Sinf NOMIDAN darajani chiqaradi — faqat nom AYNAN daraja bilan
 * boshlansa: "5-A" → 5, "3-sinf o'zbek" → 3.
 *
 * ⚠️ TAXMIN QILMAYDI (`education.md` §10 dagi moslash doktrinasi): "IT 1",
 * "Union 2", "STEM 6" dagi raqam guruh tartibi, daraja emas — ular
 * `null` qaytaradi va admin darajani qo'lda belgilaydi. Noto'g'ri taxmin
 * qilingan daraja hisobotga jimgina yolg'on raqam qo'shardi.
 *
 * ⚠️ Migratsiyadagi SQL ham AYNI naqshni ishlatadi
 * (`20261022150000_student_actual_grade`) — ikkala joyda bir xil natija
 * chiqishi kerak.
 *
 * @param {string|null|undefined} className
 * @returns {number|null}
 */
const gradeFromClassName = (className) => {
  const match = /^(\d{1,2})-/.exec(String(className ?? "").trim());
  if (!match) return null;
  const grade = Number(match[1]);
  return isGrade(grade) ? grade : null;
};

module.exports = {
  MIN_GRADE,
  MAX_GRADE,
  GRADES,
  GRADE_NONE,
  isGrade,
  formatGrade,
  parseGrade,
  gradeFromClassName,
};
