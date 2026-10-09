/**
 * MUAMMOLAR HISOBOTI — "Hisobotlar" tabining yagona payload'i.
 *
 * Savollar oddiy tilda: shu davrda nechta muammo keldi, qaysi kategoriyada
 * ko'p, qanchasi javobsiz qoldi va javob o'rtacha qancha vaqtda berildi.
 *
 * Kesim muammo KELGAN sana bo'yicha (`taskReport.service.js` bilan bir xil
 * qoida): "shu davrda kelgan murojaatning qanchasi yopildi" degan savolga
 * javob beradi va bitta muammo ikki davrda ikki marta sanalmaydi.
 *
 * Istisno — `live`: davrga bog'liq BO'LMAGAN hozirgi holat ("hozir nechta
 * javobsiz murojaat turibdi"). Ma'muriyat uchun aynan shu raqam harakatga
 * chaqiradi, davr kesimi esa manzara beradi.
 *
 * ⚠️ `null` va `0` bir xil emas: foiz yoki o'rtacha vaqtning maxraji nol
 * bo'lsa `null` qaytadi ("o'lchanmagan") va frontend uni "—" deb
 * ko'rsatadi. `0` esa "o'lchandi, natija nol".
 *
 * Kunlar Toshkent vaqti bo'yicha (+5, DST yo'q) bo'linadi.
 */

const prisma = require("../config/prisma");
const { getTashkentDateUtc } = require("../helpers/date.helpers");
const { BadRequestError } = require("../utils/errors");
const { ISSUE_STATUSES, FINAL_STATUSES } = require("./issue.service");

const TZ_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;
const TOP_LIMIT = 8;
const LIVE_LIMIT = 8;

// ─── Sana yordamchilari (`taskReport.service.js` bilan ayni hisob) ───

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
  granularity === "day"
    ? dayKey
    : granularity === "week"
      ? _weekKey(dayKey)
      : _monthKey(dayKey);

/** Davrning barcha bo'laklari — bo'sh kunlar ham diagrammada nol bo'lib turadi. */
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
    : _isoDay(
        new Date(new Date(`${toKey}T00:00:00Z`).getTime() - 29 * DAY_MS),
      );

  const days =
    Math.round(
      (new Date(`${toKey}T00:00:00Z`).getTime() -
        new Date(`${fromKey}T00:00:00Z`).getTime()) /
        DAY_MS,
    ) + 1;

  if (days < 1) {
    throw new BadRequestError("Davr boshi oxiridan keyin bo'lmasligi kerak");
  }
  if (days > MAX_RANGE_DAYS) {
    throw new BadRequestError("Davr bir yildan oshmasligi kerak");
  }

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

const _rate = (part, whole) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

const _avg = (values) =>
  values.length
    ? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
    : null;

const _fullName = (user) =>
  user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : "Noma'lum";

/** Bo'sh sanoq skeleti — har bir holat nolda turishi uchun. */
const _emptyStatusCounts = () =>
  ISSUE_STATUSES.reduce((acc, s) => ({ ...acc, [s]: 0 }), {});

/**
 * MUAMMOLAR HISOBOTI.
 *
 * @param {object} [params]
 * @param {string} [params.from] - "YYYY-MM-DD" (default: 30 kun oldin)
 * @param {string} [params.to] - "YYYY-MM-DD" (default: bugun)
 * @returns {Promise<object>}
 */
const getIssueReport = async ({ from, to } = {}) => {
  const period = _resolvePeriod({ from, to });

  const [issues, categories, live] = await Promise.all([
    prisma.issue.findMany({
      where: { createdAt: { gte: period.start, lte: period.end } },
      select: {
        id: true,
        categoryId: true,
        authorKind: true,
        status: true,
        reply: true,
        reviewedAt: true,
        repliedAt: true,
        createdAt: true,
        category: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.issueCategory.findMany({ select: { id: true, name: true } }),
    // ⚠️ DAVRGA BOG'LIQ EMAS — hozir javobsiz turgan murojaatlar.
    prisma.issue.findMany({
      where: { status: { in: ["new", "in_review"] } },
      select: {
        id: true,
        userId: true,
        authorKind: true,
        status: true,
        body: true,
        createdAt: true,
        category: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
      take: LIVE_LIMIT,
    }),
  ]);

  const total = issues.length;

  // ── Holatlar bo'yicha ──
  const byStatus = _emptyStatusCounts();
  for (const issue of issues) byStatus[issue.status] += 1;

  const closed = FINAL_STATUSES.reduce((sum, s) => sum + byStatus[s], 0);
  const pending = total - closed;

  // ── Javob tezligi ──
  //
  // ⚠️ `reviewedAt` BO'YICHA, `repliedAt` emas: o'lchanadigan narsa —
  // ma'muriyat qancha vaqtda JAVOB BERDI. `repliedAt` esa Telegram
  // yetkazganini bildiradi va odam botni bloklagan bo'lsa bo'sh qoladi —
  // o'sha holat ma'muriyatning tezligini yomonlashtirmasligi kerak.
  const replyHours = issues
    .filter((i) => FINAL_STATUSES.includes(i.status) && i.reviewedAt)
    .map(
      (i) =>
        Math.round(
          ((i.reviewedAt.getTime() - i.createdAt.getTime()) / 3600000) * 10,
        ) / 10,
    )
    .filter((h) => h >= 0);

  // ── Kategoriyalar kesimi ──
  const catNames = new Map(categories.map((c) => [c.id, c.name]));
  const catBuckets = new Map();
  for (const issue of issues) {
    const key = issue.categoryId;
    if (!catBuckets.has(key)) {
      catBuckets.set(key, {
        categoryId: key,
        name: issue.category?.name || catNames.get(key) || "Noma'lum",
        total: 0,
        ...(_emptyStatusCounts()),
      });
    }
    const bucket = catBuckets.get(key);
    bucket.total += 1;
    bucket[issue.status] += 1;
  }

  const byCategory = [...catBuckets.values()]
    .map((b) => ({
      ...b,
      closed: FINAL_STATUSES.reduce((sum, s) => sum + b[s], 0),
      share: _rate(b.total, total),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, TOP_LIMIT);

  // ── Muallif turi kesimi ──
  const byAuthorKind = { student: 0, staff: 0 };
  for (const issue of issues) {
    if (byAuthorKind[issue.authorKind] === undefined) {
      byAuthorKind[issue.authorKind] = 0;
    }
    byAuthorKind[issue.authorKind] += 1;
  }

  // ── Trend ──
  const bucketKeys = _buildBuckets(
    period.fromKey,
    period.toKey,
    period.granularity,
  );
  const trendMap = new Map(
    bucketKeys.map((k) => [k, { key: k, total: 0, closed: 0 }]),
  );
  for (const issue of issues) {
    const key = _bucketKey(_dayKey(issue.createdAt), period.granularity);
    const bucket = trendMap.get(key);
    if (!bucket) continue;
    bucket.total += 1;
    if (FINAL_STATUSES.includes(issue.status)) bucket.closed += 1;
  }

  // ── Javobsiz turganlar (hozirgi holat) ──
  const liveAuthors = await _loadLiveAuthors(live);
  const now = Date.now();

  return {
    period: {
      from: period.fromKey,
      to: period.toKey,
      days: period.days,
      granularity: period.granularity,
    },
    summary: {
      total,
      closed,
      pending,
      closeRate: _rate(closed, total),
      resolvedRate: _rate(byStatus.resolved, total),
      avgReplyHours: _avg(replyHours),
      categoriesUsed: catBuckets.size,
    },
    byStatus,
    byCategory,
    byAuthorKind,
    trend: [...trendMap.values()],
    live: live.map((issue) => ({
      id: issue.id,
      status: issue.status,
      categoryName: issue.category?.name || "Noma'lum",
      authorKind: issue.authorKind,
      authorName: _fullName(liveAuthors.get(issue.userId)),
      body: issue.body.length > 140 ? `${issue.body.slice(0, 140)}…` : issue.body,
      createdAt: issue.createdAt,
      waitingDays: Math.floor((now - issue.createdAt.getTime()) / DAY_MS),
    })),
    generatedAt: new Date(),
  };
};

/**
 * Javobsiz muammolar uchun muallif obyektlari.
 *
 * ⚠️ `issues.userId` ga relation YO'Q (muallif o'chirilsa matn qolishi
 * kerak), shuning uchun odamlar alohida so'rov bilan yuklanadi va
 * topilmagani `undefined` bo'lib qoladi — `_fullName` uni "Noma'lum" qiladi.
 */
const _loadLiveAuthors = async (rows) => {
  const ids = [...new Set(rows.map((r) => r.userId).filter(Boolean))];
  if (!ids.length) return new Map();

  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true },
  });

  return new Map(users.map((u) => [u.id, u]));
};

module.exports = { getIssueReport };
