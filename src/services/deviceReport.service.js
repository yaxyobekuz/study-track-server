/**
 * QURILMA NAZORATI — MANZARA VA HISOBOTLAR.
 *
 * ⚠️ HISOBOT ALOHIDA RUXSAT ORTIDA (`devices.reports`). Qurilmalar
 * ro'yxatini ko'rish (`devices.view`) — texnik ish ("telefon ulanganmi,
 * himoya ishlayaptimi"), bolaning qaysi ilovada qancha o'tirgani esa
 * SHAXSIY MA'LUMOT. `security.view` va `security.sessions` ajratilgani
 * bilan AYNI mulohaza.
 *
 * ⚠️ FAQAT YIG'MA KO'RSATILADI: kun + ilova + daqiqa. "Soat nechada
 * ochdi" degan kesim YO'Q va qo'shilmaydi — buning uchun ma'lumot ham
 * saqlanmaydi (`devices.md` §0.2).
 *
 * ⚠️ ARXIVLANGAN O'QUVCHI ro'yxatlarda ko'rinmaydi (`education.md` §4):
 * u maktab o'quvchisi emas va uning telefoni ham bizning ishimiz emas.
 */

const prisma = require("../config/prisma");
const { ROLES } = require("../utils/constants");
const { isValidId } = require("../utils/objectId");
const { BadRequestError } = require("../utils/errors");
const {
  tashkentDayDate,
  formatClock,
  deviceHealth,
} = require("../helpers/devicePolicy.helpers");
const { getDeviceSettings } = require("./settings.service");
const devicePolicyService = require("./devicePolicy.service");
const deviceAudit = require("./deviceAudit.service");

/** Hisobot oynasi — sukut va chegara. */
const DEFAULT_RANGE_DAYS = 7;
const MAX_RANGE_DAYS = 92;

/**
 * Kunlar oralig'i (Toshkent kunlari, UTC yarim tunida, IKKALASI
 * INKLYUZIV — `GradeAnalysisRun` bilan bir xil shakl).
 */
function parseRange(query = {}) {
  const today = tashkentDayDate(new Date());

  const days = Math.min(
    Math.max(Number(query.days) || DEFAULT_RANGE_DAYS, 1),
    MAX_RANGE_DAYS,
  );

  const to = query.to ? new Date(`${String(query.to).slice(0, 10)}T00:00:00.000Z`) : today;
  if (Number.isNaN(to.getTime())) throw new BadRequestError("Oxirgi kun noto'g'ri");

  const from = query.from
    ? new Date(`${String(query.from).slice(0, 10)}T00:00:00.000Z`)
    : new Date(to.getTime() - (days - 1) * 86400000);
  if (Number.isNaN(from.getTime())) throw new BadRequestError("Boshlanish kuni noto'g'ri");

  if (from > to) throw new BadRequestError("Boshlanish kuni oxirgi kundan keyin bo'lmasin");
  if ((to - from) / 86400000 > MAX_RANGE_DAYS) {
    throw new BadRequestError(`Oraliq ko'pi bilan ${MAX_RANGE_DAYS} kun`);
  }

  return { from, to, days: Math.round((to - from) / 86400000) + 1 };
}

/** `Date` → "YYYY-MM-DD" (`@db.Date` — faqat `getUTC*`, `dates.md` §4). */
const dayKey = (date) => new Date(date).toISOString().slice(0, 10);

/** Daqiqa → "2 s 15 daq" (panelda qisqa yorliq). */
function humanMinutes(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total < 60) return `${total} daq`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours} s` : `${hours} s ${rest} daq`;
}

/**
 * DASHBOARD — "hammasi joyidami?".
 *
 * ⚠️ QAMROV HAQIQIY YECHIMDAN hisoblanadi (`resolveForStudents`), ya'ni
 * "nechta o'quvchida chekov bor" raqami biriktirishlar sonidan emas,
 * AMALDA qo'llanayotgan siyosatdan chiqadi. Aks holda maktab siyosati
 * biriktirilgan-u, hammaga shaxsiy istisno berilgan holat "100% qamrov"
 * bo'lib ko'rinardi.
 */
async function getDashboard(query = {}) {
  const { from, to, days } = parseRange({ days: query.days || DEFAULT_RANGE_DAYS });
  const today = tashkentDayDate(new Date());

  const [settings, students, devices, unlockCount, auditTrail] = await Promise.all([
    getDeviceSettings(),
    prisma.user.findMany({
      where: { role: ROLES.STUDENT, isArchived: false },
      select: { id: true },
    }),
    prisma.studentDevice.findMany({
      where: { status: { not: "removed" } },
      select: {
        id: true,
        studentId: true,
        status: true,
        enforcing: true,
        lastSeenAt: true,
        platform: true,
      },
    }),
    prisma.deviceUnlock.count({ where: { status: "active", endsAt: { gt: new Date() } } }),
    deviceAudit.list({ limit: 12 }),
  ]);

  const studentIds = students.map((s) => s.id);
  const resolved = await devicePolicyService.resolveForStudents(studentIds);

  // ── Qamrov ──
  const covered = [...resolved.values()].filter((row) => row.policyId).length;
  const byPolicy = new Map();
  for (const row of resolved.values()) {
    if (!row.policyId) continue;
    const entry = byPolicy.get(row.policyId) || { policyId: row.policyId, name: row.policyName, students: 0 };
    entry.students += 1;
    byPolicy.set(row.policyId, entry);
  }

  // ── Qurilmalar holati ──
  const health = { healthy: 0, degraded: 0, offline: 0, paused: 0, pending: 0 };
  const platforms = { android: 0, ios: 0 };
  for (const device of devices) {
    const key = deviceHealth(device, settings.offlineGraceMinutes).key;
    if (health[key] !== undefined) health[key] += 1;
    if (platforms[device.platform] !== undefined) platforms[device.platform] += 1;
  }

  const studentsWithDevice = new Set(devices.map((d) => d.studentId)).size;

  // ── Ekran vaqti ──
  const [todayRows, trendRows, topRows] = await Promise.all([
    prisma.deviceUsageDay.aggregate({
      where: { day: today },
      _sum: { minutes: true, blocked: true },
    }),
    prisma.deviceUsageDay.groupBy({
      by: ["day"],
      where: { day: { gte: from, lte: to } },
      _sum: { minutes: true },
      orderBy: { day: "asc" },
    }),
    prisma.deviceUsageDay.groupBy({
      by: ["appKey"],
      where: { day: { gte: from, lte: to } },
      _sum: { minutes: true },
      orderBy: { _sum: { minutes: "desc" } },
      // ⚠️ 8 EMAS, kengroq olamiz: bitta ilova ikki identifikator bilan
      // kelishi mumkin va yig'ilgandan KEYIN sakkiztasi tanlanadi.
      take: 24,
    }),
  ]);

  const appMap = await resolveApps(topRows.map((r) => r.appKey));

  const todayMinutes = todayRows._sum.minutes || 0;
  const activeToday = await prisma.deviceUsageDay
    .groupBy({ by: ["studentId"], where: { day: today }, _sum: { minutes: true } })
    .then((rows) => rows.length);

  return {
    enabled: settings.enabled,
    range: { from: dayKey(from), to: dayKey(to), days },
    coverage: {
      students: studentIds.length,
      covered,
      uncovered: studentIds.length - covered,
      percent: studentIds.length ? Math.round((covered / studentIds.length) * 100) : 0,
      byPolicy: [...byPolicy.values()].sort((a, b) => b.students - a.students),
    },
    devices: {
      total: devices.length,
      studentsWithDevice,
      // ⚠️ Chekov ostida-yu qurilmasi yo'q o'quvchi — MUAMMO, chunki
      // siyosat qog'ozda bor, telefonda esa yo'q. Alohida ko'rsatiladi.
      coveredWithoutDevice: Math.max(0, covered - studentsWithDevice),
      health,
      platforms,
    },
    today: {
      totalMinutes: todayMinutes,
      totalLabel: humanMinutes(todayMinutes),
      blockedAttempts: todayRows._sum.blocked || 0,
      activeStudents: activeToday,
      avgMinutes: activeToday ? Math.round(todayMinutes / activeToday) : 0,
    },
    trend: trendRows.map((row) => ({
      day: dayKey(row.day),
      minutes: row._sum.minutes || 0,
    })),
    topApps: mergeByApp(topRows, appMap).slice(0, 8),
    activeUnlocks: unlockCount,
    audit: auditTrail,
  };
}

/**
 * Xom identifikatorlarni katalogdagi ilovaga bog'laydi.
 * @returns {Promise<Map<string, {id: string, name: string}>>}
 */
async function resolveApps(keys = []) {
  const unique = [...new Set(keys.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const apps = await prisma.deviceApp.findMany({
    where: { OR: [{ androidPackage: { in: unique } }, { iosBundleId: { in: unique } }] },
    select: { id: true, name: true, androidPackage: true, iosBundleId: true },
  });

  const map = new Map();
  for (const app of apps) {
    const entry = { id: app.id, name: app.name };
    if (app.androidPackage) map.set(app.androidPackage, entry);
    if (app.iosBundleId) map.set(app.iosBundleId, entry);
  }
  return map;
}

/**
 * ILOVA BO'YICHA YIG'ADI — xom identifikator bo'yicha EMAS.
 *
 * ⚠️ BITTA ILOVA IKKI QATOR BO'LIB KO'RINMASLIGI KERAK. Android va iOS
 * identifikatorlari boshqa-boshqa (`com.google.android.youtube` va
 * `com.google.ios.youtube`), lekin ODAM UCHUN bu bitta "YouTube".
 * Yig'masdan ko'rsatilsa, ro'yxatda ikkita "YouTube" yonma-yon turardi
 * va "eng ko'p ishlatilgan ilova" reytingi ham noto'g'ri chiqardi —
 * ikkiga bo'lingan vaqt uchinchi ilovadan past tushib qolishi mumkin.
 *
 * Katalogda yo'q identifikator o'z holicha qoladi (guruhlash kaliti —
 * o'sha identifikatorning o'zi).
 *
 * @param {Array} rows - `groupBy(["appKey"])` natijasi
 * @param {Map} appMap - `resolveApps` natijasi
 */
function mergeByApp(rows, appMap) {
  const merged = new Map();

  for (const row of rows) {
    const app = appMap.get(row.appKey);
    const key = app?.id || row.appKey;

    const entry = merged.get(key) || {
      appKey: row.appKey,
      name: app?.name || row.appKey,
      minutes: 0,
      opens: 0,
      blocked: 0,
    };
    entry.minutes += row._sum?.minutes || 0;
    entry.opens += row._sum?.opens || 0;
    entry.blocked += row._sum?.blocked || 0;
    merged.set(key, entry);
  }

  return [...merged.values()]
    .sort((a, b) => b.minutes - a.minutes)
    .map((row) => ({ ...row, label: humanMinutes(row.minutes) }));
}

/**
 * FOYDALANISH HISOBOTI — o'quvchi va ilova kesimlari.
 *
 * ⚠️ Ikkala kesim BITTA so'rovda qaytadi: panel ularni yonma-yon
 * ko'rsatadi va ikki alohida so'rov bo'lsa filtrlar orasida
 * nomuvofiqlik paydo bo'lardi ("ilovalar 7 kunlik, o'quvchilar 30
 * kunlik").
 */
async function getUsageReport(query = {}) {
  const { from, to, days } = parseRange(query);

  const where = {
    day: { gte: from, lte: to },
    ...(isValidId(query.studentId) ? { studentId: query.studentId } : {}),
  };

  // Sinf bo'yicha filtr — o'quvchilar ro'yxatiga aylantiriladi.
  if (isValidId(query.classId)) {
    const members = await prisma.userClass.findMany({
      where: { classId: query.classId },
      select: { userId: true },
    });
    where.studentId = { in: members.map((m) => m.userId) };
  }

  // O'quvchi qidiruvi — `listDevices` bilan AYNI naqsh: `studentId` soft
  // ref, shuning uchun avval ismga mos o'quvchilar topiladi.
  const search = String(query.search || "").trim();
  if (search) {
    const matched = await prisma.user.findMany({
      where: {
        role: ROLES.STUDENT,
        OR: [
          { firstName: { contains: search, mode: "insensitive" } },
          { lastName: { contains: search, mode: "insensitive" } },
        ],
      },
      select: { id: true },
      take: 500,
    });
    // ⚠️ Mavjud filtr bilan KESISHTIRILADI, ustiga yozilmaydi: sinf
    // tanlangan holda qidirilsa, natija ikkala shartga ham mos kelishi
    // kerak (aks holda qidiruv sinf filtrini jimgina bekor qilardi).
    let ids = matched.map((u) => u.id);
    if (typeof where.studentId === "string") {
      ids = ids.filter((id) => id === where.studentId);
    } else if (where.studentId?.in) {
      const allowed = new Set(where.studentId.in);
      ids = ids.filter((id) => allowed.has(id));
    }
    where.studentId = { in: ids };
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 200);

  const [byStudent, byApp, byDay, totals, studentTotal] = await Promise.all([
    prisma.deviceUsageDay.groupBy({
      by: ["studentId"],
      where,
      _sum: { minutes: true, opens: true, blocked: true },
      orderBy: { _sum: { minutes: "desc" } },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.deviceUsageDay.groupBy({
      by: ["appKey"],
      where,
      _sum: { minutes: true, opens: true, blocked: true },
      orderBy: { _sum: { minutes: "desc" } },
      take: 50,
    }),
    prisma.deviceUsageDay.groupBy({
      by: ["day"],
      where,
      _sum: { minutes: true },
      orderBy: { day: "asc" },
    }),
    prisma.deviceUsageDay.aggregate({ where, _sum: { minutes: true, blocked: true } }),
    // ⚠️ Guruhlar SONI — `groupBy` uni bermaydi, shuning uchun alohida
    // so'rov. Usiz sahifalagich nechta sahifa borligini bilmasdi.
    prisma.deviceUsageDay
      .groupBy({ by: ["studentId"], where, _count: { _all: true } })
      .then((rows) => rows.length),
  ]);

  const [students, appMap] = await Promise.all([
    byStudent.length
      ? prisma.user.findMany({
          where: { id: { in: byStudent.map((r) => r.studentId) } },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            isArchived: true,
            classes: { select: { class: { select: { name: true } } } },
          },
        })
      : [],
    resolveApps(byApp.map((r) => r.appKey)),
  ]);

  const studentMap = new Map(students.map((s) => [s.id, s]));
  const policyMap = await devicePolicyService.resolveForStudents(byStudent.map((r) => r.studentId));

  return {
    range: { from: dayKey(from), to: dayKey(to), days },
    // ⚠️ O'quvchilar kesimi SAHIFALANADI, ilovalar va kunlik dinamika esa
    // yo'q: birinchisi maktab kattaligicha o'sadi, qolgan ikkitasi
    // tabiiy chegaralangan (ilovalar katalogi va davr uzunligi).
    pagination: {
      page,
      limit,
      total: studentTotal,
      totalPages: Math.max(1, Math.ceil(studentTotal / limit)),
      hasNextPage: page * limit < studentTotal,
      hasPrevPage: page > 1,
    },
    totals: {
      minutes: totals._sum.minutes || 0,
      label: humanMinutes(totals._sum.minutes || 0),
      blocked: totals._sum.blocked || 0,
      avgPerDay: days ? Math.round((totals._sum.minutes || 0) / days) : 0,
    },
    byDay: byDay.map((row) => ({ day: dayKey(row.day), minutes: row._sum.minutes || 0 })),
    byApp: mergeByApp(byApp, appMap),
    byStudent: byStudent
      // Arxivlangan o'quvchi ro'yxatda ko'rinmaydi (`education.md` §4).
      .filter((row) => !studentMap.get(row.studentId)?.isArchived)
      .map((row) => {
        const student = studentMap.get(row.studentId);
        return {
          studentId: row.studentId,
          firstName: student?.firstName || "—",
          lastName: student?.lastName || "",
          className: student?.classes?.[0]?.class?.name || null,
          policyName: policyMap.get(row.studentId)?.policyName || null,
          minutes: row._sum.minutes || 0,
          label: humanMinutes(row._sum.minutes || 0),
          avgPerDay: days ? Math.round((row._sum.minutes || 0) / days) : 0,
          opens: row._sum.opens || 0,
          blocked: row._sum.blocked || 0,
        };
      }),
  };
}

/**
 * BITTA O'QUVCHI — qurilmalari, amaldagi siyosati, oxirgi kunlari.
 * Panel "o'quvchi kartasi" oynasida shuni ko'rsatadi.
 */
async function getStudentOverview(studentId, query = {}) {
  if (!isValidId(studentId)) throw new BadRequestError("O'quvchi id si noto'g'ri");

  const { from, to } = parseRange(query);

  const [student, devices, resolved, usage, unlocks, settings] = await Promise.all([
    prisma.user.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        isArchived: true,
        classes: { select: { class: { select: { id: true, name: true } } } },
      },
    }),
    prisma.studentDevice.findMany({
      where: { studentId },
      orderBy: [{ status: "asc" }, { enrolledAt: "desc" }],
    }),
    devicePolicyService.resolveForStudent(studentId),
    prisma.deviceUsageDay.groupBy({
      by: ["appKey"],
      where: { studentId, day: { gte: from, lte: to } },
      _sum: { minutes: true, blocked: true },
      orderBy: { _sum: { minutes: "desc" } },
      take: 20,
    }),
    prisma.deviceUnlock.findMany({
      where: { studentId },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { app: { select: { name: true } } },
    }),
    getDeviceSettings(),
  ]);

  if (!student) throw new BadRequestError("O'quvchi topilmadi");

  const appMap = await resolveApps(usage.map((r) => r.appKey));

  return {
    student: {
      ...student,
      className: student.classes?.[0]?.class?.name || null,
    },
    devices: devices.map((device) => ({
      ...device,
      health: deviceHealth(device, settings.offlineGraceMinutes),
    })),
    policy: resolved.policy
      ? {
          id: resolved.policy.id,
          name: resolved.policy.name,
          version: resolved.policy.version,
          defaultMode: resolved.policy.defaultMode,
          dailyLimitMinutes: resolved.policy.dailyLimitMinutes,
          appCount: resolved.policy.apps?.length || 0,
          windows: (resolved.policy.windows || []).map((w) => ({
            weekday: w.weekday,
            start: formatClock(w.startMinute),
            end: formatClock(w.endMinute),
          })),
        }
      : null,
    // ⚠️ "Nega shu siyosat" — har doim ko'rsatiladi (`devices.md` §4).
    policyReason: resolved.reason,
    usage: mergeByApp(usage, appMap),
    unlocks,
    audit: await deviceAudit.list({ studentId, limit: 20 }),
  };
}

module.exports = {
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  parseRange,
  humanMinutes,
  getDashboard,
  getUsageReport,
  getStudentOverview,
  resolveApps,
  mergeByApp,
};
