/**
 * O'QUVCHINING SHAXSIY MAVZU REJASI — ANKOR + QADAM.
 *
 * ── MUAMMO ────────────────────────────────────
 *
 * Mavzu o'rni SINFGA tegishli edi (`lessonTopic.service.js`): butun guruh
 * bitta raqamda turardi. Amalda esa bir guruhda bolalar boshqa-boshqa
 * tezlikda ketadi — biri bitta darsda uch mavzuni oladi, boshqasi o'rtada
 * qo'shilgani uchun 45-mavzudan boshlaydi. Diagnostika testining butun
 * va'dasi ("o'tilmagan mavzudan savol berilmaydi") aynan shu yerda
 * buzilardi: sinfning raqami bilan o'lchangan test sekin ketayotgan bolaga
 * o'tilmagan materialdan savol berardi.
 *
 * ── YECHIM ────────────────────────────────────
 *
 * Sinf bilan AYNI doktrina, faqat o'quvchi kesimida. Saqlanadigan narsa —
 * ANKOR ("16-oktabr, 3-darsda bu bola 50-mavzuda") va QADAM ("bitta darsda
 * nechta mavzu"). Qolgan hamma dars shundan SANAB chiqariladi.
 *
 * ⚠️ IKKINCHI SANOQ YOZILMAYDI. Hisob `helpers/lessonTopic.js` dagi
 * `topicOrdersForDays` da — sinf bilan BITTA funksiya, farqi faqat `step`
 * da (`education.md` §13 "Yagona hisob"). Ikkita bo'lsa, biriga qo'shilgan
 * shart (bayram, ta'til oyi, segmentlar) ikkinchisida tushib qolardi va
 * o'quvchi profilida bir mavzu, jadvalda boshqa mavzu turardi.
 *
 * ⚠️ QADAM — "NECHTA MAVZU O'TA OLADI" (biznes qarori, 2026-11-12). Bu
 * CHEGARA emas, TEZLIK: "unga 3 qilib qo'ysa, bitta dars bo'lib o'tganda u
 * uchun 3 mavzu o'tilgan hisoblanadi". 1-dars → 50,51,52; 2-dars →
 * 53,54,55. Rejaning oxiri fanning mavzular ro'yxati bilan baribir
 * cheklanadi (yo'q mavzu "o'tilgan" bo'lib ko'rinmaydi).
 *
 * ⚠️ QATOR BO'LMASA — SINFDAN MEROS (`inherited: true`, qadam 1). Butun
 * guruhga qator yozish "shaxsiy reja" tushunchasini ma'nosiz qilardi
 * (hammasi bir xil) va sinfning mavzusi o'zgarganda yuzlab qatorni qayta
 * yozish kerak bo'lardi.
 *
 * ⚠️ DARS KUNLARI SINFNING JADVALIDAN. O'quvchining o'z jadvali yo'q: u
 * guruh bilan birga o'tiradi. Shuning uchun `classId` ankorda ham
 * saqlanadi — boshqa guruhga o'tgan o'quvchiga eski reja ERGASHMAYDI.
 *
 * ⚠️ O'CHIRILMAYDI — BEKOR QILINADI (`revokedAt` + aktyor): "nega bu bola
 * boshqa mavzuda" degan savolga javob registrda qolishi kerak.
 */

const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const { generateId } = require("../utils/idGenerator");
const { ROLES } = require("../utils/constants");
const { BadRequestError, NotFoundError, ConflictError } = require("../utils/errors");
const { todayIsoTashkent, shiftIsoDays } = require("../helpers/month.helpers");
const { formatDateUz } = require("../helpers/date.helpers");
const { dayKey } = require("../helpers/lessonHours");
const {
  TOPIC_MISS_REASONS,
  noTopicsForLanguage,
  parseDayKey,
} = require("../helpers/lessonTopic");
const {
  DEFAULT_TEACHING_LANGUAGE,
  normalizeLanguage,
  languageLabel,
} = require("../helpers/teachingLanguage.helpers");
const lessonTopicService = require("./lessonTopic.service");

/**
 * BITTA DARSDA ENG KO'P MAVZU.
 *
 * Chegara ataylab past: 20 dan katta qadam bitta darsda butun kitobni
 * "o'tilgan" qilib, test qamrovini o'z-o'zidan bekor qilardi. Qiymat
 * so'rovdan kelgani uchun tekshiruv SERVISDA (oynadagi belgi chetlab
 * o'tilsa ham).
 */
const MAX_STEP = 20;

/** Izoh uzunligi — `LessonTopicBinding` bilan AYNI. */
const NOTE_MAX = 300;

/** Bir amalda eng ko'p o'quvchi (bitta guruh baribir shundan kichik). */
const MAX_BULK_STUDENTS = 200;

/** Reja topilmaganda — NEGA topilmagani (sabab ekranda ko'rsatiladi). */
const PLAN_MISS_REASONS = Object.freeze({
  noClassLesson: "Sinf jadvalida bu fandan dars yo'q",
  noUpcomingLesson: "Yaqin kunlarda bu fandan dars yo'q",
});

/* ───────────────────────── o'qish ───────────────────────── */

/** Sinf va fan — ikkisi ham bo'lishi shart (ankor ikkalasiga tayanadi). */
async function _loadContext(classId, subjectId) {
  const [classDoc, subject] = await Promise.all([
    prisma.class.findUnique({
      where: { id: classId },
      select: { id: true, name: true, language: true },
    }),
    prisma.subject.findUnique({ where: { id: subjectId }, select: { id: true, name: true } }),
  ]);
  if (!classDoc) throw new NotFoundError("Sinf topilmadi");
  if (!subject) throw new NotFoundError("Fan topilmadi");

  return { classDoc, subject, language: normalizeLanguage(classDoc.language) };
}

/**
 * SINFNING O'QUVCHILARI.
 *
 * ⚠️ `isArchived` FILTRLANADI, `isActive` esa YO'Q — `education.md` §4:
 * arxivlangan o'quvchi joriy ro'yxatlarda ko'rinmaydi, o'chirilgan login
 * esa o'qishni to'xtatmaydi. Tyutor guruhidagi o'quvchilar sanog'i bilan
 * AYNI qoida.
 */
async function loadClassStudents(classId) {
  return prisma.user.findMany({
    where: { role: ROLES.STUDENT, isArchived: false, classes: { some: { classId } } },
    select: { id: true, firstName: true, lastName: true, username: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
}

/**
 * HAR O'QUVCHINING MAVZU O'RNI.
 *
 * Qaytadigan qiymat har o'quvchi uchun:
 *   · `currentTopicNumber` — joriy darsdagi blokning BOSHI
 *   · `coveredThrough`     — blokning OXIRI (`step = 1` da ikkisi teng)
 *   · `startOrder`         — rejaning boshlanishi (test qamrovining pastki chegarasi)
 *   · `step`               — bitta darsda nechta mavzu
 *   · `inherited`          — shaxsiy reja yo'q, sinfdan meros
 *
 * ⚠️ TEST QAMROVI `coveredThrough` BO'YICHA. Blokning boshi olinsa, 3
 * qadamli rejada oxirgi darsda o'tilgan ikki mavzu qamrovdan tushib
 * qolardi — holbuki ular o'tilgan.
 *
 * ⚠️ XATO OTILMAYDI, SABAB QAYTARILADI (`diagnosticTopicScope` doktrinasi):
 * oldindan ko'rish ekrani HAMMA muammoni birdan ko'rsatishi kerak.
 *
 * @param {object} params
 * @param {string} params.classId
 * @param {string} params.subjectId
 * @param {string[]} [params.studentIds] - bo'sh bo'lsa sinfning hammasi
 * @param {string} params.actorId
 * @param {boolean} [params.ensure] - sinfga avtomatik ankor yozilsinmi
 * @returns {Promise<{
 *   class: object, subject: object, language: string, totalTopics: number,
 *   nextLesson: object|null, classCurrentTopic: number|null, classReason: string|null,
 *   byStudent: Map<string, object>
 * }>}
 */
async function resolveStudentTopics({
  classId,
  subjectId,
  studentIds = null,
  actorId,
  ensure = true,
}) {
  const { classDoc, subject, language } = await _loadContext(classId, subjectId);

  // ── SINFNING O'RNI — yagona manbadan ──
  //
  // ⚠️ `getSubjectClassTopics` CHAQIRILADI, ikkinchi hisob yozilmaydi: shu
  // tufayli meros olgan o'quvchining raqami jadval ekranidagi raqam bilan
  // hech qachon farq qilmaydi (`education.md` §13).
  const subjectView = await lessonTopicService.getSubjectClassTopics({
    subjectId,
    actorId,
    ensure,
  });
  const classRow = (subjectView.classes || []).find((row) => row.class?.id === classId) ?? null;

  const totalTopics = classRow?.totalTopics ?? subjectView.topicsByLanguage?.[language] ?? 0;

  const students = studentIds?.length
    ? await prisma.user.findMany({
        where: { id: { in: [...new Set(studentIds)] }, role: ROLES.STUDENT },
        select: { id: true, firstName: true, lastName: true, username: true },
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      })
    : await loadClassStudents(classId);

  const byStudent = new Map();
  if (students.length === 0) {
    return {
      class: classDoc,
      subject,
      language,
      languageLabel: languageLabel(language),
      totalTopics,
      nextLesson: classRow?.nextLesson ?? null,
      classCurrentTopic: classRow?.currentTopicNumber ?? null,
      classReason: classRow?.reason ?? null,
      students,
      byStudent,
    };
  }

  // ── JADVAL VA KALENDAR ──
  const template = await lessonTopicService.loadClassTemplate(classId);
  const slotsByDay = template.slotsBySubject.get(subjectId) ?? null;
  const ordersByDayNumber = template.ordersBySubject.get(subjectId) ?? new Map();

  const topicsBySubject = await lessonTopicService.loadTopics([subjectId], language);
  const topics = topicsBySubject.get(subjectId) ?? { byOrder: new Map(), last: 0 };

  const today = todayIsoTashkent();

  const plans = await prisma.studentTopicPlan.findMany({
    where: {
      classId,
      subjectId,
      studentId: { in: students.map((s) => s.id) },
      revokedAt: null,
    },
    orderBy: [{ date: "asc" }, { lessonOrder: "asc" }],
  });

  const plansByStudent = new Map();
  for (const row of plans) {
    if (!plansByStudent.has(row.studentId)) plansByStudent.set(row.studentId, []);
    plansByStudent.get(row.studentId).push(row);
  }

  /** Umumiy sabab — hamma o'quvchiga bir xil tegadigan holatlar. */
  let blockReason = null;
  if (!slotsByDay || slotsByDay.size === 0) {
    blockReason = PLAN_MISS_REASONS.noClassLesson;
  } else if (topics.last < 1) {
    blockReason =
      language === DEFAULT_TEACHING_LANGUAGE
        ? TOPIC_MISS_REASONS.noTopics
        : noTopicsForLanguage(languageLabel(language));
  }

  let slot = null;
  let isTeachingDay = () => true;

  if (!blockReason) {
    const oldestPlan = plans.length > 0 ? dayKey(plans[0].date) : today;
    const rangeFrom = [oldestPlan, today].sort()[0];
    const rangeTo = shiftIsoDays(today, lessonTopicService.ANCHOR_HORIZON_DAYS);
    ({ isTeachingDay } = await lessonTopicService.buildCalendar(rangeFrom, rangeTo));

    slot = lessonTopicService.findNextLessonSlot({
      slotsByDay,
      fromIso: today,
      isTeachingDay,
      nowMinutes: lessonTopicService.tashkentMinutes(),
    });
    if (!slot) blockReason = PLAN_MISS_REASONS.noUpcomingLesson;
  }

  const classCurrent = classRow?.currentTopicNumber ?? null;

  for (const student of students) {
    const rows = plansByStudent.get(student.id) ?? [];
    // Segmentlar: joriy darsga TA'SIR QILADIGAN oxirgi ankor.
    // ⚠️ Tanlov `lessonTopic.service.js` dagi YAGONA funksiyadan — sinf
    // kartasidagi "eng orqada / eng oldinda" kesimi ham shundan o'tadi.
    const plan = slot ? lessonTopicService.pickPlanForSlot(rows, slot.day) : null;

    const entry = {
      studentId: student.id,
      student,
      plan: plan ? publicPlan(plan) : null,
      // Hamma faol qator (tarix emas — KELAJAKDAGI ankorlar ham bor bo'lishi mumkin)
      planCount: rows.length,
      inherited: !plan,
      step: plan?.step ?? 1,
      startOrder: plan?.startOrder ?? 1,
      currentTopicNumber: null,
      currentTopicName: null,
      coveredThrough: null,
      coveredThroughName: null,
      totalTopics,
      reason: blockReason,
    };

    if (blockReason) {
      byStudent.set(student.id, entry);
      continue;
    }

    if (!plan) {
      // ── SINFDAN MEROS ──
      // Qadam 1, boshlanish 1: o'quvchi guruh bilan birga ketgan deb
      // qaraladi. Sabab ham sinfdan ko'chadi (ankor yo'q, mavzular
      // tugagan va h.k.) — ikkinchi nusxa yozilmasin.
      entry.currentTopicNumber = classCurrent;
      entry.coveredThrough = classCurrent;
      entry.reason = classRow?.reason ?? null;
    } else {
      // ⚠️ IKKINCHI HISOB YOZILMAYDI: sinf kartasidagi kesim ham AYNI
      // funksiyani chaqiradi (`lessonTopic.service.js`), ya'ni bitta bola
      // ikki ekranda ikki xil mavzuda ko'rinishi strukturaviy imkonsiz.
      const value = lessonTopicService.resolvePlanOrder({
        plan,
        slot,
        ordersByDayNumber,
        isTeachingDay,
        lastTopicOrder: topics.last,
      });
      entry.currentTopicNumber = value?.topicOrder ?? null;
      entry.coveredThrough = value?.topicOrderTo ?? value?.topicOrder ?? null;
      entry.reason = value?.reason ?? null;
    }

    entry.currentTopicName =
      entry.currentTopicNumber != null
        ? topics.byOrder.get(entry.currentTopicNumber)?.name ?? null
        : null;
    entry.coveredThroughName =
      entry.coveredThrough != null
        ? topics.byOrder.get(entry.coveredThrough)?.name ?? null
        : null;

    byStudent.set(student.id, entry);
  }

  return {
    class: classDoc,
    subject,
    language,
    languageLabel: languageLabel(language),
    totalTopics,
    nextLesson: classRow?.nextLesson ?? slot ?? null,
    classCurrentTopic: classCurrent,
    classReason: classRow?.reason ?? null,
    students,
    byStudent,
  };
}

/** Ankorni javob uchun qisqartiradi (ichki ustunlar tashqariga chiqmaydi). */
function publicPlan(row) {
  if (!row) return null;
  const day = dayKey(row.date);
  return {
    id: row.id,
    studentId: row.studentId,
    subjectId: row.subjectId,
    classId: row.classId,
    date: day,
    dateLabel: formatDateUz(row.date, { utc: true }),
    lessonOrder: row.lessonOrder,
    topicOrder: row.topicOrder,
    step: row.step,
    startOrder: row.startOrder,
    topicName: row.snapshot?.topicName ?? null,
    source: row.source,
    note: row.note,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/**
 * EKRAN: sinf + fan → o'quvchilar ro'yxati va har birining mavzu o'rni.
 *
 * "Dars mavzulari → Fan → Sinf" kartasiga bosilganda ochiladi.
 */
async function listClassStudentTopics({ classId, subjectId, actorId }) {
  const resolved = await resolveStudentTopics({ classId, subjectId, actorId });

  const rows = resolved.students.map((student) => {
    const entry = resolved.byStudent.get(student.id);
    return {
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        username: student.username,
      },
      plan: entry.plan,
      inherited: entry.inherited,
      step: entry.step,
      startOrder: entry.startOrder,
      currentTopicNumber: entry.currentTopicNumber,
      currentTopicName: entry.currentTopicName,
      coveredThrough: entry.coveredThrough,
      coveredThroughName: entry.coveredThroughName,
      reason: entry.reason,
      // Progress maxraji — sinfning TILIDAGI ro'yxat
      totalTopics: entry.totalTopics,
    };
  });

  return {
    class: resolved.class,
    subject: resolved.subject,
    language: resolved.language,
    languageLabel: resolved.languageLabel,
    totalTopics: resolved.totalTopics,
    nextLesson: resolved.nextLesson,
    classCurrentTopic: resolved.classCurrentTopic,
    classReason: resolved.classReason,
    students: rows,
    totals: {
      students: rows.length,
      // "Nechta bolaning shaxsiy rejasi bor" — ekranning asosiy savoli
      withPlan: rows.filter((row) => !row.inherited).length,
      inherited: rows.filter((row) => row.inherited).length,
    },
  };
}

/* ───────────────────────── yozish ───────────────────────── */

function _assertStep(value) {
  const step = Number(value ?? 1);
  if (!Number.isInteger(step) || step < 1 || step > MAX_STEP) {
    throw new BadRequestError(
      `Bitta darsda o'tiladigan mavzu soni 1 dan ${MAX_STEP} gacha bo'lishi kerak`,
    );
  }
  return step;
}

/**
 * O'QUVCHILARGA MAVZU O'RNI VA QADAM BELGILASH.
 *
 * ⚠️ ANKORNING KUNI VA DARSINI TIZIM TANLAYDI — sinfning KEYINGI darsi
 * (`setClassCurrentTopic` bilan AYNI qoida). Odam "qaysi darsga" degan
 * savolga javob bermaydi: u faqat "bu bola qaysi mavzuda va qanday
 * tezlikda" deydi. Shu tufayli bu ekrandagi raqam jadvaldagi raqam bilan
 * hech qachon farq qilmaydi.
 *
 * ⚠️ HAR O'QUVCHIGA ALOHIDA QATOR, "bir nechtasiga birdaniga" ham
 * (`batchId` bilan guruh) — `PayrollDeduction` doktrinasi: bekor qilish va
 * tarix qator bilan ishlaydi.
 *
 * ⚠️ HAR O'QUVCHI O'Z TRANZAKSIYASIDA: bittasi yiqilsa qolganlari baribir
 * yoziladi (`applyDefaultToAll` va `StudentCoinBlock` bilan AYNI qoida).
 * Natijada `written` / `skipped` / `failed` sanoqchilari qaytadi.
 *
 * @param {object} params
 * @param {string} params.classId
 * @param {string} params.subjectId
 * @param {string[]} params.studentIds
 * @param {number} params.topicOrder - o'quvchi qaysi mavzuda
 * @param {number} [params.step=1] - bitta darsda nechta mavzu
 * @param {number} [params.startOrder] - rejaning boshlanishi (sukut: `topicOrder`dan oshmaydigan 1)
 * @param {string} [params.note]
 * @param {string} params.actorId
 */
async function setStudentTopicPlans({
  classId,
  subjectId,
  studentIds,
  topicOrder,
  step,
  startOrder,
  note,
  actorId,
}) {
  const ids = [...new Set((Array.isArray(studentIds) ? studentIds : []).filter(Boolean))];
  if (ids.length === 0) throw new BadRequestError("Kamida bitta o'quvchi tanlanishi kerak");
  if (ids.length > MAX_BULK_STUDENTS) {
    throw new BadRequestError(
      `Bir amalda ${MAX_BULK_STUDENTS} tadan ko'p o'quvchi belgilanmaydi`,
    );
  }

  const { classDoc, subject, language } = await _loadContext(classId, subjectId);

  const number = Number(topicOrder);
  if (!Number.isInteger(number) || number < 1) {
    throw new BadRequestError("Mavzu raqami kamida 1 bo'lishi kerak");
  }
  const stepValue = _assertStep(step);

  // ⚠️ MAVZU SINFNING TILIDAGI RO'YXATDAN: tilsiz izlansa, rus guruhiga
  // o'zbek ro'yxatidagi mavzu biriktirilib qolardi.
  const topic = await prisma.topic.findUnique({
    where: { subjectId_language_order: { subjectId, language, order: number } },
    select: { id: true, name: true, order: true },
  });
  if (!topic) {
    throw new NotFoundError(
      `${number}-mavzu "${subject.name}" fanining ` +
        `${languageLabel(language)} tilidagi rejasida topilmadi`,
    );
  }

  // ⚠️ REJANING BOSHLANISHI JORIY MAVZUDAN OSHMAYDI: oshsa, test qamrovi
  // (`[startOrder … coveredThrough]`) teskari oraliq bo'lib, bitta ham
  // savol topilmasdi.
  const start = startOrder === undefined || startOrder === null || startOrder === ""
    ? 1
    : Number(startOrder);
  if (!Number.isInteger(start) || start < 1) {
    throw new BadRequestError("Rejaning boshlanishi kamida 1 bo'lishi kerak");
  }
  if (start > number) {
    throw new BadRequestError(
      `Rejaning boshlanishi (${start}) joriy mavzudan (${number}) katta bo'lmasligi kerak`,
    );
  }

  const cleanNote = typeof note === "string" ? note.trim().slice(0, NOTE_MAX) : null;

  // ── ANKOR NUQTASI — SINFNING KEYINGI DARSI ──
  const template = await lessonTopicService.loadClassTemplate(classId);
  const slotsByDay = template.slotsBySubject.get(subjectId);
  if (!slotsByDay || slotsByDay.size === 0) {
    throw new BadRequestError("Bu sinf jadvalida ushbu fandan dars yo'q");
  }

  const today = todayIsoTashkent();
  const { isTeachingDay } = await lessonTopicService.buildCalendar(
    today,
    shiftIsoDays(today, lessonTopicService.ANCHOR_HORIZON_DAYS),
  );
  const slot = lessonTopicService.findNextLessonSlot({
    slotsByDay,
    fromIso: today,
    isTeachingDay,
    nowMinutes: lessonTopicService.tashkentMinutes(),
  });
  if (!slot) {
    throw new BadRequestError("Yaqin kunlarda bu fandan dars yo'q — mavzuni keyinroq belgilang");
  }

  // ⚠️ RO'YXAT SERVERDA QAYTA TEKSHIRILADI: eskirgan ekran boshqa sinfning
  // (yoki arxivlangan) o'quvchisiga reja yozib yubormasligi kerak
  // (`LessonCredit` dagi "server ro'yxatni O'ZI oladi" bilan AYNI).
  const members = await prisma.user.findMany({
    where: {
      id: { in: ids },
      role: ROLES.STUDENT,
      isArchived: false,
      classes: { some: { classId } },
    },
    select: { id: true, firstName: true, lastName: true },
  });
  const memberMap = new Map(members.map((row) => [row.id, row]));

  const skipped = ids
    .filter((id) => !memberMap.has(id))
    .map((id) => ({ studentId: id, reason: "O'quvchi bu sinfda emas yoki arxivlangan" }));

  if (members.length === 0) {
    throw new BadRequestError(
      "Tanlangan o'quvchilar bu sinfda emas — ro'yxatni yangilang",
      { skipped },
    );
  }

  const batchId = generateId();
  const day = slot.day;
  const dateValue = parseDayKey(day);
  const written = [];
  const failed = [];

  for (const student of members) {
    const activeKey = `${student.id}|${subjectId}|${day}|${slot.lessonOrder}`;
    try {
      const row = await prisma.$transaction(async (tx) => {
        // Eski ankor O'CHIRILMAYDI — bekor qilinadi (tarix bitta qatorda
        // qolmaydi, lekin registrda qoladi).
        await tx.studentTopicPlan.updateMany({
          where: { activeKey },
          data: { activeKey: null, revokedAt: new Date(), revokedBy: actorId },
        });

        return tx.studentTopicPlan.create({
          data: {
            studentId: student.id,
            subjectId,
            classId,
            date: dateValue,
            lessonOrder: slot.lessonOrder,
            topicOrder: number,
            step: stepValue,
            startOrder: start,
            source: "manual",
            note: cleanNote || null,
            snapshot: {
              studentName: `${student.lastName ?? ""} ${student.firstName ?? ""}`.trim(),
              className: classDoc.name,
              subjectName: subject.name,
              topicName: topic.name,
              language,
            },
            activeKey,
            batchId,
            createdBy: actorId,
          },
        });
      });
      written.push(publicPlan(row));
    } catch (error) {
      logger.warn(
        `[StudentTopicPlan] Yozilmadi (o'quvchi ${student.id}, fan ${subjectId}): ${error.message}`,
      );
      failed.push({ studentId: student.id, reason: error.message });
    }
  }

  logger.info(
    `[StudentTopicPlan] ${classDoc.name} / ${subject.name} — ${written.length} o'quvchiga ` +
      `${number}-mavzu, qadam ${stepValue}`,
  );

  return {
    batchId,
    class: classDoc,
    subject,
    language,
    topic,
    step: stepValue,
    startOrder: start,
    anchor: { date: day, dateLabel: formatDateUz(dateValue, { utc: true }), lessonOrder: slot.lessonOrder },
    written,
    skipped,
    failed,
    totals: { requested: ids.length, written: written.length, skipped: skipped.length, failed: failed.length },
  };
}

/**
 * SHAXSIY REJANI BEKOR QILISH — o'quvchi SINFDAN MEROS olishga qaytadi.
 *
 * ⚠️ Qator o'chirilmaydi. Bekor qilingach mavzu OLDINGI shaxsiy ankordan
 * sanaladi; shaxsiy ankor umuman qolmasa — sinfning o'rni (`inherited`).
 */
async function revokeStudentTopicPlan({ id, actorId }) {
  const row = await prisma.studentTopicPlan.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Reja topilmadi");
  if (row.revokedAt) throw new ConflictError("Bu reja allaqachon bekor qilingan");

  const updated = await prisma.studentTopicPlan.updateMany({
    where: { id, revokedAt: null },
    data: { activeKey: null, revokedAt: new Date(), revokedBy: actorId },
  });
  if (updated.count !== 1) {
    throw new ConflictError("Reja shu orada o'zgardi — sahifani yangilang");
  }

  return {
    id,
    studentId: row.studentId,
    subjectId: row.subjectId,
    classId: row.classId,
  };
}

/** Bitta o'quvchining shu fandagi reja tarixi (oxirgilari birinchi). */
async function listStudentTopicPlans({ studentId, subjectId, limit = 50 }) {
  const rows = await prisma.studentTopicPlan.findMany({
    where: { studentId, ...(subjectId ? { subjectId } : {}) },
    orderBy: [{ createdAt: "desc" }],
    take: Math.min(Math.max(Number(limit) || 50, 1), 200),
  });

  return rows.map((row) => ({
    ...publicPlan(row),
    revokedAt: row.revokedAt,
    isActive: row.revokedAt === null,
    studentName: row.snapshot?.studentName ?? null,
    className: row.snapshot?.className ?? null,
    subjectName: row.snapshot?.subjectName ?? null,
    languageLabel: row.snapshot?.language ? languageLabel(row.snapshot.language) : null,
  }));
}

module.exports = {
  MAX_STEP,
  MAX_BULK_STUDENTS,
  NOTE_MAX,
  PLAN_MISS_REASONS,
  loadClassStudents,
  resolveStudentTopics,
  listClassStudentTopics,
  setStudentTopicPlans,
  revokeStudentTopicPlan,
  listStudentTopicPlans,
  publicPlan,
};
