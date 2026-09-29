/**
 * ILOVALAR KATALOGI — "biz qaysi ilovalar haqida gapira olamiz".
 *
 * ⚠️ BITTA ILOVA — BITTA QATOR, ikkala identifikator bilan (android paketi
 * + iOS bundle). Admin "YouTube" ni tanlaydi, server esa qurilma
 * platformasiga mosini yuboradi. Ikki alohida qator bo'lsa siyosatni ikki
 * marta sozlash kerak bo'lardi va biri albatta unutilardi.
 *
 * ⚠️ QURILMA KATALOGNI TO'LDIRADI, admin emas. Admin paket nomini
 * (`com.google.android.youtube`) yoddan yoza olmaydi — qurilma esa uni
 * biladi va o'rnatilgan ilovalar ro'yxatini yuboradi (`syncDiscovered`).
 * Katalogda yo'qlari `isDiscovered` bilan yoziladi va panelda "Yangi
 * ilovalar" ro'yxatida turadi.
 *
 * ⚠️ ANIQLANGAN ILOVA AVTOMAT RUXSAT OLMAYDI: u shunchaki katalogga
 * tushadi. Oq ro'yxat siyosatida (`defaultMode = block`) baribir
 * bloklangan bo'lib qoladi — aks holda bolaning yangi o'rnatgan o'yini
 * o'zini o'zi ruxsat qilib olardi.
 *
 * ⚠️ O'CHIRILMAYDI — ARXIVLANADI: o'tgan hisobotlar va muhrlangan
 * siyosatlar unga ishora qiladi (`Tariff` bilan bir xil qaror).
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError, ConflictError } = require("../utils/errors");
const { isValidId } = require("../utils/objectId");
const { formatPaginationResponse } = require("../utils/pagination");
const deviceAudit = require("./deviceAudit.service");

const NAME_MAX = 120;
const IDENTIFIER_MAX = 180;

/** Katalog kesimlari — panel filtrlarida va guruhlashda. */
const CATEGORIES = Object.freeze([
  "ta'lim",
  "ijtimoiy",
  "video",
  "o'yin",
  "xabar",
  "brauzer",
  "tizim",
  "boshqa",
]);

/**
 * Bir so'rovda qabul qilinadigan ilovalar chegarasi. Telefonda 200-400 ta
 * ilova bo'lishi odatiy, lekin chegarasiz ro'yxat bitta buzuq mijozga
 * katalogni to'ldirib tashlash imkonini berardi.
 */
const MAX_DISCOVERY_BATCH = 500;

/**
 * Identifikatorni normallashtiradi: bo'sh satr `null` bo'ladi.
 *
 * ⚠️ BO'SH SATR EMAS, `null`: `@unique` ustunda ikkita bo'sh satr
 * to'qnashardi, `null` lar esa PostgreSQL da bir-biriga teng emas —
 * ya'ni identifikatorsiz bir nechta ilova bemalol yashay oladi.
 *
 * ⚠️ KICHIK HARFGA TUSHIRILMAYDI — faqat bo'sh joy olinadi. Paket nomi
 * va bundle id KATTA-KICHIK HARFGA SEZGIR:
 * `com.duolingo.DuolingoMobile` va `ph.telegra.Telegraph` — haqiqiy
 * qiymatlar. Ularni kichik harfga tushirish profildagi identifikatorni
 * telefondagi haqiqiy qiymatga MOS KELMAYDIGAN qilib qo'yardi va qoida
 * o'sha ilovaga umuman qo'llanmasdi. Buni topish qiyin: panel to'g'ri
 * ko'rinib turadi, faqat telefonda ishlamaydi.
 */
const normalizeIdentifier = (value) => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length > IDENTIFIER_MAX) {
    throw new BadRequestError(`Identifikator juda uzun (${IDENTIFIER_MAX} belgidan oshmasin)`);
  }
  return text;
};

const normalizeName = (value) => {
  const text = String(value ?? "").trim();
  if (!text) throw new BadRequestError("Ilova nomi majburiy");
  return text.slice(0, NAME_MAX);
};

const normalizeCategory = (value) => {
  const text = String(value ?? "").trim().toLowerCase();
  return CATEGORIES.includes(text) ? text : "boshqa";
};

/**
 * ILOVA TARQALGANLIGI — "bu ilova nechta qurilmada bor".
 *
 * ⚠️ AYNAN SHU RAQAM "yangi aniqlangan" uyumini boshqariladigan qiladi.
 * Butun maktab ulanganda katalogga bir necha yuz ilova tushadi va ular
 * alifbo bo'yicha tursa, adminga kerak bo'lgan 20 tasi quyruqda yo'qolib
 * ketardi. Tarqalganlik bo'yicha saralanganda eng ko'p ishlatilayotgani
 * tepada bo'ladi.
 *
 * ⚠️ `COUNT(DISTINCT device_id)` — XOM SQL bilan. Prisma `groupBy` faqat
 * QATORLARNI sanaydi, qatorlar esa (qurilma × kun) kesimida: 30 kunlik
 * ma'lumotda bitta telefon o'ttiz marta sanalib, raqam ma'nosiz bo'lardi.
 *
 * ⚠️ Oyna — 30 kun: bir marta o'rnatilib tashlab qo'yilgan ilova ro'yxat
 * tepasida abadiy qolib ketmasligi kerak.
 *
 * @returns {Promise<Map<string, { devices: number, minutes: number }>>}
 */
async function usageByAppKey(days = 30) {
  const since = new Date(Date.now() - days * 86400000);
  const cutoff = new Date(
    Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()),
  );

  const rows = await prisma.$queryRaw`
    SELECT app_key,
           COUNT(DISTINCT device_id)::int AS devices,
           COALESCE(SUM(minutes), 0)::int AS minutes
    FROM device_usage_days
    WHERE day >= ${cutoff}
    GROUP BY app_key
  `;

  return new Map(rows.map((r) => [r.app_key, { devices: r.devices, minutes: r.minutes }]));
}

/**
 * Katalog ro'yxati — sahifalangan.
 *
 * ⚠️ IKKI RO'YXAT BIR SO'ROVDA: "yangi aniqlangan" (nomlanmagan) va
 * nomlangan katalog. Birinchisi TARQALGANLIK bo'yicha saralanadi va
 * SAHIFALANMAYDI (u ish ro'yxati — admin uni tugatib ketishi kerak, eng
 * kerakli 60 tasi ko'rsatiladi), ikkinchisi esa alifbo bo'yicha va
 * sahifalanadi.
 *
 * @param {{ search?, category?, archived?, page?, limit? }} query
 */
async function list(query = {}) {
  const search = String(query.search || "").trim();
  const archived = query.archived === "true";

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(Math.max(Number(query.limit) || 40, 1), 200);

  const searchWhere = search
    ? {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { androidPackage: { contains: search, mode: "insensitive" } },
          { iosBundleId: { contains: search, mode: "insensitive" } },
        ],
      }
    : {};

  const categoryWhere =
    query.category && query.category !== "all"
      ? { category: normalizeCategory(query.category) }
      : {};

  const baseWhere = { isArchived: archived, ...categoryWhere, ...searchWhere };

  // Nomlangan katalog — sahifalanadi.
  const namedWhere = { ...baseWhere, isDiscovered: false };
  // Yangi aniqlangan — faqat arxivlanmaganlar orasida ma'noga ega.
  const discoveredWhere = { ...baseWhere, isDiscovered: true };

  const [apps, total, discovered, discoveredCount, usage] = await Promise.all([
    prisma.deviceApp.findMany({
      where: namedWhere,
      orderBy: [{ category: "asc" }, { name: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.deviceApp.count({ where: namedWhere }),
    archived
      ? []
      : prisma.deviceApp.findMany({ where: discoveredWhere, take: 400 }),
    prisma.deviceApp.count({ where: { isDiscovered: true, isArchived: false } }),
    usageByAppKey(),
  ]);

  const statOf = (app) =>
    usage.get(app.androidPackage) || usage.get(app.iosBundleId) || { devices: 0, minutes: 0 };

  const decorate = (app) => ({ ...app, usage: statOf(app) });

  return {
    ...formatPaginationResponse(apps.map(decorate), total, page, limit),
    // ⚠️ Tarqalganlik bo'yicha: eng ko'p qurilmada uchragani tepada, teng
    // bo'lsa — ko'proq vaqt olgani. Nomi bo'yicha saralash bu ro'yxatda
    // foydasiz (admin nomni hali bilmaydi).
    discovered: discovered
      .map(decorate)
      .sort(
        (a, b) =>
          b.usage.devices - a.usage.devices ||
          b.usage.minutes - a.usage.minutes ||
          a.name.localeCompare(b.name),
      )
      .slice(0, 60),
    discoveredTotal: discoveredCount,
    categories: CATEGORIES,
  };
}

/** Siyosat muharriri uchun — faqat faol ilovalar, yengil shakl. */
async function options() {
  return prisma.deviceApp.findMany({
    where: { isArchived: false },
    select: {
      id: true,
      name: true,
      category: true,
      androidPackage: true,
      iosBundleId: true,
      isEssential: true,
      isDiscovered: true,
    },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });
}

/**
 * Identifikator bandligini tekshiradi.
 *
 * ⚠️ Prisma `P2002` xatosini kutib o'tirmaymiz: xabar ("Unique constraint
 * failed on the fields: (`android_package`)") foydalanuvchiga ko'rsatib
 * bo'lmaydigan matn. Qaysi ilova egallab turganini AYTAMIZ — admin uni
 * qidirib yurmasin.
 */
async function assertIdentifiersFree({ androidPackage, iosBundleId, excludeId }) {
  const conditions = [
    androidPackage ? { androidPackage } : null,
    iosBundleId ? { iosBundleId } : null,
  ].filter(Boolean);

  if (conditions.length === 0) return;

  const clash = await prisma.deviceApp.findFirst({
    where: { OR: conditions, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, name: true, androidPackage: true, iosBundleId: true },
  });

  if (clash) {
    const which = clash.androidPackage === androidPackage ? clash.androidPackage : clash.iosBundleId;
    throw new ConflictError(
      `Bu identifikator «${clash.name}» ilovasiga biriktirilgan: ${which}`,
      { appId: clash.id },
    );
  }
}

async function create(payload = {}, actorId) {
  const androidPackage = normalizeIdentifier(payload.androidPackage);
  const iosBundleId = normalizeIdentifier(payload.iosBundleId);

  if (!androidPackage && !iosBundleId) {
    throw new BadRequestError(
      "Kamida bitta identifikator kerak: Android paketi yoki iOS bundle id",
    );
  }

  await assertIdentifiersFree({ androidPackage, iosBundleId });

  const app = await prisma.deviceApp.create({
    data: {
      name: normalizeName(payload.name),
      category: normalizeCategory(payload.category),
      androidPackage,
      iosBundleId,
      isEssential: Boolean(payload.isEssential),
      // Qo'lda kiritilgan ilova "aniqlangan" emas — u allaqachon nomlangan.
      isDiscovered: false,
      createdBy: actorId,
    },
  });

  await deviceAudit.record({
    action: deviceAudit.ACTIONS.APP_UPSERT,
    actorId,
    summary: `Katalogga «${app.name}» ilovasi qo'shildi`,
    meta: { appId: app.id, androidPackage, iosBundleId },
  });

  return app;
}

async function update(id, payload = {}, actorId) {
  if (!isValidId(id)) throw new BadRequestError("Ilova id si noto'g'ri");

  const existing = await prisma.deviceApp.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Ilova topilmadi");

  const data = {};
  if (payload.name !== undefined) data.name = normalizeName(payload.name);
  if (payload.category !== undefined) data.category = normalizeCategory(payload.category);
  if (payload.isEssential !== undefined) data.isEssential = Boolean(payload.isEssential);

  if (payload.androidPackage !== undefined) {
    data.androidPackage = normalizeIdentifier(payload.androidPackage);
  }
  if (payload.iosBundleId !== undefined) {
    data.iosBundleId = normalizeIdentifier(payload.iosBundleId);
  }

  const nextAndroid = data.androidPackage !== undefined ? data.androidPackage : existing.androidPackage;
  const nextIos = data.iosBundleId !== undefined ? data.iosBundleId : existing.iosBundleId;

  if (!nextAndroid && !nextIos) {
    throw new BadRequestError("Kamida bitta identifikator qolishi kerak");
  }
  await assertIdentifiersFree({
    androidPackage: data.androidPackage,
    iosBundleId: data.iosBundleId,
    excludeId: id,
  });

  // Nomlangan ilova endi "yangi aniqlangan" emas — ro'yxatdan chiqadi.
  if (payload.name !== undefined && existing.isDiscovered) data.isDiscovered = false;

  const app = await prisma.deviceApp.update({ where: { id }, data });

  await deviceAudit.record({
    action: deviceAudit.ACTIONS.APP_UPSERT,
    actorId,
    summary: `«${app.name}» ilovasi tahrirlandi`,
    meta: { appId: id, changed: Object.keys(data) },
  });

  return app;
}

/**
 * Arxivlash / arxivdan qaytarish.
 *
 * ⚠️ SIYOSATDA ISHLATILAYOTGAN ILOVA ARXIVLANMAYDI: u profildan jimgina
 * tushib qolardi va oq ro'yxatdagi ruxsat bekor bo'lardi — bola ertalab
 * telefonini ochganda sababini hech kim tushuntira olmasdi. Avval
 * siyosatdan olib tashlanadi.
 */
async function setArchived(id, isArchived, actorId) {
  if (!isValidId(id)) throw new BadRequestError("Ilova id si noto'g'ri");

  const app = await prisma.deviceApp.findUnique({ where: { id } });
  if (!app) throw new NotFoundError("Ilova topilmadi");

  if (isArchived) {
    const used = await prisma.devicePolicyApp.findMany({
      where: { appId: id },
      select: { policy: { select: { id: true, name: true, isArchived: true } } },
    });
    const live = used.filter((row) => !row.policy.isArchived).map((row) => row.policy);
    if (live.length > 0) {
      throw new ConflictError(
        `Bu ilova ${live.length} ta siyosatda ishlatilyapti: ${live.map((p) => p.name).join(", ")}. Avval siyosatdan olib tashlang.`,
        { policies: live.map((p) => p.id) },
      );
    }
  }

  const updated = await prisma.deviceApp.update({
    where: { id },
    data: { isArchived: Boolean(isArchived) },
  });

  await deviceAudit.record({
    action: deviceAudit.ACTIONS.APP_UPSERT,
    actorId,
    summary: `«${app.name}» ilovasi ${isArchived ? "arxivlandi" : "arxivdan qaytarildi"}`,
    meta: { appId: id },
  });

  return updated;
}

/**
 * OMMAVIY ARXIVLASH — "yangi aniqlangan" uyumini tozalash uchun.
 *
 * ⚠️ BITTALIK YO'LNI CHAQIRADI, mustaqil SQL yozmaydi: aks holda
 * "siyosatda ishlatilayotgan ilova arxivlanmaydi" tekshiruvi ommaviy
 * yo'lda tushib qolardi (`finance.md` §5 dagi ommaviy amallar doktrinasi
 * bilan AYNI).
 *
 * ⚠️ HAR ILOVA ALOHIDA: bittasi yiqilsa qolganlari baribir arxivlanadi
 * va qaysi biri o'tmagani sababi bilan qaytadi.
 */
async function bulkArchive(ids = [], actorId) {
  const unique = [...new Set(ids.filter(isValidId))];
  if (unique.length === 0) throw new BadRequestError("Ilova tanlanmagan");
  if (unique.length > 200) throw new BadRequestError("Bir so'rovda ko'pi bilan 200 ta ilova");

  const archived = [];
  const failed = [];

  for (const id of unique) {
    try {
      const app = await setArchived(id, true, actorId);
      archived.push({ id, name: app.name });
    } catch (error) {
      failed.push({ id, message: error.message });
    }
  }

  return { archived: archived.length, failed };
}

/**
 * QURILMADAN KELGAN ILOVALAR RO'YXATI — katalogni to'ldiradi.
 *
 * ⚠️ MAVJUD QATOR USTIGA YOZILMAYDI. Admin ilovani "YouTube" deb nomlab,
 * kategoriya qo'ygan bo'lsa, keyingi sinxronizatsiya uni telefondagi xom
 * yorliq bilan ("YouTube Music Premium APK") almashtirmasligi kerak.
 * Faqat YO'Q ilovalar qo'shiladi.
 *
 * ⚠️ Xato TASHLAMAYDI: katalogni to'ldirish qo'shimcha foyda, qurilmaning
 * asosiy ishi (profil olish, hisobot yuborish) bunga bog'liq bo'lmasligi
 * kerak.
 *
 * @param {Array<{identifier: string, label?: string}>} apps
 * @param {string} platform - "android" | "ios"
 * @returns {Promise<{ added: number, known: number }>}
 */
async function syncDiscovered(apps = [], platform = "android") {
  const seen = new Map();

  for (const entry of apps.slice(0, MAX_DISCOVERY_BATCH)) {
    const identifier = normalizeIdentifierSafe(entry?.identifier ?? entry?.package);
    if (!identifier || seen.has(identifier)) continue;
    seen.set(identifier, String(entry?.label || "").trim().slice(0, NAME_MAX) || identifier);
  }

  if (seen.size === 0) return { added: 0, known: 0 };

  const field = platform === "ios" ? "iosBundleId" : "androidPackage";
  const identifiers = [...seen.keys()];

  const existing = await prisma.deviceApp.findMany({
    where: { [field]: { in: identifiers } },
    select: { [field]: true },
  });
  const known = new Set(existing.map((row) => row[field]));

  const rows = identifiers
    .filter((identifier) => !known.has(identifier))
    .map((identifier) => ({
      name: seen.get(identifier),
      category: "boshqa",
      [field]: identifier,
      isDiscovered: true,
    }));

  if (rows.length === 0) return { added: 0, known: known.size };

  // `skipDuplicates` — ikki qurilma bir vaqtda bir xil ilovani yuborsa
  // ikkinchisi jimgina o'tib ketsin (poyga xato emas).
  const { count } = await prisma.deviceApp.createMany({ data: rows, skipDuplicates: true });
  return { added: count, known: known.size };
}

/**
 * `normalizeIdentifier` ning tashlamaydigan varianti (qurilma oqimi uchun).
 * ⚠️ Bu yerda ham kichik harfga TUSHIRILMAYDI — yuqoridagi izohga qarang.
 */
function normalizeIdentifierSafe(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > IDENTIFIER_MAX) return null;
  return text;
}

module.exports = {
  CATEGORIES,
  list,
  usageByAppKey,
  bulkArchive,
  options,
  create,
  update,
  setArchived,
  syncDiscovered,
  normalizeIdentifierSafe,
};
