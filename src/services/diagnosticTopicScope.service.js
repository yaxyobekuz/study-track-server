/**
 * DIAGNOSTIKA — MAVZU QAMROVI ("kelgan mavzudan o'tib ketmaslik").
 *
 * ⚠️ MODULNING ENG MUHIM QOIDASI SHU YERDA:
 *
 *     Testga FAQAT sinf ALLAQACHON O'TGAN mavzulardan savol tushadi.
 *     Sinf 100-mavzuda bo'lsa, 100 — to'g'ri, 101 — XATO.
 *
 * Sabab: diagnostika bilimni o'lchaydi, o'qituvchini emas. O'tilmagan
 * mavzudan so'ralgan savol o'quvchini "bilmaydi" deb belgilaydi va
 * butun hisobotni (zaif mavzular, yo'l xaritasi, sinf kesimi) yolg'on
 * qiladi — modulning butun va'dasi shu bitta qoidaga tayanadi.
 *
 * ⚠️ JORIY MAVZU YAGONA MANBADAN — `lessonTopic.service.js`
 * (`getSubjectClassTopics`, `education.md` §13 "Yagona hisob"). Bu yerda
 * ikkinchi hisob YOZILMAYDI: aks holda jadval ekranida bir mavzu,
 * test yaratish oynasida boshqa mavzu turardi va qoida qaysi raqamga
 * tayangani noma'lum bo'lib qolardi. Chaqiruv `certificateProgress`
 * dagi `loadSubjectProgress` orqali — u fan kesimida BIR MARTA o'qiydi
 * (`getSubjectClassTopics` har chaqiruvda jadval va kalendarni o'qiydi,
 * ya'ni arzon emas).
 *
 * ⚠️ XATO OTILMAYDI, QAYTARILADI. Oldindan ko'rish ekrani HAMMA
 * muammoni birdan ko'rsatishi kerak ("3 fandan 2 tasida mavzu
 * yetmaydi"), birinchisida to'xtab qolmasligi kerak. Yozuv yo'li
 * (`buildTest`) ro'yxatni o'zi tekshiradi va bittasi ham bo'lsa
 * to'xtaydi.
 */

const prisma = require("../config/prisma");
const { NotFoundError } = require("../utils/errors");
const {
  PROGRESS_REASONS,
  loadSubjectProgress,
} = require("./certificateProgress.service");
const { TOPIC_MISS_REASONS } = require("../helpers/lessonTopic");
const { normalizeLanguage, languageLabel } = require("../helpers/teachingLanguage.helpers");
const studentTopicPlanService = require("./studentTopicPlan.service");

/**
 * Mavzular ro'yxati ekranga ham, promptga ham ketadi: 1165 mavzuli fanda
 * (ingliz tili) hammasini olib kelish ham, javobga solish ham ma'nosiz.
 * Oraliq shundan uzun bo'lsa, savol yoziladigan mavzular TENG TAQSIMLAB
 * tanlanadi (`spreadTopics`) — bu chegara faqat O'QISHNI cheklaydi.
 */
const MAX_TOPICS_LOADED = 1500;

/**
 * Qatorning mavzu qamrovini hal qiladi.
 *
 * @param {object} params
 * @param {string} params.classId - test KIMGA (o'quvchilar sinfi)
 * @param {Array} params.blueprint - `parseBlueprint` natijasi
 * @param {string} params.actorId - avtomatik ankor yozilsa muallif
 * @param {boolean} [params.ensure] - ankorsiz sinfga ankor yozilsinmi
 * @returns {Promise<{scopes: Array, errors: Array<{index: number, message: string}>}>}
 */
async function resolveScopes({ classId, blueprint, actorId, ensure = true }) {
  const rows = Array.isArray(blueprint) ? blueprint : [];
  if (!rows.length) return { scopes: [], errors: [] };

  const klass = await prisma.class.findUnique({
    where: { id: classId },
    select: { id: true, name: true, language: true },
  });
  if (!klass) throw new NotFoundError("Sinf topilmadi");

  // ⚠️ MAVZULAR SINFNING TILIDAGI RO'YXATDAN (2026-11-12). Tilsiz
  // o'qilsa, rus guruhiga o'zbek ro'yxatidagi mavzularning matni ketardi
  // va AI boshqa kitobdan savol yozardi.
  const language = normalizeLanguage(klass.language);

  const subjectIds = [...new Set(rows.map((row) => row.subjectId))];
  const subjects = await prisma.subject.findMany({
    where: { id: { in: subjectIds } },
    select: { id: true, name: true },
  });
  const subjectById = new Map(subjects.map((s) => [s.id, s]));

  const missingSubject = subjectIds.find((id) => !subjectById.has(id));
  if (missingSubject) throw new NotFoundError("Fan topilmadi");

  /**
   * ⚠️ FAQAT QAMROVI BOR QATORLAR UCHUN O'QILADI. Eski yo'l
   * (`topicMode: null`) mavzuga bog'lanmaydi va unga mavzu progressini
   * hisoblash ortiqcha jadval+kalendar o'qishi bo'lardi.
   */
  const scopedSubjectIds = [
    ...new Set(rows.filter((row) => row.topicMode).map((row) => row.subjectId)),
  ];
  const progress = scopedSubjectIds.length
    ? await loadSubjectProgress(scopedSubjectIds, { actorId, ensure })
    : new Map();

  // Oraliqdagi mavzular — fan bo'yicha BIR MARTA, keyin qatorlar
  // o'zining oralig'ini shundan kesib oladi (N+1 so'rov bo'lmasin).
  const topicsBySubject = new Map();
  for (const subjectId of scopedSubjectIds) {
    const list = await prisma.topic.findMany({
      where: { subjectId, language },
      orderBy: { order: "asc" },
      take: MAX_TOPICS_LOADED,
      select: { id: true, order: true, name: true, description: true, level: true, book: true },
    });
    topicsBySubject.set(subjectId, list);
  }

  const scopes = [];
  const errors = [];

  rows.forEach((row, index) => {
    const subject = subjectById.get(row.subjectId);
    const scope = {
      index,
      subjectId: row.subjectId,
      subjectName: subject.name,
      grade: row.grade,
      source: row.source,
      language,
      topicMode: row.topicMode,
      topicFrom: row.topicFrom,
      topicTo: row.topicTo,
      currentTopicNumber: null,
      currentTopicName: null,
      totalTopics: null,
      reason: null,
      /** Sabab O'QUVCHI yo'lida kesilishi mumkinmi (`fail` izohiga qarang). */
      clampable: false,
      /** Sinf rejani oxirigacha o'tgan — chegara oxirgi mavzu. */
      topicsExhausted: false,
      topics: [],
      topicIds: null,
    };

    // Eski yo'l: qamrov yo'q — butun fan bo'yicha.
    if (!row.topicMode) {
      scopes.push(scope);
      return;
    }

    const subjectProgress = progress.get(row.subjectId);
    const classProgress = subjectProgress?.byClass?.get(classId);
    /**
     * ⚠️ MAXRAJ SINFNING TILIDAGI RO'YXATDAN (2026-11-12), fan darajasidagi
     * raqamdan EMAS. Fan darajasidagi `totalTopics` — hamma tilning eng
     * uzun ro'yxati: 40 mavzuli rus rejasida chegara 100 ga surilib,
     * o'tilmagan mavzudan savol tushib ketardi — ya'ni modulning asosiy
     * qoidasi jimgina buzilardi ("mavzular tugagan" shoxida, pastda).
     */
    scope.totalTopics =
      classProgress?.totalTopics ?? subjectProgress?.totalTopics ?? 0;

    /**
     * @param {string} message
     * @param {{clampable?: boolean}} [options] - `clampable: true` →
     *   O'QUVCHI yo'lida to'siq EMAS: chegara har bolaga alohida kesiladi
     *   (`resolveStudentScopes`). SINF yo'lida esa baribir xato bo'lib
     *   qoladi — bitta to'plam butun guruhga ketadi va u eng orqada
     *   qolgan bolaga mos bo'lishi kerak.
     */
    const fail = (message, { clampable = false } = {}) => {
      scope.reason = message;
      scope.clampable = clampable;
      errors.push({ index, message: `${subject.name}: ${message}`, clampable });
      scopes.push(scope);
    };

    if (!classProgress) {
      return fail(PROGRESS_REASONS.noClassLesson);
    }

    scope.currentTopicNumber = classProgress.currentTopicNumber ?? null;
    scope.currentTopicName = classProgress.currentTopicName ?? null;

    /**
     * ⚠️ "MAVZULAR TUGAGAN" — TO'SIQ EMAS, CHEGARA.
     *
     * Sanoq fanning oxirgi mavzusidan o'tib ketsa, mavzu hisobi
     * `currentTopicNumber: null` + "Mavzular tugagan" sababini qaytaradi
     * (`helpers/lessonTopic.js`): jadval ekranida ko'rsatiladigan
     * "joriy mavzu" haqiqatan yo'q. Diagnostika uchun esa bu holat
     * eng ANIQ holat — sinf HAMMA mavzuni o'tgan, ya'ni chegara
     * fanning oxirgi mavzusi.
     *
     * Buni to'siq deb qoldirish amaldagi ma'lumotda eng ko'p
     * uchraydigan sinflarni (rejani oxirigacha o'tganlarni) test
     * tuzishdan butunlay mahrum qilardi — holbuki ular uchun qoida
     * umuman cheklov emas.
     *
     * Qolgan sabablar ("Mavzu biriktirilmagan", "…kundan oldin",
     * "…juda uzoqda") esa "sinf qayerda turganini BILMAYMIZ" degani —
     * ular to'siq bo'lib qoladi: bilmagan holda chegara qo'yish
     * o'tilmagan mavzudan savol berish xavfini tug'dirardi.
     */
    if (
      scope.currentTopicNumber == null &&
      classProgress.reason === TOPIC_MISS_REASONS.exhausted &&
      scope.totalTopics >= 1
    ) {
      scope.currentTopicNumber = scope.totalTopics;
      scope.topicsExhausted = true;
    }

    if (scope.currentTopicNumber == null) {
      // `getSubjectClassTopics` NEGA topilmaganini aytadi — o'sha sabab
      // o'zgartirilmasdan uzatiladi (ikkinchi nusxa yozilmasin).
      return fail(classProgress.reason || PROGRESS_REASONS.noTopics);
    }

    const to = row.topicMode === "current" ? scope.currentTopicNumber : row.topicTo;
    const from = row.topicMode === "current" ? 1 : row.topicFrom;

    // ⚠️ QOIDANING O'ZI.
    if (to > scope.currentTopicNumber) {
      return fail(
        `sinf hozir ${scope.currentTopicNumber}-mavzuda, ${to}-mavzu hali o'tilmagan. ` +
          `Oraliqning oxirini ${scope.currentTopicNumber} dan oshirmang.`,
        { clampable: true },
      );
    }

    const all = topicsBySubject.get(row.subjectId) || [];
    const inRange = all.filter((topic) => topic.order >= from && topic.order <= to);

    if (!inRange.length) {
      return fail(
        all.length === 0
          ? `${PROGRESS_REASONS.noTopics} (${languageLabel(language)} tili)`
          : `${from}–${to} oralig'ida mavzu yo'q (fanda ${all.length} ta mavzu bor)`,
      );
    }

    scope.topicFrom = from;
    scope.topicTo = to;
    scope.topics = inRange;
    scope.topicIds = inRange.map((topic) => topic.id);
    // Mavzular tugagan bo'lsa "joriy mavzu" nomi ham oxirgisidan olinadi:
    // ekranda bo'sh joy turmasin.
    if (scope.topicsExhausted && !scope.currentTopicName) {
      scope.currentTopicName =
        all.find((topic) => topic.order === scope.currentTopicNumber)?.name ?? null;
    }
    scopes.push(scope);
  });

  // ⚠️ MAVZULARNING TO'LIQ RO'YXATI HAM QAYTADI (`topicsBySubject`).
  // O'quvchining qadami 1 dan katta bo'lsa, u SINFDAN OLDINDA bo'lishi
  // mumkin: `scope.topics` sinfning oralig'iga kesilgan, ya'ni o'quvchining
  // oralig'idagi mavzular unda bo'lmasligi mumkin. Ikkinchi so'rov
  // yuborilsa, 1165 mavzuli fan har o'quvchi uchun qaytadan o'qilardi.
  return { scopes, errors, class: klass, language, topicsBySubject };
}

/* ═══════════════════════════════════════════════════════════════════
   HAR O'QUVCHIGA O'Z QAMROVI
   ═══════════════════════════════════════════════════════════════════ */

/**
 * O'quvchining qamrovi topilmaganda — NEGA topilmagani.
 *
 * Har sabab boshqa harakat talab qiladi: reja belgilash, oraliqni
 * kengaytirish yoki bolani kutib turish. "—" deb qoldirilsa, admin kimga
 * test tushmaganini qo'lda qidirib topishi kerak bo'lardi.
 */
const STUDENT_SCOPE_REASONS = Object.freeze({
  behindRange: "O'quvchi hali so'ralgan oraliqning boshiga yetmagan",
  beforeStart: "So'ralgan oraliq o'quvchining rejasidan oldin",
  noPosition: "O'quvchining mavzu o'rni aniqlanmadi",
});

/**
 * HAR O'QUVCHI UCHUN QAMROVNI HAL QILADI.
 *
 * ⚠️ MODULNING ASOSIY QOIDASI O'QUVCHI KESIMIDA (biznes qarori,
 * 2026-11-12): testga FAQAT O'SHA BOLA o'tgan mavzulardan savol tushadi.
 * Sinfning raqami bilan o'lchash guruhdagi sekin ketayotgan bolaga
 * o'tilmagan materialdan savol berardi — aynan shu qoida buzilardi.
 *
 * Har o'quvchining chegarasi `StudentTopicPlan` dan keladi (shaxsiy reja
 * yo'q bo'lsa — SINFDAN MEROS, `studentTopicPlan.service.js`):
 *
 *     yuqori chegara = o'quvchining `coveredThrough` i
 *     pastki chegara = o'quvchining `startOrder` i
 *
 * ⚠️ `range` REJIMIDA ORALIQ O'QUVCHIGA KESILADI, XATO OTILMAYDI va bu
 * SILENT NARROWING EMAS — aynan so'ralgan narsa: admin "guruhni tanlasam,
 * har bola o'z mavzulari oralig'ida test olsin" deydi. Kesilgani har
 * o'quvchi qatorida OCHIQ ko'rsatiladi (`clamped`), 25 bolalik guruhda
 * bittasi orqada qolgani uchun butun testni to'xtatish esa modulni
 * ishlatib bo'lmaydigan qilardi.
 *
 * ⚠️ ORALIQ BO'SH QOLSA — O'SHA O'QUVCHI chetda qoladi (`failed` +
 * sababi), qolganlari baribir oladi. "4 o'quvchidan 3 tasiga test tushdi"
 * degan holat JIM qolmasligi kerak — tasdiqlash ekrani uni ko'rsatadi.
 *
 * @param {object} params
 * @param {string} params.classId
 * @param {Array} params.blueprint - `parseBlueprint` natijasi
 * @param {string[]} [params.studentIds] - bo'sh bo'lsa sinfning hammasi
 * @param {string} params.actorId
 * @param {boolean} [params.ensure]
 * @returns {Promise<{
 *   class: object, language: string, errors: Array,
 *   students: Array<{student: object, status: string, reason: string|null, scopes: Array}>
 * }>}
 */
async function resolveStudentScopes({
  classId,
  blueprint,
  studentIds = null,
  actorId,
  ensure = true,
}) {
  const rows = Array.isArray(blueprint) ? blueprint : [];

  // ── 1. SINF QAMROVI — mavzular ro'yxati va umumiy xatolar shundan ──
  //
  // ⚠️ SINF YO'LI BARIBIR CHAQIRILADI: mavzular matni, "fanga reja
  // yuklanmagan" va "oraliqda mavzu yo'q" kabi HAMMA O'QUVCHIGA tegishli
  // sabablar bir joyda hal qilinadi. Ikkinchi nusxa yozilsa, ikki yo'l
  // boshqa-boshqa sabab ko'rsatardi.
  const base = await resolveScopes({ classId, blueprint: rows, actorId, ensure });

  // ⚠️ "Sinf hozir N-mavzuda, M hali o'tilmagan" XATOSI O'QUVCHI YO'LIDA
  // TO'SIQ EMAS: chegara har bolaga alohida kesiladi. Qolgan xatolar
  // (reja yo'q, oraliqda mavzu yo'q) esa to'siq bo'lib qoladi.
  const hardErrors = base.errors.filter((error) => !error.clampable);

  const language = base.language;

  // ── 2. O'QUVCHILARNING MAVZU O'RNI ──
  const scopedSubjectIds = [
    ...new Set(rows.filter((row) => row.topicMode).map((row) => row.subjectId)),
  ];

  /** fan → o'quvchi → o'rin (`resolveStudentTopics`) */
  const positions = new Map();
  let students = [];

  for (const subjectId of scopedSubjectIds) {
    const resolved = await studentTopicPlanService.resolveStudentTopics({
      classId,
      subjectId,
      studentIds,
      actorId,
      ensure,
    });
    positions.set(subjectId, resolved.byStudent);
    // O'quvchilar ro'yxati HAR FANDA AYNI (sinfning a'zolari) — birinchi
    // fandan olinadi va keyin tekshirilmaydi.
    if (students.length === 0) students = resolved.students;
  }

  // Qamrovi yo'q (eski yo'l) taqsimotda o'quvchilar ro'yxati baribir kerak
  if (students.length === 0) {
    students = studentIds?.length
      ? await prisma.user.findMany({
          where: { id: { in: [...new Set(studentIds)] } },
          select: { id: true, firstName: true, lastName: true, username: true },
          orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
        })
      : await studentTopicPlanService.loadClassStudents(classId);
  }

  const classNameById = new Map([[classId, base.class?.name ?? null]]);

  const result = students.map((student) => {
    const entry = {
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        username: student.username,
      },
      className: classNameById.get(classId) ?? null,
      status: "ready",
      reason: null,
      inherited: true,
      scopes: [],
    };

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const baseScope = base.scopes[index];

      // Eski yo'l: qamrov yo'q — butun fan bo'yicha, o'quvchi kesimi ham yo'q
      if (!row.topicMode) {
        entry.scopes.push({ ...baseScope, studentId: student.id, clamped: false });
        continue;
      }

      // Sinf darajasidagi to'siq (reja yuklanmagan, ankor yo'q) — o'quvchi
      // yo'lida ham to'siq: bilmagan holda chegara qo'yish o'tilmagan
      // mavzudan savol berish xavfini tug'dirardi. Kesiladigan sabab
      // (`clampable`) esa to'siq EMAS — u har bolaga alohida hal qilinadi.
      if (baseScope.reason && !baseScope.clampable) {
        entry.status = "failed";
        entry.reason = `${baseScope.subjectName}: ${baseScope.reason}`;
        entry.scopes.push({ ...baseScope, studentId: student.id, clamped: false });
        continue;
      }

      const position = positions.get(row.subjectId)?.get(student.id) ?? null;
      if (!position) {
        entry.status = "failed";
        entry.reason = `${baseScope.subjectName}: ${STUDENT_SCOPE_REASONS.noPosition}`;
        continue;
      }

      if (!position.inherited) entry.inherited = false;

      const covered = position.coveredThrough ?? position.currentTopicNumber ?? null;
      if (covered == null) {
        entry.status = "failed";
        entry.reason = `${baseScope.subjectName}: ${position.reason || STUDENT_SCOPE_REASONS.noPosition}`;
        continue;
      }

      // ── CHEGARALARNI KESISH ──
      const wantFrom = row.topicMode === "current" ? 1 : row.topicFrom;
      const wantTo = row.topicMode === "current" ? covered : row.topicTo;

      const from = Math.max(wantFrom, position.startOrder || 1);
      const to = Math.min(wantTo, covered);

      if (to < from) {
        entry.status = "failed";
        entry.reason =
          `${baseScope.subjectName}: ` +
          (covered < wantFrom
            ? `${STUDENT_SCOPE_REASONS.behindRange} (hozir ${covered}-mavzuda, oraliq ${wantFrom} dan)`
            : `${STUDENT_SCOPE_REASONS.beforeStart} (reja ${position.startOrder}-mavzudan)`);
        continue;
      }

      const allTopics = base.topicsBySubject.get(row.subjectId) ?? [];
      const inRange = allTopics.filter(
        (topic) => topic.order >= from && topic.order <= to,
      );

      if (!inRange.length) {
        entry.status = "failed";
        entry.reason = `${baseScope.subjectName}: ${from}–${to} oralig'ida mavzu yo'q`;
        continue;
      }

      entry.scopes.push({
        ...baseScope,
        studentId: student.id,
        topicFrom: from,
        topicTo: to,
        topics: inRange,
        topicIds: inRange.map((topic) => topic.id),
        currentTopicNumber: position.currentTopicNumber,
        currentTopicName: position.currentTopicName,
        coveredThrough: covered,
        step: position.step,
        startOrder: position.startOrder,
        inherited: position.inherited,
        // Oraliq o'quvchiga KESILGANMI — ekranda ochiq ko'rsatiladi
        clamped: from !== wantFrom || to !== wantTo,
      });
    }

    return entry;
  });

  return {
    class: base.class,
    language,
    languageLabel: languageLabel(language),
    baseScopes: base.scopes,
    errors: hardErrors,
    students: result,
  };
}

/**
 * QAMROVNING KIMLIGI — "bu ikki o'quvchining qamrovi bir xilmi".
 *
 * ⚠️ AI SAVOLLARI BIR XIL QAMROV UCHUN BIR MARTA YOZILADI. 25 bolalik
 * guruhga 20 savol so'ralsa, har bolaga alohida yozish 500 ta savol va
 * o'nlab pullik model so'rovi bo'lardi — holbuki guruhda qamrovlar
 * odatda 2–5 xil bo'ladi (ko'pchilik sinfdan meros oladi). Bir xil
 * qamrovli bolalar AYNI savollarni oladi: qoida ORALIQ haqida, savollarning
 * xilma-xilligi haqida emas (sinf testi ham shunday ishlaydi).
 */
function scopeSignature(scopes) {
  return (Array.isArray(scopes) ? scopes : [])
    .map((scope) =>
      [
        scope.index,
        scope.subjectId,
        scope.topicMode ?? "-",
        scope.topicFrom ?? "-",
        scope.topicTo ?? "-",
      ].join(":"),
    )
    .join("|");
}

/** Yorliq: "Matematika · 1–42-mavzu (joriy 42)". Panel ham, Excel ham shundan. */
function scopeLabel(scope) {
  if (!scope?.topicMode) return scope?.subjectName || "Fan";
  const range =
    scope.topicFrom != null && scope.topicTo != null
      ? `${scope.topicFrom}–${scope.topicTo}-mavzu`
      : "mavzu aniqlanmagan";
  return `${scope.subjectName} · ${range}`;
}

module.exports = {
  MAX_TOPICS_LOADED,
  STUDENT_SCOPE_REASONS,
  resolveScopes,
  resolveStudentScopes,
  scopeSignature,
  scopeLabel,
};
