const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * FILIALLARARO KO'CHIRISH — MOLIYAVIY HOLAT REJASI.
 *
 * Himoya qilinadigan narsa:
 *   · OCHIQ oy (qarz) ko'chadi, TO'LANGAN oy va uning cheki manbada qoladi
 *     — to'langan pul shu kassaga tushgan va allaqachon sarflangan;
 *   · chegaradan boshlangan oy bekor qilinadi (maqsad filial o'zi yozadi);
 *   · depozit = joriy qoldiq + bekor qilinadigan oylardan qaytadigan pul;
 *   · KASSADAN chiqadigan pul chekka bog'langandan OSHMAYDI (qo'lda
 *     to'g'rilash puli kassada yo'q — `finance.md` §6 byudjet qoidasi);
 *   · maqsadda o'sha oy allaqachon hisoblangan bo'lsa qarz KO'CHMAYDI
 *     (ikki marta yozilsa qarz ikki barobar bo'lardi), bekor qilingan
 *     qator esa O'SHA JOYIDA tiklanadi;
 *   · maqsadda faol to'lov turi bo'lmasa — to'siq (pul yo'qolmasin).
 *
 * Bazaga ulanish yo'q: `db` — SQL matniga qarab javob beradigan soxta.
 */

const { planStudentFinance } = require("../src/services/branchTransferFinance.service");

const SRC = "public";
const TGT = "br_b";
const STUDENT = "s".repeat(24);

const ctx = {
  source: { id: "a".repeat(24), name: "Chilonzor", schemaName: SRC },
  target: { id: "b".repeat(24), name: "Yunusobod", schemaName: TGT },
  actor: { id: "u".repeat(24), name: "Admin" },
};

/** Faqat kerakli so'rovlarga javob beradigan soxta client. */
const fakeDb = (data) => ({
  $queryRawUnsafe: async (sql) => {
    if (sql.includes(`"${SRC}"."monthly_invoices"`)) return data.invoices ?? [];
    if (sql.includes(`"${TGT}"."monthly_invoices"`)) return data.targetInvoices ?? [];
    if (sql.includes(`"${SRC}"."student_accounts"`)) return data.accounts ?? [];
    // ⚠️ `payment_allocations` BIRINCHI: taqsimot so'rovi `payments` ga
    // JOIN qiladi, shuning uchun teskari tartibda u chek so'rovi bilan
    // adashib ketardi
    if (sql.includes(`"${SRC}"."payment_allocations"`)) return data.allocations ?? [];
    if (sql.includes(`"${SRC}"."payments"`)) return data.receipts ?? [];
    if (sql.includes(`"${TGT}"."payment_accounts"`)) return data.targetAccounts ?? [];
    if (sql.includes(`"${SRC}"."payment_accounts"`)) return data.sourceAccounts ?? [];
    throw new Error(`Kutilmagan so'rov: ${sql.slice(0, 80)}`);
  },
});

const invoice = (id, month, status, amount, paidAmount = "0.00") => ({
  id,
  studentId: STUDENT,
  month,
  status,
  amount,
  paidAmount,
});

const ACCOUNTS = {
  targetAccounts: [
    { id: "t1", name: "Naqd", isActive: true, isArchived: false, sortOrder: 0 },
    { id: "t2", name: "Uzcard", isActive: true, isArchived: false, sortOrder: 1 },
  ],
  sourceAccounts: [
    { id: "s1", name: "Naqd" },
    { id: "s2", name: "Uzcard" },
  ],
};

const plan = async (data, boundary = 202611) => {
  const db = fakeDb({ ...ACCOUNTS, ...data });
  const map = await planStudentFinance(db, ctx, [STUDENT], new Map([[STUDENT, boundary]]));
  return map.get(STUDENT);
};

test("ochiq oy ko'chadi, to'langan oy manbada qoladi", async () => {
  const result = await plan({
    invoices: [
      invoice("i1", 202609, "paid", "600000.00", "600000.00"),
      invoice("i2", 202610, "unpaid", "600000.00"),
    ],
    accounts: [{ studentId: STUDENT, balance: "0.00" }],
  });

  assert.deepEqual(result.debtMonths, [202610]);
  assert.deepEqual(result.settledMonths, [202609]);
  assert.equal(result.debtTotalAmount, "600000.00");
  // To'langan oy bekor QILINMAYDI — pul manba kassasida qoladi
  assert.deepEqual(result.cancelInvoiceIds, ["i2"]);
});

test("chegaradan boshlangan oy bekor qilinadi, maqsad filial o'zi yozadi", async () => {
  const result = await plan({
    invoices: [invoice("i3", 202611, "unpaid", "600000.00")],
    accounts: [{ studentId: STUDENT, balance: "0.00" }],
  });

  assert.deepEqual(result.vacatingMonths, [202611]);
  // Chegaradagi oy QARZ sifatida ko'chmaydi — u maqsadda qaytadan chiqadi
  assert.deepEqual(result.debtMonths, []);
  assert.deepEqual(result.cancelInvoiceIds, ["i3"]);
});

test("qisman to'langan oy: puli depozitga qaytadi va oy TO'LIQ summa bilan ko'chadi", async () => {
  const result = await plan({
    invoices: [invoice("i4", 202610, "partial", "600000.00", "200000.00")],
    accounts: [{ studentId: STUDENT, balance: "0.00" }],
    receipts: [{ studentId: STUDENT, accountId: "s1", amount: "0.00" }],
    allocations: [
      { studentId: STUDENT, invoiceId: "i4", accountId: "s1", amount: "200000.00" },
    ],
  });

  assert.deepEqual(result.debtMonths, [202610]);
  // Maqsadda oy to'liq summada ochiladi, to'langan 200 000 esa PUL bo'lib
  // ketadi va u yerda darhol o'sha oyga yechiladi
  assert.equal(result.debtTotalAmount, "600000.00");
  assert.equal(result.deposit, "200000.00");
  assert.equal(result.cashTotal, "200000.00");
  assert.deepEqual(result.cashLines, [
    { sourceAccountId: "s1", targetAccountId: "t1", amount: "200000.00" },
  ]);
});

test("qo'lda to'g'rilash puli KASSADAN chiqmaydi — faqat balans bilan ko'chadi", async () => {
  const result = await plan({
    invoices: [],
    // 500 000 balans, lekin chekda faqat 200 000 qoldiq bor
    accounts: [{ studentId: STUDENT, balance: "500000.00" }],
    receipts: [{ studentId: STUDENT, accountId: "s1", amount: "200000.00" }],
  });

  assert.equal(result.deposit, "500000.00");
  assert.equal(result.cashTotal, "200000.00");
  assert.equal(result.nonCashTotal, "300000.00");
});

test("depozit hisoblar bo'yicha taqsimlanadi va nom bo'yicha moslanadi", async () => {
  const result = await plan({
    invoices: [],
    accounts: [{ studentId: STUDENT, balance: "900000.00" }],
    receipts: [
      { studentId: STUDENT, accountId: "s2", amount: "400000.00" },
      { studentId: STUDENT, accountId: "s1", amount: "500000.00" },
    ],
  });

  // `id` o'sish tartibida — deadlock tartibi va xesh barqarorligi uchun
  assert.deepEqual(result.cashLines, [
    { sourceAccountId: "s1", targetAccountId: "t1", amount: "500000.00" },
    { sourceAccountId: "s2", targetAccountId: "t2", amount: "400000.00" },
  ]);
  assert.equal(result.nonCashTotal, "0.00");
});

test("maqsadda shu oy allaqachon hisoblangan bo'lsa qarz ko'chmaydi", async () => {
  const result = await plan({
    invoices: [invoice("i5", 202610, "unpaid", "600000.00")],
    targetInvoices: [
      { id: "x1", studentId: STUDENT, month: 202610, status: "unpaid", paidAmount: "0.00" },
    ],
    accounts: [{ studentId: STUDENT, balance: "0.00" }],
  });

  assert.deepEqual(result.debtMonths, []);
  assert.deepEqual(result.blockedMonths, [202610]);
  // Ko'chmagan oy manbada ham bekor QILINMAYDI — aks holda qarz izsiz yo'qolardi
  assert.deepEqual(result.cancelInvoiceIds, []);
});

test("maqsaddagi bekor qilingan oy O'SHA JOYIDA tiklanadi", async () => {
  const result = await plan({
    invoices: [invoice("i6", 202610, "unpaid", "600000.00")],
    targetInvoices: [
      { id: "x2", studentId: STUDENT, month: 202610, status: "cancelled", paidAmount: "0.00" },
    ],
    accounts: [{ studentId: STUDENT, balance: "0.00" }],
  });

  assert.deepEqual(result.debtPairs, [["i6", "x2"]]);
  assert.deepEqual(result.blockedMonths, []);
});

test("maqsadda faol to'lov turi bo'lmasa — depozitni o'tkazib bo'lmaydi", async () => {
  const db = fakeDb({
    invoices: [],
    accounts: [{ studentId: STUDENT, balance: "100000.00" }],
    receipts: [{ studentId: STUDENT, accountId: "s1", amount: "100000.00" }],
    sourceAccounts: ACCOUNTS.sourceAccounts,
    targetAccounts: [{ id: "t9", name: "Naqd", isActive: false, isArchived: true, sortOrder: 0 }],
  });
  const map = await planStudentFinance(db, ctx, [STUDENT], new Map([[STUDENT, 202611]]));
  const result = map.get(STUDENT);

  assert.equal(result.missingTargetAccount, true);
  assert.equal(result.cashLines[0].targetAccountId, null);
});

test("pul yo'q bo'lsa kassaga umuman tegilmaydi", async () => {
  const result = await plan({
    invoices: [invoice("i7", 202610, "unpaid", "600000.00")],
    accounts: [],
  });

  assert.equal(result.deposit, "0.00");
  assert.equal(result.cashTotal, "0.00");
  assert.deepEqual(result.cashLines, []);
  assert.equal(result.missingTargetAccount, false);
});
