#!/usr/bin/env node
/**
 * TOPSHIRIQLARNI NOLGA TUSHIRISH — "shu kungacha bo'lgan hamma topshiriq o'chadi".
 *
 *     node src/scripts/tasks-reset.js                      # DRY-RUN (faqat ko'rsatadi)
 *     node src/scripts/tasks-reset.js --apply              # BAJARADI
 *     node src/scripts/tasks-reset.js --branch=bosh        # faqat bitta filial
 *     node src/scripts/tasks-reset.js --apply --keep-schedules
 *
 * NIMA UCHUN: tizim sinovdan haqiqiy ishga o'tdi va undan oldin yozilgan
 * topshiriqlar ("Lavozimlar markazi") hisobotni, bajarilish foizini va
 * xodimlarning jarima ballarini buzib ko'rsatyapti. Registr toza sahifadan
 * boshlanishi kerak.
 *
 * ⚠️ BU SKRIPT NIMANI TOZALAYDI VA NIMANI TOZALAMAYDI
 *
 *   TOZALAYDI:
 *     · `Task` qatorlari — HAMMASI (ijrochi bergani ham, o'ziga belgilagani
 *       ham, muammodan kelgani ham).
 *     · Vaqt chizig'i va muddat tarixi — `onDelete: Cascade` bilan o'z-o'zidan.
 *     · TOPSHIRIQDAN YOZILGAN JARIMALAR va ular qo'shgan BALLAR
 *       (pastda — eng muhim qism).
 *     · Doimiy qoidalar (`TaskSchedule`) — TO'XTATILADI, o'chirilmaydi
 *       (`--keep-schedules` bilan tegilmaydi).
 *     · Yetim qolgan fayllar.
 *
 *   TOZALAMAYDI:
 *     · Boshqa manbadan kelgan jarimalar (davomat, baho qo'ymaslik, qo'lda
 *       berilgani) — ular topshiriqqa aloqasiz va ularga tegish bu skriptning
 *       ishi emas.
 *     · Muammolarning (`Issue`) o'zi — topshiriq o'chsa `issueId` `SetNull`
 *       bo'ladi, muammo esa o'z holatida qoladi.
 *     · Topshiriq sozlamalari (`TaskSettings`) — qoidalar o'zgarmaydi.
 *
 * ⚠️ JARIMA — ENG NOZIK JOY. `task.penaltyRef` → `Penalty` qatori, va o'sha
 * jarima yozilganda `User.penaltyPoints` OSHIRILGAN. Topshiriqni shunchaki
 * o'chirish:
 *   1) jarima yozuvini MANBASIZ qoldirardi ("Topshiriq: ..." deb turadi-yu,
 *      qaysi topshiriq ekani yo'q);
 *   2) xodimning ballari OSHGANICHA qolardi — ya'ni registr nolga tushsa ham
 *      odam o'sha jarima bilan yurar edi.
 * Shuning uchun jarima `penaltyService.deletePenalty` orqali o'chiriladi:
 * u ballni QAYTARADI (`status === "approved"` bo'lsa) va fayllarini ham
 * tozalaydi. Ikkinchi nusxa yozilmaydi — ball qaytarish mantig'i bitta
 * joyda qolishi kerak.
 *
 * ⚠️ TOPSHIRIQ O'CHIRISH `task.service.js#deleteTask` ORQALI EMAS. Sabab
 * ikkita: u jarima yozilgan topshiriqni ATAYLAB rad etadi (bu yerda esa
 * jarimaning o'zi ham olib tashlanadi) va u har fayl uchun alohida
 * "boshqa kim ishlatyapti" so'rovi yuboradi — 146 qator uchun bu yuzlab
 * so'rov bo'lardi. Bu yerda tartib teskari: avval jarima, keyin qator,
 * oxirida fayllar bir martada.
 *
 * ⚠️ DOIMIY QOIDALAR TO'XTATILMASA ISH BEKOR. Cron (`taskSchedule.job.js`)
 * har kuni faol qoidalardan `leadDays` oldinga topshiriq YARATADI —
 * tozalangan registr ertasiga yana to'lib qolardi. Shuning uchun qoidalar
 * TO'XTATILADI (o'chirilmaydi: ularning matni, ijrochilari va jadvali
 * saqlanadi, rahbar kerak bo'lganda paneldan qayta yoqadi).
 *
 * ⚠️ `--apply` BO'LMASA BITTA ham qator o'zgarmaydi.
 */

require("dotenv").config();

const prisma = require("../config/prisma");
const platformPrisma = require("../config/platformPrisma");
const { disconnectAll } = require("../config/branchRegistry");
const { forEachBranch } = require("../helpers/branchIterator");
const { deleteAttachments } = require("../services/file.service");
const penaltyService = require("../services/penalty.service");
const logger = require("../utils/logger");

// Cron/skript aktyori — `stoppedBy` NOT NULL bo'lgan ustunlar uchun
const SYSTEM_ACTOR_ID = "000000000000000000000000";
const STOP_REASON = "Tizimga o'tish: topshiriqlar registri noldan boshlanadi";

const APPLY = process.argv.includes("--apply");
const KEEP_SCHEDULES = process.argv.includes("--keep-schedules");
const branchArg = process.argv.find((a) => a.startsWith("--branch="));
const ONLY_BRANCH = branchArg ? branchArg.split("=")[1] : null;

const line = (msg = "") => console.log(msg);

/**
 * Bitta filialning topshiriqlar registrini tozalaydi.
 * @returns {Promise<object>} hisobot
 */
async function resetBranch(branch) {
  line(`\n════ FILIAL: ${branch.name} (${branch.code}) ════`);

  const report = {
    tasks: 0,
    penalties: 0,
    pointsReturned: 0,
    danglingRefs: 0,
    schedules: 0,
    filesDeleted: 0,
    affectedUsers: 0,
  };

  // ── 0. Hozirgi holat ────────────────────────────────────────────
  const tasks = await prisma.task.findMany({
    select: {
      id: true,
      assignee: true,
      penaltyRef: true,
      attachments: true,
      completionAttachments: true,
      selfAssigned: true,
      status: true,
    },
  });

  if (tasks.length === 0) {
    line("   ✅ Topshiriq yo'q — tozalanadigan narsa yo'q");
  } else {
    const selfCount = tasks.filter((t) => t.selfAssigned).length;
    const byStatus = {};
    for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    line(
      `   Topildi: ${tasks.length} ta topshiriq ` +
        `(shundan ${selfCount} tasi "o'zim belgilagan")`,
    );
    line(
      `   Holatlar: ${Object.entries(byStatus)
        .map(([s, n]) => `${s}=${n}`)
        .join(", ")}`,
    );
  }
  report.tasks = tasks.length;

  // ── 1. JARIMALARNI QAYTARISH (qatorlardan OLDIN) ────────────────
  // ⚠️ TARTIB MUHIM: jarima avval o'chiriladi, chunki `penaltyRef` ni
  // topshiriq qatoridan o'qiymiz — qator o'chgandan keyin "qaysi jarima
  // shu topshiriqdan kelgan" degan savolga javob qolmaydi.
  const refs = tasks.map((t) => t.penaltyRef).filter(Boolean);

  if (refs.length > 0) {
    // Haqiqatda bazada turganlari — ba'zi ishoralar o'lik bo'lishi mumkin
    // (jarima qo'lda o'chirilgan): ular xato emas, shunchaki sanaladi.
    const existing = await prisma.penalty.findMany({
      where: { id: { in: refs } },
      select: { id: true, userId: true, points: true, status: true },
    });
    report.danglingRefs = refs.length - existing.length;

    const pointsByUser = {};
    for (const p of existing) {
      if (p.status !== "approved") continue;
      pointsByUser[p.userId] = (pointsByUser[p.userId] || 0) + p.points;
    }
    report.affectedUsers = Object.keys(pointsByUser).length;
    report.pointsReturned = Object.values(pointsByUser).reduce((a, b) => a + b, 0);

    line(
      `   Jarima: ${existing.length} ta yozuv, ${report.pointsReturned} ball ` +
        `${report.affectedUsers} xodimga qaytar${APPLY ? "ildi" : "iladi"}` +
        (report.danglingRefs ? `, ${report.danglingRefs} ta o'lik ishora` : ""),
    );

    // Kim qancha ball qaytarib olishini KO'RSATAMIZ — bu pulga teng
    // ta'sirli o'zgarish, jim bo'lmasligi kerak
    if (report.affectedUsers > 0) {
      const users = await prisma.user.findMany({
        where: { id: { in: Object.keys(pointsByUser) } },
        select: { id: true, firstName: true, lastName: true, penaltyPoints: true },
      });
      for (const u of users) {
        const back = pointsByUser[u.id];
        line(
          `      · ${u.firstName} ${u.lastName}: ${u.penaltyPoints} → ` +
            `${u.penaltyPoints - back} ball (−${back})`,
        );
      }
    }

    if (APPLY) {
      for (const p of existing) {
        try {
          // ⚠️ YAGONA YO'L: ball qaytarish mantig'i shu funksiyada
          // (`status === "approved"` bo'lsa `increment: -points`). Ikkinchi
          // nusxa yozilsa, "kamaytirish" turidagi jarima (`reduction`)
          // teskari ishlab, ballni oshirib yuborardi.
          await penaltyService.deletePenalty(p.id);
          report.penalties += 1;
        } catch (err) {
          line(`      ⚠️ Jarima ${p.id} o'chmadi: ${err.message}`);
        }
      }
    } else {
      report.penalties = existing.length;
    }
  } else if (tasks.length > 0) {
    line("   Jarima: topshiriqlardan yozilgan jarima yo'q");
  }

  // ── 2. DOIMIY QOIDALARNI TO'XTATISH ─────────────────────────────
  // ⚠️ QATORLARDAN OLDIN: cron shu orada ishga tushib, biz o'chirayotgan
  // paytda yangi topshiriq yozib qo'yishi mumkin. Avval manbani yopamiz.
  if (!KEEP_SCHEDULES) {
    const active = await prisma.taskSchedule.findMany({
      where: { isActive: true },
      select: { id: true, title: true },
    });
    report.schedules = active.length;

    if (active.length > 0) {
      line(`   Doimiy qoida: ${active.length} ta to'xtatil${APPLY ? "di" : "adi"}`);
      for (const s of active) line(`      · ${s.title}`);

      if (APPLY) {
        await prisma.taskSchedule.updateMany({
          where: { isActive: true },
          data: {
            isActive: false,
            stoppedBy: SYSTEM_ACTOR_ID,
            stopReason: STOP_REASON,
            stoppedAt: new Date(),
          },
        });
      }
    } else {
      line("   Doimiy qoida: faol qoida yo'q");
    }
  } else {
    const activeCount = await prisma.taskSchedule.count({ where: { isActive: true } });
    if (activeCount > 0) {
      line(
        `   ⚠️ Doimiy qoida: ${activeCount} ta FAOL qoldi (--keep-schedules) — ` +
          "cron ertaga yangi topshiriq yozadi",
      );
    }
  }

  // ── 3. TOPSHIRIQ QATORLARINI O'CHIRISH ──────────────────────────
  // Vaqt chizig'i va muddat tarixi `onDelete: Cascade` bilan o'z-o'zidan
  // ketadi — qo'lda o'chirish shart emas.
  if (tasks.length > 0) {
    if (APPLY) {
      const { count } = await prisma.task.deleteMany({});
      line(`   Topshiriq: ${count} ta qator o'chirildi (tarixi bilan)`);
    } else {
      line(`   Topshiriq: ${tasks.length} ta qator o'chiriladi (tarixi bilan)`);
    }
  }

  // ── 4. FAYLLARNI TOZALASH (qatorlardan KEYIN) ───────────────────
  // ⚠️ KEYIN, chunki "bu faylga boshqa kim ishora qilyapti" degan savolga
  // javob qatorlar o'chgandan keyin to'g'ri bo'ladi. Doimiy qoidalar
  // hali turadi (faqat to'xtatilgan) va ular ham faylga ishora qilishi
  // mumkin — o'sha fayllar SAQLANADI, aks holda qoida qayta yoqilganda
  // o'lik havolaga ishora qilib qolardi (`_deleteUnsharedAttachments`
  // doktrinasi).
  const allFiles = [];
  for (const t of tasks) {
    for (const a of Array.isArray(t.attachments) ? t.attachments : []) {
      if (a && a.key) allFiles.push(a);
    }
    for (const a of Array.isArray(t.completionAttachments) ? t.completionAttachments : []) {
      if (a && a.key) allFiles.push(a);
    }
  }

  // Bir fayl bir nechta topshiriqda umumiy bo'lishi mumkin — kalit bo'yicha yagona
  const uniqueFiles = [...new Map(allFiles.map((a) => [a.key, a])).values()];

  if (uniqueFiles.length > 0) {
    // Qoidalar hali ishora qilayotganlarini CHIQARIB TASHLAYMIZ
    const keep = new Set();
    for (const file of uniqueFiles) {
      const usedBySchedule = await prisma.taskSchedule.count({
        where: { attachments: { array_contains: [{ key: file.key }] } },
      });
      if (usedBySchedule > 0) keep.add(file.key);
    }

    const orphaned = uniqueFiles.filter((f) => !keep.has(f.key));
    report.filesDeleted = orphaned.length;

    line(
      `   Fayl: ${orphaned.length} ta o'chiril${APPLY ? "di" : "adi"}` +
        (keep.size ? `, ${keep.size} tasi doimiy qoidada qoldi` : ""),
    );

    if (APPLY && orphaned.length > 0) {
      await deleteAttachments(orphaned);
    }
  }

  // ── 5. YAKUNIY HOLAT ────────────────────────────────────────────
  if (APPLY) {
    const [left, leftActive] = await Promise.all([
      prisma.task.count(),
      prisma.taskSchedule.count({ where: { isActive: true } }),
    ]);
    line(
      `   ${left === 0 ? "✅" : "⚠️"} Qolgan topshiriq: ${left} ta` +
        (leftActive ? `, faol qoida: ${leftActive} ta` : ""),
    );
  }

  return report;
}

async function main() {
  line("\n🧹 TOPSHIRIQLAR REGISTRINI NOLGA TUSHIRISH");
  line(
    APPLY
      ? "   ⚠️ --apply: O'ZGARISHLAR YOZILADI"
      : "   DRY-RUN: hech narsa yozilmaydi (--apply bilan bajariladi)",
  );
  if (KEEP_SCHEDULES) line("   --keep-schedules: doimiy qoidalar TEGILMAYDI");
  if (ONLY_BRANCH) line(`   --branch=${ONLY_BRANCH}: faqat shu filial`);

  const results = await forEachBranch(
    async (branch) => {
      if (ONLY_BRANCH && branch.code !== ONLY_BRANCH) return null;
      return resetBranch(branch);
    },
    { label: "[TasksReset]" },
  );

  // ── Umumiy xulosa ─────────────────────────────────────────────
  line("\n════ XULOSA ════");
  let totals = { tasks: 0, penalties: 0, points: 0, schedules: 0, files: 0 };
  let failed = 0;

  for (const { branch, value, error } of results) {
    if (error) {
      line(`   ❌ ${branch.name}: ${error.message}`);
      failed += 1;
      continue;
    }
    if (!value) continue;
    totals.tasks += value.tasks;
    totals.penalties += value.penalties;
    totals.points += value.pointsReturned;
    totals.schedules += value.schedules;
    totals.files += value.filesDeleted;
  }

  line(`   Topshiriq:     ${totals.tasks} ta`);
  line(`   Jarima:        ${totals.penalties} ta (${totals.points} ball qaytdi)`);
  line(`   Doimiy qoida:  ${totals.schedules} ta to'xtatildi`);
  line(`   Fayl:          ${totals.files} ta`);
  if (failed) line(`   ❌ Xato bo'lgan filial: ${failed} ta`);

  if (!APPLY) {
    line("\n   ℹ️  Bu DRY-RUN edi. Bajarish uchun: --apply");
  }

  if (failed) process.exitCode = 1;
}

main()
  .catch((error) => {
    logger.error(`[TasksReset] Yiqildi: ${error.message}`);
    console.error("\n💥 Tozalash yiqildi:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectAll().catch(() => {});
    await platformPrisma.$disconnect().catch(() => {});
    line("");
  });
