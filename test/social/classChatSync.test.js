const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * SINF GURUHLARI — `classChat.service` HAQIQIY kodi, baza xotirada.
 *
 * Eng muhim qoidalar:
 *   • a'zolar SINF TARKIBIDAN quriladi (o'quvchilar + dars beradiganlar +
 *     sinf rahbari + tyutor), o'rinbosar QO'SHILMAYDI;
 *   • sinxron IDEMPOTENT — ikki marta ishga tushirish hech narsani
 *     o'zgartirmaydi (kechki pass har kuni ishlaydi);
 *   • QO'LDA qo'shilgan a'zoga TEGILMAYDI (`source = "manual"`);
 *   • sinf nofaol bo'lsa guruh YOPILADI, o'chirilmaydi.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const { currentMonthKey } = require("../../src/helpers/month.helpers");

const BRANCH = { id: "f".repeat(24), name: "Test filiali" };
const CLASS_A = "1".repeat(24);
const CLASS_B = "2".repeat(24);
const CONV_A = "c".repeat(24);
const CONV_B = "d".repeat(24);

const S1 = "a".repeat(24); // o'quvchi
const S2 = "b".repeat(24); // o'quvchi
const TEACHER = "e".repeat(24);
const LEADER = "g".repeat(24);
const TUTOR = "h".repeat(24);
const ARCHIVED_TEACHER = "i".repeat(24);
const MANUAL = "j".repeat(24); // qo'lda qo'shilgan odam

let db;
let emitted;
let systemMessages;

const resetDb = () => {
  db = {
    classes: [
      { id: CLASS_A, name: "5-A", isActive: true },
      { id: CLASS_B, name: "5-B", isActive: true },
    ],
    userClasses: [
      { userId: S1, classId: CLASS_A },
      { userId: S2, classId: CLASS_A },
    ],
    users: [
      { id: S1, role: "student", isActive: true, isArchived: false },
      { id: S2, role: "student", isActive: true, isArchived: false },
      { id: TEACHER, role: "teacher", isActive: true, isArchived: false },
      { id: LEADER, role: "teacher", isActive: true, isArchived: false },
      { id: TUTOR, role: "worker", isActive: true, isArchived: false },
      { id: ARCHIVED_TEACHER, role: "teacher", isActive: true, isArchived: true },
      { id: MANUAL, role: "teacher", isActive: true, isArchived: false },
    ],
    schedules: [
      { classId: CLASS_A, lessons: [{ teacherId: TEACHER }, { teacherId: ARCHIVED_TEACHER }] },
    ],
    classLeaders: [{ classId: CLASS_A, leaderId: LEADER }],
    tutorGroups: [
      { classId: CLASS_A, tutorId: TUTOR, startMonth: currentMonthKey() - 1, endMonth: null },
    ],
    conversations: [],
    members: [],
  };
  emitted = [];
  systemMessages = [];
};

/* ── `where` ning shu servis ishlatadigan qismi ── */
const cmp = (value, cond) => {
  if (cond === undefined) return true;
  if (cond === null) return value == null;
  if (typeof cond !== "object") return value === cond;
  if ("in" in cond) return cond.in.includes(value);
  if ("not" in cond) return cond.not === null ? value != null : value !== cond.not;
  if ("lte" in cond && !(value <= cond.lte)) return false;
  if ("gte" in cond && !(value >= cond.gte)) return false;
  return true;
};

const matches = (row, where = {}) =>
  Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return cond.some((c) => matches(row, c));
    return cmp(row[key], cond);
  });

fakeModule("../../src/config/prisma", {
  class: {
    findUnique: async ({ where }) => db.classes.find((c) => c.id === where.id) || null,
    findMany: async ({ where = {} } = {}) => db.classes.filter((c) => matches(c, where)),
  },
  userClass: {
    findMany: async ({ where = {} }) =>
      db.userClasses.filter((uc) => {
        if (where.classId && uc.classId !== where.classId) return false;
        if (where.userId && uc.userId !== where.userId) return false;
        if (where.user) {
          const user = db.users.find((u) => u.id === uc.userId);
          if (!user || !matches(user, where.user)) return false;
        }
        return true;
      }),
  },
  schedule: {
    findMany: async ({ where }) => db.schedules.filter((s) => s.classId === where.classId),
  },
  classLeader: {
    findMany: async ({ where }) => db.classLeaders.filter((l) => matches(l, where)),
  },
  tutorGroup: {
    findMany: async ({ where }) => db.tutorGroups.filter((t) => matches(t, where)),
  },
  scheduleLesson: { findMany: async () => [] },
  user: {
    findMany: async ({ where }) => db.users.filter((u) => matches(u, where)),
  },
});

let convSeq = 0;
fakeModule("../../src/config/platformPrisma", {
  conversation: {
    upsert: async ({ where, create }) => {
      const key = where.branchId_classId;
      const existing = db.conversations.find(
        (c) => c.branchId === key.branchId && c.classId === key.classId,
      );
      if (existing) return existing;
      convSeq += 1;
      const row = {
        id: key.classId === CLASS_A ? CONV_A : CONV_B,
        lastSeq: 0,
        closedAt: null,
        ...create,
      };
      db.conversations.push(row);
      return row;
    },
    update: async ({ where, data }) => {
      const row = db.conversations.find((c) => c.id === where.id);
      Object.assign(row, data);
      return row;
    },
  },
  conversationMember: {
    findMany: async ({ where }) => db.members.filter((m) => matches(m, where)),
    create: async ({ data }) => {
      const row = { leftAt: null, ...data };
      db.members.push(row);
      return row;
    },
    update: async ({ where, data }) => {
      const key = where.conversationId_userId;
      const row = db.members.find(
        (m) => m.conversationId === key.conversationId && m.userId === key.userId,
      );
      Object.assign(row, data);
      return row;
    },
  },
  // ⚠️ Soxta `$transaction`: chaqiruvlar massiv qurilganda BAJARILGAN
  // bo'ladi, shuning uchun bu yerda faqat natijalarni kutish kerak.
  $transaction: async (ops) => Promise.all(ops),
});

fakeModule("../../src/config/branchContext", {
  getBranch: () => BRANCH,
  runWithBranch: (branch, fn) => fn(),
});

fakeModule("../../src/realtime/emitter", {
  emitToUsers: (ids, event, payload) => emitted.push({ ids, event, payload }),
  emitToUser: () => {},
});

fakeModule("../../src/services/chat.service", {
  addSystemMessage: async (conversationId, payload) => {
    systemMessages.push({ conversationId, ...payload });
    return null;
  },
});

fakeModule("../../src/utils/logger", {
  info: () => {},
  warn: () => {},
  error: () => {},
});

const classChat = require("../../src/services/classChat.service");

const activeMembers = (convId) =>
  db.members.filter((m) => m.conversationId === convId && !m.leftAt);
const roleOf = (convId, userId) =>
  activeMembers(convId).find((m) => m.userId === userId)?.role ?? null;

test.beforeEach(resetDb);

/* ════════════════════════ KERAKLI HOLAT ════════════════════════ */

test("a'zolar: o'quvchi — member, o'qituvchi/rahbar/tyutor — admin", async () => {
  const desired = await classChat.computeDesiredMembers(CLASS_A);

  assert.equal(desired.get(S1), "member");
  assert.equal(desired.get(S2), "member");
  assert.equal(desired.get(TEACHER), "admin");
  assert.equal(desired.get(LEADER), "admin");
  assert.equal(desired.get(TUTOR), "admin");
  assert.equal(desired.size, 5);
});

test("arxivlangan xodim guruhga QO'SHILMAYDI", async () => {
  const desired = await classChat.computeDesiredMembers(CLASS_A);
  assert.equal(desired.has(ARCHIVED_TEACHER), false);
});

test("muddati tugagan tyutor guruhi hisobga olinmaydi", async () => {
  db.tutorGroups[0].endMonth = currentMonthKey() - 1;
  const desired = await classChat.computeDesiredMembers(CLASS_A);
  assert.equal(desired.has(TUTOR), false);
});

test("darsi yo'q sinfda faqat o'quvchilar bo'lishi NORMAL hol", async () => {
  db.userClasses.push({ userId: S1, classId: CLASS_B });
  const desired = await classChat.computeDesiredMembers(CLASS_B);
  assert.deepEqual([...desired.entries()], [[S1, "member"]]);
});

/* ════════════════════════ SINXRON ════════════════════════ */

test("birinchi sinxron: guruh ochiladi va a'zolar yoziladi", async () => {
  const result = await classChat.syncClassConversation(CLASS_A);

  assert.equal(result.conversationId, CONV_A);
  assert.equal(result.added, 5);
  assert.equal(result.removed, 0);
  assert.equal(db.conversations.length, 1);
  assert.equal(db.conversations[0].title, "5-A");
  assert.equal(db.conversations[0].type, "class");
  assert.equal(activeMembers(CONV_A).length, 5);
  assert.equal(roleOf(CONV_A, TEACHER), "admin");
  assert.equal(roleOf(CONV_A, S1), "member");
});

test("IDEMPOTENT: ikkinchi sinxron hech narsani o'zgartirmaydi", async () => {
  await classChat.syncClassConversation(CLASS_A);
  const snapshot = JSON.stringify(db.members);

  const second = await classChat.syncClassConversation(CLASS_A);

  assert.deepEqual(
    { added: second.added, removed: second.removed, roleChanged: second.roleChanged },
    { added: 0, removed: 0, roleChanged: 0 },
  );
  assert.equal(JSON.stringify(db.members), snapshot);
});

test("o'quvchi boshqa sinfga o'tdi: eskisidan chiqdi, yangisiga kirdi", async () => {
  await classChat.syncClassConversation(CLASS_A);
  await classChat.syncClassConversation(CLASS_B);

  // O'quvchini ko'chiramiz
  db.userClasses = db.userClasses.filter((uc) => !(uc.userId === S1 && uc.classId === CLASS_A));
  db.userClasses.push({ userId: S1, classId: CLASS_B });

  const fromOld = await classChat.syncClassConversation(CLASS_A);
  const toNew = await classChat.syncClassConversation(CLASS_B);

  assert.equal(fromOld.removed, 1);
  assert.equal(toNew.added, 1);
  assert.equal(roleOf(CONV_A, S1), null);
  assert.equal(roleOf(CONV_B, S1), "member");

  // ⚠️ QATOR O'CHIRILMAYDI — `leftAt` qo'yiladi (tarix bitta qatorda)
  const oldRow = db.members.find((m) => m.conversationId === CONV_A && m.userId === S1);
  assert.ok(oldRow.leftAt instanceof Date);
});

test("o'qituvchi jadvaldan olindi — guruhdan chiqadi", async () => {
  await classChat.syncClassConversation(CLASS_A);
  db.schedules[0].lessons = [];

  const result = await classChat.syncClassConversation(CLASS_A);

  assert.equal(result.removed, 1);
  assert.equal(roleOf(CONV_A, TEACHER), null);
});

test("qaytib kelgan a'zo QAYTA QO'SHILADI, yangi qator yozilmaydi", async () => {
  await classChat.syncClassConversation(CLASS_A);
  const before = db.members.length;

  db.schedules[0].lessons = [];
  await classChat.syncClassConversation(CLASS_A);

  db.schedules[0].lessons = [{ teacherId: TEACHER }];
  const back = await classChat.syncClassConversation(CLASS_A);

  assert.equal(back.added, 1);
  assert.equal(db.members.length, before, "yangi qator yozilmadi");
  assert.equal(roleOf(CONV_A, TEACHER), "admin");
});

test("roli o'zgargan a'zo: o'quvchi dars beruvchi bo'lsa admin bo'ladi", async () => {
  await classChat.syncClassConversation(CLASS_A);
  // S1 endi shu sinfda dars beradi (nazariy hol — xodim roliga o'tgan)
  db.users.find((u) => u.id === S1).role = "teacher";
  db.schedules[0].lessons.push({ teacherId: S1 });

  const result = await classChat.syncClassConversation(CLASS_A);

  assert.equal(result.roleChanged, 1);
  assert.equal(roleOf(CONV_A, S1), "admin");
});

test("QO'LDA qo'shilgan a'zoga sinxron TEGMAYDI", async () => {
  await classChat.syncClassConversation(CLASS_A);
  db.members.push({
    conversationId: CONV_A,
    userId: MANUAL,
    role: "member",
    source: "manual",
    leftAt: null,
  });

  const result = await classChat.syncClassConversation(CLASS_A);

  assert.equal(result.removed, 0);
  assert.equal(roleOf(CONV_A, MANUAL), "member");
});

test("sinf nomi o'zgarsa guruh sarlavhasi ham o'zgaradi", async () => {
  await classChat.syncClassConversation(CLASS_A);
  db.classes[0].name = "5-A (yangi)";

  await classChat.syncClassConversation(CLASS_A);

  assert.equal(db.conversations[0].title, "5-A (yangi)");
});

test("sinf nofaol: guruh YOPILADI (o'chirilmaydi), qayta faollashsa ochiladi", async () => {
  await classChat.syncClassConversation(CLASS_A);
  db.classes[0].isActive = false;

  const closed = await classChat.syncClassConversation(CLASS_A);
  assert.equal(closed.closed, true);
  assert.ok(db.conversations[0].closedAt instanceof Date);
  // A'zolar QOLADI — tarixni ochish uchun a'zolik kerak
  assert.equal(activeMembers(CONV_A).length, 5);

  db.classes[0].isActive = true;
  await classChat.syncClassConversation(CLASS_A);
  assert.equal(db.conversations[0].closedAt, null);
});

test("sinf butunlay o'chirilgan bo'lsa ham guruh yopiladi, yiqilmaydi", async () => {
  await classChat.syncClassConversation(CLASS_A);
  db.classes = db.classes.filter((c) => c.id !== CLASS_A);

  const result = await classChat.syncClassConversation(CLASS_A);
  assert.equal(result.closed, true);
});

test("XODIM qo'shilganda tizim xabari yoziladi, o'quvchi qo'shilganda — YO'Q", async () => {
  // Birinchi sinxronda ikkalasi ham bor
  await classChat.syncClassConversation(CLASS_A);
  assert.equal(systemMessages.length, 1, "xodimlar uchun bitta xabar");
  systemMessages.length = 0;

  // Yangi O'QUVCHI — xabar yozilmaydi (sentabrda 30 ta qator bo'lardi)
  db.userClasses.push({ userId: MANUAL, classId: CLASS_A });
  db.users.find((u) => u.id === MANUAL).role = "student";
  await classChat.syncClassConversation(CLASS_A);
  assert.equal(systemMessages.length, 0);
});

test("yangi a'zoga suhbat DARHOL ko'rinadi (socket hodisasi)", async () => {
  await classChat.syncClassConversation(CLASS_A);

  const updates = emitted.filter((e) => e.event === "conversation:updated");
  assert.ok(updates.length > 0);
  assert.ok(updates.some((u) => u.ids.includes(TEACHER)));
});

test("butun filial: hamma sinf sinxronlanadi, bittasining xatosi qolganini to'xtatmaydi", async () => {
  db.userClasses.push({ userId: S1, classId: CLASS_B });
  const result = await classChat.syncAllInBranch();

  assert.equal(result.classes, 2);
  assert.equal(result.failed, 0);
  assert.equal(db.conversations.length, 2);
});
