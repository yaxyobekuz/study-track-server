/**
 * TASDIQLANMAGAN SHEET TAHRIRI — O'QITUVCHI TOMONI (sof funksiyalar, BAZA YO'Q).
 *
 * Sheet rejimida (`education.md` §10) amaldagi jadval mas'ul odam
 * "Qo'llash" ni bosmaguncha o'zgarmaydi. O'qituvchi esa shu oraliqda
 * ilovada ESKI jadvalni ko'rib turadi va buni bilmaydi.
 *
 * ⚠️ OGOHLANTIRISH REJIMGA EMAS, FARQGA BOG'LIQ. Ilgari ilova faqat
 * `GET /schedule-sync/mode` ni bilgani uchun sheet rejimida "jadval
 * to'g'rilanmagan bo'lishi mumkin" degan yozuvni DOIM chiqarib turardi —
 * har kuni ko'rinadigan ogohlantirish esa o'qilmaydigan bezakka aylanadi.
 * Shuning uchun bu yerdagi funksiyalar tahrirning FARQIDAN (`diffStates` →
 * `decorateDiff`) aynan shu o'qituvchiga tegishli darslarni ajratib beradi.
 *
 * ⚠️ FARQ IKKI TOMONGA QARAYDI: o'qituvchining darsi OLIB QO'YILGANI ham
 * (`before.teacherId`), unga YANGI dars berilgani ham (`after.teacherId`)
 * shu o'qituvchiga tegishli. Faqat bittasiga qarasak, "darsim yo'qolib
 * qolgan" degan eng muhim holat jim qolardi.
 */

const { DAYS_UZ } = require("../utils/constants");
const { DAY_ORDER } = require("./scheduleState.helpers");
const { BadRequestError } = require("../utils/errors");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const dayIndex = (day) => {
  const i = DAY_ORDER.indexOf(day);
  return i === -1 ? DAY_ORDER.length : i;
};

/**
 * `?date=YYYY-MM-DD` → hafta kuni.
 *
 * Kun MATNning o'zidan chiqariladi (UTC yarim tunida o'qiladi): sana
 * kalendar kuni, instant emas, shuning uchun taymzona hisobi kerak emas
 * (`dates.md` §4 — "ISO qiymat format emas").
 *
 * Yakshanba ham qabul qilinadi: u `ScheduleDay` enumida yo'q, ya'ni o'sha
 * kunda farq ham bo'lmaydi va ro'yxat bo'sh qaytadi.
 *
 * @param {string|undefined|null} date
 * @returns {{date: string|null, day: string|null}} - `null` — butun hafta
 */
function resolveDayFilter(date) {
  const raw = typeof date === "string" ? date.trim() : "";
  if (!raw) return { date: null, day: null };
  if (!DATE_RE.test(raw)) throw new BadRequestError("Sana YYYY-MM-DD ko'rinishida bo'lishi kerak");

  const [year, month, dayOfMonth] = raw.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, dayOfMonth));
  // Mavjud bo'lmagan sana ("2026-02-31") keyingi oyga surilib ketadi —
  // qaytib o'qib tekshiriladi.
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== dayOfMonth
  ) {
    throw new BadRequestError("Sana noto'g'ri");
  }

  return { date: raw, day: DAYS_UZ[parsed.getUTCDay()] };
}

/**
 * Farqdagi katakni ilovaga ketadigan ko'rinishga keltiradi.
 *
 * Nomlar ham, id'lar ham beriladi: ilova "Fizika → Kimyo" deb yozadi,
 * lekin katakni o'z jadvalidagi dars bilan id bo'yicha solishtiradi.
 */
function lessonCell(cell) {
  if (!cell) return null;
  return {
    subjectId: cell.subjectId,
    subject: cell.subjectName,
    teacherId: cell.teacherId,
    teacher: cell.teacherName,
    startTime: cell.startTime || null,
    endTime: cell.endTime || null,
  };
}

/**
 * Farqdan (decorateDiff natijasi) AYNAN shu o'qituvchining darslarini
 * ajratadi.
 *
 * @param {{classes: Array<{classId: string, className: string, changes: Array<object>}>}|null} diff
 * @param {string} teacherId
 * @param {string|null} [day] - faqat shu hafta kuni (null — butun hafta)
 * @returns {Array<object>}
 */
function teacherLessonsFromDiff(diff, teacherId, day = null) {
  if (!diff || !teacherId) return [];

  const lessons = [];
  for (const cls of diff.classes || []) {
    for (const change of cls.changes || []) {
      if (day && change.day !== day) continue;
      const wasMine = change.before?.teacherId === teacherId;
      const willBeMine = change.after?.teacherId === teacherId;
      if (!wasMine && !willBeMine) continue;

      lessons.push({
        classId: cls.classId,
        className: cls.className,
        day: change.day,
        dayLabel: change.dayLabel,
        order: change.order,
        type: change.type,
        field: change.field,
        // "before" — dars mendan olinadi, "after" — menga beriladi,
        // "both" — dars menda qoladi, lekin fani/vaqti o'zgaradi
        mine: wasMine && willBeMine ? "both" : wasMine ? "before" : "after",
        before: lessonCell(change.before),
        after: lessonCell(change.after),
      });
    }
  }

  return lessons.sort(
    (a, b) =>
      dayIndex(a.day) - dayIndex(b.day) ||
      a.order - b.order ||
      String(a.className).localeCompare(String(b.className), "uz"),
  );
}

/**
 * Farq tegadigan o'qituvchilar — push uchun. Darsi olinadigani ham,
 * yangi dars beriladigani ham ro'yxatda.
 *
 * @param {object|null} diff
 * @returns {Array<string>}
 */
function affectedTeacherIds(diff) {
  const ids = new Set();
  for (const cls of diff?.classes || []) {
    for (const change of cls.changes || []) {
      if (change.before?.teacherId) ids.add(change.before.teacherId);
      if (change.after?.teacherId) ids.add(change.after.teacherId);
    }
  }
  return [...ids];
}

/**
 * O'qituvchi → o'zgargan darslari soni (push matnidagi raqam).
 * @param {object|null} diff
 * @returns {Map<string, number>}
 */
function lessonCountByTeacher(diff) {
  const counts = new Map();
  for (const cls of diff?.classes || []) {
    for (const change of cls.changes || []) {
      const ids = new Set(
        [change.before?.teacherId, change.after?.teacherId].filter(Boolean),
      );
      for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return counts;
}

/**
 * Farqdan (decorateDiff natijasi) BITTA SINFNING o'zgarishlari — o'quvchi
 * jadvali uchun. O'qituvchi kesimidan (`teacherLessonsFromDiff`) farqi:
 * sinfning HAMMA darsi kerak, kimga tegishli ekanidan qat'i nazar.
 *
 * @param {object|null} diff
 * @param {string} classId
 * @returns {Array<{day: string, dayLabel: string, order: number, type: string,
 *   field: string|null, before: object|null, after: object|null}>}
 */
function classChangesFromDiff(diff, classId) {
  if (!diff || !classId) return [];
  const cls = (diff.classes || []).find((c) => c.classId === classId);
  if (!cls) return [];

  return (cls.changes || [])
    .map((change) => ({
      day: change.day,
      dayLabel: change.dayLabel,
      order: change.order,
      type: change.type,
      field: change.field,
      before: lessonCell(change.before),
      after: lessonCell(change.after),
    }))
    .sort((a, b) => dayIndex(a.day) - dayIndex(b.day) || a.order - b.order);
}

/**
 * Sinfning haftalik jadvaliga SHEET BELGISINI qo'yadi (o'quvchi ilovasi).
 *
 * ⚠️ HAFTANING HAMMA KUNI QAYTADI (`DAY_ORDER`), darsi yo'q kun ham
 * (`id: null`, `subjects: []`): sheet'da o'sha kunga dars QO'SHILGAN
 * bo'lishi mumkin — kunning o'zi bo'lmasa, belgini qo'yadigan joy
 * qolmasdi.
 *
 * Belgi uch darajada va ular bir-biriga mos:
 *   · dars  — `sheetDiffers`: shu tartibdagi dars sheet'da boshqacha
 *             (fan/o'qituvchi/vaqt o'zgargan yoki olib tashlangan);
 *   · kun   — `sheetDiffers`: kunda kamida bitta o'zgarish (QO'SHILGAN
 *             dars ham — u bazada yo'q, shuning uchun faqat kunda ko'rinadi),
 *             `sheetChanges` — o'sha kunning o'zgarishlari (oldin/keyin);
 *   · sinf  — chaqiruvchi beradi, chunki farq umuman hisoblanmagan holat
 *             (sheet'da xato) faqat sinf darajasida ma'lum: qaysi dars
 *             o'zgarishini aytib bo'lmaydi.
 *
 * ⚠️ Dars `id` bo'yicha EMAS, KUN + TARTIB bo'yicha moslanadi
 * (`education.md` §8: `ScheduleLesson` id'lari barqaror emas). Bir
 * tartibda ikki dars bo'lsa (takror) — ikkalasi ham belgilanadi.
 *
 * @param {Array<object>} schedules - `getScheduleByClass` natijasi
 * @param {Array<object>} changes - `classChangesFromDiff` natijasi
 * @param {(day: string) => string} labelOf - kun yorlig'i ("Dushanba")
 * @returns {Array<object>}
 */
function markWeekWithSheet(schedules, changes, labelOf) {
  const byDay = new Map((schedules || []).map((s) => [s.day, s]));

  return DAY_ORDER.map((day) => {
    const schedule = byDay.get(day);
    const dayChanges = (changes || []).filter((c) => c.day === day);
    // `added` bazada yo'q darsni bildiradi — mavjud darsni belgilamaydi.
    const changedOrders = new Set(
      dayChanges.filter((c) => c.type !== "added").map((c) => c.order),
    );

    return {
      id: schedule?.id ?? null,
      class: schedule?.class ?? null,
      day,
      dayLabel: labelOf(day),
      subjects: (schedule?.subjects || []).map((lesson) => ({
        ...lesson,
        sheetDiffers: changedOrders.has(lesson.order),
      })),
      sheetDiffers: dayChanges.length > 0,
      sheetChanges: dayChanges,
      updatedAt: schedule?.updatedAt ?? null,
    };
  });
}

module.exports = {
  resolveDayFilter,
  lessonCell,
  teacherLessonsFromDiff,
  classChangesFromDiff,
  markWeekWithSheet,
  affectedTeacherIds,
  lessonCountByTeacher,
};
