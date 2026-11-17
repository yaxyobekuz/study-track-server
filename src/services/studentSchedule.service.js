/**
 * O'QUVCHINING O'Z SINFI DARS JADVALI — `GET /schedules/my-class`.
 *
 * O'quvchi paneli va ilovasi uchun. Jadval AMALDAGI jadvaldan
 * (`schedules` / `schedule_lessons`, `education.md` §10) va AYNI
 * formatlovchidan (`getScheduleByClass`) olinadi: admin va o'qituvchi
 * ko'radigan jadval bilan bir xil shakl, faqat ustiga SHEET BELGISI
 * qo'yiladi.
 *
 * ⚠️ SINF TOKENDAN: o'quvchi id si `req.user` dan, sinflari esa uning
 * a'zoligidan (`UserClass`). `classId` so'rovda UMUMAN yo'q — aks holda
 * istalgan sinfning jadvalini so'rash mumkin bo'lardi (`/coins/blocks/my`,
 * `/certificates/my` bilan AYNI qoida).
 *
 * ⚠️ SHEET BELGISI (`sheetDiffers`) — "sheet'dagi jadval bazadagidan farq
 * qiladimi". Sheet rejimida amaldagi jadval mas'ul odam "Qo'llash" ni
 * bosmaguncha o'zgarmaydi; shu oraliqda ilova eski jadvalni ko'rsatadi.
 * Belgi bo'lsa, ilova "jadval yangilanmoqda" deb aytadi va o'zgargan darsni
 * ajratadi. Farq o'qituvchi ogohlantirishi bilan BITTA manbadan
 * (`scheduleSheetPending.getPendingForClasses`) — sheet bu yo'lda
 * o'qilmaydi, ikkinchi hisob yozilmaydi.
 *
 * ⚠️ ALOHIDA FAYL, `schedule.service` ichida EMAS: `scheduleSyncReview`
 * `schedule.service` ni talab qiladi, ya'ni u yerdan pending servisini
 * chaqirish aylanma bog'liqlik bo'lardi.
 */

const prisma = require("../config/prisma");
const { DAYS_UZ } = require("../utils/constants");
const { getTashkentDateUtc } = require("../helpers/date.helpers");
const { markWeekWithSheet } = require("../helpers/schedulePending.helpers");
const { getScheduleByClass, dayLabel } = require("./schedule.service");
const { getPendingForClasses } = require("./scheduleSheetPending.service");

/**
 * O'quvchining JORIY sinflari. Nofaol sinf (filiallararo ko'chirishda
 * faqat tarixni ushlab turadi — `finance.md` §12) chiqariladi.
 *
 * @param {string} studentId
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
async function loadStudentClasses(studentId) {
  const links = await prisma.userClass.findMany({
    where: { userId: studentId, class: { isActive: true } },
    select: { class: { select: { id: true, name: true } } },
  });
  return links
    .map((link) => link.class)
    .sort((a, b) => a.name.localeCompare(b.name, "uz"));
}

/**
 * @param {string} studentId - tokendan
 * @returns {Promise<object>}
 */
async function getMyClassSchedule(studentId) {
  const classes = await loadStudentClasses(studentId);
  const classIds = classes.map((c) => c.id);

  const [schedules, sheet] = await Promise.all([
    Promise.all(classIds.map((id) => getScheduleByClass(id))),
    getPendingForClasses(classIds),
  ]);

  const items = classes.map((cls, index) => ({
    classId: cls.id,
    className: cls.name,
    // ⚠️ Sinf darajasidagi belgi kun/dars belgilaridan KENGROQ bo'lishi
    // mumkin: sheet'da xato bo'lsa (`diffAvailable: false`) farq aniq
    // emas, lekin jadval eskirgan bo'lishi mumkin — belgi true, kunlar
    // esa false qoladi (qaysi dars o'zgarishini aytib bo'lmaydi).
    sheetDiffers: sheet.differs(cls.id),
    schedules: markWeekWithSheet(schedules[index], sheet.changesOf(cls.id), dayLabel),
  }));

  return {
    // Bugungi hafta kuni (Toshkent) — ilova shu kunni ochib ko'rsatadi.
    // `getUTCDay` bilan: `getDay` hostning mintaqasini o'qirdi
    // (`education.md` §7).
    today: DAYS_UZ[getTashkentDateUtc().getUTCDay()],
    sheetDiffers: items.some((item) => item.sheetDiffers),
    sheet: {
      mode: sheet.mode,
      // Butun maktab bo'yicha tasdiqlanmagan tahrir bormi
      schoolPending: sheet.schoolPending,
      diffAvailable: sheet.diffAvailable,
      revisionId: sheet.revisionId,
      detectedAt: sheet.detectedAt,
      detectedAtLabel: sheet.detectedAtLabel,
    },
    classes: items,
  };
}

module.exports = { getMyClassSchedule };
