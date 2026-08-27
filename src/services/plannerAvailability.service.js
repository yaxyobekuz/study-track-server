/**
 * REJALASHTIRISH — BANDLIK ("Bandlik" tab).
 *
 * Band katak = "bu yerga dars qo'yib bo'lmaydi". Qator BORLIGI band degani,
 * bo'sh katak uchun yozuv saqlanmaydi: shu sababli "bo'sh"ni alohida belgilash
 * kerak emas va jadval o'qituvchilar soniga qarab shishmaydi.
 *
 * ⚠️ Bu XODIM DAVOMATI emas. `User.workStartTime` / `workDays` davomat uchun,
 * bu esa dars jadvali uchun. Ikkalasini bog'lash mumkin, lekin faqat QO'LDA —
 * `fillFromWorkSchedule()` tugmasi orqali. Avtomatik bog'lansa, ish vaqtini
 * o'zgartirish jimgina jadvalni buzardi.
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { DAYS_UZ } = require("../utils/constants");
const { getGrid } = require("./plannerSettings.service");
const { loadTeachers } = require("./plannerLoad.service");
const { SCHEDULE_DAYS, busyKey } = require("../helpers/planner.helpers");

// ScheduleDay → hafta kuni raqami (DAYS_UZ indeksi: 0 = yakshanba).
const DAY_NUMBER = Object.fromEntries(
  SCHEDULE_DAYS.map((day) => [day, DAYS_UZ.indexOf(day)]),
);

function assertSlot(day, order, orders) {
  if (!SCHEDULE_DAYS.includes(day)) {
    throw new BadRequestError(`Noma'lum kun: ${day}`);
  }
  const num = Number(order);
  if (!Number.isInteger(num)) {
    throw new BadRequestError("Dars tartibi butun son bo'lishi kerak");
  }
  if (orders && !orders.includes(num)) {
    throw new BadRequestError(
      `${num}-dars sozlamada yo'q — avval "Dars soatlari" ro'yxatiga qo'shing`,
    );
  }
  return num;
}

async function assertTeacher(teacherId) {
  const teacher = await prisma.user.findUnique({
    where: { id: teacherId },
    select: { id: true, role: true, isArchived: true, fullName: true },
  });
  if (!teacher) throw new NotFoundError("Xodim topilmadi");
  if (teacher.role === "student") {
    throw new BadRequestError("O'quvchiga dars bandligi belgilanmaydi");
  }
  return teacher;
}

/**
 * "Bandlik" tabining butun ma'lumoti.
 *
 * `slotSummary` — "qaysi soatda kim bo'sh" degan savolning tayyor javobi:
 * har bir katak uchun bo'sh/band sanoqchisi. Uni frontendda hisoblash mumkin
 * edi, lekin o'sha formula shakllantirishda ham kerak — bitta joyda tursin.
 */
async function getAvailability() {
  const [grid, teachers, slots] = await Promise.all([
    getGrid(),
    loadTeachers(),
    prisma.plannerBusySlot.findMany(),
  ]);

  const byTeacher = new Map();
  for (const slot of slots) {
    if (!byTeacher.has(slot.teacherId)) byTeacher.set(slot.teacherId, []);
    byTeacher.get(slot.teacherId).push({
      day: slot.day,
      order: slot.order,
      note: slot.note,
    });
  }

  const rows = teachers.map((teacher) => ({
    id: teacher.id,
    fullName: teacher.fullName,
    subjects: teacher.subjects.map((s) => s.subject),
    busy: byTeacher.get(teacher.id) ?? [],
  }));

  const busySet = new Set(
    slots.map((s) => busyKey(s.teacherId, s.day, s.order)),
  );

  const slotSummary = [];
  for (const day of grid.days) {
    for (const order of grid.orders) {
      let busy = 0;
      for (const teacher of rows) {
        if (busySet.has(busyKey(teacher.id, day, order))) busy += 1;
      }
      slotSummary.push({ day, order, busy, free: rows.length - busy });
    }
  }

  return {
    days: grid.days,
    periods: grid.periods,
    teachers: rows,
    slotSummary,
    totalTeachers: rows.length,
  };
}

/**
 * O'qituvchining band kataklarini TO'LIQ almashtiradi.
 * @param {string} teacherId
 * @param {Array} slots - [{ day, order, note? }]
 */
async function setAvailability(teacherId, slots) {
  await assertTeacher(teacherId);
  const { orders } = await getGrid();

  if (!Array.isArray(slots)) {
    throw new BadRequestError("Kataklar massiv bo'lishi kerak");
  }

  const seen = new Set();
  const rows = [];
  for (const slot of slots) {
    const order = assertSlot(slot?.day, slot?.order, orders);
    const key = `${slot.day}|${order}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      teacherId,
      day: slot.day,
      order,
      note: slot.note ? String(slot.note).slice(0, 200) : null,
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.plannerBusySlot.deleteMany({ where: { teacherId } });
    if (rows.length) {
      await tx.plannerBusySlot.createMany({ data: rows, skipDuplicates: true });
    }
  });

  return getAvailability();
}

/**
 * Bitta katakni almashtiradi (matritsadan bosilganda).
 * Butun ro'yxatni qayta yubormaslik uchun — matritsada 40+ o'qituvchi bo'lishi
 * mumkin va har bosishda hammasini jo'natish behuda bo'lardi.
 */
async function toggleSlot(teacherId, day, orderRaw) {
  await assertTeacher(teacherId);
  const { orders } = await getGrid();
  const order = assertSlot(day, orderRaw, orders);

  const existing = await prisma.plannerBusySlot.findUnique({
    where: { teacherId_day_order: { teacherId, day, order } },
  });

  if (existing) {
    await prisma.plannerBusySlot.delete({
      where: { teacherId_day_order: { teacherId, day, order } },
    });
    return { teacherId, day, order, busy: false };
  }

  await prisma.plannerBusySlot.create({ data: { teacherId, day, order } });
  return { teacherId, day, order, busy: true };
}

/**
 * Xodimning ISH JADVALIDAN band kataklarni to'ldiradi.
 *
 * Qoida ikkita, ikkalasi ham "dars qo'yib bo'lmaydi" degani:
 *   1. Kun xodimning ish kunlari ro'yxatida yo'q → butun kun band.
 *   2. Dars vaqti ish vaqtidan tashqarida → o'sha katak band.
 *
 * Bu QO'LDA bosiladigan amal va MAVJUD belgilashlarni almashtiradi: aks holda
 * "avval qo'lda qo'ygan edim, tugma bosgach yo'qolmadi-ku" degan noaniqlik
 * qolardi. Natijani keyin qo'lda tuzatish mumkin.
 */
async function fillFromWorkSchedule(teacherId) {
  const teacher = await prisma.user.findUnique({
    where: { id: teacherId },
    select: {
      id: true,
      role: true,
      workDays: true,
      workStartTime: true,
      workEndTime: true,
      weeklySchedule: true,
    },
  });
  if (!teacher) throw new NotFoundError("Xodim topilmadi");
  if (teacher.role === "student") {
    throw new BadRequestError("O'quvchiga dars bandligi belgilanmaydi");
  }

  const workDays = Array.isArray(teacher.workDays) ? teacher.workDays : [];
  const hasHours = Boolean(teacher.workStartTime && teacher.workEndTime);
  if (!workDays.length && !hasHours) {
    throw new BadRequestError(
      "Xodimda ish jadvali belgilanmagan — avval xodim sahifasidagi \"Ish jadvali\" kartasini to'ldiring",
    );
  }

  const { days, periods } = await getGrid();
  const weekly = teacher.weeklySchedule || {};
  const rows = [];

  for (const day of days) {
    const dayNumber = DAY_NUMBER[day];

    if (workDays.length && !workDays.includes(dayNumber)) {
      for (const period of periods) {
        rows.push({ teacherId, day, order: period.order, note: "Ish kuni emas" });
      }
      continue;
    }

    if (!hasHours) continue;

    const override = weekly[String(dayNumber)] || {};
    const start = override.startTime || teacher.workStartTime;
    const end = override.endTime || teacher.workEndTime;

    for (const period of periods) {
      // Vaqti kiritilmagan dars — tekshirib bo'lmaydi, tegilmaydi.
      if (!period.startTime || !period.endTime) continue;
      // "HH:mm" satrlari leksikografik taqqoslanadi — format qat'iy bo'lgani
      // uchun bu sana obyektisiz ham to'g'ri ishlaydi.
      if (period.startTime < start || period.endTime > end) {
        rows.push({
          teacherId,
          day,
          order: period.order,
          note: "Ish vaqtidan tashqari",
        });
      }
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.plannerBusySlot.deleteMany({ where: { teacherId } });
    if (rows.length) {
      await tx.plannerBusySlot.createMany({ data: rows, skipDuplicates: true });
    }
  });

  return { filled: rows.length, availability: await getAvailability() };
}

/**
 * Generator uchun band kataklar to'plami.
 * @returns {Promise<Set<string>>} "teacherId|day|order"
 */
async function getBusySet() {
  const slots = await prisma.plannerBusySlot.findMany({
    select: { teacherId: true, day: true, order: true },
  });
  return new Set(slots.map((s) => busyKey(s.teacherId, s.day, s.order)));
}

module.exports = {
  getAvailability,
  setAvailability,
  toggleSlot,
  fillFromWorkSchedule,
  getBusySet,
};
