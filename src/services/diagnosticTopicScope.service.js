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
    select: { id: true, name: true },
  });
  if (!klass) throw new NotFoundError("Sinf topilmadi");

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
      where: { subjectId },
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
      topicMode: row.topicMode,
      topicFrom: row.topicFrom,
      topicTo: row.topicTo,
      currentTopicNumber: null,
      currentTopicName: null,
      totalTopics: null,
      reason: null,
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
    scope.totalTopics = subjectProgress?.totalTopics ?? 0;

    const fail = (message) => {
      scope.reason = message;
      errors.push({ index, message: `${subject.name}: ${message}` });
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
      );
    }

    const all = topicsBySubject.get(row.subjectId) || [];
    const inRange = all.filter((topic) => topic.order >= from && topic.order <= to);

    if (!inRange.length) {
      return fail(
        all.length === 0
          ? PROGRESS_REASONS.noTopics
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

  return { scopes, errors, class: klass };
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
  resolveScopes,
  scopeLabel,
};
