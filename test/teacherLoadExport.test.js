const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * O'QITUVCHILAR YUKLAMASI (Excel) — ma'lumot qatlami.
 *
 * Shu faylda qotirilgan qoidalar:
 *
 *   • SOAT = DARS: haftalik soat jadvaldagi dars sonidan sanaladi;
 *   • bir o'qituvchi bir fandan bir nechta sinfga kirsa, 1-varaqda BITTA
 *     qator bo'ladi va sinflar bitta katakda sanaladi;
 *   • kunlar hafta tartibida ("Dushanba, Juma"), alifbo bo'yicha EMAS;
 *   • arxivlangan xodim va nofaol sinf JIM TASHLANMAYDI — belgilanadi;
 *   • nomi topilmagan o'qituvchi / fan / sinf ham qatorda qoladi;
 *   • jadvalda darsi yo'q o'qituvchi alohida ro'yxatda (kamchilik);
 *   • jadval bo'sh bo'lsa bo'sh fayl berilmaydi — xato aytiladi.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const CLASS_A = "a".repeat(24);
const CLASS_B = "b".repeat(24);
const CLASS_OLD = "c".repeat(24);
const SUBJ_MATH = "m".repeat(24);
const SUBJ_ENG = "e".repeat(24);
const SUBJ_GONE = "g".repeat(24); // katalogda yo'q fan
const T_MATH = "1".repeat(24);
const T_ENG = "2".repeat(24); // arxivlangan
const T_GONE = "3".repeat(24); // users da yo'q
const T_IDLE = "4".repeat(24); // jadvalda darsi yo'q

const CLASSES = [
  { id: CLASS_A, name: "5-A", isActive: true },
  { id: CLASS_B, name: "6-B", isActive: true },
  { id: CLASS_OLD, name: "7-C", isActive: false },
];

const SUBJECTS = [
  { id: SUBJ_MATH, name: "Matematika" },
  { id: SUBJ_ENG, name: "Ingliz tili" },
];

const STAFF = [
  { id: T_MATH, firstName: "Alisher", lastName: "Qodirov", isArchived: false, role: "teacher", extraRoles: [], subjects: [{ subject: { name: "Matematika" } }] },
  { id: T_ENG, firstName: "Nigora", lastName: "Umarova", isArchived: true, role: "teacher", extraRoles: [], subjects: [] },
  { id: T_IDLE, firstName: "Botir", lastName: "Eshonov", isArchived: false, role: "reception", extraRoles: ["teacher"], subjects: [{ subject: { name: "Fizika" } }, { subject: { name: "Astronomiya" } }] },
];

/**
 * Jadval. ⚠️ Kunlar ATAYLAB teskari tartibda yozilgan (juma, keyin
 * dushanba): natijada ular hafta tartibiga saralanishi kerak.
 */
const FULL_SCHEDULE = [
  { day: "juma", classId: CLASS_A, lessons: [{ teacherId: T_MATH, subjectId: SUBJ_MATH }] },
  { day: "dushanba", classId: CLASS_A, lessons: [
    { teacherId: T_MATH, subjectId: SUBJ_MATH },
    { teacherId: T_ENG, subjectId: SUBJ_ENG },
  ] },
  { day: "seshanba", classId: CLASS_B, lessons: [
    { teacherId: T_MATH, subjectId: SUBJ_MATH },
    { teacherId: T_MATH, subjectId: SUBJ_GONE },
  ] },
  { day: "shanba", classId: CLASS_OLD, lessons: [{ teacherId: T_GONE, subjectId: SUBJ_MATH }] },
];

let schedules = FULL_SCHEDULE;

const prismaStub = {
  schedule: { findMany: async () => schedules },
  class: {
    findMany: async ({ where }) =>
      CLASSES.filter((row) => where.id.in.includes(row.id)),
  },
  subject: {
    findMany: async ({ where }) =>
      SUBJECTS.filter((row) => where.id.in.includes(row.id)),
  },
  user: {
    findMany: async ({ where }) => {
      // Jadvaldagi o'qituvchilar — id bo'yicha
      if (where?.id?.in) return STAFF.filter((row) => where.id.in.includes(row.id));
      // Rol bo'yicha ro'yxat: arxivlangan chiqmaydi, qo'shimcha rol hisob
      return STAFF.filter(
        (row) =>
          !row.isArchived &&
          (row.role === "teacher" || (row.extraRoles || []).includes("teacher")),
      );
    },
  },
};

fakeModule("../src/config/prisma", prismaStub);

const { loadTeacherLoadReport } = require("../src/services/teacherLoadExport.service");

const findRow = (rows, teacher, subject) =>
  rows.find((row) => row.teacher.startsWith(teacher) && row.subject === subject);

test("1-varaq: bir fandan bir nechta sinf BITTA qatorda yig'iladi", async () => {
  const report = await loadTeacherLoadReport();
  const row = findRow(report.teachers, "Alisher", "Matematika");

  assert.ok(row, "Alisher Qodirovning matematika qatori bo'lishi kerak");
  assert.equal(row.classNames, "5-A, 6-B");
  assert.equal(row.classCount, 2);
  // 5-A da ikki dars (juma + dushanba) + 6-B da bitta = 3 soat
  assert.equal(row.hours, 3);
});

test("kunlar hafta tartibida saralanadi", async () => {
  const report = await loadTeacherLoadReport();
  const row = report.details.find(
    (item) => item.teacher.startsWith("Alisher") && item.className === "5-A",
  );

  assert.equal(row.days, "Dushanba, Juma");
  assert.equal(row.hours, 2);
});

test("arxivlangan xodim va nofaol sinf belgilanadi, jim tashlanmaydi", async () => {
  const report = await loadTeacherLoadReport();

  const archived = report.teachers.find((row) => row.teacher.startsWith("Nigora"));
  assert.equal(archived.teacher, "Nigora Umarova (arxivlangan)");

  const oldClass = report.byClass.find((row) => row.className.startsWith("7-C"));
  assert.equal(oldClass.className, "7-C (nofaol)");
});

test("nomi topilmagan o'qituvchi va fan qatorda qoladi", async () => {
  const report = await loadTeacherLoadReport();

  const unknownTeacher = report.details.find((row) =>
    row.teacher.startsWith("Noma'lum o'qituvchi"),
  );
  assert.ok(unknownTeacher, "users da yo'q o'qituvchi ham qatorda bo'ladi");
  assert.ok(unknownTeacher.teacher.includes("…333333"));

  const unknownSubject = report.details.find((row) =>
    row.subject.startsWith("Noma'lum fan"),
  );
  assert.ok(unknownSubject, "katalogda yo'q fan ham qatorda bo'ladi");
});

test("jadvalda darsi yo'q o'qituvchi alohida ro'yxatda", async () => {
  const report = await loadTeacherLoadReport();

  assert.equal(report.missing.length, 1);
  assert.equal(report.missing[0].teacher, "Botir Eshonov");
  // Fanlar alifbo tartibida
  assert.equal(report.missing[0].subjects, "Astronomiya, Fizika");
  assert.equal(report.totals.missing, 1);
});

test("jami raqamlar: dars soni, o'qituvchi, fan va sinf kesimi", async () => {
  const report = await loadTeacherLoadReport();

  assert.equal(report.totals.lessons, 6);
  assert.equal(report.totals.teachers, 3); // jadvaldagilar (bo'shi sanalmaydi)
  assert.equal(report.totals.subjects, 3); // matematika, ingliz tili, noma'lum
  assert.equal(report.totals.classes, 3);
});

test("sinflar bo'yicha varaq sinf nomi bo'yicha saralanadi", async () => {
  const report = await loadTeacherLoadReport();
  const names = report.byClass.map((row) => row.className);

  assert.deepEqual([...names].sort((a, b) => a.localeCompare(b)), names);
});

test("jadval bo'sh bo'lsa bo'sh fayl berilmaydi — xato aytiladi", async () => {
  schedules = [];
  try {
    await assert.rejects(loadTeacherLoadReport(), /birorta dars yo'q/);
  } finally {
    schedules = FULL_SCHEDULE;
  }
});
