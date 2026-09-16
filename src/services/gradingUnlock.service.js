/**
 * O'TGAN KUNLAR DARSIGA BAHO QO'YISH OYNASI (`GradingUnlock`).
 *
 * Baho odatda faqat o'sha kuni va maktabda turib qo'yiladi
 * (`grade.controller.js`, `gradingPresence.service.js`). Platforma sababli
 * baho qo'yilmay qolgan kunlar uchun boshliq (`grades.unlock`) KUNLAR
 * ORALIG'INI ochadi ("1-sentabr — 18-sentabr"), keyin KIMGA: hammaga yoki
 * tanlangan o'qituvchilarga, va QANCHA MUDDATGA.
 *
 * ⚠️ OCHILGAN KUNDA BAHO BOR DARS — O'TILGAN, davomatdan qat'i nazar
 * (biznes qarori): oraliqni ochish "shu kunlar bahosiga ishonaman" degani,
 * o'sha kunlar davomati ham platforma sababli noto'g'ri bo'lishi mumkin.
 * Qaror `helpers/lessonHours.js` → `judgeLesson` da, oynalar esa soat
 * hisobiga `lessonHours.service.js` → `loadLessonFacts` orqali kiradi.
 *
 * ⚠️ YOPISH FAQAT BAHO QO'YISHNI TO'XTATADI. Yopilgan yoki muddati o'tgan
 * oyna oylikda hisobga olinaveradi: o'sha paytda qo'yilgan baholar o'z
 * kuchida qoladi, ular "yopildi" deb soatdan chiqib ketmasligi kerak.
 *
 * ⚠️ OCHILGAN KUNGA "MAKTABDA BO'LISH" SHARTI QO'YILMAYDI — qoldirilgan
 * baholar istalgan joydan to'ldiriladi.
 *
 * ⚠️ MUHRLANGAN OYLIK O'ZGARMAYDI: dars soati bo'yicha oylik oy yopilgach
 * muhrlanadi. Undan keyin qo'yilgan baho soatni jonli hisobga qaytaradi,
 * lekin muhrni emas — ochishda bu ogohlantiriladi (`sealedCount`).
 */

const prisma = require("../config/prisma");
const { ROLES, DAYS_UZ } = require("../utils/constants");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const {
  currentDayDate,
  parseDayDate,
  monthKeyOfDate,
  nextMonth,
  formatMonthKey,
} = require("../helpers/month.helpers");
const { formatDateUz, formatDateTimeUz, formatDateRangeUz } = require("../helpers/date.helpers");
const { dayKey } = require("../helpers/lessonHours");
const { getTeachersHours } = require("./lessonHours.service");
const { getGradingPresence } = require("./gradingPresence.service");
const payrollAudit = require("./payrollAudit.service");

const DAY_MS = 24 * 3600 * 1000;
const TASHKENT_OFFSET_MS = 5 * 3600 * 1000;
const REASON_MAX = 200;
/** Bitta oyna necha kalendar kunini qamray oladi — tasodifan "butun yil" ochilmasligi uchun. */
const MAX_RANGE_DAYS = 92;
/** Muddat tanlovlari (kun). `monthEnd` va `custom` — alohida. */
const PRESET_DAYS = { "3d": 3, "1w": 7 };
const SCOPES = ["all", "selected"];
const STATUSES = ["active", "expired", "revoked"];

const fullName = (person) =>
  person ? `${person.firstName ?? ""} ${person.lastName ?? ""}`.trim() || "Noma'lum" : "Noma'lum";

/** Toshkent kuni (UTC yarim tuni) oxiridagi instant — `23:59:59.999 +05:00`. */
const endOfTashkentDay = (dayDate) => new Date(dayDate.getTime() + DAY_MS - TASHKENT_OFFSET_MS - 1);

const statusOf = (row, now = new Date()) =>
  row.revokedAt ? "revoked" : row.expiresAt <= now ? "expired" : "active";

/** "1-sentabr, 2026 — 18-sentabr, 2026" yoki bitta kun bo'lsa "12-sentabr, 2026". */
const rangeLabelOf = (from, to) =>
  from.getTime() === to.getTime()
    ? formatDateUz(from, { utc: true })
    : formatDateRangeUz(from, to, { utc: true });

/** Prisma sharti: shu o'qituvchini qamragan oynalar. */
const teacherWhere = (teacherId) => ({
  OR: [{ scope: "all" }, { teacherIds: { has: teacherId } }],
});

/** Holat filtri → Prisma sharti. */
const statusWhere = (status, now = new Date()) => {
  if (status === "active") return { revokedAt: null, expiresAt: { gt: now } };
  if (status === "expired") return { revokedAt: null, expiresAt: { lte: now } };
  if (status === "revoked") return { revokedAt: { not: null } };
  return {};
};

/** Nomlar xaritasi (soft ref'lar qo'lda yuklanadi). */
const loadNames = async (ids) => {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, firstName: true, lastName: true },
  });
  return new Map(users.map((u) => [u.id, fullName(u)]));
};

const serialize = (row, names = new Map(), extra = {}) => ({
  id: row.id,
  scope: row.scope,
  teacherIds: row.scope === "all" ? [] : row.teacherIds,
  teachers:
    row.scope === "all"
      ? []
      : row.teacherIds.map((id) => ({ id, name: names.get(id) ?? "Noma'lum" })),
  // ⚠️ `dateFrom`/`dateTo` — `@db.Date`: kalit ham, matn ham `getUTC*` bilan (`dates.md` §4)
  dateFrom: dayKey(row.dateFrom),
  dateTo: dayKey(row.dateTo),
  rangeLabel: rangeLabelOf(row.dateFrom, row.dateTo),
  dayCount: Math.round((row.dateTo.getTime() - row.dateFrom.getTime()) / DAY_MS) + 1,
  reason: row.reason,
  expiresAt: row.expiresAt,
  expiresAtLabel: formatDateTimeUz(row.expiresAt),
  status: statusOf(row),
  grantedByName: names.get(row.grantedBy) ?? "Noma'lum",
  createdAtLabel: formatDateTimeUz(row.createdAt),
  revokedAtLabel: row.revokedAt ? formatDateTimeUz(row.revokedAt) : null,
  revokedByName: row.revokedBy ? names.get(row.revokedBy) ?? "Noma'lum" : null,
  ...extra,
});

/**
 * Muddat → tugash instanti. Admin tanlaydi: 3 kun, 1 hafta, oy oxiri yoki
 * qo'lda sana. Hammasi Toshkent kunining OXIRIGACHA (inklyuziv).
 *
 * @param {object} data - { preset: "3d"|"1w"|"monthEnd"|"custom", until: "YYYY-MM-DD" }
 */
const parseExpiry = ({ preset, until } = {}) => {
  const today = currentDayDate();
  let lastDay;

  if (PRESET_DAYS[preset]) {
    lastDay = new Date(today.getTime() + PRESET_DAYS[preset] * DAY_MS);
  } else if (preset === "monthEnd") {
    lastDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  } else if (preset === "custom") {
    lastDay = parseDayDate(until, "Qaysi kungacha");
    if (lastDay < today) throw new BadRequestError("Tugash sanasi o'tib ketgan");
  } else {
    throw new BadRequestError("Muddatni tanlang");
  }

  return endOfTashkentDay(lastDay);
};

/**
 * Ochiladigan kunlar. Faqat O'TGAN kunlar: bugungi darsga baho odatdagidek
 * (maktabda turib) qo'yiladi, kelajakdagi darsga esa umuman qo'yilmaydi.
 *
 * @param {object} data - { dateFrom, dateTo } ("YYYY-MM-DD")
 * @returns {{from: Date, to: Date}}
 */
const parseRange = ({ dateFrom, dateTo } = {}) => {
  const from = parseDayDate(dateFrom, "Qaysi kundan");
  const to = dateTo ? parseDayDate(dateTo, "Qaysi kungacha") : from;

  if (to < from) throw new BadRequestError("Oraliq noto'g'ri: oxirgi kun boshlanishidan oldin");
  if (to >= currentDayDate()) {
    throw new BadRequestError(
      "Faqat o'tgan kunlarni ochish mumkin — bugungi darsga baho odatdagidek, maktabda turib qo'yiladi",
    );
  }

  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new BadRequestError(`Oraliq ${MAX_RANGE_DAYS} kundan oshmasin (tanlangani ${days} kun)`);
  }

  return { from, to };
};

/**
 * Kimga: hammaga yoki tanlanganlarga. Tanlangan har bir odam tekshiriladi —
 * o'quvchi va arxivlangan xodimga oyna ochilmaydi.
 *
 * @param {object} data - { scope, teacherIds }
 * @returns {Promise<{scope: string, teacherIds: string[], names: Map}>}
 */
const parseTargets = async ({ scope, teacherIds } = {}) => {
  if (!SCOPES.includes(scope)) throw new BadRequestError("Kimga ochilishini tanlang");
  if (scope === "all") return { scope, teacherIds: [], names: new Map() };

  const ids = [...new Set((Array.isArray(teacherIds) ? teacherIds : []).map(String))];
  if (ids.length === 0) throw new BadRequestError("Kamida bitta o'qituvchini tanlang");
  if (ids.some((id) => !/^[a-f\d]{24}$/i.test(id))) {
    throw new BadRequestError("O'qituvchi identifikatori noto'g'ri");
  }

  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true, role: true, isArchived: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  for (const id of ids) {
    const user = byId.get(id);
    if (!user || user.role === ROLES.STUDENT) throw new NotFoundError("O'qituvchi topilmadi");
    if (user.isArchived) throw new BadRequestError(`${fullName(user)} arxivlangan`);
  }

  return { scope, teacherIds: ids, names: new Map(users.map((u) => [u.id, fullName(u)])) };
};

/**
 * Oraliq oylarida allaqachon SHAKLLANGAN oylik soni — yangi baholar ularni
 * o'zgartirmaydi, boshliq buni ochishdan oldin bilishi kerak.
 */
const countSealedEntries = async ({ from, to }, { scope, teacherIds }) => {
  const months = [];
  for (let m = monthKeyOfDate(from); m <= monthKeyOfDate(to); m = nextMonth(m)) months.push(m);

  const count = await prisma.payrollEntry.count({
    where: {
      month: { in: months },
      status: { not: "cancelled" },
      ...(scope === "selected" ? { staffId: { in: teacherIds } } : {}),
    },
  });

  return { count, months };
};

/**
 * OYNA OCHISH.
 *
 * @param {object} data - { dateFrom, dateTo, scope, teacherIds, preset, until, reason }
 * @param {string} actorId
 */
const createUnlock = async (data = {}, actorId) => {
  const range = parseRange(data);
  const targets = await parseTargets(data);
  const expiresAt = parseExpiry(data);
  const reason = typeof data.reason === "string" ? data.reason.trim().slice(0, REASON_MAX) : "";

  const targetText =
    targets.scope === "all"
      ? "hamma o'qituvchiga"
      : targets.teacherIds.length === 1
        ? targets.names.get(targets.teacherIds[0])
        : `${targets.teacherIds.length} ta o'qituvchiga`;

  const row = await prisma.$transaction(async (tx) => {
    const saved = await tx.gradingUnlock.create({
      data: {
        dateFrom: range.from,
        dateTo: range.to,
        scope: targets.scope,
        teacherIds: targets.teacherIds,
        reason,
        expiresAt,
        grantedBy: actorId,
      },
    });

    // Oylikka ta'sir qiladi — oylik o'zgarishlari tarixida qoladi
    await payrollAudit.record(
      {
        actorId,
        action: "grading.unlock",
        targetType: "gradingUnlock",
        targetId: saved.id,
        summary:
          `${rangeLabelOf(range.from, range.to)} darslariga baho qo'yish ochildi — ${targetText}` +
          ` (${formatDateTimeUz(expiresAt)} gacha)` +
          (reason ? `: ${reason}` : ""),
        newValue: {
          dateFrom: dayKey(range.from),
          dateTo: dayKey(range.to),
          scope: targets.scope,
          teacherIds: targets.teacherIds,
          expiresAt,
        },
      },
      tx,
    );

    return saved;
  });

  const sealed = await countSealedEntries(range, targets);
  const names = await loadNames([actorId]);
  for (const [id, name] of targets.names) names.set(id, name);

  return serialize(row, names, {
    sealedCount: sealed.count,
    sealedMonthsLabel: sealed.months.map(formatMonthKey).join(", "),
  });
};

/** OYNANI YOPISH — muddatidan oldin. Qo'yilgan baholar o'z kuchida qoladi. */
const revokeUnlock = async (id, actorId) => {
  const row = await prisma.gradingUnlock.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Oyna topilmadi");
  if (statusOf(row) !== "active") throw new BadRequestError("Oyna allaqachon yopilgan");

  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.gradingUnlock.update({
      where: { id },
      data: { revokedAt: new Date(), revokedBy: actorId },
    });
    await payrollAudit.record(
      {
        actorId,
        action: "grading.lock",
        targetType: "gradingUnlock",
        targetId: id,
        summary: `${rangeLabelOf(row.dateFrom, row.dateTo)} darslariga baho qo'yish yopildi`,
        oldValue: { expiresAt: row.expiresAt },
      },
      tx,
    );
    return res;
  });

  const names = await loadNames([...updated.teacherIds, updated.grantedBy, actorId]);
  return serialize(updated, names);
};

/**
 * OYNALAR RO'YXATI — boshliq ekrani. Yangi ochilgani tepada.
 *
 * @param {object} query - { status, page, limit }
 */
const listUnlocks = async ({ status, page = 1, limit = 20 } = {}) => {
  const now = new Date();
  const where = STATUSES.includes(status) ? statusWhere(status, now) : {};
  const take = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const current = Math.max(Number(page) || 1, 1);

  const [rows, total, activeCount] = await Promise.all([
    prisma.gradingUnlock.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (current - 1) * take,
      take,
    }),
    prisma.gradingUnlock.count({ where }),
    prisma.gradingUnlock.count({ where: statusWhere("active", now) }),
  ]);

  const names = await loadNames(rows.flatMap((r) => [...r.teacherIds, r.grantedBy, r.revokedBy]));

  return {
    data: rows.map((row) => serialize(row, names)),
    pagination: {
      page: current,
      limit: take,
      total,
      totalPages: Math.ceil(total / take),
    },
    totals: { active: activeCount },
  };
};

/**
 * O'qituvchi + kun uchun OCHIQ oyna (yoki `null`) — `grade.controller.js`.
 * Bir nechta oyna qamrasa, eng kech yopiladigani qaytadi.
 *
 * @param {string} teacherId
 * @param {Date} date - kun (UTC yarim tuni)
 */
const findActiveUnlock = (teacherId, date) =>
  prisma.gradingUnlock.findFirst({
    where: {
      ...statusWhere("active"),
      dateFrom: { lte: date },
      dateTo: { gte: date },
      ...teacherWhere(teacherId),
    },
    orderBy: { expiresAt: "desc" },
  });

/**
 * O'qituvchini qamragan, oy bilan kesishgan oynalar (holati bilan) —
 * vedomostdagi o'qituvchi oynasi uchun.
 *
 * @param {string} teacherId
 * @param {number} month - YYYYMM
 */
const listForTeacherMonth = async (teacherId, month) => {
  const from = new Date(Date.UTC(Math.trunc(month / 100), (month % 100) - 1, 1));
  const to = new Date(Date.UTC(Math.trunc(month / 100), month % 100, 0));

  const rows = await prisma.gradingUnlock.findMany({
    where: { dateFrom: { lte: to }, dateTo: { gte: from }, ...teacherWhere(teacherId) },
    orderBy: { createdAt: "desc" },
  });

  const names = await loadNames(rows.flatMap((r) => [r.grantedBy, r.revokedBy]));
  return rows.map((row) => serialize(row, names));
};

/**
 * O'QITUVCHINING BAHO QO'YISH HUQUQI — baho qo'yish sahifasi uchun.
 *
 *   · `presence` — bugungi darsga baho qo'ya oladimi ("Siz maktabda emassiz");
 *   · `unlocks`  — o'ziga ochiq oynalar;
 *   · `days`     — ochiq kunlardagi BAHO QO'YILMAGAN darslari (sinf, fan,
 *                  tartib). Manba — oylik hisobining O'ZI (`getTeachersHours`
 *                  → `missedLessons`): ekrandagi ro'yxat va oylik bitta
 *                  qoidadan o'qiydi, baho qo'yilgan dars ro'yxatdan chiqadi.
 *
 * @param {{id: string, role: string}} actor
 */
const getMyAccess = async (actor) => {
  const now = new Date();
  const today = currentDayDate();

  const [presence, rows] = await Promise.all([
    getGradingPresence(actor),
    prisma.gradingUnlock.findMany({
      where: { ...statusWhere("active", now), ...teacherWhere(actor.id) },
      orderBy: { dateFrom: "asc" },
    }),
  ]);

  const names = await loadNames(rows.map((r) => r.grantedBy));
  const unlocks = rows.map((row) => serialize(row, names));
  if (rows.length === 0) return { presence, unlocks, days: [] };

  // Kun kaliti → shu kunni qamragan eng kech yopiladigan oyna muddati
  const openDays = new Map();
  for (const row of rows) {
    for (let t = row.dateFrom.getTime(); t <= row.dateTo.getTime() && t < today.getTime(); t += DAY_MS) {
      const key = dayKey(new Date(t));
      const prev = openDays.get(key);
      if (!prev || prev < row.expiresAt) openDays.set(key, row.expiresAt);
    }
  }
  if (openDays.size === 0) return { presence, unlocks, days: [] };

  const keys = [...openDays.keys()].sort();
  const firstMonth = monthKeyOfDate(parseDayDate(keys[0]));
  const lastMonth = monthKeyOfDate(parseDayDate(keys.at(-1)));

  const byDay = new Map();
  for (let month = firstMonth; month <= lastMonth; month = nextMonth(month)) {
    const hours = (await getTeachersHours([actor.id], month)).get(actor.id);
    for (const lesson of hours?.missedLessons ?? []) {
      const key = dayKey(lesson.date);
      if (!openDays.has(key)) continue;

      let day = byDay.get(key);
      if (!day) {
        day = {
          date: key,
          dateLabel: lesson.dateLabel,
          dayName: DAYS_UZ[lesson.date.getUTCDay()],
          expiresAtLabel: formatDateTimeUz(openDays.get(key)),
          lessons: [],
        };
        byDay.set(key, day);
      }

      day.lessons.push({
        classId: lesson.classId,
        className: lesson.className,
        subjectId: lesson.subjectId,
        subjectName: lesson.subjectName,
        lessonOrder: lesson.lessonOrder,
        reason: lesson.reason,
        reasonLabel: lesson.reasonLabel,
        substituted: lesson.substituted,
      });
    }
  }

  const days = [...byDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => ({
      ...day,
      lessons: day.lessons.sort(
        (a, b) => a.lessonOrder - b.lessonOrder || a.className.localeCompare(b.className),
      ),
    }));

  return { presence, unlocks, days };
};

/** Tanlov uchun o'qituvchilar — o'rinbosarlik ro'yxati bilan AYNI manba. */
const getTeacherOptions = () =>
  // Kechiktirilgan require: o'rinbosarlik servisi og'ir bog'liqliklarni tortadi
  require("./lessonSubstitution.service").getTeacherOptions();

module.exports = {
  MAX_RANGE_DAYS,
  PRESET_DAYS,
  parseExpiry,
  parseRange,
  createUnlock,
  revokeUnlock,
  listUnlocks,
  findActiveUnlock,
  listForTeacherMonth,
  getMyAccess,
  getTeacherOptions,
};
