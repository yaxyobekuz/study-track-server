/**
 * Moliya sozlamalari — akademik davr (maktab bo'yicha global) va hisob-faktura
 * cron'ining konfiguratsiyasi.
 *
 * Repo konvensiyasi: operator sozlaydigan biznes qoidalari .env da emas,
 * singleton sozlama jadvalida (coinSettings.dailyCoinPercentage,
 * attendanceSettings.* kabi). "Oyning nechanchi kunida" — aynan shunday qoida.
 */

const prisma = require("../config/prisma");
const { getFinanceSettings } = require("./settings.service");
const { BadRequestError } = require("../utils/errors");
const {
  currentMonthKey,
  parseOptionalMonthKey,
  formatMonthKey,
} = require("../helpers/month.helpers");
const {
  ACADEMIC_MONTH_COUNTS,
  assertAcademicSettings,
  describeAcademicMonth,
  academicYearBounds,
  academicYearMonths,
  academicYearOf,
} = require("../helpers/academicYear.helpers");

// Cron ifodasi emas, handler o'qiydigan kun. 28 dan oshmasligi kerak —
// 29-31 fevralda hech qachon kelmaydi va o'sha oy tashlab ketilardi.
const MAX_INVOICE_DAY = 28;
const MAX_CATCH_UP_MONTHS = 12;

const serializeSettings = (settings) => ({
  ...settings,
  firstInvoiceMonthLabel: formatMonthKey(settings.firstInvoiceMonth),
  lastGeneratedMonthLabel: formatMonthKey(settings.lastGeneratedMonth),
});

/**
 * Sozlamalar + joriy oyning akademik tavsifi.
 * @returns {Promise<object>}
 */
const getSettings = async () => {
  const settings = await getFinanceSettings();
  const month = currentMonthKey();

  return {
    ...serializeSettings(settings),
    academicMonthCountOptions: ACADEMIC_MONTH_COUNTS,
    current: {
      month,
      monthLabel: formatMonthKey(month),
      ...describeAcademicMonth(month, settings),
    },
  };
};

/**
 * Sozlamalarni yangilaydi.
 *
 * Akademik davr o'zgarsa — bu FAQAT yangi hisob-fakturalarga ta'sir qiladi:
 * chiqarilganlari o'z academicYear/academicIndex snapshot'ini saqlaydi.
 * Shuni admin ko'rishi uchun `warnings` qaytariladi.
 *
 * @param {object} data
 * @param {string} userId
 * @returns {Promise<{settings: object, warnings: string[]}>}
 */
const updateSettings = async (data, userId) => {
  const current = await getFinanceSettings();
  const payload = {};
  const warnings = [];

  const academicStartMonth =
    data.academicStartMonth !== undefined
      ? Number(data.academicStartMonth)
      : current.academicStartMonth;
  const academicMonthCount =
    data.academicMonthCount !== undefined
      ? Number(data.academicMonthCount)
      : current.academicMonthCount;

  if (
    data.academicStartMonth !== undefined ||
    data.academicMonthCount !== undefined
  ) {
    assertAcademicSettings({ academicStartMonth, academicMonthCount });
    payload.academicStartMonth = academicStartMonth;
    payload.academicMonthCount = academicMonthCount;

    const changed =
      academicStartMonth !== current.academicStartMonth ||
      academicMonthCount !== current.academicMonthCount;

    if (changed) {
      warnings.push(
        "O'quv yili o'zgarishi faqat yangi hisob-fakturalarga ta'sir qiladi — mavjudlari o'z yorlig'ini saqlaydi",
      );
    }
  }

  if (data.invoiceDayOfMonth !== undefined) {
    const day = Number(data.invoiceDayOfMonth);
    if (!Number.isInteger(day) || day < 1 || day > MAX_INVOICE_DAY) {
      throw new BadRequestError(
        `Hisob-faktura kuni 1 dan ${MAX_INVOICE_DAY} gacha bo'lishi kerak`,
      );
    }
    payload.invoiceDayOfMonth = day;
  }

  if (data.autoGenerateEnabled !== undefined) {
    payload.autoGenerateEnabled = Boolean(data.autoGenerateEnabled);
  }

  if (data.catchUpMonths !== undefined) {
    const months = Number(data.catchUpMonths);
    if (!Number.isInteger(months) || months < 0 || months > MAX_CATCH_UP_MONTHS) {
      throw new BadRequestError(
        `Orqaga qaytish oylari 0 dan ${MAX_CATCH_UP_MONTHS} gacha bo'lishi kerak`,
      );
    }
    payload.catchUpMonths = months;
  }

  if (data.firstInvoiceMonth !== undefined) {
    payload.firstInvoiceMonth = parseOptionalMonthKey(
      data.firstInvoiceMonth,
      "Birinchi hisob-faktura oyi",
    );
  }

  if (Object.keys(payload).length === 0) {
    return { settings: await getSettings(), warnings };
  }

  payload.updatedBy = userId;

  const updated = await prisma.financeSettings.update({
    where: { id: current.id },
    data: payload,
  });

  return {
    settings: {
      ...serializeSettings(updated),
      academicMonthCountOptions: ACADEMIC_MONTH_COUNTS,
      current: {
        month: currentMonthKey(),
        monthLabel: formatMonthKey(currentMonthKey()),
        ...describeAcademicMonth(currentMonthKey(), updated),
      },
    },
    warnings,
  };
};

/**
 * O'quv yilining oylari — UI kalendari va oy tanlagichi uchun.
 *
 * @param {{year?: number|string, month?: number}} query
 * @returns {Promise<object>}
 */
const getAcademicYear = async ({ year, month } = {}) => {
  const settings = await getFinanceSettings();

  const academicYear =
    year != null && year !== ""
      ? Number(year)
      : academicYearOf(month || currentMonthKey(), settings);

  if (!Number.isInteger(academicYear)) {
    throw new BadRequestError("O'quv yili noto'g'ri");
  }

  const bounds = academicYearBounds(academicYear, settings);

  return {
    academicYear,
    academicYearLabel: `${academicYear}/${academicYear + 1}`,
    academicMonthCount: settings.academicMonthCount,
    ...bounds,
    startMonthLabel: formatMonthKey(bounds.startMonth),
    endMonthLabel: formatMonthKey(bounds.endMonth),
    months: academicYearMonths(academicYear, settings).map((item) => ({
      ...item,
      monthLabel: formatMonthKey(item.month),
    })),
  };
};

module.exports = {
  MAX_INVOICE_DAY,
  MAX_CATCH_UP_MONTHS,
  serializeSettings,
  getSettings,
  updateSettings,
  getAcademicYear,
};
