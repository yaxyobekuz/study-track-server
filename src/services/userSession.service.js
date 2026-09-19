/**
 * O'Z SEANSLARIM — "Telegram → Qurilmalar" ko'rinishi.
 *
 * Foydalanuvchi o'zi qaysi qurilmalardan kirganini ko'radi va ularni
 * yakunlaydi: bittasini yoki "shu qurilmadan boshqa hammasini".
 *
 * ⚠️ RUXSAT KALITI YO'Q — identifikator TOKENDAN olinadi, ya'ni odam faqat
 * O'ZINIKINI ko'radi va yopadi. Boshqa odamning seansi xavfsizlik
 * bo'limida (`securityDashboard.service.js`, `security.revoke`).
 *
 * ⚠️ FILIAL BILAN CHEGARALANMAYDI: seanslar odamniki, filialniki emas.
 * O'qituvchining limiti ham hamma filial bo'yicha birga sanaladi
 * (`security.service.js` → `SESSION_LIMITS`), ya'ni boshqa filialdagi
 * seans ro'yxatda ko'rinmasa, uni yopib joy bo'shatishning iloji
 * bo'lmasdi.
 *
 * ⚠️ `jti` HECH QACHON MIJOZGA CHIQMAYDI: u tokenning ichidagi sir. Joriy
 * seans `isCurrent` bayrog'i bilan belgilanadi.
 *
 * O'zi yakunlagan seans `revoked` bo'ladi va `endedBy` = o'zi — xavfsizlik
 * bo'limi uni "o'zi yakunladi" deb admin uzganidan ajratadi.
 */

const platformPrisma = require("../config/platformPrisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { formatDateTimeUz } = require("../helpers/date.helpers");
const { ACTIVITY_CHANNEL_LABELS } = require("../utils/constants");
const securityService = require("./security.service");
const pushService = require("./push.service");

/**
 * "ONLAYN" OYNASI. `lastSeenAt` 2 daqiqada bir yoziladi
 * (`security.service.js` → `SEEN_WINDOW_MS`), shuning uchun oyna undan
 * kengroq: aks holda ishlab turgan qurilma yozuvlar oralig'ida "oflayn"
 * bo'lib miltillardi.
 */
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Qurilma turi — ro'yxatdagi belgi uchun (telefon / kompyuter).
 *
 * @param {string|null} device - "Chrome · Android"
 * @returns {"mobile"|"desktop"|"unknown"}
 */
const deviceKindOf = (device) => {
  const label = String(device || "");
  if (/Android|iOS|Mobil ilova/.test(label)) return "mobile";
  if (/Windows|macOS|Linux/.test(label)) return "desktop";
  return "unknown";
};

/**
 * Filial nomlari — ro'yxatda seans qaysi filialga kirilgani.
 *
 * @param {object[]} rows
 * @returns {Promise<Map<string, string>>}
 */
async function loadBranchNames(rows) {
  const ids = [...new Set(rows.map((row) => row.branchId).filter(Boolean))];
  if (ids.length === 0) return new Map();

  const branches = await platformPrisma.branch.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, shortName: true },
  });

  return new Map(branches.map((b) => [b.id, b.shortName || b.name]));
}

/**
 * Seans qatorini mijoz shakliga keltiradi.
 *
 * @param {object} row - `UserSession`
 * @param {object} [context]
 * @param {string|null} [context.currentJti]
 * @param {Map<string, string>} [context.branchNames]
 * @returns {object}
 */
function publicOwnSession(row, { currentJti = null, branchNames = new Map() } = {}) {
  const isCurrent = Boolean(currentJti) && row.jti === currentJti;

  return {
    id: row.id,
    isCurrent,
    device: row.device || "Noma'lum qurilma",
    // Bir xil yorliqli ikkita qurilmani ajratadigan qisqa belgi ("#3F9A1C")
    deviceTag: securityService.deviceTagOf(row.deviceId),
    deviceKind: deviceKindOf(row.device),
    channel: row.channel,
    channelLabel: ACTIVITY_CHANNEL_LABELS[row.channel] ?? row.channel,
    ip: row.ip,
    branchId: row.branchId,
    branchName: branchNames.get(row.branchId) ?? null,
    createdAt: row.createdAt,
    createdLabel: formatDateTimeUz(row.createdAt),
    lastSeenAt: row.lastSeenAt,
    lastSeenLabel: formatDateTimeUz(row.lastSeenAt),
    isOnline: isCurrent || Date.now() - new Date(row.lastSeenAt).getTime() < ONLINE_WINDOW_MS,
  };
}

/**
 * Qatorlar ro'yxatini ochiq shaklga keltiradi (filial nomlari bilan).
 *
 * @param {object[]} rows
 * @param {string|null} [currentJti]
 * @returns {Promise<object[]>}
 */
async function describeSessions(rows, currentJti = null) {
  const branchNames = await loadBranchNames(rows);
  return rows.map((row) => publicOwnSession(row, { currentJti, branchNames }));
}

/**
 * MENING OCHIQ SEANSLARIM.
 *
 * `current` — shu so'rov kelgan seans (eski, `jti` siz token bo'lsa `null`).
 * `others` — qolganlari, oxirgi faollik bo'yicha.
 *
 * @param {object} user - `req.user`
 * @param {string|null} currentJti - `req.tokenJti`
 * @returns {Promise<{ limit: number|null, total: number, current: object|null, others: object[] }>}
 */
async function listMine(user, currentJti) {
  const rows = await securityService.liveSessions(user.id);
  const sessions = await describeSessions(rows, currentJti);

  return {
    limit: securityService.sessionLimitOf(user),
    total: sessions.length,
    current: sessions.find((s) => s.isCurrent) ?? null,
    others: sessions.filter((s) => !s.isCurrent),
  };
}

/**
 * SHART BO'YICHA OCHIQ SEANSLARNI YAKUNLAYDI — yagona yozuv nuqtasi.
 *
 * ⚠️ Avval `jti` lar o'qiladi, keyin FAQAT o'sha `id` lar yopiladi:
 * oraliqda ochilgan yangi seans (masalan, shu lahzadagi login) tasodifan
 * yopilib ketmasligi uchun.
 *
 * @param {object} where - Prisma `where` (`liveSessionWhere` asosida)
 * @param {string} actorId - kim yakunladi (o'zi)
 * @returns {Promise<number>} - nechta seans yopildi
 */
async function terminateWhere(where, actorId) {
  const rows = await platformPrisma.userSession.findMany({
    where,
    select: { id: true, jti: true },
  });
  if (rows.length === 0) return 0;

  const { count } = await platformPrisma.userSession.updateMany({
    where: { id: { in: rows.map((row) => row.id) }, endReason: "active" },
    data: { endReason: "revoked", endedAt: new Date(), endedBy: actorId },
  });

  // ⚠️ "Ko'rindi" oynasi tozalanadi — aks holda yakunlangan qurilma yana
  // 2 daqiqa ishlab turardi va tugma "ishlamadi" bo'lib ko'rinardi.
  if (count > 0) securityService.forgetSeenCache();

  // Yakunlangan telefon topshiriq bildirishnomalarini olishda davom etmasin
  await Promise.all(rows.map((row) => pushService.forgetSession(row.jti)));

  return count;
}

/**
 * BITTA SEANSIMNI YAKUNLASH.
 *
 * ⚠️ JORIY SEANS BU YERDA YOPILMAYDI — u "Chiqish" (`POST /auth/logout`).
 * Aks holda odam ro'yxatdan o'zini bosib, tushuntirishsiz 401 bilan
 * tizimdan uchib chiqardi.
 *
 * @param {object} user - `req.user`
 * @param {string} sessionId
 * @param {string|null} currentJti - `req.tokenJti`
 * @returns {Promise<{ closed: number }>}
 */
async function terminateMine(user, sessionId, currentJti) {
  // ⚠️ `userId` sharti MAJBURIY: boshqa odamning seans id si "topilmadi"
  const session = await platformPrisma.userSession.findFirst({
    where: { id: sessionId, userId: user.id },
    select: { id: true, jti: true, endReason: true, expiresAt: true },
  });
  if (!session) throw new NotFoundError("Seans topilmadi");

  if (currentJti && session.jti === currentJti) {
    throw new BadRequestError(
      "Bu — joriy qurilma. Undan chiqish uchun \"Chiqish\" tugmasidan foydalaning",
    );
  }

  if (session.endReason !== "active" || session.expiresAt <= new Date()) {
    throw new BadRequestError("Bu seans allaqachon yakunlangan");
  }

  const closed = await terminateWhere(
    { ...securityService.liveSessionWhere(user.id), id: sessionId },
    user.id,
  );

  return { closed };
}

/**
 * SHU QURILMADAN BOSHQA HAMMASINI YAKUNLASH.
 *
 * ⚠️ `jti` siz eski token bilan kelsa joriy seans noma'lum — hammasi
 * yopiladi, eski token esa baribir ishlashda davom etadi (unga seans
 * qatori yo'q). Bu xato emas: odam tizimdan chiqib ketmaydi.
 *
 * @param {object} user - `req.user`
 * @param {string|null} currentJti - `req.tokenJti`
 * @returns {Promise<{ closed: number }>}
 */
async function terminateOthers(user, currentJti) {
  const where = securityService.liveSessionWhere(user.id);
  if (currentJti) where.jti = { not: currentJti };

  const closed = await terminateWhere(where, user.id);
  return { closed };
}

module.exports = {
  ONLINE_WINDOW_MS,
  deviceKindOf,
  publicOwnSession,
  describeSessions,
  listMine,
  terminateMine,
  terminateOthers,
};
