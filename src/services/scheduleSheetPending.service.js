/**
 * TASDIQLANMAGAN SHEET TAHRIRI — O'QITUVCHIGA.
 *
 * Sheet rejimida amaldagi jadval mas'ul odam "Qo'llash" ni bosmaguncha
 * o'zgarmaydi (`education.md` §10). Shu oraliqda o'qituvchi ilovada eski
 * jadvalni ko'rib turadi. Bu servis "sening jadvalingda aynan nima
 * o'zgaradi" degan savolga javob beradi: `GET /schedule-sync/pending/my`.
 *
 * ⚠️ SHEET O'QILMAYDI. Hammasi bazadan: oxirgi `pending` tahrir
 * (`scheduleSheetSync.job.js` har 10 daqiqada yozadi) va amaldagi jadval.
 * Endpoint ilovaning bosh sahifasida va har qayta yuklashda chaqiriladi —
 * sheet'ni o'qish (yuklab olish + ExcelJS) bu yo'lda umuman bo'lmasligi kerak.
 *
 * ⚠️ FARQ BITTA QURUVCHIDAN: `review.reviewRevision` — admin paneldagi
 * "Google Sheets" ekrani ko'radigan AYNI funksiya. Ikkinchi, yengilroq
 * quruvchi yozilsa, o'qituvchi ilovada bir farqni, admin boshqa farqni
 * ko'rardi — modulning butun mohiyati (ishonch) yo'qolardi.
 *
 * ⚠️ NATIJA KESHLANADI, chunki `reviewRevision` og'ir (nomlarni moslash,
 * oylik va o'rinbosarlik ta'siri). Kesh kaliti UCH narsadan:
 *   · tahrir id si      — yangi tahrir → yangi hisob;
 *   · amaldagi jadval imzosi (`hashState`) — jadval qo'llangani yoki qo'lda
 *     sheetga tenglashtirilgani ZAHOTI farq qayta hisoblanadi;
 *   · moslash qoidalari — nom boshqa sinfga moslansa farq ham o'zgaradi.
 * Tahrir HOLATI (applied/rejected/superseded) esa keshdan EMAS, har
 * so'rovda bazadan o'qiladi: tasdiqlangan zahoti ogohlantirish yo'qolishi
 * kerak.
 */

const prisma = require("../config/prisma");
const { requireBranch } = require("../config/branchContext");
const logger = require("../utils/logger");
const { formatDateTimeUz } = require("../helpers/date.helpers");
const { hashState } = require("../helpers/scheduleState.helpers");
const {
  resolveDayFilter,
  teacherLessonsFromDiff,
  classChangesFromDiff,
} = require("../helpers/schedulePending.helpers");
const { MODES } = require("./scheduleWriteGuard.service");
const review = require("./scheduleSyncReview.service");

const SINGLETON = "singleton";

// Filial → oxirgi hisoblangan farq. Har filialda BITTA yozuv: bir vaqtda
// faqat bitta `pending` tahrir bo'ladi (`runCheck` qolganlarini
// `superseded` qiladi), ya'ni kesh o'z-o'zidan eskisini siqib chiqaradi.
const cache = new Map();
// Bir vaqtda kelgan so'rovlar (butun maktab o'qituvchilari bosh sahifani
// birga ochadi) bitta hisobni kutadi — aks holda har biri `reviewRevision`
// ni qaytadan yurgizardi.
const inflight = new Map();

const emptyResult = (mode, { date = null, day = null } = {}) => ({
  mode,
  hasPending: false,
  schoolPending: false,
  diffAvailable: true,
  revisionId: null,
  detectedAt: null,
  detectedAtLabel: null,
  date,
  day,
  lessons: [],
});

/**
 * Moslash qoidalarining "imzosi" — qator soni va oxirgi tahrir vaqti.
 * Qoida o'zgarsa (yangi moslash, o'chirilgani) kesh kaliti o'zgaradi.
 */
async function mappingStamp() {
  const agg = await prisma.scheduleSheetMapping.aggregate({
    _count: { _all: true },
    _max: { updatedAt: true },
  });
  return `${agg._count._all}:${agg._max.updatedAt ? agg._max.updatedAt.getTime() : 0}`;
}

/**
 * Farqni hisoblaydi (keshsiz). Xato yutilmaydi — chaqiruvchi hal qiladi.
 */
async function computeDiff(revisionId) {
  const revision = await prisma.scheduleSheetRevision.findUnique({ where: { id: revisionId } });
  if (!revision) return null;

  // `calendar: null` — "bugungi ta'sir" bloki hisoblanmaydi (u faqat
  // qo'llash oynasi uchun; bu yerda baho va bayram so'rovlari ortiqcha).
  const { review: result } = await review.reviewRevision(prisma, revision, {
    calendar: null,
    user: null,
  });

  return {
    diff: result.diff,
    // `hasChanges === null` — farq umuman hisoblanmadi (moslashda xato):
    // "o'zgarish yo'q" degani EMAS.
    hasChanges: result.hasChanges,
    errorCount: result.errors.length,
  };
}

/**
 * Keshdan yoki hisoblab — oxirgi `pending` tahrirning farqi.
 *
 * @returns {Promise<{mode: string, revision: object|null, computed: object|null}>}
 */
async function loadPending() {
  const settings = await prisma.scheduleSyncSettings.findUnique({ where: { id: SINGLETON } });
  const mode = settings?.mode || MODES.PLATFORM;
  if (mode !== MODES.SHEET) return { mode, revision: null, computed: null };

  // Eng oxirgi tahrir joriy havola/varaqqa tegishli bo'lsagina qaytadi.
  const latest = await review.findLatestRevision(prisma, settings);
  // `applied` / `rejected` / `superseded` — qaror qabul qilingan, ya'ni
  // o'qituvchiga aytiladigan "tasdiqlanmagan o'zgarish" yo'q.
  if (!latest || latest.status !== "pending") return { mode, revision: null, computed: null };

  const { schemaName } = requireBranch();
  const activeRows = await review.loadActiveRows(prisma);
  const key = [schemaName, latest.id, hashState(activeRows), await mappingStamp()].join("|");

  const hit = cache.get(schemaName);
  if (hit && hit.key === key) return { mode, revision: latest, computed: hit.value };

  if (!inflight.has(key)) {
    inflight.set(
      key,
      (async () => {
        const value = await computeDiff(latest.id);
        if (value) cache.set(schemaName, { key, value });
        return value;
      })().finally(() => inflight.delete(key)),
    );
  }

  return { mode, revision: latest, computed: await inflight.get(key) };
}

/**
 * O'qituvchining tasdiqlanmagan jadval o'zgarishlari.
 *
 * @param {string} teacherId - tokendan (so'rov tanasidan EMAS)
 * @param {{date?: string}} [query] - `date` berilmasa butun hafta
 */
async function getPendingForTeacher(teacherId, { date } = {}) {
  const filter = resolveDayFilter(date);

  let pending;
  try {
    pending = await loadPending();
  } catch (error) {
    // Admin tomonidagi nosozlik (buzilgan tahrir, moslashda kutilmagan
    // holat) o'qituvchi ilovasining bosh sahifasini yiqitmasligi kerak.
    logger.warn(`[ScheduleSync] Tasdiqlanmagan tahrirni o'qib bo'lmadi: ${error.message}`);
    return emptyResult(MODES.SHEET, filter);
  }

  const { mode, revision, computed } = pending;
  if (!revision) return emptyResult(mode, filter);

  // Farq hisoblanmadi (sheet'da xato — masalan moslanmagan nom). Amaldagi
  // jadval o'zgarmagani uchun ogohlantirish KERAK, lekin qaysi dars
  // o'zgarishini aytib bo'lmaydi.
  const diffAvailable = Boolean(computed && computed.diff && computed.hasChanges !== null);
  if (!diffAvailable) {
    return {
      ...emptyResult(mode, filter),
      hasPending: true,
      schoolPending: true,
      diffAvailable: false,
      revisionId: revision.id,
      detectedAt: revision.createdAt,
      detectedAtLabel: formatDateTimeUz(revision.createdAt),
    };
  }

  // Sheet amaldagi jadval bilan bir xil (masalan ustunlar surilgan, yoki
  // jadval qo'lda tenglashtirilgan) — aytiladigan narsa yo'q.
  if (!computed.hasChanges) return emptyResult(mode, filter);

  const lessons = teacherLessonsFromDiff(computed.diff, teacherId, filter.day);
  return {
    mode,
    // ⚠️ SO'ROV DOIRASIDA: shu o'qituvchi va (berilgan bo'lsa) shu kun.
    // Ilovadagi ogohlantirish shunga qarab chiqadi — butun maktab bo'yicha
    // tahrir borligi o'qituvchining jadvali o'zgarganini bildirmaydi.
    hasPending: lessons.length > 0,
    // Butun maktab bo'yicha tasdiqlanmagan tahrir bor-yo'qligi.
    schoolPending: true,
    diffAvailable: true,
    revisionId: revision.id,
    detectedAt: revision.createdAt,
    detectedAtLabel: formatDateTimeUz(revision.createdAt),
    date: filter.date,
    day: filter.day,
    lessons,
  };
}

/**
 * Sinflar kesimida tasdiqlanmagan sheet tahriri — O'QUVCHI JADVALI uchun
 * (`GET /schedules/my-class`). O'qituvchi yo'li bilan AYNI manba
 * (`loadPending` → `reviewRevision`, AYNI kesh): ilova, o'qituvchi va admin
 * ekrani bitta farqni ko'radi.
 *
 * ⚠️ FARQ = OXIRGI `pending` TAHRIR. Rad etilgan (`rejected`) tahrir ham
 * sheet'dan farq qiladi, lekin bu ma'muriyatning qarori: amaldagi jadval
 * HAQIQIY jadval, shuning uchun u "farq" deb ko'rsatilmaydi.
 *
 * @param {Array<string>} classIds
 * @returns {Promise<{mode: string, schoolPending: boolean, diffAvailable: boolean,
 *   revisionId: string|null, detectedAt: Date|null, detectedAtLabel: string|null,
 *   changesOf: (classId: string) => Array<object>,
 *   differs: (classId: string) => boolean}>}
 */
async function getPendingForClasses(classIds = []) {
  const base = {
    mode: MODES.PLATFORM,
    schoolPending: false,
    diffAvailable: true,
    revisionId: null,
    detectedAt: null,
    detectedAtLabel: null,
  };
  const none = { ...base, changesOf: () => [], differs: () => false };

  let pending;
  try {
    pending = await loadPending();
  } catch (error) {
    // O'qituvchi yo'lidagi AYNI qaror: admin tomonidagi nosozlik o'quvchi
    // jadvalini yiqitmasligi kerak — jadval baribir bazadan ko'rsatiladi.
    logger.warn(`[ScheduleSync] O'quvchi jadvali uchun tahrirni o'qib bo'lmadi: ${error.message}`);
    return { ...none, mode: MODES.SHEET };
  }

  const { mode, revision, computed } = pending;
  if (!revision) return { ...none, mode };

  const meta = {
    ...base,
    mode,
    schoolPending: true,
    revisionId: revision.id,
    detectedAt: revision.createdAt,
    detectedAtLabel: formatDateTimeUz(revision.createdAt),
  };

  // Farq hisoblanmadi (sheet'da xato). O'qituvchi yo'li bilan AYNI: jadval
  // eskirgan bo'lishi mumkin, demak belgi KERAK — faqat qaysi dars
  // o'zgarishini aytib bo'lmaydi (`diffAvailable: false`).
  const diffAvailable = Boolean(computed && computed.diff && computed.hasChanges !== null);
  if (!diffAvailable) {
    const wanted = new Set(classIds);
    return {
      ...meta,
      diffAvailable: false,
      changesOf: () => [],
      differs: (classId) => wanted.has(classId),
    };
  }

  // Sheet amaldagi jadval bilan bir xil — aytiladigan narsa yo'q.
  if (!computed.hasChanges) return { ...none, mode };

  const byClass = new Map(
    classIds.map((id) => [id, classChangesFromDiff(computed.diff, id)]),
  );
  return {
    ...meta,
    changesOf: (classId) => byClass.get(classId) || [],
    differs: (classId) => (byClass.get(classId) || []).length > 0,
  };
}

module.exports = { getPendingForTeacher, getPendingForClasses };
