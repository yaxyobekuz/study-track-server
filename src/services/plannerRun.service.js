/**
 * REJALASHTIRISH — VARIANTLAR va ULARNI QO'LDA TUZATISH.
 *
 * Variant — shakllantirish natijasi. U AMALDAGI jadval emas: bu yerdagi hech
 * bir amal `schedules` / `schedule_lessons` ga tegmaydi.
 *
 * Qo'lda tuzatishda QATTIQ qoidalar (sinf ikki joyda, o'qituvchi ikki joyda,
 * band katak) rad etiladi, YUMSHOQ qoidalar (kunlik chegara, bir xil fan)
 * esa faqat ogohlantiradi: odam ataylab istisno qilayotgan bo'lishi mumkin va
 * uni bloklash "nega bo'lmayapti" degan boshi berk ko'chaga olib borardi.
 */

const prisma = require("../config/prisma");
const {
  BadRequestError,
  NotFoundError,
  ValidationError,
} = require("../utils/errors");
const { getGrid } = require("./plannerSettings.service");
const { getBusySet } = require("./plannerAvailability.service");
const { SCHEDULE_DAYS, busyKey } = require("../helpers/planner.helpers");

// Almashtirish paytidagi vaqtinchalik tartib. Haqiqiy `order` doim >= 1,
// shuning uchun -1 hech qachon to'qnashmaydi va `@@unique` buzilmaydi.
const SWAP_SLOT = -1;

/**
 * Variantlar ro'yxati (darslarsiz — ro'yxat yengil bo'lishi kerak).
 */
async function listRuns() {
  const runs = await prisma.plannerRun.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const authorIds = [...new Set(runs.map((r) => r.generatedBy).filter(Boolean))];
  const authors = authorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: authorIds } },
        select: { id: true, firstName: true, lastName: true, fullName: true },
      })
    : [];
  const authorMap = new Map(authors.map((a) => [a.id, a]));

  return runs.map((run) => ({
    id: run.id,
    name: run.name,
    stats: run.stats,
    unplacedCount: Array.isArray(run.unplaced)
      ? run.unplaced.reduce((sum, u) => sum + (u.missing || 0), 0)
      : 0,
    createdAt: run.createdAt,
    generatedBy: authorMap.get(run.generatedBy) || null,
  }));
}

// Dars ma'lumotnomalarini bitta partiyada yuklaydi (soft ref'lar — relation yo'q).
async function hydrate(lessons) {
  const classIds = [...new Set(lessons.map((l) => l.classId))];
  const subjectIds = [...new Set(lessons.map((l) => l.subjectId))];
  const teacherIds = [...new Set(lessons.map((l) => l.teacherId))];

  const [classes, subjects, teachers] = await Promise.all([
    prisma.class.findMany({
      where: { id: { in: classIds } },
      select: { id: true, name: true },
    }),
    prisma.subject.findMany({
      where: { id: { in: subjectIds } },
      select: { id: true, name: true },
    }),
    prisma.user.findMany({
      where: { id: { in: teacherIds } },
      select: { id: true, firstName: true, lastName: true, fullName: true },
    }),
  ]);

  return {
    classMap: new Map(classes.map((c) => [c.id, c])),
    subjectMap: new Map(subjects.map((s) => [s.id, s])),
    teacherMap: new Map(teachers.map((t) => [t.id, { id: t.id, fullName: t.fullName }])),
  };
}

/**
 * Bitta variant — darslari, gridi va bandligi bilan.
 *
 * Bandlik ham qaytadi: "O'qituvchi bo'yicha" ko'rinishda band kataklar
 * shtrixlanadi, ya'ni jadvalda bo'sh ko'ringan katak aslida bo'sh emasligi
 * darrov ko'rinadi.
 */
async function getRun(id) {
  const run = await prisma.plannerRun.findUnique({
    where: { id },
    include: { lessons: true },
  });
  if (!run) throw new NotFoundError("Variant topilmadi");

  const [grid, busy, refs] = await Promise.all([
    getGrid(),
    getBusySet(),
    hydrate(run.lessons),
  ]);

  const lessons = run.lessons
    .map((lesson) => ({
      id: lesson.id,
      day: lesson.day,
      order: lesson.order,
      isPinned: lesson.isPinned,
      class: refs.classMap.get(lesson.classId) || { id: lesson.classId, name: "—" },
      subject: refs.subjectMap.get(lesson.subjectId) || {
        id: lesson.subjectId,
        name: "—",
      },
      teacher: refs.teacherMap.get(lesson.teacherId) || {
        id: lesson.teacherId,
        fullName: "—",
      },
    }))
    .sort((a, b) => a.order - b.order);

  // Jadvalda ishtirok etgan sinflar va o'qituvchilar — tanlagichlar uchun.
  const classes = [...refs.classMap.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const teachers = [...refs.teacherMap.values()].sort((a, b) =>
    a.fullName.localeCompare(b.fullName),
  );

  return {
    id: run.id,
    name: run.name,
    stats: run.stats,
    unplaced: run.unplaced,
    settingsSnapshot: run.settingsSnapshot,
    createdAt: run.createdAt,
    days: grid.days,
    periods: grid.periods,
    lessons,
    classes,
    teachers,
    busy: [...busy].map((key) => {
      const [teacherId, day, order] = key.split("|");
      return { teacherId, day, order: Number(order) };
    }),
  };
}

/** Variant nomini o'zgartiradi. */
async function renameRun(id, name) {
  const clean = String(name || "").trim();
  if (!clean) throw new BadRequestError("Nom bo'sh bo'lishi mumkin emas");
  if (clean.length > 100) throw new BadRequestError("Nom juda uzun");

  const run = await prisma.plannerRun.findUnique({ where: { id }, select: { id: true } });
  if (!run) throw new NotFoundError("Variant topilmadi");

  return prisma.plannerRun.update({ where: { id }, data: { name: clean } });
}

/** Variantni o'chiradi (darslari kaskad bilan ketadi). */
async function deleteRun(id) {
  const run = await prisma.plannerRun.findUnique({ where: { id }, select: { id: true } });
  if (!run) throw new NotFoundError("Variant topilmadi");
  await prisma.plannerRun.delete({ where: { id } });
  return { id };
}

// Katak grid ichidami?
function assertSlot(day, order, grid) {
  if (!SCHEDULE_DAYS.includes(day) || !grid.days.includes(day)) {
    throw new BadRequestError(`Bu kun jadvalda yo'q: ${day}`);
  }
  const num = Number(order);
  if (!grid.orders.includes(num)) {
    throw new BadRequestError(`${order}-dars jadvalda yo'q`);
  }
  return num;
}

/**
 * YUMSHOQ qoidalar — bloklamaydi, ogohlantiradi.
 *
 * Odam ataylab istisno qilayotgan bo'lishi mumkin ("bugun 8-dars bo'lsin").
 * Uni bloklash "nega bo'lmayapti" degan boshi berk ko'chaga olib borardi,
 * jim qolish esa jadvalni bilinmay buzardi — shuning uchun ogohlantirish.
 */
function softWarnings({ lessons, lesson, day, order, settings }) {
  const warnings = [];
  const sameClassDay = lessons.filter(
    (l) => l.classId === lesson.classId && l.day === day && l.id !== lesson.id,
  );

  if (sameClassDay.length + 1 > settings.maxLessonsPerDay) {
    warnings.push(
      `Sinfda o'sha kuni ${sameClassDay.length + 1} ta dars bo'ladi (chegara ${settings.maxLessonsPerDay})`,
    );
  }

  const sameSubject = sameClassDay.filter((l) => l.subjectId === lesson.subjectId);
  if (sameSubject.length + 1 > settings.maxSameSubjectPerDay) {
    warnings.push(
      `Bir kunda shu fandan ${sameSubject.length + 1} ta bo'ladi (chegara ${settings.maxSameSubjectPerDay})`,
    );
  }

  const teacherDay = lessons.filter(
    (l) => l.teacherId === lesson.teacherId && l.day === day && l.id !== lesson.id,
  );
  if (teacherDay.length + 1 > settings.teacherMaxPerDay) {
    warnings.push(
      `O'qituvchida o'sha kuni ${teacherDay.length + 1} ta dars bo'ladi (chegara ${settings.teacherMaxPerDay})`,
    );
  }

  return warnings;
}

/**
 * Darsni boshqa katakka ko'chiradi. Nishonda o'sha sinfning boshqa darsi
 * tursa — ALMASHTIRADI.
 *
 * @param {string} runId
 * @param {string} lessonId
 * @param {object} target - { day, order }
 */
async function moveLesson(runId, lessonId, target) {
  const [grid, busy] = await Promise.all([getGrid(), getBusySet()]);

  const lesson = await prisma.plannerLesson.findUnique({ where: { id: lessonId } });
  if (!lesson || lesson.runId !== runId) throw new NotFoundError("Dars topilmadi");

  const day = target.day ?? lesson.day;
  const order = assertSlot(day, target.order ?? lesson.order, grid);

  if (day === lesson.day && order === lesson.order) {
    return { moved: false, warnings: [] };
  }

  const lessons = await prisma.plannerLesson.findMany({ where: { runId } });

  // Nishondagi shu sinfning darsi (bo'lsa — almashtiramiz).
  const occupant = lessons.find(
    (l) => l.classId === lesson.classId && l.day === day && l.order === order,
  );

  // ── QATTIQ QOIDALAR ──
  if (busy.has(busyKey(lesson.teacherId, day, order))) {
    throw new ValidationError("O'qituvchi bu katakda band deb belgilangan");
  }

  const teacherClash = lessons.find(
    (l) =>
      l.teacherId === lesson.teacherId &&
      l.day === day &&
      l.order === order &&
      l.id !== lesson.id &&
      l.id !== occupant?.id,
  );
  if (teacherClash) {
    throw new ValidationError(
      "O'qituvchining bu katakda boshqa sinfda darsi bor",
    );
  }

  if (occupant) {
    if (busy.has(busyKey(occupant.teacherId, lesson.day, lesson.order))) {
      throw new ValidationError(
        "Almashtirib bo'lmaydi: ikkinchi darsning o'qituvchisi bo'shatilayotgan katakda band",
      );
    }
    const swapClash = lessons.find(
      (l) =>
        l.teacherId === occupant.teacherId &&
        l.day === lesson.day &&
        l.order === lesson.order &&
        l.id !== occupant.id &&
        l.id !== lesson.id,
    );
    if (swapClash) {
      throw new ValidationError(
        "Almashtirib bo'lmaydi: ikkinchi darsning o'qituvchisi o'sha vaqtda band",
      );
    }
  }

  const settings = grid.settings;
  const warnings = softWarnings({ lessons, lesson, day, order, settings });

  await prisma.$transaction(async (tx) => {
    if (occupant) {
      // `@@unique(runId, classId, day, order)` tufayli to'g'ridan-to'g'ri
      // almashtirib bo'lmaydi — biri vaqtincha chetga chiqariladi.
      await tx.plannerLesson.update({
        where: { id: occupant.id },
        data: { order: SWAP_SLOT },
      });
      await tx.plannerLesson.update({
        where: { id: lesson.id },
        data: { day, order },
      });
      await tx.plannerLesson.update({
        where: { id: occupant.id },
        data: { day: lesson.day, order: lesson.order },
      });
    } else {
      await tx.plannerLesson.update({
        where: { id: lesson.id },
        data: { day, order },
      });
    }
  });

  return { moved: true, swapped: Boolean(occupant), warnings };
}

/** Darsni qadaydi / qadashni bekor qiladi. */
async function setPinned(runId, lessonId, isPinned) {
  const lesson = await prisma.plannerLesson.findUnique({ where: { id: lessonId } });
  if (!lesson || lesson.runId !== runId) throw new NotFoundError("Dars topilmadi");

  return prisma.plannerLesson.update({
    where: { id: lessonId },
    data: { isPinned: Boolean(isPinned) },
  });
}

/** Darsni variantdan olib tashlaydi. */
async function removeLesson(runId, lessonId) {
  const lesson = await prisma.plannerLesson.findUnique({ where: { id: lessonId } });
  if (!lesson || lesson.runId !== runId) throw new NotFoundError("Dars topilmadi");
  await prisma.plannerLesson.delete({ where: { id: lessonId } });
  return { id: lessonId };
}

/**
 * Bo'sh katakka dars qo'shadi — joylashmay qolgan darsni qo'lda joylash uchun.
 *
 * O'qituvchi shu fandan dars berishi SHART: variant rejalashtirish kirimiga
 * mos qolishi kerak, aks holda "Asosiy" tabdagi soatlar bilan jadval
 * bir-biriga to'g'ri kelmay qolardi.
 */
async function addLesson(runId, data) {
  const run = await prisma.plannerRun.findUnique({
    where: { id: runId },
    select: { id: true },
  });
  if (!run) throw new NotFoundError("Variant topilmadi");

  const { classId, subjectId, teacherId } = data;
  if (!classId || !subjectId || !teacherId) {
    throw new BadRequestError("Sinf, fan va o'qituvchi ko'rsatilishi shart");
  }

  const [grid, busy] = await Promise.all([getGrid(), getBusySet()]);
  const day = data.day;
  const order = assertSlot(day, data.order, grid);

  const [klass, subject, link] = await Promise.all([
    prisma.class.findUnique({ where: { id: classId }, select: { id: true } }),
    prisma.subject.findUnique({ where: { id: subjectId }, select: { id: true } }),
    prisma.userSubject.findUnique({
      where: { userId_subjectId: { userId: teacherId, subjectId } },
    }),
  ]);

  if (!klass) throw new BadRequestError("Sinf topilmadi");
  if (!subject) throw new BadRequestError("Fan topilmadi");
  if (!link) {
    throw new BadRequestError("Bu fan o'qituvchiga biriktirilmagan");
  }

  const lessons = await prisma.plannerLesson.findMany({ where: { runId } });

  if (lessons.some((l) => l.classId === classId && l.day === day && l.order === order)) {
    throw new ValidationError("Sinfning bu katagi band");
  }
  if (lessons.some((l) => l.teacherId === teacherId && l.day === day && l.order === order)) {
    throw new ValidationError("O'qituvchining bu katakda boshqa darsi bor");
  }
  if (busy.has(busyKey(teacherId, day, order))) {
    throw new ValidationError("O'qituvchi bu katakda band deb belgilangan");
  }

  const warnings = softWarnings({
    lessons,
    lesson: { id: null, classId, subjectId, teacherId },
    day,
    order,
    settings: grid.settings,
  });

  const created = await prisma.plannerLesson.create({
    data: { runId, classId, day, order, subjectId, teacherId, isPinned: true },
  });

  return { lesson: created, warnings };
}

// "dushanba" → "Dushanba" (eksport ustunida bosh harf bilan turishi kerak).
const dayLabel = (day) => (day ? day.charAt(0).toUpperCase() + day.slice(1) : "—");

/**
 * Excel eksporti uchun tayyor qatorlar.
 * @returns {Promise<{run: object, data: Array}>}
 */
async function getRunForExport(runId) {
  const run = await getRun(runId);
  const dayIndex = new Map(run.days.map((day, index) => [day, index]));
  const periodMap = new Map(run.periods.map((p) => [p.order, p]));

  const data = [...run.lessons]
    .sort((a, b) => {
      const byClass = a.class.name.localeCompare(b.class.name);
      if (byClass !== 0) return byClass;
      const byDay = (dayIndex.get(a.day) ?? 99) - (dayIndex.get(b.day) ?? 99);
      if (byDay !== 0) return byDay;
      return a.order - b.order;
    })
    .map((lesson) => {
      const period = periodMap.get(lesson.order);
      const time =
        period?.startTime && period?.endTime
          ? `${period.startTime}–${period.endTime}`
          : "—";
      return {
        className: lesson.class.name,
        day: dayLabel(lesson.day),
        order: lesson.order,
        time,
        subject: lesson.subject.name,
        teacher: lesson.teacher.fullName,
      };
    });

  return { run, data };
}

module.exports = {
  listRuns,
  getRun,
  renameRun,
  deleteRun,
  moveLesson,
  setPinned,
  addLesson,
  removeLesson,
  getRunForExport,
};
