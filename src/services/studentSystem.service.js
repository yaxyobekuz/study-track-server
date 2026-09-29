/**
 * O'QUVCHI TASHQI TIZIMLARDA — ERP va Kundalik.com (`StudentSystemMark`).
 *
 * Maktab o'quvchilarni ikki tashqi tizimga qo'lda kiritadi. Bu modul "kim
 * kiritilgan, kim hali yo'q" degan savolga javob beradi: mas'ul xodim har
 * o'quvchi uchun "bor" belgisini qo'yadi, ro'yxat va Excel shu belgilardan
 * "bor" / "yo'q" kesimini chiqaradi.
 *
 * Qoida bitta jumlada: belgi QATORI bor — "bor", yo'q — "yo'q". Sukutda
 * hech kim belgilanmagan (yangi o'quvchi ham o'z-o'zidan "yo'q" larda).
 *
 * ⚠️ Faqat JORIY o'quvchilar: arxivlangani faqat O'quvchilar → Arxiv da
 * ko'rinadi (`education.md` §4). Belgisi esa o'chirilmaydi — arxivdan
 * qaytsa o'z holati bilan qaytadi.
 */

const prisma = require("../config/prisma");
const { isValidId } = require("../utils/objectId");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { buildNameSearchWhere } = require("../helpers/nameSearch.helpers");

// ⚠️ `ExternalSystem` enumi bilan AYNI tartib — ro'yxat ustunlari, Excel
// varaqlari va panel shu tartibda chiziladi.
const SYSTEMS = Object.freeze(["erp", "kundalik"]);

const SYSTEM_LABELS = Object.freeze({ erp: "ERP", kundalik: "Kundalik.com" });

const PRESENCE = Object.freeze({ YES: "yes", NO: "no" });

// Sinf filtri: sinfga biriktirilmagan o'quvchilar
const NO_CLASS = "none";
const NO_CLASS_LABEL = "Sinfsiz";

const PAGE_LIMIT_DEFAULT = 50;
const PAGE_LIMIT_MAX = 200;

// Bir amalda belgilanadigan o'quvchilar (panel sahifa bo'yicha yuboradi)
const MARK_BATCH_MAX = 500;

const EXPORT_CLASSES_MAX = 300;

const EXPORT_SCOPES = Object.freeze({ SCHOOL: "school", CLASSES: "classes" });

/**
 * Excel ro'yxatlari. `all` — to'liq hisobot (har ro'yxat alohida varaqda),
 * qolganlari — bitta ro'yxat. Kalit panel bilan qo'lda sinxron
 * (`studentSystems.data.js` → `EXPORT_LIST_OPTIONS`).
 */
const EXPORT_LISTS = Object.freeze({
  all: { fileName: "ERP_va_Kundalik" },
  erp_yes: {
    system: "erp",
    present: true,
    sheet: "ERP da bor",
    title: "ERP da bor o'quvchilar",
    fileName: "ERP_da_bor",
    emptyText: "ERP da bor deb belgilangan o'quvchi yo'q",
  },
  erp_no: {
    system: "erp",
    present: false,
    sheet: "ERP da yo'q",
    title: "ERP da yo'q o'quvchilar",
    fileName: "ERP_da_yoq",
    emptyText: "Hamma o'quvchi ERP da bor deb belgilangan",
  },
  kundalik_yes: {
    system: "kundalik",
    present: true,
    sheet: "Kundalik.com da bor",
    title: "Kundalik.com da bor o'quvchilar",
    fileName: "Kundalik_da_bor",
    emptyText: "Kundalik.com da bor deb belgilangan o'quvchi yo'q",
  },
  kundalik_no: {
    system: "kundalik",
    present: false,
    sheet: "Kundalik.com da yo'q",
    title: "Kundalik.com da yo'q o'quvchilar",
    fileName: "Kundalik_da_yoq",
    emptyText: "Hamma o'quvchi Kundalik.com da bor deb belgilangan",
  },
});

// Joriy (arxivlanmagan) o'quvchilar — har so'rovning asosi
const CURRENT_STUDENTS = Object.freeze({ role: "student", isArchived: false });

// Sinf nomlari "tabiiy" tartibda: 5-A, 9-B, 10-A (matn tartibida 10 < 5 bo'lardi)
const classCollator = new Intl.Collator("uz", { numeric: true, sensitivity: "base" });
const nameCollator = new Intl.Collator("uz", { sensitivity: "base" });

/* ── Kirishni tekshirish ─────────────────────────────────────────────── */

const isBlank = (value) => value === undefined || value === null || value === "";

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** @returns {"erp"|"kundalik"} */
function parseSystem(value) {
  if (!SYSTEMS.includes(value)) {
    throw new BadRequestError("Tizim noto'g'ri: ERP yoki Kundalik.com bo'lishi kerak");
  }
  return value;
}

/** Filtr qiymati: `yes` | `no` | `null` (hammasi). */
function parsePresence(value, system) {
  if (isBlank(value) || value === "all") return null;
  if (value !== PRESENCE.YES && value !== PRESENCE.NO) {
    throw new BadRequestError(`${SYSTEM_LABELS[system]} filtri noto'g'ri`);
  }
  return value;
}

/** Sinf filtri: sinf id | `none` (sinfsiz) | `null` (hammasi). */
function parseClassFilter(value) {
  if (isBlank(value) || value === "all") return null;
  if (value === NO_CLASS) return NO_CLASS;
  if (!isValidId(String(value))) throw new BadRequestError("Noto'g'ri sinf formati");
  return String(value);
}

/**
 * Ro'yxat so'rovi → tekshirilgan filtrlar.
 *
 * @param {Record<string, unknown>} query
 */
function parseListQuery(query = {}) {
  return {
    classFilter: parseClassFilter(query.classId),
    search: typeof query.search === "string" ? query.search : "",
    presence: Object.fromEntries(
      SYSTEMS.map((system) => [system, parsePresence(query[system], system)]),
    ),
    page: parsePositiveInt(query.page, 1),
    limit: Math.min(parsePositiveInt(query.limit, PAGE_LIMIT_DEFAULT), PAGE_LIMIT_MAX),
  };
}

/**
 * `classIds` — vergul bilan ajratilgan matn ("a,b") yoki massiv
 * (`?classIds=a&classIds=b`). Takrorsiz, tartib saqlanadi.
 */
function parseClassIds(value) {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(",");
  const ids = [...new Set(raw.map((id) => String(id).trim()).filter(Boolean))];

  if (ids.length === 0) throw new BadRequestError("Kamida bitta sinf tanlang");
  if (ids.length > EXPORT_CLASSES_MAX) {
    throw new BadRequestError(`Bir martada ko'pi bilan ${EXPORT_CLASSES_MAX} ta sinf tanlanadi`);
  }
  if (ids.some((id) => !isValidId(id))) throw new BadRequestError("Noto'g'ri sinf formati");
  return ids;
}

/**
 * Excel so'rovi → `{ list, scope, classIds }`. Butun maktabda `classIds = null`.
 *
 * @param {Record<string, unknown>} query
 */
function parseExportQuery(query = {}) {
  const list = isBlank(query.list) ? "all" : String(query.list);
  if (!Object.hasOwn(EXPORT_LISTS, list)) throw new BadRequestError("Ro'yxat turi noto'g'ri");

  const scope = isBlank(query.scope) ? EXPORT_SCOPES.SCHOOL : String(query.scope);
  if (!Object.values(EXPORT_SCOPES).includes(scope)) {
    throw new BadRequestError("Qamrov noto'g'ri: butun maktab yoki sinflar");
  }

  return {
    list,
    scope,
    classIds: scope === EXPORT_SCOPES.CLASSES ? parseClassIds(query.classIds) : null,
  };
}

/** Belgilanadigan o'quvchilar — takrorsiz, bo'sh emas, chegarada. */
function parseStudentIds(studentIds) {
  if (!Array.isArray(studentIds) || studentIds.length === 0) {
    throw new BadRequestError("O'quvchilar tanlanmagan");
  }
  const ids = [...new Set(studentIds.map(String))];
  if (ids.length > MARK_BATCH_MAX) {
    throw new BadRequestError(`Bir martada ko'pi bilan ${MARK_BATCH_MAX} ta o'quvchi belgilanadi`);
  }
  if (ids.some((id) => !isValidId(id))) throw new BadRequestError("Noto'g'ri o'quvchi formati");
  return ids;
}

/* ── So'rov shartlari ────────────────────────────────────────────────── */

/** Bo'sh bo'laklarsiz `AND`. */
function allOf(...parts) {
  const list = parts.filter(Boolean);
  return list.length > 0 ? { AND: list } : {};
}

function classWhere(classFilter) {
  if (!classFilter) return null;
  if (classFilter === NO_CLASS) return { classes: { none: {} } };
  return { classes: { some: { classId: classFilter } } };
}

/** "Bor" — belgi qatori bor, "yo'q" — shu tizim uchun qator yo'q. */
function presenceWhere(system, presence) {
  if (!presence) return null;
  const mark = { system };
  return { systemMarks: presence === PRESENCE.YES ? { some: mark } : { none: mark } };
}

/**
 * Ro'yxat shartlari.
 *
 * `scope` — sanoq kartalari uchun: faqat SINF filtri. Qidiruv va "bor/yo'q"
 * filtri kartalarga ta'sir qilmaydi — aks holda "ERP da yo'q" tanlanganda
 * "ERP da bor" kartasi 0 bo'lib, sinf manzarasi yo'qolardi.
 * `where` — jadval: barcha filtrlar.
 *
 * @param {ReturnType<typeof parseListQuery>} filters
 */
function buildListWhere(filters) {
  const scope = allOf(CURRENT_STUDENTS, classWhere(filters.classFilter));
  const where = allOf(
    CURRENT_STUDENTS,
    classWhere(filters.classFilter),
    buildNameSearchWhere(filters.search),
    ...SYSTEMS.map((system) => presenceWhere(system, filters.presence[system])),
  );
  return { scope, where };
}

/* ── Ro'yxat ─────────────────────────────────────────────────────────── */

const fullName = (person) =>
  [person?.firstName, person?.lastName].filter(Boolean).join(" ").trim();

const sortClasses = (classes) =>
  [...classes].sort((a, b) => classCollator.compare(a.name, b.name));

/**
 * O'quvchilar ro'yxati — sahifalangan, ism bo'yicha. Har qatorda ikkala
 * tizim belgisi (kim va qachon qo'ygani bilan) yoki `null`.
 *
 * @param {Record<string, unknown>} query - `search`, `classId`, `erp`, `kundalik`, `page`, `limit`
 */
async function listStudentSystems(query = {}) {
  const filters = parseListQuery(query);
  const { scope, where } = buildListWhere(filters);
  const { page, limit } = filters;

  const [students, total, scopeTotal, ...yesCounts] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }, { id: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        username: true,
        classes: { select: { class: { select: { id: true, name: true } } } },
        systemMarks: { select: { system: true, markedBy: true, markedAt: true } },
      },
    }),
    prisma.user.count({ where }),
    prisma.user.count({ where: scope }),
    ...SYSTEMS.map((system) =>
      prisma.user.count({ where: allOf(scope, presenceWhere(system, PRESENCE.YES)) }),
    ),
  ]);

  // Belgilagan xodim — soft ref: bitta so'rov bilan. O'chirilgan xodim
  // `null` bo'lib qaytadi, belgining o'zi esa qoladi.
  const actorIds = [...new Set(students.flatMap((s) => s.systemMarks.map((m) => m.markedBy)))];
  const actors = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const actorById = new Map(actors.map((actor) => [actor.id, actor]));

  const data = students.map((student) => {
    const markBySystem = new Map(student.systemMarks.map((mark) => [mark.system, mark]));
    return {
      id: student.id,
      firstName: student.firstName,
      lastName: student.lastName,
      username: student.username,
      classes: sortClasses(student.classes.map((uc) => uc.class)),
      systems: Object.fromEntries(
        SYSTEMS.map((system) => {
          const mark = markBySystem.get(system);
          return [
            system,
            mark
              ? { markedAt: mark.markedAt, markedBy: actorById.get(mark.markedBy) ?? null }
              : null,
          ];
        }),
      ),
    };
  });

  const summary = {
    students: scopeTotal,
    systems: Object.fromEntries(
      SYSTEMS.map((system, index) => [
        system,
        { yes: yesCounts[index], no: scopeTotal - yesCounts[index] },
      ]),
    ),
  };

  return { data, total, page, limit, summary };
}

/* ── Belgilash ───────────────────────────────────────────────────────── */

/**
 * "Bor" / "yo'q" belgisini qo'yadi yoki oladi — bitta o'quvchi ham, bir
 * nechtasi ham shu yo'ldan.
 *
 * ⚠️ IDEMPOTENT: allaqachon "bor" o'quvchiga qayta "bor" qo'yilsa qator
 * o'zgarmaydi — birinchi belgilagan odam va sana saqlanadi. `changed` —
 * haqiqatan o'zgargan o'quvchilar soni.
 *
 * ⚠️ Faqat joriy o'quvchilar: arxivlangan yoki topilmagan id `skipped` ga
 * tushadi. Hammasi shunday bo'lsa — aniq xato (ro'yxat eskirgan).
 *
 * @param {{ studentIds: string[], system: string, present: boolean }} payload
 * @param {{ actorId: string }} options
 */
async function setStudentSystemMarks({ studentIds, system, present } = {}, { actorId } = {}) {
  // Dasturchi xatosi — foydalanuvchi xabari emas: aktyorsiz belgi "kim
  // belgiladi" degan savolga javobsiz qolardi.
  if (!actorId) throw new Error("Tizim belgisi: aktyor (actorId) berilmagan");

  const key = parseSystem(system);
  if (typeof present !== "boolean") {
    throw new BadRequestError("Belgi holati (bor / yo'q) ko'rsatilmagan");
  }
  const ids = parseStudentIds(studentIds);

  const eligible = await prisma.user.findMany({
    where: { ...CURRENT_STUDENTS, id: { in: ids } },
    select: { id: true },
  });
  const eligibleIds = eligible.map((student) => student.id);
  if (eligibleIds.length === 0) {
    throw new BadRequestError(
      "Tanlangan o'quvchilar topilmadi yoki arxivlangan. Ro'yxatni yangilab, qayta urinib ko'ring",
    );
  }

  let changed;
  try {
    const result = present
      ? await prisma.studentSystemMark.createMany({
          data: eligibleIds.map((studentId) => ({ studentId, system: key, markedBy: actorId })),
          skipDuplicates: true,
        })
      : await prisma.studentSystemMark.deleteMany({
          where: { system: key, studentId: { in: eligibleIds } },
        });
    changed = result.count;
  } catch (error) {
    // Tekshiruvdan keyin o'quvchi o'chirilgan (FK) — 500 emas, aniq xabar
    if (error?.code === "P2003") {
      throw new BadRequestError("O'quvchilar ro'yxati o'zgargan. Sahifani yangilab, qayta urinib ko'ring");
    }
    throw error;
  }

  return {
    system: key,
    present,
    studentIds: eligibleIds,
    changed,
    skipped: ids.length - eligibleIds.length,
  };
}

/* ── Excel uchun ma'lumot ────────────────────────────────────────────── */

/**
 * O'quvchilar → Excel qatorlari: sinf (tabiiy tartib, sinfsizlar oxirida),
 * keyin ism bo'yicha.
 *
 * Bir nechta sinfdagi o'quvchi bitta qator: "Sinf" ustunida hamma sinflari,
 * tartib esa birinchi (sinflar bo'yicha yuklashda — birinchi TANLANGAN)
 * sinfi bo'yicha — o'z sinfdoshlari orasida turishi uchun.
 *
 * @param {Array<{ id: string, firstName: string, lastName?: string|null, classes: {id: string, name: string}[], systems: string[] }>} students
 * @param {{ classIds?: string[]|null }} [options]
 */
function buildExportRows(students, { classIds = null } = {}) {
  const selected = classIds ? new Set(classIds) : null;

  const rows = students.map((student) => {
    const classes = sortClasses(student.classes);
    const groupClass =
      (selected ? classes.find((cls) => selected.has(cls.id)) : classes[0]) ?? null;
    const marks = new Set(student.systems);

    return {
      id: student.id,
      name: fullName(student) || "—",
      classNames: classes.length > 0 ? classes.map((cls) => cls.name).join(", ") : NO_CLASS_LABEL,
      groupClass,
      ...Object.fromEntries(SYSTEMS.map((system) => [system, marks.has(system)])),
    };
  });

  return rows.sort((a, b) => {
    if (a.groupClass && !b.groupClass) return -1;
    if (!a.groupClass && b.groupClass) return 1;
    if (a.groupClass && b.groupClass) {
      const byClass = classCollator.compare(a.groupClass.name, b.groupClass.name);
      if (byClass !== 0) return byClass;
    }
    return nameCollator.compare(a.name, b.name) || a.id.localeCompare(b.id);
  });
}

/** Qatorlar bo'yicha "bor / yo'q" sanog'i. */
function countPresence(rows) {
  return {
    students: rows.length,
    systems: Object.fromEntries(
      SYSTEMS.map((system) => {
        const yes = rows.filter((row) => row[system]).length;
        return [system, { yes, no: rows.length - yes }];
      }),
    ),
  };
}

/**
 * SINFLAR KESIMI — har sinf bo'yicha sanoq.
 *
 * Sinflar bo'yicha yuklashda — TANLANGAN sinflar (o'quvchisi yo'q sinf ham
 * 0 bilan turadi: "bu sinf qayerda?" degan savol tug'ilmasin). Butun
 * maktabda — o'quvchisi bor sinflar va sinfsizlar.
 *
 * ⚠️ Ikki sinfdagi o'quvchi ikkala sinf qatorida sanaladi, jami esa
 * `countPresence(rows)` dan — takrorsiz o'quvchilar.
 *
 * @param {ReturnType<typeof buildExportRows>} rows
 * @param {Array<{ id: string, classes: {id: string, name: string}[] }>} students
 * @param {{ classes?: {id: string, name: string}[]|null }} [options] - tanlangan sinflar
 */
function buildClassSummary(rows, students, { classes = null } = {}) {
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const buckets = new Map();

  const bucketOf = (id, name) => {
    if (!buckets.has(id)) buckets.set(id, { id, name, rows: [] });
    return buckets.get(id);
  };

  if (classes) {
    for (const cls of sortClasses(classes)) bucketOf(cls.id, cls.name);
  }

  for (const student of students) {
    const row = rowById.get(student.id);
    if (!row) continue;

    if (student.classes.length === 0) {
      if (!classes) bucketOf(NO_CLASS, NO_CLASS_LABEL).rows.push(row);
      continue;
    }
    for (const cls of student.classes) {
      if (classes && !buckets.has(cls.id)) continue;
      bucketOf(cls.id, cls.name).rows.push(row);
    }
  }

  return [...buckets.values()]
    .sort((a, b) => {
      if (a.id === NO_CLASS) return 1;
      if (b.id === NO_CLASS) return -1;
      return classCollator.compare(a.name, b.name);
    })
    .map((bucket) => ({ id: bucket.id, name: bucket.name, ...countPresence(bucket.rows) }));
}

/**
 * Excel uchun ma'lumot: qatorlar, sanoq, sinflar kesimi.
 *
 * @param {ReturnType<typeof parseExportQuery>} params
 */
async function loadExportData({ classIds }) {
  const [users, classes] = await Promise.all([
    prisma.user.findMany({
      where: allOf(
        CURRENT_STUDENTS,
        classIds ? { classes: { some: { classId: { in: classIds } } } } : null,
      ),
      select: {
        id: true,
        firstName: true,
        lastName: true,
        classes: { select: { class: { select: { id: true, name: true } } } },
        systemMarks: { select: { system: true } },
      },
    }),
    classIds
      ? prisma.class.findMany({
          where: { id: { in: classIds } },
          select: { id: true, name: true },
        })
      : null,
  ]);

  // Oyna ochilgandan keyin sinf o'chirilgan bo'lsa — jim "kam sinf" emas
  if (classes && classes.length !== classIds.length) {
    throw new NotFoundError("Tanlangan sinflardan biri topilmadi. Ro'yxatni yangilab, qayta tanlang");
  }

  const students = users.map((user) => ({
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    classes: user.classes.map((uc) => uc.class),
    systems: user.systemMarks.map((mark) => mark.system),
  }));

  const rows = buildExportRows(students, { classIds });

  return {
    rows,
    totals: countPresence(rows),
    classSummary: buildClassSummary(rows, students, { classes }),
    classes: classes ? sortClasses(classes) : null,
  };
}

module.exports = {
  SYSTEMS,
  SYSTEM_LABELS,
  PRESENCE,
  NO_CLASS,
  NO_CLASS_LABEL,
  MARK_BATCH_MAX,
  EXPORT_LISTS,
  EXPORT_SCOPES,
  parseListQuery,
  parseExportQuery,
  buildListWhere,
  buildExportRows,
  buildClassSummary,
  countPresence,
  listStudentSystems,
  setStudentSystemMarks,
  loadExportData,
};
