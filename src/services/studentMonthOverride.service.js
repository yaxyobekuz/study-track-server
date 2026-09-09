/**
 * OY SUMMASI OVERRIDE'I — bitta oy uchun o'quvchi to'lovini SABAB bilan alohida
 * belgilash. Faqat o'sha oyga ta'sir qiladi (keyingi oylar odatdagi tarif).
 *
 * "Reja": invoiceBuilder o'qiydi, regeneratsiyada saqlanadi, invoice hali
 * bo'lmasa ham oldindan qo'yiladi (enrollment.firstMonthAmount uslubi). Ommaviy
 * grant ham shu jadval orqali (ko'p o'quvchiga bir oy bir summa).
 *
 * ⚠️ Summani o'zgartirish o'zi hisob-fakturani qayta hisoblamaydi — bu jadval
 * "niyat"ni yozadi. Chaqiruvchi (controller) o'sha oyni `generateForMonth`
 * bilan qayta shakllantiradi.
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const { Decimal, parseAmount, formatAmount } = require("../helpers/money.helpers");
const { parseMonthKey, formatMonthKey } = require("../helpers/month.helpers");
const { formatDateTimeUz } = require("../helpers/date.helpers");

const REASON_CODES = ["late_join", "sickness", "family", "other"];
const REASON_LABELS = {
  late_join: "Kech qo'shilgan",
  sickness: "Kasallik sababli",
  family: "Oilaviy sabab",
  other: "Boshqa",
};

const serialize = (row) => ({
  id: row.id,
  studentId: row.studentId,
  month: row.month,
  monthLabel: formatMonthKey(row.month),
  amount: formatAmount(row.amount),
  reasonCode: row.reasonCode,
  reasonLabel: REASON_LABELS[row.reasonCode] ?? row.reasonCode,
  note: row.note ?? "",
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  createdAtLabel: formatDateTimeUz(row.createdAt),
});

const assertStudent = async (studentId) => {
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { id: true, role: true },
  });
  if (!student || student.role !== ROLES.STUDENT) {
    throw new NotFoundError("O'quvchi topilmadi");
  }
  return student;
};

const parseInput = (data) => {
  const month = parseMonthKey(data.month, "Oy");
  const amount = parseAmount(data.amount, "Summa");
  const reasonCode = REASON_CODES.includes(data.reasonCode) ? data.reasonCode : null;
  if (!reasonCode) {
    throw new BadRequestError(
      "Sabab tanlanmagan (kech qo'shilgan / kasallik / oilaviy / boshqa)",
    );
  }
  const note = data.note ? String(data.note).trim() : "";
  return { month, amount, reasonCode, note };
};

/**
 * Bitta o'quvchi + oy uchun override yozadi/yangilaydi (upsert @@unique bo'yicha).
 */
const upsertForStudent = async (studentId, data, userId) => {
  await assertStudent(studentId);
  const { month, amount, reasonCode, note } = parseInput(data);

  const row = await prisma.studentMonthOverride.upsert({
    where: { studentId_month: { studentId, month } },
    create: { studentId, month, amount, reasonCode, note, createdBy: userId },
    update: { amount, reasonCode, note, createdBy: userId },
  });
  return serialize(row);
};

/**
 * OMMAVIY: ko'p o'quvchi (yoki sinf) uchun bitta oy bir summa (grant).
 * @param {object} data - { studentIds?, classId?, month, amount, reasonCode, note }
 * @returns {{ month, applied, studentIds }}
 */
const bulkUpsert = async (data, userId) => {
  const { month, amount, reasonCode, note } = parseInput(data);

  let studentIds = Array.isArray(data.studentIds) ? [...new Set(data.studentIds)] : [];
  if (data.classId) {
    const classStudents = await prisma.user.findMany({
      where: {
        role: ROLES.STUDENT,
        isArchived: false,
        classes: { some: { classId: data.classId } },
      },
      select: { id: true },
    });
    studentIds = [...new Set([...studentIds, ...classStudents.map((s) => s.id)])];
  }
  if (studentIds.length === 0) {
    throw new BadRequestError("O'quvchilar tanlanmagan");
  }

  // Har biri alohida upsert — biri xato bo'lsa qolganini to'xtatmaydi
  const applied = [];
  for (const studentId of studentIds) {
    await prisma.studentMonthOverride.upsert({
      where: { studentId_month: { studentId, month } },
      create: { studentId, month, amount, reasonCode, note, createdBy: userId },
      update: { amount, reasonCode, note, createdBy: userId },
    });
    applied.push(studentId);
  }

  return { month, monthLabel: formatMonthKey(month), applied: applied.length, studentIds: applied };
};

/** O'quvchining barcha override'lari (eng yangisi birinchi). */
const getForStudent = async (studentId) => {
  const rows = await prisma.studentMonthOverride.findMany({
    where: { studentId },
    orderBy: { month: "desc" },
  });
  return rows.map(serialize);
};

/** Override'ni o'chirish (o'sha oy keyin odatdagi tarifga qaytadi). */
const remove = async (id) => {
  const row = await prisma.studentMonthOverride.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Override topilmadi");
  await prisma.studentMonthOverride.delete({ where: { id } });
  return { message: "O'chirildi", studentId: row.studentId, month: row.month };
};

/**
 * Berilgan oy uchun override'lar Map<studentId, { amount, reasonCode, note }>.
 * invoiceGeneration / regenerate shu bilan builder'ga uzatadi.
 */
const resolveForMonth = async (month, studentIds) => {
  const rows = await prisma.studentMonthOverride.findMany({
    where: {
      month,
      ...(studentIds?.length ? { studentId: { in: studentIds } } : {}),
    },
  });
  const map = new Map();
  for (const r of rows) {
    map.set(r.studentId, { amount: r.amount, reasonCode: r.reasonCode, note: r.note });
  }
  return map;
};

/** Bitta o'quvchi+oy override'i (regenerate yagona invoice uchun). */
const resolveOne = async (studentId, month) => {
  const row = await prisma.studentMonthOverride.findUnique({
    where: { studentId_month: { studentId, month } },
  });
  return row ? { amount: row.amount, reasonCode: row.reasonCode, note: row.note } : null;
};

// ── HISOB-FAKTURANI QAYTA MUHRLASH ────────────────
// Override yozish o'zi hisob-fakturani o'zgartirmaydi (u faqat "niyat"). Shu
// o'quvchining o'sha oy hisob-fakturasini qayta shakllantiramiz, aks holda
// summa faqat kelasi generatsiyada ko'rinardi.
//
// ⚠️ Lazy require: `invoice.service` / `invoiceGeneration.service` bizni yuqorida
// require qiladi (resolveForMonth/resolveOne). Teskari bog'lanishni funksiya
// ichida yuklab, modul sikli (partial exports) oldini olamiz.
const resealStudentMonth = async (studentId, month, reason, userId) => {
  const { regenerateInvoice } = require("./invoice.service");
  const { generateForMonth } = require("./invoiceGeneration.service");

  const invoice = await prisma.monthlyInvoice.findUnique({
    where: { studentId_month: { studentId, month } },
    select: { id: true, status: true, paidAmount: true },
  });

  // Hali hisob-faktura yo'q (yoki bekor qilingan) — targetli generatsiya uni
  // yaratadi/tiklaydi va override'ni qo'llaydi.
  if (!invoice || invoice.status === "cancelled") {
    await generateForMonth(month, {
      studentIds: [studentId],
      source: "manual",
      actorId: userId,
    });
    return { studentId, status: invoice ? "restored" : "created" };
  }

  // To'lov tushgan hisob-fakturani qayta muhrlab bo'lmaydi (§5) — bu XATO emas,
  // admin avval to'lovni bekor qilishi kerak. Jim qolmaymiz, ogohlantiramiz.
  if (new Decimal(invoice.paidAmount).greaterThan(0)) {
    return {
      studentId,
      status: "skipped",
      reason: "To'lov tushgan — avval to'lovni bekor qiling",
    };
  }

  await regenerateInvoice(invoice.id, reason, userId);
  return { studentId, status: "regenerated" };
};

const resealReason = (reasonCode) =>
  `Oy summasi o'zgartirildi: ${REASON_LABELS[reasonCode] ?? reasonCode}`;

/**
 * Bitta o'quvchi uchun override yozadi VA o'sha oy hisob-fakturasini qayta
 * muhrlaydi (controller shuni chaqiradi).
 */
const apply = async (studentId, data, userId) => {
  const override = await upsertForStudent(studentId, data, userId);
  const reseal = await resealStudentMonth(
    studentId,
    override.month,
    resealReason(override.reasonCode),
    userId,
  );
  return { override, reseal };
};

/**
 * OMMAVIY: ko'p o'quvchiga bir oy bir summa + har birining hisob-fakturasini
 * qayta muhrlash.
 */
const applyBulk = async (data, userId) => {
  const result = await bulkUpsert(data, userId);
  const reason = resealReason(
    REASON_CODES.includes(data.reasonCode) ? data.reasonCode : "other",
  );

  const reseal = [];
  for (const studentId of result.studentIds) {
    reseal.push(await resealStudentMonth(studentId, result.month, reason, userId));
  }

  return {
    month: result.month,
    monthLabel: result.monthLabel,
    applied: result.applied,
    reseal,
    skipped: reseal.filter((r) => r.status === "skipped"),
  };
};

/** Override'ni o'chiradi VA o'sha oy hisob-fakturasini odatiy tarifga qaytaradi. */
const unset = async (id, userId) => {
  const removed = await remove(id);
  const reseal = await resealStudentMonth(
    removed.studentId,
    removed.month,
    "Oy summasi override'i olib tashlandi",
    userId,
  );
  return { removed, reseal };
};

module.exports = {
  REASON_CODES,
  REASON_LABELS,
  upsertForStudent,
  bulkUpsert,
  getForStudent,
  remove,
  resolveForMonth,
  resolveOne,
  apply,
  applyBulk,
  unset,
};
