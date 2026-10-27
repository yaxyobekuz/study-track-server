/**
 * YUZ NAMUNALARINI RO'YXATGA OLISH.
 *
 * ⚠️ RO'YXATGA OLISH KIOSK TOKENI BILAN ISHLAMAYDI — odatiy login va
 * `faceId.enroll` ruxsati talab qiladi (`.claude/rules/face-id.md` §9).
 * Usiz kiosk oldiga kelgan har kim o'zini boshqa odam deb yozdirib
 * ketardi: kiosk tokeni qurilmaning kimligi, odamning emas.
 *
 * ── DUBLIKAT DARVOZASI ──────────────────────────────────────────────
 *
 * Yangi namuna saqlashdan OLDIN galereyada qidiriladi. Boshqa odamga
 * `duplicateThreshold` dan yuqori mos kelsa — RAD etiladi va kimga
 * o'xshaganini aytadi. Aks holda bitta yuz ikki odamga biriktirilib,
 * davomat har kuni tasodifiy belgilanardi va sababi topilmasdi.
 *
 * ⚠️ `duplicateThreshold` odatda `matchThreshold` DAN PAST qo'yiladi:
 * ro'yxatga olish taqqoslashdan QATTIQROQ tekshiriladi. Ikkalasini
 * tenglashtirish "chegaradan bir chimdim pastda" turgan dublikatni
 * bazaga qo'yib yuborardi — va u keyin `ambiguous` bo'lib, ikki odamning
 * ham davomatini to'sib qo'yardi.
 *
 * ── NAMUNA SONI CHEKLANGAN ──────────────────────────────────────────
 *
 * `maxSamplesPerPerson` dan oshsa ENG ESKI namuna o'chiriladi: odamning
 * sochi, ko'zoynagi, soqoli o'zgaradi va eski kadr vaqt o'tishi bilan
 * yolg'on "o'xshamadi" chiqaradi. Cheksiz o'sish esa galereyani ham,
 * taqqoslashni ham sekinlashtiradi.
 */

const prisma = require("../config/prisma");
const { getFaceSettings } = require("./settings.service");
const faceGallery = require("./faceGallery.service");
const fileStorage = require("./fileStorage.service");
const { generateId } = require("../utils/idGenerator");
const {
  normalizeEmbedding,
  packEmbedding,
  scoreToPercent,
} = require("../helpers/faceEmbedding.helpers");
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} = require("../utils/errors");
const { isValidId } = require("../utils/objectId");
const { ROLES } = require("../utils/constants");
const { formatPaginationResponse, getPaginationParams } = require("../utils/pagination");
const { buildNameSearchWhere } = require("../helpers/nameSearch.helpers");
const logger = require("../utils/logger");

const SAMPLE_SOURCES = Object.freeze(["kiosk", "panel", "import"]);
const NOTE_MAX = 500;

/** Rasm — kichik JPEG. 400 KB dan katta kadr kelsa mijoz buzuq. */
const MAX_SNAPSHOT_BYTES = 400 * 1024;

const clamp01 = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(1, num));
};

/**
 * Panelga qaytariladigan namuna shakli.
 *
 * ⚠️ `embedding` CHIQMAYDI — biometrika panelga hech qachon qaytmaydi
 * (`.claude/rules/face-id.md` §10). Panelga kerak bo'lgani: qachon
 * olingan, qanchalik sifatli va rasmi.
 */
const publicSample = (sample) => ({
  id: sample.id,
  quality: sample.quality,
  qualityPercent: scoreToPercent(sample.quality),
  liveness: sample.liveness,
  antispoof: sample.antispoof,
  model: sample.model,
  dim: sample.dim,
  source: sample.source,
  kioskId: sample.kioskId,
  snapshotUrl: sample.snapshotUrl,
  createdBy: sample.createdBy,
  createdAt: sample.createdAt,
});

const publicProfile = (profile, user) => ({
  id: profile.id,
  userId: profile.userId,
  name: user ? faceGallery.fullName(user) : null,
  role: user?.role ?? null,
  photo: user ? faceGallery.photoUrl(user) : null,
  isActive: profile.isActive,
  sampleCount: profile.sampleCount,
  enrolledBy: profile.enrolledBy,
  enrolledAt: profile.enrolledAt,
  lastMatchedAt: profile.lastMatchedAt,
  lastScore: profile.lastScore,
  lastScorePercent: scoreToPercent(profile.lastScore),
  matchCount: profile.matchCount,
  note: profile.note,
  samples: profile.samples ? profile.samples.map(publicSample) : undefined,
});

/**
 * Kadr rasmini saqlaydi (ixtiyoriy).
 *
 * ⚠️ MAXFIY YUKLASH (`uploadPrivateBuffer`), ochiq EMAS. Bu odamning —
 * ko'pincha bolaning — yuz rasmi: havolasi qo'lga tushgan har kim uni
 * ochib ko'ra olmasligi kerak. Shuning uchun `url` qaytmaydi, panelga
 * API yo'li beriladi va u `faceId.events` ruxsati bilan qo'riqlanadi.
 *
 * ⚠️ Rasm YO'Q bo'lishi NORMAL: `storeSnapshots` o'chirilgan filialda
 * biometrika saqlanadi, rasm esa saqlanmaydi. Yuklash xatosi ham
 * ro'yxatga olishni YIQITMAYDI — vektor muhim, rasm esa audit uchun.
 *
 * @param {string} base64 - `data:` prefiksi bilan yoki usiz
 * @param {string} prefix - S3 kalit prefiksi
 * @returns {Promise<{ key: string|null }>}
 */
async function storeSnapshot(base64, prefix) {
  if (!base64 || typeof base64 !== "string") return { key: null };

  const payload = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
  let buffer;
  try {
    buffer = Buffer.from(payload, "base64");
  } catch {
    return { key: null };
  }

  if (buffer.length === 0 || buffer.length > MAX_SNAPSHOT_BYTES) return { key: null };

  const key = `${prefix}/${generateId()}.jpg`;
  try {
    await fileStorage.uploadPrivateBuffer({ key, buffer, contentType: "image/jpeg" });
    return { key };
  } catch (error) {
    logger.warn(`Face ID: kadr rasmi saqlanmadi — ${error.message}`);
    return { key: null };
  }
}

/**
 * Ro'yxatga olinadigan odamni tekshiradi.
 *
 * ⚠️ Arxivlangan odam RAD etiladi, nofaol (`isActive: false`) esa
 * O'TADI — galereya qoidasi bilan AYNI (`education.md` §4): o'chirilgan
 * login odamni maktabdan chiqarmaydi.
 */
async function loadPerson(userId) {
  if (!isValidId(userId)) throw new BadRequestError("Foydalanuvchi ID noto'g'ri");

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ...faceGallery.PERSON_SELECT, isArchived: true },
  });
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");

  if (user.role === ROLES.OWNER) {
    // Owner har filial schema'sida bor, lekin davomat tizimiga kirmaydi
    // (`attendance.service.checkIn` ham uni rad etadi) — yuzini olish
    // ma'nosiz bo'lardi.
    throw new ForbiddenError("Tizim egasi davomat tizimiga kirmaydi");
  }
  if (user.isArchived) {
    throw new BadRequestError("Arxivlangan foydalanuvchini ro'yxatga olib bo'lmaydi");
  }

  return user;
}

/* ═══════════════════════ RO'YXATGA OLISH ═══════════════════════ */

/**
 * BITTA KADRNI RO'YXATGA OLADI.
 *
 * Tartib ATAYLAB shunday:
 *   1. vektorni tekshirish va normalizatsiya (`normalizeEmbedding`);
 *   2. sifat va tiriklik darvozasi;
 *   3. DUBLIKAT darvozasi (galereya bo'yicha);
 *   4. rasmni saqlash (xatosi yiqitmaydi);
 *   5. tranzaksiya: profil + namuna + eng eskisini o'chirish + versiya.
 *
 * ⚠️ Dublikat tekshiruvi YOZISHDAN OLDIN. Keyin qilinsa, rad etilgan
 * namuna bazada qolib, galereya versiyasi ham oshib ketardi.
 *
 * @param {string} userId
 * @param {object} payload - { embedding, dim, model, quality, liveness, antispoof, snapshot, source, kioskId }
 * @param {string} actorId
 * @returns {Promise<{ profile: object, sample: object, replaced: string|null }>}
 */
async function addSample(userId, payload = {}, actorId) {
  const settings = await getFaceSettings();
  const user = await loadPerson(userId);

  // ── 1. Vektor ──────────────────────────────────────────────────
  const model = String(payload.model || settings.embeddingModel).trim();
  if (model !== settings.embeddingModel) {
    throw new BadRequestError(
      `Kiosk dasturidagi model ("${model}") sozlamadagidan ("${settings.embeddingModel}") farq qiladi`,
    );
  }
  const vector = normalizeEmbedding(payload.embedding, {
    expectedDim: settings.embeddingDim,
  });

  // ── 2. Sifat va tiriklik ───────────────────────────────────────
  const quality = clamp01(payload.quality) ?? 0;
  const liveness = clamp01(payload.liveness);
  const antispoof = clamp01(payload.antispoof);

  if (quality < settings.minFaceQuality) {
    throw new BadRequestError(
      "Kadr sifatsiz — yaqinroq turing, yorug'likni oshiring va to'g'ri qarab turing",
    );
  }
  // ⚠️ Ro'yxatga olishda tiriklik SHART: bazaga rasmdan olingan vektor
  // tushsa, keyinchalik o'sha rasm bilan davomatdan o'tib bo'lardi.
  if (settings.antispoofThreshold > 0 && (antispoof ?? 0) < settings.antispoofThreshold) {
    throw new BadRequestError("Tiriklik tekshiruvidan o'tmadi — kameraga o'zingiz qarang");
  }
  if (settings.livenessThreshold > 0 && (liveness ?? 0) < settings.livenessThreshold) {
    throw new BadRequestError("Tiriklik tekshiruvidan o'tmadi — kameraga o'zingiz qarang");
  }

  // ── 3. Dublikat darvozasi ──────────────────────────────────────
  const gallery = await faceGallery.getGallery(settings);
  const { best, score } = faceGallery.findNearest(vector, gallery);

  if (best && best.userId !== userId && score >= settings.duplicateThreshold) {
    const error = new ConflictError(
      `Bu yuz allaqachon boshqa odamga biriktirilgan: ${best.name} ` +
        `(${scoreToPercent(score)}% o'xshash)`,
    );
    error.details = {
      reason: "duplicate_face",
      userId: best.userId,
      name: best.name,
      score,
      scorePercent: scoreToPercent(score),
    };
    throw error;
  }

  // ── 4. Rasm ────────────────────────────────────────────────────
  const snapshot = settings.storeSnapshots
    ? await storeSnapshot(payload.snapshot, "face-id/samples")
    : { key: null };

  const source = SAMPLE_SOURCES.includes(payload.source) ? payload.source : "panel";

  // ── 5. Yozish ──────────────────────────────────────────────────
  const result = await prisma.$transaction(async (tx) => {
    const profile = await tx.faceProfile.upsert({
      where: { userId },
      create: {
        id: generateId(),
        userId,
        enrolledBy: actorId || null,
        enrolledAt: new Date(),
        sampleCount: 0,
      },
      update: {},
    });

    // ⚠️ `id` OLDINDAN olinadi: `snapshotUrl` ustuni panelning API
    // yo'lini saqlaydi va u id'ga bog'langan (`/face-id/samples/<id>/snapshot`).
    // Yo'lni javobda hisoblash ham mumkin edi, lekin u holda bitta
    // manzil ikki joyda yig'ilib, biri o'zgarsa ikkinchisi eskirardi.
    const sampleId = generateId();
    const sample = await tx.faceSample.create({
      data: {
        id: sampleId,
        profileId: profile.id,
        embedding: packEmbedding(vector),
        dim: vector.length,
        model,
        quality,
        liveness,
        antispoof,
        snapshotKey: snapshot.key,
        // ⚠️ OCHIQ URL EMAS — ruxsat tekshiradigan API yo'li
        // (`faceId.events`). Rasm maxfiy yuklangan, havolasi yo'q.
        snapshotUrl: snapshot.key ? `/face-id/samples/${sampleId}/snapshot` : null,
        source,
        kioskId: payload.kioskId || null,
        createdBy: actorId || null,
      },
    });

    // ⚠️ ENG ESKISINI o'chirish — eng SIFATSIZINI emas. Sifat ballari
    // har kamerada boshqa shkalada chiqadi, yosh esa bir xil o'lchanadi:
    // odamning kechagi kadri bir yillik kadridan har doim yaxshiroq.
    const extras = await tx.faceSample.findMany({
      where: { profileId: profile.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, snapshotKey: true },
    });

    let replaced = null;
    if (extras.length > settings.maxSamplesPerPerson) {
      const drop = extras.slice(0, extras.length - settings.maxSamplesPerPerson);
      await tx.faceSample.deleteMany({ where: { id: { in: drop.map((s) => s.id) } } });
      replaced = drop.map((s) => s.snapshotKey).filter(Boolean);
    }

    const remaining = await tx.faceSample.count({ where: { profileId: profile.id } });
    const updated = await tx.faceProfile.update({
      where: { id: profile.id },
      data: { sampleCount: remaining, isActive: true },
    });

    // ⚠️ Versiya TRANZAKSIYA ICHIDA oshiriladi: namuna yozilib versiya
    // oshmasdan qolsa, kiosk eski galereya bilan ishlab turardi.
    const version = await faceGallery.bumpVersion(tx);

    return { profile: updated, sample, replaced, version };
  });

  // Keshni darhol tashlash — shu jarayonda keyingi so'rov yangisini ko'radi.
  faceGallery.invalidate();

  // O'chirilgan namunalarning rasmlari — kutilmaydi va yiqitmaydi.
  for (const key of result.replaced || []) {
    fileStorage.deleteObject(key).catch(() => {});
  }

  return {
    profile: publicProfile(result.profile, user),
    sample: publicSample(result.sample),
    galleryVersion: result.version,
    replacedCount: (result.replaced || []).length,
  };
}

/* ═══════════════════════ O'QISH ═══════════════════════ */

/**
 * ODAMLAR RO'YXATI — ro'yxatga olingan va OLINMAGANLAR BIRGA.
 *
 * ⚠️ Profil jadvalidan EMAS, `User` dan boshlanadi: bo'limning asosiy
 * savoli "kimni ro'yxatga olish kerak" va u faqat profil jadvalidan
 * javob olmaydi. `enrolled=false` filtri shu sababli mumkin bo'ladi.
 *
 * @param {{ role?: string, enrolled?: string, search?: string, classId?: string, page?: *, limit?: * }} query
 */
async function listPeople(query = {}) {
  const { page, limit, skip } = getPaginationParams({ query });

  const where = { ...faceGallery.PERSON_WHERE, role: { not: ROLES.OWNER } };

  if (query.role === "staff") where.role = { notIn: [ROLES.STUDENT, ROLES.OWNER] };
  else if (query.role === "student") where.role = ROLES.STUDENT;

  if (query.classId) where.classes = { some: { classId: query.classId } };

  const search = String(query.search || "").trim();
  const searchWhere = search ? buildNameSearchWhere(search) : null;
  if (searchWhere) Object.assign(where, searchWhere);

  // Ro'yxatga olingan / olinmagan filtri — profil jadvaliga qarab.
  if (query.enrolled === "true") {
    const ids = await prisma.faceProfile.findMany({
      where: { sampleCount: { gt: 0 } },
      select: { userId: true },
    });
    where.id = { in: ids.map((r) => r.userId) };
  } else if (query.enrolled === "false") {
    const ids = await prisma.faceProfile.findMany({
      where: { sampleCount: { gt: 0 } },
      select: { userId: true },
    });
    where.id = { notIn: ids.map((r) => r.userId) };
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: faceGallery.PERSON_SELECT,
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      skip,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  const profiles = await prisma.faceProfile.findMany({
    where: { userId: { in: users.map((u) => u.id) } },
  });
  const byUser = new Map(profiles.map((p) => [p.userId, p]));

  const rows = users.map((user) => {
    const profile = byUser.get(user.id);
    return {
      userId: user.id,
      name: faceGallery.fullName(user),
      role: user.role,
      isActive: user.isActive,
      photo: faceGallery.photoUrl(user),
      enrolled: Boolean(profile && profile.sampleCount > 0),
      profile: profile ? publicProfile(profile, user) : null,
    };
  });

  return formatPaginationResponse(rows, total, page, limit);
}

/** Bitta odamning profili — namunalari bilan. */
async function getProfile(userId) {
  const user = await loadPerson(userId);
  const profile = await prisma.faceProfile.findUnique({
    where: { userId },
    include: { samples: { orderBy: { createdAt: "desc" } } },
  });

  if (!profile) {
    return {
      userId,
      name: faceGallery.fullName(user),
      role: user.role,
      photo: faceGallery.photoUrl(user),
      enrolled: false,
      profile: null,
    };
  }

  return {
    userId,
    name: faceGallery.fullName(user),
    role: user.role,
    photo: faceGallery.photoUrl(user),
    enrolled: profile.sampleCount > 0,
    profile: publicProfile(profile, user),
  };
}

/* ═══════════════════════ O'CHIRISH ═══════════════════════ */

/**
 * Bitta namunani o'chiradi.
 *
 * ⚠️ Rasm ham o'chiriladi (kutilmaydi): biometrika olib tashlangan
 * bo'lsa, uning rasmi turib qolishining ma'nosi yo'q.
 */
async function removeSample(sampleId, actorId) {
  if (!isValidId(sampleId)) throw new BadRequestError("Namuna ID noto'g'ri");

  const sample = await prisma.faceSample.findUnique({
    where: { id: sampleId },
    select: { id: true, profileId: true, snapshotKey: true },
  });
  if (!sample) throw new NotFoundError("Namuna topilmadi");

  const result = await prisma.$transaction(async (tx) => {
    await tx.faceSample.delete({ where: { id: sampleId } });
    const remaining = await tx.faceSample.count({ where: { profileId: sample.profileId } });
    const profile = await tx.faceProfile.update({
      where: { id: sample.profileId },
      data: { sampleCount: remaining },
    });
    const version = await faceGallery.bumpVersion(tx);
    return { profile, version };
  });

  faceGallery.invalidate();
  if (sample.snapshotKey) fileStorage.deleteObject(sample.snapshotKey).catch(() => {});

  logger.info(`Face ID: namuna o'chirildi (${sampleId}) — ${actorId || "tizim"}`);

  return { deleted: true, sampleCount: result.profile.sampleCount, galleryVersion: result.version };
}

/**
 * PROFILNI BUTUNLAY O'CHIRADI — odamni Face ID tizimidan chiqaradi.
 *
 * ⚠️ URINISHLAR JURNALIGA TEGMAYDI (`FaceCheckEvent`): u append-only
 * jurnal va "o'tgan oyda bu odam qanday kelgan" degan savolning javobi.
 * Biometrika o'chadi, fakt qoladi.
 */
async function removeProfile(userId, actorId) {
  if (!isValidId(userId)) throw new BadRequestError("Foydalanuvchi ID noto'g'ri");

  const profile = await prisma.faceProfile.findUnique({
    where: { userId },
    include: { samples: { select: { snapshotKey: true } } },
  });
  if (!profile) throw new NotFoundError("Yuz profili topilmadi");

  const keys = profile.samples.map((s) => s.snapshotKey).filter(Boolean);

  const version = await prisma.$transaction(async (tx) => {
    // `onDelete: Cascade` namunalarni o'zi oladi.
    await tx.faceProfile.delete({ where: { id: profile.id } });
    return faceGallery.bumpVersion(tx);
  });

  faceGallery.invalidate();
  for (const key of keys) fileStorage.deleteObject(key).catch(() => {});

  logger.info(`Face ID: profil o'chirildi (${userId}) — ${actorId || "tizim"}`);

  return { deleted: true, removedSamples: keys.length, galleryVersion: version };
}

/**
 * Profilni vaqtincha o'chirish / yoqish.
 *
 * ⚠️ `removeProfile` DAN FARQI: namunalar QOLADI, faqat taqqoslashga
 * kirmaydi. "Yuzi juda o'zgargan, qayta olishim kerak, lekin eski
 * kadrlarni hali o'chirmayin" holati uchun.
 */
async function setProfileActive(userId, isActive, note, actorId) {
  const user = await loadPerson(userId);
  const profile = await prisma.faceProfile.findUnique({ where: { userId } });
  if (!profile) throw new NotFoundError("Yuz profili topilmadi");

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.faceProfile.update({
      where: { id: profile.id },
      data: {
        isActive: Boolean(isActive),
        note: note === undefined ? undefined : String(note || "").trim().slice(0, NOTE_MAX),
      },
    });
    await faceGallery.bumpVersion(tx);
    return row;
  });

  faceGallery.invalidate();
  return publicProfile(updated, user);
}

/**
 * MOS KELISHNI YOZIB QO'YADI — "bu profil ishlayaptimi" savolining javobi.
 *
 * ⚠️ Kutilmaydi va yiqitmaydi: davomat allaqachon yozilgan, bu esa
 * statistika. `activityService.touchPanel` bilan ayni qaror.
 */
function recordMatch(userId, score) {
  if (!userId) return;
  prisma.faceProfile
    .update({
      where: { userId },
      data: {
        lastMatchedAt: new Date(),
        lastScore: typeof score === "number" ? score : null,
        matchCount: { increment: 1 },
      },
    })
    .catch(() => {});
}

module.exports = {
  addSample,
  listPeople,
  getProfile,
  removeSample,
  removeProfile,
  setProfileActive,
  recordMatch,
  storeSnapshot,
  publicProfile,
  publicSample,
  SAMPLE_SOURCES,
  MAX_SNAPSHOT_BYTES,
};
