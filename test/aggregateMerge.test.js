const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * UMUMIY KO'RINISH — JAVOBLARNI BIRLASHTIRISH.
 *
 * Qabul mezonlari:
 *   - ro'yxatlar ulanadi va HAR QATORGA qaysi filialdan kelgani yoziladi
 *   - birlashtirilgan sahifa ANIQ: jami — filiallar yig'indisi, qatorlar esa
 *     global tartibdan kerakli bo'lak
 *   - sanoqchi QO'SHILADI, foiz esa QO'SHILMAYDI (o'rtachalanadi)
 *   - platforma ma'lumoti (har filialda AYNI javob) takrorlanmaydi
 *   - bo'sh sana qator boshiga chiqmaydi
 */

const merge = require("../src/helpers/aggregateMerge.helpers");

const A = { id: "a".repeat(24), code: "main", name: "Bosh filial" };
const B = { id: "b".repeat(24), code: "second", name: "Ikkinchi filial" };

const body = (data, pagination, extras = {}) => ({
  success: true,
  data,
  ...(pagination ? { pagination } : {}),
  ...extras,
});

test("qatorlarga filial belgisi qo'yiladi, primitivlarga — yo'q", () => {
  assert.deepEqual(merge.tagRow({ id: 1 }, A), { id: 1, _branch: A });
  assert.equal(merge.tagRow("matn", A), "matn");
  // Mavjud belgi USTIDAN yozilmaydi
  assert.deepEqual(merge.tagRow({ id: 1, _branch: B }, A), { id: 1, _branch: B });
});

test("ro'yxat ulanadi va createdAt bo'yicha kamayish tartibida saralanadi", () => {
  const out = merge.mergeList([
    { branch: A, body: body([{ id: 1, createdAt: "2026-01-02" }, { id: 2, createdAt: "2026-01-07" }]) },
    { branch: B, body: body([{ id: 3, createdAt: "2026-01-05" }]) },
  ]);

  assert.deepEqual(out.data.map((r) => r.id), [2, 3, 1]);
  assert.deepEqual(out.data.map((r) => r._branch.code), ["main", "second", "main"]);
  assert.equal(out.pagination, null, "sahifalash bo'lmasa — pagination yo'q");
});

test("sahifalash: jami qo'shiladi, kerakli bo'lak qirqiladi", () => {
  const results = [
    {
      branch: A,
      body: body(
        [
          { id: 1, createdAt: "2026-01-09" },
          { id: 2, createdAt: "2026-01-07" },
          { id: 3, createdAt: "2026-01-03" },
          { id: 4, createdAt: "2026-01-01" },
        ],
        { page: 1, limit: 4, total: 40 },
      ),
    },
    {
      branch: B,
      body: body(
        [
          { id: 5, createdAt: "2026-01-08" },
          { id: 6, createdAt: "2026-01-02" },
        ],
        { page: 1, limit: 4, total: 2 },
      ),
    },
  ];

  const page1 = merge.mergeList(results, { page: 1, limit: 2 });
  assert.deepEqual(page1.data.map((r) => r.id), [1, 5]);
  assert.equal(page1.pagination.total, 42);
  assert.equal(page1.pagination.totalPages, 21);

  const page2 = merge.mergeList(results, { page: 2, limit: 2 });
  assert.deepEqual(page2.data.map((r) => r.id), [2, 3]);
  assert.equal(page2.pagination.page, 2);
  assert.equal(page2.pagination.hasPrevPage, true);
});

test("mijoz page/limit yubormasa — ENDPOINTNING o'z sukuti ishlatiladi", () => {
  const out = merge.mergeList(
    [
      { branch: A, body: body([{ id: 1 }, { id: 2 }, { id: 3 }], { page: 1, limit: 3, total: 9 }) },
      { branch: B, body: body([{ id: 4 }], { page: 1, limit: 3, total: 1 }) },
    ],
    { page: null, limit: null },
  );

  assert.equal(out.data.length, 3, "sukut 3 bo'lsa 3 qator qoladi");
  assert.equal(out.pagination.limit, 3);
  assert.equal(out.pagination.total, 10);
});

test("e'lon qilingan tartib ishlatiladi (oy desc, keyin createdAt desc)", () => {
  const out = merge.mergeList(
    [
      { branch: A, body: body([{ id: 1, month: 202609, createdAt: "2026-09-01" }]) },
      {
        branch: B,
        body: body([
          { id: 2, month: 202610, createdAt: "2026-10-01" },
          { id: 3, month: 202609, createdAt: "2026-09-20" },
        ]),
      },
    ],
    {
      sort: [
        { field: "month", dir: "desc" },
        { field: "createdAt", dir: "desc" },
      ],
    },
  );

  assert.deepEqual(out.data.map((r) => r.id), [2, 3, 1]);
});

test("bo'sh sana qator boshiga CHIQMAYDI", () => {
  const out = merge.mergeList([
    { branch: A, body: body([{ id: 1, createdAt: null }, { id: 2, createdAt: "2026-01-01" }]) },
    { branch: B, body: body([{ id: 3, createdAt: "2026-02-01" }]) },
  ]);

  // `createdAt` hammasida bo'lmagani uchun tartib taxmin qilinmaydi —
  // qatorlar filial tartibida qoladi, lekin hech narsa yo'qolmaydi.
  assert.equal(out.data.length, 3);
});

test("qo'shimcha kalitlar: sanoqchi QO'SHILADI, foiz O'RTACHALANADI", () => {
  const out = merge.mergeList([
    { branch: A, body: body([], null, { totalDebt: 100, attendancePercent: 80 }) },
    { branch: B, body: body([], null, { totalDebt: 50, attendancePercent: 90 }) },
  ]);

  assert.equal(out.extras.totalDebt, 150);
  assert.equal(out.extras.attendancePercent, 85, "foiz 170 bo'lib ketmaydi");
  const meta = merge.notesToMeta(out.notes);
  assert.deepEqual(meta.summed, ["totalDebt"]);
  assert.deepEqual(meta.averaged, ["attendancePercent"]);
});

test("obyekt javob: sanoqchilar qo'shiladi", () => {
  const out = merge.mergeObject([
    { branch: A, body: { success: true, data: { students: 10, workers: 3 } } },
    { branch: B, body: { success: true, data: { students: 5, workers: 1 } } },
  ]);

  assert.deepEqual(out.data, { students: 15, workers: 4 });
});

test("platforma ma'lumoti: AYNI javoblar teng deb aniqlanadi", () => {
  const catalog = body([{ id: "t1", name: "Standart" }], { page: 1, limit: 10, total: 1 });
  assert.equal(merge.deepEqual(catalog, structuredClone(catalog)), true);
  assert.equal(merge.deepEqual(catalog, body([{ id: "t2", name: "Standart" }])), false);
});

test("foiz ko'rinishidagi kalitlar bo'lak bo'yicha aniqlanadi", () => {
  assert.equal(merge.isRatioKey("attendancePercent"), true);
  assert.equal(merge.isRatioKey("avgGrade"), true);
  assert.equal(merge.isRatioKey("ratio"), true);
  // "generated" ichidagi "rate" foiz EMAS
  assert.equal(merge.isRatioKey("generated"), false);
  assert.equal(merge.isRatioKey("total"), false);
});

/* ───────── OBYEKT JAVOBLAR (sanoq kartalari, hisobot bloklari) ───────── */

test("sozlama qiymati QO'SHILMAYDI, sanoqchi qo'shiladi", () => {
  // `GET /tasks/stats` ning haqiqiy shakli: sanoqchilar ichida "muddati
  // yaqin" chegarasi (24 soat) ham keladi.
  const out = merge.mergeObject([
    { branch: A, body: { success: true, data: { total: 10, overdue: 3, dueSoonHours: 24 } } },
    { branch: B, body: { success: true, data: { total: 5, overdue: 1, dueSoonHours: 24 } } },
  ]);

  assert.equal(out.data.total, 15);
  assert.equal(out.data.overdue, 4);
  assert.equal(out.data.dueSoonHours, 24, "24 soat 48 ga aylanmaydi");
});

test("davr va sahifa qiymatlari qo'shilmaydi", () => {
  const out = merge.mergeObject([
    { branch: A, body: { success: true, data: { month: 202610, count: 2, lastSyncAt: 5 } } },
    { branch: B, body: { success: true, data: { month: 202610, count: 3, lastSyncAt: 9 } } },
  ]);

  assert.equal(out.data.month, 202610);
  assert.equal(out.data.count, 5);
  assert.equal(out.data.lastSyncAt, 5, "instant qo'shilmaydi");
});

test("max/min qo'shilmaydi — eng katta/kichik olinadi", () => {
  const out = merge.mergeObject([
    { branch: A, body: { success: true, data: { maxStreak: 7, minScore: 3 } } },
    { branch: B, body: { success: true, data: { maxStreak: 4, minScore: 1 } } },
  ]);

  assert.equal(out.data.maxStreak, 7);
  assert.equal(out.data.minScore, 1);
});

test("registrdagi `keep` ham hurmat qilinadi", () => {
  const out = merge.mergeObject(
    [
      { branch: A, body: { success: true, data: { limitHours: 8, used: 2 } } },
      { branch: B, body: { success: true, data: { limitHours: 8, used: 5 } } },
    ],
    { keep: new Set(["limitHours"]) },
  );

  assert.equal(out.data.limitHours, 8);
  assert.equal(out.data.used, 7);
});

test("kunlik qatorlar ULANMAYDI — sana bo'yicha GURUHLANADI", () => {
  const out = merge.mergeObject([
    {
      branch: A,
      body: {
        success: true,
        data: {
          days: [
            { date: "2026-10-01", income: 100, expense: 20 },
            { date: "2026-10-02", income: 50, expense: 0 },
          ],
        },
      },
    },
    {
      branch: B,
      body: {
        success: true,
        data: { days: [{ date: "2026-10-01", income: 7, expense: 3 }] },
      },
    },
  ]);

  assert.equal(out.data.days.length, 2, "bitta sanada ikkita qator qolmaydi");
  assert.deepEqual(out.data.days[0], {
    date: "2026-10-01",
    income: 107,
    expense: 23,
  });
  // Faqat bitta filialda bor kun — o'z filiali belgisi bilan qoladi
  assert.equal(out.data.days[1]._branch.code, "main");
});

test("kalitsiz qatorlar ulanadi va har biri filial bilan belgilanadi", () => {
  const out = merge.mergeObject([
    { branch: A, body: { success: true, data: { top: [{ fullName: "A", score: 9 }] } } },
    { branch: B, body: { success: true, data: { top: [{ fullName: "B", score: 8 }] } } },
  ]);

  assert.equal(out.data.top.length, 2);
  assert.deepEqual(
    out.data.top.map((row) => row._branch.code),
    ["main", "second"],
  );
});

test("obyekt javobdagi foiz o'rtachalanadi, matn esa langardan qoladi", () => {
  const out = merge.mergeObject([
    { branch: A, body: { success: true, data: { percent: 80, label: "Bosh" } } },
    { branch: B, body: { success: true, data: { percent: 90, label: "Ikkinchi" } } },
  ]);

  assert.equal(out.data.percent, 85);
  assert.equal(out.data.label, "Bosh");
  assert.deepEqual(merge.notesToMeta(out.notes).partial, ["data.label"]);
});
