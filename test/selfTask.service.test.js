const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * XODIM O'ZIGA O'ZI BELGILAGAN TOPSHIRIQ — uchta farq va ularning har biri
 * "jim buziladigan" qoida.
 *
 *   1. JARIMA YO'Q         — ball 0, to'xtatish va muddat surishda ham
 *                            jarima yozilmaydi (bayroq kelsa ham).
 *   2. IKKINCHI TOMON YO'Q — topshirgani darhol "Yakunlangan"; oddiy
 *                            topshiriq esa avvalgidek "Tekshiruvda".
 *   3. FAQAT O'ZIGA        — ijrochi yaratuvchining O'ZI.
 *
 * Eng nozik joy — DOIRA: odam o'ziga ODDIY topshiriq ham bera oladi
 * (`createdBy === assignee`, lekin `selfAssigned: false`). Shaxsiy doira
 * uni QAMRAMASLIGI shart, aks holda xodim rahbar tasdig'ini chetlab o'tib
 * va jarimasiz o'z topshirig'ini yopib qo'ya olardi.
 *
 * Yana bir invariant: ikki oqim BIR JADVALDA yashaydi, lekin har bir
 * ro'yxat va sanoqchi ANIQ bir tomonni oladi — aralashsa, jarimasiz
 * shaxsiy topshiriqlar Lavozimlar markazining bajarilish foizini jimgina
 * ko'tarib yuborardi.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const id = (ch) => ch.repeat(24);
const STAFF = id("a");
const OTHER = id("b");
const STUDENT = id("c");
const OWNER = id("d");

const users = [
  { id: STAFF, role: "teacher", isArchived: false, firstName: "Ali", lastName: "V" },
  { id: OTHER, role: "teacher", isArchived: false, firstName: "Vali", lastName: "A" },
  { id: STUDENT, role: "student", isArchived: false, firstName: "Olim", lastName: "T" },
  { id: OWNER, role: "owner", isArchived: false, firstName: "Ega", lastName: "S" },
];

const db = { tasks: [], history: [], penalties: [], deadlines: [], userPoints: {} };
const pushes = [];

let seq = 0;

fakeModule("../src/config/prisma", {
  user: {
    findMany: async ({ where }) => users.filter((u) => where.id.in.includes(u.id)),
    findUnique: async ({ where }) => users.find((u) => u.id === where.id) ?? null,
    update: async ({ where, data }) => {
      db.userPoints[where.id] =
        (db.userPoints[where.id] || 0) + (data.penaltyPoints?.increment || 0);
      return { id: where.id };
    },
  },
  task: {
    create: async ({ data }) => {
      const { statusHistory, ...fields } = data;
      const row = { id: `t${(seq += 1)}`, ...fields };
      db.tasks.push(row);
      for (const h of statusHistory?.create
        ? [].concat(statusHistory.create)
        : []) {
        db.history.push({ taskId: row.id, ...h });
      }
      return row;
    },
    findUnique: async ({ where }) => db.tasks.find((t) => t.id === where.id) ?? null,
    update: async ({ where, data }) => {
      const row = db.tasks.find((t) => t.id === where.id);
      const { statusHistory, deadlineHistory, ...fields } = data;
      Object.assign(row, fields);
      if (statusHistory?.create) {
        db.history.push({ taskId: row.id, ...statusHistory.create });
      }
      if (deadlineHistory?.create) {
        db.deadlines.push({ taskId: row.id, ...deadlineHistory.create });
      }
      return row;
    },
    count: async () => 0,
    groupBy: async () => [],
    delete: async ({ where }) => {
      db.tasks = db.tasks.filter((t) => t.id !== where.id);
      return { id: where.id };
    },
  },
  taskStatusHistory: {
    count: async ({ where }) => db.history.filter((h) => h.taskId === where.taskId).length,
  },
  taskDeadlineHistory: {
    count: async ({ where }) => db.deadlines.filter((h) => h.taskId === where.taskId).length,
  },
  penalty: {
    create: async ({ data }) => {
      const row = { id: `p${db.penalties.length + 1}`, ...data };
      db.penalties.push(row);
      return row;
    },
    findUnique: async () => null,
  },
  taskSchedule: { count: async () => 0 },
  $transaction: async (fn) => fn(require("../src/config/prisma")),
});

fakeModule("../src/services/file.service", {
  uploadAttachments: async (files) => (files || []).map((f) => ({ key: f.originalname })),
  deleteAttachments: async () => {},
});

fakeModule("../src/services/settings.service", {
  getTaskSettings: async () => ({
    minTitleLength: 3,
    minDescriptionLength: 5,
    requireCreateAttachments: false,
    minLeadHours: 0,
    defaultPenaltyPoints: 3,
    maxPenaltyPoints: 10,
    minCompletionFiles: 1,
    maxCompletionFiles: 5,
    requireCompletionNote: false,
    minCompletionNoteLength: 0,
    completionFileTypes: ["image", "video", "document"],
    allowLateSubmission: true,
    requireApproveReason: false,
    autoPenaltyEnabled: true,
    dueSoonHours: 24,
  }),
});

fakeModule("../src/services/push.service", {
  sendToUsers: async (ids, payload) => pushes.push({ ids, payload }),
});
fakeModule("../src/services/issueTask.service", {
  onTaskCompleted: async () => {},
  onTaskReopened: async () => {},
});
fakeModule("../src/config/branchContext", { getBranch: () => ({ id: "br" }) });

const taskService = require("../src/services/task.service");
const {
  selfScope,
  resolveSelfViewScope,
  isInScope,
  applyScope,
  SCOPE_ALL,
  SCOPE_TEAM,
  SCOPE_SELF,
  SCOPE_NONE,
} = require("../src/services/taskScope.service");

const tomorrow = () => new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();

const createSelf = (overrides = {}) =>
  taskService.createTasks({
    title: "O'z rejam",
    description: "Hisobotni yozib chiqaman",
    dueDate: tomorrow(),
    assigneeIds: [STAFF],
    createdBy: STAFF,
    selfAssigned: true,
    ...overrides,
  });

// ─── 1. FAQAT O'ZIGA ──────────────────────────────────────────────

test("shaxsiy topshiriq: ijrochi yaratuvchining O'ZI va ball 0", async () => {
  const [task] = await createSelf();

  assert.equal(task.assignee, STAFF);
  assert.equal(task.createdBy, STAFF);
  assert.equal(task.selfAssigned, true);
  // ⚠️ Sozlamadagi standart ball (3) OLINMAYDI
  assert.equal(task.penaltyPoints, 0);
});

test("shaxsiy topshiriqni BOSHQA odamga yozib bo'lmaydi", async () => {
  await assert.rejects(createSelf({ assigneeIds: [OTHER] }), /faqat o'zingizga/i);
  // Bir nechta ijrochi ham rad etiladi
  await assert.rejects(createSelf({ assigneeIds: [STAFF, OTHER] }), /faqat o'zingizga/i);
});

test("o'quvchi o'ziga topshiriq belgilay olmaydi", async () => {
  await assert.rejects(
    createSelf({ assigneeIds: [STUDENT], createdBy: STUDENT }),
    /O'quvchi o'ziga topshiriq belgilay olmaydi/i,
  );
});

test("tizim egasi O'ZIGA belgilay oladi (u beruvchi emas, ijrochining o'zi)", async () => {
  const [task] = await createSelf({ assigneeIds: [OWNER], createdBy: OWNER });
  assert.equal(task.assignee, OWNER);

  // Lekin unga ODDIY yo'ldan topshiriq berib bo'lmaydi — eski qoida joyida
  await assert.rejects(
    taskService.createTasks({
      title: "Oddiy ish",
      description: "Tavsifi bor",
      dueDate: tomorrow(),
      assigneeIds: [OWNER],
      createdBy: STAFF,
    }),
    /Tizim egasiga topshiriq berib bo'lmaydi/i,
  );
});

test("o'ziga yozganiga PUSH yuborilmaydi, oddiy topshiriqda yuboriladi", async () => {
  pushes.length = 0;
  await createSelf();
  assert.equal(pushes.length, 0);

  await taskService.createTasks({
    title: "Oddiy ish",
    description: "Tavsifi bor",
    dueDate: tomorrow(),
    assigneeIds: [OTHER],
    createdBy: STAFF,
  });
  // Push kutilmaydi (fire-and-forget) — mikrotask navbatini bo'shatamiz
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(pushes.length, 1);
});

// ─── 2. IKKINCHI TOMON YO'Q ───────────────────────────────────────

test("shaxsiy topshiriq topshirilganda DARHOL yakunlanadi", async () => {
  const [task] = await createSelf();

  const done = await taskService.submitTaskCompletion(task.id, STAFF, {
    note: "Bajardim",
    files: [{ originalname: "a.png", mimetype: "image/png" }],
    scope: selfScope(STAFF),
  });

  assert.equal(done.status, "completed");
});

test("ODDIY topshiriq avvalgidek Tekshiruvda qoladi", async () => {
  const [task] = await taskService.createTasks({
    title: "Oddiy ish",
    description: "Tavsifi bor",
    dueDate: tomorrow(),
    assigneeIds: [OTHER],
    createdBy: STAFF,
  });

  const done = await taskService.submitTaskCompletion(task.id, OTHER, {
    note: "Bajardim",
    files: [{ originalname: "a.png", mimetype: "image/png" }],
  });

  assert.equal(done.status, "pending_review");
});

test("o'ziga BERILGAN oddiy topshiriqni shaxsiy yo'ldan yopib bo'lmaydi", async () => {
  // ⚠️ ENG NOZIK HOLAT: odam o'ziga oddiy topshiriq berdi
  // (`createdBy === assignee`), ya'ni `selfAssigned: false`. Shaxsiy yo'l
  // uni qamrasa, u rahbar tasdig'ini chetlab o'tib yopib qo'ya olardi.
  const [task] = await taskService.createTasks({
    title: "O'ziga oddiy ish",
    description: "Tavsifi bor",
    dueDate: tomorrow(),
    assigneeIds: [STAFF],
    createdBy: STAFF,
  });

  await assert.rejects(
    taskService.submitTaskCompletion(task.id, STAFF, {
      note: "Bajardim",
      files: [{ originalname: "a.png", mimetype: "image/png" }],
      scope: selfScope(STAFF),
    }),
    /o'zingizga belgilagan topshirig'ingiz emas/i,
  );
});

// ─── 3. JARIMA YO'Q ───────────────────────────────────────────────

test("to'xtatishda jarima bayrog'i kelsa ham jarima yozilmaydi", async () => {
  const [task] = await createSelf();
  const before = db.penalties.length;

  const stopped = await taskService.stopTask(task.id, {
    reason: "Kerak bo'lmay qoldi",
    // Panel yubormaydi, lekin qaror SERVERDA
    withPenalty: true,
    penaltyPoints: 5,
    stoppedBy: STAFF,
    scope: selfScope(STAFF),
  });

  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.penaltyRef ?? null, null);
  assert.equal(db.penalties.length, before);
  assert.equal(db.userPoints[STAFF] ?? 0, 0);
});

test("muddat surishda jarima yozilmaydi va tarix 'jarimasiz' deb yoziladi", async () => {
  const [task] = await createSelf();
  const before = db.penalties.length;

  await taskService.extendDeadline(task.id, {
    newDueDate: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
    reason: "Vaqt kerak",
    withPenalty: true,
    extendedBy: STAFF,
    scope: selfScope(STAFF),
  });

  assert.equal(db.penalties.length, before);
  const row = db.deadlines.filter((d) => d.taskId === task.id).at(-1);
  // ⚠️ `withPenalty` TARIXDA HAM false: aks holda vaqt chizig'i
  // "jarima bilan uzaytirildi" deb yolg'on ko'rsatardi
  assert.equal(row.withPenalty, false);
  assert.equal(row.penaltyPoints, 0);
});

test("ODDIY topshiriqda jarima avvalgidek yoziladi", async () => {
  const [task] = await taskService.createTasks({
    title: "Oddiy ish",
    description: "Tavsifi bor",
    dueDate: tomorrow(),
    assigneeIds: [OTHER],
    createdBy: STAFF,
  });

  const stopped = await taskService.stopTask(task.id, {
    reason: "Bajarilmadi",
    withPenalty: true,
    penaltyPoints: 4,
    stoppedBy: STAFF,
  });

  assert.ok(stopped.penaltyRef);
  assert.equal(db.userPoints[OTHER], 4);
});

// ─── TAHRIR: YOPIQ MAYDONLAR ──────────────────────────────────────

test("shaxsiy topshiriqda ijrochi va jarima bali tahrirlanmaydi", async () => {
  const [task] = await createSelf();
  const scope = selfScope(STAFF);

  await assert.rejects(
    taskService.updateTask(task.id, { assigneeId: OTHER }, STAFF, scope),
    /ijrochisini o'zgartirib bo'lmaydi/i,
  );
  await assert.rejects(
    taskService.updateTask(task.id, { penaltyPoints: 5 }, STAFF, scope),
    /jarima bali bo'lmaydi/i,
  );

  // Sarlavha esa avvalgidek tahrirlanadi
  const updated = await taskService.updateTask(
    task.id,
    { title: "Yangi sarlavha" },
    STAFF,
    scope,
  );
  assert.equal(updated.title, "Yangi sarlavha");
});

test("boshqa odamning shaxsiy topshirig'iga tegib bo'lmaydi", async () => {
  const [task] = await createSelf();

  await assert.rejects(
    taskService.deleteTask(task.id, { deletedBy: OTHER, scope: selfScope(OTHER) }),
    /o'zingizga belgilagan topshirig'ingiz emas/i,
  );
});

// ─── DOIRA ────────────────────────────────────────────────────────

test("shaxsiy doira: o'z shaxsiy qatorini qamraydi, oddiysini QAMRAMAYDI", () => {
  const scope = selfScope(STAFF);

  assert.equal(isInScope({ assignee: STAFF, createdBy: STAFF, selfAssigned: true }, scope, STAFF), true);
  // ⚠️ O'zi yaratgan, o'ziga berilgan, lekin ODDIY topshiriq
  assert.equal(isInScope({ assignee: STAFF, createdBy: STAFF, selfAssigned: false }, scope, STAFF), false);
  // Boshqa odamning shaxsiy qatori
  assert.equal(isInScope({ assignee: OTHER, createdBy: OTHER, selfAssigned: true }, scope, STAFF), false);
});

test("shaxsiy doira filtrga QO'SHILADI, ustiga yozilmaydi", () => {
  const merged = applyScope({ status: "pending" }, selfScope(STAFF));
  assert.deepEqual(merged, {
    AND: [{ status: "pending" }, { assignee: STAFF, selfAssigned: true }],
  });
});

test("boshqaruvchi doirasi: view/owner — butun filial, team — o'z bo'limi, self — butun filial", async () => {
  const base = { id: STAFF, role: "teacher", permissions: [] };

  assert.equal((await resolveSelfViewScope({ ...base, role: "owner" })).mode, SCOPE_ALL);
  assert.equal(
    (await resolveSelfViewScope({ ...base, permissions: ["tasks.view"] })).mode,
    SCOPE_ALL,
  );
  // ⚠️ `tasks.self` kalitining O'ZI butun filialni beradi
  assert.equal(
    (await resolveSelfViewScope({ ...base, permissions: ["tasks.self"] })).mode,
    SCOPE_ALL,
  );
  // Kalitsiz — yopiq (fail closed)
  assert.equal((await resolveSelfViewScope(base)).mode, SCOPE_NONE);
});

test("boshqaruvchi doirasida 'men bergan' shoxi YO'Q — shaxsiy ishni har doim o'zi yozadi", async () => {
  // Bo'limi yo'q rahbar: oddiy doirada `createdBy` shoxi bor edi, shaxsiy
  // kesimda esa u faqat o'zining rejasini qo'shardi — ya'ni ma'nosiz.
  const scope = await resolveSelfViewScope({
    id: STAFF,
    role: "teacher",
    permissions: ["tasks.team"],
  });

  assert.equal(scope.mode, SCOPE_TEAM);
  assert.equal("createdBy" in scope.where, false);
  assert.ok("assignee" in scope.where);
});

test("SCOPE_SELF nomi o'zgarmagan (panel va service bitta qiymatga tayanadi)", () => {
  assert.equal(SCOPE_SELF, "self");
  assert.equal(selfScope(STAFF).mode, SCOPE_SELF);
});
