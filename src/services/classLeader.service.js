/**
 * SINF RAHBARI — xodimga sinf biriktirish va shu biriktirishdan keladigan
 * YAGONA huquq: o'z sinfining KUNLIK davomatini belgilash.
 *
 * Qoida bitta jumlada:
 *
 * > Sinf rahbari ertalab o'z sinfiga kelib, shu kuni O'QIYOTGAN
 * > o'quvchilarning bor-yo'qligini belgilaydi — darsi bo'lmasa ham.
 *
 * ⚠️ TYUTORDAN FARQI PULDA. `TutorGroup` biriktirishi oylik dvigatelida
 * USTAMA bo'lib majburiyatga muhrlanadi (`tutorGroup.service.js`), shuning
 * uchun u stavka va DAVR bilan yuritiladi. Bu yerda pul yo'q: muhrlanadigan
 * fakt bo'lmagani uchun davr ham yo'q va biriktirish shunchaki "hozir kim
 * rahbar" degan savolga javob beradi. Bir odam ikkalasi ham bo'lishi mumkin.
 *
 * ⚠️ SINF RAHBARI — ROL BELGISI (`Role.isClassLeader`), rol kaliti EMAS
 * (`isTutor` bilan AYNI sabab): rollar dinamik va "Sinf rahbari" rolining
 * kaliti har o'rnatishda boshqacha yozilgan bo'lishi mumkin. Kalitni kodga
 * qotirsak, boshqacha nomlangan rol egasi jimgina sinfsiz qolardi.
 *
 * ⚠️ HUQUQ BIRIKTIRISHDAN KELADI, ruxsat kalitidan EMAS (`/tutor-groups/my`
 * va `/grades/teacher/classes` bilan AYNI qoida): xodim id si TOKENDAN,
 * sinflar esa `getMyLeaderClassIds` dan. Har so'rovda QAYTA o'qiladi —
 * biriktirish oraliqda olib qo'yilsa, eskirgan ekran begona sinfga tegmaydi.
 *
 * ⚠️ EGALIK BITTA MANBADAN (`getMyLeaderClassIds` / `assertMyLeaderClass`).
 * Tyutor tomonida bu xato bir marta qilingan: xabar yuborish yo'li o'z
 * nusxasini yuritardi va biriga qo'shilgan shart ikkinchisida tushib qolardi
 * (`education.md` §14). Yangi yo'l qo'shsangiz — shu yerdan o'tsin.
 *
 * ⚠️ BIR SINFGA BITTA RAHBAR va buni INDEKS kafolatlaydi
 * (`@@unique([classId])`). Tyutorda kesishuv advisory lock ichida
 * tekshiriladi, chunki davr kesishuvini indeks bilan ifodalab bo'lmaydi; bu
 * yerda davr yo'q, ya'ni ikki parallel so'rov bitta sinfni ikki kishiga yoza
 * OLMAYDI — tekshiruv zaxira qavat, kafolat esa bazada.
 */

const prisma = require("../config/prisma");
const platformPrisma = require("../config/platformPrisma");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const { hasRole } = require("../utils/permissions");
const { isValidId } = require("../utils/objectId");
const logger = require("../utils/logger");

const NOTE_MAX = 500;

// Bitta so'rovda biriktiriladigan sinflar chegarasi ("hammasi" ham shunga sig'adi)
const MAX_CLASSES_PER_REQUEST = 200;

// Ko'p sinf: har biriga qator — standart 5 soniya yetmasligi mumkin
const CREATE_TX_OPTIONS = { timeout: 30000, maxWait: 10000 };

const NO_GROUP_MESSAGE = "Sizga sinf rahbarligi biriktirilmagan";
const NOT_MY_CLASS_MESSAGE = "Bu sinf sizga sinf rahbari sifatida biriktirilmagan";

const fullName = (u) => (u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() : "");

const assertId = (value, label) => {
  if (!isValidId(value)) throw new BadRequestError(`${label} noto'g'ri`);
};

const parseNote = (value) => {
  if (value == null) return "";
  const note = String(value).trim();
  if (note.length > NOTE_MAX) {
    throw new BadRequestError(`Izoh ${NOTE_MAX} belgidan oshmasligi kerak`);
  }
  return note;
};

/** `classIds` yoki bitta `classId` — ikkala shakl ham qabul qilinadi. */
const parseClassIds = (data = {}) => {
  const raw = Array.isArray(data.classIds)
    ? data.classIds
    : data.classId
      ? [data.classId]
      : [];

  const ids = [...new Set(raw.filter(Boolean).map(String))];
  if (ids.length === 0) throw new BadRequestError("Sinf tanlanmagan");
  if (ids.length > MAX_CLASSES_PER_REQUEST) {
    throw new BadRequestError(
      `Bir amalda ko'pi bilan ${MAX_CLASSES_PER_REQUEST} sinf biriktiriladi`,
    );
  }
  for (const id of ids) assertId(id, "Sinf");
  return ids;
};

// ─────────────────────────────────────────────
// Rol belgisi
// ─────────────────────────────────────────────

/** Sinf rahbari belgisi qo'yilgan rollar kalitlari (platforma, filiallarga umumiy). */
const loadClassLeaderRoleValues = async () => {
  const rows = await platformPrisma.role.findMany({
    where: { isClassLeader: true },
    select: { value: true },
  });
  return rows.map((r) => r.value);
};

/**
 * Odam sinf rahbarimi — asosiy YOKI qo'shimcha roli bo'yicha (`hasRole`).
 *
 * @param {{role: string, extraRoles?: string[]}} user
 * @param {string[]} leaderRoles - `loadClassLeaderRoleValues()` natijasi
 */
const isClassLeaderUser = (user, leaderRoles) =>
  Boolean(user) &&
  user.role !== ROLES.STUDENT &&
  leaderRoles.length > 0 &&
  hasRole(user, leaderRoles);

// ─────────────────────────────────────────────
// O'qish
// ─────────────────────────────────────────────

/**
 * Sinflardagi o'quvchilar soni — BITTA guruhlangan so'rov.
 *
 * Arxivlangan o'quvchi sanalmaydi: sinflar ro'yxatidagi raqam va tyutor
 * kartasi bilan AYNI qoida (`tutorGroup.service.js` → `countStudentsByClass`).
 * Aks holda bir ekranda bir son, boshqasida boshqa son turardi.
 *
 * @param {string[]} classIds
 * @returns {Promise<Map<string, number>>}
 */
const countStudentsByClass = async (classIds) => {
  const ids = [...new Set(classIds)].filter(Boolean);
  if (ids.length === 0) return new Map();

  const rows = await prisma.userClass.groupBy({
    by: ["classId"],
    where: { classId: { in: ids }, user: { role: ROLES.STUDENT, isArchived: false } },
    _count: { userId: true },
  });
  return new Map(rows.map((r) => [r.classId, r._count.userId]));
};

/**
 * XODIM RAHBAR BO'LGAN SINFLARNING ID LARI — EGALIKNING YAGONA MANBAI.
 *
 * Davomat darvozasi ham, keyin qo'shiladigan har qanday yo'l ham shuni
 * chaqiradi. Ikkinchi nusxa yozilsa, biriga qo'shilgan shart ikkinchisida
 * tushib qolardi va xodim begona sinfga tegib ketardi (`education.md` §14).
 *
 * ⚠️ EGALIK IKKI SHARTDAN: **rol belgisi** va **biriktirish**. Faqat
 * biriktirishga qaralsa, xodimdan "Sinf rahbari" roli olib qo'yilgach ham
 * davomat huquqi jimgina qolib ketardi — admin uchun esa rolni olish aynan
 * "bu odam endi sinf rahbari emas" degani. Biriktirishni ham olib tashlash
 * kerakligini hech kim eslab turmaydi, shuning uchun qoida kodda.
 *
 * ⚠️ `actor` TO'LIQ obyekt (`{id, role, extraRoles}`), id EMAS: `hasRole`
 * qo'shimcha rollarni ham o'qiydi va "sinf rahbarligi — qo'shimcha rol"
 * odatiy hol (asosiy roli o'qituvchi bo'lgan odam).
 *
 * @param {{id: string, role?: string, extraRoles?: string[]}} actor - HAR DOIM `req.user`
 * @returns {Promise<string[]>}
 */
const getMyLeaderClassIds = async (actor) => {
  if (!actor || !isValidId(actor.id)) return [];

  const leaderRoles = await loadClassLeaderRoleValues();
  if (!isClassLeaderUser(actor, leaderRoles)) return [];

  const rows = await prisma.classLeader.findMany({
    where: {
      leaderId: actor.id,
      // ⚠️ NOFAOL SINF CHIQIB KETADI: u faqat tarixni ushlab turadi
      // (filiallararo ko'chirishda shunday ochiladi, `finance.md` §12) va
      // joriy ro'yxatlarga kirmaydi — davomat ekranlari bilan AYNI shart.
      class: { isActive: true },
    },
    select: { classId: true },
  });
  return [...new Set(rows.map((r) => r.classId))];
};

/**
 * Sinf shu xodimning rahbarligidami — bo'lmasa 403.
 *
 * @param {{id: string, role?: string, extraRoles?: string[]}} actor
 * @param {string} [classId] - berilmasa faqat "biror sinf bormi" tekshiriladi
 * @returns {Promise<string[]>} xodimning barcha sinf id lari
 */
const assertMyLeaderClass = async (actor, classId) => {
  const classIds = await getMyLeaderClassIds(actor);
  if (classIds.length === 0) throw new ForbiddenError(NO_GROUP_MESSAGE);
  if (classId && !classIds.includes(classId)) {
    throw new ForbiddenError(NOT_MY_CLASS_MESSAGE);
  }
  return classIds;
};

/** Qatorni ekranga keltiradi (sinf, o'quvchilar soni, izoh, kim biriktirgan). */
const shapeRow = (row, { counts, people } = {}) => ({
  id: row.id,
  classId: row.classId,
  className: row.class?.name ?? "Noma'lum",
  classIsActive: row.class?.isActive ?? false,
  studentCount: counts?.get(row.classId) ?? 0,
  note: row.note || "",
  leader: row.leaderId
    ? {
        id: row.leaderId,
        name: fullName(people?.get(row.leaderId)) || "Noma'lum",
        isArchived: people?.get(row.leaderId)?.isArchived ?? false,
      }
    : null,
  createdBy: row.createdBy
    ? { id: row.createdBy, name: fullName(people?.get(row.createdBy)) || "Noma'lum" }
    : null,
  createdAt: row.createdAt,
});

/** Qatorlarga tegishli odamlarni BITTA so'rovda yuklaydi (soft ref). */
const loadPeople = async (rows) => {
  const ids = [
    ...new Set(rows.flatMap((r) => [r.leaderId, r.createdBy]).filter(Boolean)),
  ];
  if (ids.length === 0) return new Map();

  const people = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true, isArchived: true },
  });
  return new Map(people.map((p) => [p.id, p]));
};

/**
 * BITTA XODIMNING SINFLARI — admin paneldagi xodim kartasi.
 *
 * @param {string} staffId
 */
const getStaffClasses = async (staffId) => {
  assertId(staffId, "Xodim");

  const [staff, leaderRoles] = await Promise.all([
    prisma.user.findUnique({
      where: { id: staffId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        role: true,
        extraRoles: true,
        isArchived: true,
      },
    }),
    loadClassLeaderRoleValues(),
  ]);
  if (!staff) throw new NotFoundError("Xodim topilmadi");

  const rows = await prisma.classLeader.findMany({
    where: { leaderId: staffId },
    include: { class: { select: { id: true, name: true, isActive: true } } },
    orderBy: { class: { name: "asc" } },
  });

  const [counts, people] = await Promise.all([
    countStudentsByClass(rows.map((r) => r.classId)),
    loadPeople(rows),
  ]);

  return {
    staff: {
      id: staff.id,
      name: fullName(staff),
      isArchived: staff.isArchived,
      // ⚠️ Panel shu bayroqqa qarab "rol berilmagan" ogohlantirishini
      // ko'rsatadi: belgisi yo'q xodimga biriktirish SERVERDA rad etiladi,
      // ya'ni tugmani bosib ko'rishdan oldin sabab aytilishi kerak
      isClassLeader: isClassLeaderUser(staff, leaderRoles),
    },
    items: rows.map((row) => shapeRow(row, { counts, people })),
    totalStudents: rows.reduce((sum, r) => sum + (counts.get(r.classId) ?? 0), 0),
  };
};

/**
 * SINF RAHBARINING O'Z SINFLARI — xodim paneli. Ruxsat kaliti yo'q, id tokendan.
 *
 * ⚠️ Nofaol sinf ko'rsatilmaydi (`getMyLeaderClassIds` bilan AYNI shart):
 * xodim bugungi ishini ko'radi, tarixni emas.
 *
 * @param {{id: string, role?: string, extraRoles?: string[]}} actor - HAR DOIM `req.user`
 */
const getMyClasses = async (actor) => {
  // ⚠️ RO'YXAT HAM `getMyLeaderClassIds` DAN: rol olib qo'yilgan xodim
  // ekranda sinfini ko'rib, belgilashda 403 olardi — ya'ni ikki ekran ikki
  // xil haqiqat ko'rsatardi.
  const classIds = await getMyLeaderClassIds(actor);
  if (classIds.length === 0) return { items: [] };

  const rows = await prisma.classLeader.findMany({
    where: { leaderId: actor.id, classId: { in: classIds } },
    include: { class: { select: { id: true, name: true, isActive: true } } },
    orderBy: { class: { name: "asc" } },
  });

  const counts = await countStudentsByClass(rows.map((r) => r.classId));

  return {
    items: rows.map((row) => ({
      id: row.id,
      classId: row.classId,
      className: row.class?.name ?? "Noma'lum",
      studentCount: counts.get(row.classId) ?? 0,
      note: row.note || "",
    })),
  };
};

/**
 * REGISTR — "kim qaysi sinfga rahbar" (admin, sahifalanadi).
 *
 * @param {{page: number, limit: number, skip: number}} pagination
 * @param {{search?: string, classId?: string, leaderId?: string}} [filters]
 */
const getLeaders = async ({ skip, limit }, filters = {}) => {
  const { search, classId, leaderId } = filters;

  const where = {};
  if (classId) {
    assertId(classId, "Sinf");
    where.classId = classId;
  }
  if (leaderId) {
    assertId(leaderId, "Xodim");
    where.leaderId = leaderId;
  }

  // ⚠️ Ism bo'yicha qidiruv IKKI QADAMDA: `leaderId` — soft ref (FK yo'q),
  // ya'ni `where` ichidan relation orqali qidirib bo'lmaydi. Avval mos
  // xodimlar topiladi, keyin qatorlar o'sha id lar bo'yicha filtrlanadi —
  // natija baribir SQL da chiqadi, xotirada emas (`devices.md` §10).
  const term = String(search ?? "").trim();
  if (term) {
    const matched = await prisma.user.findMany({
      where: {
        role: { not: ROLES.STUDENT },
        OR: [
          { firstName: { contains: term, mode: "insensitive" } },
          { lastName: { contains: term, mode: "insensitive" } },
        ],
      },
      select: { id: true },
    });

    const matchedIds = matched.map((m) => m.id);
    const byClassName = { class: { name: { contains: term, mode: "insensitive" } } };

    // Qidiruv mavjud filtr bilan KESISHTIRILADI, ustiga yozilmaydi
    where.OR = matchedIds.length
      ? [{ leaderId: { in: matchedIds } }, byClassName]
      : [byClassName];
  }

  const [total, rows] = await Promise.all([
    prisma.classLeader.count({ where }),
    prisma.classLeader.findMany({
      where,
      include: { class: { select: { id: true, name: true, isActive: true } } },
      orderBy: { class: { name: "asc" } },
      skip,
      take: limit,
    }),
  ]);

  const [counts, people] = await Promise.all([
    countStudentsByClass(rows.map((r) => r.classId)),
    loadPeople(rows),
  ]);

  return { total, items: rows.map((row) => shapeRow(row, { counts, people })) };
};

/**
 * TANLAGICH — qaysi sinf bo'sh, qaysisi band va kim band qilgan.
 *
 * Band sinf oynada belgilanmaydi (`isAvailable: false`), lekin ro'yxatdan
 * YASHIRILMAYDI: "nega 5-A yo'q" degan savol qo'lda qidirib topiladigan
 * bo'lmasin (tyutor tanlagichi bilan AYNI qoida).
 *
 * @param {{leaderId?: string}} [params]
 */
const getClassOptions = async ({ leaderId } = {}) => {
  const [classes, holders] = await Promise.all([
    prisma.class.findMany({
      select: { id: true, name: true, isActive: true },
      orderBy: { name: "asc" },
    }),
    prisma.classLeader.findMany({ select: { classId: true, leaderId: true } }),
  ]);

  const [counts, people] = await Promise.all([
    countStudentsByClass(classes.map((c) => c.id)),
    holders.length
      ? prisma.user.findMany({
          where: { id: { in: [...new Set(holders.map((h) => h.leaderId))] } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [],
  ]);
  const personOf = new Map(people.map((p) => [p.id, p]));

  const holderOf = new Map(
    holders.map((h) => [
      h.classId,
      {
        leaderId: h.leaderId,
        leaderName: fullName(personOf.get(h.leaderId)) || "Noma'lum",
        isMine: Boolean(leaderId) && h.leaderId === leaderId,
      },
    ]),
  );

  return {
    items: classes.map((c) => {
      const holder = holderOf.get(c.id) ?? null;
      return {
        id: c.id,
        name: c.name,
        isActive: c.isActive,
        studentCount: counts.get(c.id) ?? 0,
        holder,
        // O'zining sinfi ham "band": qayta biriktirishdan ma'no yo'q
        isAvailable: c.isActive && !holder,
      };
    }),
  };
};

// ─────────────────────────────────────────────
// Yozish
// ─────────────────────────────────────────────

/** Xodim: mavjud, o'quvchi emas, arxivlanmagan va sinf rahbari roli bor. */
const loadLeader = async (leaderId) => {
  assertId(leaderId, "Xodim");

  const [leader, leaderRoles] = await Promise.all([
    prisma.user.findUnique({
      where: { id: leaderId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        role: true,
        extraRoles: true,
        isArchived: true,
      },
    }),
    loadClassLeaderRoleValues(),
  ]);

  if (!leader) throw new NotFoundError("Xodim topilmadi");
  if (leader.role === ROLES.STUDENT) {
    throw new BadRequestError("O'quvchi sinf rahbari bo'lolmaydi");
  }
  if (leader.isArchived) {
    throw new BadRequestError("Arxivlangan xodimga sinf biriktirilmaydi");
  }
  if (!isClassLeaderUser(leader, leaderRoles)) {
    throw new BadRequestError(
      "Bu xodimda sinf rahbari roli yo'q. Xodimga shu rolni bering yoki " +
        'Rollar sahifasida rolga "Sinf rahbari" belgisini qo\'ying',
    );
  }
  return leader;
};

/**
 * XODIMGA BIR YOKI BIR NECHTA SINF BIRIKTIRADI.
 *
 * ⚠️ HAMMASI YOKI HECH NARSA (tyutor biriktirishi bilan AYNI qoida): bitta
 * tranzaksiya, bitta sinf band bo'lsa HECH QAYSI yozilmaydi va band
 * sinflarning HAMMASI bitta xabarda aytiladi. "10 tadan 8 tasi biriktirildi"
 * degan yarim holat qo'lda qidirib topiladigan xato bo'lardi.
 *
 * @param {{leaderId: string, classIds?: string[], classId?: string, note?: string}} data
 * @param {string} actorId
 */
const assignClasses = async (data = {}, actorId) => {
  const classIds = parseClassIds(data);
  const note = parseNote(data.note);
  const leader = await loadLeader(data.leaderId);

  const classes = await prisma.class.findMany({
    where: { id: { in: classIds } },
    select: { id: true, name: true, isActive: true },
    orderBy: { name: "asc" },
  });
  if (classes.length !== classIds.length) {
    throw new NotFoundError(
      classIds.length === 1 ? "Sinf topilmadi" : "Ba'zi sinflar topilmadi",
    );
  }

  const inactive = classes.filter((c) => !c.isActive);
  if (inactive.length > 0) {
    throw new BadRequestError(
      `Nofaol sinfga rahbar biriktirilmaydi: ${inactive.map((c) => c.name).join(", ")}`,
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    // Band sinflar — HAMMASI bitta xabarda. Kafolat baribir indeksda
    // (`@@unique([classId])`), bu tekshiruv esa tushunarli xato uchun.
    const taken = await tx.classLeader.findMany({
      where: { classId: { in: classIds } },
      select: { classId: true, leaderId: true },
    });

    if (taken.length > 0) {
      const names = new Map(classes.map((c) => [c.id, c.name]));
      const holderIds = [...new Set(taken.map((t) => t.leaderId))];
      const holders = await tx.user.findMany({
        where: { id: { in: holderIds } },
        select: { id: true, firstName: true, lastName: true },
      });
      const holderOf = new Map(holders.map((h) => [h.id, fullName(h)]));

      throw new ConflictError(
        `Bu sinflarda allaqachon rahbar bor: ${taken
          .map(
            (t) =>
              `${names.get(t.classId) ?? "Sinf"} — ${holderOf.get(t.leaderId) || "Noma'lum"}`,
          )
          .join("; ")}`,
        { classIds: taken.map((t) => t.classId) },
      );
    }

    const rows = [];
    for (const cls of classes) {
      rows.push(
        await tx.classLeader.create({
          data: { leaderId: leader.id, classId: cls.id, note, createdBy: actorId },
          include: { class: { select: { id: true, name: true, isActive: true } } },
        }),
      );
    }
    return rows;
  }, CREATE_TX_OPTIONS);

  logger.info(
    `Sinf rahbari biriktirildi: ${fullName(leader)} → ${created
      .map((r) => r.class?.name)
      .join(", ")} (aktyor: ${actorId})`,
  );

  const [counts, people] = await Promise.all([
    countStudentsByClass(created.map((r) => r.classId)),
    loadPeople(created),
  ]);

  return {
    items: created.map((row) => shapeRow(row, { counts, people })),
    message:
      created.length === 1
        ? `${fullName(leader)} — ${created[0].class?.name} sinf rahbari`
        : `${fullName(leader)} ${created.length} sinfga rahbar qilib biriktirildi`,
  };
};

/**
 * Izohni tahrirlaydi. Sinf va rahbar O'ZGARMAYDI: "boshqa sinf" yoki "boshqa
 * odam" — bu AVVALGI biriktirishni olib tashlash va yangisini yozish, ya'ni
 * ikki qaror. Bitta `patch` bilan qilinsa, "nega 5-A dan tushib qoldim"
 * degan savolga javob qolmasdi.
 *
 * @param {string} id
 * @param {{note?: string}} data
 * @param {string} actorId
 */
const updateClass = async (id, data = {}, actorId) => {
  assertId(id, "Biriktirish");
  if (data.note === undefined) {
    throw new BadRequestError("O'zgartirish uchun izoh yuborilmagan");
  }
  const note = parseNote(data.note);

  const existing = await prisma.classLeader.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Biriktirish topilmadi");

  const row = await prisma.classLeader.update({
    where: { id },
    data: { note },
    include: { class: { select: { id: true, name: true, isActive: true } } },
  });

  logger.info(`Sinf rahbarligi izohi o'zgardi: ${id} (aktyor: ${actorId})`);

  const [counts, people] = await Promise.all([
    countStudentsByClass([row.classId]),
    loadPeople([row]),
  ]);
  return shapeRow(row, { counts, people });
};

/**
 * BIRIKTIRISHNI OLIB TASHLAYDI.
 *
 * ⚠️ O'CHIRILADI, "bekor qilinmaydi" — va bu doktrinaga ZID emas. Loyihadagi
 * "o'chirmaymiz, bekor qilamiz" qoidasi PULGA yoki o'tgan FAKTGA tayanadigan
 * qatorlar uchun (`PayrollEntry`, `TutorGroup`, `LessonCredit`): ularga
 * hisobot, oylik yoki jarima ishora qiladi. Bu qator esa faqat HOZIRGI
 * huquqni ifodalaydi va unga hech narsa ishora qilmaydi — belgilangan
 * davomat `studentAttendances` da o'z aktyori bilan qoladi. Yopilgan qatorni
 * saqlash ro'yxatni ma'nosiz tarix bilan to'ldirardi (`education.md` §8 dagi
 * "boshlanmagan reja o'chiriladi" bilan AYNI mulohaza).
 *
 * @param {string} id
 * @param {string} actorId
 */
const removeClass = async (id, actorId) => {
  assertId(id, "Biriktirish");

  const existing = await prisma.classLeader.findUnique({
    where: { id },
    include: { class: { select: { name: true } } },
  });
  if (!existing) throw new NotFoundError("Biriktirish topilmadi");

  await prisma.classLeader.delete({ where: { id } });

  logger.info(
    `Sinf rahbarligi olib tashlandi: ${existing.class?.name ?? existing.classId} ` +
      `(xodim: ${existing.leaderId}, aktyor: ${actorId})`,
  );

  return {
    id,
    classId: existing.classId,
    className: existing.class?.name ?? null,
    message: `${existing.class?.name ?? "Sinf"} — sinf rahbarligi olib tashlandi`,
  };
};

module.exports = {
  NO_GROUP_MESSAGE,
  NOT_MY_CLASS_MESSAGE,
  loadClassLeaderRoleValues,
  isClassLeaderUser,
  getMyLeaderClassIds,
  assertMyLeaderClass,
  getMyClasses,
  getStaffClasses,
  getLeaders,
  getClassOptions,
  assignClasses,
  updateClass,
  removeClass,
};
