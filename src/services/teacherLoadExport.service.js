/**
 * O'QITUVCHILAR YUKLAMASI → EXCEL ("kim qaysi fandan qaysi sinflarga kiradi").
 *
 * Manba — AMALDAGI dars jadvali (`schedules` / `schedule_lessons`), ya'ni
 * `education.md` §10 dagi yagona haqiqat. Rejalashtirish qatlami
 * (`PlannerLoad`) va arxiv nusxalar (`schedule_snapshots`) O'QILMAYDI:
 * faylni ochgan odam "hozir kim kirib turibdi" degan savolga javob kutadi.
 *
 * ⚠️ SOAT = DARS (`teacherWorkload.service.js` bilan AYNI o'lchov): haftalik
 * soat — jadvaldagi dars sonidan. Astronomik soat kiritilsa, bu raqam
 * vedomostdagi dars soati bilan taqqoslanmay qolardi.
 *
 * ⚠️ O'RINBOSARLIK KO'RSATILMAYDI (`education.md` §8): `ScheduleLesson.teacherId`
 * — e'lon qilingan fakt va u kelasi haftaga ham tegishli. O'rinbosar esa
 * MUDDATLI yozuv; uni shu faylga qo'shsak, "bu darsning o'qituvchisi kim"
 * degan savol javobsiz qolardi (bir haftalik kasallik butun yuklamani
 * boshqa odamga yozib yuborardi).
 *
 * ⚠️ HECH NARSA JIM TASHLANMAYDI: nomi topilmagan o'qituvchi / fan / sinf
 * ham qatorda qoladi ("Noma'lum …"), arxivlangan xodim va nofaol sinf esa
 * BELGI bilan ko'rinadi. Jim filtrlash hisobotni "to'liq" ko'rsatib,
 * aslida jadvaldagi xatoni yashirardi.
 */

const prisma = require("../config/prisma");
const ExcelService = require("./excel.service");
const { dayLabel } = require("./schedule.service");
const { BadRequestError } = require("../utils/errors");
const { ROLES, DAYS } = require("../utils/constants");
const { formatDateTimeUz } = require("../helpers/date.helpers");

// Hafta kunlari tartibi (dushanba → shanba). `DAYS` — yagona manba
// (`ScheduleDay` enumining ko'zgusi), bu yerda nusxa massiv yaratilmaydi.
const DAY_RANK = new Map(Object.values(DAYS).map((day, index) => [day, index]));

const COLOR = {
  teachers: ExcelService.COLORS.HEADER_BLUE,
  details: ExcelService.COLORS.HEADER_GREEN,
  classes: ExcelService.COLORS.HEADER_PURPLE,
  missing: ExcelService.COLORS.HEADER_ORANGE,
};

const SHEETS = {
  teachers: {
    name: "O'qituvchilar",
    title: "O'qituvchilar yuklamasi — fan va sinflar",
    color: COLOR.teachers,
    columns: [
      { header: "№", key: "no", width: 6, align: "center" },
      { header: "O'qituvchi", key: "teacher", width: 30 },
      { header: "Fan", key: "subject", width: 24 },
      { header: "Sinflar", key: "classNames", width: 46 },
      { header: "Sinf soni", key: "classCount", width: 11, align: "center" },
      { header: "Haftalik soat", key: "hours", width: 14, align: "center" },
    ],
  },
  details: {
    name: "Sinflar kesimi",
    title: "O'qituvchi → fan → sinf (batafsil)",
    color: COLOR.details,
    columns: [
      { header: "№", key: "no", width: 6, align: "center" },
      { header: "O'qituvchi", key: "teacher", width: 30 },
      { header: "Fan", key: "subject", width: 24 },
      { header: "Sinf", key: "className", width: 22 },
      { header: "Haftalik soat", key: "hours", width: 14, align: "center" },
      { header: "Kunlar", key: "days", width: 40 },
    ],
  },
  byClass: {
    name: "Sinflar bo'yicha",
    title: "Sinf → fan → o'qituvchi",
    color: COLOR.classes,
    columns: [
      { header: "№", key: "no", width: 6, align: "center" },
      { header: "Sinf", key: "className", width: 22 },
      { header: "Fan", key: "subject", width: 24 },
      { header: "O'qituvchi", key: "teacher", width: 30 },
      { header: "Haftalik soat", key: "hours", width: 14, align: "center" },
      { header: "Kunlar", key: "days", width: 40 },
    ],
  },
  missing: {
    name: "Jadvalda yo'q",
    title: "Jadvalda darsi yo'q o'qituvchilar",
    color: COLOR.missing,
    columns: [
      { header: "№", key: "no", width: 6, align: "center" },
      { header: "O'qituvchi", key: "teacher", width: 30 },
      { header: "Biriktirilgan fanlar", key: "subjects", width: 46 },
    ],
  },
};

/** "Familiya Ism" — `schedule.service.js` dagi `teacherName` bilan AYNI shakl. */
const personName = (user) =>
  `${user.firstName || ""} ${user.lastName || ""}`.trim();

/**
 * Nomi topilmagan yozuv uchun yorliq.
 *
 * ⚠️ Id ning oxiri QO'SHILADI: ikki buzuq yozuv bitta "Noma'lum" nomi bilan
 * qo'shni qatorlarda turib, bitta xato bo'lib ko'rinardi.
 */
const unknownLabel = (prefix, id) => `${prefix} (…${String(id).slice(-6)})`;

const numbered = (rows) => rows.map((row, index) => ({ ...row, no: index + 1 }));

/** Matn bo'yicha barqaror taqqoslash (bir nechta kalit bilan ketma-ket). */
const byText = (...keys) => (a, b) => {
  for (const key of keys) {
    const diff = String(a[key] ?? "").localeCompare(String(b[key] ?? ""));
    if (diff !== 0) return diff;
  }
  return 0;
};

/**
 * HISOBOTNING MA'LUMOTI — varaqlardan MUSTAQIL (test shu funksiyani o'qiydi).
 *
 * @returns {Promise<{generatedAt: Date, totals: object, teachers: object[],
 *   details: object[], byClass: object[], missing: object[]}>}
 */
async function loadTeacherLoadReport() {
  const schedules = await prisma.schedule.findMany({
    select: {
      day: true,
      classId: true,
      lessons: { select: { teacherId: true, subjectId: true } },
    },
  });

  // ── Nomlar: hammasi soft ref (relation yo'q) ──
  const classIds = new Set();
  const subjectIds = new Set();
  const teacherIds = new Set();

  for (const schedule of schedules) {
    if (schedule.classId) classIds.add(schedule.classId);
    for (const lesson of schedule.lessons) {
      if (lesson.subjectId) subjectIds.add(lesson.subjectId);
      if (lesson.teacherId) teacherIds.add(lesson.teacherId);
    }
  }

  // Jadvaldagi o'qituvchilar + jadvalda darsi YO'Q o'qituvchilar: ikkinchi
  // ro'yxat uchun rol bo'yicha so'rov kerak (`getTeacherOptions` bilan AYNI
  // shart — qo'shimcha rol ham hisob, arxivlangan esa maktabdan ketgan).
  const [classes, subjects, lessonStaff, roleTeachers] = await Promise.all([
    prisma.class.findMany({
      where: { id: { in: [...classIds] } },
      select: { id: true, name: true, isActive: true },
    }),
    prisma.subject.findMany({
      where: { id: { in: [...subjectIds] } },
      select: { id: true, name: true },
    }),
    prisma.user.findMany({
      where: { id: { in: [...teacherIds] } },
      select: { id: true, firstName: true, lastName: true, isArchived: true },
    }),
    prisma.user.findMany({
      where: {
        isArchived: false,
        OR: [{ role: ROLES.TEACHER }, { extraRoles: { has: ROLES.TEACHER } }],
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        isArchived: true,
        subjects: { select: { subject: { select: { name: true } } } },
      },
    }),
  ]);

  const classMap = new Map(classes.map((row) => [row.id, row]));
  const subjectMap = new Map(subjects.map((row) => [row.id, row]));
  const staffMap = new Map(lessonStaff.map((row) => [row.id, row]));

  const teacherLabel = (id) => {
    const user = staffMap.get(id);
    if (!user) return unknownLabel("Noma'lum o'qituvchi", id);
    const name = personName(user) || unknownLabel("Ismsiz xodim", id);
    // Arxivlangan xodim jadvalda turgani — tuzatilishi kerak bo'lgan holat
    return user.isArchived ? `${name} (arxivlangan)` : name;
  };

  const subjectLabel = (id) =>
    subjectMap.get(id)?.name ?? unknownLabel("Noma'lum fan", id);

  const classLabel = (id) => {
    const row = classMap.get(id);
    if (!row) return unknownLabel("Noma'lum sinf", id);
    // Nofaol sinf jadvalda qolishi mumkin (filiallararo ko'chirishda u
    // tarixni ushlab turadi) — yashirilmaydi, BELGILANADI
    return row.isActive ? row.name : `${row.name} (nofaol)`;
  };

  // ── Yig'ish: o'qituvchi → fan → sinf ──
  //
  // Kalit ID bo'yicha (nom bo'yicha EMAS): bir xil nomli ikki fan yoki ikki
  // sinf bo'lsa, ular bitta qatorga qo'shilib ketardi.
  const cells = new Map(); // `${teacherId}|${subjectId}|${classId}` → qator
  let lessonCount = 0;

  for (const schedule of schedules) {
    for (const lesson of schedule.lessons) {
      const key = `${lesson.teacherId}|${lesson.subjectId}|${schedule.classId}`;
      let cell = cells.get(key);

      if (!cell) {
        cell = {
          teacherId: lesson.teacherId,
          subjectId: lesson.subjectId,
          classId: schedule.classId,
          teacher: teacherLabel(lesson.teacherId),
          subject: subjectLabel(lesson.subjectId),
          className: classLabel(schedule.classId),
          hours: 0,
          dayKeys: new Set(),
        };
        cells.set(key, cell);
      }

      cell.hours += 1;
      cell.dayKeys.add(schedule.day);
      lessonCount += 1;
    }
  }

  if (lessonCount === 0) {
    throw new BadRequestError(
      "Dars jadvalida birorta dars yo'q — avval jadvalni to'ldiring",
    );
  }

  const withDays = [...cells.values()].map((cell) => ({
    ...cell,
    days: [...cell.dayKeys]
      .sort((a, b) => (DAY_RANK.get(a) ?? 99) - (DAY_RANK.get(b) ?? 99))
      .map(dayLabel)
      .join(", "),
  }));

  // ── 1-varaq: o'qituvchi × fan (sinflar bitta katakda) ──
  const pairs = new Map();
  for (const cell of withDays) {
    const key = `${cell.teacherId}|${cell.subjectId}`;
    let pair = pairs.get(key);

    if (!pair) {
      pair = {
        teacher: cell.teacher,
        subject: cell.subject,
        classNames: [],
        hours: 0,
      };
      pairs.set(key, pair);
    }

    pair.classNames.push(cell.className);
    pair.hours += cell.hours;
  }

  const teacherRows = [...pairs.values()]
    .map((pair) => {
      const names = [...pair.classNames].sort((a, b) => a.localeCompare(b));
      return {
        teacher: pair.teacher,
        subject: pair.subject,
        classNames: names.join(", "),
        classCount: names.length,
        hours: pair.hours,
      };
    })
    .sort(byText("teacher", "subject"));

  const details = withDays
    .map(({ teacher, subject, className, hours, days }) => ({
      teacher,
      subject,
      className,
      hours,
      days,
    }))
    .sort(byText("teacher", "subject", "className"));

  const byClass = withDays
    .map(({ className, subject, teacher, hours, days }) => ({
      className,
      subject,
      teacher,
      hours,
      days,
    }))
    .sort(byText("className", "subject", "teacher"));

  // ── 4-varaq: jadvalda darsi yo'q o'qituvchilar ──
  //
  // Bu KAMCHILIK ro'yxati: fanga biriktirilgan, lekin jadvalga tushmagan
  // odam jim qolmasligi kerak — aks holda "hamma joylashtirildi" degan
  // xulosa faylning o'zidan chiqib ketardi.
  const missing = roleTeachers
    .filter((user) => !teacherIds.has(user.id))
    .map((user) => ({
      teacher: personName(user) || unknownLabel("Ismsiz xodim", user.id),
      subjects:
        (user.subjects || [])
          .map((link) => link.subject?.name)
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b))
          .join(", ") || "Fan biriktirilmagan",
    }))
    .sort(byText("teacher"));

  return {
    generatedAt: new Date(),
    totals: {
      teachers: new Set(withDays.map((cell) => cell.teacherId)).size,
      subjects: new Set(withDays.map((cell) => cell.subjectId)).size,
      classes: new Set(withDays.map((cell) => cell.classId)).size,
      lessons: lessonCount,
      missing: missing.length,
    },
    teachers: teacherRows,
    details,
    byClass,
    missing,
  };
}

/** Varaq: sarlavha + ustunlar + qatorlar (bo'sh ro'yxatda izoh qatori). */
function addSheet(workbook, config, rows, { subtitle, emptyText }) {
  const sheet = ExcelService.addTitledSheet(workbook, {
    name: config.name,
    title: config.title,
    subtitle,
    columns: config.columns,
    headerColor: config.color,
  });

  ExcelService.fillTitledRows(sheet, config.columns, numbered(rows), { emptyText });

  // Chop etish: ro'yxat yig'ilishga qog'ozda ham olib kiriladi — ustunlar
  // bitta sahifa kengligiga sig'adi, sarlavha qatori har sahifada takrorlanadi
  sheet.pageSetup = {
    ...sheet.pageSetup,
    paperSize: 9, // A4
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: `${ExcelService.TITLED_HEADER_ROW}:${ExcelService.TITLED_HEADER_ROW}`,
  };

  return sheet;
}

/**
 * @param {import("express").Response} res
 */
async function exportTeacherLoad(res) {
  const report = await loadTeacherLoadReport();
  const { totals } = report;

  // Sarlavha ostidagi qator: fayl chop etilganda yoki boshqa odamga
  // yuborilganda "bu qaysi holat, raqamlar qayerdan" degan savolga javob
  // faqat shu yerda bo'ladi.
  const head = [
    `Holat: ${formatDateTimeUz(report.generatedAt)}`,
    "Manba: amaldagi dars jadvali",
  ];

  const subtitle = [
    ...head,
    `O'qituvchilar: ${totals.teachers}`,
    `Fanlar: ${totals.subjects}`,
    `Sinflar: ${totals.classes}`,
    `Haftalik soat: ${totals.lessons} (soat = haftadagi dars soni)`,
  ].join(" · ");

  // ⚠️ Oxirgi varaqda soat ustuni YO'Q — unga soat izohi yozilmaydi
  const missingSubtitle = [
    ...head,
    `Jadvalda darsi yo'q: ${totals.missing}`,
  ].join(" · ");

  const workbook = ExcelService.createWorkbook();

  addSheet(workbook, SHEETS.teachers, report.teachers, {
    subtitle,
    emptyText: "Jadvalda o'qituvchi yo'q",
  });
  addSheet(workbook, SHEETS.details, report.details, {
    subtitle,
    emptyText: "Jadvalda dars yo'q",
  });
  addSheet(workbook, SHEETS.byClass, report.byClass, {
    subtitle,
    emptyText: "Jadvalda dars yo'q",
  });
  addSheet(workbook, SHEETS.missing, report.missing, {
    subtitle: missingSubtitle,
    emptyText: "Hamma o'qituvchining jadvalda darsi bor",
  });

  await ExcelService.sendWorkbookAs(res, workbook, "oqituvchilar_yuklamasi", {
    fallbackName: "oqituvchilar_yuklamasi",
  });
}

module.exports = { exportTeacherLoad, loadTeacherLoadReport };
