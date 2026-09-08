#!/usr/bin/env node
/**
 * O'QUVCHILAR SONI TASHXISI — "bir ekranda 507, boshqasida 523".
 *
 *     node src/scripts/diagnose-student-count.js            # joriy oy
 *     node src/scripts/diagnose-student-count.js 202609     # tanlangan oy
 *     node src/scripts/diagnose-student-count.js --fix      # topilganini tuzatadi
 *
 * NIMA UCHUN KERAK: dashboarddagi har bir raqam O'Z manbaidan chiqadi va
 * ular BOSHQA-BOSHQA savolga javob beradi:
 *
 *   "Sinflar bo'yicha natija" jadvali → `StudentEnrollment` (shu oy bilan
 *      KESISHGAN davr — 3-sentabrda ketgan ham, 20-sentabrda kelgan ham
 *      shu oyda o'qigan)
 *   "Baholar taqsimoti" halqasi      → shu oyda KAMIDA BITTA bahosi bor
 *      o'quvchilar
 *   O'quvchilar ro'yxati              → `User` (arxivlanmagan)
 *   Hisob-faktura generatori          → `User` (arxivlanmagan) ∩ davr
 *
 * Farq har doim shu to'rttasining kesishmasidan chiqadi. Skript ularni
 * yonma-yon qo'yadi va FARQNI TASHKIL QILGAN o'quvchilarni nomma-nom
 * ko'rsatadi, shuning uchun "qaysi raqam noto'g'ri" degan savol
 * "qaysi o'quvchi ortiqcha" degan tekshirib bo'ladigan savolga aylanadi.
 *
 * ⚠️ ODATDA FAQAT O'QIYDI. Bitta ham qator yozilmaydi.
 *
 * `--fix` bilan ishga tushirilganda YAGONA amal bajariladi: ARXIVLANGAN
 * o'quvchining ochiq qolgan o'qish davri arxivlangan sanasida yopiladi.
 * Bu `enrollment:backfill` o'rnatgan invariantni tiklaydi (arxivlangan →
 * davri yopiq) va `user.service.js` dagi `archiveUser` tuzatilishidan
 * OLDIN arxivlanganlar uchun kerak. Boshqa hech narsaga tegilmaydi.
 */

require("dotenv").config();

const prisma = require("../config/prisma");
const platformPrisma = require("../config/platformPrisma");
const { disconnectAll } = require("../config/branchRegistry");
const { forEachBranch } = require("../helpers/branchIterator");
const {
  currentMonthKey,
  parseMonthKey,
  formatMonthKey,
  monthStartDate,
  monthEndDate,
} = require("../helpers/month.helpers");
const { ROLES } = require("../utils/constants");

/** Ro'yxatda nechta ismgacha chiqariladi — konsol to'lib ketmasligi uchun. */
const NAME_LIMIT = 40;

/** `--fix` — yagona yozadigan rejim (yuqoridagi izohga qarang). */
const FIX = process.argv.includes("--fix");

const line = (msg = "") => console.log(msg);
const step = (msg) => console.log(`\n── ${msg} ${"─".repeat(Math.max(0, 58 - msg.length))}`);
const row = (label, value, note = "") =>
  console.log(`   ${label.padEnd(42)} ${String(value).padStart(6)}${note ? `   ${note}` : ""}`);

/** `academicDashboard.service.js` dagi bilan AYNI mantiq (nusxa emas, ko'zgu). */
const levelOfClassName = (name) => {
  const match = String(name ?? "").match(/\d+/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) && value > 0 && value <= 11 ? value : null;
};

const LEVELS = [
  { key: "1-4", label: "1-4 sinflar", from: 1, to: 4 },
  { key: "5-6", label: "5-6 sinflar", from: 5, to: 6 },
  { key: "7-8", label: "7-8 sinflar", from: 7, to: 8 },
  { key: "9-11", label: "9-11 sinflar", from: 9, to: 11 },
];

const levelKeyOf = (level) => {
  if (level == null) return "other";
  const group = LEVELS.find((r) => level >= r.from && level <= r.to);
  return group ? group.key : "other";
};

const nameOf = (u) =>
  [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() || u?.username || "Noma'lum";

const printNames = (users) => {
  for (const u of users.slice(0, NAME_LIMIT)) {
    const flags = [
      u.isArchived ? "ARXIV" : null,
      u.isActive === false ? "nofaol" : null,
      u.classLabel ? `sinf: ${u.classLabel}` : "SINFSIZ",
      u.endLabel,
    ]
      .filter(Boolean)
      .join(" | ");
    line(`      • ${nameOf(u).padEnd(28)} ${u.username ?? ""}  ${flags}`);
  }
  if (users.length > NAME_LIMIT) {
    line(`      … va yana ${users.length - NAME_LIMIT} ta`);
  }
};

/**
 * Arxivlangan o'quvchining ochiq davrini arxivlangan sanasida yopadi.
 *
 * ⚠️ Sana `archivedAt` dan olinadi, bugundan emas: dashboard o'tgan oy
 * uchun ham so'raladi va bugungi sana bilan yopilgan davr o'sha oylarda
 * o'quvchini yana "o'qigan" qilib ko'rsatardi.
 */
async function closeArchivedPeriods(studentIds) {
  let closed = 0;

  for (const studentId of studentIds) {
    const [user, periods] = await Promise.all([
      prisma.user.findUnique({ where: { id: studentId }, select: { archivedAt: true } }),
      prisma.studentEnrollment.findMany({
        where: { studentId, endDate: null },
        select: { id: true, startDate: true },
      }),
    ]);

    const archivedAt = user?.archivedAt ?? new Date();
    const day = new Date(
      Date.UTC(archivedAt.getUTCFullYear(), archivedAt.getUTCMonth(), archivedAt.getUTCDate()),
    );

    for (const period of periods) {
      await prisma.studentEnrollment.update({
        where: { id: period.id },
        data: {
          endDate: period.startDate > day ? period.startDate : day,
          endReason: "left",
          reason: "Arxivlangan o'quvchining davri keyinchalik yopildi",
        },
      });
      closed += 1;
    }
  }

  return closed;
}

async function diagnose(branch, month) {
  const gte = monthStartDate(month);
  const lte = new Date(monthEndDate(month).getTime() + 86400000 - 1);
  const today = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
  );

  line(`\n════ FILIAL: ${branch.name} (${branch.code}) — ${formatMonthKey(month)} ════`);

  // ── 1. Manbalar ──────────────────────────────────────────────────
  const [enrollRows, allStudents, gradeRows, invoiceRows, classRows] = await Promise.all([
    // Dashboard "Sinflar bo'yicha natija" nimani sanaydi
    prisma.studentEnrollment.findMany({
      where: { startDate: { lte }, OR: [{ endDate: null }, { endDate: { gte } }] },
      select: { studentId: true, startDate: true, endDate: true, endReason: true },
      orderBy: { startDate: "asc" },
    }),
    prisma.user.findMany({
      where: { role: ROLES.STUDENT },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        username: true,
        isActive: true,
        isArchived: true,
        classes: { select: { classId: true } },
      },
    }),
    prisma.grade.groupBy({ by: ["studentId"], where: { date: { gte, lte } }, _count: { _all: true } }),
    prisma.monthlyInvoice.findMany({
      where: { month, status: { not: "cancelled" } },
      select: { studentId: true },
      distinct: ["studentId"],
    }),
    prisma.class.findMany({ select: { id: true, name: true } }),
  ]);

  const classNames = new Map(classRows.map((c) => [c.id, c.name]));
  const userById = new Map(allStudents.map((u) => [u.id, u]));

  // Bir o'quvchida bir oyda bir nechta davr bo'lishi mumkin — eng kechgisi
  // "hozir qanday holatda" degan savolga javob beradi
  const periodOf = new Map();
  for (const e of enrollRows) periodOf.set(e.studentId, e);

  const studyingIds = [...periodOf.keys()];
  const gradedIds = new Set(gradeRows.map((r) => r.studentId));
  const invoicedIds = new Set(invoiceRows.map((r) => r.studentId));

  // ── 2. To'rt raqam yonma-yon ─────────────────────────────────────
  step("1. Ekrandagi raqamlar qayerdan chiqadi");
  row("Davr bo'yicha (sinflar jadvali, KPI)", studyingIds.length, "← StudentEnrollment");
  row("Bahosi bor (baholar taqsimoti halqasi)", gradedIds.size, "← Grade");
  row("Hisob-faktura yozilgan", invoicedIds.size, "← MonthlyInvoice");
  row("Ro'yxatdagi o'quvchi (arxivlanmagan)", allStudents.filter((u) => !u.isArchived).length, "← User");
  row("Ro'yxatdagi o'quvchi (arxiv bilan)", allStudents.length, "← User");

  // ── 3. Davr bo'yicha sanoqning tarkibi ───────────────────────────
  step("2. Davr bo'yicha sanoq NIMADAN iborat");

  const decorate = (id) => {
    const u = userById.get(id);
    const period = periodOf.get(id);
    const classId = u?.classes?.[0]?.classId;
    return {
      ...(u ?? { id }),
      classLabel: classId ? classNames.get(classId) ?? classId : null,
      endLabel: period?.endDate
        ? `davr yopilgan: ${period.endDate.toISOString().slice(0, 10)}`
        : null,
    };
  };

  const missingUser = studyingIds.filter((id) => !userById.has(id)).map(decorate);
  const archived = studyingIds.filter((id) => userById.get(id)?.isArchived).map(decorate);
  const leftMidMonth = studyingIds
    .filter((id) => {
      const end = periodOf.get(id)?.endDate;
      return end && end < today;
    })
    .map(decorate);
  const noClass = studyingIds
    .filter((id) => (userById.get(id)?.classes?.length ?? 0) === 0)
    .map(decorate);
  const noGrade = studyingIds.filter((id) => !gradedIds.has(id)).map(decorate);
  const noInvoice = studyingIds.filter((id) => !invoicedIds.has(id)).map(decorate);

  row("Jami (davr bo'yicha)", studyingIds.length);
  row("  ├ ARXIVLANGAN — davri yopilmagan", archived.length, archived.length ? "⚠️ ORTIQCHA" : "");
  row("  ├ Shu oyda ketgan (davri yopilgan)", leftMidMonth.length, "qoida bo'yicha sanaladi");
  row("  ├ Sinfga biriktirilmagan", noClass.length, "→ «Boshqa sinflar» qatori");
  row("  ├ User qatori yo'q (yetim davr)", missingUser.length, missingUser.length ? "⚠️" : "");
  row("  ├ Shu oyda bahosi yo'q", noGrade.length, "halqadagi farq shu");
  row("  └ Hisob-fakturasi yo'q", noInvoice.length);

  if (archived.length) {
    line(`\n   ⚠️ ARXIVLANGAN, LEKIN DAVRI OCHIQ (${archived.length} ta) — dashboardda`);
    line(`      o'qiyapti deb sanaladi, hisob-fakturada esa yo'q:`);
    printNames(archived);

    if (FIX) {
      const closed = await closeArchivedPeriods(archived.map((u) => u.id));
      line(`\n   🔧 ${closed} ta davr arxivlangan sanada yopildi.`);
    } else {
      line(`\n   → Tuzatish: node src/scripts/diagnose-student-count.js --fix`);
    }
  }

  if (missingUser.length) {
    line(`\n   ⚠️ DAVRI BOR, LEKIN USER QATORI YO'Q (${missingUser.length} ta):`);
    printNames(missingUser);
  }

  if (noGrade.length) {
    line(`\n   Halqa (bahosi bor) bilan jadval (davr) farqi — ${noGrade.length} ta o'quvchi:`);
    printNames(noGrade);
  }

  // ── 4. Bosqichlar kesimi ─────────────────────────────────────────
  step("3. Bosqichlar kesimi (1-4 / 5-6 / 7-8 / 9-11 / boshqa)");

  // ⚠️ Dashboard bilan bir xil qoida: HAR O'QUVCHI FAQAT BITTA sinfda
  // sanaladi (kalit bo'yicha eng kichigi), sinfsizlar «Boshqa» ga tushadi.
  const buckets = new Map();
  const bump = (key) => buckets.set(key, (buckets.get(key) ?? 0) + 1);

  for (const id of studyingIds) {
    const links = userById.get(id)?.classes ?? [];
    if (links.length === 0) {
      bump("other");
      continue;
    }
    const classId = links.map((l) => l.classId).sort()[0];
    bump(levelKeyOf(levelOfClassName(classNames.get(classId))));
  }

  let sum = 0;
  for (const level of [...LEVELS, { key: "other", label: "Boshqa sinflar" }]) {
    const count = buckets.get(level.key) ?? 0;
    sum += count;
    row(level.label, count);
  }
  row("JAMI", sum, sum === studyingIds.length ? "✅ yuqoridagi jami bilan teng" : "⚠️ TENG EMAS");

  // Sinf nomidan bosqich noto'g'ri o'qilgan bo'lsa — darhol ko'rinsin
  step("4. Sinf nomi → bosqich (nomdan o'qilgan raqam)");
  const classCounts = new Map();
  for (const id of studyingIds) {
    const links = userById.get(id)?.classes ?? [];
    if (!links.length) continue;
    const classId = links.map((l) => l.classId).sort()[0];
    classCounts.set(classId, (classCounts.get(classId) ?? 0) + 1);
  }
  for (const c of classRows.sort((a, b) => a.name.localeCompare(b.name))) {
    const level = levelOfClassName(c.name);
    const key = levelKeyOf(level);
    const count = classCounts.get(c.id) ?? 0;
    if (count === 0 && level != null) continue;
    row(
      `${c.name}  →  ${level ?? "raqam o'qilmadi"} (${key})`,
      count,
      key === "other" ? "⚠️ «Boshqa sinflar» ga tushadi" : "",
    );
  }

  // Ikki sinfga biriktirilganlar — jimgina bitta sinfda sanaladi
  const multiClass = studyingIds.filter((id) => (userById.get(id)?.classes?.length ?? 0) > 1);
  if (multiClass.length) {
    line(`\n   ⚠️ IKKI YOKI UNDAN ORTIQ SINFDA (${multiClass.length} ta) — kesimda faqat`);
    line(`      bittasida sanaladi (jami to'g'ri qoladi, sinf ustuni kam ko'rsatadi):`);
    printNames(multiClass.map(decorate));
  }
}

async function main() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const month = arg ? parseMonthKey(arg, "Oy") : currentMonthKey();

  console.log(`\n🔎 O'QUVCHILAR SONI TASHXISI — ${formatMonthKey(month)}`);
  if (FIX) console.log("   ⚠️ --fix: arxivlangan o'quvchilarning ochiq davrlari YOPILADI");

  await forEachBranch((branch) => diagnose(branch, month), { label: "[StudentCount]" });
}

main()
  .catch((error) => {
    console.error("\n💥 Tashxis yiqildi:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectAll().catch(() => {});
    await platformPrisma.$disconnect().catch(() => {});
    console.log("");
  });
