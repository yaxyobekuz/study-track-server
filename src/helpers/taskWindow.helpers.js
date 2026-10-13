/**
 * TOPSHIRIQNING VAQT HOLATI — "hozir nima bo'lyapti" degan savolning
 * YAGONA javobi.
 *
 * Ro'yxat, dashboard, ijrochi paneli va "Men ketdim" darvozasi AYNI shu
 * funksiyadan o'qiydi. Ikkita nusxa bo'lsa, ijrochi panelida "hozir
 * bajarilish vaqti" yonib turgan topshiriq boshqaruv ro'yxatida oddiy
 * bo'lib ko'rinardi — va qaysi ekran to'g'ri ekanini hech kim ayta olmasdi
 * (`finance.md` dagi "formula bitta joyda" doktrinasi).
 *
 * ⚠️ HOLAT SAQLANMAYDI, HISOBLANADI. "Bajarilmadi" (✗) — `status` emas,
 * HOSILA: muddat o'tdi-yu ish topshirilmadi. Sabab: muddat uzaytirilsa
 * topshiriq o'z-o'zidan yana "jarayonda" bo'lishi kerak. Saqlangan bo'lsa
 * uni har uzaytirishda qo'lda qaytarish kerak bo'lardi va bitta unutilgan
 * joy registrni yolg'on ✗ bilan to'ldirardi.
 */

// Ijrochi hali ishlayotgan holatlar — `task.service.js` dagi
// `WORKING_STATUSES` bilan AYNI ro'yxat (u shu yerdan o'qiydi).
const WORKING_STATUSES = ["pending", "extended", "pending_rejected"];

// ─── TUR ───────────────────────────────────────────────────────────

const TASK_KINDS = ["main", "extra"];
const TASK_KIND_LABELS = { main: "Asosiy", extra: "Qo'shimcha" };
const DEFAULT_TASK_KIND = "main";

/** Noma'lum qiymat — "asosiy": tur ko'rsatkich, to'siq emas. */
const normalizeKind = (value) =>
  TASK_KINDS.includes(String(value || "")) ? String(value) : DEFAULT_TASK_KIND;

// ─── VAQT HOLATI ───────────────────────────────────────────────────

/**
 * done     — tasdiqlangan (✓)
 * review   — topshirilgan, javob kutyapti
 * stopped  — to'xtatilgan (kerak bo'lmay qoldi)
 * missed   — muddat o'tdi, ish topshirilmadi (✗)
 * active   — ORALIQ ICHIDA: hozir bajarilish vaqti (qizil)
 * upcoming — oraliq hali boshlanmagan
 * open     — oraliqsiz, muddat hali oldinda
 */
const TASK_TIME_STATES = [
  "done",
  "review",
  "stopped",
  "missed",
  "active",
  "upcoming",
  "open",
];

const TASK_STATE_LABELS = {
  done: "Bajarildi",
  review: "Tekshiruvda",
  stopped: "To'xtatilgan",
  missed: "Bajarilmadi",
  active: "Hozir bajarilish vaqti",
  upcoming: "Hali boshlanmagan",
  open: "Bajarilmoqda",
};

/**
 * @param {{ status: string, dueDate: Date|string, startDate?: Date|string|null }} task
 * @param {Date} [now]
 * @returns {string} `TASK_TIME_STATES` dan biri
 */
const resolveTimeState = (task, now = new Date()) => {
  if (!task) return "open";
  if (task.status === "completed") return "done";
  if (task.status === "stopped") return "stopped";
  if (task.status === "pending_review") return "review";

  const due = task.dueDate instanceof Date ? task.dueDate : new Date(task.dueDate);
  if (due.getTime() < now.getTime()) return "missed";

  if (!task.startDate) return "open";
  const start =
    task.startDate instanceof Date ? task.startDate : new Date(task.startDate);
  return start.getTime() > now.getTime() ? "upcoming" : "active";
};

/**
 * Ro'yxat filtri uchun Prisma `where` bo'lagi. `null` — bunday kesim yo'q
 * (chaqiruvchi filtrni qo'llamaydi).
 *
 * ⚠️ SQL DARAJASIDA: sahifalangan ro'yxatni xotirada filtrlash 21-chi
 * topshiriqni "yo'q" qilib ko'rsatardi (`devices.md` §10 bilan AYNI sabab).
 *
 * @param {string} state
 * @param {Date} now
 */
const buildStateWhere = (state, now = new Date()) => {
  switch (state) {
    case "done":
      return { status: "completed" };
    case "review":
      return { status: "pending_review" };
    case "stopped":
      return { status: "stopped" };
    case "missed":
      return { status: { in: WORKING_STATUSES }, dueDate: { lt: now } };
    case "in_progress":
      return { status: { in: WORKING_STATUSES }, dueDate: { gte: now } };
    case "active":
      return {
        status: { in: WORKING_STATUSES },
        dueDate: { gte: now },
        startDate: { lte: now },
      };
    case "upcoming":
      return { status: { in: WORKING_STATUSES }, startDate: { gt: now } };
    default:
      return null;
  }
};

// ─── HAVOLALAR ─────────────────────────────────────────────────────

const LINKS_MAX = 10;
const LINK_URL_MAX = 2000;
const LINK_LABEL_MAX = 120;

/**
 * Havolalarni tozalaydi: faqat http/https, soni va uzunligi chegarasida.
 *
 * ⚠️ FAQAT http(s): `javascript:` va `data:` sxemalari panelda bosiladigan
 * havola bo'lib chiqardi, ya'ni saqlangan XSS yo'li. Tekshiruv SERVERDA —
 * panel faqat oldindan ogohlantiradi.
 *
 * @param {unknown} value - massiv yoki JSON satri
 * @param {(msg: string) => Error} badRequest
 * @returns {Array<{ url: string, label: string }>}
 */
const normalizeLinks = (value, badRequest) => {
  if (value === undefined || value === null || value === "") return [];

  let list = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      throw badRequest("Havolalar formati noto'g'ri");
    }
  }
  if (!Array.isArray(list)) throw badRequest("Havolalar formati noto'g'ri");
  if (list.length > LINKS_MAX) {
    throw badRequest(`Ko'pi bilan ${LINKS_MAX} ta havola qo'shish mumkin`);
  }

  const result = [];
  const seen = new Set();

  for (const item of list) {
    const raw = typeof item === "string" ? item : item?.url;
    const url = String(raw ?? "").trim();
    if (!url) continue;
    if (url.length > LINK_URL_MAX) {
      throw badRequest("Havola juda uzun");
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw badRequest(`Havola noto'g'ri: ${url}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw badRequest("Havola faqat http:// yoki https:// bilan boshlanishi kerak");
    }

    const key = parsed.href.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const label = String((typeof item === "string" ? "" : item?.label) ?? "")
      .trim()
      .slice(0, LINK_LABEL_MAX);

    result.push({ url: parsed.href, label: label || parsed.hostname });
  }

  return result;
};

module.exports = {
  WORKING_STATUSES,
  TASK_KINDS,
  TASK_KIND_LABELS,
  DEFAULT_TASK_KIND,
  TASK_TIME_STATES,
  TASK_STATE_LABELS,
  LINKS_MAX,
  normalizeKind,
  normalizeLinks,
  resolveTimeState,
  buildStateWhere,
};
