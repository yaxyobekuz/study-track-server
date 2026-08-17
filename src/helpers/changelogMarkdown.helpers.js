// ─────────────────────────────────────────────
// changes/*.md FAYLLARINI O'QISH
// ─────────────────────────────────────────────
// `changes/` papkasidagi markdown fayl formati bitta joyda — shu faylda —
// ta'riflanadi. CLI import script shu helper'ni ishlatadi.
//
// Yangi paket qo'shilmaydi: 6 ta kalitli frontmatter uchun to'liq YAML parser
// ortiqcha (repoda gray-matter/js-yaml yo'q).
//
// Fayl namunasi (changes/2026-08-17-admin.md):
//
//   ---
//   panel: admin
//   date: 2026-08-17
//   bump: minor
//   title: O'zgarishlar tarixi sahifasi qo'shildi
//   status: draft
//   version:
//   ---
//
//   - Birinchi o'zgarish
//   - Ikkinchi o'zgarish
//
//   ## Nega kerak edi
//
//   Izoh matni.

const { ValidationError } = require("../utils/errors");
const { isValidBump } = require("./semver.helpers");

const PANELS = ["admin", "teacher", "student", "server", "bot"];

const STATUSES = ["draft", "published"];

// "2026-08-17-admin.md" → ["2026-08-17", "admin"]
const FILE_NAME_RE = /^(\d{4}-\d{2}-\d{2})-([a-z]+)\.md$/;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Frontmatter bloki: fayl boshidagi --- ... --- orasi
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// "## Nega kerak edi" (yoki boshqa sarlavha) — shu yerdan keyingisi izoh
const NOTES_HEADING_RE = /^##\s+/;

// Markdown bullet: "- matn" yoki "* matn"
const BULLET_RE = /^\s*[-*]\s+/;

/**
 * Sanani UTC yarim tuniga normallashtiradi.
 *
 * Soat saqlanmasligi shart: `@@unique([date, panel])` cheklovi shunga tayanadi.
 * UTC ishlatiladi — local timezone'da `new Date("2026-08-17")` kun oldinga yoki
 * orqaga siljib ketishi mumkin.
 *
 * @param {string|Date} value "YYYY-MM-DD" yoki Date
 * @returns {Date}
 */
function normalizeDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ValidationError("Sana noto'g'ri");
    }

    return new Date(
      Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
    );
  }

  const raw = String(value ?? "").trim();
  if (!DATE_RE.test(raw)) {
    throw new ValidationError("Sana YYYY-MM-DD ko'rinishida bo'lishi kerak");
  }

  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError("Sana noto'g'ri");
  }

  return date;
}

/**
 * Date → "YYYY-MM-DD" (UTC bo'yicha).
 * @param {Date} date
 * @returns {string}
 */
function formatDateKey(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * `xss-clean` middleware `req.body` dagi burchak qavslarni HTML entity'ga
 * aylantiradi. Admin forma orqali kelgan matnni o'qiy oladigan holga qaytaradi.
 * CLI yo'li Express'dan o'tmaydi, lekin bir xil ko'rinish uchun u ham qo'llaydi.
 *
 * @param {string} value
 * @returns {string}
 */
function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Frontmatter bloki (`key: value` satrlari) → obyekt.
 * Qiymatdagi qo'shtirnoq/apostroflar olib tashlanadi, `#` izohi kesiladi.
 *
 * @param {string} block
 * @returns {Record<string, string>}
 */
function parseFrontmatter(block) {
  const result = {};

  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf(":");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();

    // Qiymat tirnoq ichida bo'lmasa, `#` dan keyingisi izoh
    const isQuoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));

    if (isQuoted) {
      const quote = value[0];
      // Tirnoq ichidagi ekranlangan belgilar: \" → "  va  \\ → \
      value = value
        .slice(1, -1)
        .replace(new RegExp(`\\\\${quote}`, "g"), quote)
        .replace(/\\\\/g, "\\");
    } else {
      const comment = value.indexOf(" #");
      if (comment !== -1) value = value.slice(0, comment).trim();
    }

    result[key] = value;
  }

  return result;
}

/**
 * Markdown tanasini bulletlar (`items`) va izohga (`notes`) ajratadi.
 *
 * @param {string} body
 * @returns {{items: string[], notes: string}}
 */
function parseBody(body) {
  const items = [];
  const notes = [];
  let inNotes = false;

  for (const line of String(body ?? "").split(/\r?\n/)) {
    if (NOTES_HEADING_RE.test(line.trim())) {
      inNotes = true;
      continue;
    }

    if (inNotes) {
      notes.push(line);
      continue;
    }

    if (BULLET_RE.test(line)) {
      const item = line.replace(BULLET_RE, "").trim();
      if (item) items.push(decodeEntities(item));
    }
  }

  return { items, notes: decodeEntities(notes.join("\n").trim()) };
}

/**
 * Bitta `changes/*.md` faylini o'qib, tekshirilgan obyektga aylantiradi.
 *
 * Xato bo'lsa `ValidationError` otadi — chaqiruvchi shu faylni o'tkazib
 * yuboradi, butun paketni to'xtatmaydi.
 *
 * @param {string} fileName "2026-08-17-admin.md"
 * @param {string} content faylning to'liq matni
 * @returns {{
 *   panel: string, date: Date, dateKey: string, bump: string,
 *   title: string, items: string[], notes: string,
 *   status: string, version: string|null, sourceFile: string
 * }}
 */
function parseChangelogFile(fileName, content) {
  const nameMatch = FILE_NAME_RE.exec(fileName);
  if (!nameMatch) {
    throw new ValidationError(
      "Fayl nomi YYYY-MM-DD-<panel>.md ko'rinishida bo'lishi kerak",
    );
  }

  const [, nameDate, namePanel] = nameMatch;

  const frontmatterMatch = FRONTMATTER_RE.exec(String(content ?? "").trimStart());
  if (!frontmatterMatch) {
    throw new ValidationError("Frontmatter (--- ... ---) topilmadi");
  }

  const meta = parseFrontmatter(frontmatterMatch[1]);
  const { items, notes } = parseBody(frontmatterMatch[2]);

  // Fayl nomi bilan frontmatter mos kelmasa — bu deyarli har doim xato
  // (fayl nusxa ko'chirilgan, ichi tahrirlanmagan).
  const panel = (meta.panel || namePanel).trim();
  const dateKey = (meta.date || nameDate).trim();

  if (panel !== namePanel) {
    throw new ValidationError(
      `Fayl nomidagi panel ("${namePanel}") frontmatter'dagidan ("${panel}") farq qiladi`,
    );
  }

  if (dateKey !== nameDate) {
    throw new ValidationError(
      `Fayl nomidagi sana ("${nameDate}") frontmatter'dagidan ("${dateKey}") farq qiladi`,
    );
  }

  if (!PANELS.includes(panel)) {
    throw new ValidationError(
      `Noma'lum panel "${panel}". Ruxsat etilganlari: ${PANELS.join(", ")}`,
    );
  }

  const bump = (meta.bump || "patch").trim();
  if (!isValidBump(bump)) {
    throw new ValidationError(
      `Noma'lum daraja "${bump}". Ruxsat etilganlari: major, minor, patch`,
    );
  }

  const status = (meta.status || "draft").trim();
  if (!STATUSES.includes(status)) {
    throw new ValidationError(
      `Noma'lum holat "${status}". Ruxsat etilganlari: draft, published`,
    );
  }

  const title = decodeEntities(meta.title || "").trim();
  if (!title && items.length === 0) {
    throw new ValidationError("Sarlavha ham, o'zgarishlar ro'yxati ham bo'sh");
  }

  return {
    panel,
    date: normalizeDate(dateKey),
    dateKey,
    bump,
    title,
    items,
    notes,
    status,
    version: (meta.version || "").trim() || null,
    sourceFile: fileName,
  };
}

/**
 * Fayl matnidagi frontmatter qiymatlarini yangilaydi (tana tegilmaydi).
 * Import muvaffaqiyatli bo'lgach `status: published` va `version: X.Y.Z`
 * yozib qo'yish uchun.
 *
 * Kalit frontmatter'da bo'lmasa — oxiriga qo'shiladi.
 *
 * @param {string} content
 * @param {Record<string, string>} updates
 * @returns {string}
 */
function updateFrontmatter(content, updates) {
  const source = String(content ?? "");
  const match = FRONTMATTER_RE.exec(source.trimStart());
  if (!match) return source;

  const lines = match[1].split(/\r?\n/);
  const pending = { ...updates };

  const next = lines.map((line) => {
    const separator = line.indexOf(":");
    if (separator === -1) return line;

    const key = line.slice(0, separator).trim();
    if (!(key in pending)) return line;

    const value = pending[key];
    delete pending[key];
    return `${key}: ${value}`;
  });

  for (const [key, value] of Object.entries(pending)) {
    next.push(`${key}: ${value}`);
  }

  return `---\n${next.join("\n")}\n---\n${match[2]}`;
}

module.exports = {
  PANELS,
  STATUSES,
  normalizeDate,
  formatDateKey,
  decodeEntities,
  parseChangelogFile,
  updateFrontmatter,
};
