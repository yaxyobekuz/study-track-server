/**
 * DIAGNOSTIKA — HAR O'QUVCHIGA O'Z TESTI (guruh tanlanadi, test bolaga
 * moslanadi) + TASDIQLASH VA SAVOLNI ALMASHTIRISH.
 *
 * ── MUAMMO ────────────────────────────────────
 *
 * Mavzu qamrovi bilan test AYNAN BITTA SINF uchun yig'ilardi va butun
 * guruhga BITTA savollar to'plami ketardi (`diagnosticTest.service.js` →
 * `buildTest`). Guruhda esa bolalar boshqa-boshqa mavzuga kelgan bo'ladi:
 * biri bitta darsda uch mavzuni oladi, boshqasi o'rtada qo'shilgani uchun
 * 45-mavzudan boshlaydi. Bitta to'plam ularning bir qismiga O'TILMAGAN
 * materialdan savol berardi — modulning asosiy qoidasi aynan shu yerda
 * buzilardi.
 *
 * ── YECHIM ────────────────────────────────────
 *
 * Guruh tanlanadi, qamrov esa HAR BOLAGA alohida hal qilinadi
 * (`StudentTopicPlan` → `diagnosticTopicScope.resolveStudentScopes`) va
 * savollar har o'quvchiga alohida MUHRLANADI
 * (`DiagnosticTestStudent` + `DiagnosticTestStudentQuestion`).
 *
 * ⚠️ BIR XIL QAMROVLI BOLALAR AYNI SAVOLLARNI OLADI (`scopeSignature`).
 * 25 bolalik guruhga 20 savol so'ralsa, har bolaga alohida yozish 500 ta
 * savol va o'nlab pullik model so'rovi bo'lardi — holbuki guruhda
 * qamrovlar odatda 2–5 xil (ko'pchilik sinfdan meros oladi). Qoida ORALIQ
 * haqida, savollarning xilma-xilligi haqida emas: sinf testi ham shunday
 * ishlagan.
 *
 * ⚠️ QAMROVI TOPILMAGAN BOLA CHETDA QOLADI, BUTUN TEST TO'XTAMAYDI
 * (`status: "failed"` + sababi). Sinf yo'lida bitta buzuq qator butun
 * testni to'xtatadi (bitta to'plam hammaga ketadi, ya'ni u eng orqada
 * qolgan bolaga mos bo'lishi shart); bu yerda esa har bolaning to'plami
 * mustaqil va "25 tadan 24 tasiga test tushdi" degan holat NORMAL —
 * faqat u JIM qolmasligi kerak.
 *
 * ── TASDIQLASH ────────────────────────────────
 *
 * ⚠️ TEST TUZILGANDAN KEYIN DARHOL CHIQMAYDI (biznes qarori, 2026-11-12):
 * "filial egasi ko'rib chiqadi, tasdiqlasa keyin chiqariladi". Darvoza
 * `diagnosticTest.service.js` → `updateTestStatus` da (`approvedAt`),
 * tasdiqlash esa ALOHIDA ruxsat ortida (`diagnostics.publish`): test
 * TUZISH huquqi uni CHIQARISH huquqiga aylanmasligi kerak
 * (`payroll.generate` / `assign` bilan AYNI mulohaza).
 *
 * ⚠️ SAVOLNI ALMASHTIRISH — BITTA YO'L, UCHALA REJIM (bitta / bir nechta /
 * hammasi) SHUNDAN O'TADI. Ikkita yo'l bo'lsa, biriga qo'shilgan shart
 * (qamrov, qiyinlik, takror) ikkinchisida tushib qolardi va "bitta savolni
 * almashtirdim" degan amal testning taqsimotini jimgina buzardi.
 *
 * ⚠️ ESKI SAVOL BANKDAN O'CHIRILMAYDI, TESTDAN AJRATILADI. Bank
 * append-only: savol boshqa testda ishlatilgan bo'lishi mumkin va u
 * moderatsiya navbatida o'z holida qoladi (`diagnosticQuestion` doktrinasi).
 */

const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} = require("../utils/errors");
const { LEVEL_LABELS } = require("../helpers/diagnostic.helpers");
const {
  LEVEL_KEYS,
  LEVEL_POOLS,
  LEVEL_KEY_LABELS,
  SOURCE_LABELS,
  TOPIC_MODE_LABELS,
  parseBlueprint,
  rowTotal,
  levelCounts,
} = require("../helpers/diagnosticBlueprint.helpers");
const { languageLabel } = require("../helpers/teachingLanguage.helpers");
const topicScopeService = require("./diagnosticTopicScope.service");
const aiQuestionService = require("./diagnosticAiQuestion.service");
const questionService = require("./diagnosticQuestion.service");
const testService = require("./diagnosticTest.service");

/**
 * BIR TESTDA ENG KO'P O'QUVCHI.
 *
 * Chegara ataylab bor: har o'quvchiga savollar MUHRLANADI, ya'ni 100
 * bolalik so'rov 100 × 20 = 2000 qator va (AI qatorlarida) o'nlab model
 * so'rovini yuzaga keltirardi. Bitta guruh baribir shundan kichik.
 */
const MAX_STUDENTS_PER_TEST = 60;

/** Bir amalda eng ko'p almashtirish — "hammasi" ham shu chegarada. */
const MAX_REGENERATE = 200;

/** Qiyinlik → odam o'ylaydigan daraja kaliti (`easy` / `medium` / `hard`). */
const LEVEL_KEY_BY_DIFFICULTY = new Map();
for (const key of LEVEL_KEYS) {
  for (const difficulty of LEVEL_POOLS[key]) LEVEL_KEY_BY_DIFFICULTY.set(difficulty, key);
}

/* ═══════════════════════════════════════════════════════════════
   1. OLDINDAN KO'RISH — HECH NARSA YOZMAYDI
   ═══════════════════════════════════════════════════════════════ */

/**
 * Har o'quvchining qamrovi, bankdagi savollar va AI yozishi kerak soni.
 *
 * ⚠️ MODEL CHAQIRILMAYDI va BANKKA YOZILMAYDI — `planTest` bilan AYNI
 * naqsh: odam avval NIMA BO'LISHINI ko'rishi kerak, chunki qaror pullik
 * chaqiruvga va bankka yoziladigan savollarga tegadi.
 *
 * @param {object} params
 * @param {string} params.classId
 * @param {Array} params.blueprint
 * @param {string[]} [params.studentIds] - bo'sh bo'lsa guruhning hammasi
 * @param {string} params.actorId
 */
async function planStudentTest({ classId, blueprint, studentIds = null, actorId }) {
  if (!classId) throw new BadRequestError("Guruh (sinf) tanlanishi shart");

  const rows = parseBlueprint(blueprint);
  if (!rows) throw new BadRequestError("Kamida bitta fan qatori kiritilsin");

  const resolved = await topicScopeService.resolveStudentScopes({
    classId,
    blueprint: rows,
    studentIds,
    actorId,
  });

  if (resolved.students.length > MAX_STUDENTS_PER_TEST) {
    throw new BadRequestError(
      `Bir testda ${MAX_STUDENTS_PER_TEST} tadan ko'p o'quvchi bo'lmaydi ` +
        `(tanlangan: ${resolved.students.length}). O'quvchilarni tanlab belgilang.`,
    );
  }

  const aiEnabled = await aiQuestionService.isEnabled();
  const want = rows.reduce((sum, row) => sum + rowTotal(row), 0);

  // ── QAMROV GURUHLARI: bir xil qamrov BIR MARTA hisoblanadi ──
  const groups = new Map();
  for (const entry of resolved.students) {
    if (entry.status !== "ready") continue;
    const signature = topicScopeService.scopeSignature(entry.scopes);
    if (!groups.has(signature)) {
      groups.set(signature, { signature, scopes: entry.scopes, students: [] });
    }
    groups.get(signature).students.push(entry.student);
  }

  // ── BANK KESIMI — qamrov guruhi bo'yicha ──
  const bankBySignature = new Map();
  for (const group of groups.values()) {
    const perRow = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row.source !== "bank") {
        perRow.push(null);
        continue;
      }
      perRow.push(
        await testService.countBankForRow(row, group.scopes[index], {
          language: resolved.language,
        }),
      );
    }
    bankBySignature.set(group.signature, perRow);
  }

  const aiNeeded = rows
    .filter((row) => row.source === "ai")
    .reduce((sum, row) => sum + rowTotal(row), 0);

  const students = resolved.students.map((entry) => {
    const signature =
      entry.status === "ready" ? topicScopeService.scopeSignature(entry.scopes) : null;
    const bank = signature ? bankBySignature.get(signature) : null;

    const shortfall = (bank || []).reduce(
      (sum, item) => sum + (item?.shortfall ?? 0),
      0,
    );

    return {
      student: entry.student,
      status: entry.status,
      reason: entry.reason,
      inherited: entry.inherited,
      scopeSignature: signature,
      want,
      shortfall,
      rows: entry.scopes.map((scope, index) => ({
        index,
        subjectId: scope.subjectId,
        subjectName: scope.subjectName,
        source: rows[index]?.source ?? scope.source,
        sourceLabel: SOURCE_LABELS[rows[index]?.source ?? scope.source],
        topicMode: scope.topicMode,
        topicModeLabel: scope.topicMode ? TOPIC_MODE_LABELS[scope.topicMode] : null,
        topicFrom: scope.topicFrom,
        topicTo: scope.topicTo,
        topicCount: (scope.topics || []).length,
        currentTopicNumber: scope.currentTopicNumber,
        coveredThrough: scope.coveredThrough ?? null,
        step: scope.step ?? 1,
        startOrder: scope.startOrder ?? 1,
        inherited: scope.inherited ?? true,
        clamped: Boolean(scope.clamped),
        label: topicScopeService.scopeLabel(scope),
        counts: levelCounts(rows[index] || {}),
        bank: bank?.[index] ?? null,
      })),
    };
  });

  const ready = students.filter((row) => row.status === "ready");
  const warnings = [];

  for (const row of ready) {
    if (row.shortfall > 0) {
      warnings.push(
        `${row.student.lastName ?? ""} ${row.student.firstName ?? ""}`.trim() +
          `: ${row.shortfall} ta savol bankda yetmaydi`,
      );
    }
  }
  if (aiNeeded > 0 && !aiEnabled) {
    warnings.push("AI o'chirilgan — AI qatorlarini bankdan olishga o'zgartiring");
  }

  return {
    class: resolved.class,
    language: resolved.language,
    languageLabel: resolved.languageLabel,
    perStudent: true,
    aiEnabled,
    errors: resolved.errors,
    students,
    /**
     * ⚠️ QAMROV GURUHLARI OCHIQ KO'RSATILADI: admin "25 bolaga 25 xil
     * test" deb o'ylamasligi kerak — bir xil mavzu oralig'idagi bolalar
     * ayni savollarni oladi va bu AI chaqiruvlari sonini ham belgilaydi.
     */
    groups: [...groups.values()].map((group) => ({
      signature: group.signature,
      students: group.students.length,
      label: group.scopes
        .filter((scope) => scope.topicMode)
        .map((scope) => topicScopeService.scopeLabel(scope))
        .join(" · "),
    })),
    totals: {
      students: resolved.students.length,
      ready: ready.length,
      failed: students.filter((row) => row.status !== "ready").length,
      scopeGroups: groups.size,
      questionsPerStudent: want,
      // AI chaqiruvlari QAMROV GURUHI bo'yicha — o'quvchi soni bo'yicha EMAS
      aiQuestions: aiNeeded * groups.size,
    },
    warnings,
    /** Panelda "Testni yaratish" tugmasi shu bayroqqa qarab yoqiladi. */
    canBuild:
      resolved.errors.length === 0 &&
      ready.length > 0 &&
      (aiNeeded === 0 || aiEnabled),
  };
}

/* ═══════════════════════════════════════════════════════════════
   2. YIG'ISH
   ═══════════════════════════════════════════════════════════════ */

/**
 * Qamrov guruhi uchun savollarni tanlaydi / yozdiradi.
 *
 * @returns {Promise<{byRow: Map<number, string[]>, warnings: string[]}>}
 */
async function _collectForGroup({
  rows,
  scopes,
  language,
  actorId,
  seenText,
  budget,
  generated,
}) {
  const byRow = new Map();
  const warnings = [];

  // ── AI QATORLARI ──
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.source !== "ai") continue;

    const scope = scopes[index];
    generated.requested += rowTotal(row);

    const result = await aiQuestionService.generateForRow({
      subject: { id: scope.subjectId, name: scope.subjectName },
      grade: row.grade,
      topics: scope.topics,
      counts: levelCounts(row),
      language,
      seenText,
      budget,
    });
    generated.requests += result.requests;
    warnings.push(...result.warnings);

    const saved = await questionService.createGeneratedQuestions(result.items, {
      authorId: actorId,
    });
    generated.written += saved.created.length;
    generated.duplicates += saved.duplicates;
    generated.failed += saved.failed;
    warnings.push(...saved.errors);

    byRow.set(index, saved.created);
  }

  // ── BANK QATORLARI ──
  const bankIndexes = rows
    .map((row, index) => (row.source === "bank" ? index : null))
    .filter((index) => index !== null);

  if (bankIndexes.length) {
    const bankRows = bankIndexes.map((index) => rows[index]);
    const bankScopes = bankIndexes.map((index) => scopes[index]);
    const result = await testService.selectByBlueprint(bankRows, {
      scopes: bankScopes,
      language,
    });
    warnings.push(...result.warnings);

    // `selectByBlueprint` faqat id qaytaradi — qiyinlik kerak (almashtirish
    // AYNI qiyinlikdan oladi), shuning uchun qatorlar qayta o'qiladi.
    const allIds = bankIndexes.flatMap((_, position) => result.byRow.get(position) || []);
    const meta = allIds.length
      ? await prisma.diagnosticQuestion.findMany({
          where: { id: { in: allIds } },
          select: { id: true, difficulty: true },
        })
      : [];
    const difficultyById = new Map(meta.map((item) => [item.id, item.difficulty]));

    bankIndexes.forEach((index, position) => {
      byRow.set(
        index,
        (result.byRow.get(position) || []).map((id) => ({
          id,
          difficulty: difficultyById.get(id) || "medium",
        })),
      );
    });
  }

  return { byRow, warnings };
}

/**
 * HAR O'QUVCHIGA O'Z TESTINI YIG'ADI.
 *
 * @param {object} data - test maydonlari + `classId` + `blueprint` + `studentIds`
 * @param {string} actorId
 * @param {{canUseAi?: boolean}} options
 */
async function buildStudentTest(data, actorId, { canUseAi = false } = {}) {
  const classId = Array.isArray(data.classIds) ? data.classIds[0] : data.classId;
  if (!classId) throw new BadRequestError("Guruh (sinf) tanlanishi shart");
  if (Array.isArray(data.classIds) && data.classIds.length > 1) {
    /**
     * ⚠️ AYNAN BITTA GURUH. Mavzu o'rni o'quvchining REJASIDAN kelsa ham,
     * dars kunlari SINFNING jadvalidan sanaladi (`StudentTopicPlan.classId`):
     * ikki guruh tanlansa, bir xil bolaning o'rni ikki jadval bo'yicha
     * ikki xil chiqardi.
     */
    throw new BadRequestError(
      "Har o'quvchiga moslangan test aynan bitta guruh uchun yaratiladi: " +
        "dars kunlari guruhning jadvalidan sanaladi.",
    );
  }

  const rows = parseBlueprint(data.blueprint);
  if (!rows) throw new BadRequestError("Kamida bitta fan qatori kiritilsin");

  const resolved = await topicScopeService.resolveStudentScopes({
    classId,
    blueprint: rows,
    studentIds: data.studentIds ?? null,
    actorId,
  });

  if (resolved.errors.length) {
    throw new BadRequestError(
      `Mavzu qamrovi to'g'ri kelmadi:\n${resolved.errors.map((e) => `• ${e.message}`).join("\n")}`,
      { errors: resolved.errors },
    );
  }

  if (resolved.students.length > MAX_STUDENTS_PER_TEST) {
    throw new BadRequestError(
      `Bir testda ${MAX_STUDENTS_PER_TEST} tadan ko'p o'quvchi bo'lmaydi ` +
        `(tanlangan: ${resolved.students.length})`,
    );
  }

  const ready = resolved.students.filter((entry) => entry.status === "ready");
  if (ready.length === 0) {
    throw new BadRequestError(
      "Birorta o'quvchining mavzu qamrovi aniqlanmadi — mavzu rejalarini tekshiring",
      { students: resolved.students.map((e) => ({ student: e.student, reason: e.reason })) },
    );
  }

  const aiRows = rows.filter((row) => row.source === "ai");
  if (aiRows.length) {
    // ⚠️ AI ALOHIDA RUXSAT (`diagnostics.ai`): har chaqiruv pullik model
    // so'rovi va natijasi BANKKA yoziladi (`buildTest` bilan AYNI qoida).
    if (!canUseAi) {
      throw new ForbiddenError(
        "AI bilan savol yozish uchun ruxsat yo'q (Diagnostika → AI tahlilini ishga tushirish)",
      );
    }
    await aiQuestionService.assertEnabled();
  }

  const parsed = await testService.parseTestPayload(data);
  const warnings = [];
  const generated = { requested: 0, written: 0, duplicates: 0, failed: 0, requests: 0 };
  const budget = { value: aiQuestionService.MAX_REQUESTS_PER_BUILD };
  const seenText = new Set();

  // ── QAMROV GURUHLARI ──
  const groups = new Map();
  for (const entry of ready) {
    const signature = topicScopeService.scopeSignature(entry.scopes);
    if (!groups.has(signature)) {
      groups.set(signature, { signature, scopes: entry.scopes, students: [] });
    }
    groups.get(signature).students.push(entry);
  }

  const picksBySignature = new Map();
  for (const group of groups.values()) {
    const { byRow, warnings: groupWarnings } = await _collectForGroup({
      rows,
      scopes: group.scopes,
      language: resolved.language,
      actorId,
      seenText,
      budget,
      generated,
    });
    picksBySignature.set(group.signature, byRow);
    warnings.push(...groupWarnings);
  }

  // ── O'QUVCHILARNING TO'PLAMLARI ──
  const studentRows = [];
  const linkRows = [];
  const uniqueQuestionIds = new Set();

  for (const entry of resolved.students) {
    const snapshot = {
      fullName: `${entry.student.lastName ?? ""} ${entry.student.firstName ?? ""}`.trim(),
      username: entry.student.username ?? null,
      className: resolved.class?.name ?? null,
    };

    if (entry.status !== "ready") {
      // ⚠️ QATOR BARIBIR YOZILADI: kimga test tushmagani tasdiqlash
      // ekranida ko'rinishi kerak, jim qolmasligi kerak.
      studentRows.push({
        studentId: entry.student.id,
        snapshot,
        scope: [],
        questionCount: 0,
        status: "failed",
        reason: entry.reason,
      });
      continue;
    }

    const byRow = picksBySignature.get(topicScopeService.scopeSignature(entry.scopes));
    const picked = [];
    const seenId = new Set();

    for (let index = 0; index < rows.length; index += 1) {
      for (const item of byRow?.get(index) || []) {
        if (seenId.has(item.id)) continue;
        seenId.add(item.id);
        picked.push({ ...item, rowIndex: index });
      }
    }

    if (picked.length === 0) {
      studentRows.push({
        studentId: entry.student.id,
        snapshot,
        scope: [],
        questionCount: 0,
        status: "failed",
        reason: "Qamrov bo'yicha birorta savol topilmadi ham, yozilmadi ham",
      });
      continue;
    }

    studentRows.push({
      studentId: entry.student.id,
      snapshot,
      /**
       * ⚠️ HAL QILINGAN ORALIQ MUHRLANADI. "Hozirgi mavzugacha" so'rovi
       * o'z-o'zicha hech narsa demaydi: o'quvchi ertaga oldinga ketadi.
       */
      scope: entry.scopes
        .filter((scope) => scope.topicMode)
        .map((scope) => ({
          index: scope.index,
          subjectId: scope.subjectId,
          subjectName: scope.subjectName,
          topicMode: scope.topicMode,
          topicFrom: scope.topicFrom,
          topicTo: scope.topicTo,
          currentTopicAtCreate: scope.currentTopicNumber,
          coveredThrough: scope.coveredThrough ?? null,
          step: scope.step ?? 1,
          startOrder: scope.startOrder ?? 1,
          inherited: scope.inherited ?? true,
          clamped: Boolean(scope.clamped),
        })),
      questionCount: picked.length,
      status: "ready",
      reason: null,
    });

    picked.forEach((item, position) => {
      uniqueQuestionIds.add(item.id);
      linkRows.push({
        studentId: entry.student.id,
        questionId: item.id,
        position,
        rowIndex: item.rowIndex,
        difficulty: item.difficulty,
      });
    });
  }

  const readyRows = studentRows.filter((row) => row.status === "ready");
  if (readyRows.length === 0) {
    throw new BadRequestError(
      "Birorta savol topilmadi ham, yozilmadi ham. Mavzu oralig'ini kengaytiring " +
        "yoki savollar sonini kamaytiring.",
      { warnings },
    );
  }

  // ⚠️ SAVOLLAR SONI — ENG KO'PINI OLGAN O'QUVCHIGA QARAB. O'quvchilarning
  // to'plami uzunligi farq qilishi mumkin (bankda yetmasa), `questionCount`
  // esa testning umumiy maydoni: urinish baribir O'QUVCHINING to'plamini
  // oladi va uzunlikni shundan hisoblaydi.
  const maxCount = Math.max(...readyRows.map((row) => row.questionCount));

  const storedBlueprint = rows.map((row, index) => ({
    subjectId: row.subjectId,
    grade: row.grade,
    source: row.source,
    topicMode: row.topicMode,
    // ⚠️ SINF DARAJASIDAGI ORALIQ — SPRAVKA: haqiqiy chegara har
    // o'quvchining o'z qatorida (`DiagnosticTestStudent.scope`).
    topicFrom: resolved.baseScopes[index]?.topicFrom ?? row.topicFrom,
    topicTo: resolved.baseScopes[index]?.topicTo ?? row.topicTo,
    easy: row.easy,
    medium: row.medium,
    hard: row.hard,
  }));

  const test = await prisma.$transaction(async (tx) => {
    const created = await tx.diagnosticTest.create({
      data: {
        ...parsed,
        perStudent: true,
        language: resolved.language,
        blueprint: storedBlueprint,
        questionCount: maxCount,
        status: "draft",
        createdBy: actorId,
        classes: { create: [{ classId }] },
      },
    });

    await tx.diagnosticTestStudent.createMany({
      data: studentRows.map((row) => ({ ...row, testId: created.id })),
    });
    await tx.diagnosticTestStudentQuestion.createMany({
      data: linkRows.map((row) => ({ ...row, testId: created.id })),
    });

    return created;
  });

  logger.info(
    `[DiagnosticStudentTest] "${test.title}" — ${readyRows.length} o'quvchi, ` +
      `${uniqueQuestionIds.size} noyob savol, ${groups.size} qamrov guruhi`,
  );

  return {
    ...(await testService.getTestById(test.id)),
    warnings,
    generated,
    students: studentRows.map((row) => ({
      studentId: row.studentId,
      fullName: row.snapshot.fullName,
      status: row.status,
      reason: row.reason,
      questionCount: row.questionCount,
    })),
    totals: {
      students: studentRows.length,
      ready: readyRows.length,
      failed: studentRows.length - readyRows.length,
      scopeGroups: groups.size,
      uniqueQuestions: uniqueQuestionIds.size,
    },
  };
}

/* ═══════════════════════════════════════════════════════════════
   3. KO'RIB CHIQISH EKRANI
   ═══════════════════════════════════════════════════════════════ */

/** Savolni ko'rib chiqish uchun — to'g'ri javob ham ko'rinadi (bu ADMIN yo'li). */
const REVIEW_QUESTION_SELECT = {
  id: true,
  code: true,
  text: true,
  type: true,
  difficulty: true,
  status: true,
  source: true,
  language: true,
  explanation: true,
  subjectId: true,
  topicId: true,
  grade: true,
  topic: { select: { id: true, order: true, name: true } },
  options: {
    orderBy: { position: "asc" },
    select: { id: true, text: true, isCorrect: true, position: true },
  },
};

function _publicReviewQuestion(question, link) {
  if (!question) return null;
  return {
    id: question.id,
    code: question.code,
    text: question.text,
    type: question.type,
    difficulty: question.difficulty,
    difficultyLabel: LEVEL_LABELS[question.difficulty] || question.difficulty,
    levelKey: LEVEL_KEY_BY_DIFFICULTY.get(question.difficulty) || "medium",
    levelKeyLabel:
      LEVEL_KEY_LABELS[LEVEL_KEY_BY_DIFFICULTY.get(question.difficulty) || "medium"],
    status: question.status,
    source: question.source,
    language: question.language,
    languageLabel: languageLabel(question.language),
    explanation: question.explanation,
    topic: question.topic
      ? { id: question.topic.id, order: question.topic.order, name: question.topic.name }
      : null,
    options: (question.options || []).map((option) => ({
      id: option.id,
      text: option.text,
      isCorrect: option.isCorrect,
    })),
    position: link?.position ?? null,
    rowIndex: link?.rowIndex ?? null,
  };
}

/**
 * TASDIQLASH EKRANI — "filial egasi nimani ko'radi".
 *
 * Har o'quvchi: qamrovi, savollari (matni, variantlari, TO'G'RI JAVOBI),
 * va kimga test tushmagani — sababi bilan.
 *
 * ⚠️ TO'G'RI JAVOB KO'RINADI va bu ataylab: tasdiqlash "savol to'g'rimi"
 * degan qarorni talab qiladi, javob kalitini ko'rmasdan esa bu qarorni
 * qabul qilib bo'lmaydi. Yo'l ADMIN ruxsati ortida (`diagnostics.view`),
 * o'quvchi yo'li esa (`diagnosticAttempt`) kalitni HECH QACHON bermaydi.
 *
 * ⚠️ SINF TESTI (`perStudent: false`) HAM SHU EKRANDAN O'TADI: tasdiqlash
 * darvozasi hamma diagnostika testiga tegishli, ya'ni ikkinchi ekran
 * yozilmaydi. Unda bitta "umumiy" to'plam ko'rsatiladi.
 */
async function getTestReview(testId) {
  const test = await prisma.diagnosticTest.findUnique({
    where: { id: testId },
    include: testService.TEST_INCLUDE,
  });
  if (!test) throw new NotFoundError("Test topilmadi");

  const [withSubject] = await testService.attachTestSubjects([test]);
  const shaped = testService.shapeTest(withSubject) || {};

  const availability = await testService.checkAvailability(test);

  if (!test.perStudent) {
    const links = await prisma.diagnosticTestQuestion.findMany({
      where: { testId },
      orderBy: { position: "asc" },
      include: { question: { select: REVIEW_QUESTION_SELECT } },
    });

    return {
      test: shaped,
      perStudent: false,
      language: test.language,
      languageLabel: test.language ? languageLabel(test.language) : null,
      availability,
      approval: _approvalState(test),
      shared: links.map((link) => _publicReviewQuestion(link.question, link)),
      students: [],
      totals: {
        students: 0,
        ready: 0,
        failed: 0,
        uniqueQuestions: links.length,
        pendingApproval: availability.pendingApproval ?? 0,
      },
    };
  }

  const [rows, links] = await Promise.all([
    prisma.diagnosticTestStudent.findMany({
      where: { testId },
      orderBy: { studentId: "asc" },
    }),
    prisma.diagnosticTestStudentQuestion.findMany({
      where: { testId },
      orderBy: [{ studentId: "asc" }, { position: "asc" }],
      include: { question: { select: REVIEW_QUESTION_SELECT } },
    }),
  ]);

  const linksByStudent = new Map();
  const uniqueQuestions = new Set();
  for (const link of links) {
    if (!linksByStudent.has(link.studentId)) linksByStudent.set(link.studentId, []);
    linksByStudent.get(link.studentId).push(link);
    if (link.questionId) uniqueQuestions.add(link.questionId);
  }

  const students = rows
    .map((row) => ({
      studentId: row.studentId,
      fullName: row.snapshot?.fullName ?? null,
      username: row.snapshot?.username ?? null,
      className: row.snapshot?.className ?? null,
      status: row.status,
      reason: row.reason,
      questionCount: row.questionCount,
      scope: row.scope || [],
      scopeLabel: (row.scope || [])
        .map((scope) =>
          `${scope.subjectName ?? "Fan"} · ${scope.topicFrom}–${scope.topicTo}-mavzu`,
        )
        .join(" · "),
      questions: (linksByStudent.get(row.studentId) || []).map((link) =>
        _publicReviewQuestion(link.question, link),
      ),
    }))
    .sort((a, b) => (a.fullName || "").localeCompare(b.fullName || ""));

  return {
    test: shaped,
    perStudent: true,
    language: test.language,
    languageLabel: test.language ? languageLabel(test.language) : null,
    availability,
    approval: _approvalState(test),
    shared: [],
    students,
    totals: {
      students: students.length,
      ready: students.filter((row) => row.status === "ready").length,
      failed: students.filter((row) => row.status !== "ready").length,
      uniqueQuestions: uniqueQuestions.size,
      pendingApproval: availability.pendingApproval ?? 0,
    },
  };
}

/** Tasdiqlash holati — panel tugmalarni shunga qarab chizadi. */
function _approvalState(test) {
  return {
    approved: Boolean(test.approvedAt),
    approvedAt: test.approvedAt,
    approvedBy: test.approvedBy,
    reviewNote: test.reviewNote,
    /**
     * Tasdiqdan keyin savollarni almashtirib bo'lmaydi: "tasdiqlangan
     * narsa" bilan "chiqadigan narsa" bir xil bo'lishi kerak. Qayta
     * ko'rish uchun avval tasdiq bekor qilinadi (`rejectTest`).
     */
     editable: !test.approvedAt,
  };
}

/* ═══════════════════════════════════════════════════════════════
   4. SAVOLNI ALMASHTIRISH (bitta / bir nechta / hammasi)
   ═══════════════════════════════════════════════════════════════ */

/**
 * SAVOL QAYSI TAQSIMOT QATORIDAN — almashtirish AYNI qatordan oladi.
 *
 * Per-student testda qator raqami MUHRLANGAN (`rowIndex`), sinf testida
 * esa savolning o'zidan chiqariladi: fan + sinf + mavzu oralig'i + daraja.
 * Ikkinchi ustun qo'shish `DiagnosticTestQuestion` ni o'zgartirishni
 * talab qilardi — holbuki javob savolning ichida bor.
 */
function _resolveRowIndex(question, rows, blueprint) {
  const levelKey = LEVEL_KEY_BY_DIFFICULTY.get(question.difficulty) || "medium";

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.subjectId !== question.subjectId) continue;
    if (row.grade && question.grade && row.grade !== question.grade) continue;
    if ((Number(row[levelKey]) || 0) === 0) continue;

    const stored = blueprint?.[index];
    const order = question.topic?.order ?? null;
    if (stored?.topicFrom != null && stored?.topicTo != null && order != null) {
      if (order < stored.topicFrom || order > stored.topicTo) continue;
    }
    return index;
  }

  // Qator topilmasa — fan bo'yicha birinchi mos qator (daraja shartisiz)
  const fallback = rows.findIndex((row) => row.subjectId === question.subjectId);
  return fallback >= 0 ? fallback : null;
}

/**
 * Bitta o'rinbosar savol topadi / yozdiradi.
 *
 * @returns {Promise<{id: string, difficulty: string}|null>}
 */
async function _replacementFor({
  row,
  scope,
  difficulty,
  language,
  excludeIds,
  seenText,
  budget,
  actorId,
  generated,
}) {
  if (row.source === "ai") {
    const counts = Object.fromEntries(LEVEL_KEYS.map((key) => [key, 0]));
    const levelKey = LEVEL_KEY_BY_DIFFICULTY.get(difficulty) || "medium";
    counts[levelKey] = 1;

    generated.requested += 1;
    const result = await aiQuestionService.generateForRow({
      subject: { id: scope.subjectId, name: scope.subjectName },
      grade: row.grade,
      topics: scope.topics,
      counts,
      language,
      seenText,
      budget,
    });
    generated.requests += result.requests;

    if (!result.items.length) return null;

    const saved = await questionService.createGeneratedQuestions(result.items.slice(0, 1), {
      authorId: actorId,
    });
    generated.written += saved.created.length;
    generated.duplicates += saved.duplicates;
    generated.failed += saved.failed;

    const created = saved.created[0];
    return created ? { id: created.id, difficulty: created.difficulty || difficulty } : null;
  }

  // ── BANKDAN: AYNI qamrov, AYNI qiyinlik, lekin BOSHQA savol ──
  const pool = await prisma.diagnosticQuestion.findMany({
    where: {
      status: "approved",
      type: { not: "essay" },
      subjectId: row.subjectId,
      ...(row.grade ? { grade: row.grade } : {}),
      ...(language ? { language } : {}),
      ...(scope.topicIds ? { topicId: { in: scope.topicIds } } : {}),
      difficulty: { in: LEVEL_POOLS[LEVEL_KEY_BY_DIFFICULTY.get(difficulty) || "medium"] },
      id: { notIn: [...excludeIds] },
    },
    select: { id: true, text: true, difficulty: true },
    orderBy: [{ usageCount: "asc" }, { createdAt: "asc" }],
    take: 40,
  });

  for (const candidate of pool) {
    const key = String(candidate.text || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (seenText.has(key)) continue;
    seenText.add(key);
    return { id: candidate.id, difficulty: candidate.difficulty };
  }

  return null;
}

/**
 * SAVOLLARNI ALMASHTIRADI — bitta, bir nechta yoki HAMMASI.
 *
 * ⚠️ UCHALA REJIM BITTA YO'LDAN: `items` bitta element bo'lsa "bitta
 * savol", bir nechta bo'lsa "tanlanganlar", `all: true` bo'lsa hammasi.
 * Alohida yo'llar yozilsa, biriga qo'shilgan shart (qamrov, qiyinlik,
 * takror, tasdiq darvozasi) ikkinchisida tushib qolardi.
 *
 * ⚠️ TASDIQLANGAN TESTGA TEGILMAYDI va URINISHI BOR TESTGA HAM: ikkalasida
 * ham "tasdiqlangan narsa" bilan "o'quvchi ko'rgan narsa" ajralib ketardi.
 *
 * ⚠️ O'RINBOSAR AYNI QAMROVDAN VA AYNI QIYINLIKDAN olinadi. Aks holda
 * "bitta savolni almashtirdim" degan amal taqsimotni (5 oson + 10 o'rta)
 * va mavzu chegarasini jimgina buzardi.
 *
 * ⚠️ TOPILMAGANI O'Z JOYIDA QOLADI (`skipped`), xato emas: bankda mos
 * savol tugashi yoki model yaroqli savol yozmasligi NORMAL hol va u
 * butun amalni orqaga qaytarmasligi kerak.
 *
 * @param {object} params
 * @param {string} params.testId
 * @param {Array<{studentId?: string, questionId: string}>} [params.items]
 * @param {boolean} [params.all]
 * @param {string} params.actorId
 * @param {boolean} [params.canUseAi]
 */
async function regenerateQuestions({ testId, items = [], all = false, actorId, canUseAi = false }) {
  const test = await prisma.diagnosticTest.findUnique({
    where: { id: testId },
    include: { _count: { select: { attempts: true } } },
  });
  if (!test) throw new NotFoundError("Test topilmadi");

  if (test.approvedAt) {
    throw new ConflictError(
      "Test allaqachon tasdiqlangan — savolni almashtirish uchun avval tasdiqni bekor qiling",
    );
  }
  if (test._count.attempts > 0) {
    throw new ConflictError(
      `Testda ${test._count.attempts} ta urinish bor — savollar o'zgartirilmaydi`,
    );
  }

  const rows = parseBlueprint(test.blueprint, { legacy: true });
  if (!rows) {
    throw new BadRequestError(
      "Testning savollar taqsimoti yo'q — savolni almashtirib bo'lmaydi " +
        "(testni qaytadan yarating)",
    );
  }

  /**
   * ⚠️ QATOR RAQAMLARI MOS KELISHI TEKSHIRILADI.
   *
   * `rowIndex` muhrda saqlangan va u MUHRLANGAN taqsimotdagi o'rin
   * (`test.blueprint`). `parseBlueprint(..., { legacy: true })` esa
   * to'liqsiz qatorni TASHLAB yuboradi — amaldagi ma'lumotda bunday
   * qator bo'lmaydi, lekin bo'lib qolsa indekslar SURILIB, almashtirilgan
   * savol boshqa fanning qatoridan kelardi. Jim surilish o'rniga aniq
   * xato: tuzatish yo'li ham aniq (testni qayta yaratish).
   */
  const storedRows = Array.isArray(test.blueprint) ? test.blueprint : [];
  if (storedRows.length !== rows.length) {
    throw new ConflictError(
      "Testning savollar taqsimoti o'qilmadi (qatorlar mos kelmadi) — " +
        "savolni almashtirish uchun testni qaytadan yarating",
    );
  }

  const classLink = await prisma.diagnosticTestClass.findFirst({
    where: { testId },
    select: { classId: true },
  });
  if (!classLink) {
    throw new BadRequestError("Testga guruh biriktirilmagan — qamrovni aniqlab bo'lmaydi");
  }

  // ── ALMASHTIRILADIGAN QATORLAR ──
  //
  // ⚠️ RO'YXAT SERVERDA QAYTA OLINADI (`all` rejimida): eskirgan ekran
  // boshqa testning savolini almashtirib yubormasligi kerak
  // (`LessonCredit` dagi "server ro'yxatni O'ZI oladi" bilan AYNI).
  const requested = new Set(
    (Array.isArray(items) ? items : [])
      .filter((item) => item?.questionId)
      .map((item) => `${item.studentId || ""}|${item.questionId}`),
  );
  if (!all && requested.size === 0) {
    throw new BadRequestError("Almashtiriladigan savol tanlanmagan");
  }

  const links = test.perStudent
    ? await prisma.diagnosticTestStudentQuestion.findMany({
        where: { testId },
        orderBy: [{ studentId: "asc" }, { position: "asc" }],
        include: { question: { select: { id: true, subjectId: true, grade: true, difficulty: true, text: true, topic: { select: { order: true } } } } },
      })
    : (
        await prisma.diagnosticTestQuestion.findMany({
          where: { testId },
          orderBy: { position: "asc" },
          include: { question: { select: { id: true, subjectId: true, grade: true, difficulty: true, text: true, topic: { select: { order: true } } } } },
        })
      ).map((link) => ({ ...link, studentId: null, rowIndex: null }));

  const targets = all
    ? links
    : links.filter((link) =>
        requested.has(`${test.perStudent ? link.studentId : ""}|${link.questionId}`),
      );

  if (targets.length === 0) {
    throw new NotFoundError("Tanlangan savollar bu testda topilmadi");
  }
  if (targets.length > MAX_REGENERATE) {
    throw new BadRequestError(
      `Bir amalda ${MAX_REGENERATE} tadan ko'p savol almashtirilmaydi (${targets.length} ta tanlandi)`,
    );
  }

  // AI qatoriga tegadigan almashtirish bo'lsa — alohida ruxsat
  const touchesAi = targets.some((link) => {
    const index = test.perStudent
      ? link.rowIndex
      : _resolveRowIndex(link.question, rows, test.blueprint);
    return index != null && rows[index]?.source === "ai";
  });
  if (touchesAi) {
    if (!canUseAi) {
      throw new ForbiddenError(
        "AI bilan savol yozish uchun ruxsat yo'q (Diagnostika → AI tahlilini ishga tushirish)",
      );
    }
    await aiQuestionService.assertEnabled();
  }

  // ── QAMROV: har o'quvchi uchun MUHRLANGAN oraliqdan ──
  const studentRows = test.perStudent
    ? await prisma.diagnosticTestStudent.findMany({
        where: { testId },
        select: { studentId: true, scope: true },
      })
    : [];
  const scopeByStudent = new Map(studentRows.map((row) => [row.studentId, row.scope || []]));

  // Mavzu id'lari muhrda yo'q (joy tejaladi) — oraliqdan QAYTA o'qiladi.
  const topicCache = new Map();
  const loadTopics = async (subjectId, from, to) => {
    const key = `${subjectId}|${from}|${to}`;
    if (!topicCache.has(key)) {
      topicCache.set(
        key,
        await prisma.topic.findMany({
          where: {
            subjectId,
            ...(test.language ? { language: test.language } : {}),
            order: { gte: from, lte: to },
          },
          orderBy: { order: "asc" },
          select: { id: true, order: true, name: true, description: true, level: true, book: true },
        }),
      );
    }
    return topicCache.get(key);
  };

  const subjects = await prisma.subject.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.subjectId))] } },
    select: { id: true, name: true },
  });
  const subjectName = new Map(subjects.map((row) => [row.id, row.name]));

  // Takror ushlagich: testdagi HAMMA savol matni (yangi savol ularni
  // takrorlamasligi kerak)
  const seenText = new Set(
    links.map((link) =>
      String(link.question?.text || "").toLowerCase().replace(/\s+/g, " ").trim(),
    ),
  );
  const excludeIds = new Set(links.map((link) => link.questionId));

  const budget = { value: aiQuestionService.MAX_REQUESTS_PER_BUILD };
  const generated = { requested: 0, written: 0, duplicates: 0, failed: 0, requests: 0 };
  const replaced = [];
  const skipped = [];

  for (const link of targets) {
    const index = test.perStudent
      ? link.rowIndex
      : _resolveRowIndex(link.question, rows, test.blueprint);
    const row = index != null ? rows[index] : null;

    if (!row) {
      skipped.push({
        studentId: link.studentId,
        questionId: link.questionId,
        reason: "Savol qaysi taqsimot qatoridan kelgani aniqlanmadi",
      });
      continue;
    }

    // Qamrov: per-student testda MUHRLANGAN oraliqdan, sinf testida
    // saqlangan taqsimotdan
    const sealed = test.perStudent
      ? (scopeByStudent.get(link.studentId) || []).find((item) => item.index === index)
      : test.blueprint?.[index];

    let topics = [];
    let topicIds = null;
    if (sealed?.topicFrom != null && sealed?.topicTo != null) {
      topics = await loadTopics(row.subjectId, sealed.topicFrom, sealed.topicTo);
      topicIds = topics.map((topic) => topic.id);
    }

    if (row.source === "ai" && topics.length === 0) {
      skipped.push({
        studentId: link.studentId,
        questionId: link.questionId,
        reason: "Qamrovdagi mavzular topilmadi — AI savol yozolmaydi",
      });
      continue;
    }

    const replacement = await _replacementFor({
      row,
      scope: {
        subjectId: row.subjectId,
        subjectName: subjectName.get(row.subjectId) || "Fan",
        topics,
        topicIds,
      },
      difficulty: link.difficulty || link.question?.difficulty || "medium",
      language: test.language,
      excludeIds,
      seenText,
      budget,
      actorId,
      generated,
    });

    if (!replacement) {
      skipped.push({
        studentId: link.studentId,
        questionId: link.questionId,
        reason:
          row.source === "ai"
            ? "AI yaroqli savol yozmadi — qayta urinib ko'ring"
            : "Bankda bu qamrov va qiyinlikda boshqa savol qolmadi",
      });
      continue;
    }

    excludeIds.add(replacement.id);

    // ⚠️ O'CHIRISH + YOZISH BITTA TRANZAKSIYADA: o'rtada yiqilsa, o'quvchi
    // to'plamida bo'shliq qolib, savollar soni jimgina kamayardi.
    try {
      await prisma.$transaction(async (tx) => {
        if (test.perStudent) {
          await tx.diagnosticTestStudentQuestion.delete({
            where: {
              testId_studentId_questionId: {
                testId,
                studentId: link.studentId,
                questionId: link.questionId,
              },
            },
          });
          await tx.diagnosticTestStudentQuestion.create({
            data: {
              testId,
              studentId: link.studentId,
              questionId: replacement.id,
              position: link.position,
              rowIndex: index,
              difficulty: replacement.difficulty,
            },
          });
        } else {
          await tx.diagnosticTestQuestion.delete({
            where: { testId_questionId: { testId, questionId: link.questionId } },
          });
          await tx.diagnosticTestQuestion.create({
            data: { testId, questionId: replacement.id, position: link.position },
          });
        }
      });

      replaced.push({
        studentId: link.studentId,
        oldQuestionId: link.questionId,
        newQuestionId: replacement.id,
        position: link.position,
      });
    } catch (error) {
      logger.warn(
        `[DiagnosticStudentTest] Savol almashtirilmadi (${link.questionId}): ${error.message}`,
      );
      skipped.push({
        studentId: link.studentId,
        questionId: link.questionId,
        reason: error.message,
      });
    }
  }

  logger.info(
    `[DiagnosticStudentTest] "${test.title}" — ${replaced.length} savol almashtirildi, ` +
      `${skipped.length} tasi o'z joyida qoldi`,
  );

  return {
    testId,
    perStudent: test.perStudent,
    generated,
    replaced,
    skipped,
    totals: {
      requested: targets.length,
      replaced: replaced.length,
      skipped: skipped.length,
    },
  };
}

/* ═══════════════════════════════════════════════════════════════
   5. TASDIQLASH VA RAD ETISH
   ═══════════════════════════════════════════════════════════════ */

const REVIEW_NOTE_MAX = 500;

/**
 * TESTNI TASDIQLAYDI — "filial egasi ko'rib chiqdi, chiqarilsin".
 *
 * ⚠️ IKKI ISH BIRGA: testdagi tasdiqlanmagan savollar tasdiqlanadi va
 * testning o'zi tasdiqlangan deb belgilanadi. Ikkisi ajratilsa, admin
 * "tasdiqladim, lekin test baribir chiqmaydi" holatiga tushardi — savollar
 * hali `review` bo'lib turardi.
 *
 * ⚠️ RUXSAT — `diagnostics.publish` (route'da): test TUZISH huquqi uni
 * CHIQARISH huquqiga aylanmasligi kerak. Savolni tasdiqlash odatda
 * `diagnostics.moderate` ortida, lekin bu yerda qaror BITTA ("bu test
 * chiqadi") va uni ikki ruxsatga bo'lish tasdiqlash tugmasini ishlatib
 * bo'lmas qilardi.
 *
 * ⚠️ TASDIQ IDEMPOTENT EMAS: allaqachon tasdiqlangan test qayta
 * tasdiqlanmaydi (`ConflictError`) — "kim va qachon tasdiqladi" izi
 * birinchi qarorda qolishi kerak.
 */
async function approveTest({ testId, actorId, note }) {
  const test = await prisma.diagnosticTest.findUnique({ where: { id: testId } });
  if (!test) throw new NotFoundError("Test topilmadi");
  if (test.approvedAt) throw new ConflictError("Test allaqachon tasdiqlangan");

  const questionResult = await testService.approveTestQuestions(testId);

  const cleanNote =
    typeof note === "string" && note.trim() ? note.trim().slice(0, REVIEW_NOTE_MAX) : null;

  // Compare-and-swap: parallel ikkinchi tasdiq o'tmaydi
  const updated = await prisma.diagnosticTest.updateMany({
    where: { id: testId, approvedAt: null },
    data: { approvedAt: new Date(), approvedBy: actorId, reviewNote: cleanNote },
  });
  if (updated.count !== 1) {
    throw new ConflictError("Test shu orada tasdiqlandi — sahifani yangilang");
  }

  // Nashr darvozasining qolgan sharti: savollar yetarlimi. Tasdiqdan
  // KEYIN o'qiladi — tasdiqlash savollarni `approved` qiladi va
  // tekshiruv shundan keyingi haqiqatni ko'rsatishi kerak.
  const availability = await testService.checkAvailability(test);

  logger.info(`[DiagnosticStudentTest] "${test.title}" tasdiqlandi (${actorId})`);

  return {
    testId,
    approved: true,
    questions: questionResult,
    availability,
    message:
      `Test tasdiqlandi. ${questionResult.approved} ta savol tasdiqlandi — ` +
      `endi testni chiqarish mumkin.`,
  };
}

/**
 * TASDIQNI BEKOR QILADI — "qayta ko'rib chiqilsin".
 *
 * ⚠️ SABAB MAJBURIY: "nega chiqmadi" degan savolga javob ekranda qolishi
 * kerak (`reviewNote`), aks holda test tuzgan odam nimani tuzatishini
 * bilmasdi.
 *
 * ⚠️ CHIQARILGAN TEST AVVAL YOPILADI: tasdiqni bekor qilish ochiq testni
 * jimgina qoldirsa, "tasdiqlanmagan, lekin ishlab turgan" test bo'lib
 * qolardi. Shuning uchun holat `draft` ga qaytariladi (urinishi bo'lsa
 * RAD ETILADI — natijalar tarixi tasdiqqa tayanadi).
 */
async function rejectTest({ testId, actorId, note }) {
  const cleanNote = typeof note === "string" ? note.trim() : "";
  if (cleanNote.length < 3) {
    throw new BadRequestError("Rad etish sababi yozilishi shart (kamida 3 belgi)");
  }

  const test = await prisma.diagnosticTest.findUnique({
    where: { id: testId },
    include: { _count: { select: { attempts: true } } },
  });
  if (!test) throw new NotFoundError("Test topilmadi");
  if (test._count.attempts > 0) {
    throw new ConflictError(
      `Testda ${test._count.attempts} ta urinish bor — tasdiq bekor qilinmaydi. ` +
        `Testni arxivlang va yangisini yarating.`,
    );
  }

  await prisma.diagnosticTest.update({
    where: { id: testId },
    data: {
      approvedAt: null,
      approvedBy: null,
      reviewNote: cleanNote.slice(0, REVIEW_NOTE_MAX),
      status: "draft",
    },
  });

  logger.info(`[DiagnosticStudentTest] "${test.title}" tasdiqi bekor qilindi (${actorId})`);

  return {
    testId,
    approved: false,
    note: cleanNote.slice(0, REVIEW_NOTE_MAX),
    message: "Tasdiq bekor qilindi — test qoralamaga qaytarildi",
  };
}

/* ═══════════════════════════════════════════════════════════════
   6. O'QUVCHI TOMONI
   ═══════════════════════════════════════════════════════════════ */

/**
 * O'QUVCHINING SHU TESTDAGI SAVOLLARI — urinish shu yerdan oladi.
 *
 * ⚠️ RO'YXAT BO'SH BO'LSA, URINISH BOSHLANMAYDI (chaqiruvchi hal qiladi).
 * Per-student testda "bankdan avtomat tanlash" yo'liga TUSHIB KETISH
 * mumkin emas: o'sha yo'l mavzu qamrovini bilmaydi va o'quvchi
 * o'tilmagan mavzudan savol olardi — modulning asosiy qoidasi aynan shu.
 *
 * @returns {Promise<{status: string, reason: string|null, questionIds: string[]}>}
 */
async function studentQuestionSet(testId, studentId) {
  const row = await prisma.diagnosticTestStudent.findUnique({
    where: { testId_studentId: { testId, studentId } },
    select: { status: true, reason: true, questionCount: true },
  });

  if (!row) {
    return { status: "missing", reason: "Bu test siz uchun tuzilmagan", questionIds: [] };
  }
  if (row.status !== "ready") {
    return { status: row.status, reason: row.reason, questionIds: [] };
  }

  const links = await prisma.diagnosticTestStudentQuestion.findMany({
    where: { testId, studentId },
    orderBy: { position: "asc" },
    select: { questionId: true },
  });

  return {
    status: "ready",
    reason: null,
    questionIds: links.map((link) => link.questionId),
  };
}

module.exports = {
  MAX_STUDENTS_PER_TEST,
  MAX_REGENERATE,
  REVIEW_NOTE_MAX,
  LEVEL_KEY_BY_DIFFICULTY,
  planStudentTest,
  buildStudentTest,
  getTestReview,
  regenerateQuestions,
  approveTest,
  rejectTest,
  studentQuestionSet,
};
