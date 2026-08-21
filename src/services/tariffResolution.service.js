/**
 * "O'quvchi X ma'lum oyda qancha to'laydi?" — moliya domenining yuragi.
 *
 * Qoida: SNAPSHOT YO'Q. Biriktirish (`StudentTariff`) narxni saqlamaydi —
 * u faqat "qaysi tarif amal qiladi"ni aytadi. Summa har safar
 * `TariffVersion` dan hal qilinadi. Shuning uchun tarif narxi ko'tarilganda
 * birorta biriktirish qatoriga tegilmaydi va o'tkazib yuborilgan qator
 * sababli jim kam hisoblash mumkin emas.
 *
 * (Taqqoslash uchun: `MarketOrder.productSnapshot` — o'tgan fakt, u yerda
 * snapshot to'g'ri. Bu yerda esa kelajakka qaragan qoida.)
 *
 * Alohida faylda, chunki chaqiruvchisi ikkita: `studentTariff.service.js`
 * (hozir) va kelajakdagi hisob-faktura cron'i. Hisob-faktura yozilgan payt —
 * aynan o'sha yerda snapshot olinadi.
 */

const prisma = require("../config/prisma");
// TariffVersion PLATFORMADA, StudentTariff esa FILIALDA. Ikki client, ikki
// so'rov, keyin xotirada join — pastdagi resolveManyForMonth shu shaklda edi.
const platformPrisma = require("../config/platformPrisma");
const { ROLES } = require("../utils/constants");
const { NotFoundError } = require("../utils/errors");
const {
  coveringMonthWhere,
  formatMonthKey,
} = require("../helpers/month.helpers");
const { formatAmount, sumAmounts } = require("../helpers/money.helpers");

// Nima uchun summa hisoblanmadi — UI shu asosda "biriktirilmagan" yoki
// "narx belgilanmagan" deb ko'rsatadi.
const REASONS = {
  NO_ASSIGNMENT: "no_assignment",
  NO_PRICE: "no_price",
};

const STUDENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  role: true,
  isArchived: true,
};

/**
 * Bo'sh natija — 404 emas. 300 o'quvchilik ro'yxat "biriktirilmagan"ni
 * satr ichida ko'rsata olishi kerak, aks holda ommaviy resolve ishlamaydi.
 */
const emptyResult = (studentId, month, reason) => ({
  studentId,
  month,
  monthLabel: formatMonthKey(month),
  items: [],
  total: null,
  reason,
  assignment: null,
});

/**
 * Bitta o'quvchi + bitta oy uchun summa.
 *
 * @param {string} studentId
 * @param {number} month - YYYYMM
 * @returns {Promise<object>} { month, items[], total, reason, assignment }
 */
const resolveForStudentMonth = async (studentId, month) => {
  // Davrni qamragan biriktirish — invariant bo'yicha ko'pi bilan bitta
  // (@@unique + kesishuv tekshiruvi). orderBy — buzilgan ma'lumotda ham
  // aniq qoida bo'lishi uchun: eng kech boshlangani yutadi.
  const assignment = await prisma.studentTariff.findFirst({
    where: { studentId, ...coveringMonthWhere(month) },
    orderBy: { startMonth: "desc" },
  });

  if (!assignment) {
    return emptyResult(studentId, month, REASONS.NO_ASSIGNMENT);
  }

  const version = await platformPrisma.tariffVersion.findFirst({
    where: { tariffId: assignment.tariffId, ...coveringMonthWhere(month) },
    orderBy: { startMonth: "desc" },
    include: { tariff: { select: { id: true, name: true } } },
  });

  if (!version) {
    // Konfiguratsiya xatosi: tarif bor, lekin bu oyga narx belgilanmagan.
    return {
      ...emptyResult(studentId, month, REASONS.NO_PRICE),
      assignment,
    };
  }

  const amount = formatAmount(version.monthlyAmount);

  return {
    studentId,
    month,
    monthLabel: formatMonthKey(month),
    // Bitta element bo'lsa ham massiv: kelajakda qo'shiluvchi tariflar
    // (o'qish + ovqat + yotoqxona) kerak bo'lsa, chaqiruvchilar buzilmaydi.
    items: [
      {
        tariff: version.tariff,
        version: {
          id: version.id,
          startMonth: version.startMonth,
          endMonth: version.endMonth,
        },
        amount,
      },
    ],
    total: amount,
    reason: null,
    assignment,
  };
};

/**
 * O'quvchi mavjudligini tekshirib, keyin summani hal qiladi (bitta o'quvchi
 * uchun endpoint — noto'g'ri id jim "biriktirilmagan" bo'lib ko'rinmasligi
 * kerak).
 *
 * @param {string} studentId
 * @param {number} month
 * @returns {Promise<object>}
 */
const resolveForStudent = async (studentId, month) => {
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: STUDENT_SELECT,
  });

  // O'quvchi alohida model emas — role bo'yicha tekshiriladi
  // (studentAttendance.service.js uslubi).
  if (!student || student.role !== ROLES.STUDENT) {
    throw new NotFoundError("O'quvchi topilmadi");
  }

  const result = await resolveForStudentMonth(studentId, month);
  return { ...result, student };
};

/**
 * Ko'p o'quvchi uchun bitta oyga summa — o'quvchilar soniga qaramay
 * 2 ta so'rov (biriktirishlar + kerakli tariflarning versiyalari), keyin
 * xotirada Map bo'yicha join. Bu funksiya kelajakdagi hisob-faktura
 * cron'ining ham asosi.
 *
 * @param {number} month - YYYYMM
 * @param {{studentIds?: string[]}} options
 * @returns {Promise<{month: number, byStudent: Map<string, object>}>}
 */
const resolveManyForMonth = async (month, { studentIds } = {}) => {
  const assignments = await prisma.studentTariff.findMany({
    where: {
      ...(studentIds?.length ? { studentId: { in: studentIds } } : {}),
      ...coveringMonthWhere(month),
    },
    orderBy: { startMonth: "desc" },
  });

  const tariffIds = [...new Set(assignments.map((a) => a.tariffId))];

  const versions = tariffIds.length
    ? await platformPrisma.tariffVersion.findMany({
        where: { tariffId: { in: tariffIds }, ...coveringMonthWhere(month) },
        orderBy: { startMonth: "desc" },
        include: { tariff: { select: { id: true, name: true } } },
      })
    : [];

  // orderBy desc + birinchisini olish — buzilgan ma'lumotda ham
  // resolveForStudentMonth bilan bir xil qoida.
  const versionByTariff = new Map();
  for (const version of versions) {
    if (!versionByTariff.has(version.tariffId)) {
      versionByTariff.set(version.tariffId, version);
    }
  }

  const byStudent = new Map();

  for (const assignment of assignments) {
    if (byStudent.has(assignment.studentId)) continue;

    const version = versionByTariff.get(assignment.tariffId);

    if (!version) {
      byStudent.set(assignment.studentId, {
        ...emptyResult(assignment.studentId, month, REASONS.NO_PRICE),
        assignment,
      });
      continue;
    }

    const amount = formatAmount(version.monthlyAmount);

    byStudent.set(assignment.studentId, {
      studentId: assignment.studentId,
      month,
      monthLabel: formatMonthKey(month),
      items: [
        {
          tariff: version.tariff,
          version: {
            id: version.id,
            startMonth: version.startMonth,
            endMonth: version.endMonth,
          },
          amount,
        },
      ],
      total: amount,
      reason: null,
      assignment,
    });
  }

  return { month, byStudent };
};

/**
 * Oylik yig'ma varaqa: sinf yoki o'quvchilar ro'yxati bo'yicha kim qancha
 * to'lashi + umumiy summa. Kelajakdagi hisob-faktura yuritishning bevosita
 * kirish nuqtasi.
 *
 * @param {number} month
 * @param {{classId?: string, studentIds?: string[], page: number, limit: number, skip: number}} options
 * @returns {Promise<{rows: object[], total: number, totals: object}>}
 */
const buildMonthSheet = async (month, options) => {
  const { classId, studentIds, skip, limit } = options;

  const studentWhere = {
    role: ROLES.STUDENT,
    isArchived: false,
    ...(classId ? { classes: { some: { classId } } } : {}),
    ...(studentIds?.length ? { id: { in: studentIds } } : {}),
  };

  const [students, total] = await Promise.all([
    prisma.user.findMany({
      where: studentWhere,
      select: STUDENT_SELECT,
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      skip,
      take: limit,
    }),
    prisma.user.count({ where: studentWhere }),
  ]);

  const { byStudent } = await resolveManyForMonth(month, {
    studentIds: students.map((s) => s.id),
  });

  const rows = students.map((student) => {
    const resolved =
      byStudent.get(student.id) ||
      emptyResult(student.id, month, REASONS.NO_ASSIGNMENT);
    return { ...resolved, student };
  });

  const priced = rows.filter((r) => r.total != null);

  // Yig'indi Decimal orqali — string summalarni `+` bilan qo'shib bo'lmaydi.
  const totalAmount = formatAmount(sumAmounts(priced.map((r) => r.total)));

  return {
    rows,
    total,
    totals: {
      studentCount: total,
      withTariff: priced.length,
      withoutTariff: rows.length - priced.length,
      totalAmount,
    },
  };
};

module.exports = {
  REASONS,
  resolveForStudentMonth,
  resolveForStudent,
  resolveManyForMonth,
  buildMonthSheet,
};
