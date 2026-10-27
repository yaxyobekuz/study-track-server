/**
 * GALEREYA — TAQQOSLASH UCHUN YUZ VEKTORLARI (filial bo'yicha keshlangan).
 *
 * ── NIMA UCHUN KESH ─────────────────────────────────────────────────
 *
 * Har skanerda 1000 odam × 5 namuna o'qish = ~20 MB bazadan. Kadr esa
 * sekundda bir necha marta keladi. Shuning uchun galereya XOTIRADA
 * keshlanadi va faqat o'zgarganda qayta quriladi.
 *
 * ── KESH QANDAY ESKIRADI ────────────────────────────────────────────
 *
 * ⚠️ VAQT BO'YICHA EMAS, VERSIYA BO'YICHA. Har skanerda bitta kichik
 * so'rov ketadi — `FaceSettings.gallery_version`. Raqam keshdagidan
 * farq qilsa galereya qayta quriladi.
 *
 * Nima uchun TTL emas: server bir nechta jarayonda ishlashi mumkin
 * (PM2 cluster). TTL bilan ro'yxatga olingan odam 5 daqiqa davomida
 * ba'zi jarayonlarda "tanilmaydi", ba'zilarida tanilib — "kiosk ba'zan
 * ishlaydi" degan tushunib bo'lmaydigan nosozlik chiqardi. Versiya esa
 * BAZADA, ya'ni barcha jarayon bitta haqiqatni ko'radi.
 *
 * ⚠️ Kesh FILIAL SCHEMA'SI bo'yicha kalitlanadi: `getBranch()` dagi
 * `schemaName`. `config/prisma` ajratishni ulanish darajasida qilsa ham,
 * XOTIRADAGI kesh umumiy — kalitsiz bitta filial galereyasi boshqasiga
 * ko'rinib ketardi.
 */

const prisma = require("../config/prisma");
const { getBranch } = require("../config/branchContext");
const { getFaceSettings } = require("./settings.service");
const {
  unpackEmbedding,
  cosineSimilarity,
} = require("../helpers/faceEmbedding.helpers");
const { ROLES } = require("../utils/constants");
const logger = require("../utils/logger");

/** schemaName → { version, entries, builtAt, sampleCount } */
const cache = new Map();

/**
 * Taqqoslashga kiradigan odamlar.
 *
 * ⚠️ `isArchived` FILTRLANADI, `isActive` esa ATAYLAB FILTRLANMAYDI —
 * davomat generatorining qoidasi bilan AYNI (`education.md` §4):
 * o'chirilgan login odamni maktabdan chiqarmaydi, u baribir kelib
 * ishlayapti va davomati yozilishi kerak.
 */
const PERSON_WHERE = { isArchived: false };

const PERSON_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  role: true,
  extraRoles: true,
  isActive: true,
  // ⚠️ `select` ichida relation — rasmning faqat KICHIK variantining URL'i
  // kerak (kiosk ekranida 96px avatar), to'liq `variants` JSON'i emas.
  profileImage: { select: { variants: true } },
};

const fullName = (user) =>
  [user.lastName, user.firstName].filter(Boolean).join(" ").trim() || "Noma'lum";

/** Profil rasmi — `statistics.service.js` bilan ayni naqsh. */
const photoUrl = (user) => user?.profileImage?.variants?.sm?.url || null;

/**
 * Galereyani bazadan quradi.
 *
 * ⚠️ Model MOS KELMAGAN namunalar TUSHIRILADI (`model` + `dim`): kiosk
 * dasturidagi model almashtirilsa, eski vektorlar yangi vektor bilan
 * taqqoslanganda MA'NOSIZ son berardi — ya'ni tasodifiy odamga davomat
 * yozilishi mumkin edi. Tushirilgan namuna soni javobda qaytadi, panel
 * uni "qayta ro'yxatdan o'tkazish kerak" deb ko'rsatadi.
 *
 * ⚠️ Buzuq bufer (uzunligi 4 ga bo'linmaydi) butun galereyani
 * YIQITMAYDI — o'sha namuna o'tkazib yuboriladi va log'ga yoziladi.
 */
async function build({ model, dim }) {
  const profiles = await prisma.faceProfile.findMany({
    where: { isActive: true, samples: { some: { model, dim } } },
    select: {
      id: true,
      userId: true,
      sampleCount: true,
      samples: {
        where: { model, dim },
        select: { id: true, embedding: true, dim: true, quality: true },
      },
    },
  });

  if (profiles.length === 0) {
    return { entries: [], sampleCount: 0, skipped: 0 };
  }

  const users = await prisma.user.findMany({
    where: { ...PERSON_WHERE, id: { in: profiles.map((p) => p.userId) } },
    select: PERSON_SELECT,
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  const entries = [];
  let sampleCount = 0;
  let skipped = 0;

  for (const profile of profiles) {
    const user = userById.get(profile.userId);
    // Arxivlangan odam — profil qolsa ham taqqoslashga kirmaydi.
    if (!user) continue;

    const vectors = [];
    for (const sample of profile.samples) {
      const vector = unpackEmbedding(sample.embedding, sample.dim);
      if (!vector) {
        skipped += 1;
        continue;
      }
      vectors.push(vector);
    }

    if (vectors.length === 0) continue;

    sampleCount += vectors.length;
    entries.push({
      profileId: profile.id,
      userId: user.id,
      name: fullName(user),
      role: user.role,
      isActive: user.isActive,
      photo: photoUrl(user),
      vectors,
    });
  }

  if (skipped > 0) {
    logger.warn(`Face ID: ${skipped} ta buzuq yuz namunasi o'tkazib yuborildi`);
  }

  return { entries, sampleCount, skipped };
}

/**
 * Joriy filialning galereyasi (keshdan yoki qayta qurilgan).
 *
 * @param {object} [settings] - `getFaceSettings()` natijasi (qayta so'ramaslik uchun)
 * @returns {Promise<{ version: number, entries: Array, sampleCount: number, model: string, dim: number }>}
 */
async function getGallery(settings) {
  const faceSettings = settings || (await getFaceSettings());
  const schemaName = getBranch()?.schemaName || "unknown";
  const cached = cache.get(schemaName);

  if (
    cached &&
    cached.version === faceSettings.galleryVersion &&
    cached.model === faceSettings.embeddingModel &&
    cached.dim === faceSettings.embeddingDim
  ) {
    return cached;
  }

  const { entries, sampleCount } = await build({
    model: faceSettings.embeddingModel,
    dim: faceSettings.embeddingDim,
  });

  const fresh = {
    version: faceSettings.galleryVersion,
    model: faceSettings.embeddingModel,
    dim: faceSettings.embeddingDim,
    entries,
    sampleCount,
    builtAt: new Date(),
  };
  cache.set(schemaName, fresh);

  logger.info(
    `Face ID: galereya qurildi (${schemaName}) — ${entries.length} odam, ${sampleCount} namuna, v${fresh.version}`,
  );

  return fresh;
}

/**
 * GALEREYA VERSIYASINI OSHIRADI — har namuna qo'shilganda/o'chirilganda.
 *
 * ⚠️ Tranzaksiya ichidan chaqirilsa `tx` berilishi SHART: aks holda
 * namuna yozildi-u versiya oshmasdan qolishi mumkin edi va kiosk eski
 * galereya bilan ishlab turardi.
 *
 * @param {object} [tx] - Prisma tranzaksiya client'i
 * @returns {Promise<number>} yangi versiya
 */
async function bumpVersion(tx) {
  const client = tx || prisma;
  const row = await client.faceSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", galleryVersion: 2 },
    update: { galleryVersion: { increment: 1 } },
    select: { galleryVersion: true },
  });
  return row.galleryVersion;
}

/**
 * Keshni darhol tashlaydi — bitta jarayon ichidagi tezkor yangilash.
 *
 * ⚠️ Bu `bumpVersion` ning O'RNINI BOSMAYDI: boshqa jarayonlar faqat
 * bazadagi versiyani ko'radi. Ikkalasi birga chaqiriladi.
 */
function invalidate() {
  const schemaName = getBranch()?.schemaName;
  if (schemaName) cache.delete(schemaName);
  else cache.clear();
}

/**
 * ENG YAQIN ODAMNI TOPADI — IKKI SHARTLI QAROR.
 *
 * ```
 * score  = eng yaxshi namunaning kosinus o'xshashligi
 * margin = score − (BOSHQA odamning eng yaxshi natijasi)
 * ```
 *
 * ⚠️ `margin` SIZ BO'LMAYDI. Faqat `score` bilan tekshirilganda
 * bir-biriga o'xshash ikki odam (aka-uka, egizak) navbatma-navbat
 * bir-birining davomatini belgilab ketardi. `margin` past bo'lsa javob
 * `ambiguous` — kiosk "qo'lda belgilang" deydi va HECH KIMGA davomat
 * yozilmaydi (`.claude/rules/face-id.md` §3).
 *
 * ⚠️ Ikkinchi o'rin AYNI ODAMNING boshqa namunasi bo'lishi mumkin — u
 * `margin` ga KIRMAYDI: odamning ikkita namunasi bir-biriga o'xshashi
 * normal va uni "noaniq" deb hisoblash har kimning davomatini to'sib
 * qo'yardi. Shuning uchun `runnerUp` faqat BOSHQA `userId` bo'yicha.
 *
 * @param {Float32Array} probe - normalizatsiya qilingan kadr vektori
 * @param {{ entries: Array }} gallery
 * @returns {{ best: object|null, score: number, margin: number, runnerUp: object|null }}
 */
function findNearest(probe, gallery) {
  let best = null;
  let bestScore = -1;
  let runnerUp = null;
  let runnerScore = -1;

  for (const entry of gallery.entries) {
    // Odamning ENG YAXSHI namunasi — ko'zoynakli/ko'zoynaksiz kadrlar
    // orasidan mos kelgani yetarli.
    let entryScore = -1;
    for (const vector of entry.vectors) {
      const score = cosineSimilarity(probe, vector);
      if (score > entryScore) entryScore = score;
    }

    if (entryScore > bestScore) {
      // Avvalgi birinchi o'rin ikkinchiga tushadi (boshqa odam bo'lgani uchun).
      runnerUp = best;
      runnerScore = bestScore;
      best = entry;
      bestScore = entryScore;
    } else if (entryScore > runnerScore) {
      runnerUp = entry;
      runnerScore = entryScore;
    }
  }

  return {
    best,
    score: bestScore,
    runnerUp,
    runnerScore,
    // Ikkinchi odam umuman bo'lmasa `margin` to'liq: raqobatchi yo'q.
    margin: runnerUp ? bestScore - runnerScore : bestScore,
  };
}

/**
 * KIOSKKA BERILADIGAN GALEREYA (oflayn rejim uchun).
 *
 * ⚠️ FAQAT KIOSK TOKENI bilan beriladi (`routes/kiosk.routes.js`) —
 * panelga vektor HECH QACHON qaytmaydi (`.claude/rules/face-id.md` §10).
 *
 * ⚠️ Vektorlar base64 — JSON massivdan 3 barobar kichik va kioskda
 * `Float32Array` ga to'g'ridan-to'g'ri o'raladi.
 *
 * @param {object} [settings]
 * @returns {Promise<{ version: number, model: string, dim: number, people: Array }>}
 */
async function exportForKiosk(settings) {
  const gallery = await getGallery(settings);

  return {
    version: gallery.version,
    model: gallery.model,
    dim: gallery.dim,
    builtAt: gallery.builtAt,
    people: gallery.entries.map((entry) => ({
      userId: entry.userId,
      name: entry.name,
      role: entry.role,
      photo: entry.photo,
      vectors: entry.vectors.map((vector) =>
        Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64"),
      ),
    })),
  };
}

/**
 * "Nechta odam ro'yxatga olingan" — panel manzarasi uchun.
 *
 * ⚠️ Galereyadan O'QILADI, `count()` dan emas: galereya modeli mos
 * kelmagan namunalarni tushirib tashlaydi, ya'ni "12 odam ro'yxatda"
 * degan raqam TAQQOSLASHGA KIRADIGAN odamlar soni bo'lishi kerak.
 * `count()` bilan panel 12 ni ko'rsatib, kiosk hech kimni tanimasligi
 * mumkin edi.
 */
async function getCoverage(settings) {
  const faceSettings = settings || (await getFaceSettings());
  const gallery = await getGallery(faceSettings);

  const [staffTotal, studentTotal, profileTotal] = await Promise.all([
    prisma.user.count({ where: { ...PERSON_WHERE, role: { not: ROLES.STUDENT } } }),
    prisma.user.count({ where: { ...PERSON_WHERE, role: ROLES.STUDENT } }),
    prisma.faceProfile.count(),
  ]);

  let staffEnrolled = 0;
  let studentEnrolled = 0;
  for (const entry of gallery.entries) {
    if (entry.role === ROLES.STUDENT) studentEnrolled += 1;
    else staffEnrolled += 1;
  }

  return {
    version: gallery.version,
    model: gallery.model,
    dim: gallery.dim,
    sampleCount: gallery.sampleCount,
    // Profil bor, lekin galereyaga kirmagan — modeli boshqa yoki buzuq.
    staleProfiles: Math.max(0, profileTotal - gallery.entries.length),
    staff: { total: staffTotal, enrolled: staffEnrolled },
    students: { total: studentTotal, enrolled: studentEnrolled },
  };
}

module.exports = {
  getGallery,
  findNearest,
  bumpVersion,
  invalidate,
  exportForKiosk,
  getCoverage,
  PERSON_WHERE,
  PERSON_SELECT,
  fullName,
  photoUrl,
};
