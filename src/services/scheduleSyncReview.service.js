/**
 * GOOGLE SHEETS JADVALI — KO'RIB CHIQISH (faqat O'QIYDI, hech narsa yozmaydi).
 *
 * Bu yerda uch savolga javob beriladi:
 *   1. Sheet'dagi nomlar tizimdagi qaysi sinf/fan/o'qituvchi? (moslash)
 *   2. Qo'llansa amaldagi jadval qanday bo'ladi va nima o'zgaradi? (farq)
 *   3. Buni qo'llash xavfsizmi? (xatolar, ogohlantirishlar, tasdiqlar)
 *
 * Xuddi shu funksiyalar ekranga ko'rsatish uchun ham (`prisma` bilan),
 * qo'llash paytida qulf ICHIDA ham (`tx` bilan) chaqiriladi. Ikki xil
 * hisoblagich bo'lsa, odam ko'rgan narsa bilan yoziladigan narsa bir-biridan
 * ajralib qolardi; bu yerda esa odam ko'rgan holatning imzosi (`newHash`)
 * qulf ichida qayta hisoblanib, solishtiriladi.
 *
 * ⚠️ Barcha so'rovlar `client` orqali. Qulf ichida global `prisma` ishlatish
 * boshqa ulanishni oladi va hovuzni osiltirib qo'yishi mumkin
 * (`scheduleWriteGuard.service.js`).
 *
 * ── SHEET REJIMIDA JADVAL = SHEET ───────────
 *
 * Qo'llanganda BUTUN maktab jadvali sheet'dan quriladi. Sheet'da darsi yo'q,
 * lekin amaldagi jadvalda darsi bor sinflar (ustun o'chirilgan, bo'shatilgan
 * yoki sinfning o'zi o'chirilgan) OLIB TASHLANADI — alohida tasdiq bilan
 * (`classes_removed`), va qo'llashdan oldingi holat arxivda qoladi.
 * Aks holda bunday sinflar "muzlab" qolardi: sheet rejimida platformada
 * tahrir yopiq, sheet'da esa ular yo'q — o'qituvchisi band ko'rinib, har
 * keyingi qo'llashni to'qnashuv bilan to'sib qo'yardi.
 */

const { cleanLabel, normalizeKey, findCandidates } = require("../helpers/scheduleSheet.helpers");
const {
  DAY_ORDER,
  hashState,
  buildRowsFromLessons,
  conflictsInState,
  diffStates,
  countLessons,
} = require("../helpers/scheduleState.helpers");
const {
  dayLabel,
  teacherName,
  validateDayShape,
  loadLessonRefContext,
  checkLessonRef,
} = require("./schedule.service");
const {
  getNowInUzbekistan,
  getTashkentDateUtc,
  getDateRangeForDay,
  formatDateUz,
} = require("../helpers/date.helpers");
const { currentMonthKey } = require("../helpers/month.helpers");
const { DAYS_UZ, ROLES } = require("../utils/constants");
const { hasRole, hasPermission, PERMISSIONS } = require("../utils/permissions");

const SINGLETON = "singleton";
const MAPPING_KINDS = ["class", "subject", "teacher"];

// Sheet tekshiruvi shu muddatdan eski bo'lsa qo'llanmaydi: sheet o'shandan
// beri o'zgargan bo'lishi mumkin (platforma rejimida avtomatik tekshiruv yo'q).
const CHECK_FRESH_MS = 15 * 60 * 1000;

const SNAPSHOT_VERSION = 1;
const ID_RE = /^[0-9a-f]{24}$/;

// Tasdiq talab qiladigan ogohlantirishlar. Matn foydalanuvchiga ko'rinadi.
const ACKS = {
  classes_removed: "Ba'zi sinflarning darslari olib tashlanadi",
  today_impact: "Bugungi darslar o'zgaradi",
  payroll_impact: "Soatbay oylikka ta'sir qiladi",
  substitutions: "Amaldagi o'rinbosarliklarga ta'sir qiladi",
  inactive_teachers: "Nofaol o'qituvchilarga dars qo'yilgan",
  archived_teachers: "Arxivlangan o'qituvchilarga dars qaytadi",
  dropped_lessons: "Ba'zi darslar tiklanmaydi",
  restore_conflicts: "Tiklanadigan jadvalda to'qnashuvlar bor",
};

const SNAPSHOT_KIND_LABELS = {
  platform_archive: "Platforma jadvali (arxiv)",
  sheet_archive: "Sheet jadvali (arxiv)",
  before_apply: "Sheet o'zgarishidan oldingi holat",
  before_restore: "Tiklashdan oldingi holat",
};

// ─────────────────────────────────────────────
// Yordamchilar
// ─────────────────────────────────────────────

/**
 * Foydalanuvchining shu bo'limdagi imkoniyatlari. Owner — hammasi.
 * @param {object|null} user
 * @returns {{view: boolean, review: boolean, source: boolean}}
 */
function userCan(user) {
  if (!user) return { view: false, review: false, source: false };
  const owner = hasRole(user, ROLES.OWNER);
  const perms = Array.isArray(user.permissions) ? user.permissions : [];
  const review = owner || hasPermission(perms, PERMISSIONS.SCHEDULESYNC_REVIEW);
  const source = owner || hasPermission(perms, PERMISSIONS.SCHEDULESYNC_SOURCE);
  const view = review || source || hasPermission(perms, PERMISSIONS.SCHEDULESYNC_VIEW);
  return { view, review, source };
}

const userRef = (user) => (user ? { id: user.id, name: teacherName(user) || "—" } : null);

/**
 * Tahrir va sozlama bir sheet'gami (havola + varaq)?
 */
function sameConfig(revision, settings) {
  return (
    Boolean(settings?.spreadsheetId) &&
    revision.spreadsheetId === settings.spreadsheetId &&
    normalizeKey(revision.sheetTab) === normalizeKey(settings.sheetTab)
  );
}

/**
 * Oxirgi tekshiruv yangi va muvaffaqiyatlimi, tahrir esa joriy sozlamadan
 * keyin olinganmi?
 */
function isCheckFresh(settings, revision = null, now = Date.now()) {
  if (!settings?.lastCheckOk || !settings.lastCheckedAt) return false;
  if (now - new Date(settings.lastCheckedAt).getTime() > CHECK_FRESH_MS) return false;
  if (revision && settings.configChangedAt && revision.createdAt < settings.configChangedAt) {
    return false;
  }
  return true;
}

/**
 * Amaldagi jadval — `schedules` ning HAR qatori (takroriylari ham).
 * @param {object} client
 * @returns {Promise<Array<{id, classId, day, createdBy, createdAt, lessons: Array}>>}
 */
async function loadActiveRows(client) {
  const rows = await client.schedule.findMany({
    include: {
      lessons: {
        select: {
          order: true,
          subjectId: true,
          teacherId: true,
          startTime: true,
          endTime: true,
          position: true,
        },
      },
    },
    orderBy: [{ classId: "asc" }, { day: "asc" }, { id: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    classId: row.classId,
    day: row.day,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    lessons: row.lessons
      .map((l) => ({
        order: l.order,
        subjectId: l.subjectId,
        teacherId: l.teacherId,
        startTime: l.startTime || null,
        endTime: l.endTime || null,
        position: l.position,
      }))
      .sort((a, b) => a.position - b.position || a.order - b.order),
  }));
}

/**
 * Ko'rib chiqish uchun umumiy ma'lumot — bitta to'plam so'rov.
 * @param {object} client - `prisma` yoki `tx`
 */
async function loadContext(client) {
  const [settings, scheduleSettings, classes, subjects, teachers, mappings, activeRows] =
    await Promise.all([
      client.scheduleSyncSettings.findUnique({ where: { id: SINGLETON } }),
      client.scheduleSettings.findUnique({ where: { id: SINGLETON }, select: { periods: true } }),
      client.class.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
      client.subject.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
      client.user.findMany({
        where: { OR: [{ role: ROLES.TEACHER }, { extraRoles: { has: ROLES.TEACHER } }] },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          username: true,
          role: true,
          extraRoles: true,
          isArchived: true,
          isActive: true,
          createdAt: true,
        },
      }),
      client.scheduleSheetMapping.findMany(),
      loadActiveRows(client),
    ]);

  const periods = Array.isArray(scheduleSettings?.periods) ? scheduleSettings.periods : [];

  return {
    settings: settings || { mode: "platform" },
    periods,
    classes,
    subjects,
    teachers,
    mappings,
    activeRows,
    classMap: new Map(classes.map((c) => [c.id, c])),
    subjectMap: new Map(subjects.map((s) => [s.id, s])),
    teacherMap: new Map(teachers.map((t) => [t.id, t])),
  };
}

/**
 * Qatorlardagi hamma o'qituvchi va fan nomlari (teacher roli bo'lmagan
 * yoki o'chirilgan foydalanuvchilar ham) — farqda "—" chiqmasligi uchun.
 */
async function loadNames(client, rowsList, ctx) {
  const subjectIds = new Set();
  const userIds = new Set();
  for (const rows of rowsList) {
    for (const row of rows || []) {
      for (const l of row.lessons || []) {
        if (!ctx.subjectMap.has(l.subjectId)) subjectIds.add(l.subjectId);
        if (!ctx.teacherMap.has(l.teacherId)) userIds.add(l.teacherId);
      }
    }
  }
  const [subjects, users] = await Promise.all([
    subjectIds.size
      ? client.subject.findMany({ where: { id: { in: [...subjectIds] } }, select: { id: true, name: true } })
      : [],
    userIds.size
      ? client.user.findMany({
          where: { id: { in: [...userIds] } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [],
  ]);
  const subjectName = new Map(ctx.subjects.map((s) => [s.id, s.name]));
  for (const s of subjects) subjectName.set(s.id, s.name);
  const userName = new Map(ctx.teachers.map((t) => [t.id, teacherName(t)]));
  for (const u of users) userName.set(u.id, teacherName(u));
  const className = new Map(ctx.classes.map((c) => [c.id, c.name]));
  return {
    subject: (id) => subjectName.get(id) || "(o'chirilgan fan)",
    teacher: (id) => userName.get(id) || "(o'chirilgan foydalanuvchi)",
    class: (id) => className.get(id) || "(o'chirilgan sinf)",
  };
}

// ─────────────────────────────────────────────
// 1. Moslash
// ─────────────────────────────────────────────

/**
 * Sheet'dagi har bir noyob nom uchun qaror.
 *
 * Holatlar: manual (odam moslagan) · auto (aniq va yagona) · suggested (bitta
 * o'xshash nomzod — tasdiq kerak) · ambiguous (bir nechta nomzod) ·
 * unresolved (nomzod yo'q) · missing_target (moslangan yozuv o'chirilgan) ·
 * archived_target (moslangan o'qituvchi arxivlangan).
 * Faqat manual va auto ishlatiladi; qolganlari — xato.
 *
 * @returns {{resolution: object, lookup: object, errors: Array, warnings: Array}}
 */
function resolveLabels(data, ctx) {
  const manual = new Map(ctx.mappings.map((m) => [`${m.kind}|${m.key}`, m]));
  const eligibleTeachers = ctx.teachers.filter((t) => !t.isArchived);

  const targetsOf = {
    class: ctx.classes,
    subject: ctx.subjects,
    teacher: eligibleTeachers,
  };
  const nameOf = {
    class: (id) => ctx.classMap.get(id)?.name || null,
    subject: (id) => ctx.subjectMap.get(id)?.name || null,
    teacher: (id) => (ctx.teacherMap.get(id) ? teacherName(ctx.teacherMap.get(id)) : null),
  };

  // Noyob nomlar: kalit bo'yicha, birinchi uchragan yozilishi ko'rsatiladi.
  // Sinflar — HAMMA sarlavhalardan (darssiz ustun ham ko'rinsin).
  const labels = { class: new Map(), subject: new Map(), teacher: new Map() };
  const addLabel = (kind, label, cell) => {
    const key = normalizeKey(label);
    if (!key) return;
    if (!labels[kind].has(key)) labels[kind].set(key, { label: cleanLabel(label), count: 0, cells: [] });
    const entry = labels[kind].get(key);
    if (cell) {
      entry.count += 1;
      if (entry.cells.length < 3) entry.cells.push(cell);
    }
  };
  for (const label of data.classes || []) addLabel("class", label, null);
  for (const lesson of data.lessons || []) {
    addLabel("class", lesson.classLabel, lesson.cell);
    addLabel("subject", lesson.subjectLabel, lesson.cell);
    addLabel("teacher", lesson.teacherLabel, lesson.cell);
  }

  const resolution = { class: [], subject: [], teacher: [] };
  const lookup = { class: new Map(), subject: new Map(), teacher: new Map() };
  const errors = [];
  const warnings = [];

  for (const kind of MAPPING_KINDS) {
    for (const [key, entry] of labels[kind]) {
      const mapping = manual.get(`${kind}|${key}`);
      const { auto, candidates } = findCandidates(kind, entry.label, targetsOf[kind]);
      // O'qituvchida login ham: bir xil ismli ikki o'qituvchi ekranda ajralsin
      const candidateOptions = candidates.map((id) =>
        kind === "teacher"
          ? { id, name: nameOf.teacher(id), username: ctx.teacherMap.get(id)?.username || null }
          : { id, name: nameOf[kind](id) },
      );

      let status;
      let targetId = null;
      if (mapping) {
        targetId = mapping.targetId;
        const exists =
          kind === "class"
            ? ctx.classMap.has(targetId)
            : kind === "subject"
              ? ctx.subjectMap.has(targetId)
              : ctx.teacherMap.has(targetId);
        if (!exists) status = "missing_target";
        else if (kind === "teacher" && ctx.teacherMap.get(targetId).isArchived) status = "archived_target";
        else status = "manual";
      } else if (auto) {
        status = "auto";
        targetId = auto;
      } else if (candidates.length === 1) {
        status = "suggested";
        targetId = candidates[0];
      } else if (candidates.length > 1) {
        status = "ambiguous";
      } else {
        status = "unresolved";
      }

      const res = {
        kind,
        label: entry.label,
        key,
        count: entry.count,
        cells: entry.cells,
        status,
        targetId,
        targetName: targetId ? nameOf[kind](targetId) : null,
        candidates: candidateOptions,
      };
      resolution[kind].push(res);

      const usable = status === "manual" || status === "auto";
      lookup[kind].set(key, usable ? targetId : null);

      // Darssiz sinf ustuni — moslanmagan bo'lsa ham hech narsa yozilmaydi.
      if (!usable && !(kind === "class" && entry.count === 0)) {
        errors.push({ code: `mapping_${status}`, kind, key, message: mappingMessage(kind, res) });
      }

      // Qo'lda moslangan o'qituvchining keyin qo'shilgan adashi
      if (status === "manual" && kind === "teacher") {
        const newer = candidates.filter((id) => {
          if (id === targetId) return false;
          const t = ctx.teacherMap.get(id);
          return t && mapping.updatedAt && t.createdAt > mapping.updatedAt;
        });
        if (newer.length) {
          warnings.push({
            code: "mapping_namesake",
            kind,
            key,
            message: `"${entry.label}" qo'lda ${res.targetName} ga moslangan, lekin keyin o'xshash o'qituvchi qo'shilgan (${newer.map((id) => nameOf.teacher(id)).join(", ")}). Moslashni tekshiring`,
          });
        }
      }
    }
    resolution[kind].sort((a, b) => a.label.localeCompare(b.label, "uz"));
  }

  // Ikki sheet sinfi bitta tizim sinfiga — ikki sinf darslari bitta sinfga
  // qo'shilib ketardi.
  const byTarget = new Map();
  for (const res of resolution.class) {
    if (!lookup.class.get(res.key)) continue;
    if (!byTarget.has(res.targetId)) byTarget.set(res.targetId, []);
    byTarget.get(res.targetId).push(res.label);
  }
  for (const [targetId, sheetLabels] of byTarget) {
    if (sheetLabels.length > 1) {
      errors.push({
        code: "class_collision",
        kind: "class",
        message: `Sheet'dagi ${sheetLabels.map((l) => `"${l}"`).join(" va ")} sinflari tizimdagi bitta sinfga (${nameOf.class(targetId)}) moslangan. Har sheet sinfi alohida sinf bo'lishi kerak`,
      });
    }
  }

  return { resolution, lookup, errors, warnings };
}

const KIND_LABELS = { class: "Sinf", subject: "Fan", teacher: "O'qituvchi" };

function mappingMessage(kind, res) {
  const who = `${KIND_LABELS[kind]} "${res.label}"`;
  switch (res.status) {
    case "suggested":
      return `${who}: taklif — ${res.targetName}. "Moslash" bo'limida tasdiqlang`;
    case "ambiguous":
      return `${who}: bir nechta mos yozuv bor (${res.candidates.map((c) => c.name).join(", ")}). Qaysi biri ekanini tanlang`;
    case "missing_target":
      return `${who}: moslangan yozuv tizimdan o'chirilgan. Qaytadan moslang`;
    case "archived_target":
      return `${who}: moslangan o'qituvchi arxivlangan. Boshqa o'qituvchini tanlang yoki sheet'ni to'g'rilang`;
    default:
      return `${who}: tizimda topilmadi. "Moslash" bo'limida tanlang yoki avval tizimga qo'shing`;
  }
}

// ─────────────────────────────────────────────
// 2. Vaqt → dars tartib raqami
// ─────────────────────────────────────────────

/**
 * Sheet'dagi har vaqt oralig'i → "Dars vaqtlari" sozlamasidagi tartib raqami
 * (boshlanish VA tugash vaqti aynan teng bo'lishi shart).
 * @returns {{slots: Array, orderOf: Map<string, number>, errors: Array}}
 */
function mapSlotsToPeriods(dataSlots, periods) {
  const errors = [];
  const orderOf = new Map();

  if (!periods.length) {
    errors.push({
      code: "periods_empty",
      message: `"Dars vaqtlari" sozlamasi bo'sh. Dars tartib raqami vaqtdan olinadi — avval "Dars jadvali sozlamalari" sahifasida qo'ng'iroq vaqtlarini kiriting`,
    });
  }

  const slots = (dataSlots || []).map((slot) => {
    const matches = periods.filter(
      (p) => p.startTime === slot.startTime && p.endTime === slot.endTime,
    );
    let status = "ok";
    let order = null;
    if (matches.length === 1) {
      order = Number(matches[0].order);
      orderOf.set(`${slot.startTime}-${slot.endTime}`, order);
    } else if (matches.length === 0) {
      status = "no_period";
      if (periods.length) {
        errors.push({
          code: "slot_no_period",
          message: `Sheet'dagi ${slot.startTime}-${slot.endTime} vaqti "Dars vaqtlari" sozlamasida yo'q. Sozlamaga qo'shing yoki sheet'dagi vaqtni to'g'rilang`,
        });
      }
    } else {
      status = "ambiguous";
      errors.push({
        code: "slot_ambiguous",
        message: `${slot.startTime}-${slot.endTime} vaqti "Dars vaqtlari" sozlamasida bir necha marta bor (${matches.map((m) => `${m.order}-dars`).join(", ")})`,
      });
    }
    return { startTime: slot.startTime, endTime: slot.endTime, order, status };
  });

  return { slots, orderOf, errors };
}

// ─────────────────────────────────────────────
// 3. Ta'sirlar: bugun, oylik, o'rinbosarlik
// ─────────────────────────────────────────────

const cellKey = (classId, day, order) => `${classId}|${day}|${Number(order)}`;

function cellsOf(rows) {
  const map = new Map();
  for (const row of rows) {
    for (const l of row.lessons || []) {
      const key = cellKey(row.classId, row.day, l.order);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(l);
    }
  }
  return map;
}

function weeklyCounts(rows) {
  const counts = new Map();
  for (const row of rows) {
    for (const l of row.lessons || []) counts.set(l.teacherId, (counts.get(l.teacherId) || 0) + 1);
  }
  return counts;
}

/**
 * O'qituvchi → hafta kuni → darslar soni. Oylik soat hafta kunlari bo'yicha
 * oyga yoyiladi va oyda dushanba va seshanbalar soni har xil: dars bir
 * kundan boshqasiga ko'chsa, haftalik jami o'zgarmasa ham oylik soat o'zgaradi.
 */
function dayDistribution(rows) {
  const out = new Map();
  for (const row of rows) {
    for (const l of row.lessons || []) {
      const key = `${l.teacherId}|${row.day}`;
      out.set(key, (out.get(key) || 0) + 1);
    }
  }
  return out;
}

/**
 * Bugungi kun: maktab kunimi (dushanba–shanba, bayram/ta'til emas)?
 * @param {{isVacationMonth: boolean, holidaySet: Set<string>}|null} calendar
 */
function todayInfo(calendar) {
  const today = getTashkentDateUtc(0);
  const day = DAYS_UZ[today.getUTCDay()];
  const key = today.toISOString().slice(0, 10);
  const schoolDay =
    DAY_ORDER.includes(day) &&
    Boolean(calendar) &&
    !calendar.isVacationMonth &&
    !calendar.holidaySet.has(key);
  return { today, day, schoolDay };
}

/**
 * Qo'llash yoki tiklash amaldagi jadvaldan tashqarida nimaga ta'sir qiladi.
 */
async function computeImpacts(client, { activeRows, newRows, names, calendar }) {
  const acks = [];
  const errors = [];
  const warnings = [];

  const activeCells = cellsOf(activeRows);
  const newCells = cellsOf(newRows);

  // ── Bugun ──
  let todayImpact = null;
  const { today, day, schoolDay } = todayInfo(calendar);
  if (schoolDay) {
    const changed = diffStates(activeRows, newRows).changes.filter((c) => c.day === day);

    // Bugun qo'yilgan baholar: eski jadvalda mos darsi bor edi, yangisida yo'q
    const { startDate, endDate } = getDateRangeForDay(getNowInUzbekistan());
    const grades = await client.grade.findMany({
      where: { date: { gte: startDate, lte: endDate } },
      select: { classId: true, subjectId: true, lessonOrder: true },
    });
    const matches = (cells, g) =>
      (cells.get(cellKey(g.classId, day, g.lessonOrder)) || []).some((l) => l.subjectId === g.subjectId);
    const gradesAffected = grades.filter((g) => matches(activeCells, g) && !matches(newCells, g)).length;

    if (changed.length || gradesAffected) {
      const teacherIds = new Set();
      for (const c of changed) {
        if (c.before) teacherIds.add(c.before.teacherId);
        if (c.after) teacherIds.add(c.after.teacherId);
      }
      todayImpact = {
        day,
        dayLabel: dayLabel(day),
        changedCells: changed.length,
        classes: [...new Set(changed.map((c) => names.class(c.classId)))],
        teachers: [...teacherIds].map((id) => names.teacher(id)),
        gradesAffected,
      };
      acks.push({
        code: "today_impact",
        title: ACKS.today_impact,
        message: `Bugun (${dayLabel(day)}) ${changed.length} ta dars o'zgaradi${gradesAffected ? `, bugun qo'yilgan ${gradesAffected} ta baho mos darsini yo'qotadi` : ""}. Jurnal huquqi, "baho qo'yilmadi" jarimasi va davomat vaqti darhol yangi jadval bo'yicha hisoblanadi. Iloji bo'lsa darslar tugagach yoki yakshanba qo'llang`,
      });
    }
  }

  // ── Oylik (soatbay) ──
  const before = weeklyCounts(activeRows);
  const after = weeklyCounts(newRows);
  const beforeDays = dayDistribution(activeRows);
  const afterDays = dayDistribution(newRows);
  const changedTeacherIds = [
    ...new Set(
      [...new Set([...beforeDays.keys(), ...afterDays.keys()])]
        .filter((key) => (beforeDays.get(key) || 0) !== (afterDays.get(key) || 0))
        .map((key) => key.split("|")[0]),
    ),
  ];
  let payrollImpact = [];
  if (changedTeacherIds.length) {
    const month = currentMonthKey();
    const [users, entries] = await Promise.all([
      client.user.findMany({
        where: { id: { in: changedTeacherIds } },
        select: { id: true, salaryCategoryId: true },
      }),
      client.payrollEntry.findMany({
        where: { month, staffId: { in: changedTeacherIds }, status: { not: "cancelled" } },
        select: { staffId: true },
      }),
    ]);
    // Dars soati faqat o'qituvchi toifasi (salaryCategoryId) bor xodimga
    // pul bo'ladi (`payrollEngine.service.js`: teaching = toifa stavkasi × soat)
    const categoryIds = [...new Set(users.map((u) => u.salaryCategoryId).filter(Boolean))];
    const categories = categoryIds.length
      ? await client.salaryCategory.findMany({
          where: { id: { in: categoryIds } },
          select: { id: true, perHourRate: true },
        })
      : [];
    const rateOf = new Map(categories.map((c) => [c.id, Number(c.perHourRate.toString())]));
    const categoryOf = new Map(users.map((u) => [u.id, u.salaryCategoryId]));
    const sealed = new Set(entries.map((e) => e.staffId));

    payrollImpact = changedTeacherIds
      .map((id) => ({
        teacherId: id,
        teacherName: names.teacher(id),
        before: before.get(id) || 0,
        after: after.get(id) || 0,
        hourPaid: (rateOf.get(categoryOf.get(id)) || 0) > 0,
        payrollSealed: sealed.has(id),
      }))
      .sort((a, b) => Number(b.hourPaid) - Number(a.hourPaid) || a.teacherName.localeCompare(b.teacherName, "uz"));

    const hourPaid = payrollImpact.filter((p) => p.hourPaid);
    if (hourPaid.length) {
      const open = hourPaid.filter((p) => !p.payrollSealed).length;
      acks.push({
        code: "payroll_impact",
        title: ACKS.payroll_impact,
        message: `${hourPaid.length} ta soatbay o'qituvchining darslari soni yoki hafta kunlari o'zgaradi. Dars soati joriy jadvaldan butun oy uchun hisoblanadi: shu oy oyligi hali shakllantirilmagan ${open} ta o'qituvchida oyning o'tgan kunlari ham yangi jadval bo'yicha hisoblanadi`,
      });
    }
  }

  // ── O'rinbosarlik ──
  const todayUtc = today;
  const monthStart = new Date(Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), 1));
  const substitutions = await client.lessonSubstitution.findMany({
    where: { status: "active", toDate: { gte: monthStart } },
    include: { items: true },
  });
  const substitutionImpact = [];

  for (const sub of substitutions) {
    const ongoing = sub.toDate >= todayUtc;
    for (const item of sub.items) {
      const key = cellKey(item.classId, item.day, item.lessonOrder);
      const was = (activeCells.get(key) || [])[0] || null;
      const will = (newCells.get(key) || [])[0] || null;
      const base = {
        substitutionId: sub.id,
        originalTeacher: names.teacher(sub.originalTeacherId),
        substituteTeacher: names.teacher(sub.substituteTeacherId),
        fromDate: sub.fromDate,
        toDate: sub.toDate,
        className: names.class(item.classId),
        dayLabel: dayLabel(item.day),
        order: item.lessonOrder,
      };
      const period = `${formatDateUz(sub.fromDate, { utc: true })} — ${formatDateUz(sub.toDate, { utc: true })}`;
      const where = `${base.className}, ${base.dayLabel}, ${item.lessonOrder}-dars`;

      // O'rinbosar yangi jadvalda o'sha vaqtda BOSHQA sinfda o'z darsiga ega
      // bo'lib qoladi — faqat o'rinbosarlik yangi jadvalda ham AMAL QILSA
      // (katak hali ham asl o'qituvchiniki). Katak o'rinbosarning o'ziga
      // berilgan yoki asl o'qituvchidan olingan bo'lsa, o'rinbosarlik
      // ishlamay qoladi (`teacherAccess`, `lessonHours`) — ikki joyda
      // bo'lish yo'q; bu holatni pastdagi "stale" ogohlantirishi aytadi.
      const stillApplies = Boolean(will && will.teacherId === sub.originalTeacherId);
      const ownElsewhere = (rows) =>
        rows.some(
          (row) =>
            row.day === item.day &&
            row.classId !== item.classId &&
            row.lessons.some(
              (l) => l.teacherId === sub.substituteTeacherId && Number(l.order) === Number(item.lessonOrder),
            ),
        );
      if (ongoing && stillApplies && ownElsewhere(newRows) && !ownElsewhere(activeRows)) {
        const row = {
          ...base,
          kind: "substitute_busy",
          message: `${where}: o'rinbosar ${base.substituteTeacher} (${period}) yangi jadvalda o'sha vaqtda o'z darsiga ega — bir vaqtda ikki sinfda bo'lib qoladi. O'rinbosarlikni bekor qiling yoki jadvalni to'g'rilang`,
        };
        substitutionImpact.push(row);
        errors.push({ code: "substitute_busy", message: row.message });
      }

      // Oldin ham yaroqsiz bo'lgan (egasi boshqa) yozuv — bu o'zgarish sababi emas
      if (!was || was.teacherId !== sub.originalTeacherId) continue;

      let kind = null;
      if (!will || will.teacherId !== sub.originalTeacherId) {
        // "Ko'chdi" — o'sha sinfda shu o'qituvchi+fan YANGI katakda paydo
        // bo'lgan bo'lsagina. Avvaldan bor (o'zgarmagan) boshqa darsi
        // ko'chish emas: u holda dars shunchaki olib tashlangan.
        const moved = newRows.some(
          (row) =>
            row.classId === item.classId &&
            row.lessons.some(
              (l) =>
                l.teacherId === sub.originalTeacherId &&
                l.subjectId === was.subjectId &&
                !(row.day === item.day && Number(l.order) === Number(item.lessonOrder)) &&
                !(activeCells.get(cellKey(row.classId, row.day, l.order)) || []).some(
                  (a) => a.teacherId === sub.originalTeacherId && a.subjectId === was.subjectId,
                ),
            ),
        );
        kind = moved ? "owner_moved" : "stale";
      } else if (
        will.subjectId !== was.subjectId ||
        (will.startTime || null) !== (was.startTime || null) ||
        (will.endTime || null) !== (was.endTime || null)
      ) {
        kind = "retargeted";
      }
      if (!kind) continue;

      const text = {
        stale: `katakda endi ${base.originalTeacher} darsi yo'q — o'rinbosarlik ishlamay qoladi (jurnal huquqi va soat hisoblanmaydi)`,
        owner_moved: `${base.originalTeacher} darsi boshqa vaqtga ko'chdi — yangi vaqtdagi dars o'rinbosarsiz qoladi`,
        retargeted: `katakdagi dars (fan yoki vaqt) o'zgaradi — o'rinbosarlik boshqa darsni qoplab qoladi`,
      }[kind];
      substitutionImpact.push({
        ...base,
        kind,
        message: `${where} (${base.originalTeacher} o'rniga ${base.substituteTeacher}, ${period}): ${text}`,
      });
    }
  }
  if (substitutionImpact.some((s) => s.kind !== "substitute_busy")) {
    acks.push({
      code: "substitutions",
      title: ACKS.substitutions,
      message: `${substitutionImpact.filter((s) => s.kind !== "substitute_busy").length} ta o'rinbosarlik katagiga ta'sir qiladi. Kerak bo'lsa ularni "O'rinbosarlik" bo'limida bekor qilib, qaytadan yarating`,
    });
  }

  return { todayImpact, payrollImpact, substitutionImpact, acks, errors, warnings };
}

// ─────────────────────────────────────────────
// 4. Farqni ekranga tayyorlash
// ─────────────────────────────────────────────

function decorateDiff(activeRows, newRows, names, sheetLabelOf = new Map()) {
  const { changes } = diffStates(activeRows, newRows);
  const cell = (l) =>
    l
      ? {
          subjectId: l.subjectId,
          subjectName: names.subject(l.subjectId),
          teacherId: l.teacherId,
          teacherName: names.teacher(l.teacherId),
          startTime: l.startTime || null,
          endTime: l.endTime || null,
        }
      : null;

  const totals = { added: 0, removed: 0, changed: 0, teacherOnly: 0, subjectOnly: 0, classesChanged: 0 };
  const byClass = new Map();
  for (const c of changes) {
    totals[c.type] += 1;
    if (c.field === "teacher") totals.teacherOnly += 1;
    if (c.field === "subject") totals.subjectOnly += 1;
    if (!byClass.has(c.classId)) {
      byClass.set(c.classId, {
        classId: c.classId,
        className: names.class(c.classId),
        sheetLabel: sheetLabelOf.get(c.classId) || null,
        changes: [],
      });
    }
    byClass.get(c.classId).changes.push({
      day: c.day,
      dayLabel: dayLabel(c.day),
      order: c.order,
      type: c.type,
      field: c.field,
      before: cell(c.before),
      after: cell(c.after),
    });
  }
  totals.classesChanged = byClass.size;
  const classes = [...byClass.values()].sort((a, b) => a.className.localeCompare(b.className, "uz"));
  return { totals, classes };
}

function diffWarnings(diff) {
  const warnings = [];
  if (diff.totals.teacherOnly) {
    warnings.push({
      code: "teacher_only_changes",
      message: `${diff.totals.teacherOnly} ta darsda faqat o'qituvchi almashadi. Vaqtinchalik almashtirish (kasallik va h.k.) jadvalda emas, "O'rinbosarlik" bo'limida qilinadi — aks holda yangi o'qituvchi butun oy soatini va jurnal huquqini oladi`,
    });
  }
  if (diff.totals.subjectOnly) {
    warnings.push({
      code: "subject_only_changes",
      message: `${diff.totals.subjectOnly} ta darsda faqat fan almashadi (o'qituvchi va vaqt o'sha). Fan nomlari to'g'ri moslanganini tekshiring — mavzular va baholar boshqa fanga o'tib ketadi`,
    });
  }
  return warnings;
}

function removedClassesOf(activeRows, newRows, ctx, names) {
  const kept = new Set(newRows.map((r) => r.classId));
  const counts = new Map();
  for (const row of activeRows) {
    if (kept.has(row.classId) || !row.lessons.length) continue;
    counts.set(row.classId, (counts.get(row.classId) || 0) + row.lessons.length);
  }
  return [...counts]
    .map(([classId, lessonCount]) => ({
      classId,
      className: names.class(classId),
      lessonCount,
      orphan: !ctx.classMap.has(classId),
    }))
    .sort((a, b) => a.className.localeCompare(b.className, "uz"));
}

function conflictIssues(conflicts, names) {
  return conflicts.map((c) => ({
    code: "teacher_conflict",
    message: `${dayLabel(c.day)}, ${c.order}-dars: ${names.teacher(c.teacherId)} bir vaqtda ${c.classIds.map((id) => `"${names.class(id)}"`).join(" va ")} sinflarida`,
  }));
}

// ─────────────────────────────────────────────
// 5. Sheet tahririni ko'rib chiqish
// ─────────────────────────────────────────────

function revisionSummary(revision, { latestId = null, users = new Map() } = {}) {
  return {
    id: revision.id,
    status: revision.status,
    spreadsheetId: revision.spreadsheetId,
    sheetTab: revision.sheetTab,
    lessonCount: revision.lessonCount,
    classCount: revision.classCount,
    issueCount: revision.issueCount,
    fetchedBy: revision.fetchedBy ? userRef(users.get(revision.fetchedBy)) || { id: revision.fetchedBy, name: "—" } : null,
    reviewedBy: revision.reviewedBy ? userRef(users.get(revision.reviewedBy)) || { id: revision.reviewedBy, name: "—" } : null,
    reviewedAt: revision.reviewedAt,
    rejectReason: revision.rejectReason,
    snapshotId: revision.snapshotId,
    createdAt: revision.createdAt,
    isLatest: latestId === revision.id,
  };
}

async function loadUsersById(client, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const users = await client.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, firstName: true, lastName: true },
  });
  return new Map(users.map((u) => [u.id, u]));
}

/**
 * Joriy sozlama bo'yicha ENG OXIRGI tahrir (butun jadvaldagi eng yangisi
 * joriy havola/varaqqa tegishli bo'lsagina).
 */
async function findLatestRevision(client, settings) {
  const latest = await client.scheduleSheetRevision.findFirst({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, spreadsheetId: true, sheetTab: true, status: true, createdAt: true },
  });
  if (!latest || !sameConfig(latest, settings)) return null;
  return latest;
}

/**
 * Sheet tahririni to'liq ko'rib chiqish.
 *
 * @param {object} client - `prisma` yoki `tx`
 * @param {object} revision - `data` bilan to'liq qator
 * @param {{calendar: object|null, user: object|null}} options
 * @returns {Promise<{review: object, internal: {newRows: Array|null, activeRows: Array, requiredAcks: string[], resolution: object}}>}
 */
async function reviewRevision(client, revision, { calendar = null, user = null } = {}) {
  const ctx = await loadContext(client);
  const latest = await findLatestRevision(client, ctx.settings);
  const isLatest = Boolean(latest && latest.id === revision.id);
  const can = userCan(user);
  const checkFresh = isCheckFresh(ctx.settings, revision);
  const data = revision.data || {};

  const errors = (data.issues || []).map((i) => ({ code: i.code, message: i.message, cell: i.cell || undefined }));
  const warnings = [];

  const slotMap = mapSlotsToPeriods(data.slots, ctx.periods);
  errors.push(...slotMap.errors);

  const resolved = resolveLabels(data, ctx);
  errors.push(...resolved.errors);
  warnings.push(...resolved.warnings);

  const users = await loadUsersById(client, [revision.fetchedBy, revision.reviewedBy]);
  const summary = revisionSummary(revision, { latestId: latest?.id || null, users });

  const base = {
    revision: summary,
    mode: ctx.settings.mode || "platform",
    isLatest,
    checkFresh,
    slots: slotMap.slots,
    resolution: resolved.resolution,
    activeHash: hashState(ctx.activeRows),
  };

  // Eski tahrir: faqat ma'lumot. Farq joriy jadvalga nisbatan chalg'itadi.
  if (!isLatest) {
    return {
      review: {
        ...base,
        resolution: revision.resolution || resolved.resolution,
        newHash: null,
        // null — farq HISOBLANMADI ("farq yo'q" degani emas)
        hasChanges: null,
        canApply: false,
        canSwitch: false,
        canReject: false,
        blockers: ["Bu eski tahrir — eng oxirgisini ko'rib chiqing"],
        errors,
        warnings,
        requiredAcks: [],
        diff: null,
        todayImpact: null,
        payrollImpact: [],
        substitutionImpact: [],
        removedClasses: [],
      },
      internal: { newRows: null, activeRows: ctx.activeRows, requiredAcks: [], resolution: resolved.resolution },
    };
  }

  // Yangi holatni qurish — faqat moslash va vaqtlar to'liq bo'lsa
  let newRows = null;
  const mappingReady = !errors.length;
  if (mappingReady) {
    const lessons = (data.lessons || []).map((l) => ({
      classId: resolved.lookup.class.get(normalizeKey(l.classLabel)),
      subjectId: resolved.lookup.subject.get(normalizeKey(l.subjectLabel)),
      teacherId: resolved.lookup.teacher.get(normalizeKey(l.teacherLabel)),
      day: l.day,
      order: slotMap.orderOf.get(`${l.startTime}-${l.endTime}`),
      startTime: l.startTime,
      endTime: l.endTime,
      classLabel: l.classLabel,
      cell: l.cell,
    }));

    // Ikkinchi qavat: hal qilinmagan id bilan dars hech qachon quruvchiga
    // tushmasin (parser belgidan iborat nomlarni allaqachon rad etadi).
    const unresolved = lessons.filter((l) => !l.classId || !l.subjectId || !l.teacherId || !l.order);
    if (unresolved.length) {
      for (const l of unresolved.slice(0, 20)) {
        errors.push({
          code: "lesson_unresolved",
          message: `${l.classLabel || "?"} (${l.cell}): sinf, fan, o'qituvchi yoki dars vaqti aniqlanmadi`,
          cell: l.cell,
        });
      }
      const review = finalizeReview({
        base,
        revision,
        can,
        errors,
        warnings,
        requiredAcks: [],
        newHash: null,
        hasChanges: null,
        diff: null,
        removedClasses: [],
        impacts: { todayImpact: null, payrollImpact: [], substitutionImpact: [] },
      });
      return {
        review,
        internal: { newRows: null, activeRows: ctx.activeRows, requiredAcks: [], resolution: resolved.resolution },
      };
    }

    newRows = buildRowsFromLessons(lessons);

    // Kun shakli (tartib takrorlanmasin, vaqtlar to'g'ri) — platforma
    // saqlashidagi AYNI qoida
    const labelOf = new Map(lessons.map((l) => [l.classId, l.classLabel]));
    for (const row of newRows) {
      try {
        validateDayShape(
          row.lessons.map((l) => ({ ...l, subject: l.subjectId, teacher: l.teacherId })),
          row.day,
        );
      } catch (error) {
        errors.push({ code: "day_shape", message: `${labelOf.get(row.classId)}: ${error.message}` });
      }
    }

    // Fan/o'qituvchi qoidasi — platforma saqlashidagi AYNI tekshiruv
    const subjectIds = [...new Set(lessons.map((l) => l.subjectId))];
    const teacherIds = [...new Set(lessons.map((l) => l.teacherId))];
    const refs = await loadLessonRefContext(subjectIds, teacherIds, client);
    const seenRef = new Set();
    for (const l of lessons) {
      const refKey = `${l.subjectId}|${l.teacherId}`;
      if (seenRef.has(refKey)) continue;
      seenRef.add(refKey);
      const issue = checkLessonRef(refs, l.subjectId, l.teacherId, `${l.classLabel} (${l.cell})`);
      if (issue) errors.push({ code: "lesson_ref", message: issue.message, cell: l.cell });
    }
    const inactive = teacherIds
      .map((id) => refs.teacherMap.get(id))
      .filter((t) => t && t.isActive === false && !t.isArchived);
    if (inactive.length) {
      warnings.push({
        code: "inactive_teachers",
        message: `Nofaol (logini o'chirilgan) o'qituvchilarga dars qo'yilgan: ${inactive.map(teacherName).join(", ")}`,
      });
    }

    const names = await loadNames(client, [ctx.activeRows, newRows], ctx);
    errors.push(...conflictIssues(conflictsInState(newRows), names));

    const impacts = await computeImpacts(client, { activeRows: ctx.activeRows, newRows, names, calendar });
    errors.push(...impacts.errors);
    warnings.push(...impacts.warnings);

    const sheetLabelOf = new Map();
    for (const res of resolved.resolution.class) {
      if (resolved.lookup.class.get(res.key)) sheetLabelOf.set(res.targetId, res.label);
    }
    const diff = decorateDiff(ctx.activeRows, newRows, names, sheetLabelOf);
    warnings.push(...diffWarnings(diff));

    const removedClasses = removedClassesOf(ctx.activeRows, newRows, ctx, names);
    const requiredAcks = [];
    if (removedClasses.length) {
      requiredAcks.push({
        code: "classes_removed",
        title: ACKS.classes_removed,
        message: `Sheet'da darsi yo'q ${removedClasses.length} ta sinfning amaldagi darslari olib tashlanadi: ${removedClasses.map((c) => `${c.className} (${c.lessonCount} ta dars)`).join(", ")}. Ular qo'llashdan oldingi arxivda saqlanadi`,
      });
    }
    requiredAcks.push(...impacts.acks);
    if (inactive.length) {
      requiredAcks.push({
        code: "inactive_teachers",
        title: ACKS.inactive_teachers,
        message: warnings.find((w) => w.code === "inactive_teachers").message,
      });
    }

    const newHash = hashState(newRows);
    const hasChanges = newHash !== base.activeHash;
    const review = finalizeReview({
      base,
      revision,
      can,
      errors,
      warnings,
      requiredAcks,
      newHash,
      hasChanges,
      diff,
      removedClasses,
      impacts,
    });
    return {
      review,
      internal: {
        newRows,
        activeRows: ctx.activeRows,
        requiredAcks: requiredAcks.map((a) => a.code),
        resolution: resolved.resolution,
      },
    };
  }

  const review = finalizeReview({
    base,
    revision,
    can,
    errors,
    warnings,
    requiredAcks: [],
    newHash: null,
    hasChanges: null, // farq hisoblanmadi — avval xatolar tuzatilishi kerak
    diff: null,
    removedClasses: [],
    impacts: { todayImpact: null, payrollImpact: [], substitutionImpact: [] },
  });
  return {
    review,
    internal: { newRows: null, activeRows: ctx.activeRows, requiredAcks: [], resolution: resolved.resolution },
  };
}

function finalizeReview({ base, revision, can, errors, warnings, requiredAcks, newHash, hasChanges, diff, removedClasses, impacts }) {
  const blockers = [];
  if (!base.checkFresh) {
    blockers.push("Sheet 15 daqiqadan beri muvaffaqiyatli tekshirilmagan — avval \"Tekshirish\" ni bosing");
  }
  if (errors.length) blockers.push(`${errors.length} ta xato tuzatilishi kerak`);
  if (revision.status === "superseded") blockers.push("Bu tahrir eskirgan");

  const common = base.isLatest && base.checkFresh && errors.length === 0 && revision.status !== "superseded";
  const canApply = base.mode === "sheet" && common && hasChanges && can.review;
  const canSwitch = base.mode === "platform" && common && can.source;
  const canReject = base.isLatest && revision.status === "pending" && can.review;

  if (base.mode === "sheet" && common && !hasChanges) blockers.push("Amaldagi jadval sheet bilan bir xil — qo'llanadigan o'zgarish yo'q");
  if (base.mode === "sheet" && !can.review) blockers.push("Qo'llash uchun ruxsatingiz yo'q");
  if (base.mode === "platform" && !can.source) blockers.push("Manbani almashtirish uchun ruxsatingiz yo'q");

  return {
    ...base,
    newHash,
    hasChanges,
    canApply,
    canSwitch,
    canReject,
    blockers,
    errors,
    warnings,
    requiredAcks,
    diff,
    todayImpact: impacts.todayImpact,
    payrollImpact: impacts.payrollImpact,
    substitutionImpact: impacts.substitutionImpact,
    removedClasses,
  };
}

// ─────────────────────────────────────────────
// 6. Arxiv nusxani tiklashni ko'rib chiqish
// ─────────────────────────────────────────────

/**
 * Arxiv JSON'ining tuzilishini tekshiradi — buzilgan nusxa jadvalga
 * yozilmasligi kerak.
 *
 * ⚠️ Tekshiruv YOZUVCHIDAN qattiqroq bo'lmasligi kerak: nusxa `schedules`
 * dagi qatorlarni AYNAN ko'chiradi, eski ma'lumotda esa vaqt "8:30"
 * ko'rinishida yoki tartib raqami platforma bugun qabul qilmaydigan
 * qiymatda bo'lishi mumkin. Bu yerda faqat bazaga yozish uchun SHART
 * bo'lgan narsa tekshiriladi (id, kun, butun son, matn) — aks holda
 * platformaning o'z arxivini qaytarib bo'lmay qolardi.
 * @returns {string|null} xato matni
 */
function validateSnapshotData(data) {
  if (!data || data.version !== SNAPSHOT_VERSION || !Array.isArray(data.schedules)) {
    return "Arxiv nusxa formati tanilmadi";
  }
  const textOk = (t) => t === null || t === undefined || (typeof t === "string" && t.length <= 20);
  for (const row of data.schedules) {
    if (!ID_RE.test(String(row.classId)) || !DAY_ORDER.includes(row.day) || !Array.isArray(row.lessons)) {
      return "Arxiv nusxada buzilgan qator bor";
    }
    for (const l of row.lessons) {
      if (
        !ID_RE.test(String(l.subjectId)) ||
        !ID_RE.test(String(l.teacherId)) ||
        !Number.isInteger(Number(l.order)) ||
        !textOk(l.startTime) ||
        !textOk(l.endTime) ||
        !Number.isInteger(Number(l.position))
      ) {
        return "Arxiv nusxada buzilgan dars bor";
      }
    }
  }
  return null;
}

/**
 * Arxiv qatorlarini holat ko'rinishiga keltiradi.
 */
function snapshotRows(data) {
  return (data.schedules || []).map((row) => ({
    classId: row.classId,
    day: row.day,
    createdBy: row.createdBy || null,
    createdAt: row.createdAt || null,
    lessons: row.lessons.map((l) => ({
      order: Number(l.order),
      subjectId: l.subjectId,
      teacherId: l.teacherId,
      startTime: l.startTime || null,
      endTime: l.endTime || null,
      position: Number(l.position),
    })),
  }));
}

function snapshotSummary(snapshot, users = new Map()) {
  return {
    id: snapshot.id,
    kind: snapshot.kind,
    kindLabel: SNAPSHOT_KIND_LABELS[snapshot.kind] || snapshot.kind,
    mode: snapshot.mode,
    classCount: snapshot.classCount,
    lessonCount: snapshot.lessonCount,
    note: snapshot.note,
    revisionId: snapshot.revisionId,
    createdBy: snapshot.createdBy
      ? userRef(users.get(snapshot.createdBy)) || { id: snapshot.createdBy, name: "—" }
      : null,
    createdAt: snapshot.createdAt,
  };
}

/**
 * Arxiv nusxani tiklashni ko'rib chiqish.
 *
 * Tiklash — avvalgi holatni qaytarish, lekin O'CHIRILGAN yozuvlarni
 * tiriltirmaydi: sinfi o'chirilgan qator va fani/o'qituvchisi o'chirilgan
 * dars tiklanmaydi (ro'yxat bilan ko'rsatiladi va tasdiq so'raladi).
 * Aks holda o'chirilgan fan bo'yicha baho qo'yib bo'lmay, har kuni
 * "baho qo'yilmadi" jarimasi yozilardi.
 */
async function reviewSnapshotRestore(client, snapshot, { calendar = null, user = null } = {}) {
  const ctx = await loadContext(client);
  const can = userCan(user);
  const users = await loadUsersById(client, [snapshot.createdBy]);
  const summary = snapshotSummary(snapshot, users);
  const activeHash = hashState(ctx.activeRows);

  const invalid = validateSnapshotData(snapshot.data);
  if (invalid) {
    return {
      review: {
        snapshot: summary,
        activeHash,
        newHash: null,
        hasChanges: null, // buzilgan nusxa — farq hisoblanmadi
        diff: null,
        warnings: [],
        requiredAcks: [],
        droppedLessons: [],
        canRestore: false,
        blockers: [invalid],
      },
      internal: {
        restoreRows: null,
        activeRows: ctx.activeRows,
        requiredAcks: [],
        blockers: [{ code: "invalid", message: invalid }],
      },
    };
  }

  const rows = snapshotRows(snapshot.data);
  const allUserIds = [...new Set(rows.flatMap((r) => r.lessons.map((l) => l.teacherId)))];
  const existingUsers = allUserIds.length
    ? await client.user.findMany({
        where: { id: { in: allUserIds } },
        select: { id: true, firstName: true, lastName: true, isArchived: true, isActive: true, role: true, extraRoles: true },
      })
    : [];
  const userById = new Map(existingUsers.map((u) => [u.id, u]));
  const snapshotNames = new Map();
  for (const row of snapshot.data.schedules) {
    snapshotNames.set(`class|${row.classId}`, row.className);
    for (const l of row.lessons) {
      snapshotNames.set(`subject|${l.subjectId}`, l.subjectName);
      snapshotNames.set(`teacher|${l.teacherId}`, l.teacherName);
    }
  }

  const droppedLessons = [];
  const restoreRows = [];
  for (const row of rows) {
    const className = ctx.classMap.get(row.classId)?.name || snapshotNames.get(`class|${row.classId}`) || "(sinf)";
    if (!ctx.classMap.has(row.classId)) {
      for (const l of row.lessons) {
        droppedLessons.push({ className, dayLabel: dayLabel(row.day), order: l.order, reason: "sinf o'chirilgan" });
      }
      continue;
    }
    const lessons = [];
    for (const l of row.lessons) {
      let reason = null;
      const user = userById.get(l.teacherId);
      if (!ctx.subjectMap.has(l.subjectId)) reason = `fan o'chirilgan (${snapshotNames.get(`subject|${l.subjectId}`) || "—"})`;
      else if (!user) reason = `o'qituvchi o'chirilgan (${snapshotNames.get(`teacher|${l.teacherId}`) || "—"})`;
      // Roli o'zgargan (endi o'qituvchi emas): platforma bunday darsni
      // saqlamaydi (`checkLessonRef`), jurnalga kira olmaydi, lekin "baho
      // qo'yilmadi" jarimasi unga yozilaverardi.
      else if (!hasRole(user, ROLES.TEACHER)) reason = `${teacherName(user)} endi o'qituvchi emas`;
      if (reason) droppedLessons.push({ className, dayLabel: dayLabel(row.day), order: l.order, reason });
      else lessons.push(l);
    }
    // Hamma darsi tushib qolgan qator yozilmaydi; asli bo'sh qator — qaytadi.
    // `position` o'zgartirilmaydi: tushib qolgan dars o'rnidagi bo'shliq
    // tartibga ta'sir qilmaydi, qolganlari esa AYNAN avvalgidek qaytadi.
    if (row.lessons.length && !lessons.length) continue;
    restoreRows.push({ ...row, lessons });
  }

  const blockers = [];
  const warnings = [];
  const requiredAcks = [];

  // Unique indeks bor bazada takroriy sinf-kun qatorini yozib bo'lmaydi
  const seen = new Set();
  const duplicates = restoreRows.filter((r) => {
    const key = `${r.classId}|${r.day}`;
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
  if (duplicates.length && (await uniqueIndexPresent(client))) {
    blockers.push({
      code: "duplicates",
      message: "Bu nusxada bir sinf-kun uchun takroriy qatorlar bor, bazadagi cheklov tufayli uni tiklab bo'lmaydi",
    });
  }

  if (droppedLessons.length) {
    requiredAcks.push({
      code: "dropped_lessons",
      title: ACKS.dropped_lessons,
      message: `${droppedLessons.length} ta dars tiklanmaydi: sinfi, fani yoki o'qituvchisi tizimdan o'chirilgan yoki o'qituvchi endi o'qituvchi emas`,
    });
  }
  const archived = [...new Set(restoreRows.flatMap((r) => r.lessons.map((l) => l.teacherId)))]
    .map((id) => userById.get(id))
    .filter((u) => u && u.isArchived);
  if (archived.length) {
    requiredAcks.push({
      code: "archived_teachers",
      title: ACKS.archived_teachers,
      message: `Arxivlangan o'qituvchilarga darslar qaytadi: ${archived.map(teacherName).join(", ")}. Ular jurnalga kira olmaydi — jadvalni keyin to'g'rilang`,
    });
  }
  const inactive = [...new Set(restoreRows.flatMap((r) => r.lessons.map((l) => l.teacherId)))]
    .map((id) => userById.get(id))
    .filter((u) => u && !u.isArchived && u.isActive === false);
  if (inactive.length) {
    requiredAcks.push({
      code: "inactive_teachers",
      title: ACKS.inactive_teachers,
      message: `Nofaol o'qituvchilarga darslar qaytadi: ${inactive.map(teacherName).join(", ")}`,
    });
  }

  const names = await loadNames(client, [ctx.activeRows, restoreRows], ctx);
  const conflicts = conflictsInState(restoreRows);
  if (conflicts.length) {
    const issues = conflictIssues(conflicts, names);
    warnings.push(...issues);
    requiredAcks.push({
      code: "restore_conflicts",
      title: ACKS.restore_conflicts,
      message: `${conflicts.length} ta to'qnashuv: ${issues.slice(0, 3).map((i) => i.message).join("; ")}${conflicts.length > 3 ? " …" : ""}`,
    });
  }

  const impacts = await computeImpacts(client, { activeRows: ctx.activeRows, newRows: restoreRows, names, calendar });
  const removedClasses = removedClassesOf(ctx.activeRows, restoreRows, ctx, names);
  if (removedClasses.length) {
    requiredAcks.unshift({
      code: "classes_removed",
      title: ACKS.classes_removed,
      message: `Bu nusxada yo'q ${removedClasses.length} ta sinfning amaldagi darslari olib tashlanadi: ${removedClasses.map((c) => c.className).join(", ")}. Hozirgi holat arxivga saqlanadi`,
    });
  }
  // Tiklashda o'rinbosar bandligi ham faqat ogohlantirish: bu avvalgi haqiqat
  for (const issue of impacts.errors) warnings.push(issue);
  requiredAcks.push(...impacts.acks);
  if (impacts.errors.length && !requiredAcks.some((a) => a.code === "substitutions")) {
    requiredAcks.push({
      code: "substitutions",
      title: ACKS.substitutions,
      message: `${impacts.errors.length} ta o'rinbosarlik bilan to'qnashadi`,
    });
  }

  const diff = decorateDiff(ctx.activeRows, restoreRows, names);
  warnings.push(...diffWarnings(diff).filter((w) => w.code !== "subject_only_changes"));
  const newHash = hashState(restoreRows);
  const hasChanges = newHash !== activeHash;
  if (!hasChanges) blockers.push({ code: "no_changes", message: "Amaldagi jadval bu nusxa bilan bir xil" });
  if (!can.source) blockers.push({ code: "no_permission", message: "Tiklash uchun ruxsatingiz yo'q" });

  return {
    review: {
      snapshot: summary,
      activeHash,
      newHash,
      hasChanges,
      diff,
      warnings,
      requiredAcks,
      droppedLessons,
      todayImpact: impacts.todayImpact,
      payrollImpact: impacts.payrollImpact,
      substitutionImpact: impacts.substitutionImpact,
      removedClasses,
      canRestore: blockers.length === 0,
      blockers: blockers.map((b) => b.message),
    },
    internal: {
      restoreRows,
      activeRows: ctx.activeRows,
      requiredAcks: requiredAcks.map((a) => a.code),
      blockers,
    },
  };
}

/**
 * `schedules_class_id_day_key` indeksi joriy filial schema'sida bormi?
 */
async function uniqueIndexPresent(client) {
  const rows = await client.$queryRaw`
    SELECT 1 AS present FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'schedules'
      AND indexname = 'schedules_class_id_day_key'`;
  return rows.length > 0;
}

module.exports = {
  ACKS,
  SNAPSHOT_VERSION,
  SNAPSHOT_KIND_LABELS,
  userCan,
  userRef,
  sameConfig,
  isCheckFresh,
  loadActiveRows,
  loadContext,
  loadUsersById,
  findLatestRevision,
  revisionSummary,
  snapshotSummary,
  snapshotRows,
  reviewRevision,
  reviewSnapshotRestore,
  uniqueIndexPresent,
  countLessons,
};
