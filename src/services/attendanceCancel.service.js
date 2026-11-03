/**
 * XODIM DAVOMATINI BEKOR QILISH — kun "belgilanmagan" holatiga qaytadi.
 *
 * Tipik hol: kiosk begona odamni tanidi, xodim boshqa filialda edi, admin
 * adashib belgiladi yoki "Men keldim" bexosdan bosildi. Bunday kunni
 * TO'G'RILAB bo'lmaydi: "keldi" deb qo'yish ham, "kelmadi" deb qo'yish ham
 * yolg'on fakt bo'ladi — kun umuman qayd etilmagan bo'lishi kerak.
 *
 * ⚠️ QATOR O'CHIRILADI, "bekor qilindi" degan YANGI HOLAT qo'shilmaydi.
 * Unday holatni davomat foizi (`education.md` §6), kelmagan kun ayirmasi
 * (`finance.md` §10), kechki "kelmadi" passi, baho darvozasi
 * (`gradingPresence.service.js`), hisobotlar va eksportlar — hammasi
 * alohida o'rganishi kerak bo'lardi va bittasi uni "kelmadi" deb o'qib
 * qolardi. Qator o'chirilgach kun HAQIQATAN belgilanmagan bo'ladi:
 * birorta o'quvchi kod o'zgartirilmaydi va ish vaqti ham, ayirma ham,
 * jarima ham yo'qoladi.
 *
 * ⚠️ FAKT ESA YO'QOLMAYDI: o'chirilgan qatorning to'liq nusxasi, sababi
 * va aktyori `attendance_cancellations` da qoladi (append-only) —
 * loyihaning "o'chirilmaydi — bekor qilinadi" doktrinasi shu yerda
 * jurnal orqali bajariladi.
 *
 * ⚠️ ALOHIDA FAYL — `attendance.service.js` ichida EMAS. Jarimani bekor
 * qilish yagona nuqtadan (`gradePenalty.service.js` → `cancelPenaltyInTx`)
 * boradi, u esa `gradeExpectation` → `studentAttendance` orqali
 * `attendance.service` ga qaytadi: import halqasi paydo bo'lib,
 * `studentAttendance.service.js` yarim yuklangan moduldan
 * `getTodayNormalized` ni `undefined` deb olardi.
 */

const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} = require("../utils/errors");
const { normalizeDateTashkent } = require("./attendance.service");
const { cancelPenaltyInTx } = require("./gradePenalty.service");
const { resyncAfterAttendanceChange } = require("./payrollAbsence.service");
const { formatDateUz } = require("../helpers/date.helpers");

/** Sabab uzunligi — paneldagi maydon bilan AYNI. */
const MAX_REASON = 300;

/**
 * Sababni tekshiradi. MAJBURIY: davomat qatori o'chadi va keyin "nega bu
 * kun bo'sh" degan savolga javob faqat shu matnda qoladi.
 *
 * @param {string} value
 * @returns {string}
 */
function parseReason(value) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!clean) throw new BadRequestError("Bekor qilish sababini yozing");
  return clean.slice(0, MAX_REASON);
}

/**
 * BITTA KUNNING DAVOMATINI BEKOR QILADI.
 *
 * ⚠️ Yozuv compare-and-swap bilan boradi (`id` + `updatedAt`): shu orada
 * xodim "Men ketdim" bossa yoki admin vaqtni to'g'rilasa, biz KO'RMAGAN
 * qatorni o'chirib yubormaymiz — 409 qaytadi.
 *
 * ⚠️ Davomat jarimasi (kech kelish / kelmaganlik / erta ketish) BIRGA
 * bekor qilinadi va ball qaytariladi: kuni o'chgan jarimani keyin hech
 * kim tushuntirib berolmasdi. Yagona nuqta — `cancelPenaltyInTx` (ball
 * 0 dan pastga tushmaydi, ikki marta ayirilmaydi).
 *
 * ⚠️ "Men keldim" va qo'lda belgilash KEYIN ham ishlaydi — ular ongli
 * qaror. Bekor qilish faqat AVTOMAT passni to'sadi.
 *
 * @param {{userId: string, date: string|Date, reason: string}} input
 * @param {string} actorId
 * @returns {Promise<{cancellation: object, penaltyPoints: number}>}
 */
async function cancelAttendance({ userId, date, reason }, actorId) {
  if (!userId) throw new BadRequestError("Xodim tanlanmagan");
  const day = normalizeDateTashkent(date);
  if (Number.isNaN(day.getTime())) throw new BadRequestError("Sana noto'g'ri");
  const note = parseReason(reason);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  });
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");
  if (user.role === "student") {
    throw new BadRequestError("Bu yo'l faqat xodim davomati uchun");
  }
  // ⚠️ O'ZINING KUNINI O'ZI BEKOR QILA OLMAYDI (ketish so'rovini o'zi
  // ko'rib chiqa olmasligi bilan AYNI qoida, `education.md` §12): bekor
  // qilish o'sha kungi kech kelish jarimasini ham o'chiradi, ya'ni
  // ruxsat egasi o'z jarimasini o'zi bekor qiladigan yo'l bo'lib qolardi.
  if (userId === actorId) {
    throw new ForbiddenError(
      "O'z davomatingizni o'zingiz bekor qila olmaysiz — boshqa mas'ul xodimga murojaat qiling",
    );
  }

  const record = await prisma.attendance.findUnique({
    where: { userId_date: { userId, date: day } },
  });
  if (!record) {
    throw new NotFoundError(
      `${formatDateUz(day, { utc: true })} kuni bu xodimning davomati belgilanmagan`,
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    // CAS: biz o'qigan qatorning O'ZI o'chadi
    const deleted = await tx.attendance.deleteMany({
      where: { id: record.id, updatedAt: record.updatedAt },
    });
    if (deleted.count !== 1) {
      throw new ConflictError(
        "Davomat shu orada o'zgardi — ro'yxatni yangilab, qaytadan urinib ko'ring",
        { reason: "attendance_changed" },
      );
    }

    // Kuni o'chgan jarima qolib ketmasin
    let penaltyPoints = 0;
    if (record.penaltyApplied && record.penaltyRef) {
      const penalty = await tx.penalty.findUnique({
        where: { id: record.penaltyRef },
        select: { id: true, userId: true, points: true },
      });
      if (penalty) {
        const removed = await cancelPenaltyInTx(tx, penalty, {
          reason: `Davomat bekor qilindi: ${note}`,
          actorId,
          now: new Date(),
        });
        penaltyPoints = removed ?? 0;
      }
    }

    const cancellation = await tx.attendanceCancellation.create({
      data: {
        userId,
        date: day,
        status: record.status,
        checkIn: record.checkIn,
        checkOut: record.checkOut,
        snapshot: record,
        reason: note,
        penaltyRef: record.penaltyRef,
        penaltyPoints,
        cancelledBy: actorId,
      },
    });

    return { cancellation, penaltyPoints };
  });

  // Kelmagan kun ayirmasi moliyada ham darhol qaytsin (kutilmaydi, xatosi
  // bekor qilishni yiqitmaydi — 06:00 dagi pass zaxira)
  resyncAfterAttendanceChange(userId, day);

  logger.info(
    `[attendance] Davomat bekor qilindi: user=${userId} ` +
      `date=${day.toISOString().slice(0, 10)} status=${record.status} ` +
      `actor=${actorId} penaltyPoints=${result.penaltyPoints}`,
  );

  return result;
}

module.exports = {
  cancelAttendance,
  MAX_REASON,
};
