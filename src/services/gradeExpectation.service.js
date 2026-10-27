/**
 * "SHU DARSDA BAHO KUTILGAN O'QUVCHILAR" — YAGONA MANBA.
 *
 * Qoida bitta jumlada:
 *
 * > O'qituvchi FAQAT o'zi baho qo'ya oladigan o'quvchi uchun javob beradi.
 *
 * ⚠️ MAXRAJ XATO BO'LSA JARIMA HAM XATO. Ilgari "baho qo'ymaslik" jarimasi
 * (`gradePenalty.job.js`) va "bugun kim baho qo'ymadi" hisoboti
 * (`grade.service.js`) maxrajni sinfdagi HAMMA o'quvchidan olardi — faqat
 * `isActive` bo'yicha filtrlab. Natijada maxrajga baho qo'yib bo'lmaydigan
 * uch toifa kirib qolardi va o'qituvchi hammani baholagan bo'lsa ham
 * jarima olardi:
 *
 *   1. O'SHA KUNI KELMAGAN o'quvchi — maktabda yo'q odamga baho qo'yib
 *      bo'lmaydi. Amalda jarimalarning asosiy sababi aynan shu edi:
 *      "4/15 (27%)" degan raqam o'sha kungi kelmaganlar soni bo'lib chiqdi.
 *   2. MAKTABDAN KETGAN o'quvchi — sinfdan faqat ARXIVLASH chiqaradi
 *      (`education.md` §5), ya'ni o'qish davri yopilgan-u arxivlanmagan
 *      bola `UserClass` da abadiy qolib, HAR KUNI "baho qo'yilmagan" bo'lib
 *      sanalardi. Xato sinfga tegishli bo'lgani uchun o'sha sinfga
 *      kiradigan HAMMA o'qituvchini urardi.
 *   3. `isActive` NOTO'G'RI BAYROQ — u login bayrog'i, "o'qiyaptimi" degan
 *      savolga javob bermaydi (`education.md` §4). Logini o'chirilgan
 *      o'quvchi o'qishda davom etadi.
 *
 * ⚠️ DAVOMAT BELGILANMAGAN BO'LSA — KELGAN deb olinadi (biznes qarori,
 * 2026-10-20). Faqat ANIQ `absent` / `excused` chiqariladi. Aks holda
 * davomat qo'yilmagan kunda jarima tizimi JIMGINA o'chib qolardi.
 * `late` — kelgan (`education.md` §6 dagi AYNI qoida).
 */

const prisma = require("../config/prisma");
const { ROLES } = require("../utils/constants");
const { loadEnrollmentsOn } = require("./studentAttendance.service");

/** Baho qo'yib bo'lmaydigan davomat holatlari. */
const ABSENT_STATUSES = Object.freeze(["absent", "excused"]);

const STUDENT_SELECT = { id: true, firstName: true, lastName: true };

/**
 * SINFLAR BO'YICHA BAHO KUTILGAN O'QUVCHILAR.
 *
 * ⚠️ BITTA SO'ROVDA hamma sinf uchun: chaqiruvchi (kechki jarima passi,
 * hisobot) o'nlab sinf bo'yicha aylanadi va har sinfga alohida so'rov
 * yuborilsa yuzlab so'rov chiqardi.
 *
 * @param {string[]} classIds
 * @param {Date} day - Toshkent kunining UTC yarim tuni
 * @returns {Promise<Map<string, {id: string, firstName: string, lastName: string}[]>>}
 */
async function loadExpectedStudents(classIds, day) {
  const ids = [...new Set((classIds || []).filter(Boolean))];
  const result = new Map(ids.map((classId) => [classId, []]));
  if (ids.length === 0) return result;

  // ⚠️ `isActive` FILTRLANMAYDI (yuqoridagi 3-sabab), `isArchived` esa
  // filtrlanadi: arxivlangan o'quvchi hech bir joriy ro'yxatda ko'rinmaydi
  const students = await prisma.user.findMany({
    where: {
      role: ROLES.STUDENT,
      isArchived: false,
      classes: { some: { classId: { in: ids } } },
    },
    select: {
      ...STUDENT_SELECT,
      classes: { select: { classId: true } },
    },
  });

  if (students.length === 0) return result;

  const studentIds = students.map((student) => student.id);

  const [enrollments, attendance] = await Promise.all([
    // Shu kunni qamragan o'qish davri — "o'qiyaptimi" degan savolning
    // YAGONA javobi (`education.md` §3)
    loadEnrollmentsOn(day, studentIds),
    prisma.studentAttendance.findMany({
      where: {
        studentId: { in: studentIds },
        date: day,
        status: { in: [...ABSENT_STATUSES] },
      },
      select: { studentId: true },
    }),
  ]);

  const away = new Set(attendance.map((row) => row.studentId));

  for (const student of students) {
    if (!enrollments.has(student.id)) continue;
    if (away.has(student.id)) continue;

    const row = { id: student.id, firstName: student.firstName, lastName: student.lastName };
    for (const link of student.classes) {
      // O'quvchi bir nechta sinfda bo'lishi mumkin — faqat SO'RALGAN
      // sinflarga qo'shiladi
      result.get(link.classId)?.push(row);
    }
  }

  return result;
}

module.exports = { ABSENT_STATUSES, loadExpectedStudents };
