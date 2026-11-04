const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * TANGA CHEKLOVI — qarzdor o'quvchiga tanga berilmaydi.
 *
 * `coinBlock.service` haqiqiy kodi, baza soxta. Eng muhim qoidalar:
 * darvoza VAQTGA bog'liq (o'tgan kun uchun qayta ishlangan pass o'sha
 * kundagi holatni ko'radi), bir o'quvchida bitta faol cheklov,
 * cheklov o'chirilmaydi — bekor qilinadi, va qo'lda tanga berish
 * yo'li cheklangan o'quvchini CHETLAB o'tadi.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const DAY = 24 * 3600 * 1000;
// ⚠️ HAQIQIY vaqt: darvoza `createdAt <= at` bo'yicha hal qiladi va `at`
// ning sukuti — `new Date()`. Qotirilgan sana soat nechchiligiga qarab
// kelajakda qolib, cheklov "hali qo'yilmagan" bo'lib ko'rinardi.
const nowRef = () => new Date();

const S1 = "a".repeat(24);
const S2 = "b".repeat(24);
const S3 = "c".repeat(24);
const TEACHER = "d".repeat(24);
const ADMIN = "e".repeat(24);

const USERS = [
  { id: S1, firstName: "Ali", lastName: "Valiyev", username: "ali", role: "student", isActive: true, isArchived: false, coinBalance: 120, classes: [{ class: { id: "x", name: "5-A" } }] },
  { id: S2, firstName: "Olim", lastName: "Karimov", username: "olim", role: "student", isActive: true, isArchived: false, coinBalance: 40, classes: [{ class: { id: "x", name: "5-A" } }] },
  { id: S3, firstName: "Shirin", lastName: "Aliyeva", username: "shirin", role: "student", isActive: true, isArchived: false, coinBalance: 0, classes: [] },
  { id: TEACHER, firstName: "Dildora", lastName: "Nurmatova", username: "dildora", role: "teacher", isActive: true, isArchived: false, coinBalance: 0, classes: [] },
];

/** Ochiq hisob-fakturalar: S1 qarzdor, S2 qarzdor, S3 qarzsiz. */
const INVOICES = [
  { studentId: S1, month: 202609, status: "unpaid", amount: "600000.00", paidAmount: "0.00" },
  { studentId: S1, month: 202610, status: "partial", amount: "600000.00", paidAmount: "200000.00" },
  { studentId: S2, month: 202610, status: "unpaid", amount: "500000.00", paidAmount: "0.00" },
  // To'liq to'langan oy qarz EMAS
  { studentId: S3, month: 202610, status: "paid", amount: "500000.00", paidAmount: "500000.00" },
];

/* ── `where` ning shu servis ishlatadigan qismi ── */
const cmp = (value, cond) => {
  if (cond === undefined) return true;
  if (cond === null) return value == null;
  if (cond instanceof Date) return value?.getTime() === cond.getTime();
  if (typeof cond !== "object") return value === cond;
  if ("not" in cond) return cond.not === null ? value != null : value !== cond.not;
  if ("in" in cond) return cond.in.includes(value);
  if ("contains" in cond) {
    return String(value ?? "").toLowerCase().includes(String(cond.contains).toLowerCase());
  }
  if ("some" in cond) return (value ?? []).some((v) => matches(v, cond.some));
  const num = (v) => (v instanceof Date ? v.getTime() : v);
  const self = num(value);
  return (
    (cond.gt === undefined || self > num(cond.gt)) &&
    (cond.gte === undefined || self >= num(cond.gte)) &&
    (cond.lt === undefined || self < num(cond.lt)) &&
    (cond.lte === undefined || self <= num(cond.lte))
  );
};
const matches = (row, where = {}) =>
  Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return cond.some((c) => matches(row, c));
    return cmp(row[key], cond);
  });

let db;
let seq;
const resetDb = () => {
  db = { blocks: [], transactions: [], stats: [], grades: new Map() };
  seq = 0;
  for (const u of USERS) u.coinBalance = u.id === S1 ? 120 : u.id === S2 ? 40 : 0;
};

const blockStore = {
  findMany: async ({ where, orderBy, skip, take, distinct }) => {
    let rows = db.blocks.filter((r) => matches(r, where));
    if (orderBy?.createdAt === "desc") rows = [...rows].sort((a, b) => b.createdAt - a.createdAt);
    if (orderBy?.revokedAt === "desc") rows = [...rows].sort((a, b) => (b.revokedAt ?? 0) - (a.revokedAt ?? 0));
    if (distinct) {
      const seen = new Set();
      rows = rows.filter((r) => {
        const key = distinct.map((k) => r[k]).join("|");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    if (skip) rows = rows.slice(skip);
    if (take) rows = rows.slice(0, take);
    return rows.map((r) => ({ ...r }));
  },
  findFirst: async ({ where, orderBy }) => (await blockStore.findMany({ where, orderBy }))[0] ?? null,
  count: async ({ where }) => db.blocks.filter((r) => matches(r, where)).length,
  create: async ({ data }) => {
    // `active_key` UNIQUE indeksi — poyga strukturaviy imkonsiz
    if (data.activeKey && db.blocks.some((r) => r.activeKey === data.activeKey)) {
      const err = new Error("Unique constraint failed");
      err.code = "P2002";
      throw err;
    }
    const row = {
      id: String(++seq).padStart(24, "0"),
      revokedAt: null,
      revokedBy: null,
      revokeReason: "",
      note: "",
      createdAt: new Date(),
      ...data,
    };
    db.blocks.push(row);
    return { ...row };
  },
  updateMany: async ({ where, data }) => {
    const rows = db.blocks.filter((r) => matches(r, where));
    for (const row of rows) Object.assign(row, data);
    return { count: rows.length };
  },
};

const prisma = {
  studentCoinBlock: blockStore,
  monthlyInvoice: {
    groupBy: async ({ where }) => {
      const rows = INVOICES.filter((r) => matches(r, where));
      const byStudent = new Map();
      for (const row of rows) {
        const entry = byStudent.get(row.studentId) ?? {
          studentId: row.studentId,
          _sum: { amount: 0, paidAmount: 0 },
          _min: { month: row.month },
          _count: { _all: 0 },
        };
        entry._sum.amount += Number(row.amount);
        entry._sum.paidAmount += Number(row.paidAmount);
        entry._min.month = Math.min(entry._min.month, row.month);
        entry._count._all += 1;
        byStudent.set(row.studentId, entry);
      }
      return [...byStudent.values()];
    },
  },
  user: {
    findMany: async ({ where }) => USERS.filter((u) => matches(u, where)).map((u) => ({ ...u })),
    count: async ({ where }) => USERS.filter((u) => matches(u, where)).length,
    updateMany: async ({ where, data }) => {
      const rows = USERS.filter((u) => matches(u, where));
      for (const row of rows) {
        if (data.coinBalance?.increment != null) row.coinBalance += data.coinBalance.increment;
      }
      return { count: rows.length };
    },
    update: async ({ where, data }) => {
      const row = USERS.find((u) => u.id === where.id);
      if (data.coinBalance?.increment != null) row.coinBalance += data.coinBalance.increment;
      return { ...row };
    },
  },
  coinTransaction: {
    createMany: async ({ data }) => {
      db.transactions.push(...data);
      return { count: data.length };
    },
    create: async ({ data }) => {
      db.transactions.push(data);
      return data;
    },
    findMany: async () => [],
    findFirst: async () => null,
  },
  dailyCoinStat: {
    findUnique: async () => null,
    upsert: async ({ create }) => db.stats.push(create),
  },
  // Kunlik pass: baho yig'indisi (o'qituvchi baho qo'ygani — tanganing manbai)
  grade: {
    groupBy: async ({ where }) =>
      [...db.grades.entries()]
        .filter(([studentId]) => (where.studentId?.in ?? []).includes(studentId))
        .map(([studentId, sum]) => ({ studentId, _sum: { grade: sum } })),
  },
  $transaction: async (arg) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg)),
  $executeRaw: async () => 0,
};

fakeModule("../src/config/prisma", prisma);
// Kunlik tanga sozlamalari — bazadan emas, qotirilgan: tekshirilayotgan
// narsa cheklov, foiz emas.
fakeModule("../src/services/settings.service", {
  getCoinSettings: async () => ({
    dailyCoinPercentage: 50,
    schoolRankBonus: 100,
    classRankBonus: 20,
    minDailyGradeForCoin: 10,
  }),
});

const service = require("../src/services/coinBlock.service");

const block = (overrides = {}) =>
  service.blockStudents({
    studentIds: [S1],
    reason: "Oylik to'lov qarzdorligi",
    createdBy: ADMIN,
    ...overrides,
  });

/* ───────────────────────── Kirish tekshiruvlari ───────────────────────── */

test("sabab MAJBURIY va o'quvchi tanlanishi shart", async () => {
  resetDb();
  await assert.rejects(() => block({ reason: "   " }), /Sabab majburiy/);
  await assert.rejects(() => block({ studentIds: [] }), /tanlanmadi/);
  await assert.rejects(() => block({ studentIds: ["qisqa"] }), /yaroqsiz/);
  await assert.rejects(
    () => block({ studentIds: Array.from({ length: service.MAX_STUDENTS + 1 }, (_, i) => String(i).padStart(24, "0")) }),
    /tagacha/,
  );
  assert.equal(db.blocks.length, 0, "xato kiritishda hech narsa yozilmaydi");
});

test("faqat O'QUVCHI cheklanadi — xodim rad etiladi", async () => {
  resetDb();
  await assert.rejects(() => block({ studentIds: [TEACHER] }), /topilmadi/);

  // Aralash ro'yxatda o'quvchi yoziladi, xodim `failed` da qaytadi
  const result = await block({ studentIds: [S1, TEACHER] });
  assert.equal(result.blockedCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(db.blocks.length, 1);
  assert.equal(db.blocks[0].studentId, S1);
});

/* ─────────────────────── BIR NECHTA O'QUVCHI BIRDANIGA ─────────────────────── */

test("ommaviy cheklash: har o'quvchiga alohida qator, bitta batch, qarz MUHRLANADI", async () => {
  resetDb();
  const result = await block({ studentIds: [S1, S2, S3] });

  assert.equal(result.blockedCount, 3);
  assert.equal(new Set(db.blocks.map((r) => r.batchId)).size, 1, "bitta amal — bitta guruh");

  const first = db.blocks.find((r) => r.studentId === S1);
  // 600000 + (600000 − 200000) = 1 000 000
  assert.equal(String(first.debtSnapshot), "1000000");
  assert.equal(first.debtMonthCount, 2);
  assert.equal(first.oldestDebtMonth, 202609);
  assert.equal(first.snapshot.fullName, "Ali Valiyev");
  assert.equal(first.snapshot.className, "5-A");

  // Qarzi yo'q o'quvchini ham cheklash mumkin (ongli qaror) — muhr 0 bo'ladi
  const third = db.blocks.find((r) => r.studentId === S3);
  assert.equal(String(third.debtSnapshot), "0");
  assert.equal(third.debtMonthCount, 0);
  assert.equal(third.oldestDebtMonth, null);
});

test("allaqachon cheklangan o'quvchiga IKKINCHI qator yozilmaydi (xato emas)", async () => {
  resetDb();
  await block({ studentIds: [S1] });
  const again = await block({ studentIds: [S1, S2] });

  assert.equal(again.blockedCount, 1, "faqat S2 yoziladi");
  assert.equal(again.skippedCount, 1);
  assert.equal(again.skipped[0].studentId, S1);
  assert.equal(db.blocks.filter((r) => r.studentId === S1 && r.revokedAt == null).length, 1);
});

/* ──────────────────────────── DARVOZA ──────────────────────────── */

test("darvoza: cheklangan o'quvchi to'plamda, qolganlari yo'q", async () => {
  resetDb();
  await block({ studentIds: [S1] });

  const blocked = await service.getBlockedStudentIds([S1, S2, S3]);
  assert.deepEqual([...blocked], [S1]);

  // Ro'yxat bo'sh bo'lsa bazaga ham borilmaydi
  assert.equal((await service.getBlockedStudentIds([])).size, 0);
});

test("darvoza: bitta o'quvchi uchun OCHIQ xato (jim o'tkazib yuborish emas)", async () => {
  resetDb();
  await service.assertCoinsAllowed(S1); // cheklov yo'q — o'tadi
  await block({ studentIds: [S1] });

  await assert.rejects(
    () => service.assertCoinsAllowed(S1),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.details.reason, "coin_blocked");
      assert.match(err.message, /taqiqlangan/);
      return true;
    },
  );
});

test("darvoza VAQTGA bog'liq: bugun ochilgan cheklov KECHAGI pass uchun amalda", async () => {
  resetDb();
  const ref = nowRef();
  const created = new Date(ref.getTime() - 3 * DAY);
  db.blocks.push({
    id: "1".repeat(24),
    studentId: S1,
    batchId: "0".repeat(24),
    activeKey: null,
    reason: "Qarzdorlik",
    note: "",
    debtSnapshot: 0,
    debtMonthCount: 0,
    oldestDebtMonth: null,
    snapshot: {},
    createdBy: ADMIN,
    createdAt: created,
    // Bugun ochilgan
    revokedAt: ref,
    revokedBy: ADMIN,
    revokeReason: "To'landi",
  });

  const yesterday = new Date(ref.getTime() - DAY);
  assert.equal(
    (await service.getBlockedStudentIds([S1], { at: yesterday })).has(S1),
    true,
    "kechagi kun uchun cheklov amalda edi — o'sha kunning tangasi qaytmasligi kerak",
  );
  assert.equal(
    (await service.getBlockedStudentIds([S1], { at: new Date(ref.getTime() + 60_000) })).has(S1),
    false,
    "ochilgandan keyin cheklov yo'q",
  );
  assert.equal(
    (await service.getBlockedStudentIds([S1], { at: new Date(created.getTime() - DAY) })).has(S1),
    false,
    "cheklov qo'yilishidan OLDINGI kunga ta'sir qilmaydi",
  );
});

/* ──────────────────────────── OCHISH ──────────────────────────── */

test("ochish: o'chirilmaydi — bekor qilinadi (sabab + aktyor), keyin qayta cheklash mumkin", async () => {
  resetDb();
  await block({ studentIds: [S1, S2] });

  await assert.rejects(
    () => service.unblockStudents({ studentIds: [S1], reason: " ", revokedBy: ADMIN }),
    /majburiy/,
  );

  const result = await service.unblockStudents({
    studentIds: [S1, S2],
    reason: "Qarzdorlik to'landi",
    revokedBy: ADMIN,
  });

  assert.equal(result.unblockedCount, 2);
  assert.equal(db.blocks.length, 2, "qator o'chirilmaydi — tarix qoladi");
  for (const row of db.blocks) {
    assert.equal(row.activeKey, null, "faol kalit bo'shaydi");
    assert.ok(row.revokedAt);
    assert.equal(row.revokedBy, ADMIN);
    assert.equal(row.revokeReason, "Qarzdorlik to'landi");
  }

  assert.equal((await service.getBlockedStudentIds([S1, S2])).size, 0);

  // Qayta cheklash — yangi qator, tarix ikki qator bo'lib qoladi
  const again = await block({ studentIds: [S1] });
  assert.equal(again.blockedCount, 1);
  assert.equal(db.blocks.filter((r) => r.studentId === S1).length, 2);
});

test("ochish: faol cheklov bo'lmasa aniq xato", async () => {
  resetDb();
  await assert.rejects(
    () => service.unblockStudents({ studentIds: [S1], reason: "To'landi", revokedBy: ADMIN }),
    /topilmadi/,
  );
});

/* ──────────────────────────── REGISTR ──────────────────────────── */

test("registr: JORIY qarz qayta o'qiladi va qarzi yopilgani belgilanadi", async () => {
  resetDb();
  await block({ studentIds: [S1, S3] });

  const list = await service.listBlocks({ query: {} });
  const byId = new Map(list.data.map((r) => [r.studentId, r]));

  // S1 — qarzi bor
  assert.equal(byId.get(S1).debtNow, "1000000.00");
  assert.equal(byId.get(S1).debtCleared, false);
  // S3 — qarzi yo'q, ya'ni cheklov ochilishi kerak
  assert.equal(byId.get(S3).debtNow, "0.00");
  assert.equal(byId.get(S3).debtCleared, true);

  const summary = await service.getBlockSummary();
  assert.equal(summary.blockedCount, 2);
  assert.equal(summary.debtNow, "1000000.00");
  assert.equal(summary.clearedCount, 1, "ochish kutib turgan cheklov");

  // Tarix tabida faol qator ko'rinmaydi
  assert.equal((await service.listBlocks({ query: { status: "revoked" } })).data.length, 0);
  await service.unblockStudents({ blockIds: [byId.get(S3).id], reason: "To'landi", revokedBy: ADMIN });
  const history = await service.listBlocks({ query: { status: "revoked" } });
  assert.equal(history.data.length, 1);
  assert.equal(history.data[0].status, "revoked");
});

test("nomzodlar: sukut bo'yicha QARZDORLAR, cheklangani belgilanadi", async () => {
  resetDb();
  await block({ studentIds: [S1] });

  const debtors = await service.getBlockCandidates({ query: {} });
  const ids = debtors.data.map((r) => r.studentId);
  assert.deepEqual(ids, [S1, S2], "qarz bo'yicha kamayish tartibida; qarzsiz S3 yo'q");
  assert.equal(debtors.data[0].isBlocked, true);
  assert.equal(debtors.data[1].isBlocked, false);

  const all = await service.getBlockCandidates({ query: { debtorsOnly: "false" } });
  assert.ok(all.data.some((r) => r.studentId === S3), "barcha o'quvchilar rejimida qarzsiz ham chiqadi");
  assert.ok(!all.data.some((r) => r.studentId === TEACHER), "xodim nomzod emas");
});

test("o'quvchi O'ZI ko'radi: sabab, izoh va qachondan", async () => {
  resetDb();
  assert.deepEqual(await service.getMyBlock(S1), { isBlocked: false });

  await block({ studentIds: [S1], note: "Ota-ona bilan kelishildi" });
  const mine = await service.getMyBlock(S1);
  assert.equal(mine.isBlocked, true);
  assert.equal(mine.reason, "Oylik to'lov qarzdorligi");
  assert.equal(mine.note, "Ota-ona bilan kelishildi");
  assert.equal(mine.debtAtBlock, "1000000.00");
  assert.ok(mine.sinceLabel);
});

/* ──────────────── QO'LDA TANGA BERISH CHEKLOVNI CHETLAB O'TMAYDI ──────────────── */

test("qo'lda tanga berish: cheklangan o'quvchi CHETDA qoladi, olish (take) esa ishlaydi", async () => {
  resetDb();
  await block({ studentIds: [S1] });

  const coinService = require("../src/services/coin.service");

  const give = await coinService.distributeManualCoins({
    action: "give",
    amount: 50,
    reason: "Bayram sovg'asi",
    filterType: "role",
    filterValue: "student",
    givenBy: ADMIN,
  });

  assert.equal(give.blockedCount, 1, "cheklangan o'quvchi sanoqda alohida");
  assert.equal(give.successCount, 2, "qolgan ikki o'quvchiga yozildi");
  assert.ok(
    !db.transactions.some((t) => t.studentId === S1),
    "cheklangan o'quvchiga tanga tranzaksiyasi YOZILMAYDI",
  );
  assert.equal(USERS.find((u) => u.id === S1).coinBalance, 120, "balansi o'zgarmadi");

  // ⚠️ OLISH cheklanmaydi: cheklov "yangi tanga yozilmaydi" degani,
  // tangani muzlatish emas.
  db.transactions = [];
  const take = await coinService.distributeManualCoins({
    action: "take",
    amount: 20,
    reason: "Xato berilgan",
    filterType: "individual",
    filterValue: S1,
    givenBy: ADMIN,
  });
  assert.equal(take.blockedCount, 0);
  assert.equal(take.successCount, 1);
  assert.equal(USERS.find((u) => u.id === S1).coinBalance, 100);
});

test("qo'lda tanga berish: BITTA o'quvchi tanlansa 409 bilan rad etiladi", async () => {
  resetDb();
  await block({ studentIds: [S1] });
  const coinService = require("../src/services/coin.service");

  await assert.rejects(
    () =>
      coinService.distributeManualCoins({
        action: "give",
        amount: 50,
        reason: "Rag'bat",
        filterType: "individual",
        filterValue: S1,
        givenBy: ADMIN,
      }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.details.reason, "coin_blocked");
      return true;
    },
  );
  assert.equal(db.transactions.length, 0);
});

/* ─────── KUNLIK TANGA (o'qituvchi baho qo'ygani) CHEKLOVNI CHETLAB O'TMAYDI ─────── */

test("kunlik pass: cheklangan o'quvchiga baho uchun tanga YOZILMAYDI", async () => {
  resetDb();
  await block({ studentIds: [S1] });

  // Uchala o'quvchiga ham baho qo'yilgan (o'qituvchi ishini qildi)
  db.grades.set(S1, 40);
  db.grades.set(S2, 40);
  db.grades.set(S3, 40);

  const coinService = require("../src/services/coin.service");
  const result = await coinService.distributeDailyCoins(new Date());

  assert.equal(result.blockedCount, 1, "cheklangan o'quvchi alohida sanaladi");
  assert.equal(result.successCount, 2);
  assert.ok(
    !db.transactions.some((t) => t.studentId === S1),
    "O'QITUVCHI BAHO QO'YSA HAM cheklangan o'quvchiga tanga tushmaydi",
  );
  assert.equal(USERS.find((u) => u.id === S1).coinBalance, 120, "balansi o'zgarmadi");
  assert.equal(USERS.find((u) => u.id === S2).coinBalance, 40 + 20);
});

test("kunlik pass: bugun ochilgan cheklov KECHAGI kun uchun ham tangani bermaydi", async () => {
  resetDb();
  const ref = nowRef();

  // Kecha qo'yilgan, bugun ochilgan cheklov
  db.blocks.push({
    id: "9".repeat(24),
    studentId: S1,
    batchId: "0".repeat(24),
    activeKey: null,
    reason: "Qarzdorlik",
    note: "",
    debtSnapshot: 0,
    debtMonthCount: 0,
    oldestDebtMonth: null,
    snapshot: {},
    createdBy: ADMIN,
    createdAt: new Date(ref.getTime() - 2 * DAY),
    revokedAt: ref,
    revokedBy: ADMIN,
    revokeReason: "To'landi",
  });

  db.grades.set(S1, 40);

  const coinService = require("../src/services/coin.service");
  // Startup recovery AYNAN shunday chaqiradi (`coinDaily.job.js` — kechagi kun)
  const result = await coinService.distributeDailyCoins(new Date(ref.getTime() - DAY));

  assert.equal(result.blockedCount, 1);
  assert.ok(
    !db.transactions.some((t) => t.studentId === S1),
    "cheklov davridagi tanga keyin ham berilmaydi",
  );
});
