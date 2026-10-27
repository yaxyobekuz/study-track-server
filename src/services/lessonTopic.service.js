/**
 * DARS JADVALIDAGI MAVZULAR — ankor (`LessonTopicBinding`) + sanoq.
 *
 * ── MUAMMO ────────────────────────────────────
 *
 * Dars jadvali — HAFTALIK SHABLON, unda sana yo'q (`Schedule`,
 * `@@unique([classId, day])`). Mavzu esa sanaga bog'liq. Ilgari bog'lovchi
 * narsa sifatida sinf+fan uchun BITTA "joriy mavzu raqami" turardi
 * (`ClassSubjectProgress`) va uni har daqiqada ishlaydigan cron dars tugagan
 * sari oshirardi. Unda mavzu faqat "hozir" uchun ma'lum edi: jadvalga
 * mavzu chiqarish ham, "keyingi haftada qaysi mavzu" degan savolga javob
 * berish ham mumkin emas edi.
 *
 * ── YECHIM ────────────────────────────────────
 *
 * Saqlanadigan narsa — ANKOR: "16-oktabr, 3-darsda 50-mavzu". Qolgan hamma
 * dars o'sha ankordan SANAB chiqariladi (`helpers/lessonTopic.js`). Shu
 * tufayli:
 *   · o'tgan va kelasi haftalarning mavzusi ham hisoblanadi;
 *   · cron kerak emas — server bir daqiqa ishlamay qolsa ham raqam surilmaydi;
 *   · "50-mavzuni bugungi darsga biriktirdim" → keyingi dars 51, 52 … o'zidan.
 *
 * ⚠️ ANKOR BO'LMASA — TIZIM O'ZI QO'YADI (`ensureAnchors`, `source: "auto"`).
 * Sanoqning boshlanish nuqtasi bo'lmasa, bir xil dars har kuni boshqa mavzuni
 * ko'rsatardi. Avtomatik ankor bugundan keyingi birinchi darsga tushadi va
 * 1-mavzudan boshlanadi; eski hisoblagichda qiymat bo'lsa — O'SHANDAN
 * (maktabning haqiqiy joriy o'rni yo'qolmasin).
 *
 * ⚠️ YOZUV O'QISH YO'LIDA. `ensureAnchors` GET so'rovida ham ishlaydi va bu
 * ataylab: ankor yozilmaguncha javob BARQAROR emas (ertaga o'sha dars boshqa
 * mavzuni ko'rsatardi). Yozuv har sinf+fan uchun UMRIDA BIR MARTA bo'ladi va
 * `activeKey` yagona indeksi bilan idempotent — parallel ikki so'rov ikkinchi
 * qatorni yoza olmaydi.
 *
 * ⚠️ BIR NECHTA ANKOR — SEGMENTLARGA BO'LINADI. Oxirgi ankor undan KEYINGI
 * darslarni qayta yozadi, oldingilari o'z davrida qoladi: 1-oktabrda
 * 10-mavzu, 15-oktabrda 50-mavzu biriktirilgan bo'lsa, 14-oktabr hali ham
 * o'z raqamini ko'rsatadi. Aks holda bitta tuzatish butun tarixni qayta
 * yozardi.
 */

const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const { generateId } = require("../utils/idGenerator");
const { DAYS_UZ } = require("../utils/constants");
const { BadRequestError, NotFoundError, ConflictError } = require("../utils/errors");
const {
  currentDayDate,
  parseDayDate,
  todayIsoTashkent,
  shiftIsoDays,
  monthKeyOfDate,
} = require("../helpers/month.helpers");
const { formatDateUz, formatDateRangeUz } = require("../helpers/date.helpers");
const { dayKey } = require("../helpers/lessonHours");
const {
  MAX_SPAN_DAYS,
  TOPIC_MISS_REASONS,
  bindingActiveKey,
  lessonKey,
  parseDayKey,
  daysBetween,
  topicOrdersForDays,
} = require("../helpers/lessonTopic");
const { buildHolidaySet } = require("./holiday.service");
const { getVacationSet } = require("./vacationMonth.service");

// `ScheduleDay` enum qiymati → `Date#getUTCDay()` raqami (0 = yakshanba).
// `DAYS_UZ` yagona manba — nusxa massiv yozilmaydi.
const DAY_TO_NUMBER = new Map(DAYS_UZ.map((day, index) => [day, index]));

/** Avtomatik ankor qidiriladigan eng uzoq oldinga qarash (kun). */
const ANCHOR_HORIZON_DAYS = 60;

/** Qo'lda biriktirishda sanaga qo'yiladigan chegara (bugundan, kun). */
const BIND_WINDOW_DAYS = 370;

const NOTE_MAX = 300;
const MAX_LESSON_ORDER = 30;

/* ───────────────────────── vaqt / kun ───────────────────────── */

/** Toshkent devor-soati — yarim tundan o'tgan daqiqalar. */
function tashkentMinutes(now = new Date()) {
  const shifted = new Date(now.getTime() + 5 * 3600000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** "HH:MM" → daqiqa; yaroqsiz bo'lsa `null`. */
function timeToMinutes(time) {
  if (typeof time !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Haftaning DUSHANBASI — berilgan kun qaysi haftaga tushsa.
 *
 * Yakshanba (`getUTCDay() === 0`) OLDINGI haftaga tegishli deb olinadi:
 * jadvalda yakshanba yo'q va u haftaning oxiri sifatida ko'rinishi kerak
 * (`DAYS_UZ` da u 0 bo'lsa ham, o'quv haftasi dushanbadan boshlanadi).
 *
 * @param {string} iso - "YYYY-MM-DD"
 * @returns {string} "YYYY-MM-DD"
 */
function weekStartOf(iso) {
  const date = parseDayKey(iso);
  if (!date) return null;
  const dayNumber = date.getUTCDay();
  const shift = dayNumber === 0 ? -6 : 1 - dayNumber;
  return shiftIsoDays(iso, shift);
}

/** Haftaning dushanbadan shanbagacha bo'lgan 6 kuni. */
function weekDays(weekStartIso) {
  return Array.from({ length: 6 }, (_, index) => shiftIsoDays(weekStartIso, index));
}

/* ───────────────────────── jadval shabloni ───────────────────────── */

/**
 * Sinfning haftalik shabloni — fan kesimida.
 *
 * @param {string} classId
 * @returns {Promise<{
 *   slotsBySubject: Map<string, Map<number, Array<{order: number, endTime: string|null}>>>,
 *   ordersBySubject: Map<string, Map<number, number[]>>,
 *   subjectIds: string[],
 *   lessonsByDay: Map<number, Array<object>>
 * }>}
 */
async function loadClassTemplate(classId) {
  const schedules = await prisma.schedule.findMany({
    where: { classId },
    include: { lessons: { orderBy: { order: "asc" } } },
  });

  const slotsBySubject = new Map();
  const ordersBySubject = new Map();
  const lessonsByDay = new Map();
  const subjectIds = new Set();

  for (const schedule of schedules) {
    const dayNumber = DAY_TO_NUMBER.get(schedule.day);
    if (dayNumber === undefined) continue; // ma'lumot buzilgan — tashlanadi

    const lessons = [...(schedule.lessons || [])].sort((a, b) => a.order - b.order);
    lessonsByDay.set(dayNumber, lessons);

    for (const lesson of lessons) {
      if (!lesson.subjectId) continue;
      subjectIds.add(lesson.subjectId);

      if (!slotsBySubject.has(lesson.subjectId)) slotsBySubject.set(lesson.subjectId, new Map());
      const byDay = slotsBySubject.get(lesson.subjectId);
      if (!byDay.has(dayNumber)) byDay.set(dayNumber, []);
      byDay.get(dayNumber).push({ order: lesson.order, endTime: lesson.endTime });
    }
  }

  // Tartiblar — sanoq uchun o'sish bo'yicha, takrorisiz (jadvalda bitta
  // katakka ikki fan tushib qolsa sanoq ikki marta surilmasin)
  for (const [subjectId, byDay] of slotsBySubject) {
    const orders = new Map();
    for (const [dayNumber, slots] of byDay) {
      slots.sort((a, b) => a.order - b.order);
      orders.set(dayNumber, [...new Set(slots.map((s) => s.order))]);
    }
    ordersBySubject.set(subjectId, orders);
  }

  return {
    slotsBySubject,
    ordersBySubject,
    subjectIds: [...subjectIds],
    lessonsByDay,
  };
}

/* ───────────────────────── kalendar ───────────────────────── */

/**
 * Dars o'tiladigan kunlar filtri.
 *
 * Uchta istisno bir joyda: yakshanba, bayram (`Holiday`) va ta'til oyi
 * (`VacationMonth`). Uchalasi ham `lessonHours` da soat hisobidan
 * chiqariladi — mavzu sanog'i ham AYNI kunlarni o'tkazib yuborishi shart,
 * aks holda "o'tilgan soat" bilan "o'tilgan mavzu" bir-biridan uzoqlashardi.
 *
 * `offReason` ham shu yerdan qaytadi: ekranda "nega bu kunda mavzu yo'q"
 * degan savol darhol javob topishi kerak, aks holda foydalanuvchi uni
 * nosozlik deb o'ylardi.
 *
 * @param {string} fromIso
 * @param {string} toIso
 * @returns {Promise<{isTeachingDay: (day: string) => boolean, offReason: (day: string) => string|null}>}
 */
async function buildCalendar(fromIso, toIso) {
  const from = parseDayKey(fromIso);
  const to = parseDayKey(toIso);

  const [holidaySet, vacationSet] = await Promise.all([
    from && to && from <= to ? buildHolidaySet(from, to) : Promise.resolve(new Set()),
    getVacationSet(),
  ]);

  const offReason = (day) => {
    const date = parseDayKey(day);
    if (!date) return "Sana noto'g'ri";
    if (date.getUTCDay() === 0) return "Yakshanba";
    if (holidaySet.has(day)) return "Bayram kuni";
    if (vacationSet.has(monthKeyOfDate(date))) return "Ta'til oyi";
    return null;
  };

  return { isTeachingDay: (day) => offReason(day) === null, offReason };
}

/* ───────────────────────── mavzular ───────────────────────── */

/**
 * Fanlarning mavzulari — tartib bo'yicha xarita va oxirgi raqam.
 *
 * ⚠️ FAQAT RAQAM VA NOM O'QILADI. Sinfda o'nlab fan, har fanda yuzlab
 * (ingliz tilida 1000 dan ortiq) mavzu bo'ladi, sanoq uchun esa faqat
 * raqam kerak. Daraja, kitob va "Nimalar o'rgatiladi" JAVOBGA TUSHADIGAN
 * mavzular uchun alohida o'qiladi (`attachTopicDetails`) — hammasini bu
 * yerda olish har so'rovda yuzlab kilobayt ortiqcha o'qish bo'lardi.
 *
 * @param {string[]} subjectIds
 * @returns {Promise<Map<string, {byOrder: Map<number, object>, last: number}>>}
 */
async function loadTopics(subjectIds) {
  const result = new Map();
  if (subjectIds.length === 0) return result;

  const topics = await prisma.topic.findMany({
    where: { subjectId: { in: subjectIds } },
    select: { id: true, subjectId: true, order: true, name: true },
    orderBy: { order: "asc" },
  });

  for (const topic of topics) {
    if (!result.has(topic.subjectId)) {
      result.set(topic.subjectId, { byOrder: new Map(), last: 0 });
    }
    const entry = result.get(topic.subjectId);
    entry.byOrder.set(topic.order, topic);
    if (topic.order > entry.last) entry.last = topic.order;
  }

  return result;
}

/**
 * HAL QILINGAN DARSLARNING MAVZUSIGA DARAJA, KITOB VA MAZMUNNI QO'SHADI.
 *
 * Faqat `byLesson` dagi (ya'ni javobga tushadigan) mavzular o'qiladi — haftada
 * bir necha o'nta, fanning butun ro'yxati emas.
 *
 * ⚠️ Uchala maydon IXTIYORIY: faylda bo'lmasa `null` qaytadi va bu xato
 * emas — ekran shunchaki ko'rsatmaydi.
 *
 * @param {Map<string, object>} byLesson - joyida yangilanadi
 */
async function attachTopicDetails(byLesson) {
  const ids = new Set();
  for (const entry of byLesson.values()) if (entry.topic?.id) ids.add(entry.topic.id);
  if (ids.size === 0) return;

  const rows = await prisma.topic.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, level: true, book: true, description: true },
  });
  const details = new Map(rows.map((row) => [row.id, row]));

  for (const entry of byLesson.values()) {
    if (!entry.topic) continue;
    const row = details.get(entry.topic.id);
    // ⚠️ YANGI obyekt: `topicsBySubject` dagi umumiy obyekt boshqa darslar
    // bilan bo'lishiladi va uni joyida o'zgartirish kutilmagan ta'sir berardi.
    entry.topic = {
      ...entry.topic,
      level: row?.level || null,
      book: row?.book || null,
      description: row?.description || null,
    };
  }
}

/* ───────────────────────── avtomatik ankor ───────────────────────── */

/**
 * Fanning BUGUNDAN KEYINGI birinchi darsi (kun + tartib).
 *
 * ⚠️ BUGUN TUGAGAN DARS HISOBGA OLINMAYDI. Eski hisoblagich (`cron`) dars
 * TUGAGANDA oshar edi, ya'ni undagi raqam "hali tugamagan birinchi dars"
 * ning mavzusi. Avtomatik ankor ham aynan o'sha darsga tushishi kerak —
 * aks holda seed bir mavzuga siljib ketardi.
 *
 * @returns {{day: string, lessonOrder: number}|null}
 */
function findNextLessonSlot({ slotsByDay, fromIso, isTeachingDay, nowMinutes }) {
  if (!slotsByDay || slotsByDay.size === 0) return null;

  for (let offset = 0; offset <= ANCHOR_HORIZON_DAYS; offset += 1) {
    const day = shiftIsoDays(fromIso, offset);
    if (!isTeachingDay(day)) continue;

    const date = parseDayKey(day);
    const slots = slotsByDay.get(date.getUTCDay()) ?? [];

    for (const slot of slots) {
      if (offset === 0) {
        const endsAt = timeToMinutes(slot.endTime);
        // Vaqti ko'rsatilmagan dars "tugagan" deb hisoblanmaydi: eski cron
        // ham faqat `endTime` bor darsni oshirardi.
        if (endsAt != null && endsAt <= nowMinutes) continue;
      }
      return { day, lessonOrder: slot.order };
    }
  }

  return null;
}

/**
 * ANKORSIZ QOLGAN FANLARGA AVTOMATIK ANKOR YOZADI.
 *
 * @returns {Promise<Array<object>>} yangi yozilgan ankorlar
 */
async function ensureAnchors({
  classId,
  className,
  subjectIds,
  slotsBySubject,
  topicsBySubject,
  subjectNames,
  isTeachingDay,
  actorId,
}) {
  if (subjectIds.length === 0) return [];

  const existing = await prisma.lessonTopicBinding.findMany({
    where: { classId, subjectId: { in: subjectIds }, revokedAt: null },
    select: { subjectId: true },
    distinct: ["subjectId"],
  });
  const anchored = new Set(existing.map((row) => row.subjectId));

  const missing = subjectIds.filter((id) => !anchored.has(id));
  if (missing.length === 0) return [];

  // Eski hisoblagich — faqat SEED uchun o'qiladi (keyin unga hech kim tegmaydi)
  const progressRows = await prisma.classSubjectProgress.findMany({
    where: { classId, subjectId: { in: missing } },
    select: { subjectId: true, currentTopicNumber: true },
  });
  const progressMap = new Map(progressRows.map((p) => [p.subjectId, p.currentTopicNumber]));

  const today = todayIsoTashkent();
  const nowMinutes = tashkentMinutes();
  const rows = [];

  for (const subjectId of missing) {
    const topics = topicsBySubject.get(subjectId);
    // Mavzular yuklanmagan fanga ankor yozish — bo'sh yozuv
    if (!topics || topics.last < 1) continue;

    const slot = findNextLessonSlot({
      slotsByDay: slotsBySubject.get(subjectId),
      fromIso: today,
      isTeachingDay,
      nowMinutes,
    });
    if (!slot) continue;

    const seed = progressMap.get(subjectId) ?? 1;
    const topicOrder = Math.min(Math.max(seed, 1), topics.last);
    const topic = topics.byOrder.get(topicOrder);

    rows.push({
      id: generateId(),
      classId,
      subjectId,
      date: parseDayKey(slot.day),
      lessonOrder: slot.lessonOrder,
      topicOrder,
      source: "auto",
      note: null,
      snapshot: {
        className: className ?? null,
        subjectName: subjectNames.get(subjectId) ?? null,
        topicName: topic?.name ?? null,
      },
      activeKey: bindingActiveKey(classId, subjectId, slot.day, slot.lessonOrder),
      createdBy: actorId,
    });
  }

  if (rows.length === 0) return [];

  // Parallel so'rov ikkinchi qatorni yoza olmaydi (`activeKey` yagona)
  await prisma.lessonTopicBinding.createMany({ data: rows, skipDuplicates: true });

  return prisma.lessonTopicBinding.findMany({
    where: { activeKey: { in: rows.map((row) => row.activeKey) } },
  });
}

/* ───────────────────────── asosiy hal qiluvchi ───────────────────────── */

/**
 * BERILGAN KUNLARDAGI HAR BIR DARSNING MAVZUSI.
 *
 * Bitta nuqta: hafta ko'rinishi ham, bahoga mavzu biriktirish ham, "fan →
 * sinflar" ekrani ham shuni chaqiradi. Ikkita mustaqil hisob bo'lsa, jurnalda
 * bir mavzu, jadvalda boshqa mavzu turardi.
 *
 * @param {object} input
 * @param {string} input.classId
 * @param {string[]} input.days - "YYYY-MM-DD"
 * @param {string} input.actorId
 * @param {boolean} [input.ensure] - ankorsiz fanlarga avtomatik ankor yozilsinmi
 * @param {boolean} [input.withDetails] - mavzuga daraja, kitob va mazmun qo'shilsinmi
 * @returns {Promise<{
 *   template: object,
 *   topicsBySubject: Map<string, object>,
 *   byLesson: Map<string, object>,
 *   anchorsBySubject: Map<string, Array<object>>
 * }>}
 */
async function resolveLessonTopics({ classId, days, actorId, ensure = true, withDetails = false }) {
  const targets = [...new Set(days)].sort();
  const template = await loadClassTemplate(classId);
  const topicsBySubject = await loadTopics(template.subjectIds);

  const byLesson = new Map();
  const anchorsBySubject = new Map();

  if (targets.length === 0 || template.subjectIds.length === 0) {
    const empty = await buildCalendar(targets[0] ?? todayIsoTashkent(), targets[targets.length - 1] ?? todayIsoTashkent());
    const classRow = await prisma.class.findUnique({
      where: { id: classId },
      select: { id: true, name: true },
    });
    return {
      template,
      topicsBySubject,
      byLesson,
      anchorsBySubject,
      subjectNames: new Map(),
      classDoc: classRow,
      isTeachingDay: empty.isTeachingDay,
      offReason: empty.offReason,
    };
  }

  const [classDoc, subjects] = await Promise.all([
    prisma.class.findUnique({ where: { id: classId }, select: { id: true, name: true } }),
    prisma.subject.findMany({
      where: { id: { in: template.subjectIds } },
      select: { id: true, name: true },
    }),
  ]);
  const subjectNames = new Map(subjects.map((s) => [s.id, s.name]));

  const today = todayIsoTashkent();
  const firstTarget = targets[0];
  const lastTarget = targets[targets.length - 1];

  // Mavjud ankorlar — kalendar oynasini ular ham belgilaydi
  let bindings = await prisma.lessonTopicBinding.findMany({
    where: { classId, subjectId: { in: template.subjectIds }, revokedAt: null },
    orderBy: [{ date: "asc" }, { lessonOrder: "asc" }],
  });

  const oldestAnchor = bindings.length > 0 ? dayKey(bindings[0].date) : null;
  // Oyna ikkala yo'l uchun ham yetarli bo'lishi kerak: sanoq (ankordan
  // maqsadgacha) va avtomatik ankor qidiruvi (bugundan 60 kun oldinga).
  let rangeFrom = [oldestAnchor, firstTarget, today].filter(Boolean).sort()[0];
  const rangeTo = [lastTarget, shiftIsoDays(today, ANCHOR_HORIZON_DAYS)].sort().pop();
  // Buzuq (juda eski) ankor butun oynani cho'zib yubormasin
  if ((daysBetween(rangeFrom, rangeTo) ?? 0) > MAX_SPAN_DAYS + ANCHOR_HORIZON_DAYS) {
    rangeFrom = shiftIsoDays(rangeTo, -(MAX_SPAN_DAYS + ANCHOR_HORIZON_DAYS));
  }

  const { isTeachingDay, offReason } = await buildCalendar(rangeFrom, rangeTo);

  if (ensure) {
    // ⚠️ AVTOMATIK ANKOR O'QISHNI YIQITMAYDI. U qulaylik: yozib bo'lmasa
    // (baza band, ruxsat, poyga) jadval baribir ko'rinishi kerak — faqat
    // mavzu o'rnida "Mavzu biriktirilmagan" turadi. Yozuvni majburiy qilsak,
    // bitta kutilmagan xato butun jadval sahifasini yopib qo'yardi.
    try {
      const created = await ensureAnchors({
        classId,
        className: classDoc?.name ?? null,
        subjectIds: template.subjectIds,
        slotsBySubject: template.slotsBySubject,
        topicsBySubject,
        subjectNames,
        isTeachingDay,
        actorId,
      });
      if (created.length > 0) {
        bindings = [...bindings, ...created].sort(
          (a, b) => a.date - b.date || a.lessonOrder - b.lessonOrder,
        );
      }
    } catch (error) {
      logger.warn(`[LessonTopic] Avtomatik ankor yozilmadi (${classId}): ${error.message}`);
    }
  }

  const bindingsBySubject = new Map();
  for (const row of bindings) {
    if (!bindingsBySubject.has(row.subjectId)) bindingsBySubject.set(row.subjectId, []);
    bindingsBySubject.get(row.subjectId).push(row);
  }

  for (const subjectId of template.subjectIds) {
    const ordersByDayNumber = template.ordersBySubject.get(subjectId) ?? new Map();
    const topics = topicsBySubject.get(subjectId);
    const subjectAnchors = bindingsBySubject.get(subjectId) ?? [];
    anchorsBySubject.set(subjectId, subjectAnchors);

    // Fanga mavzu yuklanmagan — sanaydigan narsa yo'q
    if (!topics || topics.last < 1) {
      fillMiss(byLesson, targets, ordersByDayNumber, TOPIC_MISS_REASONS.noTopics, subjectId);
      continue;
    }

    if (subjectAnchors.length === 0) {
      fillMiss(byLesson, targets, ordersByDayNumber, TOPIC_MISS_REASONS.noAnchor, subjectId);
      continue;
    }

    // SEGMENTLAR: maqsad oynasidan oldingi ankorlardan faqat OXIRGISI kerak,
    // oyna ichidagilarning HAMMASI kerak — har biri o'zidan keyingi darslarni
    // qayta yozadi (tartib bo'yicha qo'llanadi).
    const before = subjectAnchors.filter((row) => dayKey(row.date) < firstTarget);
    const within = subjectAnchors.filter((row) => {
      const day = dayKey(row.date);
      return day >= firstTarget && day <= lastTarget;
    });
    const relevant = [...before.slice(-1), ...within];

    if (relevant.length === 0) {
      // Hamma ankor maqsad oynasidan KEYIN — oyna ankordan oldin
      fillMiss(byLesson, targets, ordersByDayNumber, TOPIC_MISS_REASONS.beforeAnchor, subjectId);
      continue;
    }

    relevant.forEach((row, index) => {
      const resolved = topicOrdersForDays({
        anchor: {
          day: dayKey(row.date),
          lessonOrder: row.lessonOrder,
          topicOrder: row.topicOrder,
        },
        ordersByDayNumber,
        targetDays: targets,
        isTeachingDay,
        lastTopicOrder: topics.last,
      });

      for (const [key, value] of resolved) {
        // ⚠️ Faqat BIRINCHI (eng eski) ankor "ankordan oldin" deb belgilaydi:
        // keyingi ankorlarning shu belgisi oldingi ankor to'g'ri hisoblagan
        // kunlarni bo'sh qilib yuborardi.
        if (index > 0 && value.reason === TOPIC_MISS_REASONS.beforeAnchor) continue;

        const topic =
          value.topicOrder != null ? topics.byOrder.get(value.topicOrder) ?? null : null;

        byLesson.set(key, {
          subjectId,
          topicOrder: value.topicOrder,
          topic,
          // Raqam bor-u, mavzu yo'q — ro'yxatda bo'shliq (faylda nomi bo'sh
          // qator). Sababsiz qoldirilsa ekranda "Mavzu aniqlanmadi" turib,
          // nimani tuzatish kerakligi noma'lum qolardi.
          reason:
            value.reason ??
            (value.topicOrder != null && !topic ? TOPIC_MISS_REASONS.missingTopic : null),
          binding: row,
        });
      }
    });
  }

  if (withDetails) await attachTopicDetails(byLesson);

  return {
    template,
    topicsBySubject,
    byLesson,
    anchorsBySubject,
    subjectNames,
    classDoc,
    isTeachingDay,
    offReason,
  };
}

/** Mavzusi topilmagan darslarni sabab bilan to'ldiradi. */
function fillMiss(byLesson, targets, ordersByDayNumber, reason, subjectId = null) {
  for (const day of targets) {
    const date = parseDayKey(day);
    if (!date) continue;
    for (const order of ordersByDayNumber.get(date.getUTCDay()) ?? []) {
      byLesson.set(lessonKey(day, order), {
        subjectId,
        topicOrder: null,
        topic: null,
        reason,
        binding: null,
      });
    }
  }
}


/* ───────────────────────── ommaviy yo'llar ───────────────────────── */

/** Ankorni javob uchun qisqartiradi (ichki ustunlar tashqariga chiqmaydi). */
function publicBinding(row) {
  if (!row) return null;
  const day = dayKey(row.date);
  return {
    id: row.id,
    subjectId: row.subjectId,
    date: day,
    dateLabel: formatDateUz(row.date, { utc: true }),
    lessonOrder: row.lessonOrder,
    topicOrder: row.topicOrder,
    topicName: row.snapshot?.topicName ?? null,
    source: row.source,
    note: row.note,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/**
 * SINFNING BIR HAFTALIK JADVALI — har bir darsda mavzusi bilan.
 *
 * @param {object} input
 * @param {string} input.classId
 * @param {string} [input.week] - haftaning istalgan kuni ("YYYY-MM-DD"); bo'sh — joriy hafta
 * @param {string} input.actorId
 * @returns {Promise<object>}
 */
async function getClassWeekTopics({ classId, week, actorId }) {
  const classDoc = await prisma.class.findUnique({
    where: { id: classId },
    select: { id: true, name: true },
  });
  if (!classDoc) throw new NotFoundError("Sinf topilmadi");

  const today = todayIsoTashkent();
  const requested = week ? dayKey(parseDayDate(week, "Hafta")) : today;
  const start = weekStartOf(requested);
  const days = weekDays(start);
  const end = days[days.length - 1];

  const resolved = await resolveLessonTopics({ classId, days, actorId, withDetails: true });
  const { template, topicsBySubject, byLesson, anchorsBySubject, subjectNames, offReason } =
    resolved;

  // O'qituvchilar — jadvalning o'zi ularning ismini ko'rsatadi
  const teacherIds = new Set();
  for (const lessons of template.lessonsByDay.values()) {
    for (const lesson of lessons) if (lesson.teacherId) teacherIds.add(lesson.teacherId);
  }
  const teachers = await prisma.user.findMany({
    where: { id: { in: [...teacherIds] } },
    select: { id: true, firstName: true, lastName: true },
  });
  const teacherMap = new Map(teachers.map((t) => [t.id, t]));

  const dayRows = days.map((day) => {
    const date = parseDayKey(day);
    const dayName = DAYS_UZ[date.getUTCDay()];
    const off = offReason(day);
    const lessons = (template.lessonsByDay.get(date.getUTCDay()) ?? []).map((lesson) => {
      const resolvedTopic = byLesson.get(lessonKey(day, lesson.order)) ?? null;
      const binding = resolvedTopic?.binding ?? null;
      const isAnchor =
        Boolean(binding) &&
        dayKey(binding.date) === day &&
        binding.lessonOrder === lesson.order;

      return {
        order: lesson.order,
        startTime: lesson.startTime,
        endTime: lesson.endTime,
        subject: lesson.subjectId
          ? { id: lesson.subjectId, name: subjectNames.get(lesson.subjectId) ?? null }
          : null,
        teacher: teacherMap.get(lesson.teacherId)
          ? {
              id: lesson.teacherId,
              firstName: teacherMap.get(lesson.teacherId).firstName,
              lastName: teacherMap.get(lesson.teacherId).lastName,
            }
          : null,
        // Daraja, kitob va "Nimalar o'rgatiladi" — ixtiyoriy (`null` bo'lishi mumkin)
        topic: resolvedTopic?.topic
          ? {
              id: resolvedTopic.topic.id,
              order: resolvedTopic.topic.order,
              name: resolvedTopic.topic.name,
              level: resolvedTopic.topic.level,
              book: resolvedTopic.topic.book,
              description: resolvedTopic.topic.description,
            }
          : null,
        // Dars o'tilmaydigan kunda mavzu sanalmaydi — sabab o'sha kunniki
        topicReason: off ?? resolvedTopic?.reason ?? null,
        // Mavzu AYNAN shu darsga qo'lda biriktirilganmi
        isAnchor,
        anchorSource: isAnchor ? binding.source : null,
        bindingId: isAnchor ? binding.id : null,
        bindingNote: isAnchor ? binding.note : null,
      };
    });

    return {
      day: dayName,
      dayLabel: dayName.charAt(0).toUpperCase() + dayName.slice(1),
      date: day,
      dateLabel: formatDateUz(date, { utc: true }),
      isToday: day === today,
      isTeachingDay: off === null,
      offReason: off,
      lessons,
    };
  });

  const subjects = template.subjectIds
    .map((subjectId) => {
      const topics = topicsBySubject.get(subjectId);
      const anchors = anchorsBySubject.get(subjectId) ?? [];
      return {
        id: subjectId,
        name: subjectNames.get(subjectId) ?? null,
        topicCount: topics ? topics.byOrder.size : 0,
        lastTopicOrder: topics ? topics.last : 0,
        anchor: publicBinding(anchors[anchors.length - 1] ?? null),
      };
    })
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  return {
    class: classDoc,
    week: {
      start,
      end,
      label: formatDateRangeUz(parseDayKey(start), parseDayKey(end), { utc: true }),
      isCurrent: start === weekStartOf(today),
    },
    days: dayRows,
    subjects,
  };
}

/**
 * DARSGA MAVZU BIRIKTIRISH.
 *
 * ⚠️ Eski ankor O'CHIRILMAYDI — bekor qilinadi va o'rniga yangisi yoziladi
 * (`activeKey` NULL ga tushadi). "Nega bu darsda 50-mavzu turibdi" degan
 * savolga javob tarixda qolishi kerak.
 */
async function bindLessonTopic({
  classId,
  subjectId,
  date,
  lessonOrder,
  topicOrder,
  note,
  actorId,
}) {
  const order = Number(lessonOrder);
  if (!Number.isInteger(order) || order < 1 || order > MAX_LESSON_ORDER) {
    throw new BadRequestError("Dars tartibi noto'g'ri");
  }

  const topicNumber = Number(topicOrder);
  if (!Number.isInteger(topicNumber) || topicNumber < 1) {
    throw new BadRequestError("Mavzu raqami kamida 1 bo'lishi kerak");
  }

  const cleanNote = typeof note === "string" ? note.trim().slice(0, NOTE_MAX) : null;

  const dateValue = parseDayDate(date, "Dars kuni");
  const day = dayKey(dateValue);
  const today = todayIsoTashkent();
  const distance = daysBetween(today, day);
  if (distance == null || Math.abs(distance) > BIND_WINDOW_DAYS) {
    throw new BadRequestError(
      `Mavzu bugundan ${BIND_WINDOW_DAYS} kun ichidagi darsga biriktiriladi`,
    );
  }

  const [classDoc, subject] = await Promise.all([
    prisma.class.findUnique({ where: { id: classId }, select: { id: true, name: true } }),
    prisma.subject.findUnique({ where: { id: subjectId }, select: { id: true, name: true } }),
  ]);
  if (!classDoc) throw new NotFoundError("Sinf topilmadi");
  if (!subject) throw new NotFoundError("Fan topilmadi");

  // ⚠️ DARS JADVALDA HAQIQATAN BORMI. Eskirgan ekran yoki qo'lda yasalgan
  // so'rov mavjud bo'lmagan katakka ankor yozib qo'ysa, u hech qachon
  // ko'rinmas va sanoqni ham jimgina buzardi.
  const template = await loadClassTemplate(classId);
  const slots = template.slotsBySubject.get(subjectId)?.get(parseDayKey(day).getUTCDay()) ?? [];
  if (!slots.some((slot) => slot.order === order)) {
    throw new BadRequestError(
      `${formatDateUz(dateValue, { utc: true })} kuni bu sinfda ${order}-dars "${subject.name}" emas`,
    );
  }

  const { isTeachingDay, offReason } = await buildCalendar(day, day);
  if (!isTeachingDay(day)) {
    throw new BadRequestError(`Bu kuni dars o'tilmaydi (${offReason(day)})`);
  }

  const topic = await prisma.topic.findUnique({
    where: { subjectId_order: { subjectId, order: topicNumber } },
    select: { id: true, name: true, order: true },
  });
  if (!topic) {
    throw new NotFoundError(`${topicNumber}-mavzu "${subject.name}" fanida topilmadi`);
  }

  const activeKey = bindingActiveKey(classId, subjectId, day, order);

  const created = await prisma.$transaction(async (tx) => {
    await tx.lessonTopicBinding.updateMany({
      where: { activeKey },
      data: { activeKey: null, revokedAt: new Date(), revokedBy: actorId },
    });

    return tx.lessonTopicBinding.create({
      data: {
        classId,
        subjectId,
        date: dateValue,
        lessonOrder: order,
        topicOrder: topicNumber,
        source: "manual",
        note: cleanNote || null,
        snapshot: {
          className: classDoc.name,
          subjectName: subject.name,
          topicName: topic.name,
        },
        activeKey,
        createdBy: actorId,
      },
    });
  });

  logger.info(
    `[LessonTopic] ${classDoc.name} / ${subject.name} — ${day} ${order}-dars → ${topicNumber}-mavzu`,
  );

  return {
    binding: publicBinding(created),
    topic,
    class: classDoc,
    subject,
  };
}

/**
 * BIRIKTIRISHNI BEKOR QILISH.
 *
 * Qator o'chirilmaydi. Bekor qilingach mavzu OLDINGI ankordan sanaladi;
 * ankor umuman qolmasa, keyingi o'qishda tizim avtomatini qayta qo'yadi.
 */
async function unbindLessonTopic({ id, actorId }) {
  const row = await prisma.lessonTopicBinding.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Biriktirish topilmadi");
  if (row.revokedAt) throw new ConflictError("Bu biriktirish allaqachon bekor qilingan");

  const updated = await prisma.lessonTopicBinding.updateMany({
    where: { id, revokedAt: null },
    data: { activeKey: null, revokedAt: new Date(), revokedBy: actorId },
  });
  if (updated.count !== 1) {
    throw new ConflictError("Biriktirish shu orada o'zgardi — sahifani yangilang");
  }

  return { id, classId: row.classId, subjectId: row.subjectId };
}

/** Sinfdagi biriktirishlar tarixi (oxirgilari birinchi). */
async function listBindings({ classId, subjectId, limit = 50 }) {
  const rows = await prisma.lessonTopicBinding.findMany({
    where: { classId, ...(subjectId ? { subjectId } : {}) },
    orderBy: [{ createdAt: "desc" }],
    take: Math.min(Math.max(Number(limit) || 50, 1), 200),
  });

  return rows.map((row) => ({
    ...publicBinding(row),
    revokedAt: row.revokedAt,
    isActive: row.revokedAt === null,
    className: row.snapshot?.className ?? null,
    subjectName: row.snapshot?.subjectName ?? null,
  }));
}

/**
 * BAHOGA MAVZU — bitta kundagi bir nechta darsning `Topic.id` si.
 *
 * ⚠️ HECH QACHON XATO TASHLAMAYDI (chaqiruvchi `gradeTopic.service.js`
 * doktrinasi): mavzu — baholar tahlili uchun QO'SHIMCHA ma'lumot, uni
 * aniqlab bo'lmasa baho baribir yozilishi shart.
 *
 * @returns {Promise<Map<number, string>>} dars tartibi → `Topic.id`
 */
async function getLessonTopicIds({ classId, subjectId, day, lessonOrders, actorId }) {
  const result = new Map();
  if (!classId || !subjectId || !Array.isArray(lessonOrders) || lessonOrders.length === 0) {
    return result;
  }

  const { byLesson } = await resolveLessonTopics({ classId, days: [day], actorId });

  for (const order of lessonOrders) {
    const entry = byLesson.get(lessonKey(day, order));
    if (!entry || entry.subjectId !== subjectId || !entry.topic) continue;
    result.set(order, entry.topic.id);
  }

  return result;
}

/**
 * BITTA KUNDAGI HAR BIR DARSNING MAVZUSI — jurnal ekranlari uchun.
 *
 * O'qituvchi paneli ("bugun qaysi fandan qaysi mavzu") va baho qo'yish
 * oynasi shu yerdan o'qiydi — jadvaldagi mavzu bilan AYNI manba.
 *
 * @returns {Promise<Map<number, {subjectId: string, topicOrder: number|null, topic: object|null, reason: string|null}>>}
 *   dars tartibi → mavzu
 */
async function getDayLessonTopics({ classId, day, actorId }) {
  const result = new Map();
  if (!classId || !day) return result;

  const { byLesson, offReason } = await resolveLessonTopics({
    classId,
    days: [day],
    actorId,
    // Jurnal oynasi mavzuning darajasi, kitobi va mazmunini ham ko'rsatadi
    withDetails: true,
  });
  const off = offReason(day);

  for (const [key, entry] of byLesson) {
    const [entryDay, order] = key.split("|");
    if (entryDay !== day) continue;
    result.set(Number(order), {
      subjectId: entry.subjectId ?? null,
      topicOrder: off ? null : entry.topicOrder,
      topic: off ? null : entry.topic,
      reason: off ?? entry.reason,
    });
  }

  return result;
}

/**
 * FAN → SINFLAR EKRANI: har bir sinfning KEYINGI darsidagi mavzu.
 *
 * ⚠️ Bitta kalendar, bitta mavzular ro'yxati, bitta ankorlar so'rovi —
 * sinflar bo'yicha aylanmaydi. Ilgari bu ekran har sinf uchun alohida
 * so'rov yuborsa, 30 sinfli fanda yuzlab so'rov chiqardi.
 *
 * ⚠️ `totalTopics` — mavzular MAXRAJI. Sertifikat progressi ("200 tadan
 * 100-siga yetdi") aynan shundan quriladi va IKKINCHI hisob yozilmaydi:
 * jadval ekrani bir raqam, sertifikat ekrani boshqa raqam ko'rsatsa,
 * mavzu hisobining butun mohiyati (bitta haqiqat) yo'qolardi.
 *
 * @param {object} params
 * @param {string} params.subjectId
 * @param {string} params.actorId
 * @param {boolean} [params.ensure=true] - ankorsiz sinfga AVTOMATIK ankor
 *   yozilsinmi. ⚠️ `false` — FAQAT O'QISH yo'li uchun: o'quvchi o'z
 *   sertifikat progressini ko'rganda ta'lim domeniga qator yozilmasligi
 *   kerak (`createdBy` o'quvchi bo'lib qolardi). Admin yo'lida `true`
 *   qoladi — jadval ekranidagi bilan AYNI qoida.
 */
async function getSubjectClassTopics({ subjectId, actorId, ensure = true }) {
  const subject = await prisma.subject.findUnique({
    where: { id: subjectId },
    select: { id: true, name: true },
  });
  if (!subject) throw new NotFoundError("Fan topilmadi");

  const schedules = await prisma.schedule.findMany({
    where: { lessons: { some: { subjectId } } },
    include: { lessons: { where: { subjectId }, orderBy: { order: "asc" } } },
  });

  const slotsByClass = new Map();
  for (const schedule of schedules) {
    const dayNumber = DAY_TO_NUMBER.get(schedule.day);
    if (dayNumber === undefined) continue;
    if (!slotsByClass.has(schedule.classId)) slotsByClass.set(schedule.classId, new Map());
    slotsByClass
      .get(schedule.classId)
      .set(
        dayNumber,
        schedule.lessons.map((lesson) => ({ order: lesson.order, endTime: lesson.endTime })),
      );
  }

  const classIds = [...slotsByClass.keys()];
  if (classIds.length === 0) {
    // Jadvalda bu fandan dars yo'q — lekin MAXRAJ baribir qaytadi:
    // sertifikat ekrani "mavzu ro'yxati bor, dars yo'q" bilan "mavzu
    // ro'yxati ham yo'q" ni ajratishi kerak.
    const empty = await loadTopics([subjectId]);
    return { subject, classes: [], totalTopics: empty.get(subjectId)?.last ?? 0 };
  }

  let [classes, topicsBySubject, bindings] = await Promise.all([
    prisma.class.findMany({
      where: { id: { in: classIds } },
      select: { id: true, name: true },
    }),
    loadTopics([subjectId]),
    prisma.lessonTopicBinding.findMany({
      where: { classId: { in: classIds }, subjectId, revokedAt: null },
      orderBy: [{ date: "asc" }, { lessonOrder: "asc" }],
    }),
  ]);

  const topics = topicsBySubject.get(subjectId) ?? { byOrder: new Map(), last: 0 };
  const classMap = new Map(classes.map((c) => [c.id, c]));

  const today = todayIsoTashkent();
  const oldestAnchor = bindings.length > 0 ? dayKey(bindings[0].date) : today;
  const rangeFrom = [oldestAnchor, today].sort()[0];
  const rangeTo = shiftIsoDays(today, ANCHOR_HORIZON_DAYS);
  const { isTeachingDay } = await buildCalendar(rangeFrom, rangeTo);

  const nowMinutes = tashkentMinutes();
  const slotByClass = new Map(
    classIds.map((classId) => [
      classId,
      findNextLessonSlot({
        slotsByDay: slotsByClass.get(classId),
        fromIso: today,
        isTeachingDay,
        nowMinutes,
      }),
    ]),
  );

  // ⚠️ ANKORSIZ SINFLARGA AVTOMATIK ANKOR — jadval ekranidagi bilan AYNI
  // qoida (`ensureAnchors`), lekin BITTA yozuvda: bu ekranda o'nlab sinf
  // bo'ladi va har biriga alohida so'rov yuborilsa, sahifa yuzlab so'rov
  // qilardi. Yozuv yiqilsa ekran baribir ochiladi (sababi ko'rinadi).
  const anchored = new Set(bindings.map((row) => row.classId));
  const missing = ensure
    ? classIds.filter((classId) => !anchored.has(classId) && slotByClass.get(classId))
    : [];

  if (missing.length > 0 && topics.last >= 1) {
    try {
      const progressRows = await prisma.classSubjectProgress.findMany({
        where: { classId: { in: missing }, subjectId },
        select: { classId: true, currentTopicNumber: true },
      });
      const progressMap = new Map(progressRows.map((p) => [p.classId, p.currentTopicNumber]));

      const newRows = missing.map((classId) => {
        const slot = slotByClass.get(classId);
        const topicOrder = Math.min(Math.max(progressMap.get(classId) ?? 1, 1), topics.last);
        return {
          id: generateId(),
          classId,
          subjectId,
          date: parseDayKey(slot.day),
          lessonOrder: slot.lessonOrder,
          topicOrder,
          source: "auto",
          note: null,
          snapshot: {
            className: classMap.get(classId)?.name ?? null,
            subjectName: subject.name,
            topicName: topics.byOrder.get(topicOrder)?.name ?? null,
          },
          activeKey: bindingActiveKey(classId, subjectId, slot.day, slot.lessonOrder),
          createdBy: actorId,
        };
      });

      await prisma.lessonTopicBinding.createMany({ data: newRows, skipDuplicates: true });
      const created = await prisma.lessonTopicBinding.findMany({
        where: { activeKey: { in: newRows.map((row) => row.activeKey) } },
      });
      bindings = [...bindings, ...created].sort(
        (a, b) => a.date - b.date || a.lessonOrder - b.lessonOrder,
      );
    } catch (error) {
      logger.warn(`[LessonTopic] Avtomatik ankor yozilmadi (fan ${subjectId}): ${error.message}`);
    }
  }

  const bindingsByClass = new Map();
  for (const row of bindings) {
    if (!bindingsByClass.has(row.classId)) bindingsByClass.set(row.classId, []);
    bindingsByClass.get(row.classId).push(row);
  }

  const rows = classIds.map((classId) => {
    const slotsByDay = slotsByClass.get(classId);
    const slot = slotByClass.get(classId);
    const anchors = bindingsByClass.get(classId) ?? [];

    let currentTopicNumber = null;
    let reason = null;

    if (topics.last < 1) {
      reason = TOPIC_MISS_REASONS.noTopics;
    } else if (!slot) {
      reason = "Yaqin kunlarda bu fandan dars yo'q";
    } else if (anchors.length === 0) {
      reason = TOPIC_MISS_REASONS.noAnchor;
    } else {
      const ordersByDayNumber = new Map(
        [...slotsByDay].map(([dayNumber, list]) => [
          dayNumber,
          [...new Set(list.map((s) => s.order))].sort((a, b) => a - b),
        ]),
      );
      const usable = anchors.filter((row) => dayKey(row.date) <= slot.day);
      const anchor = usable[usable.length - 1] ?? null;

      if (!anchor) {
        reason = TOPIC_MISS_REASONS.beforeAnchor;
      } else {
        const resolved = topicOrdersForDays({
          anchor: {
            day: dayKey(anchor.date),
            lessonOrder: anchor.lessonOrder,
            topicOrder: anchor.topicOrder,
          },
          ordersByDayNumber,
          targetDays: [slot.day],
          isTeachingDay,
          lastTopicOrder: topics.last,
        });
        const entry = resolved.get(lessonKey(slot.day, slot.lessonOrder));
        currentTopicNumber = entry?.topicOrder ?? null;
        reason = entry?.reason ?? null;
      }
    }

    return {
      class: classMap.get(classId) ?? null,
      subjectId,
      currentTopicNumber,
      currentTopicName:
        currentTopicNumber != null ? topics.byOrder.get(currentTopicNumber)?.name ?? null : null,
      reason,
      nextLesson: slot
        ? {
            date: slot.day,
            dateLabel: formatDateUz(parseDayKey(slot.day), { utc: true }),
            lessonOrder: slot.lessonOrder,
          }
        : null,
      anchor: publicBinding(anchors[anchors.length - 1] ?? null),
    };
  });

  rows.sort((a, b) => (a.class?.name || "").localeCompare(b.class?.name || ""));

  return { subject, classes: rows, totalTopics: topics.last };
}

/**
 * "JORIY MAVZU" NI QO'LDA QO'YISH (fan → sinflar ekranidagi qalamcha).
 *
 * Alohida mexanizm EMAS: bu ham ankor, faqat kun va dars tartibini odam
 * emas, tizim tanlaydi — sinfning KEYINGI darsi. Shu tufayli jadvaldagi
 * raqam bilan bu ekrandagi raqam hech qachon farq qilmaydi.
 */
async function setClassCurrentTopic({ classId, subjectId, topicOrder, actorId }) {
  const template = await loadClassTemplate(classId);
  const slotsByDay = template.slotsBySubject.get(subjectId);
  if (!slotsByDay || slotsByDay.size === 0) {
    throw new BadRequestError("Bu sinf jadvalida ushbu fandan dars yo'q");
  }

  const today = todayIsoTashkent();
  const { isTeachingDay } = await buildCalendar(today, shiftIsoDays(today, ANCHOR_HORIZON_DAYS));
  const slot = findNextLessonSlot({
    slotsByDay,
    fromIso: today,
    isTeachingDay,
    nowMinutes: tashkentMinutes(),
  });
  if (!slot) {
    throw new BadRequestError("Yaqin kunlarda bu fandan dars yo'q — mavzuni jadvaldan biriktiring");
  }

  return bindLessonTopic({
    classId,
    subjectId,
    date: slot.day,
    lessonOrder: slot.lessonOrder,
    topicOrder,
    note: null,
    actorId,
  });
}

module.exports = {
  DAY_TO_NUMBER,
  ANCHOR_HORIZON_DAYS,
  BIND_WINDOW_DAYS,
  NOTE_MAX,
  MAX_LESSON_ORDER,
  tashkentMinutes,
  timeToMinutes,
  weekStartOf,
  weekDays,
  loadClassTemplate,
  buildCalendar,
  loadTopics,
  attachTopicDetails,
  findNextLessonSlot,
  ensureAnchors,
  resolveLessonTopics,
  publicBinding,
  getClassWeekTopics,
  bindLessonTopic,
  unbindLessonTopic,
  listBindings,
  getLessonTopicIds,
  getDayLessonTopics,
  getSubjectClassTopics,
  setClassCurrentTopic,
};
