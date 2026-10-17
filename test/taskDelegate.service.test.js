const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * TOPSHIRIQNI BIRIKTIRISH — "Topshiriqlarim" ekranining o'zidan.
 *
 * Nima uchun bu yo'l bor: topshiriq olgan rahbar uni o'z xodimiga
 * biriktirmoqchi bo'lsa, ilgari "Topshiriq berish" oynasiga kirib
 * sarlavha, tavsif, tur, havolalar va jarima balini QAYTA YOZIB CHIQISHI
 * kerak edi — ya'ni bir xil matn ikki marta qo'lda kiritilardi.
 *
 * Qamrov aynan "jim buziladigan" qoidalarga qaratilgan:
 *
 *   1. MANBA O'Z EGASIDA QOLADI — yangi topshiriq YARATILADI, ijrochi
 *      ko'chirilmaydi. Aks holda topshiriqning tarixi, jarimasi va
 *      bajarilish foizi birdan boshqa odamga o'tib ketardi.
 *   2. MATN MANBADAN KELADI — sarlavha, tur, havolalar va jarima bali.
 *      Qayta yozish shart emas, lekin ustiga yozish mumkin.
 *   3. FAYL QAYTA YUKLANMAYDI — havolasi (`key`) ko'chadi, ya'ni bitta
 *      fayl saqlashda ikki marta yotmaydi.
 *   4. MUDDAT MAJBURIY va KO'CHIRILMAYDI — manbaning muddati o'tgan
 *      bo'lishi mumkin, `createTasks` esa kelajakni talab qiladi.
 *   5. ORALIQ (`startDate`) KO'CHIRILMAYDI — ko'chirilsa yangi topshiriq
 *      ochilishi bilanoq "vaqti o'tgan" bo'lib ko'rinardi.
 *   6. MANBA VAQT CHIZIG'IGA IZ QOLADI — "kimga biriktirdim" degan savolga
 *      javob manbada turishi kerak.
 *   7. SHAXSIY TOPSHIRIQ va YOPILGAN TOPSHIRIQ biriktirilmaydi.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const id = (ch) => ch.repeat(24);
const BOSS = id("a"); // topshiriqni olgan va biriktiruvchi
const WORKER = id("b"); // kimga biriktiriladi
const WORKER2 = id("c");
const OWNER = id("d");
const ARCHIVED = id("e");

const users = [
  { id: BOSS, role: "staff", isArchived: false, firstName: "Jasur", lastName: "S" },
  { id: WORKER, role: "teacher", isArchived: false, firstName: "Ali", lastName: "V" },
  { id: WORKER2, role: "teacher", isArchived: false, firstName: "Vali", lastName: "A" },
  { id: OWNER, role: "owner", isArchived: false, firstName: "Ega", lastName: "S" },
  { id: ARCHIVED, role: "teacher", isArchived: true, firstName: "Ketgan", lastName: "X" },
];

const db = { tasks: [], history: [] };
const deleted = [];
const uploaded = [];
const pushes = [];
let seq = 0;

fakeModule("../src/config/prisma", {
  user: {
    findMany: async ({ where }) => users.filter((u) => where.id.in.includes(u.id)),
    findUnique: async ({ where }) => users.find((u) => u.id === where.id) ?? null,
    update: async ({ where }) => ({ id: where.id }),
  },
  task: {
    create: async ({ data }) => {
      const { statusHistory, ...fields } = data;
      const row = { id: `t${(seq += 1)}`, ...fields };
      db.tasks.push(row);
      for (const h of statusHistory?.create ? [].concat(statusHistory.create) : []) {
        db.history.push({ taskId: row.id, ...h });
      }
      return row;
    },
    findUnique: async ({ where }) => db.tasks.find((t) => t.id === where.id) ?? null,
    update: async ({ where, data }) => {
      const row = db.tasks.find((t) => t.id === where.id);
      Object.assign(row, data);
      return row;
    },
    count: async () => 0,
    groupBy: async () => [],
  },
  taskStatusHistory: {
    create: async ({ data }) => {
      db.history.push(data);
      return data;
    },
    count: async ({ where }) => db.history.filter((h) => h.taskId === where.taskId).length,
  },
  taskDeadlineHistory: { count: async () => 0 },
  penalty: { create: async (args) => ({ id: "p1", ...args.data }), findUnique: async () => null },
  taskSchedule: { count: async () => 0 },
  $transaction: async (fn) => fn(require("../src/config/prisma")),
});

fakeModule("../src/services/file.service", {
  uploadAttachments: async (files) => {
    const rows = (files || []).map((f) => ({
      key: `new/${f.originalname}`,
      url: `https://cdn/new/${f.originalname}`,
    }));
    uploaded.push(...rows);
    return rows;
  },
  deleteAttachments: async (list) => deleted.push(...(list || [])),
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
const { SCOPE_ALL, SCOPE_TEAM, SCOPE_NONE } = require("../src/services/taskScope.service");

const ALL = { mode: SCOPE_ALL, memberIds: [], departmentId: null, where: null };
const tomorrow = () => new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();
const nextWeek = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

/** Rahbarga berilgan MANBA topshiriq — fayli va havolasi bilan. */
const seedSource = (overrides = {}) => {
  const row = {
    id: `src${(seq += 1)}`,
    title: "Oylik hisobotni tayyorlash",
    description: "Sentabr oyi bo'yicha to'liq hisobot kerak",
    assignee: BOSS,
    createdBy: OWNER,
    status: "pending",
    kind: "extra",
    startDate: new Date(Date.now() - 2 * 60 * 60 * 1000),
    dueDate: new Date(Date.now() + 12 * 60 * 60 * 1000),
    penaltyPoints: 7,
    links: [{ url: "https://example.com/shablon", label: "Shablon" }],
    attachments: [{ key: "src/namuna.pdf", url: "https://cdn/src/namuna.pdf" }],
    completionAttachments: [],
    selfAssigned: false,
    penaltyRef: null,
    ...overrides,
  };
  db.tasks.push(row);
  return row;
};

test.beforeEach(() => {
  db.tasks = [];
  db.history = [];
  deleted.length = 0;
  uploaded.length = 0;
  pushes.length = 0;
});

// ─── 1. MANBA O'Z EGASIDA QOLADI ──────────────────────────────────

test("yangi topshiriq YARATILADI, manbaning ijrochisi O'ZGARMAYDI", async () => {
  const source = seedSource();

  const created = await taskService.delegateTask(
    source.id,
    { assigneeIds: [WORKER], dueDate: tomorrow() },
    BOSS,
    ALL,
  );

  assert.equal(created.length, 1);
  assert.equal(created[0].assignee, WORKER);
  assert.equal(created[0].createdBy, BOSS, "biriktirgan odam — yangi topshiriqning beruvchisi");

  // ⚠️ MANBA TEGILMAYDI: ijrochi ham, holat ham o'sha
  const after = db.tasks.find((t) => t.id === source.id);
  assert.equal(after.assignee, BOSS);
  assert.equal(after.status, "pending");
  assert.notEqual(created[0].id, source.id);
});

test("bir nechta xodimga biriktirilsa HAR BIRIGA ALOHIDA topshiriq", async () => {
  const source = seedSource();

  const created = await taskService.delegateTask(
    source.id,
    { assigneeIds: [WORKER, WORKER2], dueDate: tomorrow() },
    BOSS,
    ALL,
  );

  assert.equal(created.length, 2);
  assert.deepEqual(
    created.map((t) => t.assignee).sort(),
    [WORKER, WORKER2].sort(),
  );
});

// ─── 2. MATN MANBADAN KELADI ──────────────────────────────────────

test("sarlavha, tavsif, tur, havolalar va jarima bali MANBADAN ko'chadi", async () => {
  const source = seedSource();

  const [task] = await taskService.delegateTask(
    source.id,
    { assigneeIds: [WORKER], dueDate: tomorrow() },
    BOSS,
    ALL,
  );

  assert.equal(task.title, source.title);
  assert.equal(task.description, source.description);
  assert.equal(task.kind, "extra");
  assert.deepEqual(task.links, source.links);
  // ⚠️ Sozlamadagi standart ball (3) EMAS, manbaning bali (7)
  assert.equal(task.penaltyPoints, 7);
});

test("ustiga yozish mumkin — sarlavha, tavsif va ball", async () => {
  const source = seedSource();

  const [task] = await taskService.delegateTask(
    source.id,
    {
      assigneeIds: [WORKER],
      dueDate: tomorrow(),
      title: "Hisobotning moliya qismi",
      description: "Faqat moliya jadvallarini to'ldir",
      penaltyPoints: 2,
      kind: "main",
    },
    BOSS,
    ALL,
  );

  assert.equal(task.title, "Hisobotning moliya qismi");
  assert.equal(task.description, "Faqat moliya jadvallarini to'ldir");
  assert.equal(task.penaltyPoints, 2);
  assert.equal(task.kind, "main");
});

test("ko'rsatma tavsif OXIRIGA qo'shiladi — manba matni YO'QOLMAYDI", async () => {
  const source = seedSource();

  const [task] = await taskService.delegateTask(
    source.id,
    { assigneeIds: [WORKER], dueDate: tomorrow(), note: "Juma kuniga tayyor bo'lsin" },
    BOSS,
    ALL,
  );

  assert.ok(task.description.startsWith(source.description), "manba matni boshida turadi");
  assert.ok(task.description.includes("Juma kuniga tayyor bo'lsin"));
});

// ─── 3. FAYL QAYTA YUKLANMAYDI ────────────────────────────────────

test("manbaning fayli AYNAN O'SHA kalit bilan ko'chadi, qayta yuklanmaydi", async () => {
  const source = seedSource();

  const [task] = await taskService.delegateTask(
    source.id,
    { assigneeIds: [WORKER], dueDate: tomorrow() },
    BOSS,
    ALL,
  );

  assert.deepEqual(task.attachments, source.attachments);
  assert.equal(uploaded.length, 0, "saqlashga hech narsa yuklanmaydi");
  assert.equal(deleted.length, 0, "manbaning fayli O'CHIRILMAYDI");
});

test("buzuq fayl obyekti (key/url siz) TASHLANADI", async () => {
  const source = seedSource({
    attachments: [
      { key: "ok.pdf", url: "https://cdn/ok.pdf" },
      { key: "yo'q" }, // url yo'q
      null,
    ],
  });

  const [task] = await taskService.delegateTask(
    source.id,
    { assigneeIds: [WORKER], dueDate: tomorrow() },
    BOSS,
    ALL,
  );

  assert.equal(task.attachments.length, 1);
  assert.equal(task.attachments[0].key, "ok.pdf");
});

// ─── 4-5. MUDDAT VA ORALIQ ────────────────────────────────────────

test("muddat MANBADAN ko'chirilmaydi — berilgani olinadi", async () => {
  const source = seedSource();
  const due = nextWeek();

  const [task] = await taskService.delegateTask(
    source.id,
    { assigneeIds: [WORKER], dueDate: due },
    BOSS,
    ALL,
  );

  assert.equal(new Date(task.dueDate).toISOString(), new Date(due).toISOString());
  assert.notEqual(
    new Date(task.dueDate).getTime(),
    new Date(source.dueDate).getTime(),
  );
});

test("O'TGAN muddatli manba ham biriktiriladi (yangi muddat bilan)", async () => {
  // ⚠️ Manba muddati O'TGAN: ko'chirilsa `createTasks` "muddat kelajakda
  // bo'lsin" xatosi bilan yiqilardi — aynan shu sabab muddat majburiy.
  const source = seedSource({ dueDate: new Date(Date.now() - 48 * 60 * 60 * 1000) });

  const [task] = await taskService.delegateTask(
    source.id,
    { assigneeIds: [WORKER], dueDate: tomorrow() },
    BOSS,
    ALL,
  );

  assert.ok(new Date(task.dueDate).getTime() > Date.now());
});

test("ORALIQ (`startDate`) KO'CHIRILMAYDI", async () => {
  const source = seedSource();
  assert.ok(source.startDate, "manbada oraliq bor");

  const [task] = await taskService.delegateTask(
    source.id,
    { assigneeIds: [WORKER], dueDate: tomorrow() },
    BOSS,
    ALL,
  );

  assert.equal(task.startDate, null);
});

// ─── 6. MANBADA IZ QOLADI ─────────────────────────────────────────

test("manba vaqt chizig'iga 'kimga biriktirildi' yoziladi", async () => {
  const source = seedSource();

  await taskService.delegateTask(
    source.id,
    { assigneeIds: [WORKER, WORKER2], dueDate: tomorrow() },
    BOSS,
    ALL,
  );

  const entry = db.history.find((h) => h.taskId === source.id);
  assert.ok(entry, "manbada yozuv bor");
  assert.equal(entry.kind, "edit");
  assert.equal(entry.changedBy, BOSS);
  assert.ok(entry.reason.includes("Ali V"), "ijrochining ismi yozuvda");
  assert.ok(entry.reason.includes("Vali A"));
  // Manbaning holati O'ZGARMAYDI — yozuv faqat iz
  assert.equal(entry.status, "pending");

  // ⚠️ `meta` BO'LMASLIGI SHART: panelning vaqt chizig'i `kind === "edit"`
  // va `meta` bor bo'lsa "oldin → keyin" juftligini chizadi va `reason` ni
  // UMUMAN ko'rsatmaydi. Bu yerda "oldin" degan qiymat yo'q (ijrochi
  // almashmagan), shuning uchun `meta` yuborilsa ekranda ismlar o'rniga
  // mazmunsiz "o'zgartirildi" turib qolardi.
  assert.ok(!entry.meta, "meta yuborilmaydi — ismlar `reason` dan o'qiladi");
});

test("yangi ijrochiga push ketadi", async () => {
  const source = seedSource();

  await taskService.delegateTask(
    source.id,
    { assigneeIds: [WORKER], dueDate: tomorrow() },
    BOSS,
    ALL,
  );

  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].ids, [WORKER]);
});

// ─── 7. RAD ETILADIGAN HOLATLAR ───────────────────────────────────

test("SHAXSIY topshiriq biriktirilmaydi", async () => {
  const source = seedSource({ selfAssigned: true, penaltyPoints: 0, createdBy: BOSS });

  await assert.rejects(
    () =>
      taskService.delegateTask(
        source.id,
        { assigneeIds: [WORKER], dueDate: tomorrow() },
        BOSS,
        ALL,
      ),
    /belgilagan topshiriqni/,
  );
});

test("YAKUNLANGAN va TO'XTATILGAN topshiriq biriktirilmaydi", async () => {
  const done = seedSource({ status: "completed" });
  const stopped = seedSource({ status: "stopped" });

  await assert.rejects(
    () => taskService.delegateTask(done.id, { assigneeIds: [WORKER], dueDate: tomorrow() }, BOSS, ALL),
    /Yakunlangan/,
  );
  await assert.rejects(
    () =>
      taskService.delegateTask(stopped.id, { assigneeIds: [WORKER], dueDate: tomorrow() }, BOSS, ALL),
    /to'xtatilgan|To'xtatilgan/i,
  );
});

test("O'SHA ijrochiga qayta biriktirib bo'lmaydi", async () => {
  const source = seedSource();

  await assert.rejects(
    () => taskService.delegateTask(source.id, { assigneeIds: [BOSS], dueDate: tomorrow() }, BOSS, ALL),
    /allaqachon shu ijrochida/,
  );
});

test("ARXIVLANGAN xodimga biriktirilmaydi", async () => {
  const source = seedSource();

  await assert.rejects(
    () =>
      taskService.delegateTask(source.id, { assigneeIds: [ARCHIVED], dueDate: tomorrow() }, BOSS, ALL),
    /Arxivlangan/,
  );
});

test("ijrochi tanlanmasa rad etiladi", async () => {
  const source = seedSource();

  await assert.rejects(
    () => taskService.delegateTask(source.id, { assigneeIds: [], dueDate: tomorrow() }, BOSS, ALL),
    /Kamida bitta ijrochi/,
  );
});

test("mavjud bo'lmagan topshiriq — 404", async () => {
  await assert.rejects(
    () => taskService.delegateTask(id("f"), { assigneeIds: [WORKER], dueDate: tomorrow() }, BOSS, ALL),
    /topilmadi/,
  );
});

// ─── DOIRA ────────────────────────────────────────────────────────

/**
 * ⚠️ ENG MUHIM TEKSHIRUV. Biriktirish yo'li ruxsat kaliti talab qilmaydi
 * (huquq egalikdan keladi), shuning uchun doirasiz xodim ham service'ga
 * yetib boradi. Yaratish yo'lining tekshiruvi (`assertCanAssign`) `none`
 * ni ERKIN o'tkazadi — qayta ishlatilsa, oddiy xodim o'ziga berilgan ishni
 * BUTUN FILIALGA biriktira olardi.
 */
test("doirasi yo'q xodim BIRIKTIRA OLMAYDI", async () => {
  const source = seedSource();
  const none = { mode: SCOPE_NONE, memberIds: [], departmentId: null, where: null };

  await assert.rejects(
    () =>
      taskService.delegateTask(source.id, { assigneeIds: [WORKER], dueDate: tomorrow() }, BOSS, none),
    /ruxsatingiz yo'q/,
  );
  assert.equal(db.tasks.length, 1, "yangi topshiriq YARATILMADI");
});

test("rahbar faqat O'Z BO'LIMIGA biriktiradi", async () => {
  const source = seedSource();
  const team = {
    mode: SCOPE_TEAM,
    memberIds: [BOSS, WORKER],
    departmentId: id("9"),
    where: null,
  };

  const [task] = await taskService.delegateTask(
    source.id,
    { assigneeIds: [WORKER], dueDate: tomorrow() },
    BOSS,
    team,
  );
  assert.equal(task.assignee, WORKER);

  // WORKER2 bo'limda yo'q
  await assert.rejects(
    () =>
      taskService.delegateTask(source.id, { assigneeIds: [WORKER2], dueDate: tomorrow() }, BOSS, team),
    /bo'limingizdagi/,
  );
});

test("BEGONA topshiriqni biriktirib bo'lmaydi", async () => {
  // Ijrochi WORKER2, biriktirmoqchi bo'lgan odam BOSS va uning doirasi
  // o'z bo'limi — WORKER2 unda yo'q
  const source = seedSource({ assignee: WORKER2, createdBy: OWNER });
  const team = {
    mode: SCOPE_TEAM,
    memberIds: [BOSS, WORKER],
    departmentId: id("9"),
    where: null,
  };

  await assert.rejects(
    () =>
      taskService.delegateTask(source.id, { assigneeIds: [WORKER], dueDate: tomorrow() }, BOSS, team),
    /bo'limingizga tegishli emas/,
  );
  assert.equal(db.tasks.length, 1, "yangi topshiriq YARATILMADI");
});
