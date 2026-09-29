/**
 * QURILMA SIYOSATI — qoidalar to'plami va uni KIMGA qo'llash.
 *
 * ⚠️ QAROR MANTIG'I BU YERDA EMAS — `helpers/devicePolicy.helpers.js` da.
 * Bu servis faqat saqlaydi, o'qiydi va nishonlarni hisoblaydi. Sabab:
 * aynan o'sha mantiqni qurilma API si ham, panel ham, o'quvchining o'z
 * ekrani ham chaqiradi; u servis ichida yashirilsa, ikkinchi nusxa paydo
 * bo'lishi vaqt masalasi edi (`invoiceBuilder` / `computeSalary` doktrinasi).
 *
 * ⚠️ SIYOSAT BIRIKTIRILGUNICHA HECH KIMGA TA'SIR QILMAYDI. Shuning uchun
 * yozish (`devices.policies`) va yoqish (`devices.assign`) — ALOHIDA
 * ruxsatlar, va "barcha o'quvchilar" uchun server alohida tasdiq talab
 * qiladi (`confirmAll`).
 *
 * ⚠️ HAR NISHONGA BITTA BIRIKTIRISH (`targetKey` yagona). Nishonni qayta
 * biriktirish eskisini ALMASHTIRADI — ikkinchi qator yozilmaydi va
 * "qaysi biri amalda" degan savol tug'ilmaydi.
 */

const prisma = require("../config/prisma");
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
} = require("../utils/errors");
const { isValidId } = require("../utils/objectId");
const logger = require("../utils/logger");
const { ROLES } = require("../utils/constants");
const {
  APP_MODES,
  MINUTES_PER_DAY,
  SCOPE_LABEL,
  resolveAssignment,
  parseClock,
  formatClock,
} = require("../helpers/devicePolicy.helpers");
const deviceAudit = require("./deviceAudit.service");
const pushService = require("./push.service");
const devicePush = require("../helpers/devicePush.helpers");

const NAME_MAX = 120;
const NOTE_MAX = 500;
const MAX_APPS_PER_POLICY = 300;
const MAX_WINDOWS_PER_POLICY = 60;

/** Siyosat + bog'liqlari — profil qurish uchun kerakli minimal shakl. */
const POLICY_INCLUDE = {
  apps: {
    include: {
      app: {
        select: {
          id: true,
          name: true,
          category: true,
          androidPackage: true,
          iosBundleId: true,
          isEssential: true,
          isArchived: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  },
  windows: { orderBy: [{ weekday: "asc" }, { startMinute: "asc" }] },
};

/* ─────────────────────── VALIDATSIYA ─────────────────────── */

const normalizeName = (value) => {
  const text = String(value ?? "").trim();
  if (!text) throw new BadRequestError("Siyosat nomi majburiy");
  return text.slice(0, NAME_MAX);
};

const normalizeNote = (value) => String(value ?? "").trim().slice(0, NOTE_MAX);

/**
 * Kunlik limitni tekshiradi. `null` → chegara yo'q.
 * ⚠️ 0 ham HAQIQIY qiymat ("bugun umuman yo'q"), shuning uchun `|| null`
 * bilan yutib yuborilmaydi.
 */
function normalizeDailyLimit(value) {
  if (value === null || value === undefined || value === "") return null;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MINUTES_PER_DAY) {
    throw new BadRequestError("Kunlik limit 0 dan 1440 daqiqagacha bo'lishi kerak");
  }
  return minutes;
}

/**
 * Ilova qoidalarini tekshiradi va normallashtiradi.
 *
 * ⚠️ `limited` uchun `dailyMinutes` MAJBURIY: usiz qator "chegaralangan"
 * deb turadi-yu, chegarasi bo'lmaydi — eng yomon turdagi jim nosozlik.
 */
function normalizeApps(rows = []) {
  if (!Array.isArray(rows)) throw new BadRequestError("Ilovalar ro'yxati noto'g'ri");
  if (rows.length > MAX_APPS_PER_POLICY) {
    throw new BadRequestError(`Bitta siyosatda ko'pi bilan ${MAX_APPS_PER_POLICY} ta ilova`);
  }

  const seen = new Set();
  return rows.map((row) => {
    const appId = row?.appId;
    if (!isValidId(appId)) throw new BadRequestError("Ilova id si noto'g'ri");
    if (seen.has(appId)) throw new BadRequestError("Bitta ilova ikki marta kiritilgan");
    seen.add(appId);

    const mode = String(row?.mode || "").trim();
    if (!APP_MODES.includes(mode)) {
      throw new BadRequestError(`Ilova rejimi noto'g'ri: ${APP_MODES.join(" | ")}`);
    }

    let dailyMinutes = null;
    if (mode === "limited") {
      const minutes = Number(row?.dailyMinutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > MINUTES_PER_DAY) {
        throw new BadRequestError(
          "Chegaralangan ilova uchun kunlik daqiqa 1 dan 1440 gacha bo'lishi kerak",
        );
      }
      dailyMinutes = minutes;
    }

    return { appId, mode, dailyMinutes };
  });
}

/**
 * Vaqt oynalarini tekshiradi.
 *
 * ⚠️ YARIM TUNDAN OSHADIGAN OYNA RAD ETILADI — u ikki qatorga bo'linadi
 * (22:00–24:00 + 00:00–07:00). `start > end` ga ruxsat berilsa, har bir
 * tekshiruvda ikki xil shoxlanish paydo bo'lardi va biri albatta
 * unutilardi (`devices.md` §3).
 *
 * ⚠️ BIR KUNDA KESISHGAN OYNALAR ham rad etiladi: ular hech narsani
 * buzmaydi, lekin panelda "08:00–12:00 va 10:00–14:00" bo'lib turishi
 * adminni chalg'itadi va keyin "nega 13:00 da ochiq" degan savol tug'iladi.
 */
function normalizeWindows(rows = []) {
  if (!Array.isArray(rows)) throw new BadRequestError("Vaqt oynalari noto'g'ri");
  if (rows.length > MAX_WINDOWS_PER_POLICY) {
    throw new BadRequestError(`Ko'pi bilan ${MAX_WINDOWS_PER_POLICY} ta vaqt oynasi`);
  }

  const normalized = rows.map((row) => {
    const weekday = Number(row?.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new BadRequestError("Hafta kuni 0 (yakshanba) dan 6 (shanba) gacha bo'lishi kerak");
    }

    const startMinute = parseClock(row?.startMinute ?? row?.start);
    const endMinute = parseClock(row?.endMinute ?? row?.end);
    if (startMinute === null || endMinute === null) {
      throw new BadRequestError("Vaqt noto'g'ri — «HH:mm» ko'rinishida bo'lishi kerak");
    }
    if (endMinute <= startMinute) {
      throw new BadRequestError(
        "Tugash vaqti boshlanishdan keyin bo'lishi kerak. Yarim tundan oshadigan oynani ikkiga bo'ling: 22:00–24:00 va 00:00–07:00",
      );
    }

    return {
      weekday,
      startMinute,
      endMinute,
      label: String(row?.label || "").trim().slice(0, 60),
    };
  });

  const byDay = new Map();
  for (const w of normalized) {
    const list = byDay.get(w.weekday) || [];
    list.push(w);
    byDay.set(w.weekday, list);
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => a.startMinute - b.startMinute);
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].startMinute < list[i - 1].endMinute) {
        throw new BadRequestError(
          `Vaqt oynalari kesishmoqda: ${formatClock(list[i - 1].startMinute)}–${formatClock(list[i - 1].endMinute)} va ${formatClock(list[i].startMinute)}–${formatClock(list[i].endMinute)}`,
        );
      }
    }
  }

  return normalized;
}

/* ─────────────────────── SIYOSAT ─────────────────────── */

/**
 * Siyosat tafsilotiga hisoblangan maydonlarni qo'shadi.
 *
 * ⚠️ `missingIdentifiers` — JIM BO'SHLIQNI OCHADIGAN MAYDON. Admin
 * "YouTube ruxsat" deb yozgan-u, iOS bundle id kiritilmagan bo'lsa,
 * iPhone da u baribir bloklangan bo'lib qolardi va buni hech kim
 * sezmasdi. Shuning uchun panel buni OGOHLANTIRISH qilib ko'rsatadi.
 */
function decoratePolicy(policy) {
  if (!policy) return null;

  const missingIdentifiers = (policy.apps || [])
    .filter((row) => !row.app?.androidPackage || !row.app?.iosBundleId)
    .map((row) => ({
      appId: row.app.id,
      name: row.app.name,
      missing: !row.app.androidPackage ? "android" : "ios",
    }));

  const archivedApps = (policy.apps || [])
    .filter((row) => row.app?.isArchived)
    .map((row) => ({ appId: row.app.id, name: row.app.name }));

  const counts = { always: 0, allowed: 0, limited: 0, blocked: 0 };
  for (const row of policy.apps || []) counts[row.mode] = (counts[row.mode] || 0) + 1;

  return { ...policy, missingIdentifiers, archivedApps, appCounts: counts };
}

async function listPolicies(query = {}) {
  const archived = query.archived === "true";

  const policies = await prisma.devicePolicy.findMany({
    where: { isArchived: archived },
    include: {
      ...POLICY_INCLUDE,
      assignments: {
        where: { isActive: true },
        select: { id: true, scope: true, classId: true, studentId: true },
      },
      _count: { select: { assignments: true } },
    },
    orderBy: [{ name: "asc" }],
  });

  return policies.map(decoratePolicy);
}

async function getPolicy(id) {
  if (!isValidId(id)) throw new BadRequestError("Siyosat id si noto'g'ri");

  const policy = await prisma.devicePolicy.findUnique({
    where: { id },
    include: POLICY_INCLUDE,
  });
  if (!policy) throw new NotFoundError("Siyosat topilmadi");

  const assignments = await listAssignments({ policyId: id });
  return { ...decoratePolicy(policy), assignments };
}

async function createPolicy(payload = {}, actorId) {
  const name = normalizeName(payload.name);
  const apps = normalizeApps(payload.apps);
  const windows = normalizeWindows(payload.windows);

  const clash = await prisma.devicePolicy.findUnique({ where: { name } });
  if (clash) throw new ConflictError(`«${name}» nomli siyosat allaqachon bor`);

  const policy = await prisma.$transaction(async (tx) => {
    const created = await tx.devicePolicy.create({
      data: {
        name,
        description: normalizeNote(payload.description),
        color: payload.color || null,
        defaultMode: payload.defaultMode === "allow" ? "allow" : "block",
        dailyLimitMinutes: normalizeDailyLimit(payload.dailyLimitMinutes),
        offlinePolicy: payload.offlinePolicy === "lockDown" ? "lockDown" : "keepLast",
        createdBy: actorId,
        apps: { create: apps },
        windows: { create: windows },
      },
      include: POLICY_INCLUDE,
    });

    await deviceAudit.recordInTx(tx, {
      action: deviceAudit.ACTIONS.POLICY_CREATE,
      actorId,
      policyId: created.id,
      summary: `«${created.name}» siyosati yaratildi`,
      meta: { apps: apps.length, windows: windows.length },
    });

    return created;
  });

  return decoratePolicy(policy);
}

/**
 * Siyosatni tahrirlaydi.
 *
 * ⚠️ ILOVALAR VA OYNALAR O'RNIGA QO'YILADI, yamalmaydi
 * (`prepareSubstitution` bilan bir xil qaror): qisman yangilash
 * "qatorni o'chirish" amalini alohida endpointga aylantirardi va
 * muharrir bilan server holati asta-sekin farq qila boshlardi.
 *
 * ⚠️ `version` HAR TAHRIRDA OSHADI — qurilma shuni taqqoslab yangilanadi.
 */
async function updatePolicy(id, payload = {}, actorId) {
  if (!isValidId(id)) throw new BadRequestError("Siyosat id si noto'g'ri");

  const existing = await prisma.devicePolicy.findUnique({
    where: { id },
    include: POLICY_INCLUDE,
  });
  if (!existing) throw new NotFoundError("Siyosat topilmadi");
  if (existing.isArchived) throw new BadRequestError("Arxivlangan siyosat tahrirlanmaydi");

  const data = {};
  if (payload.name !== undefined) {
    data.name = normalizeName(payload.name);
    if (data.name !== existing.name) {
      const clash = await prisma.devicePolicy.findUnique({ where: { name: data.name } });
      if (clash) throw new ConflictError(`«${data.name}» nomli siyosat allaqachon bor`);
    }
  }
  if (payload.description !== undefined) data.description = normalizeNote(payload.description);
  if (payload.color !== undefined) data.color = payload.color || null;
  if (payload.defaultMode !== undefined) {
    data.defaultMode = payload.defaultMode === "allow" ? "allow" : "block";
  }
  if (payload.dailyLimitMinutes !== undefined) {
    data.dailyLimitMinutes = normalizeDailyLimit(payload.dailyLimitMinutes);
  }
  if (payload.offlinePolicy !== undefined) {
    data.offlinePolicy = payload.offlinePolicy === "lockDown" ? "lockDown" : "keepLast";
  }

  const apps = payload.apps !== undefined ? normalizeApps(payload.apps) : null;
  const windows = payload.windows !== undefined ? normalizeWindows(payload.windows) : null;

  const policy = await prisma.$transaction(async (tx) => {
    if (apps) {
      await tx.devicePolicyApp.deleteMany({ where: { policyId: id } });
      if (apps.length) {
        await tx.devicePolicyApp.createMany({
          data: apps.map((row) => ({ ...row, policyId: id })),
        });
      }
    }
    if (windows) {
      await tx.devicePolicyWindow.deleteMany({ where: { policyId: id } });
      if (windows.length) {
        await tx.devicePolicyWindow.createMany({
          data: windows.map((row) => ({ ...row, policyId: id })),
        });
      }
    }

    const updated = await tx.devicePolicy.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
      include: POLICY_INCLUDE,
    });

    await deviceAudit.recordInTx(tx, {
      action: deviceAudit.ACTIONS.POLICY_UPDATE,
      actorId,
      policyId: id,
      summary: `«${updated.name}» siyosati tahrirlandi (v${updated.version})`,
      meta: {
        changed: Object.keys(data),
        apps: apps ? apps.length : undefined,
        windows: windows ? windows.length : undefined,
      },
    });

    return updated;
  });

  notifyPolicyChange(id).catch((error) =>
    logger.warn(`[devices] siyosat o'zgarishi yuborilmadi: ${error.message}`),
  );

  return decoratePolicy(policy);
}

/**
 * Arxivlash.
 *
 * ⚠️ BIRIKTIRILGAN SIYOSAT ARXIVLANMAYDI: o'quvchilar jimgina chekovsiz
 * qolib ketardi va buni hech kim sezmasdi. Avval biriktirish olib
 * tashlanadi — bu ongli ikkinchi qadam.
 */
async function archivePolicy(id, actorId) {
  if (!isValidId(id)) throw new BadRequestError("Siyosat id si noto'g'ri");

  const policy = await prisma.devicePolicy.findUnique({
    where: { id },
    include: { assignments: { where: { isActive: true }, select: { id: true } } },
  });
  if (!policy) throw new NotFoundError("Siyosat topilmadi");

  if (policy.assignments.length > 0) {
    throw new ConflictError(
      `Bu siyosat ${policy.assignments.length} ta nishonga biriktirilgan. Avval biriktirishni olib tashlang.`,
      { assignments: policy.assignments.length },
    );
  }

  const updated = await prisma.devicePolicy.update({
    where: { id },
    data: { isArchived: true, archivedAt: new Date() },
  });

  await deviceAudit.record({
    action: deviceAudit.ACTIONS.POLICY_ARCHIVE,
    actorId,
    policyId: id,
    summary: `«${policy.name}» siyosati arxivlandi`,
  });

  return updated;
}

async function restorePolicy(id, actorId) {
  if (!isValidId(id)) throw new BadRequestError("Siyosat id si noto'g'ri");

  const updated = await prisma.devicePolicy.update({
    where: { id },
    data: { isArchived: false, archivedAt: null },
  });

  await deviceAudit.record({
    action: deviceAudit.ACTIONS.POLICY_ARCHIVE,
    actorId,
    policyId: id,
    summary: `«${updated.name}» siyosati arxivdan qaytarildi`,
  });

  return updated;
}

/* ─────────────────────── BIRIKTIRISH ─────────────────────── */

const targetKeyOf = ({ scope, classId, studentId }) => {
  if (scope === "school") return "school";
  if (scope === "class") return `class:${classId}`;
  return `student:${studentId}`;
};

/** Biriktirishlar + nishon nomlari (panel ro'yxati uchun). */
async function listAssignments({ policyId } = {}) {
  const rows = await prisma.devicePolicyAssignment.findMany({
    where: { ...(policyId ? { policyId } : {}) },
    include: { policy: { select: { id: true, name: true, isArchived: true } } },
    orderBy: [{ scope: "asc" }, { createdAt: "desc" }],
  });

  const classIds = rows.map((r) => r.classId).filter(Boolean);
  const studentIds = rows.map((r) => r.studentId).filter(Boolean);

  const [classes, students] = await Promise.all([
    classIds.length
      ? prisma.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } })
      : [],
    studentIds.length
      ? prisma.user.findMany({
          where: { id: { in: studentIds } },
          select: { id: true, firstName: true, lastName: true, isArchived: true },
        })
      : [],
  ]);

  const classMap = new Map(classes.map((c) => [c.id, c]));
  const studentMap = new Map(students.map((s) => [s.id, s]));

  return rows.map((row) => {
    const student = row.studentId ? studentMap.get(row.studentId) : null;
    const klass = row.classId ? classMap.get(row.classId) : null;
    return {
      ...row,
      scopeLabel: SCOPE_LABEL[row.scope] || row.scope,
      targetName:
        row.scope === "school"
          ? "Barcha o'quvchilar"
          : row.scope === "class"
            ? klass?.name || "Nomaʼlum sinf"
            : student
              ? `${student.firstName} ${student.lastName || ""}`.trim()
              : "Nomaʼlum o'quvchi",
      targetArchived: row.scope === "student" ? Boolean(student?.isArchived) : false,
    };
  });
}

/**
 * Nishonga siyosat biriktiradi (yoki almashtiradi).
 *
 * ⚠️ "BARCHA O'QUVCHILAR" — SERVERDA ALOHIDA TASDIQ (`confirmAll`).
 * Oynadagi belgi chetlab o'tilsa ham rad etiladi: bitta so'rov butun
 * maktabning telefonini qulflaydi va bu tasodifan bo'lmasligi kerak
 * (`PayrollSuspension` bilan AYNI qoida).
 *
 * ⚠️ ARXIVLANGAN SIYOSATNI biriktirib bo'lmaydi — u ataylab iste'moldan
 * chiqarilgan.
 */
async function setAssignment(payload = {}, actorId) {
  const scope = String(payload.scope || "").trim();
  if (!["school", "class", "student"].includes(scope)) {
    throw new BadRequestError("Qamrov noto'g'ri: school | class | student");
  }
  if (!isValidId(payload.policyId)) throw new BadRequestError("Siyosat id si noto'g'ri");

  if (scope === "school" && payload.confirmAll !== true) {
    throw new BadRequestError(
      "Butun maktabga biriktirish uchun alohida tasdiq kerak (confirmAll)",
    );
  }

  const policy = await prisma.devicePolicy.findUnique({
    where: { id: payload.policyId },
    select: { id: true, name: true, version: true, isArchived: true },
  });
  if (!policy) throw new NotFoundError("Siyosat topilmadi");
  if (policy.isArchived) throw new BadRequestError("Arxivlangan siyosat biriktirilmaydi");

  let classId = null;
  let studentId = null;
  let targetName = "Barcha o'quvchilar";

  if (scope === "class") {
    if (!isValidId(payload.classId)) throw new BadRequestError("Sinf id si noto'g'ri");
    const klass = await prisma.class.findUnique({
      where: { id: payload.classId },
      select: { id: true, name: true },
    });
    if (!klass) throw new NotFoundError("Sinf topilmadi");
    classId = klass.id;
    targetName = klass.name;
  }

  if (scope === "student") {
    if (!isValidId(payload.studentId)) throw new BadRequestError("O'quvchi id si noto'g'ri");
    const student = await prisma.user.findUnique({
      where: { id: payload.studentId },
      select: { id: true, role: true, firstName: true, lastName: true, isArchived: true },
    });
    if (!student) throw new NotFoundError("O'quvchi topilmadi");
    if (student.role !== ROLES.STUDENT) {
      throw new BadRequestError("Siyosat faqat o'quvchiga biriktiriladi");
    }
    if (student.isArchived) {
      throw new BadRequestError("Arxivlangan o'quvchiga siyosat biriktirilmaydi");
    }
    studentId = student.id;
    targetName = `${student.firstName} ${student.lastName || ""}`.trim();
  }

  const targetKey = targetKeyOf({ scope, classId, studentId });
  const priority = Number.isInteger(payload.priority) ? payload.priority : 0;
  const note = normalizeNote(payload.note);

  const assignment = await prisma.$transaction(async (tx) => {
    const row = await tx.devicePolicyAssignment.upsert({
      where: { targetKey },
      create: {
        policyId: policy.id,
        scope,
        classId,
        studentId,
        targetKey,
        priority,
        note,
        isActive: true,
        createdBy: actorId,
      },
      update: { policyId: policy.id, priority, note, isActive: true },
    });

    await deviceAudit.recordInTx(tx, {
      action: deviceAudit.ACTIONS.ASSIGNMENT_SET,
      actorId,
      policyId: policy.id,
      studentId,
      summary: `${targetName} → «${policy.name}» siyosati yoqildi`,
      meta: { scope, classId, targetKey, priority },
    });

    return row;
  });

  notifyPolicyChange(policy.id).catch((error) =>
    logger.warn(`[devices] biriktirish yuborilmadi: ${error.message}`),
  );

  return assignment;
}

/**
 * Biriktirishni olib tashlaydi.
 *
 * ⚠️ QATOR O'CHIRILADI, "o'chirilgan" deb belgilanmaydi — va bu modulning
 * boshqa joylaridagi "o'chirilmaydi, bekor qilinadi" qoidasiga ZID EMAS:
 * biriktirish TARIX EMAS, u faqat AMALDAGI holatni bildiradi. Kim
 * qachon yoqib-o'chirgani `device_audits` da qoladi, ya'ni javobgarlik
 * yo'qolmaydi.
 */
async function clearAssignment(id, actorId, reason = "") {
  if (!isValidId(id)) throw new BadRequestError("Biriktirish id si noto'g'ri");

  const existing = await prisma.devicePolicyAssignment.findUnique({
    where: { id },
    include: { policy: { select: { id: true, name: true } } },
  });
  if (!existing) throw new NotFoundError("Biriktirish topilmadi");

  // Kimga ta'sir qilishini O'CHIRISHDAN OLDIN hisoblaymiz — keyin
  // biriktirish yo'q bo'ladi va kimga xabar berishni bilib bo'lmasdi.
  const affected = await affectedStudentIds(existing.policyId);

  await prisma.$transaction(async (tx) => {
    await tx.devicePolicyAssignment.delete({ where: { id } });
    await deviceAudit.recordInTx(tx, {
      action: deviceAudit.ACTIONS.ASSIGNMENT_CLEAR,
      actorId,
      policyId: existing.policyId,
      studentId: existing.studentId,
      reason,
      summary: `«${existing.policy.name}» biriktirishi olib tashlandi (${existing.targetKey})`,
      meta: { scope: existing.scope, targetKey: existing.targetKey },
    });
  });

  notifyStudents(affected, devicePush.policyCleared());

  return { removed: 1, affected: affected.length };
}

/* ─────────────────────── YECHIM (RESOLVE) ─────────────────────── */

/**
 * Barcha faol biriktirishlarni o'qiydi.
 *
 * ⚠️ Biriktirishlar SONI KICHIK (maktab + sinflar + bir nechta istisno),
 * shuning uchun ular butunlay xotiraga olinadi va yechim SQL da emas,
 * `resolveAssignment` da hisoblanadi. Buning sababi arzonlik emas —
 * bitta joyda hisoblanishi: SQL varianti mantiqning ikkinchi nusxasi
 * bo'lardi va u testdan ham tashqarida qolardi.
 */
function loadAssignments() {
  return prisma.devicePolicyAssignment.findMany({
    where: { isActive: true },
    select: {
      id: true,
      policyId: true,
      scope: true,
      classId: true,
      studentId: true,
      priority: true,
      createdAt: true,
    },
  });
}

/**
 * Bitta o'quvchiga qaysi siyosat qo'llanadi.
 * @returns {Promise<{ policy: object|null, assignment: object|null, reason: string }>}
 */
async function resolveForStudent(studentId) {
  const [assignments, classRows] = await Promise.all([
    loadAssignments(),
    prisma.userClass.findMany({ where: { userId: studentId }, select: { classId: true } }),
  ]);

  const resolution = resolveAssignment({
    assignments,
    studentId,
    classIds: classRows.map((r) => r.classId),
  });

  if (!resolution.policyId) return { policy: null, ...resolution };

  const policy = await prisma.devicePolicy.findUnique({
    where: { id: resolution.policyId },
    include: POLICY_INCLUDE,
  });

  return { policy, ...resolution };
}

/**
 * Ko'p o'quvchi uchun — qurilmalar ro'yxati va dashboard uchun.
 *
 * ⚠️ BITTA SO'ROVDA: har o'quvchi uchun alohida `resolveForStudent`
 * chaqirish 300 ta o'quvchida 600 ta so'rov bo'lardi.
 *
 * @param {string[]} studentIds
 * @returns {Promise<Map<string, { policyId, policyName, reason }>>}
 */
async function resolveForStudents(studentIds = []) {
  const ids = [...new Set(studentIds.filter(Boolean))];
  const out = new Map();
  if (ids.length === 0) return out;

  const [assignments, classRows] = await Promise.all([
    loadAssignments(),
    prisma.userClass.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, classId: true },
    }),
  ]);

  const classesByStudent = new Map();
  for (const row of classRows) {
    const list = classesByStudent.get(row.userId) || [];
    list.push(row.classId);
    classesByStudent.set(row.userId, list);
  }

  const policyIds = [...new Set(assignments.map((a) => a.policyId))];
  const policies = policyIds.length
    ? await prisma.devicePolicy.findMany({
        where: { id: { in: policyIds } },
        select: { id: true, name: true, version: true, defaultMode: true, dailyLimitMinutes: true },
      })
    : [];
  const policyMap = new Map(policies.map((p) => [p.id, p]));

  for (const studentId of ids) {
    const resolution = resolveAssignment({
      assignments,
      studentId,
      classIds: classesByStudent.get(studentId) || [],
    });
    const policy = resolution.policyId ? policyMap.get(resolution.policyId) : null;
    out.set(studentId, {
      policyId: policy?.id || null,
      policyName: policy?.name || null,
      policyVersion: policy?.version || null,
      dailyLimitMinutes: policy?.dailyLimitMinutes ?? null,
      reason: resolution.reason,
    });
  }

  return out;
}

/**
 * Shu siyosat AMALDA qaysi o'quvchilarga qo'llanayotganini qaytaradi.
 *
 * ⚠️ "Biriktirilgan" bilan "amalda" BIR XIL EMAS: maktab siyosatiga
 * biriktirilgan o'quvchining shaxsiy istisnosi bo'lsa, unga bu siyosat
 * QO'LLANMAYDI. Shuning uchun bu yerda ham yechim to'liq hisoblanadi —
 * "nechta o'quvchiga ta'sir qiladi" degan raqam yolg'on bo'lmasligi kerak.
 *
 * @returns {Promise<string[]>}
 */
async function affectedStudentIds(policyId) {
  const students = await prisma.user.findMany({
    where: { role: ROLES.STUDENT, isArchived: false },
    select: { id: true },
  });

  const resolved = await resolveForStudents(students.map((s) => s.id));
  return [...resolved.entries()]
    .filter(([, value]) => value.policyId === policyId)
    .map(([id]) => id);
}

/**
 * Siyosat o'zgarganda ta'sir qilgan o'quvchilarga push yuboradi.
 * ⚠️ Kutilmaydi va xato tashlamaydi (chaqiruvchilarga qarang).
 */
async function notifyPolicyChange(policyId) {
  const policy = await prisma.devicePolicy.findUnique({
    where: { id: policyId },
    select: { id: true, name: true, version: true },
  });
  if (!policy) return { sent: 0 };

  const ids = await affectedStudentIds(policyId);
  notifyStudents(
    ids,
    devicePush.policyUpdated({
      policyId: policy.id,
      policyName: policy.name,
      version: policy.version,
    }),
  );
  return { targeted: ids.length };
}

/** Push — kutilmaydi, xato tashlamaydi. */
function notifyStudents(studentIds, message) {
  if (!studentIds?.length) return;
  pushService
    .sendToUsers(studentIds, message)
    .catch((error) => logger.warn(`[devices] push yuborilmadi: ${error.message}`));
}

module.exports = {
  POLICY_INCLUDE,
  listPolicies,
  getPolicy,
  createPolicy,
  updatePolicy,
  archivePolicy,
  restorePolicy,
  listAssignments,
  setAssignment,
  clearAssignment,
  resolveForStudent,
  resolveForStudents,
  affectedStudentIds,
  notifyPolicyChange,
  notifyStudents,
  decoratePolicy,
  targetKeyOf,
};
