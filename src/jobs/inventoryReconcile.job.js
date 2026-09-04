/**
 * Inventar invariantlarini har kecha tekshiradi.
 *
 * `financeReconcile.job.js` ning aynan ko'zgusi va bir xil falsafada:
 * ARZON REKONSILER HAR QANDAY DIZAYN ISHONCHIDAN QIMMATROQ. Bu job hech
 * narsani TUZATMAYDI — u faqat baqiradi. Avtomatik tuzatish haqiqiy
 * sababni yashirardi va keyingi safar partalar jimgina "yo'qolardi".
 *
 * Modulda uchta denormalizatsiya va ikkita muhrlangan identitet bor:
 *
 *   1. InventoryStock.quantity       = Σ InventoryMovement.quantityDelta
 *   2. InventoryStock.brokenQuantity = Σ InventoryMovement.brokenDelta
 *      (va 0 <= brokenQuantity <= quantity)
 *   3. InventoryDamage.amount        = quantity × unitPrice        [MUHR]
 *   4. InventoryDamage.chargedAmount = Σ (status≠cancelled) DamageCharge.amount
 *      (va chargedAmount <= amount)
 *   5. DamageCharge.paidAmount       = Σ (isVoided=false) DamageAllocation.amount
 *
 * 03:20 — moliyaviy tekshiruvdan (03:00) keyin, hisob-faktura passidan
 * (06:00) oldin.
 */

const cron = require("node-cron");
const { branchCron } = require("../helpers/branchIterator");
const prisma = require("../config/prisma");
const { getBranch } = require("../config/branchContext");
const logger = require("../utils/logger");
const { Decimal, formatAmount } = require("../helpers/money.helpers");
const { damageAmountOf } = require("../helpers/inventory.helpers");

/**
 * Bitta tekshiruv passi.
 * @returns {Promise<{checked: object, problems: object[]}>}
 */
async function runInventoryReconcilePass() {
  const problems = [];

  // Filial nomi HAR BIR log satrida — "qaysi filialda?" javobsiz qolmasin
  const branch = getBranch();
  const tag = `[InventoryReconcile] ${branch ? branch.name : "?"}`;

  // ── 1–2. Xatlov miqdorlari daftar yig'indisiga teng ──
  const [stocks, movementSums] = await Promise.all([
    prisma.inventoryStock.findMany({
      include: {
        item: { select: { name: true } },
        location: { select: { name: true } },
      },
    }),
    prisma.inventoryMovement.groupBy({
      by: ["stockId"],
      _sum: { quantityDelta: true, brokenDelta: true },
    }),
  ]);

  const sumByStock = new Map(movementSums.map((row) => [row.stockId, row._sum]));

  for (const stock of stocks) {
    const label = `${stock.location?.name ?? "?"} / ${stock.item?.name ?? "?"}`;
    const sums = sumByStock.get(stock.id);

    const expectedQuantity = sums?.quantityDelta ?? 0;
    const expectedBroken = sums?.brokenDelta ?? 0;

    if (stock.quantity !== expectedQuantity) {
      problems.push({
        kind: "stock_quantity",
        id: stock.id,
        label,
        stored: String(stock.quantity),
        expected: String(expectedQuantity),
      });
    }

    if (stock.brokenQuantity !== expectedBroken) {
      problems.push({
        kind: "stock_broken",
        id: stock.id,
        label,
        stored: String(stock.brokenQuantity),
        expected: String(expectedBroken),
      });
    }

    // Mantiqiy chegaralar — `assertStockConsistency` ni chetlab o'tgan
    // har qanday yo'l shu yerda ko'rinadi
    if (stock.quantity < 0 || stock.brokenQuantity < 0) {
      problems.push({
        kind: "stock_negative",
        id: stock.id,
        label,
        stored: `${stock.quantity}/${stock.brokenQuantity}`,
        expected: ">= 0",
      });
    } else if (stock.brokenQuantity > stock.quantity) {
      problems.push({
        kind: "stock_broken_exceeds",
        id: stock.id,
        label,
        stored: `${stock.brokenQuantity} > ${stock.quantity}`,
        expected: "brokenQuantity <= quantity",
      });
    }
  }

  // ── 3–4. Zarar summasi muhrlangan va ulushlar undan oshmaydi ──
  const [damages, chargeSums] = await Promise.all([
    prisma.inventoryDamage.findMany({
      where: { status: { not: "cancelled" } },
      select: {
        id: true,
        quantity: true,
        unitPrice: true,
        amount: true,
        chargedAmount: true,
        itemSnapshot: true,
        occurredAt: true,
      },
    }),
    prisma.damageCharge.groupBy({
      by: ["damageId"],
      where: { status: { not: "cancelled" } },
      _sum: { amount: true },
    }),
  ]);

  const chargedByDamage = new Map(
    chargeSums.map((row) => [row.damageId, new Decimal(row._sum.amount ?? 0)]),
  );

  for (const damage of damages) {
    const label = `${damage.itemSnapshot?.name ?? "?"} ×${damage.quantity}`;

    const expectedAmount = damageAmountOf(damage.quantity, damage.unitPrice);
    if (!expectedAmount.equals(damage.amount)) {
      problems.push({
        kind: "damage_amount",
        id: damage.id,
        label,
        stored: formatAmount(damage.amount),
        expected: formatAmount(expectedAmount),
      });
    }

    const expectedCharged = chargedByDamage.get(damage.id) ?? new Decimal(0);
    if (!expectedCharged.equals(damage.chargedAmount)) {
      problems.push({
        kind: "damage_charged",
        id: damage.id,
        label,
        stored: formatAmount(damage.chargedAmount),
        expected: formatAmount(expectedCharged),
      });
    }

    // ASOSIY INVARIANT: aybdorlarga zarardan KO'PROQ yozib bo'lmaydi
    if (expectedCharged.greaterThan(damage.amount)) {
      problems.push({
        kind: "damage_overcharged",
        id: damage.id,
        label,
        stored: formatAmount(expectedCharged),
        expected: `<= ${formatAmount(damage.amount)}`,
      });
    }
  }

  // ── 5. Qarzning to'langan summasi taqsimotlar yig'indisiga teng ──
  const [charges, allocationSums] = await Promise.all([
    prisma.damageCharge.findMany({
      where: { status: { not: "cancelled" } },
      select: { id: true, amount: true, paidAmount: true, personSnapshot: true },
    }),
    prisma.damageAllocation.groupBy({
      by: ["chargeId"],
      where: { isVoided: false },
      _sum: { amount: true },
    }),
  ]);

  const paidByCharge = new Map(
    allocationSums.map((row) => [row.chargeId, new Decimal(row._sum.amount ?? 0)]),
  );

  for (const charge of charges) {
    const snapshot = charge.personSnapshot ?? {};
    const label = `${snapshot.firstName ?? "?"} ${snapshot.lastName ?? ""}`.trim();

    const expectedPaid = paidByCharge.get(charge.id) ?? new Decimal(0);
    if (!expectedPaid.equals(charge.paidAmount)) {
      problems.push({
        kind: "charge_paid",
        id: charge.id,
        label,
        stored: formatAmount(charge.paidAmount),
        expected: formatAmount(expectedPaid),
      });
    }

    if (expectedPaid.greaterThan(charge.amount)) {
      problems.push({
        kind: "charge_overpaid",
        id: charge.id,
        label,
        stored: formatAmount(expectedPaid),
        expected: `<= ${formatAmount(charge.amount)}`,
      });
    }
  }

  const checked = {
    stocks: stocks.length,
    damages: damages.length,
    charges: charges.length,
  };

  if (problems.length === 0) {
    logger.info(
      `${tag} Invariantlar joyida — ${checked.stocks} xatlov qatori, ` +
        `${checked.damages} zarar, ${checked.charges} qarz`,
    );
  } else {
    logger.error(
      `${tag} ⚠️ ${problems.length} ta nomuvofiqlik topildi ` +
        "(avtomatik TUZATILMAYDI — sababi tekshirilishi kerak)",
    );
    for (const problem of problems) {
      logger.error(
        `${tag} ${problem.kind}: ${problem.label} — ` +
          `saqlangan ${problem.stored}, kutilgan ${problem.expected}`,
      );
    }
  }

  return { checked, problems };
}

/** Cron jobni belgilaydi. Har kuni 03:20 (Asia/Tashkent). */
function startInventoryReconcileCron() {
  cron.schedule(
    "20 3 * * *",
    branchCron("[InventoryReconcileCron]", async (branch) => {
      try {
        await runInventoryReconcilePass();
      } catch (error) {
        logger.error(`[InventoryReconcile] ${branch.name}: cron xatosi`, error);
      }
    }),
    { scheduled: true, timezone: "Asia/Tashkent" },
  );

  logger.info(
    "Inventar tekshiruv cron job belgilandi: Har kuni 03:20 (Asia/Tashkent)",
  );
}

module.exports = { startInventoryReconcileCron, runInventoryReconcilePass };
