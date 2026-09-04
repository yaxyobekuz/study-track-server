/**
 * XONALAR (lokatsiyalar) — xatlovning birinchi o'lchovi.
 *
 * "1-A sinf xonasi", "Oshxona", "Sport zali", "2-qavat yo'lagi". Butun
 * moddiy-texnik baza shu kesimda saqlanadi: har bir jihoz ANIQ bitta
 * xonaga tegishli, chunki "maktabda 400 ta stul bor" degan raqam
 * monitoringda foydasiz — "1-A da 20 ta stul bor, bugun 1 tasi sindi"
 * kerak.
 *
 * ── MAS'UL SHAXS ≠ AYBDOR ────────────────────
 *
 * `responsibleId` — kunlik hisobotni KIM YUBORISHI kerakligini bildiradi
 * (sinf rahbari, oshxona mudiri). U avtomatik aybdor EMAS: zarar aniq
 * odamga alohida qaror bilan yoziladi (`DamageCharge`). Ikkalasini bir
 * maydonga qo'shsak, sinf rahbari o'quvchi singan har bir partaning
 * pulini to'lab yurardi.
 */

const prisma = require("../config/prisma");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const { LOCATION_TYPE_LABELS } = require("../helpers/inventory.helpers");

const RESPONSIBLE_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  role: true,
  isArchived: true,
};

const LOCATION_TYPES = Object.keys(LOCATION_TYPE_LABELS);

const serializeLocation = (row, { responsible, klass, stats } = {}) => {
  const { ...rest } = row;

  return {
    ...rest,
    typeLabel: LOCATION_TYPE_LABELS[row.type] ?? row.type,
    responsible: responsible ?? null,
    responsibleName: responsible
      ? `${responsible.firstName} ${responsible.lastName ?? ""}`.trim()
      : null,
    className: klass?.name ?? null,
    ...(stats ?? {}),
  };
};

/**
 * Xonaning xatlov ko'rsatkichlari — ro'yxat ekranida har bir xona uchun
 * alohida so'rov yubormaslik uchun bitta guruhlangan so'rovda olinadi.
 *
 * @param {string[]} locationIds
 * @returns {Promise<Map<string, {itemCount, totalQuantity, brokenQuantity, serviceableQuantity}>>}
 */
const statsByLocation = async (locationIds) => {
  if (!locationIds?.length) return new Map();

  const rows = await prisma.inventoryStock.groupBy({
    by: ["locationId"],
    where: { locationId: { in: locationIds } },
    _sum: { quantity: true, brokenQuantity: true },
    _count: { _all: true },
  });

  return new Map(
    rows.map((r) => {
      const totalQuantity = r._sum.quantity ?? 0;
      const brokenQuantity = r._sum.brokenQuantity ?? 0;
      return [
        r.locationId,
        {
          itemCount: r._count._all,
          totalQuantity,
          brokenQuantity,
          // HOSILA — ustun EMAS: ikkita haqiqat manbai bo'lib qolardi
          serviceableQuantity: totalQuantity - brokenQuantity,
        },
      ];
    }),
  );
};

/** Xonalarga mas'ul va sinf nomlarini biriktiradi (soft ref → qo'lda join). */
const attachRefs = async (rows) => {
  const responsibleIds = [...new Set(rows.map((r) => r.responsibleId).filter(Boolean))];
  const classIds = [...new Set(rows.map((r) => r.classId).filter(Boolean))];

  const [people, classes] = await Promise.all([
    responsibleIds.length
      ? prisma.user.findMany({
          where: { id: { in: responsibleIds } },
          select: RESPONSIBLE_SELECT,
        })
      : [],
    classIds.length
      ? prisma.class.findMany({
          where: { id: { in: classIds } },
          select: { id: true, name: true },
        })
      : [],
  ]);

  return {
    peopleById: new Map(people.map((p) => [p.id, p])),
    classesById: new Map(classes.map((c) => [c.id, c])),
  };
};

/**
 * Xonalar ro'yxati (sahifalangan).
 * @param {object} req - query: { type, responsibleId, status, search, page, limit }
 */
const getLocations = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const where = { isArchived: query.status === "archived" };
  if (query.type) where.type = query.type;
  if (query.responsibleId) where.responsibleId = query.responsibleId;
  if (query.search?.trim()) {
    where.name = { contains: query.search.trim(), mode: "insensitive" };
  }

  const [rows, total] = await Promise.all([
    prisma.inventoryLocation.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      skip,
      take: limit,
    }),
    prisma.inventoryLocation.count({ where }),
  ]);

  const [{ peopleById, classesById }, stats] = await Promise.all([
    attachRefs(rows),
    statsByLocation(rows.map((r) => r.id)),
  ]);

  return formatPaginationResponse(
    rows.map((row) =>
      serializeLocation(row, {
        responsible: peopleById.get(row.responsibleId),
        klass: classesById.get(row.classId),
        stats: stats.get(row.id) ?? {
          itemCount: 0,
          totalQuantity: 0,
          brokenQuantity: 0,
          serviceableQuantity: 0,
        },
      }),
    ),
    total,
    page,
    limit,
  );
};

/** Faol xonalar — tanlagichlar uchun (sahifalanmaydi). */
const getActiveLocations = async () => {
  const rows = await prisma.inventoryLocation.findMany({
    where: { isArchived: false },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  const { peopleById, classesById } = await attachRefs(rows);

  return rows.map((row) =>
    serializeLocation(row, {
      responsible: peopleById.get(row.responsibleId),
      klass: classesById.get(row.classId),
    }),
  );
};

/** Bitta xona + uning xatlovi (`inventoryStock.service` chaqiradi). */
const getLocationById = async (id) => {
  const location = await prisma.inventoryLocation.findUnique({ where: { id } });
  if (!location) throw new NotFoundError("Xona topilmadi");

  const [{ peopleById, classesById }, stats] = await Promise.all([
    attachRefs([location]),
    statsByLocation([id]),
  ]);

  return serializeLocation(location, {
    responsible: peopleById.get(location.responsibleId),
    klass: classesById.get(location.classId),
    stats: stats.get(id) ?? {
      itemCount: 0,
      totalQuantity: 0,
      brokenQuantity: 0,
      serviceableQuantity: 0,
    },
  });
};

/** Xona mavjud va arxivlanmaganligini tekshiradi. */
const assertActiveLocation = async (locationId) => {
  if (!locationId) throw new BadRequestError("Xona tanlanmagan");

  const location = await prisma.inventoryLocation.findUnique({
    where: { id: locationId },
  });
  if (!location) throw new NotFoundError("Xona topilmadi");
  if (location.isArchived) throw new BadRequestError(`"${location.name}" arxivlangan`);

  return location;
};

const parseName = async (rawName, { excludeId } = {}) => {
  const name = rawName?.trim();
  if (!name) throw new BadRequestError("Xona nomi majburiy");

  const existing = await prisma.inventoryLocation.findUnique({ where: { name } });
  if (existing && existing.id !== excludeId) {
    throw new BadRequestError(`"${name}" nomli xona allaqachon bor`);
  }

  return name;
};

const parseType = (value) => {
  if (value == null || value === "") return "classroom";
  if (!LOCATION_TYPES.includes(value)) {
    throw new BadRequestError("Xona turi noto'g'ri");
  }
  return value;
};

/**
 * Mas'ul shaxs — XODIM bo'lishi shart.
 *
 * O'quvchiga kunlik hisobot yuborish mas'uliyatini yuklab bo'lmaydi: uning
 * paneli boshqa va hisobot berish xizmat vazifasi (`assertStaff` bilan
 * bir xil mulohaza).
 */
const parseResponsible = async (responsibleId) => {
  if (!responsibleId) return null;

  const person = await prisma.user.findUnique({
    where: { id: responsibleId },
    select: RESPONSIBLE_SELECT,
  });
  if (!person) throw new NotFoundError("Mas'ul xodim topilmadi");
  if (person.role === ROLES.STUDENT) {
    throw new BadRequestError("O'quvchini xonaga mas'ul qilib bo'lmaydi");
  }
  if (person.isArchived) {
    throw new BadRequestError("Arxivlangan xodimni mas'ul qilib bo'lmaydi");
  }

  return person;
};

const parseClass = async (classId) => {
  if (!classId) return null;

  const klass = await prisma.class.findUnique({
    where: { id: classId },
    select: { id: true, name: true },
  });
  if (!klass) throw new NotFoundError("Sinf topilmadi");

  return klass;
};

/** @param {object} data - { name, type, classId, responsibleId, note, sortOrder } */
const createLocation = async (data, userId) => {
  const [name, responsible, klass] = await Promise.all([
    parseName(data.name),
    parseResponsible(data.responsibleId),
    parseClass(data.classId),
  ]);

  const row = await prisma.inventoryLocation.create({
    data: {
      name,
      type: parseType(data.type),
      classId: klass?.id ?? null,
      responsibleId: responsible?.id ?? null,
      note: data.note?.trim() || "",
      sortOrder: Number.isInteger(Number(data.sortOrder)) ? Number(data.sortOrder) : 0,
      createdBy: userId,
    },
  });

  return serializeLocation(row, {
    responsible,
    klass,
    stats: { itemCount: 0, totalQuantity: 0, brokenQuantity: 0, serviceableQuantity: 0 },
  });
};

/**
 * Tahrirlash. Nomni o'zgartirish MUMKIN: kunlik hisobot va zarar
 * hujjatlarida xona nomi `locationSnapshot` ichida MUHRLANGAN.
 */
const updateLocation = async (id, data) => {
  const location = await prisma.inventoryLocation.findUnique({ where: { id } });
  if (!location) throw new NotFoundError("Xona topilmadi");

  const payload = {};
  let responsible = null;
  let klass = null;

  if (data.name !== undefined) payload.name = await parseName(data.name, { excludeId: id });
  if (data.type !== undefined) payload.type = parseType(data.type);
  if (data.note !== undefined) payload.note = data.note?.trim() || "";
  if (data.sortOrder !== undefined) payload.sortOrder = Number(data.sortOrder) || 0;

  if (data.responsibleId !== undefined) {
    responsible = await parseResponsible(data.responsibleId);
    payload.responsibleId = responsible?.id ?? null;
  }
  if (data.classId !== undefined) {
    klass = await parseClass(data.classId);
    payload.classId = klass?.id ?? null;
  }

  await prisma.inventoryLocation.update({ where: { id }, data: payload });

  return getLocationById(id);
};

/**
 * Arxivlash / arxivdan qaytarish.
 *
 * ⚠️ Xatlovda jihoz turgan xonani arxivlab bo'lmaydi: jihozlar "hech
 * qayerda" bo'lib qolardi va ular bo'yicha kunlik hisobot ham,
 * inventarizatsiya ham imkonsiz bo'lardi. Avval boshqa xonaga ko'chiriladi
 * yoki hisobdan chiqariladi.
 */
const archiveLocation = async (id, isArchived) => {
  const location = await prisma.inventoryLocation.findUnique({ where: { id } });
  if (!location) throw new NotFoundError("Xona topilmadi");

  const archive = Boolean(isArchived);

  if (archive) {
    const stock = await prisma.inventoryStock.aggregate({
      where: { locationId: id },
      _sum: { quantity: true },
    });
    const remaining = stock._sum.quantity ?? 0;

    if (remaining > 0) {
      throw new BadRequestError(
        `"${location.name}" xatlovida ${remaining} ta jihoz bor — avval ` +
          `boshqa xonaga ko'chiring yoki hisobdan chiqaring`,
      );
    }
  }

  await prisma.inventoryLocation.update({
    where: { id },
    data: { isArchived: archive },
  });

  const fresh = await getLocationById(id);
  return {
    ...fresh,
    message: archive
      ? `"${location.name}" arxivlandi`
      : `"${location.name}" arxivdan qaytarildi`,
  };
};

module.exports = {
  RESPONSIBLE_SELECT,
  LOCATION_TYPES,
  serializeLocation,
  statsByLocation,
  getLocations,
  getActiveLocations,
  getLocationById,
  assertActiveLocation,
  createLocation,
  updateLocation,
  archiveLocation,
};
