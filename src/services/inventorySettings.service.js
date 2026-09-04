/**
 * Inventar bo'limi sozlamalari.
 *
 * Repo konvensiyasi: operator sozlaydigan biznes qoidalari .env da emas,
 * singleton sozlama jadvalida (`financeSettings.invoiceDayOfMonth`,
 * `coinSettings.dailyCoinPercentage` kabi).
 *
 * ⚠️ ESLATMA VAQTI CRON IFODASIDA EMAS. Job har soatda uyg'onadi va vaqtni
 * BAZADAN o'qiydi — aks holda vaqtni o'zgartirish uchun serverni qayta
 * ishga tushirish kerak bo'lardi (`changelogNotification.job.js` bilan
 * bir xil qaror).
 */

const prisma = require("../config/prisma");
const { getInventorySettings } = require("./settings.service");
const { BadRequestError, NotFoundError } = require("../utils/errors");

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const serializeSettings = (settings, { defaultAccount } = {}) => ({
  ...settings,
  defaultAccountName: defaultAccount?.name ?? null,
});

/** Sozlamalar + tanlangan to'lov turining nomi. */
const getSettings = async () => {
  const settings = await getInventorySettings();

  const defaultAccount = settings.defaultAccountId
    ? await prisma.paymentAccount.findUnique({
        where: { id: settings.defaultAccountId },
        select: { id: true, name: true, isArchived: true },
      })
    : null;

  return serializeSettings(settings, { defaultAccount });
};

/**
 * Faol to'lov turlari — FAQAT id va nom.
 *
 * Undiruv oynasi va "standart to'lov turi" tanlagichi uchun. `paymentAccount`
 * registrining o'zi (`GET /payment-accounts`) qoldiqni ham qaytaradi va
 * `finance.view` talab qiladi; undiruvni qabul qiladigan xodimga kassadagi
 * pul miqdorini ko'rish huquqi berilmasligi kerak — shuning uchun alohida,
 * qisqa ro'yxat.
 *
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
const getPaymentAccountOptions = async () =>
  prisma.paymentAccount.findMany({
    where: { isArchived: false, isActive: true },
    select: { id: true, name: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

/**
 * Sozlamalarni yangilaydi.
 *
 * @param {object} data - { dailyCheckEnabled, reminderTime, reminderEnabled,
 *                          requirePhoto, defaultAccountId }
 * @param {string} userId
 */
const updateSettings = async (data, userId) => {
  const current = await getInventorySettings();
  const payload = {};

  if (data.dailyCheckEnabled !== undefined) {
    payload.dailyCheckEnabled = Boolean(data.dailyCheckEnabled);
  }
  if (data.reminderEnabled !== undefined) {
    payload.reminderEnabled = Boolean(data.reminderEnabled);
  }
  if (data.requirePhoto !== undefined) {
    payload.requirePhoto = Boolean(data.requirePhoto);
  }

  if (data.reminderTime !== undefined) {
    const time = String(data.reminderTime ?? "").trim();
    if (!TIME_RE.test(time)) {
      throw new BadRequestError("Eslatma vaqti HH:mm ko'rinishida bo'lishi kerak");
    }
    payload.reminderTime = time;
  }

  if (data.defaultAccountId !== undefined) {
    if (!data.defaultAccountId) {
      payload.defaultAccountId = null;
    } else {
      const account = await prisma.paymentAccount.findUnique({
        where: { id: data.defaultAccountId },
      });
      if (!account) throw new NotFoundError("To'lov turi topilmadi");
      if (account.isArchived || !account.isActive) {
        throw new BadRequestError(`"${account.name}" faol emas`);
      }
      payload.defaultAccountId = account.id;
    }
  }

  if (Object.keys(payload).length === 0) {
    throw new BadRequestError("O'zgartirish uchun ma'lumot yo'q");
  }

  payload.updatedBy = userId;

  await prisma.inventorySettings.update({ where: { id: current.id }, data: payload });

  return getSettings();
};

module.exports = {
  serializeSettings,
  getSettings,
  getPaymentAccountOptions,
  updateSettings,
};
