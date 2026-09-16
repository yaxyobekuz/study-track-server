#!/usr/bin/env node
/**
 * OYLIK POLIDAN OLDINGI XARAJATNI TOZALASH — "hamma xodim shu oydan ish boshladi".
 *
 *     node src/scripts/payroll-clear-before.js 202609             # DRY-RUN (faqat ko'rsatadi)
 *     node src/scripts/payroll-clear-before.js 202609 --set-floor # pol'ni sozlamaga yozadi (dry-run)
 *     node src/scripts/payroll-clear-before.js 202609 --set-floor --apply  # BAJARADI
 *     node src/scripts/payroll-clear-before.js --apply            # pol'ni sozlamadan oladi
 *
 * NIMA UCHUN: tizimga o'tishdan oldingi oylar uchun avtomat shakllantirilgan
 * oylik majburiyatlari (xarajat) qolib ketadi. `firstPayrollMonth` poli
 * KELAJAKDA ularni yaratmaydi, lekin ALLAQACHON yozilganini o'chirmaydi —
 * shu skript o'shalarni tozalaydi. `firstInvoiceMonth` (kirim) ning ko'zgusi.
 *
 * XAVFSIZLIK:
 *   - To'lovsiz majburiyat            → `payroll.cancelEntry` (kassaga tegmaydi).
 *   - To'lov tushgan majburiyat       → avval `salaryPayment.voidPayment`
 *     (taqsimot + majburiyat + KASSA teskari qatori BIRGA qaytadi), so'ng bekor.
 *   - Pol chegarasini KESIB o'tgan to'lov (bir chek ham pol'dan oldingi, ham
 *     keyingi oyni yopgan) → TEGILMAYDI, hisobotda "qo'lda" deb ko'rsatiladi:
 *     uni qaytarish pol'dan KEYINGI oyni ham qarzga qaytarib yuborardi.
 *   - Har amal `@@unique`/CAS himoyasidan o'tadi, idempotent — qayta ishga
 *     tushirilsa ikkinchi marta hech narsa qilmaydi (hammasi allaqachon bekor).
 *
 * ⚠️ `--apply` bo'lmasa BITTA ham qator o'zgarmaydi.
 */

require("dotenv").config();

const prisma = require("../config/prisma");
const platformPrisma = require("../config/platformPrisma");
const { disconnectAll } = require("../config/branchRegistry");
const { forEachBranch } = require("../helpers/branchIterator");
const { getFinanceSettings } = require("../services/settings.service");
const payrollService = require("../services/payroll.service");
const salaryPaymentService = require("../services/salaryPayment.service");
const { parseMonthKey, formatMonthKey } = require("../helpers/month.helpers");
const { Decimal, formatAmount } = require("../helpers/money.helpers");

// Cron/skript aktyori — `createdBy`/`voidedBy` NOT NULL bo'lgan ustunlar uchun.
const SYSTEM_ACTOR_ID = "000000000000000000000000";
const REASON = "Tizimga o'tish: xodimlar oylik boshlanish oyidan ish boshlagan";

const APPLY = process.argv.includes("--apply");
const SET_FLOOR = process.argv.includes("--set-floor");
const argMonth = process.argv.slice(2).find((a) => !a.startsWith("--"));

const line = (msg = "") => console.log(msg);

/**
 * Bitta filialni tozalaydi.
 * @param {number} floor - YYYYMM; shu oydan oldingi hamma oylik tozalanadi
 */
async function clearBranch(branch, floor) {
  line(`\n════ FILIAL: ${branch.name} (${branch.code}) — pol ${formatMonthKey(floor)} ════`);

  // Pol'ni sozlamaga yozish (kelajakdagi generatsiyani to'sadi)
  if (SET_FLOOR) {
    if (APPLY) {
      const settings = await getFinanceSettings();
      await prisma.financeSettings.update({
        where: { id: settings.id },
        data: { firstPayrollMonth: floor },
      });
      line(`   🔧 firstPayrollMonth = ${formatMonthKey(floor)} yozildi`);
    } else {
      line(`   → firstPayrollMonth = ${formatMonthKey(floor)} yoziladi (--apply bilan)`);
    }
  }

  // Pol'dan oldingi, bekor qilinmagan majburiyatlar
  const preEntries = await prisma.payrollEntry.findMany({
    where: { month: { lt: floor }, status: { not: "cancelled" } },
    select: { id: true, month: true, amount: true, paidAmount: true, staffId: true },
    orderBy: [{ month: "asc" }, { id: "asc" }],
  });

  if (preEntries.length === 0) {
    line("   ✅ Pol'dan oldingi oylik majburiyati yo'q — tozalanadigan narsa yo'q");
    return;
  }

  const preIds = new Set(preEntries.map((e) => e.id));
  const totalAmount = preEntries.reduce((s, e) => s.plus(e.amount), new Decimal(0));
  const paidTotal = preEntries.reduce((s, e) => s.plus(e.paidAmount), new Decimal(0));
  line(
    `   Topildi: ${preEntries.length} ta majburiyat, jami ${formatAmount(totalAmount)} ` +
      `(shundan to'langan ${formatAmount(paidTotal)})`,
  );

  // ── 1. To'lovlarni qaytarish ────────────────────────────────────
  // Pol'dan oldingi majburiyatga taqsimlangan har bir CHEK: agar chek FAQAT
  // pol'dan oldingi oylarni yopgan bo'lsa — qaytariladi; pol chegarasini
  // kesib o'tgan bo'lsa — TEGILMAYDI (keyingi oyni buzmaslik uchun).
  const allocs = await prisma.salaryAllocation.findMany({
    where: { isVoided: false, payrollEntryId: { in: [...preIds] } },
    select: { paymentId: true },
    distinct: ["paymentId"],
  });
  const paymentIds = allocs.map((a) => a.paymentId);

  const blockedEntryIds = new Set(); // pol chegarasini kesgan chek yopgan majburiyatlar
  let voidedCount = 0;
  let voidedSum = new Decimal(0);

  for (const paymentId of paymentIds) {
    const pAllocs = await prisma.salaryAllocation.findMany({
      where: { paymentId, isVoided: false },
      include: { payrollEntry: { select: { id: true, month: true } } },
    });

    const spansFloor = pAllocs.some((a) => a.payrollEntry.month >= floor);
    if (spansFloor) {
      // Bu chek pol'dan keyingi oyni ham yopgan — avtomat qaytarilmaydi
      for (const a of pAllocs) {
        if (a.payrollEntry.month < floor) blockedEntryIds.add(a.payrollEntry.id);
      }
      continue;
    }

    const payment = await prisma.salaryPayment.findUnique({
      where: { id: paymentId },
      select: { amount: true },
    });

    if (APPLY) {
      await salaryPaymentService.voidPayment(paymentId, REASON, SYSTEM_ACTOR_ID);
    }
    voidedCount += 1;
    voidedSum = voidedSum.plus(payment?.amount ?? 0);
  }

  line(
    `   To'lov: ${voidedCount} ta chek qaytariladi (${formatAmount(voidedSum)})` +
      (blockedEntryIds.size
        ? `, ${blockedEntryIds.size} ta majburiyat pol'ni kesgan chek bilan bog'liq — QO'LDA`
        : ""),
  );

  // ── 2. Majburiyatlarni bekor qilish ─────────────────────────────
  // To'lov qaytarilgach majburiyatlar yana to'lovsiz bo'ladi; bloklanganlar
  // (pol'ni kesgan chek) o'z holicha qoldiriladi.
  let cancelled = 0;
  let cancelSkipped = 0;

  for (const entry of preEntries) {
    if (blockedEntryIds.has(entry.id)) {
      cancelSkipped += 1;
      continue;
    }
    if (!APPLY) {
      cancelled += 1; // dry-run: nechta bekor qilinishini sanaymiz
      continue;
    }
    try {
      await payrollService.cancelEntry(entry.id, REASON, SYSTEM_ACTOR_ID);
      cancelled += 1;
    } catch (err) {
      // To'lov hali bog'liq bo'lsa (bloklangan) — o'tkazamiz
      cancelSkipped += 1;
      line(`   ⚠️ ${entry.id} bekor qilinmadi: ${err.message}`);
    }
  }

  line(
    `   Majburiyat: ${cancelled} ta bekor qilin${APPLY ? "di" : "adi"}` +
      (cancelSkipped ? `, ${cancelSkipped} ta qo'lda ko'rib chiqiladi` : ""),
  );

  // ── 3. Yakuniy holat ────────────────────────────────────────────
  if (APPLY) {
    const remaining = await prisma.payrollEntry.aggregate({
      where: { month: { lt: floor }, status: { not: "cancelled" } },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const remAmount = remaining._sum.amount ?? 0;
    line(
      `   ✅ Pol'dan oldin qolgan aktiv majburiyat: ${remaining._count._all} ta ` +
        `(${formatAmount(remAmount)})` +
        (remaining._count._all === 0 ? " — TOZA" : " — qo'lda ko'rib chiqing"),
    );
  }
}

async function main() {
  line(`\n🧹 OYLIK POLIDAN OLDINGI XARAJATNI TOZALASH`);
  line(APPLY ? "   ⚠️ --apply: O'ZGARISHLAR YOZILADI" : "   DRY-RUN: hech narsa yozilmaydi (--apply bilan bajariladi)");

  await forEachBranch(
    async (branch) => {
      // Pol: argumentdan yoki sozlamadan
      let floor;
      if (argMonth) {
        floor = parseMonthKey(argMonth, "Pol oyi");
      } else {
        const settings = await getFinanceSettings();
        floor = settings.firstPayrollMonth;
      }
      if (!floor) {
        line(`\n   ❌ ${branch.name}: pol berilmagan. Oy argumentini bering yoki avval firstPayrollMonth ni sozlang.`);
        return;
      }
      await clearBranch(branch, floor);
    },
    { label: "[PayrollClear]" },
  );
}

main()
  .catch((error) => {
    console.error("\n💥 Tozalash yiqildi:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectAll().catch(() => {});
    await platformPrisma.$disconnect().catch(() => {});
    line("");
  });
