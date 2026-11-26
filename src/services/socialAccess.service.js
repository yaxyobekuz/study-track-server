/**
 * KIM NIMA QILA OLADI — ijtimoiy qatlamning YAGONA darvozasi.
 *
 * Qoida bitta jumlada:
 *
 * > Istoriya va xodimlar chati — FAQAT XODIMLAR uchun. O'quvchi faqat o'z
 * > SINF GURUHINI ko'radi: istoriya yo'q, shaxsiy yozishma yo'q.
 *
 * ⚠️ DARVOZA SERVERDA, PANELDA EMAS (`finance.md` §14 / §15 bilan AYNI
 * mulohaza): ilovada bo'limni yashirish yetarli emas — eski ilova yoki
 * qo'lda yuborilgan so'rov javobni baribir olardi. Shu sababli har bir
 * `/api/social/*` yo'li shu fayldan o'tadi.
 *
 * ⚠️ OTA-ONA YO'Q. Ota-ona ilovasi O'QUVCHI hisobi bilan kiradi
 * (`parental.md` §1), ya'ni `userId` bola bilan bir xil — rolga qarab
 * ajratib bo'lmaydi. Ajratadigan yagona narsa — SEANS KANALI
 * (`req.sessionChannel`), shuning uchun `parent` kanali shu yerda
 * to'siladi va sinf guruhi ham ota-onaga ko'rinmaydi.
 *
 * ⚠️ ODAM MA'LUMOTI `user_directory` DAN o'qiladi, filial bazasidan EMAS:
 * suhbatda ikki filialning xodimi bo'lishi mumkin va ularning `users`
 * qatorlari BOSHQA schema'larda yotadi.
 */

const platformPrisma = require("../config/platformPrisma");
const { config } = require("../config/env.config");
const { ROLES } = require("../utils/constants");
const { PERMISSIONS, hasPermission, hasRole } = require("../utils/permissions");
const { ForbiddenError, NotFoundError } = require("../utils/errors");
const { USER_CARD_SELECT, buildUserCard } = require("../helpers/socialAvatar.helpers");

const STAFF_ONLY_MESSAGE = "Bu bo'lim faqat xodimlar uchun";
const PARENT_CHANNEL_MESSAGE = "Bu bo'lim ota-ona ilovasida ochilmaydi";

/**
 * Odam XODIMMI — ya'ni o'quvchi emasmi.
 *
 * ⚠️ ROLLAR RO'YXATI QOTIRILMAYDI (`isTutor` belgisi bilan AYNI sabab):
 * rollar dinamik va maktab yangi rol ("psixolog", "laborant") ochishi
 * mumkin. Shuning uchun shart teskari yoziladi — "o'quvchi EMAS".
 *
 * @param {{role?: string, extraRoles?: string[]}} user
 * @returns {boolean}
 */
const isStaff = (user) => Boolean(user) && !hasRole(user, ROLES.STUDENT);

/**
 * Faqat xodim. ⚠️ Kanal ham tekshiriladi: ota-ona ilovasi o'quvchi hisobi
 * bilan kiradi, lekin xodim hisobi bilan ham kirishi MUMKIN (bir odam ham
 * o'qituvchi, ham ota-ona). Kanal `parent` bo'lsa — bu ota-ona ekrani.
 *
 * @param {object} user - `req.user`
 * @param {string|null} [sessionChannel] - `req.sessionChannel`
 */
function assertStaff(user, sessionChannel = null) {
  if (sessionChannel === "parent") throw new ForbiddenError(PARENT_CHANNEL_MESSAGE);
  if (!isStaff(user)) throw new ForbiddenError(STAFF_ONLY_MESSAGE);
}

/**
 * Bo'lim shu filialda ochiqmi (PILOT bayrog'i).
 *
 * ⚠️ `SOCIAL_ENABLED_BRANCHES` bo'sh bo'lsa — HAMMA filialda ochiq.
 * Ro'yxat KO'RISHNI emas (istoriya butun tarmoqqa ko'rinadi), bo'limning
 * OCHIQLIGINI hal qiladi: pilot filialda sinovdan o'tkazib, keyin
 * hammasiga yoqiladi.
 *
 * @param {{id: string, name?: string}} branch - `req.branch`
 */
function assertEnabled(branch) {
  const allowed = config.socialEnabledBranches;
  if (allowed.length === 0) return;
  if (!branch?.id || !allowed.includes(branch.id)) {
    throw new ForbiddenError("Bu bo'lim hozircha sizning filialingizda yoqilmagan");
  }
}

/**
 * Ota-ona kanali — sinf guruhi uchun ham to'siladi.
 *
 * ⚠️ PUSH ham `channels: ["student"]` bilan ketadi (`push.service.js`),
 * ya'ni ota-ona telefoniga sinf guruhining xabari TUSHMAYDI. Ikkalasi
 * birga bo'lishi kerak: faqat push filtrlansa, ota-ona ilovasi suhbatni
 * ochib o'qiy olardi.
 */
function assertNotParentChannel(sessionChannel) {
  if (sessionChannel === "parent") throw new ForbiddenError(PARENT_CHANNEL_MESSAGE);
}

/** Moderator — istoriya/izohni istalgan joyda o'chira oladi. */
const isStoryModerator = (user) =>
  hasRole(user, ROLES.OWNER) || hasPermission(user?.permissions || [], PERMISSIONS.STORIES_MODERATE);

/** Moderator — shikoyat qilingan xabarni ko'radi va o'chiradi. */
const isChatModerator = (user) =>
  hasRole(user, ROLES.OWNER) || hasPermission(user?.permissions || [], PERMISSIONS.CHAT_MODERATE);

/** Sinf guruhlarini qo'lda sinxronlash / sozlash huquqi. */
const canManageClassGroups = (user) =>
  hasRole(user, ROLES.OWNER) ||
  hasPermission(user?.permissions || [], PERMISSIONS.CHAT_CLASSGROUPSMANAGE);

/** Xodimlar guruhini yaratish huquqi. */
const canCreateGroup = (user) =>
  hasRole(user, ROLES.OWNER) ||
  hasPermission(user?.permissions || [], PERMISSIONS.CHAT_GROUPCREATE);

/* ──────────────────── ODAMLAR KATALOGI (platforma) ──────────────────── */

/**
 * `userId` → kartochka xaritasi.
 *
 * ⚠️ BITTA SO'ROV, N+1 YO'Q: lenta 300 xodimning kartochkasini chizadi.
 * Har biri uchun alohida so'rov yuborilsa, ekran ochilishi sekundlarga
 * cho'zilardi.
 *
 * @param {string[]} userIds
 * @returns {Promise<Map<string, object>>}
 */
async function loadUserCards(userIds = []) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (ids.length === 0) return new Map();

  const rows = await platformPrisma.userDirectory.findMany({
    where: { id: { in: ids } },
    select: { ...USER_CARD_SELECT, branch: { select: { name: true } } },
  });

  return new Map(
    rows.map((row) => [row.id, buildUserCard(row, { branchName: row.branch?.name || null })]),
  );
}

/** Bitta odamning kartochkasi (topilmasa `null`). */
async function loadUserCard(userId) {
  const map = await loadUserCards([userId]);
  return map.get(String(userId)) || null;
}

/**
 * Yozish uchun xodim qidirish (`GET /chat/users`).
 *
 * ⚠️ O'QUVCHI VA ARXIVLANGAN HECH QACHON CHIQMAYDI: ro'yxat "kimga yozsam
 * bo'ladi" degan savolga javob beradi, ya'ni unda chiqqan odamga 1:1
 * suhbat ochilishi kerak. O'quvchi chiqsa, xodim unga yozib ko'rib, 403
 * olardi.
 *
 * @param {{query?: string, skip: number, limit: number, excludeId?: string}} input
 */
async function searchStaff({ query = "", skip = 0, limit = 20, excludeId = null }) {
  const q = String(query || "").trim();
  const where = {
    isArchived: false,
    isActive: true,
    role: { not: ROLES.STUDENT },
    ...(excludeId ? { id: { not: String(excludeId) } } : {}),
    ...(q
      ? {
          OR: [
            { firstName: { contains: q, mode: "insensitive" } },
            { lastName: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    platformPrisma.userDirectory.count({ where }),
    platformPrisma.userDirectory.findMany({
      where,
      select: { ...USER_CARD_SELECT, branch: { select: { name: true } } },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      skip,
      take: limit,
    }),
  ]);

  return {
    total,
    items: rows.map((row) => buildUserCard(row, { branchName: row.branch?.name || null })),
  };
}

/**
 * Odam XODIMMI — KATALOG bo'yicha (`user_directory`).
 *
 * Nima uchun kerak: 1:1 suhbat ochilayotganda SHERIK boshqa filialda
 * bo'lishi mumkin va uning `users` qatori bizning schema'mizda YO'Q.
 * Rolni katalogdan o'qish yagona ishonchli yo'l.
 *
 * @param {string} userId
 * @returns {Promise<object>} katalog qatori
 */
async function assertDirectoryStaff(userId) {
  const row = await platformPrisma.userDirectory.findUnique({
    where: { id: String(userId) },
    select: { ...USER_CARD_SELECT, branch: { select: { name: true } } },
  });
  if (!row) throw new NotFoundError("Foydalanuvchi topilmadi");
  if (row.role === ROLES.STUDENT) {
    throw new ForbiddenError("O'quvchi bilan shaxsiy yozishma ochilmaydi");
  }
  if (row.isArchived) throw new ForbiddenError("Bu xodim arxivlangan");
  return buildUserCard(row, { branchName: row.branch?.name || null });
}

module.exports = {
  isStaff,
  assertStaff,
  assertEnabled,
  assertNotParentChannel,
  isStoryModerator,
  isChatModerator,
  canManageClassGroups,
  canCreateGroup,
  loadUserCards,
  loadUserCard,
  searchStaff,
  assertDirectoryStaff,
  STAFF_ONLY_MESSAGE,
};
