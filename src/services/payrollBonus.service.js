/**
 * ADMIN USTAMA (PayrollBonus) — admin xodimga to'g'ridan-to'g'ri ustama
 * beradi (zayavkasiz). Zayavkadan kelgan ustama ham SHU jadvalda
 * (`sourceRequestId` bilan) — bu servis faqat ADMIN qo'shganini boshqaradi.
 *
 * Ustama MUSTAQIL va QO'SHILUVCHI: bir xodimda bir nechta bo'lishi mumkin
 * (fiksa/KPI qoidasidan farqli — u yerda kesishuv taqiqlanadi). Shuning
 * uchun bu yerda kesishuv tekshiruvi YO'Q.
 *
 * Foizli ustama summasi payrollEngine da boshlang'ich oylikdan (lavozim +
 * fiksa + KPI) hisoblanadi — bu yerda faqat qoida (type + value) saqlanadi.
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const { parseAmount, formatAmount } = require("../helpers/money.helpers");
const {
  currentMonthKey,
  parseMonthKey,
  parseOptionalMonthKey,
  formatMonthKey,
} = require("../helpers/month.helpers");
const payrollAudit = require("./payrollAudit.service");
const logger = require("../utils/logger");

const BONUS_TYPES = ["fixed", "percent"];

const assertStaff = async (staffId) => {
  const staff = await prisma.user.findUnique({
    where: { id: staffId },
    select: { id: true, role: true, firstName: true, lastName: true },
  });
  if (!staff) throw new NotFoundError("Xodim topilmadi");
  if (staff.role === ROLES.STUDENT) {
    throw new BadRequestError("O'quvchiga ustama biriktirilmaydi");
  }
  return staff;
};

const fullName = (u) => `${u.firstName} ${u.lastName ?? ""}`.trim();

/**
 * Admin ustama qo'shadi.
 * @param {object} data - { staffId, label, type, value, startMonth?, endMonth? }
 * @param {string} userId
 */
const createBonus = async (data, userId) => {
  const staff = await assertStaff(data.staffId);

  const type = String(data.type ?? "fixed").trim();
  if (!BONUS_TYPES.includes(type)) {
    throw new BadRequestError("Ustama turi 'fixed' yoki 'percent' bo'lishi kerak");
  }

  const value = parseAmount(data.value, "Ustama qiymati");
  if (!value.greaterThan(0)) {
    throw new BadRequestError("Ustama qiymati 0 dan katta bo'lishi kerak");
  }
  if (type === "percent" && value.greaterThan(100)) {
    throw new BadRequestError("Foiz 100 dan oshmasligi kerak");
  }

  const startMonth = data.startMonth
    ? parseMonthKey(data.startMonth, "Boshlanish oyi")
    : currentMonthKey();
  const endMonth = parseOptionalMonthKey(data.endMonth, "Tugash oyi");
  if (endMonth != null && endMonth < startMonth) {
    throw new BadRequestError("Tugash oyi boshlanish oyidan oldin bo'lishi mumkin emas");
  }

  const bonus = await prisma.payrollBonus.create({
    data: {
      staffId: staff.id,
      label: data.label?.trim() || "Ustama",
      type,
      value,
      startMonth,
      endMonth,
      sourceRequestId: null, // admin qo'shdi (zayavkasiz)
      isActive: true,
      createdBy: userId,
    },
  });

  await payrollAudit.record({
    actorId: userId,
    action: "bonus.create",
    targetType: "bonus",
    targetId: bonus.id,
    summary:
      `${fullName(staff)} — "${bonus.label}" ustamasi qo'shildi ` +
      `(${formatAmount(value)}${type === "percent" ? "%" : ""})`,
    newValue: { label: bonus.label, type, value: formatAmount(value), startMonth, endMonth },
  });

  logger.info(
    `[bonus] Admin ustama qo'shdi: staff=${staff.id} "${bonus.label}" ` +
      `${formatAmount(value)}${type === "percent" ? "%" : ""} actor=${userId}`,
  );

  return serialize(bonus, { staff });
};

/** Ustamani o'chiradi (faqat admin qo'shgani — zayavkadan kelgani emas). */
const deleteBonus = async (id, userId) => {
  const bonus = await prisma.payrollBonus.findUnique({ where: { id } });
  if (!bonus) throw new NotFoundError("Ustama topilmadi");
  if (bonus.sourceRequestId) {
    throw new BadRequestError(
      "Bu ustama zayavka orqali berilgan — uni bu yerdan o'chirib bo'lmaydi",
    );
  }

  await prisma.payrollBonus.delete({ where: { id } });

  await payrollAudit.record({
    actorId: userId,
    action: "bonus.delete",
    targetType: "bonus",
    targetId: id,
    summary: `"${bonus.label}" ustamasi o'chirildi`,
    oldValue: { label: bonus.label, value: formatAmount(bonus.value) },
  });

  return { message: "Ustama o'chirildi" };
};

const serialize = (row, { staff } = {}) => ({
  id: row.id,
  staffId: row.staffId,
  staffName: staff ? fullName(staff) : null,
  label: row.label,
  type: row.type,
  value: formatAmount(row.value),
  startMonth: row.startMonth,
  startMonthLabel: formatMonthKey(row.startMonth),
  endMonth: row.endMonth,
  endMonthLabel: row.endMonth ? formatMonthKey(row.endMonth) : null,
  isActive: row.isActive,
  createdAt: row.createdAt,
});

module.exports = {
  BONUS_TYPES,
  createBonus,
  deleteBonus,
};
