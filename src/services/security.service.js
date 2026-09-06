/**
 * XAVFSIZLIK — YOZUV VA ANIQLASH TOMONI.
 *
 * Uch narsani qayd etadi va ular ustida bitta qoida ishlatadi:
 *
 *   1. `LoginAttempt`  — har urinish (o'tgani ham, o'tmagani ham)
 *   2. `UserSession`   — har muvaffaqiyatli login
 *   3. `SecurityAlert` — qoidaga tushgan holat
 *
 * ── DOKTRINA: QAYD ETADI, TO'XTATMAYDI ───────────────────────────────
 *
 * ⚠️ Ikkinchi seans AVTOMATIK UZILMAYDI. `financeReconcile.job.js` bilan
 * bir xil qaror: tizim baqiradi, tuzatmaydi. Direktor telefonidan kirsa,
 * kompyuteridagi ochiq ishi yopilib qolmasligi kerak; "bu parol
 * tarqalganmi yoki odam ikkita qurilmadamı" degan savolga faqat ODAM
 * javob bera oladi. Uzish tugmasi bor — lekin uni odam bosadi
 * (`security.revoke`).
 *
 * ── PAROL VA MAXFIYLIK ───────────────────────────────────────────────
 *
 * ⚠️ Parol (hatto noto'g'risi ham) HECH QACHON yozilmaydi. `username`
 * esa yoziladi — mavjud bo'lmagan login bilan urinish aynan hujum
 * belgisi va usiz "kimning nomiga urinilyapti" degan savol javobsiz
 * qolardi.
 */

// ⚠️ `config/prisma` EMAS — xavfsizlik ma'lumoti PLATFORMADA yashaydi
// (`prisma/platform/schema.prisma` sarlavhasidagi uchta sabab). Ikkalasini
// aralashtirsak, "platformada `userSession` modeli yo'q" degan xato
// darhol chiqadi va bu yaxshi: jimgina noto'g'ri schema'ga yozib
// qo'yishdan afzal.
const platformPrisma = require("../config/platformPrisma");
const { generateId } = require("../utils/idGenerator");
const { currentDayDate } = require("../helpers/month.helpers");
const { formatDateTimeUz } = require("../helpers/date.helpers");
const logger = require("../utils/logger");

/**
 * SEANS "KO'RINDI" OYNASI. `lastSeenAt` har so'rovda emas, 2 daqiqada
 * bir marta yoziladi: aks holda har GET so'rov bitta UPDATE hosil
 * qilardi va seanslar jadvali eng ko'p yoziladigan jadvalga aylanardi.
 */
const SEEN_WINDOW_MS = 2 * 60 * 1000;

/** Xotiradagi oyna: `jti` → oxirgi yozuv vaqti. */
const seenWindow = new Map();
const SEEN_LIMIT = 5000;

/**
 * BRUTE-FORCE OSTONASI — 15 daqiqada 5 ta muvaffaqiyatsiz urinish.
 *
 * ⚠️ `index.js` dagi `loginLimiter` (15 daqiqada 10 ta) BOSHQA narsa:
 * u so'rovni to'sadi, bu esa ODAMNI ogohlantiradi. Ostona undan PAST,
 * chunki limiter IP bo'yicha ishlaydi, bu esa HISOB bo'yicha: bitta
 * hisobga turli IP lardan urinilganda limiter jim qolardi.
 */
const BRUTE_WINDOW_MS = 15 * 60 * 1000;
const BRUTE_THRESHOLD = 5;

/** Kechasi kirish — Toshkent bo'yicha shu soatlar oralig'i. */
const NIGHT_FROM = 0;
const NIGHT_TO = 5;

/** Uzoq kirmagan hisob shu kundan keyin "uyquda" hisoblanadi. */
const DORMANT_DAYS = 45;

/**
 * TEZ FILIAL ALMASHTIRISH — oynasi va ostonasi.
 *
 * ⚠️ 10 daqiqada 3 ta filial. Rahbar kun davomida ikki filialni
 * ko'rishi mumkin va bu normal, shuning uchun oyna qisqa va ostona
 * uchta: ikkita filial "odam ritmi", uchtasi o'n daqiqada esa emas.
 */
const RAPID_SWITCH_WINDOW_MS = 10 * 60 * 1000;
const RAPID_SWITCH_THRESHOLD = 3;

/* ───────────────────────── KIRISH URINISHI ───────────────────────── */

/**
 * Urinishni yozadi. Hech qachon xato tashlamaydi.
 *
 * ⚠️ FILIAL KONTEKSTI SHART EMAS — jadval platformada. Aynan shu sababli
 * NOMA'LUM LOGIN bilan kelgan urinish ham yoziladi (`branchId: null`), va
 * u eng qimmatli hodisa: mavjud bo'lmagan nom bilan brute-force.
 *
 * ⚠️ Kirish urinishi yozuvi login javobini KUTIB TURMAYDI —
 * `auth.controller.js` uni `await` qilmaydi.
 *
 * @param {object} input
 * @param {string} input.username
 * @param {string} [input.userId]
 * @param {string} [input.branchId]
 * @param {boolean} input.success
 * @param {string} [input.reason]
 * @param {object} input.client - `helpers/request.helpers.js` → `clientInfo()`
 * @returns {Promise<void>}
 */
async function recordAttempt({
  username,
  userId,
  branchId,
  success,
  reason = "ok",
  client = {},
}) {
  try {
    await platformPrisma.loginAttempt.create({
      data: {
        id: generateId(),
        username: String(username || "").slice(0, 120),
        userId: userId ?? null,
        branchId: branchId ?? null,
        success,
        reason: String(reason).slice(0, 24),
        channel: client.channel || "admin",
        ip: client.ip ?? null,
        userAgent: client.userAgent ?? null,
        device: client.device ?? null,
        day: currentDayDate(),
      },
    });
  } catch (error) {
    logger.warn(`[security] kirish urinishi yozilmadi: ${error.message}`);
  }
}

/* ───────────────────────── OGOHLANTIRISH ───────────────────────── */

/**
 * OGOHLANTIRISHNI KO'TARADI — takrorlanmaydigan qilib.
 *
 * ⚠️ `dedupeKey` bo'yicha `upsert`: bitta hisobga bir kunda o'n marta
 * kirilsa ham ro'yxatda BITTA qator turadi, ichidagi `hitCount` o'sadi.
 * Har hodisaga yangi qator yozilsa, ekran bitta muammoning nusxalari
 * bilan to'lib ketardi va haqiqiy ikkinchi muammo ko'rinmay qolardi.
 *
 * ⚠️ YOPILGAN OGOHLANTIRISH QAYTA OCHILMAYDI. Xodim "bu direktorning
 * ikkinchi telefoni, tushundim" deb yopgan bo'lsa, o'sha holat ertasiga
 * yana qalqib chiqmasligi kerak — `dedupeKey` da KUN bor, ya'ni ertangi
 * hodisa yangi kalit oladi va yangi qator sifatida chiqadi.
 *
 * @param {object} input
 * @param {string} input.type - `SecurityAlertType`
 * @param {string} input.severity - `SecurityAlertSeverity`
 * @param {string} input.dedupeKey
 * @param {string} input.title
 * @param {string} [input.detail]
 * @param {string} [input.userId]
 * @param {string} [input.username]
 * @param {string} [input.branchId]
 * @param {string} [input.sessionId]
 * @param {object} [input.meta]
 * @returns {Promise<void>}
 */
async function raise({
  type,
  severity,
  dedupeKey,
  title,
  detail = "",
  userId,
  username = "",
  branchId,
  sessionId,
  meta,
}) {
  try {
    const now = new Date();

    await platformPrisma.securityAlert.upsert({
      where: { dedupeKey: dedupeKey.slice(0, 140) },
      create: {
        id: generateId(),
        type,
        severity,
        dedupeKey: dedupeKey.slice(0, 140),
        title: title.slice(0, 160),
        detail,
        userId: userId ?? null,
        username: String(username || "").slice(0, 120),
        branchId: branchId ?? null,
        sessionId: sessionId ?? null,
        meta: meta ?? undefined,
        day: currentDayDate(),
        firstSeenAt: now,
        lastSeenAt: now,
      },
      update: {
        hitCount: { increment: 1 },
        lastSeenAt: now,
        // ⚠️ SARLAVHA VA JIDDIYLIK HAM YANGILANADI, faqat tafsilot emas.
        // Bir kunda ikkinchi seans qo'shilsa `high`, uchinchisida
        // `critical` bo'ladi — lekin `dedupeKey` bir xil bo'lgani
        // uchun qator YANGI yozilmaydi. Faqat `detail` yangilansa,
        // ro'yxatda "2 ta seans / high" bo'lib qolib, matn ichida
        // "4 ta" yozilib turardi.
        severity,
        title: title.slice(0, 160),
        detail,
        meta: meta ?? undefined,
      },
    });
  } catch (error) {
    logger.warn(`[security] ogohlantirish yozilmadi: ${error.message}`);
  }
}

/* ───────────────────────── SEANS ───────────────────────── */

/**
 * Foydalanuvchining HOZIR OCHIQ seanslari.
 *
 * "Ochiq" = tugatilmagan VA muddati o'tmagan. Ikkala shart ham kerak:
 * `endReason` faqat qo'lda tugatilganda o'zgaradi, muddat esa o'zi
 * o'tadi va uni hech kim yozmaydi (cron kechroq tozalaydi).
 *
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
function liveSessions(userId) {
  return platformPrisma.userSession.findMany({
    where: {
      userId,
      endReason: "active",
      expiresAt: { gt: new Date() },
    },
    orderBy: { lastSeenAt: "desc" },
  });
}

/**
 * IP MANZILDAN TARMOQ PREFIKSI.
 *
 * ⚠️ TO'LIQ IP BO'YICHA TAQQOSLASH ISHLAMAYDI. Mobil internetda va
 * ko'p ofis tarmoqlarida IP har ulanishda o'zgaradi — har kirish
 * "yangi manzil" bo'lib chiqardi va ogohlantirishlar ro'yxati bir
 * kunda shovqin bilan to'lib ketardi. Prefiks esa TARMOQNI bildiradi:
 * maktabdan kirish har safar bir xil prefiksda qoladi, boshqa
 * shahardan kirish esa darhol ajralib turadi.
 *
 * IPv4 → dastlabki uch oktet ("10.0.5.23" → "10.0.5")
 * IPv6 → dastlabki to'rt guruh (odatda /64 tarmog'i)
 * Qisqa yoki noma'lum qiymat → o'zgarishsiz qaytadi.
 *
 * @param {string|null} ip
 * @returns {string|null}
 */
function networkOf(ip) {
  if (!ip) return null;

  if (ip.includes(":")) {
    const parts = ip.split(":");
    return parts.length > 4 ? parts.slice(0, 4).join(":") : ip;
  }

  const parts = ip.split(".");
  return parts.length === 4 ? parts.slice(0, 3).join(".") : ip;
}

/**
 * "Qurilma o'sha-o'shami?" — IP va qurilma yorlig'ining birikmasi.
 *
 * ⚠️ FAQAT IP YETARLI EMAS: mobil internetda IP har ulanishda o'zgaradi
 * va har kirish "yangi qurilma" bo'lib chiqardi. Faqat qurilma ham
 * yetarli emas: "Chrome · Windows" ikkita boshqa odamda ham bir xil.
 * Ikkalasining birikmasi — amaliy o'rta yechim.
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
const sameOrigin = (a, b) => a.ip === b.ip && a.device === b.device;

/**
 * YANGI SEANS OCHISH + QOIDALARNI ISHLATISH.
 *
 * Tartib muhim: avval seans yoziladi, keyin tekshiruvlar. Aks holda
 * "hozir nechta ochiq seans bor" savoli o'zini hisobga olmasdi.
 *
 * ⚠️ `expiresAt` TOKENNING O'ZIDAN (`decoded.exp`) olinadi, bu yerda
 * hisoblanmaydi: `JWT_EXPIRES_IN` o'zgarsa ikkita haqiqat manbai paydo
 * bo'lardi va ro'yxatdagi "muddati" haqiqiy token bilan mos kelmasdi.
 *
 * ⚠️ FILIAL ALMASHTIRGANDA ESKI SEANS YOPILADI (`superseded`). Aks holda
 * bir odamning bitta brauzerdagi ishi "ikkita bir vaqtdagi seans" bo'lib
 * ko'rinardi va birinchi kunning o'zidayoq soxta ogohlantirish chiqardi.
 *
 * @param {object} input
 * @param {object} input.user - `{ id, username, firstName, lastName, role }`
 * @param {string} input.branchId
 * @param {string} input.jti
 * @param {Date} input.expiresAt - tokenning `exp` idan
 * @param {object} input.client - `clientInfo()`
 * @param {string} [input.supersedeJti] - yopiladigan oldingi seans (filial almashtirish)
 * @returns {Promise<object|null>} - yaratilgan seans (xato bo'lsa `null`)
 */
async function openSession({ user, branchId, jti, expiresAt, client = {}, supersedeJti }) {
  let session = null;

  try {
    if (supersedeJti) {
      await closeSession({ jti: supersedeJti, reason: "superseded" });
    }

    // ⚠️ Tekshiruvlar uchun OLDINGI holat kerak — yangi qator qo'shilishidan
    // OLDIN o'qiladi, aks holda "bu birinchi seansmi" savoli har doim
    // "yo'q" bo'lardi.
    const before = await liveSessions(user.id);

    session = await platformPrisma.userSession.create({
      data: {
        id: generateId(),
        userId: user.id,
        username: user.username || "",
        branchId,
        jti,
        channel: client.channel || "admin",
        ip: client.ip ?? null,
        userAgent: client.userAgent ?? null,
        device: client.device ?? null,
        expiresAt,
      },
    });

    await runRules({ user, branchId, session, previous: before, client });
  } catch (error) {
    logger.warn(`[security] seans ochilmadi: ${error.message}`);
  }

  return session;
}

/**
 * QOIDALAR — yangi seans ochilgandan keyin ishlaydi.
 *
 * ⚠️ HAMMASI BITTA JOYDA. Har qoida o'z faylida bo'lsa, "bu holat qaysi
 * ogohlantirishni ko'taradi" degan savolga javob berish uchun beshta
 * faylni ochish kerak bo'lardi — ular esa bir-birini inkor qilishi
 * mumkin (bir kirish ham "yangi qurilma", ham "kechasi kirish").
 *
 * @param {object} input
 * @returns {Promise<void>}
 */
async function runRules({ user, branchId, session, previous, client }) {
  const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.username;

  // ⚠️ KALITDA FILIAL HAM BOR. Xodim bir nechta filialda ishlaydi va
  // ko'rish huquqi filial bo'yicha chegaralangan (`branchScope`).
  // Kalitda filial bo'lmasa, hodisa BIRINCHI filialga "yopishib"
  // qolardi: ikkinchi filialdagi xavfsizlik xodimi o'z filialida
  // sodir bo'lgan hodisani umuman ko'rmasdi.
  const dayKey = `${branchId ?? "-"}:${currentDayDate().toISOString().slice(0, 10)}`;

  // Har `raise()` chaqirig'ida takrorlanadigan uchlik — bitta joyda
  const who = { userId: user.id, username: user.username || "", branchId };

  /* ── 1. BIR VAQTDA IKKI SEANS ────────────────────────────────────
     Foydalanuvchi so'ragan asosiy qoida: "bitta akkauntga ikkita yoki
     undan ko'p seansdan kirilsa darhol qayd etilsin".

     ⚠️ BOSHQA QURILMADAN bo'lishi shart. Bir odam bitta kompyuterda
     ikkita tab ochsa ham ikkita seans bo'ladi (har login yangi token) —
     u ogohlantirish emas, shovqin. */
  // ⚠️ FAQAT SHU FILIALDAGI seanslar taqqoslanadi. Xodim bir nechta
  // filialda ishlaydi va boshqa filialdagi seansning IP/qurilmasini bu
  // yerda ko'rsatish filial chegarasini buzardi: Chilonzordagi
  // xavfsizlik xodimi Yunusobodning ma'lumotini ko'rib qolardi.
  //
  // ⚠️ Filial almashtirish eski seansni `superseded` bilan yopadi
  // (`auth.service.js`), ya'ni bir odamning ikki filialda BIR VAQTDA
  // ochiq seansi bo'lishi normal holat emas va uni "shubhali" deb
  // belgilash soxta ogohlantirish bo'lardi.
  const foreign = previous.filter(
    (s) => s.branchId === branchId && !sameOrigin(s, session),
  );

  if (foreign.length > 0) {
    const total = foreign.length + 1;
    await raise({
      type: "concurrent_session",
      // Uchtadan ko'p bo'lsa — bu endi "ikkinchi telefon" emas
      severity: total >= 3 ? "critical" : "high",
      dedupeKey: `concurrent:${user.id}:${dayKey}`,
      ...who,
      sessionId: session.id,
      title: `${fullName} — bitta hisobda ${total} ta seans`,
      detail:
        `Hisobga bir vaqtning o'zida turli qurilmalardan kirilgan. ` +
        `Joriy: ${session.device || "noma'lum qurilma"} (${session.ip || "IP yo'q"}). ` +
        `Boshqa seanslar: ${foreign
          .map((s) => `${s.device || "noma'lum"} (${s.ip || "IP yo'q"})`)
          .join(", ")}.`,
      meta: {
        total,
        sessions: [session, ...foreign].map((s) => ({
          id: s.id,
          ip: s.ip,
          device: s.device,
          channel: s.channel,
          at: s.createdAt,
        })),
      },
    });
  }

  /* ── 2. YANGI QURILMA ────────────────────────────────────────────
     ⚠️ Faqat TARIXDA umuman uchramagan qurilma. Tekshiruv oxirgi 60
     kunlik seanslarda: undan eskisini "yangi emas" deb hisoblash
     ma'nosiz, chunki odam qurilmasini almashtirgan bo'lishi mumkin. */
  // ⚠️ Natija KEYINGI qoidaga ham kerak (`new_ip` faqat tanish
  // qurilmada ishlaydi), shuning uchun blokdan tashqarida e'lon
  // qilinadi. `null` — qurilma umuman aniqlanmagan holat.
  let deviceKnown = null;

  if (session.device) {
    const since = new Date(Date.now() - 60 * 24 * 3600 * 1000);
    const seenBefore = await platformPrisma.userSession.count({
      where: {
        userId: user.id,
        device: session.device,
        id: { not: session.id },
        createdAt: { gte: since },
      },
    });

    deviceKnown = seenBefore > 0;

    if (seenBefore === 0) {
      await raise({
        type: "new_device",
        severity: "medium",
        dedupeKey: `device:${user.id}:${session.device}:${dayKey}`,
        ...who,
        sessionId: session.id,
        title: `${fullName} — yangi qurilmadan kirdi`,
        detail: `Ilgari ishlatilmagan qurilma: ${session.device} (${session.ip || "IP yo'q"}).`,
        meta: { device: session.device, ip: session.ip, channel: session.channel },
      });
    }
  }

  /* ── 2b. YANGI TARMOQ (IP) ───────────────────────────────────────
     ⚠️ FAQAT QURILMA TANISH BO'LGANDA. Yangi qurilmada IP ham
     tabiiy ravishda yangi bo'ladi va ikkita ogohlantirish bitta
     hodisani ikki marta aytardi. Qiymatli holat esa aynan teskarisi:
     "O'ZI odatdagi noutbukidan, LEKIN butunlay boshqa tarmoqdan
     kirdi" — bu yo safar, yo qurilma o'g'irlangani.

     ⚠️ Jiddiylik `low`: tarmoq almashishi o'z-o'zicha shubhali emas
     (uy, mobil internet, safar). U faqat BOSHQA signal bilan birga
     turganda ma'no kasb etadi — shuning uchun qayd etiladi, lekin
     ro'yxatning tepasiga chiqmaydi. */
  const network = networkOf(session.ip);

  if (network && session.device && deviceKnown) {
    const since = new Date(Date.now() - 60 * 24 * 3600 * 1000);

    // ⚠️ Prefiks bo'yicha SQL filtri yo'q (`ip` to'liq saqlanadi),
    // shuning uchun oxirgi seanslarning IP lari o'qilib, prefiks JS
    // tomonida hisoblanadi. Qatorlar soni bitta odam uchun kichik.
    const recent = await platformPrisma.userSession.findMany({
      where: { userId: user.id, id: { not: session.id }, createdAt: { gte: since } },
      select: { ip: true },
      take: 200,
    });

    const knownNetworks = new Set(
      recent.map((row) => networkOf(row.ip)).filter(Boolean),
    );

    if (recent.length > 0 && !knownNetworks.has(network)) {
      await raise({
        type: "new_ip",
        severity: "low",
        dedupeKey: `network:${user.id}:${network}:${dayKey}`,
        ...who,
        sessionId: session.id,
        title: `${fullName} — yangi tarmoqdan kirdi`,
        detail:
          `Tanish qurilma (${session.device}), lekin ilgari ishlatilmagan ` +
          `tarmoq: ${session.ip}. Odatdagi tarmoqlar: ` +
          `${[...knownNetworks].slice(0, 3).join(", ")}.`,
        meta: {
          ip: session.ip,
          network,
          device: session.device,
          knownNetworks: [...knownNetworks].slice(0, 10),
        },
      });
    }
  }

  /* ── 2c. TEZ FILIAL ALMASHTIRISH ─────────────────────────────────
     Qisqa vaqt ichida bir nechta filialga kirish.

     ⚠️ FILIAL ALMASHTIRISH O'Z-O'ZICHA NORMAL: rahbar kun davomida
     ikki filialni ko'rishi mumkin va `switch-branch` har safar yangi
     seans ochadi. Shubhali bo'lgani — TEZLIK: o'n daqiqada uchta
     boshqa filial odamning ish ritmi emas, skript ritmi.

     ⚠️ `endReason` bo'yicha FILTRLANMAYDI. Almashtirish eskisini
     `superseded` bilan yopadi, ya'ni "ochiq seanslar" ro'yxatida
     ular ko'rinmaydi — tarixga qarash kerak. */
  if (branchId) {
    const since = new Date(Date.now() - RAPID_SWITCH_WINDOW_MS);

    const recentSessions = await platformPrisma.userSession.findMany({
      where: { userId: user.id, createdAt: { gte: since } },
      select: { branchId: true },
    });

    const branchIds = [...new Set(recentSessions.map((row) => row.branchId))];

    if (branchIds.length >= RAPID_SWITCH_THRESHOLD) {
      const branches = await platformPrisma.branch.findMany({
        where: { id: { in: branchIds } },
        select: { id: true, name: true },
      });

      await raise({
        type: "rapid_switch",
        severity: "medium",
        // ⚠️ Kalitda SOAT bor, kun emas: bu hodisa TEZLIK haqida va
        // ertalabki almashtirishlar to'plami bilan kechqurungisi
        // bitta qatorga qo'shilib ketmasligi kerak.
        dedupeKey: `switch:${user.id}:${new Date().toISOString().slice(0, 13)}`,
        ...who,
        sessionId: session.id,
        title: `${fullName} — ${branchIds.length} ta filialga tez kirdi`,
        detail:
          `Oxirgi ${Math.round(RAPID_SWITCH_WINDOW_MS / 60000)} daqiqada ` +
          `${branchIds.length} ta filialga kirildi: ` +
          `${branches.map((b) => b.name).join(", ")}.`,
        meta: {
          windowMinutes: Math.round(RAPID_SWITCH_WINDOW_MS / 60000),
          branches: branches.map((b) => ({ id: b.id, name: b.name })),
        },
      });
    }
  }

  /* ── 3. KECHASI KIRISH ───────────────────────────────────────────
     ⚠️ O'ZI ogohlantirish EMAS, `low`: tunda ishlaydigan xodim ham bor.
     Lekin "kechasi 3 da yangi qurilmadan kirildi" ikkita past signal
     birga turganda manzarani o'zgartiradi — shuning uchun qayd etiladi. */
  const tashkentHour = new Date(Date.now() + 5 * 3600 * 1000).getUTCHours();
  if (tashkentHour >= NIGHT_FROM && tashkentHour < NIGHT_TO) {
    await raise({
      type: "night_login",
      severity: "low",
      dedupeKey: `night:${user.id}:${dayKey}`,
      ...who,
      sessionId: session.id,
      title: `${fullName} — tunda tizimga kirdi`,
      detail: `Kirish vaqti: ${formatDateTimeUz(session.createdAt)} (Toshkent).`,
      meta: { hour: tashkentHour, ip: session.ip, device: session.device },
    });
  }

  /* ── 4. UZOQ KIRMAGAN HISOB UYG'ONDI ─────────────────────────────
     Ishdan ketgan xodimning hisobi o'chirilmay qolgan bo'lsa, uning
     "qayta kirishi" eng jiddiy signallardan biri. */
  const prevSession = await platformPrisma.userSession.findFirst({
    where: { userId: user.id, id: { not: session.id } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  if (prevSession) {
    const idleDays = Math.floor(
      (session.createdAt - prevSession.createdAt) / (24 * 3600 * 1000),
    );
    if (idleDays >= DORMANT_DAYS) {
      await raise({
        type: "dormant_login",
        severity: "high",
        dedupeKey: `dormant:${user.id}:${dayKey}`,
        ...who,
        sessionId: session.id,
        title: `${fullName} — ${idleDays} kundan keyin qaytib kirdi`,
        detail:
          `Oldingi kirish: ${formatDateTimeUz(prevSession.createdAt)}. ` +
          `Hisob ishlatilmayotgan bo'lsa, uni o'chirib qo'yish tavsiya etiladi.`,
        meta: { idleDays, previousAt: prevSession.createdAt },
      });
    }
  }

  /* ── 5. BRUTE-FORCE ──────────────────────────────────────────────
     Muvaffaqiyatli kirishdan OLDINGI muvaffaqiyatsiz urinishlar.
     ⚠️ Aynan shu ketma-ketlik ("14 marta xato, 15-chisi o'tdi") eng
     jiddiy holat: parol TOPILGAN bo'lishi mumkin. */
  const failedRecently = await platformPrisma.loginAttempt.count({
    where: {
      username: user.username,
      success: false,
      createdAt: { gte: new Date(Date.now() - BRUTE_WINDOW_MS) },
    },
  });

  if (failedRecently >= BRUTE_THRESHOLD) {
    await raise({
      type: "brute_force",
      severity: "critical",
      dedupeKey: `brute:${user.id}:${dayKey}`,
      ...who,
      sessionId: session.id,
      title: `${fullName} — parol tanlashdan keyin kirildi`,
      detail:
        `Muvaffaqiyatli kirishdan oldin ${failedRecently} ta noto'g'ri urinish ` +
        `qayd etilgan (oxirgi 15 daqiqa). Parolni almashtirish tavsiya etiladi.`,
      meta: { failedAttempts: failedRecently, ip: session.ip, device: session.device },
    });
  }
}

/**
 * TOKENSIZ QOLGAN URINISHLAR — muvaffaqiyatsiz kirish uchun qoida.
 *
 * Muvaffaqiyatli kirish bo'lmasa `runRules` umuman chaqirilmaydi, ya'ni
 * "hisobga urinishmoqda, lekin hali kira olishmadi" holati ko'rinmay
 * qolardi. Bu funksiya aynan shuni ushlaydi.
 *
 * @param {object} input
 * @param {string} input.username
 * @param {string} [input.userId]
 * @param {string} [input.branchId]
 * @param {object} input.client
 * @returns {Promise<void>}
 */
async function checkFailedStreak({ username, userId, branchId, client = {} }) {
  try {
    // ⚠️ JORIY URINISH HAM SANALADI. `recordAttempt` va bu funksiya
    // parallel ketadi (`auth.service.js` ikkalasini ham `await`
    // qilmaydi), ya'ni sanoq ko'pincha oxirgi urinishni KO'RMAYDI va
    // 5 ta ostona amalda 6 ga aylanardi. Bitta qo'shish poygani
    // butunlay yo'q qiladi va ortiqcha kutish talab qilmaydi.
    const previous = await platformPrisma.loginAttempt.count({
      where: {
        username,
        success: false,
        createdAt: { gte: new Date(Date.now() - BRUTE_WINDOW_MS) },
      },
    });

    const failed = previous + 1;
    if (failed < BRUTE_THRESHOLD) return;

    const dayKey = `${branchId ?? "-"}:${currentDayDate().toISOString().slice(0, 10)}`;

    await raise({
      type: "brute_force",
      severity: "high",
      dedupeKey: `brute-fail:${username}:${dayKey}`,
      userId: userId ?? null,
      username,
      branchId: branchId ?? null,
      title: `"${username}" — ${failed} ta muvaffaqiyatsiz kirish urinishi`,
      detail:
        `Oxirgi 15 daqiqada ${failed} marta noto'g'ri parol kiritildi. ` +
        `IP: ${client.ip || "noma'lum"}, qurilma: ${client.device || "noma'lum"}.`,
      meta: { failedAttempts: failed, ip: client.ip, device: client.device },
    });
  } catch (error) {
    logger.warn(`[security] urinishlar tekshirilmadi: ${error.message}`);
  }
}

/**
 * SEANS "KO'RINDI" — `auth.middleware` har so'rovda chaqiradi.
 *
 * ⚠️ Bekor qilingan seansni ANIQLAB BERADI: qaytgan qiymat `false`
 * bo'lsa, chaqiruvchi 401 tashlaydi. Aynan shu bitta qator "seansni
 * tugat" tugmasini haqiqiy qiladi — usiz tugma faqat ro'yxatdan qatorni
 * o'chirgan bo'lardi.
 *
 * ⚠️ Oyna ichida bo'lsa BAZAGA UMUMAN BORMAYDI va `true` qaytaradi.
 * Ya'ni bekor qilish eng ko'pi bilan 2 daqiqada kuchga kiradi. Bu
 * ataylab: har so'rovda seansni o'qish auth'ni ikki barobar
 * qimmatlashtirardi, 2 daqiqa esa amaliyotda yetarli.
 *
 * @param {string} jti
 * @returns {Promise<boolean>} - seans amal qiladimi
 */
async function touchSession(jti) {
  if (!jti) return true;

  const now = Date.now();
  const last = seenWindow.get(jti);
  if (last && now - last < SEEN_WINDOW_MS) return true;

  if (seenWindow.size > SEEN_LIMIT) {
    for (const [key, at] of seenWindow) {
      if (now - at > SEEN_WINDOW_MS) seenWindow.delete(key);
    }
    if (seenWindow.size > SEEN_LIMIT) seenWindow.clear();
  }

  // ⚠️ OYNAGA FAQAT "TIRIK" JAVOBDAN KEYIN YOZILADI, tekshiruvdan
  // OLDIN EMAS. Aks holda tugatilgan seans birinchi so'rovda 401
  // olardi-yu, o'sha 401 ning O'ZI oynani to'ldirib qo'yardi va
  // keyingi ikki daqiqadagi so'rovlar bazaga umuman bormasdan
  // O'TIB KETARDI — ya'ni "seansni tugat" tugmasi bir marta ishlab,
  // darhol o'z ta'sirini yo'qotardi.
  const alive = await checkSession(jti);
  if (alive) seenWindow.set(jti, now);
  else seenWindow.delete(jti);

  return alive;
}

/**
 * Seansning holatini BAZADAN o'qiydi va `lastSeenAt` ni yangilaydi.
 *
 * `touchSession` dan ajratilgan: oyna mantig'i va baza mantig'i bitta
 * funksiyada aralashib turgani uchun "qachon keshga yoziladi" degan
 * savolga javob berish qiyin edi.
 *
 * @param {string} jti
 * @returns {Promise<boolean>} - seans amal qiladimi
 */
async function checkSession(jti) {
  try {
    // ⚠️ `updateMany` — `update` qator topilmasa xato tashlaydi, bu yerda
    // esa "qator yo'q" normal holat: eski token yoki boshqa filialning
    // seansi.
    //
    // ⚠️ `expiresAt` HAM tekshiriladi: cron muddati o'tgan seanslarni
    // 03:40 da yopadi, ya'ni oralig'da `endReason` hamon `active`
    // bo'lib turadi. Faqat `endReason` ga qarasak, muddati o'tgan
    // token o'sha kechagacha ishlab turardi.
    const { count } = await platformPrisma.userSession.updateMany({
      where: { jti, endReason: "active", expiresAt: { gt: new Date() } },
      data: { lastSeenAt: new Date() },
    });

    if (count === 1) return true;

    // Qator yangilanmadi — yo umuman yo'q (eski token: o'tkazamiz), yo
    // tugatilgan/muddati o'tgan (o'tkazmaymiz).
    const exists = await platformPrisma.userSession.findUnique({
      where: { jti },
      select: { endReason: true, expiresAt: true },
    });

    if (!exists) return true;
    return exists.endReason === "active" && exists.expiresAt > new Date();
  } catch (error) {
    // Baza yiqilsa hamma tizimdan chiqib ketmasligi kerak
    logger.warn(`[security] seans yangilanmadi: ${error.message}`);
    return true;
  }
}

/**
 * SEANSNI YOPISH — logout yoki admin tomonidan bekor qilish.
 *
 * @param {object} input
 * @param {string} [input.jti]
 * @param {string} [input.sessionId]
 * @param {string} input.reason - `SessionEndReason`
 * @param {string} [input.actorId]
 * @returns {Promise<number>} - nechta seans yopildi
 */
async function closeSession({ jti, sessionId, reason, actorId }) {
  const where = jti ? { jti } : sessionId ? { id: sessionId } : null;
  if (!where) return 0;

  const { count } = await platformPrisma.userSession.updateMany({
    where: { ...where, endReason: "active" },
    data: {
      endReason: reason,
      endedAt: new Date(),
      endedBy: actorId ?? null,
    },
  });

  // Oynani darhol bo'shatamiz — aks holda bekor qilingan seans yana 2
  // daqiqa "ko'rindi" deb o'tib ketardi
  if (jti) seenWindow.delete(jti);
  else if (count > 0) seenWindow.clear();

  return count;
}

/**
 * "KO'RINDI" OYNASINI TOZALASH.
 *
 * ⚠️ `closeSession` dan chetlab o'tib yopilgan seanslar uchun
 * (`updateMany` bilan ommaviy bekor qilish). Tozalanmasa, yopilgan
 * seanslar yana 2 daqiqa davomida o'tib ketardi va "hammasini tugat"
 * tugmasi kechikkan bo'lib ko'rinardi.
 *
 * @returns {void}
 */
function forgetSeenCache() {
  seenWindow.clear();
}

/**
 * Muddati o'tgan seanslarni yopadi — cron chaqiradi.
 *
 * ⚠️ O'CHIRMAYDI, YOPADI. Seans tarixi — xavfsizlik tarixi: "bu odam
 * o'sha kuni qaysi qurilmadan kirgan edi" degan savolga javob faqat
 * qator saqlangandagina bo'ladi.
 *
 * @returns {Promise<number>}
 */
async function expireStaleSessions() {
  const { count } = await platformPrisma.userSession.updateMany({
    where: { endReason: "active", expiresAt: { lte: new Date() } },
    data: { endReason: "expired", endedAt: new Date() },
  });
  return count;
}

module.exports = {
  SEEN_WINDOW_MS,
  BRUTE_THRESHOLD,
  DORMANT_DAYS,
  RAPID_SWITCH_WINDOW_MS,
  RAPID_SWITCH_THRESHOLD,
  networkOf,
  recordAttempt,
  raise,
  liveSessions,
  openSession,
  checkFailedStreak,
  touchSession,
  closeSession,
  forgetSeenCache,
  expireStaleSessions,
};
