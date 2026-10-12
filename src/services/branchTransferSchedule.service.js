/**
 * FILIALLARARO KO'CHIRISH — SINFNING DARS JADVALI.
 *
 * Sinf boshqa filialga ko'chganda uning haftalik jadvali ham ko'chadi:
 * maqsad filialda AYNI kataklar (kun + dars tartibi) tiklanadi, manbadagi
 * jadval esa KEYINGI OY BOSHIDAN olib tashlanadi.
 *
 * ═════════════════════════════════════════════
 * ⚠️ NIMA UCHUN MANBADAN DARHOL O'CHIRILMAYDI
 *
 * `ScheduleLesson` — SANASIZ haftalik shablon, soatbay oylik esa uni butun
 * oyga yoyib hisoblaydi (`lessonHours.service.js`). Oy o'rtasida o'chirilsa,
 * shu oyda ALLAQACHON O'TILGAN darslar ham o'qituvchi oyligidan tushib
 * ketardi (`education.md` §8 va §10: jadvalni o'chirish o'tgan oylikni
 * qayta yozmasin).
 *
 * Oy oxirigacha qoldirish esa o'qituvchini ortiqcha ham qilmaydi: ko'chishdan
 * KEYINGI darslarga baho qo'yilmaydi, ya'ni ular "o'tilmagan" bo'lib
 * soatga kirmaydi ("JADVAL — REJA, PUL FAKTGA TO'LANADI").
 *
 * ⚠️ NIMA UCHUN O'QITUVCHI NOMI BO'YICHA MOSLANMAYDI
 *
 * Fan — katalog, uni nomi bo'yicha ochish xavfsiz. O'qituvchi esa login,
 * ruxsat va oylik egasi: uni "nomi o'xshash" deb maqsad filialga ulash jim
 * huquq berish va begona odamga soat (pul) yozish bo'lardi. Shuning uchun
 * dars FAQAT o'sha o'qituvchi maqsad filialda HAQIQATAN bor bo'lsa (avval
 * xodim sifatida ko'chirilgan yoki ulashilgan) va o'sha katakda BAND
 * BO'LMASA ko'chadi. Qolgani ro'yxat bilan aytiladi va qo'lda to'ldiriladi.
 * ═════════════════════════════════════════════
 *
 * ⚠️ Maqsadga yozuv filiallararo tranzaksiyada EMAS: amaldagi jadvalga
 * yozadigan har yo'l `withScheduleWriteLock` + `assertPlatformMode` dan
 * o'tishi SHART (`education.md` §10), u esa filialga bog'langan Prisma
 * tranzaksiyasi. Shuning uchun nusxalash — tranzaksiyadan KEYINGI qadam;
 * yiqilsa, manbadagi o'chirish navbati ham bekor qilinadi va ogohlantirish
 * jurnalga tushadi.
 */

const { generateId } = require("../utils/idGenerator");
const logger = require("../utils/logger");
const prisma = require("../config/prisma");
const { runWithBranch } = require("../config/branchContext");
const { qualified, schemaType } = require("../helpers/crossSchema.helpers");
const { nextMonth, formatMonthKey } = require("../helpers/month.helpers");
const { mapSubjects, presentStaff } = require("./branchTransferCatalog.service");
const {
  withScheduleWriteLock,
  assertPlatformMode,
} = require("./scheduleWriteGuard.service");

/**
 * SINF JADVALI REJASI — har sinf uchun nima ko'chadi, nima qo'lda qoladi.
 *
 * @param {object} db - filiallararo tranzaksiya yoki platforma client'i
 * @param {object} ctx
 * @param {Array<{id: string, name: string}>} classes - manba sinflari
 * @returns {Promise<Map<string, object>>} manba classId → reja
 */
const planClassSchedules = async (db, ctx, classes) => {
  const ids = classes.map((c) => c.id);
  const src = (t) => qualified(ctx.source.schemaName, t);
  const tgt = (t) => qualified(ctx.target.schemaName, t);
  const q = (sql, ...params) => db.$queryRawUnsafe(sql, ...params);
  const plans = new Map(ids.map((id) => [id, null]));
  if (ids.length === 0) return plans;

  const lessons = await q(
    `SELECT s.class_id AS "classId", s.day::text AS day, l.id, l.subject_id AS "subjectId",
            l.teacher_id AS "teacherId", l."order", l.start_time AS "startTime",
            l.end_time AS "endTime", l.position
     FROM ${src("schedule_lessons")} l
     JOIN ${src("schedules")} s ON s.id = l.schedule_id
     WHERE s.class_id = ANY($1::text[])
     ORDER BY s.class_id, s.day, l."order", l.position, l.id`,
    ids,
  );
  if (lessons.length === 0) return plans;

  const subjectNames = new Map(
    (
      await q(
        `SELECT id, name FROM ${src("subjects")} WHERE id = ANY($1::text[])`,
        [...new Set(lessons.map((l) => l.subjectId))],
      )
    ).map((r) => [r.id, r.name]),
  );
  const teacherNames = new Map(
    (
      await q(
        `SELECT id, first_name AS "firstName", last_name AS "lastName"
         FROM ${src("users")} WHERE id = ANY($1::text[])`,
        [...new Set(lessons.map((l) => l.teacherId))],
      )
    ).map((r) => [r.id, `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim()]),
  );

  const available = await presentStaff(db, ctx, lessons.map((l) => l.teacherId));

  // Maqsad filialda o'sha o'qituvchi o'sha katakda BAND emasmi
  const busy = await q(
    `SELECT l.teacher_id AS "teacherId", s.day::text AS day, l."order"
     FROM ${tgt("schedule_lessons")} l
     JOIN ${tgt("schedules")} s ON s.id = l.schedule_id
     WHERE l.teacher_id = ANY($1::text[])`,
    [...available],
  );
  const busyKeys = new Set(busy.map((r) => `${r.teacherId}|${r.day}|${r.order}`));

  const plansByClass = new Map();
  for (const lesson of lessons) {
    if (!plansByClass.has(lesson.classId)) {
      plansByClass.set(lesson.classId, { lessons: [], skipped: [], days: new Set() });
    }
    const entry = plansByClass.get(lesson.classId);
    entry.days.add(lesson.day);

    const teacherName = teacherNames.get(lesson.teacherId) || "noma'lum xodim";
    const subjectName = subjectNames.get(lesson.subjectId) || "noma'lum fan";
    const slot = `${lesson.day}|${lesson.order}`;

    if (!available.has(lesson.teacherId)) {
      entry.skipped.push({
        day: lesson.day,
        order: lesson.order,
        subject: subjectName,
        teacher: teacherName,
        reason: "teacher_missing",
      });
      continue;
    }
    if (busyKeys.has(`${lesson.teacherId}|${lesson.day}|${lesson.order}`)) {
      entry.skipped.push({
        day: lesson.day,
        order: lesson.order,
        subject: subjectName,
        teacher: teacherName,
        reason: "teacher_busy",
      });
      continue;
    }
    // Bitta ko'chirishda ikki sinf bitta o'qituvchining bitta katagini
    // talab qilsa, ikkinchisi ham band bo'ladi
    busyKeys.add(`${lesson.teacherId}|${lesson.day}|${lesson.order}`);
    entry.lessons.push({
      day: lesson.day,
      subjectId: lesson.subjectId,
      teacherId: lesson.teacherId,
      order: lesson.order,
      startTime: lesson.startTime,
      endTime: lesson.endTime,
      position: lesson.position,
      slot,
    });
  }

  for (const klass of classes) {
    const entry = plansByClass.get(klass.id);
    if (!entry) continue;
    plans.set(klass.id, {
      total: entry.lessons.length + entry.skipped.length,
      moving: entry.lessons.length,
      lessons: entry.lessons,
      skipped: entry.skipped,
      days: [...entry.days].sort(),
      subjectIds: [...new Set(entry.lessons.map((l) => l.subjectId))].sort(),
      removalMonth: nextMonth(ctx.month),
    });
  }
  return plans;
};

/**
 * Manbada jadvalni o'chirish NAVBATINI yozadi (filiallararo tranzaksiya
 * ichida — qaror ko'chirish bilan bitta atomda bo'lsin).
 *
 * @param {object} db
 * @param {object} ctx
 * @param {Array<{id: string, name: string, schedule: object|null}>} classes
 * @returns {Promise<number>} yozilgan navbat qatorlari
 */
const queueSourceRemoval = async (db, ctx, classes) => {
  // ⚠️ FAQAT HAQIQATAN KO'CHGAN JADVAL UCHUN. Maqsad filialda o'qituvchi
  // bo'lmasa birorta dars nusxalanmaydi (`moving = 0`) — bunda manbadagi
  // jadvalni o'chirish jadvalni IKKALA filialdan ham yo'q qilardi.
  const live = classes.filter((c) => c.schedule && c.schedule.moving > 0);
  if (live.length === 0) return 0;

  const month = nextMonth(ctx.month);
  let written = 0;
  for (const klass of live) {
    written += await db.$executeRawUnsafe(
      `INSERT INTO ${qualified(ctx.source.schemaName, "pending_schedule_removals")}
         (id, class_id, class_name, effective_month, reason, target_branch_id, transfer_id,
          status, lesson_count, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               'pending'::${schemaType(ctx.source.schemaName, "PendingScheduleRemovalStatus")},
               $8, $9, NOW(), NOW())
       ON CONFLICT (class_id, effective_month) DO UPDATE
         SET reason = EXCLUDED.reason, target_branch_id = EXCLUDED.target_branch_id,
             transfer_id = EXCLUDED.transfer_id, status = EXCLUDED.status,
             lesson_count = EXCLUDED.lesson_count, fail_reason = '',
             processed_at = NULL, updated_at = NOW()`,
      generateId(),
      klass.id,
      klass.name,
      month,
      `"${ctx.target.name}" filialiga ko'chirildi: ${ctx.reason}`,
      ctx.target.id,
      ctx.transferId,
      klass.schedule.total,
      ctx.actor.id,
    );
  }
  return written;
};


/**
 * KO'CHISHDAN OLDIN: o'qituvchining o'tilmagan darslari SURATI.
 *
 * ⚠️ NIMA UCHUN KERAK. O'quvchilar bilan birga ularning BAHOLARI ham
 * ko'chadi, oylik esa "dars o'tildimi" degan savolga aynan bahodan javob
 * oladi (`loadLessonFacts` — sinf + fan + tartib + kun). Sinfning hamma
 * o'quvchisi ketsa, shu oyda ALLAQACHON O'TILGAN dars birdan "o'tilmagan"
 * bo'lib qoladi va o'qituvchi haqiqatan qilgan ishi uchun pulsiz qolardi.
 *
 * Shuning uchun ko'chirishdan OLDIN va KEYIN o'tilmaganlar ro'yxati
 * olinadi; farqi — aynan ko'chirish sababli yo'qolgan darslar, va ular
 * "o'tildi" belgisi bilan qaytariladi (`creditLostLessons`).
 *
 * @param {object} ctx
 * @param {string[]} classIds - manba filialdagi sinflar
 * @returns {Promise<{month: number, teacherIds: string[], missed: Set<string>}>}
 */
const snapshotMissedLessons = async (ctx, classIds) => {
  const empty = { month: ctx.month, teacherIds: [], missed: new Set() };
  if (!classIds.length) return empty;

  return runWithBranch(ctx.source, async () => {
    const { getTeachersHours } = require("./lessonHours.service");
    const [own, subs] = await Promise.all([
      prisma.scheduleLesson.findMany({
        where: { schedule: { classId: { in: classIds } } },
        distinct: ["teacherId"],
        select: { teacherId: true },
      }),
      prisma.lessonSubstitutionItem.findMany({
        where: { classId: { in: classIds } },
        distinct: ["substitutionId"],
        select: { substitution: { select: { substituteTeacherId: true } } },
      }),
    ]);
    const teacherIds = [
      ...new Set([
        ...own.map((r) => r.teacherId),
        ...subs.map((r) => r.substitution?.substituteTeacherId),
      ]),
    ].filter(Boolean);
    if (teacherIds.length === 0) return empty;

    const hours = await getTeachersHours(teacherIds, ctx.month);
    const missed = new Set();
    for (const [teacherId, row] of hours) {
      for (const lesson of row.missedLessons ?? []) {
        missed.add(missedKey(teacherId, lesson));
      }
    }
    return { month: ctx.month, teacherIds, missed };
  });
};

/** Dars kaliti — `lessonCreditKey` bilan AYNI tarkib. */
const missedKey = (teacherId, lesson) =>
  [teacherId, lesson.classId, lesson.subjectId, lesson.lessonOrder, toIsoDay(lesson.date)].join("|");

const toIsoDay = (date) => new Date(date).toISOString().slice(0, 10);

/**
 * KO'CHISHDAN KEYIN: faqat ko'chirish sababli "o'tilmagan" bo'lib qolgan
 * darslarni "o'tildi" deb belgilaydi — o'qituvchi o'z soatini yo'qotmaydi.
 *
 * Belgilash BITTALIK xizmat orqali (`lessonCredit.createCredits`): u darsni
 * serverda QAYTA tekshiradi, `activeKey` bilan takrorni to'sadi, davomat va
 * jarima holatini belgiga muhrlaydi — mustaqil SQL yozilmaydi.
 *
 * @returns {Promise<{credited: number, days: number, warnings: string[]}>}
 */
const creditLostLessons = async (ctx, classIds, snapshot) => {
  const warnings = [];
  if (!snapshot?.teacherIds?.length) return { credited: 0, days: 0, warnings };

  return runWithBranch(ctx.source, async () => {
    const { getTeachersHours } = require("./lessonHours.service");
    const { createCredits } = require("./lessonCredit.service");

    const hours = await getTeachersHours(snapshot.teacherIds, snapshot.month);
    const classSet = new Set(classIds);
    const byDay = new Map();

    for (const [teacherId, row] of hours) {
      for (const lesson of row.missedLessons ?? []) {
        if (!classSet.has(lesson.classId)) continue;
        const key = missedKey(teacherId, lesson);
        // Ko'chirishdan OLDIN ham o'tilmagan bo'lsa — bu bizning ishimiz emas
        if (snapshot.missed.has(key)) continue;
        const day = toIsoDay(lesson.date);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push({
          teacherId,
          classId: lesson.classId,
          subjectId: lesson.subjectId,
          lessonOrder: lesson.lessonOrder,
        });
      }
    }

    let credited = 0;
    for (const [day, lessons] of [...byDay.entries()].sort()) {
      try {
        const result = await createCredits(
          {
            date: day,
            mode: "lessons",
            lessons,
            reason:
              `Sinf "${ctx.target.name}" filialiga ko'chirildi — dars o'tilgan, ` +
              "lekin baholar o'quvchilar bilan birga ko'chdi",
          },
          ctx.actor.id,
        );
        credited += result?.created ?? lessons.length;
      } catch (error) {
        warnings.push(
          `${day} kunidagi ${lessons.length} ta o'tilgan dars belgilanmadi — ` +
            `o'qituvchi soati kam chiqishi mumkin (${error.message})`,
        );
        logger.warn(`[branchTransfer] o'tilgan dars belgilanmadi (${day}): ${error.message}`);
      }
    }
    return { credited, days: byDay.size, warnings };
  });
};

/** Navbat qatorini bekor qiladi (maqsadga nusxalash o'tmadi). */
const cancelQueuedRemoval = async (ctx, classIds, reason) => {
  if (classIds.length === 0) return;
  await runWithBranch(ctx.source, async () => {
    await prisma.pendingScheduleRemoval.updateMany({
      where: {
        classId: { in: classIds },
        effectiveMonth: nextMonth(ctx.month),
        status: "pending",
      },
      data: { status: "cancelled", failReason: reason, processedAt: new Date() },
    });
  });
};

/**
 * MAQSAD FILIALGA JADVALNI NUSXALAYDI — tranzaksiyadan KEYIN, jadval yozuv
 * qulfi va rejim tekshiruvi ostida.
 *
 * ⚠️ Maqsad sinfning o'sha kuni ALLAQACHON darsi bo'lsa, o'sha kun
 * TEGILMAYDI: ustiga yozish boshqa sinfning haqiqiy jadvalini jimgina
 * o'chirardi. Bunday kunlar ro'yxat bilan qaytadi.
 *
 * @param {object} ctx
 * @param {Array<{id: string, name: string, targetId: string, schedule: object}>} classes
 * @returns {Promise<{copied: number, warnings: string[], failedClassIds: string[]}>}
 */
const copySchedulesToTarget = async (ctx, classes) => {
  const live = classes.filter((c) => c.schedule && c.schedule.moving > 0);
  const warnings = [];
  if (live.length === 0) return { copied: 0, warnings, failedClassIds: [] };

  // Fanlarni moslash maqsad filialda, oddiy tranzaksiyadan TASHQARIDA
  // bo'lmasligi uchun jadval qulfi ichida bajariladi
  let copied = 0;
  const failedClassIds = [];

  try {
    await runWithBranch(ctx.target, () =>
      withScheduleWriteLock(async (tx) => {
        await assertPlatformMode(tx);

        // Fan moslamasi — `mapSubjects` filiallararo ishlaydi, shuning uchun
        // unga `tx` beriladi (u ham xom SQL bilan ikkala schema'ga qaraydi)
        const allSubjectIds = [...new Set(live.flatMap((c) => c.schedule.subjectIds))];
        const subjects = await mapSubjects(tx, ctx, allSubjectIds);

        for (const klass of live) {
          const existing = await tx.schedule.findMany({
            where: { classId: klass.targetId },
            select: { id: true, day: true, _count: { select: { lessons: true } } },
          });
          const busyDays = new Set(
            existing.filter((row) => row._count.lessons > 0).map((row) => row.day),
          );
          const scheduleIdOf = new Map(existing.map((row) => [row.day, row.id]));

          const byDay = new Map();
          for (const lesson of klass.schedule.lessons) {
            if (busyDays.has(lesson.day)) continue;
            if (!byDay.has(lesson.day)) byDay.set(lesson.day, []);
            byDay.get(lesson.day).push(lesson);
          }

          const blocked = [...new Set(klass.schedule.lessons.map((l) => l.day))].filter((day) =>
            busyDays.has(day),
          );
          if (blocked.length) {
            warnings.push(
              `"${klass.name}" sinfining ${blocked.join(", ")} kunlarida yangi filialda ` +
                "allaqachon dars bor — o'sha kunlar tegilmadi",
            );
          }

          for (const [day, lessons] of byDay) {
            let scheduleId = scheduleIdOf.get(day);
            if (!scheduleId) {
              const created = await tx.schedule.create({
                data: { classId: klass.targetId, day, createdBy: ctx.actor.id },
                select: { id: true },
              });
              scheduleId = created.id;
            }
            await tx.scheduleLesson.createMany({
              data: lessons.map((lesson) => ({
                scheduleId,
                subjectId: subjects.map.get(lesson.subjectId) ?? lesson.subjectId,
                teacherId: lesson.teacherId,
                order: lesson.order,
                startTime: lesson.startTime,
                endTime: lesson.endTime,
                position: lesson.position,
              })),
            });
            copied += lessons.length;
          }
        }
      }),
    );
  } catch (error) {
    logger.error(`[branchTransfer] jadval nusxalanmadi (${ctx.transferId}): ${error.message}`);
    warnings.push(
      `Dars jadvali yangi filialga ko'chirilmadi (${error.message}) — qo'lda tuzing; ` +
        `shu filialdagi jadval ${formatMonthKey(nextMonth(ctx.month))} dan o'chirilmaydi`,
    );
    failedClassIds.push(...live.map((c) => c.id));
  }

  return { copied, warnings, failedClassIds };
};

module.exports = {
  planClassSchedules,
  snapshotMissedLessons,
  creditLostLessons,
  queueSourceRemoval,
  cancelQueuedRemoval,
  copySchedulesToTarget,
};
