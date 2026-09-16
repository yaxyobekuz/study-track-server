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
];

// Faqat servis ishlatadigan shartlar: role (satr / notIn), positionId (in)
const matches = (u, where = {}) => {
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
fakeModule("../src/services/payrollEngine.service", {
  loadContext: async () => ({}),
  previewForStaff: (u) => ({ amount: u.firstName === "Ali" ? "9000000.00" : "1000000.00" }),
});

const view = require("../src/services/payrollView.service");

test("nomzodlar: shu bo'limdagilar chiqariladi, boshqa bo'limdagi hozirgi lavozimi bilan qoladi", async () => {
  const rows = await view.getAssignCandidates({ query: { departmentId: DEPT_A } });
  const names = rows.map((r) => r.fullName);

  // Ali va Zafar allaqachon Oshxonada — qayta tanlanmaydi
  assert.deepEqual(names, ["Bobur", "Dilnoza"]);
  assert.equal(rows[0].currentLabel, "Qorovul");
  assert.equal(rows[1].currentLabel, null);
  // O'qituvchi va o'quvchi staff bo'limga nomzod emas
  assert.ok(!names.includes("Olim") && !names.includes("Sardor"));
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
