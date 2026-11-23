const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * XODIM O'Z OYLIGINI KO'RMAYDI — DARVOZA (`selfPayroll.helpers.js`).
 *
 * Qabul mezonlari:
 *   - butun javobi oylikdan iborat yo'llar 403 bilan yopiladi
 *     (`assertSelfPayrollVisible`);
 *   - aralash javobdan (dars soati, tyutor guruhi, toifa zayavkasi) FAQAT
 *     pul maydonlari olib tashlanadi — soat, foiz, ball va sana QOLADI:
 *     o'qituvchi "nega soatim kam" degan savolga o'zi javob topishi kerak;
 *   - pul kaliti SUFFIKS bo'yicha ham taniladi (`*Amount`): javobga
 *     qo'shilgan yangi summa darvozani jimgina chetlab o'tmasin;
 *   - summa YOZILGAN MATN (`formulaLabel`) ham ketadi — u raqamning
 *     o'zi qadar ochiq;
 *   - `Date` qiymati obyektga aylanib qolmaydi.
 */

process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db?schema=public";

const {
  SELF_PAYROLL_VISIBLE,
  assertSelfPayrollVisible,
  isSalaryKey,
  stripSalaryAmounts,
  hideSalaryAmounts,
} = require("../src/helpers/selfPayroll.helpers");

test("yopiq holatda oylik yo'llari 403 qaytaradi", () => {
  if (SELF_PAYROLL_VISIBLE) {
    // Qaror qaytarilgan bo'lsa (bitta satr) — darvoza o'tkazib yuboradi
    assert.doesNotThrow(() => assertSelfPayrollVisible());
    return;
  }

  assert.throws(() => assertSelfPayrollVisible(), { statusCode: 403 });
});

test("pul kaliti: suffiks ham, aniq ro'yxat ham", () => {
  for (const key of [
    "amount",
    "fixedAmount",
    "kpiAmount",
    "paidAmount",
    "monthlyAmount",
    "perStudentAmount",
    "absenceAmount",
    "suspendedAmount",
    "deductionAmount",
    "hourlyRate",
    "perHourRate",
    "dailyRate",
    "perWeeklyHour",
    "baseSalary",
    "formulaLabel",
  ]) {
    assert.equal(isSalaryKey(key), true, `${key} pul maydoni bo'lishi kerak`);
  }

  // Pul EMAS: soat, foiz, ball, sanoq va holat ko'rinishda qoladi
  for (const key of [
    "hours",
    "taughtHours",
    "missedHours",
    "lessonHours",
    "attendanceRate",
    "points",
    "dayCount",
    "studentCount",
    "status",
    "monthLabel",
  ]) {
    assert.equal(isSalaryKey(key), false, `${key} ko'rinishda qolishi kerak`);
  }
});

test("aralash javobdan faqat pul olinadi", () => {
  const when = new Date("2026-11-23T00:00:00.000Z");

  const visible = stripSalaryAmounts({
    taughtHours: 42,
    hourlyRate: "50000.00",
    formulaLabel: "3 000 000 so'm + 50 000 so'm × soat",
    absence: { dayCount: 2, amount: "400000.00", dailyRate: "200000.00" },
    missedLessons: [{ className: "5-A", reasonLabel: "Baho yo'q", amount: "50000.00" }],
    createdAt: when,
    group: { studentCount: 24, monthlyAmount: "1200000.00" },
  });

  assert.deepEqual(visible, {
    taughtHours: 42,
    absence: { dayCount: 2 },
    missedLessons: [{ className: "5-A", reasonLabel: "Baho yo'q" }],
    createdAt: when,
    group: { studentCount: 24 },
  });

  // Sana BORLIGICHA qoladi — qayta qurilsa obyektga aylanib ketardi
  assert.ok(visible.createdAt instanceof Date);
});

test("skalyar va bo'sh qiymat o'zgarmaydi", () => {
  assert.equal(stripSalaryAmounts(null), null);
  assert.equal(stripSalaryAmounts(undefined), undefined);
  assert.equal(stripSalaryAmounts("1200000.00"), "1200000.00");
  assert.deepEqual(stripSalaryAmounts([]), []);
});

test("o'ram BAYROQQA bo'ysunadi — qaror bitta joyda", () => {
  const payload = { amount: "1200000.00", studentCount: 24 };
  const visible = hideSalaryAmounts(payload);

  if (SELF_PAYROLL_VISIBLE) {
    // Ochilgan kuni javob O'ZGARMAYDI: aks holda oylik faqat bir qism
    // ekranda qaytib, tyutor guruhi va toifa stavkasi yopiq qolardi
    assert.equal(visible, payload);
    return;
  }

  assert.deepEqual(visible, { studentCount: 24 });
});
