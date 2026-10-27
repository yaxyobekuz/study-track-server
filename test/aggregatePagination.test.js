const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * SAHIFALANGAN OBYEKT JAVOB — ro'yxat `data` da emas, o'z nomi bilan.
 *
 * Kunlik davomat `{ students, summary, date, pagination }` qaytaradi.
 * Bunday javob obyekt sifatida birlashtiriladi va `pagination` javobdan
 * butunlay tushib qolardi — panel "jami nechta" ni ham, sahifalarni ham
 * ko'rsata olmasdi.
 */

const {
  mergePagination,
  singleArrayKey,
} = require("../src/middleware/aggregate.middleware");

const A = { id: "a".repeat(24), code: "mbsi", name: "MBSI" };
const B = { id: "b".repeat(24), code: "aihub", name: "AI Hub" };

const labelled = (aTotal, bTotal) => [
  {
    branch: A,
    body: { students: [], summary: {}, pagination: { page: 1, limit: 20, total: aTotal } },
  },
  {
    branch: B,
    body: { students: [], summary: {}, pagination: { page: 1, limit: 20, total: bTotal } },
  },
];

test("jami — filiallar yig'indisi, sahifa — mijoz so'ragani", () => {
  const out = mergePagination(labelled(92, 23), 2, 20);

  assert.equal(out.total, 115);
  assert.equal(out.page, 2);
  assert.equal(out.limit, 20);
  assert.equal(out.totalPages, 6);
  assert.equal(out.hasPrevPage, true);
  assert.equal(out.hasNextPage, true);
});

test("mijoz sahifa yubormasa — endpointning o'z sukuti", () => {
  const out = mergePagination(labelled(10, 5), null, null);

  assert.equal(out.page, 1);
  assert.equal(out.limit, 20);
  assert.equal(out.totalPages, 1);
  assert.equal(out.hasNextPage, false);
});

test("filial sahifalamagan bo'lsa — birlashtirilmaydi", () => {
  const rows = labelled(10, 5);
  delete rows[1].body.pagination;

  assert.equal(mergePagination(rows, 1, 20), null);
});

test("yagona massiv kaliti topiladi, ikkitasi bo'lsa — taxmin qilinmaydi", () => {
  assert.equal(singleArrayKey(labelled(1, 1)), "students");

  const twoArrays = labelled(1, 1).map((row) => ({
    ...row,
    body: { ...row.body, warnings: [] },
  }));
  assert.equal(singleArrayKey(twoArrays), null);
});
