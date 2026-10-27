#!/usr/bin/env node
/**
 * "BAHO QO'YMASLIK" JARIMALARINI QAYTA TEKSHIRISH (tozalash skripti).
 *
 * Jarima maxraji ilgari NOTO'G'RI edi: sinfdagi HAMMA o'quvchi sanalardi —
 * o'sha kuni kelmagani ham, maktabdan ketib sinfda qolib ketgani ham. Shu
 * sababli hammani baholagan o'qituvchi ham jarima olardi. Maxraj
 * tuzatilgandan keyin (`gradeExpectation.service.js`) eski jarimalarning
 * bir qismi asossiz bo'lib qoladi — bu skript o'shalarni bekor qiladi va
 * ballni qaytaradi.
 *
 * 2026-10-22 dan jarima faqat BITTA HAM baho qo'yilmagan darsga (foiz chegarasi
 * olib tashlangan): eski kunlarni tekshirish darsda kamida bitta bahosi bor
 * jarimalarni ham "Darsga baho qo'yilgan" sababi bilan bekor qiladi.
 *
 * ⚠️ FAQAT BEKOR QILADI, yangi jarima YOZMAYDI: bu tozalash, qayta
 * jarimalash emas. Haqiqatan baho qo'yilmagani joyida qoladi.
 *
 * ⚠️ SUKUT BO'YICHA HECH NARSA YOZILMAYDI (quruq yurish) — `--apply` kerak.
 *
 * ⚠️ HAR FILIAL ALOHIDA ko'riladi (`forEachBranch`).
 *
 * Misollar:
 *   node src/scripts/recheck-grade-penalties.js --from=2026-10-01 --to=2026-10-20
 *   node src/scripts/recheck-grade-penalties.js --from=2026-10-01 --to=2026-10-20 --apply
 */

require("dotenv").config();

const { validateEnv } = require("../config/env.config");

validateEnv();

const platformPrisma = require("../config/platformPrisma");
const prisma = require("../config/prisma");
const { forEachBranch } = require("../helpers/branchIterator");
const { getGradePenaltySettings } = require("../services/settings.service");
const { recheckRange } = require("../services/gradePenalty.service");
const { ROLES } = require("../utils/constants");

function parseArgs(argv) {
  const args = { from: null, to: null, apply: false };

  for (const raw of argv.slice(2)) {
    if (raw === "--apply") args.apply = true;
    else if (raw.startsWith("--from=")) args.from = raw.slice(7).trim();
    else if (raw.startsWith("--to=")) args.to = raw.slice(5).trim();
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.from || !args.to) {
    console.error(
      "Sana oralig'i berilmadi. Misol: --from=2026-10-01 --to=2026-10-20 [--apply]",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Oraliq: ${args.from} … ${args.to} — ${args.apply ? "YOZILADI" : "quruq yurish (--apply yo'q)"}\n`,
  );

  await forEachBranch(
    async (branch) => {
      // Aktyor — owner: jarimani tizim bekor qiladi, odam emas
      const owner = await prisma.user.findFirst({
        where: { role: ROLES.OWNER },
        select: { id: true },
      });
      if (!owner) {
        console.log(`${branch.name}: owner topilmadi — o'tkazib yuborildi`);
        return;
      }

      const settings = await getGradePenaltySettings();
      const report = await recheckRange(args, { actorId: owner.id, settings });

      console.log(
        `${branch.name}: ${report.days} kun, ${report.checked} jarima ko'rildi — ` +
          `${report.kept} ta o'z o'rnida, ${report.cancelled} ta bekor qilinadi` +
          (args.apply ? ` (${report.pointsReturned} ball qaytarildi)` : ""),
      );

      for (const row of report.rows) {
        console.log(`  ${row.day}  ${row.title}  →  ${row.reason}`);
      }
      if (report.rows.length > 0) console.log("");
    },
    { label: "[GradePenaltyRecheck]" },
  );
}

main()
  .catch((error) => {
    console.error("Xato:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await platformPrisma.$disconnect?.();
    process.exit(process.exitCode ?? 0);
  });
