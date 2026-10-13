const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * KIM KIMGA TOPSHIRIQ BERADI — `tasks.team` doirasi.
 *
 * Eng muhim invariant: `tasks.team` — QO'SHIMCHA daraja, mavjud
 * huquqlarni KUCHSIZLANTIRMAYDI. Shuning uchun qamrov aynan shunga
 * qaratilgan:
 *
 *   · `tasks.view` / owner — butun filial (hech qanday qo'shimcha so'rovsiz);
 *   · `tasks.team` — faqat O'Z BO'LIMI (lavozim → bo'lim) va o'zi bergan ish;
 *   · kalitsiz odam — ro'yxat yopiq, lekin `tasks.review` kabi mavjud
 *     kalitlar avvalgidek butun filialda ishlaydi (cheklov faqat `team` da);
 *   · arxivlangan xodim bo'lim ro'yxatiga kirmaydi.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const id = (ch) => ch.repeat(24);
const HEAD = id("a");
const MEMBER = id("b");
const ARCHIVED = id("c");
const OUTSIDER = id("d");
const POSITION_IT = id("1");
const POSITION_IT2 = id("2");
const POSITION_OTHER = id("3");
const DEPT_IT = id("9");
const DEPT_OTHER = id("8");

const users = [
  { id: HEAD, positionId: POSITION_IT, isArchived: false },
  { id: MEMBER, positionId: POSITION_IT2, isArchived: false },
  { id: ARCHIVED, positionId: POSITION_IT2, isArchived: true },
  { id: OUTSIDER, positionId: POSITION_OTHER, isArchived: false },
];

const positions = [
  { id: POSITION_IT, departmentId: DEPT_IT },
  { id: POSITION_IT2, departmentId: DEPT_IT },
  { id: POSITION_OTHER, departmentId: DEPT_OTHER },
];

let queryCount = 0;

fakeModule("../src/config/prisma", {
  user: {
    findUnique: async ({ where }) => {
      queryCount += 1;
      return users.find((u) => u.id === where.id) ?? null;
    },
    findMany: async ({ where }) => {
      queryCount += 1;
      return users.filter(
        (u) => where.positionId.in.includes(u.positionId) && u.isArchived === where.isArchived,
      );
    },
  },
  position: {
    findUnique: async ({ where }) => {
      queryCount += 1;
      return positions.find((p) => p.id === where.id) ?? null;
    },
    findMany: async ({ where }) => {
      queryCount += 1;
      return positions.filter((p) => p.departmentId === where.departmentId);
    },
  },
});

const {
  resolveTaskScope,
  applyScope,
  isInScope,
  assertCanAssign,
  SCOPE_ALL,
  SCOPE_TEAM,
  SCOPE_NONE,
} = require("../src/services/taskScope.service");

const user = (overrides) => ({ id: HEAD, role: "staff", permissions: [], ...overrides });

// ─── Doira ────────────────────────────────────────────────────────

test("owner va `tasks.view` — butun filial, qo'shimcha so'rovsiz", async () => {
  queryCount = 0;
  const owner = await resolveTaskScope(user({ role: "owner" }));
  const viewer = await resolveTaskScope(user({ permissions: ["tasks.view"] }));

  assert.equal(owner.mode, SCOPE_ALL);
  assert.equal(viewer.mode, SCOPE_ALL);
  // Doira "all" bo'lsa bazaga umuman borilmaydi
  assert.equal(queryCount, 0);
  // Filtr o'zgarmaydi
  assert.deepEqual(applyScope({ status: "pending" }, owner), { status: "pending" });
});

test("`tasks.team` — o'z bo'limi a'zolari, arxivlangani CHIQARIB", async () => {
  const scope = await resolveTaskScope(user({ permissions: ["tasks.team"] }));

  assert.equal(scope.mode, SCOPE_TEAM);
  assert.equal(scope.departmentId, DEPT_IT);
  assert.deepEqual(scope.memberIds.sort(), [HEAD, MEMBER].sort());
  assert.ok(!scope.memberIds.includes(ARCHIVED));
  assert.ok(!scope.memberIds.includes(OUTSIDER));
});

test("kalitsiz odam — ro'yxat yopiq", async () => {
  const scope = await resolveTaskScope(user({ permissions: ["tasks.review"] }));
  assert.equal(scope.mode, SCOPE_NONE);
  assert.throws(() => applyScope({}, scope), /ruxsat yo'q/);
});

test("doira filtrni USTIGA YOZMAYDI, AND bilan birlashtiradi", async () => {
  const scope = await resolveTaskScope(user({ permissions: ["tasks.team"] }));
  const where = applyScope({ status: "completed" }, scope);

  assert.ok(Array.isArray(where.AND));
  assert.deepEqual(where.AND[0], { status: "completed" });
  assert.ok(where.AND[1].OR);
});

// ─── Biriktirish ──────────────────────────────────────────────────

test("rahbar faqat o'z bo'limiga topshiriq beradi", async () => {
  const scope = await resolveTaskScope(user({ permissions: ["tasks.team"] }));

  assert.doesNotThrow(() => assertCanAssign([MEMBER, HEAD], scope));
  assert.throws(() => assertCanAssign([MEMBER, OUTSIDER], scope), /bo'limingizdagi/);
});

test("`tasks.team` MAVJUD HUQUQLARNI KUCHSIZLANTIRMAYDI", async () => {
  // `tasks.create` egasida bo'lim bo'lmasligi ham mumkin — u avvalgidek
  // istalgan xodimga topshiriq beradi
  const scope = await resolveTaskScope(user({ permissions: ["tasks.create"] }));
  assert.equal(scope.mode, SCOPE_NONE);
  assert.doesNotThrow(() => assertCanAssign([OUTSIDER], scope));
});

test("lavozimi yo'q rahbar o'zi bergan ishini ko'radi", async () => {
  const noPosition = { id: id("e"), role: "staff", permissions: ["tasks.team"] };
  const scope = await resolveTaskScope(noPosition);

  assert.equal(scope.mode, SCOPE_TEAM);
  assert.deepEqual(scope.memberIds, []);
  assert.deepEqual(scope.where.OR, [{ createdBy: noPosition.id }]);
  // Boshqa birovga topshiriq bera olmaydi
  assert.throws(() => assertCanAssign([MEMBER], scope), /bo'limingizdagi/);
});

// ─── Bitta topshiriq ──────────────────────────────────────────────

test("o'zi bergan topshiriq doirada, begonasi yo'q", async () => {
  const scope = await resolveTaskScope(user({ permissions: ["tasks.team"] }));

  assert.ok(isInScope({ assignee: MEMBER, createdBy: OUTSIDER }, scope, HEAD));
  assert.ok(isInScope({ assignee: OUTSIDER, createdBy: HEAD }, scope, HEAD));
  assert.ok(!isInScope({ assignee: OUTSIDER, createdBy: OUTSIDER }, scope, HEAD));
});
