/**
 * DARS JADVALI MANBAI: PLATFORMA ↔ GOOGLE SHEETS — boshqaruv.
 *
 * Bu servis:
 *   · sheet havolasini sozlaydi va varaqni yuklab o'qiydi (tekshirish);
 *   · sheet o'zgarishini tasdiqlash yoki rad etishni bajaradi;
 *   · manbani almashtiradi (platforma ↔ sheet) va arxiv versiyani tiklaydi;
 *   · nom moslash qoidalarini saqlaydi;
 *   · mas'ul odamlarga Telegram orqali xabar beradi.
 *
 * "Nima o'zgaradi, xavfsizmi" degan savol — `scheduleSyncReview.service.js`.
 *
 * ── HECH NARSA YO'QOLMAYDI ───────────────────
 *
 * Amaldagi jadvalni almashtiradigan har amal (qo'llash, rejim almashtirish,
 * tiklash) BITTA tranzaksiyada va BITTA qulf ostida (`withScheduleWriteLock`):
 *   1. rejim va "ko'rib chiqilgan holat" qayta tekshiriladi — odam ko'rgan
 *      amaldagi jadval (`activeHash`) va yoziladigan natija (`newHash`)
 *      qulf ichida qayta hisoblanadi; bittasi farq qilsa — 409;
 *   2. joriy holat arxivga (`schedule_snapshots`) yoziladi va QAYTA O'QIB
 *      tekshiriladi;
 *   3. yangi holat yoziladi va yana QAYTA O'QIB tekshiriladi.
 * Istalgan qadam mos kelmasa tranzaksiya to'liq orqaga qaytadi: yarim
 * yozilgan jadval ham, tiklab bo'lmaydigan arxiv ham qolmaydi.
 */

const path = require("path");
const { Worker } = require("worker_threads");
const prisma = require("../config/prisma");
const { getBranch, requireBranch } = require("../config/branchContext");
const { config } = require("../config/env.config");
const logger = require("../utils/logger");
const { BadRequestError, NotFoundError, ConflictError } = require("../utils/errors");
const { generateId } = require("../utils/idGenerator");
const { isValidId } = require("../utils/objectId");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");
const { ROLES } = require("../utils/constants");
const { PERMISSIONS } = require("../utils/permissions");
const telegramService = require("./telegram.service");
const { escapeHtml } = require("../helpers/changelogMessage.helpers");
const { decodeEntities } = require("../helpers/changelogMarkdown.helpers");
const { formatDateTimeUz } = require("../helpers/date.helpers");
const { currentMonthKey } = require("../helpers/month.helpers");
const sheet = require("../helpers/scheduleSheet.helpers");
const { hashState, countLessons } = require("../helpers/scheduleState.helpers");
const { getScheduleSyncSettings } = require("./settings.service");
const { getMonthCalendar } = require("./lessonHours.service");
const { teacherName } = require("./schedule.service");
const { withScheduleWriteLock, readSourceMode, MODES } = require("./scheduleWriteGuard.service");
const review = require("./scheduleSyncReview.service");

const SINGLETON = "singleton";
const MAPPING_KINDS = ["class", "subject", "teacher"];
const MAX_MAPPING_ITEMS = 500;
const MAX_TAB_LENGTH = 200;
const MAX_REASON_LENGTH = 500;

const FETCH_TIMEOUT_MS = 30000;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

// Nosozlik xabari: ketma-ket 2 ta xatodan keyin, 6 soatda bir martadan ko'p emas
// (sheet tahrirlanayotganda bir-ikki tekshiruv xato berishi tabiiy).
const FAILURE_NOTIFY_AFTER = 2;
const FAILURE_NOTIFY_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Hech qachon qo'llanmagan, eskirgan tahrirlar shuncha kundan keyin o'chiriladi.
// Qo'llangan/rad etilgan tahrirlar va arxiv nusxalar O'CHIRILMAYDI.
const SUPERSEDED_RETENTION_DAYS = 30;

const HASH_RE = /^[0-9a-f]{64}$/;

// Bir filialda bir vaqtda bitta yuklab olish (tugma qayta-qayta bosilsa yoki
// cron bilan ustma-ust tushsa, ikkinchisi birinchisining natijasini kutadi).
const inflight = new Map();

function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const promise = (async () => {
    try {
      return await fn();
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

const branchKey = (suffix) => `${requireBranch().schemaName}:${suffix}`;

// ─────────────────────────────────────────────
// Yuklab olish
// ─────────────────────────────────────────────

const NOT_PUBLIC_MESSAGE =
  "Jadvalni o'qib bo'lmadi: sheet ochiq emas. Google Sheets'da \"Ulashish\" → \"Havolaga ega har kim ko'ra oladi\" qilib qo'ying";

async function readLimited(body, maxBytes) {
  if (!body) throw new BadRequestError("Google Sheets bo'sh javob qaytardi");
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BadRequestError(`Sheet fayli juda katta (${Math.round(maxBytes / 1024 / 1024)} MB dan ortiq)`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Sheet kitobini XLSX sifatida yuklab oladi. URL server o'zi yig'adi.
 * Faqat BAYTLAR qaytadi — o'qish alohida oqimda (`readSheetInWorker`).
 * @param {string} spreadsheetId
 * @returns {Promise<Buffer>}
 */
async function downloadWorkbook(spreadsheetId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const timeoutError = () =>
    new BadRequestError("Google Sheets 30 soniya ichida javob bermadi. Birozdan so'ng qayta urinib ko'ring");

  try {
    let response;
    try {
      response = await fetch(sheet.buildExportUrl(spreadsheetId), {
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "study-track-schedule-sync/1.0" },
      });
    } catch (error) {
      if (error.name === "AbortError") throw timeoutError();
      throw new BadRequestError("Google Sheets'ga ulanib bo'lmadi. Internet ulanishini tekshiring");
    }

    if (response.status === 404) {
      throw new BadRequestError("Jadval topilmadi: havola noto'g'ri yoki jadval o'chirilgan");
    }
    if (response.status === 401 || response.status === 403) throw new BadRequestError(NOT_PUBLIC_MESSAGE);
    if (!response.ok) {
      throw new BadRequestError(`Google Sheets xatosi (HTTP ${response.status}). Birozdan so'ng qayta urinib ko'ring`);
    }
    // Yopiq sheet 200 bilan kirish sahifasini (HTML) qaytaradi
    if ((response.headers.get("content-type") || "").includes("text/html")) {
      throw new BadRequestError(NOT_PUBLIC_MESSAGE);
    }
    if (Number(response.headers.get("content-length") || 0) > MAX_DOWNLOAD_BYTES) {
      throw new BadRequestError("Sheet fayli juda katta (20 MB dan ortiq)");
    }

    let buffer;
    try {
      buffer = await readLimited(response.body, MAX_DOWNLOAD_BYTES);
    } catch (error) {
      if (error.name === "AbortError") throw timeoutError();
      throw error;
    }

    // XLSX — ZIP arxiv ("PK\x03\x04")
    if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
      throw new BadRequestError("Google Sheets kutilgan formatda (XLSX) javob bermadi");
    }
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

const SHEET_WORKER = path.join(__dirname, "../helpers/scheduleSheet.worker.js");
const WORKER_TIMEOUT_MS = 60000;
const WORKER_MEMORY_MB = 512;

/**
 * XLSX'ni alohida oqimda o'qiydi — xotira va vaqt chegarasi bilan.
 * Katta yoki buzilgan fayl faqat shu oqimni to'xtatadi, serverni emas
 * (sababi `scheduleSheet.worker.js` izohida).
 *
 * @param {Buffer} buffer
 * @param {"parse"|"tabs"} task
 * @param {string} [tabName]
 * @returns {Promise<object>} `{ parsed }` yoki `{ tabs }`
 */
function readSheetInWorker(buffer, task, tabName) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(SHEET_WORKER, {
      workerData: { buffer: new Uint8Array(buffer), task, tabName },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB },
    });
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      settle(value);
    };
    const timer = setTimeout(
      () =>
        finish(
          reject,
          new BadRequestError("Sheet'ni o'qish 60 soniyadan oshdi — faylda juda katta varaq bor"),
        ),
      WORKER_TIMEOUT_MS,
    );

    worker.once("message", (message) => {
      if (message?.ok) return finish(resolve, message.result);
      const error =
        message?.statusCode === 400
          ? new BadRequestError(message.message)
          : new Error(message?.message || "Sheet faylini o'qib bo'lmadi");
      return finish(reject, error);
    });
    worker.once("error", (error) => {
      logger.warn(`[ScheduleSync] Sheet o'qish oqimi to'xtadi: ${error.code || ""} ${error.message}`);
      finish(
        reject,
        new BadRequestError(
          error.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? "Sheet fayli juda katta — uni o'qishga xotira yetmadi. Keraksiz katta varaqlarni boshqa faylga ko'chiring"
            : "Sheet faylini o'qib bo'lmadi",
        ),
      );
    });
    worker.once("exit", () => finish(reject, new BadRequestError("Sheet faylini o'qib bo'lmadi")));
  });
}

// ─────────────────────────────────────────────
// Holat
// ─────────────────────────────────────────────

/**
 * Faqat rejim — jadval sahifalari tahrirni yopish uchun. Yozmaydi.
 * @returns {Promise<{mode: string}>}
 */
async function getMode() {
  return { mode: await readSourceMode() };
}

/**
 * To'liq holat (Google Sheets sahifasi uchun).
 * @param {object} user - req.user
 */
async function getStatus(user) {
  const settings = await getScheduleSyncSettings();
  const [latestRef, activeRows, platformSnapshot, indexPresent] = await Promise.all([
    review.findLatestRevision(prisma, settings),
    review.loadActiveRows(prisma),
    settings.platformSnapshotId
      ? prisma.scheduleSnapshot.findUnique({
          where: { id: settings.platformSnapshotId },
          omit: { data: true },
        })
      : null,
    review.uniqueIndexPresent(prisma),
  ]);

  const latest = latestRef
    ? await prisma.scheduleSheetRevision.findUnique({ where: { id: latestRef.id }, omit: { data: true, resolution: true } })
    : null;
  const users = await review.loadUsersById(prisma, [
    settings.modeChangedBy,
    latest?.fetchedBy,
    latest?.reviewedBy,
    platformSnapshot?.createdBy,
  ]);

  const perDay = new Map();
  for (const row of activeRows) {
    const key = `${row.classId}|${row.day}`;
    perDay.set(key, (perDay.get(key) || 0) + 1);
  }
  const duplicateRows = [...perDay.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0);

  const activeHash = hashState(activeRows);
  const mode = settings.mode || MODES.PLATFORM;

  return {
    mode,
    sheetUrl: settings.sheetUrl,
    spreadsheetId: settings.spreadsheetId,
    sheetTab: settings.sheetTab,
    autoCheck: settings.autoCheck,
    lastCheckedAt: settings.lastCheckedAt,
    lastCheckOk: settings.lastCheckOk,
    lastCheckError: settings.lastCheckError,
    checkFailureCount: settings.checkFailureCount,
    modeChangedAt: settings.modeChangedAt,
    modeChangedBy: settings.modeChangedBy
      ? review.userRef(users.get(settings.modeChangedBy)) || { id: settings.modeChangedBy, name: "—" }
      : null,
    platformSnapshot: platformSnapshot ? review.snapshotSummary(platformSnapshot, users) : null,
    latestRevision: latest ? review.revisionSummary(latest, { latestId: latest.id, users }) : null,
    active: {
      hash: activeHash,
      classCount: new Set(activeRows.map((r) => r.classId)).size,
      lessonCount: countLessons(activeRows),
    },
    inSync:
      mode === MODES.SHEET && settings.appliedStateHash ? settings.appliedStateHash === activeHash : null,
    checkFresh: review.isCheckFresh(settings),
    integrity: { duplicateRows, uniqueIndexPresent: indexPresent },
    can: review.userCan(user),
  };
}

// ─────────────────────────────────────────────
// Sozlash va varaqlar
// ─────────────────────────────────────────────

/**
 * `xss-clean` so'rov tanasidagi "<" ni "&lt;" ga aylantiradi. Varaq va sheet
 * nomi ekranga emas, sheet bilan TAQQOSLASHga ketadi — asl ko'rinishiga
 * qaytariladi.
 */
const decodeText = (value) => sheet.cleanLabel(decodeEntities(value ?? ""));

async function updateConfig(body, user) {
  const sheetUrl = sheet.cleanLabel(body?.sheetUrl);
  const spreadsheetId = sheet.extractSpreadsheetId(sheetUrl);
  const sheetTab = decodeText(body?.sheetTab);
  if (!sheetTab) throw new BadRequestError("Varaq nomini tanlang");
  if (sheetTab.length > MAX_TAB_LENGTH) throw new BadRequestError("Varaq nomi juda uzun");
  if (body?.autoCheck !== undefined && typeof body.autoCheck !== "boolean") {
    throw new BadRequestError("autoCheck true yoki false bo'lishi kerak");
  }

  await getScheduleSyncSettings(); // qator bo'lmasa yaratiladi (tranzaksiyadan tashqarida)

  await withScheduleWriteLock(async (tx) => {
    const current = await tx.scheduleSyncSettings.findUnique({ where: { id: SINGLETON } });
    const changed =
      current.spreadsheetId !== spreadsheetId ||
      sheet.normalizeKey(current.sheetTab) !== sheet.normalizeKey(sheetTab);

    const data = { sheetUrl, spreadsheetId, sheetTab, updatedBy: user.id };
    if (body.autoCheck !== undefined) data.autoCheck = body.autoCheck;
    if (changed) {
      // Boshqa sheet — eski tekshiruv natijasi va kutilayotgan tahrirlar
      // unga tegishli emas.
      Object.assign(data, {
        configChangedAt: new Date(),
        lastCheckedAt: null,
        lastCheckOk: null,
        lastCheckError: null,
        checkFailureCount: 0,
        failureNotifiedAt: null,
      });
    }
    await tx.scheduleSyncSettings.update({ where: { id: SINGLETON }, data });

    if (changed) {
      await tx.scheduleSheetRevision.updateMany({
        where: { status: "pending" },
        data: { status: "superseded" },
      });
    }
  });

  logger.info(`[ScheduleSync] Sheet sozlandi: ${spreadsheetId} / "${sheetTab}" (${user.id})`);
  return getStatus(user);
}

/**
 * Havoladagi KO'RINADIGAN varaqlar ro'yxati (sozlash oynasi uchun).
 */
async function inspectSheet(body) {
  const spreadsheetId = sheet.extractSpreadsheetId(sheet.cleanLabel(body?.sheetUrl));
  return once(branchKey(`inspect:${spreadsheetId}`), async () => {
    const buffer = await downloadWorkbook(spreadsheetId);
    const { tabs } = await readSheetInWorker(buffer, "tabs");
    return { spreadsheetId, tabs };
  });
}

// ─────────────────────────────────────────────
// Tekshirish (sheet'ni o'qish → tahrir)
// ─────────────────────────────────────────────

/**
 * Sheet'ni o'qiydi. Mazmun oxirgi tahrirdan farq qilsa — yangi tahrir
 * (`pending`) yoziladi, eskirgan kutilayotganlari `superseded` bo'ladi.
 * Amaldagi jadvalga TEGMAYDI.
 *
 * @param {{actorId: string|null}} options - null — avtomatik tekshiruv
 * @returns {Promise<{created: boolean, revision: object}>}
 */
async function checkSheet({ actorId = null } = {}) {
  const settings = await getScheduleSyncSettings();
  if (!settings.spreadsheetId || !settings.sheetTab) {
    throw new BadRequestError("Avval Google Sheets havolasi va varag'ini sozlang");
  }
  // Kalitda sozlama ham bor: havola almashgan paytda ESKI sheet'ning davom
  // etayotgan tekshiruvi yangisining natijasi bo'lib qaytmasin.
  const key = branchKey(`check:${settings.spreadsheetId}:${sheet.normalizeKey(settings.sheetTab)}`);
  return once(key, () => runCheck(actorId, settings));
}

async function runCheck(actorId, settings) {
  let parsed;
  try {
    const buffer = await downloadWorkbook(settings.spreadsheetId);
    ({ parsed } = await readSheetInWorker(buffer, "parse", settings.sheetTab));
  } catch (error) {
    await recordCheckFailure(error, settings);
    throw error;
  }
  const contentHash = sheet.hashParsedSheet(parsed);

  const outcome = await withScheduleWriteLock(async (tx) => {
    const current = await tx.scheduleSyncSettings.findUnique({ where: { id: SINGLETON } });
    if (
      !current ||
      current.spreadsheetId !== settings.spreadsheetId ||
      sheet.normalizeKey(current.sheetTab) !== sheet.normalizeKey(settings.sheetTab)
    ) {
      throw new ConflictError("Tekshiruv paytida sheet havolasi o'zgartirildi — qayta tekshiring", {
        reason: "config_changed",
      });
    }

    const latestAny = await tx.scheduleSheetRevision.findFirst({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        spreadsheetId: true,
        sheetTab: true,
        contentHash: true,
        status: true,
        createdAt: true,
        notifiedAt: true,
      },
    });
    const latest = latestAny && review.sameConfig(latestAny, current) ? latestAny : null;

    // Mavjud tahrir faqat JORIY sozlamadan keyin olingan bo'lsa qayta
    // ishlatiladi. Havola boshqasiga o'zgartirilib, yana qaytarilsa, eski
    // tahrir "sozlamadan oldingi" bo'lib qoladi va hech qachon "yangi
    // tekshirilgan" hisoblanmasdi — qo'llash abadiy to'silib qolardi.
    const reusable =
      latest &&
      latest.contentHash === contentHash &&
      latest.status !== "superseded" &&
      !(current.configChangedAt && latest.createdAt < current.configChangedAt);

    let revisionId;
    let created = false;
    if (reusable) {
      revisionId = latest.id;
    } else {
      const revision = await tx.scheduleSheetRevision.create({
        data: {
          spreadsheetId: current.spreadsheetId,
          sheetTab: current.sheetTab,
          contentHash,
          data: parsed,
          lessonCount: parsed.lessons.length,
          classCount: parsed.classes.length,
          issueCount: parsed.issues.length,
          status: "pending",
          fetchedBy: actorId,
        },
        select: { id: true },
      });
      revisionId = revision.id;
      created = true;
      await tx.scheduleSheetRevision.updateMany({
        where: { status: "pending", id: { not: revision.id } },
        data: { status: "superseded" },
      });
    }

    // Muvaffaqiyatli tekshiruv — nosozlik davri tugadi: keyingi uzilish
    // haqida yana xabar berilsin (6 soatlik kutish faqat BITTA uzilish ichida).
    await tx.scheduleSyncSettings.update({
      where: { id: SINGLETON },
      data: {
        lastCheckedAt: new Date(),
        lastCheckOk: true,
        lastCheckError: null,
        checkFailureCount: 0,
        failureNotifiedAt: null,
      },
    });

    // "Oldingi o'zgarish haqida odamlarga aytilgan va u hali kutilmoqda" —
    // shundagina yangi xabar yuborilmaydi. Xabarsiz qolgan (masalan
    // o'zgarishsiz) tahrir keyingi haqiqiy o'zgarish xabarini yutib yubormaydi.
    const previousWasAnnounced = latest?.status === "pending" && Boolean(latest.notifiedAt);
    return { created, revisionId, mode: current.mode, previousWasAnnounced };
  });

  if (outcome.created && outcome.mode === MODES.SHEET && !outcome.previousWasAnnounced) {
    await notifyNewRevision(outcome.revisionId).catch((error) =>
      logger.warn(`[ScheduleSync] Xabar yuborilmadi: ${error.message}`),
    );
  }

  const revision = await prisma.scheduleSheetRevision.findUnique({
    where: { id: outcome.revisionId },
    omit: { data: true, resolution: true },
  });
  const users = await review.loadUsersById(prisma, [revision.fetchedBy, revision.reviewedBy]);
  return {
    created: outcome.created,
    revision: review.revisionSummary(revision, { latestId: revision.id, users }),
  };
}

/**
 * Muvaffaqiyatsiz tekshiruvni qayd etadi. Asl xatoni yashirmaydi: o'zi
 * yiqilsa ham faqat log yoziladi.
 *
 * @param {Error} error
 * @param {{spreadsheetId: string, sheetTab: string}} checked - tekshirilgan sozlama
 */
async function recordCheckFailure(error, checked) {
  try {
    const message = String(error?.message || "Noma'lum xato").slice(0, 500);
    let notify = null;

    await withScheduleWriteLock(async (tx) => {
      const current = await tx.scheduleSyncSettings.findUnique({ where: { id: SINGLETON } });
      if (!current) return;
      // Tekshiruv paytida havola almashgan: xato ESKI sheet'niki — yangi
      // sozlamaning holatiga yozilmaydi.
      if (
        current.spreadsheetId !== checked.spreadsheetId ||
        sheet.normalizeKey(current.sheetTab) !== sheet.normalizeKey(checked.sheetTab)
      ) {
        return;
      }
      const failures = (current.checkFailureCount || 0) + 1;
      const now = new Date();
      await tx.scheduleSyncSettings.update({
        where: { id: SINGLETON },
        data: { lastCheckedAt: now, lastCheckOk: false, lastCheckError: message, checkFailureCount: failures },
      });

      const due =
        current.mode === MODES.SHEET &&
        failures >= FAILURE_NOTIFY_AFTER &&
        (!current.failureNotifiedAt ||
          now.getTime() - current.failureNotifiedAt.getTime() > FAILURE_NOTIFY_INTERVAL_MS);
      if (!due) return;

      // Klaster rejimida ikki jarayon bir vaqtda yubormasligi uchun "egallash"
      const claim = await tx.scheduleSyncSettings.updateMany({
        where: { id: SINGLETON, failureNotifiedAt: current.failureNotifiedAt },
        data: { failureNotifiedAt: now },
      });
      if (claim.count === 1) notify = { message, failures };
    });

    if (notify) await notifyFailure(notify.message, notify.failures);
  } catch (recordError) {
    logger.error(`[ScheduleSync] Tekshiruv xatosini yozib bo'lmadi: ${recordError.message}`);
  }
}

// ─────────────────────────────────────────────
// Tahrirlar
// ─────────────────────────────────────────────

const clampLimit = (req) => {
  const { page, limit } = getPaginationParams(req, 20);
  const safeLimit = Math.min(Math.max(limit, 1), 50);
  const safePage = Math.max(page, 1);
  return { page: safePage, limit: safeLimit, skip: (safePage - 1) * safeLimit };
};

async function listRevisions(req) {
  const { page, limit, skip } = clampLimit(req);
  const settings = await getScheduleSyncSettings();
  const [rows, total, latest] = await Promise.all([
    prisma.scheduleSheetRevision.findMany({
      omit: { data: true, resolution: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take: limit,
    }),
    prisma.scheduleSheetRevision.count(),
    review.findLatestRevision(prisma, settings),
  ]);
  const users = await review.loadUsersById(
    prisma,
    rows.flatMap((r) => [r.fetchedBy, r.reviewedBy]),
  );
  const data = rows.map((r) => review.revisionSummary(r, { latestId: latest?.id || null, users }));
  return formatPaginationResponse(data, total, page, limit);
}

async function getRevisionReview(id, user) {
  const revision = await prisma.scheduleSheetRevision.findUnique({ where: { id } });
  if (!revision) throw new NotFoundError("Tahrir topilmadi");
  const calendar = await getMonthCalendar(currentMonthKey());
  const { review: result } = await review.reviewRevision(prisma, revision, { calendar, user });
  return result;
}

/**
 * Tasdiqlash so'rovi tanasi: odam ko'rgan imzolar va tasdiqlagan ogohlantirishlar.
 */
function parseDecision(body, { requireNewHash = true } = {}) {
  const activeHash = typeof body?.activeHash === "string" ? body.activeHash : "";
  const newHash = typeof body?.newHash === "string" ? body.newHash : "";
  if (!HASH_RE.test(activeHash)) {
    throw new BadRequestError("Ko'rib chiqilgan jadval imzosi (activeHash) yuborilmagan");
  }
  if (requireNewHash && !HASH_RE.test(newHash)) {
    throw new BadRequestError("Ko'rib chiqilgan natija imzosi (newHash) yuborilmagan");
  }
  const acknowledged = Array.isArray(body?.acknowledged)
    ? body.acknowledged.filter((code) => typeof code === "string")
    : [];
  return { activeHash, newHash, acknowledged };
}

/**
 * Qulf ichida qayta hisoblangan ko'rib chiqish odam ko'rgani bilan bir xilmi?
 *
 * Tasdiqlar to'plami imzolarga kirmaydi (bugungi kun, o'rinbosarlik,
 * o'qituvchi holati — jadvaldan tashqaridagi narsalar), shuning uchun
 * yetishmagan tasdiqlar TO'LIQ matni bilan qaytadi: odam ko'rmagan
 * ogohlantirishni ekran darhol ko'rsata oladi.
 *
 * @param {{activeHash: string, newHash: string, requiredAcks: Array<{code: string}>}} current
 */
function assertReviewedState({ activeHash, newHash, requiredAcks }, input) {
  if (activeHash !== input.activeHash) {
    throw new ConflictError(
      "Amaldagi jadval siz ko'rib chiqqandan keyin o'zgargan — sahifani yangilab, qayta ko'rib chiqing",
      { reason: "stale_active" },
    );
  }
  if (newHash !== input.newHash) {
    throw new ConflictError(
      "Qo'llanadigan natija siz ko'rgandan keyin o'zgargan (moslash yoki ma'lumot yangilangan) — qayta ko'rib chiqing",
      { reason: "stale_review" },
    );
  }
  const missing = requiredAcks.filter((ack) => !input.acknowledged.includes(ack.code));
  if (missing.length) {
    throw new BadRequestError("Avval ogohlantirishlarni o'qib, tasdiqlang", {
      reason: "ack_required",
      required: missing.map((ack) => ack.code),
      acks: missing.map(({ code, title, message }) => ({ code, title, message })),
    });
  }
}

function assertRevisionApplicable(result) {
  if (!result.isLatest || result.revision.status === "superseded") {
    throw new ConflictError("Sheet'da yangiroq o'zgarish bor — eng oxirgisini ko'rib chiqing", {
      reason: "not_latest",
    });
  }
  if (!result.checkFresh) {
    throw new ConflictError(
      "Sheet 15 daqiqadan beri muvaffaqiyatli tekshirilmagan — avval \"Tekshirish\" ni bosing",
      { reason: "stale_check" },
    );
  }
  if (result.errors.length) {
    throw new BadRequestError(`Qo'llab bo'lmaydi: ${result.errors.length} ta xato bor`, {
      reason: "validation",
      errors: result.errors.slice(0, 100),
    });
  }
}

/**
 * Qo'llangan paytdagi moslash — tahrir ichiga muhrlanadi (tarix uchun).
 */
function condenseResolution(resolution) {
  const out = {};
  for (const kind of MAPPING_KINDS) {
    out[kind] = (resolution[kind] || []).map((r) => ({
      label: r.label,
      key: r.key,
      status: r.status,
      targetId: r.targetId,
      targetName: r.targetName,
    }));
  }
  return out;
}

/**
 * Tahrirni "qo'llangan" deb belgilaydi (compare-and-swap) va undan eski
 * kutilayotganlarini eskirgan qiladi.
 */
async function markApplied(tx, revision, { userId, resolution, snapshotId }) {
  const { count } = await tx.scheduleSheetRevision.updateMany({
    where: { id: revision.id, status: { in: ["pending", "rejected", "applied"] } },
    data: {
      status: "applied",
      reviewedBy: userId,
      reviewedAt: new Date(),
      rejectReason: null,
      resolution: condenseResolution(resolution),
      ...(snapshotId ? { snapshotId } : {}),
    },
  });
  if (count !== 1) {
    throw new ConflictError("Tahrir holati shu orada o'zgardi — qayta ko'rib chiqing", { reason: "not_latest" });
  }
  await tx.scheduleSheetRevision.updateMany({
    where: { status: "pending", createdAt: { lt: revision.createdAt } },
    data: { status: "superseded" },
  });
}

/**
 * Sheet o'zgarishini qo'llash (faqat sheet rejimida).
 */
async function applyRevision(id, body, user) {
  const input = parseDecision(body);
  const calendar = await getMonthCalendar(currentMonthKey());

  const outcome = await withScheduleWriteLock(async (tx) => {
    const settings = await tx.scheduleSyncSettings.findUnique({ where: { id: SINGLETON } });
    if ((settings?.mode || MODES.PLATFORM) !== MODES.SHEET) {
      throw new ConflictError(
        "Jadval manbai hozir platforma. Sheet'dagi jadvalni qo'llash uchun \"Manbani almashtirish\" dan foydalaning",
        { reason: "mode_changed" },
      );
    }
    const revision = await tx.scheduleSheetRevision.findUnique({ where: { id } });
    if (!revision) throw new NotFoundError("Tahrir topilmadi");

    const { review: result, internal } = await review.reviewRevision(tx, revision, { calendar, user });
    assertRevisionApplicable(result);
    assertReviewedState(
      { activeHash: result.activeHash, newHash: result.newHash, requiredAcks: result.requiredAcks },
      input,
    );

    let snapshotId = null;
    if (result.hasChanges) {
      const snapshot = await writeSnapshot(tx, {
        kind: "before_apply",
        mode: MODES.SHEET,
        rows: internal.activeRows,
        note: "Google Sheets o'zgarishi qo'llanishidan oldingi holat",
        revisionId: revision.id,
        createdBy: user.id,
      });
      snapshotId = snapshot.id;
      await replaceAllRows(tx, internal.newRows, user.id);
    }

    await markApplied(tx, revision, { userId: user.id, resolution: internal.resolution, snapshotId });
    await tx.scheduleSyncSettings.update({
      where: { id: SINGLETON },
      data: { appliedStateHash: result.newHash },
    });
    return { changed: result.hasChanges, totals: result.diff?.totals };
  });

  logger.info(
    `[ScheduleSync] Sheet o'zgarishi qo'llandi: ${id} (${user.id})${outcome.changed ? ` ${JSON.stringify(outcome.totals)}` : " — o'zgarishsiz"}`,
  );
  return getStatus(user);
}

async function rejectRevision(id, body, user) {
  const reason = decodeText(body?.reason);
  if (reason.length > MAX_REASON_LENGTH) {
    throw new BadRequestError(`Sabab juda uzun (ko'pi bilan ${MAX_REASON_LENGTH} belgi)`);
  }

  await withScheduleWriteLock(async (tx) => {
    const settings = await tx.scheduleSyncSettings.findUnique({ where: { id: SINGLETON } });
    const latest = await review.findLatestRevision(tx, settings);
    if (!latest || latest.id !== id) {
      throw new ConflictError("Faqat eng oxirgi tahrirni rad etish mumkin", { reason: "not_latest" });
    }
    const { count } = await tx.scheduleSheetRevision.updateMany({
      where: { id, status: "pending" },
      data: { status: "rejected", reviewedBy: user.id, reviewedAt: new Date(), rejectReason: reason || null },
    });
    if (count !== 1) {
      throw new ConflictError("Bu tahrir allaqachon ko'rib chiqilgan", { reason: "not_latest" });
    }
  });

  logger.info(`[ScheduleSync] Tahrir rad etildi: ${id} (${user.id})`);
  const revision = await prisma.scheduleSheetRevision.findUnique({
    where: { id },
    omit: { data: true, resolution: true },
  });
  const users = await review.loadUsersById(prisma, [revision.fetchedBy, revision.reviewedBy]);
  return review.revisionSummary(revision, { latestId: revision.id, users });
}

// ─────────────────────────────────────────────
// Moslash
// ─────────────────────────────────────────────

async function getMappings() {
  const [mappings, classes, subjects, teachers] = await Promise.all([
    prisma.scheduleSheetMapping.findMany({ orderBy: [{ kind: "asc" }, { label: "asc" }] }),
    prisma.class.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.subject.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.user.findMany({
      where: { OR: [{ role: ROLES.TEACHER }, { extraRoles: { has: ROLES.TEACHER } }] },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        username: true,
        isArchived: true,
        subjects: { select: { subjectId: true } },
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    }),
  ]);

  const names = {
    class: new Map(classes.map((c) => [c.id, c.name])),
    subject: new Map(subjects.map((s) => [s.id, s.name])),
    teacher: new Map(teachers.map((t) => [t.id, `${teacherName(t)}${t.isArchived ? " (arxiv)" : ""}`])),
  };
  const users = await review.loadUsersById(prisma, mappings.map((m) => m.updatedBy));

  return {
    items: mappings.map((m) => ({
      id: m.id,
      kind: m.kind,
      key: m.key,
      label: m.label,
      targetId: m.targetId,
      targetName: names[m.kind]?.get(m.targetId) || null,
      targetMissing: !names[m.kind]?.has(m.targetId),
      updatedBy: m.updatedBy ? review.userRef(users.get(m.updatedBy)) || { id: m.updatedBy, name: "—" } : null,
      updatedAt: m.updatedAt,
    })),
    options: {
      classes,
      subjects,
      // `username` — yagona: bir xil ismli ikki o'qituvchini ekranda ajratish uchun
      teachers: teachers
        .filter((t) => !t.isArchived)
        .map((t) => ({
          id: t.id,
          name: teacherName(t),
          username: t.username,
          subjectIds: t.subjects.map((s) => s.subjectId),
        })),
    },
  };
}

/**
 * Moslash qoidalarini saqlash. `key` — server bergan kalit (harf, raqam,
 * bo'shliq): u `xss-clean` dan buzilmay o'tadi. `targetId: null` — o'chirish.
 */
async function saveMappings(body, user) {
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || items.length === 0) throw new BadRequestError("Saqlanadigan moslash yo'q");
  if (items.length > MAX_MAPPING_ITEMS) {
    throw new BadRequestError(`Bir martada ko'pi bilan ${MAX_MAPPING_ITEMS} ta moslash saqlanadi`);
  }

  const seen = new Set();
  const normalized = items.map((item, index) => {
    const position = `${index + 1}-qator`;
    if (!MAPPING_KINDS.includes(item?.kind)) throw new BadRequestError(`${position}: turi noto'g'ri`);
    const key = typeof item.key === "string" ? item.key.trim() : "";
    if (!key || key !== sheet.normalizeKey(key) || key.length > sheet.MAX_LABEL_LENGTH) {
      throw new BadRequestError(`${position}: kalit noto'g'ri`);
    }
    const label = decodeText(item.label).slice(0, sheet.MAX_LABEL_LENGTH) || key;
    const targetId = item.targetId === null || item.targetId === undefined ? null : String(item.targetId);
    if (targetId !== null && !isValidId(targetId)) throw new BadRequestError(`${position}: tanlangan yozuv noto'g'ri`);
    const unique = `${item.kind}|${key}`;
    if (seen.has(unique)) throw new BadRequestError(`${position}: "${label}" ikki marta yuborilgan`);
    seen.add(unique);
    return { kind: item.kind, key, label, targetId };
  });

  await withScheduleWriteLock(async (tx) => {
    const idsOf = (kind) => normalized.filter((i) => i.kind === kind && i.targetId).map((i) => i.targetId);
    const [classes, subjects, teachers] = await Promise.all([
      tx.class.findMany({ where: { id: { in: idsOf("class") } }, select: { id: true } }),
      tx.subject.findMany({ where: { id: { in: idsOf("subject") } }, select: { id: true } }),
      tx.user.findMany({
        where: { id: { in: idsOf("teacher") } },
        select: { id: true, role: true, extraRoles: true, isArchived: true },
      }),
    ]);
    const valid = {
      class: new Set(classes.map((c) => c.id)),
      subject: new Set(subjects.map((s) => s.id)),
      teacher: new Set(
        teachers
          .filter((t) => !t.isArchived && (t.role === ROLES.TEACHER || (t.extraRoles || []).includes(ROLES.TEACHER)))
          .map((t) => t.id),
      ),
    };

    for (const item of normalized) {
      if (item.targetId && !valid[item.kind].has(item.targetId)) {
        throw new BadRequestError(
          item.kind === "teacher"
            ? `"${item.label}": tanlangan foydalanuvchi faol o'qituvchi emas`
            : `"${item.label}": tanlangan yozuv topilmadi`,
        );
      }
    }

    for (const item of normalized) {
      if (!item.targetId) {
        await tx.scheduleSheetMapping.deleteMany({ where: { kind: item.kind, key: item.key } });
        continue;
      }
      await tx.scheduleSheetMapping.upsert({
        where: { kind_key: { kind: item.kind, key: item.key } },
        create: { kind: item.kind, key: item.key, label: item.label, targetId: item.targetId, updatedBy: user.id },
        update: { label: item.label, targetId: item.targetId, updatedBy: user.id },
      });
    }
  });

  logger.info(`[ScheduleSync] Moslash saqlandi: ${normalized.length} ta (${user.id})`);
  return getMappings();
}

// ─────────────────────────────────────────────
// Manbani almashtirish
// ─────────────────────────────────────────────

/**
 * Sozlama qatori tranzaksiya ichida (bo'lmasa yaratiladi).
 */
async function ensureSettingsTx(tx) {
  return tx.scheduleSyncSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON },
    update: {},
  });
}

async function switchSource(body, user) {
  const to = body?.to;
  if (to === MODES.SHEET) return switchToSheet(body, user);
  if (to === MODES.PLATFORM) return switchToPlatform(body, user);
  throw new BadRequestError("Qaysi manbaga o'tish ko'rsatilmagan (to: \"sheet\" yoki \"platform\")");
}

async function switchToSheet(body, user) {
  const input = parseDecision(body);
  const revisionId = String(body.revisionId || "");
  if (!isValidId(revisionId)) throw new BadRequestError("Qo'llanadigan tahrir ko'rsatilmagan");
  const calendar = await getMonthCalendar(currentMonthKey());

  await withScheduleWriteLock(async (tx) => {
    const settings = await ensureSettingsTx(tx);
    if (settings.mode === MODES.SHEET) {
      throw new ConflictError("Jadval allaqachon Google Sheets rejimida", { reason: "already_in_mode" });
    }
    if (!settings.spreadsheetId || !settings.sheetTab) {
      throw new BadRequestError("Avval Google Sheets havolasi va varag'ini sozlang");
    }
    const revision = await tx.scheduleSheetRevision.findUnique({ where: { id: revisionId } });
    if (!revision) throw new NotFoundError("Tahrir topilmadi");

    const { review: result, internal } = await review.reviewRevision(tx, revision, { calendar, user });
    assertRevisionApplicable(result);
    assertReviewedState(
      { activeHash: result.activeHash, newHash: result.newHash, requiredAcks: result.requiredAcks },
      input,
    );

    // Platformaning o'z jadvali — o'zgarish bo'lmasa ham ARXIVGA: qaytishda
    // aynan shu nusxa tiklanadi.
    const snapshot = await writeSnapshot(tx, {
      kind: "platform_archive",
      mode: MODES.PLATFORM,
      rows: internal.activeRows,
      note: "Google Sheets rejimiga o'tishdan oldingi platforma jadvali",
      revisionId: revision.id,
      createdBy: user.id,
    });
    if (result.hasChanges) await replaceAllRows(tx, internal.newRows, user.id);

    await markApplied(tx, revision, { userId: user.id, resolution: internal.resolution, snapshotId: snapshot.id });
    await tx.scheduleSyncSettings.update({
      where: { id: SINGLETON },
      data: {
        mode: MODES.SHEET,
        platformSnapshotId: snapshot.id,
        modeChangedAt: new Date(),
        modeChangedBy: user.id,
        appliedStateHash: result.newHash,
      },
    });
  });

  logger.info(`[ScheduleSync] Manba: platforma → Google Sheets (${user.id}), tahrir ${revisionId}`);
  return getStatus(user);
}

async function switchToPlatform(body, user) {
  const restore = body?.restore;
  if (restore !== "archive" && restore !== "keep") {
    throw new BadRequestError("Platformaga qaytishda arxivni tiklash yoki hozirgisini saqlashni tanlang");
  }
  const input = parseDecision(body, { requireNewHash: restore === "archive" });
  const calendar = restore === "archive" ? await getMonthCalendar(currentMonthKey()) : null;

  await withScheduleWriteLock(async (tx) => {
    const settings = await ensureSettingsTx(tx);
    if (settings.mode !== MODES.SHEET) {
      throw new ConflictError("Jadval allaqachon platforma rejimida", { reason: "already_in_mode" });
    }

    const activeRows = await review.loadActiveRows(tx);
    let restoreRows = null;

    if (restore === "archive") {
      const snapshot = settings.platformSnapshotId
        ? await tx.scheduleSnapshot.findUnique({ where: { id: settings.platformSnapshotId } })
        : null;
      if (!snapshot) {
        throw new BadRequestError(
          "Arxivdagi platforma jadvali topilmadi — \"Hozirgi jadvalni saqlab qolish\" ni tanlang",
        );
      }
      const { review: result, internal } = await review.reviewSnapshotRestore(tx, snapshot, { calendar, user });
      assertRestorable(internal, { allowNoChanges: true });
      assertReviewedState(
        { activeHash: result.activeHash, newHash: result.newHash, requiredAcks: result.requiredAcks },
        input,
      );
      restoreRows = internal.restoreRows;
    } else if (hashState(activeRows) !== input.activeHash) {
      throw new ConflictError(
        "Amaldagi jadval siz ko'rib chiqqandan keyin o'zgargan — sahifani yangilab, qayta urinib ko'ring",
        { reason: "stale_active" },
      );
    }

    // Sheet'dan kelgan jadval — tanlovdan qat'i nazar arxivga
    await writeSnapshot(tx, {
      kind: "sheet_archive",
      mode: MODES.SHEET,
      rows: activeRows,
      note: "Platformaga qaytishdan oldingi (Google Sheets) jadval",
      createdBy: user.id,
    });
    if (restoreRows && hashState(restoreRows) !== hashState(activeRows)) {
      await replaceAllRows(tx, restoreRows, user.id, { preserveMeta: true });
    }

    await tx.scheduleSyncSettings.update({
      where: { id: SINGLETON },
      data: {
        mode: MODES.PLATFORM,
        platformSnapshotId: null,
        modeChangedAt: new Date(),
        modeChangedBy: user.id,
        appliedStateHash: null,
      },
    });
  });

  logger.info(`[ScheduleSync] Manba: Google Sheets → platforma (${user.id}), tanlov: ${restore}`);
  return getStatus(user);
}

// ─────────────────────────────────────────────
// Arxiv nusxalar
// ─────────────────────────────────────────────

async function listSnapshots(req) {
  const { page, limit, skip } = clampLimit(req);
  const [rows, total] = await Promise.all([
    prisma.scheduleSnapshot.findMany({
      omit: { data: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take: limit,
    }),
    prisma.scheduleSnapshot.count(),
  ]);
  const users = await review.loadUsersById(prisma, rows.map((r) => r.createdBy));
  return formatPaginationResponse(
    rows.map((r) => review.snapshotSummary(r, users)),
    total,
    page,
    limit,
  );
}

async function getSnapshotReview(id, user) {
  const snapshot = await prisma.scheduleSnapshot.findUnique({ where: { id } });
  if (!snapshot) throw new NotFoundError("Arxiv nusxa topilmadi");
  const calendar = await getMonthCalendar(currentMonthKey());
  const { review: result } = await review.reviewSnapshotRestore(prisma, snapshot, { calendar, user });
  return result;
}

/**
 * Tiklash to'sig'i: buzilgan nusxa, takroriy qatorlar, (tiklashda) o'zgarish
 * yo'qligi. Ruxsat route darajasida tekshiriladi. Platformaga qaytishda
 * "o'zgarish yo'q" to'siq EMAS — rejim baribir almashadi.
 */
function assertRestorable(internal, { allowNoChanges = false } = {}) {
  const blocking = internal.blockers.filter(
    (b) => b.code !== "no_permission" && !(allowNoChanges && b.code === "no_changes"),
  );
  if (blocking.length) {
    throw new BadRequestError(blocking[0].message, { reason: "validation" });
  }
}

async function restoreSnapshot(id, body, user) {
  const input = parseDecision(body);
  const calendar = await getMonthCalendar(currentMonthKey());

  await withScheduleWriteLock(async (tx) => {
    const snapshot = await tx.scheduleSnapshot.findUnique({ where: { id } });
    if (!snapshot) throw new NotFoundError("Arxiv nusxa topilmadi");
    const settings = await ensureSettingsTx(tx);

    const { review: result, internal } = await review.reviewSnapshotRestore(tx, snapshot, { calendar, user });
    assertRestorable(internal);
    assertReviewedState(
      { activeHash: result.activeHash, newHash: result.newHash, requiredAcks: result.requiredAcks },
      input,
    );

    await writeSnapshot(tx, {
      kind: "before_restore",
      mode: settings.mode,
      rows: internal.activeRows,
      note: "Arxiv versiya tiklanishidan oldingi holat",
      createdBy: user.id,
    });
    await replaceAllRows(tx, internal.restoreRows, user.id, { preserveMeta: true });
  });

  logger.info(`[ScheduleSync] Arxiv versiya tiklandi: ${id} (${user.id})`);
  return getStatus(user);
}

// ─────────────────────────────────────────────
// Yozish (faqat qulf ichida)
// ─────────────────────────────────────────────

/**
 * Holatning arxiv nusxasini yozadi va QAYTA O'QIB tekshiradi.
 */
async function writeSnapshot(tx, { kind, mode, rows, note = null, revisionId = null, createdBy = null }) {
  const classIds = [...new Set(rows.map((r) => r.classId))];
  const subjectIds = [...new Set(rows.flatMap((r) => r.lessons.map((l) => l.subjectId)))];
  const userIds = [...new Set(rows.flatMap((r) => r.lessons.map((l) => l.teacherId)))];
  const [classes, subjects, users] = await Promise.all([
    classIds.length ? tx.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } }) : [],
    subjectIds.length ? tx.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } }) : [],
    userIds.length
      ? tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true } })
      : [],
  ]);
  const className = new Map(classes.map((c) => [c.id, c.name]));
  const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
  const userName = new Map(users.map((u) => [u.id, teacherName(u)]));

  const data = {
    version: review.SNAPSHOT_VERSION,
    schedules: rows.map((row) => ({
      classId: row.classId,
      className: className.get(row.classId) || null,
      day: row.day,
      createdBy: row.createdBy || null,
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
      lessons: row.lessons.map((l) => ({
        order: Number(l.order),
        subjectId: l.subjectId,
        subjectName: subjectName.get(l.subjectId) || null,
        teacherId: l.teacherId,
        teacherName: userName.get(l.teacherId) || null,
        startTime: l.startTime || null,
        endTime: l.endTime || null,
        position: Number(l.position),
      })),
    })),
  };

  const expectedHash = hashState(rows);
  const snapshot = await tx.scheduleSnapshot.create({
    data: {
      kind,
      mode,
      data,
      contentHash: expectedHash,
      classCount: classIds.length,
      lessonCount: countLessons(rows),
      note,
      revisionId,
      createdBy,
    },
    select: { id: true },
  });

  const stored = await tx.scheduleSnapshot.findUnique({ where: { id: snapshot.id }, select: { data: true } });
  const storedRows = review.snapshotRows(stored.data);
  if (storedRows.length !== rows.length || hashState(storedRows) !== expectedHash) {
    throw new Error("Arxiv nusxa to'g'ri saqlanmadi — amal bekor qilindi, jadval o'zgarmadi");
  }
  return snapshot;
}

const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/**
 * Amaldagi jadvalni BUTUNLAY almashtiradi va natijani QAYTA O'QIB tekshiradi.
 *
 * Nima uchun o'chirib-qayta yozish: `schedules.id` ga hech kim ishora
 * qilmaydi (o'rinbosarlik, baho, bot — hammasi sinf+kun+tartib bo'yicha),
 * `schedule_lessons` esa kaskad bilan o'chadi. Bitta tranzaksiyada bo'lgani
 * uchun o'quvchilar yo eski, yo yangi holatni ko'radi — oraliqni emas.
 *
 * @param {object} tx
 * @param {Array} rows - yoziladigan holat
 * @param {string} actorId
 * @param {{preserveMeta?: boolean}} [options] - arxivdan tiklashda qatorning
 *   asl muallifi va yaratilgan vaqti qaytariladi
 */
async function replaceAllRows(tx, rows, actorId, { preserveMeta = false } = {}) {
  await tx.schedule.deleteMany({});

  const schedules = rows.map((row) => ({
    id: generateId(),
    classId: row.classId,
    day: row.day,
    createdBy: (preserveMeta && row.createdBy) || actorId,
    ...(preserveMeta && row.createdAt ? { createdAt: new Date(row.createdAt) } : {}),
  }));
  for (const part of chunk(schedules, 500)) {
    await tx.schedule.createMany({ data: part });
  }

  const lessons = rows.flatMap((row, index) =>
    row.lessons.map((l) => ({
      scheduleId: schedules[index].id,
      subjectId: l.subjectId,
      teacherId: l.teacherId,
      order: Number(l.order),
      startTime: l.startTime || null,
      endTime: l.endTime || null,
      position: Number(l.position),
    })),
  );
  for (const part of chunk(lessons, 2000)) {
    await tx.scheduleLesson.createMany({ data: part });
  }

  const written = await review.loadActiveRows(tx);
  if (written.length !== rows.length || hashState(written) !== hashState(rows)) {
    throw new Error("Jadval to'g'ri yozilmadi — amal bekor qilindi, avvalgi jadval joyida");
  }
}

// ─────────────────────────────────────────────
// Xabarnomalar (Telegram, best effort)
// ─────────────────────────────────────────────

const OWNER_FILTER = [{ role: ROLES.OWNER }, { extraRoles: { has: ROLES.OWNER } }];

async function sendToUsers(orFilter, text) {
  if (!config.telegramBotToken) {
    logger.warn("[ScheduleSync] TELEGRAM_BOT_TOKEN yo'q — xabar yuborilmadi");
    return;
  }
  const recipients = await prisma.user.findMany({
    where: { isArchived: false, isActive: true, OR: orFilter },
    select: { telegramIds: true },
  });
  const chatIds = [...new Set(recipients.flatMap((u) => u.telegramIds || []).filter(Boolean))];

  for (const chatId of chatIds) {
    try {
      const result = await telegramService.sendMessage(chatId, text);
      if (!result?.success) logger.warn(`[ScheduleSync] ${chatId}: ${result?.error || "yuborilmadi"}`);
    } catch (error) {
      logger.warn(`[ScheduleSync] ${chatId}: ${error.message}`);
    }
    await telegramService.sleep(config.messageRateLimitMs);
  }
}

const branchTitle = () => escapeHtml(getBranch()?.name || "Filial");

const shorten = (text, max) => {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

/**
 * "Xabar yuborildi" belgisini qaytaradi — xabar amalda ketmagan bo'lsa.
 */
async function releaseNotifyClaim(revisionId) {
  await prisma.scheduleSheetRevision.updateMany({
    where: { id: revisionId },
    data: { notifiedAt: null },
  });
}

async function notifyNewRevision(revisionId) {
  // Klaster rejimida bir marta yuborilsin
  const claim = await prisma.scheduleSheetRevision.updateMany({
    where: { id: revisionId, notifiedAt: null },
    data: { notifiedAt: new Date() },
  });
  if (claim.count !== 1) return;

  const revision = await prisma.scheduleSheetRevision.findUnique({ where: { id: revisionId } });
  const calendar = await getMonthCalendar(currentMonthKey());
  let result;
  try {
    ({ review: result } = await review.reviewRevision(prisma, revision, { calendar, user: null }));
  } catch (error) {
    await releaseNotifyClaim(revisionId);
    throw error;
  }

  // Amaldagi jadval bilan bir xil (masalan ustunlar surilgan) — xabar shart
  // emas. "Aytildi" belgisi QAYTARILADI: aks holda bu tahrir keyingi haqiqiy
  // o'zgarish haqidagi xabarni ham to'sib qo'yardi.
  if (!result.errors.length && !result.hasChanges) {
    await releaseNotifyClaim(revisionId);
    return;
  }

  const when = escapeHtml(formatDateTimeUz(new Date()));
  let text;
  if (result.errors.length) {
    text = [
      `⚠️ <b>Dars jadvali — ${branchTitle()}</b>`,
      `Google Sheets'da yangi o'zgarish bor (${when}), lekin uni qo'llab bo'lmaydi: ${result.errors.length} ta xato.`,
      // Telegram 4096 belgidan uzun xabarni qabul qilmaydi
      `Masalan: ${escapeHtml(shorten(result.errors[0].message, 300))}`,
      "Ko'rib chiqish: Admin panel → Dars jadvali → Google Sheets.",
    ].join("\n");
  } else {
    const t = result.diff.totals;
    text = [
      `📅 <b>Dars jadvali — ${branchTitle()}</b>`,
      `Google Sheets'da yangi o'zgarish bor (${when}).`,
      `Qo'shilgan: ${t.added}, olib tashlangan: ${t.removed}, o'zgargan: ${t.changed} ta dars (${t.classesChanged} ta sinf).`,
      "Amaldagi jadval hali o'zgarmadi — ko'rib chiqib tasdiqlang: Admin panel → Dars jadvali → Google Sheets.",
    ].join("\n");
  }
  await sendToUsers([...OWNER_FILTER, { permissions: { has: PERMISSIONS.SCHEDULESYNC_REVIEW } }], text);
}

async function notifyFailure(message, failures) {
  const text = [
    `⚠️ <b>Dars jadvali — ${branchTitle()}</b>`,
    `Google Sheets'ni ketma-ket ${failures} marta tekshirib bo'lmadi: ${escapeHtml(shorten(message, 500))}`,
    "Amaldagi jadval o'zgarmadi. Havolani, varaq nomini va ulashish sozlamasini tekshiring.",
  ].join("\n");
  await sendToUsers(
    [
      ...OWNER_FILTER,
      { permissions: { has: PERMISSIONS.SCHEDULESYNC_REVIEW } },
      { permissions: { has: PERMISSIONS.SCHEDULESYNC_SOURCE } },
    ],
    text,
  );
}

// ─────────────────────────────────────────────
// Avtomatik tekshiruv (cron)
// ─────────────────────────────────────────────

/**
 * Bitta filial uchun: sheet rejimida va avtomatik tekshiruv yoqilgan
 * bo'lsa — tekshiradi; keyin eskirgan tahrirlarni tozalaydi.
 * Xato yutiladi (log): bitta filialning sheet'i buzilgani qolganlarini
 * to'xtatmasligi kerak.
 */
async function runScheduleSheetSyncPass() {
  const settings = await getScheduleSyncSettings();
  if (settings.mode === MODES.SHEET && settings.autoCheck && settings.spreadsheetId && settings.sheetTab) {
    try {
      await checkSheet({ actorId: null });
    } catch (error) {
      logger.warn(`[ScheduleSync] ${getBranch()?.name || "?"}: tekshiruv muvaffaqiyatsiz — ${error.message}`);
    }
  }

  // Hech qachon qo'llanmagan va eskirgan tahrirlar — ular amaldagi jadvalga
  // hech qachon tegmagan va hech bir arxiv nusxa ularga ishora qilmaydi.
  const cutoff = new Date(Date.now() - SUPERSEDED_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await withScheduleWriteLock(async (tx) => {
    await tx.scheduleSheetRevision.deleteMany({
      where: { status: "superseded", createdAt: { lt: cutoff } },
    });
  });
}

module.exports = {
  getMode,
  getStatus,
  updateConfig,
  inspectSheet,
  checkSheet,
  listRevisions,
  getRevisionReview,
  applyRevision,
  rejectRevision,
  getMappings,
  saveMappings,
  switchSource,
  listSnapshots,
  getSnapshotReview,
  restoreSnapshot,
  runScheduleSheetSyncPass,
};
