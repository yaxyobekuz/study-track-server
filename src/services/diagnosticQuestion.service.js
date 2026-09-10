/**
 * DIAGNOSTIKA — SAVOLLAR BANKI.
 *
 * Mavjud `question.service.js` dan farqi bitta va u tub: u yerda savol
 * TESTGA tegishli (`testId` majburiy) va bir marta ishlatiladi, bu yerda esa
 * savol — QAYTA ISHLATILADIGAN bank birligi. Shuning uchun bu yerda mavjud
 * bo'lgan, u yerda esa umuman ma'nosiz bo'ladigan narsalar bor:
 *   - moderatsiya holati (`draft → review → approved`),
 *   - ishlatilish statistikasi (`usageCount`, `accuracy`),
 *   - fan + mavzu + qiyinlik bo'yicha saralash.
 */

const XLSX = require("xlsx");
const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const { uploadFile } = require("./file.service");
const { deleteObject } = require("./fileStorage.service");
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
} = require("../utils/errors");
const {
  LEVELS,
  LEVEL_LABELS,
  AUTO_GRADED_TYPES,
  needsOptions,
  normalizeText,
} = require("../helpers/diagnostic.helpers");

const QUESTION_TYPES = [...AUTO_GRADED_TYPES, "essay"];
const STATUSES = ["draft", "review", "approved", "archived"];

/** Foydalanuvchi ko'radigan tur nomlari (xato xabarlari va eksport uchun). */
const TYPE_LABELS = {
  single: "Bitta to'g'ri javob",
  multiple: "Bir nechta to'g'ri javob",
  truefalse: "To'g'ri / Noto'g'ri",
  gap: "Bo'sh joyni to'ldirish",
  short: "Qisqa javob",
  essay: "Insho",
};

/**
 * ⚠️ MODERATSIYA O'TISHLARI QAT'IY.
 *
 * Sabab: "tasdiqlangan" savol o'quvchining darajasini o'lchaydi va uning
 * o'quv rejasini belgilaydi. Agar arxivdan to'g'ridan-to'g'ri `approved` ga
 * o'tish mumkin bo'lsa, bir marta chiqarib tashlangan xato savol qayta
 * ko'rikdan o'tmasdan bankka qaytardi.
 *
 * `archived` — YAGONA teskari yo'l (istalgan holatdan), chunki u savolni
 * ISHLATISHDAN chiqaradi, ishlatishga qo'ymaydi.
 */
const STATUS_TRANSITIONS = {
  draft: ["review", "archived"],
  review: ["approved", "draft", "archived"],
  approved: ["review", "archived"],
  archived: ["draft"],
};

// ─────────────────────────────────────────────
// KOD GENERATSIYASI
// ─────────────────────────────────────────────

/**
 * Inson o'qiydigan kod: `D-000418`.
 *
 * ⚠️ `count() + 1` ISHLATILMAYDI — o'chirilgan savoldan keyin raqam qayta
 * ishlatilib, noyoblik buzilardi. Eng katta MAVJUD koddan bittaga oshiriladi.
 * To'qnashuv baribir bo'lsa (parallel ikkita so'rov), `create` P2002 bilan
 * yiqiladi va bir marta qayta uriniladi.
 */
async function _nextCode() {
  const last = await prisma.diagnosticQuestion.findFirst({
    orderBy: { code: "desc" },
    select: { code: true },
  });
  const lastNumber = last ? parseInt(last.code.replace(/\D/g, ""), 10) || 0 : 0;
  return `D-${String(lastNumber + 1).padStart(6, "0")}`;
}

// ─────────────────────────────────────────────
// VALIDATSIYA
// ─────────────────────────────────────────────

/**
 * Variantlarni tekshirib normallashtiradi.
 *
 * ⚠️ ENG MUHIM TEKSHIRUV — "kamida bitta to'g'ri variant". Usiz to'g'ri
 * javobsiz savol bankka tushardi va u HAR BIR o'quvchini jimgina xato deb
 * belgilardi: test ishlayotgandek ko'rinadi, natija esa yolg'on bo'ladi.
 */
function _normalizeOptions(type, rawOptions) {
  if (!needsOptions(type)) return [];

  const options = Array.isArray(rawOptions) ? rawOptions : [];
  const cleaned = options
    .map((opt, index) => ({
      text: typeof opt?.text === "string" ? opt.text.trim() : "",
      image: opt?.image ?? null,
      isCorrect: Boolean(opt?.isCorrect),
      position: Number.isInteger(opt?.position) ? opt.position : index,
    }))
    .filter((opt) => opt.text || opt.image);

  if (cleaned.length < 2) {
    throw new BadRequestError(
      `"${TYPE_LABELS[type] || type}" turidagi savolda kamida 2 ta variant bo'lishi kerak`,
    );
  }

  const correctCount = cleaned.filter((opt) => opt.isCorrect).length;
  if (correctCount === 0) {
    throw new BadRequestError("Kamida bitta to'g'ri variant belgilanishi kerak");
  }
  if (type !== "multiple" && correctCount > 1) {
    throw new BadRequestError(
      "Bu turdagi savolda faqat BITTA to'g'ri variant bo'lishi mumkin",
    );
  }

  // Takroriy variant matni — o'quvchi uchun ikkita bir xil javob degani.
  const seen = new Set();
  for (const opt of cleaned) {
    const key = normalizeText(opt.text);
    if (!key) continue;
    if (seen.has(key)) {
      throw new BadRequestError(`Takroriy variant: "${opt.text}"`);
    }
    seen.add(key);
  }

  return cleaned
    .sort((a, b) => a.position - b.position)
    .map((opt, index) => ({ ...opt, position: index }));
}

/** `short` turi uchun qabul qilinadigan javoblar. */
function _normalizeAccepted(type, raw) {
  if (type !== "short") return [];

  const list = (Array.isArray(raw) ? raw : [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);

  if (list.length === 0) {
    throw new BadRequestError(
      "Qisqa javobli savolda kamida bitta to'g'ri javob variantini kiriting",
    );
  }

  // Normallashgan ko'rinishi bo'yicha dedupe — "Toshkent" va "toshkent"
  // bitta javob.
  const seen = new Map();
  for (const value of list) {
    const key = normalizeText(value);
    if (key && !seen.has(key)) seen.set(key, value);
  }
  return [...seen.values()];
}

async function _assertSubjectAndTopic(subjectId, topicId) {
  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) throw new NotFoundError("Fan topilmadi");

  if (!topicId) return;

  const topic = await prisma.topic.findUnique({ where: { id: topicId } });
  if (!topic) throw new NotFoundError("Mavzu topilmadi");
  if (topic.subjectId !== subjectId) {
    throw new BadRequestError("Mavzu tanlangan fanga tegishli emas");
  }
}

/** Kiruvchi ma'lumotni tekshirib, `create`/`update` uchun tayyorlaydi. */
function _parsePayload(data, { partial = false } = {}) {
  const out = {};

  if (data.text !== undefined || !partial) {
    const text = String(data.text ?? "").trim();
    if (!text) throw new BadRequestError("Savol matni majburiy");
    if (text.length > 4000) {
      throw new BadRequestError("Savol matni 4000 belgidan oshmasligi kerak");
    }
    out.text = text;
  }

  if (data.type !== undefined || !partial) {
    const type = data.type ?? "single";
    if (!QUESTION_TYPES.includes(type)) {
      throw new BadRequestError(`Noma'lum savol turi: ${type}`);
    }
    out.type = type;
  }

  if (data.difficulty !== undefined || !partial) {
    const difficulty = data.difficulty ?? "medium";
    if (!LEVELS.includes(difficulty)) {
      throw new BadRequestError(`Noma'lum qiyinlik darajasi: ${difficulty}`);
    }
    out.difficulty = difficulty;
  }

  if (data.grade !== undefined) {
    if (data.grade === null || data.grade === "") {
      out.grade = null;
    } else {
      const grade = parseInt(data.grade, 10);
      if (Number.isNaN(grade) || grade < 1 || grade > 11) {
        throw new BadRequestError("Sinf darajasi 1 dan 11 gacha bo'lishi kerak");
      }
      out.grade = grade;
    }
  }

  if (data.points !== undefined) {
    const points = Number(data.points);
    if (Number.isNaN(points) || points <= 0 || points > 100) {
      throw new BadRequestError("Ball 0 dan katta va 100 dan kichik bo'lishi kerak");
    }
    out.points = points;
  }

  if (data.estimatedTime !== undefined) {
    const seconds = parseInt(data.estimatedTime, 10);
    if (Number.isNaN(seconds) || seconds < 5 || seconds > 3600) {
      throw new BadRequestError(
        "Kutilgan vaqt 5 soniyadan 60 daqiqagacha bo'lishi kerak",
      );
    }
    out.estimatedTime = seconds;
  }

  if (data.bloom !== undefined) {
    out.bloom = data.bloom ? String(data.bloom).trim().slice(0, 24) : null;
  }
  if (data.explanation !== undefined) {
    out.explanation = data.explanation ? String(data.explanation).trim() : null;
  }
  if (data.solution !== undefined) {
    out.solution = data.solution ? String(data.solution).trim() : null;
  }
  if (data.language !== undefined) {
    const language = String(data.language || "uz").toLowerCase();
    if (!["uz", "ru", "en"].includes(language)) {
      throw new BadRequestError("Til faqat uz, ru yoki en bo'lishi mumkin");
    }
    out.language = language;
  }

  return out;
}

// ─────────────────────────────────────────────
// RASMLAR
// ─────────────────────────────────────────────

/**
 * Multer fayllarini saqlash xizmatiga yuklaydi. Xatolik bo'lsa allaqachon
 * yuklanganlarini tozalaydi — aks holda "yetim" fayllar to'planib qolardi.
 */
async function _uploadImages(files) {
  if (!files || files.length === 0) return [];

  const uploaded = [];
  try {
    for (const file of files) {
      uploaded.push(
        await uploadFile({
          buffer: file.buffer,
          mimeType: file.mimetype,
          originalName: file.originalname,
        }),
      );
    }
    return uploaded;
  } catch (error) {
    await Promise.allSettled(uploaded.map((a) => deleteObject(a.key)));
    throw error;
  }
}

/**
 * `req.files` (multer `.fields()`) dan savol va variant rasmlarini ajratadi.
 * Maydon nomlari: `questionImage`, `optionImage_<index>`.
 */
async function _resolveImages(files) {
  if (!files) return { questionImage: null, optionImages: {} };

  const questionFiles = files.questionImage || [];
  const [questionImage] = await _uploadImages(questionFiles);

  const optionImages = {};
  for (const field of Object.keys(files)) {
    const match = /^optionImage_(\d+)$/.exec(field);
    if (!match) continue;
    const [image] = await _uploadImages(files[field]);
    if (image) optionImages[Number(match[1])] = image;
  }

  return { questionImage: questionImage || null, optionImages };
}

// ─────────────────────────────────────────────
// SHAKLLANTIRISH
// ─────────────────────────────────────────────

const QUESTION_INCLUDE = {
  options: { orderBy: { position: "asc" } },
  subject: { select: { id: true, name: true } },
  topic: { select: { id: true, name: true } },
};

/**
 * Javob shakli. `withAnswers = false` bo'lsa TO'G'RI JAVOB OLIB TASHLANADI.
 *
 * ⚠️ Bu bayroq xavfsizlik chegarasi, ko'rinish sozlamasi emas: o'quvchi
 * bankdagi savolni ko'rish huquqini olsa ham, javob kalitini olmasligi kerak.
 */
function _shape(question, { withAnswers = true } = {}) {
  if (!question) return null;

  const options = (question.options || []).map((opt) => ({
    id: opt.id,
    text: opt.text,
    image: opt.image,
    position: opt.position,
    ...(withAnswers ? { isCorrect: opt.isCorrect } : {}),
  }));

  const shaped = { ...question, options };
  if (!withAnswers) {
    delete shaped.acceptedAnswers;
    delete shaped.explanation;
    delete shaped.solution;
  }
  return shaped;
}

// ─────────────────────────────────────────────
// O'QISH
// ─────────────────────────────────────────────

/**
 * Bankdagi savollar ro'yxati (sahifalangan).
 *
 * @param {object} query - `req.query`
 * @param {{page:number,limit:number,skip:number}} pagination
 */
async function listQuestions(query = {}, pagination) {
  const where = {};

  if (query.subjectId) where.subjectId = query.subjectId;
  if (query.topicId) where.topicId = query.topicId;
  if (query.status && STATUSES.includes(query.status)) where.status = query.status;
  if (query.difficulty && LEVELS.includes(query.difficulty)) {
    where.difficulty = query.difficulty;
  }
  if (query.type && QUESTION_TYPES.includes(query.type)) where.type = query.type;
  if (query.language) where.language = String(query.language).toLowerCase();
  if (query.grade) {
    const grade = parseInt(query.grade, 10);
    if (!Number.isNaN(grade)) where.grade = grade;
  }
  if (query.authorId) where.authorId = query.authorId;

  const search = String(query.search || "").trim();
  if (search) {
    // ⚠️ MAVZU NOMI HAM QIDIRUVGA KIRADI. O'qituvchi savolni ko'pincha
    // mavzusi bilan eslaydi ("kasrlar"), matnining aynan qaysi so'zi
    // borligini emas.
    where.OR = [
      { text: { contains: search, mode: "insensitive" } },
      { code: { contains: search, mode: "insensitive" } },
      { topic: { name: { contains: search, mode: "insensitive" } } },
    ];
  }

  /**
   * TO'G'RI JAVOB FOIZI BO'YICHA FILTR.
   *
   * ⚠️ `usageCount > 0` SHARTI MAJBURIY. `accuracy` hech kim javob
   * bermagan savolda 0 bo'lib turadi; usiz "0–20%" filtri butun
   * ishlatilmagan bankni "eng qiyin savollar" deb ko'rsatib yuborardi.
   */
  const pctMin = query.pctMin !== undefined ? Number(query.pctMin) : null;
  const pctMax = query.pctMax !== undefined ? Number(query.pctMax) : null;
  const onlyAnswered =
    query.onlyAnswered === true || query.onlyAnswered === "true";

  if (Number.isFinite(pctMin) || Number.isFinite(pctMax) || onlyAnswered) {
    where.usageCount = { gt: 0 };
  }
  if (Number.isFinite(pctMin) || Number.isFinite(pctMax)) {
    where.accuracy = {};
    if (Number.isFinite(pctMin)) where.accuracy.gte = pctMin;
    if (Number.isFinite(pctMax)) where.accuracy.lte = pctMax;
  }

  /**
   * SARALASH.
   *
   * ⚠️ `accuracy` BO'YICHA SARALASHDA `usageCount` IKKINCHI KALIT:
   * bitta o'quvchi javob bergan 0% li savol yuzta o'quvchi javob
   * bergan 0% li savoldan oldin turmasligi kerak — ikkinchisi
   * haqiqiy muammo, birinchisi shunchaki ma'lumot yetishmasligi.
   */
  const SORTS = {
    newest: [{ createdAt: "desc" }],
    oldest: [{ createdAt: "asc" }],
    grade: [{ grade: "asc" }, { subjectId: "asc" }, { createdAt: "desc" }],
    subject: [{ subjectId: "asc" }, { grade: "asc" }, { createdAt: "desc" }],
    difficulty: [{ difficulty: "asc" }, { createdAt: "desc" }],
    hardest: [{ accuracy: "asc" }, { usageCount: "desc" }],
    easiest: [{ accuracy: "desc" }, { usageCount: "desc" }],
    popular: [{ usageCount: "desc" }, { createdAt: "desc" }],
  };
  const orderBy = SORTS[query.sort] || SORTS.newest;

  const [total, totalAll, rows] = await Promise.all([
    prisma.diagnosticQuestion.count({ where }),
    // Sarlavhadagi "jami N ta" — FILTRSIZ bank hajmi. Filtrlangan son
    // bilan bir xil bo'lsa, "nechta savol bor" degan javob ekrandagi
    // filtrga qarab o'zgarib turardi.
    prisma.diagnosticQuestion.count(),
    prisma.diagnosticQuestion.findMany({
      where,
      include: QUESTION_INCLUDE,
      orderBy,
      skip: pagination.skip,
      take: pagination.limit,
    }),
  ]);

  const authors = await _attachAuthors(rows);
  return {
    total,
    totalAll,
    rows: authors.map((q) => {
      const shaped = _shape(q);
      return {
        ...shaped,
        // ⚠️ JAVOB BERILMAGAN SAVOLDA FOIZ `null`, 0 EMAS. 0% "hamma
        // xato qildi" degani, `null` esa "hali sinalmagan" — ekranda
        // ular butunlay boshqacha o'qiladi.
        answered: q.usageCount,
        correctPct: q.usageCount > 0 ? Math.round(q.accuracy) : null,
      };
    }),
  };
}

/** `authorId` — soft ref (FK yo'q), shuning uchun alohida yuklanadi. */
async function _attachAuthors(rows) {
  const ids = [...new Set(rows.map((r) => r.authorId).filter(Boolean))];
  if (ids.length === 0) return rows.map((r) => ({ ...r, author: null }));

  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true },
  });
  const map = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) => ({ ...r, author: map.get(r.authorId) || null }));
}

async function getQuestionById(id, { withAnswers = true } = {}) {
  const question = await prisma.diagnosticQuestion.findUnique({
    where: { id },
    include: QUESTION_INCLUDE,
  });
  if (!question) throw new NotFoundError("Savol topilmadi");

  const [withAuthor] = await _attachAuthors([question]);
  return _shape(withAuthor, { withAnswers });
}

/**
 * Bank manzarasi — moderatsiya ekranining yuqori qatori.
 *
 * ⚠️ `avgAccuracy` FAQAT ISHLATILGAN savollar bo'yicha hisoblanadi
 * (`usageCount > 0`). Aks holda yangi qo'shilgan har bir savol nol aniqlik
 * bilan o'rtachani pastga tortib, bank "yomonlashib boryapti" degan yolg'on
 * manzara chizardi.
 */
async function getBankStats() {
  const [total, byStatus, byDifficulty, usedAgg, unusedApproved] =
    await Promise.all([
      prisma.diagnosticQuestion.count(),
      prisma.diagnosticQuestion.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.diagnosticQuestion.groupBy({
        by: ["difficulty"],
        where: { status: "approved" },
        _count: { _all: true },
      }),
      prisma.diagnosticQuestion.aggregate({
        where: { usageCount: { gt: 0 } },
        _avg: { accuracy: true },
        _count: { _all: true },
      }),
      prisma.diagnosticQuestion.count({
        where: { status: "approved", usageCount: 0 },
      }),
    ]);

  const statusCounts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const row of byStatus) statusCounts[row.status] = row._count._all;

  const difficultyCounts = Object.fromEntries(LEVELS.map((l) => [l, 0]));
  for (const row of byDifficulty) difficultyCounts[row.difficulty] = row._count._all;

  // Muammoli savollar: ko'p ishlatilgan-u deyarli hech kim to'g'ri javob
  // bermaydi. Bu odatda savolning O'ZIDA xato borligini bildiradi.
  const problematic = await prisma.diagnosticQuestion.findMany({
    where: { status: "approved", usageCount: { gte: 5 }, accuracy: { lt: 20 } },
    include: QUESTION_INCLUDE,
    orderBy: [{ accuracy: "asc" }, { usageCount: "desc" }],
    take: 10,
  });

  return {
    total,
    status: statusCounts,
    difficulty: difficultyCounts,
    usedCount: usedAgg._count._all,
    unusedApproved,
    avgAccuracy: Math.round(usedAgg._avg.accuracy ?? 0),
    problematic: problematic.map((q) => _shape(q)),
  };
}

/**
 * Fan/mavzu kesimida bank qamrovi — "qaysi mavzuda savol yetishmayapti".
 *
 * ⚠️ Diagnostika uchun bu eng muhim hisobot: savoli yo'q mavzu tahlilda
 * umuman ko'rinmaydi va o'quvchi u mavzuni bilmasligini HECH QACHON
 * bilmaydi. "Nol" qatorlar shuning uchun ATAYLAB chiqariladi.
 */
async function getCoverage(subjectId = null) {
  const subjects = await prisma.subject.findMany({
    where: { isActive: true, ...(subjectId ? { id: subjectId } : {}) },
    include: { topics: { orderBy: { order: "asc" } } },
    orderBy: { name: "asc" },
  });

  const counts = await prisma.diagnosticQuestion.groupBy({
    by: ["subjectId", "topicId", "difficulty"],
    where: { status: "approved" },
    _count: { _all: true },
  });

  const key = (s, t) => `${s}::${t || "-"}`;
  const map = new Map();
  for (const row of counts) {
    const k = key(row.subjectId, row.topicId);
    const entry = map.get(k) || { total: 0, byLevel: {} };
    entry.total += row._count._all;
    entry.byLevel[row.difficulty] =
      (entry.byLevel[row.difficulty] || 0) + row._count._all;
    map.set(k, entry);
  }

  return subjects.map((subject) => {
    const topics = subject.topics.map((topic) => {
      const entry = map.get(key(subject.id, topic.id)) || { total: 0, byLevel: {} };
      return {
        topicId: topic.id,
        topicName: topic.name,
        total: entry.total,
        byLevel: Object.fromEntries(
          LEVELS.map((l) => [l, entry.byLevel[l] || 0]),
        ),
      };
    });

    const untagged = map.get(key(subject.id, null)) || { total: 0, byLevel: {} };

    return {
      subjectId: subject.id,
      subjectName: subject.name,
      topics,
      // Mavzusiz savollar — ular tahlilda "Umumiy" kesimida ko'rinadi.
      untagged: {
        total: untagged.total,
        byLevel: Object.fromEntries(
          LEVELS.map((l) => [l, untagged.byLevel[l] || 0]),
        ),
      },
      total: topics.reduce((sum, t) => sum + t.total, 0) + untagged.total,
    };
  });
}

// ─────────────────────────────────────────────
// YOZISH
// ─────────────────────────────────────────────

/**
 * Yangi savol. Har doim `draft` holatida tug'iladi — tasdiqlash ALOHIDA
 * amal va alohida ruxsat (`diagnostics.moderate`).
 */
async function createQuestion(data, files, authorId) {
  const parsed = _parsePayload(data);
  const subjectId = data.subjectId;
  if (!subjectId) throw new BadRequestError("Fan tanlanishi shart");
  const topicId = data.topicId || null;

  await _assertSubjectAndTopic(subjectId, topicId);

  const options = _normalizeOptions(parsed.type, _parseJson(data.options));
  const acceptedAnswers = _normalizeAccepted(
    parsed.type,
    _parseJson(data.acceptedAnswers),
  );

  const { questionImage, optionImages } = await _resolveImages(files);

  const optionRows = options.map((opt, index) => ({
    text: opt.text || null,
    image: optionImages[index] || opt.image || null,
    isCorrect: opt.isCorrect,
    position: index,
  }));

  // Kod to'qnashuvi faqat parallel yozuvda bo'ladi — bir marta qayta uriniladi.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const created = await prisma.diagnosticQuestion.create({
        data: {
          ...parsed,
          code: await _nextCode(),
          subjectId,
          topicId,
          image: questionImage,
          acceptedAnswers,
          status: "draft",
          authorId,
          options: { create: optionRows },
        },
        include: QUESTION_INCLUDE,
      });
      return _shape(created);
    } catch (error) {
      if (error?.code === "P2002" && attempt === 0) continue;
      throw error;
    }
  }

  throw new ConflictError("Savol kodi band — qaytadan urinib ko'ring");
}

/** `multipart/form-data` da massivlar string bo'lib keladi. */
function _parseJson(value) {
  if (value == null) return value;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new BadRequestError("Ma'lumot formati noto'g'ri (JSON kutilgan)");
  }
}

/**
 * Savolni tahrirlash.
 *
 * ⚠️ ISHLATILGAN SAVOL TAHRIRLANSA HAM O'TGAN NATIJA O'ZGARMAYDI: urinish
 * savolni MUHRLAB oladi (`DiagnosticAttemptQuestion`). Shuning uchun bu
 * yerda `usageCount > 0` uchun to'siq YO'Q — u faqat xato savolni abadiy
 * xato holatda qoldirardi.
 */
async function updateQuestion(id, data, files) {
  const existing = await prisma.diagnosticQuestion.findUnique({
    where: { id },
    include: { options: true },
  });
  if (!existing) throw new NotFoundError("Savol topilmadi");

  const parsed = _parsePayload(data, { partial: true });
  const type = parsed.type ?? existing.type;

  const subjectId = data.subjectId ?? existing.subjectId;
  const topicId =
    data.topicId === undefined
      ? existing.topicId
      : data.topicId || null;
  if (data.subjectId !== undefined || data.topicId !== undefined) {
    await _assertSubjectAndTopic(subjectId, topicId);
  }

  const update = { ...parsed, subjectId, topicId };

  if (data.acceptedAnswers !== undefined || parsed.type !== undefined) {
    update.acceptedAnswers = _normalizeAccepted(
      type,
      _parseJson(data.acceptedAnswers) ?? existing.acceptedAnswers,
    );
  }

  const { questionImage, optionImages } = await _resolveImages(files);
  const removeImage = data.removeImage === "true" || data.removeImage === true;
  if (questionImage) update.image = questionImage;
  else if (removeImage) update.image = null;

  // Variantlar YAMALMAYDI, O'RNIGA QO'YILADI: qisman yangilash "eski
  // variant qoldi, yangisi qo'shildi" degan aralash holatga olib kelardi.
  const rawOptions = _parseJson(data.options);
  const replaceOptions = rawOptions !== undefined || parsed.type !== undefined;
  const optionRows = replaceOptions
    ? _normalizeOptions(
        type,
        rawOptions ??
          existing.options
            .sort((a, b) => a.position - b.position)
            .map((o) => ({
              text: o.text,
              image: o.image,
              isCorrect: o.isCorrect,
              position: o.position,
            })),
      ).map((opt, index) => ({
        text: opt.text || null,
        image: optionImages[index] || opt.image || null,
        isCorrect: opt.isCorrect,
        position: index,
      }))
    : null;

  const updated = await prisma.$transaction(async (tx) => {
    if (optionRows) {
      await tx.diagnosticQuestionOption.deleteMany({ where: { questionId: id } });
    }
    return tx.diagnosticQuestion.update({
      where: { id },
      data: {
        ...update,
        ...(optionRows ? { options: { create: optionRows } } : {}),
      },
      include: QUESTION_INCLUDE,
    });
  });

  // Eski rasmlarni tozalash — tranzaksiyadan KEYIN va xatoni yutib.
  // Fayl o'chmasa ham savol yangilangan bo'lib qolishi kerak.
  if (questionImage && existing.image?.key) {
    deleteObject(existing.image.key).catch(() => {});
  }

  return _shape(updated);
}

/**
 * Holatni o'zgartirish (moderatsiya).
 *
 * `approved` ga o'tishda savol yana bir bor tekshiriladi: bank sifatining
 * yagona darvozasi shu yerda.
 */
async function updateStatus(id, status) {
  if (!STATUSES.includes(status)) {
    throw new BadRequestError(`Noma'lum holat: ${status}`);
  }

  const question = await prisma.diagnosticQuestion.findUnique({
    where: { id },
    include: { options: true },
  });
  if (!question) throw new NotFoundError("Savol topilmadi");

  if (question.status === status) return _shape(question);

  const allowed = STATUS_TRANSITIONS[question.status] || [];
  if (!allowed.includes(status)) {
    throw new BadRequestError(
      `"${question.status}" holatidan "${status}" holatiga o'tib bo'lmaydi`,
    );
  }

  if (status === "approved") {
    _assertApprovable(question);
  }

  const updated = await prisma.diagnosticQuestion.update({
    where: { id },
    data: { status },
    include: QUESTION_INCLUDE,
  });
  return _shape(updated);
}

/**
 * Savol testga TUSHISHGA tayyormi.
 *
 * ⚠️ Bu tekshiruv `create` dagi bilan bir xil emas va bo'lishi ham shart
 * emas: qoralama savol to'liq bo'lmasligi mumkin (o'qituvchi ishlab
 * turibdi), lekin TASDIQLANGAN savol o'quvchining oldiga chiqadi.
 */
function _assertApprovable(question) {
  if (needsOptions(question.type)) {
    const options = question.options || [];
    if (options.length < 2) {
      throw new BadRequestError(
        "Tasdiqlash uchun kamida 2 ta variant bo'lishi kerak",
      );
    }
    if (!options.some((o) => o.isCorrect)) {
      throw new BadRequestError(
        "Tasdiqlash uchun to'g'ri variant belgilangan bo'lishi kerak",
      );
    }
  }

  if (question.type === "short" && (question.acceptedAnswers || []).length === 0) {
    throw new BadRequestError(
      "Qisqa javobli savolda to'g'ri javob variantlari bo'lishi kerak",
    );
  }
}

/** Ommaviy moderatsiya — ro'yxatdan bir necha savolni birdan tasdiqlash. */
async function bulkUpdateStatus(ids, status) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (list.length === 0) throw new BadRequestError("Savollar tanlanmagan");
  if (list.length > 200) {
    throw new BadRequestError("Bir vaqtda 200 tadan ko'p savol o'zgartirilmaydi");
  }

  const result = { updated: 0, skipped: [] };

  // Har savol ALOHIDA: bittasi tasdiqlanmasa (masalan to'g'ri varianti yo'q)
  // qolganlari baribir o'tishi kerak — aks holda 50 ta savoldan bittasi
  // tufayli butun amal bekor bo'lardi.
  for (const id of list) {
    try {
      await updateStatus(id, status);
      result.updated += 1;
    } catch (error) {
      result.skipped.push({ id, reason: error.message });
    }
  }

  return result;
}

/**
 * O'chirish.
 *
 * ⚠️ ISHLATILGAN SAVOL O'CHIRILMAYDI — ARXIVLANADI. Urinish savolni
 * muhrlab olgan bo'lsa ham, bank statistikasi va "bu savol qayerdan keldi"
 * degan iz yo'qolmasligi kerak (tarif arxivlanishi bilan bir xil doktrina).
 */
async function deleteQuestion(id) {
  const question = await prisma.diagnosticQuestion.findUnique({
    where: { id },
    include: { _count: { select: { testLinks: true } } },
  });
  if (!question) throw new NotFoundError("Savol topilmadi");

  if (question.usageCount > 0) {
    const archived = await prisma.diagnosticQuestion.update({
      where: { id },
      data: { status: "archived" },
      include: QUESTION_INCLUDE,
    });
    return {
      archived: true,
      question: _shape(archived),
      message:
        "Savol testlarda ishlatilgan — o'chirilmadi, arxivlandi. Natijalar tarixi saqlanadi.",
    };
  }

  if (question._count.testLinks > 0) {
    throw new BadRequestError(
      "Savol test tarkibida turibdi. Avval uni testdan chiqaring.",
    );
  }

  await prisma.diagnosticQuestion.delete({ where: { id } });
  if (question.image?.key) deleteObject(question.image.key).catch(() => {});

  return { archived: false, message: "Savol o'chirildi" };
}

// ─────────────────────────────────────────────
// IMPORT / EKSPORT
// ─────────────────────────────────────────────

const IMPORT_LEVEL_ALIASES = {
  oson: "easy",
  easy: "easy",
  "o'rta": "medium",
  orta: "medium",
  "o‘rta": "medium",
  medium: "medium",
  qiyin: "hard",
  hard: "hard",
  murakkab: "expert",
  expert: "expert",
};

/**
 * Faylning BIRINCHI varag'ini obyektlar massiviga aylantiradi.
 *
 * ⚠️ Sarlavhalar NORMALLASHTIRILADI (kichik harf, bo'shliqlar → pastki
 * chiziq): foydalanuvchi "To'g'ri javob" deb yozsa ham, "togri_javob" deb
 * yozsa ham bir xil ustun topiladi. Aks holda import faqat namunaviy
 * shablon bilan ishlardi.
 */
function _readSheet(file) {
  const name = String(file.originalname || "");
  const extension = name.includes(".")
    ? name.split(".").pop().toLowerCase()
    : "";
  if (!["xlsx", "xls", "csv"].includes(extension)) {
    throw new BadRequestError("Faqat .xlsx, .xls yoki .csv fayllar qabul qilinadi");
  }

  let workbook;
  try {
    // ⚠️ CSV MATN sifatida, ATAYLAB UTF-8 deb o'qiladi.
    //
    // `XLSX.read(buffer)` kodlashni o'zi taxmin qiladi va BOM'siz UTF-8
    // faylni CP1252 deb o'qib yuboradi: "O‘zbekistonda" → "OÊ»zbekistonda".
    // Google Sheets ham, LibreOffice ham BOM qo'ymaydi, ya'ni bu ODATIY
    // hol edi. Eng yomoni — xato JIM: ustun sarlavhalari ASCII bo'lgani
    // uchun qator muvaffaqiyatli import bo'ladi va buzuq matn bazaga
    // tushadi. Sarlavhada apostrof bo'lsa ("To'g'ri javob") u ham buzilib,
    // HAR BIR qator "To'g'ri javob ko'rsatilmagan" bilan yiqilardi.
    //
    // .xlsx/.xls o'z kodlashini ichida olib yuradi — ularga tegilmaydi.
    if (extension === "csv") {
      const text = file.buffer.toString("utf8").replace(/^\uFEFF/, "");
      workbook = XLSX.read(text, { type: "string" });
    } else {
      workbook = XLSX.read(file.buffer, { type: "buffer" });
    }
  } catch {
    throw new BadRequestError("Faylni o'qib bo'lmadi — format buzilgan bo'lishi mumkin");
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new BadRequestError("Faylda sahifa topilmadi");

  const raw = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });

  return raw.map((row) => {
    const normalized = {};
    for (const [key, value] of Object.entries(row)) {
      const clean = String(key)
        .trim()
        .toLowerCase()
        .replace(/[‘’ʻʼ'`´]/g, "")
        .replace(/[\s.-]+/g, "_");
      normalized[clean] = value;
    }
    return normalized;
  });
}

/**
 * Excel/CSV dan ommaviy import.
 *
 * Kutilgan ustunlar: `savol`, `variant_a…variant_f`, `togri_javob` (harf yoki
 * harflar: "b" yoki "a,c"), `qiyinlik`, `mavzu`, `izoh`, `ball`, `sinf`.
 *
 * ⚠️ HAR QATOR ALOHIDA TEKSHIRILADI va xatolari YIG'ILADI. "Birinchi xatoda
 * to'xtash" 300 qatorli faylni foydasiz qilardi: foydalanuvchi xatolarni
 * bittalab topib, faylni 40 marta qayta yuklashga majbur bo'lardi.
 */
async function importQuestions(file, { subjectId, authorId, language = "uz" }) {
  if (!file) throw new BadRequestError("Fayl yuklanmadi");
  if (!subjectId) throw new BadRequestError("Fan tanlanishi shart");
  await _assertSubjectAndTopic(subjectId, null);

  const rows = _readSheet(file);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new BadRequestError("Faylda ma'lumot topilmadi");
  }
  if (rows.length > 1000) {
    throw new BadRequestError("Bir faylda 1000 tadan ko'p savol bo'lmasligi kerak");
  }

  // Mavzular nomi bo'yicha — importda id emas, NOM keladi.
  const topics = await prisma.topic.findMany({ where: { subjectId } });
  const topicByName = new Map(topics.map((t) => [normalizeText(t.name), t.id]));

  const prepared = [];
  const errors = [];
  const warnings = [];

  rows.forEach((row, index) => {
    const line = index + 2; // 1-qator — sarlavha
    try {
      const item = _prepareImportRow(row, { subjectId, topicByName, language });
      item.line = line;
      prepared.push(item);
      item.warnings.forEach((message) => warnings.push({ line, message }));
    } catch (error) {
      errors.push({ line, message: error.message });
    }
  });

  // ⚠️ DUBLIKAT SAVOL YOZILMAYDI — na fayl ichida, na bazada bori.
  //
  // Import "bir marta bosiladigan" amal emas: foydalanuvchi bir necha
  // qatorda xato topadi, faylni tuzatadi va QAYTA yuklaydi. Tekshiruvsiz
  // har yuklash butun bankni ikkilantirardi va bu jimgina sodir bo'lardi —
  // testga esa bir xil savol ikki marta tushib qolardi.
  //
  // Solishtirish MATN bo'yicha, `normalizeText` bilan (registr, apostrof va
  // ortiqcha bo'shliq farqi hisobga olinmaydi) va faqat SHU FAN ichida:
  // "Poytaxt qaysi shahar?" turli fanlarda boshqa savol bo'lishi mumkin.
  const existing = await prisma.diagnosticQuestion.findMany({
    where: { subjectId },
    select: { text: true },
  });
  const seen = new Set(existing.map((q) => normalizeText(q.text)));

  const toCreate = [];
  let duplicates = 0;
  for (const item of prepared) {
    const key = normalizeText(item.question.text);
    if (seen.has(key)) {
      duplicates += 1;
      warnings.push({
        line: item.line,
        message: `"${_shortText(item.question.text)}" — bunday savol bankda allaqachon bor, o'tkazib yuborildi`,
      });
      continue;
    }
    seen.add(key);
    toCreate.push(item);
  }

  let created = 0;
  // Kodlar KETMA-KET beriladi: har qator uchun alohida `_nextCode()`
  // chaqirish N ta qo'shimcha so'rov bo'lardi.
  let counter = await _nextCodeCounter();

  for (const item of toCreate) {
    // ⚠️ KOD TO'QNASHUVIDA QAYTA URINILADI. Sanoqchi import boshida BIR
    // MARTA o'qiladi, ya'ni shu orada boshqa admin savol yaratsa (yoki
    // ikkinchi import ketsa) `code` unique cheklovi buziladi. Qayta
    // urinishsiz bitta to'qnashuv qolgan HAMMA qatorni yiqitardi —
    // sanoqchi oldinga surilmagani uchun har keyingi qator ham aynan shu
    // xatoga tushardi. `createQuestion` da ham AYNI himoya bor.
    let saved = false;
    for (let attempt = 0; attempt < 3 && !saved; attempt += 1) {
      counter += 1;
      try {
        await prisma.diagnosticQuestion.create({
          data: {
            ...item.question,
            code: `D-${String(counter).padStart(6, "0")}`,
            authorId,
            status: "draft",
            options: { create: item.options },
          },
        });
        created += 1;
        saved = true;
      } catch (error) {
        if (error?.code === "P2002" && attempt < 2) {
          counter = Math.max(counter, await _nextCodeCounter());
          continue;
        }
        errors.push({
          line: item.line,
          message: `"${_shortText(item.question.text)}" saqlanmadi: ${_saveErrorMessage(error)}`,
        });
        saved = true;
      }
    }
  }

  return {
    total: rows.length,
    created,
    duplicates,
    failed: errors.length,
    errors,
    warnings,
  };
}

/** Xato xabarida savol matni — uzun savol butun ro'yxatni bosib ketmasligi uchun. */
function _shortText(text) {
  const value = String(text ?? "");
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}

/**
 * Saqlash xatosini FOYDALANUVCHI TILIGA o'giradi.
 *
 * ⚠️ Prisma xatosining xom matni ekranga chiqmaydi: u ustun va cheklov
 * nomlarini (`diagnostic_questions_code_key`) ko'rsatadi — foydalanuvchiga
 * ma'nosiz, tizim tuzilishi haqida esa ortiqcha ma'lumot.
 */
function _saveErrorMessage(error) {
  if (error?.code === "P2002") return "kod band bo'lib qoldi, qaytadan urinib ko'ring";
  if (error?.code === "P2003") return "bog'liq yozuv topilmadi (fan yoki mavzu o'chirilgan bo'lishi mumkin)";
  if (error?.code === "P2000") return "matn juda uzun";
  if (error instanceof BadRequestError) return error.message;
  logger.error("Diagnostika importida saqlash xatosi", { error });
  return "ichki xato";
}

async function _nextCodeCounter() {
  // ⚠️ FAQAT "D-<raqam>" ko'rinishidagi kodlar sanaladi. Bankda boshqa
  // shakldagi kodlar ham bo'ladi (masalan demo seed "DEMO-…" yozadi) va
  // ular `orderBy: code desc` da eng tepaga chiqib, sanoqchini noto'g'ri
  // qiymatga tushirardi — natijada kod to'qnashuvi DOIMIY bo'lib qolardi.
  const last = await prisma.diagnosticQuestion.findFirst({
    where: { code: { startsWith: "D-" } },
    orderBy: { code: "desc" },
    select: { code: true },
  });
  if (!last) return 0;
  const digits = /^D-(\d+)$/.exec(last.code);
  return digits ? parseInt(digits[1], 10) : 0;
}

const LETTERS = ["a", "b", "c", "d", "e", "f"];

function _prepareImportRow(row, { subjectId, topicByName, language }) {
  // Sarlavhalar `_readSheet` da allaqachon normallashtirilgan
  // (kichik harf, `_` bilan), shuning uchun bu yerda faqat bir nechta
  // sinonim nom sinab ko'riladi.
  const pick = (...keys) => {
    for (const key of keys) {
      const value = row[key];
      if (value != null && String(value).trim() !== "") return String(value).trim();
    }
    return "";
  };

  const text = pick("savol", "question", "text", "savol_matni");
  if (!text) throw new BadRequestError("Savol matni bo'sh");

  const options = [];
  for (const letter of LETTERS) {
    const value = pick(`variant_${letter}`, `variant${letter}`, letter);
    if (value) options.push({ letter, text: value });
  }
  if (options.length < 2) {
    throw new BadRequestError("Kamida 2 ta variant bo'lishi kerak");
  }

  const correctRaw = pick("togri_javob", "correct", "javob", "answer");
  if (!correctRaw) throw new BadRequestError("To'g'ri javob ko'rsatilmagan");

  // ⚠️ TAKRORIY HARF TASHLANADI. "b,b" yozilgani savolni `multiple` ga
  // aylantirib yuborardi (tur javoblar SONIDAN chiqadi), natijada bitta
  // to'g'ri javobli savol "bir nechta javobni belgilang" bo'lib qolardi.
  const correctLetters = [
    ...new Set(
      correctRaw
        .toLowerCase()
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];

  const known = new Set(options.map((o) => o.letter));
  const unknown = correctLetters.filter((l) => !known.has(l));
  if (unknown.length) {
    throw new BadRequestError(
      `To'g'ri javob "${unknown.join(", ")}" variantlar orasida yo'q`,
    );
  }

  // ⚠️ NOMA'LUM QIYINLIK — XATO, jim `medium` EMAS. Ilgari "Juda qiyin",
  // "yengil", "A2" kabi har qanday qiymat jimgina `medium` bo'lib yozilardi
  // va buni hech kim sezmasdi; adaptiv tanlov esa noto'g'ri pog'onadan
  // savol berardi. Qo'lda yaratish yo'li (`_parsePayload`) ayni holatda
  // ALLAQACHON xato tashlaydi — ikki yo'l bir xil qat'iy bo'lishi kerak.
  // Ustun umuman bo'sh bo'lsa `medium` qoladi: bu hujjatlashtirilgan sukut.
  const difficultyRawText = pick("qiyinlik", "difficulty", "daraja");
  const difficultyKey = normalizeText(difficultyRawText);
  let difficulty = "medium";
  if (difficultyKey) {
    difficulty = IMPORT_LEVEL_ALIASES[difficultyKey];
    if (!difficulty) {
      throw new BadRequestError(
        `Noma'lum qiyinlik: "${difficultyRawText}". Ruxsat etilgan: oson, o'rta, qiyin, murakkab`,
      );
    }
  }

  // ⚠️ MAVZU TOPILMASA QATOR RAD ETILMAYDI — OGOHLANTIRISH beriladi va
  // savol mavzusiz saqlanadi. Ilgari butun qator yiqilardi: mavzular
  // ro'yxati administratorda, savollar fayli esa ko'pincha o'qituvchida —
  // bitta nomdagi farq tufayli 300 qatorli fayldan hech narsa o'tmasdi.
  // Mavzu — savolning MAJBURIY qismi emas (qo'lda yaratishda ham `null`
  // bo'lishi mumkin), shuning uchun uni to'siq qilish o'rinsiz edi.
  const topicName = pick("mavzu", "topic");
  const topicId = topicName ? topicByName.get(normalizeText(topicName)) || null : null;
  const warnings = [];
  if (topicName && !topicId) {
    warnings.push(`"${topicName}" mavzusi bu fanda topilmadi — savol mavzusiz saqlandi`);
  }

  const gradeRaw = pick("sinf", "grade");
  const grade = gradeRaw ? parseInt(gradeRaw, 10) : null;
  if (gradeRaw && (Number.isNaN(grade) || grade < 1 || grade > 11)) {
    throw new BadRequestError("Sinf 1 dan 11 gacha bo'lishi kerak");
  }

  const pointsRaw = pick("ball", "points");
  const points = pointsRaw ? Number(pointsRaw) : 1;
  if (pointsRaw && (Number.isNaN(points) || points <= 0)) {
    throw new BadRequestError("Ball noto'g'ri");
  }

  return {
    warnings,
    question: {
      text,
      subjectId,
      topicId,
      difficulty,
      type: correctLetters.length > 1 ? "multiple" : "single",
      grade: Number.isNaN(grade) ? null : grade,
      points,
      language,
      explanation: pick("izoh", "explanation") || null,
      acceptedAnswers: [],
    },
    options: options.map((opt, index) => ({
      text: opt.text,
      isCorrect: correctLetters.includes(opt.letter),
      position: index,
    })),
  };
}

/** Excel eksport uchun tekis qatorlar. */
async function getQuestionsForExport(query = {}) {
  const { rows } = await listQuestions(query, { skip: 0, limit: 5000 });

  const STATUS_LABELS = {
    draft: "Qoralama",
    review: "Ko'rikda",
    approved: "Tasdiqlangan",
    archived: "Arxivlangan",
  };

  return rows.map((q) => ({
    code: q.code,
    subject: q.subject?.name || "—",
    topic: q.topic?.name || "—",
    grade: q.grade ?? "—",
    text: q.text,
    type: TYPE_LABELS[q.type] || q.type,
    difficulty: LEVEL_LABELS[q.difficulty] || q.difficulty,
    options: (q.options || []).map((o) => o.text).filter(Boolean).join(" | "),
    correct: (q.options || [])
      .filter((o) => o.isCorrect)
      .map((o) => o.text)
      .filter(Boolean)
      .join(" | "),
    points: q.points,
    status: STATUS_LABELS[q.status] || q.status,
    usageCount: q.usageCount,
    accuracy: q.usageCount > 0 ? `${Math.round(q.accuracy)}%` : "—",
    author: q.author ? `${q.author.lastName} ${q.author.firstName}` : "—",
  }));
}

module.exports = {
  QUESTION_TYPES,
  TYPE_LABELS,
  STATUSES,
  STATUS_TRANSITIONS,
  listQuestions,
  getQuestionById,
  getBankStats,
  getCoverage,
  createQuestion,
  updateQuestion,
  updateStatus,
  bulkUpdateStatus,
  deleteQuestion,
  importQuestions,
  getQuestionsForExport,
};
