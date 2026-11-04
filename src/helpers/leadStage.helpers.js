/**
 * QABUL ZINAPOYASI — 6 POG'ONA (`Lead`, `LeadStageEvent`).
 *
 * Bola maktabga qabul qilinishi oldindan ma'lum yo'ldan o'tadi va har
 * qadamda yo'qotish bo'lishi mumkin. Zinapoya shu yo'lni ifodalaydi:
 *
 *   1. Qiziqish bildirdi        — so'radi, telefon qoldirdi
 *   2. Sinov darsiga yozildi    — kelishilgan kun bor
 *   3. Keldi                    — maktabga keldi
 *   4. Darsga kirdi             — darsning o'zida qatnashdi
 *   5. Dars yoqdi               — davom etishga rozi
 *   6. To'lov qildi             — QABUL QILINDI (yashil)
 *
 * ⚠️ TARTIB SHU YERDA, `LeadStatus` enumida EMAS. PostgreSQL enum tartibi
 * domen tartibi emas va yangi holat qo'shilganda u oxiriga tushadi —
 * tartibni enumdan o'qisak, bitta migratsiya butun grafikni aralashtirib
 * yuborardi.
 *
 * ⚠️ IKKINCHI NUSXA YOZILMAYDI. Pog'ona raqami, yorlig'i va holat bilan
 * bog'lanishi faqat shu fayldan o'qiladi: server (yozuv, tahlil) ham,
 * panel ham (`leads.data.js` — qo'lda sinxron). Ikki joyda bo'lsa, bir
 * ekranda 4-pog'ona "darsga kirdi", boshqasida "dars yoqdi" bo'lib qolardi.
 *
 * ⚠️ ESKI HOLATLAR TASHLAB YUBORILMAYDI (`new`, `contacted`,
 * `negotiation`): ular zinapoyaning eng yaqin pog'onasiga MOSLANADI,
 * aks holda modul ishga tushgan kuni butun eski ma'lumot tahlildan
 * yo'qolardi. Moslash migratsiyadagi backfill bilan AYNI.
 */

/** Zinapoya — tartib bo'yicha, 1 dan 6 gacha. */
const LEAD_STAGES = Object.freeze([
  {
    stage: 1,
    status: "interested",
    label: "Qiziqish bildirdi",
    short: "Qiziqdi",
    hint: "So'radi, telefon raqamini qoldirdi",
  },
  {
    stage: 2,
    status: "trial",
    label: "Sinov darsiga yozildi",
    short: "Yozildi",
    hint: "Kelishilgan kun bor",
  },
  {
    stage: 3,
    status: "visited",
    label: "Keldi",
    short: "Keldi",
    hint: "Maktabga keldi",
  },
  {
    stage: 4,
    status: "attended",
    label: "Darsga kirdi",
    short: "Darsga kirdi",
    hint: "Sinov darsining o'zida qatnashdi",
  },
  {
    stage: 5,
    status: "liked",
    label: "Dars yoqdi",
    short: "Yoqdi",
    hint: "Davom etishga rozi",
  },
  {
    stage: 6,
    status: "enrolled",
    label: "To'lov qildi",
    short: "To'ladi",
    hint: "Qabul qilindi",
  },
]);

/** Zinapoyaning oxirgi pog'onasi — "qabul qilindi". */
const FINAL_STAGE = LEAD_STAGES[LEAD_STAGES.length - 1].stage;

/**
 * CHIQIB KETISH HOLATLARI — zinapoyada emas, ulardan chiqish.
 * Pog'ona tarixi saqlanib qolgani uchun "qaysi pog'onada yo'qotdik"
 * degan savolga javob bo'ladi.
 */
const EXIT_STATUSES = Object.freeze(["rejected", "lost", "postponed"]);

const EXIT_LABELS = Object.freeze({
  rejected: "Rad etdi",
  lost: "Yo'qoldi",
  postponed: "Keyinga qoldirildi",
});

/**
 * ESKI HOLATLARNI ZINAPOYAGA MOSLASH (migratsiyadagi backfill bilan AYNI):
 * - `new` / `contacted` — hali birinchi pog'onaga chiqmagan (0);
 * - `negotiation` — to'lovdan oldingi suhbat, ya'ni dars yoqqan (5).
 */
const LEGACY_STAGE_OF = Object.freeze({
  new: 0,
  contacted: 0,
  negotiation: 5,
});

/** `status` → pog'ona raqami. Chiqish holatlari va noma'lum qiymat → `null`. */
const STAGE_BY_STATUS = new Map(LEAD_STAGES.map((s) => [s.status, s.stage]));
const STAGE_META = new Map(LEAD_STAGES.map((s) => [s.stage, s]));

/** Barcha holatlar — enum bilan AYNI ro'yxat (validatsiya uchun). */
const LEAD_STATUSES = Object.freeze([
  "new",
  "contacted",
  ...LEAD_STAGES.map((s) => s.status),
  "negotiation",
  ...EXIT_STATUSES,
]);

const STATUS_LABELS = Object.freeze({
  new: "Yangi",
  contacted: "Bog'lanildi",
  negotiation: "Muzokara",
  ...Object.fromEntries(LEAD_STAGES.map((s) => [s.status, s.label])),
  ...EXIT_LABELS,
});

/**
 * Holatning pog'ona raqami.
 *
 * @param {string} status
 * @returns {number} 1..6 — zinapoyada; 0 — hali chiqmagan; `-1` — chiqib ketgan
 */
function rungOf(status) {
  if (EXIT_STATUSES.includes(status)) return -1;
  const direct = STAGE_BY_STATUS.get(status);
  if (direct !== undefined) return direct;
  return LEGACY_STAGE_OF[status] ?? 0;
}

/** Chiqib ketish holatimi. */
const isExitStatus = (status) => EXIT_STATUSES.includes(status);

/**
 * Shu holatga YETISH bilan yozilishi kerak bo'lgan pog'onalar.
 *
 * ⚠️ MONOTON: 6-pog'onaga yetgan 1..5 ga ham yetgan hisoblanadi, shuning
 * uchun ro'yxat 1 dan boshlanadi. Busiz "yetganlar soni" pastga tushib,
 * grafik teskari ko'rinardi (masalan to'lov qilgan bola "keldi" da
 * sanalmay qolardi).
 *
 * Chiqib ketish holati hech qanday pog'ona YOZMAYDI: u zinapoyadan
 * chiqish, undagi qadam emas.
 *
 * @param {string} status
 * @returns {Array<{stage: number, status: string}>}
 */
function stagesUpTo(status) {
  const rung = rungOf(status);
  if (rung <= 0) return [];
  return LEAD_STAGES.filter((s) => s.stage <= rung).map((s) => ({
    stage: s.stage,
    status: s.status,
  }));
}

/** Pog'ona raqami bo'yicha ma'lumot (yorliq va izoh). */
const stageMeta = (stage) => STAGE_META.get(stage) ?? null;

/** Holatning odam o'qiydigan nomi. */
const statusLabel = (status) => STATUS_LABELS[status] ?? status;

module.exports = {
  LEAD_STAGES,
  FINAL_STAGE,
  EXIT_STATUSES,
  EXIT_LABELS,
  LEAD_STATUSES,
  STATUS_LABELS,
  rungOf,
  isExitStatus,
  stagesUpTo,
  stageMeta,
  statusLabel,
};
