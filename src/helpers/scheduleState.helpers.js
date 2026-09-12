/**
 * BUTUN MAKTAB JADVALI HOLATI — sof funksiyalar (BAZA YO'Q).
 *
 * "Holat" — `schedules` jadvalining qatorlari, har biri o'z darslari bilan:
 *
 *   [{ classId, day, lessons: [{ order, subjectId, teacherId, startTime, endTime, position }] }]
 *
 * ⚠️ Qatorlar (class, day) bo'yicha BIRLASHTIRILMAYDI. Versiyalash
 * migratsiyasi qoldig'i tufayli ba'zi bazalarda bir sinf-kun uchun ikki
 * qator bo'lishi mumkin. Arxiv nusxa ularni alohida saqlaydi, shuning uchun
 * tiklash avvalgi holatni AYNAN qaytaradi.
 *
 * Bu yerdagi funksiyalarni sheet'ni qo'llash, rejimni almashtirish va
 * versiyani tiklash — uchalasi ham chaqiradi: imzo, to'qnashuv va farq
 * qoidasi bitta joyda bo'lmasa, ekrandagi "farq" bilan yoziladigan narsa
 * bir-biridan ajralib qolardi.
 */

const crypto = require("crypto");
const { DAYS } = require("../utils/constants");

// ScheduleDay enum tartibi (dushanba → shanba)
const DAY_ORDER = Object.values(DAYS);
const dayIndex = (day) => {
  const i = DAY_ORDER.indexOf(day);
  return i === -1 ? DAY_ORDER.length : i;
};

/**
 * Dars maydonlarini bir xil ko'rinishga keltiradi (bo'sh vaqt → null).
 * @param {object} lesson
 * @returns {{order: number, subjectId: string, teacherId: string, startTime: string|null, endTime: string|null}}
 */
function canonicalLesson(lesson) {
  return {
    order: Number(lesson.order),
    subjectId: String(lesson.subjectId),
    teacherId: String(lesson.teacherId),
    startTime: lesson.startTime || null,
    endTime: lesson.endTime || null,
  };
}

/**
 * Holatning ANIQ imzosi. Ikki vazifasi bor:
 *   1. Optimistik qulf: odam ko'rib chiqqan holat (amaldagi va yoziladigan)
 *      yozish paytidagi holat bilan AYNAN bir xilmi?
 *   2. Yozuvni tekshirish: arxiv nusxa va yozilgan jadval kutilgan holat
 *      bilan mos kelmasa tranzaksiya orqaga qaytadi — "tiklab bo'lmaydigan
 *      arxiv" jimgina paydo bo'lmasligi uchun.
 *
 * Qatorlar ALOHIDA qoladi (bir sinf-kun uchun ikki qator bitta qatorga
 * "qo'shilib" ketmaydi), darssiz qator ham, `position` ham imzoga kiradi
 * (bot darslarni `position` bo'yicha tartiblaydi). Qator id'lari va
 * `createdBy` kirmaydi: ular jadval MAZMUNI emas. Tartib qatorlar
 * kelish tartibiga bog'liq emas (kod birligi bo'yicha saralanadi).
 *
 * @param {Array<{classId: string, day: string, lessons: Array<object>}>} rows
 * @returns {string} sha256 hex
 */
function hashState(rows) {
  const serialized = rows.map((row) => {
    const lessons = (row.lessons || [])
      .map((lesson) => {
        const l = canonicalLesson(lesson);
        return [l.order, l.subjectId, l.teacherId, l.startTime || "", l.endTime || "", Number(lesson.position)].join("|");
      })
      .sort();
    return `${row.classId}|${row.day}#${lessons.join(",")}`;
  });
  serialized.sort();
  return crypto.createHash("sha256").update(serialized.join("\n")).digest("hex");
}

/**
 * Sheet darslaridan (id'lari hal qilingan) qatorlar yasaydi: har sinf-kun
 * uchun bitta qator, darslar tartib bo'yicha, `position` = indeks.
 *
 * @param {Array<{classId: string, day: string, order: number, subjectId: string,
 *   teacherId: string, startTime: string|null, endTime: string|null}>} lessons
 * @returns {Array<{classId: string, day: string, lessons: Array<object>}>}
 */
function buildRowsFromLessons(lessons) {
  const byKey = new Map();
  for (const lesson of lessons) {
    const key = `${lesson.classId}|${lesson.day}`;
    if (!byKey.has(key)) byKey.set(key, { classId: lesson.classId, day: lesson.day, lessons: [] });
    byKey.get(key).lessons.push(canonicalLesson(lesson));
  }

  return [...byKey.values()]
    .map((row) => ({
      ...row,
      lessons: row.lessons
        .sort((a, b) => a.order - b.order)
        .map((lesson, position) => ({ ...lesson, position })),
    }))
    .sort((a, b) => a.classId.localeCompare(b.classId) || dayIndex(a.day) - dayIndex(b.day));
}

/**
 * O'qituvchining parallel bandligi — BUTUN holat ichida.
 *
 * Qoida `collectTeacherConflicts` bilan bir xil: bir o'qituvchi bir kunda
 * bir xil tartib raqamida ikki sinfda tura olmaydi. Farqi — bu yerda
 * tekshiriladigan holat YANGI holatning o'zi (eski holatga qarab
 * tekshirilsa, o'qituvchi 5-A dan 5-B ga ko'chirilganda "5-A da band" degan
 * soxta xato chiqardi).
 *
 * @param {Array<object>} rows
 * @param {{skipClassIds?: Set<string>}} [options] - hisobga olinmaydigan
 *   sinflar (masalan, o'chirilgan sinfdan qolib ketgan qatorlar)
 * @returns {Array<{day: string, order: number, teacherId: string, classIds: string[]}>}
 */
function conflictsInState(rows, { skipClassIds = new Set() } = {}) {
  const busy = new Map();
  for (const row of rows) {
    if (skipClassIds.has(row.classId)) continue;
    for (const lesson of row.lessons || []) {
      const key = `${row.day}|${lesson.teacherId}|${Number(lesson.order)}`;
      if (!busy.has(key)) busy.set(key, new Set());
      busy.get(key).add(row.classId);
    }
  }

  const conflicts = [];
  for (const [key, classIds] of busy) {
    if (classIds.size < 2) continue;
    const [day, teacherId, order] = key.split("|");
    conflicts.push({ day, order: Number(order), teacherId, classIds: [...classIds].sort() });
  }
  return conflicts.sort(
    (a, b) => dayIndex(a.day) - dayIndex(b.day) || a.order - b.order || a.teacherId.localeCompare(b.teacherId),
  );
}

/**
 * Sinf-kun-tartib bo'yicha katak xaritasi. Bir katakda bir nechta dars
 * bo'lsa (takroriy qatorlar), hammasi saqlanadi.
 */
function cellMap(rows, classIds) {
  const map = new Map();
  for (const row of rows) {
    if (classIds && !classIds.has(row.classId)) continue;
    for (const lesson of row.lessons || []) {
      const key = `${row.classId}|${row.day}|${Number(lesson.order)}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(canonicalLesson(lesson));
    }
  }
  return map;
}

const sameLesson = (a, b) =>
  a.subjectId === b.subjectId &&
  a.teacherId === b.teacherId &&
  (a.startTime || null) === (b.startTime || null) &&
  (a.endTime || null) === (b.endTime || null);

/**
 * Ikki holat orasidagi farq — faqat berilgan sinflar bo'yicha (bo'sh =
 * hamma sinf).
 *
 * @param {Array<object>} beforeRows - amaldagi holat
 * @param {Array<object>} afterRows - yoziladigan holat
 * @param {Set<string>|null} [classIds]
 * @returns {{changes: Array<{classId: string, day: string, order: number,
 *   type: "added"|"removed"|"changed", before: object|null, after: object|null}>,
 *   changedClassIds: string[]}}
 */
function diffStates(beforeRows, afterRows, classIds = null) {
  const before = cellMap(beforeRows, classIds);
  const after = cellMap(afterRows, classIds);
  const keys = new Set([...before.keys(), ...after.keys()]);

  const changes = [];
  for (const key of keys) {
    const b = before.get(key) || [];
    const a = after.get(key) || [];
    const [classId, day, order] = key.split("|");

    // Takroriy qatorlar: ikkala tomonda ham bittadan bo'lib, bir xil
    // bo'lsagina "o'zgarmagan". Aks holda farq sifatida ko'rsatiladi.
    if (b.length === 1 && a.length === 1 && sameLesson(b[0], a[0])) continue;
    if (b.length === 0 && a.length === 0) continue;

    let type = "changed";
    if (b.length === 0) type = "added";
    else if (a.length === 0) type = "removed";

    // Nima o'zgargani: faqat o'qituvchi almashishi (odatda vaqtinchalik
    // o'rinbosarlik — u jadvalda emas, o'rinbosarlik bo'limida qilinadi)
    // yoki faqat fan almashishi (odatda noto'g'ri moslash) — alohida
    // ko'rsatiladi.
    let field = null;
    if (type === "changed" && b.length === 1 && a.length === 1) {
      const sameSubject = b[0].subjectId === a[0].subjectId;
      const sameTeacher = b[0].teacherId === a[0].teacherId;
      const sameTime =
        (b[0].startTime || null) === (a[0].startTime || null) &&
        (b[0].endTime || null) === (a[0].endTime || null);
      if (sameSubject && !sameTeacher && sameTime) field = "teacher";
      else if (!sameSubject && sameTeacher && sameTime) field = "subject";
      else if (sameSubject && sameTeacher && !sameTime) field = "time";
    }

    changes.push({
      classId,
      day,
      order: Number(order),
      type,
      field,
      before: b[0] || null,
      after: a[0] || null,
      beforeCount: b.length,
      afterCount: a.length,
    });
  }

  changes.sort(
    (x, y) => x.classId.localeCompare(y.classId) || dayIndex(x.day) - dayIndex(y.day) || x.order - y.order,
  );
  return { changes, changedClassIds: [...new Set(changes.map((c) => c.classId))] };
}

/**
 * Holatdagi darslar soni.
 * @param {Array<object>} rows
 * @returns {number}
 */
function countLessons(rows) {
  return rows.reduce((sum, row) => sum + (row.lessons ? row.lessons.length : 0), 0);
}

module.exports = {
  DAY_ORDER,
  canonicalLesson,
  hashState,
  buildRowsFromLessons,
  conflictsInState,
  diffStates,
  countLessons,
};
