// ─────────────────────────────────────────────
// SEMANTIK VERSIYA (0.0.0) — sof funksiyalar
// ─────────────────────────────────────────────
// Bazaga tegmaydi. Bazadan o'qish `changelog.service.js` da.
//
// Har bir panel o'z versiyasiga ega va u MONOTON o'sadi: keyingi versiya
// panelning eng yuqori versiyasidan olinadi, sana bo'yicha oxirgisidan emas.
// Shu sababli o'tgan kunga yozuv qo'shilsa ham versiya orqaga ketmaydi.

const BUMPS = ["major", "minor", "patch"];

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * "1.4.2" → { major: 1, minor: 4, patch: 2 }.
 * @param {string} value
 * @returns {{major: number, minor: number, patch: number}|null} noto'g'ri format → null
 */
function parseVersion(value) {
  const match = VERSION_RE.exec(String(value ?? "").trim());
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * { major: 1, minor: 4, patch: 2 } → "1.4.2".
 * @param {{major?: number, minor?: number, patch?: number}} parts
 * @returns {string}
 */
function formatVersion(parts) {
  const { major = 0, minor = 0, patch = 0 } = parts || {};
  return `${major}.${minor}.${patch}`;
}

/**
 * Joriy versiyani bump darajasiga qarab oshiradi.
 *
 * `current` bo'sh bo'lsa (panelning birinchi yozuvi) 0.0.0 dan boshlanadi:
 *   major → 1.0.0 | minor → 0.1.0 | patch → 0.0.1
 *
 * @param {{major?: number, minor?: number, patch?: number}|null} current
 * @param {"major"|"minor"|"patch"} bump
 * @returns {{major: number, minor: number, patch: number}}
 */
function bumpVersion(current, bump) {
  const base = { major: 0, minor: 0, patch: 0, ...(current || {}) };

  if (bump === "major") return { major: base.major + 1, minor: 0, patch: 0 };
  if (bump === "minor") return { major: base.major, minor: base.minor + 1, patch: 0 };

  return { major: base.major, minor: base.minor, patch: base.patch + 1 };
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isValidBump(value) {
  return BUMPS.includes(value);
}

module.exports = {
  BUMPS,
  parseVersion,
  formatVersion,
  bumpVersion,
  isValidBump,
};
