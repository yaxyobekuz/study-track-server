/**
 * O'QITUVCHINING DARSGA HUQUQI — YAGONA QOIDA.
 *
 * Savol bitta: "shu odam AYNAN shu darsga (sinf + fan + sana + tartib)
 * yozish huquqiga egami?". Javob uch manbadan chiqadi:
 *
 *   1. O'Z DARSI — `ScheduleLesson.teacherId`. Butun tizimda "bu darsning
 *                 o'qituvchisi kim" degan savolning yagona javobi shu.
 *   2. O'RINBOSARLIK — `LessonSubstitution` amalda bo'lsa, huquq KO'CHADI:
 *                 o'rinbosarga ochiladi, egasiga esa AYNAN o'sha dars uchun
 *                 YOPILADI (u faqat ko'rish rejimida qoladi).
 *
 * ⚠️ HUQUQ IKKI TOMONGA HARAKAT QILADI. Faqat ochilsa, ikkala o'qituvchi
 * ham bitta jurnalga yozadigan bo'lib qolardi va "kim o'tdi" degan savolga
 * javob yo'qolardi — oylik esa aynan shu javobdan hisoblanadi.
 *
 * ⚠️ NIMA UCHUN ROL BO'YICHA "ERTA QAYTISH" YO'Q: helper darvoza EMAS, u
 * DARSLAR TO'PLAMINI hisoblaydi. Darsning egasi har doim o'qituvchi bo'ladi,
 * shuning uchun owner/qabulxona uchun to'plam baribir bo'sh chiqadi — bu
 * esa AYNAN bugungi xatti-harakat (`grade.controller.js` allaqachon
 * `teacherId === req.user.id` bo'yicha filtrlaydi). Ya'ni bu qatlam hech
 * kimga yangi huquq bermaydi, faqat o'rinbosarlik farqini qo'shadi.
 *
 * ⚠️ NIMA UCHUN HELPER, SERVICE EMAS: chaqiruvchilari controller
 * (`grade.controller.js`), service (`studentAttendance.service.js`) va cron
 * (`gradePenalty.job.js`). Service bo'lsa, controller service'ni chaqirar,
 * service esa controller mantiqini takrorlardi — qoida ikkiga bo'linardi.
 */

const prisma = require("../config/prisma");
const { DAYS_UZ } = require("../utils/constants");

/** Katak kaliti — `scheduleLessonId` EMAS (jadval qayta saqlanadi). */
const cellKey = (classId, day, lessonOrder) => `${classId}|${day}|${lessonOrder}`;

/**
 * Sananing hafta kuni nomi — `getUTC*` bilan.
 *
 * ⚠️ Yakshanba ham qaytadi ("yakshanba"), lekin u `ScheduleDay` enumida
 * YO'Q. Chaqiruvchi uni Prisma so'roviga bermasligi kerak — shuning uchun
 * bu yerda `null` qaytariladi va shart bitta joyda qoladi.
 *
 * @param {Date} date
 * @returns {string|null}
 */
function scheduleDayOf(date) {
  const name = DAYS_UZ[date.getUTCDay()];
  return name === "yakshanba" ? null : name;
}

/**
 * Sanani KUNGA keltiradi (UTC yarim tun).
 *
 * Jurnaldagi sanalar har xil turda saqlanadi (`Grade.date` — haqiqiy
 * instant, `StudentAttendance.date` — Toshkent yarim tuni), o'rinbosarlik
 * oynasi esa `@db.Date`. Taqqoslashdan OLDIN ikkalasi ham kunga keltiriladi,
 * aks holda "21:30 da yozilgan baho ertangi kunga tushib" qolardi.
 *
 * @param {Date|string} value
 * @returns {Date} UTC yarim tun
 */
function toDayDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/**
 * BERILGAN SANADA AMALDAGI O'RINBOSARLIK KATAKLARI.
 *
 * Bitta so'rov, natija xaritada — chaqiruvchi N ta darsni sikl ichida
 * tekshirsa ham qo'shimcha so'rov bo'lmaydi.
 *
 * @param {Date} date
 * @param {object} [filter]
 * @param {string} [filter.classId] - faqat shu sinf
 * @returns {Promise<Map<string, {
 *   substitutionId: string,
 *   originalTeacherId: string,
 *   substituteTeacherId: string,
 *   subjectId: string,
 *   snapshot: object
 * }>>}
 */
async function getSubstitutionCells(date, filter = {}) {
  const map = new Map();

  const day = scheduleDayOf(toDayDate(date));
  if (!day) return map; // yakshanba — dars yo'q, o'rinbosarlik ham bo'lmaydi

  const target = toDayDate(date);

  const items = await prisma.lessonSubstitutionItem.findMany({
    where: {
      day,
      ...(filter.classId ? { classId: filter.classId } : {}),
      substitution: {
        status: "active",
        fromDate: { lte: target },
        toDate: { gte: target },
      },
    },
    include: {
      substitution: {
        select: {
          id: true,
          originalTeacherId: true,
          substituteTeacherId: true,
          teacherSnapshot: true,
        },
      },
    },
  });

  for (const item of items) {
    map.set(cellKey(item.classId, item.day, item.lessonOrder), {
      substitutionId: item.substitution.id,
      originalTeacherId: item.substitution.originalTeacherId,
      substituteTeacherId: item.substitution.substituteTeacherId,
      subjectId: item.subjectId,
      snapshot: item.snapshot,
      teacherSnapshot: item.substitution.teacherSnapshot,
    });
  }

  return map;
}

/**
 * DARSNING AMALDAGI O'QITUVCHISI — o'rinbosarlik hisobga olingan holda.
 *
 * Jarima va hisobotlar uchun: "bu darsni kim o'tishi kerak edi".
 *
 * @param {{classId: string, day: string, order: number, teacherId: string}} lesson
 * @param {Map} cells - `getSubstitutionCells` natijasi
 * @returns {{teacherId: string, substituted: boolean, substitutionId: string|null}}
 */
function effectiveTeacherOf(lesson, cells) {
  const cell = cells.get(cellKey(lesson.classId, lesson.day, lesson.order));

  if (!cell || cell.originalTeacherId !== lesson.teacherId) {
    return { teacherId: lesson.teacherId, substituted: false, substitutionId: null };
  }

  return {
    teacherId: cell.substituteTeacherId,
    substituted: true,
    substitutionId: cell.substitutionId,
  };
}

/**
 * O'QITUVCHI SHU SINF+FANDA QAYSI DARSLARGA YOZA OLADI.
 *
 * Natija — darslar ro'yxati, chunki bitta sinfda bitta fandan bir kunda
 * bir nechta dars bo'lishi mumkin va chaqiruvchi `lessonOrder` ni shu
 * ro'yxatdan tekshiradi.
 *
 * @param {object} params
 * @param {object} params.actor - `req.user`
 * @param {string} params.classId
 * @param {string} params.subjectId - `null` bo'lsa fan bo'yicha filtrlanmaydi
 * @param {Date} params.date
 * @param {Array} params.lessons - o'sha kungi sinf darslari
 *   (`{ subjectId, teacherId, order }`), allaqachon yuklangan bo'lsa
 * @param {Map} [params.cells] - `getSubstitutionCells` natijasi (batch uchun)
 * @returns {Promise<{
 *   allowed: boolean,
 *   via: "own"|"substitution"|null,
 *   lessons: Array,
 *   blocked: Array,
 *   blockedMessage: string|null,
 *   substitutionId: string|null,
 *   message: string|null
 * }>}
 */
async function resolveLessonAccess({
  actor,
  classId,
  subjectId = null,
  date,
  lessons = [],
  cells = null,
}) {
  const day = scheduleDayOf(toDayDate(date));
  if (!day) {
    return {
      allowed: false,
      via: null,
      lessons: [],
      blocked: [],
      blockedMessage: null,
      substitutionId: null,
      message: "Yakshanba kuni dars yo'q",
    };
  }

  const cellMap = cells ?? (await getSubstitutionCells(date, { classId }));

  const scoped = subjectId
    ? lessons.filter((l) => l.subjectId === subjectId)
    : lessons;

  const own = [];
  const blocked = [];
  const granted = [];
  let substitutionId = null;

  for (const lesson of scoped) {
    const cell = cellMap.get(cellKey(classId, day, lesson.order));

    // ⚠️ ESKIRGAN KATAK — grant BERILMAYDI. Yozuv tuzilgandan keyin sinf
    // jadvali qayta saqlanib, dars boshqa o'qituvchiga o'tgan bo'lishi
    // mumkin. U holda o'rinbosarlik o'z ma'nosini yo'qotadi: u FALON
    // o'qituvchining o'rniga chiqish edi, "bu katakka egalik" emas.
    // Tekshiruvsiz bitta dars ikki kishiga ochilib qolardi
    // (`effectiveTeacherOf` da bu shart allaqachon bor — ikkalasi bir xil
    // savolga bir xil javob berishi SHART).
    const cellIsCurrent = cell && cell.originalTeacherId === lesson.teacherId;

    // O'RNIGA CHIQQAN — huquq ochiq
    if (cellIsCurrent && cell.substituteTeacherId === actor.id) {
      granted.push(lesson);
      substitutionId = cell.substitutionId;
      continue;
    }

    if (lesson.teacherId !== actor.id) continue;

    // O'Z DARSI, LEKIN BOSHQAGA BERILGAN — huquq yopiq
    if (cellIsCurrent && cell.originalTeacherId === actor.id) {
      blocked.push({ ...lesson, substitutionId: cell.substitutionId });
      continue;
    }

    own.push(lesson);
  }

  const allowedLessons = [...own, ...granted];

  // ⚠️ "BERIB YUBORILGAN DARS" XABARI HAR DOIM HISOBLANADI, hatto ruxsat
  // berilgan bo'lsa ham. Sabab: o'qituvchida ikkita dars bo'lib, faqat
  // bittasi ko'chirilgan bo'lishi mumkin — u holda `allowed` rost, lekin
  // AYNAN o'sha darsga yozmoqchi bo'lganda chaqiruvchi shu xabarni
  // ko'rsatishi kerak. Aks holda odam "dars tartibi noto'g'ri" degan
  // umumiy xatoni olib, jadval buzilgan deb o'ylardi.
  const blockedMessage =
    blocked.length > 0
      ? (() => {
          const name = cellMap.get(cellKey(classId, day, blocked[0].order))
            ?.teacherSnapshot?.substitute?.name;
          return (
            `Bu dars vaqtincha ${name ? `${name} ga` : "boshqa o'qituvchiga"} ` +
            "berilgan — siz uchun faqat ko'rish rejimi ochiq"
          );
        })()
      : null;

  if (allowedLessons.length > 0) {
    return {
      allowed: true,
      via: own.length > 0 ? "own" : "substitution",
      lessons: allowedLessons,
      blocked,
      blockedMessage,
      substitutionId: own.length > 0 ? null : substitutionId,
      message: null,
    };
  }

  // Hech narsa ochiq emas — SABABI aniq bo'lishi kerak.
  if (blocked.length > 0) {
    return {
      allowed: false,
      via: null,
      lessons: [],
      blocked,
      blockedMessage,
      substitutionId: blocked[0].substitutionId,
      message: blockedMessage,
    };
  }

  return {
    allowed: false,
    via: null,
    lessons: [],
    blocked: [],
    blockedMessage: null,
    substitutionId: null,
    message: `Bugun (${day}) ushbu sinfda sizning bu fan darslaringiz yo'q`,
  };
}

module.exports = {
  cellKey,
  scheduleDayOf,
  toDayDate,
  getSubstitutionCells,
  effectiveTeacherOf,
  resolveLessonAccess,
};
