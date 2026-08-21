#!/usr/bin/env node
/**
 * FILIALLASHTIRISHGA O'TISH — BIR MARTALIK skript.
 *
 *     npm run branch:bootstrap
 *
 * Mavjud baza QAYTA NOMLANMAYDI, KO'CHIRILMAYDI va TEGILMAYDI: u shundayligicha
 * "Bosh filial" bo'lib qoladi (schema nomi ham o'zgarmaydi — `public`). Faqat
 * BARCHA FILIALLARGA UMUMIY jadvallar yangi `platform` schema'siga nusxalanadi.
 *
 * Qadamlar:
 *   1. CREATE SCHEMA platform + platforma migratsiyalari
 *   2. Reyestrga "Bosh filial" (schemaName = joriy schema, isDefault = true)
 *   3. Umumiy jadvallarni platformaga NUSXALASH (INSERT ... SELECT)
 *   4. `user_directory` ni `users` dan qurish (login yo'naltirgichi)
 *   5. `telegram_directory` ni `tg_users` dan qurish (bot uchun)
 *   6. TEKSHIRUV — sanoqlar solishtiriladi
 *   7. Faqat tekshiruv o'tsa: eski nusxani bo'shatish (TRUNCATE)
 *
 * IDEMPOTENT: qayta ishga tushirilsa mavjud qatorlarni o'tkazib yuboradi
 * (`ON CONFLICT DO NOTHING`), ya'ni yarim bajarilgan urinishdan keyin
 * shunchaki qaytadan yugurtirish kifoya.
 *
 * 7-qadamdan KEYIN `npm run branch:migrate` ni ishga tushiring — u eski
 * jadvallarni butunlay tashlaydi. Tartib ATAYLAB ikkiga bo'lingan:
 * tasdiqlanmagan ko'chirish qaytarib bo'lmas DROP bilan bir qadamda
 * bo'lmasligi kerak.
 */

require("dotenv").config();

const readline = require("readline");
const { validateEnv, config } = require("../../config/env.config");

validateEnv();

const { PrismaClient } = require("../../generated/prisma");
const { buildSchemaUrl, assertSafeSchemaName } = require("../../helpers/schemaUrl.helpers");

// Ko'chiriladigan jadvallar va ularning ustunlari.
// Ustunlar ANIQ sanab o'tiladi: `SELECT *` ustunlar tartibiga bog'lanib
// qolardi va kelajakdagi migratsiya buni jimgina buzardi.
const SHARED_TABLES = [
  {
    name: "roles",
    columns: [
      "id", "name", "value", "is_system", "permissions",
      "work_start_time", "work_end_time", "work_days", "weekly_schedule",
      "created_by", "created_at", "updated_at",
    ],
  },
  {
    name: "tariffs",
    columns: [
      "id", "name", "description", "currency", "is_active", "is_archived",
      "archived_at", "created_by", "created_at", "updated_at",
    ],
  },
  {
    name: "tariff_versions",
    columns: [
      "id", "tariff_id", "start_month", "end_month", "monthly_amount",
      "created_by", "created_at", "updated_at",
    ],
  },
  {
    name: "discounts",
    columns: [
      "id", "name", "description", "type", "value", "is_exclusive",
      "is_active", "is_archived", "archived_at", "created_by",
      "created_at", "updated_at",
    ],
    // `type` — enum. Manba va manzil schema'larida bir xil nomli, lekin
    // BOSHQA tip, shuning uchun matn orqali o'tkaziladi.
    casts: { type: '"DiscountType"' },
  },
  {
    name: "changelogs",
    columns: [
      "id", "panel", "date", "seq", "version", "major", "minor", "patch",
      "bump", "title", "items", "notes", "source_file", "created_by",
      "created_at", "updated_at",
    ],
    casts: { panel: '"ChangelogPanel"', bump: '"ChangelogBump"' },
  },
  {
    name: "changelog_settings",
    columns: [
      "id", "daily_enabled", "send_time", "weekly_enabled", "recipients",
      "last_daily_sent_date", "last_daily_sent_at", "last_weekly_sent_at",
      "updated_by", "created_at", "updated_at",
    ],
  },
  {
    name: "changelog_notifications",
    columns: [
      "id", "kind", "status", "coverage_date", "coverage_from", "coverage_to",
      "chat_id", "label", "entry_count", "message_count", "error_message",
      "sent_by", "created_at",
    ],
    casts: {
      kind: '"ChangelogNotificationKind"',
      status: '"ChangelogNotificationStatus"',
    },
  },
];

// TRUNCATE tartibi — FK bo'yicha bolalardan boshlab
const TRUNCATE_ORDER = [
  "tariff_versions",
  "tariffs",
  "discounts",
  "changelog_notifications",
  "changelog_settings",
  "changelogs",
  "roles",
];

const log = (msg) => console.log(msg);
const step = (n, msg) => console.log(`\n[${n}] ${msg}`);

/** `DATABASE_URL` dagi joriy schema nomi (odatda `public`). */
function currentSchemaName() {
  const url = new URL(config.databaseUrl);
  return url.searchParams.get("schema") || "public";
}

/** Ha/yo'q so'roq (`--yes` bilan o'tkazib yuboriladi). */
function confirm(question) {
  if (process.argv.includes("--yes")) return Promise.resolve(true);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} (ha/yo'q): `, (answer) => {
      rl.close();
      resolve(/^(ha|h|yes|y)$/i.test(answer.trim()));
    });
  });
}

/** Jadval mavjudmi? */
async function tableExists(client, schema, table) {
  const rows = await client.$queryRawUnsafe(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    `${schema}.${table}`,
  );
  return rows[0]?.present === true;
}

/** Qatorlar soni. */
async function countRows(client, schema, table) {
  const rows = await client.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "${schema}"."${table}"`,
  );
  return rows[0]?.n ?? 0;
}

async function main() {
  const legacySchema = assertSafeSchemaName(currentSchemaName());
  const platformSchema = assertSafeSchemaName(config.platformSchema);

  log("\n═══ Filiallashtirishga o'tish ═══");
  log(`  Mavjud schema  : ${legacySchema}  → "Bosh filial"`);
  log(`  Platforma      : ${platformSchema}  (yangi)`);

  // Xom client — DDL va cross-schema SQL uchun. Prisma modellari EMAS,
  // chunki bu bosqichda ikkala schema ham "yarim" holatda bo'lishi mumkin.
  const raw = new PrismaClient({
    datasourceUrl: buildSchemaUrl(config.databaseUrl, legacySchema, {
      connectionLimit: 1,
    }),
  });

  // ── 1. Platforma schema'si ────────────────
  step(1, "Platforma schema'si va migratsiyalari");
  await raw.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${platformSchema}"`);
  log(`  ✔ CREATE SCHEMA ${platformSchema}`);

  const { spawnSync } = require("child_process");
  const path = require("path");
  const deploy = spawnSync(
    "npx",
    ["prisma", "migrate", "deploy", "--schema=prisma/platform/schema.prisma"],
    {
      cwd: path.join(__dirname, "..", "..", ".."),
      shell: true,
      encoding: "utf8",
      env: { ...process.env, PLATFORM_DATABASE_URL: config.platformDatabaseUrl },
    },
  );

  if (deploy.status !== 0) {
    console.error(deploy.stdout || "");
    console.error(deploy.stderr || "");
    throw new Error("Platforma migratsiyasi xato bilan tugadi");
  }
  log("  ✔ Platforma migratsiyalari qo'llandi");

  // Endi platforma modellari bilan ishlash mumkin
  const platformPrisma = require("../../config/platformPrisma");

  // ── 2. Bosh filialni ro'yxatga olish ──────
  step(2, "\"Bosh filial\" reyestrga yozilmoqda");

  let mainBranch = await platformPrisma.branch.findFirst({
    where: { schemaName: legacySchema },
  });

  if (mainBranch) {
    log(`  · Allaqachon bor: ${mainBranch.name} (${mainBranch.code})`);
  } else {
    mainBranch = await platformPrisma.branch.create({
      data: {
        code: "bosh",
        name: "Bosh filial",
        shortName: "Bosh",
        schemaName: legacySchema,
        status: "ready",
        isDefault: true,
        isActive: true,
        sortOrder: 0,
      },
    });
    log(`  ✔ Yaratildi: ${mainBranch.name} → schema "${legacySchema}"`);
  }

  // ── 3. Umumiy jadvallarni nusxalash ───────
  step(3, "Umumiy kataloglar platformaga nusxalanmoqda");

  const report = [];

  for (const table of SHARED_TABLES) {
    const present = await tableExists(raw, legacySchema, table.name);
    if (!present) {
      log(`  · ${table.name}: eski schema'da yo'q — o'tkazib yuborildi`);
      report.push({ table: table.name, source: 0, target: null, skipped: true });
      continue;
    }

    const source = await countRows(raw, legacySchema, table.name);

    const cols = table.columns.map((c) => `"${c}"`).join(", ");
    const selectCols = table.columns
      .map((c) => {
        const cast = table.casts?.[c];
        // Enum → text → manzil enum'i. Ikki schema'da bir xil nomli, lekin
        // BOSHQA tip: to'g'ridan-to'g'ri INSERT tip xatosini berardi.
        return cast
          ? `"${c}"::text::"${platformSchema}".${cast}`
          : `"${c}"`;
      })
      .join(", ");

    // ON CONFLICT DO NOTHING — idempotentlik: qayta ishga tushirish
    // dublikat bermaydi.
    const inserted = await raw.$executeRawUnsafe(
      `INSERT INTO "${platformSchema}"."${table.name}" (${cols})
       SELECT ${selectCols} FROM "${legacySchema}"."${table.name}"
       ON CONFLICT DO NOTHING`,
    );

    const target = await countRows(raw, platformSchema, table.name);
    log(`  ✔ ${table.name}: manba ${source}, platformada ${target} (${inserted} ta yangi)`);
    report.push({ table: table.name, source, target, skipped: false });
  }

  // ── 4. Login yo'naltirgichi ───────────────
  step(4, "Login yo'naltirgichi (user_directory) qurilmoqda");

  const userInserted = await raw.$executeRawUnsafe(
    `INSERT INTO "${platformSchema}"."user_directory"
       (id, username, branch_id, role, first_name, last_name, is_active, is_archived, created_at, updated_at)
     SELECT u.id, u.username, $1, u.role,
            u.first_name, COALESCE(u.last_name, ''),
            u.is_active, u.is_archived, u.created_at, u.updated_at
       FROM "${legacySchema}"."users" u
     ON CONFLICT (id) DO NOTHING`,
    mainBranch.id,
  );

  const usersSource = await countRows(raw, legacySchema, "users");
  const dirTarget = await countRows(raw, platformSchema, "user_directory");
  log(`  ✔ users ${usersSource} → user_directory ${dirTarget} (${userInserted} ta yangi)`);

  // ── 5. Telegram yo'naltirgichi ────────────
  step(5, "Telegram yo'naltirgichi (telegram_directory) qurilmoqda");

  const tgExists = await tableExists(raw, legacySchema, "tg_users");
  let tgSource = 0;
  let tgTarget = 0;

  if (tgExists) {
    const tgInserted = await raw.$executeRawUnsafe(
      `INSERT INTO "${platformSchema}"."telegram_directory"
         (telegram_id, branch_id, student_id, created_at, updated_at)
       SELECT t.telegram_id, $1, t.student, t.created_at, t.updated_at
         FROM "${legacySchema}"."tg_users" t
       ON CONFLICT (telegram_id) DO NOTHING`,
      mainBranch.id,
    );
    tgSource = await countRows(raw, legacySchema, "tg_users");
    tgTarget = await countRows(raw, platformSchema, "telegram_directory");
    log(`  ✔ tg_users ${tgSource} → telegram_directory ${tgTarget} (${tgInserted} ta yangi)`);
  } else {
    log("  · tg_users jadvali yo'q — o'tkazib yuborildi");
  }

  // ── 6. Tekshiruv ──────────────────────────
  step(6, "Tekshiruv");

  const problems = [];

  for (const row of report) {
    if (row.skipped) continue;
    if (row.target < row.source) {
      problems.push(
        `${row.table}: manbada ${row.source}, platformada ${row.target}`,
      );
    }
  }
  if (dirTarget < usersSource) {
    problems.push(`user_directory: users ${usersSource}, yo'naltirgichda ${dirTarget}`);
  }
  if (tgExists && tgTarget < tgSource) {
    problems.push(`telegram_directory: tg_users ${tgSource}, yo'naltirgichda ${tgTarget}`);
  }

  if (problems.length) {
    console.error("\n[XATO] Sanoqlar mos kelmadi:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      "\nEski nusxa BO'SHATILMADI. Sababni aniqlab, skriptni qayta ishga tushiring.\n",
    );
    await raw.$disconnect();
    await platformPrisma.$disconnect();
    process.exitCode = 1;
    return;
  }

  log("  ✔ Barcha sanoqlar mos");

  // ── 7. Eski nusxani bo'shatish ────────────
  step(7, "Eski nusxani bo'shatish");
  log("  Quyidagi jadvallar BO'SHATILADI (ma'lumot platformada saqlanib qoldi):");
  for (const t of TRUNCATE_ORDER) log(`    - ${legacySchema}.${t}`);

  const ok = await confirm("\n  Davom etamizmi?");
  if (!ok) {
    log(
      "\n  Bo'shatilmadi. Keyinroq shu skriptni qayta ishga tushiring — " +
        "nusxalash idempotent.\n",
    );
    await raw.$disconnect();
    await platformPrisma.$disconnect();
    return;
  }

  const existing = [];
  for (const t of TRUNCATE_ORDER) {
    if (await tableExists(raw, legacySchema, t)) existing.push(`"${legacySchema}"."${t}"`);
  }

  if (existing.length) {
    await raw.$executeRawUnsafe(`TRUNCATE ${existing.join(", ")} CASCADE`);
    log(`  ✔ ${existing.length} ta jadval bo'shatildi`);
  }

  await raw.$disconnect();
  await platformPrisma.$disconnect();

  log("\n═══ Tayyor ═══");
  log("  Keyingi qadam:  npm run branch:migrate");
  log("  (eski, bo'shatilgan jadvallarni butunlay tashlaydi)\n");
}

main().catch((error) => {
  console.error("\n[XATO]", error.message, "\n");
  process.exit(1);
});
