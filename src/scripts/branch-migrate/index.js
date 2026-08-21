#!/usr/bin/env node
/**
 * MIGRATSIYALARNI PLATFORMA VA BARCHA FILIALLARGA QO'LLAYDI.
 *
 *     npm run branch:migrate
 *
 * Nima uchun alohida skript: `prisma migrate deploy` bitta ulanish satriga
 * qaraydi, filiallar esa N ta schema. Har birini qo'lda yugurtirish esa
 * bittasini unutib qoldirish demak — va unutilgan filial serverni
 * "Migratsiya qo'llanmagan" xatosi bilan to'xtatadi (config/database.js).
 *
 * TARTIB MUHIM: avval platforma (filiallar reyestri o'sha yerda), keyin
 * filiallar. Reyestr o'qilmasa qaysi schema'larga borishni bilib bo'lmaydi.
 *
 * Arxivlangan filiallar HAM migratsiya qilinadi: ularning ma'lumoti hisobot
 * uchun kerak va schema eskirib qolsa keyin o'qib bo'lmasdi.
 */

require("dotenv").config();

const path = require("path");
const { spawn } = require("child_process");

const { validateEnv, config } = require("../../config/env.config");

validateEnv();

const SERVER_ROOT = path.join(__dirname, "..", "..", "..");
const PLATFORM_SCHEMA_PATH = path.join("prisma", "platform", "schema.prisma");

/**
 * `prisma migrate deploy` ni ishga tushiradi va chiqishini oqim bilan
 * ko'rsatadi (uzoq migratsiyada jim turmasin).
 *
 * @param {{schemaPath?: string, databaseUrl?: string, label: string}} options
 * @returns {Promise<void>}
 */
const runDeploy = ({ schemaPath, databaseUrl, label }) =>
  new Promise((resolve, reject) => {
    const args = ["prisma", "migrate", "deploy"];
    if (schemaPath) args.push(`--schema=${schemaPath}`);

    const child = spawn("npx", args, {
      cwd: SERVER_ROOT,
      shell: true, // Windows'da `prisma` — .cmd
      env: {
        ...process.env,
        ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
      },
    });

    let output = "";
    child.stdout.on("data", (d) => (output += d.toString()));
    child.stderr.on("data", (d) => (output += d.toString()));

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        const applied = output.match(/Applying migration `([^`]+)`/g) || [];
        console.log(
          `  ✔ ${label}: ${
            applied.length ? `${applied.length} ta migratsiya qo'llandi` : "yangilik yo'q"
          }`,
        );
        resolve();
      } else {
        console.error(`  ✖ ${label}:\n${output}`);
        reject(new Error(`${label} — migratsiya xato bilan tugadi (${code})`));
      }
    });
  });

async function main() {
  console.log("\n─── Migratsiya: platforma va barcha filiallar ───\n");

  // ── 1. Platforma ──────────────────────────
  await runDeploy({
    schemaPath: PLATFORM_SCHEMA_PATH,
    databaseUrl: config.platformDatabaseUrl,
    label: `platforma (${config.platformSchema})`,
  });

  // Platforma migratsiya qilingandan KEYIN yuklaymiz — undan oldin
  // `branches` jadvali bo'lmasligi mumkin.
  const platformPrisma = require("../../config/platformPrisma");
  const { buildSchemaUrl } = require("../../helpers/schemaUrl.helpers");

  let branches;
  try {
    branches = await platformPrisma.branch.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
  } catch (error) {
    console.error(`\n[XATO] Filiallar reyestri o'qilmadi: ${error.message}`);
    console.error(
      "Yechim: avval \"npm run branch:bootstrap\" ni ishga tushiring.\n",
    );
    process.exitCode = 1;
    await platformPrisma.$disconnect();
    return;
  }

  if (branches.length === 0) {
    console.log(
      "\nReyestrda filial yo'q. \"npm run branch:bootstrap\" mavjud bazani " +
        '"Bosh filial" sifatida ro\'yxatga oladi.\n',
    );
    await platformPrisma.$disconnect();
    return;
  }

  // ── 2. Filiallar ──────────────────────────
  const failed = [];

  for (const branch of branches) {
    // `provisioning` — schema hali yaratilmagan bo'lishi mumkin; uni
    // o'tkazib yuboramiz, `branchProvision` o'zi qo'llaydi.
    if (branch.status === "provisioning") {
      console.log(`  · ${branch.name}: tayyorlanmoqda — o'tkazib yuborildi`);
      continue;
    }

    const url = buildSchemaUrl(config.databaseUrl, branch.schemaName, {
      connectionLimit: 1,
    });

    try {
      await runDeploy({
        databaseUrl: url,
        label: `${branch.name} (${branch.schemaName})`,
      });
    } catch (error) {
      failed.push({ branch, error });
    }
  }

  await platformPrisma.$disconnect();

  console.log("");
  if (failed.length) {
    console.error(`[XATO] ${failed.length} ta filialda migratsiya qo'llanmadi:`);
    for (const { branch, error } of failed) {
      console.error(`  - ${branch.name}: ${error.message}`);
    }
    console.error("");
    process.exitCode = 1;
  } else {
    console.log(`✔ Barchasi tayyor: platforma + ${branches.length} ta filial\n`);
  }
}

main().catch((error) => {
  console.error("\n[XATO]", error.message, "\n");
  process.exit(1);
});
