/**
 * BEKOR QILINGAN DAVOMAT KUNLARINI O'QISH — yagona nuqta.
 *
 * ⚠️ ALOHIDA HELPER, servis ichida EMAS: shu ro'yxatni UCH joy o'qiydi —
 * kunlik xodimlar ro'yxati ("bu qator nega bo'sh"), kechki "kelmadi" passi
 * (qalqon) va bekor qilish servisining o'zi. Servisga qo'yilsa
 * `attendance.service.js` ↔ `attendanceCancel.service.js` import halqasi
 * paydo bo'lardi (bekor qilish jarimani `gradePenalty.service.js` orqali
 * bekor qiladi va u `studentAttendance` → `attendance.service` ga qaytadi).
 *
 * Ikki nusxa bo'lsa, biriga qo'shilgan shart (masalan "oxirgi bekor qilish
 * yutadi") ikkinchisida tushib qolardi va kunduzi bekor qilingan kun
 * kechqurun jimgina "kelmadi" bo'lib qaytardi.
 */

const prisma = require("../config/prisma");

/**
 * Shu KUNDA bekor qilingan xodimlar.
 *
 * Bir kunda bir nechta bekor qilish bo'lishi mumkin (bekor qilindi →
 * xodim qayta "Men keldim" bosdi → yana bekor qilindi): OXIRGISI yutadi,
 * chunki ekranda ham, qalqonda ham joriy holat kerak.
 *
 * @param {Date} day - Toshkent kunining UTC yarim tuni (`Attendance.date`)
 * @param {string[]} [userIds] - berilmasa o'sha kunning hammasi
 * @returns {Promise<Map<string, object>>} userId → oxirgi bekor qilish
 */
async function loadDayCancellations(day, userIds = null) {
  const where = { date: day };
  if (userIds) {
    if (userIds.length === 0) return new Map();
    where.userId = { in: userIds };
  }

  const rows = await prisma.attendanceCancellation.findMany({
    where,
    // asc — oxirgisi Map'da ustiga yoziladi
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      userId: true,
      status: true,
      reason: true,
      cancelledBy: true,
      createdAt: true,
    },
  });

  const byUser = new Map();
  for (const row of rows) byUser.set(row.userId, row);
  return byUser;
}

module.exports = { loadDayCancellations };
