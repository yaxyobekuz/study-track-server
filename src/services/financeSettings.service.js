/**
 * Moliya sozlamalari — akademik davr (maktab bo'yicha global) va hisob-faktura
 * cron'ining konfiguratsiyasi.
 *
 * Repo konvensiyasi: operator sozlaydigan biznes qoidalari .env da emas,
 * singleton sozlama jadvalida (coinSettings.dailyCoinPercentage,
 * attendanceSettings.* kabi). "Oyning nechanchi kunida" — aynan shunday qoida.
 */

const prisma = require("../config/prisma");
const platformPrisma = require("../config/platformPrisma");
const { getFinanceSettings } = require("./settings.service");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const {
  currentMonthKey,
  prevMonth,
  parseOptionalMonthKey,
  formatMonthKey,
  coveringMonthWhere,
} = require("../helpers/month.helpers");
const { formatAmount } = require("../helpers/money.helpers");
const logger = require("../utils/logger");

// Kelmagan kun ayirmasi sozlamasi o'zgarganda qayta hisoblanadigan oylar
// chegarasi — catch-up oynasidan uzoq tarixga avtomat tegilmaydi.
const MAX_ABSENCE_RESYNC_MONTHS = 12;


// Cron ifodasi emas, handler o'qiydigan kun. 28 dan oshmasligi kerak —
// 29-31 fevralda hech qachon kelmaydi va o'sha oy tashlab ketilardi.
const MAX_INVOICE_DAY = 28;
const MAX_CATCH_UP_MONTHS = 12;

const serializeSettings = (settings) => ({
  ...settings,
  firstInvoiceMonthLabel: formatMonthKey(settings.firstInvoiceMonth),
  firstPayrollMonthLabel: formatMonthKey(settings.firstPayrollMonth),
  absenceDeductionFromMonthLabel: formatMonthKey(settings.absenceDeductionFromMonth),
  lastGeneratedMonthLabel: formatMonthKey(settings.lastGeneratedMonth),
});

/**
 * STANDART TARIFNING ekranga chiqadigan ko'rinishi: nomi va JORIY OY narxi.
 *
 * ⚠️ Narx sozlamada SAQLANMAYDI, har safar `TariffVersion` dan o'qiladi
 * (`finance.md` §1: katalogda narx maydoni yo'q). Aks holda tarif narxi
 * oshganda sozlamalar sahifasi eski raqamni ko'rsatib turardi.
 *
 * ⚠️ Tarif ARXIVLANGAN yoki O'CHIRILGAN bo'lishi mumkin — ko'rsatkich
 * jimgina "yo'q" bo'lib qolmasligi uchun bayroq bilan qaytariladi:
 * ekranda "tarif topilmadi" deb ochiq turadi.
 */
const loadDefaultTariff = async (tariffId) => {
  if (!tariffId) return null;

  const month = currentMonthKey();

  const tariff = await platformPrisma.tariff.findUnique({
    where: { id: tariffId },
    select: { id: true, name: true, isActive: true, isArchived: true },
  });

  if (!tariff) {
    return { id: tariffId, name: "Topilmadi", missing: true, amount: null };
  }

  const version = await platformPrisma.tariffVersion.findFirst({
    where: { tariffId, ...coveringMonthWhere(month) },
    orderBy: { startMonth: "desc" },
  });

  return {
    ...tariff,
    missing: false,
    amount: version ? formatAmount(version.monthlyAmount) : null,
    monthLabel: formatMonthKey(month),
  };
};

/**
 * Sozlamalar + joriy oyning akademik tavsifi.
 * @returns {Promise<object>}
 */
const getSettings = async () => {
  const settings = await getFinanceSettings();
  const month = currentMonthKey();
  const defaultTariff = await loadDefaultTariff(settings.defaultTariffId);

  return {
    ...serializeSettings(settings),
    defaultTariff,
    current: {
      month,
      monthLabel: formatMonthKey(month),
      // Ta'til deb belgilanmagan har bir oy to'lanadi — "akademik oy"
      // degan tushuncha yo'q, shuning uchun bu yerda bayroq ham yo'q.
    },
  };
};

/**
 * Kelmagan kun ayirmasi sozlamasi o'zgardi — ta'sirlangan oylardagi MUHRLANGAN
 * oyliklar qayta hisoblanadi (jonli ekranlar o'zi yangilanadi). Eski va yangi
 * boshlanish oyining kichigidan joriy oygacha, ko'pi bilan
 * `MAX_ABSENCE_RESYNC_MONTHS` oy.
 *
 * ⚠️ Xato sozlamani orqaga qaytarmaydi — ogohlantirish bo'lib qaytadi,
 * kunlik oylik passi (06:00) zaxira.
 *
 * @returns {Promise<string[]>} ogohlantirishlar
 */
const resyncAbsenceMonths = async (before, after) => {
  const current = currentMonthKey();
  const bounds = [before, after].filter((m) => m != null && m <= current);
  if (bounds.length === 0) return [];

  const months = [];
  for (let m = current; m >= Math.min(...bounds) && months.length < MAX_ABSENCE_RESYNC_MONTHS; m = prevMonth(m)) {
    months.unshift(m);
  }

  try {
    const { resyncSealedEntries } = require("./payrollDeduction.service");
    const result = await resyncSealedEntries(null, months);
    return result.locked.length > 0
      ? [
          `${result.locked.length} ta oylikka to'lov tushgani uchun kelmagan kun ayirmasi ` +
            "qo'llanmadi — to'langan summa yangi summadan ko'p",
        ]
      : [];
  } catch (error) {
    logger.warn(`[financeSettings] Kelmagan kun ayirmasini qayta hisoblab bo'lmadi: ${error.message}`);
    return ["Oyliklar keyingi kunlik hisobda yangilanadi"];
  }
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

  if (data.firstPayrollMonth !== undefined) {
    payload.firstPayrollMonth = parseOptionalMonthKey(
      data.firstPayrollMonth,
      "Birinchi oylik oyi",
    );
  }

  // KELMAGAN KUN UCHUN AYIRMA — null/"" o'chiradi, oy kaliti shu oydan yoqadi
  if (data.absenceDeductionFromMonth !== undefined) {
    payload.absenceDeductionFromMonth = parseOptionalMonthKey(
      data.absenceDeductionFromMonth,
      "Kelmagan kun ayirmasi boshlanish oyi",
    );
  }

  if (data.depositAutoApply !== undefined) {
    payload.depositAutoApply = Boolean(data.depositAutoApply);
  }

  // ── STANDART TARIF ──────────────────────────
  //
  // Bo'sh qiymat (null / "") — ATAYLAB ruxsat etilgan: avtomat biriktirishni
  // butunlay o'chirish yo'li shu.
  if (data.defaultTariffId !== undefined) {
    const tariffId = data.defaultTariffId || null;

    if (tariffId) {
      const tariff = await platformPrisma.tariff.findUnique({
        where: { id: tariffId },
        select: { id: true, isArchived: true },
      });

      if (!tariff) throw new NotFoundError("Tarif topilmadi");

      // ⚠️ Arxivlangan tarif RAD ETILADI: uni biriktirish `studentTariff`
      // tomonida ham taqiqlangan, ya'ni sozlamada turaversa har bir yangi
      // o'quvchi jimgina tarifsiz qolib ketardi.
      if (tariff.isArchived) {
        throw new BadRequestError("Arxivlangan tarifni standart qilib bo'lmaydi");
      }

      // Narx yo'qligi BLOKLAMAYDI — narxdan oldin biriktirish qonuniy
      // tartib (`studentTariff.service.js` dagi bilan bir xil qoida),
      // lekin jim qolmaymiz.
      const version = await platformPrisma.tariffVersion.findFirst({
        where: { tariffId, ...coveringMonthWhere(currentMonthKey()) },
      });

      if (!version) {
        warnings.push(
          `Tanlangan tarifda ${formatMonthKey(currentMonthKey())} oyi uchun ` +
            "narx belgilanmagan — biriktirish bo'ladi, lekin hisob-faktura yozilmaydi",
        );
      }
    }

    payload.defaultTariffId = tariffId;
  }

  if (Object.keys(payload).length === 0) {
    return { settings: await getSettings(), warnings };
  }

  payload.updatedBy = userId;

  const updated = await prisma.financeSettings.update({
    where: { id: current.id },
    data: payload,
  });

  if (
    payload.absenceDeductionFromMonth !== undefined &&
    payload.absenceDeductionFromMonth !== current.absenceDeductionFromMonth
  ) {
    warnings.push(...(await resyncAbsenceMonths(current.absenceDeductionFromMonth, updated.absenceDeductionFromMonth)));
  }

  return {
    settings: {
      ...serializeSettings(updated),
      defaultTariff: await loadDefaultTariff(updated.defaultTariffId),
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
  loadDefaultTariff,
  MAX_CATCH_UP_MONTHS,
  serializeSettings,
  getSettings,
  updateSettings,
};
