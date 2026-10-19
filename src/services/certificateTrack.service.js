/**
 * SERTIFIKAT YO'NALISHLARI KATALOGI (`CertificateTrack`).
 *
 * Yo'nalish — "IELTS", "CEFR", "SAT", "Ona tili", "Matematika". Ular
 * MAKTAB FANI BO'LISHI SHART EMAS, shuning uchun katalog alohida turadi va
 * `Subject` ga bog'lanish IXTIYORIY.
 *
 * ⚠️ Fanga bog'lanish — MAVZU PROGRESSINING yagona kaliti. Bog'lanmagan
 * yo'nalishda ekranda "mavzu ro'yxati bog'lanmagan" deb OCHIQ turadi:
 * IELTS ning maktab mavzulari yo'q va bor-u yo'q foizni ko'rsatish
 * o'quvchini chalg'itardi.
 *
 * ⚠️ O'CHIRILMAYDI — ARXIVLANADI. Yo'nalishga o'tgan rejalar ishora qiladi
 * (`certificate_plans.track_id`, `onDelete: Restrict`), ya'ni o'chirish
 * bazada ham to'siladi. `Tariff` va `DeviceApp` bilan AYNI qaror.
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError, ConflictError } = require("../utils/errors");
const { isValidId } = require("../utils/objectId");
const { normalizeName, PLAN_SOURCE, ACTIVE_STATUS } = require("../helpers/certificate.helpers");

const NAME_MAX = 80;

/** Bir importda yaratiladigan yangi yo'nalishlar chegarasi. */
const IMPORT_TRACK_MAX = 50;

const TRACK_SELECT = {
  id: true,
  name: true,
  subjectId: true,
  isActive: true,
  source: true,
  createdAt: true,
  subject: { select: { id: true, name: true, isActive: true } },
};

/* ─────────────────────────── kirish ─────────────────────────── */

function parseName(value) {
  const name = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) throw new BadRequestError("Yo'nalish nomi kiritilishi shart");
  if (name.length > NAME_MAX) {
    throw new BadRequestError(`Yo'nalish nomi ${NAME_MAX} belgidan oshmasligi kerak`);
  }
  return name;
}

/**
 * Fan bog'lanishi: id | `null` (bog'lanmagan).
 *
 * ⚠️ ARXIVLANGAN fanga bog'lab bo'lmaydi: uning mavzulari yangilanmaydi va
 * progress jimgina muzlab qolardi.
 */
async function parseSubjectId(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "" || value === "none") return null;

  if (!isValidId(value)) throw new BadRequestError("Fan tanlovi noto'g'ri");

  const subject = await prisma.subject.findUnique({
    where: { id: value },
    select: { id: true, isActive: true },
  });
  if (!subject) throw new NotFoundError("Fan topilmadi");
  if (!subject.isActive) {
    throw new BadRequestError("Arxivlangan fanga bog'lab bo'lmaydi");
  }

  return subject.id;
}

/* ─────────────────────────── o'qish ─────────────────────────── */

/**
 * Katalog ro'yxati.
 *
 * ⚠️ SAHIFALANMAYDI va bu ataylab: yo'nalishlar soni tabiiy chegaralangan
 * (o'nlab qator), ro'yxat esa tanlov (`select`) uchun ham ishlatiladi —
 * sahifalangan tanlov yarim ro'yxat ko'rsatardi (`devices.md` §10 bilan
 * AYNI mulohaza).
 *
 * @param {{includeArchived?: boolean, withUsage?: boolean}} [options]
 */
async function listTracks({ includeArchived = false, withUsage = false } = {}) {
  const tracks = await prisma.certificateTrack.findMany({
    where: includeArchived ? {} : { isActive: true },
    select: TRACK_SELECT,
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });

  if (!withUsage || tracks.length === 0) {
    return tracks.map((track) => ({ ...track, activePlans: null }));
  }

  // "Bu yo'nalishni nechta o'quvchi rejalashtirgan" — arxivlashdan oldin
  // ko'rinib turishi kerak.
  const counts = await prisma.certificatePlan.groupBy({
    by: ["trackId"],
    where: { trackId: { in: tracks.map((t) => t.id) }, status: ACTIVE_STATUS },
    _count: { _all: true },
  });
  const byTrack = new Map(counts.map((row) => [row.trackId, row._count._all]));

  return tracks.map((track) => ({ ...track, activePlans: byTrack.get(track.id) ?? 0 }));
}

/* ─────────────────────────── yozish ─────────────────────────── */

async function createTrack({ name, subjectId }, { actorId }) {
  const cleanName = parseName(name);
  const subject = await parseSubjectId(subjectId);

  const existing = await prisma.certificateTrack.findUnique({
    where: { name: cleanName },
    select: { id: true, isActive: true },
  });
  if (existing) {
    throw new ConflictError(
      existing.isActive
        ? "Bu nomli yo'nalish allaqachon bor"
        : "Bu nomli yo'nalish arxivda — uni arxivdan qaytaring",
    );
  }

  return prisma.certificateTrack.create({
    data: {
      name: cleanName,
      subjectId: subject ?? null,
      source: PLAN_SOURCE.MANUAL,
      createdBy: actorId,
    },
    select: TRACK_SELECT,
  });
}

async function updateTrack(id, { name, subjectId, isActive }) {
  const track = await prisma.certificateTrack.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!track) throw new NotFoundError("Yo'nalish topilmadi");

  const data = {};

  if (name !== undefined) {
    const cleanName = parseName(name);
    if (cleanName !== track.name) {
      const clash = await prisma.certificateTrack.findUnique({
        where: { name: cleanName },
        select: { id: true },
      });
      if (clash && clash.id !== id) throw new ConflictError("Bu nomli yo'nalish allaqachon bor");
      data.name = cleanName;
    }
  }

  if (subjectId !== undefined) data.subjectId = await parseSubjectId(subjectId);

  if (isActive !== undefined) {
    data.isActive = Boolean(isActive);
    // ⚠️ Faol rejasi bor yo'nalish arxivlanmaydi: u statistikadan va
    // o'quvchi ekranidan JIMGINA tushib qolardi. Avval rejalar bekor
    // qilinadi yoki boshqa yo'nalishga o'tkaziladi.
    if (data.isActive === false) {
      const active = await prisma.certificatePlan.count({
        where: { trackId: id, status: ACTIVE_STATUS },
      });
      if (active > 0) {
        throw new ConflictError(
          `Bu yo'nalishda ${active} ta faol reja bor — avval ularni bekor qiling`,
        );
      }
    }
  }

  if (Object.keys(data).length === 0) {
    return prisma.certificateTrack.findUnique({ where: { id }, select: TRACK_SELECT });
  }

  return prisma.certificateTrack.update({ where: { id }, data, select: TRACK_SELECT });
}

/* ─────────────────────── import uchun ─────────────────────── */

/**
 * NOMLAR BO'YICHA YO'NALISHLARNI TAYYORLAYDI (import yo'li).
 *
 * Faylda yo'nalish MATN bilan keladi ("Ona tili", "CEFR"). Yo'q bo'lsa
 * yaratiladi va maktab fani bilan AYNI nomli bo'lsa, fanga AVTOMATIK
 * bog'lanadi.
 *
 * ⚠️ MOSLASHTIRISH TAXMIN QILMAYDI: faqat QAT'IY TENG nom (apostrof va
 * registr farqisiz) avtomatik bog'lanadi. "Ingliz tili" ni "IELTS" ga
 * bog'lash — odamning qarori, chunki u progress raqamini belgilaydi
 * (`education.md` §10 — sheet moslashtirishdagi AYNI doktrina).
 *
 * ⚠️ ARXIVLANGAN yo'nalish QAYTA FAOLLASHTIRILMAYDI: arxivlash — ongli
 * qaror va import uni jimgina bekor qilmasligi kerak. Bunday nom
 * `archived` bo'lib qaytadi va qator moslanmagan ro'yxatga tushadi.
 *
 * @param {string[]} names
 * @param {{actorId: string}} options
 * @returns {Promise<{byName: Map<string, object>, created: string[], archived: string[]}>}
 *   `byName` kaliti — `normalizeName(nom)`
 */
async function ensureTracksByName(names, { actorId }) {
  const wanted = new Map();
  for (const raw of names || []) {
    const name = String(raw ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!name) continue;
    const key = normalizeName(name);
    if (!wanted.has(key)) wanted.set(key, name);
  }

  const byName = new Map();
  const created = [];
  const archived = [];
  if (wanted.size === 0) return { byName, created, archived };

  const existing = await prisma.certificateTrack.findMany({ select: TRACK_SELECT });
  const existingByKey = new Map(existing.map((track) => [normalizeName(track.name), track]));

  const missing = [];
  for (const [key, name] of wanted) {
    const track = existingByKey.get(key);
    if (!track) {
      missing.push({ key, name });
    } else if (!track.isActive) {
      archived.push(track.name);
    } else {
      byName.set(key, track);
    }
  }

  if (missing.length > IMPORT_TRACK_MAX) {
    throw new BadRequestError(
      `Faylda ${missing.length} ta yangi yo'nalish bor — ustun to'g'ri tanlanganini tekshiring`,
    );
  }

  if (missing.length > 0) {
    // Fanga avtomatik bog'lash — FAQAT qat'iy teng nom
    const subjects = await prisma.subject.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
    });
    const subjectByKey = new Map(subjects.map((s) => [normalizeName(s.name), s.id]));

    await prisma.certificateTrack.createMany({
      data: missing.map(({ key, name }) => ({
        name,
        subjectId: subjectByKey.get(key) ?? null,
        source: PLAN_SOURCE.IMPORT,
        createdBy: actorId,
      })),
      skipDuplicates: true,
    });

    const fresh = await prisma.certificateTrack.findMany({
      where: { name: { in: missing.map((row) => row.name) } },
      select: TRACK_SELECT,
    });
    for (const track of fresh) {
      byName.set(normalizeName(track.name), track);
      created.push(track.name);
    }
  }

  return { byName, created, archived };
}

module.exports = {
  NAME_MAX,
  TRACK_SELECT,
  listTracks,
  createTrack,
  updateTrack,
  ensureTracksByName,
};
