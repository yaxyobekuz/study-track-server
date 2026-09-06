#!/usr/bin/env node
/**
 * AKADEMIK DASHBOARD UCHUN NAMUNAVIY MA'LUMOT — FAQAT LOCAL BAZA.
 *
 *     npm run seed:academic -- --yes
 *     npm run seed:academic -- --yes --dry-run
 *     npm run seed:academic -- --yes --reset
 *     npm run seed:academic -- --yes --all-branches --months=12
 *
 * ⚠️ FAQAT BUYRUQ SATRIDAN ISHLAYDI. `require.main === module` bo'lmasa
 * fayl HECH NARSA bajarmaydi — na qo'riqchi, na baza ulanishi, na
 * `process.exit`. Shu sababli sof funksiyalarini (`stableId`,
 * `buildMonths`, `monthProgress`…) sinovda import qilib bo'ladi.
 *
 * ⚠️ BU SKRIPT PRODUCTION BAZAGA ISHLAMAYDI. Uchta qo'riqchi ishga
 * tushishning ENG BOSHIDA (`bootstrapCli`), bironta `prisma` chaqiruvidan
 * — hatto `require` idan — OLDIN tekshiriladi va bittasi bajarilmasa
 * jarayon DARHOL to'xtaydi:
 *   1. `config.nodeEnv !== "production"`
 *   2. `DATABASE_URL` xosti localhost / 127.0.0.1 (`new URL()` bilan ajratiladi,
 *      satr qidiruvi bilan EMAS: "db.prod-localhost.example.com" o'tib ketardi)
 *   3. Buyruqda `--yes` bayrog'i bor
 *
 * ⚠️ MOLIYAGA TEGMAYDI. Bu yerda pul harakati yo'q — faqat o'quv jarayoni:
 * baholar, davomat, topshiriqlar, olimpiada yutuqlari, to'garaklar va oylik
 * reja. Moliya uchun alohida skript bor: `npm run finance:demo`.
 *
 * IDEMPOTENTLIK — har qatorning `id` si DETERMINISTIK (seed + tabiiy kalit
 * sha1). Shu sababli:
 *   · takroriy yugurish `skipDuplicates` bilan hech narsa qo'shmaydi
 *     (va yakuniy hisobot buni AYTADI — sanoq `createMany` qaytargan
 *     haqiqiy sondan olinadi, urinilgan qatorlardan emas);
 *   · `--reset` aynan shu skript yozadigan id'larni o'chiradi, ya'ni
 *     haqiqiy ma'lumotga TEGMAYDI (WHERE id IN (...), sana oralig'i emas).
 *
 * ⚠️ `--reset` joriy parametrlar (`--seed`, `--months`) hosil qiladigan id
 * to'plamini qayta yozadi. Seed yoki oylar soni o'zgarsa, eski yugurishdan
 * qolgan qatorlar boshqa id fazosida qoladi — avval eski parametrlar bilan
 * `--reset` qiling.
 */

// ─────────────────────────────────────────────
// 1-QISM: QO'RIQCHILAR (prisma require'dan OLDIN)
// ─────────────────────────────────────────────

require("dotenv").config();

const { config } = require("../config/env.config");

/**
 * Skript BUYRUQ SATRIDAN ishga tushirildimi.
 *
 * ⚠️ Busiz fayl `require` qilingan zahoti ISHGA TUSHARDI: `main()` modul
 * darajasida shartsiz chaqirilib, `process.exit()` bilan tugardi. Ikkita
 * oqibati bor edi va ikkalasi ham jiddiy:
 *   1. skriptdan bitta sof funksiyani (`stableId`, `buildMonths`) import
 *      qilib sinov yozib bo'lmasdi — test runner require qilgan zahoti
 *      `process.exit` bilan o'lardi va bironta natija qaytmasdi;
 *   2. bayroqlar HOST jarayonining `process.argv` idan o'qilardi, ya'ni
 *      `--yes` bilan ishga tushgan istalgan jarayon shu faylni require
 *      qilsa, seeder HAQIQATAN yozishni boshlardi.
 */
const IS_CLI = require.main === module;

// ⚠️ Bayroqlar FAQAT CLI da o'qiladi — host jarayonning argv i emas.
const ARGV = IS_CLI ? process.argv.slice(2) : [];
const hasFlag = (name) => ARGV.includes(`--${name}`);
const flagValue = (name, fallback) => {
  const hit = ARGV.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

/**
 * localhost sifatida qabul qilinadigan xostlar.
 *
 * ⚠️ IPv6 KVADRAT QAVS BILAN: `new URL("postgresql://u:p@[::1]:5432/db").hostname`
 * `"[::1]"` qaytaradi, `"::1"` emas. Ro'yxatda faqat qavssiz ko'rinish
 * turganda IPv6-only local Postgres bilan ishlaydigan dasturchi seed'ni
 * umuman yugurtira olmasdi — skript uning local bazasini "local emas"
 * deb rad etardi.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Uchta shartni tekshiradi. Bittasi bajarilmasa ANIQ sabab bilan to'xtaydi.
 * @returns {{host: string, port: string, database: string}}
 */
function assertLocalOrExit() {
  const stop = (reason, hint) => {
    console.error(`\n✖ TO'XTATILDI — ${reason}`);
    if (hint) console.error(`  ${hint}`);
    console.error("  Hech narsa yozilmadi.\n");
    process.exit(1);
  };

  // 1) Muhit
  if (config.nodeEnv === "production") {
    stop(
      'NODE_ENV="production".',
      "Namunaviy ma'lumot faqat development/test muhitida yoziladi.",
    );
  }

  // 2) Baza xosti — URL sifatida ajratiladi, satr qidiruvi bilan emas
  let parsed;
  try {
    parsed = new URL(config.databaseUrl);
  } catch {
    stop(
      "DATABASE_URL yaroqli URL emas (yoki umuman berilmagan).",
      "Namuna: postgresql://user:pass@localhost:5432/study_track?schema=public",
    );
  }

  const host = parsed.hostname;
  if (!LOCAL_HOSTS.has(host)) {
    stop(
      `DATABASE_URL xosti "${host}" — local emas.`,
      `Ruxsat etilgan xostlar: ${[...LOCAL_HOSTS].join(", ")}.`,
    );
  }

  // 3) Ochiq tasdiq
  if (!hasFlag("yes")) {
    stop(
      "`--yes` bayrog'i berilmagan.",
      "Yozishga rozilik ochiq bo'lishi kerak: npm run seed:academic -- --yes" +
        " (bu `--dry-run` uchun ham talab qilinadi).",
    );
  }

  return {
    host,
    port: parsed.port || "5432",
    database: parsed.pathname.replace(/^\//, "") || "?",
  };
}

// ─────────────────────────────────────────────
// 2-QISM: BOG'LIQLIKLAR (qo'riqchilardan KEYIN)
// ─────────────────────────────────────────────

const crypto = require("crypto");

/**
 * Bazaga tegadigan modullar KECHIKTIRIB yuklanadi.
 *
 * ⚠️ Tartib O'ZGARMAYDI — qo'riqchilar baribir birinchi bo'lib ishlaydi
 * (`bootstrapCli` ning birinchi qatori), ya'ni "prisma require'idan
 * OLDIN to'xtaydi" kafolati saqlanadi. Farqi shundaki, endi bularning
 * hech biri fayl shunchaki `require` qilinganda YUKLANMAYDI: sof
 * funksiyalarni sinovdan o'tkazish uchun baza ulanishi kerak emas.
 */
let DB = null;
let prisma = null;
let platformPrisma = null;
let runWithBranch = null;
let branchService = null;
let forEachBranch = null;

function bootstrapCli() {
  DB = assertLocalOrExit(); // ⚠️ QO'RIQCHILAR — hamma narsadan OLDIN
  prisma = require("../config/prisma");
  platformPrisma = require("../config/platformPrisma");
  ({ runWithBranch } = require("../config/branchContext"));
  branchService = require("../services/branch.service");
  ({ forEachBranch } = require("../helpers/branchIterator"));
}

const {
  currentMonthKey,
  prevMonth,
  daysInMonth,
  formatMonthKey,
} = require("../helpers/month.helpers");

// ─────────────────────────────────────────────
// 3-QISM: SOZLAMALAR
// ─────────────────────────────────────────────

const DRY_RUN = hasFlag("dry-run");
const RESET = hasFlag("reset");
const ALL_BRANCHES = hasFlag("all-branches");
const SEED = flagValue("seed", "academic-demo-v1");
const MONTHS = Math.max(1, Math.min(36, Number(flagValue("months", 12)) || 12));
/** Bitta o'quvchiga nechta fandan baho yoziladi (hajmni ushlab turadi). */
const MAX_SUBJECTS_PER_STUDENT = Math.max(
  1,
  Math.min(20, Number(flagValue("subjects", 8)) || 8),
);

/** `createMany` to'plami. O'n minglab qator qatorma-qator yozilmaydi. */
const CHUNK = 1000;

/** Oyiga har fandan nechta baho. */
const GRADES_PER_SUBJECT_MONTH = { min: 3, max: 6 };
/** Oyiga nechta yutuq. */
const ACHIEVEMENTS_PER_MONTH = { min: 2, max: 6 };
/** Nechta to'garak ochiladi. */
const CLUB_COUNT = { min: 8, max: 12 };
/** O'quvchilarning qanchasi to'garakka a'zo. */
const CLUB_MEMBER_SHARE = 0.4;

/** Ish kunining boshlanishi/tugashi — Toshkent (UTC+5). */
const WORK_START_MIN = 8 * 60 + 30;
const WORK_END_MIN = 17 * 60;
const LATE_GRACE_MIN = 10;

const CLUB_CATALOG = [
  { name: "Robototexnika", subject: "Informatika", hours: 4 },
  { name: "Shaxmat", subject: null, hours: 3 },
  { name: "Matematika olimpiada guruhi", subject: "Matematika", hours: 4 },
  { name: "Ingliz tili so'zlashuv klubi", subject: "Ingliz tili", hours: 3 },
  { name: "Yosh kimyogarlar", subject: "Kimyo", hours: 2 },
  { name: "Fizika laboratoriyasi", subject: "Fizika", hours: 3 },
  { name: "Adabiyot va sahna", subject: "Ona tili va adabiyot", hours: 2 },
  { name: "Tasviriy san'at", subject: null, hours: 3 },
  { name: "Milliy raqs", subject: null, hours: 3 },
  { name: "Futbol seksiyasi", subject: null, hours: 6 },
  { name: "Yosh biologlar", subject: "Biologiya", hours: 2 },
  { name: "Veb-dasturlash", subject: "Informatika", hours: 4 },
];

const TASK_TEMPLATES = [
  ["Oylik dars rejasini topshirish", "Kelgusi oy uchun mavzular rejasini bo'lim mudiriga topshiring."],
  ["Jurnal to'ldirilishini tekshirish", "Barcha sinflar bo'yicha baholar jurnalidagi bo'sh kataklarni to'ldiring."],
  ["Ochiq dars tayyorlash", "Metodik kengash uchun ochiq dars ishlanmasini tayyorlang."],
  ["Ota-onalar yig'ilishi bayonnomasi", "Yig'ilish bayonnomasini rasmiylashtirib topshiring."],
  ["Olimpiadaga nomzodlarni belgilash", "Tuman bosqichiga tavsiya etiladigan o'quvchilar ro'yxatini bering."],
  ["Sinf xonasi inventarini tekshirish", "Xonadagi jihozlar holatini ko'rib chiqib, ro'yxatni yangilang."],
  ["Test bazasini yangilash", "O'z faningiz bo'yicha kamida 20 ta yangi savol qo'shing."],
  ["Malaka oshirish kursi hisoboti", "Kurs yakuniy hisobotini tizimga yuklang."],
  ["Davomat hisobotini yopish", "Oy yakunidagi davomat hisobotini tasdiqlang."],
  ["Kuchsiz o'zlashtiruvchilar bilan ish", "Qo'shimcha mashg'ulot jadvalini kelishib oling."],
];

const ACHIEVEMENT_TITLES = [
  "Fan olimpiadasi",
  "Zakovat intellektual bellashuvi",
  "Ijodkor yoshlar tanlovi",
  "Bilimlar bellashuvi",
  "Yosh iqtidorlar ko'rigi",
  "Maktablararo musobaqa",
];

const ABSENCE_NOTES = [
  "Shifokor ko'rigida",
  "Oilaviy sabab",
  "Kasallik varaqasi",
  "Musobaqada qatnashdi",
];

// ─────────────────────────────────────────────
// 4-QISM: DETERMINIZM — PRNG va barqaror ID
// ─────────────────────────────────────────────

/**
 * `Math.random` ATAYLAB ishlatilmaydi: bir xil seed bilan bir xil baza
 * chiqishi kerak, aks holda "kecha dashboardda ko'rgan raqam" bugun boshqa
 * bo'lib qolardi va xatolikni takrorlab bo'lmasdi.
 */
function makeRng(...parts) {
  const key = `${SEED}|${parts.join("|")}`;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }

  let a = h;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    /** [min, max] — ikkala chet ham kiradi. */
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    float: (min, max) => min + next() * (max - min),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** [{ value, weight }] — og'irliklar yig'indisi ixtiyoriy. */
    weighted: (pairs) => {
      const total = pairs.reduce((s, p) => s + Math.max(0, p.weight), 0);
      let roll = next() * total;
      for (const pair of pairs) {
        roll -= Math.max(0, pair.weight);
        if (roll <= 0) return pair.value;
      }
      return pairs[pairs.length - 1].value;
    },
    /** Massivdan `n` ta takrorlanmas element (Fisher–Yates nusxa ustida). */
    sample: (arr, n) => {
      const copy = arr.slice();
      const take = Math.min(n, copy.length);
      for (let i = 0; i < take; i += 1) {
        const j = i + Math.floor(next() * (copy.length - i));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy.slice(0, take);
    },
  };
}

/**
 * Tabiiy kalitdan barqaror 24-belgili hex ID.
 *
 * Bu shunchaki qulaylik emas, IDEMPOTENTLIK MEXANIZMI: qator qaysi
 * yugurishda yozilganidan qat'i nazar bir xil id oladi, ya'ni ikkinchi
 * yugurish `skipDuplicates` bilan jimgina o'tib ketadi va `--reset`
 * aynan shu id'larni o'chiradi — sana oralig'i bo'yicha emas, ya'ni
 * haqiqiy ma'lumotga tegmaydi.
 */
function stableId(...parts) {
  return crypto
    .createHash("sha1")
    .update(`${SEED}|${parts.join("|")}`)
    .digest("hex")
    .slice(0, 24);
}

// ─────────────────────────────────────────────
// 5-QISM: KUN KOORDINATASI
// ─────────────────────────────────────────────

/** Bugungi kun — UTC yarim tun, TOSHKENT kalendari bo'yicha. */
function todayUtcDay() {
  const now = new Date();
  const t = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 5 * 3600000);
  return new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()));
}

const TODAY = todayUtcDay();

/** Oxirgi `count` oy (joriy oy bilan birga), eskidan yangiga. */
function buildMonths(count) {
  const months = [];
  let m = currentMonthKey();
  for (let i = 0; i < count; i += 1) {
    months.unshift(m);
    m = prevMonth(m);
  }
  return months;
}

/**
 * Oyning ISH KUNLARI (dush–jum), kelajakdagi kunlarsiz.
 * Dam olish kuni — `getUTCDay()` 0 (yakshanba) va 6 (shanba).
 */
function workdaysOfMonth(monthKey) {
  const year = Math.trunc(monthKey / 100);
  const month = (monthKey % 100) - 1;
  const days = [];
  for (let d = 1; d <= daysInMonth(monthKey); d += 1) {
    const date = new Date(Date.UTC(year, month, d));
    const dow = date.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (date.getTime() > TODAY.getTime()) break; // kelajak sana yozilmaydi
    days.push(date);
  }
  return days;
}

/** Oyning TO'LIQ ish kunlari soni (kelajak kunlar ham sanaladi). */
function workdayCountOfMonth(monthKey) {
  const year = Math.trunc(monthKey / 100);
  const month = (monthKey % 100) - 1;
  let total = 0;
  for (let d = 1; d <= daysInMonth(monthKey); d += 1) {
    const dow = new Date(Date.UTC(year, month, d)).getUTCDay();
    if (dow !== 0 && dow !== 6) total += 1;
  }
  return total;
}

/**
 * Oyning qancha qismi O'TGAN (0..1).
 *
 * ⚠️ HAJM SHUNGA BOG'LIQ. Busiz tugallanmagan joriy oy TO'LIQ oyning
 * hajmini olardi: oyning 6-kunida 4 ta ish kuniga to'liq oylik baho,
 * yutuq va topshiriq yozilib, kunlik zichlik ~5 barobar yuqori chiqardi.
 * Dashboarddagi SANOQ turidagi KPI lar (yutuqlar, topshiriqlar) o'tgan oy
 * bilan taqqoslanadi, ya'ni oy boshida "o'tgan oyga nisbatan" ustuni doim
 * yolg'on tekis ko'rinardi.
 */
function monthProgress(monthKey, workdays) {
  const full = workdayCountOfMonth(monthKey);
  if (full === 0) return 0;
  return Math.min(1, workdays.length / full);
}

/** Oylik hajmni o'tgan qismga moslashtiradi (kamida 0). */
function scaleToProgress(count, progress) {
  if (progress >= 1) return count;
  return Math.max(0, Math.round(count * progress));
}

/** UTC yarim tundagi kunga Toshkent daqiqasini qo'shadi (09:00 → 04:00Z). */
function atTashkentMinute(day, minutes) {
  return new Date(day.getTime() + (minutes - 5 * 60) * 60000);
}

const dayKey = (date) => date.toISOString().slice(0, 10);

/** Instantni UTC yarim tundagi KUN koordinatasiga keltiradi. */
function utcDayOf(value) {
  const d = new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ─────────────────────────────────────────────
// 6-QISM: YOZUVCHI (chunk + dry-run)
// ─────────────────────────────────────────────

function makeWriter() {
  const counts = new Map();
  const skipped = new Map();

  return {
    counts,
    skipped,
    /**
     * Qatorlarni to'plamlab yozadi.
     * `--reset` da avval AYNAN shu id'lar o'chiriladi (haqiqiy qatorlar emas),
     * `--reset` siz esa `skipDuplicates` mavjudini qayta yozmaydi.
     *
     * ⚠️ SANOQ `createMany` QAYTARGAN SONDAN olinadi, `rows.length` dan
     * EMAS. `skipDuplicates` unikal cheklovga urilgan qatorni JIMGINA
     * tashlab yuboradi (masalan `StudentAttendance` dagi
     * `@@unique([studentId, date])` — o'sha kunga haqiqiy davomat allaqachon
     * bor), ya'ni urinilgan qatorlarni sanash hisobotni yolg'on qilardi:
     * ekranda "648 qator yozildi" turardi, bazaga esa 0 ta qator tushardi
     * va foydalanuvchida sabab izlash uchun bironta ishora qolmasdi.
     */
    async write(modelName, rows) {
      if (rows.length === 0) return;

      if (DRY_RUN) {
        counts.set(modelName, (counts.get(modelName) ?? 0) + rows.length);
        return;
      }

      const delegate = prisma[modelName];
      let written = 0;

      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        if (RESET) {
          await delegate.deleteMany({ where: { id: { in: chunk.map((r) => r.id) } } });
        }
        const result = await delegate.createMany({ data: chunk, skipDuplicates: true });
        written += result.count ?? 0;
      }

      counts.set(modelName, (counts.get(modelName) ?? 0) + written);
      if (written < rows.length) {
        skipped.set(modelName, (skipped.get(modelName) ?? 0) + (rows.length - written));
      }
    },
    total() {
      let sum = 0;
      for (const n of counts.values()) sum += n;
      return sum;
    },
  };
}

// ─────────────────────────────────────────────
// 7-QISM: MA'LUMOTNI O'QISH
// ─────────────────────────────────────────────

async function loadContext() {
  const [owner, students, staff, teachers, classes, subjects, userSubjects] =
    await Promise.all([
      prisma.user.findFirst({ where: { role: "owner" }, select: { id: true } }),
      prisma.user.findMany({
        where: { role: "student", isArchived: false },
        select: { id: true, classes: { select: { classId: true } } },
        orderBy: { id: "asc" },
      }),
      prisma.user.findMany({
        where: { role: { notIn: ["owner", "student"] }, isArchived: false },
        select: { id: true, role: true, workStartTime: true, workEndTime: true },
        orderBy: { id: "asc" },
      }),
      prisma.user.findMany({
        where: { role: "teacher", isArchived: false },
        select: { id: true },
        orderBy: { id: "asc" },
      }),
      prisma.class.findMany({
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      prisma.subject.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      prisma.userSubject.findMany({ select: { userId: true, subjectId: true } }),
    ]);

  const studentIds = students.map((s) => s.id);
  const enrollments = studentIds.length
    ? await prisma.studentEnrollment.findMany({
        where: { studentId: { in: studentIds } },
        select: { studentId: true, startDate: true, endDate: true },
      })
    : [];

  const enrollmentsByStudent = new Map();
  for (const row of enrollments) {
    const list = enrollmentsByStudent.get(row.studentId) ?? [];
    list.push(row);
    enrollmentsByStudent.set(row.studentId, list);
  }

  const classById = new Map(classes.map((c) => [c.id, c]));
  const teachersBySubject = new Map();
  const teacherIds = new Set(teachers.map((t) => t.id));
  for (const link of userSubjects) {
    if (!teacherIds.has(link.userId)) continue;
    const list = teachersBySubject.get(link.subjectId) ?? [];
    list.push(link.userId);
    teachersBySubject.set(link.subjectId, list);
  }

  return {
    owner,
    students,
    staff,
    teachers,
    classes,
    subjects,
    classById,
    teachersBySubject,
    enrollmentsByStudent,
  };
}

/**
 * O'quvchi shu kunda maktabdami?
 *
 * ⚠️ `finance.md` §3: "davr yo'q" degani o'quvchida BITTA HAM qator yo'q
 * degani. Bunday holatda ma'lumot to'liq emas — biz uni "o'qiydi" deb
 * qabul qilamiz, aks holda demo bazada hech narsa chiqmasdi.
 */
function isEnrolledOn(periods, day) {
  if (!periods || periods.length === 0) return true;
  return periods.some(
    (p) =>
      p.startDate.getTime() <= day.getTime() &&
      (p.endDate == null || day.getTime() <= p.endDate.getTime()),
  );
}

/** "9-A" → 9, "Bog'cha — katta guruh" → 1. */
function classLevel(name) {
  const hit = /^\s*(\d{1,2})/.exec(name ?? "");
  const level = hit ? Number(hit[1]) : 1;
  return Math.max(1, Math.min(11, level));
}

// ─────────────────────────────────────────────
// 8-QISM: BAHOLAR
// ─────────────────────────────────────────────

/**
 * Baho taqsimoti: 5≈30%, 4≈45%, 3≈20%, 2≈4%, 1≈1%.
 * Ustiga ikki og'ish: sinf darajasi (kichik sinflarda o'rtacha yuqoriroq)
 * va o'quvchining o'z darajasi — aks holda dashboarddagi har bir sinf bir
 * xil raqam ko'rsatib, "jonli" ko'rinmasdi.
 */
function gradeWeights(level, ability) {
  const tilt = (6 - level) * 0.7 + ability * 2.2;
  const clamp = (v) => Math.max(0.2, v);
  return [
    { value: 5, weight: clamp(30 + tilt * 3.4) },
    { value: 4, weight: clamp(45 + tilt * 0.4) },
    { value: 3, weight: clamp(20 - tilt * 2.2) },
    { value: 2, weight: clamp(4 - tilt * 1.1) },
    { value: 1, weight: clamp(1 - tilt * 0.35) },
  ];
}

function buildGrades(ctx, monthKey, workdays) {
  const rows = [];
  if (ctx.subjects.length === 0 || workdays.length === 0) return rows;

  const fallbackTeachers = ctx.teachers.length ? ctx.teachers.map((t) => t.id) : null;

  // ⚠️ Oylik hajm o'tgan ish kunlariga bog'lanadi (`monthProgress`).
  // Kamida bitta baho qoladi: joriy oyni butunlay bo'sh qoldirish
  // `dataGaps` ni yoqib, demo dashboardni ma'nosiz qilardi.
  const progress = monthProgress(monthKey, workdays);

  for (const student of ctx.students) {
    // Baho qatorida `classId` MAJBURIY va hisobotlar aynan shu ustun bo'yicha
    // kesiladi — sinfsiz o'quvchiga soxta sinf qo'yish o'rniga o'tkazib
    // yuboriladi (yakunda "sinfsiz o'quvchi" sifatida sanaladi).
    const classId = student.classes[0]?.classId;
    if (!classId) continue;

    const periods = ctx.enrollmentsByStudent.get(student.id);
    const level = classLevel(ctx.classById.get(classId)?.name);

    const abilityRng = makeRng("ability", student.id);
    const ability = abilityRng.float(-1, 1);

    // ⚠️ Fanlar to'plami SINF bo'yicha tanlanadi, o'quvchi bo'yicha EMAS:
    // bitta sinfdagi bolalar bir xil dars jadvalida o'qiydi. O'quvchi
    // bo'yicha mustaqil tanlovda (fanlar soni chegaradan ko'p bo'lganda)
    // "9-A" ning 25 o'quvchisidan Kimyo bo'yicha bahoni faqat ~13 tasi
    // olardi va "kuchsiz fan" ro'yxati o'zlashtirishni emas, tasodifiy
    // tanlov nechta bolani qamraganini ko'rsatardi.
    const subjectRng = makeRng("subjects", classId);
    const subjects = subjectRng.sample(ctx.subjects, MAX_SUBJECTS_PER_STUDENT);
    const weights = gradeWeights(level, ability);

    for (const subject of subjects) {
      const rng = makeRng("grade", student.id, subject.id, monthKey);
      const monthly = rng.int(GRADES_PER_SUBJECT_MONTH.min, GRADES_PER_SUBJECT_MONTH.max);
      const count = progress >= 1 ? monthly : Math.max(1, scaleToProgress(monthly, progress));
      const days = rng.sample(workdays, count);

      const teacherPool = ctx.teachersBySubject.get(subject.id) ?? fallbackTeachers;
      if (!teacherPool || teacherPool.length === 0) continue;
      const teacherId = teacherPool[Math.abs(hashInt(subject.id)) % teacherPool.length];

      for (const day of days) {
        if (!isEnrolledOn(periods, day)) continue;
        rows.push({
          id: stableId("grade", student.id, subject.id, dayKey(day)),
          studentId: student.id,
          subjectId: subject.id,
          classId,
          teacherId,
          grade: rng.weighted(weights),
          date: day,
          lessonOrder: 1,
          comment: null,
        });
      }
    }
  }

  return rows;
}

/** Kichik yordamchi: satrdan barqaror butun son (teacher tanlash uchun). */
function hashInt(value) {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (Math.imul(h, 31) + value.charCodeAt(i)) | 0;
  return h;
}

// ─────────────────────────────────────────────
// 9-QISM: O'QUVCHI DAVOMATI
// ─────────────────────────────────────────────

const STUDENT_STATUS_WEIGHTS = [
  { value: "present", weight: 92 },
  { value: "late", weight: 3 },
  { value: "excused", weight: 3 },
  { value: "absent", weight: 2 },
];

function buildStudentAttendance(ctx, monthKey, workdays) {
  const rows = [];

  for (const student of ctx.students) {
    const classId = student.classes[0]?.classId;
    if (!classId) continue; // sinfsiz o'quvchida davomat belgisi bo'lmaydi
    const periods = ctx.enrollmentsByStudent.get(student.id);
    const rng = makeRng("st-att", student.id, monthKey);

    for (const day of workdays) {
      if (!isEnrolledOn(periods, day)) continue;
      const status = rng.weighted(STUDENT_STATUS_WEIGHTS);
      rows.push({
        id: stableId("st-att", student.id, dayKey(day)),
        studentId: student.id,
        classId,
        date: day,
        status,
        markedAt: atTashkentMinute(day, 9 * 60 + rng.int(0, 25)),
        excuseReason: status === "excused" ? rng.pick(ABSENCE_NOTES) : null,
        autoMarked: false,
        createdBy: ctx.markerId,
      });
    }
  }

  return rows;
}

// ─────────────────────────────────────────────
// 10-QISM: XODIM DAVOMATI (KPI ustuni bo'sh qolmasligi uchun MAJBURIY)
// ─────────────────────────────────────────────

const STAFF_STATUS_WEIGHTS = [
  { value: "present", weight: 90 },
  { value: "late", weight: 5 },
  { value: "excused", weight: 3 },
  { value: "absent", weight: 2 },
];

function parseTimeToMinutes(value, fallback) {
  const hit = /^(\d{1,2}):(\d{2})$/.exec(value ?? "");
  if (!hit) return fallback;
  return Number(hit[1]) * 60 + Number(hit[2]);
}

function buildStaffAttendance(ctx, monthKey, workdays) {
  const rows = [];

  for (const person of ctx.staff) {
    const startMin = parseTimeToMinutes(person.workStartTime, WORK_START_MIN);
    const endMin = parseTimeToMinutes(person.workEndTime, WORK_END_MIN);
    const rng = makeRng("staff-att", person.id, monthKey);

    // ⚠️ XODIM DAVOMATI ISH DAVRI BILAN CHEGARALANMAYDI va bu ATAYLAB.
    // O'quvchi tomonida `isEnrolledOn` bor, chunki `StudentEnrollment` —
    // haqiqiy KUN aniqligidagi davr jadvali. Xodimda bunday jadval yo'q,
    // `User.createdAt` esa ishga qabul sanasi EMAS, QATOR YARATILGAN
    // payt: mavjud bazada barcha xodim (va o'quvchi) `createdAt` i
    // ma'lumot ko'chirilgan kunga teng. Uni chegara qilib olsak, seed
    // xodim davomatini UMUMAN yozmay qo'yardi (o'lchandi: ikkala oyda ham
    // 0 qator) va o'qituvchilar KPI jadvali bo'sh qolardi.
    for (const day of workdays) {
      const status = rng.weighted(STAFF_STATUS_WEIGHTS);
      const row = {
        id: stableId("staff-att", person.id, dayKey(day)),
        userId: person.id,
        date: day,
        status,
        checkIn: null,
        checkOut: null,
        isLate: false,
        lateMinutes: 0,
        isEarlyOut: false,
        earlyOutMinutes: 0,
        excuseReason: status === "excused" ? rng.pick(ABSENCE_NOTES) : null,
        autoMarked: false,
        createdBy: ctx.markerId,
      };

      if (status === "present" || status === "late") {
        // Kechikish `late` da kafolatlangan, `present` da esa grace ichida
        const delta =
          status === "late"
            ? LATE_GRACE_MIN + rng.int(1, 35)
            : rng.int(-20, LATE_GRACE_MIN - 1);
        const arrival = startMin + delta;
        const departure = endMin + rng.int(-25, 45);

        row.checkIn = atTashkentMinute(day, arrival);
        row.checkOut = atTashkentMinute(day, departure);
        row.isLate = delta > LATE_GRACE_MIN;
        row.lateMinutes = row.isLate ? delta - LATE_GRACE_MIN : 0;
        row.isEarlyOut = departure < endMin - LATE_GRACE_MIN;
        row.earlyOutMinutes = row.isEarlyOut ? endMin - departure : 0;
      }

      rows.push(row);
    }
  }

  return rows;
}

// ─────────────────────────────────────────────
// 11-QISM: TOPSHIRIQLAR (~85% bajarilgan)
// ─────────────────────────────────────────────

const OPEN_TASK_STATUSES = [
  { value: "pending", weight: 45 },
  { value: "pending_review", weight: 25 },
  { value: "extended", weight: 20 },
  { value: "stopped", weight: 10 },
];

function buildTasks(ctx, monthKey, workdays) {
  const rows = [];
  if (ctx.staff.length === 0 || workdays.length === 0) return rows;

  // ⚠️ Tugallanmagan oyda hajm ham tugallanmagan bo'ladi — izohga qarang
  // (`monthProgress`).
  const progress = monthProgress(monthKey, workdays);

  for (const person of ctx.staff) {
    const rng = makeRng("task", person.id, monthKey);
    const count = scaleToProgress(rng.int(1, 3), progress);

    for (let i = 0; i < count; i += 1) {
      const [title, description] = rng.pick(TASK_TEMPLATES);
      const due = rng.pick(workdays);
      const completed = rng.chance(0.85);
      const createdAt = new Date(due.getTime() - rng.int(3, 12) * 86400000);

      rows.push({
        id: stableId("task", person.id, monthKey, i),
        title,
        description,
        assignee: person.id,
        createdBy: ctx.markerId,
        status: completed ? "completed" : rng.weighted(OPEN_TASK_STATUSES),
        dueDate: atTashkentMinute(due, 18 * 60),
        penaltyPoints: rng.int(1, 3),
        completionNote: completed ? "Bajarildi va topshirildi." : null,
        autopenalized: false,
        createdAt,
      });
    }
  }

  return rows;
}

// ─────────────────────────────────────────────
// 12-QISM: OLIMPIADA YUTUQLARI
// ─────────────────────────────────────────────

const LEVEL_WEIGHTS = [
  { value: "school", weight: 38 },
  { value: "district", weight: 26 },
  { value: "city", weight: 15 },
  { value: "region", weight: 12 },
  { value: "republic", weight: 7 },
  { value: "international", weight: 2 },
];

const PLACE_WEIGHTS = [
  { value: "participant", weight: 38 },
  { value: "third", weight: 22 },
  { value: "second", weight: 19 },
  { value: "first", weight: 21 },
];

function buildAchievements(ctx, monthKey, workdays) {
  const rows = [];
  if (ctx.students.length === 0 || workdays.length === 0) return rows;

  const rng = makeRng("achievement", monthKey);
  // ⚠️ Yutuq — SANOQ turidagi KPI: tugallanmagan oyga to'liq oylik son
  // yozilsa, dashboard oy boshidayoq "o'tgan oy bilan teng" deb ko'rsatardi.
  const count = scaleToProgress(
    rng.int(ACHIEVEMENTS_PER_MONTH.min, ACHIEVEMENTS_PER_MONTH.max),
    monthProgress(monthKey, workdays),
  );
  if (count === 0) return rows;
  const winners = rng.sample(ctx.students, count);

  winners.forEach((student, i) => {
    const day = rng.pick(workdays);
    if (!isEnrolledOn(ctx.enrollmentsByStudent.get(student.id), day)) return;

    const subject = ctx.subjects.length ? rng.pick(ctx.subjects) : null;
    const level = rng.weighted(LEVEL_WEIGHTS);
    const title = subject
      ? `${subject.name} bo'yicha ${rng.pick(ACHIEVEMENT_TITLES).toLowerCase()}`
      : rng.pick(ACHIEVEMENT_TITLES);

    rows.push({
      id: stableId("achievement", monthKey, i, student.id),
      studentId: student.id,
      subjectId: subject?.id ?? null,
      title,
      level,
      place: rng.weighted(PLACE_WEIGHTS),
      date: day, // @db.Date — UTC yarim tun
      note: null,
      createdBy: ctx.markerId,
    });
  });

  return rows;
}

// ─────────────────────────────────────────────
// 13-QISM: TO'GARAKLAR VA A'ZOLIKLAR
// ─────────────────────────────────────────────

function buildClubs(ctx, months) {
  const rng = makeRng("clubs");
  const count = rng.int(CLUB_COUNT.min, CLUB_COUNT.max);
  const chosen = CLUB_CATALOG.slice(0, count);

  const subjectByName = new Map(ctx.subjects.map((s) => [s.name.toLowerCase(), s]));
  const teacherPool = ctx.teachers.length ? ctx.teachers : ctx.staff;

  const clubs = chosen.map((entry, i) => ({
    id: stableId("club", entry.name),
    name: entry.name,
    description: `${entry.name} to'garagi — qo'shimcha mashg'ulot.`,
    teacherId: teacherPool.length ? teacherPool[i % teacherPool.length].id : null,
    subjectId: entry.subject ? (subjectByName.get(entry.subject.toLowerCase())?.id ?? null) : null,
    weeklyHours: entry.hours,
    isActive: true,
    createdBy: ctx.markerId,
  }));

  // A'zoliklar — SANALI (`ClubMember` izohi): oyni kesib o'tgan davr
  // hisobotdan jimgina yo'qolmasligi kerak.
  const firstMonth = months[0];
  const windowStart = new Date(
    Date.UTC(Math.trunc(firstMonth / 100), (firstMonth % 100) - 1, 1),
  );

  /**
   * A'zolik boshlanadigan oyna — TANLANGAN OYLARDAN kelib chiqadi.
   *
   * ⚠️ Ilgari bu 300 kunlik qotib qolgan oyna edi va `--months` bilan
   * bog'lanmagan edi: `--months=1` da tasodifiy siljish 2027-yilgacha
   * cho'zilib, oshib ketgani `start = TODAY` bilan bir kunga qisilardi.
   * Natijada 83 a'zolikdan 81 tasi BUGUN boshlanardi va yopilganlarining
   * `endDate` i `startDate` ga teng — NOL UZUNLIKDAGI a'zolik — bo'lardi.
   * Dashboard buni "to'garak qamrovi +40 punkt sakradi" deb ko'rsatardi:
   * hech qanday hodisa emas, demo ma'lumotning artefakti.
   */
  const windowDays = Math.max(
    1,
    Math.round((TODAY.getTime() - windowStart.getTime()) / 86400000),
  );

  const memberRng = makeRng("club-members");
  const memberCount = Math.round(ctx.students.length * CLUB_MEMBER_SHARE);
  const members = [];

  for (const student of memberRng.sample(ctx.students, memberCount)) {
    const rng2 = makeRng("club-member", student.id);
    const perStudent = rng2.chance(0.3) ? 2 : 1;

    for (const club of rng2.sample(clubs, perStudent)) {
      const offsetDays = rng2.int(0, windowDays);
      let start = new Date(windowStart.getTime() + offsetDays * 86400000);
      if (start.getTime() > TODAY.getTime()) start = TODAY;

      const ended = rng2.chance(0.15);
      let end = null;
      if (ended) {
        const candidate = new Date(start.getTime() + rng2.int(45, 210) * 86400000);
        end = candidate.getTime() > TODAY.getTime() ? TODAY : candidate;
      }

      members.push({
        id: stableId("club-member", club.id, student.id),
        clubId: club.id,
        studentId: student.id,
        startDate: start,
        endDate: end,
        createdBy: ctx.markerId,
      });
    }
  }

  return { clubs, members };
}

// ─────────────────────────────────────────────
// 14-QISM: OYLIK REJA (AcademicTarget)
// ─────────────────────────────────────────────

/**
 * Reja qiymatlari `helpers/academicMetrics.js` KALITLARI bilan yoziladi.
 * Yorliq va turi kodda turadi — bazaga faqat kalit tushadi.
 */
function buildTargets(ctx, months) {
  const current = months[months.length - 1];
  const previous = months.length > 1 ? months[months.length - 2] : prevMonth(current);
  const rows = [];

  for (const month of [previous, current]) {
    const rng = makeRng("target", month);
    const plan = {
      students: Math.max(1, Math.round(ctx.students.length * rng.float(1.02, 1.12))),
      averageGrade: rng.float(4.1, 4.4).toFixed(2),
      qualityRate: rng.int(70, 80),
      attendanceRate: rng.int(92, 96),
      taskCompletion: rng.int(85, 93),
      achievements: rng.int(4, 9),
    };

    for (const [metric, value] of Object.entries(plan)) {
      rows.push({
        id: stableId("target", month, metric),
        month,
        metric,
        planValue: String(Number(value).toFixed(2)),
        createdBy: ctx.markerId,
      });
    }
  }

  return rows;
}

// ─────────────────────────────────────────────
// 15-QISM: BITTA FILIAL
// ─────────────────────────────────────────────

async function seedBranch(branch) {
  const ctx = await loadContext();

  const marker = ctx.owner ?? ctx.staff[0] ?? ctx.teachers[0];
  if (!marker) {
    throw new Error(
      "Bazada birorta xodim yo'q — avval foydalanuvchi yarating " +
        "(`npm run branch:bootstrap` yoki admin panel).",
    );
  }
  ctx.markerId = marker.id;

  const notes = [];
  if (ctx.students.length === 0) notes.push("o'quvchi topilmadi — baho/davomat yozilmadi");
  if (ctx.subjects.length === 0) notes.push("faol fan topilmadi — baho yozilmadi");
  if (ctx.teachers.length === 0) notes.push("o'qituvchi topilmadi — baho o'rniga xodim biriktirildi");
  if (ctx.classes.length === 0) notes.push("sinf topilmadi — o'quvchi davomati o'tkazib yuborildi");
  if (ctx.staff.length === 0) notes.push("xodim topilmadi — xodim davomati va topshiriq yozilmadi");

  const classless = ctx.students.filter((s) => s.classes.length === 0).length;
  if (classless > 0) {
    notes.push(`${classless} o'quvchi hech qaysi sinfda emas — ularga baho va davomat yozilmadi`);
  }

  const months = buildMonths(MONTHS);
  const writer = makeWriter();

  console.log(
    `  ${branch.name}: ${ctx.students.length} o'quvchi, ${ctx.staff.length} xodim, ` +
      `${ctx.subjects.length} fan, ${months.length} oy`,
  );

  // To'garaklar avval — a'zolik ularga FK bilan bog'lanadi
  const { clubs, members } = buildClubs(ctx, months);
  await writer.write("club", clubs);
  await writer.write("clubMember", members);
  console.log(`    to'garaklar: ${clubs.length}, a'zolik: ${members.length}`);

  // Oyma-oy: xotirada bir vaqtda faqat bitta oyning qatorlari turadi
  for (const monthKey of months) {
    const workdays = workdaysOfMonth(monthKey);
    if (workdays.length === 0) continue;

    const grades = buildGrades(ctx, monthKey, workdays);
    const studentAtt = buildStudentAttendance(ctx, monthKey, workdays);
    const staffAtt = buildStaffAttendance(ctx, monthKey, workdays);
    const tasks = buildTasks(ctx, monthKey, workdays);
    const achievements = buildAchievements(ctx, monthKey, workdays);

    await writer.write("grade", grades);
    await writer.write("studentAttendance", studentAtt);
    await writer.write("attendance", staffAtt);
    await writer.write("task", tasks);
    await writer.write("studentAchievement", achievements);

    console.log(
      `    ${formatMonthKey(monthKey)}: baho ${grades.length}, ` +
        `o'quvchi davomati ${studentAtt.length}, xodim davomati ${staffAtt.length}, ` +
        `topshiriq ${tasks.length}, yutuq ${achievements.length}`,
    );
  }

  const targets = buildTargets(ctx, months);
  await writer.write("academicTarget", targets);
  console.log(`    reja: ${targets.length} ko'rsatkich`);

  return { counts: writer.counts, skipped: writer.skipped, total: writer.total(), notes };
}

// ─────────────────────────────────────────────
// 16-QISM: KIRISH NUQTASI
// ─────────────────────────────────────────────

async function main() {
  console.log("\n─── Akademik dashboard uchun namunaviy ma'lumot ───\n");
  console.log(`  Baza    : ${DB.host}:${DB.port}/${DB.database}`);
  console.log(`  Muhit   : ${config.nodeEnv}`);
  console.log(`  Rejim   : ${DRY_RUN ? "DRY-RUN (hech narsa yozilmaydi)" : RESET ? "RESET (demo qatorlar qayta yoziladi)" : "qo'shish (mavjudi o'tkazib yuboriladi)"}`);
  console.log(`  Seed    : ${SEED}`);
  console.log(`  Oylar   : oxirgi ${MONTHS} oy`);
  console.log(`  Filial  : ${ALL_BRANCHES ? "BARCHASI" : "joriy (bosh) filial"}\n`);

  const started = Date.now();
  const results = [];

  if (ALL_BRANCHES) {
    const branchResults = await forEachBranch(
      async (branch) => seedBranch(branch),
      { label: "[AcademicDemo]" },
    );
    for (const r of branchResults) {
      if (r.error) console.error(`  ✖ ${r.branch.name}: ${r.error.message}`);
      else results.push({ branch: r.branch, ...r.value });
    }
  } else {
    const branch = await branchService.getDefaultBranch();
    if (!branch) {
      throw new Error("Filial topilmadi — avval `npm run branch:bootstrap`.");
    }
    const value = await runWithBranch(branch, () => seedBranch(branch));
    results.push({ branch, ...value });
  }

  // Yakuniy jamlanma
  const totals = new Map();
  const skippedTotals = new Map();
  const notes = [];
  for (const r of results) {
    for (const [model, n] of r.counts) totals.set(model, (totals.get(model) ?? 0) + n);
    for (const [model, n] of r.skipped ?? []) {
      skippedTotals.set(model, (skippedTotals.get(model) ?? 0) + n);
    }
    for (const note of r.notes) notes.push(`${r.branch.name}: ${note}`);
  }

  console.log(`\n  ${DRY_RUN ? "Yoziladigan" : "Yozilgan"} qatorlar:`);
  const labels = {
    grade: "Baholar",
    studentAttendance: "O'quvchi davomati",
    attendance: "Xodim davomati",
    task: "Topshiriqlar",
    studentAchievement: "Yutuqlar",
    club: "To'garaklar",
    clubMember: "To'garak a'zoliklari",
    academicTarget: "Oylik reja",
  };
  let grand = 0;
  for (const [model, n] of totals) {
    grand += n;
    console.log(`    ${(labels[model] ?? model).padEnd(22)} ${String(n).padStart(8)}`);
  }
  console.log(`    ${"JAMI".padEnd(22)} ${String(grand).padStart(8)}`);

  // ⚠️ TASHLAB YUBORILGAN QATORLAR JIM QOLMAYDI. `skipDuplicates` unikal
  // cheklovga urilganini indamay o'tkazadi (o'sha kunga haqiqiy davomat
  // bor, yoki skript ikkinchi marta yugurtirilgan) — buni aytmasak,
  // foydalanuvchi "yozildi" degan hisobotni o'qib, dashboardda bo'sh
  // kesimni ko'rib, sababni izlashga hech qanday ishorasiz qolardi.
  if (skippedTotals.size) {
    console.log("\n  ℹ️  Mavjud qatorlar (yozilmadi, o'tkazib yuborildi):");
    for (const [model, n] of skippedTotals) {
      console.log(`    ${(labels[model] ?? model).padEnd(22)} ${String(n).padStart(8)}`);
    }
    console.log("    Sabab: bir xil id yoki unikal cheklov (masalan o'sha kundagi davomat).");
    console.log("    Qayta yozish uchun: --reset");
  }

  if (notes.length) {
    console.log("\n  ⚠️  Diqqat:");
    for (const note of notes) console.log(`    · ${note}`);
  }

  console.log(
    `\n✔ ${DRY_RUN ? "Hisoblandi (baza o'zgarmadi)" : "Tayyor"} — ` +
      `${Math.round((Date.now() - started) / 1000)}s\n`,
  );

  await platformPrisma.$disconnect?.();
  process.exit(0);
}

// ─────────────────────────────────────────────
// 17-QISM: ISHGA TUSHIRISH
// ─────────────────────────────────────────────

/**
 * ⚠️ FAQAT BUYRUQ SATRIDAN. `require` qilingan fayl hech narsa
 * bajarmaydi: na qo'riqchi, na baza ulanishi, na `process.exit` —
 * shuning uchun quyidagi sof funksiyalarni sinovda ishlatish mumkin
 * (`IS_CLI` izohiga qarang).
 */
if (IS_CLI) {
  bootstrapCli();

  main().catch(async (error) => {
    console.error("\n✖ Xatolik:", error.message);
    if (process.env.DEBUG) console.error(error);
    process.exit(1);
  });
}

module.exports = {
  // Sof funksiyalar — bazaga tegmaydi, sinov uchun ochiladi
  makeRng,
  stableId,
  buildMonths,
  workdaysOfMonth,
  workdayCountOfMonth,
  monthProgress,
  scaleToProgress,
  utcDayOf,
  dayKey,
};
