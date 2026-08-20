const prisma = require("../config/prisma");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");
const { NotFoundError, ValidationError } = require("../utils/errors");
const {
  parseVersion,
  formatVersion,
  bumpVersion,
  isValidBump,
  BUMPS,
} = require("../helpers/semver.helpers");
const { PANELS, normalizeDate, decodeEntities } = require("../helpers/changelogMarkdown.helpers");

// Versiya to'qnashuvida necha marta qayta urinish (pastdagi izohga qarang)
const VERSION_RETRY_ATTEMPTS = 3;

// Kiruvchi ma'lumotdan xavfsiz maydonlarni ajratadi.
// `version` va `major/minor/patch` bu yerda YO'Q — ular alohida, nazorat ostida
// hisoblanadi (mijoz versiyani ixtiyoriy ravishda o'zgartira olmasligi kerak).
function pickChangelogFields(data = {}) {
  const fields = {};

  if (data.title !== undefined) fields.title = decodeEntities(data.title || "").trim();
  if (data.notes !== undefined) fields.notes = decodeEntities(data.notes || "").trim();

  if (data.items !== undefined) {
    fields.items = Array.isArray(data.items)
      ? data.items
          .filter((item) => typeof item === "string")
          .map((item) => decodeEntities(item).trim())
          .filter(Boolean)
      : [];
  }

  if (data.sourceFile !== undefined) fields.sourceFile = data.sourceFile || null;

  return fields;
}

// Panel nomini tekshiradi
function assertPanel(panel) {
  if (!PANELS.includes(panel)) {
    throw new ValidationError(
      `Noma'lum panel "${panel}". Ruxsat etilganlari: ${PANELS.join(", ")}`,
    );
  }
}

// Bump darajasini tekshiradi
function assertBump(bump) {
  if (!isValidBump(bump)) {
    throw new ValidationError(
      `Noma'lum daraja "${bump}". Ruxsat etilganlari: ${BUMPS.join(", ")}`,
    );
  }
}

// "1.4.2" → { version, major, minor, patch }
function resolveExplicitVersion(value) {
  const parts = parseVersion(value);
  if (!parts) {
    throw new ValidationError("Versiya 0.0.0 ko'rinishida bo'lishi kerak");
  }

  return { ...parts, version: formatVersion(parts) };
}

/**
 * Panelning ENG YUQORI versiyasini topib, bump bo'yicha keyingisini qaytaradi.
 *
 * Sana bo'yicha oxirgi yozuv EMAS, aynan eng yuqori versiya olinadi — shuning
 * uchun o'tgan kunga yozuv qo'shilsa ham versiya orqaga ketmaydi.
 *
 * @param {string} panel
 * @param {"major"|"minor"|"patch"} bump
 * @param {object} client - prisma yoki transaction client
 * @returns {Promise<{version: string, major: number, minor: number, patch: number}>}
 */
async function computeNextVersion(panel, bump, client = prisma) {
  const top = await client.changelog.findFirst({
    where: { panel },
    orderBy: [{ major: "desc" }, { minor: "desc" }, { patch: "desc" }],
    select: { major: true, minor: true, patch: true },
  });

  const next = bumpVersion(top, bump);
  return { ...next, version: formatVersion(next) };
}

/**
 * O'sha kun + panel uchun keyingi reliz raqami.
 *
 * Bir kunda bir panelga bir nechta reliz chiqarish mumkin: birinchisi 1,
 * keyingisi 2 va h.k. Qo'lda yaratishda mijoz raqamni o'ylab o'tirmaydi.
 *
 * @param {Date} date
 * @param {string} panel
 * @param {object} client
 * @returns {Promise<number>}
 */
async function nextSeq(date, panel, client = prisma) {
  const top = await client.changelog.findFirst({
    where: { date, panel },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });

  return (top?.seq || 0) + 1;
}

// Prisma unique cheklov xatosini aniqlaydi
function isUniqueError(error, field) {
  if (error?.code !== "P2002") return false;

  const target = error.meta?.target;
  const asText = Array.isArray(target) ? target.join(",") : String(target || "");
  return asText.includes(field);
}

/**
 * Yozuvni versiyani qayta hisoblab yaratadi.
 *
 * `findFirst` + `create` — o'qib-yozish ketma-ketligi. Buni `$transaction`
 * YECHMAYDI: bu lost update emas, phantom (hali mavjud bo'lmagan qatorni
 * qulflab bo'lmaydi). Haqiqiy kafolat — `@@unique([panel, version])` cheklovi;
 * to'qnashuv bo'lsa versiyani qayta hisoblab urinamiz.
 *
 * @param {() => Promise<object>} buildData - har urinishda qaytadan chaqiriladi
 */
async function createWithVersionRetry(buildData) {
  for (let attempt = 0; attempt < VERSION_RETRY_ATTEMPTS; attempt++) {
    try {
      return await prisma.changelog.create({ data: await buildData() });
    } catch (error) {
      if (isUniqueError(error, "version") && attempt < VERSION_RETRY_ATTEMPTS - 1) {
        continue;
      }

      if (isUniqueError(error, "date")) {
        throw new ValidationError("Bu reliz allaqachon mavjud");
      }

      throw error;
    }
  }

  // Bu yerga yetib kelmaydi — oxirgi urinish yo qaytaradi, yo otadi
  throw new ValidationError("Versiya band, qaytadan urinib ko'ring");
}

// Ro'yxat — sahifalangan, filtrlar bilan
async function getChangelogs(req) {
  const { page, limit, skip } = getPaginationParams(req);
  const { panel, from, to, search } = req.query;

  const filter = {};

  if (panel && panel !== "all") {
    assertPanel(panel);
    filter.panel = panel;
  }

  if (from || to) {
    filter.date = {};
    if (from) filter.date.gte = normalizeDate(from);
    if (to) filter.date.lte = normalizeDate(to);
  }

  if (search) {
    // `items` — String[]. Prisma unda QISM satr bo'yicha qidira olmaydi
    // (`has` aniq tenglikni tekshiradi va yozib qidirishda hech qachon
    // topmaydi). Shuning uchun mos keladigan id'lar oldindan raw so'rov
    // bilan olinadi — yozuvlar kam, bu arzon.
    const pattern = `%${search}%`;
    const hits = await prisma.$queryRaw`
      SELECT id FROM changelogs
      WHERE EXISTS (SELECT 1 FROM unnest(items) AS i WHERE i ILIKE ${pattern})
    `;

    filter.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { notes: { contains: search, mode: "insensitive" } },
      { id: { in: hits.map((row) => row.id) } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.changelog.findMany({
      where: filter,
      orderBy: [{ date: "desc" }, { panel: "asc" }, { seq: "desc" }],
      skip,
      take: limit,
    }),
    prisma.changelog.count({ where: filter }),
  ]);

  return formatPaginationResponse(data, total, page, limit);
}

async function getChangelogById(id) {
  const entry = await prisma.changelog.findUnique({ where: { id } });
  if (!entry) throw new NotFoundError("O'zgarish yozuvi topilmadi");

  return entry;
}

/**
 * Har bir panelning joriy versiyasi — sahifa sarlavhasi uchun.
 *
 * `nextVersion` ham qaytariladi: admin formada "keyingi versiya: 0.1.0"
 * maslahatini ko'rsatish uchun mijozda semver mantiq takrorlanmasin.
 */
async function getPanelVersions() {
  const [tops, counts] = await Promise.all([
    Promise.all(
      PANELS.map((panel) =>
        prisma.changelog.findFirst({
          where: { panel },
          orderBy: [{ major: "desc" }, { minor: "desc" }, { patch: "desc" }],
          select: { version: true, major: true, minor: true, patch: true, date: true, title: true },
        }),
      ),
    ),
    prisma.changelog.groupBy({ by: ["panel"], _count: { _all: true } }),
  ]);

  const countByPanel = Object.fromEntries(
    counts.map((row) => [row.panel, row._count._all]),
  );

  return PANELS.map((panel, index) => {
    const top = tops[index];

    return {
      panel,
      version: top?.version || "0.0.0",
      lastDate: top?.date || null,
      lastTitle: top?.title || "",
      entryCount: countByPanel[panel] || 0,
      nextVersion: Object.fromEntries(
        BUMPS.map((bump) => [bump, formatVersion(bumpVersion(top, bump))]),
      ),
    };
  });
}

/**
 * Yangi yozuv. Versiya `bump` asosida hisoblanadi (yoki `version` bilan
 * qo'lda beriladi).
 */
async function createChangelog(data, createdBy) {
  const { panel, date, bump = "patch", version } = data;

  assertPanel(panel);
  assertBump(bump);

  const normalizedDate = normalizeDate(date);
  const fields = pickChangelogFields(data);

  if (!fields.title && (fields.items || []).length === 0) {
    throw new ValidationError("Sarlavha yoki o'zgarishlar ro'yxati kiritilishi kerak");
  }

  // Reliz raqami: berilmasa o'sha kun+panel uchun keyingisi olinadi.
  // Ya'ni bir kunda ikkinchi marta yozuv qo'shsangiz xato emas — 2-reliz bo'ladi.
  const seq = data.seq ? Number(data.seq) : await nextSeq(normalizedDate, panel);

  // Qo'lda berilgan versiya bo'lsa qayta urinishning ma'nosi yo'q
  if (version) {
    const explicit = resolveExplicitVersion(version);

    try {
      return await prisma.changelog.create({
        data: { ...fields, panel, seq, date: normalizedDate, bump, ...explicit, createdBy },
      });
    } catch (error) {
      if (isUniqueError(error, "version")) {
        throw new ValidationError(`"${explicit.version}" versiyasi bu panelda allaqachon bor`);
      }
      if (isUniqueError(error, "date")) {
        throw new ValidationError("Bu reliz allaqachon mavjud");
      }
      throw error;
    }
  }

  return createWithVersionRetry(async () => {
    const computed = await computeNextVersion(panel, bump);
    return { ...fields, panel, seq, date: normalizedDate, bump, ...computed, createdBy };
  });
}

/**
 * Tahrirlash. Versiya QAYTA HISOBLANMAYDI — `bump` faqat yaratish vaqtidagi
 * tushuncha. Imlo xatosini tuzatish tizim egasi allaqachon ko'rgan versiyani
 * siljitmasligi kerak. Versiyani ataylab o'zgartirish uchun `version` beriladi.
 */
async function updateChangelog(id, data) {
  await getChangelogById(id);

  const fields = pickChangelogFields(data);

  if (data.date !== undefined) fields.date = normalizeDate(data.date);

  if (data.panel !== undefined) {
    assertPanel(data.panel);
    fields.panel = data.panel;
  }

  if (data.version !== undefined && data.version !== "") {
    Object.assign(fields, resolveExplicitVersion(data.version));
  }

  try {
    return await prisma.changelog.update({ where: { id }, data: fields });
  } catch (error) {
    if (isUniqueError(error, "version")) {
      throw new ValidationError("Bu versiya ushbu panelda allaqachon bor");
    }
    if (isUniqueError(error, "date")) {
      throw new ValidationError("Bu sana uchun ushbu panelda yozuv allaqachon mavjud");
    }
    throw error;
  }
}

// Qattiq o'chirish — bu yozuvlarga hech narsa bog'lanmagan
async function deleteChangelog(id) {
  await getChangelogById(id);
  return prisma.changelog.delete({ where: { id } });
}

/**
 * CLI import uchun: `(date, panel, seq)` bo'yicha yaratadi yoki yangilaydi.
 *
 * `seq` fayl nomidan keladi: "2026-08-17-admin.md" → 1,
 * "2026-08-17-admin-2.md" → 2. Ya'ni bir kunda bir panelga bir nechta reliz
 * chiqarish mumkin, lekin ayni fayl qayta yuklanganda dublikat yaratilmaydi.
 *
 * Mavjud yozuv topilsa MATN yangilanadi, VERSIYA saqlanadi — shu sababli
 * `/changelog` ni necha marta ishga tushirsangiz ham natija bir xil bo'ladi.
 *
 * DIQQAT: chaqiruvchi buni KETMA-KET (`for...of` + `await`) chaqirishi shart.
 * Parallel chaqirilsa bitta panelning fayllari bir xil "eng yuqori versiya"ni
 * o'qib, keraksiz qayta urinishlarga sabab bo'ladi.
 *
 * @param {object} parsed - `parseChangelogFile` natijasi
 * @param {string|null} createdBy
 * @returns {Promise<{action: "created"|"updated", entry: object}>}
 */
async function upsertFromFile(parsed, createdBy = null) {
  const { panel, seq = 1, date, bump, title, items, notes, version, sourceFile } = parsed;

  assertPanel(panel);
  assertBump(bump);

  const existing = await prisma.changelog.findUnique({
    where: { date_panel_seq: { date, panel, seq } },
  });

  if (existing) {
    const fields = { title, items, notes, sourceFile };

    // Faylda aniq versiya ko'rsatilgan bo'lsa — faqat shunda versiya o'zgaradi
    if (version && version !== existing.version) {
      Object.assign(fields, resolveExplicitVersion(version));
    }

    const entry = await prisma.changelog.update({ where: { id: existing.id }, data: fields });
    return { action: "updated", entry };
  }

  const fields = { panel, seq, date, bump, title, items, notes, sourceFile, createdBy };

  if (version) {
    const entry = await prisma.changelog.create({
      data: { ...fields, ...resolveExplicitVersion(version) },
    });
    return { action: "created", entry };
  }

  const entry = await createWithVersionRetry(async () => {
    const computed = await computeNextVersion(panel, bump);
    return { ...fields, ...computed };
  });

  return { action: "created", entry };
}

module.exports = {
  getChangelogs,
  getChangelogById,
  getPanelVersions,
  computeNextVersion,
  createChangelog,
  updateChangelog,
  deleteChangelog,
  upsertFromFile,
};
