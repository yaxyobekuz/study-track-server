/**
 * AI YORDAMCHI — "overview" bo'limi: butun platforma bo'yicha YIG'MA manzara.
 *
 * Bu bo'lim chuqur tahlil qilmaydi — u "qayerga qarash kerak" degan savolga
 * javob beradi. Har bir bo'lim mavjud o'qish servislaridan bir necha raqam
 * oladi, deterministik chegaralar bilan baholaydi va model keyin tegishli
 * vosita to'plamini (`finance`, `payroll`, ...) ochib chuqurlashadi.
 *
 * ⚠️ CHEGARALAR KODDA, MODELDA EMAS. "Yig'ilish 68% — yomonmi?" degan savolni
 * model har safar boshqacha hal qilardi va bir xil ma'lumotga ikki xil xulosa
 * chiqardi. Shu sababli har bir chegara pastda doimiy sifatida turadi va
 * yonida NIMA UCHUN shu son ekani yozilgan.
 *
 * ⚠️ HECH BIR BO'LIM BUTUN TAHLILNI YIQITMAYDI. Har bo'lim o'z vaqt
 * chegarasi bilan alohida ishlaydi: sekin yoki buzilgan bo'lim
 * `status: "unavailable"` va sababi bilan qaytadi, qolganlari baribir chiqadi.
 * Aks holda bitta buzuq servis (masalan, moliyaviy rekonsiler) "to'liq tahlil"
 * tugmasini butunlay ishlatib bo'lmaydigan qilardi.
 */

const prisma = require("../../../config/prisma");
const platformPrisma = require("../../../config/platformPrisma");
const { getBranch } = require("../../../config/branchContext");
const logger = require("../../../utils/logger");
const { ROLES } = require("../../../utils/constants");
const { mapBranches } = require("../../../helpers/branchIterator");
const { Decimal, sumAmounts, formatAmount } = require("../../../helpers/money.helpers");
const {
  currentDayOfMonth,
  daysInCurrentMonth,
  prevMonth,
  diffMonths,
  shiftIsoDays,
} = require("../../../helpers/month.helpers");
const { formatDateUz, formatDateTimeUz } = require("../../../helpers/date.helpers");
const { buildFacts } = require("../../../helpers/academicFacts");
const { GOOD_ATTENDANCE_RATE, LOW_TASK_COMPLETION } = require("../../../helpers/academicInsights");
const { conflictsInState } = require("../../../helpers/scheduleState.helpers");

const settingsService = require("../../settings.service");
const invoiceService = require("../../invoice.service");
const payrollService = require("../../payroll.service");
const { resolveSalariesForMonth } = require("../../staffSalary.service");
const payrollRequestService = require("../../payrollRequest.service");
const expenseBudgetService = require("../../expenseBudget.service");
const academicDashboardService = require("../../academicDashboard.service");
const { currentWeekStart } = require("../../academicInsight.service");
const studentAttendanceService = require("../../studentAttendance.service");
const attendanceService = require("../../attendance.service");
const { getMonthCalendar } = require("../../lessonHours.service");
const scheduleSheetSyncService = require("../../scheduleSheetSync.service");
const { loadActiveRows } = require("../../scheduleSyncReview.service");
const lessonSubstitutionService = require("../../lessonSubstitution.service");
const messageQueueService = require("../../messageQueue.service");
const inventoryCheckService = require("../../inventoryCheck.service");
const damageChargeService = require("../../damageCharge.service");
const securityDashboardService = require("../../securityDashboard.service");
const activityDashboardService = require("../../activityDashboard.service");
const { runFinanceReconcilePass } = require("../../../jobs/financeReconcile.job");
const { runInventoryReconcilePass } = require("../../../jobs/inventoryReconcile.job");

const { LIMITS } = require("../assistant.constants");
const {
  AiToolError,
  defineTool,
  monthSchema,
  monthArg,
  formatMoneyUz,
  monthLabel,
  sliceList,
  personName,
} = require("../assistant.toolkit");

// ─────────────────────────────────────────────────────────────────────────
// Chegaralar — deterministik; har birining sababi yonida
// ─────────────────────────────────────────────────────────────────────────

/** Yopilgan oyda yig'ilish 70% dan past — tushumning uchdan biri kelmagan, pul oqimi xavf ostida. */
const COLLECTION_RATE_HIGH = 70;
/** 85% dan past — odatiy kechikishdan ko'p: qarzdorlar bilan tizimli ishlash kerak. */
const COLLECTION_RATE_MEDIUM = 85;
/** Eng eski qarz 3 oydan eski — undirish ehtimoli keskin pasayadigan chegara. */
const DEBT_AGE_MEDIUM_MONTHS = 3;
/** 6 oydan eski qarz amalda "umidsiz" toifaga o'tadi. */
const DEBT_AGE_HIGH_MONTHS = 6;
/** Hisob-faktura cron'i har kuni 06:00 da ishlaydi: 24 soatlik oyna + 2 soat zaxira (restart, sekin pass). */
const INVOICE_CRON_STALE_HOURS = 26;
/**
 * Shakllantirish kunining o'zida cron 06:00 da ishlaydi: undan oldin joriy oy
 * shakllanmagani va watermark eskiligi NORMAL. 07:00 — 06:00 + bir soat zaxira.
 */
const INVOICE_CRON_GRACE_HOUR = 7;
/** Limitdan oshgan toifalar 3 va undan ko'p — alohida toifa emas, byudjet nazorati ishlamayapti. */
const BUDGET_OVER_HIGH_COUNT = 3;
/** Oylik davomat 80% dan past — har beshinchi o'quvchi darsda yo'q ("yaxshi" chegara `GOOD_ATTENDANCE_RATE` dashboard bilan umumiy). */
const ATTENDANCE_RATE_HIGH = 80;
/** Reja 90% dan kam bajarilgan — kichik og'ish emas, oy rejasi amalda bajarilmayapti. */
const PLAN_RATE_MEDIUM = 90;
/** O'quvchi davomati birinchi darslarda belgilanadi: 12:00 gacha belgilanmagani normal hol. */
const STUDENT_MARKING_CUTOFF_HOUR = 12;
/** Xodimlar ish boshida (08:00–09:00) keladi: 10:00 dan keyin belgilanmagani — kelmagan yoki kirishni qayd etmagan. */
const STAFF_MARKING_CUTOFF_HOUR = 10;
/** Belgilanmaganlar 20% dan ko'p — bitta sinf emas, belgilash jarayonining o'zi to'xtagan. */
const UNMARKED_SHARE_MEDIUM = 20;
/** Navbatdagi xabar 10 daqiqadan beri joyidan siljimagan — yuborish sikli ishlamayapti (tezlik ~1 xabar/s). */
const QUEUE_STUCK_MINUTES = 10;
/** Yetkazilmagan xabarlar shu oynada sanaladi — bir haftalik manzara. */
const QUEUE_FAILED_WINDOW_DAYS = 7;
/** Haftada 20+ yetkazilmagan xabar — bitta botni bloklagan ota-ona emas, ommaviy muammo. */
const QUEUE_FAILED_HIGH = 20;
/** Muddati o'tgan topshiriqlar 5 tadan ko'p — alohida holat emas, ijro intizomi masalasi. */
const OVERDUE_TASKS_MEDIUM = 5;
/** 14 kun harakatsiz lid — odatiy qayta aloqa siklidan (bir hafta) ikki barobar uzun. */
const STALE_LEAD_DAYS = 14;
/** 10+ unutilgan lid — sotuv voronkasi sezilarli darajada "oqyapti". */
const STALE_LEADS_MEDIUM = 10;
/**
 * Harakatsizlik tekshiriladigan lid holatlari — `lead.service` dagi "faol"
 * ro'yxati, faqat `postponed` SIZ: kechiktirilgan lid ataylab kutib turadi.
 */
const STALE_LEAD_STATUSES = ["new", "contacted", "interested", "visited", "trial", "negotiation"];
/** Kunlik xatlov hisobotlarining yarmidan ko'pi eslatma vaqtidan keyin ham topshirilmagan. */
const INVENTORY_PENDING_SHARE_MEDIUM = 50;
/** Faollik oynasi — bir hafta: dam olish kunlari ham, qisqa ta'til ham "jim" deb ko'rinmaydi. */
const ACTIVITY_WINDOW_DAYS = 7;
/** 30% dan ko'p xodim bir hafta davomida panelga kirmagan — panel amalda ishlatilmayapti. */
const SILENT_STAFF_SHARE_MEDIUM = 30;
/**
 * Bitta bo'lim vaqti. Hamma bo'lim PARALLEL ishlaydi, shuning uchun butun
 * tahlil ham shu vaqtda tugaydi — umumiy chegara (`LIMITS.healthScanTimeoutMs`)
 * dan ancha kichik: yadro vositani kesib tashlashidan oldin qisman natija
 * qaytishga ulgurishi kerak.
 */
const SECTION_TIMEOUT_MS = 20000;
/** Rekonsiler — butun jadvallarni o'qiydigan og'ir skan; 10 daqiqa kesh (design.md §3.1-7). */
const RECONCILE_CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * VAQTINCHALIK xato (ulanish pool'i to'lgan, tarmoq uzilishi) bir daqiqa
 * keshlanadi: 10 daqiqa davomida "tekshiruv ishlamayapti" deb turish yolg'on
 * bo'lardi, har chaqiruvda qayta urinish esa band bazani battar yuklardi.
 */
const RECONCILE_FAILURE_TTL_MS = 60 * 1000;
/** Keshsiz rekonsiler vaqti: undan oshsa javob qaytadi, pass esa fonda tugab keshni to'ldiradi. */
const RECONCILE_TIMEOUT_MS = 45000;
/** Modelga boradigan nomuvofiqliklar ro'yxati — har tur bo'yicha jami sanoq baribir to'liq. */
const INTEGRITY_PROBLEMS_LIMIT = 30;
/** Kunlik coin bo'shliqlari qidiriladigan oyna (bugundan tashqari, cron 23:30 da ishlaydi). */
const COIN_GAP_WINDOW_DAYS = 7;
/** Diagnostika AI cron'i 5 daqiqada ishlaydi va 10 daqiqadan eski `processing` ni qayta oladi: 30 daqiqa — uch sikl o'tdi. */
const DIAGNOSTIC_STUCK_MINUTES = 30;
/** Changelog xabarnomasi xatolari oynasi — bir hafta. */
const CHANGELOG_FAILED_WINDOW_DAYS = 7;
/** Test sessiyasi cron'i har daqiqada: 5 daqiqadan beri muddati o'tgan-u yopilmagan — cron ishlamayapti. */
const TEST_SESSION_BACKLOG_MINUTES = 5;
/** Premium muddati cron'i har soatda: 2 soatdan beri tugagan-u faol — cron ishlamayapti. */
const PREMIUM_BACKLOG_HOURS = 2;
/** Haftalik AI tahlil dushanba 07:00 da yoziladi: 08:00 gacha qator yo'qligi normal. */
const WEEKLY_INSIGHT_GRACE_HOUR = 8;

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// ─────────────────────────────────────────────────────────────────────────
// Umumiy yordamchilar
// ─────────────────────────────────────────────────────────────────────────

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
const STATUS_ORDER = ["critical", "warning", "ok", "unavailable"];

const signal = (severity, text, evidence = {}) => ({ severity, text, evidence });

/** Vaqt chegarasi xatosi — "unavailable" sababi sifatida egaga ko'rinadi. */
class OverviewTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "OverviewTimeoutError";
  }
}

/**
 * Kod va sxema ajrashgan (Prisma validatsiyasi) — DETERMINISTIK xato:
 * tuzatilmaguncha har urinishda aynan shunday yiqiladi. Vaqtinchalik
 * xatolardan (pool, tarmoq) farqi kesh muddati va egaga aytiladigan xulosada.
 */
const isSchemaDriftError = (err) => err?.name === "PrismaClientValidationError";

/**
 * Mijoz ulanishni uzgan bo'lsa yangi og'ir ish BOSHLANMAYDI. Yadro natijani
 * baribir kutmaydi — boshlangan skan esa bazani behuda yuklardi.
 */
function assertNotAborted(ctx) {
  if (ctx.signal?.aborted) throw new AiToolError("So'rov bekor qilindi");
}

/**
 * Promise'ni vaqt bilan cheklaydi. Asl ish TO'XTATILMAYDI (Prisma so'rovini
 * bekor qilib bo'lmaydi) — faqat kutish tugaydi. Ish so'rovning o'z async
 * zanjirida qoladi, ya'ni filial konteksti yo'qolmaydi.
 */
function withTimeout(promise, ms, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new OverviewTimeoutError(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Xatoni egaga tushunarli qisqa sababga aylantiradi.
 *
 * ⚠️ Prisma validatsiya xatosi alohida: uning xabari ko'p qatorli kod
 * parchasi, birinchi qatori esa ("Invalid ... invocation in") hech narsa
 * aytmaydi. Bu xato har doim kod va baza sxemasi ajrashganini bildiradi.
 */
function describeError(err) {
  if (err instanceof OverviewTimeoutError || err instanceof AiToolError) return err.message;
  if (err?.statusCode && err.statusCode < 500) return err.message;
  if (isSchemaDriftError(err)) {
    const message = err.message || "";
    const call = /prisma\.(\w+)\.(\w+)\(\)/.exec(message);
    const unknown = /Unknown (field|argument) `(\w+)`[^\n]*?model `(\w+)`/.exec(message);
    const what = unknown
      ? `: kod ${unknown[3]} modelida mavjud bo'lmagan \`${unknown[2]}\` ${unknown[1] === "field" ? "maydonini" : "argumentini"} ishlatadi`
      : "";
    return `Kod va ma'lumotlar bazasi sxemasi mos emas${what}${call ? ` (${call[1]}.${call[2]})` : ""}`;
  }
  const firstLine = String(err?.message || "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return `Kutilmagan xato: ${(firstLine || "sababi noma'lum").slice(0, 200)}`;
}

/** Foiz, 1 xona; bo'luvchi nol bo'lsa `null` — `financeDashboard.rateOf` bilan aynan bir xil. */
function rateOf(part, whole) {
  const w = new Decimal(whole ?? 0);
  if (w.isZero()) return null;
  return Number(new Decimal(part ?? 0).div(w).times(100).toFixed(1));
}

/** Son matnda: o'nli ajratgich vergul ("32,3"); qiymat yo'q bo'lsa "—". */
const numUz = (value) => (value === null || value === undefined ? "—" : String(value).replace(".", ","));

/** Foiz matnda: "32,3%". */
const pct = (value) => (value === null || value === undefined ? "—" : `${numUz(value)}%`);

/** Butun sonlar ulushi (foiz, 1 xona); maxraj nol bo'lsa `null`. */
function shareOf(part, whole) {
  if (!whole) return null;
  return Number(((part / whole) * 100).toFixed(1));
}

/** Toshkent devor-soati: `{ hour, hhmm }`. */
function tashkentClock(now) {
  const shifted = new Date(now.getTime() + TASHKENT_OFFSET_MS);
  return { hour: shifted.getUTCHours(), hhmm: shifted.toISOString().slice(11, 16) };
}

/** "YYYY-MM-DD" hafta kuni (0 = yakshanba). */
const weekdayOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** Toshkent kalendar kunining instant chegaralari — `Grade.date` kabi haqiqiy vaqtlar uchun. */
const tashkentDayRange = (iso) => ({
  gte: new Date(`${iso}T00:00:00.000+05:00`),
  lte: new Date(`${iso}T23:59:59.999+05:00`),
});

/**
 * Bugun joriy filialda o'qish kunimi — `lessonHours.getMonthCalendar` (ta'til
 * oyi, bayram, yakshanba) bo'yicha. Dam olish kunidagi "0% keldi" davomat
 * emas, shuning uchun davomat faqat o'qish kunida baholanadi.
 */
async function schoolDayOf(ctx) {
  const calendar = await getMonthCalendar(ctx.monthKey);
  if (calendar.days.some((day) => day.key === ctx.today)) return { isSchoolDay: true, reason: null };
  return {
    isSchoolDay: false,
    reason: calendar.isVacationMonth ? "Ta'til oyi" : weekdayOf(ctx.today) === 0 ? "Yakshanba" : "Bayram kuni",
  };
}

/** Uzun erkin matnni modelga qisqa holda beradi (xato matnlari ko'p qatorli bo'lishi mumkin). */
const clip = (text, max = 200) => {
  if (!text) return null;
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** Bitta tahlil ichida bir necha bo'lim so'raydigan ma'lumot bir marta o'qiladi. */
function once(fn) {
  let promise = null;
  return () => {
    if (!promise) promise = fn();
    return promise;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Umumiy baholashlar (health scan va system_integrity ikkalasi ishlatadi)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Hisob-faktura cron'i tirikmi — `invoiceGeneration.job.js` mantiqi bo'yicha.
 *
 * ⚠️ Belgilangan kundan OLDIN watermark yangilanmaydi (job erta qaytadi),
 * shuning uchun oy boshidagi eski `lastRunAt` nosozlik EMAS. Kun
 * `Math.min(invoiceDayOfMonth, daysInCurrentMonth())` — job'dagi bilan bir xil.
 *
 * @returns {{ level: "ok"|"medium"|"high", detail: string, evidence: object }}
 */
function assessInvoiceCron(settings, { now, monthKey }) {
  const evidence = {
    autoGenerateEnabled: settings.autoGenerateEnabled,
    invoiceDayOfMonth: settings.invoiceDayOfMonth,
    lastRunAtLabel: formatDateTimeUz(settings.lastRunAt),
    lastGeneratedMonthLabel: monthLabel(settings.lastGeneratedMonth),
  };

  if (!settings.autoGenerateEnabled) {
    return {
      level: "medium",
      detail: "Hisob-faktura va oyliklarni avtomatik shakllantirish o'chirilgan — har oy qo'lda shakllantirish kerak",
      evidence,
    };
  }

  const targetDay = Math.min(settings.invoiceDayOfMonth, daysInCurrentMonth());
  if (currentDayOfMonth() < targetDay) {
    return {
      level: "ok",
      detail: `Shakllantirish kuni hali kelmagan (har oyning ${targetDay}-kuni)`,
      evidence,
    };
  }

  // Shakllantirish kunining o'zida 06:00 gacha job hali ishlamagan: joriy oy
  // shakllanmagani ham, oldingi kunlarda (erta qaytgan job) yangilanmagan
  // watermark ham nosozlik EMAS
  if (
    currentDayOfMonth() === targetDay &&
    tashkentClock(now).hour < INVOICE_CRON_GRACE_HOUR &&
    settings.lastGeneratedMonth !== monthKey
  ) {
    return {
      level: "ok",
      detail: `${monthLabel(monthKey)} bugun soat 06:00 dagi cron bilan shakllantiriladi`,
      evidence,
    };
  }

  const staleHours = settings.lastRunAt
    ? Math.floor((now.getTime() - new Date(settings.lastRunAt).getTime()) / HOUR_MS)
    : null;

  if (staleHours === null || staleHours >= INVOICE_CRON_STALE_HOURS) {
    return {
      level: "high",
      detail:
        staleHours === null
          ? "Hisob-faktura cron'i hech qachon ishlamagan"
          : `Hisob-faktura cron'i ${staleHours} soatdan beri ishlamagan (oxirgi: ${evidence.lastRunAtLabel})`,
      evidence: { ...evidence, staleHours },
    };
  }

  if (settings.lastGeneratedMonth !== monthKey) {
    return {
      level: "high",
      detail: `Joriy oy (${monthLabel(monthKey)}) hali shakllantirilmagan, oxirgisi — ${evidence.lastGeneratedMonthLabel}`,
      evidence,
    };
  }

  return { level: "ok", detail: `Cron ishlayapti (oxirgi: ${evidence.lastRunAtLabel})`, evidence };
}

/**
 * Haftalik ta'lim AI tahlili (`academicInsight.job.js`, dushanba 07:00).
 * `source: "rules"` — OpenAI yiqilgan yoki kalit yo'q; joriy haftaga qator
 * yo'qligi — job ishlamagan.
 */
async function assessWeeklyInsight({ now, today }) {
  const weekStart = currentWeekStart();
  const latest = await prisma.academicInsight.findFirst({
    orderBy: { weekStart: "desc" },
    select: { weekStart: true, source: true, model: true, generatedAt: true },
  });

  const evidence = latest
    ? {
        weekStartLabel: formatDateUz(latest.weekStart, { utc: true }),
        source: latest.source,
        generatedAtLabel: formatDateTimeUz(latest.generatedAt),
      }
    : { weekStartLabel: null, source: null, generatedAtLabel: null };

  const isCurrent = Boolean(latest) && latest.weekStart.getTime() === weekStart.getTime();
  const inGrace = weekdayOf(today) === 1 && tashkentClock(now).hour < WEEKLY_INSIGHT_GRACE_HOUR;

  if (!isCurrent) {
    return inGrace
      ? { level: "ok", detail: "Bu haftalik tahlil bugun 07:00 dan keyin yoziladi", evidence, isCurrent }
      : {
          level: "medium",
          detail: `Joriy hafta (${formatDateUz(weekStart, { utc: true })} dan) uchun haftalik ta'lim tahlili yozilmagan — cron ishlamagan`,
          evidence,
          isCurrent,
        };
  }

  if (latest.source === "rules") {
    return {
      level: "low",
      detail: "Haftalik tahlil AI siz, qoidalar bilan yozilgan — OpenAI javob bermagan yoki kalit kiritilmagan",
      evidence,
      isCurrent,
    };
  }

  return { level: "ok", detail: "Haftalik tahlil joriy hafta uchun AI bilan yozilgan", evidence, isCurrent };
}

/**
 * Telegram yetkazish navbatlari holati (`messageQueue`, `penaltyNotificationQueue`).
 *
 * ⚠️ `messageQueue` o'z-o'zidan `processing` → `pending` ga QAYTMAYDI
 * (qayta ishga tushganda ham), shuning uchun eski `processing` qatori
 * abadiy osilib qoladi — alohida sanaladi.
 */
async function loadQueueHealth(now) {
  const staleBefore = new Date(now.getTime() - QUEUE_STUCK_MINUTES * MINUTE_MS);
  const failedSince = new Date(now.getTime() - QUEUE_FAILED_WINDOW_DAYS * DAY_MS);

  const [stats, failed, stuckProcessing, stalePending, topErrors, penaltyFailed, penaltyStuck] =
    await Promise.all([
      messageQueueService.getQueueStats(),
      prisma.messageQueue.count({ where: { status: "failed", processedAt: { gte: failedSince } } }),
      prisma.messageQueue.count({ where: { status: "processing", updatedAt: { lt: staleBefore } } }),
      prisma.messageQueue.count({ where: { status: "pending", updatedAt: { lt: staleBefore } } }),
      prisma.messageQueue.groupBy({
        by: ["errorMessage"],
        where: { status: "failed", processedAt: { gte: failedSince } },
        _count: { _all: true },
        orderBy: { _count: { errorMessage: "desc" } },
        take: 3,
      }),
      prisma.penaltyNotificationQueue.count({
        where: { status: "failed", updatedAt: { gte: failedSince } },
      }),
      prisma.penaltyNotificationQueue.count({
        where: { status: { in: ["pending", "processing"] }, updatedAt: { lt: staleBefore } },
      }),
    ]);

  return {
    stats: {
      pending: stats.pending ?? 0,
      processing: stats.processing ?? 0,
      completed: stats.completed ?? 0,
      failed: stats.failed ?? 0,
      cancelled: stats.cancelled ?? 0,
    },
    failedLastWeek: failed,
    stuckProcessing,
    stalePending,
    topErrors: topErrors.map((row) => ({ error: clip(row.errorMessage, 160), count: row._count._all })),
    penaltyQueue: { failedLastWeek: penaltyFailed, stuck: penaltyStuck },
  };
}

/** Navbat holatidan signal ro'yxati (operatsiyalar bo'limi va integrity uchun bitta qoida). */
function queueSignals(queue) {
  const signals = [];
  if (queue.stuckProcessing > 0 || queue.stalePending > 0) {
    signals.push(
      signal(
        "high",
        `Telegram navbatida ${queue.stuckProcessing + queue.stalePending} ta xabar ${QUEUE_STUCK_MINUTES} daqiqadan beri joyidan siljimagan — yuborish sikli to'xtagan`,
        { stuckProcessing: queue.stuckProcessing, stalePending: queue.stalePending },
      ),
    );
  }
  if (queue.failedLastWeek > 0) {
    signals.push(
      signal(
        queue.failedLastWeek >= QUEUE_FAILED_HIGH ? "high" : "medium",
        `Oxirgi ${QUEUE_FAILED_WINDOW_DAYS} kunda ${queue.failedLastWeek} ta Telegram xabari yetkazilmagan`,
        { failedLastWeek: queue.failedLastWeek, topErrors: queue.topErrors },
      ),
    );
  }
  if (queue.penaltyQueue.stuck > 0 || queue.penaltyQueue.failedLastWeek > 0) {
    signals.push(
      signal(
        queue.penaltyQueue.stuck > 0 ? "medium" : "low",
        `Jarima xabarnomalari navbatida ${queue.penaltyQueue.failedLastWeek} ta yetkazilmagan va ${queue.penaltyQueue.stuck} ta osilib qolgan xabar bor`,
        queue.penaltyQueue,
      ),
    );
  }
  return signals;
}

// ─────────────────────────────────────────────────────────────────────────
// Rekonsiler keshi (filial schema'si bo'yicha, xotirada)
// ─────────────────────────────────────────────────────────────────────────

const FINANCE_PROBLEM_LABELS = {
  account_balance: "To'lov turi qoldig'i harakatlar daftariga mos emas",
  student_balance: "O'quvchi depoziti to'lovlar qoldig'iga mos emas",
  invoice_paid: "Hisob-fakturaning to'langan summasi taqsimotlarga mos emas",
  invoice_amount: "Hisob-faktura summasi tarkibiga mos emas",
  invoice_prorated: "Proratsiya qilingan summa tarif narxidan katta",
  invoice_days: "Hisob-fakturadagi kunlar soni noto'g'ri",
  payroll_paid: "Oylikning to'langan summasi taqsimotlarga mos emas",
  payroll_amount: "Oylik summasi tarkibiga mos emas",
  payroll_overpaid: "Oylik ortiqcha to'langan",
};

const INVENTORY_PROBLEM_LABELS = {
  stock_quantity: "Xatlov miqdori harakatlar daftariga mos emas",
  stock_broken: "Singan jihozlar soni harakatlar daftariga mos emas",
  stock_negative: "Xatlov miqdori manfiy",
  stock_broken_exceeds: "Singanlar soni umumiy miqdordan ko'p",
  damage_amount: "Zarar summasi miqdor × narxga mos emas",
  damage_charged: "Zararning undiriladigan summasi qarzlarga mos emas",
  damage_overcharged: "Aybdorlarga zarardan ko'p summa yozilgan",
  charge_paid: "Zarar qarzining to'langan summasi taqsimotlarga mos emas",
  charge_overpaid: "Zarar qarzi ortiqcha to'langan",
  transfer_quantity: "O'tkazma jami miqdori satrlarga mos emas",
  transfer_lines: "O'tkazma satrlari soni mos emas",
};

const RECONCILE_PASSES = {
  finance: {
    label: "Moliyaviy invariantlar (kirim va chiqim)",
    run: runFinanceReconcilePass,
    kindLabels: FINANCE_PROBLEM_LABELS,
  },
  inventory: {
    label: "Inventar invariantlari",
    run: runInventoryReconcilePass,
    kindLabels: INVENTORY_PROBLEM_LABELS,
  },
};

/** `${schemaName}:${kind}` → { ok, value?, error?, at } */
const reconcileCache = new Map();
/** Bir vaqtdagi ikkinchi so'rov ikkinchi to'liq skan boshlamasligi uchun. */
const reconcileInFlight = new Map();

/**
 * Rekonsiler natijasi — keshdan yoki yangi pass bilan.
 *
 * ⚠️ XATO HAM KESHLANADI. Pass buzilgan bo'lsa (kod va sxema ajrashgan),
 * u har chaqiruvda hisob-fakturalarni to'liq o'qib, keyin yiqilardi —
 * tuzatilmaguncha natija baribir o'zgarmaydi. Vaqtinchalik xato esa faqat
 * `RECONCILE_FAILURE_TTL_MS` turadi. `refresh: true` keshni chetlab o'tadi.
 *
 * ⚠️ KALIT — pass HAQIQATAN ishlaydigan filial konteksti (`getBranch()`),
 * `ctx.branch` emas: `prisma` Proxy aynan shu kontekstdan schema tanlaydi,
 * ya'ni kalit va o'qilgan ma'lumot hech qachon ikki filialga ajralmaydi.
 *
 * ⚠️ Vaqt tugasa pass TO'XTATILMAYDI: u so'rovning o'z async zanjirida
 * (filial konteksti bilan) tugaydi va keshni to'ldiradi, keyingi so'rov
 * tayyor natijani oladi.
 */
async function getReconcile(kind, ctx, { refresh = false } = {}) {
  const branch = getBranch();
  if (!branch?.schemaName) throw new Error("Filial konteksti yo'q — rekonsiler ishga tushirilmadi");

  const key = `${branch.schemaName}:${kind}`;
  const cached = reconcileCache.get(key);
  const ttl = cached && !cached.ok && !cached.deterministic ? RECONCILE_FAILURE_TTL_MS : RECONCILE_CACHE_TTL_MS;
  if (!refresh && cached && Date.now() - cached.at < ttl) {
    return { ...cached, fromCache: true };
  }

  let flight = reconcileInFlight.get(key);
  if (!flight) {
    assertNotAborted(ctx);
    flight = (async () => {
      const at = Date.now();
      let outcome;
      try {
        outcome = { ok: true, value: await RECONCILE_PASSES[kind].run(), at };
      } catch (err) {
        logger.warn(`[AiOverview] ${RECONCILE_PASSES[kind].label} xato bilan tugadi`, {
          branch: branch.name,
          error: err.message,
        });
        outcome = { ok: false, error: describeError(err), deterministic: isSchemaDriftError(err), at };
      }
      reconcileCache.set(key, outcome);
      return outcome;
    })().finally(() => reconcileInFlight.delete(key));
    reconcileInFlight.set(key, flight);
  }

  const outcome = await withTimeout(
    flight,
    RECONCILE_TIMEOUT_MS,
    `${RECONCILE_PASSES[kind].label} hali tugamadi — bir necha daqiqadan keyin qayta so'rang`,
  );
  return { ...outcome, fromCache: false };
}

/** Rekonsiler natijasini modelga beriladigan ixcham shaklga keltiradi. */
function shapeReconcile(kind, outcome, { withProblems }) {
  const pass = RECONCILE_PASSES[kind];
  const base = {
    key: kind,
    label: pass.label,
    cachedAtLabel: formatDateTimeUz(outcome.at),
    fromCache: outcome.fromCache,
  };

  if (!outcome.ok) {
    return {
      ...base,
      status: "failed",
      error: outcome.error,
      // ⚠️ Model "muammo topilmadi" deb xulosa qilmasligi uchun aniq aytiladi
      meaning: outcome.deterministic
        ? "Tekshiruv yakunlanmadi — bu \"muammo yo'q\" degani EMAS: birorta invariant natijasi olinmadi. Xato kodda, tuzatilmaguncha tungi 03:00 dagi tekshiruv ham har kecha shu joyda yiqiladi"
        : "Tekshiruv yakunlanmadi — bu \"muammo yo'q\" degani EMAS: birorta invariant natijasi olinmadi. Xato vaqtinchalik bo'lishi mumkin, bir daqiqadan keyin qayta so'rang",
    };
  }

  const { checked, problems } = outcome.value;
  const counts = new Map();
  for (const problem of problems) counts.set(problem.kind, (counts.get(problem.kind) ?? 0) + 1);

  const byKind = [...counts.entries()]
    .map(([problemKind, count]) => ({
      kind: problemKind,
      label: pass.kindLabels[problemKind] ?? problemKind,
      count,
    }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

  const shaped = {
    ...base,
    status: problems.length === 0 ? "ok" : "problems",
    checked,
    problemCount: problems.length,
    byKind,
  };

  if (withProblems) {
    const list = sliceList(
      problems.map((problem) => ({
        kind: problem.kind,
        kindLabel: pass.kindLabels[problem.kind] ?? problem.kind,
        id: problem.id,
        label: problem.label,
        stored: problem.stored,
        expected: problem.expected,
      })),
      INTEGRITY_PROBLEMS_LIMIT,
    );
    shaped.problems = list;
  }

  return shaped;
}

// ─────────────────────────────────────────────────────────────────────────
// Health scan bo'limlari
// ─────────────────────────────────────────────────────────────────────────

/**
 * Har bo'lim: `{ key, label, toolset, run(scope) → { metrics, signals } }`.
 * `scope = { ctx, month, shared }`; `shared` — bir necha bo'lim so'raydigan
 * ma'lumotning bir martalik yuklovchilari.
 */
const SECTIONS = [
  {
    key: "finance",
    label: "Moliya (kirim)",
    toolset: "finance",
    async run({ ctx, month, shared }) {
      const [summary, debtors, settings] = await Promise.all([
        invoiceService.getSummary(month),
        invoiceService.getDebtors({ query: { limit: "1" } }),
        shared.financeSettings(),
      ]);

      const isOpenMonth = month === ctx.monthKey;
      const rate = rateOf(summary.totals.paid, summary.totals.amount);
      // ⚠️ Joriy oy baholanmaydi: to'lovlar oy davomida kelib turadi va
      // 14-sanadagi 40% "yomon" emas. Chegara YOPILGAN oyga qo'llanadi.
      const judged = isOpenMonth
        ? {
            month: summary.compareMonth,
            label: summary.compareMonthLabel,
            amount: summary.previous.amount,
            paid: summary.previous.paid,
          }
        : { month, label: summary.monthLabel, amount: summary.totals.amount, paid: summary.totals.paid };
      const judgedRate = rateOf(judged.paid, judged.amount);
      const cron = assessInvoiceCron(settings, ctx);

      const metrics = {
        monthLabel: summary.monthLabel,
        isVacationMonth: summary.isVacation,
        invoiceCount: summary.counts.invoiced,
        accrued: summary.totals.amount,
        accruedLabel: formatMoneyUz(summary.totals.amount),
        collected: summary.totals.paid,
        collectedLabel: formatMoneyUz(summary.totals.paid),
        collectionRate: rate,
        monthDebtLabel: formatMoneyUz(summary.totals.debt),
        totalDebt: debtors.totals.totalDebt,
        totalDebtLabel: formatMoneyUz(debtors.totals.totalDebt),
        debtorCount: debtors.totals.debtorCount,
        oldestDebtMonthLabel: debtors.totals.oldestMonthLabel,
        depositsLabel: formatMoneyUz(summary.totals.deposits),
        invoiceCron: { status: cron.level === "ok" ? "ok" : "problem", ...cron.evidence },
      };
      if (isOpenMonth) {
        metrics.closedMonth = { monthLabel: judged.label, collectionRate: judgedRate };
      }

      const signals = [];

      if (judgedRate !== null && judgedRate < COLLECTION_RATE_MEDIUM) {
        signals.push(
          signal(
            judgedRate < COLLECTION_RATE_HIGH ? "high" : "medium",
            `${judged.label} oyida to'lov yig'ilishi ${pct(judgedRate)} — ${formatMoneyUz(judged.paid)} / ${formatMoneyUz(judged.amount)}`,
            { month: judged.month, collectionRate: judgedRate, accrued: judged.amount, collected: judged.paid },
          ),
        );
      }

      const oldest = debtors.totals.oldestMonth;
      if (oldest) {
        const age = diffMonths(oldest, ctx.monthKey);
        if (age >= DEBT_AGE_MEDIUM_MONTHS) {
          signals.push(
            signal(
              age >= DEBT_AGE_HIGH_MONTHS ? "high" : "medium",
              `Eng eski to'lanmagan qarz ${debtors.totals.oldestMonthLabel} oyidan (${age} oy); jami qarz ${formatMoneyUz(debtors.totals.totalDebt)}, ${debtors.totals.debtorCount} ta qarzdor`,
              { oldestMonth: oldest, ageMonths: age, debtorCount: debtors.totals.debtorCount },
            ),
          );
        }
      }

      if (cron.level !== "ok") signals.push(signal(cron.level, cron.detail, cron.evidence));

      // Hisob-faktura yozilmagan oy: ta'til, `firstInvoiceMonth` dan oldingi
      // oy va joriy oyning shakllantirish kunidan oldingi davr — normal hol.
      const beforeFloor = settings.firstInvoiceMonth && month < settings.firstInvoiceMonth;
      const beforeDay =
        isOpenMonth && currentDayOfMonth() < Math.min(settings.invoiceDayOfMonth, daysInCurrentMonth());
      if (summary.counts.invoiced === 0 && !summary.isVacation && !beforeFloor && !beforeDay) {
        signals.push(
          signal("high", `${summary.monthLabel} uchun birorta ham hisob-faktura shakllanmagan`, { month }),
        );
      }

      return { metrics, signals };
    },
  },

  {
    key: "payroll",
    label: "Oylik",
    toolset: "payroll",
    async run({ ctx, month, shared }) {
      const current = ctx.monthKey;
      const [monthEntries, monthUnpaid, overdue, salaryRules, pendingRequests, settings] = await Promise.all([
        payrollService.getEntries({ query: { month: String(month), limit: "1" } }),
        payrollService.getEntries({ query: { month: String(month), debtOnly: "true", limit: "1" } }),
        payrollService.getEntries({
          query: { toMonth: String(prevMonth(current)), debtOnly: "true", limit: "1" },
        }),
        resolveSalariesForMonth(month),
        payrollRequestService.getAllRequests({ status: "pending", limit: 1 }),
        shared.financeSettings(),
      ]);

      const ruleIds = [...salaryRules.keys()];
      // Oylik oluvchilar doirasi — `payroll.generateForMonth` dagi so'rovning aynan nusxasi
      const [eligibleCount, noSetup] = await Promise.all([
        prisma.user.count({
          where: {
            isArchived: false,
            role: { not: ROLES.STUDENT },
            OR: [
              { positionId: { not: null } },
              { salaryCategoryId: { not: null } },
              ...(ruleIds.length ? [{ id: { in: ruleIds } }] : []),
            ],
          },
        }),
        prisma.user.findMany({
          where: {
            isArchived: false,
            role: { notIn: [ROLES.OWNER, ROLES.STUDENT] },
            positionId: null,
            salaryCategoryId: null,
            ...(ruleIds.length ? { id: { notIn: ruleIds } } : {}),
          },
          select: { id: true, firstName: true, lastName: true, role: true },
          orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
        }),
      ]);

      const metrics = {
        monthLabel: monthLabel(month),
        entryCount: monthEntries.pagination.total,
        accrued: monthEntries.totals.accrued,
        accruedLabel: formatMoneyUz(monthEntries.totals.accrued),
        paidLabel: formatMoneyUz(monthEntries.totals.paid),
        monthDebtLabel: formatMoneyUz(monthEntries.totals.debt),
        unpaidEntryCount: monthUnpaid.pagination.total,
        closedMonthsDebt: overdue.totals.debt,
        closedMonthsDebtLabel: formatMoneyUz(overdue.totals.debt),
        closedMonthsUnpaidCount: overdue.pagination.total,
        eligibleStaffCount: eligibleCount,
        staffWithoutSalarySetup: noSetup.length,
        pendingPayrollRequests: pendingRequests.pendingCount,
      };

      const signals = [];

      if (overdue.pagination.total > 0 && new Decimal(overdue.totals.debt).greaterThan(0)) {
        signals.push(
          signal(
            "high",
            `Yopilgan oylar bo'yicha ${overdue.pagination.total} ta oylik to'lanmagan, xodimlar oldidagi qarz ${formatMoneyUz(overdue.totals.debt)}`,
            { unpaidCount: overdue.pagination.total, debt: overdue.totals.debt },
          ),
        );
      }

      // Tizimga o'tishdan oldingi oylar (`firstInvoiceMonth` poli) va joriy
      // oyning shakllantirish kunidan oldingi davr — bo'sh bo'lishi normal
      const beforeFloor = settings.firstInvoiceMonth && month < settings.firstInvoiceMonth;
      const dayReached =
        month < current || currentDayOfMonth() >= Math.min(settings.invoiceDayOfMonth, daysInCurrentMonth());
      if (monthEntries.pagination.total === 0 && eligibleCount > 0 && dayReached && !beforeFloor) {
        signals.push(
          signal(
            "medium",
            `${monthLabel(month)} uchun oylik majburiyatlari shakllantirilmagan, oylik oladigan xodimlar — ${eligibleCount} ta`,
            { eligibleStaffCount: eligibleCount },
          ),
        );
      }

      if (noSetup.length > 0 && !beforeFloor) {
        signals.push(
          signal(
            "medium",
            `${noSetup.length} ta xodimda lavozim, toifa yoki oylik qoidasi yo'q — ularga oylik hisoblanmaydi`,
            {
              staff: sliceList(
                noSetup.map((user) => ({ id: user.id, name: personName(user), role: user.role })),
                5,
              ),
            },
          ),
        );
      }

      if (pendingRequests.pendingCount > 0) {
        signals.push(
          signal("low", `${pendingRequests.pendingCount} ta xodim oylik so'rovi ko'rib chiqilishini kutmoqda`, {
            pendingCount: pendingRequests.pendingCount,
          }),
        );
      }

      return { metrics, signals };
    },
  },

  {
    key: "expenses",
    label: "Xarajatlar va byudjet",
    toolset: "payroll",
    async run({ month }) {
      const budgets = await expenseBudgetService.getBudgets({ month });
      const { totals } = budgets;
      const over = budgets.items.filter((item) => item.status === "over");
      const warning = budgets.items.filter((item) => item.status === "warning");

      const metrics = {
        monthLabel: budgets.monthLabel,
        limitLabel: formatMoneyUz(totals.limit),
        spent: totals.spent,
        spentLabel: formatMoneyUz(totals.spent),
        usageRate: totals.rate,
        categoryCount: totals.categoryCount,
        categoriesWithLimit: totals.withLimit,
        overCount: totals.overCount,
        warningCount: warning.length,
      };

      const describe = (item) => ({
        categoryId: item.categoryId,
        name: item.name,
        limit: formatMoneyUz(item.limit),
        spent: formatMoneyUz(item.spent),
        rate: item.rate,
      });

      const signals = [];
      if (over.length > 0) {
        signals.push(
          signal(
            over.length >= BUDGET_OVER_HIGH_COUNT ? "high" : "medium",
            `${over.length} ta xarajat toifasi ${budgets.monthLabel} limitidan oshgan: ${over
              .slice(0, 3)
              .map((item) => `${item.name} (${pct(item.rate)})`)
              .join(", ")}`,
            { categories: sliceList(over.map(describe), 5) },
          ),
        );
      }
      if (warning.length > 0) {
        signals.push(
          signal("low", `${warning.length} ta xarajat toifasi limitning 90% idan oshdi`, {
            categories: sliceList(warning.map(describe), 5),
          }),
        );
      }
      if (totals.categoryCount > 0 && totals.withLimit === 0) {
        signals.push(signal("low", `${budgets.monthLabel} uchun birorta xarajat toifasiga limit belgilanmagan`, {}));
      }

      return { metrics, signals };
    },
  },

  {
    key: "academic",
    label: "Ta'lim",
    toolset: "academic",
    async run({ ctx, month }) {
      const [overview, insight] = await Promise.all([
        academicDashboardService.getOverview({ month }),
        assessWeeklyInsight(ctx),
      ]);
      const facts = buildFacts(overview);
      const gapKeys = new Set(facts.dataGaps.map((gap) => gap.key));
      const metric = (key) => facts.metrics.find((row) => row.key === key) ?? null;

      const metrics = {
        monthLabel: overview.monthLabel,
        ...Object.fromEntries(
          facts.metrics.map((row) => [row.key, { value: row.value, previous: row.previous, planRate: row.planRate }]),
        ),
        totals: facts.totals,
        dataGaps: facts.dataGaps.map((gap) => gap.key),
        weeklyInsight: { ...insight.evidence, isCurrentWeek: insight.isCurrent },
      };

      const signals = [];

      const attendance = metric("attendanceRate");
      if (!gapKeys.has("attendance") && attendance?.value != null && attendance.value < GOOD_ATTENDANCE_RATE) {
        signals.push(
          signal(
            attendance.value < ATTENDANCE_RATE_HIGH ? "high" : "medium",
            `${overview.monthLabel} oyida o'quvchilar davomati ${pct(attendance.value)} (o'tgan oy ${pct(attendance.previous)})`,
            { value: attendance.value, previous: attendance.previous },
          ),
        );
      }

      const tasks = metric("taskCompletion");
      if (!gapKeys.has("tasks") && tasks?.value != null && tasks.value < LOW_TASK_COMPLETION) {
        signals.push(
          signal("medium", `Topshiriqlar bajarilishi ${pct(tasks.value)} — ${pct(LOW_TASK_COMPLETION)} dan past`, {
            value: tasks.value,
            pending: facts.taskDiscipline?.pending ?? null,
          }),
        );
      }

      // Reja bo'yicha: faqat ma'lumoti yetarli ko'rsatkichlar
      const gapOf = {
        averageGrade: "grades",
        qualityRate: "grades",
        attendanceRate: "attendance",
        taskCompletion: "tasks",
      };
      for (const row of facts.metrics) {
        if (row.planRate == null || row.planRate >= PLAN_RATE_MEDIUM) continue;
        if (gapOf[row.key] && gapKeys.has(gapOf[row.key])) continue;
        signals.push(
          signal(
            "medium",
            `"${row.label}" rejasi ${pct(row.planRate)} bajarilgan (reja ${numUz(row.plan)}, amalda ${numUz(row.value)})`,
            { metric: row.key, plan: row.plan, value: row.value, planRate: row.planRate },
          ),
        );
      }

      // Bo'shliqlar BITTA signalda: har biri alohida bo'lsa, ma'lumoti yo'q
      // oyda sakkizta "past" signal haqiqiy muammolarni ko'mib yuborardi
      const gapTasks = facts.dataGaps.filter((gap) => gap.task);
      if (gapTasks.length > 0) {
        signals.push(
          signal("low", `${gapTasks.length} ta kesimda tahlil uchun ma'lumot yetarli emas`, {
            tasks: gapTasks.map((gap) => ({ key: gap.key, task: gap.task })),
          }),
        );
      }

      if (insight.level !== "ok") signals.push(signal(insight.level, insight.detail, insight.evidence));

      return { metrics, signals };
    },
  },

  {
    key: "attendance_today",
    label: "Bugungi davomat",
    toolset: "academic",
    async run({ ctx }) {
      const schoolDay = await schoolDayOf(ctx);
      const { hour } = tashkentClock(ctx.now);

      if (!schoolDay.isSchoolDay) {
        return {
          metrics: {
            dateLabel: formatDateUz(`${ctx.today}T00:00:00Z`, { utc: true }),
            isSchoolDay: false,
            reason: schoolDay.reason,
          },
          signals: [],
        };
      }

      const [students, staff] = await Promise.all([
        studentAttendanceService.getTodayAllStudents({ query: { limit: "1" } }),
        attendanceService.getTodayAllRecords(null, null),
      ]);

      const s = students.summary;
      const workdayStaff = staff.rows.filter((row) => row.isWorkDay);
      const staffNotMarked = workdayStaff.filter((row) => row.status === "not_marked");
      const unmarkedShare = shareOf(s.unmarked, s.total);
      const cameRate = shareOf(s.came, s.total);

      const metrics = {
        dateLabel: formatDateUz(students.date, { utc: true }),
        isSchoolDay: true,
        students: {
          total: s.total,
          came: s.came,
          late: s.late,
          absent: s.absent,
          excused: s.excused,
          unmarked: s.unmarked,
          cameRate,
        },
        staff: {
          total: staff.summary.total,
          workdayTotal: workdayStaff.length,
          present: staff.summary.present,
          late: staff.summary.late,
          absent: staff.summary.absent,
          excused: staff.summary.excused,
          notMarkedOnWorkday: staffNotMarked.length,
        },
      };

      const signals = [];

      if (hour >= STUDENT_MARKING_CUTOFF_HOUR && s.total > 0) {
        if (unmarkedShare !== null && unmarkedShare > UNMARKED_SHARE_MEDIUM) {
          signals.push(
            signal(
              "medium",
              `Soat ${STUDENT_MARKING_CUTOFF_HOUR}:00 dan o'tdi, lekin ${s.unmarked} ta o'quvchi (${pct(unmarkedShare)}) davomati belgilanmagan`,
              { unmarked: s.unmarked, total: s.total },
            ),
          );
        } else if (cameRate !== null && cameRate < GOOD_ATTENDANCE_RATE) {
          signals.push(
            signal(
              cameRate < ATTENDANCE_RATE_HIGH ? "high" : "medium",
              `Bugun o'quvchilarning ${pct(cameRate)} i darsda (${s.came} / ${s.total}), kelmagan ${s.absent}, sababli ${s.excused}`,
              { came: s.came, total: s.total, absent: s.absent, excused: s.excused },
            ),
          );
        }
      }

      if (hour >= STAFF_MARKING_CUTOFF_HOUR && staffNotMarked.length > 0) {
        const share = shareOf(staffNotMarked.length, workdayStaff.length);
        signals.push(
          signal(
            share !== null && share > UNMARKED_SHARE_MEDIUM ? "medium" : "low",
            `Bugun ish kuni bo'lgan ${staffNotMarked.length} ta xodim kelganini qayd etmagan (${pct(share)})`,
            {
              staff: sliceList(
                staffNotMarked.map((row) => ({ id: row.user.id, name: personName(row.user), role: row.user.role })),
                5,
              ),
            },
          ),
        );
      }

      return { metrics, signals };
    },
  },

  {
    key: "schedule",
    label: "Dars jadvali",
    toolset: "schedule",
    async run({ ctx }) {
      const [status, activeRows, substitutions] = await Promise.all([
        scheduleSheetSyncService.getStatus(ctx.user),
        loadActiveRows(prisma),
        lessonSubstitutionService.getSubstitutions({ query: { ongoing: "true", limit: "1" } }),
      ]);
      const conflicts = conflictsInState(activeRows);

      const metrics = {
        mode: status.mode,
        classCount: status.active.classCount,
        lessonCount: status.active.lessonCount,
        teacherConflicts: conflicts.length,
        duplicateRows: status.integrity.duplicateRows,
        ongoingSubstitutions: substitutions.totals.ongoing,
      };

      const signals = [];

      if (status.active.lessonCount === 0) {
        signals.push(
          signal(
            "medium",
            "Amaldagi dars jadvali bo'sh — bugungi darslar, o'rinbosarlik va soatbay oylik hisoblanmaydi",
            {},
          ),
        );
      }
      if (conflicts.length > 0) {
        signals.push(
          signal("high", `Jadvalda ${conflicts.length} ta to'qnashuv: bitta o'qituvchi bir vaqtda ikki sinfda`, {
            conflicts: sliceList(conflicts, 5),
          }),
        );
      }
      if (status.integrity.duplicateRows > 0) {
        signals.push(
          signal("high", `Jadvalda ${status.integrity.duplicateRows} ta takroriy sinf-kun qatori bor`, {
            duplicateRows: status.integrity.duplicateRows,
          }),
        );
      }
      if (!status.integrity.uniqueIndexPresent) {
        signals.push(
          signal(
            "medium",
            "Dars jadvalida sinf-kun noyoblik indeksi yo'q — takroriy qatorlar paydo bo'lishi mumkin",
            {},
          ),
        );
      }

      if (status.mode === "sheet") {
        metrics.sheet = {
          autoCheck: status.autoCheck,
          lastCheckedAtLabel: formatDateTimeUz(status.lastCheckedAt),
          lastCheckOk: status.lastCheckOk,
          checkFailureCount: status.checkFailureCount,
          inSync: status.inSync,
          checkFresh: status.checkFresh,
          latestRevisionStatus: status.latestRevision?.status ?? null,
        };

        if (status.lastCheckOk === false) {
          signals.push(
            signal(
              status.checkFailureCount >= 2 ? "high" : "medium",
              `Google Sheets tekshiruvi ketma-ket ${status.checkFailureCount} marta muvaffaqiyatsiz: ${clip(status.lastCheckError, 160) ?? "sababi yozilmagan"}`,
              { checkFailureCount: status.checkFailureCount, lastCheckedAtLabel: metrics.sheet.lastCheckedAtLabel },
            ),
          );
        } else if (status.autoCheck && !status.checkFresh) {
          signals.push(
            signal("medium", "Google Sheets oxirgi 15 daqiqada muvaffaqiyatli tekshirilmagan", {
              lastCheckedAtLabel: metrics.sheet.lastCheckedAtLabel,
            }),
          );
        }
        if (status.inSync === false) {
          signals.push(
            signal("high", "Amaldagi jadval oxirgi qo'llangan Google Sheets holatidan farq qiladi", {}),
          );
        }
        if (status.latestRevision?.status === "pending") {
          signals.push(signal("low", "Google Sheets'dagi yangi tahrir ko'rib chiqilishini kutmoqda", {}));
        }
        if (!status.autoCheck) {
          signals.push(signal("low", "Google Sheets avtomatik tekshiruvi o'chirilgan", {}));
        }
      }

      return { metrics, signals };
    },
  },

  {
    key: "operations",
    label: "Operatsiyalar",
    toolset: "operations",
    async run({ ctx }) {
      const staleLeadBefore = new Date(ctx.now.getTime() - STALE_LEAD_DAYS * DAY_MS);
      const [overdueTasks, awaitingReview, queue, inventorySettings, overdueCharges, staleLeads] =
        await Promise.all([
          prisma.task.count({
            where: { dueDate: { lt: ctx.now }, status: { notIn: ["completed", "stopped"] } },
          }),
          prisma.task.count({ where: { status: "pending_review" } }),
          loadQueueHealth(ctx.now),
          settingsService.getInventorySettings(),
          damageChargeService.getCharges({ query: { overdue: "true", limit: "1" } }),
          prisma.lead.count({
            where: {
              status: { in: STALE_LEAD_STATUSES },
              createdAt: { lt: staleLeadBefore },
              activities: { none: { createdAt: { gte: staleLeadBefore } } },
            },
          }),
        ]);

      const pendingChecks = inventorySettings.dailyCheckEnabled
        ? await inventoryCheckService.getPendingLocations()
        : null;

      const metrics = {
        overdueTasks,
        tasksAwaitingReview: awaitingReview,
        telegramQueue: {
          ...queue.stats,
          failedLastWeek: queue.failedLastWeek,
          stuck: queue.stuckProcessing + queue.stalePending,
        },
        inventoryChecksToday: pendingChecks
          ? {
              totalLocations: pendingChecks.totalLocations,
              submitted: pendingChecks.submittedCount,
              pending: pendingChecks.pendingCount,
              reminderTime: inventorySettings.reminderTime,
            }
          : { dailyCheckEnabled: false },
        overdueDamageCharges: overdueCharges.pagination.total,
        overdueDamageAmountLabel: formatMoneyUz(overdueCharges.totals.remainingAmount),
        staleLeads,
      };

      const signals = [...queueSignals(queue)];

      if (overdueTasks > 0) {
        signals.push(
          signal(
            overdueTasks > OVERDUE_TASKS_MEDIUM ? "medium" : "low",
            `${overdueTasks} ta topshiriqning muddati o'tgan va hali yopilmagan`,
            { overdueTasks },
          ),
        );
      }
      if (awaitingReview > 0) {
        signals.push(
          signal("low", `${awaitingReview} ta bajarilgan topshiriq tekshirilishini kutmoqda`, { awaitingReview }),
        );
      }
      const afterReminder = tashkentClock(ctx.now).hhmm >= inventorySettings.reminderTime;
      if (pendingChecks && pendingChecks.pendingCount > 0 && afterReminder) {
        const share = shareOf(pendingChecks.pendingCount, pendingChecks.totalLocations);
        signals.push(
          signal(
            share !== null && share > INVENTORY_PENDING_SHARE_MEDIUM ? "medium" : "low",
            `Eslatma vaqti (${inventorySettings.reminderTime}) o'tdi, ${pendingChecks.pendingCount} / ${pendingChecks.totalLocations} xona kunlik xatlov hisobotini topshirmagan`,
            { pending: pendingChecks.pendingCount, totalLocations: pendingChecks.totalLocations },
          ),
        );
      }
      if (overdueCharges.pagination.total > 0) {
        signals.push(
          signal(
            "low",
            `${overdueCharges.pagination.total} ta zarar qarzining to'lov muddati o'tgan, qoldiq ${metrics.overdueDamageAmountLabel}`,
            { count: overdueCharges.pagination.total, remaining: overdueCharges.totals.remainingAmount },
          ),
        );
      }
      if (staleLeads > 0) {
        signals.push(
          signal(
            staleLeads >= STALE_LEADS_MEDIUM ? "medium" : "low",
            `${staleLeads} ta faol lid bilan ${STALE_LEAD_DAYS} kundan beri hech qanday aloqa qilinmagan`,
            { staleLeads, days: STALE_LEAD_DAYS },
          ),
        );
      }

      return { metrics, signals };
    },
  },

  {
    key: "security",
    label: "Xavfsizlik (barcha filiallar)",
    toolset: "operations",
    async run({ ctx }) {
      const scope = { actor: ctx.user, branch: ctx.branch, status: "open" };
      const [open, critical, high] = await Promise.all([
        securityDashboardService.listAlerts({ ...scope, limit: 1 }),
        securityDashboardService.listAlerts({ ...scope, severity: "critical", limit: 3 }),
        securityDashboardService.listAlerts({ ...scope, severity: "high", limit: 3 }),
      ]);

      const brief = (alert) => ({
        id: alert.id,
        title: alert.title,
        typeLabel: alert.typeLabel,
        hitCount: alert.hitCount,
        lastSeenLabel: alert.lastSeenLabel,
      });

      const metrics = {
        openAlerts: open.pagination.total,
        openCritical: critical.pagination.total,
        openHigh: high.pagination.total,
      };

      const signals = [];
      if (critical.pagination.total > 0) {
        signals.push(
          signal("high", `${critical.pagination.total} ta ochiq JUDA MUHIM xavfsizlik ogohlantirishi`, {
            alerts: critical.items.map(brief),
          }),
        );
      }
      if (high.pagination.total > 0) {
        signals.push(
          signal("medium", `${high.pagination.total} ta ochiq muhim xavfsizlik ogohlantirishi`, {
            alerts: high.items.map(brief),
          }),
        );
      }
      const rest = open.pagination.total - critical.pagination.total - high.pagination.total;
      if (rest > 0) {
        signals.push(
          signal("low", `Yana ${rest} ta ochiq past/o'rta darajali xavfsizlik ogohlantirishi`, { count: rest }),
        );
      }

      return { metrics, signals };
    },
  },

  {
    key: "activity",
    label: "Xodimlar faolligi",
    toolset: "operations",
    async run() {
      const overview = await activityDashboardService.getOverview({
        granularity: "day",
        count: ACTIVITY_WINDOW_DAYS,
        withRoster: false,
      });
      const metricValue = (key) => overview.metrics.find((row) => row.key === key)?.value ?? null;

      const staffTotal = overview.today.panel.total;
      const silentTotal = metricValue("silentStaff") ?? 0;
      const silentShare = shareOf(silentTotal, staffTotal);

      const metrics = {
        periodLabel: overview.period.rangeLabel,
        collecting: overview.collecting,
        staffTotal,
        silentStaff: silentTotal,
        silentShare,
        panelCoverage: metricValue("panelCoverage"),
        parentBotCoverage: metricValue("botCoverage"),
        todayPanelActive: overview.today.panel.active,
      };

      const signals = [];
      // Tarix yig'ilayotgan bo'lsa "hech kim kirmagan" degan xulosa yolg'on bo'lardi
      if (!overview.collecting && silentTotal > 0) {
        signals.push(
          signal(
            silentShare !== null && silentShare > SILENT_STAFF_SHARE_MEDIUM ? "medium" : "low",
            `${silentTotal} / ${staffTotal} xodim oxirgi ${ACTIVITY_WINDOW_DAYS} kunda panelga bir marta ham kirmagan`,
            {
              // ⚠️ `staff.silent` servisda 12 ta bilan kesilgan — jami `silentStaff` metrikasidan
              staff: {
                items: overview.staff.silent.slice(0, 5).map((row) => ({ id: row.id, name: row.name, role: row.role })),
                total: silentTotal,
                truncated: silentTotal > 5,
              },
            },
          ),
        );
      }

      return { metrics, signals };
    },
  },

  {
    key: "integrity",
    label: "Ma'lumotlar yaxlitligi",
    toolset: "operations",
    async run({ ctx }) {
      // Keshsiz birinchi skan uzoq bo'lishi mumkin: bo'lim chegarasidan OLDIN
      // aniq sabab bilan to'xtaymiz — pass fonda tugab keshni to'ldiradi
      const [finance, inventory] = await withTimeout(
        Promise.all([getReconcile("finance", ctx), getReconcile("inventory", ctx)]),
        SECTION_TIMEOUT_MS - 1000,
        "Yaxlitlik tekshiruvi hali tugamadi va fonda davom etmoqda — birozdan so'ng system_integrity bilan so'rang",
      );
      const shaped = {
        finance: shapeReconcile("finance", finance, { withProblems: false }),
        inventory: shapeReconcile("inventory", inventory, { withProblems: false }),
      };

      const metrics = Object.fromEntries(
        Object.entries(shaped).map(([key, row]) => [
          key,
          { status: row.status, problemCount: row.problemCount ?? null, checkedAtLabel: row.cachedAtLabel },
        ]),
      );

      const signals = [];
      if (shaped.finance.status === "failed") {
        signals.push(
          signal(
            "high",
            finance.deterministic
              ? `Moliyaviy invariantlar tekshiruvi ishlamayapti: ${shaped.finance.error}. Pul qoldiqlari va hisob-faktura summalari tekshirilmayapti; tungi 03:00 dagi tekshiruv ham aynan shu funksiyani chaqiradi, ya'ni har kecha yiqilmoqda`
              : `Moliyaviy invariantlar tekshiruvi yakunlanmadi: ${shaped.finance.error}. Pul qoldiqlari tekshirilmadi — bu "muammo yo'q" degani emas`,
            { error: shaped.finance.error },
          ),
        );
      } else if (shaped.finance.problemCount > 0) {
        signals.push(
          signal(
            "high",
            `Moliyada ${shaped.finance.problemCount} ta nomuvofiqlik topildi (qoldiq yoki summa daftarga mos emas)`,
            { byKind: shaped.finance.byKind },
          ),
        );
      }
      if (shaped.inventory.status === "failed") {
        signals.push(
          signal("medium", `Inventar invariantlari tekshiruvi yakunlanmadi: ${shaped.inventory.error}`, {
            error: shaped.inventory.error,
          }),
        );
      } else if (shaped.inventory.problemCount > 0) {
        signals.push(
          signal("medium", `Inventarda ${shaped.inventory.problemCount} ta nomuvofiqlik topildi`, {
            byKind: shaped.inventory.byKind,
          }),
        );
      }

      return { metrics, signals };
    },
  },
];

/** Bo'lim natijasini yakuniy shaklga keltiradi: signallar saralanadi, holat hisoblanadi. */
function finalizeSection(section, { metrics, signals }) {
  const sorted = [...signals].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const status = sorted.some((row) => row.severity === "high")
    ? "critical"
    : sorted.some((row) => row.severity === "medium")
      ? "warning"
      : "ok";
  return { key: section.key, label: section.label, toolset: section.toolset, status, metrics, signals: sorted };
}

async function runSection(section, scope) {
  try {
    const result = await withTimeout(
      section.run(scope),
      SECTION_TIMEOUT_MS,
      `Bo'lim ${Math.round(SECTION_TIMEOUT_MS / 1000)} soniyada javob bermadi`,
    );
    return finalizeSection(section, result);
  } catch (err) {
    logger.warn(`[AiOverview] "${section.key}" bo'limi o'qilmadi`, {
      branch: scope.ctx.branch?.name,
      error: err.message,
    });
    return {
      key: section.key,
      label: section.label,
      toolset: section.toolset,
      status: "unavailable",
      reason: describeError(err),
      metrics: {},
      signals: [],
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// system_integrity — fon joblari
// ─────────────────────────────────────────────────────────────────────────

const levelToStatus = (level) => (level === "high" ? "critical" : level === "ok" ? "ok" : "warning");

const JOB_CHECKS = [
  {
    key: "invoice_cron",
    label: "Hisob-faktura va oylik shakllantirish (har kuni 06:00)",
    async run(ctx) {
      const cron = assessInvoiceCron(await settingsService.getFinanceSettings(), ctx);
      return { status: levelToStatus(cron.level), detail: cron.detail, evidence: cron.evidence };
    },
  },
  {
    key: "academic_insight",
    label: "Haftalik ta'lim tahlili (dushanba 07:00)",
    async run(ctx) {
      const insight = await assessWeeklyInsight(ctx);
      return { status: levelToStatus(insight.level), detail: insight.detail, evidence: insight.evidence };
    },
  },
  {
    key: "daily_coins",
    label: "Kunlik coin tarqatish (har kuni 23:30, yakshanbadan tashqari)",
    async run(ctx) {
      // Bugun hisobga olinmaydi: cron kun oxirida ishlaydi
      const days = [];
      for (let offset = 1; offset <= COIN_GAP_WINDOW_DAYS; offset += 1) {
        const iso = shiftIsoDays(ctx.today, -offset);
        if (weekdayOf(iso) !== 0) days.push(iso);
      }

      const rows = await Promise.all(
        days.map(async (iso) => {
          const range = tashkentDayRange(iso);
          const [grades, coins] = await Promise.all([
            prisma.grade.count({ where: { date: range } }),
            prisma.coinTransaction.count({ where: { type: "daily", date: range } }),
          ]);
          return { iso, grades, coins };
        }),
      );

      // ⚠️ Coin faqat kunlik baho yig'indisi chegaradan oshganda beriladi,
      // ya'ni baho bor-u coin yo'q kun nazariy jihatdan normal bo'lishi
      // mumkin. Shuning uchun bu "ogohlantirish", "xato" emas.
      const gaps = rows
        .filter((row) => row.grades > 0 && row.coins === 0)
        .map((row) => ({ dateLabel: formatDateUz(`${row.iso}T00:00:00Z`, { utc: true }), grades: row.grades }));

      return gaps.length === 0
        ? {
            status: "ok",
            detail: `Oxirgi ${COIN_GAP_WINDOW_DAYS} kunda baho qo'yilgan har kuni coin tarqatilgan`,
            evidence: {},
          }
        : {
            status: "warning",
            detail: `${gaps.length} kunda baho qo'yilgan, lekin kunlik coin tarqatilmagan — cron o'tkazib yuborgan bo'lishi mumkin`,
            evidence: { days: gaps },
          };
    },
  },
  {
    key: "diagnostic_insights",
    label: "Diagnostika AI tahlillari (har 5 daqiqada)",
    async run(ctx) {
      const since = new Date(ctx.now.getTime() - 7 * DAY_MS);
      const stuckBefore = new Date(ctx.now.getTime() - DIAGNOSTIC_STUCK_MINUTES * MINUTE_MS);
      const [failed, stuck, latestFailed] = await Promise.all([
        prisma.diagnosticInsight.count({ where: { status: "failed", updatedAt: { gte: since } } }),
        prisma.diagnosticInsight.count({
          where: { status: { in: ["queued", "processing"] }, updatedAt: { lt: stuckBefore } },
        }),
        prisma.diagnosticInsight.findFirst({
          where: { status: "failed" },
          orderBy: { updatedAt: "desc" },
          select: { kind: true, error: true, updatedAt: true },
        }),
      ]);
      const evidence = {
        failedLastWeek: failed,
        stuck,
        latestError: latestFailed
          ? {
              kind: latestFailed.kind,
              error: clip(latestFailed.error),
              atLabel: formatDateTimeUz(latestFailed.updatedAt),
            }
          : null,
      };
      if (stuck > 0) {
        return {
          status: "critical",
          detail: `${stuck} ta diagnostika tahlili ${DIAGNOSTIC_STUCK_MINUTES} daqiqadan beri navbatda turibdi — cron ishlamayapti`,
          evidence,
        };
      }
      if (failed > 0) {
        return {
          status: "warning",
          detail: `Oxirgi 7 kunda ${failed} ta diagnostika tahlili xato bilan tugagan`,
          evidence,
        };
      }
      return { status: "ok", detail: "Diagnostika tahlillari navbati normal", evidence };
    },
  },
  {
    key: "schedule_sheet_sync",
    label: "Google Sheets jadval tekshiruvi (har 10 daqiqada)",
    async run() {
      const settings = await settingsService.getScheduleSyncSettings();
      if (settings.mode !== "sheet") {
        return {
          status: "not_applicable",
          detail: "Jadval platformada boshqariladi — Sheets tekshiruvi ishlatilmaydi",
          evidence: {},
        };
      }
      const pendingRevisions = await prisma.scheduleSheetRevision.count({ where: { status: "pending" } });
      const evidence = {
        autoCheck: settings.autoCheck,
        lastCheckedAtLabel: formatDateTimeUz(settings.lastCheckedAt),
        lastCheckOk: settings.lastCheckOk,
        checkFailureCount: settings.checkFailureCount,
        lastCheckError: clip(settings.lastCheckError),
        pendingRevisions,
      };
      if (settings.lastCheckOk === false) {
        return {
          status: settings.checkFailureCount >= 2 ? "critical" : "warning",
          detail: `Oxirgi tekshiruv muvaffaqiyatsiz (ketma-ket ${settings.checkFailureCount} marta)`,
          evidence,
        };
      }
      if (!settings.autoCheck) {
        return { status: "warning", detail: "Avtomatik tekshiruv o'chirilgan", evidence };
      }
      return { status: "ok", detail: `Oxirgi tekshiruv muvaffaqiyatli (${evidence.lastCheckedAtLabel})`, evidence };
    },
  },
  {
    key: "changelog_notifications",
    label: "O'zgarishlar tarixi xabarnomalari (platforma, barcha filiallar)",
    async run(ctx) {
      const since = new Date(ctx.now.getTime() - CHANGELOG_FAILED_WINDOW_DAYS * DAY_MS);
      const [failed, latest] = await Promise.all([
        platformPrisma.changelogNotification.count({ where: { status: "failed", createdAt: { gte: since } } }),
        platformPrisma.changelogNotification.findFirst({
          where: { status: "failed", createdAt: { gte: since } },
          orderBy: { createdAt: "desc" },
          select: { kind: true, label: true, errorMessage: true, createdAt: true },
        }),
      ]);
      if (failed === 0) {
        return {
          status: "ok",
          detail: `Oxirgi ${CHANGELOG_FAILED_WINDOW_DAYS} kunda yuborishda xato yo'q`,
          evidence: {},
        };
      }
      return {
        status: "warning",
        detail: `Oxirgi ${CHANGELOG_FAILED_WINDOW_DAYS} kunda ${failed} ta xabarnoma yuborilmagan`,
        evidence: {
          failed,
          latest: {
            kind: latest.kind,
            recipient: latest.label || null,
            error: clip(latest.errorMessage),
            atLabel: formatDateTimeUz(latest.createdAt),
          },
        },
      };
    },
  },
  {
    key: "message_queue",
    label: "Telegram yetkazish navbati",
    async run(ctx) {
      const queue = await loadQueueHealth(ctx.now);
      const signals = queueSignals(queue);
      const worst = signals.reduce((acc, row) => Math.min(acc, SEVERITY_RANK[row.severity]), 3);
      return {
        status: worst === 0 ? "critical" : worst < 3 ? "warning" : "ok",
        detail: signals.length ? signals.map((row) => row.text).join("; ") : "Navbat normal ishlayapti",
        evidence: queue,
      };
    },
  },
  {
    key: "test_session_expiry",
    label: "Test sessiyalarini yopish (har daqiqada)",
    async run(ctx) {
      const backlog = await prisma.testSession.count({
        where: {
          status: "in_progress",
          expiresAt: { lt: new Date(ctx.now.getTime() - TEST_SESSION_BACKLOG_MINUTES * MINUTE_MS) },
        },
      });
      return backlog > 0
        ? {
            status: "critical",
            detail: `${backlog} ta test sessiyasining vaqti tugagan, lekin yopilmagan — cron ishlamayapti`,
            evidence: { backlog },
          }
        : { status: "ok", detail: "Muddati o'tgan ochiq test sessiyasi yo'q", evidence: {} };
    },
  },
  {
    key: "premium_expiry",
    label: "Premium muddatini tugatish (har soatda)",
    async run(ctx) {
      const backlog = await prisma.user.count({
        where: {
          premiumIsActive: true,
          premiumExpiresAt: { lt: new Date(ctx.now.getTime() - PREMIUM_BACKLOG_HOURS * HOUR_MS) },
        },
      });
      return backlog > 0
        ? {
            status: "critical",
            detail: `${backlog} ta o'quvchining premium muddati tugagan, lekin hali faol — cron ishlamayapti`,
            evidence: { backlog },
          }
        : { status: "ok", detail: "Muddati tugagan faol premium yo'q", evidence: {} };
    },
  },
];

async function runJobCheck(check, ctx) {
  try {
    const result = await withTimeout(check.run(ctx), SECTION_TIMEOUT_MS, "Tekshiruv vaqtida javob bermadi");
    return { key: check.key, label: check.label, ...result };
  } catch (err) {
    logger.warn(`[AiOverview] "${check.key}" job tekshiruvi o'qilmadi`, { error: err.message });
    return { key: check.key, label: check.label, status: "unavailable", detail: describeError(err), evidence: {} };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// branches_compare — filial kesimi
// ─────────────────────────────────────────────────────────────────────────

/**
 * Hozir o'qiyotgan o'quvchilar soni — `activityDashboard.studyingStudentIds`
 * so'rovining aynan nusxasi (u eksport qilinmagan): bugunni qamragan o'qish
 * davri bor VA arxivlanmagan o'quvchi.
 */
async function countStudyingStudents(today) {
  const [rows, activeStudents] = await Promise.all([
    prisma.studentEnrollment.findMany({
      where: { startDate: { lte: today }, OR: [{ endDate: null }, { endDate: { gte: today } }] },
      select: { studentId: true },
      distinct: ["studentId"],
    }),
    prisma.user.findMany({ where: { role: ROLES.STUDENT, isArchived: false }, select: { id: true } }),
  ]);
  const allowed = new Set(activeStudents.map((row) => row.id));
  return rows.filter((row) => allowed.has(row.studentId)).length;
}

/**
 * Bitta filialning ko'rsatkichlari. `mapBranches` ichida — o'sha filial
 * kontekstida — chaqiriladi, shuning uchun o'qish kuni ham (bayramlar filialga
 * xos) shu filial bo'yicha aniqlanadi.
 */
async function loadBranchFigures(month, ctx) {
  const todayDate = new Date(`${ctx.today}T00:00:00Z`);
  const [students, staff, summary, debtors, payrollDebt, attendance, schoolDay] = await Promise.all([
    countStudyingStudents(todayDate),
    prisma.user.count({ where: { isArchived: false, role: { notIn: [ROLES.OWNER, ROLES.STUDENT] } } }),
    invoiceService.getSummary(month),
    invoiceService.getDebtors({ query: { limit: "1" } }),
    payrollService.getEntries({ query: { debtOnly: "true", limit: "1" } }),
    studentAttendanceService.getTodayAllStudents({ query: { limit: "1" } }),
    schoolDayOf(ctx),
  ]);

  return {
    students,
    staff,
    invoiced: summary.totals.amount,
    invoicedLabel: formatMoneyUz(summary.totals.amount),
    collected: summary.totals.paid,
    collectedLabel: formatMoneyUz(summary.totals.paid),
    collectionRate: rateOf(summary.totals.paid, summary.totals.amount),
    previousMonthCollectionRate: rateOf(summary.previous.paid, summary.previous.amount),
    totalDebt: debtors.totals.totalDebt,
    totalDebtLabel: formatMoneyUz(debtors.totals.totalDebt),
    debtorCount: debtors.totals.debtorCount,
    payrollDebt: payrollDebt.totals.debt,
    payrollDebtLabel: formatMoneyUz(payrollDebt.totals.debt),
    // Dam olish kunidagi "0% keldi" davomat emas — stavka faqat o'qish kunida beriladi
    attendanceToday: schoolDay.isSchoolDay
      ? {
          isSchoolDay: true,
          came: attendance.summary.came,
          total: attendance.summary.total,
          unmarked: attendance.summary.unmarked,
          // Hech kim belgilanmagan bo'lsa stavka yo'q (0% emas) — davomat qilinmagan
          rate:
            attendance.summary.total > 0 && attendance.summary.unmarked === attendance.summary.total
              ? null
              : shareOf(attendance.summary.came, attendance.summary.total),
        }
      : { isSchoolDay: false, reason: schoolDay.reason },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Vositalar
// ─────────────────────────────────────────────────────────────────────────

/** Oy argumenti: bo'sh → joriy oy; kelajak oy rad etiladi (unda hali fakt yo'q). */
function scanMonth(value, ctx) {
  const month = monthArg(value);
  if (month > ctx.monthKey) {
    throw new AiToolError(`${monthLabel(month)} hali kelmagan — tahlil faqat joriy yoki o'tgan oy uchun`);
  }
  return month;
}

const platformHealthScan = defineTool({
  name: "platform_health_scan",
  toolset: "core",
  label: "Platforma holati tekshirilmoqda",
  timeoutMs: LIMITS.healthScanTimeoutMs,
  description:
    "Whole-platform health scan for the CURRENT branch. Use it FIRST for broad questions (full analysis, what is wrong, how is the school doing) before drilling down. " +
    "Runs ten sections in parallel: finance (collection rate, accrued/collected, debt, invoice cron), payroll (accrued/paid, unpaid closed months, staff without salary setup, pending requests), expenses (budget limits), academic (attendance, grades, plans, data gaps, weekly insight), attendance_today (students/staff), schedule (conflicts, Google Sheets sync, substitutions), operations (overdue tasks, Telegram queue, inventory checks, damage charges, stale leads), security (open alerts, all branches), activity (silent staff, 7 days), integrity (finance/inventory reconcile, cached 10 min). " +
    "Each section returns status ok|warning|critical|unavailable, compact metrics, signals sorted by severity with concrete numbers, and the toolset to open for details. Thresholds are fixed in code. Money values are strings in so'm with *Label fields.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      month: monthSchema(
        "Month for the month-based sections (finance, payroll, expenses, academic) as YYYYMM, e.g. 202609. Omit for the current month. Future months are rejected. Today-based sections always use today.",
      ),
    },
  },
  async handler(args, ctx) {
    const month = scanMonth(args.month, ctx);
    assertNotAborted(ctx);
    const scope = {
      ctx,
      month,
      shared: { financeSettings: once(() => settingsService.getFinanceSettings()) },
    };

    const sections = await Promise.all(SECTIONS.map((section) => runSection(section, scope)));

    const summary = { critical: 0, warning: 0, ok: 0, unavailable: 0 };
    for (const section of sections) summary[section.status] += 1;

    sections.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));

    return {
      branch: ctx.branch.name,
      month,
      monthLabel: monthLabel(month),
      generatedAtLabel: formatDateTimeUz(ctx.now),
      summary,
      sections,
    };
  },
});

const branchesCompare = defineTool({
  name: "branches_compare",
  toolset: "core",
  label: "Filiallar taqqoslanmoqda",
  timeoutMs: LIMITS.healthScanTimeoutMs,
  description:
    "Side-by-side comparison of ALL operational branches (not just the current one). Use for questions like which branch performs better, compare branches, or school-wide totals across branches. " +
    "Per branch: studying students (open enrollment today, not archived), staff count, the month's invoiced/collected amounts and collection rate (plus previous month's rate), total outstanding student debt and debtor count (all months), outstanding payroll debt (all months), and today's student attendance (came/total/unmarked/rate; on a non-school day of that branch only isSchoolDay:false with a reason). " +
    "A branch that fails or times out is returned with status unavailable and a reason. Totals sum only available branches. Money values are strings in so'm with *Label fields.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      month: monthSchema(
        "Month for invoiced/collected figures as YYYYMM, e.g. 202609. Omit for the current month. Future months are rejected.",
      ),
    },
  },
  async handler(args, ctx) {
    const month = scanMonth(args.month, ctx);
    assertNotAborted(ctx);

    const results = await mapBranches(
      () =>
        withTimeout(
          loadBranchFigures(month, ctx),
          SECTION_TIMEOUT_MS,
          `Filial ${Math.round(SECTION_TIMEOUT_MS / 1000)} soniyada javob bermadi`,
        ),
      { label: "[AiBranchesCompare]" },
    );

    const branches = results
      .map(({ branch, value, error }) => {
        const head = {
          branchId: branch.id,
          name: branch.name,
          code: branch.code,
          isCurrent: branch.id === ctx.branch.id,
          isActive: branch.isActive,
        };
        return error
          ? { ...head, status: "unavailable", reason: describeError(error) }
          : { ...head, status: "ok", ...value };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "uz"));

    const available = branches.filter((row) => row.status === "ok");
    if (available.length === 0) {
      return {
        month,
        monthLabel: monthLabel(month),
        generatedAtLabel: formatDateTimeUz(ctx.now),
        empty: true,
        reason: branches.length === 0 ? "Ishlaydigan filial topilmadi" : "Birorta filial ma'lumotini o'qib bo'lmadi",
        branches,
      };
    }

    const invoiced = sumAmounts(available.map((row) => row.invoiced));
    const collected = sumAmounts(available.map((row) => row.collected));
    const totalDebt = sumAmounts(available.map((row) => row.totalDebt));
    const payrollDebt = sumAmounts(available.map((row) => row.payrollDebt));

    return {
      month,
      monthLabel: monthLabel(month),
      generatedAtLabel: formatDateTimeUz(ctx.now),
      branchCount: branches.length,
      unavailableCount: branches.length - available.length,
      branches,
      totals: {
        students: available.reduce((sum, row) => sum + row.students, 0),
        staff: available.reduce((sum, row) => sum + row.staff, 0),
        invoicedLabel: formatMoneyUz(formatAmount(invoiced)),
        collectedLabel: formatMoneyUz(formatAmount(collected)),
        collectionRate: rateOf(collected, invoiced),
        totalDebtLabel: formatMoneyUz(formatAmount(totalDebt)),
        debtorCount: available.reduce((sum, row) => sum + row.debtorCount, 0),
        payrollDebtLabel: formatMoneyUz(formatAmount(payrollDebt)),
      },
    };
  },
});

const systemIntegrity = defineTool({
  name: "system_integrity",
  toolset: "core",
  label: "Tizim yaxlitligi tekshirilmoqda",
  timeoutMs: LIMITS.healthScanTimeoutMs,
  description:
    "Technical health of the CURRENT branch: data invariants and background jobs. Use when the owner asks whether the system works correctly, about data mismatches, or when platform_health_scan flags the integrity section. " +
    "Returns (1) finance reconcile (account balances, deposits, invoice paid/amount identities, payroll paid/amount) and inventory reconcile (stock vs ledger, damage charges, transfers): status ok|problems|failed, counts per kind with Uzbek labels, first 30 problems (total and truncated flags); results are cached per branch for 10 minutes (cachedAtLabel, fromCache), refresh=true forces a new full scan. " +
    "(2) Background job liveness: invoice/payroll cron, weekly academic insight, daily coins, diagnostic AI queue, Google Sheets sync, changelog notifications (platform-wide), Telegram queues, test session expiry, premium expiry; each with status ok|warning|critical|unavailable|not_applicable, an Uzbek detail and evidence.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      refresh: {
        type: "boolean",
        description: "true to bypass the 10-minute reconcile cache and run a fresh full scan (heavy). Default false.",
        default: false,
      },
    },
  },
  async handler(args, ctx) {
    const refresh = args.refresh === true;
    assertNotAborted(ctx);

    const reconcileSection = async (kind) => {
      try {
        return shapeReconcile(kind, await getReconcile(kind, ctx, { refresh }), { withProblems: true });
      } catch (err) {
        return { key: kind, label: RECONCILE_PASSES[kind].label, status: "unavailable", reason: describeError(err) };
      }
    };

    const [finance, inventory, jobs] = await Promise.all([
      reconcileSection("finance"),
      reconcileSection("inventory"),
      Promise.all(JOB_CHECKS.map((check) => runJobCheck(check, ctx))),
    ]);

    const jobSummary = { critical: 0, warning: 0, ok: 0, unavailable: 0, not_applicable: 0 };
    for (const job of jobs) jobSummary[job.status] += 1;

    return {
      branch: ctx.branch.name,
      generatedAtLabel: formatDateTimeUz(ctx.now),
      reconcile: { finance, inventory },
      jobSummary,
      jobs,
    };
  },
});

module.exports = [platformHealthScan, branchesCompare, systemIntegrity];
