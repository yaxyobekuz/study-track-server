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
 *
 * ⚠️ IKKI OQIM, BITTA DVIGATEL. `query.selfAssigned` — RAHBAR BERGAN
 * topshiriqlar (`false`, sukut) yoki XODIM O'ZIGA BELGILAGANLARI (`true`)
 * kesimi. Ikkinchisi uchun ikkinchi hisobot dvigateli yozilmadi: KPI,
 * taqsimot, dinamika, hafta kuni va xodimlar kesimi bir xil savollarga
 * javob beradi, farqi faqat QAYSI qatorlar o'qilishida.
 *
 * ⚠️ FILTR MAJBURIY VA SUKUT `false`: aralashsa, jarimasiz va o'zi
 * yopiladigan shaxsiy topshiriqlar Lavozimlar markazining bajarilish
 * foizini jimgina ko'tarib yuborardi — ya'ni rahbar bergan ishning
 * intizomi haqidagi raqam yolg'on bo'lib qolardi.
 */

const prisma = require("../config/prisma");
const { getTaskSettings } = require("./settings.service");
const { getTashkentDateUtc } = require("../helpers/date.helpers");
const { BadRequestError } = require("../utils/errors");
const { applyScope } = require("./taskScope.service");
const { normalizeKind } = require("../helpers/taskWindow.helpers");
// ⚠️ DAVR TA'RIFI BITTA JOYDA (`helpers/statPeriod.helpers.js`): bosh
// sahifadagi kartalar yonma-yon turadi va "oylik" ularning hammasida AYNI
// oynani bildirishi shart.
const {
  isoDay: _isoDay,
  bucketKey: _bucketKey,
  bucketLabel: _bucketLabel,
  buildBuckets: _buildBuckets,
  periodLabel: _periodLabel,
  resolvePresetRange: _resolvePreset,
} = require("../helpers/statPeriod.helpers");

const TZ_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const WORKING_STATUSES = ["pending", "extended", "pending_rejected"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;
const LIVE_LIMIT = 8;
/** Reyting ro'yxatlarining uzunligi — ekranda ham, hujjatda ham AYNI. */
const TOP_LEADERS = 5;
const TOP_ATTENTION = 6;
const TOP_CREATORS = 6;
/**
 * Ijrochilar jadvalining chegarasi. ⚠️ Umumiy ko'rinishda u HAR FILIALGA
 * alohida qo'llanadi (`taskNetwork.service.js`), chunki hisobot har
 * filialda alohida quriladi.
 */
const PEOPLE_LIMIT = 100;

// ─── Sana yordamchilari ───────────────────────────────────────────

/** Instant → Toshkent kunining kaliti ("2026-09-17"). */
const _dayKey = (instant) => _isoDay(new Date(instant.getTime() + TZ_OFFSET_MS));

const _resolvePeriod = ({ from, to, period }) => {
  const todayKey = _isoDay(getTashkentDateUtc(0));
  // Preset berilgan bo'lsa from/to ni O'ZI beradi; qo'lda tanlangan davr
  // (hisobot tabi) avvalgidek ishlaydi.
  const preset = _resolvePreset(period);
  if (preset) {
    from = preset.from;
    to = preset.to;
  }
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
    preset: preset ? period : null,
    label: _periodLabel(fromKey, toKey),
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

/**
 * REYTINGLAR VA KESIMLAR — TAYYOR ijrochi qatorlaridan.
 *
 * ⚠️ FUNKSIYA SIFATIDA AJRATILGAN va bu ataylab: AYNI qoidalarni tarmoq
 * hisoboti ham chaqiradi (`taskNetwork.service.js`). Ikkinchi nusxa
 * bo'lsa, bitta filial hisobotidagi "yetakchi" bilan umumiy ko'rinishdagi
 * "yetakchi" boshqa-boshqa qoidadan chiqib ketardi — holbuki ekranda
 * ular bitta nomdagi ustun.
 *
 * Kirish — `_finalizePerson` dan o'tgan qatorlar (`rate`, `onTimeRate`
 * allaqachon hisoblangan), shuning uchun qayta hisob YO'Q.
 */
const pickLeaders = (rows) =>
  rows
    .filter((p) => p.completed > 0)
    .sort(
      (a, b) =>
        (b.rate ?? 0) - (a.rate ?? 0) ||
        (b.onTimeRate ?? 0) - (a.onTimeRate ?? 0) ||
        b.completed - a.completed,
    )
    .slice(0, TOP_LEADERS);

/** Muddati o'tgani bor YOKI bajarilishi 50% dan past (kamida 2 ta ish). */
const pickAttention = (rows) =>
  rows
    .filter((p) => p.overdue > 0 || (p.assigned - p.stopped >= 2 && (p.rate ?? 100) < 50))
    .sort((a, b) => b.overdue - a.overdue || (a.rate ?? 0) - (b.rate ?? 0))
    .slice(0, TOP_ATTENTION);

/**
 * ROLLAR KESIMI.
 *
 * ⚠️ Rol — GURUH KALITI, odam emas: bir xil rolli qatorlar (umumiy
 * ko'rinishda — har filialdagi qatorlar ham) QO'SHILADI. `people` esa
 * odam soni, ya'ni ikki filialda ishlaydigan xodim u yerda ikki marta
 * sanaladi va buning sababi hisobotda ochiq yoziladi.
 */
const groupByRole = (rows) => {
  const roles = new Map();

  for (const p of rows) {
    const key = p.role || "unknown";
    const row = roles.get(key) || {
      role: key,
      assigned: 0,
      completed: 0,
      overdue: 0,
      stopped: 0,
      people: 0,
    };
    row.assigned += p.assigned;
    row.completed += p.completed;
    row.overdue += p.overdue;
    row.stopped += p.stopped;
    row.people += 1;
    roles.set(key, row);
  }

  return [...roles.values()]
    .map((r) => ({ ...r, rate: _rate(r.completed, r.assigned - r.stopped) }))
    .sort((a, b) => b.assigned - a.assigned);
};

/** Topshiriq beruvchilar — bergan ishi bo'yicha kamayish tartibida. */
const pickCreators = (rows) =>
  [...rows].sort((a, b) => b.created - a.created).slice(0, TOP_CREATORS);

// ─── Jonli ro'yxatlar ─────────────────────────────────────────────

const _loadLive = async (settings, now, scope, selfAssigned = false) => {
  const soon = new Date(now.getTime() + settings.dueSoonHours * HOUR_MS);
  // Oqim kesimi — hisobotning qolgan qismi bilan AYNI (`getTaskReport`).
  // ⚠️ "Tekshiruv navbati" shaxsiy oqimda har doim BO'SH bo'ladi va bu
  // kutilgan hol: shaxsiy topshiriqda tasdiqlash bosqichi yo'q.
  const scoped = (where) => applyScope({ ...where, selfAssigned }, scope);
  const select = {
    id: true,
    title: true,
    assignee: true,
    status: true,
    kind: true,
    startDate: true,
    dueDate: true,
    penaltyPoints: true,
    createdAt: true,
  };

  const [overdue, overdueCount, dueSoon, dueSoonCount, review, reviewCount] = await Promise.all([
    prisma.task.findMany({
      where: scoped({ status: { in: WORKING_STATUSES }, dueDate: { lt: now } }),
      orderBy: { dueDate: "asc" },
      take: LIVE_LIMIT,
      select,
    }),
    prisma.task.count({
      where: scoped({ status: { in: WORKING_STATUSES }, dueDate: { lt: now } }),
    }),
    prisma.task.findMany({
      where: scoped({ status: { in: WORKING_STATUSES }, dueDate: { gte: now, lte: soon } }),
      orderBy: { dueDate: "asc" },
      take: LIVE_LIMIT,
      select,
    }),
    prisma.task.count({
      where: scoped({ status: { in: WORKING_STATUSES }, dueDate: { gte: now, lte: soon } }),
    }),
    prisma.task.findMany({
      where: scoped({ status: "pending_review" }),
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
    prisma.task.count({ where: scoped({ status: "pending_review" }) }),
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
  // Rahbar (`tasks.team`) — faqat o'z bo'limi. `tasks.view` / owner uchun
  // `scope` yo'q va `applyScope` hech narsa qo'shmaydi.
  const scope = query.scope;
  // Oqim kesimi HAR BIR so'rovga qo'shiladi (jonli ro'yxatlar ham —
  // `_loadLive` o'z parametridan oladi).
  const selfAssigned = query.selfAssigned === true;
  const scoped = (where) => applyScope({ ...where, selfAssigned }, scope);
  // ⚠️ `tasks.reports` KESIMI: yetakchilar, e'tibor talab qiladiganlar,
  // rollar va topshiriq beruvchilar reytingi — butun jamoaning intizomi,
  // ya'ni ro'yxatni ko'rishdan KENGROQ kesim (`.claude/rules` doktrinasi).
  // Dashboard uni so'ramaydi: aks holda `tasks.view` bo'lgan har kim
  // `tasks.reports` ortidagi hamma narsani ochib olardi.
  const full = query.full !== false;

  const prevEnd = new Date(start.getTime() - 1);
  const prevStart = new Date(start.getTime() - period.days * DAY_MS);

  const settings = await getTaskSettings();

  const [tasks, completionEvents, prevGroups, live] = await Promise.all([
    prisma.task.findMany({
      where: scoped({ createdAt: { gte: start, lte: end } }),
      select: {
        id: true,
        assignee: true,
        createdBy: true,
        status: true,
        kind: true,
        startDate: true,
        dueDate: true,
        penaltyRef: true,
        createdAt: true,
        statusHistory: {
          // ⚠️ Faqat HOLAT qatorlari: tahrir/jarima/muddat qatorlari
          // `_deriveFacts` da baribir chetlab o'tiladi, ularni SQL darajasida
          // tashlab yuborish yillik kesimda o'qiladigan qatorni bir necha
          // barobar kamaytiradi.
          where: { kind: "status" },
          orderBy: { position: "asc" },
          select: { status: true, kind: true, changedAt: true },
        },
        deadlineHistory: { select: { id: true } },
      },
    }),
    prisma.taskStatusHistory.findMany({
      where: {
        status: "completed",
        kind: "status",
        changedAt: { gte: start, lte: end },
        // ⚠️ OQIM FILTRI BU YERDA HAM: bu so'rov topshiriqdan EMAS,
        // tarix qatorlaridan o'qiydi, ya'ni `scoped()` ni chetlab o'tadi.
        // Usiz "bu hafta nechta ish bitdi" diagrammasi ikki oqimni
        // qo'shib ko'rsatardi.
        task: { selfAssigned, ...(scope && scope.mode !== "all" ? scope.where : {}) },
      },
      select: { changedAt: true },
    }),
    prisma.task.groupBy({
      by: ["status"],
      where: scoped({ createdAt: { gte: prevStart, lte: prevEnd } }),
      _count: { _all: true },
    }),
    _loadLive(settings, now, scope, selfAssigned),
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
  // TUR KESIMI — asosiy (lavozim bo'yicha doimiy ish) va qo'shimcha.
  // Rahbar "qo'shimcha ishlar asosiy ishni bosib ketmayaptimi" degan
  // savolga shu yerdan javob oladi.
  const kinds = {
    main: { key: "main", total: 0, completed: 0, overdue: 0, inProgress: 0, review: 0, stopped: 0 },
    extra: { key: "extra", total: 0, completed: 0, overdue: 0, inProgress: 0, review: 0, stopped: 0 },
  };
  const timing = { early: 0, lastDay: 0, late: 0 };
  const completionMinutes = [];
  const reviewMinutes = [];

  const buckets = _buildBuckets(fromKey, toKey, granularity);
  const trendMap = new Map(
    buckets.map((key) => [
      key,
      { key, label: _bucketLabel(key, granularity), created: 0, completed: 0 },
    ]),
  );
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

    const kindRow = kinds[normalizeKind(task.kind)];
    kindRow.total += 1;
    if (facts.isCompleted) kindRow.completed += 1;
    else if (task.status === "stopped") kindRow.stopped += 1;
    else if (task.status === "pending_review") kindRow.review += 1;
    else if (facts.isOverdue) kindRow.overdue += 1;
    else kindRow.inProgress += 1;

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

  const leaders = pickLeaders(peopleRows);
  const attention = pickAttention(peopleRows);
  const byRole = groupByRole(peopleRows);

  const creatorRows = pickCreators(
    [...creators.values()].map((c) => ({
      ...c,
      name: _fullName(userMap.get(c.userId)),
      rate: _rate(c.completed, c.created - c.stopped),
    })),
  );

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
      preset: period.preset,
      label: period.label,
    },
    kpis: {
      ...kpis,
      assignees: people.size,
      completionRate: _rate(kpis.completed, base),
      onTimeRate: _rate(timing.early + timing.lastDay, timing.early + timing.lastDay + timing.late),
      avgCompletionMinutes: _avg(completionMinutes),
      avgReviewMinutes: _avg(reviewMinutes),
      // ⚠️ O'RTACHANING MAXRAJI. Umumiy ko'rinishda o'rtachalar
      // OG'IRLIK bilan qo'shiladi (`taskNetwork.service.js`): usiz
      // 2 ta topshirig'i bor filial 200 ta topshirig'i bor filial bilan
      // teng hissa qo'shib, "tarmoq o'rtachasi" ma'nosiz raqam bo'lardi.
      completionSamples: completionMinutes.length,
      reviewSamples: reviewMinutes.length,
    },
    previous: {
      total: prevTotal,
      completed: prevCompleted,
      // ⚠️ Maxrajda ham kerak: umumiy ko'rinishda oldingi davr foizi
      // filiallar yig'indisidan QAYTA hisoblanadi (`taskNetwork.service.js`),
      // ya'ni to'xtatilganlar soni o'sha yerda ham chiqarib tashlanishi
      // kerak — aks holda ikki ekranda ikki xil o'zgarish ko'rinardi.
      stopped: prevCount("stopped"),
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
    kinds: [kinds.main, kinds.extra].map((row) => ({
      ...row,
      rate: _rate(row.completed, row.total - row.stopped),
    })),
    trend: [...trendMap.values()],
    weekday,
    people: peopleRows.slice(0, PEOPLE_LIMIT),
    leaders: full ? leaders : [],
    attention: full ? attention : [],
    byRole: full ? byRole : [],
    creators: full ? creatorRows : [],
    live: {
      ...live,
      overdue: live.overdue.map(withAssignee),
      dueSoon: live.dueSoon.map(withAssignee),
      review: live.review.map(withAssignee),
    },
    generatedAt: now,
  };
};

/**
 * BOSH SAHIFA KARTASI — davr bo'yicha BEShTA raqam.
 *
 * ⚠️ NIMA UCHUN TO'LIQ HISOBOT EMAS. `getTaskReport` har topshiriqning
 * HOLATLAR TARIXINI ham o'qiydi (o'z vaqtida topshirildimi, necha marta
 * rad etilgan) va ustiga oltita jonli ro'yxat so'rovini qo'shadi. Bosh
 * sahifadagi kartaga bularning birortasi kerak emas, lekin karta HAR
 * ochilishda, HAR FILIALDA bajariladi — ya'ni narxi filiallar soniga
 * ko'payadi.
 *
 * ⚠️ IKKINCHI HISOB EMAS: davr chegarasi (`_resolvePeriod`), holat
 * ta'riflari (`WORKING_STATUSES`, "muddati o'tgan" = ishlanayotgan va
 * muddati o'tgan) va foiz formulasi (`_rate`) AYNI — hammasi shu
 * fayldagi BITTA manbadan. Shuning uchun kartadagi raqam hujjatdagi
 * raqam bilan har doim mos tushadi.
 *
 * @param {{period?: string, from?: string, to?: string, scope?: object,
 *          selfAssigned?: boolean}} query
 * @returns {Promise<object>}
 */
const getTaskPulse = async (query = {}) => {
  const period = _resolvePeriod(query);
  const { start, end, fromKey, toKey } = period;
  const now = new Date();
  const scope = query.scope;
  const selfAssigned = query.selfAssigned === true;

  // ⚠️ DAVR SHARTI BIRINCHI yoziladi, qolgani USTIGA qo'shiladi: teskari
  // bo'lsa chaqiruvchidan kelgan `createdAt` uni jimgina bosib ketardi.
  const scoped = (where = {}) =>
    applyScope(
      { createdAt: { gte: start, lte: end }, ...where, selfAssigned },
      scope,
    );

  const [groups, overdue] = await Promise.all([
    prisma.task.groupBy({
      by: ["status"],
      where: scoped(),
      _count: { _all: true },
    }),
    prisma.task.count({
      where: scoped({ status: { in: WORKING_STATUSES }, dueDate: { lt: now } }),
    }),
  ]);

  const count = (status) =>
    groups.find((g) => g.status === status)?._count._all || 0;

  const total = groups.reduce((acc, g) => acc + g._count._all, 0);
  const completed = count("completed");
  const stopped = count("stopped");
  const review = count("pending_review");
  const working = WORKING_STATUSES.reduce((acc, status) => acc + count(status), 0);

  return {
    period: {
      from: fromKey,
      to: toKey,
      days: period.days,
      preset: period.preset,
      label: period.label,
    },
    total,
    completed,
    review,
    // "Jarayonda" — ishlanayotgan, lekin muddati HALI o'tmagan
    inProgress: Math.max(0, working - overdue),
    overdue,
    stopped,
    // ⚠️ To'xtatilgani maxrajdan chiqariladi (`getTaskReport` bilan AYNI):
    // bekor qilingan ish bajarilmagan deb sanalsa, rahbarning "to'xtatish"
    // qarori xodimning foizini tushirib yuborardi.
    completionRate: _rate(completed, total - stopped),
  };
};

module.exports = {
  getTaskReport,
  getTaskPulse,
  // Tarmoq hisoboti (`taskNetwork.service.js`) AYNI qoidalarni chaqiradi —
  // ikkinchi nusxa yozilmaydi.
  rate: _rate,
  pickLeaders,
  pickAttention,
  groupByRole,
  pickCreators,
  LIVE_LIMIT,
};
