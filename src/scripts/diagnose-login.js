#!/usr/bin/env node
/**
 * LOGIN TASHXISI — "username va parol to'g'ri, lekin tizimga kiritmayapti".
 *
 *     node src/scripts/diagnose-login.js mamajonova
 *     node src/scripts/diagnose-login.js mamajonova 'Ustoz8197'
 *
 * NIMA UCHUN KERAK: `auth.service.login()` UCHTA turli sababni bitta
 * "Username yoki parol noto'g'ri" xabari bilan qaytaradi — ataylab, mavjud
 * login'ni oshkor qilmaslik uchun (`unknown_user`, `branch_unusable`,
 * `bad_password`). Ekranga qarab qaysi biri ekanini bilib bo'lmaydi.
 *
 * Skript LOGIN YO'LINI AYNAN TAKRORLAYDI va har qadamni alohida ko'rsatadi,
 * shuning uchun "qaysi bo'g'inda uzilgan" degan savolga bir marta ishga
 * tushirish bilan javob beradi.
 *
 * ⚠️ FAQAT O'QIYDI. Hech narsa yozilmaydi va parol jurnalga tushmaydi —
 * natijada faqat "mos keldi / kelmadi" ko'rinadi.
 */

require("dotenv").config();

const platformPrisma = require("../config/platformPrisma");
const branchService = require("../services/branch.service");
const userDirectory = require("../services/userDirectory.service");
const { getClientForBranch } = require("../config/branchRegistry");
const { disconnectAll } = require("../config/branchRegistry");
const { matchPassword } = require("../utils/password");

const [, , rawUsername, rawPassword] = process.argv;

const ok = (msg) => console.log(`  ✅ ${msg}`);
const bad = (msg) => console.log(`  ❌ ${msg}`);
const info = (msg) => console.log(`     ${msg}`);
const step = (msg) => console.log(`\n── ${msg} ${"─".repeat(Math.max(0, 56 - msg.length))}`);

async function main() {
  if (!rawUsername) {
    console.error("Foydalanish: node src/scripts/diagnose-login.js <username> [parol]");
    process.exit(1);
  }

  const username = userDirectory.normalize(rawUsername);
  console.log(`\n🔎 LOGIN TASHXISI — "${rawUsername}"`);
  if (username !== rawUsername) {
    info(`normalizatsiya: "${rawUsername}" → "${username}"`);
  }

  // ── 1. Yo'naltirgich: username → qaysi filial? ──────────────────
  step("1. Yo'naltirgich (platform.user_directory)");
  const entry = await platformPrisma.userDirectory.findUnique({
    where: { username },
  });

  if (!entry) {
    bad(`Bu username yo'naltirgichda YO'Q → login "unknown_user" bilan yiqiladi.`);

    // O'xshash yozuvlar — imlo xatosini darhol ko'rsatadi.
    const similar = await platformPrisma.userDirectory.findMany({
      where: { username: { contains: username.slice(0, 5) } },
      select: { username: true, role: true, branchId: true, isArchived: true },
      take: 20,
    });
    if (similar.length) {
      info(`O'xshash username'lar (imlo xatosi bo'lishi mumkin):`);
      for (const row of similar) {
        info(`  • ${row.username} (${row.role}${row.isArchived ? ", arxivlangan" : ""})`);
      }
    }

    // Yo'naltirgichda yo'q, lekin filial bazasida bormi? Bu — YARIM
    // YOZILGAN holat: odam admin panelida ko'rinadi, lekin kira olmaydi.
    await scanBranchesForUsername(username);
    await showAttempts(username);
    return;
  }

  ok(`Topildi — userId=${entry.id}`);
  info(`rol: ${entry.role} | ism: ${entry.firstName} ${entry.lastName}`);
  info(`uy filiali: ${entry.branchId}`);
  if (!entry.isActive) bad(`yo'naltirgichda isActive=false`);
  if (entry.isArchived) bad(`yo'naltirgichda isArchived=true`);

  // ── 2. Filial ishga yaroqlimi? ─────────────────────────────────
  step("2. Filial holati (platform.branches)");
  let branch;
  try {
    branch = await branchService.getUsableById(entry.branchId);
    ok(`"${branch.name}" (${branch.code}) — yaroqli | schema: ${branch.schemaName}`);
  } catch (error) {
    bad(`Filial yaroqsiz: ${error.message} → login "branch_unusable" bilan yiqiladi.`);
    const raw = await platformPrisma.branch.findUnique({ where: { id: entry.branchId } });
    if (raw) {
      info(`status=${raw.status} | isActive=${raw.isActive} | isArchived=${raw.isArchived}`);
    } else {
      info(`Filial qatori umuman topilmadi (id=${entry.branchId}) — yetim yo'naltirgich yozuvi.`);
    }
    await showAttempts(username);
    return;
  }

  // ── 3. Filial bazasida `User` qatori bormi? ────────────────────
  step("3. Filial bazasidagi profil (users)");
  const client = getClientForBranch(branch);
  const user = await client.user.findUnique({
    where: { id: entry.id },
    select: {
      id: true,
      username: true,
      role: true,
      isActive: true,
      isArchived: true,
      password: true,
      plainPassword: true,
    },
  });

  if (!user) {
    bad(
      `"${branch.name}" filialida bu id bilan profil YO'Q → login "bad_password" bilan yiqiladi.`,
    );
    info(`Yo'naltirgich bor, profil yo'q — yarim qolgan yaratish/ko'chirish.`);
    await scanBranchesForUsername(username);
    await showAttempts(username);
    return;
  }

  ok(`Profil topildi — rol: ${user.role}`);
  if (user.username !== username) {
    bad(`Username MOS EMAS: yo'naltirgichda "${username}", filialda "${user.username}"`);
    info(`Login yo'naltirgichdan boradi, ya'ni bu farq o'zi xato emas — lekin belgi.`);
  }
  if (!user.password) {
    bad(`Parol hash'i BO'SH — hech qanday parol mos kelmaydi.`);
  }

  // ── 4. Parol ───────────────────────────────────────────────────
  step("4. Parol");
  if (rawPassword) {
    const matched = user.password
      ? await matchPassword(rawPassword, user.password)
      : false;
    if (matched) {
      ok(`Berilgan parol hash bilan MOS KELDI.`);
    } else {
      bad(`Berilgan parol hash bilan MOS KELMADI → "bad_password".`);
      // Panelda ko'rinadigan parol (plainPassword) hash bilan mos kelmasligi
      // mumkin: admin panel plainPassword'ni ko'rsatadi, login esa hash'ni
      // tekshiradi. Ikkisi ajralib qolgan bo'lsa — aynan shu holat.
      if (user.plainPassword) {
        const panelMatches = await matchPassword(user.plainPassword, user.password);
        info(
          panelMatches
            ? `Panelda ko'rinadigan parol hash bilan mos — demak kiritilgan parol boshqa.`
            : `⚠️ Panelda ko'rinadigan parol ham hash bilan MOS KELMAYDI — plainPassword va password AJRALIB QOLGAN.`,
        );
        info(
          `Panel paroli "${rawPassword}" bilan bir xilmi: ${user.plainPassword === rawPassword ? "ha" : "yo'q"}`,
        );
        if (user.plainPassword !== user.plainPassword.trim()) {
          info(`⚠️ Panel parolida bo'sh joy bor (boshida yoki oxirida).`);
        }
      } else {
        info(`plainPassword bo'sh — eski hisob, panelda parol ko'rsatilmaydi.`);
      }
    }
  } else {
    info(`Parol berilmadi — tekshirilmadi.`);
    if (user.plainPassword && user.password) {
      const panelMatches = await matchPassword(user.plainPassword, user.password);
      info(
        panelMatches
          ? `Panelda ko'rinadigan parol hash bilan MOS.`
          : `⚠️ Panelda ko'rinadigan parol hash bilan MOS EMAS — ajralib qolgan.`,
      );
    }
  }

  // ── 5. Hisob holati (parol o'tgandan keyingi to'siqlar) ────────
  step("5. Hisob holati");
  if (!user.isActive) bad(`isActive=false → "Sizning hisobingiz faol emas"`);
  else ok(`isActive=true`);
  if (user.isArchived) bad(`isArchived=true → "Sizning hisobingiz arxivlangan"`);
  else ok(`isArchived=false`);

  await showAttempts(username);
}

/**
 * Filial bazalarini username bo'yicha kezadi — "profil bor, yo'naltirgich
 * yo'q" holatini ko'rsatadi.
 */
async function scanBranchesForUsername(username) {
  step("Qo'shimcha: filial bazalarini kezish");
  const branches = await branchService.list({ includeArchived: true });
  let found = 0;

  for (const branch of branches) {
    if (branch.status !== "ready") {
      info(`${branch.name}: status=${branch.status}, o'tkazib yuborildi`);
      continue;
    }
    try {
      const client = getClientForBranch(branch);
      const rows = await client.user.findMany({
        where: { username },
        select: { id: true, username: true, role: true, isActive: true, isArchived: true },
      });
      for (const row of rows) {
        found += 1;
        bad(
          `"${branch.name}" (${branch.schemaName}) da profil BOR: id=${row.id}, rol=${row.role}` +
            `${row.isActive ? "" : ", faol emas"}${row.isArchived ? ", arxivlangan" : ""}`,
        );
      }
    } catch (error) {
      info(`${branch.name}: o'qib bo'lmadi — ${error.message}`);
    }
  }

  if (!found) info(`Hech bir filialda bu username bilan profil topilmadi.`);
  else info(`⚠️ Profil bor, lekin yo'naltirgichda yozuv yo'q — login shu sababdan yiqiladi.`);
}

/** Oxirgi kirish urinishlari — server nima deb yozganini ko'rsatadi. */
async function showAttempts(username) {
  step("Oxirgi kirish urinishlari (platform.login_attempts)");

  // ⚠️ Client ESKIRGAN bo'lishi mumkin: `src/generated/` git'da emas va
  // `postinstall` uni qayta yaratadi. Yaratilmagan bo'lsa `loginAttempt`
  // undefined bo'ladi va tashxis eng oxirgi qadamda yiqilardi — ya'ni
  // yuqoridagi javob ham ko'rinmay ketardi.
  if (!platformPrisma.loginAttempt) {
    bad(`Platform client eskirgan — \`npm run prisma:generate\` ni ishga tushiring.`);
    return;
  }

  let attempts;
  try {
    attempts = await platformPrisma.loginAttempt.findMany({
      where: { username },
      orderBy: { createdAt: "desc" },
      take: 15,
      select: {
        createdAt: true,
        success: true,
        reason: true,
        channel: true,
        ip: true,
        device: true,
      },
    });
  } catch (error) {
    // ⚠️ P2021 = jadval yo'q. Bu YIQILISH EMAS, ALOHIDA XULOSA: platform
    // migratsiyasi qo'llanmagan, ya'ni urinishlar umuman yozilmayapti va
    // xavfsizlik ekrani ham bo'sh turadi. Tashxisning qolgan qismi esa
    // allaqachon javob bergan — uni shu sababli yo'qotib bo'lmaydi.
    if (error.code === "P2021") {
      bad(`\`platform.login_attempts\` jadvali YO'Q — migratsiya qo'llanmagan.`);
      info(`Tuzatish: npm run platform:migrate`);
      return;
    }
    throw error;
  }

  if (!attempts.length) {
    info(`Yozuv yo'q — bu username bilan hech kim urinmagan (yoki boshqa yozilgan).`);
    return;
  }

  for (const row of attempts) {
    const when = row.createdAt.toISOString().replace("T", " ").slice(0, 19);
    const mark = row.success ? "✅" : "❌";
    info(`${mark} ${when} | ${row.reason} | ${row.channel} | ${row.ip ?? "-"} | ${row.device ?? "-"}`);
  }
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
