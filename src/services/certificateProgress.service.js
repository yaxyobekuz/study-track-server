/**
 * SERTIFIKAT PROGRESSI — "mavzuning nechanchisiga yetdi".
 *
 * Qoida bitta jumlada:
 *
 * > Progress o'quvchining SINFI yo'nalishga bog'langan FANNING mavzularidan
 * > qanchasiga yetganini ko'rsatadi: 200 mavzudan 100-siga yetgan bo'lsa —
 * > 50% o'tilgan, 50% qoldi.
 *
 * ⚠️ HISOB BU YERDA QILINMAYDI. Mavzu raqami `lessonTopic.service.js` dagi
 * `getSubjectClassTopics` dan olinadi — jadval ekrani, jurnal oynasi va
 * "Dars mavzulari → Sinflar" ekrani bilan AYNI nuqta. Ikkinchi hisob
 * yozilsa, o'quvchi sertifikat ekranida bir mavzuni, jurnalda boshqasini
 * ko'rardi (`education.md` §13 — "Yagona hisob").
 *
 * ⚠️ PROGRESS SINFGA tegishli, o'quvchiga emas: platformada o'quvchining
 * shaxsiy mavzu o'rni yo'q va u yo'q narsani taxmin qilib ko'rsatmaydi.
 * Shuning uchun javobda sinf nomi ham qaytadi — o'quvchi raqam qayerdan
 * kelganini ko'rib turadi.
 */

const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const lessonTopicService = require("./lessonTopic.service");

/**
 * Progress topilmaganda — NEGA topilmagani.
 *
 * Har sabab boshqa harakat talab qiladi: yo'nalishni fanga bog'lash, mavzu
 * yuklash yoki jadvalga dars qo'yish. "—" deb qoldirilsa, foydalanuvchi
 * buni nosozlik deb o'ylardi.
 */
const PROGRESS_REASONS = Object.freeze({
  noTrackSubject: "Yo'nalish maktab faniga bog'lanmagan",
  noTopics: "Fanga mavzular yuklanmagan",
  noClass: "O'quvchi sinfga biriktirilmagan",
  noClassLesson: "O'quvchining sinfida bu fandan dars yo'q",
});

/**
 * Sinflar bo'yicha mavzu o'rni — fan kesimida, BIR MARTA o'qiladi.
 *
 * ⚠️ Keshi SO'ROV ICHIDA: bir nechta yo'nalish bitta fanga bog'langan
 * bo'lsa (IELTS va CEFR — ikkisi ham ingliz tili), fan bo'yicha hisob
 * ikki marta bajarilmaydi. `getSubjectClassTopics` har chaqiruvda kalendar
 * va jadvalni o'qiydi, ya'ni bu arzon emas.
 *
 * @param {string[]} subjectIds
 * @param {{actorId: string, ensure?: boolean}} options
 * @returns {Promise<Map<string, {totalTopics: number, byClass: Map<string, object>}>>}
 */
async function loadSubjectProgress(subjectIds, { actorId, ensure = false }) {
  const unique = [...new Set((subjectIds || []).filter(Boolean))];
  const result = new Map();

  for (const subjectId of unique) {
    try {
      const data = await lessonTopicService.getSubjectClassTopics({
        subjectId,
        actorId,
        ensure,
      });

      result.set(subjectId, {
        totalTopics: data.totalTopics ?? 0,
        byClass: new Map(
          (data.classes || [])
            .filter((row) => row.class?.id)
            .map((row) => [
              row.class.id,
              {
                className: row.class.name,
                currentTopicNumber: row.currentTopicNumber,
                currentTopicName: row.currentTopicName,
                reason: row.reason,
                nextLesson: row.nextLesson,
              },
            ]),
        ),
      });
    } catch (error) {
      // Progress — QO'SHIMCHA ma'lumot: bitta fanning mavzu hisobi
      // yiqilsa sertifikat ro'yxati baribir ochilishi kerak.
      logger.warn(
        `[Certificate] Mavzu progressi o'qilmadi (fan ${subjectId}): ${error.message}`,
      );
      result.set(subjectId, { totalTopics: 0, byClass: new Map(), failed: true });
    }
  }

  return result;
}

/**
 * O'quvchilarning sinflari — `UserClass` (sanasiz M2M, `education.md` §5).
 *
 * @param {string[]} studentIds
 * @returns {Promise<Map<string, {id: string, name: string}[]>>}
 */
async function loadStudentClasses(studentIds) {
  const ids = [...new Set((studentIds || []).filter(Boolean))];
  const map = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return map;

  const rows = await prisma.userClass.findMany({
    where: { userId: { in: ids } },
    select: { userId: true, class: { select: { id: true, name: true } } },
  });

  for (const row of rows) {
    if (!row.class) continue;
    map.get(row.userId)?.push(row.class);
  }

  return map;
}

/**
 * Bitta (o'quvchi + fan) uchun progress.
 *
 * ⚠️ JORIY MAVZU "YETILGAN" DEB SANALADI: 200 mavzudan 100-sida bo'lgan
 * sinf — 50%, qolgani 100 mavzu. Shunday hisoblangani uchun ekrandagi uch
 * raqam bir-biriga MOS keladi: `yetdi + qoldi = jami`. Agar joriy mavzu
 * "hali o'tilmagan" deb sanalsa, "100 / 200" yozuvi yonida 49.5% turib,
 * foydalanuvchiga ikkita haqiqat ko'rsatilardi.
 *
 * @param {{subjectId: string|null, studentClasses: {id: string, name: string}[],
 *   subjectData: object|undefined}} params
 * @returns {object}
 */
function buildProgress({ subjectId, studentClasses, subjectData }) {
  const empty = {
    available: false,
    totalTopics: subjectData?.totalTopics ?? 0,
    reachedTopics: null,
    remainingTopics: null,
    percent: null,
    currentTopicName: null,
    className: null,
    reason: null,
  };

  if (!subjectId) return { ...empty, reason: PROGRESS_REASONS.noTrackSubject };
  if (!subjectData || subjectData.totalTopics < 1) {
    return { ...empty, reason: PROGRESS_REASONS.noTopics };
  }
  if (!studentClasses.length) return { ...empty, reason: PROGRESS_REASONS.noClass };

  // ⚠️ O'quvchi bir nechta sinfda bo'lishi mumkin (`UserClass` — sodda
  // M2M). Fanni O'QIYOTGAN sinf olinadi; bir nechtasi bo'lsa ENG UZOQQA
  // ketgani (shu fanni ko'proq o'tgani) — "qancha o'rgandim" degan
  // savolga eng to'g'ri javob shu. Qaysi sinf olingani javobda ko'rinadi.
  const candidates = studentClasses
    .map((cls) => ({ cls, entry: subjectData.byClass.get(cls.id) }))
    .filter((row) => row.entry);

  if (!candidates.length) return { ...empty, reason: PROGRESS_REASONS.noClassLesson };

  const resolved = candidates
    .filter((row) => row.entry.currentTopicNumber != null)
    .sort((a, b) => b.entry.currentTopicNumber - a.entry.currentTopicNumber)[0];

  if (!resolved) {
    const [first] = candidates;
    return {
      ...empty,
      className: first.cls.name,
      reason: first.entry.reason || PROGRESS_REASONS.noClassLesson,
    };
  }

  const total = subjectData.totalTopics;
  const reached = Math.min(Math.max(resolved.entry.currentTopicNumber, 0), total);

  return {
    available: true,
    totalTopics: total,
    reachedTopics: reached,
    remainingTopics: total - reached,
    percent: total > 0 ? Math.round((reached / total) * 100) : null,
    currentTopicName: resolved.entry.currentTopicName,
    className: resolved.cls.name,
    reason: null,
  };
}

/**
 * REJALARGA PROGRESS BIRIKTIRADI.
 *
 * @param {{studentId: string, track: {subjectId: string|null, subject?: object}}[]} plans
 * @param {{actorId: string, ensure?: boolean}} options
 * @returns {Promise<Map<string, object>>} kalit — `"<studentId>|<subjectId>"`,
 *   fani yo'q yo'nalish uchun `"<studentId>|"`
 */
async function loadProgressForPlans(plans, { actorId, ensure = false }) {
  const rows = plans || [];
  const subjectIds = rows.map((plan) => plan.track?.subjectId).filter(Boolean);
  const studentIds = rows.map((plan) => plan.studentId);

  const [subjects, classes] = await Promise.all([
    loadSubjectProgress(subjectIds, { actorId, ensure }),
    loadStudentClasses(studentIds),
  ]);

  const out = new Map();
  for (const plan of rows) {
    const subjectId = plan.track?.subjectId ?? null;
    const key = `${plan.studentId}|${subjectId ?? ""}`;
    if (out.has(key)) continue;

    out.set(
      key,
      buildProgress({
        subjectId,
        studentClasses: classes.get(plan.studentId) ?? [],
        subjectData: subjectId ? subjects.get(subjectId) : undefined,
      }),
    );
  }

  return out;
}

/** `loadProgressForPlans` natijasidan bitta reja uchun kalit. */
const progressKey = (studentId, subjectId) => `${studentId}|${subjectId ?? ""}`;

module.exports = {
  PROGRESS_REASONS,
  loadSubjectProgress,
  loadStudentClasses,
  buildProgress,
  loadProgressForPlans,
  progressKey,
};
