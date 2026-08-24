// ─────────────────────────────────────────────
// CHANGELOG → TELEGRAM XABARI
// ─────────────────────────────────────────────
// Yozuvlarni tizim egasi o'qiydigan xabarga aylantiradi.
//
// Ikkita qattiq cheklov bor:
//  1. `telegram.service.js` DOIM `parse_mode: "HTML"` yuboradi, changelog
//     matni esa erkin matn. Escape qilinmasa Telegram butun xabarni rad etadi.
//  2. Telegram bitta xabarda 4096 belgidan ko'pini qabul qilmaydi.

const { formatDateUz: formatDate } = require("./date.helpers");

// Telegram cheklovi 4096; sarlavha va "1/3" belgisi uchun zapas qoldiramiz.
const TELEGRAM_MAX = 4096;
const SAFE_LIMIT = 3800;

const PANEL_LABELS = {
  admin: "Admin panel",
  teacher: "O'qituvchi paneli",
  student: "O'quvchi paneli",
  server: "Server",
  bot: "Telegram bot",
};

/**
 * HTML parse_mode uchun xavfsiz matn.
 *
 * `&` ENG BIRINCHI almashtirilishi shart — aks holda keyingi qadamlarda
 * paydo bo'lgan `&lt;` dagi `&` qayta escape qilinib `&amp;lt;` bo'lib ketadi.
 *
 * Bazada matn allaqachon dekodlangan holda yotadi (`changelog.service.js`
 * `decodeEntities` qo'llaydi), shuning uchun bu yerda aynan bitta o'tish bo'ladi.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * UTC yarim tunidagi sanani "17-avgust, 2026" ko'rinishiga keltiradi.
 *
 * UTC getterlar ishlatiladi — `Changelog.date` UTC yarim tunida saqlanadi,
 * lokal getter host timezone'ida kunni siljitib yuborishi mumkin.
 *
 * @param {Date|string} date
 * @returns {string}
 */
function formatDateUz(date) {
  // utc: true — `Changelog.date` UTC yarim tunida yotadi (yuqoridagi izoh).
  return formatDate(date, { utc: true });
}

/** Sana kaliti (guruhlash uchun) — "2026-08-17". */
function dateKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/**
 * Bitta yozuv → bitta "blok". Blok hech qachon bo'linmaydi.
 * @param {object} entry
 * @returns {string}
 */
function buildEntryBlock(entry) {
  const panel = PANEL_LABELS[entry.panel] || entry.panel;
  const lines = [`<b>${escapeHtml(panel)}</b> · <code>v${escapeHtml(entry.version)}</code>`];

  if (entry.title) lines.push(`<i>${escapeHtml(entry.title)}</i>`);

  for (const item of entry.items || []) {
    lines.push(`• ${escapeHtml(item)}`);
  }

  return lines.join("\n");
}

/**
 * Bloklarni 4096 belgilik chegaraga sig'adigan xabarlarga yig'adi.
 * Blok ichidan hech qachon kesilmaydi.
 *
 * @param {string[]} blocks
 * @returns {string[]}
 */
function packBlocks(blocks) {
  const messages = [];
  let current = "";

  for (const block of blocks) {
    // Nazariy holat: bitta blokning o'zi chegaradan katta (200 ta bulletli yozuv)
    if (block.length > SAFE_LIMIT) {
      if (current) {
        messages.push(current);
        current = "";
      }
      messages.push(`${block.slice(0, SAFE_LIMIT - 2)}\n…`);
      continue;
    }

    const candidate = current ? `${current}\n\n${block}` : block;

    if (candidate.length > SAFE_LIMIT) {
      messages.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }

  if (current) messages.push(current);

  return messages;
}

/**
 * Yozuvlardan Telegram xabar(lar)ini quradi.
 *
 * Yozuv bo'lmasa BO'SH massiv qaytaradi — chaqiruvchi alohida tekshirmasligi
 * uchun ("hisobot bo'lmasa hech narsa yuborilmaydi" qoidasi shu yerda).
 *
 * @param {object[]} entries - `date desc, panel asc` tartibida
 * @param {{heading?: string}} [options]
 * @returns {string[]}
 */
function buildChangelogMessages(entries, options = {}) {
  if (!entries || entries.length === 0) return [];

  const blocks = [];
  let lastKey = null;

  if (options.heading) {
    blocks.push(`📋 <b>${escapeHtml(options.heading)}</b>`);
  }

  for (const entry of entries) {
    const key = dateKey(entry.date);

    // Sana sarlavhasi — faqat sana o'zgarganda
    if (key !== lastKey) {
      blocks.push(`🗓 <b>${escapeHtml(formatDateUz(entry.date))}</b>`);
      lastKey = key;
    }

    blocks.push(buildEntryBlock(entry));
  }

  const messages = packBlocks(blocks);

  // Bir nechta xabar bo'lsa tartib raqami qo'shiladi
  if (messages.length > 1) {
    return messages.map((text, index) => `${text}\n\n<i>${index + 1}/${messages.length}</i>`);
  }

  return messages;
}

module.exports = {
  TELEGRAM_MAX,
  SAFE_LIMIT,
  PANEL_LABELS,
  escapeHtml,
  formatDateUz,
  buildChangelogMessages,
};
