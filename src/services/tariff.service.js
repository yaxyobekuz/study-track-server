/**
 * Tariflar katalogi va narx versiyalari.
 *
 * Asosiy g'oya: katalogda narx YO'Q. Narx — `TariffVersion` qatorlari,
 * har biri `[startMonth, endMonth]` davri uchun. Narxni ko'tarish = eski
 * versiyani yopish + yangisini keyingi oydan ochish; o'quvchilarning
 * biriktirishlariga umuman tegilmaydi (qarang: tariffResolution.service.js).
 */

const prisma = require("../config/prisma");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const logger = require("../utils/logger");
const {
  currentMonthKey,
  nextMonth,
  prevMonth,
  parseMonthKey,
  parseOptionalMonthKey,
  formatMonthKey,
  formatMonthRange,
  coveringMonthWhere,
  overlappingPeriodWhere,
  findGaps,
} = require("../helpers/month.helpers");
const { parseAmount, formatAmount } = require("../helpers/money.helpers");

// Barcha summalar so'mda. `Tariff.currency` ustuni sxemada default "UZS"
// bilan qoladi (kelajakda kerak bo'lsa), lekin bu qatlam uni o'qimaydi ham,
// yozmaydi ham.
const NAME_MIN = 2;
const NAME_MAX = 100;

// ─────────────────────────────────────────────
// Serializatsiya (pul har doim 2 xonali string)
// ─────────────────────────────────────────────

const serializeVersion = (version) =>
  version == null
    ? null
    : {
        ...version,
        monthlyAmount: formatAmount(version.monthlyAmount),
        startMonthLabel: formatMonthKey(version.startMonth),
        endMonthLabel: formatMonthKey(version.endMonth),
      };

const serializeTariff = (tariff) => {
  const { versions, ...rest } = tariff;
  return versions
    ? { ...rest, versions: versions.map(serializeVersion) }
    : rest;
};

// ─────────────────────────────────────────────
// Validatsiya (repoda validatsiya kutubxonasi yo'q — qo'lda)
// ─────────────────────────────────────────────

const parseName = (value) => {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new BadRequestError("Tarif nomi majburiy");
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    throw new BadRequestError(
      `Tarif nomi ${NAME_MIN} dan ${NAME_MAX} gacha belgi bo'lishi kerak`,
    );
  }
  return name;
};

/** Prisma unique-constraint xatosini o'zbekcha xabarga o'giradi. */
const rethrowDuplicate = (error, message) => {
  if (error?.code === "P2002") throw new BadRequestError(message);
  throw error;
};

/**
 * Davr chegaralarini tekshiradi.
 * @returns {{startMonth: number, endMonth: number|null}}
 */
const parsePeriod = (startValue, endValue, { defaultStart } = {}) => {
  const startMonth =
    startValue == null || startValue === ""
      ? defaultStart
      : parseMonthKey(startValue, "Boshlanish oyi");

  if (startMonth == null) throw new BadRequestError("Boshlanish oyi ko'rsatilmagan");

  const endMonth = parseOptionalMonthKey(endValue, "Tugash oyi");

  if (endMonth != null && endMonth < startMonth) {
    throw new BadRequestError(
      "Tugash oyi boshlanish oyidan oldin bo'lishi mumkin emas",
    );
  }

  return { startMonth, endMonth };
};

/**
 * Bir tarif ichida davrlar kesishmasligini tekshiradi.
 * Tekshiruv yozuv bilan BITTA tranzaksiyada bajarilishi shart (TOCTOU);
 * poyga holatidagi haqiqiy kafolat — @@unique([tariffId, startMonth]).
 *
 * @param {object} tx - Prisma transaction client
 * @param {string} tariffId
 * @param {{startMonth: number, endMonth: number|null}} period
 * @param {string|null} excludeId - tahrirlashda o'zini hisobga olmaslik uchun
 */
const assertNoVersionOverlap = async (tx, tariffId, period, excludeId = null) => {
  const conflict = await tx.tariffVersion.findFirst({
    where: {
      tariffId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      ...overlappingPeriodWhere(period.startMonth, period.endMonth),
    },
    orderBy: { startMonth: "asc" },
  });

  if (!conflict) return;

  // Bir oydan boshlanadigan ikkita narx bo'lishi mumkin emas — bu yerda
  // yangi versiya emas, mavjudini tahrirlash kerak.
  if (conflict.startMonth === period.startMonth) {
    throw new BadRequestError(
      `${formatMonthKey(period.startMonth)} oyidan boshlanadigan narx allaqachon bor — ` +
        "yangi versiya qo'shish o'rniga o'shani tahrirlang",
    );
  }

  throw new BadRequestError(
    `Bu davr uchun tarifda boshqa narx belgilangan (${formatMonthRange(
      conflict.startMonth,
      conflict.endMonth,
    )}). Tugash oyini ko'rsating yoki o'sha versiyani tahrirlang.`,
  );
};

// ─────────────────────────────────────────────
// Katalog
// ─────────────────────────────────────────────

const buildTariffFilter = (query) => {
  const filter = {};

  if (query.isArchived === "true") filter.isArchived = true;
  else if (query.isArchived === "all") {
    /* filtrsiz */
  } else filter.isArchived = false;

  if (query.isActive === "true") filter.isActive = true;
  if (query.isActive === "false") filter.isActive = false;

  const search = query.search?.trim();
  if (search) {
    filter.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { description: { contains: search, mode: "insensitive" } },
    ];
  }

  return filter;
};

/**
 * Tariflar ro'yxati. Har bir tarifga o'sha oydagi amaldagi versiya va
 * biriktirilgan o'quvchilar soni qo'shiladi (N+1 siz — 2 qo'shimcha so'rov).
 *
 * @param {object} req - Express request (query: page, limit, search, isActive, isArchived, month)
 * @returns {Promise<object>} paginated response
 */
const getTariffs = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const filter = buildTariffFilter(req.query);
  const month = req.query.month
    ? parseMonthKey(req.query.month, "Oy")
    : currentMonthKey();

  const [rows, total] = await Promise.all([
    prisma.tariff.findMany({
      where: filter,
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      skip,
      take: limit,
    }),
    prisma.tariff.count({ where: filter }),
  ]);

  const tariffIds = rows.map((t) => t.id);

  const [currentVersions, versionCounts, assignmentCounts] = await Promise.all([
    tariffIds.length
      ? prisma.tariffVersion.findMany({
          where: { tariffId: { in: tariffIds }, ...coveringMonthWhere(month) },
        })
      : [],
    tariffIds.length
      ? prisma.tariffVersion.groupBy({
          by: ["tariffId"],
          where: { tariffId: { in: tariffIds } },
          _count: { _all: true },
        })
      : [],
    tariffIds.length
      ? prisma.studentTariff.groupBy({
          by: ["tariffId"],
          where: { tariffId: { in: tariffIds } },
          _count: { _all: true },
        })
      : [],
  ]);

  const versionMap = new Map(currentVersions.map((v) => [v.tariffId, v]));
  const versionCountMap = new Map(
    versionCounts.map((v) => [v.tariffId, v._count._all]),
  );
  const assignmentCountMap = new Map(
    assignmentCounts.map((a) => [a.tariffId, a._count._all]),
  );

  const items = rows.map((tariff) => ({
    ...serializeTariff(tariff),
    month,
    currentVersion: serializeVersion(versionMap.get(tariff.id) || null),
    versionCount: versionCountMap.get(tariff.id) || 0,
    assignedStudentCount: assignmentCountMap.get(tariff.id) || 0,
  }));

  return formatPaginationResponse(items, total, page, limit);
};

/**
 * Bitta tarif — narx tarixi, bo'shliqlar va biriktirishlar soni bilan.
 * @param {string} id
 * @param {number|null} month - amaldagi versiyani qaysi oyga hisoblash
 * @returns {Promise<object>}
 */
const getTariffById = async (id, month = null) => {
  const targetMonth = month == null ? currentMonthKey() : month;

  const tariff = await prisma.tariff.findUnique({
    where: { id },
    include: { versions: { orderBy: { startMonth: "desc" } } },
  });

  if (!tariff) throw new NotFoundError("Tarif topilmadi");

  const assignedStudentCount = await prisma.studentTariff.count({
    where: { tariffId: id },
  });

  const currentVersion =
    tariff.versions.find(
      (v) =>
        v.startMonth <= targetMonth &&
        (v.endMonth == null || v.endMonth >= targetMonth),
    ) || null;

  return {
    ...serializeTariff(tariff),
    month: targetMonth,
    currentVersion: serializeVersion(currentVersion),
    gaps: findGaps(tariff.versions).map((gap) => ({
      ...gap,
      label: formatMonthRange(gap.fromMonth, gap.toMonth),
    })),
    hasOpenEnded: tariff.versions.some((v) => v.endMonth == null),
    assignedStudentCount,
  };
};

/**
 * Tarif yaratadi. `initialVersion` berilsa, birinchi narx ham bir vaqtda
 * yoziladi (nested create — id auto-id extension tomonidan qo'yiladi).
 *
 * @param {object} data - { name, description, isActive, initialVersion }
 * @param {string} userId
 * @returns {Promise<object>}
 */
const createTariff = async (data, userId) => {
  const name = parseName(data.name);

  let versionCreate;
  if (data.initialVersion) {
    const period = parsePeriod(
      data.initialVersion.startMonth,
      data.initialVersion.endMonth,
      { defaultStart: currentMonthKey() },
    );
    versionCreate = {
      ...period,
      monthlyAmount: parseAmount(
        data.initialVersion.monthlyAmount,
        "Oylik summa",
      ),
      note: data.initialVersion.note?.trim() || "",
      createdBy: userId,
    };
  }

  try {
    const tariff = await prisma.tariff.create({
      data: {
        name,
        description: data.description?.trim() || "",
        isActive: data.isActive !== false,
        createdBy: userId,
        ...(versionCreate ? { versions: { create: versionCreate } } : {}),
      },
      include: { versions: true },
    });

    return serializeTariff(tariff);
  } catch (error) {
    return rethrowDuplicate(error, "Bu nomli tarif allaqachon mavjud");
  }
};

/**
 * Tarifni tahrirlaydi (narxni EMAS — narx faqat yangi versiya orqali).
 * @param {string} id
 * @param {object} data - { name, description, isActive }
 * @returns {Promise<object>}
 */
const updateTariff = async (id, data) => {
  const tariff = await prisma.tariff.findUnique({ where: { id } });
  if (!tariff) throw new NotFoundError("Tarif topilmadi");

  const payload = {};

  if (data.name !== undefined) payload.name = parseName(data.name);
  if (data.description !== undefined) {
    payload.description = data.description?.trim() || "";
  }
  if (data.isActive !== undefined) payload.isActive = Boolean(data.isActive);

  try {
    const updated = await prisma.tariff.update({ where: { id }, data: payload });
    return serializeTariff(updated);
  } catch (error) {
    return rethrowDuplicate(error, "Bu nomli tarif allaqachon mavjud");
  }
};

/**
 * Arxivlash / arxivdan qaytarish. Arxivlangan tarif yangi biriktirish uchun
 * tanlanmaydi, lekin mavjud biriktirishlar uchun narx hal qilinaveradi —
 * moliyaviy tarix hisoblanadigan bo'lib qolishi kerak.
 *
 * @param {string} id
 * @param {boolean} isArchived
 * @returns {Promise<object>}
 */
const setTariffArchived = async (id, isArchived) => {
  const tariff = await prisma.tariff.findUnique({ where: { id } });
  if (!tariff) throw new NotFoundError("Tarif topilmadi");

  const updated = await prisma.tariff.update({
    where: { id },
    data: {
      isArchived: Boolean(isArchived),
      archivedAt: isArchived ? new Date() : null,
    },
  });

  return serializeTariff(updated);
};

/**
 * Tarifni o'chiradi. Versiyalar cascade bo'ladi (egalik ostidagi bolalar),
 * lekin biriktirish bo'lsa — rad etiladi. Biriktirish soft ref, ya'ni FK
 * to'xtatmaydi: qo'lda sanaymiz.
 *
 * @param {string} id
 * @returns {Promise<{message: string}>}
 */
const deleteTariff = async (id) => {
  const tariff = await prisma.tariff.findUnique({ where: { id } });
  if (!tariff) throw new NotFoundError("Tarif topilmadi");

  const assignmentCount = await prisma.studentTariff.count({
    where: { tariffId: id },
  });

  if (assignmentCount > 0) {
    throw new BadRequestError(
      `Bu tarifga ${assignmentCount} ta o'quvchi biriktirilgan — o'chirib bo'lmaydi. Uni arxivlang.`,
    );
  }

  await prisma.tariff.delete({ where: { id } });

  return { message: "Tarif o'chirildi" };
};

/**
 * Narx tarixi + bo'shliqlar. UI ogohlantirishlari uchun.
 * @param {string} id
 * @returns {Promise<object>}
 */
const getTariffTimeline = async (id) => {
  const tariff = await prisma.tariff.findUnique({
    where: { id },
    include: { versions: { orderBy: { startMonth: "desc" } } },
  });

  if (!tariff) throw new NotFoundError("Tarif topilmadi");

  return {
    tariffId: id,
    versions: tariff.versions.map(serializeVersion),
    gaps: findGaps(tariff.versions).map((gap) => ({
      ...gap,
      label: formatMonthRange(gap.fromMonth, gap.toMonth),
    })),
    hasOpenEnded: tariff.versions.some((v) => v.endMonth == null),
  };
};

// ─────────────────────────────────────────────
// Narx versiyalari
// ─────────────────────────────────────────────

/**
 * Tarif versiyalari (sahifalangan).
 * @param {string} tariffId
 * @param {object} req
 * @returns {Promise<object>} paginated response
 */
const getVersions = async (tariffId, req) => {
  const { page, limit, skip } = getPaginationParams(req);

  const tariff = await prisma.tariff.findUnique({ where: { id: tariffId } });
  if (!tariff) throw new NotFoundError("Tarif topilmadi");

  const [rows, total] = await Promise.all([
    prisma.tariffVersion.findMany({
      where: { tariffId },
      orderBy: { startMonth: "desc" },
      skip,
      take: limit,
    }),
    prisma.tariffVersion.count({ where: { tariffId } }),
  ]);

  return formatPaginationResponse(rows.map(serializeVersion), total, page, limit);
};

/**
 * Yangi narx versiyasi. Ikki yo'nalishda ham ishlaydi:
 *
 *  - OLDINGA (narxni ko'tarish): `startMonth` berilmasa keyingi oy olinadi,
 *    va `autoCloseCurrent` (default true) undan oldin ochiq turgan versiyani
 *    `startMonth - 1` da yopadi.
 *  - ORQAGA (o'tgan davr narxini kiritish): `endMonth` berilmasa, u keyingi
 *    versiya boshlanishidan bir oy oldin qilib avtomatik hisoblanadi.
 *    Aks holda har bir yangi versiya "ochiq" bo'lib, mavjud ochiq versiya
 *    bilan to'qnashaverardi.
 *
 * Hammasi bitta tranzaksiyada — oraliqda tarif ikkita amaldagi narx bilan
 * qolib ketmasligi kerak.
 *
 * @param {string} tariffId
 * @param {object} data - { startMonth, endMonth, monthlyAmount, note, autoCloseCurrent }
 * @param {string} userId
 * @returns {Promise<object>}
 */
const addVersion = async (tariffId, data, userId) => {
  const tariff = await prisma.tariff.findUnique({ where: { id: tariffId } });
  if (!tariff) throw new NotFoundError("Tarif topilmadi");

  const startMonth =
    data.startMonth == null || data.startMonth === ""
      ? nextMonth(currentMonthKey())
      : parseMonthKey(data.startMonth, "Boshlanish oyi");

  const explicitEnd = parseOptionalMonthKey(data.endMonth, "Tugash oyi");
  if (explicitEnd != null && explicitEnd < startMonth) {
    throw new BadRequestError(
      "Tugash oyi boshlanish oyidan oldin bo'lishi mumkin emas",
    );
  }

  const monthlyAmount = parseAmount(data.monthlyAmount, "Oylik summa");
  const autoClose = data.autoCloseCurrent !== false;

  let period = { startMonth, endMonth: explicitEnd };

  try {
    return await prisma.$transaction(async (tx) => {
      if (autoClose) {
        // Yangi davrdan OLDIN boshlangan ochiq versiyani yopamiz.
        const openVersion = await tx.tariffVersion.findFirst({
          where: { tariffId, endMonth: null, startMonth: { lt: startMonth } },
        });

        if (openVersion) {
          await tx.tariffVersion.update({
            where: { id: openVersion.id },
            data: { endMonth: prevMonth(startMonth) },
          });
        }
      }

      // Tugash oyi ko'rsatilmagan bo'lsa — keyingi versiyagacha davom etadi.
      // Shu yerda o'tgan davr uchun narx kiritish imkoni paydo bo'ladi.
      if (period.endMonth == null) {
        const nextVersion = await tx.tariffVersion.findFirst({
          where: { tariffId, startMonth: { gt: startMonth } },
          orderBy: { startMonth: "asc" },
        });

        if (nextVersion) {
          period = { startMonth, endMonth: prevMonth(nextVersion.startMonth) };
        }
      }

      await assertNoVersionOverlap(tx, tariffId, period);

      const version = await tx.tariffVersion.create({
        data: {
          tariffId,
          ...period,
          monthlyAmount,
          note: data.note?.trim() || "",
          createdBy: userId,
        },
      });

      return serializeVersion(version);
    });
  } catch (error) {
    return rethrowDuplicate(
      error,
      `Tarifda ${formatMonthKey(startMonth)} oyidan boshlanadigan versiya allaqachon bor — uni tahrirlang`,
    );
  }
};

/**
 * Versiyani tahrirlaydi.
 *
 * Amaldagi (startMonth <= joriy oy) versiyaning SUMMASI va BOSHLANISHI
 * o'zgarmas — aks holda o'tgan oylar uchun hisoblangan summa jim o'zgarib
 * ketardi. Yangi narx = yangi versiya. `endMonth` faqat oldinga suriladi.
 *
 * Haqiqiy kiritish xatosini to'g'rilash uchun `force` bor — alohida
 * `tariffs.adjust` ruxsati talab qilinadi va logga yoziladi.
 *
 * @param {string} tariffId
 * @param {string} versionId
 * @param {object} data - { startMonth, endMonth, monthlyAmount, note }
 * @param {{force?: boolean, userId: string}} options
 * @returns {Promise<object>}
 */
const updateVersion = async (tariffId, versionId, data, options = {}) => {
  const { force = false, userId } = options;

  const version = await prisma.tariffVersion.findFirst({
    where: { id: versionId, tariffId },
  });
  if (!version) throw new NotFoundError("Tarif versiyasi topilmadi");

  const now = currentMonthKey();
  const isInEffect = version.startMonth <= now;
  const payload = {};

  if (data.note !== undefined) payload.note = data.note?.trim() || "";

  if (data.monthlyAmount !== undefined) {
    const amount = parseAmount(data.monthlyAmount, "Oylik summa");
    if (isInEffect && !force && !amount.equals(version.monthlyAmount)) {
      throw new BadRequestError(
        "Amaldagi tarif versiyasi narxini o'zgartirib bo'lmaydi. Yangi versiya qo'shing.",
      );
    }
    payload.monthlyAmount = amount;
  }

  const wantsPeriodChange =
    data.startMonth !== undefined || data.endMonth !== undefined;

  if (wantsPeriodChange) {
    const period = parsePeriod(
      data.startMonth !== undefined ? data.startMonth : version.startMonth,
      data.endMonth !== undefined ? data.endMonth : version.endMonth,
      { defaultStart: version.startMonth },
    );

    if (isInEffect && !force) {
      if (period.startMonth !== version.startMonth) {
        throw new BadRequestError(
          "Amaldagi versiya boshlanish oyini o'zgartirib bo'lmaydi",
        );
      }
      // Yopish faqat oldinga: allaqachon hisoblangan oylarni kesib bo'lmaydi.
      const minEnd = Math.max(now, version.startMonth);
      if (period.endMonth != null && period.endMonth < minEnd) {
        throw new BadRequestError(
          `Amaldagi versiyani ${formatMonthKey(minEnd)} dan oldin yopib bo'lmaydi`,
        );
      }
    }

    payload.startMonth = period.startMonth;
    payload.endMonth = period.endMonth;
  }

  if (Object.keys(payload).length === 0) {
    return serializeVersion(version);
  }

  if (force && isInEffect) {
    logger.warn(
      `[tariffs] Amaldagi versiya majburiy tahrirlandi: version=${versionId} tariff=${tariffId} ` +
        `actor=${userId} oldingi=${version.monthlyAmount.toFixed(2)}/${formatMonthRange(
          version.startMonth,
          version.endMonth,
        )} yangi=${JSON.stringify({
          ...payload,
          monthlyAmount: payload.monthlyAmount
            ? payload.monthlyAmount.toFixed(2)
            : undefined,
        })}`,
    );
  }

  try {
    return await prisma.$transaction(async (tx) => {
      if (payload.startMonth !== undefined || payload.endMonth !== undefined) {
        await assertNoVersionOverlap(
          tx,
          tariffId,
          {
            startMonth: payload.startMonth ?? version.startMonth,
            endMonth:
              payload.endMonth !== undefined
                ? payload.endMonth
                : version.endMonth,
          },
          versionId,
        );
      }

      const updated = await tx.tariffVersion.update({
        where: { id: versionId },
        data: payload,
      });

      return serializeVersion(updated);
    });
  } catch (error) {
    return rethrowDuplicate(
      error,
      "Tarifda shu oydan boshlanadigan versiya allaqachon bor",
    );
  }
};

/**
 * Versiyani o'chiradi — faqat hali boshlanmagan (kelajakdagi) versiyani.
 * @param {string} tariffId
 * @param {string} versionId
 * @returns {Promise<{message: string}>}
 */
const deleteVersion = async (tariffId, versionId) => {
  const version = await prisma.tariffVersion.findFirst({
    where: { id: versionId, tariffId },
  });
  if (!version) throw new NotFoundError("Tarif versiyasi topilmadi");

  if (version.startMonth <= currentMonthKey()) {
    throw new BadRequestError(
      "Amaldagi yoki o'tgan versiyani o'chirib bo'lmaydi",
    );
  }

  await prisma.tariffVersion.delete({ where: { id: versionId } });

  return { message: "Versiya o'chirildi" };
};

module.exports = {
  serializeTariff,
  serializeVersion,
  getTariffs,
  getTariffById,
  createTariff,
  updateTariff,
  setTariffArchived,
  deleteTariff,
  getTariffTimeline,
  getVersions,
  addVersion,
  updateVersion,
  deleteVersion,
};
