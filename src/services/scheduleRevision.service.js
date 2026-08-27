/**
 * DARS JADVALI — TAHRIRLAR TARIXI (Google Sheets revision uslubida).
 *
 * Har saqlashda butun sinf haftasining snapshot'i + kim/qachon/IP/xulosa
 * yoziladi. Foydalanuvchi versiyani ko'ra oladi va o'sha holatga qaytara oladi.
 *
 * Bu qatlam faqat YOZADI/O'QIYDI — snapshot'ni schedule.service tuzadi va
 * uzatadi (aylanma bog'liqlik bo'lmasligi uchun).
 */

const prisma = require("../config/prisma");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { NotFoundError } = require("../utils/errors");

const DAY_LABELS = {
  dushanba: "Dushanba",
  seshanba: "Seshanba",
  chorshanba: "Chorshanba",
  payshanba: "Payshanba",
  juma: "Juma",
  shanba: "Shanba",
};

/** Bitta kun darslarini taqqoslash uchun barqaror kalitga aylantiradi. */
const dayFingerprint = (subjects = []) =>
  [...subjects]
    .map(
      (s) =>
        `${s.subject?.id || s.subjectId || ""}:${s.teacher?.id || s.teacherId || ""}:${s.order}:${s.startTime || ""}-${s.endTime || ""}`,
    )
    .sort()
    .join("|");

/** Ikki snapshot orasidagi farqni qisqacha matnga aylantiradi. */
const summarizeDiff = (prev = [], next = []) => {
  const prevMap = new Map(prev.map((d) => [d.day, d.subjects || []]));
  const nextMap = new Map(next.map((d) => [d.day, d.subjects || []]));
  const days = new Set([...prevMap.keys(), ...nextMap.keys()]);

  const parts = [];
  for (const day of ["dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"]) {
    if (!days.has(day)) continue;
    const p = prevMap.get(day);
    const n = nextMap.get(day);
    const label = DAY_LABELS[day] || day;

    if (!p && n) {
      parts.push(`${label} qo'shildi (${n.length} dars)`);
    } else if (p && !n) {
      parts.push(`${label} o'chirildi`);
    } else if (p && n) {
      if (p.length !== n.length) {
        parts.push(`${label}: ${p.length} → ${n.length} dars`);
      } else if (dayFingerprint(p) !== dayFingerprint(n)) {
        parts.push(`${label} o'zgartirildi`);
      }
    }
  }

  return parts.length ? parts.join("; ") : "O'zgarish yo'q";
};

/**
 * Revision yozadi.
 * @param {object} data - { classId, editedBy, editedByName, editedByRole, ip,
 *                          action, prevSnapshot, newSnapshot }
 */
const record = async (data) => {
  const summary = summarizeDiff(data.prevSnapshot, data.newSnapshot);

  return prisma.scheduleRevision.create({
    data: {
      classId: data.classId,
      editedBy: data.editedBy ?? null,
      editedByName: data.editedByName || "",
      editedByRole: data.editedByRole || "",
      ip: data.ip || "",
      action: data.action || "edit",
      summary: data.summary || summary,
      snapshot: data.newSnapshot,
    },
  });
};

const serialize = (row) => ({
  id: row.id,
  classId: row.classId,
  editedBy: row.editedBy,
  editedByName: row.editedByName,
  editedByRole: row.editedByRole,
  ip: row.ip,
  action: row.action,
  summary: row.summary,
  createdAt: row.createdAt,
  daysCount: Array.isArray(row.snapshot) ? row.snapshot.length : 0,
});

/** Sinfning tahrirlar tarixi (sahifalangan, eng yangisi birinchi). */
const list = async (classId, req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const [rows, total] = await Promise.all([
    prisma.scheduleRevision.findMany({
      where: { classId },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.scheduleRevision.count({ where: { classId } }),
  ]);
  return formatPaginationResponse(rows.map(serialize), total, page, limit);
};

/** Bitta revision — to'liq snapshot bilan (ko'rish/qaytarish uchun). */
const getById = async (id) => {
  const row = await prisma.scheduleRevision.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Versiya topilmadi");
  return { ...serialize(row), snapshot: row.snapshot };
};

module.exports = {
  summarizeDiff,
  record,
  list,
  getById,
};
