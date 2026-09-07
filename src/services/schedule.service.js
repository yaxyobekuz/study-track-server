const crypto = require("crypto");
const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { getCurrentDayUz, isSunday } = require("../helpers/date.helpers");
const { DAYS, ROLES } = require("../utils/constants");
const { hasRole } = require("../utils/permissions");

// Jadval kunlari — YAGONA manba (`ScheduleDay` enumi bilan bir xil tartib).
const VALID_DAYS = Object.values(DAYS);

/**
 * Kun nomini yorliq ko'rinishiga keltiradi: "dushanba" → "Dushanba".
 * @param {string} day
 * @returns {string}
 */
function dayLabel(day) {
  if (!day) return "";
  return day.charAt(0).toUpperCase() + day.slice(1);
}

/**
 * ScheduleLesson child yozuvlarini eski `subjects[]` embedded shakliga xaritalaydi.
 * Berilgan subject/teacher xaritalaridan `subject` ({_id,name}) va
 * `teacher` ({_id,firstName,lastName}) objektlarini to'ldiradi.
 * @param {Array} lessons - ScheduleLesson yozuvlari
 * @param {Map} subjectMap - subjectId -> { _id, name }
 * @param {Map} teacherMap - teacherId -> { _id, firstName, lastName }
 * @returns {Array} eski shakldagi subjects massivi
 */
function mapLessons(lessons, subjectMap, teacherMap) {
  return (lessons || []).map((lesson) => ({
    id: lesson.id,
    subject: subjectMap.get(lesson.subjectId) || null,
    teacher: teacherMap.get(lesson.teacherId) || null,
    order: lesson.order,
    startTime: lesson.startTime,
    endTime: lesson.endTime,
  }));
}

/**
 * Berilgan schedule yozuvlaridagi barcha subject va teacher'larni bitta
 * so'rovdan yuklab, xaritalarni qaytaradi (soft ref — relation YO'Q).
 * @param {Array} schedules - lessons bilan yuklangan schedule'lar
 * @returns {Promise<{subjectMap: Map, teacherMap: Map}>}
 */
async function loadLessonRefs(schedules) {
  const subjectIds = new Set();
  const teacherIds = new Set();
  for (const schedule of schedules) {
    for (const lesson of schedule.lessons || []) {
      if (lesson.subjectId) subjectIds.add(lesson.subjectId);
      if (lesson.teacherId) teacherIds.add(lesson.teacherId);
    }
  }

  const [subjects, teachers] = await Promise.all([
    prisma.subject.findMany({
      where: { id: { in: [...subjectIds] } },
      select: { id: true, name: true },
    }),
    prisma.user.findMany({
      where: { id: { in: [...teacherIds] } },
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);

  const subjectMap = new Map(
    subjects.map((s) => [s.id, { id: s.id, name: s.name }]),
  );
  const teacherMap = new Map(
    teachers.map((t) => [
      t.id,
      { id: t.id, firstName: t.firstName, lastName: t.lastName },
    ]),
  );

  return { subjectMap, teacherMap };
}

/**
 * Bitta schedule'ni eski shaklga (id + subjects[]) aylantiradi.
 * @param {object} schedule - lessons bilan yuklangan schedule
 * @param {Map} subjectMap
 * @param {Map} teacherMap
 * @returns {object}
 */
function formatSchedule(schedule, subjectMap, teacherMap) {
  return {
    id: schedule.id,
    class: schedule.classId,
    day: schedule.day,
    subjects: mapLessons(schedule.lessons, subjectMap, teacherMap),
    createdBy: schedule.createdBy,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  };
}

/**
 * Bir kunlik darslardan ScheduleLesson create'lar uchun ma'lumot tuzadi.
 * @param {Array} subjects - kiritilgan darslar (subject, teacher, order, ...)
 * @returns {Array} createMany uchun data (position bilan)
 */
function buildLessonRows(scheduleId, subjects) {
  return subjects.map((item, index) => ({
    scheduleId,
    subjectId: item.subject,
    teacherId: item.teacher,
    order: Number(item.order),
    startTime: item.startTime || null,
    endTime: item.endTime || null,
    position: index,
  }));
}

/**
 * Sinf uchun barcha dars jadvallarini olish.
 * @param {string} classId - sinf ID
 * @returns {Promise<Array>} jadvallar ro'yxati
 */
async function getScheduleByClass(classId) {
  const classExists = await prisma.class.findUnique({ where: { id: classId } });
  if (!classExists) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const schedules = await prisma.schedule.findMany({
    where: { classId },
    include: { lessons: true },
    orderBy: { day: "asc" },
  });

  const { subjectMap, teacherMap } = await loadLessonRefs(schedules);

  // Sort lessons by their order number (manual order, e.g. 1, 3, 4)
  return schedules.map((schedule) => {
    const formatted = formatSchedule(schedule, subjectMap, teacherMap);
    formatted.subjects = [...formatted.subjects].sort(
      (a, b) => (a.order || 0) - (b.order || 0),
    );
    return formatted;
  });
}

/**
 * Sinf va kun uchun dars jadvalini olish.
 * @param {string} classId - sinf ID
 * @param {string} day - kun nomi
 * @returns {Promise<object>} jadval
 */
async function getScheduleByDay(classId, day) {
  const schedule = await prisma.schedule.findFirst({
    where: { classId, day },
    include: { lessons: true },
  });

  if (!schedule) {
    throw new NotFoundError("Bu kun uchun dars jadvali topilmadi");
  }

  const { subjectMap, teacherMap } = await loadLessonRefs([schedule]);
  return formatSchedule(schedule, subjectMap, teacherMap);
}

/**
 * Saqlangan jadvalning IMZOSI (qoralama uchun tayanch nuqta).
 *
 * Qoralama "shu holat ustiga" qurilgan bo'ladi. Qoralama turgan payt boshqa
 * xodim jadvalni o'zgartirsa, imzo mos kelmaydi va tiklashda ogohlantirish
 * beriladi — aks holda eski nusxa yangi jadvalni jimgina bosib ketardi.
 *
 * Imzo TARTIBGA BOG'LIQ EMAS: kunlar va darslar saralanadi, shuning uchun
 * bir xil jadval har doim bir xil imzo beradi.
 *
 * @param {Array} formatted - `getScheduleByClass` natijasi
 * @returns {string} 64 belgili hex
 */
function hashSchedules(formatted = []) {
  const canonical = [...formatted]
    .filter((s) => (s.subjects || []).length > 0)
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))
    .map((s) => {
      const lessons = [...(s.subjects || [])]
        .map((l) =>
          [
            Number(l.order) || 0,
            l.subject?.id || "",
            l.teacher?.id || "",
            l.startTime || "",
            l.endTime || "",
          ].join(":"),
        )
        .sort();
      return `${s.day}|${lessons.join(",")}`;
    })
    .join(";");

  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Bir kunlik darslarni MA'LUMOTLAR BAZASISIZ tekshirish: tartib raqamlari
 * va vaqtlar. Bazaga tegadigan tekshiruvlar (fan/o'qituvchi, bandlik)
 * ataylab alohida — ular butun hafta uchun bir marta ishlaydi.
 *
 * @param {Array} subjects - bir kun uchun darslar
 * @param {string} day - kun nomi (xato matnida ko'rsatiladi)
 */
function validateDayShape(subjects, day) {
  const prefix = day ? `${dayLabel(day)}, ` : "";

  // Tartib raqamlari: 1..100, kun ichida takrorlanmaydi
  const seenOrders = new Set();
  for (const item of subjects) {
    const order = Number(item.order);
    if (!Number.isInteger(order) || order < 1 || order > 100) {
      throw new BadRequestError(
        `${prefix}dars tartibi 1 dan 100 gacha bo'lgan butun son bo'lishi kerak`,
      );
    }
    if (seenOrders.has(order)) {
      throw new BadRequestError(
        `${prefix}${order}-tartib bir necha marta ishlatilgan. Har bir dars tartibi takrorlanmasligi kerak`,
      );
    }
    seenOrders.add(order);
  }

  // Vaqtlar
  for (const item of subjects) {
    if (!item.startTime && !item.endTime) continue;

    if (!item.startTime || !item.endTime) {
      throw new BadRequestError(
        `${prefix}${item.order}-dars: boshlanish va tugash vaqti ikkalasi ham kiritilishi kerak`,
      );
    }

    const timeRegex = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(item.startTime) || !timeRegex.test(item.endTime)) {
      throw new BadRequestError(
        `${prefix}${item.order}-dars: vaqt formati noto'g'ri (HH:mm formatida bo'lishi kerak)`,
      );
    }

    if (item.startTime >= item.endTime) {
      throw new BadRequestError(
        `${prefix}${item.order}-dars: boshlanish vaqti tugash vaqtidan oldin bo'lishi kerak`,
      );
    }
  }

  // Vaqtlar to'qnashuvi (bir kun ichida)
  const withTimes = subjects.filter((s) => s.startTime && s.endTime);
  const sorted = [...withTimes].sort((a, b) =>
    a.startTime.localeCompare(b.startTime),
  );
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].endTime > sorted[i + 1].startTime) {
      throw new BadRequestError(
        `${prefix}darslar vaqtlari to'qnashib ketdi: ${sorted[i].order}-dars (${sorted[i].startTime}-${sorted[i].endTime}) va ${sorted[i + 1].order}-dars (${sorted[i + 1].startTime}-${sorted[i + 1].endTime})`,
      );
    }
  }
}

/**
 * Fan va o'qituvchi havolalarini tekshirish — BUTUN HAFTA uchun BITTA marta.
 *
 * Uch narsa tekshiriladi:
 *   1. Fan bazada bormi;
 *   2. O'qituvchi bormi va u haqiqatan O'QITUVCHIMI;
 *   3. ⚠️ O'qituvchi SHU FANDAN dars beradimi (`user_subjects`).
 *
 * (3) — "matematika o'qituvchisiga ingliz tilidan dars qo'yib qo'yish" ni
 * to'xtatadi. Bu tekshiruv SERVERDA turishi shart: interfeys ro'yxatni
 * filtrlaydi, lekin so'rov to'g'ridan-to'g'ri ham kelishi mumkin.
 *
 * ⚠️ O'qituvchida fan UMUMAN biriktirilmagan bo'lsa, tekshiruv o'tkazib
 * yuboriladi: bu "noto'g'ri fan" emas, "ma'lumot to'liq emas" holati va
 * uni bloklash butun jadvalni saqlashni to'xtatib qo'yardi.
 *
 * ⚠️ Rol `hasRole` orqali tekshiriladi: bir odam bir vaqtda o'qituvchi ham,
 * ma'muriyat ham bo'lishi mumkin (`User.extraRoles`) va to'g'ridan-to'g'ri
 * `role === "teacher"` taqqoslash uni ko'rmasdi.
 *
 * @param {Array} entries - [{ day, subjects }] (darslari bor kunlar)
 */
async function validateLessonRefs(entries) {
  const subjectIds = new Set();
  const teacherIds = new Set();

  for (const entry of entries) {
    for (const item of entry.subjects) {
      if (!item.subject) {
        throw new BadRequestError(
          `${dayLabel(entry.day)}, ${item.order}-dars: fan tanlanmagan`,
        );
      }
      if (!item.teacher) {
        throw new BadRequestError(
          `${dayLabel(entry.day)}, ${item.order}-dars: o'qituvchi tanlanmagan`,
        );
      }
      subjectIds.add(String(item.subject));
      teacherIds.add(String(item.teacher));
    }
  }

  if (subjectIds.size === 0) return;

  const [subjects, teachers, links] = await Promise.all([
    prisma.subject.findMany({
      where: { id: { in: [...subjectIds] } },
      select: { id: true, name: true },
    }),
    prisma.user.findMany({
      where: { id: { in: [...teacherIds] } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        role: true,
        extraRoles: true,
      },
    }),
    prisma.userSubject.findMany({
      where: { userId: { in: [...teacherIds] } },
      select: { userId: true, subjectId: true },
    }),
  ]);

  const subjectMap = new Map(subjects.map((s) => [s.id, s]));
  const teacherMap = new Map(teachers.map((t) => [t.id, t]));

  // teacherId -> Set(subjectId). Bo'sh to'plam = fan biriktirilmagan.
  const assigned = new Map();
  for (const link of links) {
    if (!assigned.has(link.userId)) assigned.set(link.userId, new Set());
    assigned.get(link.userId).add(link.subjectId);
  }

  for (const entry of entries) {
    for (const item of entry.subjects) {
      const prefix = `${dayLabel(entry.day)}, ${item.order}-dars`;

      const subject = subjectMap.get(String(item.subject));
      if (!subject) {
        throw new NotFoundError(`${prefix}: fan topilmadi`);
      }

      const teacher = teacherMap.get(String(item.teacher));
      if (!teacher) {
        throw new NotFoundError(`${prefix}: o'qituvchi topilmadi`);
      }
      if (!hasRole(teacher, ROLES.TEACHER)) {
        throw new BadRequestError(
          `${prefix}: ${teacherName(teacher)} o'qituvchi emas`,
        );
      }

      const teacherSubjects = assigned.get(teacher.id);
      if (teacherSubjects?.size && !teacherSubjects.has(subject.id)) {
        throw new BadRequestError(
          `${prefix}: ${teacherName(teacher)} "${subject.name}" fanidan dars bermaydi. Fan biriktirilishi "Xodimlar" bo'limida o'zgartiriladi`,
        );
      }
    }
  }
}

/**
 * O'qituvchining ismi — xato matnlari uchun.
 * @param {{firstName?: string, lastName?: string}} teacher
 * @returns {string}
 */
function teacherName(teacher) {
  if (!teacher) return "O'qituvchi";
  return `${teacher.firstName || ""} ${teacher.lastName || ""}`.trim();
}

/**
 * O'qituvchining parallel bandligi — BUTUN HAFTA uchun BITTA so'rov.
 *
 * Bir o'qituvchi bir kunda bir xil tartib (order) raqamida ikkita sinfda
 * tura olmaydi. Joriy sinfning o'zi tekshirilmaydi: u qayta yoziladi.
 *
 * ⚠️ Birinchi to'qnashuvda TO'XTAMAYDI — HAMMASI yig'ib qaytariladi.
 * Aks holda foydalanuvchi bittasini tuzatib, qayta saqlab, keyingisini
 * ko'rar edi va bu bir necha marta takrorlanardi.
 *
 * @param {string} classId - joriy sinf
 * @param {Array} entries - [{ day, subjects }] (darslari bor kunlar)
 * @returns {Promise<Array>} [{ day, dayLabel, order, classId, className, teacherId, teacherName }]
 */
async function collectTeacherConflicts(classId, entries) {
  const days = entries.map((e) => e.day);
  if (days.length === 0) return [];

  const otherSchedules = await prisma.schedule.findMany({
    where: { day: { in: days }, classId: { not: classId } },
    include: { lessons: { select: { teacherId: true, order: true } } },
  });

  // Map: "day|teacherId|order" -> classId
  const occupied = new Map();
  for (const schedule of otherSchedules) {
    for (const lesson of schedule.lessons || []) {
      occupied.set(
        `${schedule.day}|${lesson.teacherId}|${lesson.order}`,
        schedule.classId,
      );
    }
  }
  if (occupied.size === 0) return [];

  const conflicts = [];
  for (const entry of entries) {
    for (const item of entry.subjects) {
      const teacherId = String(item.teacher);
      const order = Number(item.order);
      const busyClassId = occupied.get(`${entry.day}|${teacherId}|${order}`);
      if (busyClassId) {
        conflicts.push({ day: entry.day, order, teacherId, classId: busyClassId });
      }
    }
  }
  if (conflicts.length === 0) return [];

  // Nomlar faqat HAQIQIY to'qnashuvlar uchun yuklanadi
  const [classes, teachers] = await Promise.all([
    prisma.class.findMany({
      where: { id: { in: [...new Set(conflicts.map((c) => c.classId))] } },
      select: { id: true, name: true },
    }),
    prisma.user.findMany({
      where: { id: { in: [...new Set(conflicts.map((c) => c.teacherId))] } },
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);

  const classNameMap = new Map(classes.map((c) => [c.id, c.name]));
  const teacherNameMap = new Map(teachers.map((t) => [t.id, teacherName(t)]));

  return conflicts.map((c) => ({
    ...c,
    dayLabel: dayLabel(c.day),
    className: classNameMap.get(c.classId) || "",
    teacherName: teacherNameMap.get(c.teacherId) || "",
  }));
}

/**
 * Butun haftani tekshiradi: kunlar, tartib raqamlari, vaqtlar, fan/o'qituvchi
 * havolalari va parallel bandlik.
 *
 * Hech narsa YOZILMASDAN OLDIN chaqiriladi — bitta yaroqsiz kun yarim
 * saqlangan jadval qoldirmasligi kerak.
 *
 * @param {string} classId
 * @param {Array} schedules - [{ day, subjects }]
 * @returns {Promise<Array>} darslari bor kunlar
 */
async function validateWeek(classId, schedules) {
  const seenDays = new Set();
  const filled = [];

  for (const entry of schedules) {
    const { day, subjects = [] } = entry;

    if (!VALID_DAYS.includes(day)) {
      throw new BadRequestError(`Noto'g'ri kun: ${day}`);
    }
    if (seenDays.has(day)) {
      throw new BadRequestError(`${dayLabel(day)} kuni bir necha marta yuborildi`);
    }
    seenDays.add(day);

    validateDayShape(subjects, day);
    if (subjects.length > 0) filled.push({ day, subjects });
  }

  await validateLessonRefs(filled);

  const conflicts = await collectTeacherConflicts(classId, filled);
  if (conflicts.length > 0) {
    const shown = conflicts
      .slice(0, 5)
      .map(
        (c) =>
          `${c.dayLabel}, ${c.order}-dars — ${c.teacherName} "${c.className}" sinfida band`,
      )
      .join("; ");
    const rest =
      conflicts.length > 5 ? ` va yana ${conflicts.length - 5} ta` : "";

    throw new BadRequestError(
      `Parallel dars belgilab bo'lmaydi: ${shown}${rest}`,
      { conflicts },
    );
  }

  return filled;
}

/**
 * Dars jadvalini yaratish yoki yangilash.
 * @param {object} data - { classId, day, subjects }
 * @param {string} createdBy - yaratuvchi foydalanuvchi ID
 * @returns {Promise<object>} saqlangan jadval
 */
async function createOrUpdateSchedule(data, createdBy) {
  const { classId, day, subjects } = data;

  if (!classId || !day || !subjects || subjects.length === 0) {
    throw new BadRequestError("All required fields must be filled");
  }

  const classExists = await prisma.class.findUnique({ where: { id: classId } });
  if (!classExists) {
    throw new NotFoundError("Sinf topilmadi");
  }

  // Tekshiruv bitta joyda — haftalik saqlash bilan AYNAN bir xil qoidalar.
  // Ikkita mustaqil tekshirgich bo'lsa, yangi qoida faqat bittasiga
  // qo'shilib qolardi.
  await validateWeek(classId, [{ day, subjects }]);

  const existing = await prisma.schedule.findFirst({
    where: { classId, day },
  });

  let scheduleId;
  if (existing) {
    scheduleId = existing.id;
    // Eski darslarni tozalab, yangilarini qayta yozamiz (position bilan)
    await prisma.scheduleLesson.deleteMany({ where: { scheduleId } });
    await prisma.scheduleLesson.createMany({
      data: buildLessonRows(scheduleId, subjects),
    });
  } else {
    const schedule = await prisma.schedule.create({
      data: { classId, day, createdBy },
    });
    scheduleId = schedule.id;
    await prisma.scheduleLesson.createMany({
      data: buildLessonRows(scheduleId, subjects),
    });
  }

  const saved = await prisma.schedule.findUnique({
    where: { id: scheduleId },
    include: { lessons: true },
  });
  const { subjectMap, teacherMap } = await loadLessonRefs([saved]);
  return formatSchedule(saved, subjectMap, teacherMap);
}

/**
 * Sinf uchun butun hafta dars jadvalini bir martada saqlash.
 * Har bir kun uchun darslar bo'lsa - yaratiladi/yangilanadi,
 * darslar bo'sh bo'lsa - o'sha kun jadvali o'chiriladi.
 * Barcha kunlar avval tekshiriladi, keyin yoziladi (qisman saqlanish bo'lmaydi).
 * @param {string} classId - sinf ID
 * @param {Array} schedules - [{ day, subjects }]
 * @param {string} createdBy - yaratuvchi foydalanuvchi ID
 * @returns {Promise<Array>} sinfning yangilangan jadvallari
 */
async function saveClassSchedule(classId, schedules, createdBy) {
  if (!classId || !Array.isArray(schedules)) {
    throw new BadRequestError("Sinf va dars jadvali majburiy");
  }

  const classExists = await prisma.class.findUnique({ where: { id: classId } });
  if (!classExists) {
    throw new NotFoundError("Sinf topilmadi");
  }

  // HAMMASI avval tekshiriladi: bitta yaroqsiz kun yarim saqlangan
  // jadval qoldirmasligi kerak.
  await validateWeek(classId, schedules);

  // Yozish BITTA tranzaksiyada: aks holda uzilish (tarmoq, xato) haftaning
  // yarmini yangi, yarmini eski holatda qoldirardi va bunday jadval hech
  // kimda bo'lmagan variant bo'lib chiqardi.
  await prisma.$transaction(async (tx) => {
    for (const entry of schedules) {
      const { day, subjects = [] } = entry;

      // Bo'sh kun — o'sha kun jadvali butunlay olib tashlanadi
      if (subjects.length === 0) {
        await tx.schedule.deleteMany({ where: { classId, day } });
        continue;
      }

      const schedule = await tx.schedule.findFirst({ where: { classId, day } });
      if (schedule) {
        await tx.scheduleLesson.deleteMany({
          where: { scheduleId: schedule.id },
        });
        await tx.scheduleLesson.createMany({
          data: buildLessonRows(schedule.id, subjects),
        });
      } else {
        const created = await tx.schedule.create({
          data: { classId, day, createdBy },
        });
        await tx.scheduleLesson.createMany({
          data: buildLessonRows(created.id, subjects),
        });
      }
    }

    // Ish tugadi — shu odamning qoralamasi endi keraksiz. Qoldirilsa,
    // keyingi kirishda "tugallanmagan tahrir bor" deb allaqachon
    // saqlangan holatni qayta taklif qilardi.
    if (createdBy) {
      await tx.scheduleDraft.deleteMany({ where: { classId, userId: createdBy } });
    }
  });

  return getScheduleByClass(classId);
}

/**
 * Dars jadvalini o'chirish.
 * @param {string} id - jadval ID
 * @returns {Promise<void>}
 */
async function deleteSchedule(id) {
  const schedule = await prisma.schedule.findUnique({ where: { id } });
  if (!schedule) {
    throw new NotFoundError("Dars jadvali topilmadi");
  }

  await prisma.schedule.delete({ where: { id } });
}

/**
 * Sinf uchun Excel eksport ma'lumotlarini tayyorlash.
 * @param {string} classId - sinf ID
 * @returns {Promise<{classDoc: object, data: Array}>}
 */
async function getScheduleForExport(classId) {
  const classDoc = await prisma.class.findUnique({ where: { id: classId } });
  if (!classDoc) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const schedules = await prisma.schedule.findMany({
    where: { classId },
    include: { lessons: true },
    orderBy: { day: "asc" },
  });

  const { subjectMap, teacherMap } = await loadLessonRefs(schedules);

  const dayOrder = [
    "dushanba",
    "seshanba",
    "chorshanba",
    "payshanba",
    "juma",
    "shanba",
    "yakshanba",
  ];

  const dayRank = new Map(dayOrder.map((day, index) => [day, index]));

  const formattedSchedules = schedules.map((schedule) =>
    formatSchedule(schedule, subjectMap, teacherMap),
  );

  const sortedSchedules = [...formattedSchedules].sort((a, b) => {
    const rankA = dayRank.has(a.day) ? dayRank.get(a.day) : 999;
    const rankB = dayRank.has(b.day) ? dayRank.get(b.day) : 999;
    return rankA - rankB;
  });

  const data = [];

  sortedSchedules.forEach((schedule) => {
    const subjects = [...(schedule.subjects || [])].sort(
      (a, b) => (a.order || 0) - (b.order || 0),
    );

    if (subjects.length === 0) {
      data.push({
        day: schedule.day,
        order: "-",
        subject: "-",
        teacher: "-",
        time: "-",
      });
      return;
    }

    subjects.forEach((subj, index) => {
      const displayOrder = subj.order || index + 1;
      const teacherName = subj.teacher
        ? `${subj.teacher.firstName} ${subj.teacher.lastName || ""}`.trim()
        : "-";
      const time =
        subj.startTime && subj.endTime
          ? `${subj.startTime} - ${subj.endTime}`
          : "-";

      data.push({
        day: schedule.day,
        order: displayOrder,
        subject: subj.subject?.name || "-",
        teacher: teacherName,
        time,
      });
    });
  });

  return { classDoc, data };
}

/**
 * Dars mavjud (kamida bitta fan) sinf+kun juftliklari to'plamini qaytaradi.
 * Kalit formati: "<classId>|<dayName>" (masalan "65f...|dushanba").
 * Davomat cron va hisobotlarida "bu sinfda shu kuni dars bormi?" tekshiruvi uchun.
 * @returns {Promise<Set<string>>}
 */
async function getLessonDayMap() {
  const schedules = await prisma.schedule.findMany({
    where: { lessons: { some: {} } },
    select: { classId: true, day: true },
  });

  return new Set(schedules.map((s) => `${s.classId}|${s.day}`));
}

/**
 * Bugungi barcha jadvallarni olish.
 * @returns {Promise<Array>} formatlangan jadvallar
 */
async function getAllTodaySchedules() {
  const dayName = getCurrentDayUz();

  if (isSunday()) {
    return [];
  }

  const schedules = await prisma.schedule.findMany({
    where: { day: dayName },
    include: { lessons: true },
  });

  const { subjectMap, teacherMap } = await loadLessonRefs(schedules);

  // Sinf nomlarini yuklab, sinf nomi bo'yicha tartiblaymiz
  const classIds = [
    ...new Set(schedules.map((s) => s.classId).filter(Boolean)),
  ];
  const classes = await prisma.class.findMany({
    where: { id: { in: classIds } },
    select: { id: true, name: true },
  });
  const classMap = new Map(
    classes.map((c) => [c.id, { id: c.id, name: c.name }]),
  );

  const result = schedules.map((schedule) => ({
    class: classMap.get(schedule.classId) || null,
    subjects: mapLessons(schedule.lessons, subjectMap, teacherMap).sort(
      (a, b) => a.order - b.order,
    ),
  }));

  return result.sort((a, b) =>
    (a.class?.name || "").localeCompare(b.class?.name || ""),
  );
}

/**
 * O'qituvchining bugungi dars jadvalini olish.
 * @param {string} teacherId - o'qituvchi ID
 * @returns {Promise<Array>} o'qituvchining bugungi darslari
 */
async function getMyTodaySchedule(teacherId) {
  const dayName = getCurrentDayUz();

  if (isSunday()) {
    return [];
  }

  const schedules = await prisma.schedule.findMany({
    where: {
      day: dayName,
      lessons: { some: { teacherId: teacherId.toString() } },
    },
    include: { lessons: true },
  });

  const { subjectMap, teacherMap } = await loadLessonRefs(schedules);

  const classIds = [
    ...new Set(schedules.map((s) => s.classId).filter(Boolean)),
  ];
  const classes = await prisma.class.findMany({
    where: { id: { in: classIds } },
    select: { id: true, name: true },
  });
  const classMap = new Map(
    classes.map((c) => [c.id, { id: c.id, name: c.name }]),
  );

  return schedules
    .map((schedule) => {
      const teacherSubjects = mapLessons(
        schedule.lessons,
        subjectMap,
        teacherMap,
      )
        .filter(
          (item) =>
            item.teacher &&
            item.teacher.id.toString() === teacherId.toString(),
        )
        .sort((a, b) => a.order - b.order);

      return {
        class: classMap.get(schedule.classId) || null,
        subjects: teacherSubjects,
      };
    })
    .filter((schedule) => schedule.subjects.length > 0);
}

/**
 * Fan bo'yicha sinflarni va joriy mavzu raqamini olish.
 * @param {string} subjectId - fan ID
 * @returns {Promise<{classes: Array, subject: object}>}
 */
async function getClassesBySubject(subjectId) {
  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) {
    throw new NotFoundError("Fan topilmadi");
  }

  const schedules = await prisma.schedule.findMany({
    where: { lessons: { some: { subjectId } } },
    include: { lessons: true },
  });

  const classIds = [
    ...new Set(schedules.map((s) => s.classId).filter(Boolean)),
  ];

  const [classes, progressList] = await Promise.all([
    prisma.class.findMany({
      where: { id: { in: classIds } },
      select: { id: true, name: true },
    }),
    prisma.classSubjectProgress.findMany({
      where: { subjectId, classId: { in: classIds } },
    }),
  ]);

  const classInfoMap = new Map(
    classes.map((c) => [c.id, { id: c.id, name: c.name }]),
  );

  const progressMap = new Map();
  for (const p of progressList) {
    progressMap.set(p.classId, p.currentTopicNumber);
  }

  const classMap = new Map();
  for (const schedule of schedules) {
    const classId = schedule.classId;

    if (!classMap.has(classId)) {
      classMap.set(classId, {
        class: classInfoMap.get(classId) || null,
        subjectId: subjectId,
        currentTopicNumber: progressMap.get(classId) || 1,
      });
    }
  }

  const classesResult = Array.from(classMap.values()).sort((a, b) =>
    (a.class?.name || "").localeCompare(b.class?.name || ""),
  );

  return {
    classes: classesResult,
    subject: { id: subject.id, name: subject.name },
  };
}

/**
 * Sinf+fan uchun joriy mavzu raqamini yangilash.
 * @param {string} classId - sinf ID
 * @param {string} subjectId - fan ID
 * @param {number} topicNumber - mavzu raqami
 * @returns {Promise<object>} yangilangan ma'lumot
 */
async function updateCurrentTopic(classId, subjectId, topicNumber) {
  if (!topicNumber || topicNumber < 1) {
    throw new BadRequestError("Mavzu raqami kamida 1 bo'lishi kerak");
  }

  const classDoc = await prisma.class.findUnique({ where: { id: classId } });
  if (!classDoc) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) {
    throw new NotFoundError("Fan topilmadi");
  }

  const topic = await prisma.topic.findFirst({
    where: { subjectId, order: topicNumber },
  });

  if (!topic) {
    throw new NotFoundError(`${topicNumber}-mavzu ushbu fan uchun topilmadi`);
  }

  const progress = await prisma.classSubjectProgress.upsert({
    where: { classId_subjectId: { classId, subjectId } },
    update: { currentTopicNumber: topicNumber },
    create: { classId, subjectId, currentTopicNumber: topicNumber },
  });

  return {
    class: { id: classDoc.id, name: classDoc.name },
    subject: { id: subject.id, name: subject.name },
    currentTopicNumber: progress.currentTopicNumber,
  };
}

/**
 * DARS BIRIKTIRISH UCHUN O'QITUVCHILAR MA'LUMOTNOMASI.
 *
 * Jadval formasi fan tanlangandan keyin FAQAT o'sha fanga biriktirilgan
 * o'qituvchilarni ko'rsatishi kerak. Buning uchun "kim qaysi fandan dars
 * beradi" ma'lumoti kerak, lekin butun `GET /users` javobi (telefon, parol
 * holati, ruxsatlar) kerak EMAS — shuning uchun alohida, tor ro'yxat.
 *
 * ⚠️ `isActive` ATAYLAB filtrlanmaydi (rejalashtirish moduli bilan bir xil
 * qoida): logini vaqtincha o'chirilgan xodim ham jadvalda turgan bo'lishi
 * mumkin va uni ro'yxatdan yo'qotib qo'ysak, o'sha darsni tahrirlash
 * imkonsiz bo'lardi. Arxivlangan esa maktabdan ketgan — u chiqmaydi.
 *
 * ⚠️ Rol `extraRoles` bilan birga qidiriladi: asosiy roli "qabulxona"
 * bo'lgan odam ham qo'shimcha o'qituvchi bo'lishi mumkin.
 *
 * @returns {Promise<Array>} [{ id, fullName, subjectIds }]
 */
async function getTeacherOptions() {
  const teachers = await prisma.user.findMany({
    where: {
      isArchived: false,
      OR: [{ role: ROLES.TEACHER }, { extraRoles: { has: ROLES.TEACHER } }],
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      subjects: { select: { subjectId: true } },
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });

  return teachers.map((t) => ({
    id: t.id,
    fullName: teacherName(t),
    subjectIds: (t.subjects || []).map((s) => s.subjectId),
  }));
}

module.exports = {
  getScheduleByClass,
  getTeacherOptions,
  hashSchedules,
  getScheduleByDay,
  createOrUpdateSchedule,
  saveClassSchedule,
  deleteSchedule,
  getScheduleForExport,
  getLessonDayMap,
  getAllTodaySchedules,
  getMyTodaySchedule,
  getClassesBySubject,
  updateCurrentTopic,
};
