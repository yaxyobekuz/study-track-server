/**
 * MUAMMOLAR — botdan kelgan shikoyatlar va ularning kategoriyalari.
 *
 * Oqim: xodim yoki ota-ona botda KATEGORIYA tanlaydi (oddiy klaviatura),
 * so'ng matn yozadi → `issues` ga qator tushadi. Ma'muriyat panelda ko'radi,
 * holatini o'zgartiradi va javob yozadi — javob botga qaytadi
 * (`issueNotification.service.js`).
 *
 * ── QOIDALAR ─────────────────────────────────────────────────────────
 *
 * ⚠️ MUAMMONI SERVER YARATMAYDI. Yozuvchi — BOT (`bot/src/services/
 * issue.service.js`), chunki u o'quvchi/xodim nomidan ishlaydi va serverda
 * uning tokeni yo'q. Server faqat KO'RIB CHIQADI: `status`, `reply`,
 * `reviewedBy/At`, `repliedAt`. Ikki tomon bir ustunga yozmaydi, shu sababli
 * poyga holati yo'q — bot `body`/`categoryId` ga, server esa ularga hech
 * qachon tegmaydi.
 *
 * ⚠️ KATEGORIYA YUMSHOQ O'CHIRILADI (`isActive = false`). Qattiq o'chirish
 * arxivdagi muammoni kategoriyasiz qoldirardi (`issues.category_id` ga
 * RESTRICT qo'yilgan). Bot esa faqat faol kategoriyalarni ko'rsatadi, ya'ni
 * yumshoq o'chirish botdagi tugmani darhol olib tashlaydi.
 *
 * ⚠️ MUALLIF NOMI QO'LDA YIG'ILADI. `select` ishlatilgan so'rovda Prisma
 * virtuallari (`fullName`) KELMAYDI — `config/prisma.js` dagi `virtuals`
 * kengaytmasi to'liq obyektga ishlaydi. Shuning uchun ism `firstName` va
 * `lastName` dan yig'iladi.
 */

const prisma = require("../config/prisma");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { NotFoundError, BadRequestError } = require("../utils/errors");
const { notifyIssueReply } = require("./issueNotification.service");

/** Ko'rib chiqish holatlari — `IssueStatus` enum bilan ayni ro'yxat. */
const ISSUE_STATUSES = ["new", "in_review", "resolved", "rejected"];

/**
 * YAKUNIY HOLATLAR — javob botga shu ikkisida ketadi.
 *
 * "Rad etildi" ham javob oladi: odam shikoyatini yozib, javobsiz qolsa bu
 * botni ikkinchi marta ishlatmaslikka sabab bo'lardi.
 */
const FINAL_STATUSES = ["resolved", "rejected"];

/** Muallif turlari — `tg_users.link_kind` bilan ayni ro'yxat. */
const AUTHOR_KINDS = ["student", "staff"];

/** Muammo ro'yxatida muallif haqida ko'rsatiladigan maydonlar. */
const AUTHOR_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  role: true,
  username: true,
  phone: true,
};

/** `select` li so'rovda virtual yo'q — ismni qo'lda yig'amiz. */
const fullNameOf = (user) =>
  user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : "";

// ─────────────────────────────────────────────
// KATEGORIYALAR
// ─────────────────────────────────────────────

/**
 * Kiruvchi ma'lumotdan faqat NOMI va HOLATI olinadi.
 *
 * ⚠️ Boshqa maydon ATAYLAB YO'Q: kategoriya botdagi klaviatura tugmasi va
 * tugmada nomdan boshqa hech narsa ko'rinmaydi. Tavsif/rang/mas'ul qo'shish
 * panelda ko'rinadigan, botda esa hech qachon ko'rinmaydigan ma'lumot
 * yaratardi.
 */
function pickCategoryFields(data = {}) {
  const fields = {};
  if (data.name !== undefined) fields.name = String(data.name).trim();
  if (data.isActive !== undefined) fields.isActive = !!data.isActive;
  return fields;
}

/**
 * Kategoriya yaratadi.
 * @param {object} data - `{ name, isActive }`
 * @param {string} createdBy
 * @returns {Promise<object>}
 */
async function createCategory(data, createdBy) {
  const fields = pickCategoryFields(data);
  if (!fields.name) throw new BadRequestError("Kategoriya nomi kiritilmadi");

  return prisma.issueCategory.create({ data: { ...fields, createdBy } });
}

/**
 * Boshqaruv ro'yxati — NOAKTIVLAR HAM kiradi.
 *
 * ⚠️ Faol bo'lmaganini ham qaytaradi: panelda ularni qayta yoqish kerak,
 * aks holda o'chirilgan kategoriya ko'rinmay qolib, uni tiklash imkonsiz
 * bo'lardi. Botdagi ro'yxat alohida (`getActiveCategories`).
 *
 * @returns {Promise<object[]>}
 */
async function getCategories() {
  const categories = await prisma.issueCategory.findMany({
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    include: { _count: { select: { issues: true } } },
  });

  return categories.map(({ _count, ...category }) => ({
    ...category,
    issuesCount: _count.issues,
  }));
}

/**
 * Faol kategoriyalar — botdagi klaviatura shundan chiziladi.
 * @returns {Promise<object[]>}
 */
async function getActiveCategories() {
  return prisma.issueCategory.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });
}

/**
 * Kategoriyani tahrirlaydi.
 * @param {string} id
 * @param {object} data - `{ name, isActive }`
 * @returns {Promise<object>}
 */
async function updateCategory(id, data) {
  const existing = await prisma.issueCategory.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Kategoriya topilmadi");

  const fields = pickCategoryFields(data);
  if (fields.name !== undefined && !fields.name) {
    throw new BadRequestError("Kategoriya nomi bo'sh bo'lishi mumkin emas");
  }

  return prisma.issueCategory.update({ where: { id }, data: fields });
}

/**
 * Kategoriyani o'chiradi.
 *
 * ⚠️ MUAMMOSI BOR KATEGORIYA — YUMSHOQ o'chirish (`isActive = false`):
 * botdagi tugma yo'qoladi, arxivdagi muammo esa kategoriyasiz qolmaydi.
 * Muammosi yo'q kategoriya butunlay o'chadi — adashib qo'shilgan satrni
 * ro'yxatda abadiy saqlab o'tirishning hojati yo'q.
 *
 * @param {string} id
 * @returns {Promise<{ deleted: boolean }>}
 */
async function deleteCategory(id) {
  const existing = await prisma.issueCategory.findUnique({
    where: { id },
    include: { _count: { select: { issues: true } } },
  });
  if (!existing) throw new NotFoundError("Kategoriya topilmadi");

  if (existing._count.issues > 0) {
    await prisma.issueCategory.update({
      where: { id },
      data: { isActive: false },
    });
    return { deleted: false };
  }

  await prisma.issueCategory.delete({ where: { id } });
  return { deleted: true };
}

// ─────────────────────────────────────────────
// MUAMMOLAR
// ─────────────────────────────────────────────

/**
 * Ro'yxat filtri — faqat KELGAN parametrlardan yig'iladi.
 * @param {object} query - `req.query`
 */
function buildIssueFilter(query = {}) {
  const where = {};

  if (query.status && ISSUE_STATUSES.includes(query.status)) {
    where.status = query.status;
  }
  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.authorKind && AUTHOR_KINDS.includes(query.authorKind)) {
    where.authorKind = query.authorKind;
  }
  if (query.search) {
    where.body = { contains: String(query.search).trim(), mode: "insensitive" };
  }

  // Davr — `from`/`to` "YYYY-MM-DD", Toshkent kunining chegaralari.
  if (query.from || query.to) {
    where.createdAt = {};
    if (query.from) where.createdAt.gte = new Date(`${query.from}T00:00:00+05:00`);
    if (query.to) where.createdAt.lte = new Date(`${query.to}T23:59:59.999+05:00`);
  }

  return where;
}

/**
 * Muammo qatorini mijozga tayyorlaydi: muallif ismi + kategoriya nomi.
 *
 * ⚠️ `authorKind === "student"` da muallif — O'QUVCHI, botdan foydalanadigan
 * odam esa uning OTA-ONASI. Panelda shu farq ko'rinishi uchun `authorKind`
 * o'zgarishsiz qaytariladi va yorliq frontendda qo'yiladi.
 */
function shapeIssue(issue) {
  const { author, category, ...rest } = issue;

  return {
    ...rest,
    categoryName: category?.name || "",
    categoryIsActive: category?.isActive ?? true,
    author: author
      ? { ...author, fullName: fullNameOf(author) }
      : null,
  };
}

/**
 * Muammolar ro'yxati (sahifalangan).
 *
 * ⚠️ MUALLIF `include` BILAN KELMAYDI: `issues.userId` — oddiy ustun,
 * `User` ga relation YO'Q (muallif o'chirilsa muammo matni qolishi kerak).
 * Shu sababli odamlar bitta qo'shimcha so'rov bilan yuklanadi va topilmagani
 * `null` bo'lib qoladi — bu normal holat, yetim qator.
 *
 * @param {object} req - Express request
 * @returns {Promise<object>}
 */
async function getIssues(req) {
  const { page, limit, skip } = getPaginationParams(req);
  const where = buildIssueFilter(req.query);

  const [rows, total] = await Promise.all([
    prisma.issue.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      include: { category: { select: { name: true, isActive: true } } },
    }),
    prisma.issue.count({ where }),
  ]);

  const authors = await loadAuthors(rows);
  const data = rows.map((row) =>
    shapeIssue({ ...row, author: authors.get(row.userId) || null }),
  );

  return formatPaginationResponse(data, total, page, limit);
}

/** Muammolar to'plami uchun muallif obyektlarini bitta so'rovda yuklaydi. */
async function loadAuthors(rows) {
  const ids = [...new Set(rows.map((r) => r.userId).filter(Boolean))];
  if (!ids.length) return new Map();

  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: AUTHOR_SELECT,
  });

  return new Map(users.map((u) => [u.id, u]));
}

/**
 * Bitta muammo.
 * @param {string} id
 * @returns {Promise<object>}
 */
async function getIssueById(id) {
  const issue = await prisma.issue.findUnique({
    where: { id },
    include: { category: { select: { name: true, isActive: true } } },
  });
  if (!issue) throw new NotFoundError("Muammo topilmadi");

  const authors = await loadAuthors([issue]);
  return shapeIssue({ ...issue, author: authors.get(issue.userId) || null });
}

/**
 * Holatlar bo'yicha sanoq — ro'yxat ustidagi tablar uchun.
 *
 * ⚠️ FILTRGA BOG'LIQ EMAS: sanoq butun registr bo'yicha, shuning uchun
 * "yangi" tabidagi raqam qaysi tab ochiq bo'lishidan qat'i nazar bir xil
 * qoladi. Aks holda tab o'zining raqamini o'zi o'zgartirardi.
 *
 * @returns {Promise<Record<string, number>>}
 */
async function getStatusCounts() {
  const grouped = await prisma.issue.groupBy({
    by: ["status"],
    _count: { _all: true },
  });

  const counts = ISSUE_STATUSES.reduce((acc, s) => ({ ...acc, [s]: 0 }), {});
  let total = 0;
  for (const row of grouped) {
    counts[row.status] = row._count._all;
    total += row._count._all;
  }

  return { ...counts, total };
}

/**
 * KO'RIB CHIQISH — holat va (ixtiyoriy) javob.
 *
 * ⚠️ JAVOB YAKUNIY HOLATDA MAJBURIY. "Hal qilindi" deb yopib, odamga hech
 * narsa aytmaslik — botdan shikoyat yuborgan odam uchun javobsizlik bilan
 * bir xil; bot esa unga yopilgani haqida o'zi xabar bera olmaydi.
 *
 * ⚠️ XABAR YUBORISH MUVAFFAQIYATSIZ BO'LSA HAM AMAL BEKOR QILINMAYDI:
 * odam botni bloklagan bo'lishi mumkin va bu ma'muriyatning qarorini
 * qaytarish uchun sabab emas. Farq `repliedAt` da ko'rinadi — bo'sh
 * bo'lsa javob yetib bormagan.
 *
 * @param {string} id
 * @param {object} data - `{ status, reply }`
 * @param {string} reviewedBy
 * @returns {Promise<object>}
 */
async function reviewIssue(id, data = {}, reviewedBy) {
  const existing = await prisma.issue.findUnique({
    where: { id },
    include: { category: { select: { name: true, isActive: true } } },
  });
  if (!existing) throw new NotFoundError("Muammo topilmadi");

  const status = data.status ?? existing.status;
  if (!ISSUE_STATUSES.includes(status)) {
    throw new BadRequestError("Holat noto'g'ri");
  }

  const reply =
    data.reply === undefined ? existing.reply : String(data.reply).trim();

  if (FINAL_STATUSES.includes(status) && !reply) {
    throw new BadRequestError(
      "Muammoni yakunlash uchun javob matni kiritilishi shart",
    );
  }

  const replyChanged = Boolean(reply) && reply !== existing.reply;
  const becameFinal =
    FINAL_STATUSES.includes(status) && !FINAL_STATUSES.includes(existing.status);

  const updated = await prisma.issue.update({
    where: { id },
    data: {
      status,
      reply: reply || null,
      reviewedBy,
      reviewedAt: new Date(),
    },
    include: { category: { select: { name: true, isActive: true } } },
  });

  // Javob botga faqat YAKUNIY holatda va matn yangilanganda ketadi —
  // "ko'rilmoqda" ni har bosishda odamga xabar yuborish spam bo'lardi.
  let delivered = null;
  if (FINAL_STATUSES.includes(status) && (becameFinal || replyChanged)) {
    delivered = await notifyIssueReply(updated);
    if (delivered) {
      await prisma.issue.update({
        where: { id },
        data: { repliedAt: new Date() },
      });
    }
  }

  const authors = await loadAuthors([updated]);
  return shapeIssue({
    ...updated,
    repliedAt: delivered ? new Date() : updated.repliedAt,
    author: authors.get(updated.userId) || null,
  });
}

/**
 * Muammoni o'chiradi (qattiq).
 *
 * Yumshoq o'chirish qo'yilmadi: muammo — HODISA, uning "noaktiv" holati
 * ma'nosiz. Spam yoki adashib yuborilgan satrni registrda saqlab turishning
 * hojati yo'q, yopilganlari esa `rejected` holati bilan qoladi.
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
async function deleteIssue(id) {
  const existing = await prisma.issue.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Muammo topilmadi");

  await prisma.issue.delete({ where: { id } });
}

module.exports = {
  ISSUE_STATUSES,
  FINAL_STATUSES,
  AUTHOR_KINDS,
  createCategory,
  getCategories,
  getActiveCategories,
  updateCategory,
  deleteCategory,
  getIssues,
  getIssueById,
  getStatusCounts,
  reviewIssue,
  deleteIssue,
};
