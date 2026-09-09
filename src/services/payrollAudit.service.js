/**
 * OYLIK STRUKTURASI AUDIT QAYDLARI.
 *
 * Oylikka ta'sir qiladigan har bir qaror shu yerda qoladi: lavozim maoshini
 * o'zgartirish, toifa biriktirish, ustama tasdiqlash. "Kim / qachon / eski /
 * yangi" — keyinchalik "nega bu odamning oyligi oshdi" degan savolga javob.
 *
 * `record()` ni HAR DOIM shu servicedan chaqiring — to'g'ridan-to'g'ri
 * `prisma.payrollAudit.create` yozilsa, `summary`/`action` nomlanishi
 * chalkashadi. Xohlasa tranzaksiya client'i (tx) uzatiladi.
 */

const prisma = require("../config/prisma");
const { formatDateTimeUz } = require("../helpers/date.helpers");

/**
 * Audit qaydini yozadi. Xatolik audit tufayli asosiy amalni to'xtatmasligi
 * kerak — shuning uchun chaqiruvchi odatda `await record(...).catch(...)`
 * emas, `await record(...)` qiladi va xatolik yuzaga chiqsa log'ga tushadi.
 *
 * @param {object} entry
 * @param {string} entry.actorId    — amalni bajargan xodim id
 * @param {string} entry.action     — "position.update" | "category.assign" | "request.approve" ...
 * @param {string} entry.targetType — "position" | "category" | "user" | "bonus" | "request"
 * @param {string} entry.targetId
 * @param {string} [entry.summary]  — inson o'qiydigan qisqa izoh
 * @param {*} [entry.oldValue]
 * @param {*} [entry.newValue]
 * @param {object} [client]         — tranzaksiya client'i (ixtiyoriy)
 */
const record = async (entry, client = prisma) => {
  return client.payrollAudit.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      summary: entry.summary ?? "",
      oldValue: entry.oldValue ?? undefined,
      newValue: entry.newValue ?? undefined,
    },
  });
};

const serialize = (row, actorMap = new Map()) => {
  const actor = actorMap.get(row.actorId);
  return {
    id: row.id,
    actorId: row.actorId,
    actorName: actor
      ? `${actor.firstName ?? ""} ${actor.lastName ?? ""}`.trim() || "—"
      : "—",
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    summary: row.summary,
    oldValue: row.oldValue ?? null,
    newValue: row.newValue ?? null,
    createdAt: row.createdAt,
    createdAtLabel: formatDateTimeUz(row.createdAt),
  };
};

/**
 * Audit qaydlari ro'yxati (eng yangisi birinchi), aktyor ismi bilan.
 * @param {object} query - { targetType, targetId, action, page, limit }
 */
const list = async (query = {}) => {
  const where = {};
  if (query.targetType) where.targetType = query.targetType;
  if (query.targetId) where.targetId = query.targetId;
  if (query.action) where.action = query.action;

  const page = parseInt(query.page, 10) || 1;
  const limit = Math.min(parseInt(query.limit, 10) || 30, 100);
  const skip = (page - 1) * limit;

  const [rows, total] = await Promise.all([
    prisma.payrollAudit.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.payrollAudit.count({ where }),
  ]);

  const actorIds = [...new Set(rows.map((r) => r.actorId))];
  const actors = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const actorMap = new Map(actors.map((a) => [a.id, a]));

  return {
    data: rows.map((r) => serialize(r, actorMap)),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPrevPage: page > 1,
    },
  };
};

module.exports = { record, list };
