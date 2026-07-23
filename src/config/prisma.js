/**
 * PrismaClient singleton + kengaytmalar (extensions).
 *
 *  1. ID auto-generatsiya: har `create`/`createMany`da `id` berilmagan bo'lsa,
 *     24-hex ObjectId-mos ID qo'shadi (eski format bilan mos). 42 service'da
 *     takrorlamaslik uchun shu yerda markazlashtirilgan.
 *  2. Computed fieldlar (Mongoose virtuallari o'rnini bosadi):
 *     User.fullName, Lead.fullName, TestResult.maxScore — frontend shakli saqlanadi.
 *
 * Barcha service `require("../config/prisma")` orqali shu (kengaytirilgan)
 * clientni oladi.
 */

const { PrismaClient } = require("../generated/prisma");
const { generateId } = require("../utils/idGenerator");

// ID auto-generatsiya kerak bo'lgan modellar (id maydoni String @db.Char(24)).
// Singletonlar (id="singleton") va junction jadvallar (composite PK) bu ro'yxatda YO'Q.
const AUTO_ID_MODELS = new Set([
  "User", "Role", "Class", "Subject", "Topic", "Schedule", "ScheduleLesson",
  "TeacherAssignment", "ClassSubjectProgress", "Attendance", "AbsenceReason",
  "StudentAttendance", "ExcuseRequest", "Grade", "Task", "TaskStatusHistory",
  "TaskDeadlineHistory", "Penalty", "PenaltyCategory", "PenaltyNotificationQueue",
  "FineReductionPackage", "CoinTransaction", "DailyCoinStat", "MarketProduct",
  "MarketOrder", "MarketOrderStatusHistory", "Lead", "LeadActivity", "LeadCategory",
  "LeadDirection", "LeadSource", "Test", "Question", "QuestionOption", "TestBinding",
  "TestBindingReopenGrant", "TestSession", "TestSessionQuestion",
  "TestSessionQuestionOption", "TestSessionAnswer", "TestResult",
  "TestResultExtraPoint", "TestResultPerQuestion", "TestSeason", "Message",
  "MessageDeliveryStatus", "MessageQueue", "TgUser", "SocialNetwork", "WeeklyStats",
  "Holiday", "Image", "Monitor", "Premium", "EmojiConfig",
]);

const basePrisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

// Junction (M2M) relation nomlari — bu jadvallarda `id` yo'q (composite PK).
// Nested create'da bularga id QO'SHILMAYDI.
const JUNCTION_RELATIONS = new Set(["classes", "images"]);

/**
 * `data` obyekti ichidagi barcha nested create/createMany yozuvlariga
 * rekursiv ravishda `id` qo'shadi (junction relationlardan tashqari).
 * Prisma extension query-hook faqat top-level modelga id qo'yadi; nested
 * yozuvlar (statusHistory, questions, answers, ...) shu funksiya bilan qamraladi.
 */
function ensureNestedIds(data) {
  if (data == null || typeof data !== "object") return;

  for (const [key, value] of Object.entries(data)) {
    if (value == null || typeof value !== "object") continue;

    // Relation yozuvi: { create: {...} } yoki { create: [...] } yoki { createMany: { data } }
    const isJunction = JUNCTION_RELATIONS.has(key);

    if (value.create !== undefined) {
      const rows = Array.isArray(value.create) ? value.create : [value.create];
      for (const row of rows) {
        if (row && typeof row === "object") {
          if (!isJunction && row.id == null) row.id = generateId();
          ensureNestedIds(row); // chuqurroq nested (masalan question.options)
        }
      }
    }
    if (value.createMany && value.createMany.data) {
      const rows = Array.isArray(value.createMany.data)
        ? value.createMany.data
        : [value.createMany.data];
      for (const row of rows) {
        if (row && typeof row === "object" && !isJunction && row.id == null) {
          row.id = generateId();
        }
      }
    }
  }
}

const prisma = basePrisma
  .$extends({
    name: "auto-id",
    query: {
      $allModels: {
        async create({ model, args, query }) {
          if (args.data) {
            if (AUTO_ID_MODELS.has(model) && args.data.id == null) {
              args.data.id = generateId();
            }
            ensureNestedIds(args.data);
          }
          return query(args);
        },
        async createMany({ model, args, query }) {
          if (AUTO_ID_MODELS.has(model) && args.data) {
            const rows = Array.isArray(args.data) ? args.data : [args.data];
            for (const row of rows) {
              if (row.id == null) row.id = generateId();
            }
          }
          return query(args);
        },
        async update({ args, query }) {
          // update ichida nested create bo'lishi mumkin (masalan statusHistory qo'shish)
          if (args.data) ensureNestedIds(args.data);
          return query(args);
        },
        async upsert({ args, query }) {
          if (args.create) ensureNestedIds(args.create);
          if (args.update) ensureNestedIds(args.update);
          return query(args);
        },
      },
    },
  })
  .$extends({
    name: "virtuals",
    result: {
      user: {
        fullName: {
          needs: { firstName: true, lastName: true },
          compute(u) {
            return u.lastName ? `${u.firstName} ${u.lastName}` : u.firstName;
          },
        },
      },
      lead: {
        fullName: {
          needs: { firstName: true, lastName: true },
          compute(l) {
            return `${l.firstName} ${l.lastName}`;
          },
        },
      },
      testResult: {
        // maxScore: gradingMax bo'lsa o'sha; aks holda service perQuestion.maxPoints
        // yig'indisi bilan to'ldiradi (bu yerda faqat gradingMax fallback'i).
        maxScore: {
          needs: { gradingMax: true },
          compute(r) {
            return r.gradingMax != null ? r.gradingMax : 0;
          },
        },
      },
    },
  });

module.exports = prisma;
