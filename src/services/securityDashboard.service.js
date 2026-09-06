/**
 * XAVFSIZLIK DASHBOARDI — O'QISH TOMONI.
 *
 * Bitta savolga javob beradi: **hisobga KIM kirdi?**
 *
 * ⚠️ FAOLLIKDAN FARQI. Faollik "tizimdan kim FOYDALANYAPTI" ni o'lchaydi
 * va bu kadrlar savoli. Bu yerda esa savol boshqa: "kim kirdi, qayerdan
 * kirdi va bu odam o'shami". Shu sababli o'lchov birligi ham boshqa —
 * u yerda KUN va foiz, bu yerda esa HODISA va qurilma.
 *
 * ⚠️ FILIAL BO'YICHA CHEGARALANGAN. Jadvallar platformada (barcha
 * filiallar bir joyda), lekin `User.permissions` har filialda alohida —
 * Chilonzorda `security.view` olgan xodim Yunusobodning seanslarini
 * ko'rmasligi kerak. Owner istisno: u hamma filialga ega.
 *
 * ⚠️ HISOBOT HECH NARSANI TO'XTATMAYDI. Ogohlantirish — signal, jazo
 * emas (`security.service.js` dagi doktrina). Seansni faqat ODAM
 * tugatadi va buning uchun alohida ruxsat kerak (`security.revoke`).
 */

const platformPrisma = require("../config/platformPrisma");
const prisma = require("../config/prisma");
const { NotFoundError, BadRequestError } = require("../utils/errors");
const { currentDayDate } = require("../helpers/month.helpers");
const { formatDateUz, formatDateTimeUz } = require("../helpers/date.helpers");
const { ROLES } = require("../utils/constants");
const { hasRole } = require("../utils/permissions");
const securityService = require("./security.service");

/** Ruxsat etilgan davrlar (kun). */
const PERIODS = [7, 14, 30, 90];
const DEFAULT_PERIOD = 30;

/** Ogohlantirish turlarining o'zbekcha nomlari va izohlari. */
const ALERT_META = {
  concurrent_session: {
    label: "Bir vaqtda bir nechta seans",
    hint: "Bitta hisobga turli qurilmalardan bir vaqtning o'zida kirilgan",
  },
  new_device: {
    label: "Yangi qurilma",
    hint: "Ilgari ishlatilmagan qurilmadan kirish",
  },
  new_ip: {
    label: "Yangi IP manzil",
    hint: "Odatdagidan boshqa tarmoqdan kirish",
  },
  brute_force: {
    label: "Parol tanlash urinishi",
    hint: "Ketma-ket muvaffaqiyatsiz kirish urinishlari",
  },
  rapid_switch: {
    label: "Tez filial almashtirish",
    hint: "Qisqa vaqtda bir nechta filialga kirish",
  },
  night_login: {
    label: "Tunda kirish",
    hint: "00:00 — 05:00 oralig'ida kirish",
  },
  dormant_login: {
    label: "Uzoq kirmagan hisob uyg'ondi",
    hint: "Uzoq vaqt ishlatilmagan hisobga qaytib kirildi",
  },
};

/** Muvaffaqiyatsizlik sabablarining nomlari. */
const REASON_LABELS = {
  ok: "Muvaffaqiyatli",
  bad_password: "Noto'g'ri parol",
  unknown_user: "Mavjud bo'lmagan login",
  // ⚠️ `auth.service.js` bu sababni "Username yoki parol noto'g'ri" xabari
  // ostida yashiradi (mavjud login'ni oshkor qilmaslik uchun). Jurnalda esa
  // u alohida turadi — nomsiz qolsa, ekranda xom kalit ko'rinardi.
  branch_unusable: "Filial yaroqsiz (arxiv/yopiq/tayyor emas)",
  inactive: "Hisob faol emas",
  archived: "Hisob arxivlangan",
  rate_limited: "Limitdan oshdi",
};

/** Seans tugash sabablarining nomlari. */
const END_REASON_LABELS = {
  active: "Ochiq",
  logout: "Chiqildi",
  revoked: "Majburan tugatildi",
  expired: "Muddati o'tdi",
  superseded: "Filial almashtirildi",
};

/* ═══════════════════════ YORDAMCHILAR ═══════════════════════ */

const dayKey = (date) => date.toISOString().slice(0, 10);

const shiftDay = (date, days) =>
  new Date(date.getTime() + days * 24 * 3600 * 1000);

const rate = (part, whole) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;

/**
 * @param {object} params
 * @returns {{ days: number, from: Date, to: Date }}
 */
function resolvePeriod({ days } = {}) {
  const requested = days == null ? DEFAULT_PERIOD : Number(days);

  if (!PERIODS.includes(requested)) {
    throw new BadRequestError(
      `Davr noto'g'ri. Ruxsat etilgan qiymatlar: ${PERIODS.join(", ")}`,
    );
  }

  const to = currentDayDate();
  return { days: requested, from: shiftDay(to, -(requested - 1)), to };
}

/**
 * FILIAL DARVOZASI — so'rov shartining birinchi bo'lagi.
 *
 * ⚠️ Owner uchun `{}` qaytariladi (hamma filial), qolganlar uchun esa
 * JORIY filial. Ruxsat har filialda alohida bo'lgani uchun boshqa yo'l
 * yo'q: bitta filialdagi `security.view` butun tarmoqni ochib
 * yubormasligi kerak.
 *
 * ⚠️ `branchId: null` bo'lgan qatorlar (noma'lum login bilan urinish)
 * FAQAT OWNER ga ko'rinadi: ular qaysi filialga tegishli ekani noma'lum
 * va ularni "hammaga ko'rsatish" filial chegarasini buzardi.
 *
 * @param {object} actor - `req.user`
 * @param {object} branch - `req.branch`
 * @returns {object} - Prisma `where` bo'lagi
 */
function branchScope(actor, branch) {
  if (hasRole(actor, ROLES.OWNER)) return {};
  return { branchId: branch?.id ?? "__none__" };
}

/**
 * Foydalanuvchi ismlarini yo'naltirgichdan yuklaydi.
 *
 * ⚠️ FILIAL BAZASIGA BORILMAYDI: seanslar platformada va ular bir
 * nechta filialga tegishli bo'lishi mumkin. `UserDirectory` esa
 * denormalizatsiya qilingan ism-familiyani saqlaydi — u aynan shunday
 * savollar uchun bor.
 *
 * @param {string[]} userIds
 * @returns {Promise<Map<string, { name: string, role: string }>>}
 */
async function loadNames(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const rows = await platformPrisma.userDirectory.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true, role: true, username: true },
  });

  return new Map(
    rows.map((row) => [
      row.id,
      {
        name: `${row.firstName || ""} ${row.lastName || ""}`.trim() || row.username,
        role: row.role,
        username: row.username,
      },
    ]),
  );
}

/** Seans qatorini mijoz shakliga keltiradi. */
const publicSession = (row, names) => ({
  id: row.id,
  userId: row.userId,
  username: row.username || names.get(row.userId)?.username || "",
  name: names.get(row.userId)?.name ?? row.username ?? "Noma'lum",
  role: names.get(row.userId)?.role ?? null,
  branchId: row.branchId,
  channel: row.channel,
  ip: row.ip,
  device: row.device || "Noma'lum qurilma",
  createdAt: row.createdAt,
  createdLabel: formatDateTimeUz(row.createdAt),
  lastSeenAt: row.lastSeenAt,
  lastSeenLabel: formatDateTimeUz(row.lastSeenAt),
  expiresAt: row.expiresAt,
  expiresLabel: formatDateUz(row.expiresAt),
  endReason: row.endReason,
  endReasonLabel: END_REASON_LABELS[row.endReason] ?? row.endReason,
  endedAt: row.endedAt,
  isLive: row.endReason === "active" && row.expiresAt > new Date(),
});

/** Ogohlantirish qatorini mijoz shakliga keltiradi. */
const publicAlert = (row, names) => ({
  id: row.id,
  type: row.type,
  typeLabel: ALERT_META[row.type]?.label ?? row.type,
  typeHint: ALERT_META[row.type]?.hint ?? "",
  severity: row.severity,
  status: row.status,
  userId: row.userId,
  name: row.userId ? (names.get(row.userId)?.name ?? row.username) : row.username,
  role: row.userId ? (names.get(row.userId)?.role ?? null) : null,
  branchId: row.branchId,
  title: row.title,
  detail: row.detail,
  meta: row.meta ?? null,
  hitCount: row.hitCount,
  firstSeenAt: row.firstSeenAt,
  firstSeenLabel: formatDateTimeUz(row.firstSeenAt),
  lastSeenAt: row.lastSeenAt,
  lastSeenLabel: formatDateTimeUz(row.lastSeenAt),
  note: row.note,
  acknowledgedAt: row.acknowledgedAt,
  resolvedAt: row.resolvedAt,
});

/* ═══════════════════════ ASOSIY MANZARA ═══════════════════════ */

/**
 * BUTUN MANZARA — bitta so'rov.
 *
 * ⚠️ SHAXSIY MA'LUMOT ALOHIDA RUXSAT BILAN. Manzarani ko'rish
 * (`security.view`) raqamlarni ochadi; IP, qurilma va aniq odamlar
 * ro'yxati esa `security.sessions` talab qiladi va usiz javobdan
 * BUTUNLAY chiqarib tashlanadi. Ilgari ular `overview` javobiga
 * qo'shilib ketardi va mayda ruxsatlar shakli (moliya bo'limidagi
 * naqsh) amalda buzilardi: "foizni ko'rish" huquqi butun seans
 * registrini ochib berardi.
 *
 * ⚠️ Filtr SERVERDA, frontendda emas. Mijoz tomonida yashirish
 * ma'lumotni baribir tarmoq javobida qoldirardi.
 *
 * @param {object} params
 * @param {number} [params.days=30]
 * @param {object} params.actor - `req.user`
 * @param {object} params.branch - `req.branch`
 * @param {boolean} [params.withDetails=false] - `security.sessions` ruxsati
 * @returns {Promise<object>}
 */
async function getOverview({ days, actor, branch, withDetails = false } = {}) {
  const period = resolvePeriod({ days });
  const scope = branchScope(actor, branch);
  const now = new Date();
  const today = currentDayDate();

  const attemptWhere = {
    ...scope,
    day: { gte: period.from, lte: period.to },
  };

  const [
    liveSessions,
    attemptsByDay,
    attemptsByReason,
    alertCounts,
    alertsByType,
    resolvedCount,
    openAlerts,
    recentAttempts,
    topIps,
    devices,
    firstAttempt,
  ] = await Promise.all([
    // ── Hozir ochiq seanslar ────────────────────────────────────────
    platformPrisma.userSession.findMany({
      where: { ...scope, endReason: "active", expiresAt: { gt: now } },
      orderBy: { lastSeenAt: "desc" },
    }),

    // ── Kunlik urinishlar ───────────────────────────────────────────
    platformPrisma.loginAttempt.groupBy({
      by: ["day", "success"],
      where: attemptWhere,
      _count: { _all: true },
    }),

    // ── Sabab kesimi ────────────────────────────────────────────────
    platformPrisma.loginAttempt.groupBy({
      by: ["reason"],
      where: attemptWhere,
      _count: { _all: true },
    }),

    // ── Ogohlantirish sanoqlari ─────────────────────────────────────
    // ⚠️ DAVR BO'YICHA FILTRLANMAYDI, RO'YXAT BILAN BIR XIL QAMROVDA.
    // Ro'yxat (`openAlerts`) barcha ochiq holatlarni beradi — u
    // "hal qilinmagan ish" degani va u davrga bog'liq emas. Sanoq
    // esa davr bilan chegaralansa, plitkada "0 ta ochiq" turib,
    // ostidagi ro'yxatda 12 ta qator ko'rinardi.
    platformPrisma.securityAlert.groupBy({
      by: ["status", "severity"],
      where: { ...scope, status: { in: ["open", "acknowledged"] } },
      _count: { _all: true },
    }),

    platformPrisma.securityAlert.groupBy({
      by: ["type"],
      where: { ...scope, day: { gte: period.from, lte: period.to } },
      _count: { _all: true },
    }),

    // Davr ichida yopilganlar — "qancha ish qilindi" ko'rsatkichi
    platformPrisma.securityAlert.count({
      where: { ...scope, status: "resolved", day: { gte: period.from, lte: period.to } },
    }),

    // ── Ochiq ogohlantirishlar ro'yxati ─────────────────────────────
    // ⚠️ Tartib: jiddiylik BO'YICHA emas, `severity` enum tartibida
    // Prisma saralay olmaydi — shuning uchun JS tomonida saralanadi.
    platformPrisma.securityAlert.findMany({
      where: { ...scope, status: { in: ["open", "acknowledged"] } },
      orderBy: { lastSeenAt: "desc" },
      take: 60,
    }),

    // ── Oxirgi urinishlar lentasi ───────────────────────────────────
    platformPrisma.loginAttempt.findMany({
      where: attemptWhere,
      orderBy: { createdAt: "desc" },
      take: 40,
    }),

    // ── Eng ko'p urinilgan IP lar ───────────────────────────────────
    platformPrisma.loginAttempt.groupBy({
      by: ["ip"],
      where: { ...attemptWhere, success: false },
      _count: { _all: true },
      orderBy: { _count: { ip: "desc" } },
      take: 8,
    }),

    // ── Qurilmalar ──────────────────────────────────────────────────
    // ⚠️ `take` YO'Q. Ro'yxatga faqat sakkiztasi chiqadi, lekin
    // "noyob qurilmalar" KPI si HAMMASINI sanashi kerak — kesilgan
    // so'rov o'sha raqamni hech qachon 8 dan oshirmasdi va
    // ko'rsatkich jimgina yolg'on aytardi. Qurilma turlari soni
    // tabiiy ravishda kichik (o'nlab), shuning uchun to'liq
    // ro'yxat xavfsiz.
    platformPrisma.userSession.groupBy({
      by: ["device"],
      where: { ...scope, createdAt: { gte: period.from } },
      _count: { _all: true },
      orderBy: { _count: { device: "desc" } },
    }),

    platformPrisma.loginAttempt.findFirst({
      where: scope,
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);

  /* ── Ismlar ─────────────────────────────────────────────────────── */
  const names = await loadNames([
    ...liveSessions.map((s) => s.userId),
    ...openAlerts.map((a) => a.userId),
    ...recentAttempts.map((a) => a.userId),
  ]);

  /* ── Bir vaqtda bir nechta seans ────────────────────────────────── */
  // ⚠️ QURILMA BO'YICHA, seans soni bo'yicha EMAS. Bir odam bitta
  // kompyuterda ikki marta login qilsa ham ikkita seans bo'ladi — u
  // ogohlantirish emas, shovqin.
  const byUser = new Map();
  for (const session of liveSessions) {
    if (!byUser.has(session.userId)) byUser.set(session.userId, []);
    byUser.get(session.userId).push(session);
  }

  const multiSession = [];
  for (const [userId, sessions] of byUser) {
    const origins = new Set(sessions.map((s) => `${s.ip}|${s.device}`));
    if (origins.size < 2) continue;

    multiSession.push({
      userId,
      name: names.get(userId)?.name ?? sessions[0].username ?? "Noma'lum",
      role: names.get(userId)?.role ?? null,
      sessions: sessions.length,
      origins: origins.size,
      items: sessions.map((s) => publicSession(s, names)),
    });
  }
  multiSession.sort((a, b) => b.origins - a.origins || b.sessions - a.sessions);

  /* ── Kunlik trend ───────────────────────────────────────────────── */
  const dayMap = new Map();
  for (const row of attemptsByDay) {
    const key = dayKey(row.day);
    const cell = dayMap.get(key) ?? { success: 0, failed: 0 };
    if (row.success) cell.success += row._count._all;
    else cell.failed += row._count._all;
    dayMap.set(key, cell);
  }

  const trend = [];
  for (let i = 0; i < period.days; i += 1) {
    const date = shiftDay(period.from, i);
    const key = dayKey(date);
    const cell = dayMap.get(key) ?? { success: 0, failed: 0 };
    trend.push({
      day: key,
      label: formatDateUz(date, { utc: true }),
      success: cell.success,
      failed: cell.failed,
      total: cell.success + cell.failed,
    });
  }

  const totalSuccess = trend.reduce((sum, row) => sum + row.success, 0);
  const totalFailed = trend.reduce((sum, row) => sum + row.failed, 0);

  /* ── Ogohlantirish sanoqlari ────────────────────────────────────── */
  const alerts = { open: 0, acknowledged: 0, resolved: 0 };
  const severity = { low: 0, medium: 0, high: 0, critical: 0 };

  for (const row of alertCounts) {
    alerts[row.status] = (alerts[row.status] ?? 0) + row._count._all;
    // Jiddiylik sanog'i faqat OCHIQ holatlar bo'yicha (so'rov ham
    // shundaylarini oladi): yopilgan "critical" ni qizil raqamda
    // ko'rsatish ekranni doim qonli qilardi
    severity[row.severity] = (severity[row.severity] ?? 0) + row._count._all;
  }

  // ⚠️ "Yopilgan" sanog'i DAVR bo'yicha va bu ataylab boshqacha:
  // "shu oy nechta holat hal qilindi" — bu ish hajmi ko'rsatkichi,
  // ochiq holatlar esa hozirgi qarz. Ikkalasi bir xil qamrovda
  // bo'lsa, yillar davomida yopilgan hammasi bitta raqamga
  // yig'ilib, ma'nosini yo'qotardi.
  alerts.resolved = resolvedCount;

  const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
  const sortedAlerts = [...openAlerts].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      b.lastSeenAt - a.lastSeenAt,
  );

  /* ── Bugun ──────────────────────────────────────────────────────── */
  const todayKey = dayKey(today);
  const todayCell = dayMap.get(todayKey) ?? { success: 0, failed: 0 };

  return {
    period: {
      days: period.days,
      from: dayKey(period.from),
      to: dayKey(period.to),
      fromLabel: formatDateUz(period.from, { utc: true }),
      toLabel: formatDateUz(period.to, { utc: true }),
      options: PERIODS,
    },

    scope: {
      allBranches: hasRole(actor, ROLES.OWNER),
      branchId: branch?.id ?? null,
      branchName: branch?.name ?? null,
    },

    collecting: !firstAttempt || firstAttempt.createdAt > period.from,
    since: firstAttempt?.createdAt ?? null,
    sinceLabel: firstAttempt ? formatDateUz(firstAttempt.createdAt) : null,

    now: {
      liveSessions: liveSessions.length,
      liveUsers: byUser.size,
      multiSessionUsers: multiSession.length,
      openAlerts: alerts.open,
      criticalAlerts: severity.critical,
      todaySuccess: todayCell.success,
      todayFailed: todayCell.failed,
    },

    metrics: [
      {
        key: "liveSessions",
        label: "Ochiq seanslar",
        value: liveSessions.length,
        unit: "",
        tone: "session",
        hint: `${byUser.size} ta foydalanuvchi hozir tizimda`,
        higherIsBetter: null,
      },
      {
        key: "multiSession",
        label: "Bir nechta seansli hisob",
        value: multiSession.length,
        unit: "",
        tone: "alert",
        hint: "Turli qurilmalardan bir vaqtda kirilgan hisoblar",
        higherIsBetter: false,
      },
      {
        key: "failedRate",
        label: "Muvaffaqiyatsiz urinish",
        value: rate(totalFailed, totalSuccess + totalFailed),
        unit: "%",
        tone: "warn",
        hint: `${totalFailed} ta urinish ${totalSuccess + totalFailed} tadan`,
        higherIsBetter: false,
      },
      {
        key: "openAlerts",
        label: "Ochiq ogohlantirishlar",
        value: alerts.open,
        unit: "",
        tone: "alert",
        hint: `${severity.critical} ta jiddiy`,
        higherIsBetter: false,
      },
      {
        key: "devices",
        label: "Noyob qurilmalar",
        value: devices.length,
        unit: "",
        tone: "device",
        hint: "Davr ichida kirish uchun ishlatilgan qurilmalar",
        higherIsBetter: null,
      },
      {
        key: "logins",
        label: "Muvaffaqiyatli kirishlar",
        value: totalSuccess,
        unit: "",
        tone: "neutral",
        hint: "Davr ichidagi jami kirishlar",
        higherIsBetter: null,
      },
    ],

    trend,

    alerts: {
      counts: alerts,
      severity,
      byType: Object.keys(ALERT_META).map((type) => ({
        key: type,
        label: ALERT_META[type].label,
        hint: ALERT_META[type].hint,
        count: alertsByType.find((row) => row.type === type)?._count._all ?? 0,
      })),
      // ⚠️ `meta` ichida IP va qurilma ro'yxati bor — `security.sessions`
      // siz u ham chiqmasligi kerak. Sarlavha va tafsilot qoladi:
      // ular "nima bo'ldi" ni aytadi, "qayerdan" ni emas.
      items: sortedAlerts.map((row) => {
        const alert = publicAlert(row, names);
        return withDetails ? alert : { ...alert, meta: null };
      }),
    },

    // ⚠️ `available` bayrog'i — ekran "ruxsat yo'q" holatini
    // "ma'lumot yo'q" dan ajrata olishi uchun. Bo'sh massiv yuborib
    // qo'ysak, foydalanuvchi "hech kim tizimda emas" deb o'ylardi.
    sessions: {
      available: withDetails,
      live: withDetails
        ? liveSessions.slice(0, 60).map((row) => publicSession(row, names))
        : [],
      total: liveSessions.length,
      multiSession: withDetails ? multiSession : [],
      multiSessionCount: multiSession.length,
    },

    attempts: {
      available: withDetails,
      success: totalSuccess,
      failed: totalFailed,
      byReason: attemptsByReason
        .map((row) => ({
          key: row.reason,
          label: REASON_LABELS[row.reason] ?? row.reason,
          count: row._count._all,
        }))
        .sort((a, b) => b.count - a.count),
      recent: (withDetails ? recentAttempts : []).map((row) => ({
        id: row.id,
        username: row.username,
        name: row.userId ? (names.get(row.userId)?.name ?? row.username) : row.username,
        userId: row.userId,
        success: row.success,
        reason: row.reason,
        reasonLabel: REASON_LABELS[row.reason] ?? row.reason,
        ip: row.ip,
        device: row.device || "Noma'lum qurilma",
        channel: row.channel,
        createdAt: row.createdAt,
        createdLabel: formatDateTimeUz(row.createdAt),
      })),
      topIps: (withDetails ? topIps : [])
        .filter((row) => row.ip)
        .map((row) => ({ ip: row.ip, count: row._count._all })),
    },

    // Ro'yxat qisqartiriladi (ekranga sig'ishi kerak), KPI esa
    // to'liq sanoqni oladi — `metrics` dagi `devices.length`
    devices: (withDetails ? devices : [])
      .filter((row) => row.device)
      .slice(0, 8)
      .map((row) => ({ device: row.device, count: row._count._all })),
  };
}

/* ═══════════════════════ RO'YXATLAR ═══════════════════════ */

/**
 * SEANSLAR RO'YXATI — sahifalangan, filtrlanadigan.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
async function listSessions({
  actor,
  branch,
  status = "live",
  userId,
  page = 1,
  limit = 30,
} = {}) {
  const scope = branchScope(actor, branch);
  const take = Math.min(Number(limit) || 30, 100);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const where = { ...scope };
  if (userId) where.userId = userId;

  if (status === "live") {
    where.endReason = "active";
    where.expiresAt = { gt: new Date() };
  } else if (status === "ended") {
    where.endReason = { not: "active" };
  }

  const [rows, total] = await Promise.all([
    platformPrisma.userSession.findMany({
      where,
      orderBy: { lastSeenAt: "desc" },
      skip,
      take,
    }),
    platformPrisma.userSession.count({ where }),
  ]);

  const names = await loadNames(rows.map((row) => row.userId));

  return {
    items: rows.map((row) => publicSession(row, names)),
    pagination: { page: Number(page) || 1, limit: take, total, pages: Math.ceil(total / take) },
  };
}

/**
 * OGOHLANTIRISHLAR RO'YXATI.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
async function listAlerts({
  actor,
  branch,
  status,
  severity,
  type,
  page = 1,
  limit = 30,
} = {}) {
  const scope = branchScope(actor, branch);
  const take = Math.min(Number(limit) || 30, 100);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const where = { ...scope };
  if (status) where.status = status;
  if (severity) where.severity = severity;
  if (type) where.type = type;

  const [rows, total] = await Promise.all([
    platformPrisma.securityAlert.findMany({
      where,
      orderBy: { lastSeenAt: "desc" },
      skip,
      take,
    }),
    platformPrisma.securityAlert.count({ where }),
  ]);

  const names = await loadNames(rows.map((row) => row.userId));

  return {
    items: rows.map((row) => publicAlert(row, names)),
    pagination: { page: Number(page) || 1, limit: take, total, pages: Math.ceil(total / take) },
  };
}

/**
 * KIRISH URINISHLARI RO'YXATI.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
async function listAttempts({
  actor,
  branch,
  success,
  username,
  page = 1,
  limit = 30,
} = {}) {
  const scope = branchScope(actor, branch);
  const take = Math.min(Number(limit) || 30, 100);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const where = { ...scope };
  if (success === "true" || success === true) where.success = true;
  if (success === "false" || success === false) where.success = false;
  if (username) where.username = { contains: String(username), mode: "insensitive" };

  const [rows, total] = await Promise.all([
    platformPrisma.loginAttempt.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    platformPrisma.loginAttempt.count({ where }),
  ]);

  const names = await loadNames(rows.map((row) => row.userId));

  return {
    items: rows.map((row) => ({
      id: row.id,
      username: row.username,
      name: row.userId ? (names.get(row.userId)?.name ?? row.username) : row.username,
      userId: row.userId,
      success: row.success,
      reason: row.reason,
      reasonLabel: REASON_LABELS[row.reason] ?? row.reason,
      ip: row.ip,
      device: row.device || "Noma'lum qurilma",
      channel: row.channel,
      createdAt: row.createdAt,
      createdLabel: formatDateTimeUz(row.createdAt),
    })),
    pagination: { page: Number(page) || 1, limit: take, total, pages: Math.ceil(total / take) },
  };
}

/* ═══════════════════════ AMALLAR ═══════════════════════ */

/**
 * SEANSNI MAJBURAN TUGATISH.
 *
 * ⚠️ Bu boshqa odamning ISHINI UZADI — shuning uchun `security.revoke`
 * alohida ruxsat. `auth.middleware` yopilgan seansni 2 daqiqa ichida
 * rad eta boshlaydi (`SEEN_WINDOW_MS`).
 *
 * @param {string} sessionId
 * @param {object} actor
 * @param {object} branch
 * @returns {Promise<object>}
 */
async function revokeSession(sessionId, actor, branch) {
  const session = await platformPrisma.userSession.findUnique({
    where: { id: sessionId },
  });
  if (!session) throw new NotFoundError("Seans topilmadi");

  // Filial darvozasi — ro'yxatdagi bilan bir xil qoida
  if (!hasRole(actor, ROLES.OWNER) && session.branchId !== branch?.id) {
    throw new NotFoundError("Seans topilmadi");
  }

  if (session.endReason !== "active") {
    throw new BadRequestError("Bu seans allaqachon tugatilgan");
  }

  await securityService.closeSession({
    sessionId,
    reason: "revoked",
    actorId: actor.id,
  });

  const updated = await platformPrisma.userSession.findUnique({
    where: { id: sessionId },
  });
  const names = await loadNames([updated.userId]);

  return publicSession(updated, names);
}

/**
 * FOYDALANUVCHINING BARCHA SEANSLARINI TUGATISH.
 *
 * "Parol tarqalgan" holatida bitta tugma bilan hammasini yopish kerak
 * bo'ladi — har seansni alohida bosish o'sha lahzada ochilgan yangisini
 * qoldirib ketardi.
 *
 * @param {string} userId
 * @param {object} actor
 * @param {object} branch
 * @returns {Promise<{ closed: number }>}
 */
async function revokeUserSessions(userId, actor, branch) {
  // ⚠️ FILIAL BILAN CHEGARALANMAYDI (owner uchun ham, xavfsizlik
  // xodimi uchun ham). Bu tugma "parol tarqaldi" holati uchun va
  // o'sha paytda odamning BOSHQA filialdagi ochiq seansini qoldirib
  // ketish tugmaning butun ma'nosini yo'qotardi: hujumchi o'sha
  // seans bilan ishlashda davom etardi.
  //
  // ⚠️ Bu filial chegarasini buzmaydi: yopish — ma'lumotni KO'RSATISH
  // emas. Xodim boshqa filialning seans TAFSILOTINI baribir ko'rmaydi
  // (`branchScope`), faqat "hammasini yop" degan buyruq beradi.
  // ⚠️ LEKIN NISHONNI KO'RA OLISHI SHART. Aks holda A filialidagi
  // xavfsizlik xodimi ixtiyoriy `userId` yuborib, B filialidagi
  // notanish odamni tizimdan chiqarib yuborardi. Owner istisno —
  // u hamma filialga ega.
  if (!hasRole(actor, ROLES.OWNER)) {
    const visible = await platformPrisma.userSession.findFirst({
      where: { userId, branchId: branch?.id ?? "__none__" },
      select: { id: true },
    });
    if (!visible) throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  const where = { userId, endReason: "active" };

  const { count } = await platformPrisma.userSession.updateMany({
    where,
    data: { endReason: "revoked", endedAt: new Date(), endedBy: actor.id },
  });

  // ⚠️ Xotiradagi "ko'rindi" oynasi TOZALANADI. `updateMany` uni chetlab
  // o'tdi, tozalanmasa yopilgan seanslar yana 2 daqiqa davomida o'tib
  // ketardi va tugma "ishlamagandek" ko'rinardi.
  if (count > 0) securityService.forgetSeenCache();

  return { closed: count };
}

/**
 * OGOHLANTIRISH HOLATINI O'ZGARTIRISH.
 *
 * @param {string} alertId
 * @param {object} params
 * @param {string} params.status - "acknowledged" | "resolved" | "open"
 * @param {string} [params.note]
 * @param {object} params.actor
 * @param {object} params.branch
 * @returns {Promise<object>}
 */
async function updateAlert(alertId, { status, note, actor, branch }) {
  const allowed = ["open", "acknowledged", "resolved"];
  if (!allowed.includes(status)) {
    throw new BadRequestError("Holat noto'g'ri");
  }

  const alert = await platformPrisma.securityAlert.findUnique({
    where: { id: alertId },
  });
  if (!alert) throw new NotFoundError("Ogohlantirish topilmadi");

  if (!hasRole(actor, ROLES.OWNER) && alert.branchId !== branch?.id) {
    throw new NotFoundError("Ogohlantirish topilmadi");
  }

  const now = new Date();

  const updated = await platformPrisma.securityAlert.update({
    where: { id: alertId },
    data: {
      status,
      note: note != null ? String(note).slice(0, 2000) : alert.note,
      acknowledgedBy: status === "open" ? null : actor.id,
      acknowledgedAt: status === "open" ? null : (alert.acknowledgedAt ?? now),
      resolvedAt: status === "resolved" ? now : null,
    },
  });

  const names = await loadNames([updated.userId]);
  return publicAlert(updated, names);
}

/**
 * BITTA FOYDALANUVCHINING XAVFSIZLIK KARTASI.
 *
 * @param {string} userId
 * @param {object} params
 * @returns {Promise<object>}
 */
async function getUserSecurity(userId, { actor, branch, days } = {}) {
  const period = resolvePeriod({ days });
  const scope = branchScope(actor, branch);

  const [profile, sessions, attempts, alerts] = await Promise.all([
    prisma.user
      .findUnique({
        where: { id: userId },
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
          role: true,
          extraRoles: true,
        },
      })
      .catch(() => null),
    platformPrisma.userSession.findMany({
      where: { ...scope, userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    platformPrisma.loginAttempt.findMany({
      where: { ...scope, userId, createdAt: { gte: period.from } },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    platformPrisma.securityAlert.findMany({
      where: { ...scope, userId },
      orderBy: { lastSeenAt: "desc" },
      take: 30,
    }),
  ]);

  if (!profile && sessions.length === 0) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  const names = await loadNames([userId]);
  const now = new Date();

  return {
    user: profile
      ? {
          id: profile.id,
          username: profile.username,
          name: `${profile.firstName || ""} ${profile.lastName || ""}`.trim(),
          role: profile.role,
          extraRoles: profile.extraRoles || [],
        }
      : { id: userId, name: names.get(userId)?.name ?? "Noma'lum" },

    live: sessions
      .filter((s) => s.endReason === "active" && s.expiresAt > now)
      .map((s) => publicSession(s, names)),

    history: sessions.map((s) => publicSession(s, names)),

    devices: [
      ...new Set(sessions.map((s) => s.device).filter(Boolean)),
    ].map((device) => ({
      device,
      count: sessions.filter((s) => s.device === device).length,
      lastAt: sessions.find((s) => s.device === device)?.createdAt ?? null,
    })),

    attempts: attempts.map((row) => ({
      id: row.id,
      success: row.success,
      reason: row.reason,
      reasonLabel: REASON_LABELS[row.reason] ?? row.reason,
      ip: row.ip,
      device: row.device || "Noma'lum qurilma",
      createdAt: row.createdAt,
      createdLabel: formatDateTimeUz(row.createdAt),
    })),

    alerts: alerts.map((row) => publicAlert(row, names)),
  };
}

module.exports = {
  PERIODS,
  ALERT_META,
  REASON_LABELS,
  END_REASON_LABELS,
  getOverview,
  listSessions,
  listAlerts,
  listAttempts,
  revokeSession,
  revokeUserSessions,
  updateAlert,
  getUserSecurity,
};
