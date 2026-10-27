const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * UMUMIY KO'RINISHDAGI SANOQCHILAR — ODAM BIR MARTA SANALADI.
 *
 * Qabul mezonlari:
 *   - bir nechta filialda ishlaydigan xodim JAMIDA bir marta sanaladi
 *     (u har filialda AYNI `id` bilan turadi — `attachToBranch`)
 *   - bolalari ikki filialda o'qiydigan ota-ona ham bir marta
 *   - FILIALLAR KESIMI esa har filialning O'Z soni bilan qoladi: kesim
 *     yig'indisi jamidan katta bo'lishi mumkin va farqi `shared` da
 *   - o'quvchi va premium dedup QILINMAYDI (o'quvchi bitta filialda)
 */

const { foldBranchStats } = require("../src/services/user.service");

const A = { id: "a".repeat(24), code: "main", name: "Bosh filial" };
const B = { id: "b".repeat(24), code: "aihub", name: "AI Hub" };

const SHARED_STAFF = "1".repeat(24);

test("ikki filialda ishlaydigan xodim JAMIDA bir marta sanaladi", () => {
  const out = foldBranchStats([
    {
      branch: A,
      staffIds: [SHARED_STAFF, "2".repeat(24), "3".repeat(24)],
      telegramIds: ["tg-1", "tg-2"],
      students: 300,
      premiumUsers: 25,
    },
    {
      branch: B,
      staffIds: [SHARED_STAFF, "4".repeat(24)],
      telegramIds: ["tg-1"],
      students: 161,
      premiumUsers: 15,
    },
  ]);

  assert.equal(out.totals.workers, 4, "3 + 2 = 5 EMAS: bittasi ikkala filialda");
  assert.equal(out.totals.telegramUsers, 2, "ota-ona ham bir marta");
  assert.equal(out.totals.students, 461, "o'quvchi bitta filialda — qo'shiladi");
  assert.equal(out.totals.premiumUsers, 40);

  // Kesim har filialning O'Z soni bilan qoladi
  assert.deepEqual(
    out.perBranch.map((row) => row.workers),
    [3, 2],
  );
  assert.equal(out.shared.workers, 1, "farq ochiq aytiladi");
  assert.equal(out.shared.telegramUsers, 1);
});

test("takrorlanish bo'lmasa farq nol bo'ladi", () => {
  const out = foldBranchStats([
    { branch: A, staffIds: ["5".repeat(24)], telegramIds: [], students: 10, premiumUsers: 0 },
    { branch: B, staffIds: ["6".repeat(24)], telegramIds: [], students: 5, premiumUsers: 0 },
  ]);

  assert.equal(out.totals.workers, 2);
  assert.equal(out.shared.workers, 0);
});
