/**
 * SERTIFIKAT STATISTIKASI.
 *
 * Asosiy savol — "sertifikat topshirmoqchi bo'lgan o'quvchilar soni".
 *
 * ⚠️ "O'QUVCHI SONI" va "REJALAR SONI" — IKKI XIL raqam va ikkalasi ham
 * ko'rsatiladi. Bitta o'quvchi ikki sertifikat rejalashtirsa, rejalar soni
 * 2 ga, o'quvchilar soni 1 ga oshadi. Faqat biri ko'rsatilsa, "277 ta
 * o'quvchi sertifikat topshiradi" degan yolg'on raqam chiqardi (haqiqatda
 * 152 o'quvchi, 277 reja).
 *
 * ⚠️ FAQAT JORIY O'QUVCHILAR sanaladi (`education.md` §4): arxivlangani
 * hisobotlarning hech birida ko'rinmaydi. Rejasi esa o'chirilmaydi.
 *
 * ⚠️ FAQAT FAOL (`planned`) REJALAR. Bekor qilingani va almashtirilgani
 * tarix; topshirgani (`passed`) esa alohida sanoqchi — u "rejalashtirgan"
 * emas, "bajargan".
 */

const prisma = require("../config/prisma");
const { BadRequestError } = require("../utils/errors");
const { isValidId } = require("../utils/objectId");
const { getTashkentDateUtc } = require("../helpers/date.helpers");
const { formatMonthKey } = require("../helpers/month.helpers");
const { loadArchivedStudentScope } = require("./archivedStudentScope.service");
const { PLAN_STATUS, ACTIVE_STATUS, monthKeyOf } = require("../helpers/certificate.helpers");

/** Sinfga biriktirilmagan o'quvchilar kesimi. */
const NO_CLASS = Object.freeze({ id: "none", name: "Sinfsiz" });

const classCollator = new Intl.Collator("uz", { numeric: true, sensitivity: "base" });
const nameCollator = new Intl.Collator("uz", { sensitivity: "base" });

/** "2026-12" → 202612 (oy yorlig'i uchun). */
const toMonthNumber = (key) => Number(String(key).replace("-", ""));

/**
 * Kesim qatorlarini yig'adi: o'quvchilar (DISTINCT) va rejalar.
 *
 * @returns {{students: number, plans: number}}
 */
function countBucket(bucket) {
  return { students: bucket.students.size, plans: bucket.plans };
}

function bucketOf(map, key, meta) {
  if (!map.has(key)) map.set(key, { ...meta, students: new Set(), plans: 0 });
  return map.get(key);
}

/**
 * STATISTIKA.
 *
 * @param {{classId?: string}} [query] - sinf kesimi (karta raqamlari ham
 *   shunga bog'lanadi: filtr tanlanganda butun ekran bitta sinf haqida
 *   bo'lishi kerak)
 */
async function getCertificateStats(query = {}) {
  const today = getTashkentDateUtc();
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));

  const classFilter = String(query.classId ?? "").trim();
  const hasClassFilter = Boolean(classFilter) && classFilter !== "all";
  if (hasClassFilter && classFilter !== NO_CLASS.id && !isValidId(classFilter)) {
    throw new BadRequestError("Sinf tanlovi noto'g'ri");
  }

  const scope = await loadArchivedStudentScope();

  const plans = await prisma.certificatePlan.findMany({
    where: { ...scope, status: { in: [ACTIVE_STATUS, PLAN_STATUS.PASSED] } },
    select: {
      studentId: true,
      trackId: true,
      dueDate: true,
      status: true,
      track: { select: { id: true, name: true, subjectId: true } },
    },
  });

  // O'quvchi → sinflar. ⚠️ `UserClass` sanasiz M2M, o'quvchi bir nechta
  // sinfda bo'lishi mumkin — bunda u HAR IKKI sinf kesimida sanaladi,
  // "Jami" da esa bir marta (sinflar ro'yxatidagi AYNI qoida).
  const studentIds = [...new Set(plans.map((plan) => plan.studentId))];
  const links = studentIds.length
    ? await prisma.userClass.findMany({
        where: { userId: { in: studentIds } },
        select: { userId: true, class: { select: { id: true, name: true } } },
      })
    : [];

  const classesByStudent = new Map(studentIds.map((id) => [id, []]));
  for (const link of links) {
    if (link.class) classesByStudent.get(link.userId)?.push(link.class);
  }

  // Sinf filtri — statistikaning O'ZIDA qo'llanadi (ikkinchi so'rov emas)
  const inScope = (studentId) => {
    if (!hasClassFilter) return true;
    const list = classesByStudent.get(studentId) ?? [];
    if (classFilter === NO_CLASS.id) return list.length === 0;
    return list.some((cls) => cls.id === classFilter);
  };

  const totals = {
    students: new Set(),
    plans: 0,
    overdue: 0,
    dueThisMonth: 0,
    dueLater: 0,
    noDue: 0,
    passed: 0,
    passedStudents: new Set(),
  };

  const byTrack = new Map();
  const byClass = new Map();
  const byMonth = new Map();

  for (const plan of plans) {
    if (!inScope(plan.studentId)) continue;

    if (plan.status === PLAN_STATUS.PASSED) {
      totals.passed += 1;
      totals.passedStudents.add(plan.studentId);
      continue;
    }

    totals.students.add(plan.studentId);
    totals.plans += 1;

    if (!plan.dueDate) totals.noDue += 1;
    else if (plan.dueDate < today) totals.overdue += 1;
    else if (plan.dueDate < nextMonthStart) totals.dueThisMonth += 1;
    else totals.dueLater += 1;

    const track = bucketOf(byTrack, plan.trackId, {
      id: plan.trackId,
      name: plan.track?.name ?? "—",
      subjectId: plan.track?.subjectId ?? null,
    });
    track.students.add(plan.studentId);
    track.plans += 1;

    const classes = classesByStudent.get(plan.studentId) ?? [];
    const targets = classes.length ? classes : [NO_CLASS];
    for (const cls of targets) {
      const bucket = bucketOf(byClass, cls.id, { id: cls.id, name: cls.name });
      bucket.students.add(plan.studentId);
      bucket.plans += 1;
    }

    const monthKey = monthKeyOf(plan.dueDate);
    if (monthKey) {
      const bucket = bucketOf(byMonth, monthKey, {
        month: monthKey,
        label: formatMonthKey(toMonthNumber(monthKey)),
      });
      bucket.students.add(plan.studentId);
      bucket.plans += 1;
    }
  }

  return {
    totals: {
      // ⚠️ ASOSIY RAQAM — "nechta o'quvchi sertifikat topshirmoqchi"
      students: totals.students.size,
      plans: totals.plans,
      overdue: totals.overdue,
      dueThisMonth: totals.dueThisMonth,
      dueLater: totals.dueLater,
      noDue: totals.noDue,
      passed: totals.passed,
      passedStudents: totals.passedStudents.size,
    },
    byTrack: [...byTrack.values()]
      .map((bucket) => ({ ...bucket, ...countBucket(bucket) }))
      .sort((a, b) => b.students - a.students || nameCollator.compare(a.name, b.name)),
    byClass: [...byClass.values()]
      .map((bucket) => ({ ...bucket, ...countBucket(bucket) }))
      .sort((a, b) => classCollator.compare(a.name, b.name)),
    // Oylar XRONOLOGIK tartibda: diagramma va ro'yxat vaqt bo'yicha o'qiladi
    byMonth: [...byMonth.values()]
      .map((bucket) => ({ ...bucket, ...countBucket(bucket) }))
      .sort((a, b) => a.month.localeCompare(b.month)),
  };
}

module.exports = { NO_CLASS, getCertificateStats };
