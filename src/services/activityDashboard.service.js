/**
 * FAOLLIK DASHBOARDI — O'QISH TOMONI.
 *
 * Bitta savolga javob beradi: **tizimdan KIM foydalanyapti?**
 *
 * ⚠️ STATISTIKADAN FARQI. Statistika NATIJANI o'lchaydi (baho, davomat,
 * tushum), faollik esa JALB QILINGANLIKNI: ota-ona botni ochdimi,
 * o'qituvchi panelga kirdimi. Ikkinchisi boshqacha qaror chiqaradi —
 * "bu sinfning ota-onalari xabarni ko'rmayapti, sinf rahbariga aytish
 * kerak" yoki "bu o'qituvchi bir oydan beri tizimga kirmagan".
 *
 * ── UCHTA MAXRAJ, UCHALASI HAM ATAYLAB BOSHQA ────────────────────────
 *
 *   O'QUVCHILAR   — `StudentEnrollment` bo'yicha (`education.md` §3).
 *                   ⚠️ `User.isActive`/`isArchived` EMAS: ular LOGIN
 *                   bayroqlari va "bu o'quvchi o'qiyaptimi" degan
 *                   savolga javob bermaydi. `User` sanog'ini olsak,
 *                   bugun kimnidir arxivlash O'TGAN OY foizini
 *                   jimgina o'zgartirib yuborardi.
 *
 *   BOG'LANGANLAR — `TgUser` qatorlari. ⚠️ Bitta o'quvchida IKKITA
 *                   bog'langan hisob bo'lishi mumkin (ona va ota),
 *                   shuning uchun "faol ota-onalar" va "qamrab olingan
 *                   o'quvchilar" — IKKI XIL raqam va ikkalasi ham
 *                   ko'rsatiladi.
 *
 *   XODIMLAR      — `role notIn [owner, student]`, arxivlanmaganlar.
 *
 * ── HALOL ATAMALAR ──────────────────────────────────────────────────
 *
 * ⚠️ "O'QILDI" DEGAN RAQAM YO'Q va bo'lishi ham mumkin emas: Telegram
 * Bot API o'qish tasdig'ini BERMAYDI. Shuning uchun ekranda faqat
 * "yuborildi" va "ochildi" (foydalanuvchi botda biror harakat qildi)
 * turadi. "O'qildi" deb yozish yolg'on bo'lardi.
 *
 * ⚠️ TARIX YO'Q. Kim qachon botga kirgani ilgari HECH QAYERDA
 * saqlanmagan (`TgUser.lastActivity` faqat bog'langan lahzada bir marta
 * yozilgan edi). Shuning uchun javobda `collecting` bayrog'i bor:
 * birinchi haftalarda ekran "ma'lumot yig'ilmoqda" deydi, 0% ni
 * falokat qilib ko'rsatmaydi.
 *
 * ⚠️ CHIQUVCHI HODISALAR SANOQQA KIRMAYDI. `bot.out.*` — bu BIZ
 * yuborgan xabar, foydalanuvchi harakati emas. Ular alohida
 * ("yetkazish") ko'rsatiladi; faol foydalanuvchi sanog'iga qo'shilsa,
 * kechki hisobot yuborilgan har bir ota-ona "faol" bo'lib chiqardi.
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { currentDayDate } = require("../helpers/month.helpers");
const {
  formatDateUz,
  formatDateTimeUz,
  formatDateRangeUz,
} = require("../helpers/date.helpers");
const { formatMonthKey } = require("../helpers/month.helpers");
const {
  ACTIVITY_CHANNELS,
  ACTIVITY_CHANNEL_LABELS,
  ROLES,
} = require("../utils/constants");

/**
 * DAVR — GRANULYARLIK BILAN BIRGA.
 *
 * ⚠️ "30 kun" va "30 hafta" bir xil tanlagichda tursa, foydalanuvchi
 * qaysi birini tanlaganini bilmasdi. Shuning uchun har granulyarlikning
 * O'Z variantlari bor va ular BIRLIKDA (kun / hafta / oy) o'lchanadi:
 * "oxirgi 12 hafta" degan yozuv "84 kun" dan tushunarliroq.
 *
 * ⚠️ OY GRANULYARLIGIDA oyna KALENDAR oylar bo'yicha hisoblanadi,
 * "30 kun × N" bilan emas: fevral va mart bir xil uzunlikda emas va
 * yaqinlashtirilgan oyna oylar chegarasini siljitib yuborardi.
 */
const GRANULARITY = {
  day: { key: "day", label: "Kunlik", options: [7, 14, 30, 90], fallback: 30 },
  week: { key: "week", label: "Haftalik", options: [4, 8, 12, 26], fallback: 12 },
  month: { key: "month", label: "Oylik", options: [3, 6, 12, 24], fallback: 6 },
};

const GRANULARITIES = Object.keys(GRANULARITY);

/** Orqaga moslik: `days` parametri hamon ishlaydi (kunlik granulyarlik). */
const PERIODS = GRANULARITY.day.options;

/** Xodim ro'yxatidan chiqariladigan rollar. */
const NON_STAFF_ROLES = [ROLES.OWNER, ROLES.STUDENT];

/** Chiquvchi (biz yuborgan) hodisalar prefiksi — faollik sanog'iga kirmaydi. */
const OUTBOUND_PREFIX = "bot.out.";

/** Bot harakatlarining o'zbekcha nomlari. */
const ACTION_LABELS = {
  "bot.start": "Botni ochish",
  "bot.link": "Hisobni bog'lash",
  "bot.grades": "Baholarni ko'rish",
  "bot.settings": "Sozlamalar",
  "bot.statistics": "Statistika",
  "bot.notifications": "Bildirishnoma sozlash",
  "bot.unlink": "Hisobni uzish",
  "bot.message": "Boshqa xabar",
  "bot.out.report": "Kunlik hisobot yuborildi",
  "bot.out.failed": "Yuborilmadi",
  "panel.request": "Panelda ish",
};

/* ═══════════════════════ YORDAMCHILAR ═══════════════════════ */

/**
 * `Date` → "YYYY-MM-DD" (UTC). Kalit sifatida ishlatiladi, EKRANGA
 * chiqmaydi (`dates.md` §3 dagi istisno).
 *
 * ⚠️ XOM SQL PARAMETRI HAM SHU SHAKLDA BERILADI (`${dayKey(x)}::date`),
 * `Date` obyekti EMAS. Sabab: PostgreSQL seansi `Asia/Tashkent` da
 * ishlaydi, Prisma esa `Date` ni `timestamptz` qilib yuboradi — natijada
 * `DATE` ustuni bilan taqqoslashda qiymat +5 soatga suriladi va
 * "bugungi" so'rov BO'SH qaytadi (oraliq so'rovi esa jimgina to'g'ri
 * ishlaydi, chunki quyi chegara kengroq). Satr → `date` konversiyasi
 * taymzonaga umuman bog'liq emas.
 *
 * ⚠️ Prisma ORM so'rovlarida (`where: { day: { gte, lte } }`) bu muammo
 * YO'Q — u `@db.Date` ni to'g'ri uzatadi. Tuzoq faqat `$queryRaw` da.
 *
 * @param {Date} date
 * @returns {string}
 */
const dayKey = (date) => date.toISOString().slice(0, 10);

/**
 * Kunni siljitadi (UTC yarim tunida qoladi).
 * @param {Date} date
 * @param {number} days
 * @returns {Date}
 */
const shiftDay = (date, days) =>
  new Date(date.getTime() + days * 24 * 3600 * 1000);

/**
 * Foiz — 0 ga bo'lishdan himoyalangan, bir xonali kasr bilan.
 * @param {number} part
 * @param {number} whole
 * @returns {number}
 */
const rate = (part, whole) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;

/** BigInt (raw SQL `COUNT`) → Number. */
const num = (value) => Number(value ?? 0);

/**
 * Davrni tekshirib, kun oralig'iga aylantiradi.
 *
 * @param {object} params
 * @returns {{ days: number, from: Date, to: Date, prevFrom: Date, prevTo: Date }}
 */
function resolvePeriod({ days, granularity, count, inherited = false } = {}) {
  const grain = GRANULARITY[granularity] ?? GRANULARITY.day;

  // ⚠️ `inherited` — TAFSILOT EKRANLARI UCHUN (`getSubject`, `getClass`).
  //
  // Ular o'z tanlagichiga EGA EMAS: oyna ota-ekrandan meros qoladi va
  // u haftalik rejimda 84, oylikda esa 150+ kun bo'lishi mumkin —
  // ya'ni `options` ro'yxatida yo'q. Qat'iy tekshiruv bu yerda
  // 400 qaytarardi va modal umuman ochilmasdi.
  //
  // Meros qolgan qiymat FOYDALANUVCHI KIRITMASI EMAS (u ota-ekranda
  // allaqachon tekshirilgan), shuning uchun bu yerda faqat oqilona
  // chegara qo'yiladi — cheksiz oyna bilan og'ir so'rov yuborib
  // bo'lmasligi uchun.
  if (inherited) {
    const span = Math.min(Math.max(Number(days) || grain.fallback, 1), 400);
    const to = currentDayDate();
    const from = shiftDay(to, -(span - 1));
    const prevTo = shiftDay(from, -1);

    return {
      grain: "day",
      grainLabel: GRANULARITY.day.label,
      count: span,
      options: GRANULARITY.day.options,
      days: span,
      from,
      to,
      prevFrom: shiftDay(prevTo, -(span - 1)),
      prevTo,
    };
  }

  // ⚠️ `days` — ESKI parametr va u hamon qabul qilinadi: bosh
  // sahifadagi "Bot faolligi" bloki va tashqi chaqiruvlar undan
  // foydalanadi. Yangi `count` berilsa u ustun turadi.
  const requested =
    count != null
      ? Number(count)
      : days != null && grain.key === "day"
        ? Number(days)
        : grain.fallback;

  if (!grain.options.includes(requested)) {
    throw new BadRequestError(
      `Davr noto'g'ri. "${grain.label}" uchun ruxsat etilgan qiymatlar: ${grain.options.join(", ")}`,
    );
  }

  const to = currentDayDate();
  let from;

  if (grain.key === "month") {
    // Kalendar oylar: joriy oyning 1-kunidan (count-1) oy orqaga
    const d = new Date(to);
    from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (requested - 1), 1));
  } else if (grain.key === "week") {
    // Dushanbadan boshlanadigan haftalar (PostgreSQL `date_trunc('week')`
    // ham dushanbadan boshlaydi — ikkalasi mos kelishi shart)
    const dow = (to.getUTCDay() + 6) % 7;
    const monday = shiftDay(to, -dow);
    from = shiftDay(monday, -(requested - 1) * 7);
  } else {
    from = shiftDay(to, -(requested - 1));
  }

  // Taqqoslash — AYNAN shuncha uzunlikdagi oldingi davr. Uzunligi bir
  // xil bo'lmasa, "o'sdi/kamaydi" ko'rsatkichi ma'nosini yo'qotardi.
  const spanDays = Math.round((to - from) / 86400000) + 1;
  const prevTo = shiftDay(from, -1);
  const prevFrom = shiftDay(prevTo, -(spanDays - 1));

  return {
    grain: grain.key,
    grainLabel: grain.label,
    count: requested,
    options: grain.options,
    days: spanDays,
    from,
    to,
    prevFrom,
    prevTo,
  };
}

/* ═══════════════════════ MAXRAJLAR ═══════════════════════ */

/**
 * Shu paytda O'QIYOTGAN o'quvchilar — `StudentEnrollment` bo'yicha.
 *
 * ⚠️ `education.md` §3: davr yo'q = o'qimaydi. Ochiq davr (`endDate:
 * null`) yoki bugunni qamragan davr — ikkalasi ham "o'qiyapti".
 *
 * @returns {Promise<string[]>}
 */
async function studyingStudentIds() {
  const today = currentDayDate();

  const rows = await prisma.studentEnrollment.findMany({
    where: {
      startDate: { lte: today },
      OR: [{ endDate: null }, { endDate: { gte: today } }],
    },
    select: { studentId: true },
    distinct: ["studentId"],
  });

  return rows.map((row) => row.studentId);
}

/**
 * Har o'quvchi uchun BITTA sinf — kalit bo'yicha eng kichigi.
 *
 * ⚠️ `UserClass` sanasiz M2M va o'quvchi bir nechta sinfda bo'lishi
 * mumkin. Tanlov DETERMINISTIK bo'lmasa, sinf kesimlarining yig'indisi
 * maktab jamisidan oshib ketardi va "25 tadan 20 tasi" degan da'voni
 * tekshirib bo'lmasdi (`academicDashboard.service.js` bilan bir xil
 * qaror).
 *
 * @param {string[]} studentIds
 * @returns {Promise<{ classOfStudent: Map<string,string>, classNames: Map<string,string> }>}
 */
async function resolveClasses(studentIds) {
  if (studentIds.length === 0) {
    return { classOfStudent: new Map(), classNames: new Map() };
  }

  const [links, classRows] = await Promise.all([
    prisma.userClass.findMany({
      where: { userId: { in: studentIds } },
      select: { userId: true, classId: true },
    }),
    prisma.class.findMany({ select: { id: true, name: true } }),
  ]);

  const classOfStudent = new Map();
  for (const row of links) {
    const chosen = classOfStudent.get(row.userId);
    if (chosen == null || row.classId < chosen) {
      classOfStudent.set(row.userId, row.classId);
    }
  }

  return {
    classOfStudent,
    classNames: new Map(classRows.map((row) => [row.id, row.name])),
  };
}

/* ═══════════════════════ XOM YIG'MALAR ═══════════════════════ */

/**
 * NOYOB FAOL ODAMLAR — kanal kesimida.
 *
 * ⚠️ `$queryRaw` SHART: Prisma `groupBy` da `COUNT(DISTINCT ...)` yo'q.
 * Uni JS tomonida hisoblash barcha qatorlarni tortib olishni talab
 * qilardi — 30 kunlik hodisa oqimi esa o'n minglab qator.
 *
 * ⚠️ `actor_key` bo'yicha sanaladi, `user_id`/`telegram_id` ni
 * `COALESCE` qilib emas: `@@index([actorKey, day])` aynan shuning
 * uchun bor.
 *
 * @param {Date} from
 * @param {Date} to
 * @returns {Promise<Map<string, { users: number, events: number }>>}
 */
async function activeByChannel(from, to) {
  const rows = await prisma.$queryRaw`
    SELECT channel::text AS channel,
           COUNT(DISTINCT actor_key)::int AS users,
           COUNT(*)::int                  AS events
      FROM activity_events
     WHERE day BETWEEN ${dayKey(from)}::date AND ${dayKey(to)}::date
       AND action NOT LIKE ${`${OUTBOUND_PREFIX}%`}
     GROUP BY channel
  `;

  return new Map(
    rows.map((row) => [row.channel, { users: num(row.users), events: num(row.events) }]),
  );
}

/**
 * TREND — davr bo'laklari bo'yicha noyob odamlar.
 *
 * ⚠️ HAFTALIK/OYLIK SANOQNI KUNLIKDAN YIG'IB BO'LMAYDI. Bir odam
 * haftaning besh kunida kirsa, kunlik qatorlarda u besh marta
 * sanaladi — yig'indi "5 kishi" berardi, aslida esa BITTA odam.
 * Shuning uchun bo'lak SQL darajasida hosil qilinadi va
 * `COUNT(DISTINCT)` har bo'lak ichida bir marta ishlaydi.
 *
 * ⚠️ `date_trunc('week')` PostgreSQL da DUSHANBADAN boshlaydi —
 * `resolvePeriod` dagi hafta boshi ham dushanba. Ikkalasi mos
 * kelmasa, birinchi bo'lak yarim bo'lib chiqardi.
 *
 * @param {Date} from
 * @param {Date} to
 * @param {string} grain - "day" | "week" | "month"
 * @returns {Promise<Map<string, { bot: number, panel: number, events: number }>>}
 */
async function bucketSeries(from, to, grain) {
  // ⚠️ `$queryRawUnsafe` EMAS: `grain` foydalanuvchidan keladi.
  // `resolvePeriod` uni allaqachon oq ro'yxatdan o'tkazgan, lekin
  // bu yerda ham aniq `switch` turadi — ikkinchi qavat himoya
  // parametrni SQL matniga qo'shishning yagona xavfsiz yo'li.
  const unit = grain === "month" ? "month" : grain === "week" ? "week" : "day";

  const rows =
    unit === "day"
      ? await prisma.$queryRaw`
          SELECT to_char(day, 'YYYY-MM-DD') AS bucket,
                 COUNT(DISTINCT actor_key) FILTER (WHERE channel = 'bot')::int  AS bot,
                 COUNT(DISTINCT actor_key) FILTER (WHERE channel <> 'bot')::int AS panel,
                 COUNT(*)::int                                                  AS events
            FROM activity_events
           WHERE day BETWEEN ${dayKey(from)}::date AND ${dayKey(to)}::date
             AND action NOT LIKE ${`${OUTBOUND_PREFIX}%`}
           GROUP BY day
           ORDER BY day
        `
      : unit === "week"
        ? await prisma.$queryRaw`
            SELECT to_char(date_trunc('week', day), 'YYYY-MM-DD') AS bucket,
                   COUNT(DISTINCT actor_key) FILTER (WHERE channel = 'bot')::int  AS bot,
                   COUNT(DISTINCT actor_key) FILTER (WHERE channel <> 'bot')::int AS panel,
                   COUNT(*)::int                                                  AS events
              FROM activity_events
             WHERE day BETWEEN ${dayKey(from)}::date AND ${dayKey(to)}::date
               AND action NOT LIKE ${`${OUTBOUND_PREFIX}%`}
             GROUP BY 1
             ORDER BY 1
          `
        : await prisma.$queryRaw`
            SELECT to_char(date_trunc('month', day), 'YYYY-MM-DD') AS bucket,
                   COUNT(DISTINCT actor_key) FILTER (WHERE channel = 'bot')::int  AS bot,
                   COUNT(DISTINCT actor_key) FILTER (WHERE channel <> 'bot')::int AS panel,
                   COUNT(*)::int                                                  AS events
              FROM activity_events
             WHERE day BETWEEN ${dayKey(from)}::date AND ${dayKey(to)}::date
               AND action NOT LIKE ${`${OUTBOUND_PREFIX}%`}
             GROUP BY 1
             ORDER BY 1
          `;

  return new Map(
    rows.map((row) => [
      row.bucket,
      { bot: num(row.bot), panel: num(row.panel), events: num(row.events) },
    ]),
  );
}

/**
 * Trend qatorini bo'shliqlarsiz quradi.
 *
 * ⚠️ HODISASI YO'Q BO'LAK HAM QATORDA TURADI: diagramma faqat mavjud
 * bo'laklarni chizsa, dam olish kunidagi tanaffus ko'rinmay qolardi va
 * chiziq uzluksiz "yaxshi" bo'lib ko'rinardi.
 *
 * @param {object} period
 * @param {Map} series
 * @returns {object[]}
 */
function buildTrend(period, series) {
  const rows = [];

  for (let i = 0; i < period.count; i += 1) {
    let start;
    let end;
    let label;

    if (period.grain === "month") {
      const base = new Date(period.from);
      start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + i, 1));
      end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
      const monthKey = start.getUTCFullYear() * 100 + start.getUTCMonth() + 1;
      label = formatMonthKey(monthKey);
    } else if (period.grain === "week") {
      start = shiftDay(period.from, i * 7);
      end = shiftDay(start, 6);
      label = formatDateRangeUz(start, end, { utc: true });
    } else {
      start = shiftDay(period.from, i);
      end = start;
      label = formatDateUz(start, { utc: true });
    }

    // Kelajakdagi bo'lak chizilmaydi
    if (start > period.to) break;

    const row = series.get(dayKey(start)) ?? { bot: 0, panel: 0, events: 0 };

    rows.push({
      day: dayKey(start),
      endDay: dayKey(end),
      label,
      // Qisqa yorliq — diagramma o'qi uchun (to'liq yorliq tooltipda)
      shortLabel:
        period.grain === "month"
          ? label
          : formatDateUz(start, { utc: true }).split(",")[0],
      bot: row.bot,
      panel: row.panel,
      total: row.bot + row.panel,
      events: row.events,
    });
  }

  return rows;
}

/**
 * SOATLIK VA HAFTA KUNI KESIMI — "qachon foydalanishadi".
 *
 * ⚠️ Toshkent vaqti: `occurred_at` UTC da saqlanadi, ekranda esa
 * mahalliy soat kerak. `+ interval '5 hour'` — tizim butunlay
 * Asia/Tashkent (+5, DST yo'q, `education.md` §7).
 *
 * @param {Date} from
 * @param {Date} to
 * @returns {Promise<{ hourly: number[], weekday: number[] }>}
 */
async function timeOfDay(from, to) {
  const rows = await prisma.$queryRaw`
    SELECT EXTRACT(HOUR FROM occurred_at + interval '5 hour')::int AS hour,
           EXTRACT(DOW  FROM occurred_at + interval '5 hour')::int AS dow,
           COUNT(*)::int                                          AS total
      FROM activity_events
     WHERE day BETWEEN ${dayKey(from)}::date AND ${dayKey(to)}::date
       AND action NOT LIKE ${`${OUTBOUND_PREFIX}%`}
     GROUP BY 1, 2
  `;

  const hourly = Array.from({ length: 24 }, () => 0);
  const weekday = Array.from({ length: 7 }, () => 0);

  for (const row of rows) {
    hourly[num(row.hour)] += num(row.total);
    weekday[num(row.dow)] += num(row.total);
  }

  return { hourly, weekday };
}

/**
 * Bot harakatlari kesimi — "nima uchun kirishadi".
 *
 * @param {Date} from
 * @param {Date} to
 * @returns {Promise<Array<{ action: string, count: number }>>}
 */
async function actionBreakdown(from, to) {
  const rows = await prisma.activityEvent.groupBy({
    by: ["action"],
    where: { day: { gte: from, lte: to }, channel: "bot" },
    _count: { _all: true },
    orderBy: { _count: { action: "desc" } },
  });

  return rows.map((row) => ({ action: row.action, count: row._count._all }));
}

/**
 * BUGUN FAOL BO'LGAN SUBYEKT KALITLARI.
 *
 * ⚠️ `activeByChannel(today, today)` YETARLI EMAS: u hodisa jadvalidagi
 * HAR QANDAY subyektni sanaydi — maktabdan ketgan o'quvchining
 * ota-onasini ham, arxivlangan xodimni ham. Hero'dagi foizning maxraji
 * esa faqat HOZIRGI ro'yxat, ya'ni foiz 100% dan oshib ketardi.
 *
 * Kalitlar RO'YXAT sifatida qaytariladi va chaqiruvchi joyda haqiqiy
 * ro'yxat bilan kesishtiriladi. Qatorlar soni — bugun faol bo'lgan
 * odamlar soni (bir necha yuz), shuning uchun bu yengil so'rov.
 *
 * @param {Date} day
 * @returns {Promise<{ keys: Set<string>, events: number }>}
 */
async function todayActors(day) {
  const rows = await prisma.$queryRaw`
    SELECT actor_key AS key, COUNT(*)::int AS events
      FROM activity_events
     WHERE day = ${dayKey(day)}::date
       AND action NOT LIKE ${`${OUTBOUND_PREFIX}%`}
     GROUP BY actor_key
  `;

  return {
    keys: new Set(rows.map((row) => row.key)),
    events: rows.reduce((sum, row) => sum + Number(row.events ?? 0), 0),
  };
}

/**
 * Har bir subyektning shu davrdagi faolligi.
 *
 * `actorKey` → { days, events, lastAt } — reyting va "jim turganlar"
 * ro'yxati shundan chiqadi.
 *
 * @param {Date} from
 * @param {Date} to
 * @returns {Promise<Map<string, { days: number, events: number, lastAt: Date }>>}
 */
async function actorSummary(from, to) {
  const rows = await prisma.$queryRaw`
    SELECT actor_key            AS key,
           COUNT(DISTINCT day)::int AS days,
           COUNT(*)::int            AS events,
           MAX(occurred_at)         AS last_at
      FROM activity_events
     WHERE day BETWEEN ${dayKey(from)}::date AND ${dayKey(to)}::date
       AND action NOT LIKE ${`${OUTBOUND_PREFIX}%`}
     GROUP BY actor_key
  `;

  return new Map(
    rows.map((row) => [
      row.key,
      { days: num(row.days), events: num(row.events), lastAt: row.last_at },
    ]),
  );
}

/* ═══════════════════════ ASOSIY ═══════════════════════ */

/**
 * BUTUN MANZARA — bitta so'rov, bitta javob.
 *
 * ⚠️ BITTA ENDPOINT va bu ataylab (inventar/moliya dashboardlari bilan
 * bir xil naqsh): hamma blok AYNI jadvallardan yig'iladi va ikkiga
 * bo'lish o'sha qatorlarni ikkinchi marta o'qishga olib kelardi.
 *
 * @param {object} params
 * @param {number} [params.days=30]
 * @param {boolean} [params.withRoster=false] - jim turganlar ro'yxati
 *   (`activity.roster` ruxsati). Umumiy foizni ko'rish huquqi aniq
 *   odamlarning ism-ro'yxatini OCHMASLIGI kerak.
 * @returns {Promise<object>}
 */
async function getOverview({ days, granularity, count, withRoster = false } = {}) {
  const period = resolvePeriod({ days, granularity, count });
  const today = currentDayDate();

  /* ── 1. Maxrajlar ─────────────────────────────────────────────── */
  const [studentIds, staff, tgUsers, firstEvent] = await Promise.all([
    studyingStudentIds(),
    prisma.user.findMany({
      where: { role: { notIn: NON_STAFF_ROLES }, isArchived: false },
      select: { id: true, firstName: true, lastName: true, role: true, extraRoles: true },
      orderBy: [{ firstName: "asc" }],
    }),
    prisma.tgUser.findMany({
      select: {
        telegramId: true,
        student: true,
        firstName: true,
        lastName: true,
        username: true,
        isActive: true,
        notificationsEnabled: true,
        lastActivity: true,
        createdAt: true,
      },
    }),
    prisma.activityEvent.findFirst({
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
    }),
  ]);

  const studentSet = new Set(studentIds);
  const { classOfStudent, classNames } = await resolveClasses(studentIds);

  // ⚠️ FAQAT O'QIYOTGAN o'quvchiga bog'langan hisoblar sanaladi. Ketgan
  // o'quvchining ota-onasi hali ham botda turishi mumkin va uni
  // maxrajga qo'shsak, qamrov foizi asossiz pasayardi.
  const activeTgUsers = tgUsers.filter((tg) => studentSet.has(tg.student));

  /* ── 2. Yig'malar ─────────────────────────────────────────────── */
  const [
    channels,
    prevChannels,
    series,
    { hourly, weekday },
    actions,
    actors,
    todayRaw,
    delivery,
  ] = await Promise.all([
    activeByChannel(period.from, period.to),
    activeByChannel(period.prevFrom, period.prevTo),
    bucketSeries(period.from, period.to, period.grain),
    timeOfDay(period.from, period.to),
    actionBreakdown(period.from, period.to),
    actorSummary(period.from, period.to),
    todayActors(today),
    loadDelivery(period.from, period.to),
  ]);

  /* ── 3. Trend (bo'shliqlar to'ldirilgan) ──────────────────────── */
  const trend = buildTrend(period, series).map((row) => ({
    ...row,
    botRate: rate(row.bot, activeTgUsers.length),
    panelRate: rate(row.panel, staff.length),
  }));

  /* ── 4. Subyekt bo'yicha faollik ──────────────────────────────── */
  const botActors = new Map();
  const panelActors = new Map();
  for (const [key, value] of actors) {
    if (key.startsWith("tg:")) botActors.set(key.slice(3), value);
    else if (key.startsWith("user:")) panelActors.set(key.slice(5), value);
  }

  /* ── 5. Sinf kesimi ───────────────────────────────────────────── */
  const byClass = new Map();
  const bucket = (classId) => {
    const key = classId ?? "__none__";
    if (!byClass.has(key)) {
      byClass.set(key, {
        id: classId,
        name: classId ? classNames.get(classId) ?? "Noma'lum" : "Sinfsiz",
        students: 0,
        linked: 0,
        linkedStudents: 0,
        active: 0,
        activeStudents: 0,
      });
    }
    return byClass.get(key);
  };

  for (const studentId of studentIds) bucket(classOfStudent.get(studentId)).students += 1;

  // Bitta o'quvchida ikkita bog'langan hisob bo'lishi mumkin (ona/ota) —
  // shuning uchun HISOB va O'QUVCHI alohida sanaladi
  const linkedStudentIds = new Set();
  const activeStudentIds = new Set();

  for (const tg of activeTgUsers) {
    const target = bucket(classOfStudent.get(tg.student));
    target.linked += 1;

    if (!linkedStudentIds.has(tg.student)) {
      linkedStudentIds.add(tg.student);
      target.linkedStudents += 1;
    }

    if (botActors.has(tg.telegramId)) {
      target.active += 1;
      if (!activeStudentIds.has(tg.student)) {
        activeStudentIds.add(tg.student);
        target.activeStudents += 1;
      }
    }
  }

  const classes = [...byClass.values()]
    .map((row) => ({
      ...row,
      // ⚠️ Maxraj — BOG'LANGAN hisoblar, o'quvchilar EMAS: bog'lanmagan
      // ota-onani "foydalanmadi" deb yozish adolatsiz bo'lardi, u
      // umuman botdan xabardor emas. Bog'lanish qamrovi alohida ustun.
      rate: rate(row.active, row.linked),
      linkRate: rate(row.linkedStudents, row.students),
      silent: row.linked - row.active,
    }))
    .sort((a, b) => a.rate - b.rate || b.students - a.students);

  /* ── 6. Xodimlar ──────────────────────────────────────────────── */
  const staffRows = staff.map((user) => {
    const stat = panelActors.get(user.id);
    return {
      id: user.id,
      name: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
      role: user.role,
      extraRoles: user.extraRoles || [],
      days: stat?.days ?? 0,
      events: stat?.events ?? 0,
      lastSeenAt: stat?.lastAt ?? null,
      lastSeenLabel: stat?.lastAt ? formatDateTimeUz(stat.lastAt) : null,
      // ⚠️ Davr ichida faol bo'lgan kunlar ulushi — "har kuni kiradi"mi
      // yoki "bir marta kirib qo'ygan"mi degan farqni ko'rsatadi
      consistency: rate(stat?.days ?? 0, period.days),
    };
  });

  const activeStaff = staffRows
    .filter((row) => row.days > 0)
    .sort((a, b) => b.days - a.days || b.events - a.events);

  const silentStaff = staffRows
    .filter((row) => row.days === 0)
    .sort((a, b) => a.name.localeCompare(b.name, "uz"));

  /* ── 7. Ota-onalar ────────────────────────────────────────────── */
  const parentRows = activeTgUsers.map((tg) => {
    const stat = botActors.get(tg.telegramId);
    const classId = classOfStudent.get(tg.student);

    return {
      telegramId: tg.telegramId,
      studentId: tg.student,
      contactName:
        `${tg.firstName || ""} ${tg.lastName || ""}`.trim() ||
        (tg.username ? `@${tg.username}` : "Noma'lum"),
      className: classId ? classNames.get(classId) ?? "—" : "Sinfsiz",
      notificationsEnabled: tg.notificationsEnabled,
      isActive: tg.isActive,
      days: stat?.days ?? 0,
      events: stat?.events ?? 0,
      lastSeenAt: stat?.lastAt ?? tg.lastActivity ?? null,
      linkedAt: tg.createdAt,
    };
  });

  // O'quvchi ismlari — faqat ro'yxat so'ralganda yuklanadi
  let silentParents = [];
  let unlinked = [];

  if (withRoster) {
    const silent = parentRows.filter((row) => row.days === 0);
    const linkedSet = new Set(activeTgUsers.map((tg) => tg.student));
    const unlinkedIds = studentIds.filter((id) => !linkedSet.has(id));

    const nameIds = [...new Set([...silent.map((r) => r.studentId), ...unlinkedIds])];
    const names = nameIds.length
      ? await prisma.user.findMany({
          where: { id: { in: nameIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const nameMap = new Map(
      names.map((u) => [u.id, `${u.firstName || ""} ${u.lastName || ""}`.trim()]),
    );

    silentParents = silent
      .map((row) => ({
        ...row,
        studentName: nameMap.get(row.studentId) ?? "Noma'lum",
        lastSeenLabel: row.lastSeenAt ? formatDateTimeUz(row.lastSeenAt) : null,
        daysSince: row.lastSeenAt
          ? Math.floor((Date.now() - new Date(row.lastSeenAt).getTime()) / 86400000)
          : null,
      }))
      .sort((a, b) => (b.daysSince ?? 9999) - (a.daysSince ?? 9999));

    unlinked = unlinkedIds
      .map((id) => {
        const classId = classOfStudent.get(id);
        return {
          id,
          name: nameMap.get(id) ?? "Noma'lum",
          className: classId ? classNames.get(classId) ?? "—" : "Sinfsiz",
        };
      })
      .sort((a, b) => a.className.localeCompare(b.className, "uz"));
  }

  /* ── 8. KPI lenta ─────────────────────────────────────────────── */

  // ⚠️ SURAT VA MAXRAJ BITTA AHOLIDAN OLINADI. `channels` yig'masi
  // hodisa jadvalidagi HAR QANDAY subyektni sanaydi — jumladan
  // maktabdan ketgan o'quvchining ota-onasini yoki arxivlangan
  // xodimni. Maxraj esa faqat HOZIR o'qiyotgan/ishlayotganlar. Ikkalasi
  // boshqa ro'yxatdan olinsa, foiz 100% dan oshib ketardi va
  // `active + silent ≠ linked` bo'lardi.
  //
  // Shuning uchun surat ham RO'YXATDAN sanaladi (`botActors` /
  // `panelActors` — ular allaqachon `actorSummary` dan kelgan).
  const botActiveCount = activeTgUsers.filter((tg) =>
    botActors.has(tg.telegramId),
  ).length;
  const staffActiveCount = staff.filter((user) => panelActors.has(user.id)).length;

  // Hodisa hajmi (foiz emas) — u butun oqimni ko'rsatishi TO'G'RI:
  // "jami harakatlar" savoli kimning ekaniga bog'liq emas
  const botNow = channels.get("bot") ?? { users: 0, events: 0 };
  const botPrev = prevChannels.get("bot") ?? { users: 0, events: 0 };

  const sumChannels = (map) =>
    ACTIVITY_CHANNELS.filter((c) => c !== "bot").reduce(
      (acc, key) => {
        const row = map.get(key);
        return row
          ? { users: acc.users + row.users, events: acc.events + row.events }
          : acc;
      },
      { users: 0, events: 0 },
    );

  const panelNow = sumChannels(channels);
  const panelPrev = sumChannels(prevChannels);

  // ⚠️ TAQQOSLASH DAVRI UCHUN suratni qayta sanash mumkin emas
  // (`actorSummary` faqat joriy davr uchun olingan), shuning uchun
  // o'tgan davr foizи YIG'MADAN olinadi va u biroz optimistik
  // bo'lishi mumkin. Bu ataylab: ikkinchi og'ir so'rov yuborishdan
  // ko'ra, delta chipining bir foizlik noaniqligi arzonroq.
  //
  // ⚠️ KUN CHEGARASI: `period.from` — UTC yarim tun, `createdAt` esa
  // instant. Toshkent kuni UTC dan 5 soat oldin boshlanadi, ya'ni
  // oddiy taqqoslash o'sha kunning birinchi 5 soatini yo'qotardi va
  // "yangi bog'lanishlar" doim kam ko'rsatilardi. Chegaralar shuning
  // uchun 5 soatga suriladi.
  const TASHKENT_OFFSET_MS = 5 * 3600 * 1000;
  const instantFrom = (day) => new Date(day.getTime() - TASHKENT_OFFSET_MS);
  const instantTo = (day) =>
    new Date(day.getTime() + 24 * 3600 * 1000 - TASHKENT_OFFSET_MS);

  const periodStart = instantFrom(period.from);
  const prevStart = instantFrom(period.prevFrom);
  const prevEnd = instantTo(period.prevTo);

  const newLinks = activeTgUsers.filter((tg) => tg.createdAt >= periodStart).length;
  const prevLinks = activeTgUsers.filter(
    (tg) => tg.createdAt >= prevStart && tg.createdAt < prevEnd,
  ).length;

  const metrics = [
    {
      key: "botCoverage",
      label: "Bot qamrovi",
      value: rate(botActiveCount, activeTgUsers.length),
      previous: rate(botPrev.users, activeTgUsers.length),
      unit: "%",
      tone: "bot",
      hint: `${botActiveCount} / ${activeTgUsers.length} bog'langan hisob`,
      higherIsBetter: true,
    },
    {
      key: "studentCoverage",
      label: "O'quvchilar qamrovi",
      value: rate(linkedStudentIds.size, studentIds.length),
      previous: null,
      unit: "%",
      tone: "link",
      hint: `${linkedStudentIds.size} / ${studentIds.length} o'quvchida bog'langan hisob bor`,
      higherIsBetter: true,
    },
    {
      key: "panelCoverage",
      label: "Xodimlar faolligi",
      // ⚠️ `panelNow.users` EMAS: u o'quvchi panelidan kirgan
      // o'quvchilarni ham sanaydi va foiz 100% dan oshib ketardi.
      // Surat XODIMLAR ro'yxatidan filtrlanadi.
      value: rate(staffActiveCount, staff.length),
      previous: rate(panelPrev.users, staff.length),
      unit: "%",
      tone: "panel",
      hint: `${staffActiveCount} / ${staff.length} xodim tizimga kirdi`,
      higherIsBetter: true,
    },
    {
      key: "silentStaff",
      label: "Jim turgan xodimlar",
      value: silentStaff.length,
      previous: null,
      unit: "",
      tone: "warn",
      hint: `${period.days} kun ichida birorta ham kirmagan`,
      higherIsBetter: false,
    },
    {
      key: "newLinks",
      label: "Yangi bog'lanishlar",
      value: newLinks,
      previous: prevLinks,
      unit: "",
      tone: "link",
      hint: "Davr ichida botga ulangan hisoblar",
      higherIsBetter: true,
    },
    {
      key: "events",
      label: "Jami harakatlar",
      value: botNow.events + panelNow.events,
      previous: botPrev.events + panelPrev.events,
      unit: "",
      tone: "neutral",
      hint: "Bot va panellardagi harakatlar",
      higherIsBetter: true,
    },
  ];

  /* ── 9. Javob ─────────────────────────────────────────────────── */

  // ⚠️ Bugungi surat ham RO'YXAT bilan kesishtiriladi (8-bo'limdagi
  // bilan bir xil sabab): maxraj bilan bitta aholidan bo'lishi shart.
  const todayBotActive = activeTgUsers.filter((tg) =>
    todayRaw.keys.has(`tg:${tg.telegramId}`),
  ).length;
  const todayStaffActive = staff.filter((user) =>
    todayRaw.keys.has(`user:${user.id}`),
  ).length;

  return {
    period: {
      // Granulyarlik va bo'laklar soni — tanlagich shulardan chiziladi
      granularity: period.grain,
      granularityLabel: period.grainLabel,
      count: period.count,
      options: period.options,
      // Barcha granulyarliklarning variantlari — tanlagich almashganda
      // mijoz qayta so'rov yubormasligi uchun
      granularities: GRANULARITIES.map((key) => ({
        key,
        label: GRANULARITY[key].label,
        options: GRANULARITY[key].options,
        fallback: GRANULARITY[key].fallback,
      })),
      days: period.days,
      from: dayKey(period.from),
      to: dayKey(period.to),
      fromLabel: formatDateUz(period.from, { utc: true }),
      toLabel: formatDateUz(period.to, { utc: true }),
      rangeLabel: formatDateRangeUz(period.from, period.to, { utc: true }),
    },

    // ⚠️ Tarix yig'ilmagan bo'lsa ekran buni AYTADI: 0% ni falokat
    // sifatida ko'rsatish yolg'on bo'lardi (hech kim yozmagan edi)
    collecting: !firstEvent || firstEvent.occurredAt > period.from,
    since: firstEvent?.occurredAt ?? null,
    sinceLabel: firstEvent ? formatDateUz(firstEvent.occurredAt) : null,

    today: {
      date: dayKey(today),
      label: formatDateUz(today, { utc: true }),
      bot: {
        active: todayBotActive,
        total: activeTgUsers.length,
        rate: rate(todayBotActive, activeTgUsers.length),
      },
      panel: {
        active: todayStaffActive,
        total: staff.length,
        rate: rate(todayStaffActive, staff.length),
      },
      // Harakatlar soni — butun oqim (kimning ekaniga bog'liq emas)
      events: todayRaw.events,
    },

    metrics,
    trend,

    channels: ACTIVITY_CHANNELS.map((key) => {
      const row = channels.get(key) ?? { users: 0, events: 0 };
      return {
        key,
        label: ACTIVITY_CHANNEL_LABELS[key] ?? key,
        users: row.users,
        events: row.events,
      };
    }).filter((row) => row.events > 0 || row.key === "bot" || row.key === "admin"),

    classes,

    hourly: hourly.map((value, hour) => ({ hour, value })),
    weekday: weekday.map((value, index) => ({ day: index, value })),

    actions: actions.map((row) => ({
      key: row.action,
      label: ACTION_LABELS[row.action] ?? row.action,
      count: row.count,
      outbound: row.action.startsWith(OUTBOUND_PREFIX),
    })),

    staff: {
      total: staff.length,
      active: activeStaff.slice(0, 12),
      silent: silentStaff.slice(0, 12),
      silentTotal: silentStaff.length,
    },

    parents: {
      linked: activeTgUsers.length,
      linkedStudents: linkedStudentIds.size,
      students: studentIds.length,
      // ⚠️ `botNow.users` EMAS (yuqoridagi izoh): `active + silent`
      // aynan `linked` ga teng bo'lishi kerak
      active: botActiveCount,
      silent: parentRows.filter((row) => row.days === 0).length,
      unlinked: studentIds.length - linkedStudentIds.size,
      notificationsOff: activeTgUsers.filter((tg) => !tg.notificationsEnabled).length,
    },

    delivery,

    // Faqat `activity.roster` ruxsati bilan to'ladi
    roster: {
      available: withRoster,
      silentParents: silentParents.slice(0, 200),
      silentParentsTotal: silentParents.length,
      unlinked: unlinked.slice(0, 200),
      unlinkedTotal: unlinked.length,
    },
  };
}

/**
 * XABAR YETKAZISH — mavjud `MessageDeliveryStatus` dan.
 *
 * ⚠️ "O'QILDI" YO'Q. Telegram Bot API o'qish tasdig'ini bermaydi va
 * `MessageDeliveryStatusEnum` da ham bunday holat yo'q: `sent` faqat
 * "Telegram so'rovni qabul qildi" degani. Ekranda shuning uchun
 * "yetkazildi" deb yoziladi.
 *
 * ⚠️ KUNLIK BAHO HISOBOTI BU YERGA TUSHMAYDI — bot uni to'g'ridan-to'g'ri
 * yuboradi va `Message` qatori yaratmaydi. Uning o'rniga bot
 * `ActivityEvent` ga `bot.out.report` yozadi va u alohida ko'rsatiladi.
 *
 * @param {Date} from
 * @param {Date} to
 * @returns {Promise<object>}
 */
async function loadDelivery(from, to) {
  const upperBound = shiftDay(to, 1);

  const [statuses, outbound] = await Promise.all([
    prisma.messageDeliveryStatus.groupBy({
      by: ["status"],
      where: { message: { createdAt: { gte: from, lt: upperBound } } },
      _count: { _all: true },
    }),
    prisma.activityEvent.groupBy({
      by: ["action"],
      where: {
        day: { gte: from, lte: to },
        action: { startsWith: OUTBOUND_PREFIX },
      },
      _count: { _all: true },
    }),
  ]);

  const byStatus = Object.fromEntries(
    statuses.map((row) => [row.status, row._count._all]),
  );
  const total = statuses.reduce((sum, row) => sum + row._count._all, 0);

  const outMap = Object.fromEntries(
    outbound.map((row) => [row.action, row._count._all]),
  );
  const reportsSent = outMap[`${OUTBOUND_PREFIX}report`] ?? 0;
  const reportsFailed = outMap[`${OUTBOUND_PREFIX}failed`] ?? 0;

  return {
    // Ommaviy xabarlar (admin paneldan yuborilganlar)
    broadcast: {
      total,
      sent: byStatus.sent ?? 0,
      failed: byStatus.failed ?? 0,
      pending: byStatus.pending ?? 0,
      cancelled: byStatus.cancelled ?? 0,
      rate: rate(byStatus.sent ?? 0, total),
    },
    // Kunlik baho hisoboti (bot to'g'ridan-to'g'ri yuboradi)
    reports: {
      sent: reportsSent,
      failed: reportsFailed,
      rate: rate(reportsSent, reportsSent + reportsFailed),
    },
  };
}

/**
 * BITTA ODAMNING FAOLLIK TARIXI — xodim yoki ota-ona kartasi uchun.
 *
 * @param {object} params
 * @param {string} [params.userId]
 * @param {string} [params.telegramId]
 * @param {number} [params.days=30]
 * @returns {Promise<object>}
 */
async function getSubject({ userId, telegramId, days } = {}) {
  if (!userId && !telegramId) {
    throw new BadRequestError("Foydalanuvchi yoki Telegram ID kerak");
  }

  // ⚠️ `inherited` — oyna ota-ekrandan keladi (yuqoridagi izoh)
  const period = resolvePeriod({ days, inherited: true });
  const actorKey = userId ? `user:${userId}` : `tg:${telegramId}`;

  const [events, daily] = await Promise.all([
    prisma.activityEvent.findMany({
      where: { actorKey, day: { gte: period.from, lte: period.to } },
      orderBy: { occurredAt: "desc" },
      take: 100,
      select: {
        id: true,
        channel: true,
        action: true,
        occurredAt: true,
        meta: true,
      },
    }),
    prisma.activityEvent.groupBy({
      by: ["day"],
      where: { actorKey, day: { gte: period.from, lte: period.to } },
      _count: { _all: true },
    }),
  ]);

  const byDay = new Map(daily.map((row) => [dayKey(row.day), row._count._all]));

  const calendar = [];
  for (let i = 0; i < period.days; i += 1) {
    const date = shiftDay(period.from, i);
    const key = dayKey(date);
    calendar.push({
      day: key,
      label: formatDateUz(date, { utc: true }),
      value: byDay.get(key) ?? 0,
    });
  }

  return {
    period: {
      days: period.days,
      from: dayKey(period.from),
      to: dayKey(period.to),
      fromLabel: formatDateUz(period.from, { utc: true }),
      toLabel: formatDateUz(period.to, { utc: true }),
    },
    activeDays: daily.length,
    totalEvents: daily.reduce((sum, row) => sum + row._count._all, 0),
    calendar,
    events: events.map((row) => ({
      id: row.id,
      channel: row.channel,
      channelLabel: ACTIVITY_CHANNEL_LABELS[row.channel] ?? row.channel,
      action: row.action,
      actionLabel: ACTION_LABELS[row.action] ?? row.action,
      occurredAt: row.occurredAt,
      occurredLabel: formatDateTimeUz(row.occurredAt),
      meta: row.meta ?? null,
    })),
  };
}

/**
 * BITTA SINFNING FAOLLIK KESIMI.
 *
 * ⚠️ UMUMIY EKRANDAGI QATORNI OCHADI, uni takrorlamaydi. Ro'yxatdagi
 * "3-A: 8/13 = 61.5%" degan qator savol tug'diradi — "qaysi 5 tasi
 * ochmayapti?". Javob shu yerda: har bir ota-ona ismi, oxirgi kirish
 * sanasi va bog'lanmagan o'quvchilar alohida.
 *
 * ⚠️ ISM-RO'YXAT BO'LGANI UCHUN `activity.roster` TALAB QILINADI
 * (route darajasida). Umumiy foizni ko'rish huquqi aniq odamlarning
 * ro'yxatini ochib bermasligi kerak — bu bo'limning butun ruxsat
 * shakli shu ajratishga tayanadi.
 *
 * ⚠️ SINFGA BIRIKTIRISH `resolveClasses` BILAN BIR XIL qoidada
 * ("eng kichik `classId` yutadi"): aks holda bu ekrandagi o'quvchilar
 * soni umumiy ro'yxatdagi bilan mos kelmasdi va foydalanuvchi qaysi
 * biriga ishonishni bilmasdi.
 *
 * @param {string} classId
 * @param {object} params
 * @returns {Promise<object>}
 */
async function getClass(classId, { days } = {}) {
  // ⚠️ `inherited` — oyna umumiy ekrandan meros qoladi va u haftalik
  // rejimda 84 kun bo'lishi mumkin (yuqoridagi izoh)
  const period = resolvePeriod({ days, inherited: true });

  const klass = await prisma.class.findUnique({
    where: { id: classId },
    select: { id: true, name: true },
  });
  if (!klass) throw new NotFoundError("Sinf topilmadi");

  /* ── Shu sinfda o'qiyotganlar ─────────────────────────────────── */
  const studentIds = await studyingStudentIds();
  const { classOfStudent } = await resolveClasses(studentIds);

  const members = studentIds.filter((id) => classOfStudent.get(id) === classId);

  if (members.length === 0) {
    return {
      class: { ...klass, students: 0, linked: 0, active: 0, rate: 0, linkRate: 0 },
      period: publicPeriod(period),
      parents: [],
      unlinked: [],
      trend: [],
    };
  }

  /* ── Bog'langan hisoblar, ismlar va faollik ───────────────────── */
  const [tgUsers, names, actors] = await Promise.all([
    prisma.tgUser.findMany({
      where: { student: { in: members } },
      select: {
        telegramId: true,
        student: true,
        firstName: true,
        lastName: true,
        username: true,
        notificationsEnabled: true,
        isActive: true,
        lastActivity: true,
        createdAt: true,
      },
    }),
    prisma.user.findMany({
      where: { id: { in: members } },
      select: { id: true, firstName: true, lastName: true },
    }),
    actorSummary(period.from, period.to),
  ]);

  const nameOf = new Map(
    names.map((u) => [u.id, `${u.firstName || ""} ${u.lastName || ""}`.trim()]),
  );

  const parents = tgUsers
    .map((tg) => {
      const stat = actors.get(`tg:${tg.telegramId}`);
      const lastSeenAt = stat?.lastAt ?? tg.lastActivity ?? null;

      return {
        telegramId: tg.telegramId,
        studentId: tg.student,
        studentName: nameOf.get(tg.student) ?? "Noma'lum",
        contactName:
          `${tg.firstName || ""} ${tg.lastName || ""}`.trim() ||
          (tg.username ? `@${tg.username}` : "Noma'lum"),
        notificationsEnabled: tg.notificationsEnabled,
        isActive: tg.isActive,
        days: stat?.days ?? 0,
        events: stat?.events ?? 0,
        active: Boolean(stat?.days),
        lastSeenAt,
        lastSeenLabel: lastSeenAt ? formatDateTimeUz(lastSeenAt) : null,
        daysSince: lastSeenAt
          ? Math.floor((Date.now() - new Date(lastSeenAt).getTime()) / 86400000)
          : null,
        linkedAt: tg.createdAt,
        linkedLabel: formatDateUz(tg.createdAt),
      };
    })
    // ⚠️ JIM TURGANLAR TEPADA. Ro'yxat harakat uchun ochiladi
    // ("kimga qo'ng'iroq qilish kerak"), shuning uchun eng uzoq
    // ko'rinmagani birinchi turadi — alifbo tartibi bu savolga
    // javob bermasdi.
    .sort(
      (a, b) =>
        Number(a.active) - Number(b.active) ||
        (b.daysSince ?? 9999) - (a.daysSince ?? 9999) ||
        a.studentName.localeCompare(b.studentName, "uz"),
    );

  const linkedStudents = new Set(tgUsers.map((tg) => tg.student));
  const activeCount = parents.filter((row) => row.active).length;

  const unlinked = members
    .filter((id) => !linkedStudents.has(id))
    .map((id) => ({ id, name: nameOf.get(id) ?? "Noma'lum" }))
    .sort((a, b) => a.name.localeCompare(b.name, "uz"));

  /* ── Shu sinfning trendi ──────────────────────────────────────── */
  // ⚠️ ALOHIDA SO'ROV, umumiy trenddan kesib olinmaydi: umumiy trend
  // butun maktabning noyob odamlarini sanaydi va undan bitta sinfni
  // ajratib bo'lmaydi (`COUNT(DISTINCT)` ni bo'lib bo'lmaydi).
  const trendRows = await prisma.$queryRaw`
    SELECT to_char(day, 'YYYY-MM-DD') AS bucket,
           COUNT(DISTINCT actor_key)::int AS active
      FROM activity_events
     WHERE day BETWEEN ${dayKey(period.from)}::date AND ${dayKey(period.to)}::date
       AND channel = 'bot'
       AND action NOT LIKE ${`${OUTBOUND_PREFIX}%`}
       AND student_id = ANY(${members}::char(24)[])
     GROUP BY day
     ORDER BY day
  `;

  const byDay = new Map(trendRows.map((row) => [row.bucket, num(row.active)]));

  const trend = [];
  for (let i = 0; i < period.days; i += 1) {
    const date = shiftDay(period.from, i);
    const key = dayKey(date);
    trend.push({
      day: key,
      label: formatDateUz(date, { utc: true }),
      active: byDay.get(key) ?? 0,
    });
  }

  return {
    class: {
      ...klass,
      students: members.length,
      linked: tgUsers.length,
      linkedStudents: linkedStudents.size,
      active: activeCount,
      silent: tgUsers.length - activeCount,
      rate: rate(activeCount, tgUsers.length),
      linkRate: rate(linkedStudents.size, members.length),
    },
    period: publicPeriod(period),
    parents,
    unlinked,
    trend,
  };
}

/** Davrning mijozga chiqadigan shakli — uch joyda takrorlanmasligi uchun. */
const publicPeriod = (period) => ({
  granularity: period.grain,
  granularityLabel: period.grainLabel,
  count: period.count,
  options: period.options,
  days: period.days,
  from: dayKey(period.from),
  to: dayKey(period.to),
  fromLabel: formatDateUz(period.from, { utc: true }),
  toLabel: formatDateUz(period.to, { utc: true }),
  rangeLabel: formatDateRangeUz(period.from, period.to, { utc: true }),
});

module.exports = {
  PERIODS,
  GRANULARITY,
  ACTION_LABELS,
  getOverview,
  getSubject,
  getClass,
};
