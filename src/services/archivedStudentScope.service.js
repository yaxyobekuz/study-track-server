const prisma = require("../config/prisma");
const { ROLES } = require("../utils/constants");

/**
 * ARXIVLANGAN o'quvchilar qatorlarini chiqarib tashlaydigan shart.
 *
 * ⚠️ Arxivlangan o'quvchi joriy o'quvchilar ro'yxatlari va hisobotlarining
 * HECH BIRIDA ko'rinmaydi — u faqat O'quvchilar → Arxiv ro'yxatida qoladi.
 * Ro'yxat `User` dan emas, YOZUVLARDAN (davomat, baho) yig'ilganda arxiv
 * filtri o'z-o'zidan ishlamaydi: davomat hisobotida ketgan bola eski
 * yozuvlari bilan bir oy "Xavfli guruh" da sinfsiz ("-") turib qolgan edi.
 * Bu yozuvlarning `studentId` si `User` bilan Prisma aloqasiga ega emas,
 * shuning uchun shart id ro'yxati bilan quriladi.
 *
 * ⚠️ `isArchived` bo'yicha, `isActive` bo'yicha EMAS: logini o'chirilgan
 * o'quvchi o'qishda davom etadi (`education.md` §4).
 *
 * @returns {Promise<object>} `studentId` maydonli yozuvning (davomat, baho)
 *   where-shartiga qo'shiladi
 */
async function loadArchivedStudentScope() {
  const archived = await prisma.user.findMany({
    where: { role: ROLES.STUDENT, isArchived: true },
    select: { id: true },
  });
  return archived.length
    ? { studentId: { notIn: archived.map((u) => u.id) } }
    : {};
}

module.exports = { loadArchivedStudentScope };
