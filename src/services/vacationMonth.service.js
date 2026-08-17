/**
 * Ta'til oylari — MAKTAB BO'YICHA.
 *
 * "Yanvarda o'qimaymiz" degan qaror: o'sha oyda hech kimga hisob-faktura
 * shakllanmaydi. Bu akademik oyna ichidagi ISTISNO — akademik davrning
 * o'zi (sentabr..may) kalendar qoidasi bo'lib qoladi.
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
const {
  academicYearOf,
  academicYearBounds,
  billableMonthsOfYear,
  describeAcademicMonth,
} = require("../helpers/academicYear.helpers");
const { getFinanceSettings } = require("./settings.service");

const serializeVacation = (row) => ({
  ...row,
  monthLabel: formatMonthKey(row.month),
  academicYearLabel: `${row.academicYear}/${row.academicYear + 1}`,
});

/**
 * Ta'til oylari to'plami — generator va hisob-kitob uchun.
 *
 * Jadval kichik (o'quv yiliga 0..3 qator), shuning uchun oraliq bo'yicha
 * emas, kerak bo'lganda butun yil o'qiladi.
 *
 * @param {number} [academicYear] - berilmasa BARCHA ta'til oylari
 * @returns {Promise<Set<number>>} YYYYMM to'plami
 */
const getVacationSet = async (academicYear) => {
  const rows = await prisma.vacationMonth.findMany({
    where: academicYear != null ? { academicYear } : {},
    select: { month: true },
  });

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
 * O'quv yilining oylari — har biri ta'til bayrog'i va tartib raqami bilan.
 * Admin sozlamalar sahifasidagi oylar grid'i shu javobdan chiziladi.
 *
 * @param {object} query - { academicYear }
 * @returns {Promise<object>}
 */
const getVacationMonths = async (query = {}) => {
  const settings = await getFinanceSettings();

  const academicYear =
    query.academicYear != null && query.academicYear !== ""
      ? Number(query.academicYear)
      : academicYearOf(currentMonthKey(), settings);

  if (!Number.isInteger(academicYear)) {
    throw new BadRequestError("O'quv yili noto'g'ri");
  }

  const [rows, vacationSet] = await Promise.all([
    prisma.vacationMonth.findMany({
      where: { academicYear },
      orderBy: { month: "asc" },
    }),
    getVacationSet(academicYear),
  ]);

  const titleByMonth = new Map(rows.map((r) => [r.month, r.title]));
  const idByMonth = new Map(rows.map((r) => [r.month, r.id]));
  const { months, billableMonthCount } = billableMonthsOfYear(
    academicYear,
    settings,
    vacationSet,
  );

  const bounds = academicYearBounds(academicYear, settings);

  return {
    academicYear,
    academicYearLabel: `${academicYear}/${academicYear + 1}`,
    ...bounds,
    academicMonthCount: settings.academicMonthCount,
    billableMonthCount,
    months: months.map((m) => ({
      ...m,
      id: idByMonth.get(m.month) ?? null,
      title: titleByMonth.get(m.month) ?? "",
      monthLabel: formatMonthKey(m.month),
    })),
    items: rows.map(serializeVacation),
  };
};

/**
 * Oyni ta'til deb belgilaydi.
 *
 * `academicYear` HOSILA bo'lsa ham saqlanadi: `academicStartMonth` keyin
 * o'zgarsa eski ta'til oylari jimgina boshqa o'quv yiliga ko'chib ketmasin.
 *
 * @param {object} data - { month, title }
 * @param {string} userId
 * @returns {Promise<object>}
 */
const createVacationMonth = async (data, userId) => {
  const settings = await getFinanceSettings();
  const month = parseMonthKey(data.month, "Oy");

  const academic = describeAcademicMonth(month, settings);
  if (!academic.isAcademicMonth) {
    throw new BadRequestError(
      `${formatMonthKey(month)} akademik oy emas — u allaqachon to'lovsiz`,
    );
  }

  const existing = await prisma.vacationMonth.findUnique({ where: { month } });
  if (existing) {
    throw new BadRequestError(`${formatMonthKey(month)} allaqachon ta'til deb belgilangan`);
  }

  const row = await prisma.vacationMonth.create({
    data: {
      month,
      academicYear: academic.academicYear,
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

  return { message: `${formatMonthKey(row.month)} ta'til ro'yxatidan chiqarildi`, warnings };
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
