/**
 * Faza 2 — MongoDB → PostgreSQL (Prisma) data migration.
 *
 * MongoDB native driver bilan raw hujjatlarni o'qiydi, transform qiladi va
 * PrismaClient orqali PostgreSQL'ga yozadi.
 *
 *  - ID: eski ObjectId hex saqlanadi. Child jadvallar deterministik id oladi
 *    (helpers.childId) — to'liq IDEMPOTENT (skipDuplicates + deterministik id).
 *  - Embedded arraylar child jadvalga split qilinadi (position bilan).
 *  - Map/nested obyektlar JSONB'ga (deepObjectIdToString bilan).
 *  - Bog'liqlik tartibida (parent avval).
 *
 * Ishga tushirish:  node src/scripts/migrate-mongo-to-postgres/index.js
 * Qayta ishga tushirsa buzilmaydi (idempotent).
 */

require("dotenv").config();
const { MongoClient } = require("mongodb");
const { PrismaClient } = require("../../generated/prisma");
const {
  oid,
  deepObjectIdToString,
  childId,
  chunk,
  toDate,
  timestamps,
} = require("./helpers");

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error("MONGODB_URI kiritilmagan");
  process.exit(1);
}

const prisma = new PrismaClient();
const BATCH = 1000;

// Umumiy hisobot
const report = [];

/**
 * Bitta kolleksiyani ko'chirish.
 * @param {import('mongodb').Db} db
 * @param {string} collName - MongoDB kolleksiya nomi
 * @param {string} prismaModel - Prisma model nomi (prisma[model])
 * @param {(doc)=>object} transform - asosiy jadval yozuvi
 * @param {(doc, parentId)=>{model:string, rows:object[]}[]} childrenFn - child jadval yozuvlari (ixtiyoriy)
 */
async function migrateCollection(db, collName, prismaModel, transform, childrenFn) {
  const coll = db.collection(collName);
  const total = await coll.countDocuments();
  if (total === 0) {
    report.push({ model: prismaModel, mongo: 0, pg: 0 });
    console.log(`  ${prismaModel.padEnd(28)} bo'sh (0)`);
    return;
  }

  const cursor = coll.find({});
  let mainRows = [];
  const childBuckets = {}; // model → rows[]
  let processed = 0;

  const flushMain = async () => {
    if (mainRows.length === 0) return;
    await prisma[prismaModel].createMany({ data: mainRows, skipDuplicates: true });
    mainRows = [];
  };
  const flushChildren = async () => {
    for (const [model, rows] of Object.entries(childBuckets)) {
      if (rows.length === 0) continue;
      for (const part of chunk(rows, BATCH)) {
        await prisma[model].createMany({ data: part, skipDuplicates: true });
      }
      childBuckets[model] = [];
    }
  };

  for await (const doc of cursor) {
    try {
      const row = transform(doc);
      if (row) mainRows.push(row);
      if (childrenFn) {
        const groups = childrenFn(doc) || [];
        for (const g of groups) {
          if (!childBuckets[g.model]) childBuckets[g.model] = [];
          childBuckets[g.model].push(...g.rows);
        }
      }
    } catch (e) {
      console.error(`  ⚠️ ${collName} hujjat ${oid(doc._id)}: ${e.message}`);
    }
    processed++;
    if (mainRows.length >= BATCH) await flushMain();
  }
  await flushMain();
  await flushChildren();

  const pgCount = await prisma[prismaModel].count();
  report.push({ model: prismaModel, mongo: total, pg: pgCount });
  console.log(`  ${prismaModel.padEnd(28)} ${total} → ${pgCount}`);
}

// ─────────────────────────────────────────────
// TRANSFORM FUNKSIYALARI
// ─────────────────────────────────────────────

const t = {
  role: (d) => ({
    id: oid(d._id),
    name: d.name,
    value: d.value,
    isSystem: !!d.isSystem,
    workStartTime: d.workStartTime ?? null,
    workEndTime: d.workEndTime ?? null,
    workDays: Array.isArray(d.workDays) ? d.workDays : [1, 2, 3, 4, 5],
    weeklySchedule: deepObjectIdToString(d.weeklySchedule || {}),
    createdBy: oid(d.createdBy),
    ...timestamps(d),
  }),

  class: (d) => ({
    id: oid(d._id),
    name: d.name,
    isActive: d.isActive ?? true,
    createdBy: oid(d.createdBy),
    ...timestamps(d),
  }),

  subject: (d) => ({
    id: oid(d._id),
    name: d.name,
    description: d.description ?? null,
    isActive: d.isActive ?? true,
    createdBy: oid(d.createdBy),
    ...timestamps(d),
  }),

  image: (d) => ({
    id: oid(d._id),
    originalName: d.originalName,
    mimeType: d.mimeType,
    extension: d.extension,
    originalSizeBytes: d.originalSizeBytes,
    variants: deepObjectIdToString(d.variants || {}),
    uploadedBy: oid(d.uploadedBy),
    ...timestamps(d),
  }),

  holiday: (d) => ({
    id: oid(d._id),
    name: d.name,
    description: d.description ?? null,
    type: d.type,
    date: toDate(d.date),
    startDate: toDate(d.startDate),
    endDate: toDate(d.endDate),
    recurringDate: d.recurringDate ? deepObjectIdToString(d.recurringDate) : null,
    recurringStartDate: d.recurringStartDate ? deepObjectIdToString(d.recurringStartDate) : null,
    recurringEndDate: d.recurringEndDate ? deepObjectIdToString(d.recurringEndDate) : null,
    isActive: d.isActive ?? true,
    createdBy: oid(d.createdBy),
    ...timestamps(d),
  }),

  socialNetwork: (d) => ({
    id: oid(d._id),
    platform: d.platform || "telegram",
    name: d.name,
    chatId: d.chatId,
    username: d.username ?? null,
    isActive: d.isActive ?? true,
    createdBy: oid(d.createdBy),
    ...timestamps(d),
  }),

  leadCategory: (d) => ({
    id: oid(d._id), name: d.name, description: d.description ?? null,
    isActive: d.isActive ?? true, ...timestamps(d),
  }),
  leadDirection: (d) => ({
    id: oid(d._id), name: d.name, description: d.description ?? null,
    isActive: d.isActive ?? true, ...timestamps(d),
  }),
  leadSource: (d) => ({
    id: oid(d._id), name: d.name, description: d.description ?? null,
    isActive: d.isActive ?? true, ...timestamps(d),
  }),

  emojiConfig: (d) => ({
    id: oid(d._id), name: d.name, animationUrl: d.animationUrl,
    fileKey: d.fileKey, ...timestamps(d),
  }),

  monitor: (d) => ({
    id: oid(d._id), code: d.code, name: d.name ?? null,
    isActive: d.isActive ?? true, ...timestamps(d),
  }),

  // ── Singletonlar (id "singleton")
  coinSettings: (d) => ({
    id: "singleton",
    dailyCoinPercentage: d.dailyCoinPercentage ?? 60,
    schoolRankBonus: d.schoolRankBonus ?? 100,
    classRankBonus: d.classRankBonus ?? 20,
    minDailyGradeForCoin: d.minDailyGradeForCoin ?? 10,
    updatedBy: oid(d.updatedBy),
    ...timestamps(d),
  }),
  scheduleSettings: (d) => ({
    id: "singleton",
    periods: deepObjectIdToString(d.periods || []),
    updatedBy: oid(d.updatedBy),
    ...timestamps(d),
  }),
  attendanceSettings: (d) => ({
    id: "singleton",
    officeLocation: d.officeLocation ? deepObjectIdToString(d.officeLocation) : null,
    officeRadius: d.officeRadius ?? 100,
    lateArrivalPenaltyPoints: d.lateArrivalPenaltyPoints ?? 1,
    lateArrivalGraceMinutes: d.lateArrivalGraceMinutes ?? 10,
    earlyDeparturePenaltyPoints: d.earlyDeparturePenaltyPoints ?? 1,
    earlyDepartureGraceMinutes: d.earlyDepartureGraceMinutes ?? 10,
    absentPenaltyPoints: d.absentPenaltyPoints ?? 2,
    penaltyPaused: !!d.penaltyPaused,
    pausedRoles: d.pausedRoles || [],
    pausedUsers: (d.pausedUsers || []).map(oid),
    updatedBy: oid(d.updatedBy),
    ...timestamps(d),
  }),
  gradePenaltySettings: (d) => ({
    id: "singleton",
    isEnabled: d.isEnabled ?? true,
    penaltyPoints: d.penaltyPoints ?? 1,
    missingThresholdPercent: d.missingThresholdPercent ?? 40,
    exemptTeachers: (d.exemptTeachers || []).map(oid),
    updatedBy: oid(d.updatedBy),
    ...timestamps(d),
  }),
  penaltySettings: (d) => ({
    id: "singleton",
    fineAmounts: deepObjectIdToString(d.fineAmounts || {}),
    studentFineAmount: d.studentFineAmount ?? 2100000,
    teacherFineAmount: d.teacherFineAmount ?? 2100000,
    premiumReductionDiscountPercent: d.premiumReductionDiscountPercent ?? 0,
    updatedBy: oid(d.updatedBy),
    ...timestamps(d),
  }),
  testSettings: (d) => ({
    id: "singleton",
    minScore: d.minScore ?? 56,
    maxScore: d.maxScore ?? 189,
    updatedBy: oid(d.updatedBy),
    ...timestamps(d),
  }),
  premiumSettings: (d) => ({
    id: "singleton",
    isEnabled: d.isEnabled ?? true,
    coinCost: d.coinCost ?? 100,
    durationDays: d.durationDays ?? 30,
    allowedNameColors: deepObjectIdToString(d.allowedNameColors || []),
    updatedBy: oid(d.updatedBy),
    ...timestamps(d),
  }),

  // ── User (+ classes junction)
  user: (d) => ({
    id: oid(d._id),
    username: d.username,
    password: d.password,
    plainPassword: d.plainPassword ?? null,
    firstName: d.firstName,
    lastName: d.lastName ?? null,
    telegramIds: d.telegramIds || [],
    role: d.role,
    isActive: d.isActive ?? true,
    gender: d.gender === "male" || d.gender === "female" ? d.gender : null,
    coinBalance: d.coinBalance ?? 0,
    penaltyPoints: d.penaltyPoints ?? 0,
    isArchived: !!d.isArchived,
    archivedAt: toDate(d.archivedAt),
    archiveSnapshot: d.archiveSnapshot ? deepObjectIdToString(d.archiveSnapshot) : null,
    workStartTime: d.workStartTime ?? null,
    workEndTime: d.workEndTime ?? null,
    workDays: Array.isArray(d.workDays) ? d.workDays : [],
    weeklySchedule: deepObjectIdToString(d.weeklySchedule || {}),
    premiumIsActive: d.premium?.isActive ?? false,
    premiumExpiresAt: toDate(d.premium?.expiresAt),
    profilePicture: oid(d.profilePicture),
    // emojiBadgeId ba'zan Number (eski data), ba'zan String — string'ga normallashtiramiz
    emojiBadgeId: d.emojiBadgeId == null ? null : String(d.emojiBadgeId),
    displayName: d.displayName ?? null,
    nameColor: d.nameColor ?? null,
    ...timestamps(d),
  }),

  topic: (d) => ({
    id: oid(d._id),
    subjectId: oid(d.subject),
    order: d.order,
    name: d.name,
    description: d.description ?? null,
    createdBy: oid(d.createdBy),
    ...timestamps(d),
  }),

  teacherAssignment: (d) => ({
    id: oid(d._id),
    seasonId: oid(d.season),
    classId: oid(d.class),
    subjectId: oid(d.subject),
    teacherId: oid(d.teacher),
    isActive: d.isActive ?? true,
    createdBy: oid(d.createdBy),
    ...timestamps(d),
  }),

  classSubjectProgress: (d) => ({
    id: oid(d._id),
    classId: oid(d.class),
    subjectId: oid(d.subject),
    currentTopicNumber: d.currentTopicNumber ?? 1,
    ...timestamps(d),
  }),

  schedule: (d) => ({
    id: oid(d._id),
    classId: oid(d.class),
    day: d.day,
    createdBy: oid(d.createdBy),
    ...timestamps(d),
  }),

  attendance: (d) => ({
    id: oid(d._id),
    userId: oid(d.user),
    date: toDate(d.date),
    checkIn: toDate(d.checkIn),
    checkOut: toDate(d.checkOut),
    status: d.status || "present",
    isLate: !!d.isLate,
    lateMinutes: d.lateMinutes ?? 0,
    isEarlyOut: !!d.isEarlyOut,
    earlyOutMinutes: d.earlyOutMinutes ?? 0,
    checkInLocation: d.checkInLocation ? deepObjectIdToString(d.checkInLocation) : null,
    checkOutLocation: d.checkOutLocation ? deepObjectIdToString(d.checkOutLocation) : null,
    locationWarning: !!d.locationWarning,
    outOfOffice: !!d.outOfOffice,
    penaltyApplied: !!d.penaltyApplied,
    penaltyRef: oid(d.penaltyRef),
    excuseReason: d.excuseReason ?? null,
    absenceReason: oid(d.absenceReason),
    autoMarked: !!d.autoMarked,
    createdBy: oid(d.createdBy),
    lastModifiedBy: oid(d.lastModifiedBy),
    ...timestamps(d),
  }),

  absenceReason: (d) => ({
    id: oid(d._id),
    title: d.title,
    description: d.description ?? "",
    roles: d.roles || [],
    appliesToAll: !!d.appliesToAll,
    isActive: d.isActive ?? true,
    createdBy: oid(d.createdBy),
    ...timestamps(d),
  }),

  studentAttendance: (d) => ({
    id: oid(d._id),
    studentId: oid(d.student),
    classId: oid(d.class),
    date: toDate(d.date),
    status: d.status || "absent",
    markedAt: toDate(d.markedAt),
    excuseReason: d.excuseReason ?? null,
    absenceReason: oid(d.absenceReason),
    autoMarked: !!d.autoMarked,
    createdBy: oid(d.createdBy),
    lastModifiedBy: oid(d.lastModifiedBy),
    ...timestamps(d),
  }),

  excuseRequest: (d) => ({
    id: oid(d._id),
    userId: oid(d.user),
    date: toDate(d.date),
    absenceReason: oid(d.absenceReason),
    reason: d.reason ?? null,
    type: d.type,
    status: d.status || "pending",
    reviewedBy: oid(d.reviewedBy),
    reviewedAt: toDate(d.reviewedAt),
    rejectionReason: d.rejectionReason ?? null,
    attachments: deepObjectIdToString(d.attachments || []),
    ...timestamps(d),
  }),

  grade: (d) => ({
    id: oid(d._id),
    studentId: oid(d.student),
    subjectId: oid(d.subject),
    classId: oid(d.class),
    teacherId: oid(d.teacher),
    grade: d.grade,
    comment: d.comment ?? null,
    date: toDate(d.date),
    lessonOrder: d.lessonOrder ?? 1,
    isEdited: !!d.isEdited,
    editHistory: deepObjectIdToString(d.editHistory || []),
    ...timestamps(d),
  }),

  task: (d) => ({
    id: oid(d._id),
    title: d.title,
    description: d.description,
    assignee: oid(d.assignee),
    createdBy: oid(d.createdBy),
    status: d.status || "pending",
    dueDate: toDate(d.dueDate),
    penaltyPoints: d.penaltyPoints ?? 1,
    attachments: deepObjectIdToString(d.attachments || []),
    completionNote: d.completionNote ?? null,
    completionAttachments: deepObjectIdToString(d.completionAttachments || []),
    penaltyRef: oid(d.penaltyRef),
    autopenalized: !!d.autopenalized,
    ...timestamps(d),
  }),

  penalty: (d) => ({
    id: oid(d._id),
    userId: oid(d.user),
    givenBy: oid(d.givenBy),
    category: oid(d.category),
    type: d.type || "penalty",
    title: d.title ?? null,
    description: d.description ?? null,
    points: d.points,
    status: d.status || "pending",
    reviewedBy: oid(d.reviewedBy),
    reviewedAt: toDate(d.reviewedAt),
    rejectionReason: d.rejectionReason ?? null,
    attachments: deepObjectIdToString(d.attachments || []),
    isCustom: !!d.isCustom,
    fineAmount: d.fineAmount ?? 0,
    ...timestamps(d),
  }),

  penaltyCategory: (d) => ({
    id: oid(d._id),
    title: d.title,
    description: d.description ?? null,
    points: d.points,
    targetRole: d.targetRole,
    isActive: d.isActive ?? true,
    createdBy: oid(d.createdBy),
    ...timestamps(d),
  }),

  penaltyNotificationQueue: (d) => ({
    id: oid(d._id),
    penaltyId: oid(d.penaltyId),
    telegramId: d.telegramId,
    userId: oid(d.userId),
    messageText: d.messageText,
    attachments: deepObjectIdToString(d.attachments || []),
    status: d.status || "pending",
    priority: d.priority ?? 0,
    attempts: d.attempts ?? 0,
    maxAttempts: d.maxAttempts ?? 3,
    errorMessage: d.errorMessage ?? null,
    processedAt: toDate(d.processedAt),
    ...timestamps(d),
  }),

  fineReductionPackage: (d) => ({
    id: oid(d._id),
    title: d.title,
    points: d.points,
    coinCost: d.coinCost,
    order: d.order ?? 0,
    isActive: d.isActive ?? true,
    createdBy: oid(d.createdBy),
    ...timestamps(d),
  }),

  coinTransaction: (d) => ({
    id: oid(d._id),
    studentId: oid(d.student),
    amount: d.amount,
    type: d.type,
    description: d.description,
    balanceAfter: d.balanceAfter,
    meta: d.meta ? deepObjectIdToString(d.meta) : null,
    date: toDate(d.date),
    ...timestamps(d),
  }),

  dailyCoinStat: (d) => ({
    id: oid(d._id),
    date: toDate(d.date),
    totalDistributed: d.totalDistributed ?? 0,
    ...timestamps(d),
  }),

  marketProduct: (d) => ({
    id: oid(d._id),
    name: d.name,
    description: d.description ?? "",
    price: d.price,
    quantity: d.quantity,
    isActive: d.isActive ?? true,
    isArchived: !!d.isArchived,
    createdBy: oid(d.createdBy),
    archivedAt: toDate(d.archivedAt),
    ...timestamps(d),
  }),

  marketOrder: (d) => ({
    id: oid(d._id),
    studentId: oid(d.student),
    productId: oid(d.product),
    quantity: d.quantity,
    unitPrice: d.unitPrice,
    totalPrice: d.totalPrice,
    productSnapshot: deepObjectIdToString(d.productSnapshot || {}),
    status: d.status || "pending",
    deliveryImage: oid(d.deliveryImage),
    rejectReason: d.rejectReason ?? "",
    ...timestamps(d),
  }),

  lead: (d) => ({
    id: oid(d._id),
    firstName: d.firstName,
    lastName: d.lastName,
    phone: d.phone,
    additionalPhone: d.additionalPhone ?? null,
    source: oid(d.source),
    direction: oid(d.direction),
    category: oid(d.category),
    status: d.status || "new",
    classInterest: d.classInterest ?? null,
    parentName: d.parentName ?? null,
    parentPhone: d.parentPhone ?? null,
    address: d.address ?? null,
    notes: d.notes ?? null,
    expectedEnrollDate: toDate(d.expectedEnrollDate),
    lostReason: d.lostReason ?? null,
    createdBy: oid(d.createdBy),
    ...timestamps(d),
  }),

  leadActivity: (d) => ({
    id: oid(d._id),
    leadId: oid(d.lead),
    type: d.type,
    description: d.description,
    previousStatus: d.previousStatus ?? null,
    newStatus: d.newStatus ?? null,
    createdBy: oid(d.createdBy),
    ...timestamps(d),
  }),

  test: (d) => ({
    id: oid(d._id),
    teacherId: oid(d.teacher),
    title: d.title,
    questionCount: d.questionCount ?? 30,
    timeLimitMinutes: d.timeLimitMinutes ?? 30,
    isActive: d.isActive ?? true,
    ...timestamps(d),
  }),

  question: (d) => ({
    id: oid(d._id),
    testId: oid(d.test),
    type: d.type,
    text: d.text ?? null,
    image: d.image ? deepObjectIdToString(d.image) : null,
    difficulty: d.difficulty || "medium",
    points: d.points ?? 0,
    order: d.order ?? 0,
    isActive: d.isActive ?? true,
    ...timestamps(d),
  }),

  testBinding: (d) => ({
    id: oid(d._id),
    testId: oid(d.test),
    teacherId: oid(d.teacher),
    seasonId: oid(d.season),
    subjectId: oid(d.subject),
    status: d.status || "draft",
    isActive: d.isActive ?? true,
    ...timestamps(d),
  }),

  testSession: (d) => ({
    id: oid(d._id),
    bindingId: oid(d.binding),
    testId: oid(d.test),
    studentId: oid(d.student),
    seasonId: oid(d.season),
    attemptNumber: d.attemptNumber ?? 1,
    status: d.status || "in_progress",
    startedAt: toDate(d.startedAt) || timestamps(d).createdAt,
    expiresAt: toDate(d.expiresAt),
    submittedAt: toDate(d.submittedAt),
    gradingMin: d.gradingMin ?? null,
    gradingMax: d.gradingMax ?? null,
    ...timestamps(d),
  }),

  testResult: (d) => ({
    id: oid(d._id),
    sessionId: oid(d.session),
    bindingId: oid(d.binding),
    testId: oid(d.test),
    studentId: oid(d.student),
    seasonId: oid(d.season),
    classId: oid(d.class),
    subjectId: oid(d.subject),
    autoGradedScore: d.autoGradedScore ?? 0,
    manualGradedScore: d.manualGradedScore ?? 0,
    finalScore: d.finalScore ?? 0,
    gradingMin: d.gradingMin ?? null,
    gradingMax: d.gradingMax ?? null,
    passed: !!d.passed,
    status: d.status || "pending",
    ...timestamps(d),
  }),

  testSeason: (d) => ({
    id: oid(d._id),
    name: d.name,
    description: d.description ?? null,
    startDate: toDate(d.startDate),
    endDate: toDate(d.endDate),
    status: d.status || "draft",
    isActive: d.isActive ?? true,
    createdBy: oid(d.createdBy),
    schoolTiers: deepObjectIdToString(d.schoolTiers || []),
    classTiers: deepObjectIdToString(d.classTiers || []),
    distributedAt: toDate(d.distributedAt),
    distributedBy: oid(d.distributedBy),
    finalizedAt: toDate(d.finalizedAt),
    finalizedBy: oid(d.finalizedBy),
    ...timestamps(d),
  }),

  message: (d) => ({
    id: oid(d._id),
    messageText: d.messageText,
    sentBy: oid(d.sentBy),
    recipientType: d.recipientType,
    recipientIds: d.recipientIds || [],
    classId: oid(d.classId),
    season: oid(d.season),
    studentId: oid(d.studentId),
    totalRecipients: d.totalRecipients ?? 0,
    ...timestamps(d),
  }),

  messageQueue: (d) => ({
    id: oid(d._id),
    messageId: oid(d.messageId),
    telegramId: d.telegramId,
    userId: oid(d.userId),
    messageText: d.messageText,
    filePath: d.filePath ?? null,
    fileName: d.fileName ?? null,
    fileContentType: d.fileContentType ?? null,
    fileType: d.fileType === "photo" || d.fileType === "document" ? d.fileType : null,
    replyMarkup: d.replyMarkup ? deepObjectIdToString(d.replyMarkup) : null,
    status: d.status || "pending",
    priority: d.priority ?? 0,
    attempts: d.attempts ?? 0,
    maxAttempts: d.maxAttempts ?? 3,
    errorMessage: d.errorMessage ?? null,
    processedAt: toDate(d.processedAt),
    ...timestamps(d),
  }),

  tgUser: (d) => ({
    id: oid(d._id),
    telegramId: d.telegramId,
    chatId: d.chatId,
    student: oid(d.student),
    firstName: d.firstName ?? null,
    lastName: d.lastName ?? null,
    username: d.username ?? null,
    notificationsEnabled: d.notificationsEnabled ?? true,
    lastActivity: toDate(d.lastActivity) || timestamps(d).createdAt,
    isActive: d.isActive ?? true,
    ...timestamps(d),
  }),

  weeklyStats: (d) => ({
    id: oid(d._id),
    student: oid(d.student),
    weekStart: toDate(d.weekStart),
    weekEnd: toDate(d.weekEnd),
    weekNumber: d.weekNumber,
    year: d.year,
    simpleStats: deepObjectIdToString(d.simpleStats || {}),
    totalSum: d.simpleStats?.totalSum ?? 0,
    totalGrades: d.simpleStats?.totalGrades ?? 0,
    classRanks: deepObjectIdToString(d.rankings?.classRanks || []),
    schoolRank: d.rankings?.schoolRank ?? null,
    schoolTotalStudents: d.rankings?.schoolTotalStudents ?? null,
    lastUpdated: toDate(d.lastUpdated) || timestamps(d).createdAt,
    isComplete: !!d.isComplete,
    ...timestamps(d),
  }),

  premium: (d) => ({
    id: oid(d._id),
    student: oid(d.student),
    durationDays: d.durationDays ?? 30,
    coinCost: d.coinCost,
    startDate: toDate(d.startDate),
    endDate: toDate(d.endDate),
    status: d.status || "active",
    coinBalanceAfter: d.coinBalanceAfter,
    source: d.source || "purchase",
    grantedBy: oid(d.grantedBy),
    ...timestamps(d),
  }),
};

// ─────────────────────────────────────────────
// CHILD JADVAL AJRATUVCHILARI
// ─────────────────────────────────────────────

const children = {
  userClasses: (d) => {
    const pid = oid(d._id);
    const rows = (d.classes || []).map((c) => ({
      userId: pid,
      classId: oid(c),
    }));
    return [{ model: "userClass", rows }];
  },

  scheduleLessons: (d) => {
    const pid = oid(d._id);
    const rows = (d.subjects || []).map((s, i) => ({
      id: childId(pid, i, 0),
      scheduleId: pid,
      subjectId: oid(s.subject),
      teacherId: oid(s.teacher),
      order: s.order,
      startTime: s.startTime ?? null,
      endTime: s.endTime ?? null,
      position: i,
    }));
    return [{ model: "scheduleLesson", rows }];
  },

  taskHistories: (d) => {
    const pid = oid(d._id);
    const status = (d.statusHistory || []).map((h, i) => ({
      id: childId(pid, i, 0),
      taskId: pid,
      status: h.status,
      reason: h.reason,
      changedBy: oid(h.changedBy),
      changedAt: toDate(h.changedAt) || timestamps(d).createdAt,
      position: i,
    }));
    const deadline = (d.deadlineHistory || []).map((h, i) => ({
      id: childId(pid, i, 1),
      taskId: pid,
      oldDueDate: toDate(h.oldDueDate),
      newDueDate: toDate(h.newDueDate),
      reason: h.reason,
      changedBy: oid(h.changedBy),
      changedAt: toDate(h.changedAt) || timestamps(d).createdAt,
      withPenalty: !!h.withPenalty,
      penaltyPoints: h.penaltyPoints ?? 0,
      position: i,
    }));
    return [
      { model: "taskStatusHistory", rows: status },
      { model: "taskDeadlineHistory", rows: deadline },
    ];
  },

  marketProductImages: (d) => {
    const pid = oid(d._id);
    const rows = (d.images || []).map((img, i) => ({
      productId: pid,
      imageId: oid(img),
      position: i,
    }));
    return [{ model: "marketProductImage", rows }];
  },

  marketOrderHistory: (d) => {
    const pid = oid(d._id);
    const rows = (d.statusHistory || []).map((h, i) => ({
      id: childId(pid, i, 0),
      orderId: pid,
      status: h.status,
      changedBy: oid(h.changedBy),
      note: h.note ?? "",
      changedAt: toDate(h.changedAt) || timestamps(d).createdAt,
      position: i,
    }));
    return [{ model: "marketOrderStatusHistory", rows }];
  },

  questionOptions: (d) => {
    const pid = oid(d._id);
    const rows = (d.options || []).map((o, i) => ({
      id: childId(pid, i, 0),
      questionId: pid,
      text: o.text ?? null,
      image: o.image ? deepObjectIdToString(o.image) : null,
      isCorrect: !!o.isCorrect,
      position: i,
    }));
    return [{ model: "questionOption", rows }];
  },

  testBindingChildren: (d) => {
    const pid = oid(d._id);
    const classes = (d.classes || []).map((c) => ({
      bindingId: pid,
      classId: oid(c),
    }));
    const grants = (d.reopenGrants || []).map((g, i) => ({
      id: childId(pid, i, 0),
      bindingId: pid,
      studentId: oid(g.student),
      grantedBy: oid(g.grantedBy),
      grantedAt: toDate(g.grantedAt) || timestamps(d).createdAt,
    }));
    return [
      { model: "testBindingClass", rows: classes },
      { model: "testBindingReopenGrant", rows: grants },
    ];
  },

  testSessionChildren: (d) => {
    const pid = oid(d._id);
    const questions = [];
    const options = [];
    (d.questions || []).forEach((q, qi) => {
      const qRowId = childId(pid, qi, 0);
      questions.push({
        id: qRowId,
        sessionId: pid,
        questionId: oid(q.question),
        type: q.type,
        text: q.text ?? null,
        image: q.image ? deepObjectIdToString(q.image) : null,
        difficulty: q.difficulty || "medium",
        points: q.points ?? 0,
        correctOptionId: oid(q.correctOptionId),
        position: qi,
      });
      (q.options || []).forEach((o, oi) => {
        options.push({
          id: childId(qRowId, oi, 1),
          questionRowId: qRowId,
          optionId: oid(o.optionId),
          text: o.text ?? null,
          image: o.image ? deepObjectIdToString(o.image) : null,
          position: oi,
        });
      });
    });
    const answers = (d.answers || []).map((a, i) => ({
      id: childId(pid, i, 2),
      sessionId: pid,
      questionId: oid(a.question),
      selectedOptionId: oid(a.selectedOptionId),
      textAnswer: a.textAnswer ?? null,
      answeredAt: toDate(a.answeredAt) || timestamps(d).createdAt,
    }));
    return [
      { model: "testSessionQuestion", rows: questions },
      { model: "testSessionQuestionOption", rows: options },
      { model: "testSessionAnswer", rows: answers },
    ];
  },

  testResultChildren: (d) => {
    const pid = oid(d._id);
    const extra = (d.extraPoints || []).map((e, i) => ({
      id: oid(e._id) || childId(pid, i, 0),
      resultId: pid,
      amount: e.amount,
      reason: e.reason,
      addedBy: oid(e.addedBy),
      addedAt: toDate(e.addedAt) || timestamps(d).createdAt,
      position: i,
    }));
    const perQ = (d.perQuestion || []).map((p, i) => ({
      id: childId(pid, i, 1),
      resultId: pid,
      questionId: oid(p.question),
      awardedPoints: p.awardedPoints ?? 0,
      maxPoints: p.maxPoints,
      gradedBy: oid(p.gradedBy),
      status: p.status || "graded",
      feedback: p.feedback ?? null,
      position: i,
    }));
    return [
      { model: "testResultExtraPoint", rows: extra },
      { model: "testResultPerQuestion", rows: perQ },
    ];
  },

  messageDelivery: (d) => {
    const pid = oid(d._id);
    const rows = (d.deliveryStatus || []).map((s, i) => ({
      id: childId(pid, i, 0),
      messageId: pid,
      telegramId: s.telegramId,
      userId: oid(s.userId),
      status: s.status || "pending",
      errorMessage: s.errorMessage ?? null,
      sentAt: toDate(s.sentAt),
      position: i,
    }));
    return [{ model: "messageDeliveryStatus", rows }];
  },

  weeklyStatsClasses: (d) => {
    const pid = oid(d._id);
    const rows = (d.classes || []).map((c) => ({
      weeklyStatsId: pid,
      classId: oid(c),
    }));
    return [{ model: "weeklyStatsClass", rows }];
  },
};

// ─────────────────────────────────────────────
// ISHGA TUSHIRISH (bog'liqlik tartibida)
// ─────────────────────────────────────────────

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db();
  console.log(`\n=== MIGRATION: ${db.databaseName} → PostgreSQL ===\n`);

  const M = (coll, model, transform, childrenFn) =>
    migrateCollection(db, coll, model, transform, childrenFn);

  console.log("── 1-daraja: ildiz modellar ──");
  await M("roles", "role", t.role);
  await M("classes", "class", t.class);
  await M("subjects", "subject", t.subject);
  await M("images", "image", t.image);
  await M("holidays", "holiday", t.holiday);
  await M("socialnetworks", "socialNetwork", t.socialNetwork);
  await M("leadcategories", "leadCategory", t.leadCategory);
  await M("leaddirections", "leadDirection", t.leadDirection);
  await M("leadsources", "leadSource", t.leadSource);
  await M("emojiconfigs", "emojiConfig", t.emojiConfig);
  await M("monitors", "monitor", t.monitor);
  // Singletonlar
  await M("coinsettings", "coinSettings", t.coinSettings);
  await M("schedulesettings", "scheduleSettings", t.scheduleSettings);
  await M("attendancesettings", "attendanceSettings", t.attendanceSettings);
  await M("gradepenaltysettings", "gradePenaltySettings", t.gradePenaltySettings);
  await M("penaltysettings", "penaltySettings", t.penaltySettings);
  await M("testsettings", "testSettings", t.testSettings);
  await M("premiumsettings", "premiumSettings", t.premiumSettings);

  console.log("── 2-daraja: User + junction ──");
  await M("users", "user", t.user, children.userClasses);

  console.log("── 3-daraja ──");
  await M("topics", "topic", t.topic);
  await M("teacherassignments", "teacherAssignment", t.teacherAssignment);
  await M("classsubjectprogresses", "classSubjectProgress", t.classSubjectProgress);
  await M("schedules", "schedule", t.schedule, children.scheduleLessons);
  await M("attendances", "attendance", t.attendance);
  await M("absencereasons", "absenceReason", t.absenceReason);
  await M("studentattendances", "studentAttendance", t.studentAttendance);
  await M("excuserequests", "excuseRequest", t.excuseRequest);
  await M("grades", "grade", t.grade);
  await M("tasks", "task", t.task, children.taskHistories);
  await M("penalties", "penalty", t.penalty);
  await M("penaltycategories", "penaltyCategory", t.penaltyCategory);
  await M("penaltynotificationqueues", "penaltyNotificationQueue", t.penaltyNotificationQueue);
  await M("finereductionpackages", "fineReductionPackage", t.fineReductionPackage);
  await M("coinsettings", "coinSettings", t.coinSettings); // idempotent
  await M("cointransactions", "coinTransaction", t.coinTransaction);
  await M("dailycoinstats", "dailyCoinStat", t.dailyCoinStat);
  await M("marketproducts", "marketProduct", t.marketProduct, children.marketProductImages);
  await M("tests", "test", t.test);
  await M("testseasons", "testSeason", t.testSeason);
  await M("weeklystats", "weeklyStats", t.weeklyStats, children.weeklyStatsClasses);
  await M("leads", "lead", t.lead);
  await M("leadactivities", "leadActivity", t.leadActivity);
  await M("tgusers", "tgUser", t.tgUser);

  console.log("── 4-daraja ──");
  await M("questions", "question", t.question, children.questionOptions);
  await M("testbindings", "testBinding", t.testBinding, children.testBindingChildren);
  await M("marketorders", "marketOrder", t.marketOrder, children.marketOrderHistory);
  await M("messages", "message", t.message, children.messageDelivery);
  await M("premia", "premium", t.premium);

  console.log("── 5-daraja ──");
  await M("testsessions", "testSession", t.testSession, children.testSessionChildren);
  await M("testresults", "testResult", t.testResult, children.testResultChildren);
  await M("messagequeues", "messageQueue", t.messageQueue);

  // ── Hisobot
  console.log("\n=== HISOBOT (model | mongo | pg | diff) ===");
  let ok = true;
  for (const r of report) {
    const diff = r.pg - r.mongo;
    const mark = diff === 0 ? "✓" : diff > 0 ? "≈(child/idempotent)" : "✗ KAM";
    if (diff < 0) ok = false;
    console.log(`  ${r.model.padEnd(28)} ${String(r.mongo).padStart(7)} ${String(r.pg).padStart(7)}  ${mark}`);
  }
  console.log(ok ? "\n✅ Barcha asosiy jadvallar to'liq ko'chdi." : "\n⚠️ Ba'zi jadvallarda kamomad bor — yuqoridagi log'ni tekshiring.");

  await client.close();
  await prisma.$disconnect();
  console.log("\n=== MIGRATION TUGADI ===\n");
}

main().catch(async (e) => {
  console.error("Migration xatosi:", e);
  await prisma.$disconnect();
  process.exit(1);
});
