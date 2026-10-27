/**
 * FACE ID → DAVOMAT. KIOSKNING YAGONA KIRISH NUQTASI.
 *
 * ⚠️ ENG MUHIM QOIDA: BU YERDA DAVOMAT MANTIG'I YO'Q.
 *
 * Bu service to'rt ish qiladi va boshqa hech narsa:
 *   1. kadr sifati va tirikligini tekshiradi (darvoza);
 *   2. galereyadan kimligini aniqlaydi (`faceGallery.findNearest`);
 *   3. qaysi amal kerakligini hal qiladi (kelish / ketish / belgilash);
 *   4. MAVJUD service'ni chaqiradi va urinishni jurnalga yozadi.
 *
 * Kechikish, imtiyoz, jarima, `checkoutGate`, o'qish davri va oylik
 * ayirmasi — hammasi `attendance.service.js` va
 * `studentAttendance.service.js` da qoladi. Ularning NUSXASI bu faylda
 * paydo bo'lsa, "kioskdan kelgan kechikish jarimasiz" degan holat
 * tug'ilardi va uni hech kim sezmasdi (`.claude/rules/face-id.md` §0).
 *
 * ── UCH YO'L, BITTA MANTIQ ──────────────────────────────────────────
 *
 *   panel    → markStaffAttendance / markAttendance   (xodim boshqa odam uchun)
 *   telefon  → checkIn / checkOut                     (xodim o'zi, GPS bilan)
 *   kiosk    → AYNI checkIn / checkOut / markAttendance
 *
 * ── URINISH HAR DOIM JURNALGA TUSHADI ───────────────────────────────
 *
 * Muvaffaqiyatsizi ham: "nega kiosk meni tanimayapti" va "kim telefondagi
 * rasm bilan o'tishga urindi" degan savollarning javobi `FaceCheckEvent`
 * da. Jim rad etish bu modulni nosozligi topilmaydigan qora qutiga
 * aylantirardi.
 */

const prisma = require("../config/prisma");
const attendanceService = require("./attendance.service");
const studentAttendanceService = require("./studentAttendance.service");
const faceGallery = require("./faceGallery.service");
const faceProfileService = require("./faceProfile.service");
const kioskService = require("./kiosk.service");
const { getFaceSettings, getScheduleSettings } = require("./settings.service");
const { normalizeEmbedding, scoreToPercent } = require("../helpers/faceEmbedding.helpers");
const { overlappingDateRangeWhere } = require("../helpers/enrollment.helpers");
const { generateId } = require("../utils/idGenerator");
const { ROLES, DAYS_UZ } = require("../utils/constants");

/**
 * `ScheduleDay` enumida BOR kunlar.
 *
 * ⚠️ `DAYS_UZ` dan FARQ QILADI: u `getDay()` tartibida va yakshanbani
 * ham o'z ichiga oladi, jadval enumi esa olmaydi (yakshanba hech qachon
 * dars kuni emas — `scheduleWorkTime.service.js` izohiga qarang).
 */
const SCHEDULE_DAYS = new Set([
  "dushanba",
  "seshanba",
  "chorshanba",
  "payshanba",
  "juma",
  "shanba",
]);
const { BadRequestError } = require("../utils/errors");
const { formatPaginationResponse, getPaginationParams } = require("../utils/pagination");
const { formatTimeUz } = require("../helpers/date.helpers");
const logger = require("../utils/logger");

const RESULT = Object.freeze({
  MARKED: "marked",
  COOLDOWN: "cooldown",
  ALREADY: "already",
  NO_MATCH: "no_match",
  AMBIGUOUS: "ambiguous",
  SPOOF: "spoof",
  LOW_QUALITY: "low_quality",
  NOT_ENROLLED: "not_enrolled",
  BLOCKED: "blocked",
  REJECTED: "rejected",
  ERROR: "error",
});

const KIND = Object.freeze({
  CHECK_IN: "checkIn",
  CHECK_OUT: "checkOut",
  STUDENT_MARK: "studentMark",
  ENROLL: "enroll",
  UNKNOWN: "unknown",
});

/** Kiosk ekranidagi tugma — mijoz nimani so'raganini aytadi. */
const INTENTS = Object.freeze(["auto", "checkIn", "checkOut"]);

const clamp01 = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(1, num));
};

const CLIENT_EVENT_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Oflayn navbatning kaliti.
 *
 * ⚠️ MIJOZ BERADI va shu ataylab: idempotentlik navbat qayta
 * yuborilganda ishlashi kerak, ya'ni kalit SERVERDA tug'ilsa har
 * yuborishda boshqa bo'lib, bitta kelish ikki marta yozilardi.
 * Shakli tekshiriladi, mazmuniga esa ishonilmaydi — `@unique` ustun
 * takrorni baribir to'sadi.
 */
const resolveClientEventId = (value) => {
  const raw = String(value || "").trim();
  return CLIENT_EVENT_RE.test(raw) ? raw : generateId();
};

/* ═══════════════════════ JURNAL ═══════════════════════ */

/**
 * Urinishni jurnalga yozadi.
 *
 * ⚠️ TAKROR YOZUVNI JIM QABUL QILADI (`P2002`): oflayn navbat ikki marta
 * yuborilsa, ikkinchisi xato bermasligi kerak — kiosk uchun bu "qabul
 * qilindi" degan javob bo'lishi lozim, aks holda navbatdan hech qachon
 * o'chmasdi va cheksiz qayta yuborilib turardi.
 *
 * @returns {Promise<object|null>} yozilgan qator yoki `null` (takror)
 */
async function logEvent(data) {
  try {
    const eventId = generateId();
    return await prisma.faceCheckEvent.create({
      data: {
        id: eventId,
        kioskId: data.kioskId ?? null,
        kioskName: data.kioskName ?? null,
        userId: data.userId ?? null,
        userName: data.userName ?? null,
        userRole: data.userRole ?? null,
        kind: data.kind,
        result: data.result,
        score: data.score ?? null,
        margin: data.margin ?? null,
        liveness: data.liveness ?? null,
        antispoof: data.antispoof ?? null,
        message: data.message ?? null,
        attendanceId: data.attendanceId ?? null,
        snapshotKey: data.snapshotKey ?? null,
        // ⚠️ OCHIQ URL EMAS — `faceId.events` ruxsati tekshiradigan API yo'li.
        snapshotUrl: data.snapshotKey ? `/face-id/events/${eventId}/snapshot` : null,
        offline: Boolean(data.offline),
        clientEventId: data.clientEventId,
        occurredAt: data.occurredAt,
      },
    });
  } catch (error) {
    if (error?.code === "P2002") return null;
    // Jurnal yozilmasa ham davomat yozilgan bo'lishi mumkin — yiqitmaymiz.
    logger.error(`Face ID: jurnal yozilmadi — ${error.message}`);
    return null;
  }
}

/**
 * Javob shakli — kiosk ekrani SHU kalitlardan chiziladi.
 *
 * ⚠️ `message` SERVERDAN keladi va kioskda yozilmaydi: sabab matnlari
 * ikki joyda bo'lsa, `checkoutGate` yangi sabab qo'shganda kiosk eski
 * matnni ko'rsatib turardi.
 */
const reply = ({ result, kind, message, person, score, margin, attendance, extra }) => ({
  result,
  kind,
  message,
  ok: result === RESULT.MARKED,
  person: person
    ? {
        userId: person.userId,
        name: person.name,
        role: person.role,
        photo: person.photo ?? null,
      }
    : null,
  score: score ?? null,
  scorePercent: scoreToPercent(score),
  margin: margin ?? null,
  attendance: attendance ?? null,
  ...(extra || {}),
});

/* ═══════════════════════ O'QUVCHI HOLATI ═══════════════════════ */

/**
 * O'QUVCHINING SINFI VA KELISH HOLATI.
 *
 * ⚠️ `present` yoki `late` — bu yerda hal qilinadi, chunki o'quvchida
 * `workStartTime` tushunchasi yo'q. Kechikish SINFNING BIRINCHI DARSI
 * boshlanishidan `studentLateGraceMinutes` keyin sanaladi.
 *
 * ⚠️ Dars vaqti ANIQLANMASA → `present`. Soxta kechikish yozish
 * (jadval to'liq kiritilmagan sinfda hammani "kechikdi" qilish) eng
 * yomon natija bo'lardi: o'qituvchi hisobotga ishonmay qo'yardi.
 *
 * ⚠️ O'QUVCHIDA KETISH YO'Q: `StudentAttendance` da `checkOut` ustuni
 * yo'q va qo'shilmaydi — o'quvchi davomati pulga ta'sir qilmaydi
 * (`education.md` §6), ya'ni ketish vaqtining moliyaviy ma'nosi yo'q.
 *
 * @returns {Promise<{ classId: string, status: "present"|"late", firstLessonTime: string|null }|{ error: string }>}
 */
async function resolveStudentStatus(studentId, settings, now = new Date()) {
  const today = attendanceService.getTodayNormalized();

  const [student, enrollment] = await Promise.all([
    prisma.user.findUnique({
      where: { id: studentId },
      select: { classes: { select: { classId: true } } },
    }),
    // O'QISH DAVRI — "davr yo'q = o'qimaydi" (`education.md` §3).
    //
    // ⚠️ BUGUNGI KUNNI QAMRAGAN davr so'raladi: ketgan o'quvchining
    // kioskdan o'tishi davomat yozmasligi kerak. Moliyadagi resolver
    // butun tarixni o'qiydi (u yerda savol boshqa — "umuman davri
    // bormi"), bu yerda esa savol "BUGUN o'qiyaptimi".
    prisma.studentEnrollment.findFirst({
      where: { studentId, ...overlappingDateRangeWhere(today, today) },
      select: { id: true },
    }),
  ]);

  if (!enrollment) {
    return { error: "O'quvchining bugungi kunga o'qish davri yo'q" };
  }

  const classId = student?.classes?.[0]?.classId;
  if (!classId) {
    // Davomat sinfga bog'langan (`StudentAttendance.classId` majburiy) —
    // sinfsiz o'quvchiga qator yozib bo'lmaydi.
    return { error: "O'quvchi birorta sinfga biriktirilmagan" };
  }

  const firstLessonTime = await getClassFirstLessonTime(classId, now);
  if (!firstLessonTime) {
    return { classId, status: "present", firstLessonTime: null };
  }

  const [hours, minutes] = firstLessonTime.split(":").map(Number);
  const lessonMin = hours * 60 + minutes;
  const nowMin = currentMinutesTashkent(now);
  const grace = Number(settings.studentLateGraceMinutes) || 0;

  return {
    classId,
    status: nowMin > lessonMin + grace ? "late" : "present",
    firstLessonTime,
  };
}

/** Toshkent devor-soati bo'yicha daqiqa (attendance.service bilan ayni qoida). */
function currentMinutesTashkent(date = new Date()) {
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60000;
  const t = new Date(utcMs + 5 * 3600000);
  return t.getHours() * 60 + t.getMinutes();
}

/**
 * SINFNING shu kundagi BIRINCHI darsi boshlanish vaqti.
 *
 * ⚠️ Vaqt IKKI MANBADAN olinadi va tartibi `scheduleWorkTime.service.js`
 * bilan AYNAN bir xil: darsning O'ZIDA yozilgan vaqt ustun, bo'lmasa
 * `ScheduleSettings.periods` dagi o'sha `order` ning standart vaqti.
 * Uchinchi mustaqil hal qiluvchi yozilsa, o'qituvchi davomati bir
 * vaqtni, o'quvchi davomati boshqasini ko'rsatardi.
 *
 * ⚠️ Yakshanba `ScheduleDay` enumida YO'Q — jadval topilmaydi va
 * natija `null` bo'ladi (kechikish yo'q). Alohida shart kerak emas.
 *
 * @returns {Promise<string|null>} "08:30" yoki `null`
 */
async function getClassFirstLessonTime(classId, now = new Date()) {
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const dayIndex = new Date(utcMs + 5 * 3600000).getDay();
  const dayName = DAYS_UZ[dayIndex];

  // ⚠️ YAKSHANBA `ScheduleDay` ENUMIDA YO'Q. `findUnique` ga yuborilsa
  // Prisma validatsiya xatosi beradi (null emas) va butun skaner 500
  // bilan yiqilardi — shuning uchun shart BAZAGA BORMASDAN kesiladi.
  if (!dayName || !SCHEDULE_DAYS.has(dayName)) return null;

  const [schedule, scheduleSettings] = await Promise.all([
    prisma.schedule.findUnique({
      where: { classId_day: { classId, day: dayName } },
      select: { lessons: { select: { order: true, startTime: true } } },
    }),
    getScheduleSettings(),
  ]);

  if (!schedule || schedule.lessons.length === 0) return null;

  const periods = Array.isArray(scheduleSettings.periods) ? scheduleSettings.periods : [];
  const periodMap = new Map(
    periods
      .filter((p) => p && Number.isFinite(Number(p.order)) && p.startTime)
      .map((p) => [Number(p.order), String(p.startTime)]),
  );

  let earliest = null;
  for (const lesson of schedule.lessons) {
    const time = lesson.startTime || periodMap.get(lesson.order) || null;
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(time || "").trim());
    if (!match) continue;
    const minutes = Number(match[1]) * 60 + Number(match[2]);
    if (Number(match[1]) > 23 || Number(match[2]) > 59) continue;
    if (earliest === null || minutes < earliest) earliest = minutes;
  }

  if (earliest === null) return null;
  return `${String(Math.floor(earliest / 60)).padStart(2, "0")}:${String(earliest % 60).padStart(2, "0")}`;
}

/* ═══════════════════════ AMALNI TANLASH ═══════════════════════ */

/**
 * XODIM UCHUN: KELISHMI YOKI KETISHMI.
 *
 * ```
 * kelish qayd etilmagan                          → kelish
 * kelish bor, ketish yo'q, intent = "checkOut"    → ketish
 * kelish bor, ketish yo'q, checkoutMinMinutes o'tgan va intent = "auto" → ketish
 * ketish ham bor                                 → already
 * ```
 *
 * ⚠️ NOANIQ HOLATDA KELISH TANLANADI. Xato kelish zarariz (qayta
 * yozilmaydi, allaqachon bor), xato ketish esa ish kunini YARIMLATADI va
 * erta ketish jarimasini yozib qo'yadi. Shuning uchun `auto` rejimida
 * ketishga o'tish uchun `checkoutMinMinutes` o'tishi SHART.
 *
 * ⚠️ Kiosk ekranida "Ketish" tugmasi bor (`intent: "checkOut"`) — odam
 * ataylab bosganda vaqt sharti qo'llanmaydi: u o'zi nima qilayotganini
 * biladi va `checkoutGate` baribir tekshiradi.
 */
function decideStaffAction(record, intent, settings, now = new Date()) {
  if (!record || !record.checkIn) return { kind: KIND.CHECK_IN };

  if (record.checkOut) {
    return {
      kind: KIND.CHECK_OUT,
      already: true,
      message: `Bugun kelish (${formatTimeUz(record.checkIn)}) va ketish (${formatTimeUz(record.checkOut)}) qayd etilgan`,
    };
  }

  if (intent === "checkOut") return { kind: KIND.CHECK_OUT };

  const minutesSinceCheckIn = (now.getTime() - new Date(record.checkIn).getTime()) / 60000;
  if (minutesSinceCheckIn >= (Number(settings.checkoutMinMinutes) || 0)) {
    return { kind: KIND.CHECK_OUT };
  }

  return {
    kind: KIND.CHECK_IN,
    already: true,
    message: `Bugun kelish allaqachon qayd etilgan (${formatTimeUz(record.checkIn)})`,
  };
}

/**
 * TAKROR SKANER DARVOZASI.
 *
 * Odam kameraga 2 soniyada besh marta tushadi. `cooldownSeconds` ichida
 * ayni odamga ikkinchi amal YOZILMAYDI va kiosk oldingi natijani
 * takrorlab ko'rsatadi.
 *
 * ⚠️ Faqat MUVAFFAQIYATLI qayd hisobga olinadi: rad etilgan urinish
 * (masalan `checkoutGate` to'sgan) odamni 90 soniya kutishga majbur
 * qilmasligi kerak — u bahosini qo'yib darhol qaytib keladi.
 */
async function findRecentSuccess(userId, settings, now = new Date()) {
  const seconds = Number(settings.cooldownSeconds) || 0;
  if (seconds <= 0) return null;

  return prisma.faceCheckEvent.findFirst({
    where: {
      userId,
      result: RESULT.MARKED,
      occurredAt: { gte: new Date(now.getTime() - seconds * 1000) },
    },
    orderBy: { occurredAt: "desc" },
    select: { kind: true, occurredAt: true },
  });
}

/* ═══════════════════════ ASOSIY OQIM ═══════════════════════ */

/**
 * KIOSKDAN KELGAN BITTA SKANER.
 *
 * @param {object} input
 * @param {object} input.kiosk - `req.kiosk` (reyestr qatori)
 * @param {Array<number>} input.embedding - kiosk hisoblagan vektor
 * @param {string} [input.model] - vektor modeli
 * @param {number} [input.quality] - detektor ishonchi
 * @param {number} [input.liveness]
 * @param {number} [input.antispoof]
 * @param {string} [input.intent] - "auto" | "checkIn" | "checkOut"
 * @param {string} [input.snapshot] - base64 JPEG (ixtiyoriy)
 * @param {string} [input.clientEventId] - oflayn navbat kaliti
 * @param {string|Date} [input.occurredAt] - kioskdagi vaqt (oflayn uchun)
 * @param {boolean} [input.offline]
 * @returns {Promise<object>} `reply()` shakli
 */
async function submitCheck(input = {}) {
  const { kiosk } = input;
  const settings = await getFaceSettings();
  const now = new Date();

  const clientEventId = resolveClientEventId(input.clientEventId);
  const intent = INTENTS.includes(input.intent) ? input.intent : "auto";
  const offline = Boolean(input.offline);

  // ⚠️ OFLAYN VAQTGA ISHONILADI, LEKIN CHEKLANADI: kioskdagi soat
  // buzilgan bo'lsa kelasi yilga yozilgan davomat hisobotni buzardi.
  // Kelajak RAD etiladi (hozirgi vaqt olinadi), o'tmish esa 7 kungacha
  // qabul qilinadi — uzilish bir hafta davom etishi mumkin.
  const occurredAt = resolveOccurredAt(input.occurredAt, now);

  const base = {
    kioskId: kiosk?.id ?? null,
    kioskName: kiosk?.name ?? null,
    clientEventId,
    occurredAt,
    offline,
    liveness: clamp01(input.liveness),
    antispoof: clamp01(input.antispoof),
  };

  // ── 1. Vektor ──────────────────────────────────────────────────
  let probe;
  try {
    const model = String(input.model || settings.embeddingModel).trim();
    if (model !== settings.embeddingModel) {
      throw new BadRequestError(
        `Kiosk dasturidagi model sozlamadagidan farq qiladi ("${model}")`,
      );
    }
    probe = normalizeEmbedding(input.embedding, { expectedDim: settings.embeddingDim });
  } catch (error) {
    await logEvent({ ...base, kind: KIND.UNKNOWN, result: RESULT.ERROR, message: error.message });
    throw error;
  }

  // ── 2. Sifat va tiriklik darvozasi ─────────────────────────────
  //
  // ⚠️ Kiosk ham tekshiradi, server ham QAYTA tekshiradi: kiosk dasturi
  // almashtirilgan bo'lishi mumkin. Mijozga ishonish bu darvozani
  // bezakka aylantirardi.
  const quality = clamp01(input.quality) ?? 0;
  const snapshot = settings.storeSnapshots
    ? await faceProfileService.storeSnapshot(input.snapshot, "face-id/events")
    : { key: null };
  base.snapshotKey = snapshot.key;

  if (quality < settings.minFaceQuality) {
    await logEvent({
      ...base,
      kind: KIND.UNKNOWN,
      result: RESULT.LOW_QUALITY,
      message: "Kadr sifatsiz",
    });
    return reply({
      result: RESULT.LOW_QUALITY,
      kind: KIND.UNKNOWN,
      message: "Yaqinroq turing va kameraga to'g'ri qarang",
    });
  }

  const spoofed =
    (settings.antispoofThreshold > 0 && (base.antispoof ?? 0) < settings.antispoofThreshold) ||
    (settings.livenessThreshold > 0 && (base.liveness ?? 0) < settings.livenessThreshold);

  if (spoofed) {
    await logEvent({
      ...base,
      kind: KIND.UNKNOWN,
      result: RESULT.SPOOF,
      message: "Tiriklik tekshiruvidan o'tmadi",
    });
    logger.warn(`Face ID: tiriklik tekshiruvi rad etdi — kiosk ${kiosk?.name || "?"}`);
    return reply({
      result: RESULT.SPOOF,
      kind: KIND.UNKNOWN,
      message: "Tiriklik tekshiruvidan o'tmadi — kameraga o'zingiz qarang",
    });
  }

  // ── 3. Kimligini aniqlash ──────────────────────────────────────
  const gallery = await faceGallery.getGallery(settings);
  const { best, score, margin } = faceGallery.findNearest(probe, gallery);

  if (!best || score < settings.matchThreshold) {
    await logEvent({
      ...base,
      kind: KIND.UNKNOWN,
      result: RESULT.NO_MATCH,
      score: best ? score : null,
      margin: best ? margin : null,
      message: "Galereyada topilmadi",
    });
    return reply({
      result: RESULT.NO_MATCH,
      kind: KIND.UNKNOWN,
      score: best ? score : null,
      message:
        gallery.entries.length === 0
          ? "Hali hech kim ro'yxatga olinmagan — administratorga murojaat qiling"
          : "Tanib bo'lmadi — qayta urinib ko'ring yoki xodimga murojaat qiling",
    });
  }

  // ⚠️ IKKINCHI SHART. Usiz aka-uka (yoki egizak) navbatma-navbat
  // bir-birining davomatini belgilab ketardi.
  if (margin < settings.marginThreshold) {
    await logEvent({
      ...base,
      kind: KIND.UNKNOWN,
      result: RESULT.AMBIGUOUS,
      score,
      margin,
      message: `Bir nechta odamga baravar o'xshadi (eng yaqini: ${best.name})`,
    });
    return reply({
      result: RESULT.AMBIGUOUS,
      kind: KIND.UNKNOWN,
      score,
      margin,
      message: "Ikki odamga baravar o'xshadi — davomatni xodim qo'lda belgilaydi",
    });
  }

  const person = { ...base, userId: best.userId, userName: best.name, userRole: best.role };

  // ── 4. Rejim darvozalari ───────────────────────────────────────
  const isStudent = best.role === ROLES.STUDENT;

  if (isStudent && !settings.studentEnabled) {
    return rejectPerson(person, best, "O'quvchilar uchun Face ID o'chirilgan", RESULT.BLOCKED);
  }
  if (!isStudent && !settings.staffEnabled) {
    return rejectPerson(person, best, "Xodimlar uchun Face ID o'chirilgan", RESULT.BLOCKED);
  }
  if (kiosk && !kioskService.modeAllows(kiosk, best.role)) {
    return rejectPerson(
      person,
      best,
      isStudent
        ? "Bu qurilma faqat xodimlar uchun"
        : "Bu qurilma faqat o'quvchilar uchun",
      RESULT.BLOCKED,
    );
  }

  // ── 5. Takror skaner ───────────────────────────────────────────
  const recent = await findRecentSuccess(best.userId, settings, now);
  if (recent) {
    await logEvent({ ...person, kind: recent.kind, result: RESULT.COOLDOWN, score, margin });
    return reply({
      result: RESULT.COOLDOWN,
      kind: recent.kind,
      person: best,
      score,
      margin,
      message: `Siz allaqachon o'tdingiz (${formatTimeUz(recent.occurredAt)})`,
    });
  }

  // Mos kelishni profilga yozib qo'yamiz (kutilmaydi).
  faceProfileService.recordMatch(best.userId, score);

  // ── 6. DAVOMAT — MAVJUD SERVICE CHAQIRILADI ────────────────────
  try {
    const outcome = isStudent
      ? await markStudent({ person, best, settings, score, margin, now })
      : await markStaff({ person, best, settings, score, margin, intent, kiosk, now });

    if (outcome.result === RESULT.MARKED) kioskService.bumpCheckCount(kiosk?.id);
    return outcome;
  } catch (error) {
    // ⚠️ DARVOZA RAD ETGANI XATO EMAS, NATIJA. `checkoutGate` 409 bilan
    // "ishlaringiz tugamagan" deydi va kiosk shu matnni ko'rsatishi
    // kerak — 500 chiqarib "server buzildi" deb ko'rsatish odamni
    // administratorga yuborardi, aslida o'zi bahosini qo'yishi kerak.
    const message = error?.message || "Davomat yozilmadi";
    await logEvent({
      ...person,
      kind: isStudent ? KIND.STUDENT_MARK : KIND.CHECK_IN,
      result: RESULT.REJECTED,
      score,
      margin,
      message,
    });
    return reply({
      result: RESULT.REJECTED,
      kind: isStudent ? KIND.STUDENT_MARK : KIND.CHECK_IN,
      person: best,
      score,
      margin,
      message,
      extra: { details: error?.details ?? null },
    });
  }
}

/** Rad etilgan odamni jurnalga yozib, javob qaytaradi. */
async function rejectPerson(person, best, message, result) {
  await logEvent({ ...person, kind: KIND.UNKNOWN, result, message });
  return reply({ result, kind: KIND.UNKNOWN, person: best, message });
}

/**
 * Oflayn vaqtni cheklab qabul qiladi.
 *
 * ⚠️ KELAJAK RAD ETILADI: kioskdagi soat buzilgan bo'lsa (BIOS
 * batareyasi o'lgan kompyuterda odatiy hol) kelasi yilga yozilgan
 * davomat hisobotni buzardi va uni topish deyarli imkonsiz bo'lardi.
 *
 * ⚠️ O'TMISH 7 KUNGACHA: tarmoq uzilishi bir hafta davom etishi mumkin,
 * undan uzun bo'lsa qayd "bugun" deb yoziladi va jurnalda ko'rinadi.
 */
function resolveOccurredAt(value, now) {
  if (!value) return now;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return now;
  if (parsed > now) return now;
  if (now.getTime() - parsed.getTime() > 7 * 24 * 3600 * 1000) return now;
  return parsed;
}

/**
 * XODIM — `attendance.service` ga topshiradi.
 *
 * ⚠️ Kechikish, imtiyoz, jarima va `checkoutGate` SHU YERDA EMAS: ular
 * chaqirilgan service ichida. Bu funksiya faqat "kelishmi yoki ketishmi"
 * degan savolga javob beradi.
 */
async function markStaff({ person, best, settings, score, margin, intent, kiosk, now }) {
  const today = attendanceService.getTodayNormalized();
  const record = await prisma.attendance.findFirst({
    where: { userId: best.userId, date: today },
    select: { id: true, checkIn: true, checkOut: true },
  });

  const action = decideStaffAction(record, intent, settings, now);

  if (action.already) {
    await logEvent({
      ...person,
      kind: action.kind,
      result: RESULT.ALREADY,
      score,
      margin,
      message: action.message,
    });
    return reply({
      result: RESULT.ALREADY,
      kind: action.kind,
      person: best,
      score,
      margin,
      message: action.message,
    });
  }

  const options = {
    source: attendanceService.ATTENDANCE_SOURCE.KIOSK,
    kiosk: kiosk ? { id: kiosk.id, name: kiosk.name, location: kiosk.location } : null,
  };

  // Jarima "kim tomonidan" — owner (panel yo'lidagi bilan ayni qoida).
  const owner = await prisma.user.findFirst({
    where: { role: ROLES.OWNER },
    select: { id: true },
  });
  const adminUserId = owner?.id || best.userId;

  const row =
    action.kind === KIND.CHECK_OUT
      ? await attendanceService.checkOut(best.userId, null, adminUserId, options)
      : await attendanceService.checkIn(best.userId, null, adminUserId, options);

  const isLate = action.kind === KIND.CHECK_IN && row.isLate;
  const message =
    action.kind === KIND.CHECK_OUT
      ? `Ketish qayd etildi — ${formatTimeUz(row.checkOut)}`
      : isLate
        ? `Kelish qayd etildi — ${formatTimeUz(row.checkIn)} (${row.lateMinutes} daqiqa kechikish)`
        : `Kelish qayd etildi — ${formatTimeUz(row.checkIn)}`;

  await logEvent({
    ...person,
    kind: action.kind,
    result: RESULT.MARKED,
    score,
    margin,
    message,
    attendanceId: row.id,
  });

  return reply({
    result: RESULT.MARKED,
    kind: action.kind,
    person: best,
    score,
    margin,
    message,
    attendance: {
      id: row.id,
      status: row.status,
      checkIn: row.checkIn,
      checkOut: row.checkOut,
      isLate: row.isLate,
      lateMinutes: row.lateMinutes,
      isEarlyOut: row.isEarlyOut,
      earlyOutMinutes: row.earlyOutMinutes,
    },
  });
}

/**
 * O'QUVCHI — `studentAttendance.service.markAttendance` ga topshiradi.
 *
 * ⚠️ `upsert` qoidasi o'sha service ichida: ikkinchi skaner qatorni
 * qayta yozadi, lekin takror skaner darvozasi (`cooldown`) unga
 * yetib bormaydi. Shu sababli kioskdan ikki marta o'tgan o'quvchining
 * `markedAt` i o'zgarmaydi.
 */
async function markStudent({ person, best, settings, score, margin, now }) {
  const resolved = await resolveStudentStatus(best.userId, settings, now);

  if (resolved.error) {
    await logEvent({
      ...person,
      kind: KIND.STUDENT_MARK,
      result: RESULT.NOT_ENROLLED,
      score,
      margin,
      message: resolved.error,
    });
    return reply({
      result: RESULT.NOT_ENROLLED,
      kind: KIND.STUDENT_MARK,
      person: best,
      score,
      margin,
      message: resolved.error,
    });
  }

  const existing = await prisma.studentAttendance.findFirst({
    where: { studentId: best.userId, date: attendanceService.getTodayNormalized() },
    select: { id: true, status: true, markedAt: true, autoMarked: true },
  });

  // ⚠️ Qo'lda belgilangan qator KIOSK TOMONIDAN QAYTA YOZILMAYDI:
  // xodim "sababli" deb belgilagan bolani kiosk "keldi" qilib
  // yuborishi xodimning qarorini jimgina bekor qilardi. Avtomat
  // yozilgan ("kelmadi" cron'i) esa qayta yozilishi KERAK — bola
  // kechikib kelgan bo'lishi mumkin.
  if (existing && !existing.autoMarked && ["present", "late", "excused"].includes(existing.status)) {
    const message = `Davomat allaqachon belgilangan (${existing.status === "excused" ? "sababli" : existing.status === "late" ? "kechikdi" : "keldi"})`;
    await logEvent({
      ...person,
      kind: KIND.STUDENT_MARK,
      result: RESULT.ALREADY,
      score,
      margin,
      message,
      attendanceId: existing.id,
    });
    return reply({
      result: RESULT.ALREADY,
      kind: KIND.STUDENT_MARK,
      person: best,
      score,
      margin,
      message,
    });
  }

  const [row] = await studentAttendanceService.markAttendance(
    {
      classId: resolved.classId,
      records: [{ studentId: best.userId, status: resolved.status, classId: resolved.classId }],
    },
    // ⚠️ `markedBy` = O'QUVCHINING O'ZI. Kiosk odam emas va uning
    // `User` qatori yo'q: "kim belgiladi" degan savolga eng to'g'ri
    // javob "o'zi o'tdi". Qaysi kiosk ekani Face ID jurnalida.
    best.userId,
  );

  const message =
    resolved.status === "late"
      ? `Keldi, lekin kechikdi (dars ${resolved.firstLessonTime} da boshlangan)`
      : "Davomat belgilandi — keldi";

  await logEvent({
    ...person,
    kind: KIND.STUDENT_MARK,
    result: RESULT.MARKED,
    score,
    margin,
    message,
    attendanceId: row.id,
  });

  return reply({
    result: RESULT.MARKED,
    kind: KIND.STUDENT_MARK,
    person: best,
    score,
    margin,
    message,
    attendance: {
      id: row.id,
      status: row.status,
      classId: row.classId,
      markedAt: row.markedAt,
      firstLessonTime: resolved.firstLessonTime,
    },
  });
}

/**
 * OFLAYN NAVBATNI QABUL QILADI.
 *
 * ⚠️ KETMA-KET bajariladi, parallel EMAS: bir odamning ikki qaydi
 * (kelish va ketish) navbatda yonma-yon turishi mumkin va ular
 * TARTIB bilan qo'llanishi shart — parallel bajarilsa ikkisi ham
 * "kelish" bo'lib qolardi.
 *
 * ⚠️ Bitta qayd yiqilsa qolganlari DAVOM ETADI: navbatdagi bitta
 * buzuq yozuv butun kunning davomatini to'sib qo'ymasligi kerak.
 *
 * @param {{ kiosk: object, events: Array }} input
 * @returns {Promise<{ accepted: number, results: Array }>}
 */
async function submitBulk({ kiosk, events }) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new BadRequestError("Yuborish uchun qayd yo'q");
  }
  if (events.length > 200) {
    throw new BadRequestError("Bir so'rovda 200 tadan ko'p qayd yuborilmaydi");
  }

  const results = [];
  for (const event of events) {
    try {
      const outcome = await submitCheck({ ...event, kiosk, offline: true });
      results.push({ clientEventId: event.clientEventId ?? null, ...outcome });
    } catch (error) {
      // Mijoz navbatdan O'CHIRISHI uchun javob baribir qaytadi.
      results.push({
        clientEventId: event.clientEventId ?? null,
        result: RESULT.ERROR,
        ok: false,
        message: error?.message || "Qayd qabul qilinmadi",
      });
    }
  }

  return { accepted: results.length, results };
}

/* ═══════════════════════ JURNAL (PANEL) ═══════════════════════ */

/**
 * Urinishlar jurnali — sahifalangan.
 *
 * ⚠️ `occurredAt` bo'yicha tartiblanadi, `createdAt` bo'yicha EMAS:
 * oflayn navbatdan kelgan qayd kechagi vaqtga tegishli va ro'yxat
 * HODISA vaqtini ko'rsatishi kerak (`AccountEntry` da registr `seq`,
 * hisobot `occurredAt` bo'yicha bo'lgani bilan ayni mulohaza).
 */
async function listEvents(query = {}) {
  const { page, limit, skip } = getPaginationParams({ query });
  const where = {};

  if (query.result && query.result !== "all") where.result = query.result;
  if (query.kind && query.kind !== "all") where.kind = query.kind;
  if (query.kioskId) where.kioskId = query.kioskId;
  if (query.userId) where.userId = query.userId;
  if (query.offline === "true") where.offline = true;

  if (query.from || query.to) {
    where.occurredAt = {};
    if (query.from) where.occurredAt.gte = new Date(query.from);
    if (query.to) {
      const to = new Date(query.to);
      to.setUTCHours(23, 59, 59, 999);
      where.occurredAt.lte = to;
    }
  }

  const [rows, total] = await Promise.all([
    prisma.faceCheckEvent.findMany({
      where,
      orderBy: { occurredAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.faceCheckEvent.count({ where }),
  ]);

  return formatPaginationResponse(
    rows.map((row) => ({
      id: row.id,
      kioskId: row.kioskId,
      kioskName: row.kioskName,
      userId: row.userId,
      userName: row.userName,
      userRole: row.userRole,
      kind: row.kind,
      result: row.result,
      score: row.score,
      scorePercent: scoreToPercent(row.score),
      margin: row.margin,
      liveness: row.liveness,
      antispoof: row.antispoof,
      message: row.message,
      attendanceId: row.attendanceId,
      snapshotUrl: row.snapshotUrl,
      offline: row.offline,
      occurredAt: row.occurredAt,
      createdAt: row.createdAt,
    })),
    total,
    page,
    limit,
  );
}

/**
 * Bugungi yig'indi — panel manzarasi.
 *
 * ⚠️ `result` bo'yicha guruhlanadi va MUVAFFAQIYATSIZLARI HAM chiqadi:
 * "bugun 3 marta tiriklik tekshiruvi rad etdi" degan raqam ko'rinmasa,
 * kirish eshigida nima bo'layotganini hech kim bilmasdi.
 */
async function getEventSummary({ from, to } = {}) {
  const start = from ? new Date(from) : attendanceService.getTodayNormalized();
  const end = to ? new Date(to) : new Date();
  if (to) end.setUTCHours(23, 59, 59, 999);

  const grouped = await prisma.faceCheckEvent.groupBy({
    by: ["result"],
    where: { occurredAt: { gte: start, lte: end } },
    _count: { _all: true },
  });

  const byResult = Object.fromEntries(
    Object.values(RESULT).map((key) => [key, 0]),
  );
  for (const row of grouped) byResult[row.result] = row._count._all;

  const byKind = await prisma.faceCheckEvent.groupBy({
    by: ["kind"],
    where: { occurredAt: { gte: start, lte: end }, result: RESULT.MARKED },
    _count: { _all: true },
  });

  return {
    from: start,
    to: end,
    total: grouped.reduce((sum, row) => sum + row._count._all, 0),
    marked: byResult[RESULT.MARKED],
    byResult,
    byKind: Object.fromEntries(byKind.map((row) => [row.kind, row._count._all])),
  };
}

module.exports = {
  submitCheck,
  submitBulk,
  listEvents,
  getEventSummary,
  resolveStudentStatus,
  getClassFirstLessonTime,
  decideStaffAction,
  RESULT,
  KIND,
  INTENTS,
};
