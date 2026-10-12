/**
 * FILIALLARARO KO'CHIRISH — O'QUVCHINING TA'LIM TARIXI.
 *
 * Baho, davomat, yutuq va jarima o'quvchi bilan birga ko'chadi: u yangi
 * filialda "toza varaq" bilan emas, o'z tarixi bilan boshlaydi.
 *
 * ═════════════════════════════════════════════
 * ⚠️ UCHTA QOIDA — HAR BIRI PULGA YOKI MA'NOGA TEGADI
 *
 * 1. KATALOG NOMI BO'YICHA MOSLANADI, `id` bo'yicha emas. `subjects` va
 *    `classes` har filialning o'ziniki; moslanmasa qator maqsadda osilib
 *    qolardi (jurnalda fansiz baho, hisobotda sinfsiz davomat).
 *    Moslash — `branchTransferCatalog.service.js`.
 *
 * 2. KO'CHGAN BAHO DARSNI "O'TILGAN" QILMAYDI. `loadLessonFacts` bahoni
 *    sinf + fan + dars tartibi + kun bo'yicha o'qiydi, O'QITUVCHI BO'YICHA
 *    EMAS: ko'chgan baho maqsad filialdagi o'sha katakdagi darsni o'tilgan
 *    qilib, uni hech qachon o'tmagan o'qituvchiga soat (demak PUL) yozib
 *    yuborardi. Shuning uchun har ko'chgan bahoga
 *    `transferred_from_branch_id` qo'yiladi va oylik hisobi uni chetlab
 *    o'tadi (`gradingGrantId` bilan AYNI mulohaza).
 *
 * 3. OSILGAN ISHORA QOLDIRILMAYDI. Faqat manba filialda ma'noga ega
 *    bo'lgan ustunlar (dars mavzusi, baho ruxsati, davomat sababi, jarima
 *    toifasi) maqsadda NULL qilinadi: noto'g'ri mavzuni ko'rsatgan tahlil
 *    bo'sh ko'rsatgandan yomonroq. O'qituvchi (`teacher_id`) esa
 *    MANBADAGICHA qoladi — u tarixiy fakt va 2-qoida tufayli pulga
 *    tegmaydi.
 * ═════════════════════════════════════════════
 *
 * KO'CHMAYDI (va reja buni ochiq aytadi): testlar — `TestResult` /
 * `TestSession` filialning test mavsumi, test katalogi va biriktirishiga
 * bog'langan, ularni bitta o'quvchi bilan ajratib ko'chirib bo'lmaydi;
 * do'kon buyurtmalari va tanga TARIXI — tanga QOLDIG'I yozuv bilan
 * ko'chadi (`branchTransferStudent`), tarixi esa o'z filialida qoladi.
 */

const {
  quoteIdent,
  qualified,
  copyRows,
  deleteRows,
} = require("../helpers/crossSchema.helpers");
const { mapSubjects, mapClasses, nameKey } = require("./branchTransferCatalog.service");

/**
 * Ko'chiriladigan jadvallar. Har biri `student_id` bo'yicha tanlanadi va
 * `id` bo'yicha idempotent (`ON CONFLICT DO NOTHING`).
 */
// Ko'chirish parametrlarining O'RNI (ikkala jadvalda ham AYNI oxirgi
// ikkitasi) — raqam ikki joyda yozilsa, biri siljiganda belgi noto'g'ri
// filialni ko'rsatib qolardi
const SOURCE_PARAM = 6;
const HOME_PARAM = 7;

const HISTORY_TABLES = Object.freeze([
  { table: "grades", label: "baho" },
  { table: "student_attendances", label: "davomat" },
  { table: "student_achievements", label: "yutuq" },
]);

/**
 * Manba → maqsad moslama uchun SQL ifoda (kichik ro'yxat, korrelyatsiyali
 * kichik so'rov). Ustun nomi `quoteIdent` dan o'tadi — identifikator hech
 * qachon parametrlanmaydi, shuning uchun u qat'iy naqshga mos kelishi SHART
 * (`crossSchema.helpers.js` doktrinasi).
 */
const remapExpr = (column, fromParam, toParam) => {
  const col = quoteIdent(column);
  const n = (v) => `$${Number.parseInt(v, 10)}`;
  return (
    `COALESCE((SELECT m.t FROM unnest(${n(fromParam)}::text[], ${n(toParam)}::text[]) AS m(f, t) ` +
    `WHERE m.f = s.${col} LIMIT 1), s.${col})`
  );
};

/** Moslanmasa NULL (katalog qatori maqsadda yo'q — osilgan ishora qolmaydi). */
const remapOrNullExpr = (column, fromParam, toParam) => {
  const col = quoteIdent(column);
  const n = (v) => `$${Number.parseInt(v, 10)}`;
  return (
    `(SELECT m.t FROM unnest(${n(fromParam)}::text[], ${n(toParam)}::text[]) AS m(f, t) ` +
    `WHERE m.f = s.${col} LIMIT 1)`
  );
};

/**
 * Qatorlarni NUSXALAB, manbadan FAQAT maqsadga haqiqatan o'tganini o'chiradi.
 *
 * ⚠️ O'chirish sharti nusxalash sharti bilan bir xil EMAS: nusxada tabiiy
 * kalit to'qnashsa (`student_attendances` da `(student_id, date)`) qator
 * tashlanadi va u manbada QOLISHI kerak — aks holda ma'lumot izsiz
 * yo'qolardi. Shuning uchun o'chirish `EXISTS (… t.id = s.id)` bilan.
 *
 * @param {object} db - filiallararo tranzaksiya
 * @param {object} ctx
 * @param {object} spec
 * @param {string} spec.table
 * @param {string[]} spec.ids - `$1` qiymati
 * @param {string} [spec.key="student_id"] - `ids` solishtiriladigan ustun
 * @param {any[]} spec.params - `$1` dan boshlab (birinchisi `ids`)
 * @param {Object<string, string>} [spec.override]
 * @returns {Promise<number>} nusxalangan qatorlar
 */
const relocateRows = async (db, ctx, { table, ids, key = "student_id", params, override }) => {
  const from = ctx.source.schemaName;
  const to = ctx.target.schemaName;
  const condition = `s.${quoteIdent(key)} = ANY($1::text[])`;
  const copied = await copyRows(db, ctx.cache, {
    from,
    to,
    table,
    where: condition,
    params: params ?? [ids],
    override,
    onConflict: "nothing",
  });
  await db.$executeRawUnsafe(
    `DELETE FROM ${qualified(from, table)} s WHERE ${condition}
       AND EXISTS (SELECT 1 FROM ${qualified(to, table)} t WHERE t."id" = s."id")`,
    ids,
  );
  return copied;
};

/**
 * XODIMNING TARIXI — faqat shu filialdan BUTUNLAY chiqib ketganda.
 *
 * ⚠️ KO'CHADI: jarima/rag'bat (intizom yozuvi, odam bilan ketadi) va
 * topshiriqlar (ularning tarixi bilan — `onDelete: Cascade` bolalari
 * manbada yetim qolmasin).
 *
 * ⚠️ KO'CHMAYDI va bu ATAYLAB:
 *   • XODIM DAVOMATI — u manba filialning OYLIK KIRIMI: kelmagan kun
 *     ayirmasi (`payrollAbsence.service.js`) aynan shu qatorlardan
 *     hisoblanadi va ko'chish oyining asosiy oyligi manbada qoladi
 *     (`payrollOwnership`). Davomatni olib ketish manbadagi oylikni
 *     jimgina OSHIRIB yuborardi.
 *   • OYLIK MAJBURIYATI — har oy BITTA filialda hisoblanadi va o'sha
 *     filial kassasidan to'lanadi; maqsadga ko'chirilsa, o'sha filialning
 *     shakllantirish passi uni "asosiy oylik boshqa filialda" deb darhol
 *     bekor qilardi (`fixedElsewhere`). To'lanmagan oylik manba filialda
 *     ko'rinadi va "Oylik filiallar kesimida" orqali yangi filialdan ham
 *     o'qiladi.
 *
 * @param {object} db
 * @param {object} ctx
 * @param {string[]} staffIds
 * @returns {Promise<{penalties: number, tasks: number}>}
 */
const writeStaffHistory = async (db, ctx, staffIds) => {
  const ids = [...new Set(staffIds)].sort();
  if (ids.length === 0) return { penalties: 0, tasks: 0 };
  const from = ctx.source.schemaName;
  const to = ctx.target.schemaName;

  // Jarima toifasi — nomi bo'yicha, yo'g'i NULL (katalog ochilmaydi)
  const srcCategories = await db.$queryRawUnsafe(
    `SELECT id, title FROM ${qualified(from, "penalty_categories")}`,
  );
  const tgtCategories = await db.$queryRawUnsafe(
    `SELECT id, title FROM ${qualified(to, "penalty_categories")}`,
  );
  const byTitle = new Map(tgtCategories.map((r) => [nameKey(r.title), r.id]));
  const categoryMap = new Map();
  for (const row of srcCategories) {
    const match = byTitle.get(nameKey(row.title));
    if (match) categoryMap.set(row.id, match);
  }

  const penalties = await relocateRows(db, ctx, {
    table: "penalties",
    ids,
    key: "user_id",
    params: [ids, [...categoryMap.keys()], [...categoryMap.values()]],
    override: {
      category: remapOrNullExpr("category", 2, 3),
      updated_at: "NOW()",
    },
  });
  await deleteRows(db, {
    schema: from,
    table: "penalty_notification_queue",
    where: `s."user_id" = ANY($1::text[])`,
    params: [ids],
  });

  // Topshiriqlar — tarixi bilan. Avval BOLALAR nusxalanadi (ota qator
  // maqsadda bo'lgandan keyin), keyin ota qator manbadan o'chadi va
  // bolalari `onDelete: Cascade` bilan o'zi ketadi.
  const taskRows = await db.$queryRawUnsafe(
    `SELECT id FROM ${qualified(from, "tasks")} WHERE assignee = ANY($1::text[])`,
    ids,
  );
  const taskIds = taskRows.map((r) => r.id);
  let tasks = 0;
  if (taskIds.length) {
    tasks = await copyRows(db, ctx.cache, {
      from,
      to,
      table: "tasks",
      where: `s."assignee" = ANY($1::text[])`,
      params: [ids],
      override: { updated_at: "NOW()" },
      onConflict: "nothing",
    });
    for (const table of ["task_status_history", "task_deadline_history"]) {
      await copyRows(db, ctx.cache, {
        from,
        to,
        table,
        where: `s."task_id" = ANY($1::text[])`,
        params: [taskIds],
        onConflict: "nothing",
      });
    }
    await db.$executeRawUnsafe(
      `DELETE FROM ${qualified(from, "tasks")} s WHERE s."assignee" = ANY($1::text[])
         AND EXISTS (SELECT 1 FROM ${qualified(to, "tasks")} t WHERE t."id" = s."id")`,
      ids,
    );
  }

  return { penalties, tasks };
};

/**
 * TA'LIM TARIXI REJASI — nima ko'chadi, nima qoladi.
 *
 * @param {object} db
 * @param {object} ctx
 * @param {string[]} studentIds
 * @returns {Promise<Map<string, object>>} studentId → reja
 */
const planStudentHistory = async (db, ctx, studentIds) => {
  const ids = [...new Set(studentIds)].sort();
  const src = (t) => qualified(ctx.source.schemaName, t);
  const q = (sql, ...params) => db.$queryRawUnsafe(sql, ...params);
  const plans = new Map(ids.map((id) => [id, null]));
  if (ids.length === 0) return plans;

  const grades = await q(
    `SELECT student_id AS "studentId", COUNT(*)::int AS n,
            MIN(date)::text AS "from", MAX(date)::text AS "to"
     FROM ${src("grades")} WHERE student_id = ANY($1::text[]) GROUP BY student_id`,
    ids,
  );
  const attendance = await q(
    `SELECT student_id AS "studentId", COUNT(*)::int AS n
     FROM ${src("student_attendances")} WHERE student_id = ANY($1::text[]) GROUP BY student_id`,
    ids,
  );
  const achievements = await q(
    `SELECT student_id AS "studentId", COUNT(*)::int AS n
     FROM ${src("student_achievements")} WHERE student_id = ANY($1::text[]) GROUP BY student_id`,
    ids,
  );
  const penalties = await q(
    `SELECT user_id AS "studentId", COUNT(*)::int AS n
     FROM ${src("penalties")} WHERE user_id = ANY($1::text[]) GROUP BY user_id`,
    ids,
  );
  // KO'CHMAYDIGANLAR — reja ularni JIM qoldirmaydi
  const tests = await q(
    `SELECT student_id AS "studentId", COUNT(*)::int AS n
     FROM ${src("test_results")} WHERE student_id = ANY($1::text[]) GROUP BY student_id`,
    ids,
  );

  // Ko'chadigan qatorlarda uchraydigan kataloglar — reja bosqichida faqat
  // SANALADI (hech narsa ochilmaydi; ochish yozuv bosqichida)
  const subjects = await q(
    `SELECT DISTINCT sub.id, sub.name FROM ${src("subjects")} sub
     WHERE sub.id IN (
       SELECT subject_id FROM ${src("grades")} WHERE student_id = ANY($1::text[])
       UNION SELECT subject_id FROM ${src("student_achievements")} WHERE student_id = ANY($1::text[])
     ) ORDER BY sub.name`,
    ids,
  );
  const classes = await q(
    `SELECT DISTINCT c.id, c.name FROM ${src("classes")} c
     WHERE c.id IN (
       SELECT class_id FROM ${src("grades")} WHERE student_id = ANY($1::text[])
       UNION SELECT class_id FROM ${src("student_attendances")} WHERE student_id = ANY($1::text[])
     ) ORDER BY c.name`,
    ids,
  );
  const targetSubjects = await q(`SELECT name FROM ${qualified(ctx.target.schemaName, "subjects")}`);
  const targetClasses = await q(`SELECT name FROM ${qualified(ctx.target.schemaName, "classes")}`);
  const haveSubject = new Set(targetSubjects.map((r) => nameKey(r.name)));
  const haveClass = new Set(targetClasses.map((r) => nameKey(r.name)));

  const countOf = (rows) => new Map(rows.map((r) => [String(r.studentId), r.n]));
  const gradeOf = new Map(grades.map((r) => [String(r.studentId), r]));
  const attendanceOf = countOf(attendance);
  const achievementOf = countOf(achievements);
  const penaltyOf = countOf(penalties);
  const testOf = countOf(tests);

  const newSubjects = subjects.filter((s) => !haveSubject.has(nameKey(s.name))).map((s) => s.name);
  const newClasses = classes.filter((c) => !haveClass.has(nameKey(c.name))).map((c) => c.name);

  for (const id of ids) {
    const grade = gradeOf.get(id);
    plans.set(id, {
      grades: grade?.n ?? 0,
      gradeFrom: grade?.from ?? null,
      gradeTo: grade?.to ?? null,
      attendance: attendanceOf.get(id) ?? 0,
      achievements: achievementOf.get(id) ?? 0,
      penalties: penaltyOf.get(id) ?? 0,
      testsStaying: testOf.get(id) ?? 0,
    });
  }

  // Katalog qarorlari butun amalga umumiy — har qatorda takrorlanmaydi
  plans.set("__catalog__", {
    subjectIds: subjects.map((s) => s.id),
    classIds: classes.map((c) => c.id),
    newSubjects,
    newClasses,
  });

  return plans;
};

/**
 * TA'LIM TARIXINI KO'CHIRADI.
 *
 * Har jadval uchun: maqsadga NUSXALANADI (`id` yoki tabiiy kalit bo'yicha
 * to'qnashsa — tashlanadi), keyin manbada FAQAT maqsadda haqiqatan paydo
 * bo'lgan qatorlar o'chiriladi. Teskari tartib (avval o'chirish) tranzaksiya
 * yiqilsa ham xavfsiz, lekin "nusxa o'tmadi-yu manbadan o'chdi" holatini
 * STRUKTURAVIY imkonsiz qilish uchun aynan shu tartib tanlangan
 * (`tg_users` ko'chirish naqshi).
 *
 * @param {object} db
 * @param {object} ctx
 * @param {string[]} studentIds
 * @param {object} catalog - `planStudentHistory` dagi `__catalog__`
 * @param {Map<string, string>} [knownClassMap] - sinf oqimidagi tayyor moslama
 * @returns {Promise<{moved: object, createdSubjects: string[], createdClasses: string[]}>}
 */
const writeStudentHistory = async (db, ctx, studentIds, catalog, knownClassMap) => {
  const ids = [...new Set(studentIds)].sort();
  const from = ctx.source.schemaName;
  const to = ctx.target.schemaName;
  const moved = {};
  if (ids.length === 0) return { moved, createdSubjects: [], createdClasses: [] };

  const subjectMap = await mapSubjects(db, ctx, catalog.subjectIds);
  const classMap = await mapClasses(db, ctx, catalog.classIds, {
    // Tarix uchun ochilgan sinf NOFAOL: u joriy sinflar ro'yxatiga,
    // jurnalga va hisobotlarga kirmaydi, faqat ko'chgan qatorlarni ushlab
    // turadi. Sinfning O'ZI ko'chirilayotgan bo'lsa chaqiruvchi tayyor
    // (faol) moslama beradi.
    active: false,
    known: knownClassMap,
  });

  // Davomat sababi va jarima toifasi — faqat NOM bo'yicha moslanadi va
  // YANGISI OCHILMAYDI: ular intizom katalogi (ball, rol, qo'llanish
  // doirasi bilan), ularni tarix ko'chirish yo'li bilan tug'dirish maqsad
  // filialning intizom qoidasini jimgina o'zgartirardi. Mos kelmagani NULL
  // bo'ladi — sabab matni baribir qatorning o'zida qoladi.
  const matchByTitle = async (table) => {
    const srcRows = await db.$queryRawUnsafe(
      `SELECT id, title FROM ${qualified(from, table)}`,
    );
    const tgtRows = await db.$queryRawUnsafe(
      `SELECT id, title FROM ${qualified(to, table)}`,
    );
    const byTitle = new Map(tgtRows.map((r) => [nameKey(r.title), r.id]));
    const map = new Map();
    for (const row of srcRows) {
      const match = byTitle.get(nameKey(row.title));
      if (match) map.set(row.id, match);
    }
    return map;
  };
  const absenceMap = await matchByTitle("absence_reasons");
  const penaltyCategoryMap = await matchByTitle("penalty_categories");

  const pairs = (map) => [[...map.keys()], [...map.values()]];
  const [subjectFrom, subjectTo] = pairs(subjectMap.map);
  const [classFrom, classTo] = pairs(classMap.map);
  const [absenceFrom, absenceTo] = pairs(absenceMap);
  const [categoryFrom, categoryTo] = pairs(penaltyCategoryMap);

  const relocate = (spec) => relocateRows(db, ctx, { ...spec, ids });

  // ⚠️ UYGA QAYTGAN QATOR BELGIDAN XALOS BO'LADI. A → B → A da qator
  // o'zining tug'ilgan filialiga qaytadi: u yerda u ko'chirilgan emas,
  // O'Z fakti. Belgini saqlab qolsak, o'sha filialning o'z bahosi abadiy
  // "boshqa filialdan" bo'lib qolardi.
  const originExpr = (column) =>
    `CASE WHEN s.${quoteIdent(column)} = $${HOME_PARAM} THEN NULL ELSE $${SOURCE_PARAM} END`;

  // ── BAHOLAR ──
  moved.grades = await relocate({
    table: "grades",
    params: [ids, subjectFrom, subjectTo, classFrom, classTo, ctx.source.id, ctx.target.id],
    override: {
      subject_id: remapExpr("subject_id", 2, 3),
      class_id: remapExpr("class_id", 4, 5),
      // ⚠️ PUL XAVFSIZLIGI — 2-qoida (fayl sarlavhasi)
      transferred_from_branch_id: originExpr("transferred_from_branch_id"),
      // Dars mavzusi va baho ruxsati faqat manba filialda ma'noga ega
      topic_id: "NULL",
      grading_grant_id: "NULL",
      updated_at: "NOW()",
    },
  });

  // ── DAVOMAT ──
  moved.attendance = await relocate({
    table: "student_attendances",
    params: [ids, classFrom, classTo, absenceFrom, absenceTo, ctx.source.id, ctx.target.id],
    override: {
      class_id: remapExpr("class_id", 2, 3),
      absence_reason: remapOrNullExpr("absence_reason", 4, 5),
      transferred_from_branch_id: originExpr("transferred_from_branch_id"),
      updated_at: "NOW()",
    },
  });

  // ── YUTUQLAR ──
  moved.achievements = await relocate({
    table: "student_achievements",
    params: [ids, subjectFrom, subjectTo],
    override: {
      subject_id: remapExpr("subject_id", 2, 3),
      updated_at: "NOW()",
    },
  });

  // ── JARIMA VA RAG'BAT ──
  // `given_by` / `reviewed_by` manbadagi xodimga ishora qiladi va
  // MANBADAGICHA qoladi: u tarixiy fakt (kim bergan), pulga tegmaydi.
  moved.penalties = await relocate({
    table: "penalties",
    key: "user_id",
    params: [ids, categoryFrom, categoryTo],
    override: {
      category: remapOrNullExpr("category", 2, 3),
      updated_at: "NOW()",
    },
  });

  // Yetkazilmagan jarima xabarnomalari manbada ma'nosiz qoladi
  await deleteRows(db, {
    schema: from,
    table: "penalty_notification_queue",
    where: `s."user_id" = ANY($1::text[])`,
    params: [ids],
  });

  return {
    moved,
    createdSubjects: subjectMap.created,
    createdClasses: classMap.created,
    classMap: classMap.map,
  };
};

module.exports = {
  HISTORY_TABLES,
  relocateRows,
  planStudentHistory,
  writeStudentHistory,
  writeStaffHistory,
};
