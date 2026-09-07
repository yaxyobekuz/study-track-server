#!/usr/bin/env node
/**
 * YO'NALTIRGICHNI TO'LDIRADI — "profil bor, lekin tizimga kira olmaydi".
 *
 *     node src/scripts/backfill-user-directory.js            # dry-run
 *     node src/scripts/backfill-user-directory.js --apply
 *
 * MUAMMO: login `platform.user_directory` dan boshlanadi (username → qaysi
 * filial). Foydalanuvchi filial bazasiga `userDirectory.claim()` dan
 * O'TMASDAN yozilgan bo'lsa — masalan to'g'ridan-to'g'ri SQL yoki import
 * skripti bilan — u admin panelida ko'rinadi, ro'yxatlarda turadi, lekin
 * login qadamining BIRINCHISIDA yiqiladi va ekranda "Username yoki parol
 * noto'g'ri" chiqadi. Parolning bunga aloqasi yo'q.
 *
 * YECHIM: `userDirectory.sync()` — u yo'naltirgich qatorini ham, uy filiali
 * biriktirishini ham (`user_branch_access`) upsert qiladi. Aynan shu
 * funksiya "filiallashtirishdan oldin yaratilgan foydalanuvchilar" uchun
 * mo'ljallangan lazy migratsiya yo'li.
 *
 * ⚠️ USERNAME TO'QNASHUVI YOZILMAYDI. Username butun tizim bo'yicha yagona:
 * agar u BOSHQA odamga tegishli bo'lsa, skript o'sha qatorni o'tkazib
 * yuboradi va ro'yxatga chiqaradi — jimgina qayta biriktirish ikkinchi
 * odamni tizimdan chiqarib yuborardi.
 */

require("dotenv").config();

const platformPrisma = require("../config/platformPrisma");
const branchService = require("../services/branch.service");
const userDirectory = require("../services/userDirectory.service");
const { getClientForBranch, disconnectAll } = require("../config/branchRegistry");

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(
    `\n🔧 YO'NALTIRGICH TO'LDIRISH — ${APPLY ? "YOZISH REJIMI (--apply)" : "DRY-RUN (hech narsa yozilmaydi)"}\n`,
  );

  const branches = await branchService.list({ includeArchived: true });
  let totalMissing = 0;
  let totalFixed = 0;
  const conflicts = [];

  for (const branch of branches) {
    if (branch.status !== "ready") {
      console.log(`⏭️  ${branch.name}: status=${branch.status}, o'tkazib yuborildi`);
      continue;
    }

    const client = getClientForBranch(branch);
    const users = await client.user.findMany({
      select: {
        id: true,
        username: true,
        role: true,
        firstName: true,
        lastName: true,
        isActive: true,
        isArchived: true,
      },
    });

    // Bitta so'rov bilan: 554 ta foydalanuvchi uchun 554 ta `findUnique`
    // yubormaymiz.
    const existing = await platformPrisma.userDirectory.findMany({
      where: { id: { in: users.map((u) => u.id) } },
      select: { id: true },
    });
    const known = new Set(existing.map((row) => row.id));
    const missing = users.filter((u) => !known.has(u.id));

    console.log(
      `\n── ${branch.name} (${branch.schemaName}) — jami ${users.length}, yo'naltirgichda yo'q ${missing.length}`,
    );
    totalMissing += missing.length;

    for (const user of missing) {
      // Username BOSHQA odamda bo'lsa — tegmaymiz.
      const taken = await userDirectory.findByUsername(user.username);
      if (taken && taken.id !== user.id) {
        conflicts.push({ branch: branch.name, user, takenBy: taken });
        console.log(
          `   ⚠️  ${user.username} — username BOSHQA odamda (${taken.id}, filial ${taken.branchId}); o'tkazib yuborildi`,
        );
        continue;
      }

      if (!APPLY) {
        console.log(`   • ${user.username} (${user.role}) — ${user.firstName} ${user.lastName}`);
        continue;
      }

      try {
        await userDirectory.sync({
          id: user.id,
          username: user.username,
          branchId: branch.id,
          role: user.role,
          firstName: user.firstName,
          lastName: user.lastName ?? "",
          isActive: user.isActive,
          isArchived: user.isArchived,
        });
        totalFixed += 1;
        console.log(`   ✅ ${user.username} (${user.role})`);
      } catch (error) {
        console.log(`   ❌ ${user.username} — ${error.message}`);
      }
    }
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Yo'naltirgichda yo'q edi: ${totalMissing}`);
  if (APPLY) console.log(`Tuzatildi: ${totalFixed}`);
  else if (totalMissing) console.log(`Yozish uchun: --apply bilan qayta ishga tushiring`);
  if (conflicts.length) console.log(`⚠️  Username to'qnashuvi (qo'lda hal qilinadi): ${conflicts.length}`);
  console.log("");
}

main()
  .catch((error) => {
    console.error("\n💥 Yiqildi:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectAll().catch(() => {});
    await platformPrisma.$disconnect().catch(() => {});
  });
