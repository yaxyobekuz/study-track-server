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
    current: {
      month,
      monthLabel: formatMonthKey(month),
      // Ta'til deb belgilanmagan har bir oy to'lanadi — "akademik oy"
      // degan tushuncha yo'q, shuning uchun bu yerda bayroq ham yo'q.
    },
  };
};

/**
 * Sozlamalarni yangilaydi.
 *
 * @param {object} data
 * @param {string} userId
 * @returns {Promise<{settings: object, warnings: string[]}>}
 */
const updateSettings = async (data, userId) => {
  const current = await getFinanceSettings();
  const payload = {};
  const warnings = [];

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

  if (data.prorationEnabled !== undefined) {
    payload.prorationEnabled = Boolean(data.prorationEnabled);
  }

  if (data.roundingUnit !== undefined) {
    const unit = Number(data.roundingUnit);
    if (!Number.isInteger(unit) || unit < 0 || unit > 1000000) {
      throw new BadRequestError("Yaxlitlash birligi 0 dan 1 000 000 gacha butun son bo'lishi kerak");
    }
    payload.roundingUnit = unit;
  }

  if (data.catchUpMonths !== undefined) {
    const months = Number(data.catchUpMonths);
    if (!Number.isInteger(months) || months < 0 || months > MAX_CATCH_UP_MONTHS) {
      throw new BadRequestError(
        `Orqaga qaytish oylari 0 dan ${MAX_CATCH_UP_MONTHS} gacha bo'lishi kerak`,
      );
    }

    // Proratsiya yoqilgan bo'lsa 0 xavfli: oy o'rtasida kelgan o'quvchining
    // birinchi oyi cron passiga ULGURMAYDI (davr keyinroq kiritiladi) va
    // orqaga qaytish bo'lmasa u oy umuman hisoblanmay qolardi. Davr
    // ochilganda darhol shakllantirish bor, lekin bu ikkinchi himoya qavati.
    const proration =
      payload.prorationEnabled ?? current.prorationEnabled;

    if (months === 0 && proration) {
      throw new BadRequestError(
        "Kirish proratsiyasi yoqilganda orqaga qaytish 0 bo'lishi mumkin emas — " +
          "oy o'rtasida kelgan o'quvchining birinchi oyi hisoblanmay qoladi",
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

  if (data.maxDiscountPercent !== undefined) {
    const percent = Number(data.maxDiscountPercent);
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
      throw new BadRequestError("Chegirma cheklovi 0 dan 100 gacha bo'lishi kerak");
    }
    payload.maxDiscountPercent = percent;

    // Mavjud hisob-fakturalar summasi MUHRLANGAN — cheklovni pasaytirish
    // ularni qimmatlashtirmaydi. Bu tez-tez noto'g'ri tushuniladi.
    if (percent < current.maxDiscountPercent) {
      warnings.push(
        "Cheklov faqat yangi hisob-fakturalarga ta'sir qiladi — chiqarilganlari o'z summasini saqlaydi",
      );
    }
  }

  if (data.depositAutoApply !== undefined) {
    payload.depositAutoApply = Boolean(data.depositAutoApply);
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
      current: {
        month: currentMonthKey(),
        monthLabel: formatMonthKey(currentMonthKey()),
      },
    },
    warnings,
  };
};

module.exports = {
  MAX_INVOICE_DAY,
  MAX_CATCH_UP_MONTHS,
  serializeSettings,
  getSettings,
  updateSettings,
};
