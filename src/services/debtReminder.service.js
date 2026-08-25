/**
 * QARZDORLARGA TELEGRAM ESLATMASI.
 *
 * Undirish jarayonining birinchi qadami: ota-onaga "qancha qarz bor va
 * qaysi oydan beri" degan xabar boradi. Pul harakatlanmaydi, hech narsa
 * yozilmaydi — shuning uchun bu amal `finance.pay` emas, alohida
 * `debtors.remind` ruxsati bilan boshqariladi.
 *
 * NIMA UCHUN MAVJUD XABAR INFRATUZILMASI:
 * Har eslatma oddiy `Message` yozuvi sifatida saqlanadi va navbat orqali
 * yuboriladi. Buning uchta natijasi bor:
 *   1. "Xabarlar" sahifasida eslatma tarixi ko'rinadi — kimga, qachon,
 *      qanday matn ketgani auditda qoladi;
 *   2. Telegram tezlik chegarasi allaqachon navbatda hal qilingan;
 *   3. Yetkazilmagan xabar (bloklangan bot) `deliveryStatus` da ko'rinadi.
 *
 * ⚠️ HAR O'QUVCHIGA ALOHIDA `Message`: matn ichida aynan o'sha o'quvchining
 * summasi bor, ya'ni bitta umumiy yozuv bilan almashtirib bo'lmaydi.
 */

const prisma = require("../config/prisma");
const messageQueueService = require("./messageQueue.service");
const { escapeHtml } = require("../helpers/changelogMessage.helpers");
const { formatMonthKey } = require("../helpers/month.helpers");
const { Decimal } = require("../helpers/money.helpers");
const { BadRequestError } = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const logger = require("../utils/logger");

// Bir chaqiruvda yuboriladigan eng ko'p eslatma. Navbat o'zi sekin
// yuboradi, lekin bitta so'rovda 500 ta xabar yaratish bazaga ham,
// "bexosdan hammaga yubordim" xatosiga ham yo'l ochadi.
const MAX_RECIPIENTS = 200;

// Ota-onaga ketadigan matnda izoh — erkin matn, uzunligi cheklanadi
const MAX_NOTE_LENGTH = 300;

/**
 * Summani o'qishga qulay ko'rinishga keltiradi: 1200000 → "1 200 000".
 *
 * Bu FAQAT xabar matni uchun. API'da summa har doim 2 xonali string
 * (`formatAmount`) bo'lib qoladi — `finance.md` §0.
 *
 * @param {Decimal} amount
 * @returns {string}
 */
const formatSumUz = (amount) => {
  const whole = new Decimal(amount).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return whole.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
};

/**
 * Bitta o'quvchi uchun eslatma matni (Telegram HTML).
 *
 * @param {{studentName: string, debt: Decimal, unpaidCount: number,
 *          oldestMonth: number, note: string}} params
 * @returns {string}
 */
const buildReminderText = ({ studentName, debt, unpaidCount, oldestMonth, note }) => {
  const lines = [
    "💰 <b>To'lov eslatmasi</b>",
    "",
    `👤 O'quvchi: <b>${escapeHtml(studentName)}</b>`,
    `📅 To'lanmagan oylar: <b>${unpaidCount} ta</b> (eng eskisi — ${escapeHtml(
      formatMonthKey(oldestMonth) ?? "",
    )})`,
    `🔴 Jami qarz: <b>${formatSumUz(debt)} so'm</b>`,
  ];

  if (note) {
    lines.push("", escapeHtml(note));
  }

  lines.push("", "To'lovni maktab kassasida amalga oshirishingiz mumkin.");

  return lines.join("\n");
};

/**
 * Tanlangan o'quvchilarning ota-onasiga qarz eslatmasini yuboradi.
 *
 * Qarz SERVERDA qayta hisoblanadi — mijozdan kelgan summaga ishonilmaydi:
 * ro'yxat ochilgandan keyin to'lov tushgan bo'lishi mumkin va ota-onaga
 * allaqachon yopilgan qarz haqida xabar ketishi eng yomon natija bo'lardi.
 *
 * @param {string[]} studentIds
 * @param {{note?: string, actorId: string}} options
 * @returns {Promise<{queued: number, sentTo: number, skipped: object}>}
 */
const remindDebtors = async (studentIds, { note = "", actorId } = {}) => {
  const ids = [...new Set((studentIds ?? []).filter(Boolean))];

  if (ids.length === 0) {
    throw new BadRequestError("O'quvchi tanlanmagan");
  }
  if (ids.length > MAX_RECIPIENTS) {
    throw new BadRequestError(
      `Bir marta ${MAX_RECIPIENTS} tagacha eslatma yuborish mumkin`,
    );
  }

  const trimmedNote = String(note ?? "").trim();
  if (trimmedNote.length > MAX_NOTE_LENGTH) {
    throw new BadRequestError(
      `Izoh ${MAX_NOTE_LENGTH} belgidan oshmasligi kerak`,
    );
  }

  // ── 1. Qarzni QAYTA hisoblash ──────────────
  const grouped = await prisma.monthlyInvoice.groupBy({
    by: ["studentId"],
    where: { studentId: { in: ids }, status: { in: ["unpaid", "partial"] } },
    _sum: { amount: true, paidAmount: true },
    _min: { month: true },
    _count: { _all: true },
  });

  const debts = new Map();
  for (const row of grouped) {
    const debt = new Decimal(row._sum.amount ?? 0).minus(row._sum.paidAmount ?? 0);
    if (debt.lessThanOrEqualTo(0)) continue;

    debts.set(row.studentId, {
      debt,
      unpaidCount: row._count._all,
      oldestMonth: row._min.month,
    });
  }

  // ── 2. O'quvchilar va ularning Telegram hisoblari ─
  const [students, tgUsers] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: ids }, role: ROLES.STUDENT },
      select: { id: true, firstName: true, lastName: true },
    }),
    prisma.tgUser.findMany({
      where: {
        student: { in: ids },
        isActive: true,
        notificationsEnabled: true,
      },
      select: { student: true, chatId: true },
    }),
  ]);

  const studentMap = new Map(students.map((s) => [s.id, s]));
  const chatsByStudent = new Map();
  for (const tg of tgUsers) {
    if (!chatsByStudent.has(tg.student)) chatsByStudent.set(tg.student, []);
    chatsByStudent.get(tg.student).push(tg.chatId);
  }

  // ── 3. Xabar yozuvlari va navbat ───────────
  const skipped = { noDebt: [], noTelegram: [] };
  const queueItems = [];
  let sentTo = 0;

  for (const studentId of ids) {
    const student = studentMap.get(studentId);
    if (!student) continue;

    const name = `${student.firstName} ${student.lastName ?? ""}`.trim();
    const debtInfo = debts.get(studentId);

    if (!debtInfo) {
      skipped.noDebt.push(name);
      continue;
    }

    const chats = chatsByStudent.get(studentId) ?? [];
    if (chats.length === 0) {
      skipped.noTelegram.push(name);
      continue;
    }

    const messageText = buildReminderText({
      studentName: name,
      note: trimmedNote,
      ...debtInfo,
    });

    const message = await prisma.message.create({
      data: {
        messageText,
        sentBy: actorId,
        recipientType: "student",
        recipientIds: chats,
        studentId,
        totalRecipients: chats.length,
        deliveryStatus: {
          create: chats.map((telegramId, position) => ({
            telegramId,
            userId: studentId,
            status: "pending",
            position,
          })),
        },
      },
    });

    for (const chatId of chats) {
      queueItems.push({
        messageId: message.id,
        telegramId: chatId,
        userId: studentId,
        messageText,
      });
    }

    sentTo += 1;
  }

  if (queueItems.length > 0) {
    await messageQueueService.addBulkToQueue(queueItems);
  }

  logger.info(
    `[debtors] Eslatma: ${sentTo} ta o'quvchi, ${queueItems.length} ta xabar, ` +
      `qarzsiz ${skipped.noDebt.length}, telegramsiz ${skipped.noTelegram.length}, actor=${actorId}`,
  );

  return { queued: queueItems.length, sentTo, skipped };
};

module.exports = { remindDebtors, MAX_RECIPIENTS };
