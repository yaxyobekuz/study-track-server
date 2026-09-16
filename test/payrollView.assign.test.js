const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * OYLIK TUZILMASI — "Xodim qo'shish" nomzodlari va saralash.
 *
 * Himoya qilinadigan narsa: shu bo'limda allaqachon bor xodim tanlagichda
 * qayta chiqmasligi, bir xil lavozimga qayta biriktirish rad etilishi va
 * oxirgi biriktirilgan xodim ro'yxat tepasida turishi.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const DEPT_A = "a".repeat(24);
const DEPT_B = "b".repeat(24);
const POS_A = "1".repeat(24);
const POS_B = "2".repeat(24);

const users = [
  { id: "u1".padEnd(24, "0"), firstName: "Ali", lastName: "", role: "cook", positionId: POS_A, salaryCategoryId: null },
  { id: "u2".padEnd(24, "0"), firstName: "Bobur", lastName: "", role: "guard", positionId: POS_B, salaryCategoryId: null },
  { id: "u3".padEnd(24, "0"), firstName: "Dilnoza", lastName: "", role: "cleaner", positionId: null, salaryCategoryId: null },
  { id: "u4".padEnd(24, "0"), firstName: "Zafar", lastName: "", role: "cook", positionId: POS_A, salaryCategoryId: null },
  { id: "u5".padEnd(24, "0"), firstName: "Olim", lastName: "", role: "teacher", positionId: null, salaryCategoryId: null },
  { id: "u6".padEnd(24, "0"), firstName: "Sardor", lastName: "", role: "student", positionId: null, salaryCategoryId: null },
  // Login o'chirilgan, lekin filialda — nomzod
  { id: "u7".padEnd(24, "0"), firstName: "Gulnora", lastName: "", role: "cleaner", positionId: null, salaryCategoryId: null, isActive: false },
  // Filialdan chiqarilgan (ruxsat qatori yo'q) — nomzod EMAS
  { id: "u8".padEnd(24, "0"), firstName: "Kamol", lastName: "", role: "cook", positionId: null, salaryCategoryId: null, isActive: false },
  // Lavozimsiz, lekin amaldagi StaffSalary qoidasi bor — oyligi bor
  { id: "u9".padEnd(24, "0"), firstName: "Farhod", lastName: "", role: "guard", positionId: null, salaryCategoryId: null },
].map((u) => ({ isActive: true, ...u }));

// Faqat servis ishlatadigan shartlar: isActive, role (satr / notIn), positionId (in)
const matches = (u, where = {}) => {
  if (where.isActive !== undefined && u.isActive !== where.isActive) return false;
  if (typeof where.role === "string" && u.role !== where.role) return false;
  if (where.role?.notIn && where.role.notIn.includes(u.role)) return false;
  if (where.role?.not && u.role === where.role.not) return false;
  if (where.positionId?.in && !where.positionId.in.includes(u.positionId)) return false;
  return true;
};

const at = (iso) => new Date(iso);

const prisma = {
  department: {
    findUnique: async ({ where }) =>
      ({ [DEPT_A]: { id: DEPT_A, name: "Oshxona", kind: "staff" }, [DEPT_B]: { id: DEPT_B, name: "Qo'riqlash", kind: "staff" } })[where.id] ?? null,
  },
  position: {
    findMany: async ({ where } = {}) =>
      [
        { id: POS_A, name: "Oshpaz", departmentId: DEPT_A },
        { id: POS_B, name: "Qorovul", departmentId: DEPT_B },
      ].filter((p) => !where?.departmentId || p.departmentId === where.departmentId),
  },
  salaryCategory: { findMany: async () => [] },
  user: {
    findMany: async ({ where, orderBy, skip, take }) => {
      let rows = users.filter((u) => matches(u, where));
      if (orderBy) rows = [...rows].sort((a, b) => a.firstName.localeCompare(b.firstName));
      return skip != null ? rows.slice(skip, skip + take) : rows;
    },
    count: async ({ where }) => users.filter((u) => matches(u, where)).length,
  },
  // Zafar — eng oxirgi biriktirilgan (audit), Ali — oylik qoidasi o'zgargan
  payrollAudit: {
    groupBy: async () => [
      { targetId: users[0].id, _max: { createdAt: at("2026-09-01T10:00:00Z") } },
      { targetId: users[3].id, _max: { createdAt: at("2026-09-16T10:00:00Z") } },
    ],
  },
  staffSalary: {
    groupBy: async () => [{ staffId: users[0].id, _max: { updatedAt: at("2026-09-10T10:00:00Z") } }],
  },
};

fakeModule("../src/config/prisma", prisma);
fakeModule("../src/config/platformPrisma", {
  userBranchAccess: {
    findMany: async ({ where }) =>
      [{ userId: users[6].id, branchId: "main" }].filter(
        (a) => a.branchId === where.branchId && where.userId.in.includes(a.userId),
      ),
  },
});
fakeModule("../src/config/branchContext", { requireBranch: () => ({ id: "main" }) });
fakeModule("../src/services/staffSalary.service", {
  resolveSalariesForMonth: async () => new Map([[users[8].id, { staffId: users[8].id }]]),
});
fakeModule("../src/services/payrollEngine.service", {
  loadContext: async () => ({}),
  previewForStaff: (u) => ({ amount: u.firstName === "Ali" ? "9000000.00" : "1000000.00" }),
});

const view = require("../src/services/payrollView.service");

test("nomzodlar: shu bo'limdagilar chiqariladi, oyligi belgilanmaganlar tepada", async () => {
  const rows = await view.getAssignCandidates({ query: { departmentId: DEPT_A } });
  const names = rows.map((r) => r.fullName);

  // Ali va Zafar allaqachon Oshxonada — qayta tanlanmaydi.
  // Avval oyligi yo'qlar (ism tartibida), keyin lavozimi/qoidasi borlar.
  assert.deepEqual(names, ["Dilnoza", "Gulnora", "Bobur", "Farhod"]);
  const byName = Object.fromEntries(rows.map((r) => [r.fullName, r]));
  assert.equal(byName.Bobur.currentLabel, "Qorovul");
  assert.equal(byName.Bobur.hasSalary, true);
  assert.equal(byName.Farhod.hasSalary, true);
  assert.equal(byName.Dilnoza.currentLabel, null);
  assert.equal(byName.Dilnoza.hasSalary, false);
  // O'qituvchi va o'quvchi staff bo'limga nomzod emas
  assert.ok(!names.includes("Olim") && !names.includes("Sardor"));
});

test("nomzodlar: login o'chirilgan xodim chiqadi, filialdan chiqarilgani chiqmaydi", async () => {
  const rows = await view.getAssignCandidates({ query: { departmentId: DEPT_A } });
  const byName = Object.fromEntries(rows.map((r) => [r.fullName, r]));

  assert.equal(byName.Gulnora?.loginDisabled, true);
  assert.equal(byName.Dilnoza.loginDisabled, false);
  assert.equal(byName.Kamol, undefined);
});

test("sukut saralash: oxirgi biriktirilgan tepada, qolganlari ism bo'yicha", async () => {
  const res = await view.getStaffPayroll({ query: { departmentId: DEPT_A } });
  assert.deepEqual(res.data.map((r) => r.fullName), ["Zafar", "Ali"]);
});

test("ism va oylik bo'yicha saralash o'zgarmagan", async () => {
  const byName = await view.getStaffPayroll({ query: { departmentId: DEPT_A, sort: "name" } });
  assert.deepEqual(byName.data.map((r) => r.fullName), ["Ali", "Zafar"]);

  const byAmount = await view.getStaffPayroll({ query: { departmentId: DEPT_A, sort: "amount" } });
  assert.deepEqual(byAmount.data.map((r) => r.fullName), ["Ali", "Zafar"]);
});
