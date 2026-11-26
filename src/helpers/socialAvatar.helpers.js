/**
 * AVATAR VA ODAM KARTOCHKASI — javobning YAGONA shakli.
 *
 * Istoriya lentasi, chat, sinf guruhi a'zolari va profil bosh qismi — hammasi
 * odamni AYNI shaklda qaytaradi:
 *
 *   { id, firstName, lastName, fullName, role, branchId,
 *     avatar: { url, preset, initials, color } }
 *
 * ⚠️ NIMA UCHUN BITTA SHAKL: mobil ilovada bitta `SocialAvatar` vidjeti bor
 * (`mbsi_social` paketi). Server bir joyda `avatarUrl`, boshqa joyda
 * `profileImage.variants.sm.url` qaytarsa, vidjet ikkita shoxlanishga
 * aylanardi va biri yangilanmay qolardi.
 *
 * ⚠️ `color` — `userId` DAN HOSILA, tasodifiy EMAS: bir odam uchala
 * ilovada va har ochilishda AYNI rangda bo'lishi kerak. Rang ro'yxati
 * ilovada (brend palitrasi), server faqat 0..7 indeksni beradi.
 *
 * ⚠️ TAYYOR AVATARLAR SERVERDA RASM BO'LIB TURMAYDI — faqat KOD saqlanadi
 * ("a07"), rasmning o'zi `mbsi_social` paketi ichida. Shu sababli u
 * tarmoqsiz ham darhol chiziladi va yangi avatar qo'shish = paketning
 * yangi versiyasi. ⚠️ Noma'lum kod kelsa ilova bosh harflarni ko'rsatadi,
 * ya'ni server ro'yxatini kengaytirish eski ilovani SINDIRMAYDI.
 */

const { BadRequestError } = require("../utils/errors");

/** Rang indekslari soni — ilovadagi palitra uzunligi bilan AYNI. */
const AVATAR_COLORS = 8;

/** Tayyor avatar kodlari: a01 … a24. */
const AVATAR_PRESETS = Object.freeze(
  Array.from({ length: 24 }, (_, i) => `a${String(i + 1).padStart(2, "0")}`),
);

/**
 * `userId` dan barqaror rang indeksi (0..7).
 *
 * ⚠️ Hash SODDA va shunday qolishi kerak: qiymat mobil ilovada ham
 * hisoblanishi mumkin (oflayn kartochka), ya'ni algoritm o'zgarsa bir odam
 * ikki xil rangda ko'rinardi.
 *
 * @param {string} userId
 * @returns {number} 0..7
 */
function avatarColor(userId) {
  const id = String(userId || "");
  let sum = 0;
  for (let i = 0; i < id.length; i += 1) sum = (sum * 31 + id.charCodeAt(i)) % 100000007;
  return sum % AVATAR_COLORS;
}

/**
 * Ism bosh harflari: "Ali Valiyev" → "AV".
 *
 * ⚠️ Familiya bo'lmasa bitta harf qaytadi ("A"), bo'sh satr EMAS: ilova
 * bo'sh doira chizib qo'ymasin.
 *
 * @param {{firstName?: string, lastName?: string}} user
 * @returns {string}
 */
function avatarInitials(user = {}) {
  const first = String(user.firstName || "").trim();
  const last = String(user.lastName || "").trim();
  const letters = [first.charAt(0), last.charAt(0)].filter(Boolean).join("");
  return letters.toUpperCase() || "?";
}

/**
 * Avatar bloki — javobning har joyida AYNI.
 *
 * @param {{id: string, firstName?: string, lastName?: string,
 *          avatarUrl?: string|null, avatarPreset?: string|null}} row
 *   `user_directory` qatori
 * @returns {{url: string|null, preset: string|null, initials: string, color: number}}
 */
function buildAvatar(row = {}) {
  return {
    url: row.avatarUrl || null,
    preset: row.avatarPreset || null,
    initials: avatarInitials(row),
    color: avatarColor(row.id),
  };
}

/**
 * ODAM KARTOCHKASI — `user_directory` qatoridan.
 *
 * ⚠️ TELEFON VA USERNAME YO'Q: bu kartochka sinf guruhida O'QUVCHIGA ham
 * ko'rinadi. "Kerak bo'lsa keyin qo'shamiz" degan maydon bir marta
 * qo'shilsa, u darhol hamma javobda bo'lardi.
 *
 * @param {object|null} row
 * @param {{branchName?: string|null}} [extra]
 * @returns {object|null}
 */
function buildUserCard(row, extra = {}) {
  if (!row) return null;
  const firstName = row.firstName || "";
  const lastName = row.lastName || "";
  return {
    id: row.id,
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
    role: row.role || null,
    branchId: row.branchId || null,
    branchName: extra.branchName ?? null,
    isArchived: Boolean(row.isArchived),
    avatar: buildAvatar(row),
  };
}

/**
 * Tayyor avatar kodini tekshiradi.
 *
 * @param {string} value
 * @returns {string}
 */
function assertPreset(value) {
  const preset = String(value || "").trim().toLowerCase();
  if (!AVATAR_PRESETS.includes(preset)) {
    throw new BadRequestError("Tayyor avatar kodi noto'g'ri");
  }
  return preset;
}

/** `user_directory` dan kartochka uchun o'qiladigan maydonlar (`select`). */
const USER_CARD_SELECT = Object.freeze({
  id: true,
  firstName: true,
  lastName: true,
  role: true,
  branchId: true,
  isActive: true,
  isArchived: true,
  avatarUrl: true,
  avatarPreset: true,
});

module.exports = {
  AVATAR_COLORS,
  AVATAR_PRESETS,
  USER_CARD_SELECT,
  avatarColor,
  avatarInitials,
  buildAvatar,
  buildUserCard,
  assertPreset,
};
