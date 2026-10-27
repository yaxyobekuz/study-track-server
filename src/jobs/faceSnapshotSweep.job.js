/**
 * FACE ID KADRLARI SUPURGISI — kechasi 03:50.
 *
 * Kirish eshigidagi kamera kuniga yuzlab kadr yozadi. Ularning har biri
 * odamning — ko'pincha bolaning — yuz rasmi, ya'ni ikki muammo bir vaqtda:
 *
 *   1. MAXFIYLIK. Yuz rasmlari arxivi CHEKSIZ o'smasligi kerak. "Bugun
 *      kim o'tdi" degan savolga javob bir-ikki hafta kerak bo'ladi,
 *      undan keyin rasm faqat xavf bo'lib qoladi.
 *   2. JOY. 500 odam × kuniga 2 marta × 30 KB = kuniga ~30 MB.
 *
 * ⚠️ JURNAL QATORI O'CHIRILMAYDI, FAQAT RASM. `FaceCheckEvent` —
 * append-only jurnal (`AccountEntry` uslubi) va "o'tgan oyda bu odam
 * qanday kelgan" degan savolning javobi. Rasm esa `snapshotRetentionDays`
 * dan keyin yo'qoladi: fakt qoladi, surat ketadi.
 *
 * ⚠️ YUZ NAMUNALARINING (`FaceSample`) rasmlari TEGILMAYDI. Ular 5 ta va
 * ro'yxatga olingan paytdan beri yotadi: "bu odamni kim, qachon va qanday
 * kadr bilan ro'yxatga olgan" degan savolning yagona javobi. Ularni
 * muddat bilan o'chirish auditni ko'r qilardi.
 *
 * ⚠️ FILIAL BO'YICHA AYLANADI (`branchCron` MAJBURIY): jurnal har filial
 * schema'sida (root `CLAUDE.md`). O'ralmagan job birinchi so'rovdayoq
 * "Filial konteksti yo'q" xatosi bilan yiqilardi.
 */

const cron = require("node-cron");
const { branchCron } = require("../helpers/branchIterator");
const prisma = require("../config/prisma");
const { getFaceSettings } = require("../services/settings.service");
const fileStorage = require("../services/fileStorage.service");
const logger = require("../utils/logger");

/**
 * Bir o'tishda ko'pi bilan shuncha rasm o'chiriladi.
 *
 * ⚠️ Chegara kerak: birinchi ishga tushishda (yoki muddat qisqartirilgan
 * kunda) o'n minglab obyekt o'chirilishi mumkin va bu S3 ga qarshi
 * cheksiz tsikl bo'lardi. Qolgani ertasi kun o'chadi — supurgi har kuni
 * ishlaydi va orqada qolib ketmaydi.
 */
const BATCH_LIMIT = 2000;

/**
 * Bitta filialning passi.
 * @returns {Promise<{ removed: number, failed: number }>}
 */
async function runFaceSnapshotSweepPass() {
  const settings = await getFaceSettings();
  const days = Number(settings.snapshotRetentionDays) || 30;
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);

  const rows = await prisma.faceCheckEvent.findMany({
    where: { snapshotKey: { not: null }, occurredAt: { lt: cutoff } },
    select: { id: true, snapshotKey: true },
    orderBy: { occurredAt: "asc" },
    take: BATCH_LIMIT,
  });

  if (rows.length === 0) return { removed: 0, failed: 0 };

  let failed = 0;
  const cleared = [];

  for (const row of rows) {
    try {
      await fileStorage.deleteObject(row.snapshotKey);
      cleared.push(row.id);
    } catch (error) {
      // ⚠️ S3 xatosi qatorni TOZALAMAYDI: aks holda rasm bucket'da
      // qolib, bazada "yo'q" bo'lib ko'rinardi va uni hech kim
      // topa olmasdi. Ertasi kun qayta urinadi.
      failed += 1;
    }
  }

  if (cleared.length > 0) {
    await prisma.faceCheckEvent.updateMany({
      where: { id: { in: cleared } },
      data: { snapshotKey: null, snapshotUrl: null },
    });
  }

  return { removed: cleared.length, failed };
}

/** Cron jobni belgilaydi. Har kuni 03:50 (Asia/Tashkent). */
function startFaceSnapshotSweepCron() {
  cron.schedule(
    "50 3 * * *",
    branchCron("[FaceSnapshotSweep]", async (branch) => {
      try {
        const { removed, failed } = await runFaceSnapshotSweepPass();
        if (removed > 0 || failed > 0) {
          logger.info(
            `[FaceSnapshotSweep] ${branch.name}: ${removed} ta kadr o'chirildi` +
              (failed > 0 ? `, ${failed} tasi xato bilan qoldi` : ""),
          );
        }
      } catch (error) {
        logger.error(`[FaceSnapshotSweep] ${branch.name}: cron xatosi`, error);
      }
    }),
    { scheduled: true, timezone: "Asia/Tashkent" },
  );

  logger.info(
    "Face ID kadrlari supurgisi cron job belgilandi: Har kuni 03:50 (Asia/Tashkent)",
  );
}

module.exports = { startFaceSnapshotSweepCron, runFaceSnapshotSweepPass };
