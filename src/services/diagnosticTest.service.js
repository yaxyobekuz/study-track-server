/**
 * DIAGNOSTIKA — TEST SHABLONI.
 *
 * Shablon savollarni SAQLAMAYDI, ularni TANLASH QOIDASINI saqlaydi: qaysi
 * fan, qancha savol, qanday qiyinlik, kimga va qachon ochiq. Aniq savollar
 * urinish boshlanganda bankdan olinadi va o'sha urinishga muhrlanadi.
 *
 * ⚠️ Aniq savollarni testga BIRIKTIRISH ham mumkin
 * (`DiagnosticTestQuestion`) — o'qituvchi "aynan shu 20 ta savol" desa.
 * Ikkalasi bir vaqtda ishlaydi: biriktirilgan ro'yxat bo'sh bo'lsa, qoida
 * bo'yicha tanlanadi.
 */

const prisma = require("../config/prisma");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require("../utils/errors");
const { LEVELS, LEVEL_LABELS } = require("../helpers/diagnostic.helpers");
const { getDiagnosticSettings } = require("./settings.service");

const MODES = ["adaptive", "practice", "timed", "section"];
const STATUSES = ["draft", "scheduled", "active", "archived"];

const MODE_LABELS = {
  adaptive: "Adaptiv test",
  practice: "Amaliyot",
  timed: "Vaqtli imtihon",
  section: "Bo'lim testi",
};

/**
 * ⚠️ HOLAT O'TISHLARI.
 *
 * `draft → scheduled|active` — nashr qilish. `active → archived` — yopish.
 * `archived` dan faqat `draft` ga qaytish mumkin: arxivlangan test qayta
 * ochilsa, unga tegishli sana va sinf ro'yxati qaytadan ko'rib chiqilishi
 * kerak, aks holda o'tgan yilgi test bugun jimgina ochilib ketardi.
 */
const STATUS_TRANSITIONS = {
  draft: ["scheduled", "active", "archived"],
  scheduled: ["active", "draft", "archived"],
  active: ["archived", "scheduled"],
  archived: ["draft"],
};

const TEST_INCLUDE = {
  classes: { include: { class: { select: { id: true, name: true } } } },
  _count: { select: { questions: true, attempts: true } },
};

function _shape(test) {
  if (!test) return null;
  const { classes, _count, ...rest } = test;
  return {
    ...rest,
    blueprintLabels: test.blueprintLabels || [],
    modeLabel: MODE_LABELS[test.mode] || test.mode,
    levelLabel: test.level ? LEVEL_LABELS[test.level] : null,
    classes: (classes || []).map((tc) => tc.class),
    pinnedQuestionCount: _count?.questions ?? 0,
    attemptCount: _count?.attempts ?? 0,
  };
}

// ─────────────────────────────────────────────
// VALIDATSIYA
// ─────────────────────────────────────────────

function _parseDate(value, field) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError(`${field} sanasi noto'g'ri`);
  }
  return date;
}

async function _parsePayload(data, { partial = false } = {}) {
  const settings = await getDiagnosticSettings();
  const out = {};

  if (data.title !== undefined || !partial) {
    const title = String(data.title ?? "").trim();
    if (title.length < 2) throw new BadRequestError("Test nomi kamida 2 belgi");
    if (title.length > 160) {
      throw new BadRequestError("Test nomi 160 belgidan oshmasligi kerak");
    }
    out.title = title;
  }

  if (data.description !== undefined) {
    out.description = data.description ? String(data.description).trim() : null;
  }

  if (data.subjectId !== undefined) {
    if (!data.subjectId) {
      out.subjectId = null;
    } else {
      const subject = await prisma.subject.findUnique({
        where: { id: data.subjectId },
      });
      if (!subject) throw new NotFoundError("Fan topilmadi");
      out.subjectId = subject.id;
    }
  }

  if (data.mode !== undefined || !partial) {
    const mode = data.mode ?? "practice";
    if (!MODES.includes(mode)) throw new BadRequestError(`Noma'lum rejim: ${mode}`);
    out.mode = mode;
  }

  if (data.level !== undefined) {
    if (!data.level) out.level = null;
    else {
      if (!LEVELS.includes(data.level)) {
        throw new BadRequestError(`Noma'lum qiyinlik: ${data.level}`);
      }
      out.level = data.level;
    }
  }

  if (data.grade !== undefined) {
    if (data.grade === null || data.grade === "") out.grade = null;
    else {
      const grade = parseInt(data.grade, 10);
      if (Number.isNaN(grade) || grade < 1 || grade > 11) {
        throw new BadRequestError("Sinf darajasi 1 dan 11 gacha bo'lishi kerak");
      }
      out.grade = grade;
    }
  }

  if (data.questionCount !== undefined || !partial) {
    const count = parseInt(data.questionCount ?? settings.defaultQuestionCount, 10);
    if (Number.isNaN(count) || count < 1 || count > 100) {
      throw new BadRequestError("Savollar soni 1 dan 100 gacha bo'lishi kerak");
    }
    out.questionCount = count;
  }

  if (data.durationMin !== undefined || !partial) {
    const duration = parseInt(data.durationMin ?? settings.defaultDurationMin, 10);
    if (Number.isNaN(duration) || duration < 1 || duration > 300) {
      throw new BadRequestError("Davomiylik 1 dan 300 daqiqagacha bo'lishi kerak");
    }
    out.durationMin = duration;
  }

  if (data.attemptsAllowed !== undefined || !partial) {
    const attempts = parseInt(data.attemptsAllowed ?? settings.defaultAttempts, 10);
    if (Number.isNaN(attempts) || attempts < 1 || attempts > 20) {
      throw new BadRequestError("Urinishlar soni 1 dan 20 gacha bo'lishi kerak");
    }
    out.attemptsAllowed = attempts;
  }

  for (const flag of ["shuffleQuestions", "shuffleOptions", "showAnswers"]) {
    if (data[flag] !== undefined) out[flag] = Boolean(data[flag]);
  }

  const from = _parseDate(data.availableFrom, "Boshlanish");
  const to = _parseDate(data.availableTo, "Tugash");
  if (data.availableFrom !== undefined) out.availableFrom = from;
  if (data.availableTo !== undefined) out.availableTo = to;
  if (from && to && from >= to) {
    throw new BadRequestError("Tugash sanasi boshlanish sanasidan keyin bo'lishi kerak");
  }

  return out;
}

async function _resolveClassIds(classIds) {
  const list = [...new Set((classIds || []).filter(Boolean))];
  if (list.length === 0) return [];

  const classes = await prisma.class.findMany({
    where: { id: { in: list } },
    select: { id: true },
  });
  if (classes.length !== list.length) {
    throw new BadRequestError("Tanlangan sinflardan biri topilmadi");
  }
  return classes.map((c) => c.id);
}

/**
 * Biriktirilgan savollarni tekshiradi.
 *
 * ⚠️ FAQAT TASDIQLANGAN SAVOL BIRIKTIRILADI. Qoralama savol testga tushsa,
 * o'quvchi tekshirilmagan (ehtimol xato) savolga javob berardi va uning
 * natijasi yolg'on bo'lardi.
 */
async function _resolveQuestionIds(questionIds) {
  const list = [...new Set((questionIds || []).filter(Boolean))];
  if (list.length === 0) return [];

  const questions = await prisma.diagnosticQuestion.findMany({
    where: { id: { in: list } },
    select: { id: true, status: true, code: true },
  });

  const found = new Map(questions.map((q) => [q.id, q]));
  const missing = list.filter((id) => !found.has(id));
  if (missing.length) {
    throw new BadRequestError(`${missing.length} ta savol topilmadi`);
  }

  const notApproved = questions.filter((q) => q.status !== "approved");
  if (notApproved.length) {
    throw new BadRequestError(
      `Tasdiqlanmagan savollarni testga qo'shib bo'lmaydi: ${notApproved
        .map((q) => q.code)
        .join(", ")}`,
    );
  }

  // Tartib foydalanuvchi bergan tartibda saqlanadi.
  return list;
}

// ─────────────────────────────────────────────
// O'QISH
// ─────────────────────────────────────────────

async function listTests(query = {}, pagination) {
  const where = {};
  if (query.status && STATUSES.includes(query.status)) where.status = query.status;
  if (query.subjectId) where.subjectId = query.subjectId;
  if (query.mode && MODES.includes(query.mode)) where.mode = query.mode;
  if (query.classId) where.classes = { some: { classId: query.classId } };
  if (query.grade) {
    const grade = parseInt(query.grade, 10);
    if (!Number.isNaN(grade)) where.grade = grade;
  }

  const search = String(query.search || "").trim();
  if (search) where.title = { contains: search, mode: "insensitive" };

  const [total, rows] = await Promise.all([
    prisma.diagnosticTest.count({ where }),
    prisma.diagnosticTest.findMany({
      where,
      include: TEST_INCLUDE,
      orderBy: { createdAt: "desc" },
      skip: pagination.skip,
      take: pagination.limit,
    }),
  ]);

  const subjects = await _attachSubjects(rows);
  return { total, rows: subjects.map(_shape) };
}

/** `subjectId` — ixtiyoriy FK, `include` bilan olinmaydi (nullable relation yo'q). */
async function _attachSubjects(rows) {
  /**
   * ⚠️ TAQSIMOTDAGI FANLAR HAM YUKLANADI. Ro'yxatda har test yonida
   * "Matematika (7-sinf)" kabi yorliqlar turadi; ularni panelda
   * fanlar katalogidan qidirish har qator uchun alohida so'rov
   * bo'lardi (N+1).
   */
  const ids = [
    ...new Set(
      rows
        .flatMap((r) => [
          r.subjectId,
          ...(Array.isArray(r.blueprint) ? r.blueprint.map((b) => b?.subjectId) : []),
        ])
        .filter(Boolean),
    ),
  ];
  if (!ids.length) {
    return rows.map((r) => ({ ...r, subject: null, blueprintLabels: [] }));
  }

  const subjects = await prisma.subject.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  const map = new Map(subjects.map((s) => [s.id, s]));

  return rows.map((r) => ({
    ...r,
    subject: map.get(r.subjectId) || null,
    blueprintLabels: (Array.isArray(r.blueprint) ? r.blueprint : []).map((b) => {
      const name = map.get(b?.subjectId)?.name || "Fan";
      return {
        subjectId: b?.subjectId || null,
        name,
        grade: b?.grade ?? null,
        // Yorliq matni SERVERDA yig'iladi — panel va Excel bir xil
        // ko'rinishda chiqarishi uchun.
        label: b?.grade ? `${name} (${b.grade}-sinf)` : name,
        easy: b?.easy ?? 0,
        medium: b?.medium ?? 0,
        hard: b?.hard ?? 0,
      };
    }),
  }));
}

async function getTestById(id) {
  const test = await prisma.diagnosticTest.findUnique({
    where: { id },
    include: {
      ...TEST_INCLUDE,
      questions: {
        orderBy: { position: "asc" },
        include: {
          question: {
            select: {
              id: true,
              code: true,
              text: true,
              type: true,
              difficulty: true,
              points: true,
              status: true,
              topicId: true,
            },
          },
        },
      },
    },
  });
  if (!test) throw new NotFoundError("Test topilmadi");

  const [withSubject] = await _attachSubjects([test]);
  const shaped = _shape(withSubject);
  shaped.questions = (test.questions || []).map((tq) => ({
    ...tq.question,
    position: tq.position,
  }));
  return shaped;
}

/**
 * Test qoidasiga mos savollar bankda YETARLIMI.
 *
 * ⚠️ Bu tekshiruv NASHR QILISHDAN OLDIN chaqiriladi. Usiz test e'lon
 * qilinardi, o'quvchi esa boshlaganda "mos savollar topilmadi" xatosini
 * olardi — ya'ni muammo eng noqulay joyda, o'quvchining oldida chiqardi.
 */
async function checkAvailability(test) {
  const pinned = await prisma.diagnosticTestQuestion.count({
    where: { testId: test.id },
  });
  if (pinned > 0) {
    return {
      required: test.questionCount,
      available: pinned,
      pinned: true,
      enough: pinned >= 1,
    };
  }

  const available = await prisma.diagnosticQuestion.count({
    where: _bankFilter(test),
  });

  return {
    required: test.questionCount,
    available,
    pinned: false,
    enough: available >= test.questionCount,
  };
}

/** Bankdan savol tanlash sharti — bitta joyda (urinish ham shuni ishlatadi). */
function _bankFilter(test, { levels = null } = {}) {
  // ⚠️ `essay` CHIQARIB TASHLANADI — urinish tanlovi bilan AYNI shart
  // (`diagnosticAttempt.service.js`: `type: { not: "essay" }`). Ilgari bu
  // yerda filtr yo'q edi va tekshiruv insho savollarini ham sanardi:
  // nashr paytida "bankda yetarli savol bor" deyilar, o'quvchi esa
  // kamroq savol olardi. Ikki joyda ikki shart — aynan shu tafovut.
  const where = { status: "approved", type: { not: "essay" } };
  if (test.subjectId) where.subjectId = test.subjectId;
  if (test.grade) where.grade = test.grade;

  const levelList = levels || (test.level ? [test.level] : null);
  if (levelList && levelList.length) where.difficulty = { in: levelList };

  return where;
}

// ─────────────────────────────────────────────
// YOZISH
// ─────────────────────────────────────────────


/**
 * SAVOLLAR TAQSIMOTI BO'YICHA BANKDAN TANLASH.
 *
 * Har qator: `{ subjectId, grade, easy, medium, hard }` — qaysi fandan,
 * qaysi sinf bazasidan, nechta yengil / o'rta / og'ir savol.
 *
 * ⚠️ "OG'IR" IKKI DARAJANI QAMRAYDI (`hard` + `expert`). Bankda
 `expert` savollar kam bo'ladi; ularni alohida qator qilib so'rash
 * o'qituvchini har safar "yetarli savol yo'q" xatosiga urardi.
 *
 * ⚠️ TAKRORIY MATN BIR TESTGA IKKI MARTA TUSHMAYDI. Bank turli
 * sinflar uchun bir xil savolni saqlashi mumkin (masalan "2+2"),
 * shuning uchun tanlov MATN bo'yicha ham solishtiriladi — id bo'yicha
 * emas.
 *
 * ⚠️ YETMASA — O'SHA FAN VA SINFNING istalgan darajasidan to'ldiriladi,
 * lekin BOSHQA FANGA O'TILMAYDI: "matematikadan 10 ta" degan so'rovga
 * fizika savoli qo'shilsa, test o'z ma'nosini yo'qotardi. To'ldirib
 * bo'lmagan qator OGOHLANTIRISH bo'lib qaytadi.
 */
const BLUEPRINT_LEVELS = [
  ["easy", ["easy"]],
  ["medium", ["medium"]],
  ["hard", ["hard", "expert"]],
];

function _normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

async function selectByBlueprint(blueprint, { language = null } = {}) {
  const selected = [];
  const warnings = [];
  const seenText = new Set();
  const seenId = new Set();

  const take = (pool, want) => {
    let taken = 0;
    for (const q of pool) {
      if (taken >= want) break;
      if (seenId.has(q.id)) continue;
      const key = _normalizeText(q.text);
      if (seenText.has(key)) continue;
      seenText.add(key);
      seenId.add(q.id);
      selected.push(q.id);
      taken += 1;
    }
    return taken;
  };

  for (const row of blueprint) {
    const base = {
      status: "approved",
      // Insho avtomat baholanmaydi — biriktirilgan testga tasodifan
      // tushib qolsa, ball maxrajini jimgina kichraytirardi.
      type: { not: "essay" },
      subjectId: row.subjectId,
      ...(row.grade ? { grade: row.grade } : {}),
      ...(language ? { language } : {}),
    };

    const want =
      (Number(row.easy) || 0) + (Number(row.medium) || 0) + (Number(row.hard) || 0);
    if (want <= 0) continue;

    let picked = 0;
    for (const [key, difficulties] of BLUEPRINT_LEVELS) {
      const need = Number(row[key]) || 0;
      if (need <= 0) continue;

      const pool = await prisma.diagnosticQuestion.findMany({
        where: { ...base, difficulty: { in: difficulties } },
        select: { id: true, text: true },
        // Kam ishlatilgani birinchi — bank bo'ylab yuk teng taqsimlanadi.
        orderBy: [{ usageCount: "asc" }, { createdAt: "asc" }],
        take: Math.max(need * 4, 40),
      });
      picked += take(pool, need);
    }

    if (picked < want) {
      const filler = await prisma.diagnosticQuestion.findMany({
        where: base,
        select: { id: true, text: true },
        orderBy: [{ usageCount: "asc" }, { createdAt: "asc" }],
        take: (want - picked) * 4 + 40,
      });
      picked += take(filler, want - picked);
    }

    if (picked < want) {
      const subject = await prisma.subject.findUnique({
        where: { id: row.subjectId },
        select: { name: true },
      });
      warnings.push(
        `${subject?.name || "Fan"}${row.grade ? ` (${row.grade}-sinf)` : ""}: ` +
          `${want} ta so'raldi, bankda ${picked} ta topildi`,
      );
    }
  }

  return { questionIds: selected, warnings };
}

/**
 * Taqsimotni tozalaydi: yaroqsiz qatorlar tushib qoladi, sonlar
 * chegaraga solinadi.
 */
function _parseBlueprint(raw) {
  if (!Array.isArray(raw)) return null;

  const rows = raw
    .map((row) => ({
      subjectId: row?.subjectId || null,
      grade: row?.grade ? parseInt(row.grade, 10) || null : null,
      easy: Math.max(0, Math.min(100, parseInt(row?.easy, 10) || 0)),
      medium: Math.max(0, Math.min(100, parseInt(row?.medium, 10) || 0)),
      hard: Math.max(0, Math.min(100, parseInt(row?.hard, 10) || 0)),
    }))
    .filter((row) => row.subjectId && row.easy + row.medium + row.hard > 0);

  return rows.length ? rows : null;
}

async function createTest(data, createdBy) {
  const parsed = await _parsePayload(data);
  const classIds = await _resolveClassIds(data.classIds);
  const blueprint = _parseBlueprint(data.blueprint);

  /**
   * ⚠️ TAQSIMOT BERILGAN BO'LSA, SAVOLLAR O'SHANDAN TANLANADI va
   * `questionIds` E'TIBORGA OLINMAYDI. Ikkalasini birga qabul qilish
   * "reja bir narsa, savollar boshqa narsa" degan holatni yaratardi
   * va testni keyin tahrirlaganda qaysi biri haqiqat ekani noma'lum
   * bo'lib qolardi.
   */
  let questionIds;
  let warnings = [];
  if (blueprint) {
    const result = await selectByBlueprint(blueprint);
    questionIds = result.questionIds;
    warnings = result.warnings;
    if (!questionIds.length) {
      throw new BadRequestError(
        "Taqsimot bo'yicha bankdan birorta savol topilmadi. Fan, sinf va sonlarni tekshiring.",
      );
    }
  } else {
    questionIds = await _resolveQuestionIds(data.questionIds);
  }

  const test = await prisma.diagnosticTest.create({
    data: {
      ...parsed,
      // Taqsimot bo'lsa, savollar soni TANLANGANIGA tenglashadi:
      // rejada 40 ta so'ralib 34 tasi topilsa, o'quvchiga 40 ta
      // savol va'da qilib bo'lmaydi.
      ...(blueprint ? { blueprint, questionCount: questionIds.length } : {}),
      status: "draft",
      createdBy,
      classes: { create: classIds.map((classId) => ({ classId })) },
      questions: {
        create: questionIds.map((questionId, position) => ({ questionId, position })),
      },
    },
    include: TEST_INCLUDE,
  });

  const [withSubject] = await _attachSubjects([test]);
  return { ...(_shape(withSubject) || {}), warnings };
}

/**
 * Tahrirlash.
 *
 * ⚠️ URINISHI BOR TESTNING QOIDASI O'ZGARMAYDI (savollar soni, davomiylik,
 * qiyinlik, fan). Sabab: birinchi o'quvchi 20 savolga javob berib bo'lgan,
 * ikkinchisi esa 30 tasini olardi va ikkalasining natijasi bitta jadvalda
 * taqqoslanardi. Nomi, tavsifi, sinflar ro'yxati va oynasi esa O'ZGARADI —
 * ular natijaning ma'nosiga tegmaydi.
 */
const LOCKED_AFTER_ATTEMPT = [
  "questionCount",
  "durationMin",
  "mode",
  "level",
  "subjectId",
  "grade",
];

async function updateTest(id, data) {
  const existing = await prisma.diagnosticTest.findUnique({
    where: { id },
    include: { _count: { select: { attempts: true } } },
  });
  if (!existing) throw new NotFoundError("Test topilmadi");

  /**
   * ⚠️ TAQSIMOT O'ZGARSA, SAVOLLAR QAYTA TANLANADI — lekin faqat
   * URINISH BO'LMAGAN testda. Urinishi bor testning savollari
   * o'zgarsa, birinchi o'quvchi bir to'plamga, ikkinchisi boshqasiga
   * javob bergan bo'lardi va ularning natijasi bitta jadvalda
   * taqqoslanardi (quyidagi `LOCKED_AFTER_ATTEMPT` bilan bir xil
   * mantiq).
   */
  const blueprint = _parseBlueprint(data.blueprint);
  let reselected = null;
  let warnings = [];
  if (blueprint && existing._count.attempts === 0) {
    const result = await selectByBlueprint(blueprint);
    if (!result.questionIds.length) {
      throw new BadRequestError(
        "Taqsimot bo'yicha bankdan birorta savol topilmadi. Fan, sinf va sonlarni tekshiring.",
      );
    }
    reselected = result.questionIds;
    warnings = result.warnings;
  }

  const parsed = await _parsePayload(data, { partial: true });

  if (existing._count.attempts > 0) {
    const locked = LOCKED_AFTER_ATTEMPT.filter(
      (field) => parsed[field] !== undefined && parsed[field] !== existing[field],
    );
    if (locked.length) {
      throw new BadRequestError(
        "Testda urinishlar bor — savollar soni, davomiylik, rejim, qiyinlik va fanni o'zgartirib bo'lmaydi. Yangi test yarating.",
      );
    }
    if (data.questionIds !== undefined) {
      throw new BadRequestError(
        "Testda urinishlar bor — savollar ro'yxatini o'zgartirib bo'lmaydi",
      );
    }
  }

  const classIds =
    data.classIds !== undefined ? await _resolveClassIds(data.classIds) : null;
  const questionIds =
    data.questionIds !== undefined
      ? await _resolveQuestionIds(data.questionIds)
      : null;

  // Taqsimotdan qayta tanlangan savollar qo'lda berilganidan ustun.
  const finalQuestionIds = reselected ?? questionIds;

  const updated = await prisma.$transaction(async (tx) => {
    if (classIds) {
      await tx.diagnosticTestClass.deleteMany({ where: { testId: id } });
    }
    if (finalQuestionIds) {
      await tx.diagnosticTestQuestion.deleteMany({ where: { testId: id } });
    }
    return tx.diagnosticTest.update({
      where: { id },
      data: {
        ...parsed,
        ...(blueprint && reselected
          ? { blueprint, questionCount: reselected.length }
          : {}),
        ...(classIds
          ? { classes: { create: classIds.map((classId) => ({ classId })) } }
          : {}),
        ...(finalQuestionIds
          ? {
              questions: {
                create: finalQuestionIds.map((questionId, position) => ({
                  questionId,
                  position,
                })),
              },
            }
          : {}),
      },
      include: TEST_INCLUDE,
    });
  });

  const [withSubject] = await _attachSubjects([updated]);
  return { ...(_shape(withSubject) || {}), warnings };
}

/**
 * Holatni o'zgartirish. `active`/`scheduled` ga o'tishda bank tekshiriladi.
 */
async function updateTestStatus(id, status) {
  if (!STATUSES.includes(status)) {
    throw new BadRequestError(`Noma'lum holat: ${status}`);
  }

  const test = await prisma.diagnosticTest.findUnique({ where: { id } });
  if (!test) throw new NotFoundError("Test topilmadi");
  if (test.status === status) return getTestById(id);

  const allowed = STATUS_TRANSITIONS[test.status] || [];
  if (!allowed.includes(status)) {
    throw new BadRequestError(
      `"${test.status}" holatidan "${status}" holatiga o'tib bo'lmaydi`,
    );
  }

  if (status === "active" || status === "scheduled") {
    const availability = await checkAvailability(test);
    if (!availability.enough) {
      throw new BadRequestError(
        `Bankda yetarli savol yo'q: ${availability.available} ta bor, ${availability.required} ta kerak. Savol qo'shing yoki savollar sonini kamaytiring.`,
        availability,
      );
    }
    if (status === "scheduled" && !test.availableFrom) {
      throw new BadRequestError(
        "Rejalashtirish uchun boshlanish sanasi ko'rsatilishi kerak",
      );
    }
  }

  await prisma.diagnosticTest.update({
    where: { id },
    data: {
      status,
      publishedAt:
        (status === "active" || status === "scheduled") && !test.publishedAt
          ? new Date()
          : test.publishedAt,
    },
  });

  return getTestById(id);
}

/**
 * O'chirish.
 *
 * ⚠️ URINISHI BOR TEST O'CHIRILMAYDI — ARXIVLANADI. Natijalar tarixi
 * testning nomiga va qoidasiga ishora qiladi; qatorni yo'q qilish o'sha
 * tarixni ma'nosiz qilardi (hisob-faktura doktrinasi bilan bir xil).
 */
async function deleteTest(id) {
  const test = await prisma.diagnosticTest.findUnique({
    where: { id },
    include: { _count: { select: { attempts: true } } },
  });
  if (!test) throw new NotFoundError("Test topilmadi");

  if (test._count.attempts > 0) {
    await prisma.diagnosticTest.update({
      where: { id },
      data: { status: "archived" },
    });
    return {
      archived: true,
      message: `Testda ${test._count.attempts} ta urinish bor — o'chirilmadi, arxivlandi.`,
    };
  }

  await prisma.diagnosticTest.delete({ where: { id } });
  return { archived: false, message: "Test o'chirildi" };
}

// ─────────────────────────────────────────────
// O'QUVCHI TOMONI
// ─────────────────────────────────────────────

/**
 * O'quvchiga OCHIQ testlar.
 *
 * Shartlar: `active` holat, oyna ichida, sinf mos (yoki test butun
 * maktabga), urinishlar limiti tugamagan.
 *
 * ⚠️ `scheduled` test RO'YXATDA KO'RINADI, lekin boshlab bo'lmaydi:
 * o'quvchi "ertaga matematikadan diagnostika bor" degan ma'lumotni
 * ko'rishi kerak, aks holda test kutilmaganda paydo bo'lardi.
 */
/**
 * Sanaga qarab test holatlarini haqiqatga moslaydi (cron chaqiradi).
 *
 * ⚠️ ILGARI BUNI HECH KIM QILMASDI. `scheduled` — "falon sanada ochiladi"
 * degan va'da, lekin uni `active` ga o'tkazadigan yo'l yo'q edi: sana
 * kelsa ham test yopiq turaverardi va o'quvchi ro'yxatida ko'rinmasdi
 * (`listAvailableForStudent` `canStart` ni faqat `active` ga beradi).
 * Ya'ni "rejalashtirilgan test" xususiyati amalda ISHLAMASDI.
 *
 * ⚠️ Muddati tugagan test ham YOPILADI. U o'quvchiga baribir ko'rinmasdi
 * (`availableTo` filtri), lekin panelda "Faol" deb turardi — holat
 * haqiqatni aytmasa, ro'yxatning ma'nosi qolmaydi.
 *
 * Ikkalasi ham IDEMPOTENT: qayta ishlaganda o'zgaradigan qator qolmaydi.
 */
async function syncTestStatuses() {
  const now = new Date();

  const opened = await prisma.diagnosticTest.updateMany({
    where: {
      status: "scheduled",
      availableFrom: { not: null, lte: now },
      OR: [{ availableTo: null }, { availableTo: { gt: now } }],
    },
    // ⚠️ `publishedAt` ga TEGILMAYDI: u test `scheduled` qilingan paytda
    // allaqachon qo'yilgan (`updateTestStatus`). Bu yerda qayta yozilsa,
    // "kim va qachon nashr qildi" degan iz yo'qolardi.
    data: { status: "active" },
  });

  const closed = await prisma.diagnosticTest.updateMany({
    where: {
      status: { in: ["active", "scheduled"] },
      availableTo: { not: null, lte: now },
    },
    data: { status: "archived" },
  });

  return { opened: opened.count, closed: closed.count };
}

async function listAvailableForStudent(studentId) {
  const now = new Date();

  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { id: true, classes: { select: { classId: true } } },
  });
  if (!student) throw new NotFoundError("O'quvchi topilmadi");

  const classIds = student.classes.map((c) => c.classId);

  const tests = await prisma.diagnosticTest.findMany({
    where: {
      status: { in: ["active", "scheduled"] },
      OR: [
        { classes: { none: {} } },
        ...(classIds.length ? [{ classes: { some: { classId: { in: classIds } } } }] : []),
      ],
      AND: [
        { OR: [{ availableTo: null }, { availableTo: { gt: now } }] },
      ],
    },
    include: TEST_INCLUDE,
    orderBy: [{ availableFrom: "asc" }, { createdAt: "desc" }],
  });

  if (!tests.length) return [];

  const attempts = await prisma.diagnosticAttempt.groupBy({
    by: ["testId"],
    where: { studentId, testId: { in: tests.map((t) => t.id) } },
    _count: { _all: true },
  });
  const usedByTest = new Map(attempts.map((a) => [a.testId, a._count._all]));

  const withSubjects = await _attachSubjects(tests);

  return withSubjects.map((test) => {
    const used = usedByTest.get(test.id) || 0;
    const opened = !test.availableFrom || test.availableFrom <= now;
    return {
      ..._shape(test),
      attemptsUsed: used,
      attemptsLeft: Math.max(0, test.attemptsAllowed - used),
      canStart:
        test.status === "active" && opened && used < test.attemptsAllowed,
      opensAt: opened ? null : test.availableFrom,
    };
  });
}

/**
 * Urinish boshlashga RUXSAT bormi — bitta joyda.
 * Urinish servisi ham, o'quvchi ro'yxati ham shuni ishlatadi.
 */
async function assertCanStart(test, studentId) {
  const now = new Date();

  if (test.status !== "active") {
    throw new BadRequestError("Test hozircha ochiq emas");
  }
  if (test.availableFrom && test.availableFrom > now) {
    throw new BadRequestError("Test hali boshlanmagan");
  }
  if (test.availableTo && test.availableTo <= now) {
    throw new BadRequestError("Test yopilgan");
  }

  const classLinks = await prisma.diagnosticTestClass.count({
    where: { testId: test.id },
  });
  if (classLinks > 0) {
    const belongs = await prisma.diagnosticTestClass.count({
      where: {
        testId: test.id,
        class: { users: { some: { userId: studentId } } },
      },
    });
    if (belongs === 0) {
      throw new ForbiddenError("Bu test sizning sinfingizga biriktirilmagan");
    }
  }

  const used = await prisma.diagnosticAttempt.count({
    where: { testId: test.id, studentId },
  });
  if (used >= test.attemptsAllowed) {
    throw new BadRequestError(
      `Urinishlar tugadi (${test.attemptsAllowed} tadan ${used} ta ishlatilgan)`,
    );
  }

  // ⚠️ TARTIB RAQAMI SANOQDAN EMAS, ENG KATTASIDAN OLINADI.
  //
  // `used + 1` o'chirilgan urinishdan keyin BAND raqamni qaytarardi
  // (3 tadan 2-si o'chirilsa: count = 2 → 3, lekin 3 allaqachon bor) va
  // noyob indeks yozuvni rad etardi. Eng katta mavjud raqamdan bittaga
  // oshirish bunday holatni tug'dirmaydi; parallel ikkita so'rov esa
  // baribir bo'lishi mumkin va uni indeksning o'zi ushlaydi
  // (`startAttempt` P2002 da qayta uriniladi).
  const last = await prisma.diagnosticAttempt.findFirst({
    where: { testId: test.id, studentId },
    orderBy: { attemptNumber: "desc" },
    select: { attemptNumber: true },
  });

  return { attemptNumber: (last?.attemptNumber ?? 0) + 1 };
}

module.exports = {
  MODES,
  MODE_LABELS,
  STATUSES,
  STATUS_TRANSITIONS,
  listTests,
  getTestById,
  createTest,
  updateTest,
  updateTestStatus,
  deleteTest,
  checkAvailability,
  listAvailableForStudent,
  syncTestStatuses,
  assertCanStart,
  _bankFilter,
};
