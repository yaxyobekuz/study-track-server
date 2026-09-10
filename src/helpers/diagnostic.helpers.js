/**
 * DIAGNOSTIKA — sof funksiyalar va yagona formulalar manbai.
 *
 * ⚠️ BU YERDAGI HAR BIR FORMULA BITTA NUSXADA. Diagnostika modulining butun
 * mohiyati — o'quvchi, o'qituvchi va rahbar BIR XIL raqamni ko'rishi. Ikkita
 * nusxa bo'lsa, natija sahifasida bir ball, tahlil sahifasida boshqa ball
 * chiqardi va modul o'ziga bo'lgan ishonchni yo'qotardi (moliyadagi
 * `computeSalary()` bilan bir xil mantiq).
 *
 * Bu fayl PRISMA'GA TEGMAYDI — faqat kiruvchi qiymatlar bilan ishlaydi.
 * Shuning uchun uni test qilish ham, panelda qayta ishlatish ham oson.
 */

// ─────────────────────────────────────────────
// DARAJA VA CHEGARALAR
// ─────────────────────────────────────────────

/** Qiyinlik darajalari — pastdan yuqoriga. Tartib MUHIM (adaptiv tanlov). */
const LEVELS = ["easy", "medium", "hard", "expert"];

/** Foydalanuvchi ko'radigan o'zbekcha nomlar. */
const LEVEL_LABELS = {
  easy: "Oson",
  medium: "O'rta",
  hard: "Qiyin",
  expert: "Murakkab",
};

/**
 * O'quvchi o'zi tanlaydigan daraja → qaysi qiyinliklar beriladi.
 *
 * ⚠️ HAR DARAJA IKKI POG'ONANI QAMRAYDI va ular BIR-BIRINI QOPLAYDI
 * (medium ikkalasida ham bor). Sabab: bitta pog'ona bilan test o'quvchining
 * chegarasini TOPA OLMASDI — hammasi to'g'ri yoki hammasi xato bo'lardi va
 * "qayerda turibdi" degan savolga javob chiqmasdi. Ikki pog'ona esa
 * o'tish nuqtasini ko'rsatadi.
 */
const DEFAULT_LEVEL_TIERS = {
  beginner: ["easy", "medium"],
  intermediate: ["medium", "hard"],
  advanced: ["hard", "expert"],
};

/** Sozlamadagi `levelTiers` ni tekshirib, yaroqsizini default bilan almashtiradi. */
function resolveLevelTiers(raw) {
  if (!raw || typeof raw !== "object") return DEFAULT_LEVEL_TIERS;

  const out = {};
  for (const key of Object.keys(DEFAULT_LEVEL_TIERS)) {
    const value = Array.isArray(raw[key])
      ? raw[key].filter((l) => LEVELS.includes(l))
      : [];
    out[key] = value.length ? [...new Set(value)] : DEFAULT_LEVEL_TIERS[key];
  }
  return out;
}

// ─────────────────────────────────────────────
// BALL VA TASNIF
// ─────────────────────────────────────────────

/**
 * Ballni uch toifaga ajratadi. Chegaralar SOZLAMADAN keladi
 * (`DiagnosticSettings.goodScore` / `mediumScore`), chunki har maktabning
 * "yaxshi" tushunchasi har xil.
 *
 * ⚠️ Natija urinishga MUHRLANADI: chegara keyin o'zgarsa, o'tgan urinishning
 * darajasi o'zgarmaydi (hisob-faktura doktrinasi bilan bir xil).
 *
 * @param {number} score - 0–100
 * @param {number} [good=70]
 * @param {number} [medium=40]
 * @returns {"GOOD"|"MEDIUM"|"BAD"}
 */
function classifyScore(score, good = 70, medium = 40) {
  if (score >= good) return "GOOD";
  if (score >= medium) return "MEDIUM";
  return "BAD";
}

/** Toifaning o'zbekcha yorlig'i. */
const GRADE_LABELS = { GOOD: "Yaxshi", MEDIUM: "O'rta", BAD: "Zaif" };

function gradeLabel(grade) {
  return GRADE_LABELS[grade] || "—";
}

/**
 * Mavzu ballining SEMANTIK rangi. UI shu nomlar bilan ishlaydi
 * (`--mastered` / `--developing` / `--gap` / `--untested`), ya'ni ma'no
 * faqat rang bilan emas, matn bilan ham beriladi.
 *
 * @param {number|null|undefined} score
 * @returns {"mastered"|"developing"|"gap"|"untested"}
 */
function diagnosisTone(score) {
  if (score == null) return "untested";
  if (score >= 80) return "mastered";
  if (score >= 50) return "developing";
  return "gap";
}

const TONE_LABELS = {
  mastered: "O'zlashtirilgan",
  developing: "Rivojlanmoqda",
  gap: "Kamchilik",
  untested: "Tekshirilmagan",
};

// ─────────────────────────────────────────────
// O'RTACHA VA O'SISH
// ─────────────────────────────────────────────

/** Bo'sh massiv uchun `null` — 0 EMAS: "ma'lumot yo'q" va "nol ball" boshqa narsa. */
function calcAverage(scores) {
  const list = (scores || []).filter((n) => typeof n === "number" && !Number.isNaN(n));
  if (!list.length) return null;
  return Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10;
}

/**
 * SONLAR uchun nisbiy o'zgarish (%). Avvalgi 0 bo'lsa `null` — nolga
 * bo'linish ham, "cheksiz o'sish" degan ma'nosiz yorliq ham chiqmaydi.
 */
function growthPercent(current, previous) {
  if (previous == null || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/**
 * BALL uchun punktdagi farq: 72.4 va 66.2 → +6.2.
 *
 * ⚠️ Ballga `growthPercent` ISHLATILMAYDI: "60% dan 66% ga" o'zgarish 10%
 * o'sish emas, 6 punkt o'sish. Foizning foizi ota-onaga ham, o'qituvchiga
 * ham noto'g'ri o'qiladi.
 */
function growthPoints(current, previous) {
  if (current == null || previous == null) return null;
  return Math.round((current - previous) * 10) / 10;
}

/**
 * Har doim 100 ga yig'iladigan butun foizlar. Qoldiq eng katta guruhga
 * beriladi — aks holda "34 + 33 + 33 = 100" o'rniga 99 yoki 101 chiqib,
 * diagramma ostidagi jami noto'g'ri ko'rinardi.
 */
function categoryShares(good, medium, bad) {
  const total = good + medium + bad;
  if (total === 0) return { good: 0, medium: 0, bad: 0 };

  const shares = {
    good: Math.round((good / total) * 100),
    medium: Math.round((medium / total) * 100),
    bad: Math.round((bad / total) * 100),
  };

  const diff = 100 - (shares.good + shares.medium + shares.bad);
  if (diff !== 0) {
    const largest =
      good >= medium && good >= bad ? "good" : medium >= bad ? "medium" : "bad";
    shares[largest] += diff;
  }
  return shares;
}

/**
 * Avvalgi davr — AYNI UZUNLIKDAGI, `from` dan darhol oldingi oraliq.
 *
 * ⚠️ UZUNLIK KUNLARDA EMAS, MILLISEKUNDDA o'lchanadi. Oraliqning oxiri
 * kunning OXIRGI millisekundi (`23:59:59.999`), shuning uchun kun soniga
 * tayangan hisob bir kunga adashardi: "1–9-sentabr" (9 kun) uchun avvalgi
 * davr "22–31-avgust" (10 kun) bo'lib chiqib, o'sish foizi ham noto'g'ri
 * hisoblanardi.
 *
 * Bu yerda: `prevTo` — joriy oraliq boshlanishidan 1 ms oldin,
 * `prevFrom` — undan aynan shu uzunlikda orqada.
 */
function previousPeriod(from, to) {
  const durationMs = to.getTime() - from.getTime() + 1;
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(from.getTime() - durationMs);
  return { from: prevFrom, to: prevTo };
}

// ─────────────────────────────────────────────
// JAVOBNI SOLISHTIRISH
// ─────────────────────────────────────────────

/** Ikki id to'plami aynan tengmi (tartib ahamiyatsiz). */
function sameOptionSet(a = [], b = []) {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((x) => setB.has(x));
}

/**
 * Matnli javobni solishtirish uchun normallashtirish: kichik harf, ortiqcha
 * bo'shliqlar siqiladi, chekka tinish belgilari olib tashlanadi.
 *
 * ⚠️ APOSTROF VARIANTLARI BIRLASHTIRILADI (`'`, `’`, `ʻ`, `‘`). O'zbek
 * matnida "o'zbek", "o‘zbek" va "oʻzbek" — bitta so'z, lekin bayt darajasida
 * uchtasi ham boshqacha. Bunisiz to'g'ri javob klaviaturaga qarab xato
 * hisoblanardi.
 */
function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[‘’ʻʼ'`´]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/^[\s.,;:!?"«»()\-]+|[\s.,;:!?"«»()\-]+$/g, "")
    .trim();
}

/** Matnli javob qabul qilinadigan variantlardan biriga to'g'ri keladimi. */
function matchesText(answer, accepted = []) {
  const normalized = normalizeText(answer);
  if (!normalized) return false;
  return accepted.some((a) => normalizeText(a) === normalized);
}

// ─────────────────────────────────────────────
// XATO SABABI
// ─────────────────────────────────────────────

const ERROR_REASONS = {
  rushing: "Shoshilish",
  knowledge: "Bilim yetishmasligi",
  misread: "Noto'g'ri tushunish",
};

/**
 * NEGA xato qilindi — vaqt va javobni o'zgartirish sonidan.
 *
 * ⚠️ Bu diagnostikaning eng qimmatli javobi: "40 ball" degan raqam nima
 * qilish kerakligini aytmaydi, "xatolarning 60% i shoshilishdan" esa aytadi.
 * Shuning uchun har javobda `timeSpentSec` va `changeCount` yig'iladi.
 *
 * Qoida:
 *   - kutilgan vaqtning 35% idan tez (lekin kamida 10 soniya chegarasi bilan)
 *     → SHOSHILDI. 10 soniyalik pol majburiy: 12 soniyalik savolda "35%" 4
 *     soniya bo'lib, oddiy tez javob ham shoshilish deb belgilanardi;
 *   - javobni 2+ marta o'zgartirgan → savolni NOTO'G'RI TUSHUNGAN
 *     (ikkilanish — matn tushunarsiz bo'lganini bildiradi);
 *   - qolgani → BILIM yetishmasligi.
 *
 * @param {number} estimatedTime - savolga kutilgan vaqt (soniya)
 * @param {number|null|undefined} timeSpentSec
 * @param {number} changeCount
 * @returns {"rushing"|"knowledge"|"misread"}
 */
function classifyError(estimatedTime, timeSpentSec, changeCount = 0) {
  const threshold = Math.max(10, (estimatedTime || 60) * 0.35);
  if (timeSpentSec != null && timeSpentSec < threshold) return "rushing";
  if (changeCount >= 2) return "misread";
  return "knowledge";
}

/**
 * Xato sabablarining ULUSHI (foizda, jami 100).
 *
 * @param {{rushing:number,knowledge:number,misread:number}} counts
 * @param {number} wrongCount
 */
function errorPatternShares(counts, wrongCount) {
  if (!wrongCount) {
    return { wrongCount: 0, rushing: 0, knowledge: 0, misread: 0 };
  }
  const shares = categoryShares(counts.rushing, counts.knowledge, counts.misread);
  return {
    wrongCount,
    rushing: shares.good,
    knowledge: shares.medium,
    misread: shares.bad,
  };
}

// ─────────────────────────────────────────────
// ISHONCH OYNASI
// ─────────────────────────────────────────────

/**
 * Standart xato — natija qanchalik ishonchli ekani.
 *
 * ⚠️ 8 ta savollik test ham, 60 ta savollik test ham "72%" deb ko'rsatadi,
 * lekin birinchisining xatosi ancha katta. Buni yashirish — o'quvchini
 * chalg'itish, shuning uchun natija sahifasida ± oyna chiziladi.
 *
 * 1/√n, [0.20 … 0.75] oralig'iga siqiladi va 2 kasr xonagacha yaxlitlanadi.
 *
 * @param {number} answeredCount - baholangan (obyektiv) savollar soni
 * @returns {number} 0.20–0.75
 */
function standardError(answeredCount) {
  const n = Math.max(1, answeredCount || 0);
  const raw = 1 / Math.sqrt(n);
  return Math.round(Math.min(0.75, Math.max(0.2, raw)) * 100) / 100;
}

/**
 * Ballning ishonch oynasi (foizda). `seScore` — nisbiy o'lchov, uni ballga
 * ko'chirish uchun 100 ga ko'paytiriladi va 0–100 oralig'ida qirqiladi.
 */
function confidenceBand(score, seScore) {
  const margin = Math.round((seScore || 0) * 100 * 0.5);
  return {
    low: Math.max(0, Math.round(score) - margin),
    high: Math.min(100, Math.round(score) + margin),
    margin,
  };
}

// ─────────────────────────────────────────────
// YO'L XARITASI (heuristik zaxira)
// ─────────────────────────────────────────────

/**
 * Zaif mavzulardan hafta-hafta reja quradi.
 *
 * ⚠️ AI BO'LMASA HAM REJA CHIQADI. Diagnostikaning va'dasi — "nima qilishni
 * ko'rsataman"; AI kaliti yo'qligi yoki model yiqilishi bu va'dani buzmasligi
 * kerak. Shuning uchun bu funksiya AI'dan MUSTAQIL ishlaydi va AI javobi
 * kelganda uning ustiga yoziladi.
 *
 * @param {{topic:string, score:number}[]} breakdown - mavzular kesimi
 * @param {number} currentScore
 * @param {number} [weakThreshold=80] - shundan past mavzular rejaga tushadi
 */
function buildRoadmap(breakdown, currentScore, weakThreshold = 80) {
  const goal = Math.min(100, Math.round(currentScore) + 25);
  const weak = (breakdown || [])
    .filter((t) => t.score < weakThreshold)
    .sort((a, b) => a.score - b.score)
    .slice(0, 4);

  const steps = weak.map((topic, i) => ({
    week: i + 1,
    title: topic.topic,
    detail: `${topic.score}% — mustahkamlash kerak`,
    // Har hafta maqsad sari teng qadam. Oxirgi haftada bashorat aynan
    // `goal` ga tenglashadi.
    projected: Math.round(
      currentScore + ((goal - currentScore) * (i + 1)) / weak.length,
    ),
    checkpoint: i === weak.length - 1 ? "Nazorat testi" : null,
  }));

  return {
    goal,
    current: Math.round(currentScore),
    steps,
  };
}

// ─────────────────────────────────────────────
// KUN CHEGARASI (TOSHKENT)
// ─────────────────────────────────────────────

/**
 * ⚠️ `setHours()` ISHLATILMAYDI VA BU QAT'IY QOIDA.
 *
 * `setHours` SERVER LOKAL vaqti bilan ishlaydi. Ishlab chiqish mashinasi
 * Toshkentda (+5), production konteyneri esa odatda UTC — ya'ni bir xil
 * kod ikki joyda BOSHQA natija berardi va farq faqat productionda,
 * kechqurun ko'rinardi: soat 00:00–05:00 orasida topshirilgan urinishlar
 * "kechagi" oraliqqa tushib qolardi. Loyihaning o'z hujjati ham shundan
 * ogohlantiradi (`date.helpers.js` dagi `getDateRangeForDay` izohi).
 *
 * Shuning uchun chegara ISO satrning QISMLARIDAN, host taymzonasiga
 * umuman tegmasdan hisoblanadi. Toshkent — UTC+5, yozgi vaqt yo'q
 * (`education.md` §9), demak Toshkent yarim tuni = o'sha kunning UTC
 * yarim tunidan 5 soat OLDIN.
 */
const TASHKENT_OFFSET_HOURS = 5;

/** `"2026-09-09"` → o'sha kunning Toshkent yarim tuni (UTC instant). */
function tashkentDayStart(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate || ""));
  if (!match) return null;
  const [, year, month, day] = match;
  return new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), -TASHKENT_OFFSET_HOURS),
  );
}

/** Toshkent bo'yicha HOZIRGI kunning `YYYY-MM-DD` ko'rinishi. */
function tashkentToday() {
  const shifted = new Date(Date.now() + TASHKENT_OFFSET_HOURS * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** Instantni Toshkent kuniga (`YYYY-MM-DD`) keltiradi — guruhlash uchun. */
function tashkentDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + TASHKENT_OFFSET_HOURS * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
}

/** `YYYY-MM-DD` kunidan `days` kun oldingi/keyingi kun kaliti. */
function shiftDayKey(isoDate, days) {
  const start = tashkentDayStart(isoDate);
  if (!start) return null;
  return tashkentDayKey(new Date(start.getTime() + days * 86400000 + 1000));
}

/**
 * Kun kalitini haftaning DUSHANBASIGA keltiradi (uzun oraliqda guruhlash).
 * `getDay()` ham lokal — shuning uchun UTC getteri ishlatiladi.
 */
function weekStartKey(isoDate) {
  const start = tashkentDayStart(isoDate);
  if (!start) return null;
  // `start` — Toshkent yarim tuni; unga 5 soat qo'shsak o'sha kunning
  // UTC yarim tuni chiqadi va hafta kuni to'g'ri o'qiladi.
  const utcMidnight = new Date(start.getTime() + TASHKENT_OFFSET_HOURS * 3600 * 1000);
  const weekday = (utcMidnight.getUTCDay() + 6) % 7; // dushanba = 0
  return shiftDayKey(isoDate, -weekday);
}

// ─────────────────────────────────────────────
// VAQT
// ─────────────────────────────────────────────

/** Soniyani "12:05" ko'rinishiga keltiradi. Bo'sh bo'lsa — em-dash. */
function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Massivni JOYIDA emas, NUSXADA aralashtiradi (Fisher–Yates).
 * Savol va variant tartibini aralashtirish uchun.
 */
function shuffle(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Savol turlari: qaysilari AVTOMAT baholanadi.
 * `essay` — baholanmaydi (AI faqat izohlaydi), qolgani baholanadi.
 */
const AUTO_GRADED_TYPES = ["single", "multiple", "truefalse", "gap", "short"];

function isAutoGraded(type) {
  return AUTO_GRADED_TYPES.includes(type);
}

// ─────────────────────────────────────────────
// NATIJA SAHIFASINING HOSILA BLOKLARI
// ─────────────────────────────────────────────
//
// ⚠️ BULAR SERVERDA HISOBLANADI, PANELDA EMAS. Bitta natija UCH joyda
// ko'rsatiladi (o'quvchi paneli, admin paneli, Excel hisoboti) — formula
// panelga ko'chirilsa, uchtasi uch xil raqam chiqarardi. Aynan shu xato
// tayyor loyihada bor edi: "eng zaif mavzu" natija sahifasida bir xil,
// hisobotda boshqacha chiqardi.

/**
 * Mavzuni yopish uchun taxminiy mehnat.
 *
 * ⚠️ TAYYOR LOYIHADA BU SATR QOTIB QOLGAN EDI ("~1 hafta · 15 daq/kun"
 * har bir kartada bir xil) — ya'ni 12% li mavzu ham, 78% li mavzu ham
 * bir xil mehnat talab qilardi. Bu yerda u masofadan chiqadi: mavzu
 * o'zlashtirish chizig'idan (80%) qancha uzoq bo'lsa, shuncha ko'p vaqt.
 */
function estimateEffort(score) {
  const gap = Math.max(0, 80 - (Number.isFinite(score) ? score : 0));
  // Har 20 punkt ≈ bir hafta; kamida 1, ko'pi bilan 4 hafta.
  const weeks = Math.min(4, Math.max(1, Math.ceil(gap / 20)));
  // Chuqurroq bo'shliq kuniga ko'proq vaqt talab qiladi.
  const minutesPerDay = gap >= 50 ? 30 : gap >= 25 ? 20 : 15;
  return {
    weeks,
    minutesPerDay,
    label: `~${weeks} hafta · ${minutesPerDay} daq/kun`,
  };
}

/**
 * "Yopish kerak bo'lgan mavzular" — o'zlashtirilmagan mavzular, eng
 * zaifidan boshlab.
 *
 * ⚠️ MAXRAJ `diagnosisTone` (80/50), `classifyScore` (70/40) EMAS.
 * Ikkalasi ataylab har xil: birinchisi MAVZU o'zlashtirilganini, ikkinchisi
 * URINISH darajasini o'lchaydi. Chalkashtirilsa 72% li mavzu "yopish
 * kerak" ro'yxatidan tushib qolardi-yu, kesimda sariq turaverardi.
 */
function buildGaps(breakdown, limit = 4) {
  return (breakdown || [])
    .filter((t) => diagnosisTone(t.score) !== "mastered")
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
    .slice(0, limit)
    .map((t) => {
      const effort = estimateEffort(t.score);
      return {
        topicId: t.topicId || null,
        topic: t.topic,
        score: t.score,
        questions: t.questions ?? t.total ?? 0,
        correct: t.correct ?? 0,
        tone: diagnosisTone(t.score),
        effortWeeks: effort.weeks,
        effortMinutesPerDay: effort.minutesPerDay,
        effortLabel: effort.label,
        // Mavzuni o'zlashtirish chizig'iga olib chiqilsa umumiy natija
        // qancha o'sishi — mavzuning testdagi ULUSHIGA ko'paytiriladi.
        // Tayyor loyihada bu maydonga mavzuning JORIY foizi yozilgan edi
        // va yashil o'q bilan "o'sish" deb ko'rsatilardi.
        projectedGain: null,
      };
    });
}

/**
 * Har bir bo'shliqning umumiy ballga qo'shadigan ulushi.
 * Alohida funksiya, chunki u BUTUN testni (savollar sonini) biladi.
 */
function withProjectedGain(gaps, totalQuestions) {
  const total = totalQuestions || gaps.reduce((n, g) => n + (g.questions || 0), 0);
  if (!total) return gaps;
  return gaps.map((g) => ({
    ...g,
    projectedGain: Math.round(((80 - g.score) * (g.questions || 0)) / total),
  }));
}

/**
 * "Sizning 3 ta asosiy topilmangiz" — kuchli tomon, asosiy to'siq va
 * o'zgarish. HAR DOIM aynan uchta va HAR DOIM to'ldirilgan: AI matni
 * kelmagan bo'lsa ham qoidadan chiqqan matn turadi.
 */
function buildFindings({ breakdown = [], score = 0, previousScore = null, feedback = null }) {
  const sorted = [...breakdown].sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
  const worst = sorted[0] || null;
  const best = sorted[sorted.length - 1] || null;

  const ai = feedback && typeof feedback === "object" ? feedback : null;
  const aiStrength = ai?.strengths?.[0] || null;
  const aiWeakness = ai?.weaknesses?.[0] || null;

  const diff =
    previousScore != null && score != null
      ? Math.round((score - previousScore) * 10) / 10
      : null;

  return [
    {
      kind: "strength",
      label: "Kuchli tomon",
      // ⚠️ `topic` — MAVZU NOMINING O'ZI. Sarlavhadagi "Eng kuchli: …"
      // jumlasi shuni ishlatadi: u yerga karta sarlavhasi ("… yaxshi
      // o'zlashtirilgan") qo'yilsa, jumla ikki marta gapirib qolardi.
      topic: best ? best.topic : null,
      score: best ? Math.round(best.score) : null,
      title:
        aiStrength?.title ||
        (best ? `${best.topic} yaxshi o'zlashtirilgan` : "Barqaror asos"),
      detail:
        aiStrength?.body ||
        (best
          ? `Bu mavzuda ${Math.round(best.score)}% aniqlik.`
          : "Natijalar to'planganda kuchli tomon aniqroq ko'rinadi."),
      metric: best ? `${Math.round(best.score)}%` : null,
      source: aiStrength ? "ai" : "rules",
    },
    {
      kind: "blocker",
      label: "#1 to'siq",
      topic: worst ? worst.topic : null,
      score: worst ? Math.round(worst.score) : null,
      title:
        aiWeakness?.title ||
        (worst ? `${worst.topic} — asosiy to'siq` : "Aniq to'siq yo'q"),
      detail:
        aiWeakness?.body ||
        (worst
          ? "Shu bittasini yopish natijangizni sezilarli oshiradi."
          : "Barcha mavzular bir xil darajada o'zlashtirilgan."),
      metric: worst ? `${Math.round(worst.score)}%` : null,
      source: aiWeakness ? "ai" : "rules",
    },
    {
      kind: "change",
      label: "O'zgarish",
      positive: (diff ?? 0) >= 0,
      title:
        diff == null
          ? "Birinchi test"
          : diff > 0
            ? `O'tgan testdan +${diff} ball o'sish`
            : diff < 0
              ? `O'tgan testdan ${diff} ball`
              : "O'tgan test bilan bir xil",
      detail:
        diff == null
          ? "Keyingi testlar o'sishni ko'rsatadi."
          : "Oxirgi urinishga nisbatan.",
      // ⚠️ 0 da ko'rsatkich YOZILMAYDI: "+0 ball" ma'nosiz yorliq.
      metric: diff ? `${diff > 0 ? "+" : ""}${diff} ball` : null,
      source: "rules",
    },
  ];
}

/**
 * Bashorat egri chizig'i — bugungi ball va rejadagi har haftaning
 * bashorati. Grafik uchun bitta massiv.
 */
function roadmapCurve(roadmap, currentScore) {
  const start = roadmap?.current ?? (currentScore != null ? Math.round(currentScore) : null);
  const projected = (roadmap?.steps || [])
    .map((s) => s.projected)
    .filter((n) => typeof n === "number");
  const points = start != null ? [start, ...projected] : projected;
  // Bitta nuqtali "egri chiziq" chizilmaydi.
  return points.length > 1 ? points : [];
}

/** Variant talab qiladigan turlar — validatsiyada ishlatiladi. */
const OPTION_TYPES = ["single", "multiple", "truefalse", "gap"];

function needsOptions(type) {
  return OPTION_TYPES.includes(type);
}

module.exports = {
  LEVELS,
  LEVEL_LABELS,
  DEFAULT_LEVEL_TIERS,
  GRADE_LABELS,
  TONE_LABELS,
  ERROR_REASONS,
  AUTO_GRADED_TYPES,
  OPTION_TYPES,
  resolveLevelTiers,
  classifyScore,
  gradeLabel,
  diagnosisTone,
  calcAverage,
  growthPercent,
  growthPoints,
  categoryShares,
  previousPeriod,
  sameOptionSet,
  normalizeText,
  matchesText,
  classifyError,
  errorPatternShares,
  standardError,
  confidenceBand,
  buildRoadmap,
  estimateEffort,
  buildGaps,
  withProjectedGain,
  buildFindings,
  roadmapCurve,
  formatDuration,
  shuffle,
  TASHKENT_OFFSET_HOURS,
  tashkentDayStart,
  tashkentToday,
  tashkentDayKey,
  shiftDayKey,
  weekStartKey,
  isAutoGraded,
  needsOptions,
};
