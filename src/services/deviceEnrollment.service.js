/**
 * QURILMA BIRIKTIRISH VA HAYOT DAVRI.
 *
 * ⚠️ BIRIKTIRISH IKKI TOMONLAMA IMZO. Kodni KATTA ODAM beradi
 * (`devices.enroll`), kodni telefonga esa O'QUVCHINING O'ZI kiritadi —
 * ya'ni har ikkalasi ham harakat qiladi. Ikkalasini bitta tomonga
 * yig'ish ikki xil yomon natija berardi:
 *   · faqat admin qila olsa — masofadan, bola bilmagan holda qurilma
 *     biriktirilardi (`devices.md` §0.4 buni taqiqlaydi);
 *   · faqat o'quvchi qila olsa — u soxta "qurilma" biriktirib, haqiqiy
 *     telefonini chekovdan tashqarida qoldirardi va panelda hammasi
 *     joyida ko'rinardi.
 *
 * ⚠️ QURILMA O'CHIRILMAYDI — `removed` bo'ladi (sababi va aktyori bilan):
 * ekran vaqti tarixi unga ishora qiladi.
 *
 * ⚠️ `deviceUid` YAGONA. Shu telefon boshqa o'quvchiga biriktirilsa qator
 * unga KO'CHADI (`PushDevice` bilan bir xil qaror): aks holda avvalgi
 * egasining qoidasi yangi bolada qolib ketardi.
 */

const crypto = require("crypto");

const prisma = require("../config/prisma");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} = require("../utils/errors");
const { isValidId } = require("../utils/objectId");
const { formatPaginationResponse } = require("../utils/pagination");
const { ROLES } = require("../utils/constants");
const { deviceHealth } = require("../helpers/devicePolicy.helpers");
const { getDeviceSettings } = require("./settings.service");
const devicePolicyService = require("./devicePolicy.service");
const deviceAudit = require("./deviceAudit.service");
const devicePush = require("../helpers/devicePush.helpers");

const PLATFORMS = Object.freeze(["android", "ios"]);
const CODE_LENGTH = 6;
const CODE_ATTEMPTS = 6;
const LABEL_MAX = 60;
const REASON_MAX = 300;

const DEVICE_SELECT = {
  id: true,
  studentId: true,
  deviceUid: true,
  label: true,
  platform: true,
  manufacturer: true,
  model: true,
  osVersion: true,
  appVersion: true,
  status: true,
  enforcing: true,
  enforcementNote: true,
  lastSeenAt: true,
  lastSyncAt: true,
  appliedPolicyVersion: true,
  batteryLevel: true,
  enrolledAt: true,
  removedAt: true,
  removeReason: true,
};

const clip = (value, max) => String(value ?? "").trim().slice(0, max) || null;

/**
 * 6 xonali kod.
 *
 * ⚠️ `crypto.randomInt` — `Math.random` EMAS. Kod qurilmani o'quvchiga
 * bog'laydi; taxmin qilinadigan ketma-ketlik birovning telefonini
 * boshqa bolaga biriktirib qo'yish yo'li bo'lardi.
 *
 * ⚠️ Faqat RAQAM: kod telefon klaviaturasida terilади va harf
 * aralashtirilsa "O" bilan "0" chalkashardi.
 */
const generateCode = () =>
  String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");

/* ─────────────────────── KOD ─────────────────────── */

/**
 * O'quvchi uchun bir martalik kod beradi.
 *
 * ⚠️ YANGI KOD ESKISINI BEKOR QILADI: bir o'quvchida bir vaqtda faqat
 * bitta faol kod bo'ladi. Aks holda "qaysi kodni aytgan edim" degan
 * holat tug'ilardi va eski kod muddatigacha ishlab turardi.
 */
async function issueCode(studentId, actorId) {
  if (!isValidId(studentId)) throw new BadRequestError("O'quvchi id si noto'g'ri");

  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { id: true, role: true, firstName: true, lastName: true, isArchived: true },
  });
  if (!student) throw new NotFoundError("O'quvchi topilmadi");
  if (student.role !== ROLES.STUDENT) {
    throw new BadRequestError("Qurilma faqat o'quvchiga biriktiriladi");
  }
  if (student.isArchived) {
    throw new BadRequestError("Arxivlangan o'quvchiga qurilma biriktirilmaydi");
  }

  const settings = await getDeviceSettings();
  const ttlMs = Math.max(1, settings.enrollmentCodeTtlMinutes) * 60000;
  const expiresAt = new Date(Date.now() + ttlMs);

  const created = await prisma.$transaction(async (tx) => {
    await tx.deviceEnrollmentCode.updateMany({
      where: { studentId, usedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // Kod yagona — juda kam ehtimolli to'qnashuvda qayta urinamiz.
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      try {
        return await tx.deviceEnrollmentCode.create({
          data: { code: generateCode(), studentId, expiresAt, createdBy: actorId },
        });
      } catch (error) {
        if (error?.code !== "P2002" || attempt === CODE_ATTEMPTS - 1) throw error;
      }
    }
    throw new ConflictError("Kod yaratilmadi, qayta urinib ko'ring");
  });

  await deviceAudit.record({
    action: deviceAudit.ACTIONS.CODE_ISSUE,
    actorId,
    studentId,
    summary: `${student.firstName} ${student.lastName || ""} uchun biriktirish kodi berildi`.trim(),
    meta: { expiresAt },
  });

  return { code: created.code, expiresAt: created.expiresAt, studentId };
}

/**
 * O'quvchining amaldagi kodi (panelda ko'rsatish uchun).
 * Muddati o'tgan / ishlatilgan kod QAYTARILMAYDI.
 */
async function getActiveCode(studentId) {
  return prisma.deviceEnrollmentCode.findFirst({
    where: {
      studentId,
      usedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    select: { code: true, expiresAt: true },
  });
}

/* ─────────────────────── BIRIKTIRISH ─────────────────────── */

/**
 * Qurilmani kod bilan biriktiradi. Chaqiruvchi — O'QUVCHINING O'ZI.
 *
 * ⚠️ `studentId` KODDAN OLINADI va so'rovdagi foydalanuvchi bilan
 * TAQQOSLANADI: kod boshqa bolaga tegishli bo'lsa rad etiladi. Ikkalasi
 * ham tekshirilishi kerak — faqat kodga ishonilsa, o'g'irlangan kod bilan
 * birovning nomidan qurilma yozilardi; faqat tokenga ishonilsa, kod
 * umuman keraksiz bo'lib qolardi.
 *
 * ⚠️ KOD BIR MARTALIK: `usedAt` shu tranzaksiyada `updateMany` bilan,
 * shartida `usedAt: null` bilan yoziladi — ikki parallel so'rov bitta
 * kodni ikki qurilmaga biriktira olmaydi (compare-and-swap).
 */
async function enroll(payload = {}, user) {
  const code = String(payload.code || "").trim();
  if (!/^\d{6}$/.test(code)) throw new BadRequestError("Kod 6 xonali raqam bo'lishi kerak");

  const deviceUid = String(payload.deviceUid || "").trim();
  if (deviceUid.length < 8 || deviceUid.length > 64) {
    throw new BadRequestError("Qurilma identifikatori noto'g'ri");
  }

  const platform = PLATFORMS.includes(payload.platform) ? payload.platform : "android";

  const row = await prisma.deviceEnrollmentCode.findUnique({ where: { code } });
  if (!row || row.revokedAt) throw new NotFoundError("Kod topilmadi yoki bekor qilingan");
  if (row.usedAt) throw new ConflictError("Bu kod allaqachon ishlatilgan");
  if (row.expiresAt <= new Date()) throw new BadRequestError("Kod muddati tugagan");
  if (row.studentId !== user.id) throw new ForbiddenError("Bu kod sizga tegishli emas");

  const device = await prisma.$transaction(async (tx) => {
    // ⚠️ Compare-and-swap: shart ichida `usedAt: null`.
    const claimed = await tx.deviceEnrollmentCode.updateMany({
      where: { id: row.id, usedAt: null, revokedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) throw new ConflictError("Bu kod allaqachon ishlatilgan");

    const data = {
      studentId: user.id,
      label: clip(payload.label, LABEL_MAX) || clip(payload.model, LABEL_MAX) || "Qurilma",
      platform,
      manufacturer: clip(payload.manufacturer, 64),
      model: clip(payload.model, 64),
      osVersion: clip(payload.osVersion, 32),
      appVersion: clip(payload.appVersion, 32),
      status: "active",
      // ⚠️ `enforcing` FALSE bilan boshlanadi: OS ruxsati berilganini
      // faqat qurilma tasdiqlaydi (`heartbeat`). Boshidan `true` qo'yilsa
      // panel ruxsat berilmagan telefonni "himoyada" deb ko'rsatardi.
      enforcing: false,
      enforcementNote: "",
      removedAt: null,
      removedBy: null,
      removeReason: "",
      enrolledBy: user.id,
      enrolledAt: new Date(),
    };

    const saved = await tx.studentDevice.upsert({
      where: { deviceUid },
      create: { deviceUid, ...data },
      update: data,
      select: DEVICE_SELECT,
    });

    await tx.deviceEnrollmentCode.update({
      where: { id: row.id },
      data: { usedBy: saved.id },
    });

    await deviceAudit.recordInTx(tx, {
      action: deviceAudit.ACTIONS.DEVICE_ENROLL,
      actorId: user.id,
      studentId: user.id,
      deviceId: saved.id,
      summary: `«${saved.label}» qurilmasi biriktirildi`,
      meta: { platform, model: saved.model },
    });

    return saved;
  });

  devicePolicyService.notifyStudents([user.id], devicePush.deviceEnrolled({ label: device.label }));

  return device;
}

/* ─────────────────────── RO'YXAT VA HOLAT ─────────────────────── */

/**
 * HOLAT FILTRI SQL SHARTIGA aylantiriladi.
 *
 * ⚠️ XOTIRADA FILTRLANMAYDI. Ilgari ro'yxat `take: 500` bilan olinib,
 * qidiruv va holat filtri KEYIN xotirada qo'llanardi — ya'ni 600-chi
 * qurilma qidiruvda hech qachon topilmasdi va buni hech kim sezmasdi
 * (ro'yxat "bo'sh" ko'rinardi, xato emas).
 *
 * ⚠️ HOLAT VA `status` BITTA TUSHUNCHA. Panelda ham bitta tanlagich:
 * ikkita bo'lganda "faol + to'xtatilgan" kabi bir-birini inkor qiladigan
 * tanlov mumkin bo'lib, foydalanuvchi bo'sh ro'yxatni tizim nosozligi deb
 * o'ylardi.
 *
 * @param {string} health - HEALTH_FILTERS kaliti
 * @param {number} offlineGraceMinutes
 */
function healthWhere(health, offlineGraceMinutes) {
  const cutoff = new Date(Date.now() - Math.max(1, offlineGraceMinutes) * 60000);

  switch (health) {
    case "paused":
      return { status: "paused" };
    case "removed":
      return { status: "removed" };
    case "pending":
      return { status: "active", lastSeenAt: null };
    case "offline":
      return { status: "active", lastSeenAt: { lt: cutoff } };
    case "degraded":
      return { status: "active", enforcing: false, lastSeenAt: { gte: cutoff } };
    case "healthy":
      return { status: "active", enforcing: true, lastSeenAt: { gte: cutoff } };
    case "all":
      return {};
    default:
      // Sukut: olib tashlanganlardan boshqa hammasi. "Faol" deb
      // cheklansa, to'xtatilgan qurilma ro'yxatdan jimgina yo'qolardi.
      return { status: { not: "removed" } };
  }
}

/**
 * Qurilmalar ro'yxati — o'quvchi, sinf, siyosat va holat bilan.
 *
 * ⚠️ QIDIRUV IKKI QADAMDA. `StudentDevice.studentId` — soft ref (FK yo'q,
 * `devices.md` §5), ya'ni Prisma bilan `User` ga join qilib bo'lmaydi.
 * Shuning uchun avval ismga mos o'quvchilar topiladi, keyin qurilmalar
 * o'sha id lar bo'yicha filtrlanadi — natija baribir SQL da chiqadi.
 *
 * ⚠️ SIYOSAT YECHIMI OMMAVIY (`resolveForStudents`): har qator uchun
 * alohida hisoblash 300 ta qurilmada yuzlab so'rov bo'lardi.
 */
async function listDevices(query = {}) {
  const settings = await getDeviceSettings();

  const search = String(query.search || "").trim();
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(Math.max(Number(query.limit) || 30, 1), 200);

  const where = {
    ...healthWhere(String(query.health || "").trim(), settings.offlineGraceMinutes),
    ...(isValidId(query.studentId) ? { studentId: query.studentId } : {}),
  };

  // Sinf — a'zolar id lari orqali.
  if (isValidId(query.classId)) {
    const members = await prisma.userClass.findMany({
      where: { classId: query.classId },
      select: { userId: true },
    });
    where.studentId = { in: members.map((m) => m.userId) };
  }

  // Qidiruv — o'quvchi ismi YOKI qurilma nomi/modeli.
  if (search) {
    const matched = await prisma.user.findMany({
      where: {
        role: ROLES.STUDENT,
        OR: [
          { firstName: { contains: search, mode: "insensitive" } },
          { lastName: { contains: search, mode: "insensitive" } },
          { username: { contains: search, mode: "insensitive" } },
        ],
      },
      select: { id: true },
      take: 500,
    });

    where.OR = [
      ...(matched.length ? [{ studentId: { in: matched.map((u) => u.id) } }] : []),
      { label: { contains: search, mode: "insensitive" } },
      { model: { contains: search, mode: "insensitive" } },
    ];
  }

  const [devices, total] = await Promise.all([
    prisma.studentDevice.findMany({
      where,
      orderBy: [{ status: "asc" }, { lastSeenAt: { sort: "desc", nulls: "last" } }],
      skip: (page - 1) * limit,
      take: limit,
      select: DEVICE_SELECT,
    }),
    prisma.studentDevice.count({ where }),
  ]);

  const studentIds = [...new Set(devices.map((d) => d.studentId))];

  const [students, policyMap] = await Promise.all([
    studentIds.length
      ? prisma.user.findMany({
          where: { id: { in: studentIds } },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            isArchived: true,
            classes: { select: { class: { select: { id: true, name: true } } } },
          },
        })
      : [],
    devicePolicyService.resolveForStudents(studentIds),
  ]);

  const studentMap = new Map(students.map((s) => [s.id, s]));

  const rows = devices.map((device) => {
    const student = studentMap.get(device.studentId);
    const policy = policyMap.get(device.studentId);
    return {
      ...device,
      health: deviceHealth(device, settings.offlineGraceMinutes),
      student: student
        ? {
            id: student.id,
            firstName: student.firstName,
            lastName: student.lastName,
            isArchived: student.isArchived,
            className: student.classes?.[0]?.class?.name || null,
            classIds: (student.classes || []).map((c) => c.class.id),
          }
        : null,
      policy: policy || { policyId: null, policyName: null, reason: "" },
      // ⚠️ UCH HOLAT AJRATILADI va bu ataylab:
      //   `current`  — qurilmada AYNI versiya turibdi;
      //   `pending`  — qurilma qoidani HALI BIR MARTA HAM olmagan;
      //   `outdated` — qurilmada ESKI versiya turibdi (push yetmagan).
      // Ikkinchisini "eski qoida bilan ishlayapti" deb ko'rsatish YOLG'ON
      // bo'lardi: qurilmada hech qanday qoida yo'q, u shunchaki hali
      // olmagan — va tuzatish yo'li ham boshqa.
      policyState: !policy?.policyVersion
        ? "current"
        : device.appliedPolicyVersion == null
          ? "pending"
          : device.appliedPolicyVersion !== policy.policyVersion
            ? "outdated"
            : "current",
    };
  });

  return formatPaginationResponse(rows, total, page, limit);
}

/** Bitta qurilma — tafsilot oynasi uchun. */
async function getDevice(id) {
  if (!isValidId(id)) throw new BadRequestError("Qurilma id si noto'g'ri");

  const device = await prisma.studentDevice.findUnique({
    where: { id },
    select: DEVICE_SELECT,
  });
  if (!device) throw new NotFoundError("Qurilma topilmadi");

  const settings = await getDeviceSettings();
  return { ...device, health: deviceHealth(device, settings.offlineGraceMinutes) };
}

/* ─────────────────────── HAYOT DAVRI ─────────────────────── */

async function setStatus(id, status, actorId, reason = "") {
  if (!isValidId(id)) throw new BadRequestError("Qurilma id si noto'g'ri");
  if (!["active", "paused", "removed"].includes(status)) {
    throw new BadRequestError("Holat noto'g'ri");
  }

  const device = await prisma.studentDevice.findUnique({ where: { id } });
  if (!device) throw new NotFoundError("Qurilma topilmadi");

  // ⚠️ OLIB TASHLASH SABABI MAJBURIY: chekovni bekor qilish qarori
  // sababsiz qolmasligi kerak (modulning butun doktrinasi).
  const trimmed = String(reason || "").trim().slice(0, REASON_MAX);
  if (status === "removed" && !trimmed) {
    throw new BadRequestError("Olib tashlash sababi majburiy");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.studentDevice.update({
      where: { id },
      data: {
        status,
        ...(status === "removed"
          ? { removedAt: new Date(), removedBy: actorId, removeReason: trimmed, enforcing: false }
          : { removedAt: null, removedBy: null, removeReason: "" }),
      },
      select: DEVICE_SELECT,
    });

    const action =
      status === "removed"
        ? deviceAudit.ACTIONS.DEVICE_REMOVE
        : status === "paused"
          ? deviceAudit.ACTIONS.DEVICE_PAUSE
          : deviceAudit.ACTIONS.DEVICE_RESUME;

    const verb =
      status === "removed" ? "olib tashlandi" : status === "paused" ? "to'xtatildi" : "qayta yoqildi";

    await deviceAudit.recordInTx(tx, {
      action,
      actorId,
      studentId: device.studentId,
      deviceId: id,
      reason: trimmed,
      summary: `«${row.label}» qurilmasi ${verb}`,
    });

    return row;
  });

  devicePolicyService.notifyStudents(
    [device.studentId],
    status === "removed" ? devicePush.policyCleared() : devicePush.policyUpdated({}),
  );

  return updated;
}

/**
 * O'quvchi arxivlanganda uning qurilmalarini chekovdan chiqaradi.
 *
 * ⚠️ ARXIVLANGAN O'QUVCHI MAKTAB O'QUVCHISI EMAS, telefoni ham
 * maktabniki emas: uni cheklab turish huquqimiz yo'q. Chaqiruvchi —
 * `user.service.js` dagi arxivlash oqimi.
 *
 * ⚠️ Xato TASHLAMAYDI: qurilma tozalanmagani arxivlashni orqaga
 * qaytarmasligi kerak (arxivlashdagi qarz tushirish bilan bir xil qaror,
 * `finance.md` §6).
 */
async function releaseForStudent(studentId, actorId, reason = "O'quvchi arxivlandi") {
  const devices = await prisma.studentDevice.findMany({
    where: { studentId, status: { not: "removed" } },
    select: { id: true, label: true },
  });
  if (devices.length === 0) return { removed: 0 };

  await prisma.studentDevice.updateMany({
    where: { studentId, status: { not: "removed" } },
    data: {
      status: "removed",
      removedAt: new Date(),
      removedBy: actorId || null,
      removeReason: reason,
      enforcing: false,
    },
  });

  await deviceAudit.record({
    action: deviceAudit.ACTIONS.DEVICE_REMOVE,
    actorId: actorId || studentId,
    studentId,
    reason,
    summary: `${devices.length} ta qurilma chekovdan chiqarildi`,
    meta: { devices: devices.map((d) => d.id) },
  });

  return { removed: devices.length };
}

/**
 * O'QUVCHI QIDIRUVI — biriktirish, ochish va siyosat oynalari uchun.
 *
 * ⚠️ BO'LIMNING O'Z QIDIRUVI, `/users/students` EMAS va bu ataylab:
 * u `users.view` talab qiladi, ya'ni faqat qurilma nazoratini
 * boshqaradigan xodim o'quvchini umuman tanlay olmasdi. Bo'lim o'z
 * ishini o'zi bajarishi kerak (`gradeAnalysis` da ham shunday).
 *
 * ⚠️ Javobda "qurilmasi bormi" va "qaysi siyosat amalda" ham bor:
 * oynada o'quvchini tanlayotgan odam ayni shu ikki narsani bilishi
 * kerak — aks holda allaqachon qurilmasi bor bolaga yana kod berardi.
 */
async function searchStudents(query = {}) {
  const search = String(query.search || "").trim();
  const classId = isValidId(query.classId) ? query.classId : null;

  const students = await prisma.user.findMany({
    where: {
      role: ROLES.STUDENT,
      isArchived: false,
      ...(classId ? { classes: { some: { classId } } } : {}),
      ...(search
        ? {
            OR: [
              { firstName: { contains: search, mode: "insensitive" } },
              { lastName: { contains: search, mode: "insensitive" } },
              { username: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      classes: { select: { class: { select: { id: true, name: true } } } },
    },
    orderBy: [{ firstName: "asc" }],
    take: 50,
  });

  const ids = students.map((s) => s.id);
  const [devices, policies] = await Promise.all([
    ids.length
      ? prisma.studentDevice.groupBy({
          by: ["studentId"],
          where: { studentId: { in: ids }, status: { not: "removed" } },
          _count: { _all: true },
        })
      : [],
    devicePolicyService.resolveForStudents(ids),
  ]);
  const deviceCount = new Map(devices.map((d) => [d.studentId, d._count._all]));

  return students.map((student) => ({
    id: student.id,
    firstName: student.firstName,
    lastName: student.lastName || "",
    className: student.classes?.[0]?.class?.name || null,
    deviceCount: deviceCount.get(student.id) || 0,
    policyName: policies.get(student.id)?.policyName || null,
  }));
}

module.exports = {
  PLATFORMS,
  DEVICE_SELECT,
  searchStudents,
  issueCode,
  getActiveCode,
  enroll,
  listDevices,
  healthWhere,
  getDevice,
  setStatus,
  releaseForStudent,
  deviceHealth,
};
