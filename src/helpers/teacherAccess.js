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
 *   3. FANGA RUXSAT — `GradingGrant`: boshliq o'qituvchiga O'ZINIKI BO'LMAGAN
 *                 sinf+fan darslariga baho qo'yishni muddat bilan ochgan.
 *                 Bu QO'SHIMCHA huquq: dars egasidan hech narsa olinmaydi.
 *                 Faqat baho uchun — shu sabab faqat `resolveLessonAccess`
 *                 (baho yozish) uni o'qiydi; `effectiveTeacherOf` (jarima,
 *                 hisobot, "kim o'tishi kerak edi") unga QARAMAYDI.
 *
 * ⚠️ HUQUQ IKKI TOMONGA HARAKAT QILADI. Faqat ochilsa, ikkala o'qituvchi
 * ham bitta jurnalga yozadigan bo'lib qolardi va "kim o'tdi" degan savolga
 * javob yo'qolardi — oylik esa aynan shu javobdan hisoblanadi.
 *
 * ⚠️ NIMA UCHUN ROL BO'YICHA "ERTA QAYTISH" YO'Q: helper darvoza EMAS, u
 * DARSLAR TO'PLAMINI hisoblaydi. Darsning egasi har doim o'qituvchi bo'ladi,
 * shuning uchun owner/qabulxona uchun to'plam baribir bo'sh chiqadi — bu
 * esa AYNAN bugungi xatti-harakat (`grade.controller.js` allaqachon
 * `teacherId === req.user.id` bo'yicha filtrlaydi). Ya'ni bu qatlam o'z-
 * o'zidan hech kimga yangi huquq bermaydi: yangi huquq faqat boshliq
 * yozgan qarordan keladi (o'rinbosarlik yoki fanga ruxsat). Fanga ruxsat
 * ham rolga qaramaydi — `createGrade` darvozasi baribir o'qituvchi rolini
 * talab qiladi, ruxsat esa faqat o'qituvchiga beriladi.
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
 *   classId: string,
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
      classId: item.classId,
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
 * O'QITUVCHINING SHU KUNDA AMALDAGI FANGA RUXSATLARI (`GradingGrant`).
 *
 * Yopilmagan (`revokedAt = null`) va kunni qamragan ruxsatlar — bitta
 * so'rov; chaqiruvchi ko'p sinfni tekshirsa ham natijani qayta ishlatadi.
 *
 * @param {string} teacherId
 * @param {Date} date - kun (instant ham bo'lishi mumkin — kunga keltiriladi)
 * @param {object} [filter]
 * @param {string} [filter.classId] - faqat shu sinf
 * @returns {Promise<Array<{id: string, classId: string, subjectId: string, lessonOrder: number|null}>>}
 */
async function getGradingGrants(teacherId, date, filter = {}) {
  const target = toDayDate(date);

  return prisma.gradingGrant.findMany({
    where: {
      teacherId,
      revokedAt: null,
      dateFrom: { lte: target },
      dateTo: { gte: target },
      ...(filter.classId ? { classId: filter.classId } : {}),
    },
    select: { id: true, classId: true, subjectId: true, lessonOrder: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Dars shu ruxsatga TUSHADIMI: sinf va fan mos, bitta darsga berilgan
 * bo'lsa — tartib ham.
 *
 * @param {{classId: string, subjectId: string, lessonOrder: number|null}} grant
 * @param {string} classId
 * @param {{subjectId: string, order: number}} lesson
 */
const grantCovers = (grant, classId, lesson) =>
  grant.classId === classId &&
  grant.subjectId === lesson.subjectId &&
  (grant.lessonOrder == null || grant.lessonOrder === lesson.order);

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
 * Har bir ruxsat etilgan dars — jadval qatorining NUSXASI, ustiga
 * `access` ("own" | "substitution" | "grant") va `grantId` qo'shilgan:
 * chaqiruvchi bahoni qaysi yo'l bilan yozayotganini aynan shu darsdan
 * biladi (ruxsat bilan qo'yilgan baho `Grade.gradingGrantId` oladi).
 *
 * ⚠️ USTUNLIK TARTIBI: o'z darsi → o'rinbosarlik → fanga ruxsat. Ruxsat
 * faqat BOSHQA yo'l bilan ochilmagan darsga qo'llanadi — o'z darsidagi baho
 * ruxsat bahosi bo'lib belgilanib, oylikdan tushib qolmasligi uchun.
 * ⚠️ O'RINBOSARGA BERILGAN O'Z DARSINI RUXSAT QAYTA OCHMAYDI: o'rinbosarlik
 * AYNAN shu dars uchun aniqroq qaror ("egasiga yopiladi").
 *
 * @param {object} params
 * @param {object} params.actor - `req.user`
 * @param {string} params.classId
 * @param {string} params.subjectId - `null` bo'lsa fan bo'yicha filtrlanmaydi
 * @param {Date} params.date
 * @param {Array} params.lessons - o'sha kungi sinf darslari
 *   (`{ subjectId, teacherId, order }`), allaqachon yuklangan bo'lsa
 * @param {Map} [params.cells] - `getSubstitutionCells` natijasi (batch uchun)
 * @param {Array} [params.grants] - `getGradingGrants` natijasi (batch uchun)
 * @returns {Promise<{
 *   allowed: boolean,
 *   via: "own"|"substitution"|"grant"|null,
 *   lessons: Array<object & {access: "own"|"substitution"|"grant", grantId: string|null}>,
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
  grants = null,
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

  const [cellMap, grantList] = await Promise.all([
    cells ?? getSubstitutionCells(date, { classId }),
    grants ?? getGradingGrants(actor.id, date, { classId }),
  ]);

  const scoped = subjectId
    ? lessons.filter((l) => l.subjectId === subjectId)
    : lessons;

  const own = [];
  const blocked = [];
  const substituted = [];
  const viaGrant = [];
  let substitutionId = null;

  for (const lesson of scoped) {
    const cell = cellMap.get(cellKey(classId, day, lesson.order));

    // ⚠️ ESKIRGAN KATAK — o'rinbosarlik huquqi BERILMAYDI. Yozuv tuzilgandan keyin sinf
    // jadvali qayta saqlanib, dars boshqa o'qituvchiga o'tgan bo'lishi
    // mumkin. U holda o'rinbosarlik o'z ma'nosini yo'qotadi: u FALON
    // o'qituvchining o'rniga chiqish edi, "bu katakka egalik" emas.
    // Tekshiruvsiz bitta dars ikki kishiga ochilib qolardi
    // (`effectiveTeacherOf` da bu shart allaqachon bor — ikkalasi bir xil
    // savolga bir xil javob berishi SHART).
    const cellIsCurrent = cell && cell.originalTeacherId === lesson.teacherId;

    // O'RNIGA CHIQQAN — huquq ochiq
    if (cellIsCurrent && cell.substituteTeacherId === actor.id) {
      substituted.push({ ...lesson, access: "substitution", grantId: null });
      substitutionId = cell.substitutionId;
      continue;
    }

    if (lesson.teacherId === actor.id) {
      // O'Z DARSI, LEKIN BOSHQAGA BERILGAN — huquq yopiq
      if (cellIsCurrent && cell.originalTeacherId === actor.id) {
        blocked.push({ ...lesson, substitutionId: cell.substitutionId });
        continue;
      }

      own.push({ ...lesson, access: "own", grantId: null });
      continue;
    }

    // BOSHQANING DARSI — faqat boshliq ochgan ruxsat bilan (qo'shimcha huquq)
    const grant = grantList.find((g) => grantCovers(g, classId, lesson));
    if (grant) viaGrant.push({ ...lesson, access: "grant", grantId: grant.id });
  }

  const allowedLessons = [...own, ...substituted, ...viaGrant];

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
    const via = own.length > 0 ? "own" : substituted.length > 0 ? "substitution" : "grant";
    return {
      allowed: true,
      via,
      lessons: allowedLessons,
      blocked,
      blockedMessage,
      substitutionId: via === "substitution" ? substitutionId : null,
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

/**
 * RUXSAT BILAN QO'YILGAN BAHONI TAHRIRLASH/O'CHIRISH HUQUQI.
 *
 * Baho `gradingGrantId` bilan yozilgan bo'lsa, uni o'zgartirish uchun shu
 * sinf+fan+tartib+kunni qamragan AMALDAGI ruxsat kerak (yozilgandagisi
 * shart emas — boshliq uni yopib, yangisini ochgan bo'lishi mumkin).
 * ⚠️ `GradingUnlock` dan farqi ataylab: u o'z darsiga platforma nosozligini
 * to'g'rilash, bu esa BOSHQANING jurnaliga kirish. Ruxsat yopilgach
 * boshqaning jurnalidagi bahoni o'zgartirish ham yopiladi.
 *
 * @param {{teacherId: string, classId: string, subjectId: string, lessonOrder: number}} grade
 * @param {Date} day - bahoning Toshkent kuni (UTC yarim tun)
 * @returns {Promise<boolean>}
 */
async function hasGradingGrantFor(grade, day) {
  const grants = await getGradingGrants(grade.teacherId, day, { classId: grade.classId });
  return grants.some((g) =>
    grantCovers(g, grade.classId, { subjectId: grade.subjectId, order: grade.lessonOrder }),
  );
}

module.exports = {
  cellKey,
  scheduleDayOf,
  toDayDate,
  getSubstitutionCells,
  getGradingGrants,
  effectiveTeacherOf,
  resolveLessonAccess,
  hasGradingGrantFor,
};
