const ExcelService = require("../services/excel.service");
const attemptService = require("../services/diagnosticAttempt.service");
const aiService = require("../services/diagnosticAi.service");
const analyticsService = require("../services/diagnosticAnalytics.service");
const studentService = require("../services/diagnosticStudent.service");
const asyncHandler = require("../middleware/async.middleware");
const { ForbiddenError } = require("../utils/errors");
const { hasPermission, hasRole } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");
const {
  formatDuration,
  TONE_LABELS,
} = require("../helpers/diagnostic.helpers");
const { formatDateTimeUz } = require("../helpers/date.helpers");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");

/**
 * Natijani ko'rish huquqi.
 *
 * ⚠️ IKKI XIL YO'L VA ULAR ATAYLAB HAR XIL:
 *   - O'QUVCHI o'z natijasini RUXSATSIZ ko'radi (u o'zining ma'lumoti);
 *   - BOSHQALARNING natijasi `diagnostics.attempts` ruxsati ortida.
 * Ikkalasini bitta ruxsatga bog'lash o'quvchini o'z natijasidan mahrum
 * qilardi yoki har kimga butun registrni ochib berardi.
 */
function _assertCanView(req, attemptStudentId) {
  if (req.user.id === attemptStudentId) return true;
  if (hasRole(req.user, ROLES.OWNER)) return true;
  if (hasPermission(req.user.permissions || [], "diagnostics.attempts")) return true;
  throw new ForbiddenError("Bu natijani ko'rish uchun ruxsatingiz yo'q");
}

// ── O'QUVCHI TOMONI ──────────────────────────

const startAttempt = asyncHandler(async (req, res) => {
  const data = await attemptService.startAttempt(req.user.id, req.body);
  res.status(201).json({ success: true, data });
});

const getActiveAttempt = asyncHandler(async (req, res) => {
  const data = await attemptService.getActiveAttempt(req.user.id, req.params.id);
  res.json({ success: true, data });
});

// Bitta javobni saqlash. Adaptiv rejimda javob KEYINGI SAVOLNI ham
// qaytaradi — mijoz alohida so'rov yubormaydi.
const saveAnswer = asyncHandler(async (req, res) => {
  const data = await attemptService.saveAnswer(
    req.user.id,
    req.params.id,
    req.params.questionId,
    req.body,
  );
  res.json({ success: true, data });
});

const submitAttempt = asyncHandler(async (req, res) => {
  const attempt = await attemptService.submitAttempt(
    req.user.id,
    req.params.id,
    req.body,
  );

  // ⚠️ TAHLIL QATORLARI SHU YERDA YARATILADI (kutiladi), MODEL CHAQIRUVI
  // esa FONDA qoladi — `requestAnalysis` qatorlarni yozib bo'lgach darhol
  // qaytadi va ishlovni kutmaydi.
  //
  // `await` ATAYLAB: usiz qatorlar javobdan KEYIN yaratilardi va natija
  // sahifasi ochilganda "tahlil yo'q" holatini ko'rib qolishi mumkin edi
  // ("Tahlil hali so'ralmagan" degan noto'g'ri xabar bilan). Kutish
  // narxi — bir nechta INSERT, model javobi emas.
  await aiService
    .requestAnalysis(attempt.id, ["feedback", "roadmap"])
    .catch(() => null);

  res.json({
    success: true,
    message: "Test yakunlandi",
    data: { id: attempt.id, score: attempt.score, grade: attempt.grade },
  });
});

const getMyAttempts = asyncHandler(async (req, res) => {
  const data = await attemptService.listStudentAttempts(req.user.id, {
    limit: parseInt(req.query.limit, 10) || 20,
  });
  res.json({ success: true, data });
});

/**
 * O'quvchining diagnostika boshqaruv paneli.
 *
 * ⚠️ HAR DOIM `req.user.id` — so'rovda `studentId` QABUL QILINMAYDI.
 * Xodim boshqa o'quvchining panelini `/diagnostics/analytics/students/:id/dashboard`
 * orqali ochadi va u yerda ruxsat tekshiriladi. Bitta yo'lga ikkala
 * holatni yig'ish "o'quvchi boshqa o'quvchining id sini yozib yuborsa
 * nima bo'ladi" degan savolni doimiy ochiq qoldirardi.
 */
const getMyDashboard = asyncHandler(async (req, res) => {
  const data = await studentService.getDashboard(req.user.id);
  res.json({ success: true, data });
});

// ── NATIJA (o'quvchi va admin uchun bitta yo'l) ──

const getResult = asyncHandler(async (req, res) => {
  const owner = await attemptService.getAttemptOwner(req.params.id);
  _assertCanView(req, owner.studentId);

  // Ruxsati bor xodim to'g'ri javoblarni DOIM ko'radi; o'quvchi esa
  // testning `showAnswers` sozlamasiga qarab (service'dagi izohga qarang).
  const data = await attemptService.getResult(req.params.id, {
    staff: req.user.id !== owner.studentId,
  });

  res.json({ success: true, data });
});

const getInsights = asyncHandler(async (req, res) => {
  const owner = await attemptService.getAttemptOwner(req.params.id);
  _assertCanView(req, owner.studentId);

  res.json({ success: true, data: await aiService.getInsights(req.params.id) });
});

const explainAnswer = asyncHandler(async (req, res) => {
  const owner = await attemptService.getAttemptOwner(req.params.id);
  _assertCanView(req, owner.studentId);

  // `staff` — testning "javoblarni ko'rsatma" sozlamasini chetlab o'tish
  // huquqi (service'dagi izohga qarang), egalik tekshiruvi emas.
  const data = await aiService.explainAnswer(
    req.params.id,
    req.params.questionId,
    { staff: req.user.id !== owner.studentId },
  );
  res.json({ success: true, data });
});

// AI tahlilini qayta so'rash (tugma). Model chaqiruvi pullik — shuning
// uchun alohida ruxsat: `diagnostics.ai`.
const requestAnalysis = asyncHandler(async (req, res) => {
  const kinds = Array.isArray(req.body.kinds) && req.body.kinds.length
    ? req.body.kinds
    : ["feedback", "roadmap", "plan"];

  const data = await aiService.requestAnalysis(req.params.id, kinds);
  res.json({ success: true, message: "Tahlil so'raldi", data });
});

// ── ADMIN TOMONI ─────────────────────────────

const getAttempts = asyncHandler(async (req, res) => {
  const pagination = getPaginationParams(req);
  const { total, rows } = await attemptService.listAttempts(req.query, pagination);

  res.json(formatPaginationResponse(rows, total, pagination.page, pagination.limit));
});

const deleteAttempt = asyncHandler(async (req, res) => {
  const data = await attemptService.deleteAttempt(req.params.id);
  res.json({ success: true, message: data.message, data });
});

const exportAttempts = asyncHandler(async (req, res) => {
  const rows = await analyticsService.getAttemptsForExport(req.query);

  const workbook = ExcelService.createExcel({
    sheetName: "Diagnostika natijalari",
    columns: [
      { header: "O'quvchi", key: "student", width: 26 },
      { header: "Sinf", key: "className", width: 10 },
      { header: "Fan", key: "subject", width: 18 },
      { header: "Rejim", key: "mode", width: 12 },
      { header: "Natija", key: "score", width: 10 },
      { header: "Daraja", key: "grade", width: 10 },
      { header: "To'g'ri", key: "correct", width: 9 },
      { header: "Xato", key: "wrong", width: 9 },
      { header: "Tashlab ketilgan", key: "skipped", width: 16 },
      { header: "Savollar", key: "totalQuestions", width: 10 },
      { header: "Vaqt", key: "timeSpent", width: 10 },
      { header: "Topshirilgan", key: "submittedAt", width: 20 },
    ],
    data: rows.map((row) => ({
      ...row,
      timeSpent: formatDuration(row.timeSpentSec),
    })),
    headerStyle: { bgColor: ExcelService.COLORS.HEADER_PURPLE },
  });

  const filename = ExcelService.generateFileName("diagnostika_natijalar");
  await ExcelService.sendWorkbook(res, workbook, filename);
});

/**
 * BITTA NATIJANI EXCEL'GA YUKLASH ("Hisobotni yuklab olish" / "Excelga").
 *
 * ⚠️ TO'RT VARAQ, CHUNKI HISOBOT UCH XIL SAVOLGA JAVOB BERADI: "qancha
 * oldim", "qaysi fandan/mavzudan" va "qaysi savolda nima bo'ldi". Bitta
 * tekis jadvalga sig'dirilsa har qatorda umumiy ko'rsatkichlar
 * takrorlanib, fayl o'qib bo'lmas holga kelardi.
 *
 * ⚠️ JAVOB KALITI `showAnswers` ORTIDA. Servis "javoblarni ko'rsatma"
 * qilingan testda to'g'ri javobni umuman qaytarmaydi — Excel esa shu
 * ma'lumotdan yasaladi, ya'ni faylni yuklab olish orqali sozlamani
 * chetlab o'tib bo'lmaydi.
 */
const exportResult = asyncHandler(async (req, res) => {
  const owner = await attemptService.getAttemptOwner(req.params.id);
  const isStaff = _assertCanView(req, owner.studentId) && req.user.id !== owner.studentId;

  const result = await attemptService.getResult(req.params.id, { staff: isStaff });
  const { attempt, breakdown, subjects, questions, errorPatterns, roadmap, findings } =
    result;

  const workbook = ExcelService.createWorkbook();
  const student =
    [attempt.studentSnapshot?.lastName, attempt.studentSnapshot?.firstName]
      .filter(Boolean)
      .join(" ") || "—";

  // ── 1. UMUMIY ──────────────────────────────
  const summary = ExcelService.addWorksheet(workbook, "Umumiy");
  ExcelService.setColumns(summary, [
    { header: "Ko'rsatkich", key: "label", width: 30 },
    { header: "Qiymat", key: "value", width: 46 },
  ]);
  ExcelService.styleHeader(summary, { bgColor: ExcelService.COLORS.HEADER_PURPLE });
  ExcelService.addRows(summary, [
    { label: "O'quvchi", value: student },
    { label: "Sinf", value: attempt.studentSnapshot?.className || "—" },
    { label: "Test", value: attempt.testTitle || "Mustaqil mashq" },
    { label: "Topshirilgan", value: formatDateTimeUz(attempt.submittedAt) },
    { label: "Natija", value: attempt.score != null ? `${Math.round(attempt.score)}%` : "—" },
    { label: "Daraja", value: attempt.gradeLabel },
    { label: "Aniqlik", value: attempt.accuracy != null ? `${attempt.accuracy}%` : "—" },
    {
      label: "To'g'ri javoblar",
      value: `${attempt.correctCount ?? 0} / ${attempt.gradedQuestions ?? attempt.totalQuestions ?? 0}`,
    },
    { label: "Xato javoblar", value: attempt.wrongCount ?? 0 },
    { label: "Tashlab ketilgan", value: attempt.skippedCount ?? 0 },
    { label: "Sarflangan vaqt", value: formatDuration(attempt.timeSpentSec) },
    ...findings.map((f) => ({
      label: f.label,
      value: [f.title, f.metric].filter(Boolean).join(" — "),
    })),
    ...(errorPatterns && errorPatterns.wrongCount
      ? [
          { label: "Xato sababi: shoshilish", value: `${errorPatterns.rushing}%` },
          { label: "Xato sababi: bilim yetishmasligi", value: `${errorPatterns.knowledge}%` },
          { label: "Xato sababi: noto'g'ri o'qish", value: `${errorPatterns.misread}%` },
        ]
      : []),
  ]);

  // ── 2. FANLAR ──────────────────────────────
  const subjectSheet = ExcelService.addWorksheet(workbook, "Fanlar");
  ExcelService.setColumns(subjectSheet, [
    { header: "Fan", key: "subject", width: 28 },
    { header: "Savollar", key: "questions", width: 12 },
    { header: "To'g'ri", key: "correct", width: 10 },
    { header: "Natija", key: "score", width: 10 },
  ]);
  ExcelService.styleHeader(subjectSheet, { bgColor: ExcelService.COLORS.HEADER_BLUE });
  ExcelService.addRows(
    subjectSheet,
    subjects.map((s) => ({ ...s, score: `${s.score}%` })),
  );

  // ── 3. MAVZULAR ────────────────────────────
  const topicSheet = ExcelService.addWorksheet(workbook, "Mavzular");
  ExcelService.setColumns(topicSheet, [
    { header: "Mavzu", key: "topic", width: 32 },
    { header: "Savollar", key: "questions", width: 12 },
    { header: "To'g'ri", key: "correct", width: 10 },
    { header: "Natija", key: "score", width: 10 },
    { header: "Holat", key: "tone", width: 22 },
  ]);
  ExcelService.styleHeader(topicSheet, { bgColor: ExcelService.COLORS.HEADER_GREEN });
  ExcelService.addRows(
    topicSheet,
    breakdown.map((t) => ({
      topic: t.topic,
      questions: t.questions ?? t.total ?? 0,
      correct: t.correct ?? 0,
      score: `${Math.round(t.score)}%`,
      tone: TONE_LABELS[t.tone] || "—",
    })),
  );

  // ── 4. SAVOLLAR ────────────────────────────
  const questionSheet = ExcelService.addWorksheet(workbook, "Savollar");
  ExcelService.setColumns(questionSheet, [
    { header: "#", key: "position", width: 6 },
    { header: "Savol", key: "text", width: 60 },
    { header: "Mavzu", key: "topic", width: 24 },
    { header: "Sizning javobingiz", key: "given", width: 30 },
    ...(result.showAnswers
      ? [
          { header: "To'g'ri javob", key: "correct", width: 30 },
          { header: "Holat", key: "status", width: 12 },
        ]
      : []),
    { header: "Vaqt", key: "time", width: 10 },
  ]);
  ExcelService.styleHeader(questionSheet, { bgColor: ExcelService.COLORS.HEADER_DARK });

  const optionText = (question, ids = []) =>
    question.options
      .filter((o) => ids.includes(o.id))
      .map((o) => o.text)
      .filter(Boolean)
      .join(", ");

  ExcelService.addRows(
    questionSheet,
    questions.map((q) => {
      const given =
        q.answer?.textAnswer ||
        optionText(q, q.answer?.selectedOptionIds || []) ||
        "(bo'sh)";
      const row = {
        position: q.position + 1,
        text: q.text,
        topic: q.topicName || "—",
        given,
        time: formatDuration(q.answer?.timeSpentSec),
      };
      if (result.showAnswers) {
        row.correct =
          optionText(
            q,
            q.options.filter((o) => o.isCorrect).map((o) => o.id),
          ) || "—";
        row.status = q.answer?.isSkipped
          ? "Bo'sh"
          : q.answer?.isCorrect
            ? "To'g'ri"
            : "Xato";
      }
      return row;
    }),
  );

  // ⚠️ FAYL NOMIDA ISO SANA — u MASHINA uchun (saralanadigan nom), matn
  // emas. Ekranda ko'rinadigan sana `formatDateTimeUz` bilan chiqadi
  // (`.claude/rules/dates.md` §3 istisnosi).
  const filename = ExcelService.generateFileName(
    `diagnostika_${student.replace(/\s+/g, "_")}`,
  );
  await ExcelService.sendWorkbook(res, workbook, filename);
});

module.exports = {
  startAttempt,
  getActiveAttempt,
  saveAnswer,
  submitAttempt,
  getMyAttempts,
  getMyDashboard,
  getResult,
  getInsights,
  explainAnswer,
  requestAnalysis,
  getAttempts,
  deleteAttempt,
  exportAttempts,
  exportResult,
};
