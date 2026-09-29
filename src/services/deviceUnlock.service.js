/**
 * VAQTINCHALIK OCHISH — "bugun kechqurun ochib ber", "yana 30 daqiqa".
 *
 * ⚠️ DAVR IKKALA TOMONDAN MAJBURIY va ko'pi bilan `MAX_UNLOCK_HOURS`
 * (24 soat). Muddatsiz ochish chekovni jimgina abadiy o'chirib qo'yardi
 * va buni hech kim sezmasdi — `PayrollSuspension` dagi "ko'pi bilan
 * 12 oy" bilan AYNI mulohaza.
 *
 * ⚠️ HAR O'QUVCHIGA ALOHIDA QATOR (`batchId` bilan guruhlansa ham):
 * registr, bekor qilish va o'quvchining o'z ekrani qator bilan ishlaydi
 * (`PayrollDeduction` bilan bir xil qaror).
 *
 * ⚠️ O'CHIRILMAYDI — BEKOR QILINADI (sabab + aktyor). Chekovni
 * yumshatgan qaror tarixda qolishi shart.
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError, ConflictError } = require("../utils/errors");
const { isValidId } = require("../utils/objectId");
const { formatPaginationResponse } = require("../utils/pagination");
const { ROLES } = require("../utils/constants");
const { MAX_UNLOCK_HOURS } = require("../helpers/devicePolicy.helpers");
const { formatDateTimeUz } = require("../helpers/date.helpers");
const deviceAudit = require("./deviceAudit.service");
const devicePolicyService = require("./devicePolicy.service");
const devicePush = require("../helpers/devicePush.helpers");

const REASON_MAX = 300;
const NOTE_MAX = 500;
const MAX_STUDENTS_PER_REQUEST = 200;

const clip = (value, max) => String(value ?? "").trim().slice(0, max);

/**
 * Davrni tekshiradi.
 *
 * ⚠️ `endsAt` O'TMISHDA bo'lishi mumkin emas: darhol tugagan ochish
 * hech narsa qilmaydi-yu, registrda "berildi" bo'lib turardi va
 * "nega ishlamadi" degan savol tug'ilardi.
 */
function parsePeriod(payload) {
  const now = new Date();

  const startsAt = payload.startsAt ? new Date(payload.startsAt) : now;
  if (Number.isNaN(startsAt.getTime())) throw new BadRequestError("Boshlanish vaqti noto'g'ri");

  let endsAt;
  if (payload.endsAt) {
    endsAt = new Date(payload.endsAt);
    if (Number.isNaN(endsAt.getTime())) throw new BadRequestError("Tugash vaqti noto'g'ri");
  } else if (payload.durationMinutes !== undefined) {
    const minutes = Number(payload.durationMinutes);
    if (!Number.isInteger(minutes) || minutes < 1) {
      throw new BadRequestError("Davomiylik kamida 1 daqiqa bo'lishi kerak");
    }
    endsAt = new Date(startsAt.getTime() + minutes * 60000);
  } else {
    throw new BadRequestError("Tugash vaqti majburiy — muddatsiz ochish yo'q");
  }

  if (endsAt <= startsAt) throw new BadRequestError("Tugash vaqti boshlanishdan keyin bo'lishi kerak");
  if (endsAt <= now) throw new BadRequestError("Tugash vaqti o'tib ketgan");

  const hours = (endsAt - startsAt) / 3600000;
  if (hours > MAX_UNLOCK_HOURS) {
    throw new BadRequestError(
      `Vaqtinchalik ochish ko'pi bilan ${MAX_UNLOCK_HOURS} soat bo'lishi mumkin. Uzoqroq kerak bo'lsa — siyosatni o'zgartiring.`,
    );
  }

  return { startsAt, endsAt };
}

/**
 * Ochish yaratadi (bir yoki bir nechta o'quvchiga).
 *
 * ⚠️ AYNAN TAKROR QAYTA YOZILMAYDI: shu o'quvchida o'sha turdagi va
 * o'sha ilovaga AMALDAGI ochish bo'lsa, ikkinchisi yozilmaydi va
 * `skipped` da qaytadi. Tugmani ikki marta bosish ikki barobar vaqt
 * bermasligi kerak.
 */
async function create(payload = {}, actorId) {
  const kind = payload.kind === "app" ? "app" : "full";
  const reason = clip(payload.reason, REASON_MAX);
  if (!reason) throw new BadRequestError("Sabab majburiy");

  const { startsAt, endsAt } = parsePeriod(payload);

  const studentIds = [...new Set((payload.studentIds || []).filter(isValidId))];
  if (studentIds.length === 0) throw new BadRequestError("Kamida bitta o'quvchi tanlang");
  if (studentIds.length > MAX_STUDENTS_PER_REQUEST) {
    throw new BadRequestError(`Bir so'rovda ko'pi bilan ${MAX_STUDENTS_PER_REQUEST} o'quvchi`);
  }

  let appId = null;
  let extraMinutes = null;
  if (kind === "app") {
    if (!isValidId(payload.appId)) throw new BadRequestError("Ilova tanlanmagan");
    const app = await prisma.deviceApp.findUnique({
      where: { id: payload.appId },
      select: { id: true, name: true },
    });
    if (!app) throw new NotFoundError("Ilova topilmadi");
    appId = app.id;

    const minutes = Number(payload.extraMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      throw new BadRequestError("Qo'shimcha daqiqa 1 dan 1440 gacha bo'lishi kerak");
    }
    extraMinutes = minutes;
  }

  // ⚠️ Faqat o'quvchi: xodimning telefoni bu modulga kirmaydi.
  const students = await prisma.user.findMany({
    where: { id: { in: studentIds }, role: ROLES.STUDENT, isArchived: false },
    select: { id: true, firstName: true, lastName: true },
  });
  if (students.length === 0) throw new BadRequestError("Mos o'quvchi topilmadi");

  const deviceId = isValidId(payload.deviceId) ? payload.deviceId : null;

  const existing = await prisma.deviceUnlock.findMany({
    where: {
      studentId: { in: students.map((s) => s.id) },
      status: "active",
      kind,
      appId,
      endsAt: { gt: new Date() },
    },
    select: { studentId: true },
  });
  const alreadyOpen = new Set(existing.map((row) => row.studentId));

  const targets = students.filter((s) => !alreadyOpen.has(s.id));
  if (targets.length === 0) {
    throw new ConflictError("Tanlanganlarning hammasida bunday ochish allaqachon amalda");
  }

  const created = await prisma.$transaction(async (tx) => {
    const rows = [];
    for (const student of targets) {
      const row = await tx.deviceUnlock.create({
        data: {
          studentId: student.id,
          deviceId,
          kind,
          appId,
          extraMinutes,
          startsAt,
          endsAt,
          reason,
          note: clip(payload.note, NOTE_MAX),
          createdBy: actorId,
        },
      });
      rows.push(row);

      await deviceAudit.recordInTx(tx, {
        action: deviceAudit.ACTIONS.UNLOCK_CREATE,
        actorId,
        studentId: student.id,
        deviceId,
        reason,
        summary:
          kind === "full"
            ? `${student.firstName} ${student.lastName || ""}: telefon ${formatDateTimeUz(endsAt)} gacha ochildi`.trim()
            : `${student.firstName} ${student.lastName || ""}: +${extraMinutes} daqiqa`.trim(),
        meta: { kind, appId, extraMinutes, startsAt, endsAt },
      });
    }
    return rows;
  });

  devicePolicyService.notifyStudents(
    targets.map((s) => s.id),
    devicePush.unlockGranted({ until: formatDateTimeUz(endsAt), reason, kind }),
  );

  return {
    created: created.length,
    skipped: students.length - targets.length,
    unlocks: created,
  };
}

/**
 * Bekor qiladi.
 * ⚠️ Faqat AMALDAGI ochish bekor qilinadi: allaqachon tugaganini
 * "bekor qilish" tarixni yolg'on ko'rsatardi.
 */
async function cancel(id, reason, actorId) {
  if (!isValidId(id)) throw new BadRequestError("Ochish id si noto'g'ri");

  const trimmed = clip(reason, REASON_MAX);
  if (!trimmed) throw new BadRequestError("Bekor qilish sababi majburiy");

  const unlock = await prisma.deviceUnlock.findUnique({ where: { id } });
  if (!unlock) throw new NotFoundError("Yozuv topilmadi");
  if (unlock.status !== "active") throw new BadRequestError("Bu yozuv allaqachon yopilgan");

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.deviceUnlock.update({
      where: { id },
      data: {
        status: "cancelled",
        cancelReason: trimmed,
        cancelledAt: new Date(),
        cancelledBy: actorId,
      },
    });

    await deviceAudit.recordInTx(tx, {
      action: deviceAudit.ACTIONS.UNLOCK_CANCEL,
      actorId,
      studentId: unlock.studentId,
      deviceId: unlock.deviceId,
      reason: trimmed,
      summary: "Vaqtinchalik ochish bekor qilindi",
    });

    return row;
  });

  devicePolicyService.notifyStudents(
    [unlock.studentId],
    devicePush.unlockCancelled({ reason: trimmed }),
  );

  return updated;
}

/**
 * REGISTR — amaldagi va tarixdagi ochishlar.
 *
 * ⚠️ QIDIRUV O'QUVCHI ISMI BO'YICHA va u SQL darajasida (`listDevices`
 * bilan AYNI naqsh): `studentId` soft ref, shuning uchun avval ismga mos
 * o'quvchilar topiladi. Xotirada filtrlansa, ikkinchi sahifadagi o'quvchi
 * qidiruvda topilmasdi.
 *
 * ⚠️ "AMALDA" — `status` VA `endsAt` BIRGALIKDA. Supurgi kechikkan
 * bo'lsa ham ro'yxat haqiqatni ko'rsatishi kerak, shuning uchun `live`
 * filtri `endsAt > hozir` shartini ham qo'yadi.
 */
async function list(query = {}) {
  const status = String(query.status || "live");
  const search = String(query.search || "").trim();
  const now = new Date();

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(Math.max(Number(query.limit) || 30, 1), 200);

  const where = {
    ...(isValidId(query.studentId) ? { studentId: query.studentId } : {}),
    ...(status === "live"
      ? { status: "active", endsAt: { gt: now } }
      : status === "all"
        ? {}
        : { status }),
  };

  if (search) {
    const matched = await prisma.user.findMany({
      where: {
        role: ROLES.STUDENT,
        OR: [
          { firstName: { contains: search, mode: "insensitive" } },
          { lastName: { contains: search, mode: "insensitive" } },
        ],
      },
      select: { id: true },
      take: 500,
    });
    where.studentId = { in: matched.map((u) => u.id) };
  }

  const [rows, total, liveCount] = await Promise.all([
    prisma.deviceUnlock.findMany({
      where,
      include: { app: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.deviceUnlock.count({ where }),
    prisma.deviceUnlock.count({ where: { status: "active", endsAt: { gt: now } } }),
  ]);

  const studentIds = [...new Set(rows.map((r) => r.studentId))];
  const students = studentIds.length
    ? await prisma.user.findMany({
        where: { id: { in: studentIds } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          classes: { select: { class: { select: { name: true } } } },
        },
      })
    : [];
  const studentMap = new Map(students.map((s) => [s.id, s]));

  const data = rows.map((row) => {
    const student = studentMap.get(row.studentId);
    return {
      ...row,
      isLive: row.status === "active" && new Date(row.endsAt) > now,
      student: student
        ? {
            id: student.id,
            firstName: student.firstName,
            lastName: student.lastName,
            className: student.classes?.[0]?.class?.name || null,
          }
        : null,
    };
  });

  return { ...formatPaginationResponse(data, total, page, limit), liveCount };
}

/** O'quvchi o'z ochishlarini ko'radi (profil ekrani). */
async function listMine(studentId) {
  return prisma.deviceUnlock.findMany({
    where: { studentId, endsAt: { gt: new Date(Date.now() - 7 * 86400000) } },
    include: { app: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
}

/**
 * Muddati o'tganlarni yopadi (kechki supurgi).
 *
 * ⚠️ Bu FAQAT RO'YXATNI TOZALAYDI. Hisob-kitob baribir `endsAt` ga
 * qaraydi (`activeUnlocks`), ya'ni job ishlamay qolsa ham ochish o'z
 * vaqtida tugaydi — chekov ochiq qolib ketmaydi.
 */
async function expireOverdue() {
  const { count } = await prisma.deviceUnlock.updateMany({
    where: { status: "active", endsAt: { lte: new Date() } },
    data: { status: "expired" },
  });
  return { expired: count };
}

module.exports = { create, cancel, list, listMine, expireOverdue, MAX_UNLOCK_HOURS };
