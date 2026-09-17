/**
 * TOPSHIRIQLAR HISOBOTI — "Hisobotlar" tabining yagona payload'i.
 *
 * Kesim topshiriq YARATILGAN sana bo'yicha (`staffReport.service.js` bilan
 * bir xil qoida): "shu davrda berilgan ishning qanchasi bajarildi" degan
 * savolga javob beradi va bitta topshiriq ikki davrda ikki marta sanalmaydi.
 *
 * Istisno — ikkita hodisa kesimi:
 *   trend.completed / weekday — shu davrda YAKUNLANGAN (tasdiqlangan) ishlar,
 *   qachon yaratilganidan qat'i nazar ("bu hafta nechta ish bitdi");
 *   live — davrga bog'liq bo'lmagan HOZIRGI holat (muddati o'tganlar,
 *   yaqinlashganlar, tekshiruv navbati).
 *
 * ⚠️ `null` va `0` bir xil emas: foiz maxraji nol bo'lsa `null` qaytadi
 * ("o'lchanmagan"), frontend uni "—" deb ko'rsatadi.
 *
 * Kunlar Toshkent vaqti bo'yicha (+5, DST yo'q) bo'linadi.
 */

const prisma = require("../config/prisma");
const { getTaskSettings } = require("./settings.service");
const { getTashkentDateUtc } = require("../helpers/date.helpers");
const { BadRequestError } = require("../utils/errors");

const TZ_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const WORKING_STATUSES = ["pending", "extended", "pending_rejected"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;
const LIVE_LIMIT = 8;

// ─── Sana yordamchilari ───────────────────────────────────────────

const _isoDay = (date) => date.toISOString().slice(0, 10);

/** Instant → Toshkent kunining kaliti ("2026-09-17"). */
const _dayKey = (instant) => _isoDay(new Date(instant.getTime() + TZ_OFFSET_MS));

/** Kun kaliti → o'sha haftaning dushanbasi. */
const _weekKey = (dayKey) => {
  const d = new Date(`${dayKey}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7; // dushanba = 0
  return _isoDay(new Date(d.getTime() - shift * DAY_MS));
};

const _monthKey = (dayKey) => `${dayKey.slice(0, 7)}-01`;

const _bucketKey = (dayKey, granularity) =>
  granularity === "day" ? dayKey : granularity === "week" ? _weekKey(dayKey) : _monthKey(dayKey);

/** Davrning barcha bo'laklari — bo'sh kunlar ham diagrammada nol bo'lib turishi uchun. */
const _buildBuckets = (fromKey, toKey, granularity) => {
  const keys = [];
  const seen = new Set();
  for (
    let t = new Date(`${fromKey}T00:00:00Z`).getTime();
    t <= new Date(`${toKey}T00:00:00Z`).getTime();
    t += DAY_MS
  ) {
    const key = _bucketKey(_isoDay(new Date(t)), granularity);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
};

const _resolvePeriod = ({ from, to }) => {
  const todayKey = _isoDay(getTashkentDateUtc(0));
  const toKey = DATE_RE.test(to || "") ? to : todayKey;
  const fromKey = DATE_RE.test(from || "")
    ? from
    : _isoDay(new Date(new Date(`${toKey}T00:00:00Z`).getTime() - 29 * DAY_MS));

  const days =
    Math.round(
      (new Date(`${toKey}T00:00:00Z`).getTime() - new Date(`${fromKey}T00:00:00Z`).getTime()) /
        DAY_MS,
    ) + 1;

  if (days < 1) throw new BadRequestError("Davr boshi oxiridan keyin bo'lmasligi kerak");
  if (days > MAX_RANGE_DAYS) throw new BadRequestError("Davr bir yildan oshmasligi kerak");

  const granularity = days <= 31 ? "day" : days <= 120 ? "week" : "month";

  return {
    fromKey,
    toKey,
    days,
    granularity,
    start: new Date(`${fromKey}T00:00:00+05:00`),
    end: new Date(`${toKey}T23:59:59.999+05:00`),
  };
};

// ─── Hisob yordamchilari ──────────────────────────────────────────

const _rate = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

const _avg = (values) =>
  values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;

const _fullName = (user) =>
  user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : "Noma'lum";

/**
 * Bitta topshiriqning tarixidan hosila faktlar.
 * `submittedAt` — yakunlanishdan oldingi OXIRGI topshirish (rad etilgandan
 * keyin qayta topshirilgan bo'lsa — o'sha).
 */
const _deriveFacts = (task, now) => {
  let submittedAt = null;
  let completedAt = null;
  let wasRejected = false;

  for (const h of task.statusHistory) {
    if ((h.kind || "status") !== "status") continue;
    if (h.status === "pending_review") submittedAt = h.changedAt;
    if (h.status === "completed") completedAt = h.changedAt;
    if (h.status === "pending_rejected") wasRejected = true;
  }

  const isCompleted = task.status === "completed";
  const isOverdue = WORKING_STATUSES.includes(task.status) && task.dueDate < now;
  const onTime = isCompleted && submittedAt ? submittedAt <= task.dueDate : null;

  return {
    isCompleted,
    isOverdue,
    wasRejected,
    wasExtended: task.deadlineHistory.length > 0,
    submittedAt,
    completedAt: isCompleted ? completedAt : null,
    onTime,
  };
};

/** Ijrochining ish topshirish vaqti muddatga nisbatan: erta / oxirgi kuni / kech. */
const _timingBucket = (facts, dueDate) => {
  if (!facts.isCompleted || !facts.submittedAt) return null;
  const diff = dueDate.getTime() - facts.submittedAt.getTime();
  if (diff < 0) return "late";
  if (diff <= DAY_MS) return "lastDay";
  return "early";
};

const _emptyPerson = (userId) => ({
  userId,
  assigned: 0,
  completed: 0,
  inProgress: 0,
  review: 0,
  overdue: 0,
  stopped: 0,
  onTime: 0,
  late: 0,
  rejected: 0,
  penaltyPoints: 0,
  completionMinutes: [],
});

const _finalizePerson = (row, user) => {
  const base = row.assigned - row.stopped;
  const { completionMinutes, ...rest } = row;
  return {
    ...rest,
    name: _fullName(user),
    role: user?.role || null,
    rate: _rate(row.completed, base),
    onTimeRate: _rate(row.onTime, row.onTime + row.late),
    avgCompletionMinutes: _avg(completionMinutes),
  };
};

// ─── Jonli ro'yxatlar ─────────────────────────────────────────────

const _loadLive = async (settings, now) => {
  const soon = new Date(now.getTime() + settings.dueSoonHours * HOUR_MS);
  const select = {
    id: true,
    title: true,
    assignee: true,
    status: true,
    dueDate: true,
    penaltyPoints: true,
    createdAt: true,
  };

  const [overdue, overdueCount, dueSoon, dueSoonCount, review, reviewCount] = await Promise.all([
    prisma.task.findMany({
      where: { status: { in: WORKING_STATUSES }, dueDate: { lt: now } },
      orderBy: { dueDate: "asc" },
      take: LIVE_LIMIT,
      select,
    }),
    prisma.task.count({ where: { status: { in: WORKING_STATUSES }, dueDate: { lt: now } } }),
    prisma.task.findMany({
      where: { status: { in: WORKING_STATUSES }, dueDate: { gte: now, lte: soon } },
      orderBy: { dueDate: "asc" },
      take: LIVE_LIMIT,
      select,
    }),
    prisma.task.count({
      where: { status: { in: WORKING_STATUSES }, dueDate: { gte: now, lte: soon } },
    }),
    prisma.task.findMany({
      where: { status: "pending_review" },
      orderBy: { updatedAt: "asc" },
      take: LIVE_LIMIT,
      select: {
        ...select,
        statusHistory: {
          where: { status: "pending_review", kind: "status" },
          orderBy: { position: "desc" },
          take: 1,
          select: { changedAt: true },
        },
      },
    }),
    prisma.task.count({ where: { status: "pending_review" } }),
  ]);

  return {
    overdue,
    dueSoon,
    review: review.map(({ statusHistory, ...t }) => ({
      ...t,
      submittedAt: statusHistory[0]?.changedAt || null,
    })),
    counts: { overdue: overdueCount, dueSoon: dueSoonCount, review: reviewCount },
    dueSoonHours: settings.dueSoonHours,
  };
};

// ─── ASOSIY ───────────────────────────────────────────────────────

/**
 * @param {{ from?: string, to?: string }} query - "YYYY-MM-DD" (Toshkent kunlari)
 * @returns {Promise<object>}
 */
const getTaskReport = async (query = {}) => {
  const period = _resolvePeriod(query);
  const { start, end, fromKey, toKey, granularity } = period;
  const now = new Date();

  const prevEnd = new Date(start.getTime() - 1);
  const prevStart = new Date(start.getTime() - period.days * DAY_MS);

  const settings = await getTaskSettings();

  const [tasks, completionEvents, prevGroups, live] = await Promise.all([
    prisma.task.findMany({
      where: { createdAt: { gte: start, lte: end } },
      select: {
        id: true,
        assignee: true,
        createdBy: true,
        status: true,
        dueDate: true,
        penaltyRef: true,
        createdAt: true,
        statusHistory: {
          orderBy: { position: "asc" },
          select: { status: true, kind: true, changedAt: true },
        },
        deadlineHistory: { select: { id: true } },
      },
    }),
    prisma.taskStatusHistory.findMany({
      where: { status: "completed", kind: "status", changedAt: { gte: start, lte: end } },
      select: { changedAt: true },
    }),
    prisma.task.groupBy({
      by: ["status"],
      where: { createdAt: { gte: prevStart, lte: prevEnd } },
      _count: { _all: true },
    }),
    _loadLive(settings, now),
  ]);

  // Jarima ballari — jarima yozuvlaridan (topshiriqdagi `penaltyPoints` —
  // bu "muddati o'tsa qancha", haqiqatda yozilgan ball emas)
  const penaltyIds = tasks.map((t) => t.penaltyRef).filter(Boolean);
  const penalties = penaltyIds.length
    ? await prisma.penalty.findMany({
        where: { id: { in: penaltyIds } },
        select: { id: true, points: true },
      })
    : [];
  const penaltyPointsById = new Map(penalties.map((p) => [p.id, p.points]));

  // ── Yig'ish ──
  const kpis = {
    total: tasks.length,
    completed: 0,
    inProgress: 0,
    review: 0,
    stopped: 0,
    overdue: 0,
    rejected: 0,
    extended: 0,
    penalized: 0,
    penaltyPoints: 0,
  };
  const timing = { early: 0, lastDay: 0, late: 0 };
  const completionMinutes = [];
  const reviewMinutes = [];

  const buckets = _buildBuckets(fromKey, toKey, granularity);
  const trendMap = new Map(buckets.map((key) => [key, { key, created: 0, completed: 0 }]));
  const weekday = Array.from({ length: 7 }, (_, index) => ({ index, created: 0, completed: 0 }));

  const people = new Map();
  const creators = new Map();

  for (const task of tasks) {
    const facts = _deriveFacts(task, now);
    const points = task.penaltyRef ? penaltyPointsById.get(task.penaltyRef) || 0 : 0;

    if (facts.isCompleted) kpis.completed += 1;
    else if (task.status === "stopped") kpis.stopped += 1;
    else if (task.status === "pending_review") kpis.review += 1;
    else if (facts.isOverdue) kpis.overdue += 1;
    else kpis.inProgress += 1;

    if (facts.wasRejected) kpis.rejected += 1;
    if (facts.wasExtended) kpis.extended += 1;
    if (task.penaltyRef) {
      kpis.penalized += 1;
      kpis.penaltyPoints += points;
    }

    const bucket = _timingBucket(facts, task.dueDate);
    if (bucket) timing[bucket] += 1;

    if (facts.completedAt) {
      completionMinutes.push((facts.completedAt - task.createdAt) / 60000);
      if (facts.submittedAt) reviewMinutes.push((facts.completedAt - facts.submittedAt) / 60000);
    }

    const dayKey = _dayKey(task.createdAt);
    const trendRow = trendMap.get(_bucketKey(dayKey, granularity));
    if (trendRow) trendRow.created += 1;
    weekday[(new Date(`${dayKey}T00:00:00Z`).getUTCDay() + 6) % 7].created += 1;

    // Ijrochi kesimi
    const person = people.get(task.assignee) || _emptyPerson(task.assignee);
    person.assigned += 1;
    if (facts.isCompleted) person.completed += 1;
    else if (task.status === "stopped") person.stopped += 1;
    else if (task.status === "pending_review") person.review += 1;
    else if (facts.isOverdue) person.overdue += 1;
    else person.inProgress += 1;
    if (facts.onTime === true) person.onTime += 1;
    if (facts.onTime === false) person.late += 1;
    if (facts.wasRejected) person.rejected += 1;
    person.penaltyPoints += points;
    if (facts.completedAt) {
      person.completionMinutes.push((facts.completedAt - task.createdAt) / 60000);
    }
    people.set(task.assignee, person);

    // Topshiriq beruvchi kesimi
    const creator = creators.get(task.createdBy) || {
      userId: task.createdBy,
      created: 0,
      completed: 0,
      stopped: 0,
    };
    creator.created += 1;
    if (facts.isCompleted) creator.completed += 1;
    if (task.status === "stopped") creator.stopped += 1;
    creators.set(task.createdBy, creator);
  }

  for (const event of completionEvents) {
    const dayKey = _dayKey(event.changedAt);
    const trendRow = trendMap.get(_bucketKey(dayKey, granularity));
    if (trendRow) trendRow.completed += 1;
    weekday[(new Date(`${dayKey}T00:00:00Z`).getUTCDay() + 6) % 7].completed += 1;
  }

  // ── Foydalanuvchilar ──
  const userIds = [...new Set([...people.keys(), ...creators.keys(),
    ...live.overdue.map((t) => t.assignee),
    ...live.dueSoon.map((t) => t.assignee),
    ...live.review.map((t) => t.assignee)])];
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, firstName: true, lastName: true, role: true },
      })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));

  const peopleRows = [...people.values()]
    .map((row) => _finalizePerson(row, userMap.get(row.userId)))
    .sort((a, b) => b.assigned - a.assigned || (b.rate ?? -1) - (a.rate ?? -1));

  const leaders = peopleRows
    .filter((p) => p.completed > 0)
    .sort(
      (a, b) =>
        (b.rate ?? 0) - (a.rate ?? 0) ||
        (b.onTimeRate ?? 0) - (a.onTimeRate ?? 0) ||
        b.completed - a.completed,
    )
    .slice(0, 5);

  const attention = peopleRows
    .filter((p) => p.overdue > 0 || (p.assigned - p.stopped >= 2 && (p.rate ?? 100) < 50))
    .sort((a, b) => b.overdue - a.overdue || (a.rate ?? 0) - (b.rate ?? 0))
    .slice(0, 6);

  // Rollar kesimi
  const roles = new Map();
  for (const p of peopleRows) {
    const key = p.role || "unknown";
    const row = roles.get(key) || { role: key, assigned: 0, completed: 0, overdue: 0, stopped: 0, people: 0 };
    row.assigned += p.assigned;
    row.completed += p.completed;
    row.overdue += p.overdue;
    row.stopped += p.stopped;
    row.people += 1;
    roles.set(key, row);
  }
  const byRole = [...roles.values()]
    .map((r) => ({ ...r, rate: _rate(r.completed, r.assigned - r.stopped) }))
    .sort((a, b) => b.assigned - a.assigned);

  const creatorRows = [...creators.values()]
    .map((c) => ({
      ...c,
      name: _fullName(userMap.get(c.userId)),
      rate: _rate(c.completed, c.created - c.stopped),
    }))
    .sort((a, b) => b.created - a.created)
    .slice(0, 6);

  const withAssignee = (t) => {
    const u = userMap.get(t.assignee);
    return { ...t, assignee: u ? { id: u.id, name: _fullName(u), role: u.role } : null };
  };

  // Oldingi davr — o'zgarish strelkalari uchun
  const prevCount = (s) => prevGroups.find((g) => g.status === s)?._count._all || 0;
  const prevTotal = prevGroups.reduce((a, g) => a + g._count._all, 0);
  const prevCompleted = prevCount("completed");

  const base = kpis.total - kpis.stopped;

  return {
    period: {
      from: fromKey,
      to: toKey,
      days: period.days,
      granularity,
    },
    kpis: {
      ...kpis,
      assignees: people.size,
      completionRate: _rate(kpis.completed, base),
      onTimeRate: _rate(timing.early + timing.lastDay, timing.early + timing.lastDay + timing.late),
      avgCompletionMinutes: _avg(completionMinutes),
      avgReviewMinutes: _avg(reviewMinutes),
    },
    previous: {
      total: prevTotal,
      completed: prevCompleted,
      completionRate: _rate(prevCompleted, prevTotal - prevCount("stopped")),
    },
    breakdown: [
      { key: "completed", value: kpis.completed },
      { key: "review", value: kpis.review },
      { key: "inProgress", value: kpis.inProgress },
      { key: "overdue", value: kpis.overdue },
      { key: "stopped", value: kpis.stopped },
    ],
    timing,
    trend: [...trendMap.values()],
    weekday,
    people: peopleRows.slice(0, 100),
    leaders,
    attention,
    byRole,
    creators: creatorRows,
    live: {
      ...live,
      overdue: live.overdue.map(withAssignee),
      dueSoon: live.dueSoon.map(withAssignee),
      review: live.review.map(withAssignee),
    },
    generatedAt: now,
  };
};

module.exports = { getTaskReport };
