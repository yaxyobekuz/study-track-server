/**
 * O'QUVCHI SINFI O'ZGARISHI JURNALI — sinfdan chiqarish va boshqa sinfga
 * ko'chirish, majburiy sababi va aktyori bilan (`StudentClassChange`).
 *
 * `UserClass` sanasiz va tarixsiz, shuning uchun "nega bu o'quvchi sinfsiz
 * qoldi / nega boshqa sinfga o'tdi" degan savolga faqat shu jurnal javob
 * beradi. O'quvchi sinfini o'zgartiradigan HAR yo'l (profil, sinf sahifasi,
 * AI yordamchi) shu modul orqali yozadi — sabab qoidasi ham, yozuv shakli
 * ham bitta joyda. Ikkinchi nusxa bo'lsa, bir yo'l sababsiz o'tib ketardi
 * va registr "to'liq" ko'rinib, aslida bo'shliq bilan turardi.
 *
 * Qoida bitta jumlada: o'quvchi kamida bitta sinfini YO'QOTSA — sabab
 * majburiy va jurnalga yoziladi. Sof qo'shish sabab talab qilmaydi va
 * yozilmaydi (`schema.prisma` → `StudentClassChange` izohi).
 *
 * ⚠️ Arxivlashda sinfdan chiqish bu yerga YOZILMAYDI — uning sababi
 * `User.archiveNote` da (ikki joyda ikki xil sabab turib qolmasin).
 */

const prisma = require("../config/prisma");
const { isValidId } = require("../utils/objectId");
const { BadRequestError } = require("../utils/errors");

const REASON_MIN = 3;
const REASON_MAX = 500;

const CHANGE_TYPES = Object.freeze({ MOVED: "moved", REMOVED: "removed" });

const CHANGE_SOURCES = Object.freeze({
  PROFILE: "profile",
  CLASS_PAGE: "class_page",
  ASSISTANT: "assistant",
});

const PAGE_LIMIT_DEFAULT = 20;
const PAGE_LIMIT_MAX = 100;

// Qidiruvda nechta so'z hisobga olinadi ("Valiyev Ali" — ikki so'z). Cheksiz
// so'z har biri uchun uchta `ILIKE` shartini ko'paytirardi.
const SEARCH_TERMS_MAX = 4;

/**
 * Sababni tekshiradi va normallashtiradi. Bo'sh / juda qisqa / juda uzun
 * sabab RAD ETILADI — "." yoki "-" kabi sabab registrda hech narsa aytmaydi.
 *
 * @param {unknown} reason
 * @returns {string}
 */
function normalizeReason(reason) {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text) {
    throw new BadRequestError("Sinfdan chiqarish yoki ko'chirish sababi majburiy");
  }
  if (text.length < REASON_MIN) {
    throw new BadRequestError(`Sabab kamida ${REASON_MIN} ta belgidan iborat bo'lishi kerak`);
  }
  if (text.length > REASON_MAX) {
    throw new BadRequestError(`Sabab ${REASON_MAX} ta belgidan oshmasligi kerak`);
  }
  return text;
}

/**
 * Ikki sinf ro'yxati orasidagi farq. Tartib va takror ahamiyatsiz.
 *
 * @param {string[]} prevIds - hozirgi sinflar
 * @param {string[]} nextIds - yangi sinflar
 * @returns {{ removed: string[], added: string[] }} saralangan
 */
function diffClassIds(prevIds, nextIds) {
  const prev = new Set(prevIds);
  const next = new Set(nextIds);
  return {
    removed: [...prev].filter((id) => !next.has(id)).sort(),
    added: [...next].filter((id) => !prev.has(id)).sort(),
  };
}

/**
 * O'quvchilarning sinf a'zoligini tranzaksiya oxirigacha qulflaydi.
 *
 * ⚠️ HAR yo'l farqni QULF ICHIDA, `tx` bilan qayta o'qiydi. Aks holda ikki
 * parallel amal (profilda tahrir + sinf sahifasida ko'chirish) bir xil
 * eskirgan holatni ko'rib, jurnalga bo'lmagan o'zgarishni yozardi.
 *
 * ⚠️ Kalitlar SARALANGAN tartibda olinadi: kesishgan to'plamli ikki
 * ommaviy amal bir-birini kutib deadlock bo'lmasligi uchun.
 *
 * ⚠️ `$executeRaw`: `pg_advisory_xact_lock` `void` qaytaradi va `$queryRaw`
 * uni o'qiy olmaydi (`scheduleWriteGuard.service.js` izohi). O'quvchi id
 * lari filiallar bo'ylab yagona, shuning uchun kalitda schema nomi shart emas.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {string[]} studentIds
 */
async function lockStudentClasses(tx, studentIds) {
  const keys = [...new Set(studentIds)].sort().map((id) => `student_classes:${id}`);
  if (keys.length === 0) return;

  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(k))
    FROM (SELECT unnest(${keys}::text[]) AS k ORDER BY 1) AS ordered`;
}

/**
 * Jurnalga yozadi. Faqat sinf YO'QOTGAN o'zgarishlar qator bo'ladi.
 *
 * Tranzaksiya ICHIDA, a'zolik yozuvi bilan birga chaqiriladi: jurnal
 * yozilmasa a'zolik ham o'zgarmaydi (sababsiz o'zgarish strukturaviy
 * imkonsiz).
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {{ studentId: string, fromClassIds: string[], toClassIds: string[] }[]} changes
 * @param {{ reason: string, source: string, actorId: string }} meta
 * @returns {Promise<number>} yozilgan qatorlar soni
 */
async function recordClassChanges(tx, changes, { reason, source, actorId }) {
  const rows = changes.filter((change) => change.fromClassIds.length > 0);
  if (rows.length === 0) return 0;

  // Dasturchi xatosi — foydalanuvchi xabari emas: aktyorsiz audit yozuvi
  // "kim qildi" degan savolga javobsiz qolardi.
  if (!actorId) throw new Error("Sinf o'zgarishi jurnali: aktyor (actorId) berilmagan");
  if (!Object.values(CHANGE_SOURCES).includes(source)) {
    throw new Error(`Sinf o'zgarishi jurnali: noma'lum manba "${source}"`);
  }

  const classIds = [...new Set(rows.flatMap((c) => [...c.fromClassIds, ...c.toClassIds]))];
  const classes = await tx.class.findMany({
    where: { id: { in: classIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(classes.map((c) => [c.id, c.name]));
  const namesOf = (ids) => ids.map((id) => nameById.get(id) ?? "Noma'lum sinf");

  const { count } = await tx.studentClassChange.createMany({
    data: rows.map((change) => ({
      studentId: change.studentId,
      type: change.toClassIds.length > 0 ? CHANGE_TYPES.MOVED : CHANGE_TYPES.REMOVED,
      source,
      fromClassIds: change.fromClassIds,
      fromClassNames: namesOf(change.fromClassIds),
      toClassIds: change.toClassIds,
      toClassNames: namesOf(change.toClassIds),
      reason,
      createdBy: actorId,
    })),
  });
  return count;
}

/** Parallel massivlar → `[{ id, name }]`. */
const zipClasses = (ids = [], names = []) =>
  ids.map((id, index) => ({ id, name: names[index] ?? "Noma'lum sinf" }));

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function optionalId(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (!isValidId(String(value))) throw new BadRequestError(`Noto'g'ri ${label} formati`);
  return String(value);
}

/**
 * O'quvchi ismi bo'yicha qidiruv sharti. Har so'z ism, familiya yoki
 * logindan BIRIGA mos kelishi kerak — "Valiyev Ali" ham, "Ali Valiyev" ham
 * topiladi (bitta `contains` bilan ikkalasi ham topilmasdi).
 */
function studentSearchWhere(search) {
  const terms = String(search ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, SEARCH_TERMS_MAX);
  if (terms.length === 0) return null;

  return {
    AND: terms.map((term) => ({
      OR: [
        { firstName: { contains: term, mode: "insensitive" } },
        { lastName: { contains: term, mode: "insensitive" } },
        { username: { contains: term, mode: "insensitive" } },
      ],
    })),
  };
}

/**
 * Jurnal registri — sahifalangan, eng yangisi birinchi.
 *
 * Qidiruv, sinf va o'quvchi filtri SQL darajasida (xotirada emas). Sinf
 * filtri — o'sha sinfdan CHIQQAN yoki unga KIRGAN har ikkala holat.
 * `totals` — tur bo'yicha sanoq (joriy qidiruv va filtr bilan), tablar
 * yorlig'i uchun.
 *
 * ⚠️ Arxivlangan o'quvchining yozuvlari ham qaytadi (`student.isArchived`
 * bilan): bu joriy o'quvchilar ro'yxati emas, AMALLAR jurnali — ularni
 * yashirish "kim, qachon, nega chiqardi" degan audit savolini javobsiz
 * qoldirardi. Panel ularni belgi bilan ko'rsatadi.
 *
 * @param {{ type?: string, search?: string, classId?: string, studentId?: string, page?: string|number, limit?: string|number }} query
 */
async function listClassChanges(query = {}) {
  const { type, search } = query;
  if (type !== undefined && type !== "" && !Object.values(CHANGE_TYPES).includes(type)) {
    throw new BadRequestError("Noto'g'ri o'zgarish turi");
  }
  const classId = optionalId(query.classId, "sinf");
  const studentId = optionalId(query.studentId, "o'quvchi");

  const page = parsePositiveInt(query.page, 1);
  const limit = Math.min(parsePositiveInt(query.limit, PAGE_LIMIT_DEFAULT), PAGE_LIMIT_MAX);

  const base = {};
  if (studentId) base.studentId = studentId;
  if (classId) {
    base.OR = [{ fromClassIds: { has: classId } }, { toClassIds: { has: classId } }];
  }
  const studentWhere = studentSearchWhere(search);
  if (studentWhere) base.student = studentWhere;

  const where = type ? { ...base, type } : base;

  const [rows, total, moved, removed] = await Promise.all([
    prisma.studentClassChange.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            username: true,
            isArchived: true,
            classes: {
              select: { class: { select: { id: true, name: true } } },
              orderBy: { class: { name: "asc" } },
            },
          },
        },
      },
    }),
    prisma.studentClassChange.count({ where }),
    prisma.studentClassChange.count({ where: { ...base, type: CHANGE_TYPES.MOVED } }),
    prisma.studentClassChange.count({ where: { ...base, type: CHANGE_TYPES.REMOVED } }),
  ]);

  // Aktyor — soft ref: bitta so'rov bilan yuklanadi. O'chirilgan xodim
  // `null` bo'lib qaytadi, yozuvning o'zi esa qoladi.
  const actorIds = [...new Set(rows.map((r) => r.createdBy))];
  const actors = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const actorById = new Map(actors.map((a) => [a.id, a]));

  const data = rows.map((row) => ({
    id: row.id,
    type: row.type,
    source: row.source,
    reason: row.reason,
    createdAt: row.createdAt,
    fromClasses: zipClasses(row.fromClassIds, row.fromClassNames),
    toClasses: zipClasses(row.toClassIds, row.toClassNames),
    student: {
      id: row.student.id,
      firstName: row.student.firstName,
      lastName: row.student.lastName,
      username: row.student.username,
      isArchived: row.student.isArchived,
      currentClasses: row.student.classes.map((uc) => uc.class),
    },
    createdBy: actorById.get(row.createdBy) ?? null,
  }));

  return { data, total, page, limit, totals: { moved, removed } };
}

module.exports = {
  REASON_MIN,
  REASON_MAX,
  CHANGE_TYPES,
  CHANGE_SOURCES,
  normalizeReason,
  diffClassIds,
  lockStudentClasses,
  recordClassChanges,
  listClassChanges,
};
