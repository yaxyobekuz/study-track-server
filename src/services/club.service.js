/**
 * TO'GARAK VA QO'SHIMCHA DARSLAR.
 *
 * ⚠️ `Class` DAN ALOHIDA: sinf — o'quvchining doimiy joyi va u bitta;
 * to'garak ixtiyoriy va bir o'quvchi bir nechtasiga qatnashadi. Sinfga
 * qo'shib yuborilsa, "9-A" ham, "Robototexnika" ham bitta ro'yxatda
 * turib, davomat va baho hisobotlari ikkalasini bir xil o'qib yuborardi.
 *
 * ⚠️ A'zolik SANALI (`ClubMember.startDate/endDate`), `UserClass` kabi
 * sanasiz emas: "shu oyda nechta o'quvchi qatnashdi" degan savolga
 * sanasiz M2M javob bera olmaydi — chiqib ketgan o'quvchi o'tgan oy
 * hisobotidan ham jimgina yo'qolib qolardi.
 *
 * ⚠️ `endDate` INKLYUZIV — oxirgi qatnashgan kun (o'qish davri bilan bir
 * xil qoida, `finance.md` §3).
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError, ConflictError } = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { parseDayDate, currentDayDate } = require("../helpers/month.helpers");

const MAX_NAME = 80;
const MAX_DESCRIPTION = 500;
/** Haftalik soat — aqlga sig'adigan chegara (haftada 168 soat bor). */
const MAX_WEEKLY_HOURS = 40;

/** Bir marta biriktiriladigan o'quvchilar soni — so'rov ham, ekran ham cheklangan. */
const MAX_BULK_MEMBERS = 300;

const MEMBER_STUDENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  isArchived: true,
  classes: { select: { class: { select: { id: true, name: true } } } },
};

/** Hozir faol a'zolik sharti (bugungi kunga). */
const activeMemberWhere = (day = currentDayDate()) => ({
  startDate: { lte: day },
  OR: [{ endDate: null }, { endDate: { gte: day } }],
});

const serializeMember = (row) => ({
  id: row.id,
  clubId: row.clubId,
  studentId: row.studentId,
  startDate: row.startDate,
  endDate: row.endDate,
  isActive: row.endDate == null || row.endDate >= currentDayDate(),
  student: row.student
    ? {
        id: row.student.id,
        firstName: row.student.firstName,
        lastName: row.student.lastName,
        isArchived: row.student.isArchived,
        className: row.student.classes?.[0]?.class?.name ?? null,
      }
    : null,
});

const serialize = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description ?? "",
  weeklyHours: row.weeklyHours,
  isActive: row.isActive,
  teacherId: row.teacherId,
  teacher: row.teacher ?? null,
  subject: row.subject ? { id: row.subject.id, name: row.subject.name } : null,
  memberCount: row._count?.members ?? 0,
  createdAt: row.createdAt,
});

/**
 * Rahbarni tekshiradi.
 *
 * ⚠️ O'QUVCHI RAHBAR BO'LA OLMAYDI. Aks holda bir odam ham a'zo, ham
 * rahbar bo'lib, "to'garak rahbarlari" ro'yxatiga o'quvchi tushib qolardi.
 */
const resolveTeacher = async (teacherId) => {
  if (!teacherId) return null;

  const teacher = await prisma.user.findUnique({
    where: { id: String(teacherId) },
    select: { id: true, role: true },
  });

  if (!teacher) throw new NotFoundError("Xodim topilmadi");
  if (teacher.role === ROLES.STUDENT) {
    throw new BadRequestError("To'garak rahbari o'quvchi bo'la olmaydi");
  }

  return teacher.id;
};

const parsePayload = async (data = {}, { partial = false } = {}) => {
  const payload = {};

  if (!partial || data.name !== undefined) {
    const name = String(data.name ?? "").trim();
    if (!name) throw new BadRequestError("To'garak nomi kiritilmagan");
    if (name.length > MAX_NAME) throw new BadRequestError("To'garak nomi juda uzun");
    payload.name = name;
  }

  if (data.description !== undefined) {
    const description = String(data.description ?? "").trim();
    if (description.length > MAX_DESCRIPTION) {
      throw new BadRequestError("Izoh juda uzun");
    }
    payload.description = description || null;
  }

  if (data.teacherId !== undefined) {
    payload.teacherId = await resolveTeacher(data.teacherId);
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

  if (data.weeklyHours !== undefined) {
    const hours = Number(data.weeklyHours ?? 0);
    if (!Number.isInteger(hours) || hours < 0 || hours > MAX_WEEKLY_HOURS) {
      throw new BadRequestError(`Haftalik soat 0 dan ${MAX_WEEKLY_HOURS} gacha bo'lishi kerak`);
    }
    payload.weeklyHours = hours;
  }

  if (data.isActive !== undefined) payload.isActive = Boolean(data.isActive);

  return payload;
};

/** Rahbarlarning ismini bitta so'rovda oladi (relatsiya emas — soft ref). */
const attachTeachers = async (rows) => {
  const ids = [...new Set(rows.map((row) => row.teacherId).filter(Boolean))];
  if (ids.length === 0) return rows.map((row) => ({ ...row, teacher: null }));

  const teachers = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true },
  });
  const byId = new Map(teachers.map((row) => [row.id, row]));

  return rows.map((row) => ({ ...row, teacher: byId.get(row.teacherId) ?? null }));
};

/**
 * To'garaklar ro'yxati.
 *
 * @param {object} query - { page, limit, search, isActive }
 */
const getClubs = async (query = {}) => {
  const { page, limit, skip } = getPaginationParams({ query });

  const where = {};

  const search = String(query.search ?? "").trim();
  if (search) where.name = { contains: search, mode: "insensitive" };

  if (query.isActive === "true") where.isActive = true;
  if (query.isActive === "false") where.isActive = false;

  const [rows, total] = await Promise.all([
    prisma.club.findMany({
      where,
      include: {
        subject: { select: { id: true, name: true } },
        _count: { select: { members: true } },
      },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      skip,
      take: limit,
    }),
    prisma.club.count({ where }),
  ]);

  const withTeachers = await attachTeachers(rows);

  return formatPaginationResponse(withTeachers.map(serialize), total, page, limit);
};

/** Bitta to'garak — a'zolari bilan. */
const getClub = async (id) => {
  const row = await prisma.club.findUnique({
    where: { id },
    include: {
      subject: { select: { id: true, name: true } },
      _count: { select: { members: true } },
      members: {
        include: { student: { select: MEMBER_STUDENT_SELECT } },
        orderBy: [{ endDate: "asc" }, { startDate: "desc" }],
      },
    },
  });

  if (!row) throw new NotFoundError("To'garak topilmadi");

  const [withTeacher] = await attachTeachers([row]);

  return {
    ...serialize(withTeacher),
    members: row.members.map(serializeMember),
  };
};

const createClub = async (data, userId) => {
  const payload = await parsePayload(data);

  const duplicate = await prisma.club.findUnique({
    where: { name: payload.name },
    select: { id: true },
  });
  if (duplicate) throw new ConflictError("Bunday nomli to'garak allaqachon bor");

  const row = await prisma.club.create({
    data: { weeklyHours: 0, ...payload, createdBy: userId },
    include: {
      subject: { select: { id: true, name: true } },
      _count: { select: { members: true } },
    },
  });

  const [withTeacher] = await attachTeachers([row]);
  return serialize(withTeacher);
};

const updateClub = async (id, data) => {
  const exists = await prisma.club.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw new NotFoundError("To'garak topilmadi");

  const payload = await parsePayload(data, { partial: true });

  if (payload.name) {
    const duplicate = await prisma.club.findFirst({
      where: { name: payload.name, id: { not: id } },
      select: { id: true },
    });
    if (duplicate) throw new ConflictError("Bunday nomli to'garak allaqachon bor");
  }

  const row = await prisma.club.update({
    where: { id },
    data: payload,
    include: {
      subject: { select: { id: true, name: true } },
      _count: { select: { members: true } },
    },
  });

  const [withTeacher] = await attachTeachers([row]);
  return serialize(withTeacher);
};

/**
 * To'garakni o'chirish.
 *
 * ⚠️ A'ZOSI BO'LGAN TO'GARAK O'CHIRILMAYDI — nofaol qilinadi. A'zolik
 * qatorlari o'tgan oylar hisobotining manbai: ular bilan birga o'chirilsa,
 * "sentabrda 428 o'quvchi qatnashgan" degan raqam bugun o'zgarib ketardi.
 */
const deleteClub = async (id) => {
  const club = await prisma.club.findUnique({
    where: { id },
    select: { id: true, _count: { select: { members: true } } },
  });
  if (!club) throw new NotFoundError("To'garak topilmadi");

  if (club._count.members > 0) {
    throw new ConflictError(
      "A'zosi bor to'garakni o'chirib bo'lmaydi — uni nofaol qilib qo'ying",
    );
  }

  await prisma.club.delete({ where: { id } });
  return { id };
};

/**
 * O'quvchilarni to'garakka biriktirish.
 *
 * Bir necha o'quvchi bir so'rovda qo'shiladi (ekranda ham ular bitta
 * ro'yxatdan belgilanadi). ⚠️ ALLAQACHON FAOL a'zo QAYTA QO'SHILMAYDI —
 * xato emas, jim tashlab ketiladi: kassirning "qo'shildi" tugmasini ikki
 * marta bosishi hisobotda ikki barobar a'zo bo'lib ko'rinmasligi kerak.
 */
const addMembers = async (clubId, data = {}, userId) => {
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { id: true, isActive: true },
  });
  if (!club) throw new NotFoundError("To'garak topilmadi");
  if (!club.isActive) throw new BadRequestError("Nofaol to'garakka a'zo qo'shib bo'lmaydi");

  const ids = [...new Set((Array.isArray(data.studentIds) ? data.studentIds : []).map(String))];
  if (ids.length === 0) throw new BadRequestError("O'quvchi tanlanmagan");
  if (ids.length > MAX_BULK_MEMBERS) {
    throw new BadRequestError(`Bir vaqtda ${MAX_BULK_MEMBERS} tadan ko'p o'quvchi qo'shib bo'lmaydi`);
  }

  const startDate = data.startDate ? parseDayDate(data.startDate, "Boshlanish sanasi") : currentDayDate();

  const students = await prisma.user.findMany({
    where: { id: { in: ids }, role: ROLES.STUDENT },
    select: { id: true },
  });
  if (students.length !== ids.length) {
    throw new BadRequestError("Ba'zi tanlangan foydalanuvchilar o'quvchi emas");
  }

  const existing = await prisma.clubMember.findMany({
    where: { clubId, studentId: { in: ids }, ...activeMemberWhere(startDate) },
    select: { studentId: true },
  });
  const alreadyIn = new Set(existing.map((row) => row.studentId));

  const fresh = ids.filter((id) => !alreadyIn.has(id));

  if (fresh.length > 0) {
    await prisma.clubMember.createMany({
      data: fresh.map((studentId) => ({ clubId, studentId, startDate, createdBy: userId })),
    });
  }

  return { added: fresh.length, skipped: alreadyIn.size };
};

/**
 * A'zolikni yopish.
 *
 * ⚠️ QATOR O'CHIRILMAYDI, yopiladi: o'tgan oylarning hisoboti shu
 * qatorlardan yig'iladi. Xato kiritilgan a'zolik uchun `remove` bor.
 */
const closeMember = async (clubId, memberId, data = {}) => {
  const member = await prisma.clubMember.findUnique({
    where: { id: memberId },
    select: { id: true, clubId: true, startDate: true, endDate: true },
  });

  if (!member || member.clubId !== clubId) throw new NotFoundError("A'zolik topilmadi");
  if (member.endDate) throw new BadRequestError("A'zolik allaqachon yopilgan");

  const endDate = data.endDate ? parseDayDate(data.endDate, "Tugash sanasi") : currentDayDate();

  if (endDate < member.startDate) {
    throw new BadRequestError("Tugash sanasi boshlanish sanasidan oldin bo'lishi mumkin emas");
  }

  const row = await prisma.clubMember.update({
    where: { id: memberId },
    data: { endDate },
    include: { student: { select: MEMBER_STUDENT_SELECT } },
  });

  return serializeMember(row);
};

/** Xato kiritilgan a'zolikni butunlay o'chirish. */
const removeMember = async (clubId, memberId) => {
  const member = await prisma.clubMember.findUnique({
    where: { id: memberId },
    select: { id: true, clubId: true },
  });

  if (!member || member.clubId !== clubId) throw new NotFoundError("A'zolik topilmadi");

  await prisma.clubMember.delete({ where: { id: memberId } });
  return { id: memberId };
};

module.exports = {
  getClubs,
  getClub,
  createClub,
  updateClub,
  deleteClub,
  addMembers,
  closeMember,
  removeMember,
  activeMemberWhere,
};
