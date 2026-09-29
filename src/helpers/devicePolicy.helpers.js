/**
 * QURILMA NAZORATINING SOF QARORI — yagona manba.
 *
 * Bu fayl bazaga TEGMAYDI va yon ta'sir bermaydi: kirish — o'qilgan
 * qatorlar, chiqish — qaror. Shu sababli uni test qilish oson va
 * chaqiruvchilar soni muhim emas.
 *
 * ⚠️ PROFIL BITTA JOYDA QURILADI (`buildDeviceProfile`). Uni qurilma API si
 * ham, paneldagi "oldindan ko'rish" ham, o'quvchining o'z ekrani ham
 * chaqiradi. Ikkita mustaqil quruvchi bo'lsa panel bir narsa ko'rsatib,
 * telefon boshqasini bajarardi — modulning butun mohiyati (ishonch)
 * yo'qolardi. Bu `invoiceBuilder.service.js` va `computeSalary()` bilan
 * AYNI doktrina.
 *
 * To'liq qoidalar: `.claude/rules/devices.md`.
 */

const { tashkentDayKey } = require("./lessonHours");

/* ─────────────────────── DOIMIYLAR ─────────────────────── */

/** Toshkent +5, DST yo'q (`education.md` §9). */
const TASHKENT_OFFSET_MS = 5 * 3600000;

/** Kunda daqiqalar — oyna chegaralarining yuqori qiymati. */
const MINUTES_PER_DAY = 1440;

/**
 * ⚠️ VAQTINCHALIK OCHISH ENG KO'PI BILAN 24 SOAT.
 *
 * Muddatsiz ochish chekovni jimgina abadiy o'chirib qo'yardi va buni hech
 * kim sezmasdi — `PayrollSuspension` dagi "ko'pi bilan 12 oy" bilan AYNI
 * mulohaza. Uzoqroq kerak bo'lsa, bu siyosat qarori: biriktirish
 * o'zgartiriladi.
 */
const MAX_UNLOCK_HOURS = 24;

/**
 * QAMROV TARTIBI — kichik raqam KUCHLIROQ.
 *
 * ⚠️ ENG TOR QAMROV YUTADI: shaxsiy istisno sinf qoidasidan, sinf qoidasi
 * esa maktab qoidasidan ustun. "Eng kech boshlangani yutadi" naqshi
 * (`finance.md` §1, `StudentTariff`) bu yerga KO'CHIRILMAYDI — u yerda
 * ma'no boshqa. Bu yerda "kech" mezoni bo'lsa, bugun maktab siyosatini
 * tahrirlash kechagi shaxsiy istisnoni JIMGINA bekor qilardi.
 */
const SCOPE_RANK = Object.freeze({ student: 0, class: 1, school: 2 });

/** Qamrov yorlig'i — audit va paneldagi "nega shu siyosat" javobi uchun. */
const SCOPE_LABEL = Object.freeze({
  student: "O'quvchiga shaxsan",
  class: "Sinf orqali",
  school: "Butun maktab",
});

/**
 * ILOVA REJIMLARI — yumshoqdan qattiqqa.
 *
 * ⚠️ `always` "cheksiz" DEGANI EMAS: u faqat VAQT OYNASIDAN ozod qiladi.
 * Umumiy kunlik limitdan esa `isExemptFromDailyLimit` ozod qiladi va u
 * ataylab alohida tushuncha.
 */
const APP_MODES = Object.freeze(["always", "allowed", "limited", "blocked"]);

/**
 * ⚠️ FAVQULODDA QO'NG'IROQ DOIM OCHIQ — ZAXIRA QAVAT.
 *
 * Asosiy mexanizm — katalogdagi `isEssential` bayrog'i. Lekin admin
 * raqam teruvchini belgilashni UNUTISHI mumkin, oq ro'yxat siyosati esa
 * belgilanmagan hamma narsani bloklaydi — natijada bola yordam so'ray
 * olmay qolardi. Shuning uchun bu ro'yxat kodda turadi va sozlamaga
 * CHIQARILMAYDI (`devices.md` §0.3).
 *
 * ⚠️ Ro'yxat to'liq emas va to'liq bo'la olmaydi (ishlab chiqaruvchilar
 * o'z qobiqlarini qo'yadi), shuning uchun profil `emergencyCalls: true`
 * bayrog'ini ham yuboradi: qurilma ilovasi favqulodda ekranni har qanday
 * holatda ochiq qoldiradi. Bu ikkisi BIR-BIRINI ALMASHTIRMAYDI.
 */
const FALLBACK_ESSENTIAL = Object.freeze([
  // Android — raqam terish va kontaktlar
  "com.android.dialer",
  "com.google.android.dialer",
  "com.android.contacts",
  "com.google.android.contacts",
  "com.samsung.android.dialer",
  "com.android.server.telecom",
  "com.android.emergency",
  // Android — tizim sozlamalari (ruxsatni qaytarish uchun kerak)
  "com.android.settings",
  // iOS
  "com.apple.mobilephone",
  "com.apple.MobileAddressBook",
  "com.apple.Preferences",
]);

const FALLBACK_ESSENTIAL_SET = new Set(FALLBACK_ESSENTIAL);

/* ─────────────────────── VAQT PRIMITIVLARI ─────────────────────── */

/**
 * Instantning TOSHKENT hafta kuni.
 *
 * ⚠️ 0 = yakshanba ... 6 = shanba — `DAYS_UZ` indeksi va JS `getDay()`
 * bilan AYNI. Yangi konvensiya kiritilmaydi: dars jadvali `ScheduleDay`
 * enumi bilan ishlaydi, davomat esa shu indeks bilan — uchinchi tartib
 * qo'shilsa, ular orasidagi har bir o'tkazishda xato bo'lardi.
 *
 * @param {Date} instant
 * @returns {number} 0..6
 */
function tashkentWeekday(instant) {
  return new Date(instant.getTime() + TASHKENT_OFFSET_MS).getUTCDay();
}

/**
 * Instantning TOSHKENT devor-soati, yarim tundan boshlab daqiqada.
 * @param {Date} instant
 * @returns {number} 0..1439
 */
function tashkentMinuteOfDay(instant) {
  const shifted = new Date(instant.getTime() + TASHKENT_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/**
 * Toshkent kunini `@db.Date` uchun UTC yarim tuniga keltiradi.
 * @param {Date} instant
 * @returns {Date}
 */
function tashkentDayDate(instant) {
  return new Date(`${tashkentDayKey(instant)}T00:00:00.000Z`);
}

/** `"08:30"` → 510. Yaroqsiz qiymat → `null`. */
function parseClock(value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value >= 0 && value <= MINUTES_PER_DAY ? value : null;
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) return null;
  const total = hours * 60 + minutes;
  return total <= MINUTES_PER_DAY ? total : null;
}

/** 510 → `"08:30"`. Panelga va qurilmaga shu ko'rinishda ketadi. */
function formatClock(minute) {
  const safe = Math.max(0, Math.min(MINUTES_PER_DAY, Number(minute) || 0));
  return `${String(Math.floor(safe / 60) % 24).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

/* ─────────────────────── SIYOSATNI TANLASH ─────────────────────── */

/**
 * O'QUVCHIGA QAYSI SIYOSAT QO'LLANADI.
 *
 * ⚠️ SIYOSATLAR QO'SHILMAYDI — bitta siyosat, TO'LIQ holida. Ikki
 * siyosatning ilovalar ro'yxatini birlashtirish ("kesishma" ham,
 * "birlashma" ham) ota-onaga tushuntirib bo'lmaydigan natija berardi,
 * shuning uchun tanlov umuman qilinmaydi (`finance.md` §2 dagi
 * chegirmalardan aynan shu bilan farq qiladi).
 *
 * ⚠️ HAR DOIM `reason` QAYTARADI. "Nega bu bolada boshqa qoida" degan
 * savol qo'lda qidirib topiladigan bo'lmasligi kerak — panel shu matnni
 * o'quvchi qatorida ko'rsatadi.
 *
 * @param {object} input
 * @param {Array} input.assignments - biriktirishlar (faol bo'lmaganlari ham
 *   berilishi mumkin — bu yerda filtrlanadi)
 * @param {string} input.studentId
 * @param {string[]} input.classIds - o'quvchining sinflari
 * @returns {{ assignment: object|null, policyId: string|null, reason: string,
 *   candidates: object[] }}
 */
function resolveAssignment({ assignments = [], studentId, classIds = [] }) {
  const classSet = new Set(classIds.filter(Boolean));

  const candidates = assignments.filter((a) => {
    if (!a || a.isActive === false) return false;
    if (a.scope === "student") return a.studentId === studentId;
    if (a.scope === "class") return classSet.has(a.classId);
    return a.scope === "school";
  });

  if (candidates.length === 0) {
    return {
      assignment: null,
      policyId: null,
      reason: "Biriktirilgan siyosat yo'q — cheklov qo'llanmaydi",
      candidates: [],
    };
  }

  // Tartib: qamrov (tor → keng) → priority (katta → kichik) → oxirgi yozilgani.
  // ⚠️ Uchala mezon ham KERAK: o'quvchi ikki sinfda bo'lsa birinchi mezon
  // ularni ajrata olmaydi, `priority` teng bo'lsa esa natija tartibsiz
  // bo'lib qolardi va bir xil so'rov har safar boshqa javob berardi.
  const sorted = [...candidates].sort((a, b) => {
    const rank = SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope];
    if (rank !== 0) return rank;
    const priority = (b.priority || 0) - (a.priority || 0);
    if (priority !== 0) return priority;
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });

  const winner = sorted[0];
  const scopeLabel = SCOPE_LABEL[winner.scope] || winner.scope;
  const overridden = sorted.length > 1 ? ` (${sorted.length - 1} ta kengroq qoida ustidan)` : "";

  return {
    assignment: winner,
    policyId: winner.policyId,
    reason: `${scopeLabel}${overridden}`,
    candidates: sorted,
  };
}

/* ─────────────────────── VAQT OYNALARI ─────────────────────── */

/**
 * Oynalarni hafta kuni bo'yicha guruhlaydi va tartiblaydi.
 * @param {Array<{weekday:number,startMinute:number,endMinute:number,label?:string}>} windows
 * @returns {Map<number, Array<{startMinute:number,endMinute:number,label:string}>>}
 */
function groupWindows(windows = []) {
  const byDay = new Map();
  for (const w of windows) {
    if (!Number.isInteger(w?.weekday) || w.weekday < 0 || w.weekday > 6) continue;
    const list = byDay.get(w.weekday) || [];
    list.push({
      startMinute: w.startMinute,
      endMinute: w.endMinute,
      label: w.label || "",
    });
    byDay.set(w.weekday, list);
  }
  for (const list of byDay.values()) list.sort((a, b) => a.startMinute - b.startMinute);
  return byDay;
}

/**
 * Shu daqiqada oyna ochiqmi?
 *
 * ⚠️ OYNA BITTA HAM BO'LMASA — CHEKLOV YO'Q (`true`). Bo'sh ro'yxatni
 * "hech qachon ishlamaydi" deb o'qish yangi yaratilgan siyosatni jimgina
 * to'liq qulfga aylantirardi: admin bitta ilovani ruxsat berib, telefon
 * umuman ochilmay qolganini tushunmasdi.
 *
 * ⚠️ `endMinute` EKSKLYUZIV: `[08:00, 12:00)` va `[12:00, 16:00)`
 * kesishmaydi (`StudentEnrollment.endDate` inklyuziv bo'lgani bilan
 * farqi shu — u yerda oxirgi KUN, bu yerda esa chegara ONi).
 *
 * @returns {{ open: boolean, current: object|null, next: object|null }}
 */
function windowState(windows, weekday, minuteOfDay) {
  if (!windows || windows.length === 0) {
    return { open: true, current: null, next: null };
  }

  const byDay = groupWindows(windows);
  const today = byDay.get(weekday) || [];

  const current = today.find(
    (w) => minuteOfDay >= w.startMinute && minuteOfDay < w.endMinute,
  );
  if (current) return { open: true, current, next: null };

  // Bugungi keyingi oyna; bo'lmasa — keyingi kunlardagi birinchisi.
  const laterToday = today.find((w) => w.startMinute > minuteOfDay);
  if (laterToday) return { open: false, current: null, next: { ...laterToday, weekday } };

  for (let step = 1; step <= 7; step += 1) {
    const day = (weekday + step) % 7;
    const list = byDay.get(day);
    if (list?.length) return { open: false, current: null, next: { ...list[0], weekday: day } };
  }

  return { open: false, current: null, next: null };
}

/* ─────────────────────── VAQTINCHALIK OCHISH ─────────────────────── */

/**
 * Shu ONda amal qilayotgan ochishlar.
 *
 * ⚠️ BIRLASHTIRILMAYDI: `full` turlaridan eng KECH tugaydigani amal
 * qiladi, `app` turidagi qo'shimcha daqiqalar esa o'sha ilova uchun
 * QO'SHILADI. Ikki xil qoida, chunki ma'nolari ham boshqa: "bugun kechqurun
 * ochib ber" ikki marta berilsa ikki barobar ochilmaydi, "yana 30 daqiqa"
 * esa ikki marta berilsa bir soat bo'ladi.
 *
 * ⚠️ `status` BILAN BIRGA `endsAt` ham tekshiriladi: supurgi ishlamay
 * qolsa ham ochish o'z vaqtida tugaydi (`deviceSweep.job.js` faqat
 * ro'yxatni tozalaydi, hisob-kitobga ta'sir qilmaydi).
 *
 * @param {Array} unlocks
 * @param {Date} now
 * @param {string|null} deviceId - qurilmaga xoslari uchun; `null` → hammasi
 * @returns {{ full: object|null, extraByAppId: Map<string, number> }}
 */
function activeUnlocks(unlocks = [], now = new Date(), deviceId = null) {
  const extraByAppId = new Map();
  let full = null;

  for (const u of unlocks) {
    if (!u || u.status !== "active") continue;
    if (new Date(u.startsAt) > now) continue;
    if (new Date(u.endsAt) <= now) continue;
    // `deviceId = null` bo'lgan ochish o'quvchining BARCHA qurilmalariga.
    if (u.deviceId && deviceId && u.deviceId !== deviceId) continue;

    if (u.kind === "full") {
      if (!full || new Date(u.endsAt) > new Date(full.endsAt)) full = u;
      continue;
    }
    if (u.kind === "app" && u.appId) {
      const extra = Math.max(0, Number(u.extraMinutes) || 0);
      extraByAppId.set(u.appId, (extraByAppId.get(u.appId) || 0) + extra);
    }
  }

  return { full, extraByAppId };
}

/* ─────────────────────── ILOVA IDENTIFIKATORI ─────────────────────── */

/**
 * Qurilma platformasiga mos identifikator.
 *
 * ⚠️ Ilovada shu platforma uchun identifikator BO'LMASA `null` qaytadi va
 * u profilga KIRMAYDI. Bu jim bo'shliq: oq ro'yxat siyosatida "YouTube
 * ruxsat" deb yozilgan-u, iOS bundle id kiritilmagan bo'lsa, iPhone da u
 * baribir bloklangan bo'lib qolardi. Shuning uchun siyosat tafsilotida
 * `missingIdentifiers` alohida hisoblanadi va panel buni OGOHLANTIRISH
 * qilib ko'rsatadi — jim qolmaydi.
 */
function appIdentifier(app, platform) {
  if (!app) return null;
  return (platform === "ios" ? app.iosBundleId : app.androidPackage) || null;
}

/** Ilova katalogdagi yoki zaxira ro'yxatdagi "hech qachon bloklanmas"mi? */
function isEssentialApp(app, identifier) {
  if (app?.isEssential) return true;
  return Boolean(identifier && FALLBACK_ESSENTIAL_SET.has(identifier));
}

/* ─────────────────────── PROFIL ─────────────────────── */

/**
 * QURILMAGA YUBORILADIGAN PROFIL — modulning yagona chiqish shakli.
 *
 * ⚠️ `remainingMinutes` — MASLAHAT, buyruq emas. Qurilma o'z hisobini
 * yuritadi va ikkalasidan KICHIGINI oladi. Aks holda internetni o'chirib
 * qo'yish cheklovni nolga tushirardi — chetlab o'tishning eng oson yo'li
 * aynan shu bo'lardi.
 *
 * ⚠️ Modul o'chirilgan bo'lsa (`settings.enabled = false`) BO'SH CHEKOV
 * qaytadi: hamma narsa ochiq, lekin siyosat va biriktirishlar joyida
 * qoladi (`devices.md` §10 — favqulodda tugma).
 *
 * @param {object} input
 * @param {object|null} input.policy - siyosat (`apps` va `windows` bilan)
 * @param {object} input.settings - `DeviceSettings`
 * @param {string} input.platform - "android" | "ios"
 * @param {Map<string, {minutes:number}>} input.usageByKey - bugungi foydalanish
 * @param {Array} input.unlocks - o'quvchining ochishlari
 * @param {string|null} input.deviceId
 * @param {Date} input.now
 * @param {{ policyId: string|null, reason: string }} input.resolution
 * @returns {object} profil
 */
function buildDeviceProfile({
  policy = null,
  settings = {},
  platform = "android",
  usageByKey = new Map(),
  unlocks = [],
  deviceId = null,
  now = new Date(),
  resolution = { reason: "" },
}) {
  const weekday = tashkentWeekday(now);
  const minuteOfDay = tashkentMinuteOfDay(now);

  const base = {
    generatedAt: now.toISOString(),
    timezone: "Asia/Tashkent",
    day: tashkentDayKey(now),
    // ⚠️ QURILMA ILOVASI BILAN SHARTNOMA: har qanday holatda favqulodda
    // qo'ng'iroq ekrani ochiq qoladi (`devices.md` §0.3).
    emergencyCalls: true,
    syncIntervalMinutes: settings.syncIntervalMinutes ?? 30,
    reason: resolution.reason || "",
  };

  // ── Modul o'chiq yoki siyosat biriktirilmagan: BO'SH CHEKOV ──
  if (!settings.enabled || !policy) {
    return {
      ...base,
      enforced: false,
      version: 0,
      policyId: null,
      policyName: null,
      defaultMode: "allow",
      dailyLimitMinutes: null,
      remainingMinutes: null,
      offlinePolicy: settings.offlinePolicy || "keepLast",
      windowOpen: true,
      windows: [],
      nextWindow: null,
      apps: [],
      unlock: null,
      reason: settings.enabled
        ? base.reason || "Biriktirilgan siyosat yo'q — cheklov qo'llanmaydi"
        : "Qurilma nazorati o'chirilgan",
    };
  }

  const windows = (policy.windows || []).map((w) => ({
    weekday: w.weekday,
    startMinute: w.startMinute,
    endMinute: w.endMinute,
    start: formatClock(w.startMinute),
    end: formatClock(w.endMinute),
    label: w.label || "",
  }));

  const state = windowState(windows, weekday, minuteOfDay);
  const { full, extraByAppId } = activeUnlocks(unlocks, now, deviceId);

  // ── Ilova qoidalari ──
  let dailyUsed = 0;
  const apps = [];

  for (const rule of policy.apps || []) {
    const app = rule.app;
    const identifier = appIdentifier(app, platform);
    // Shu platforma uchun identifikatori yo'q ilova profilga kirmaydi:
    // qurilma uni baribir taniy olmasdi (yuqoridagi izohga qarang).
    if (!identifier) continue;

    const essential = isEssentialApp(app, identifier);
    // ⚠️ ESSENTIAL ILOVANI SIYOSAT BLOKLAY OLMAYDI — rejim `always` ga
    // majburan ko'tariladi (`devices.md` §0.3).
    const mode = essential ? "always" : rule.mode;

    const used = Math.max(0, Number(usageByKey.get(identifier)?.minutes) || 0);
    // `always` ilovalar umumiy kunlik limitdan HISOBLANMAYDI: ota-onaga
    // qo'ng'iroq qilish kunlik limitni yeb qo'ymasligi kerak.
    if (mode !== "always") dailyUsed += used;

    const extra = extraByAppId.get(app?.id) || 0;
    const limit =
      mode === "limited" ? Math.max(0, (Number(rule.dailyMinutes) || 0) + extra) : null;

    apps.push({
      appId: app?.id || null,
      name: app?.name || identifier,
      identifier,
      mode,
      essential,
      dailyMinutes: limit,
      usedMinutes: used,
      remainingMinutes: limit === null ? null : Math.max(0, limit - used),
      extraMinutes: extra || 0,
    });
  }

  // Katalogda yo'q, lekin qurilmada ishlatilgan ilovalarning vaqti ham
  // umumiy limitga kiradi — aks holda oq ro'yxatdagi bo'shliq limitni
  // chetlab o'tish yo'liga aylanardi.
  const known = new Set(apps.map((a) => a.identifier));
  for (const [key, entry] of usageByKey) {
    if (known.has(key)) continue;
    if (FALLBACK_ESSENTIAL_SET.has(key)) continue;
    dailyUsed += Math.max(0, Number(entry?.minutes) || 0);
  }

  const dailyLimit = policy.dailyLimitMinutes ?? null;

  return {
    ...base,
    enforced: true,
    version: policy.version,
    policyId: policy.id,
    policyName: policy.name,
    defaultMode: policy.defaultMode,
    dailyLimitMinutes: dailyLimit,
    dailyUsedMinutes: dailyUsed,
    remainingMinutes: dailyLimit === null ? null : Math.max(0, dailyLimit - dailyUsed),
    offlinePolicy: policy.offlinePolicy || settings.offlinePolicy || "keepLast",
    windowOpen: state.open,
    windows,
    nextWindow: state.next
      ? { weekday: state.next.weekday, start: formatClock(state.next.startMinute) }
      : null,
    apps,
    // ⚠️ To'liq ochish profilni O'ZGARTIRMAYDI, faqat ustiga qo'yiladi:
    // qurilma ochish tugagach eski qoidaga QAYTA olishi kerak va buning
    // uchun asosiy qoidalar qo'lida turishi shart.
    unlock: full
      ? { kind: "full", until: new Date(full.endsAt).toISOString(), reason: full.reason || "" }
      : null,
  };
}

/**
 * Bitta ilova SHU ONDA ochiqmi — paneldagi "hozir nima bo'ladi" javobi
 * va testlar uchun. Qurilma ham aynan shu mantiqni bajaradi.
 *
 * @param {object} profile - `buildDeviceProfile` natijasi
 * @param {string} identifier - paket nomi / bundle id
 * @returns {{ allowed: boolean, reason: string }}
 */
function evaluateApp(profile, identifier) {
  if (!profile?.enforced) return { allowed: true, reason: "Cheklov yo'q" };

  const entry = profile.apps.find((a) => a.identifier === identifier);

  if (entry?.essential) return { allowed: true, reason: "Majburiy ilova" };
  if (profile.unlock) return { allowed: true, reason: "Vaqtinchalik ochilgan" };

  if (!entry) {
    return profile.defaultMode === "allow"
      ? { allowed: true, reason: "Ro'yxatda yo'q — ruxsat etilgan" }
      : { allowed: false, reason: "Ro'yxatda yo'q — bloklangan" };
  }

  if (entry.mode === "blocked") return { allowed: false, reason: "Bloklangan" };
  if (entry.mode === "always") return { allowed: true, reason: "Doim ochiq" };

  if (!profile.windowOpen) return { allowed: false, reason: "Ruxsat vaqti emas" };

  if (profile.remainingMinutes === 0) {
    return { allowed: false, reason: "Kunlik vaqt tugagan" };
  }
  if (entry.mode === "limited" && entry.remainingMinutes === 0) {
    return { allowed: false, reason: "Bu ilova uchun vaqt tugagan" };
  }

  return { allowed: true, reason: "Ruxsat etilgan" };
}

/* ─────────────────────── QURILMA HOLATI ─────────────────────── */

/**
 * QURILMA HOLATI — panelda rangli belgi.
 *
 * ⚠️ UCH XIL "YOMON" HOLAT BIR-BIRIDAN AJRATILADI va bu ataylab:
 *   · `offline`  — telefon ko'rinmayapti (internet yo'q bo'lishi mumkin);
 *   · `degraded` — telefon ulangan, lekin OS ruxsati OLINGAN, ya'ni
 *                  cheklov ISHLAMAYAPTI — aynan shu holat e'tibor talab
 *                  qiladi;
 *   · `paused`   — biz o'zimiz to'xtatganmiz.
 *
 * Ularni bitta "muammo" belgisiga yig'ish adminni eng muhim holatdan
 * ko'r qilardi: oflayn telefon odatda o'zi tuzaladi, himoyasi
 * o'chirilgani esa o'z-o'zidan tuzalmaydi.
 *
 * ⚠️ SOF FUNKSIYA va ataylab shu yerda: uni ham qurilmalar ro'yxati, ham
 * dashboard, ham o'quvchi kartasi chaqiradi. Servisda tursa, hisobot
 * servisi ro'yxat servisiga bog'lanib qolardi.
 *
 * @param {{status:string, enforcing:boolean, lastSeenAt:Date|null}} device
 * @param {number} offlineGraceMinutes
 * @returns {{ key: string, label: string }}
 */
function deviceHealth(device, offlineGraceMinutes = 120) {
  if (device?.status === "removed") return { key: "removed", label: "Olib tashlangan" };
  if (device?.status === "paused") return { key: "paused", label: "To'xtatilgan" };

  const graceMs = Math.max(1, Number(offlineGraceMinutes) || 120) * 60000;
  const seen = device?.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;

  if (!seen) return { key: "pending", label: "Hali ulanmagan" };
  if (Date.now() - seen > graceMs) return { key: "offline", label: "Oflayn" };
  if (!device.enforcing) return { key: "degraded", label: "Himoya o'chirilgan" };

  return { key: "healthy", label: "Himoyada" };
}

module.exports = {
  MAX_UNLOCK_HOURS,
  MINUTES_PER_DAY,
  APP_MODES,
  SCOPE_RANK,
  SCOPE_LABEL,
  FALLBACK_ESSENTIAL,
  tashkentWeekday,
  tashkentMinuteOfDay,
  tashkentDayDate,
  parseClock,
  formatClock,
  resolveAssignment,
  groupWindows,
  windowState,
  activeUnlocks,
  appIdentifier,
  isEssentialApp,
  buildDeviceProfile,
  evaluateApp,
  deviceHealth,
};
