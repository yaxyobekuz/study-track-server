/**
 * OLIMPIADA VA MUSOBAQA YUTUQLARI.
 *
 * ⚠️ `TestResult` DAN ALOHIDA: test — tizim ichidagi o'lchov (savol,
 * javob, ball), yutuq esa TASHQI hodisa. Ikkalasi bitta jadvalda tursa,
 * "bu yil nechta respublika o'rni oldik" degan savolga javob test
 * natijalari orasidan qidirib topiladigan bo'lardi.
 *
 * ⚠️ Daraja va o'rin — TOIFA, erkin matn emas. Hisobot aynan shu ikki
 * kesim bo'yicha yig'iladi; "Respublika bosqichi" va "respublika" deb
 * yozilgan ikki qator bitta guruhga tushmasdi.
 *
 * ⚠️ Sana `@db.Date` — UTC yarim tunida yotadi va faqat `getUTC*` bilan
 * o'qiladi (`finance.md` §0). Foydalanuvchiga ko'rsatishda
 * `formatDateUz(v, { utc: true })`.
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const {
  parseDayDate,
  parseOptionalMonthKey,
  monthStartDate,
  monthEndDate,
} = require("../helpers/month.helpers");

/** Daraja — pastdan yuqoriga. Tartib hisobotdagi ustunlar tartibi ham. */
const ACHIEVEMENT_LEVEL_LABELS = {
  school: "Maktab",
  district: "Tuman",
  city: "Shahar",
  region: "Viloyat",
  republic: "Respublika",
  international: "Xalqaro",
};

const ACHIEVEMENT_PLACE_LABELS = {
  first: "1-o'rin",
  second: "2-o'rin",
  third: "3-o'rin",
  participant: "Ishtirokchi",
};

const LEVELS = Object.keys(ACHIEVEMENT_LEVEL_LABELS);
const PLACES = Object.keys(ACHIEVEMENT_PLACE_LABELS);

const MAX_TITLE = 160;
const MAX_NOTE = 500;

const STUDENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  isArchived: true,
  classes: { select: { class: { select: { id: true, name: true } } } },
};

/** Javob shakli — ro'yxat ham, bitta yozuv ham shu ko'rinishda chiqadi. */
const serialize = (row) => ({
  id: row.id,
  title: row.title,
  level: row.level,
  levelLabel: ACHIEVEMENT_LEVEL_LABELS[row.level] ?? row.level,
  place: row.place,
  placeLabel: ACHIEVEMENT_PLACE_LABELS[row.place] ?? row.place,
  date: row.date,
  note: row.note ?? "",
  subject: row.subject ? { id: row.subject.id, name: row.subject.name } : null,
  student: row.student
    ? {
        id: row.student.id,
        firstName: row.student.firstName,
        lastName: row.student.lastName,
        isArchived: row.student.isArchived,
        className: row.student.classes?.[0]?.class?.name ?? null,
      }
    : null,
  createdAt: row.createdAt,
});

const INCLUDE = {
  student: { select: STUDENT_SELECT },
  subject: { select: { id: true, name: true } },
};

/** Kiruvchi ma'lumotni tekshiradi va bazaga tushadigan shaklga keltiradi. */
const parsePayload = async (data = {}, { partial = false } = {}) => {
  const payload = {};

  if (!partial || data.studentId !== undefined) {
    const student = await prisma.user.findUnique({
      where: { id: String(data.studentId ?? "") },
      select: { id: true, role: true },
    });

    if (!student) throw new NotFoundError("O'quvchi topilmadi");
    // ⚠️ Xodimga yutuq yozilmaydi: hisobot o'quvchilar kesimida yig'iladi
    // va xodim qatori "sinfsiz o'quvchi" bo'lib osilib qolardi.
    if (student.role !== ROLES.STUDENT) {
      throw new BadRequestError("Yutuq faqat o'quvchiga biriktiriladi");
    }

    payload.studentId = student.id;
  }

  if (!partial || data.title !== undefined) {
    const title = String(data.title ?? "").trim();
    if (!title) throw new BadRequestError("Yutuq nomi kiritilmagan");
    if (title.length > MAX_TITLE) throw new BadRequestError("Yutuq nomi juda uzun");
    payload.title = title;
  }

  if (!partial || data.level !== undefined) {
    const level = String(data.level ?? "");
    if (!LEVELS.includes(level)) throw new BadRequestError("Daraja noto'g'ri");
    payload.level = level;
  }

  if (!partial || data.place !== undefined) {
    const place = String(data.place ?? "participant");
    if (!PLACES.includes(place)) throw new BadRequestError("O'rin noto'g'ri");
    payload.place = place;
  }

  if (!partial || data.date !== undefined) {
    payload.date = parseDayDate(data.date, "Sana");
  }

  if (data.subjectId !== undefined) {
    const subjectId = data.subjectId ? String(data.subjectId) : null;

    if (subjectId) {
      const subject = await prisma.subject.findUnique({
        where: { id: subjectId },
        select: { id: true },
      });
      if (!subject) throw new NotFoundError("Fan topilmadi");
    }

    payload.subjectId = subjectId;
  }

  if (data.note !== undefined) {
    const note = String(data.note ?? "").trim();
    if (note.length > MAX_NOTE) throw new BadRequestError("Izoh juda uzun");
    payload.note = note || null;
  }

  return payload;
};

/**
 * Yutuqlar ro'yxati.
 *
 * @param {object} query - { page, limit, month, level, place, studentId, subjectId, search }
 */
const getAchievements = async (query = {}) => {
  const { page, limit, skip } = getPaginationParams({ query });

  const where = {};

  const month = parseOptionalMonthKey(query.month, "Oy");
  if (month) {
    where.date = {
      gte: monthStartDate(month),
      lte: new Date(monthEndDate(month).getTime() + 86400000 - 1),
    };
  }

  if (query.level && LEVELS.includes(query.level)) where.level = query.level;
  if (query.place && PLACES.includes(query.place)) where.place = query.place;
  if (query.studentId) where.studentId = String(query.studentId);
  if (query.subjectId) where.subjectId = String(query.subjectId);

  const search = String(query.search ?? "").trim();
  if (search) {
    where.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { student: { firstName: { contains: search, mode: "insensitive" } } },
      { student: { lastName: { contains: search, mode: "insensitive" } } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.studentAchievement.findMany({
      where,
      include: INCLUDE,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
    }),
    prisma.studentAchievement.count({ where }),
  ]);

  return formatPaginationResponse(rows.map(serialize), total, page, limit);
};

/** Bitta yutuq. */
const getAchievement = async (id) => {
  const row = await prisma.studentAchievement.findUnique({
    where: { id },
    include: INCLUDE,
  });

  if (!row) throw new NotFoundError("Yutuq topilmadi");
  return serialize(row);
};

const createAchievement = async (data, userId) => {
  const payload = await parsePayload(data);

  const row = await prisma.studentAchievement.create({
    data: { ...payload, createdBy: userId },
    include: INCLUDE,
  });

  return serialize(row);
};

const updateAchievement = async (id, data) => {
  const exists = await prisma.studentAchievement.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!exists) throw new NotFoundError("Yutuq topilmadi");

  const payload = await parsePayload(data, { partial: true });

  const row = await prisma.studentAchievement.update({
    where: { id },
    data: payload,
    include: INCLUDE,
  });

  return serialize(row);
};

/**
 * Yutuqni o'chirish.
 *
 * ⚠️ Bu yerda "arxivlash" YO'Q: yutuq — bir martalik qayd, unga hech
 * qanday hisob-faktura yoki boshqa qator ishora qilmaydi. Xato kiritilgan
 * qatorni saqlab qo'yish hisobotni buzib turardi.
 */
const deleteAchievement = async (id) => {
  const exists = await prisma.studentAchievement.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!exists) throw new NotFoundError("Yutuq topilmadi");

  await prisma.studentAchievement.delete({ where: { id } });
  return { id };
};

/** Frontend uchun toifalar katalogi — ro'yxat kodda takrorlanmasin. */
const getOptions = () => ({
  levels: LEVELS.map((key) => ({ value: key, label: ACHIEVEMENT_LEVEL_LABELS[key] })),
  places: PLACES.map((key) => ({ value: key, label: ACHIEVEMENT_PLACE_LABELS[key] })),
});

module.exports = {
  ACHIEVEMENT_LEVEL_LABELS,
  ACHIEVEMENT_PLACE_LABELS,
  getAchievements,
  getAchievement,
  createAchievement,
  updateAchievement,
  deleteAchievement,
  getOptions,
};
