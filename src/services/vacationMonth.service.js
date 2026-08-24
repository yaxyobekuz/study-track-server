/**
 * Ta'til oylari — MAKTAB BO'YICHA.
 *
 * "Iyulda o'qimaymiz" degan qaror: o'sha oyda hech kimga hisob-faktura
 * shakllanmaydi.
 *
 * ⚠️ O'QUV YILI TUSHUNCHASI YO'Q. Sukut bo'yicha HAR OY to'lanadi, ta'til esa
 * yagona umumiy istisno. Ilgari ta'til "akademik oyna ichidagi istisno" edi va
 * oynadan tashqaridagi oyni ta'til deb belgilash rad etilardi — endi bunday
 * chegara yo'q, istalgan oy ta'til bo'lishi mumkin.
 *
 * Bitta o'quvchini to'xtatish uchun bu emas, `StudentFinanceStatus.frozen`
 * ishlatiladi.
 *
 * QAYTARILMASLIK: allaqachon shakllangan hisob-faktura ta'til belgilanganda
 * AVTOMATIK bekor qilinmaydi — `warnings` qaytariladi va admin ongli ravishda
 * `POST /invoices/:id/cancel` qiladi.
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const {
  parseMonthKey,
  formatMonthKey,
  currentMonthKey,
} = require("../helpers/month.helpers");

const serializeVacation = (row) => ({
  ...row,
  monthLabel: formatMonthKey(row.month),
});

/**
 * Ta'til oylari to'plami — generator va hisob-kitob uchun.
 *
 * Jadval kichik (yiliga 0..3 qator), shuning uchun filtrsiz butunicha
 * o'qiladi: oraliq bo'yicha so'rov qo'shimcha murakkablik beradi, foyda bermaydi.
 *
 * @returns {Promise<Set<number>>} YYYYMM to'plami
 */
const getVacationSet = async () => {
  const rows = await prisma.vacationMonth.findMany({ select: { month: true } });
  return new Set(rows.map((r) => r.month));
};

/**
 * Berilgan oy ta'tilmi.
 * @param {number} month - YYYYMM
 * @returns {Promise<boolean>}
 */
const isVacationMonth = async (month) => {
  const row = await prisma.vacationMonth.findUnique({ where: { month } });
  return Boolean(row);
};

/**
 * KALENDAR YILINING 12 oyi — har biri ta'til bayrog'i bilan.
 * Admin sozlamalar sahifasidagi oylar grid'i shu javobdan chiziladi.
 *
 * Oyna sodda: yanvardan dekabrgacha. Ta'til deb belgilanmagan har bir oy
 * to'lanadi, shuning uchun bu ekran "yilning qaysi oylari bepul" degan
 * savolning YAGONA javob joyi.
 *
 * @param {object} query - { year }
 * @returns {Promise<object>}
 */
const getVacationMonths = async (query = {}) => {
  const current = currentMonthKey();
  const year =
    query.year != null && query.year !== ""
      ? Number(query.year)
      : Math.trunc(current / 100);

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new BadRequestError("Yil noto'g'ri");
  }

  const rows = await prisma.vacationMonth.findMany({
    where: { month: { gte: year * 100 + 1, lte: year * 100 + 12 } },
    orderBy: { month: "asc" },
  });

  const titleByMonth = new Map(rows.map((r) => [r.month, r.title]));
  const idByMonth = new Map(rows.map((r) => [r.month, r.id]));

  const months = Array.from({ length: 12 }, (_, index) => {
    const month = year * 100 + index + 1;
    return {
      month,
      monthLabel: formatMonthKey(month),
      isVacation: idByMonth.has(month),
      isPast: month < current,
      isCurrent: month === current,
      id: idByMonth.get(month) ?? null,
      title: titleByMonth.get(month) ?? "",
    };
  });

  return {
    year,
    currentMonth: current,
    // Shu yilda to'lanadigan oylar soni — ta'til chegirilgan holda
    billableMonthCount: months.filter((m) => !m.isVacation).length,
    months,
    items: rows.map(serializeVacation),
  };
};

/**
 * Oyni ta'til deb belgilaydi.
 *
 * Istalgan oy ta'til bo'lishi mumkin — o'quv yili oynasi yo'q, ya'ni
 * tekshiriladigan chegara ham yo'q.
 *
 * @param {object} data - { month, title }
 * @param {string} userId
 * @returns {Promise<object>}
 */
const createVacationMonth = async (data, userId) => {
  const month = parseMonthKey(data.month, "Oy");

  const existing = await prisma.vacationMonth.findUnique({ where: { month } });
  if (existing) {
    throw new BadRequestError(
      `${formatMonthKey(month)} allaqachon ta'til deb belgilangan`,
    );
  }

  const row = await prisma.vacationMonth.create({
    data: {
      month,
      title: data.title?.trim() || "",
      createdBy: userId,
    },
  });

  const warnings = await collectInvoiceWarnings(month);

  return { ...serializeVacation(row), warnings };
};

/**
 * Ta'til belgisini olib tashlaydi.
 *
 * Kelasi generatsiyadan boshlab o'sha oyga hisob-faktura yoziladi.
 * O'tgan oyni ochish — qarz "orqaga" paydo bo'lishi demak, shuning uchun
 * ogohlantiriladi.
 *
 * @param {string} id
 * @returns {Promise<{message: string, warnings: string[]}>}
 */
const deleteVacationMonth = async (id) => {
  const row = await prisma.vacationMonth.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Ta'til oyi topilmadi");

  await prisma.vacationMonth.delete({ where: { id } });

  const warnings =
    row.month < currentMonthKey()
      ? [
          `${formatMonthKey(row.month)} o'tgan oy — hisob-faktura avtomatik shakllanmaydi. ` +
            "Kerak bo'lsa qo'lda shakllantiring.",
        ]
      : [];

  return {
    message: `${formatMonthKey(row.month)} ta'til ro'yxatidan chiqarildi`,
    warnings,
  };
};

/**
 * Shu oy uchun allaqachon chiqarilgan hisob-fakturalar haqida ogohlantirish.
 * Qaytarilmaslik qoidasini admin harakat qila oladigan paytda ko'rsatadi.
 */
const collectInvoiceWarnings = async (month) => {
  const count = await prisma.monthlyInvoice.count({
    where: { month, status: { not: "cancelled" } },
  });

  if (count === 0) return [];

  return [
    `${formatMonthKey(month)} uchun ${count} ta hisob-faktura allaqachon shakllantirilgan — ` +
      "ular avtomatik bekor qilinmaydi",
  ];
};

module.exports = {
  serializeVacation,
  getVacationSet,
  isVacationMonth,
  getVacationMonths,
  createVacationMonth,
  deleteVacationMonth,
};
