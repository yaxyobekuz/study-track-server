/**
 * "BAHO QO'YMASLIK" JARIMASI — HISOB VA QAYTA TEKSHIRISH.
 *
 * Kechki pass (`gradePenalty.job.js`) ham, qayta tekshirish ham SHU
 * YERDAGI hisobni chaqiradi. Ilgari hisob jobning ichida edi va
 * "qaysi jarima haqli" degan savolga ikkinchi javob yozilsa, tozalash
 * jarima yozishdan boshqacha ishlardi.
 *
 * ⚠️ JARIMA — DARSGA BITTA HAM BAHO QO'YILMAGAN BO'LSA (biznes qarori,
 * 2026-10-22). O'qituvchi bitta o'quvchiga ham baho qo'ygan bo'lsa, qolganlari
 * baholanmagan bo'lsa ham jarima YOZILMAYDI. Oylikdagi "dars o'tildimi"
 * (`judgeLesson`) va "Men ketdim" darvozasi bilan AYNI qoida: uchala joy bir
 * darsni bir xil baholaydi — "dars o'tilgan, soati to'langan, ketishga ruxsat
 * berilgan, lekin jarima yozilgan" holati bo'lmaydi.
 *   · Ilgari foiz chegarasi bor edi (`missingThresholdPercent`, sukut 40%) —
 *     u OLIB TASHLANGAN (migratsiya `20261022120000_drop_grade_penalty_threshold`),
 *     QAYTA KIRITMANG.
 *   · Fanga RUXSAT bilan (boshqa o'qituvchi) qo'ygan baho va boshqa filialdan
 *     KO'CHGAN baho hisob EMAS — `loadLessonFacts` bilan AYNI: aks holda
 *     dars egasi bitta ham baho qo'ymay jarimadan qutulardi.
 *
 * ⚠️ BAHO KUTILGAN O'QUVCHI YO'Q BO'LSA JARIMA YO'Q. Ro'yxat
 * `gradeExpectation.service.js` dan keladi: maktabdan ketgan, arxivlangan va
 * o'sha kuni KELMAGAN o'quvchi hisobga kirmaydi (hamma kelmagan darsda
 * baholaydigan odam yo'q).
 *
 * ⚠️ DARS BO'LMAGAN BO'LSA JARIMA YO'Q:
 *   · o'qituvchining O'ZI kelmagan yoki sababli (`Attendance`);
 *   · rahbariyat darsni "o'tildi" deb belgilagan (`LessonCredit`) —
 *     baho daftarda, platformada yo'q (`finance.md` §10).
 */

const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const { isHoliday } = require("./holiday.service");
const { getSubstitutionCells, effectiveTeacherOf } = require("../helpers/teacherAccess");
const { dayKey, tashkentDayKey, lessonCreditKey } = require("../helpers/lessonHours");
const { parseDayDate } = require("../helpers/month.helpers");
const { DAYS_UZ } = require("../utils/constants");
const { gradePenaltyTitle } = require("../helpers/gradePenalty.helpers");
const { loadExpectedStudents } = require("./gradeExpectation.service");

/** Kun umuman tekshirilmaydigan sabablar. */
const DAY_SKIP = Object.freeze({
  SUNDAY: "sunday",
  HOLIDAY: "holiday",
  DISABLED: "disabled",
});

/** Dars tekshirildi, lekin jarima yozilmaydigan sabablar. */
const LESSON_SKIP = Object.freeze({
  EXEMPT: "exempt",            // o'qituvchi jarimadan ozod
  TEACHER_AWAY: "teacherAway", // o'qituvchi kelmagan / sababli
  CREDITED: "credited",        // dars "o'tildi" deb belgilangan
  NO_STUDENTS: "noStudents",   // baho kutilgan o'quvchi yo'q
  GRADED: "graded",            // kamida bitta baho qo'yilgan
});

const LESSON_SKIP_LABELS = Object.freeze({
  [LESSON_SKIP.EXEMPT]: "O'qituvchi jarimadan ozod",
  [LESSON_SKIP.TEACHER_AWAY]: "O'qituvchi o'sha kuni kelmagan",
  [LESSON_SKIP.CREDITED]: "Dars \"o'tildi\" deb belgilangan",
  [LESSON_SKIP.NO_STUDENTS]: "Baho kutilgan o'quvchi yo'q",
  [LESSON_SKIP.GRADED]: "Darsga baho qo'yilgan",
});

/**
 * BITTA KUN UCHUN QAYSI DARSGA JARIMA HAQLI.
 *
 * Hech narsa YOZMAYDI — faqat hisoblaydi.
 *
 * ⚠️ `Schedule` — HAFTALIK SHABLON, unda sana yo'q (`education.md` §8).
 * Shuning uchun o'tgan kun uchun hisob JORIY jadvaldan quriladi: jadval
 * o'zgargan bo'lsa, o'sha kundagi dars topilmasligi mumkin. Qayta
 * tekshirish buni ALOHIDA sabab bilan qaytaradi va jim taxmin qilmaydi.
 *
 * @param {Date} day - Toshkent kunining UTC yarim tuni
 * @param {{isEnabled: boolean, penaltyPoints: number,
 *   exemptTeachers: string[]}} settings
 * @returns {Promise<{skip: string|null, lessons: Map<string, object>}>}
 *   kalit — jarima SARLAVHASI (darsning yagona belgisi)
 */
async function computeDayPenalties(day, settings) {
  const lessons = new Map();

  if (!settings.isEnabled) return { skip: DAY_SKIP.DISABLED, lessons };

  // ⚠️ HAFTA KUNI `getUTCDay()` BILAN. `day` — Toshkent kunining UTC yarim
  // tuni, `getDayNameUz`/`isSunday` esa LOKAL `getDay()` ni o'qiydi: manfiy
  // ofsetli hostda kun bir kunga orqaga siljib, butun jadval boshqa kunniki
  // bo'lib qolardi (`lessonCredit.service.js` bilan AYNI naqsh).
  if (day.getUTCDay() === 0) return { skip: DAY_SKIP.SUNDAY, lessons };

  // ⚠️ `isHoliday` sanani LOKAL `setHours(0,0,0,0)` bilan normallashtiradi,
  // shuning uchun unga o'sha kalendar kunning LOKAL TUSHI beriladi — har
  // qanday hostda bitta kunga tushadi.
  const localNoon = new Date(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    12,
    0,
    0,
  );
  const { isHoliday: holiday } = await isHoliday(localNoon);
  if (holiday) return { skip: DAY_SKIP.HOLIDAY, lessons };

  const dayName = DAYS_UZ[day.getUTCDay()];
  const dateStr = dayKey(day);

  const exemptSet = new Set((settings.exemptTeachers || []).map((id) => id.toString()));

  // ⚠️ O'RINBOSARLIK — jarima AMALDA DARSGA CHIQQAN odamga yoziladi:
  // kasal bo'lib darsini boshqaga bergan o'qituvchi, o'rinbosar baho
  // qo'ymagani uchun jarima olib yurardi.
  const substitutionCells = await getSubstitutionCells(day);

  const schedules = await prisma.schedule.findMany({
    where: { day: dayName },
    include: { lessons: true },
  });
  if (schedules.length === 0) return { skip: null, lessons };

  // `Schedule.classId` scalar (relation YO'Q) — sinflarni qo'lda yuklaymiz
  const classIds = [...new Set(schedules.map((s) => s.classId))];
  const classes = await prisma.class.findMany({
    where: { id: { in: classIds } },
    select: { id: true, name: true, isActive: true },
  });
  const classMap = new Map(classes.map((c) => [c.id, c]));

  const [expectedByClass, teacherAbsences, lessonCredits, grades] = await Promise.all([
    loadExpectedStudents(classIds, day),
    prisma.attendance.findMany({
      where: { date: day, status: { in: ["absent", "excused"] } },
      select: { userId: true },
    }),
    prisma.lessonCredit.findMany({
      where: { date: day, revokedAt: null },
      select: { teacherId: true, classId: true, subjectId: true, lessonOrder: true },
    }),
    // ⚠️ `Grade.date` — INSTANT, `@db.Date` EMAS: kun `tashkentDayKey`
    // bilan olinadi (`education.md` §7). Ilgari bu yerda server-lokal
    // `setHours` bilan qurilgan oraliq ishlatilardi va UTC hostda kun
    // besh soatga suriladi.
    prisma.grade.findMany({
      where: {
        classId: { in: classIds },
        date: { gte: dayStart(day), lte: dayEnd(day) },
        // Ruxsat bilan qo'yilgan va ko'chgan baho dars egasining ishi emas
        // (fayl izohi) — `loadLessonFacts` va "Men ketdim" bilan AYNI filtr
        gradingGrantId: null,
        transferredFromBranchId: null,
      },
      select: { classId: true, subjectId: true, lessonOrder: true, studentId: true, date: true },
    }),
  ]);

  const awayTeachers = new Set(teacherAbsences.map((row) => row.userId));
  const creditedLessons = new Set(
    lessonCredits.map((row) =>
      lessonCreditKey(row.teacherId, row.classId, row.subjectId, row.lessonOrder, dateStr),
    ),
  );

  // Baholar: `<classId>|<subjectId>|<lessonOrder>` → baho olgan o'quvchilar
  const gradedByLesson = new Map();
  for (const grade of grades) {
    if (tashkentDayKey(grade.date) !== dateStr) continue;
    const key = `${grade.classId}|${grade.subjectId}|${grade.lessonOrder}`;
    if (!gradedByLesson.has(key)) gradedByLesson.set(key, new Set());
    gradedByLesson.get(key).add(grade.studentId);
  }

  for (const schedule of schedules) {
    const scheduleClass = classMap.get(schedule.classId);
    if (!scheduleClass || !scheduleClass.isActive) continue;

    const expected = expectedByClass.get(schedule.classId) ?? [];

    for (const lesson of schedule.lessons) {
      if (!lesson.teacherId) continue;

      const effective = effectiveTeacherOf(
        {
          classId: schedule.classId,
          day: schedule.day,
          order: lesson.order,
          teacherId: lesson.teacherId,
        },
        substitutionCells,
      );

      const title = gradePenaltyTitle(
        scheduleClass.name,
        lesson.order,
        dateStr,
        effective.substituted,
      );

      const entry = {
        title,
        teacherId: effective.teacherId,
        classId: schedule.classId,
        className: scheduleClass.name,
        subjectId: lesson.subjectId,
        lessonOrder: lesson.order,
        day: dateStr,
        total: expected.length,
        missing: 0,
        deserved: false,
        skip: null,
      };
      lessons.set(title, entry);

      if (exemptSet.has(effective.teacherId.toString())) {
        entry.skip = LESSON_SKIP.EXEMPT;
        continue;
      }
      if (awayTeachers.has(effective.teacherId)) {
        entry.skip = LESSON_SKIP.TEACHER_AWAY;
        continue;
      }
      if (
        creditedLessons.has(
          lessonCreditKey(
            effective.teacherId,
            schedule.classId,
            lesson.subjectId,
            lesson.order,
            dateStr,
          ),
        )
      ) {
        entry.skip = LESSON_SKIP.CREDITED;
        continue;
      }
      if (expected.length === 0) {
        entry.skip = LESSON_SKIP.NO_STUDENTS;
        continue;
      }

      const graded =
        gradedByLesson.get(`${schedule.classId}|${lesson.subjectId}|${lesson.order}`) ?? new Set();

      entry.missing = expected.filter((student) => !graded.has(student.id)).length;

      // ⚠️ BITTA BAHO YETADI (fayl izohi). `graded` — darsdagi HAR QANDAY
      // o'quvchining bahosi, maxrajdagisining emas: kelmagan deb belgilangan
      // bolaga qo'yilgan baho ham darsni o'tilgan qiladi (`judgeLesson` kabi).
      if (graded.size > 0) {
        entry.skip = LESSON_SKIP.GRADED;
        continue;
      }

      entry.deserved = true;
    }
  }

  return { skip: null, lessons };
}

/** Toshkent kunining boshi/oxiri — INSTANT baholar uchun (+5, DST yo'q). */
const dayStart = (day) => new Date(day.getTime() - 5 * 3600000);
const dayEnd = (day) => new Date(day.getTime() + 19 * 3600000 - 1);

/**
 * JARIMA MATNI — faqat haqli jarima uchun (darsda bitta ham baho yo'q).
 *
 * @param {object} entry - `computeDayPenalties` qatori
 * @returns {string}
 */
const penaltyDescription = (entry) =>
  `Darsdagi ${entry.total} o'quvchidan birortasiga ham baho qo'yilmagan`;

/**
 * JARIMANI BEKOR QILADI — compare-and-swap `approved` → `rejected` va
 * o'qituvchidan ballni oladi, 0 dan PASTGA TUSHIRMASDAN (ball boshqa yo'l
 * bilan kamaytirilgan bo'lishi mumkin). Parallel amal uni ikki marta bekor
 * qilib, ballni ikki marta ayira olmaydi.
 *
 * ⚠️ YAGONA NUSXA: "o'tildi" belgisi (`lessonCredit.service.js`) ham, qayta
 * tekshirish ham shuni chaqiradi. Ikki nusxa bo'lsa, biriga qo'shilgan
 * himoya (masalan ball 0 dan pastga tushmasligi) ikkinchisida tushib
 * qolardi.
 *
 * @param {object} tx - Prisma tranzaksiyasi
 * @param {{id: string, userId: string, points: number}} penalty
 * @param {{reason: string, actorId: string, now: Date}} options - `reason`
 *   TO'LIQ matn (chaqiruvchi o'z sababini yozadi)
 * @returns {Promise<number|null>} AYNAN olib tashlangan ball; `null` —
 *   jarima shu orada o'zgargan, tegilmadi
 */
async function cancelPenaltyInTx(tx, penalty, { reason, actorId, now }) {
  const updated = await tx.penalty.updateMany({
    where: { id: penalty.id, status: "approved" },
    data: { status: "rejected", rejectionReason: reason, reviewedBy: actorId, reviewedAt: now },
  });
  if (updated.count !== 1) return null;

  const user = await tx.user.findUnique({
    where: { id: penalty.userId },
    select: { penaltyPoints: true },
  });
  const removed = Math.max(0, Math.min(penalty.points, user?.penaltyPoints ?? 0));
  if (removed > 0) {
    await tx.user.update({
      where: { id: penalty.userId },
      data: { penaltyPoints: { decrement: removed } },
    });
  }
  return removed;
}

/* ─────────────────────── QAYTA TEKSHIRISH ─────────────────────── */

/** Bir amalda tekshiriladigan kunlar chegarasi. */
const MAX_DAYS = 120;

/**
 * O'TGAN KUNLARDAGI JARIMALARNI QAYTA TEKSHIRADI.
 *
 * Yangi qoida bo'yicha endi asoslanmaydigan "baho qo'ymaslik" jarimalari
 * bekor qilinadi va ball qaytariladi. Haqiqatan baho qo'yilmagani JOYIDA
 * qoladi, yangi jarima esa YOZILMAYDI — bu tozalash, qayta jarimalash emas.
 *
 * ⚠️ `apply` berilmasa hech narsa yozilmaydi (quruq yurish) — `perm:grant`
 * bilan AYNI naqsh.
 *
 * ⚠️ Har jarima ALOHIDA tranzaksiyada: bitta buzuq qator butun tozalashni
 * orqaga qaytarmaydi.
 *
 * @param {{from: string, to: string, apply?: boolean}} range - "YYYY-MM-DD"
 * @param {{actorId: string, settings: object}} options
 */
async function recheckRange({ from, to, apply = false }, { actorId, settings }) {
  const fromDay = parseDayDate(from);
  const toDay = parseDayDate(to);
  if (!fromDay || !toDay) throw new Error("Sana noto'g'ri (YYYY-MM-DD kutiladi)");
  if (toDay < fromDay) throw new Error("Oxirgi kun birinchisidan oldin");

  const days = Math.round((toDay - fromDay) / 86400000) + 1;
  if (days > MAX_DAYS) throw new Error(`Ko'pi bilan ${MAX_DAYS} kun tekshiriladi`);

  const report = { days: 0, checked: 0, kept: 0, cancelled: 0, pointsReturned: 0, rows: [] };
  const now = new Date();

  for (let i = 0; i < days; i += 1) {
    const day = new Date(fromDay.getTime() + i * 86400000);
    const dateStr = dayKey(day);

    const existing = await prisma.penalty.findMany({
      where: {
        isCustom: true,
        status: "approved",
        title: { startsWith: "Baho qo'ymaslik:", endsWith: `(${dateStr})` },
      },
      select: { id: true, userId: true, title: true, points: true },
    });

    // Bu kun bo'yicha tekshiriladigan jarima yo'q — hisob ham qilinmaydi
    if (existing.length === 0) continue;

    report.days += 1;
    // ⚠️ `isEnabled` bu yerda SAVOL EMAS: u faqat YANGI jarima yozishni
    // to'xtatadi. Sozlama o'chiq bo'lsa hisob bo'sh qaytib, mavjud HAMMA
    // jarima "Jadvalda bu dars topilmadi" deb bekor qilinib ketardi.
    const { lessons } = await computeDayPenalties(day, { ...settings, isEnabled: true });

    for (const penalty of existing) {
      report.checked += 1;

      // ⚠️ Sarlavha "— o'rinbosarlik" bilan tugashi mumkin: `endsWith`
      // shunda mos kelmaydi, shuning uchun xaritadan to'g'ridan-to'g'ri
      // va o'rinbosarlik variantidan ham qidiriladi.
      const entry =
        lessons.get(penalty.title) ?? lessons.get(`${penalty.title} — o'rinbosarlik`) ?? null;

      if (entry?.deserved) {
        report.kept += 1;
        continue;
      }

      const why = entry
        ? (LESSON_SKIP_LABELS[entry.skip] ?? "Endi asoslanmaydi")
        : "Jadvalda bu dars topilmadi";

      const row = {
        day: dateStr,
        penaltyId: penalty.id,
        userId: penalty.userId,
        title: penalty.title,
        points: penalty.points,
        reason: why,
        applied: false,
      };

      if (apply) {
        try {
          const removed = await prisma.$transaction((tx) =>
            cancelPenaltyInTx(tx, penalty, {
              reason: `Qayta tekshirildi: ${why}`,
              actorId,
              now,
            }),
          );
          if (removed === null) continue; // oraliqda o'zgargan — tegilmadi
          row.applied = true;
          report.pointsReturned += removed;
        } catch (error) {
          logger.error(`[GradePenaltyRecheck] ${penalty.id} bekor qilinmadi: ${error.message}`);
          continue;
        }
      }

      report.cancelled += 1;
      report.rows.push(row);
    }
  }

  return report;
}

module.exports = {
  DAY_SKIP,
  LESSON_SKIP,
  LESSON_SKIP_LABELS,
  MAX_DAYS,
  computeDayPenalties,
  penaltyDescription,
  cancelPenaltyInTx,
  recheckRange,
};
