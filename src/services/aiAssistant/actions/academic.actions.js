/**
 * AI yordamchi — TA'LIM bo'limi amallari (taklif → ko'rinish → tasdiq → bajarish).
 *
 * `prepare` servis rad etadigan HAMMA holatni oldindan tekshiradi: ega
 * tasdiqlash tugmasini bosgandan keyin "bajarilmadi" ko'rishi — eng yomon
 * tajriba. Ayniqsa davomat servislari o'quvchi, sinf a'zoligi, yakshanba,
 * bayram va kelajak sanani TEKSHIRMAYDI (`studentAttendance.markAttendance`)
 * — bu tekshiruvlar shu yerda.
 *
 * `execute` HTTP controller qatorlarining aynan ko'zgusi: bir xil servis,
 * bir xil argumentlar, aktyor — `ctx.user.id`. Biznes mantiqi bu yerda
 * qayta yozilmaydi.
 *
 * ⚠️ Ataylab OCHILMAGAN amallar: baho qo'yish/tahrirlash/o'chirish
 * (o'qituvchining o'z darsi), mavsum e'loni va yakunlash (ommaviy Telegram
 * va qaytmas tanga), har qanday o'chirish va sozlamalar.
 */

const prisma = require("../../../config/prisma");
const {
  defineAction,
  AiToolError,
  idSchema,
  monthSchema,
  daySchema,
  requireId,
  monthArg,
  dayArg,
  monthLabel,
  personName,
} = require("../assistant.toolkit");
const { ROLES } = require("../../../utils/constants");
const { formatDateUz, formatDateTimeUz } = require("../../../helpers/date.helpers");
const {
  parseDayDate,
  currentDayDate,
  monthKeyOfDate,
} = require("../../../helpers/month.helpers");
const { Decimal } = require("../../../helpers/money.helpers");
const {
  ACADEMIC_METRICS,
  METRIC_KINDS,
  METRIC_MAX,
  getMetric,
} = require("../../../helpers/academicMetrics");

const academicTargetService = require("../../../services/academicTarget.service");
const academicInsightService = require("../../../services/academicInsight.service");
const achievementService = require("../../../services/achievement.service");
const attendanceService = require("../../../services/attendance.service");
const studentAttendanceService = require("../../../services/studentAttendance.service");
const clubService = require("../../../services/club.service");
const { getAttendanceSettings } = require("../../../services/settings.service");
const { buildHolidaySet } = require("../../../services/holiday.service");

const TOOLSET = "academic";

/** Davomat holatlari (o'quvchi va xodim enumi bir xil) — foydalanuvchi matni. */
const ATTENDANCE_STATUS_LABELS = Object.freeze({
  present: "Keldi",
  late: "Kechikdi",
  absent: "Kelmadi",
  excused: "Sababli",
});
const ATTENDANCE_STATUSES = Object.keys(ATTENDANCE_STATUS_LABELS);

const EXCUSE_STATUS_LABELS = Object.freeze({
  pending: "Kutilmoqda",
  approved: "Tasdiqlangan",
  rejected: "Rad etilgan",
});

const LEVEL_LABELS = achievementService.ACHIEVEMENT_LEVEL_LABELS;
const PLACE_LABELS = achievementService.ACHIEVEMENT_PLACE_LABELS;

/** `achievement.service` dagi chegaralar bilan bir xil (u yerda eksport qilinmagan). */
const MAX_ACHIEVEMENT_TITLE = 160;
const MAX_NOTE = 500;

/** Bitta taklifda to'garakka qo'shiladigan o'quvchilar — preview o'qiladigan bo'lib qolishi uchun. */
const MAX_CLUB_MEMBERS_PER_PROPOSAL = 100;

/** Ko'rinishda nomi bilan sanab o'tiladigan o'quvchilar soni. */
const PREVIEW_NAME_LIMIT = 10;

/** Ismlar ro'yxati: "A, B, C va yana 4 ta". */
function nameList(names) {
  const shown = names.slice(0, PREVIEW_NAME_LIMIT).join(", ");
  const rest = names.length - PREVIEW_NAME_LIMIT;
  return rest > 0 ? `${shown} va yana ${rest} ta` : shown;
}

const dayLabel = (iso) => formatDateUz(parseDayDate(iso), { utc: true });

/** Erkin matn: bo'sh → null. */
const textOrNull = (value) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
};

// ─────────────────────────────────────────────────────────────────────────
// 1. Oylik ta'lim rejasi
// ─────────────────────────────────────────────────────────────────────────

/**
 * Reja qiymatini `academicTarget.service` dagi `parseMetricValue` bilan
 * AYNAN bir xil qoidalar bo'yicha tekshiradi (u eksport qilinmagan).
 * Servis baribir yozishdan oldin hammasini qayta tekshiradi — bu yerdagi
 * nusxa faqat xatoni tasdiqdan OLDIN ko'rsatish uchun.
 */
function parsePlanValue(metric, raw) {
  let value;
  try {
    value = new Decimal(typeof raw === "string" ? raw.replace(/\s+/g, "").replace(",", ".") : raw);
  } catch {
    throw new AiToolError(`${metric.label}: reja noto'g'ri formatda`);
  }
  if (!value.isFinite() || value.isNegative()) {
    throw new AiToolError(`${metric.label}: reja manfiy bo'lishi mumkin emas`);
  }
  if (value.decimalPlaces() > 2) {
    throw new AiToolError(`${metric.label}: reja 2 xonagacha kasr bo'lishi kerak`);
  }
  if (metric.kind === METRIC_KINDS.COUNT && !value.isInteger()) {
    throw new AiToolError(`${metric.label}: reja butun son bo'lishi kerak`);
  }
  const max = METRIC_MAX[metric.kind];
  if (max != null && value.greaterThan(max)) {
    throw new AiToolError(`${metric.label}: reja ${max} dan oshmasligi kerak`);
  }
  return value;
}

/** Reja qiymatini ko'rsatish: "95%", "4.5", "171 ta". */
function formatPlan(metric, value) {
  if (value === null || value === undefined) return "Belgilanmagan";
  const number = new Decimal(value).toNumber();
  if (metric.kind === METRIC_KINDS.PERCENT) return `${number}%`;
  if (metric.kind === METRIC_KINDS.COUNT) return `${number} ta`;
  return String(number);
}

const setAcademicTargets = defineAction({
  type: "education.set_targets",
  toolName: "propose_set_academic_targets",
  toolset: TOOLSET,
  title: "Ta'lim rejasini belgilash",
  risk: "low",
  permission: "education.plan",
  description:
    "Propose setting or removing monthly academic plan values shown as 'Reja' on the education dashboard. Metrics: students (count), " +
    "averageGrade (0-5, up to 2 decimals), qualityRate (%, 0-100), attendanceRate (%, 0-100), taskCompletion (%, 0-100), achievements " +
    "(count). Only the listed metrics change; others stay as they are. Call academic_targets first to see current plans.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      month: monthSchema("Month YYYYMM the plan applies to. Omit for the current month."),
      items: {
        type: "array",
        minItems: 1,
        maxItems: ACADEMIC_METRICS.length,
        description: "Plan changes, one per metric.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["metric"],
          properties: {
            metric: {
              type: "string",
              enum: ACADEMIC_METRICS.map((metric) => metric.key),
              description: "Metric key.",
            },
            planValue: {
              type: ["number", "string"],
              description: "New plan value (percent as 95, grade as 4.5, counts as integers).",
            },
            remove: {
              type: "boolean",
              description: "true to remove this metric's plan for the month (planValue must be omitted).",
            },
          },
        },
      },
    },
  },
  async prepare(args, ctx) {
    const month = monthArg(args.month);
    const current = await academicTargetService.getTargets({ month });
    const currentByMetric = new Map(current.items.map((row) => [row.metric, row.planValue]));

    const seen = new Set();
    const items = [];
    const fields = [];

    for (const item of args.items) {
      const metric = getMetric(item.metric);
      if (seen.has(metric.key)) throw new AiToolError(`${metric.label}: ko'rsatkich ikki marta berilgan`);
      seen.add(metric.key);

      const hasValue = item.planValue !== undefined;
      if (item.remove === true && hasValue) {
        throw new AiToolError(`${metric.label}: bir vaqtda qiymat berib, rejani olib tashlab bo'lmaydi`);
      }
      if (item.remove !== true && !hasValue) {
        throw new AiToolError(`${metric.label}: yangi reja qiymati ko'rsatilmagan`);
      }

      const before = currentByMetric.get(metric.key) ?? null;
      const after = item.remove === true ? null : parsePlanValue(metric, item.planValue);

      const unchanged =
        (before === null && after === null) ||
        (before !== null && after !== null && new Decimal(before).equals(after));
      if (unchanged) continue;

      items.push({ metric: metric.key, planValue: after === null ? null : after.toFixed(2) });
      fields.push({ label: metric.label, before: formatPlan(metric, before), after: formatPlan(metric, after) });
    }

    if (items.length === 0) {
      throw new AiToolError(`${monthLabel(month)} rejasi allaqachon aynan shunday — o'zgarish yo'q`);
    }

    const removed = items.filter((row) => row.planValue === null).length;
    const warnings = [];
    if (month < ctx.monthKey) {
      warnings.push(`${monthLabel(month)} — o'tgan oy: dashboarddagi bajarilish foizlari shu oy uchun o'zgaradi`);
    }

    return {
      params: { month, items },
      preview: {
        summary: `${monthLabel(month)} uchun ta'lim rejasida ${items.length} ta ko'rsatkich o'zgaradi`,
        target: `Ta'lim rejasi — ${monthLabel(month)}`,
        fields,
        effects: [
          "Ta'lim dashboardidagi \"Reja\" qiymatlari va bajarilish foizlari yangilanadi",
          ...(removed > 0 ? [`${removed} ta ko'rsatkichning rejasi olib tashlanadi`] : []),
          "Ro'yxatda berilmagan ko'rsatkichlar rejasi o'zgarmaydi",
        ],
        warnings,
      },
    };
  },
  async execute(params, ctx) {
    // academicDashboard.controller.saveTargets: upsertTargets(req.body, req.user.id)
    const result = await academicTargetService.upsertTargets(
      { month: params.month, items: params.items },
      ctx.user.id,
    );
    const changed = new Set(params.items.map((row) => row.metric));

    return {
      summary: `${result.monthLabel} uchun ta'lim rejasi saqlandi (${changed.size} ta ko'rsatkich)`,
      details: result.items
        .filter((row) => changed.has(row.metric))
        .map((row) => ({ label: row.label, value: formatPlan(getMetric(row.metric), row.planValue) })),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Haftalik tahlilni yangilash
// ─────────────────────────────────────────────────────────────────────────

const refreshWeeklyInsight = defineAction({
  type: "education.refresh_insight",
  toolName: "propose_refresh_weekly_insight",
  toolset: TOOLSET,
  title: "Haftalik ta'lim tahlilini yangilash",
  risk: "low",
  permission: "education.plan",
  // Model chaqiruvi (45 s, 1 qayta urinish) + dashboard hisobi
  timeoutMs: 120000,
  description:
    "Propose regenerating the current week's education analysis (summary, insights, weekly actions) from the current month's data. " +
    "Uses the AI model when configured, otherwise the rule-based plan. Manual refresh has a 10-minute cooldown; the preview fails " +
    "if the cooldown is active.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async prepare(args, ctx) {
    const insight = await academicInsightService.getWeeklyInsight();
    // ⚠️ Yangilash HAR DOIM joriy oy bilan quriladi (`generateWeeklyInsight` →
    // `getOverview()`). Saqlangan tahlilning `monthLabel` i esa u yozilgan oy:
    // oy almashgan haftada (masalan 31-avgust dushanba) ular farq qiladi.
    const sourceMonthLabel = monthLabel(ctx.monthKey);

    if (!insight.canRefresh) {
      throw new AiToolError(
        `Tahlil yaqinda yangilangan. Qayta yangilash ${formatDateTimeUz(insight.nextRefreshAt)} dan keyin mumkin`,
      );
    }

    const sourceLabel = !insight.isSaved
      ? "Saqlanmagan (qoidalar asosida jonli hisob)"
      : insight.source === "ai"
        ? "AI tahlili"
        : "Qoidalar asosidagi tahlil";

    return {
      params: {},
      preview: {
        summary: `${insight.weekStartLabel} haftasi uchun ta'lim tahlili ${sourceMonthLabel} ma'lumotlari asosida qayta shakllantiriladi`,
        target: `Haftalik ta'lim tahlili — ${insight.weekStartLabel} haftasi`,
        fields: [
          {
            label: "Manba",
            before: sourceLabel,
            after: insight.aiEnabled ? "AI tahlili (model javob bermasa — qoidalar)" : "Qoidalar asosidagi tahlil",
          },
          {
            label: "Oxirgi yangilanish",
            before: insight.generatedAt ? formatDateTimeUz(insight.generatedAt) : "—",
            after: "Tasdiqlangan payt",
          },
        ],
        effects: [
          "Joriy oy ko'rsatkichlari qayta o'qiladi, xulosa va haftalik vazifalar yangilanadi",
          ...(insight.isSaved ? ["Shu haftaning saqlangan tahlili yangisi bilan almashtiriladi"] : []),
        ],
        warnings: [
          "Yangilangandan keyin 10 daqiqa davomida qayta yangilab bo'lmaydi (bajarilmay qolsa ham)",
          ...(insight.aiEnabled ? [] : ["AI kaliti sozlanmagan — tahlil faqat qoidalar asosida yoziladi"]),
        ],
      },
      fingerprint: {
        month: ctx.monthKey,
        weekStart: insight.weekStart,
        isSaved: insight.isSaved,
        generatedAt: insight.generatedAt,
        source: insight.source,
      },
    };
  },
  async execute(params, ctx) {
    // academicDashboard.controller.refreshInsights: generateWeeklyInsight({ actorId: req.user.id })
    const result = await academicInsightService.generateWeeklyInsight({ actorId: ctx.user.id });

    return {
      summary: `${result.weekStartLabel} haftasi uchun ta'lim tahlili yangilandi (${
        result.source === "ai" ? "AI tahlili" : "qoidalar asosida"
      })`,
      details: [
        { label: "Xulosa", value: result.summary },
        { label: "Vazifalar", value: `${result.actions.length} ta` },
      ],
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Olimpiada yutug'ini qayd etish
// ─────────────────────────────────────────────────────────────────────────

const createAchievement = defineAction({
  type: "achievements.create",
  toolName: "propose_create_achievement",
  toolset: TOOLSET,
  title: "Olimpiada yutug'ini qayd etish",
  risk: "low",
  permission: "achievements.create",
  description:
    "Propose recording a student's olympiad or competition achievement: title, level (school, district, city, region, republic, " +
    "international), place (first, second, third, participant), day of the result, optional subject and note. Resolve the student " +
    "with search_people first; the date cannot be in the future.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["studentId", "title", "level", "date"],
    properties: {
      studentId: idSchema("Student user id."),
      title: {
        type: "string",
        minLength: 1,
        maxLength: MAX_ACHIEVEMENT_TITLE,
        description: "Competition name as it should appear, in Uzbek.",
      },
      level: { type: "string", enum: Object.keys(LEVEL_LABELS), description: "Competition level." },
      place: {
        type: "string",
        enum: Object.keys(PLACE_LABELS),
        description: "Place taken. Default participant.",
      },
      date: daySchema("Day of the result, YYYY-MM-DD."),
      subjectId: idSchema("Subject id, if the competition is for one subject."),
      note: { type: "string", maxLength: MAX_NOTE, description: "Optional note." },
    },
  },
  async prepare(args, ctx) {
    const studentId = requireId(args.studentId, "studentId");
    const date = dayArg(args.date, "Sana");
    if (date > ctx.today) throw new AiToolError("Yutuq sanasi kelajakda bo'lishi mumkin emas");

    const [student, subject, duplicate] = await Promise.all([
      prisma.user.findUnique({
        where: { id: studentId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          role: true,
          isArchived: true,
          classes: { select: { class: { select: { name: true } } } },
        },
      }),
      args.subjectId
        ? prisma.subject.findUnique({ where: { id: requireId(args.subjectId, "subjectId") }, select: { id: true, name: true } })
        : null,
      prisma.studentAchievement.findFirst({
        where: { studentId, date: parseDayDate(date), title: { equals: args.title, mode: "insensitive" } },
        select: { id: true },
      }),
    ]);

    if (!student) throw new AiToolError("O'quvchi topilmadi");
    if (student.role !== ROLES.STUDENT) throw new AiToolError("Yutuq faqat o'quvchiga biriktiriladi");
    if (args.subjectId && !subject) throw new AiToolError("Fan topilmadi");

    const place = args.place ?? "participant";
    const note = textOrNull(args.note);
    const className = student.classes[0]?.class.name ?? null;
    const name = personName(student);

    const params = { studentId, title: args.title, level: args.level, place, date };
    if (subject) params.subjectId = subject.id;
    if (note) params.note = note;

    const warnings = [];
    if (duplicate) warnings.push("Bu o'quvchiga shu kunga aynan shu nomli yutuq allaqachon yozilgan — takror bo'lishi mumkin");
    if (student.isArchived) warnings.push("O'quvchi arxivlangan");

    return {
      params,
      preview: {
        summary: `${name} uchun "${args.title}" — ${LEVEL_LABELS[args.level]} bosqichi, ${PLACE_LABELS[place]} qayd etiladi`,
        target: className ? `${name} — ${className}` : name,
        fields: [
          { label: "Yutuq", before: "—", after: args.title },
          { label: "Daraja", before: "—", after: LEVEL_LABELS[args.level] },
          { label: "O'rin", before: "—", after: PLACE_LABELS[place] },
          { label: "Sana", before: "—", after: dayLabel(date) },
          { label: "Fan", before: "—", after: subject ? subject.name : "Ko'rsatilmagan" },
          ...(note ? [{ label: "Izoh", before: "—", after: note }] : []),
        ],
        effects: [
          `Ta'lim dashboardida ${monthLabel(monthKeyOfDate(parseDayDate(date)))} yutuqlari soni 1 taga oshadi`,
        ],
        warnings,
      },
    };
  },
  async execute(params, ctx) {
    // academicDashboard.controller.createAchievement: createAchievement(req.body, req.user.id)
    const row = await achievementService.createAchievement(params, ctx.user.id);
    const name = row.student ? personName(row.student) : "O'quvchi";

    return {
      summary: `${name} uchun "${row.title}" yutug'i qayd etildi (${row.levelLabel}, ${row.placeLabel})`,
      details: [
        { label: "Sana", value: formatDateUz(row.date, { utc: true }) },
        { label: "Fan", value: row.subject?.name ?? "Ko'rsatilmagan" },
      ],
      data: { achievementId: row.id },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Xodimning uzrli so'rovini ko'rib chiqish
// ─────────────────────────────────────────────────────────────────────────

const reviewExcuse = defineAction({
  type: "attendance.review_excuse",
  toolName: "propose_review_excuse",
  toolset: TOOLSET,
  title: "Uzrli so'rovni ko'rib chiqish",
  risk: "medium",
  permission: "attendance.review",
  description:
    "Propose approving or rejecting a staff member's pending excuse (absence justification) request. Approving turns that day's " +
    "'absent' mark into 'excused' (or creates an excused mark if none exists) and cancels the automatic absence penalty. Rejecting " +
    "requires a reason and changes nothing else. Get excuse ids from attendance_pending_excuses.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["excuseId", "decision"],
    properties: {
      excuseId: idSchema("Excuse request id."),
      decision: { type: "string", enum: ["approved", "rejected"], description: "approved or rejected." },
      rejectionReason: {
        type: "string",
        maxLength: MAX_NOTE,
        description: "Reason shown to the staff member. Required when decision is rejected.",
      },
    },
  },
  async prepare(args) {
    const excuseId = requireId(args.excuseId, "excuseId");
    const excuse = await prisma.excuseRequest.findUnique({ where: { id: excuseId } });
    if (!excuse) throw new AiToolError("Uzrli so'rov topilmadi");
    if (excuse.status !== "pending") {
      throw new AiToolError(
        `So'rov allaqachon ko'rib chiqilgan (holati: ${EXCUSE_STATUS_LABELS[excuse.status] ?? excuse.status})`,
      );
    }

    const rejectionReason = textOrNull(args.rejectionReason);
    if (args.decision === "rejected" && !rejectionReason) {
      throw new AiToolError("Rad etish sababi majburiy");
    }

    const [user, reason, record, settings] = await Promise.all([
      prisma.user.findUnique({
        where: { id: excuse.userId },
        select: { id: true, firstName: true, lastName: true, role: true },
      }),
      excuse.absenceReason
        ? prisma.absenceReason.findUnique({ where: { id: excuse.absenceReason }, select: { title: true } })
        : null,
      prisma.attendance.findFirst({
        where: { userId: excuse.userId, date: excuse.date },
        select: { id: true, status: true, penaltyApplied: true, penaltyRef: true, updatedAt: true },
      }),
      getAttendanceSettings(),
    ]);

    const name = user ? personName(user) : "Xodim";
    const dateText = formatDateUz(excuse.date, { utc: true });
    const recordStatus = record ? ATTENDANCE_STATUS_LABELS[record.status] ?? record.status : "Belgilanmagan";

    const fields = [
      { label: "So'rov holati", before: EXCUSE_STATUS_LABELS.pending, after: EXCUSE_STATUS_LABELS[args.decision] },
    ];
    const effects = [];
    const warnings = [];
    let penalty = null;

    if (args.decision === "approved") {
      if (record && record.status === "absent") {
        fields.push({ label: `Davomat (${dateText})`, before: recordStatus, after: ATTENDANCE_STATUS_LABELS.excused });

        if (record.penaltyApplied && record.penaltyRef) {
          penalty = await prisma.penalty.findUnique({
            where: { id: record.penaltyRef },
            select: { id: true, points: true, status: true },
          });
          if (!penalty) {
            // Servis avval so'rovni yopadi, keyin jarimani yangilaydi (tranzaksiyasiz):
            // yo'q jarimada u yarim yo'lda yiqilib, so'rov "tasdiqlangan" bo'lib qolardi.
            throw new AiToolError(
              "Davomatdagi jarima yozuvi topilmadi — tasdiqlash yarim bajarilib qolardi. Avval jarimalar bo'limida tekshiring",
            );
          }
          // ⚠️ Servis jarimaning O'Z ballini emas, JORIY sozlamadagi ballni ayiradi.
          const points = settings.absentPenaltyPoints;
          effects.push("Kelmaganlik uchun yozilgan jarima bekor qilinadi");
          effects.push(`Xodimning jarima ballidan ${points} ball ayiriladi`);
          if (penalty.points !== points) {
            warnings.push(
              `Jarima ${penalty.points} ball bilan yozilgan, lekin joriy sozlama bo'yicha ${points} ball ayiriladi`,
            );
          }
          if (penalty.status === "rejected") {
            warnings.push("Bu jarima allaqachon bekor qilingan — ball IKKINCHI marta ayiriladi");
          }
        } else if (record.penaltyApplied) {
          // Servis faqat `penaltyRef` bo'lsa jarimani qaytaradi: havolasiz yozuvda
          // ball ham, `penaltyApplied` bayrog'i ham o'z holicha qoladi.
          effects.push("Jarima ballari o'zgarmaydi");
          warnings.push(
            "Davomatda jarima qo'llangan deb belgilangan, lekin jarima yozuviga havola yo'q — ball avtomatik qaytarilmaydi, jarimalar bo'limida qo'lda tekshiring",
          );
        } else {
          effects.push("Bu kun uchun jarima yozilmagan — ballar o'zgarmaydi");
        }
      } else if (!record) {
        fields.push({ label: `Davomat (${dateText})`, before: recordStatus, after: ATTENDANCE_STATUS_LABELS.excused });
        effects.push("Bu kun uchun \"Sababli\" davomat yozuvi yaratiladi");
      } else {
        effects.push(`Davomat yozuvi o'zgarmaydi (holati: ${recordStatus})`);
      }
      if (!record || record.status === "absent") {
        effects.push("So'rovdagi sabab toifasi va izoh davomat yozuviga ko'chiriladi");
      }
    } else {
      fields.push({ label: "Rad etish sababi", before: "—", after: rejectionReason });
      effects.push("Davomat va jarimalar o'zgarmaydi");
    }

    return {
      params: { excuseId, status: args.decision, rejectionReason: args.decision === "rejected" ? rejectionReason : null },
      preview: {
        summary: `${name}ning ${dateText} kungi uzrli so'rovi ${args.decision === "approved" ? "tasdiqlanadi" : "rad etiladi"}`,
        target: `${name}, ${dateText}${reason ? ` (${reason.title})` : ""}`,
        fields,
        effects,
        warnings,
      },
      fingerprint: {
        excuseId,
        excuseStatus: excuse.status,
        excuseUpdatedAt: excuse.updatedAt,
        decision: args.decision,
        rejectionReason,
        record,
        penalty,
        absentPenaltyPoints: settings.absentPenaltyPoints,
      },
    };
  },
  async execute(params, ctx) {
    // attendance.controller.reviewExcuse: status ∈ {approved, rejected}, rejected → sabab majburiy,
    // keyin reviewExcuse(req.params.id, status, rejectionReason, req.user.id)
    if (!["approved", "rejected"].includes(params.status)) {
      throw new AiToolError("Status noto'g'ri (approved | rejected)");
    }
    if (params.status === "rejected" && !params.rejectionReason) {
      throw new AiToolError("Rad etish sababi majburiy");
    }

    const excuse = await attendanceService.reviewExcuse(
      params.excuseId,
      params.status,
      params.rejectionReason ?? undefined,
      ctx.user.id,
    );

    return {
      summary: `Uzrli so'rov ${excuse.status === "approved" ? "tasdiqlandi" : "rad etildi"} (${formatDateUz(excuse.date, { utc: true })})`,
      details: params.rejectionReason ? [{ label: "Rad etish sababi", value: params.rejectionReason }] : [],
      data: { excuseId: excuse.id, status: excuse.status },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 5. O'quvchi davomatini tuzatish (bitta kun)
// ─────────────────────────────────────────────────────────────────────────

const correctStudentAttendance = defineAction({
  type: "attendance.correct_student",
  toolName: "propose_correct_student_attendance",
  toolset: TOOLSET,
  title: "O'quvchi davomatini tuzatish",
  risk: "medium",
  permission: "attendance.update",
  description:
    "Propose correcting ONE student's attendance mark for ONE day: present, late, absent or excused, with an optional note. Updates the " +
    "existing mark or creates it when the day is unmarked. The day must not be in the future, a Sunday or a holiday. For an unmarked " +
    "day of a student in several classes, classId is required. Check attendance_student_month first.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["studentId", "date", "status"],
    properties: {
      studentId: idSchema("Student user id."),
      date: daySchema("Day YYYY-MM-DD to correct."),
      status: { type: "string", enum: ATTENDANCE_STATUSES, description: "New attendance status." },
      note: { type: "string", maxLength: MAX_NOTE, description: "Optional note (for example the reason of absence)." },
      classId: idSchema("Class the mark belongs to; needed only when the day is unmarked and the student is in several classes."),
    },
  },
  async prepare(args, ctx) {
    const studentId = requireId(args.studentId, "studentId");
    const date = dayArg(args.date, "Sana");
    const day = parseDayDate(date);

    if (date > ctx.today) throw new AiToolError("Kelajakdagi kun uchun davomat belgilab bo'lmaydi");
    if (day.getUTCDay() === 0) throw new AiToolError("Yakshanba — dars kuni emas, davomat belgilanmaydi");

    const [student, holidays, record] = await Promise.all([
      prisma.user.findUnique({
        where: { id: studentId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          role: true,
          isActive: true,
          isArchived: true,
          classes: { select: { class: { select: { id: true, name: true } } } },
        },
      }),
      buildHolidaySet(day, day),
      prisma.studentAttendance.findUnique({
        where: { studentId_date: { studentId, date: day } },
        select: {
          id: true,
          classId: true,
          status: true,
          excuseReason: true,
          absenceReason: true,
          autoMarked: true,
          updatedAt: true,
        },
      }),
    ]);

    if (!student || student.role !== ROLES.STUDENT) throw new AiToolError("O'quvchi topilmadi");
    if (holidays.has(date)) throw new AiToolError(`${dayLabel(date)} — dam olish kuni, davomat belgilanmaydi`);

    const name = personName(student);
    const dateText = dayLabel(date);
    const note = textOrNull(args.note);
    const memberships = student.classes.map((row) => row.class);
    const warnings = [];
    const effects = [];

    if (!student.isActive || student.isArchived) {
      warnings.push("O'quvchi faol emas yoki arxivlangan — kunlik ro'yxat va hisobotlarda ko'rinmaydi");
    }

    let classId;
    let className;

    if (record) {
      const recordNote = record.excuseReason ?? null;
      if (record.status === args.status && recordNote === note && !record.absenceReason) {
        throw new AiToolError(
          `${name}ning ${dateText} kungi davomati allaqachon "${ATTENDANCE_STATUS_LABELS[args.status]}" — o'zgarish yo'q`,
        );
      }
      classId = record.classId;
      const recordClass = await prisma.class.findUnique({ where: { id: record.classId }, select: { name: true } });
      className = recordClass?.name ?? "—";

      if (args.classId && args.classId !== record.classId) {
        warnings.push(`Mavjud yozuvning sinfi (${className}) o'zgarmaydi — faqat holat va izoh tuzatiladi`);
      }
      if (record.absenceReason) {
        const reason = await prisma.absenceReason.findUnique({ where: { id: record.absenceReason }, select: { title: true } });
        warnings.push(`Sabab toifasi (${reason?.title ?? "—"}) tozalanadi`);
      }
      if (recordNote && !note) warnings.push(`Mavjud izoh ("${recordNote}") o'chiriladi`);
      if (record.autoMarked) effects.push("Tungi avtomatik belgi qo'lda tuzatilgan belgiga aylanadi");
    } else {
      if (args.classId) {
        const match = memberships.find((row) => row.id === args.classId);
        if (!match) throw new AiToolError(`${name} tanlangan sinfda o'qimaydi`);
        classId = match.id;
        className = match.name;
      } else if (memberships.length === 1) {
        classId = memberships[0].id;
        className = memberships[0].name;
      } else if (memberships.length === 0) {
        throw new AiToolError(`${name} hech qaysi sinfga biriktirilmagan — davomat sinf bo'yicha yoziladi`);
      } else {
        throw new AiToolError(
          `${name} bir nechta sinfda: ${memberships.map((row) => `${row.name} (${row.id})`).join(", ")}. Qaysi sinf uchun belgilashni aniqlang`,
        );
      }
      effects.push("Bu kun uchun yangi davomat yozuvi yaratiladi");
    }

    effects.push("Oylik davomat hisobotlari va ta'lim dashboardi shu kun uchun yangi holatni hisoblaydi");

    return {
      params: {
        mode: record ? "update" : "create",
        recordId: record ? record.id : null,
        studentId,
        classId,
        date,
        status: args.status,
        note,
      },
      preview: {
        summary: `${name}ning ${dateText} kungi davomati "${ATTENDANCE_STATUS_LABELS[args.status]}" deb belgilanadi`,
        target: `${name} — ${className}, ${dateText}`,
        fields: [
          {
            label: "Holat",
            before: record ? ATTENDANCE_STATUS_LABELS[record.status] : "Belgilanmagan",
            after: ATTENDANCE_STATUS_LABELS[args.status],
          },
          { label: "Izoh", before: record?.excuseReason || "—", after: note || "—" },
        ],
        effects,
        warnings,
      },
      fingerprint: {
        studentId,
        date,
        status: args.status,
        note,
        classId,
        record,
        studentActive: student.isActive && !student.isArchived,
      },
    };
  },
  async execute(params, ctx) {
    if (params.mode === "update") {
      // studentAttendance.controller.updateRecord: updateRecord(req.params.id, { status, excuseReason }, req.user.id)
      await studentAttendanceService.updateRecord(
        params.recordId,
        { status: params.status, excuseReason: params.note },
        ctx.user.id,
      );
    } else {
      // studentAttendance.controller.mark: markAttendance({ classId, date, records }, req.user.id)
      await studentAttendanceService.markAttendance(
        {
          classId: params.classId,
          date: params.date,
          records: [{ studentId: params.studentId, status: params.status, excuseReason: params.note }],
        },
        ctx.user.id,
      );
    }

    return {
      summary: `${dayLabel(params.date)} kungi davomat "${ATTENDANCE_STATUS_LABELS[params.status]}" deb ${
        params.mode === "update" ? "tuzatildi" : "belgilandi"
      }`,
      details: params.note ? [{ label: "Izoh", value: params.note }] : [],
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 6–7. To'garak a'zoligi
// ─────────────────────────────────────────────────────────────────────────

async function loadClub(clubId) {
  const club = await prisma.club.findUnique({
    where: { id: requireId(clubId, "clubId") },
    select: { id: true, name: true, isActive: true },
  });
  if (!club) throw new AiToolError("To'garak topilmadi");
  return club;
}

const addClubMembers = defineAction({
  type: "clubs.add_members",
  toolName: "propose_add_club_members",
  toolset: TOOLSET,
  title: "To'garakka o'quvchi qo'shish",
  risk: "low",
  permission: "clubs.members",
  description:
    "Propose adding students to an active club from a start day (default today). Students already members on that day are skipped. " +
    "All ids must be students. Resolve the club with clubs_list and students with search_people first.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["clubId", "studentIds"],
    properties: {
      clubId: idSchema("Club id."),
      studentIds: {
        type: "array",
        minItems: 1,
        maxItems: MAX_CLUB_MEMBERS_PER_PROPOSAL,
        items: idSchema("Student user id."),
        description: "Students to add.",
      },
      startDate: daySchema("Membership start day YYYY-MM-DD. Default: today."),
    },
  },
  async prepare(args, ctx) {
    const club = await loadClub(args.clubId);
    if (!club.isActive) throw new AiToolError(`"${club.name}" to'garagi nofaol — unga a'zo qo'shib bo'lmaydi`);

    const startDate = dayArg(args.startDate ?? ctx.today, "Boshlanish sanasi");
    const start = parseDayDate(startDate);
    const ids = [...new Set(args.studentIds.map((id) => requireId(id, "studentId")))].sort();

    const [students, existing, activeToday] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, firstName: true, lastName: true, role: true, isArchived: true },
      }),
      prisma.clubMember.findMany({
        where: { clubId: club.id, studentId: { in: ids }, ...clubService.activeMemberWhere(start) },
        select: { studentId: true },
      }),
      prisma.clubMember.count({ where: { clubId: club.id, ...clubService.activeMemberWhere(currentDayDate()) } }),
    ]);

    const byId = new Map(students.map((row) => [row.id, row]));
    const invalid = ids.filter((id) => byId.get(id)?.role !== ROLES.STUDENT);
    if (invalid.length > 0) {
      throw new AiToolError(`Quyidagi id'lar o'quvchi emas yoki topilmadi: ${invalid.join(", ")}`);
    }

    const alreadyIn = new Set(existing.map((row) => row.studentId));
    const fresh = ids.filter((id) => !alreadyIn.has(id));
    if (fresh.length === 0) {
      throw new AiToolError(`Tanlangan o'quvchilarning barchasi ${dayLabel(startDate)} holatiga "${club.name}" a'zosi`);
    }

    const nameOf = (id) => personName(byId.get(id));
    const archived = fresh.filter((id) => byId.get(id).isArchived);
    const warnings = [];
    if (alreadyIn.size > 0) {
      warnings.push(`${alreadyIn.size} ta o'quvchi allaqachon a'zo va o'tkazib yuboriladi: ${nameList([...alreadyIn].map(nameOf))}`);
    }
    if (archived.length > 0) warnings.push(`Arxivlangan o'quvchilar: ${nameList(archived.map(nameOf))}`);
    if (startDate > ctx.today) warnings.push(`A'zolik kelajakdagi sanadan (${dayLabel(startDate)}) boshlanadi`);

    const startsNow = startDate <= ctx.today;

    return {
      params: { clubId: club.id, studentIds: ids, startDate },
      preview: {
        summary: `"${club.name}" to'garagiga ${fresh.length} ta o'quvchi ${dayLabel(startDate)} dan qo'shiladi`,
        target: `To'garak — ${club.name}`,
        fields: [
          {
            label: "Hozirgi faol a'zolar",
            before: `${activeToday} ta`,
            after: startsNow ? `${activeToday + fresh.length} ta` : `${activeToday} ta (${dayLabel(startDate)} dan ${activeToday + fresh.length} ta)`,
          },
        ],
        effects: [`Qo'shiladi: ${nameList(fresh.map(nameOf))}`, "Ta'lim dashboardidagi to'garak qamrovi yangilanadi"],
        warnings,
      },
    };
  },
  async execute(params, ctx) {
    // academicDashboard.controller.addClubMembers: addMembers(req.params.id, req.body, req.user.id)
    const result = await clubService.addMembers(
      params.clubId,
      { studentIds: params.studentIds, startDate: params.startDate },
      ctx.user.id,
    );

    return {
      summary:
        result.skipped > 0
          ? `${result.added} ta o'quvchi qo'shildi, ${result.skipped} tasi allaqachon a'zo edi`
          : `${result.added} ta o'quvchi qo'shildi`,
      data: result,
    };
  },
});

const closeClubMember = defineAction({
  type: "clubs.close_member",
  toolName: "propose_close_club_member",
  toolset: TOOLSET,
  title: "To'garak a'zoligini yopish",
  risk: "low",
  permission: "clubs.members",
  description:
    "Propose ending a student's club membership on an end day (inclusive last day, default today). The membership row is kept for " +
    "history. Pass memberId from clubs_list, or studentId when the student has exactly one open membership in that club.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["clubId"],
    properties: {
      clubId: idSchema("Club id."),
      memberId: idSchema("Membership id (from clubs_list with clubId)."),
      studentId: idSchema("Student id; used when memberId is not given."),
      endDate: daySchema("Last day of membership YYYY-MM-DD (inclusive). Default: today."),
    },
  },
  async prepare(args, ctx) {
    const club = await loadClub(args.clubId);
    if (!args.memberId && !args.studentId) throw new AiToolError("memberId yoki studentId ko'rsatilishi kerak");

    let member;
    if (args.memberId) {
      member = await prisma.clubMember.findUnique({
        where: { id: requireId(args.memberId, "memberId") },
        select: { id: true, clubId: true, studentId: true, startDate: true, endDate: true },
      });
      if (!member || member.clubId !== club.id) throw new AiToolError("A'zolik topilmadi");
      if (args.studentId && member.studentId !== args.studentId) {
        throw new AiToolError("memberId va studentId bir-biriga mos emas");
      }
      if (member.endDate) {
        throw new AiToolError(`A'zolik allaqachon yopilgan (${formatDateUz(member.endDate, { utc: true })})`);
      }
    } else {
      const open = await prisma.clubMember.findMany({
        where: { clubId: club.id, studentId: requireId(args.studentId, "studentId"), endDate: null },
        select: { id: true, clubId: true, studentId: true, startDate: true, endDate: true },
        orderBy: { startDate: "asc" },
      });
      if (open.length === 0) throw new AiToolError(`O'quvchining "${club.name}" to'garagida ochiq a'zoligi yo'q`);
      if (open.length > 1) {
        throw new AiToolError(
          `O'quvchining bu to'garakda ${open.length} ta ochiq a'zoligi bor (${open.map((row) => row.id).join(", ")}) — memberId ko'rsating`,
        );
      }
      [member] = open;
    }

    const endDate = dayArg(args.endDate ?? ctx.today, "Tugash sanasi");
    if (parseDayDate(endDate) < member.startDate) {
      throw new AiToolError(
        `Tugash sanasi a'zolik boshlanishidan (${formatDateUz(member.startDate, { utc: true })}) oldin bo'lishi mumkin emas`,
      );
    }

    const student = await prisma.user.findUnique({
      where: { id: member.studentId },
      select: { firstName: true, lastName: true },
    });
    const name = student ? personName(student) : "O'quvchi";

    return {
      params: { clubId: club.id, memberId: member.id, endDate },
      preview: {
        summary: `${name}ning "${club.name}" to'garagidagi a'zoligi ${dayLabel(endDate)} bilan yopiladi`,
        target: `${name} — ${club.name}`,
        fields: [
          {
            label: "A'zolik davri",
            before: `${formatDateUz(member.startDate, { utc: true })} dan (ochiq)`,
            after: `${formatDateUz(member.startDate, { utc: true })} — ${dayLabel(endDate)}`,
          },
        ],
        effects: [
          `${dayLabel(endDate)} dan keyin o'quvchi to'garak a'zolari va qamrov hisobotida sanalmaydi`,
          "A'zolik qatori o'chirilmaydi — o'tgan oylar hisoboti o'zgarmaydi",
        ],
        warnings: endDate > ctx.today ? [`Tugash sanasi kelajakda (${dayLabel(endDate)})`] : [],
      },
    };
  },
  async execute(params) {
    // academicDashboard.controller.closeClubMember: closeMember(req.params.id, req.params.memberId, req.body)
    const row = await clubService.closeMember(params.clubId, params.memberId, { endDate: params.endDate });
    const name = row.student ? personName(row.student) : "O'quvchi";

    return {
      summary: `${name}ning to'garak a'zoligi ${formatDateUz(row.endDate, { utc: true })} bilan yopildi`,
      data: { memberId: row.id },
    };
  },
});

module.exports = [
  setAcademicTargets,
  refreshWeeklyInsight,
  createAchievement,
  reviewExcuse,
  correctStudentAttendance,
  addClubMembers,
  closeClubMember,
];
