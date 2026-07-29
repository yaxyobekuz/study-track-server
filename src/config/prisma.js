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

const { PrismaClient, Prisma } = require("../generated/prisma");
const { generateId } = require("../utils/idGenerator");

// Modellar schema'ning o'zidan (DMMF) o'qiladi — qo'lda ro'yxat yuritilmaydi,
// shuning uchun yangi model qo'shilganda bu fayl eskirib qolmaydi.
//
// AUTO_ID_MODELS: `id` maydoni bor va @default'i YO'Q modellar. Singletonlar
// (id @default("singleton")) va junction jadvallar (composite PK, id yo'q)
// avtomatik ravishda tashqarida qoladi.
const AUTO_ID_MODELS = new Set(
  Prisma.dmmf.datamodel.models
    .filter((m) =>
      m.fields.some((f) => f.name === "id" && f.isId && !f.hasDefaultValue),
    )
    .map((m) => m.name),
);

// model nomi -> { relation maydoni: bog'langan model nomi }.
// Nested yozuvda qaysi modelga id kerakligini nom bo'yicha taxmin qilmay,
// aniq bilish uchun kerak.
const RELATIONS = new Map(
  Prisma.dmmf.datamodel.models.map((m) => [
    m.name,
    Object.fromEntries(
      m.fields.filter((f) => f.kind === "object").map((f) => [f.name, f.type]),
    ),
  ]),
);

const basePrisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

/**
 * `payload` (obyekt yoki massiv) — `model` modelining create yozuv(lar)i.
 * Kerak bo'lsa `id` qo'yadi va ichkariga rekursiv tushadi.
 */
function applyIds(model, payload) {
  if (payload == null || typeof payload !== "object") return;

  for (const row of Array.isArray(payload) ? payload : [payload]) {
    if (row == null || typeof row !== "object") continue;
    if (AUTO_ID_MODELS.has(model) && row.id == null) row.id = generateId();
    ensureNestedIds(model, row);
  }
}

/**
 * `data` ichidagi barcha nested yozuvlarga rekursiv ravishda `id` qo'shadi:
 * `create`, `createMany`, `connectOrCreate.create`, `upsert.create`.
 * Prisma extension query-hook faqat top-level modelga id qo'yadi; nested
 * yozuvlar (statusHistory, questions, answers, ...) shu funksiya bilan qamraladi.
 */
function ensureNestedIds(model, data) {
  const relations = RELATIONS.get(model);
  if (!relations || data == null || typeof data !== "object") return;

  for (const [key, value] of Object.entries(data)) {
    const target = relations[key];
    if (!target || value == null || typeof value !== "object") continue;

    if (value.create !== undefined) applyIds(target, value.create);

    // { connectOrCreate: { where, create } } va { upsert: { where, create, update } }
    // — ikkalasi ham bitta obyekt yoki massiv bo'lishi mumkin.
    for (const nested of [value.connectOrCreate, value.upsert]) {
      if (nested == null || typeof nested !== "object") continue;
      for (const entry of Array.isArray(nested) ? nested : [nested]) {
        if (entry == null || typeof entry !== "object") continue;
        applyIds(target, entry.create);
        ensureNestedIds(target, entry.update);
      }
    }

    // { update: { where, data } } ichida yana nested create bo'lishi mumkin
    if (value.update !== undefined && !("upsert" in value)) {
      for (const entry of Array.isArray(value.update)
        ? value.update
        : [value.update]) {
        if (entry == null || typeof entry !== "object") continue;
        ensureNestedIds(target, entry.data !== undefined ? entry.data : entry);
      }
    }

    // createMany nested relation'larni qo'llab-quvvatlamaydi — faqat id kerak
    if (value.createMany && value.createMany.data != null) {
      const rows = Array.isArray(value.createMany.data)
        ? value.createMany.data
        : [value.createMany.data];
      for (const row of rows) {
        if (row == null || typeof row !== "object") continue;
        if (AUTO_ID_MODELS.has(target) && row.id == null) row.id = generateId();
      }
    }
  }
}

function ensureManyIds(model, data) {
  if (!AUTO_ID_MODELS.has(model) || data == null) return;
  for (const row of Array.isArray(data) ? data : [data]) {
    if (row && typeof row === "object" && row.id == null) row.id = generateId();
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
        async upsert({ model, args, query }) {
          if (args.create) {
            if (AUTO_ID_MODELS.has(model) && args.create.id == null) {
              args.create.id = generateId();
            }
            ensureNestedIds(args.create);
          }
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
