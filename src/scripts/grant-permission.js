#!/usr/bin/env node
/**
 * RUXSATNI ROLLARGA VA ULARNING EGALARIGA BERISH (bir martalik skript).
 *
 * Yangi ruxsat kaliti katalogga qo'shilganda (`utils/permissions.js`) u HECH
 * KIMDA bo'lmaydi: `Role.permissions` — faqat YANGI foydalanuvchi uchun
 * boshlang'ich to'plam, mavjud xodimlarning kalitlari esa har filialning
 * `users.permissions` ustunida yotadi. Shu sababli "direktor ham qila olsin"
 * degan talab ikki joyga yozilishi kerak: rolga (kelgusi xodimlar uchun) va
 * o'sha roldagi mavjud xodimlarga.
 *
 * ⚠️ ROL NOMLARI KODGA QOTIRILMAYDI. Rollar dinamik (`platform.roles`) va
 * har o'rnatishda boshqacha nomlangan bo'lishi mumkin, shuning uchun ro'yxat
 * `--roles` bilan beriladi; berilmasa skript rahbarlik rollarini TAXMIN
 * qiladi va nimani topganini ekranga chiqaradi — odam tasdiqlaydi.
 *
 * ⚠️ SUKUT BO'YICHA HECH NARSA YOZILMAYDI (quruq yurish). Yozish uchun
 * `--apply` kerak: bitta noto'g'ri naqsh butun maktabga ruxsat tarqatib
 * yuborishi mumkin.
 *
 * Misollar:
 *   node src/scripts/grant-permission.js --keys=topics.view,topics.assign
 *   node src/scripts/grant-permission.js --keys=topics.assign --roles=direktor,rahbar --apply
 *   node src/scripts/grant-permission.js --keys=topics.assign --roles=direktor --no-users --apply
 */

require("dotenv").config();

const { validateEnv } = require("../config/env.config");

validateEnv();

const platformPrisma = require("../config/platformPrisma");
const prisma = require("../config/prisma");
const { forEachBranch } = require("../helpers/branchIterator");
const { PERMISSION_KEYS, normalizePermissions } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");

/** Rol nomi/kaliti shu so'zlardan birini saqlasa — rahbarlik roli deb taxmin qilinadi. */
const LEADER_HINTS = ["direktor", "director", "rahbar", "boshli", "mudir", "zavuch", "metodist"];

/** Ruxsat berilmaydigan rollar: owner'da hammasi bor, o'quvchida kerak emas. */
const SKIP_ROLES = new Set([ROLES.OWNER, ROLES.STUDENT]);

function parseArgs(argv) {
  const args = { keys: [], roles: null, apply: false, users: true };

  for (const raw of argv.slice(2)) {
    if (raw === "--apply") args.apply = true;
    else if (raw === "--no-users") args.users = false;
    else if (raw.startsWith("--keys=")) {
      args.keys = raw.slice(7).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (raw.startsWith("--roles=")) {
      args.roles = raw.slice(8).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    }
  }

  return args;
}

const matchesLeader = (role) => {
  const haystack = `${role.name} ${role.value}`.toLowerCase();
  return LEADER_HINTS.some((hint) => haystack.includes(hint));
};

async function main() {
  const args = parseArgs(process.argv);

  if (args.keys.length === 0) {
    console.error("Ruxsat kaliti berilmadi. Misol: --keys=topics.view,topics.assign");
    process.exitCode = 1;
    return;
  }

  const unknown = args.keys.filter((key) => !PERMISSION_KEYS.includes(key));
  if (unknown.length > 0) {
    console.error(`Katalogda yo'q kalit(lar): ${unknown.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const allRoles = await platformPrisma.role.findMany({
    select: { id: true, name: true, value: true, permissions: true },
    orderBy: { name: "asc" },
  });

  const targets = allRoles.filter((role) => {
    if (SKIP_ROLES.has(role.value)) return false;
    if (args.roles) {
      const haystack = `${role.name} ${role.value}`.toLowerCase();
      return args.roles.some((needle) => haystack.includes(needle));
    }
    return matchesLeader(role);
  });

  console.log(`Kalitlar : ${args.keys.join(", ")}`);
  console.log(`Rejim    : ${args.apply ? "YOZILADI" : "quruq yurish (--apply yo'q)"}`);
  console.log(`Rollar   : ${targets.length ? targets.map((r) => `${r.name} (${r.value})`).join(", ") : "topilmadi"}`);

  if (targets.length === 0) {
    console.log("\nMos rol topilmadi. `--roles=` bilan aniq ko'rsating.");
    console.log(`Mavjud rollar: ${allRoles.map((r) => r.value).join(", ")}`);
    return;
  }

  // ── 1) ROL KATALOGI (kelgusi xodimlar uchun boshlang'ich to'plam) ──
  for (const role of targets) {
    const next = normalizePermissions([...role.permissions, ...args.keys]);
    const added = next.filter((key) => !role.permissions.includes(key));

    if (added.length === 0) {
      console.log(`  rol "${role.name}": allaqachon bor`);
      continue;
    }

    console.log(`  rol "${role.name}": +${added.join(", ")}`);
    if (args.apply) {
      await platformPrisma.role.update({ where: { id: role.id }, data: { permissions: next } });
    }
  }

  if (!args.users) return;

  // ── 2) MAVJUD XODIMLAR (har filialda alohida — `User.permissions`) ──
  const roleValues = targets.map((r) => r.value);

  await forEachBranch(async (branch) => {
    const staff = await prisma.user.findMany({
      where: {
        isArchived: false,
        OR: [{ role: { in: roleValues } }, { extraRoles: { hasSome: roleValues } }],
      },
      select: { id: true, firstName: true, lastName: true, permissions: true },
    });

    let touched = 0;

    for (const person of staff) {
      const next = normalizePermissions([...(person.permissions || []), ...args.keys]);
      const added = next.filter((key) => !(person.permissions || []).includes(key));
      if (added.length === 0) continue;

      touched += 1;
      console.log(
        `  ${branch.name} — ${person.firstName} ${person.lastName}: +${added.join(", ")}`,
      );
      if (args.apply) {
        await prisma.user.update({ where: { id: person.id }, data: { permissions: next } });
      }
    }

    console.log(`  ${branch.name}: ${staff.length} ta xodim ko'rildi, ${touched} tasiga qo'shiladi`);
  }, { label: "[Grant]" });
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
