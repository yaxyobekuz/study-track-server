/**
 * OTA-ONA NAZORATI — WATCHDOG (har 30 daqiqada) va TOZALASH (03:30).
 *
 * Har 30 daqiqada, har filialda:
 *   1. 24 soatdan beri jim qurilma → `offline` hodisasi + ota-onaga push.
 *      ⚠️ BIR MARTA: `offlineAlertAt` compare-and-swap bilan "egallanadi" —
 *      qurilma qaytib kelmaguncha (har qanday device so'rovi uni tozalaydi)
 *      qayta ogohlantirilmaydi, ikki parallel pass ikki push jo'natmaydi.
 *   2. Muddati o'tgan `pending` ruxsat so'rovlari → `expired`.
 *   3. Muddati o'tgan "hammasini bloklash" → yechiladi, versiya +1, jim push.
 *      (So'rovda ham yechiladi — `expireLockAllIfDue`; bu yerda telefon
 *      o'zi so'ramasa ham push ketishi uchun.)
 *
 * Har kuni 03:30 — saqlash muddatidan eskisi O'CHIRILADI:
 *   statistika 90 kun, hodisalar va hal bo'lgan so'rovlar 180 kun, 180 kun
 *   jim qurilma. ⚠️ Bu majburiyat, gigiyena emas: bolaning ekran vaqtini
 *   cheksiz saqlash asossiz ma'lumot to'plash bo'lardi (`devices.md` §8).
 *
 * ⚠️ `branchCron` — filial konteksti MAJBURIY (`CLAUDE.md`). Job hech qachon
 * jarayonni yiqitmaydi; bir pass tugamasdan keyingisi boshlanmaydi.
 */

const cron = require("node-cron");

const prisma = require("../config/prisma");
const { forEachBranch } = require("../helpers/branchIterator");
const { getBranch } = require("../config/branchContext");
const { currentDayDate } = require("../helpers/month.helpers");
const logger = require("../utils/logger");
const policyService = require("../services/parentalPolicy.service");
const parentalService = require("../services/parental.service");
const eventService = require("../services/parentalEvent.service");

const DAY_MS = 24 * 60 * 60 * 1000;
const OFFLINE_AFTER_MS = DAY_MS;
const BATCH = 200;
/** Bitta passda ko'pi bilan shuncha partiya — biror qator qotib qolsa ham pass tugaydi. */
const MAX_BATCHES = 50;

const USAGE_RETENTION_DAYS = 90;
const EVENT_RETENTION_DAYS = 180;
const REQUEST_RETENTION_DAYS = 180;
const DEVICE_RETENTION_DAYS = 180;

const tagOf = (label) => `${label} ${getBranch()?.name ?? "?"}`;

/**
 * Jim qurilmalar — bitta filial.
 * @returns {Promise<{ alerted: number, failed: number }>}
 */
async function alertOfflineDevices() {
  const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS);
  let alerted = 0;
  let failed = 0;

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const devices = await prisma.parentalDevice.findMany({
      where: { offlineAlertAt: null, lastSeenAt: { lt: cutoff } },
      orderBy: { lastSeenAt: "asc" },
      take: BATCH,
      select: { id: true, studentId: true, deviceId: true, lastSeenAt: true },
    });
    if (devices.length === 0) break;

    const students = await prisma.user.findMany({
      where: { id: { in: [...new Set(devices.map((d) => d.studentId))] } },
      select: { id: true, firstName: true, isArchived: true },
    });
    const studentById = new Map(students.map((s) => [s.id, s]));

    let progressed = 0;
    for (const device of devices) {
      try {
        // Egallash: shu paytgacha qaytib kelmagan va hali ogohlantirilmagan
        const { count } = await prisma.parentalDevice.updateMany({
          where: { id: device.id, offlineAlertAt: null, lastSeenAt: { lt: cutoff } },
          data: { offlineAlertAt: new Date() },
        });
        progressed += 1;
        if (count !== 1) continue;

        // ⚠️ Arxivlangan o'quvchi — egallanadi (har passda qayta o'qilmasin),
        // lekin push yo'q: u maktab o'quvchisi emas.
        const student = studentById.get(device.studentId);
        if (!student || student.isArchived) continue;

        await eventService.recordEvent({
          studentId: device.studentId,
          deviceId: device.deviceId,
          type: "offline",
          payload: { lastSeenAt: device.lastSeenAt.toISOString() },
          studentName: student.firstName ?? null,
        });
        alerted += 1;
      } catch (error) {
        failed += 1;
        logger.warn(`[ParentalWatchdog] oflayn ogohlantirish xatosi: ${error.message}`);
      }
    }

    if (devices.length < BATCH || progressed === 0) break;
  }

  return { alerted, failed };
}

/**
 * Muddati o'tgan "hammasini bloklash" — bitta filial.
 * @returns {Promise<number>}
 */
async function expireLockAll() {
  const due = await prisma.parentalSettings.findMany({
    where: { lockAll: true, lockAllUntil: { lte: new Date() } },
    select: { id: true, studentId: true, lockAll: true, lockAllUntil: true },
    take: BATCH * MAX_BATCHES,
  });

  let expired = 0;
  for (const settings of due) {
    try {
      const after = await policyService.expireLockAllIfDue(settings.studentId, settings);
      if (!after.lockAll) expired += 1;
    } catch (error) {
      logger.warn(`[ParentalWatchdog] blok yechilmadi: ${error.message}`);
    }
  }
  return expired;
}

/** Bitta filial uchun watchdog passi. */
async function runParentalWatchdogPass() {
  const tag = tagOf("[ParentalWatchdog]");

  const offline = await alertOfflineDevices();
  const expiredRequests = await parentalService.expirePendingRequests();
  const expiredLocks = await expireLockAll();

  if (offline.alerted || offline.failed || expiredRequests || expiredLocks) {
    logger.info(
      `${tag} oflayn: ${offline.alerted} (xato: ${offline.failed}), ` +
        `muddati o'tgan so'rov: ${expiredRequests}, yechilgan blok: ${expiredLocks}`,
    );
  }

  return { offline, expiredRequests, expiredLocks };
}

/** Bitta filial uchun tozalash passi. */
async function runParentalCleanupPass() {
  const tag = tagOf("[ParentalCleanup]");
  const now = Date.now();

  // ⚠️ Statistika chegarasi KUN aniqligida (`@db.Date`, `getUTC*`) —
  // instant bilan taqqoslansa chegaradagi kun bir kunga siljirdi.
  const usageCutoff = new Date(currentDayDate().getTime() - USAGE_RETENTION_DAYS * DAY_MS);

  const [usage, events, requests, devices] = await Promise.all([
    prisma.appUsageDaily.deleteMany({ where: { date: { lt: usageCutoff } } }),
    prisma.parentalEvent.deleteMany({
      where: { createdAt: { lt: new Date(now - EVENT_RETENTION_DAYS * DAY_MS) } },
    }),
    prisma.parentalUnlockRequest.deleteMany({
      where: {
        status: { not: "pending" },
        createdAt: { lt: new Date(now - REQUEST_RETENTION_DAYS * DAY_MS) },
      },
    }),
    prisma.parentalDevice.deleteMany({
      where: { lastSeenAt: { lt: new Date(now - DEVICE_RETENTION_DAYS * DAY_MS) } },
    }),
  ]);

  if (usage.count || events.count || requests.count || devices.count) {
    logger.info(
      `${tag} o'chirildi — statistika: ${usage.count}, hodisa: ${events.count}, ` +
        `so'rov: ${requests.count}, qurilma: ${devices.count}`,
    );
  }

  return {
    usage: usage.count,
    events: events.count,
    requests: requests.count,
    devices: devices.count,
  };
}

/**
 * Filiallar bo'ylab yuguradi; oldingisi tugamagan bo'lsa bu tick o'tkazib
 * yuboriladi (katta bazada pass 30 daqiqadan oshsa ikkitasi ustma-ust
 * ishlab, bir-birining qulflarini kutmasin).
 */
function guarded(label, pass) {
  let running = false;

  return async () => {
    if (running) {
      logger.warn(`${label} oldingi pass hali tugamagan — o'tkazib yuborildi`);
      return;
    }
    running = true;
    const startedAt = Date.now();
    logger.info(`${label} boshlandi`);

    try {
      await forEachBranch(() => pass(), { label });
      logger.info(`${label} tugadi (${Date.now() - startedAt} ms)`);
    } catch (error) {
      logger.error(`${label} xatosi: ${error.message}`);
    } finally {
      running = false;
    }
  };
}

/** Cron joblarni belgilaydi (Asia/Tashkent). */
function startParentalWatchdogCron() {
  cron.schedule("*/30 * * * *", guarded("[ParentalWatchdog]", runParentalWatchdogPass), {
    scheduled: true,
    timezone: "Asia/Tashkent",
  });
  cron.schedule("30 3 * * *", guarded("[ParentalCleanup]", runParentalCleanupPass), {
    scheduled: true,
    timezone: "Asia/Tashkent",
  });

  logger.info(
    "Ota-ona nazorati cron joblari belgilandi: watchdog har 30 daqiqada, tozalash 03:30 (Asia/Tashkent)",
  );
}

module.exports = {
  startParentalWatchdogCron,
  runParentalWatchdogPass,
  runParentalCleanupPass,
};
