/**
 * SINF GURUHLARI — a'zolik AVTOMATIK sinxronlanadi.
 *
 * Qoida bitta jumlada:
 *
 * > Har sinfga BITTA guruh; a'zolar "kerakli holat → farq → tuzatish"
 * > (reconciliation) usulida yangilanadi, hodisalarni bittalab
 * > "qo'sh / olib tashla" qilib EMAS.
 *
 * ⚠️ NIMA UCHUN RECONCILIATION: hodisa asosidagi yondashuv bir kun
 * o'tkazib yuboradi (jadval Sheets'dan import qilindi, tyutor almashdi,
 * o'quvchi filiallararo ko'chdi) va guruh JIMGINA noto'g'ri bo'lib
 * qoladi — buni hech kim sezmaydi, chunki "qo'shilmagan odam" hech
 * qanday xato bermaydi. To'liq solishtirish esa o'zini O'ZI TUZATADI:
 * kechki pass har kuni hamma sinfni tekshiradi.
 *
 * A'zolar manbai (FILIAL schema'sidan):
 *   o'quvchilar          `UserClass` (role = student, arxivlanmagan)  → member
 *   dars beradiganlar    `ScheduleLesson.teacherId`                   → admin
 *   sinf rahbari         `ClassLeader.leaderId`                       → admin
 *   tyutor               `TutorGroup.tutorId` (joriy oyda aktiv)      → admin
 *
 * ⚠️ O'RINBOSAR O'QITUVCHI QO'SHILMAYDI (`LessonSubstitution`): u
 * VAQTINCHA (bir hafta kasallik). Guruhga qo'shilsa, muddat tugagach uni
 * chiqarish kerak bo'lardi — va "kim qachon chiqadi" degan savol har
 * sinxronda qayta hal qilinardi. Kerak bo'lsa — alohida qaror.
 *
 * ⚠️ FAQAT `source = "auto"` QATORLARGA TEGADI: qo'lda qo'shilgan odamni
 * sinxron chiqarib yuborsa, admin qarori jimgina bekor bo'lardi.
 *
 * ⚠️ SINF YOPILGANDA GURUH O'CHIRILMAYDI — `closedAt` qo'yiladi: tarix
 * o'qiladi, yozish yopiladi. Yangi o'quv yilida yangi sinf = yangi guruh.
 */

const prisma = require("../config/prisma");
const platformPrisma = require("../config/platformPrisma");
const { getBranch, runWithBranch } = require("../config/branchContext");
const { currentMonthKey } = require("../helpers/month.helpers");
const { ROLES } = require("../utils/constants");
const logger = require("../utils/logger");
const emitter = require("../realtime/emitter");
const chatService = require("./chat.service");

/**
 * HODISADAN KEYINGI SINXRONNING KECHIKISHI.
 *
 * ⚠️ NIMA UCHUN DEBOUNCE: dars jadvalini Sheets'dan import qilish 40 ta
 * darsni bir vaqtda yozadi va har biri `requestSync` chaqiradi. Busiz
 * bitta import 40 marta sinxron ishga tushirardi.
 */
const DEBOUNCE_MS = 3000;

/** Navbatdagi sinxronlar: `branchId:classId` → timer. */
const pending = new Map();

/**
 * JORIY FILIAL yoki `null`.
 *
 * ⚠️ `getBranch()` XATO TASHLAMAYDI — kontekst bo'lmasa `null` qaytaradi
 * (xato tashlaydigani `requireBranch`). Shu farq bir marta `TypeError`
 * bergan: `try/catch` bilan o'ralgan chaqiruv `null.id` da yiqilib,
 * tyutor guruhini olib tashlash amalini butunlay to'xtatib qo'ygan edi.
 *
 * ⚠️ Kontekstsiz chaqiruv JIM O'TMAYDI (log yoziladi), lekin asosiy
 * amalni ham YIQITMAYDI: sinxron fon ishi va kechki pass baribir
 * to'g'rilaydi.
 */
function currentBranch() {
  const branch = getBranch();
  if (!branch) {
    logger.warn("[classChat] filial konteksti yo'q — sinxron o'tkazib yuborildi");
    return null;
  }
  return branch;
}

/* ════════════════════════ KERAKLI HOLAT ════════════════════════ */

/**
 * Sinfda KIM BO'LISHI KERAK — `Map<userId, "admin"|"member">`.
 *
 * ⚠️ FILIAL KONTEKSTI ICHIDA chaqiriladi (`prisma` joriy filialga boradi).
 *
 * @param {string} classId
 * @returns {Promise<Map<string, string>>}
 */
async function computeDesiredMembers(classId) {
  const month = currentMonthKey();

  const [students, schedules, leaders, tutors] = await Promise.all([
    prisma.userClass.findMany({
      where: {
        classId,
        // ⚠️ `isArchived` bo'yicha filtr: arxivlangan o'quvchi joriy
        // ro'yxatlarda ko'rinmaydi (`education.md` §4).
        user: { role: ROLES.STUDENT, isArchived: false, isActive: true },
      },
      select: { userId: true },
    }),
    prisma.schedule.findMany({
      where: { classId },
      select: { lessons: { select: { teacherId: true } } },
    }),
    prisma.classLeader.findMany({ where: { classId }, select: { leaderId: true } }),
    prisma.tutorGroup.findMany({
      where: {
        classId,
        startMonth: { lte: month },
        OR: [{ endMonth: null }, { endMonth: { gte: month } }],
      },
      select: { tutorId: true },
    }),
  ]);

  const desired = new Map();

  // ⚠️ TARTIB MUHIM: avval o'quvchilar, keyin xodimlar. Bir odam ikki
  // manbada bo'lsa (nazariy hol), XODIM roli ustun turishi kerak.
  for (const row of students) desired.set(row.userId, "member");

  const staffIds = new Set();
  for (const schedule of schedules) {
    for (const lesson of schedule.lessons) staffIds.add(lesson.teacherId);
  }
  for (const row of leaders) staffIds.add(row.leaderId);
  for (const row of tutors) staffIds.add(row.tutorId);

  if (staffIds.size > 0) {
    // Arxivlangan xodim guruhda turmasligi kerak (`devices.md` bilan AYNI
    // mulohaza: ketgan odam ko'rinmasin).
    const staff = await prisma.user.findMany({
      where: { id: { in: [...staffIds] }, isArchived: false, isActive: true },
      select: { id: true },
    });
    for (const row of staff) desired.set(row.id, "admin");
  }

  return desired;
}

/* ════════════════════════ SINXRON ════════════════════════ */

/**
 * BITTA SINFNI sinxronlaydi (filial konteksti ICHIDA).
 *
 * @param {string} classId
 * @returns {Promise<{conversationId: string|null, added: number, removed: number, roleChanged: number, closed?: boolean}>}
 */
async function syncClassConversation(classId) {
  const branch = getBranch();
  const cls = await prisma.class.findUnique({
    where: { id: String(classId) },
    select: { id: true, name: true, isActive: true },
  });

  const conversation = await ensureConversation(branch.id, classId, cls);

  if (!cls || !cls.isActive) {
    // Sinf o'chirilgan yoki nofaol: guruh YOPILADI, a'zolar qoladi
    // (tarixni ochish uchun a'zolik kerak).
    if (conversation && !conversation.closedAt) {
      await platformPrisma.conversation.update({
        where: { id: conversation.id },
        data: { closedAt: new Date() },
      });
      await notifyMembers(conversation.id);
    }
    return { conversationId: conversation?.id || null, added: 0, removed: 0, roleChanged: 0, closed: true };
  }

  // Sinf qayta faollashtirilgan bo'lsa guruh ham ochiladi.
  if (conversation.closedAt) {
    await platformPrisma.conversation.update({
      where: { id: conversation.id },
      data: { closedAt: null },
    });
  }

  const desired = await computeDesiredMembers(classId);
  const current = await platformPrisma.conversationMember.findMany({
    where: { conversationId: conversation.id, source: "auto" },
  });

  const currentMap = new Map(current.map((row) => [row.userId, row]));

  const toAdd = [];
  const toRestore = [];
  const toRoleChange = [];
  for (const [userId, role] of desired) {
    const row = currentMap.get(userId);
    if (!row) {
      toAdd.push({ userId, role });
      continue;
    }
    if (row.leftAt) toRestore.push({ userId, role });
    else if (row.role !== role) toRoleChange.push({ userId, role });
  }

  const toRemove = current
    .filter((row) => !row.leftAt && !desired.has(row.userId))
    .map((row) => row.userId);

  if (
    toAdd.length === 0 &&
    toRestore.length === 0 &&
    toRoleChange.length === 0 &&
    toRemove.length === 0 &&
    conversation.title === cls.name
  ) {
    return { conversationId: conversation.id, added: 0, removed: 0, roleChanged: 0 };
  }

  await platformPrisma.$transaction([
    ...(conversation.title !== cls.name
      ? [
          platformPrisma.conversation.update({
            where: { id: conversation.id },
            data: { title: cls.name },
          }),
        ]
      : []),
    ...toAdd.map(({ userId, role }) =>
      platformPrisma.conversationMember.create({
        data: { conversationId: conversation.id, userId, role, source: "auto" },
      }),
    ),
    ...toRestore.map(({ userId, role }) =>
      platformPrisma.conversationMember.update({
        where: { conversationId_userId: { conversationId: conversation.id, userId } },
        data: { leftAt: null, role },
      }),
    ),
    ...toRoleChange.map(({ userId, role }) =>
      platformPrisma.conversationMember.update({
        where: { conversationId_userId: { conversationId: conversation.id, userId } },
        data: { role },
      }),
    ),
    ...toRemove.map((userId) =>
      platformPrisma.conversationMember.update({
        where: { conversationId_userId: { conversationId: conversation.id, userId } },
        data: { leftAt: new Date() },
      }),
    ),
  ]);

  // Yangi a'zoda suhbat DARHOL paydo bo'lishi kerak.
  emitter.emitToUsers(
    [...toAdd.map((r) => r.userId), ...toRestore.map((r) => r.userId), ...toRemove],
    "conversation:updated",
    { conversationId: conversation.id },
  );
  await notifyMembers(conversation.id);

  // ⚠️ TIZIM XABARI FAQAT XODIM O'ZGARISHIDA: sinfga har yangi o'quvchi
  // qo'shilganda "Ali guruhga qo'shildi" yozilsa, sentabrda guruh 30 ta
  // tizim xabari bilan boshlanardi.
  const staffAdded = toAdd.filter((r) => r.role === "admin").map((r) => r.userId);
  if (staffAdded.length > 0) {
    await chatService.addSystemMessage(conversation.id, {
      addedIds: staffAdded,
      actorId: staffAdded[0],
    });
  }

  return {
    conversationId: conversation.id,
    added: toAdd.length + toRestore.length,
    removed: toRemove.length,
    roleChanged: toRoleChange.length,
  };
}

/**
 * Sinf guruhini topadi yoki ochadi.
 *
 * ⚠️ `upsert` KOMPOZIT KALIT bo'yicha (`branchId_classId`): ikki parallel
 * sinxron bitta sinf uchun ikkita guruh ocha OLMAYDI.
 */
async function ensureConversation(branchId, classId, cls) {
  const title = cls?.name || "Sinf";
  return platformPrisma.conversation.upsert({
    where: { branchId_classId: { branchId: String(branchId), classId: String(classId) } },
    create: {
      type: "class",
      branchId: String(branchId),
      classId: String(classId),
      title,
      // ⚠️ `createdBy` — TIZIM (filial id si): guruhni odam ochmaydi,
      // shuning uchun bu maydonga odam id sini yozib qo'yish yolg'on
      // bo'lardi ("u guruh yaratmagan").
      createdBy: String(branchId),
    },
    update: {},
  });
}

async function notifyMembers(conversationId) {
  const members = await platformPrisma.conversationMember.findMany({
    where: { conversationId, leftAt: null },
    select: { userId: true },
  });
  emitter.emitToUsers(
    members.map((m) => m.userId),
    "conversation:updated",
    { conversationId },
  );
}

/* ════════════════════════ CHAQIRUV NUQTALARI ════════════════════════ */

/**
 * SINXRONNI SO'RASH — hodisadan keyin (debounce bilan).
 *
 * ⚠️ FILIAL ID SI SHU YERDA SAQLANADI va ish `runWithBranch` ICHIDA
 * bajariladi: kechiktirilgan ish (`setTimeout`) filial kontekstidan
 * TASHQARIDA ishlaydi va aks holda birinchi so'rov "Filial konteksti
 * yo'q" xatosi bilan yiqilardi (root `CLAUDE.md` qoidasi).
 *
 * ⚠️ XATO YUTILADI: sinxron — fon ishi. U yiqilsa, asosiy amal (o'quvchini
 * sinfga qo'shish, jadvalni saqlash) orqaga qaytmasligi kerak; kechki
 * pass baribir to'g'rilaydi.
 *
 * @param {string} classId
 */
function requestSync(classId) {
  if (!classId) return;

  const branch = currentBranch();
  if (!branch) return;

  const key = `${branch.id}:${classId}`;
  if (pending.has(key)) clearTimeout(pending.get(key));

  const timer = setTimeout(() => {
    pending.delete(key);
    runWithBranch(branch, () => syncClassConversation(String(classId)))
      .then((result) => {
        if (result.added || result.removed || result.roleChanged) {
          logger.info(
            `[classChat] ${branch.name}: sinf ${classId} — +${result.added} / -${result.removed}`,
          );
        }
      })
      .catch((error) =>
        logger.error(`[classChat] sinxron xatosi (${key}): ${error.message}`),
      );
  }, DEBOUNCE_MS);

  // ⚠️ `unref()`: navbatdagi sinxron jarayonning yopilishini USHLAB
  // TURMASLIGI kerak (graceful shutdown).
  timer.unref?.();
  pending.set(key, timer);
}

/**
 * BIR NECHTA SINF — jadval saqlash / import uchun.
 * @param {string[]} classIds
 */
function requestSyncMany(classIds = []) {
  for (const id of [...new Set(classIds.filter(Boolean))]) requestSync(id);
}

/**
 * BUTUN FILIAL — DARS JADVALI o'zgarganda.
 *
 * ⚠️ NIMA UCHUN "HAMMASI": jadvalga yozadigan yo'l (platforma tahriri,
 * Sheets'dan qo'llash, manbani almashtirish, arxivdan tiklash,
 * rejalashtiruvchini e'lon qilish) qaysi SINFLAR tegilganini chaqiruvchiga
 * aytmaydi — Sheets rejimida u butun maktabni qayta yozadi. Har yo'lda
 * "qaysi sinflar o'zgardi" ni qo'lda yig'ish bitta unutilgan joyda
 * o'qituvchini guruhsiz qoldirardi.
 *
 * ⚠️ BITTA NAVBAT, 40 ta EMAS: `requestSyncMany` har sinf uchun alohida
 * taymer qo'yardi; bu yerda esa butun filial uchun BITTA ish navbatga
 * tushadi va u `syncAllInBranch` ni chaqiradi.
 */
function requestSyncAll() {
  const branch = currentBranch();
  if (!branch) return;

  const key = `${branch.id}:*`;
  if (pending.has(key)) clearTimeout(pending.get(key));

  const timer = setTimeout(() => {
    pending.delete(key);
    runWithBranch(branch, () => syncAllInBranch())
      .then((result) => {
        if (result.added || result.removed || result.roleChanged) {
          logger.info(
            `[classChat] ${branch.name}: jadval o'zgardi — ` +
              `+${result.added} / -${result.removed} / rol ${result.roleChanged}`,
          );
        }
      })
      .catch((error) =>
        logger.error(`[classChat] to'liq sinxron xatosi (${branch.name}): ${error.message}`),
      );
  }, DEBOUNCE_MS);

  timer.unref?.();
  pending.set(key, timer);
}

/**
 * O'QUVCHI BO'YICHA — uning HAMMA sinfi sinxronlanadi.
 *
 * Nima uchun kerak: o'quvchi sinfdan chiqarilganda eski sinf id si
 * chaqiruvchida bo'lmasligi mumkin (`updateUser` faqat yangi ro'yxatni
 * biladi). Shuning uchun bu funksiya o'quvchi TEGISHLI bo'lgan guruhlarni
 * ham sinxronlaydi.
 *
 * @param {string} studentId
 * @param {string[]} [extraClassIds] - chiqarilgan sinflar
 */
async function requestSyncForStudent(studentId, extraClassIds = []) {
  try {
    const rows = await prisma.userClass.findMany({
      where: { userId: String(studentId) },
      select: { classId: true },
    });
    requestSyncMany([...rows.map((r) => r.classId), ...extraClassIds]);
  } catch (error) {
    logger.warn(`[classChat] o'quvchi bo'yicha sinxron so'ralmadi: ${error.message}`);
  }
}

/**
 * XODIM BO'YICHA — u dars beradigan va rahbar/tyutor bo'lgan sinflar.
 *
 * @param {string} staffId
 */
async function requestSyncForStaff(staffId) {
  try {
    const id = String(staffId);
    const [lessons, leaders, tutors] = await Promise.all([
      prisma.scheduleLesson.findMany({
        where: { teacherId: id },
        select: { schedule: { select: { classId: true } } },
      }),
      prisma.classLeader.findMany({ where: { leaderId: id }, select: { classId: true } }),
      prisma.tutorGroup.findMany({ where: { tutorId: id }, select: { classId: true } }),
    ]);

    requestSyncMany([
      ...lessons.map((l) => l.schedule.classId),
      ...leaders.map((l) => l.classId),
      ...tutors.map((t) => t.classId),
    ]);
  } catch (error) {
    logger.warn(`[classChat] xodim bo'yicha sinxron so'ralmadi: ${error.message}`);
  }
}

/**
 * JORIY FILIALNING BARCHA SINFLARI — kechki pass va qo'lda qayta sinxron.
 *
 * @returns {Promise<{classes: number, added: number, removed: number, roleChanged: number, failed: number}>}
 */
async function syncAllInBranch() {
  const classes = await prisma.class.findMany({ select: { id: true } });
  const total = { classes: classes.length, added: 0, removed: 0, roleChanged: 0, failed: 0 };

  for (const cls of classes) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await syncClassConversation(cls.id);
      total.added += result.added;
      total.removed += result.removed;
      total.roleChanged += result.roleChanged;
    } catch (error) {
      total.failed += 1;
      logger.error(`[classChat] sinf ${cls.id} sinxronlanmadi: ${error.message}`);
    }
  }

  return total;
}

module.exports = {
  DEBOUNCE_MS,
  computeDesiredMembers,
  syncClassConversation,
  syncAllInBranch,
  requestSync,
  requestSyncMany,
  requestSyncAll,
  requestSyncForStudent,
  requestSyncForStaff,
};
