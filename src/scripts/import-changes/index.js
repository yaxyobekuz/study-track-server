/**
 * changes/*.md → PostgreSQL (changelogs jadvali)
 *
 * Monorepo ildizidagi `changes/` papkasidagi markdown fayllarni o'qib, bazaga
 * yozadi. `/changelog` slash-buyrug'i shu scriptni chaqiradi.
 *
 * IDEMPOTENT: kalit `(date, panel)`. Qayta ishga tushirilsa dublikat
 * yaratmaydi — mavjud yozuvning MATNI yangilanadi, VERSIYASI saqlanadi.
 *
 * Ishga tushirish:
 *   npm run changes:import                    -- barcha `status: draft` fayllar
 *   npm run changes:import -- --all           -- `status` ga qaramay hammasi
 *   npm run changes:import -- --date=2026-08-17
 *   npm run changes:import -- --dry-run       -- bazaga tegmaydi
 *   npm run changes:import -- --yes           -- tasdiq so'ramaydi
 *
 * BAZA: `CHANGELOG_DATABASE_URL` bo'lsa o'sha, aks holda `DATABASE_URL`.
 * Ish boshlashdan oldin qaysi bazaga yozilishi ko'rsatiladi va tasdiq so'raladi
 * — local bazaga adashib yozib yuborilmasligi uchun.
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const {
  parseChangelogFile,
  updateFrontmatter,
} = require("../../helpers/changelogMarkdown.helpers");

// server/src/scripts/import-changes → monorepo ildizi
const CHANGES_DIR = path.resolve(__dirname, "../../../../changes");

// "2026-08-17-admin.md" va bir kundagi keyingi relizlar: "2026-08-17-admin-2.md"
const FILE_RE = /^\d{4}-\d{2}-\d{2}-[a-z]+(?:-\d+)?\.md$/;

// ─────────────────────────────────────────────
// Argumentlar
// ─────────────────────────────────────────────

function parseArgs(argv) {
  const options = { all: false, dryRun: false, yes: false, date: null };

  for (const arg of argv) {
    if (arg === "--all") options.all = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg.startsWith("--date=")) options.date = arg.slice("--date=".length).trim();
    else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) options.date = arg;
  }

  return options;
}

// ─────────────────────────────────────────────
// Baza manzili
// ─────────────────────────────────────────────

/** Connection string'dan parolni olib tashlab, o'qish uchun qulay ko'rinish. */
function describeDatabase(url) {
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//, "") || "(nomsiz)";
    return `${parsed.hostname}:${parsed.port || 5432} / ${database}`;
  } catch {
    return "(manzilni o'qib bo'lmadi)";
  }
}

/**
 * O'zgarishlar tarixi endi PLATFORMA schema'sida (barcha filiallarga umumiy —
 * bitta reliz hamma joyga bir vaqtda yetib boradi). Shuning uchun tanlangan
 * ulanish satrining `schema` parametri `platform` ga o'rnatiladi: sozlamada
 * `?schema=public` turgan bo'lsa ham yozuv to'g'ri joyga tushadi.
 */
function withPlatformSchema(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("schema", process.env.PLATFORM_SCHEMA || "platform");
    return parsed.toString();
  } catch {
    return url;
  }
}

function resolveDatabaseUrl() {
  const override = process.env.CHANGELOG_DATABASE_URL;
  if (override) {
    return {
      url: withPlatformSchema(override),
      source: "CHANGELOG_DATABASE_URL",
    };
  }

  const fallback = process.env.DATABASE_URL;
  if (fallback) {
    return { url: withPlatformSchema(fallback), source: "DATABASE_URL" };
  }

  return null;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ─────────────────────────────────────────────
// Fayllarni o'qish
// ─────────────────────────────────────────────

function collectFiles(options) {
  if (!fs.existsSync(CHANGES_DIR)) {
    console.error(`changes/ papkasi topilmadi: ${CHANGES_DIR}`);
    process.exit(1);
  }

  const names = fs
    .readdirSync(CHANGES_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort();

  const selected = [];
  const failed = [];

  for (const name of names) {
    if (!FILE_RE.test(name)) {
      failed.push({ file: name, error: "Fayl nomi YYYY-MM-DD-<panel>.md ko'rinishida emas" });
      continue;
    }

    const fullPath = path.join(CHANGES_DIR, name);
    const content = fs.readFileSync(fullPath, "utf8");

    let parsed;
    try {
      parsed = parseChangelogFile(name, content);
    } catch (error) {
      failed.push({ file: name, error: error.message });
      continue;
    }

    if (options.date && parsed.dateKey !== options.date) continue;
    if (!options.all && parsed.status === "published") {
      selected.push({ name, fullPath, parsed, skip: true });
      continue;
    }

    selected.push({ name, fullPath, parsed, skip: false });
  }

  // Fayl nomi bo'yicha saralash YETARLI EMAS: "admin-2.md" alifboda
  // "admin.md" dan oldin turadi ("-" < "."), ya'ni 2-reliz 1-relizdan oldin
  // yuklanib, undan past versiya olib qolardi. Sana → panel → reliz raqami.
  selected.sort(
    (a, b) =>
      a.parsed.dateKey.localeCompare(b.parsed.dateKey) ||
      a.parsed.panel.localeCompare(b.parsed.panel) ||
      a.parsed.seq - b.parsed.seq,
  );

  return { selected, failed };
}

// ─────────────────────────────────────────────
// Asosiy oqim
// ─────────────────────────────────────────────

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { selected, failed } = collectFiles(options);

  const pending = selected.filter((item) => !item.skip);
  const skipped = selected.filter((item) => item.skip);

  // Nima yuklanishi
  console.log(`\nchanges/ papkasi: ${CHANGES_DIR}`);
  console.log(`Yuklanadi: ${pending.length} ta fayl` + (options.dryRun ? "  [--dry-run]" : ""));

  for (const item of pending) {
    const { panel, seq, dateKey, bump, title, items } = item.parsed;
    const label = seq > 1 ? `${panel} #${seq}` : panel;
    console.log(
      `  ${dateKey}  ${label.padEnd(11)} ${bump.padEnd(5)} ${items.length} ta o'zgarish  ${title}`,
    );
  }

  for (const item of skipped) {
    console.log(`  ${item.name.padEnd(26)} o'tkazildi  (allaqachon yuklangan)`);
  }

  for (const item of failed) {
    console.log(`  ${item.file.padEnd(26)} XATO — ${item.error}`);
  }

  if (options.dryRun) {
    console.log("\n--dry-run: bazaga hech narsa yozilmadi.");
    if (failed.length > 0) process.exitCode = 1;
    return;
  }

  if (pending.length === 0) {
    console.log(
      skipped.length > 0
        ? "\nYangi fayl yo'q — hammasi allaqachon yuklangan (qayta yuklash uchun --all)."
        : "\nYuklash uchun yaroqli fayl yo'q.",
    );
    if (failed.length > 0) process.exitCode = 1;
    return;
  }

  // Baza manzili — yozishdan OLDIN ko'rsatiladi
  const database = resolveDatabaseUrl();
  if (!database) {
    console.error("\nDATABASE_URL ham, CHANGELOG_DATABASE_URL ham topilmadi.");
    process.exit(1);
  }

  console.log(`\nBaza: ${describeDatabase(database.url)}   (${database.source})`);

  if (!options.yes) {
    const answer = await ask("Shu bazaga yozilsinmi? [ha/yo'q]: ");
    if (!["ha", "h", "y", "yes"].includes(answer)) {
      console.log("Bekor qilindi.");
      return;
    }
  }

  // PrismaClient tanlangan manzil bilan. `changelog.service.js` PLATFORMA
  // client'ini ishlatadi, u esa `config.platformDatabaseUrl` ni REQUIRE
  // PAYTIDA o'qiydi — shuning uchun env o'zgaruvchisi require'dan OLDIN
  // qo'yiladi.
  process.env.PLATFORM_DATABASE_URL = database.url;
  const platformPrisma = require("../../config/platformPrisma");
  const changelogService = require("../../services/changelog.service");

  const report = [];

  // KETMA-KET — parallel bo'lsa bitta panelning fayllari bir xil "eng yuqori
  // versiya"ni o'qib, keraksiz qayta urinishlarga sabab bo'ladi.
  for (const item of pending) {
    try {
      const { action, entry } = await changelogService.upsertFromFile(item.parsed, null);

      const updated = updateFrontmatter(fs.readFileSync(item.fullPath, "utf8"), {
        status: "published",
        version: entry.version,
      });
      fs.writeFileSync(item.fullPath, updated, "utf8");

      report.push({ file: item.name, action, panel: entry.panel, version: entry.version });
    } catch (error) {
      report.push({ file: item.name, action: "error", error: error.message });
    }
  }

  await platformPrisma.$disconnect();

  // Hisobot
  console.log("");
  for (const row of report) {
    if (row.action === "error") {
      console.log(`  ${row.file.padEnd(26)} XATO — ${row.error}`);
    } else {
      const label = row.action === "created" ? "yaratildi" : "yangilandi";
      console.log(`  ${row.file.padEnd(26)} ${label.padEnd(11)} ${row.panel.padEnd(8)} v${row.version}`);
    }
  }

  const created = report.filter((r) => r.action === "created").length;
  const updatedCount = report.filter((r) => r.action === "updated").length;
  const errors = report.filter((r) => r.action === "error").length + failed.length;

  console.log(
    `\nJami: ${created} yaratildi, ${updatedCount} yangilandi, ` +
      `${skipped.length} o'tkazildi, ${errors} xato`,
  );

  if (errors > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Import xatosi:", error);
  process.exit(1);
});
