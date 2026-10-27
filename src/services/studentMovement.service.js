/**
 * O'QUVCHILAR HARAKATI — "nechtasi keldi, nechtasi ketdi, qancha foizga o'zgardi".
 *
 * ⚠️ YANGI JADVAL YO'Q va qo'shilmaydi — manba `StudentEnrollment`
 * (`studentDeparture.service.js` dagi AYNI mulohaza): kelish fakti davrning
 * OCHILGANI, ketish fakti esa davrning YOPILGANI. Ikkinchi registr ochilsa,
 * arxivlash, filiallararo ko'chirish va qo'lda yopish uchun uchta alohida
 * yo'l paydo bo'lardi va ulardan biri jimgina yozilmay qolardi.
 *
 * Bu servis faqat O'QIYDI.
 *
 * ──────────────────────────────────────────────────────────────────────
 * ARIFMETIKA — oyning CHEGARASI qayerda
 * ──────────────────────────────────────────────────────────────────────
 *
 *   oy oxiridagi son = oy boshidagi son + kelganlar − ketganlar
 *
 * Bu tenglik TASODIF emas, chegaraning ta'rifidan kelib chiqadi:
 *
 *   openCount(M) = `startDate < M ning 1-kuni` VA
 *                  (`endDate` yo'q YOKI `endDate >= M ning 1-kuni`)
 *   closeCount(M) = openCount(M + 1)
 *
 * ⚠️ `startDate < 1-kun` (`<=` EMAS): aynan 1-kuni kelgan o'quvchi
 * "kelganlar" da sanaladi — ikkalasida sanalsa, u ikki marta qo'shilardi.
 * ⚠️ `endDate >= 1-kun`: `endDate` INKLYUZIV, ya'ni "oxirgi o'qigan kun"
 * (`education.md` §3). Oldingi oyning oxirgi kuni bilan yopilgan davr shu
 * oyning boshida allaqachon yo'q — u o'sha oyning "ketganlar" ida.
 *
 * Shu ikki chegara tufayli har oyning uchta raqami bir-biriga mos keladi
 * va hisobotdagi "farq" ustuni ko'z bilan tekshiriladi. Chegara boshqacha
 * qo'yilsa (masalan ikkalasi ham inklyuziv), oyning oxirgi kuni bilan
 * ketgan o'quvchi ham "ketganlar" da, ham "oy oxirida" da turib, jadval
 * bir birlikka og'ib ketardi.
 *
 * ⚠️ KELGUSI OYLAR HISOBOTGA KIRMAYDI (`education.md` §1 bilan AYNI qoida):
 * yuqori chegara joriy oydan oshmaydi. Joriy oyning O'ZI esa TO'LIQ birlik
 * sifatida olinadi — oy ichidagi kelgusi sana bilan yopilgan davr ham shu
 * oyga yoziladi (aks holda yuqoridagi tenglik joriy oyda buzilardi).
 *
 * ⚠️ `isArchived` BO'YICHA FILTRLANMAYDI: "o'quvchi o'qiyaptimi" degan
 * savolga faqat o'qish davri javob beradi (`education.md` §4). Bosh
 * sahifadagi "O'quvchilar" kartasi esa LOGIN larni sanaydi
 * (`user.service.js` → `role: student, isArchived: false`) — ikki raqam
 * farq qilishi mumkin, shuning uchun hisobot ikkalasini ham yozadi
 * (`context`): farqni yashirish "nega 462 emas" degan savolni qoldirardi.
 */

const prisma = require("../config/prisma");
const platformPrisma = require("../config/platformPrisma");
const { getBranch } = require("../config/branchContext");
const { BadRequestError } = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const {
  isMonthKey,
  parseMonthKey,
  currentMonthKey,
  monthKeyOfDate,
  monthStartDate,
  monthEndDate,
  nextMonth,
  diffMonths,
  formatMonthKey,
  formatMonthShort,
  currentDayDate,
} = require("../helpers/month.helpers");
const {
  END_REASONS,
  END_REASON_LABELS,
} = require("./studentEnrollment.service");
const { loadDepartureClasses } = require("./studentDeparture.service");

/**
 * Oraliqning eng uzun chegarasi (oy). Hisobot — o'qiladigan hujjat:
 * 60 oylik jadval Word faylida ham, ekranda ham o'qilmas bo'lib qolardi.
 */
const MAX_MONTHS = 60;

/** Sabab ko'rsatilmagan ketishlar uchun toifa kaliti (eski ma'lumot). */
const UNKNOWN_REASON = "unknown";
const UNKNOWN_REASON_LABEL = "Sabab ko'rsatilmagan";

const DAY_MS = 86400000;

/** `@db.Date` → "YYYY-MM-DD" (faqat `getUTC*`, `finance.md` §0). */
const iso = (date) => (date == null ? null : date.toISOString().slice(0, 10));

/** Foiz — bir xonali kasr bilan; maxraj nol bo'lsa `null` (0% EMAS). */
const percentOf = (part, base) =>
  base > 0 ? Math.round((part / base) * 1000) / 10 : null;

// ─────────────────────────────────────────────
// So'rov parametrlari
// ─────────────────────────────────────────────

/**
 * ORALIQ — uchta shakl, ustunlik tartibi bilan:
 *   `from`/`to` (YYYYMM) → aniq oraliq
 *   `month` (YYYYMM)     → bitta oy
 *   `year` (YYYY)        → yanvardan joriy oygacha (yoki dekabrgacha)
 *
 * Sukut — JORIY YIL: hisobot birinchi ochilishda "bu yil nima bo'ldi"
 * degan savolga javob berishi kerak.
 *
 * @param {object} query
 * @returns {{from: number, to: number, scope: string, year: number, month: number|null}}
 */
const resolveRange = (query = {}) => {
  const today = currentMonthKey();
  const thisYear = Math.trunc(today / 100);

  const rawFrom = String(query.from ?? "").trim();
  const rawTo = String(query.to ?? "").trim();
  const rawMonth = String(query.month ?? "").trim();
  const rawYear = String(query.year ?? "").trim();

  let from;
  let to;
  let scope;
  let year = thisYear;
  let month = null;

  if (rawFrom || rawTo) {
    scope = "range";
    from = parseMonthKey(rawFrom || rawTo, "Boshlanish oyi");
    to = parseMonthKey(rawTo || rawFrom, "Tugash oyi");
  } else if (rawMonth) {
    scope = "month";
    from = parseMonthKey(rawMonth, "Oy");
    to = from;
  } else {
    scope = "year";
    if (rawYear) {
      const parsed = Number.parseInt(rawYear, 10);
      if (!Number.isInteger(parsed) || parsed < 2000 || parsed > 2100) {
        throw new BadRequestError("Yil noto'g'ri ko'rsatilgan");
      }
      year = parsed;
    }
    from = year * 100 + 1;
    to = year * 100 + 12;
  }

  if (!isMonthKey(from) || !isMonthKey(to)) {
    throw new BadRequestError("Oy noto'g'ri ko'rsatilgan");
  }
  if (from > to) {
    throw new BadRequestError("Boshlanish oyi tugash oyidan keyin bo'lishi mumkin emas");
  }

  // ⚠️ Kelgusi oylar kesiladi — fayl boshidagi izoh. Butun oraliq
  // kelajakda bo'lsa (masalan keyingi yil) bu XATO, jim bo'sh jadval emas:
  // odam yil tanlab, nega hech narsa yo'qligini bilmay qolardi.
  if (from > today) {
    throw new BadRequestError(
      "Kelgusi oylar uchun hisobot yo'q: ular hali fakt emas",
    );
  }
  if (to > today) to = today;

  if (diffMonths(from, to) + 1 > MAX_MONTHS) {
    throw new BadRequestError(`Oraliq ${MAX_MONTHS} oydan uzun bo'lishi mumkin emas`);
  }

  if (scope === "month") month = from;
  if (scope !== "year") year = Math.trunc(to / 100);

  return { from, to, scope, year, month };
};

const monthsBetween = (from, to) => {
  const months = [];
  for (let cursor = from; cursor <= to; cursor = nextMonth(cursor)) {
    months.push(cursor);
  }
  return months;
};

// ─────────────────────────────────────────────
// Xom ma'lumot
// ─────────────────────────────────────────────

/**
 * BUTUN TARIX BIR MARTA O'QILADI.
 *
 * "Oy boshidagi son" uchun oraliqdan OLDIN boshlangan davrlar ham kerak,
 * ya'ni pastki chegara qo'yib bo'lmaydi. Qatorlar soni esa o'quvchilar
 * soni bilan o'lchanadi (bir o'quvchida odatda bitta davr), shuning uchun
 * bitta skaner har oy uchun alohida `count` so'rovidan ham arzon, ham
 * ishonchliroq: hamma raqam BIR XIL ma'lumotdan chiqadi, ya'ni ular
 * bir-biriga qarama-qarshi bo'lishi STRUKTURAVIY imkonsiz.
 *
 * @param {number} toMonth - yuqori chegara (YYYYMM)
 */
const loadEnrollments = (toMonth) =>
  prisma.studentEnrollment.findMany({
    where: { startDate: { lte: monthEndDate(toMonth) } },
    select: {
      id: true,
      studentId: true,
      startDate: true,
      endDate: true,
      endReason: true,
      reason: true,
      note: true,
      createdAt: true,
    },
    orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
  });

const STUDENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  isArchived: true,
  classes: {
    select: { class: { select: { id: true, name: true } } },
    orderBy: { class: { name: "asc" } },
  },
};

const loadStudents = async (studentIds) => {
  if (studentIds.length === 0) return new Map();

  const students = await prisma.user.findMany({
    where: { id: { in: studentIds } },
    select: STUDENT_SELECT,
  });

  return new Map(students.map((s) => [s.id, s]));
};

/** To'liq ism — bo'sh familiya "undefined" bo'lib chiqmasin. */
const nameOf = (student) =>
  [student?.firstName, student?.lastName].filter(Boolean).join(" ") ||
  "Noma'lum o'quvchi";

const classNameOf = (student) => {
  const names = (student?.classes ?? []).map((link) => link.class?.name).filter(Boolean);
  return names.length ? names.join(", ") : null;
};

// ─────────────────────────────────────────────
// Oylar kesimi
// ─────────────────────────────────────────────

/**
 * Oy boshidagi o'quvchilar soni — fayl boshidagi chegara ta'rifi bilan.
 *
 * @param {Array} rows - barcha davrlar
 * @param {number} monthKey
 * @returns {number} TAKRORSIZ o'quvchilar soni
 */
const openCountAt = (rows, monthKey) => {
  const boundary = monthStartDate(monthKey).getTime();
  const ids = new Set();

  for (const row of rows) {
    if (row.startDate.getTime() >= boundary) continue;
    if (row.endDate && row.endDate.getTime() < boundary) continue;
    ids.add(row.studentId);
  }

  return ids.size;
};

/**
 * Har bir o'quvchining ENG ERTA davri — "yangi" bilan "qaytib kelgan" ni
 * ajratadi. Ikkalasi bitta "keldi" raqamiga qo'shiladi (maktabga odam
 * qo'shildi), lekin hisobot ularni ALOHIDA ham ko'rsatadi: "20 ta keldi"
 * ning 15 tasi yangi, 5 tasi qaytgan bo'lsa, bu butunlay boshqa manzara.
 *
 * @param {Array} rows
 * @returns {Map<string, number>} studentId → eng erta `startDate` (ms)
 */
const firstStartByStudent = (rows) => {
  const first = new Map();

  for (const row of rows) {
    const time = row.startDate.getTime();
    const known = first.get(row.studentId);
    if (known === undefined || time < known) first.set(row.studentId, time);
  }

  return first;
};

const reasonKeyOf = (row) => row.endReason ?? UNKNOWN_REASON;

const reasonLabelOf = (row) =>
  row.endReason ? END_REASON_LABELS[row.endReason] : UNKNOWN_REASON_LABEL;

/**
 * Sabab toifalari — HAR DOIM to'rtta qator, nollari ham
 * (`studentDeparture.service.js` dagi AYNI qaror: bo'sh joy "nol" degani
 * emas, "hisoblanmadi" degani ham bo'lib o'qiladi). "Sabab ko'rsatilmagan"
 * esa FAQAT haqiqatan uchrasa qo'shiladi — eski ma'lumotdagi bo'shliq.
 *
 * @param {Array} leftRows
 * @returns {Array<{key: string, label: string, count: number, percent: number|null}>}
 */
const groupByReason = (leftRows) => {
  const counts = new Map();
  for (const row of leftRows) {
    const key = reasonKeyOf(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const total = leftRows.length;
  const items = END_REASONS.map((key) => ({
    key,
    label: END_REASON_LABELS[key],
    count: counts.get(key) ?? 0,
    percent: percentOf(counts.get(key) ?? 0, total),
  }));

  if (counts.has(UNKNOWN_REASON)) {
    items.push({
      key: UNKNOWN_REASON,
      label: UNKNOWN_REASON_LABEL,
      count: counts.get(UNKNOWN_REASON),
      percent: percentOf(counts.get(UNKNOWN_REASON), total),
    });
  }

  return items;
};

/**
 * Bitta davr uchun ko'rsatkichlar bloki — oy ham, butun oraliq ham AYNI
 * funksiyadan chiqadi. Ikkita nusxa bo'lsa, oyning foizi bilan yillik
 * foiz boshqa formuladan hisoblanib qolardi.
 *
 * @param {{openCount: number, closeCount: number, joined: Array, left: Array,
 *   firstStart: Map<string, number>}} input
 */
const buildMetrics = ({
  openCount,
  closeCount,
  joined,
  left,
  movedIn = [],
  movedOut = [],
  firstStart,
}) => {
  const joinedNew = joined.filter(
    (row) => firstStart.get(row.studentId) === row.startDate.getTime(),
  ).length;

  return {
    openCount,
    joined: joined.length,
    joinedNew,
    joinedReturned: joined.length - joinedNew,
    left: left.length,
    net: joined.length - left.length,
    // ⚠️ KO'CHISH ALOHIDA O'LCHOV va `net` ga KIRMAYDI: u maktabning
    // o'sishi emas, tarmoq ichidagi joy almashish. Lekin oy oxiridagi
    // songa TA'SIR QILADI, shuning uchun tenglikda o'z hadi bor.
    movedIn: movedIn.length,
    movedOut: movedOut.length,
    moveNet: movedIn.length - movedOut.length,
    closeCount,
    // ⚠️ Maxraj — DAVR BOSHIDAGI son: "450 tadan 12 ta ko'paydi" degan
    // jumlaning o'zi. Oxirgi songa bo'linsa, o'sish va tushish bir xil
    // o'zgarish uchun turli foiz berardi.
    joinedPercent: percentOf(joined.length, openCount),
    leftPercent: percentOf(left.length, openCount),
    growthPercent: percentOf(joined.length - left.length, openCount),
  };
};

/**
 * FILIALLAR BO'YICHA BITTA BLOKKA — "Umumiy ko'rinish" (butun tarmoq) uchun.
 *
 * ⚠️ FOIZ QAYTA HISOBLANADI, O'RTACHALANMAYDI. Umumiy birlashtiruvchi har
 * `*Percent` kalitini filiallar bo'yicha OG'IRLIKSIZ o'rtachalaydi
 * (`aggregateMerge.helpers.js`; root `CLAUDE.md`: "aniq qiymat kerak bo'lsa
 * o'sha yo'l uchun alohida qoida yoziladi"). Bu hisobotda u YOLG'ON raqam
 * berardi: 344 o'quvchili filialning +2% i bilan 0 o'quvchili (endi
 * ochilgan) filialning "—" i teng hissa qo'sha olmaydi. Tarmoq foizi FAQAT
 * tarmoq yig'indisidan chiqadi: (Σkeldi − Σketdi) ÷ Σdavr boshidagi son.
 *
 * ⚠️ Sanoqchilar esa shunchaki QO'SHILADI va bu to'g'ri: o'quvchi bir vaqtda
 * faqat BITTA filialda bo'ladi (`finance.md` §12), ya'ni xodim tomonidagi
 * "bir odam ikki filialda" muammosi bu yerda TUG'ILMAYDI.
 *
 * @param {Array<object>} items - `buildMetrics` qaytargan bloklar
 */
const combineMetrics = (items) => {
  const sum = (key) =>
    items.reduce((acc, item) => acc + (Number(item?.[key]) || 0), 0);

  const openCount = sum("openCount");
  const joined = sum("joined");
  const left = sum("left");
  const movedIn = sum("movedIn");
  const movedOut = sum("movedOut");

  return {
    openCount,
    joined,
    joinedNew: sum("joinedNew"),
    joinedReturned: sum("joinedReturned"),
    left,
    net: joined - left,
    // ⚠️ TARMOQ DARAJASIDA KO'CHISH ODATDA O'ZINI YO'QOTADI (bitta bola
    // bir filialdan chiqib, boshqasiga kiradi), lekin NOLGA TENG EMAS:
    // ko'chish oyning 1-kuni bo'lsa, chiqish OLDINGI oyga tushadi
    // (`finance.md` §12). Shuning uchun ikkala son ham saqlanadi.
    movedIn,
    movedOut,
    moveNet: movedIn - movedOut,
    closeCount: sum("closeCount"),
    joinedPercent: percentOf(joined, openCount),
    leftPercent: percentOf(left, openCount),
    growthPercent: percentOf(joined - left, openCount),
  };
};

/**
 * Sabab kesimlarini birlashtiradi.
 *
 * ⚠️ Toifalar TARTIBI va YORLIG'I `groupByReason` dagi AYNI manbadan
 * (`END_REASONS` + `END_REASON_LABELS`): ikkinchi nusxa bo'lsa, umumiy
 * ko'rinishda sabablar boshqa tartibda chiqib, ikki ekran solishtirib
 * bo'lmas holga kelardi. Ulush esa TARMOQ jamiga nisbatan qayta
 * hisoblanadi — filial ulushlarining o'rtachasi 100% ni bermasdi.
 *
 * @param {Array<Array<object>>} lists
 */
const combineReasons = (lists) => {
  const counts = new Map();

  for (const list of lists) {
    for (const item of list ?? []) {
      counts.set(item.key, (counts.get(item.key) ?? 0) + (item.count ?? 0));
    }
  }

  const total = [...counts.values()].reduce((acc, n) => acc + n, 0);

  const items = END_REASONS.map((key) => ({
    key,
    label: END_REASON_LABELS[key],
    count: counts.get(key) ?? 0,
    percent: percentOf(counts.get(key) ?? 0, total),
  }));

  if (counts.get(UNKNOWN_REASON)) {
    items.push({
      key: UNKNOWN_REASON,
      label: UNKNOWN_REASON_LABEL,
      count: counts.get(UNKNOWN_REASON),
      percent: percentOf(counts.get(UNKNOWN_REASON), total),
    });
  }

  return items;
};

/* ─────────────── FILIALLARARO KO'CHISH — "keldi/ketdi" EMAS ─────────────── */

/**
 * ⚠️ BOSHQA FILIALGA O'TISH MAKTABGA KELISH VA MAKTABDAN KETISH EMAS
 * (biznes qarori, 2026-10-27). Ko'chishda manbada davr T−1 da YOPILADI,
 * maqsadda esa T dan OCHILADI (`finance.md` §12) — ya'ni bitta bola
 * tarmoq ichida joyini o'zgartirgani uchun "ketdi" ham, "keldi" ham
 * bo'lib sanalardi va ikkala sanoqchi ham shishib ketardi. Tarmoq
 * darajasida esa bu umuman harakat emas: maktabda o'quvchilar soni
 * o'zgarmaydi.
 *
 * ⚠️ `endReason = "transferred"` BO'YICHA ANIQLAB BO'LMAYDI va bu eng
 * muhim tuzoq: o'sha toifani admin QO'LDA ham qo'yadi ("boshqa maktabga
 * o'tdi") — u esa HAQIQIY ketish. Toifaga tayansak, maktabni butunlay
 * tashlab ketgan bolalar jimgina "ichki ko'chish" bo'lib yo'qolardi.
 *
 * Yagona ishonchli manba — platformadagi KO'CHIRISH JURNALI
 * (`branch_transfers` + `branch_transfer_items`, append-only).
 * `attention` ham hisob: asosiy tranzaksiya o'tgan, faqat undan keyingi
 * qadam yiqilgan (`BranchTransferStatus` izohi).
 */
const loadBranchMoves = async (from, to, branchId) => {
  if (!branchId) return [];

  // Ko'chish sanasi T: manbada oxirgi kun T−1, maqsadda birinchi kun T.
  // Demak oraliqqa ta'sir qiladigan T lar — [oraliq boshi, oraliq oxiri+1].
  const since = monthStartDate(from);
  const until = new Date(monthEndDate(to).getTime() + DAY_MS);

  return platformPrisma.branchTransfer.findMany({
    where: {
      effectiveDate: { gte: since, lte: until },
      OR: [{ sourceBranchId: branchId }, { targetBranchId: branchId }],
    },
    select: {
      effectiveDate: true,
      sourceBranchId: true,
      targetBranchId: true,
      sourceBranch: { select: { name: true } },
      targetBranch: { select: { name: true } },
      items: {
        where: { subjectType: "user" },
        select: { subjectId: true },
      },
    },
  });
};

/**
 * Jurnaldan "qaysi qator ko'chish" degan savolga javob beradigan indeks.
 *
 * ⚠️ KALIT — O'QUVCHI + KUN, ko'chirish id si EMAS: hisobot o'qish
 * davrlarini o'qiydi va ular jurnalga ISHORA QILMAYDI (boshqa schema, FK
 * yo'q). Bog'lovchi yagona narsa — sana:
 *   · maqsadda  `startDate === T`
 *   · manbada   `endDate   === T − 1`
 *
 * Sof funksiya: bazasiz sinaladi (`test/studentMovement.test.js`).
 *
 * @param {Array} transfers - `loadBranchMoves` natijasi
 * @param {string} branchId - JORIY filial
 */
const buildMoveIndex = (transfers, branchId) => {
  const movedIn = new Map();
  const movedOut = new Map();

  for (const transfer of transfers) {
    const arrival = iso(transfer.effectiveDate);
    const lastDay = iso(new Date(transfer.effectiveDate.getTime() - DAY_MS));

    for (const item of transfer.items) {
      if (transfer.targetBranchId === branchId) {
        movedIn.set(`${item.subjectId}|${arrival}`, {
          fromBranch: transfer.sourceBranch?.name ?? null,
          toBranch: transfer.targetBranch?.name ?? null,
        });
      }
      if (transfer.sourceBranchId === branchId) {
        movedOut.set(`${item.subjectId}|${lastDay}`, {
          fromBranch: transfer.sourceBranch?.name ?? null,
          toBranch: transfer.targetBranch?.name ?? null,
        });
      }
    }
  }

  return {
    movedIn,
    movedOut,
    /** Qator — boshqa filialdan ko'chib kelganmi? */
    isIn: (row) => movedIn.get(`${row.studentId}|${iso(row.startDate)}`) ?? null,
    /** Qator — boshqa filialga ko'chib ketganmi? */
    isOut: (row) =>
      row.endDate
        ? (movedOut.get(`${row.studentId}|${iso(row.endDate)}`) ?? null)
        : null,
  };
};

/** Ko'chish indeksi yo'q bo'lganda (sinov, bitta filial) — hech narsa ko'chmagan. */
const EMPTY_MOVES = { movedIn: new Map(), movedOut: new Map(), isIn: () => null, isOut: () => null };

/**
 * Oraliqdagi kelgan va ketgan davrlar — XOTIRADA, bitta o'tishda.
 *
 * ⚠️ KETGANLAR `endReason` bo'yicha FILTRLANMAYDI (eski ma'lumotda u
 * bo'sh bo'lishi mumkin): aks holda yuqoridagi tenglik buzilardi —
 * o'quvchi "oy oxirida" sanoqdan chiqib, "ketganlar" ga esa tushmasdi.
 * Sababsiz qatorlar kesimda "Sabab ko'rsatilmagan" bo'lib ko'rinadi, ya'ni
 * bo'shliq yashirilmaydi.
 */
const collectRange = (rows, from, to, moves = EMPTY_MOVES) => {
  const joined = [];
  const left = [];
  const movedIn = [];
  const movedOut = [];

  for (const row of rows) {
    const startMonth = monthKeyOfDate(row.startDate);
    if (startMonth >= from && startMonth <= to) {
      // ⚠️ KO'CHIB KELGAN "keldi" GA TUSHMAYDI — u boshqa filialdan
      // o'tdi, maktabga yangi kelmadi.
      (moves.isIn(row) ? movedIn : joined).push(row);
    }

    if (row.endDate) {
      const endMonth = monthKeyOfDate(row.endDate);
      if (endMonth >= from && endMonth <= to) {
        (moves.isOut(row) ? movedOut : left).push(row);
      }
    }
  }

  return { joined, left, movedIn, movedOut };
};

/** Oraliq ko'rsatkichlari — bosh sahifa kartasi shuni chaqiradi. */
const metricsFor = (rows, from, to, firstStart, moves = EMPTY_MOVES) => {
  const { joined, left, movedIn, movedOut } = collectRange(rows, from, to, moves);

  return buildMetrics({
    openCount: openCountAt(rows, from),
    closeCount: openCountAt(rows, nextMonth(to)),
    joined,
    left,
    movedIn,
    movedOut,
    firstStart,
  });
};

// ─────────────────────────────────────────────
// Ro'yxatlar
// ─────────────────────────────────────────────

/**
 * ⚠️ KELGAN O'QUVCHIDA SINF — JORIY a'zolik: u hozir o'qiyapti, ya'ni
 * "hozirgi sinfi" aynan to'g'ri javob. KETGANIDA esa joriy a'zolik deyarli
 * har doim bo'sh bo'ladi (arxivlash o'quvchini barcha sinflardan chiqaradi,
 * `education.md` §5), shuning uchun u ketish OYINING hisob-fakturasidagi
 * `studentSnapshot.className` dan olinadi — registr bilan AYNI manba
 * (`studentDeparture.service.js` → `loadDepartureClasses`).
 */
const serializeJoined = (row, { studentById, firstStart, todayMs }) => {
  const student = studentById.get(row.studentId) ?? null;
  const isNew = firstStart.get(row.studentId) === row.startDate.getTime();
  const endMs = row.endDate ? row.endDate.getTime() : null;

  return {
    id: row.id,
    studentId: row.studentId,
    name: nameOf(student),
    username: student?.username ?? null,
    className: classNameOf(student),
    date: iso(row.startDate),
    month: monthKeyOfDate(row.startDate),
    kind: isNew ? "new" : "returned",
    kindLabel: isNew ? "Yangi" : "Qaytib kelgan",
    // "Keldi-yu, o'sha oraliqda ketdi" — hisobotda ko'rinib tursin
    leftDate: iso(row.endDate),
    isStudyingNow: endMs == null || endMs >= todayMs,
    isArchived: Boolean(student?.isArchived),
  };
};

const serializeLeft = (row, { studentById, classByKey, todayMs, laterStarts }) => {
  const student = studentById.get(row.studentId) ?? null;
  const endMonth = monthKeyOfDate(row.endDate);
  const snapshotClass = classByKey.get(`${row.studentId}|${endMonth}`) ?? null;

  // Ketgandan keyin ochilgan ENG ERTA davr — "qaytib kelgan"
  const returned = (laterStarts.get(row.studentId) ?? []).find(
    (start) => start > row.endDate.getTime(),
  );

  return {
    id: row.id,
    studentId: row.studentId,
    name: nameOf(student),
    username: student?.username ?? null,
    className: snapshotClass ?? classNameOf(student),
    classSource: snapshotClass ? "snapshot" : classNameOf(student) ? "current" : null,
    startDate: iso(row.startDate),
    date: iso(row.endDate),
    month: endMonth,
    reasonKey: reasonKeyOf(row),
    reasonLabel: reasonLabelOf(row),
    // Erkin izoh — "nega" degan savolning ASL javobi (toifa faqat kesim
    // uchun). `reason` yopishda yoziladi, `note` davrning umumiy izohi.
    reasonNote: row.reason || "",
    note: row.note || "",
    studiedDays: Math.floor((row.endDate - row.startDate) / DAY_MS) + 1,
    returnedAt: returned ? iso(new Date(returned)) : null,
    isArchived: Boolean(student?.isArchived),
  };
};

/**
 * FILIALLARARO KO'CHGAN QATOR — "qayerdan qayerga va qachon".
 *
 * ⚠️ Yo'nalish qatorning O'ZIDAN chiqadi, taxmin qilinmaydi: ko'chib
 * KELGANDA sana — davr boshlangan kun, ko'chib KETGANDA esa ko'chish kuni
 * (oxirgi o'qigan kundan bir kun keyin, `finance.md` §12). Ikkalasini
 * bitta sana deb yozsak, jadvalda bir kunlik siljish paydo bo'lardi.
 *
 * @param {{row: object, move: {fromBranch: string|null, toBranch: string|null}}} entry
 * @param {"in"|"out"} direction
 */
const serializeMoved = (entry, direction, { studentById, classByKey }) => {
  const { row, move } = entry;
  const student = studentById.get(row.studentId) ?? null;

  const date =
    direction === "in"
      ? row.startDate
      : new Date(row.endDate.getTime() + DAY_MS);

  const snapshotClass =
    direction === "out"
      ? (classByKey.get(`${row.studentId}|${monthKeyOfDate(row.endDate)}`) ?? null)
      : null;

  return {
    id: row.id,
    studentId: row.studentId,
    name: nameOf(student),
    username: student?.username ?? null,
    className: snapshotClass ?? classNameOf(student),
    direction,
    directionLabel: direction === "in" ? "Ko'chib keldi" : "Ko'chib ketdi",
    fromBranch: move.fromBranch,
    toBranch: move.toBranch,
    date: iso(date),
    month: monthKeyOfDate(date),
  };
};

/**
 * O'quvchining ketishdan KEYIN boshlangan davrlari — "qaytib kelganmi".
 * Xotirada quriladi: barcha davrlar allaqachon o'qilgan.
 */
const buildLaterStarts = (rows) => {
  const byStudent = new Map();

  for (const row of rows) {
    if (!byStudent.has(row.studentId)) byStudent.set(row.studentId, []);
    byStudent.get(row.studentId).push(row.startDate.getTime());
  }

  for (const starts of byStudent.values()) starts.sort((a, b) => a - b);

  return byStudent;
};

// ─────────────────────────────────────────────
// Ro'yxat bilan hisob o'rtasidagi farq
// ─────────────────────────────────────────────

/**
 * IKKI XIL "O'QUVCHILAR SONI" va ikkalasi ham to'g'ri:
 *   · `listed`   — bosh sahifadagi karta: arxivlanmagan LOGIN lar
 *                  (`user.service.js` → `getStats`)
 *   · `studying` — o'qish davri BUGUNNI qamragan o'quvchilar
 *
 * Farq bo'lsa, u ma'lumotdagi bo'shliqni bildiradi (davri yopilgan-u
 * arxivlanmagan yoki umuman davri yo'q o'quvchi — `education.md` §3).
 * Hisobot buni YOZIB qo'yadi: aks holda rahbar ikki ekranda ikki raqam
 * ko'rib, qaysi biriga ishonishni bilmay qolardi.
 *
 * ⚠️ IKKALA RAQAM HAM BUGUNGA tegishli va hisobot DAVRIGA bog'liq EMAS.
 * Shuning uchun u hisobot uchun o'qilgan qatorlardan hisoblanmaydi: ular
 * davrning yuqori chegarasi bilan kesilgan va sentabr hisobotida
 * oktabrda kelganlar "hozir o'qimayapti" bo'lib chiqardi — ya'ni bir xil
 * savolga tanlangan oyga qarab boshqa javob berilardi.
 */
const buildContext = async () => {
  const today = currentDayDate();

  const [students, open] = await Promise.all([
    prisma.user.findMany({
      where: { role: ROLES.STUDENT, isArchived: false },
      select: { id: true },
    }),
    prisma.studentEnrollment.findMany({
      where: {
        startDate: { lte: today },
        OR: [{ endDate: null }, { endDate: { gte: today } }],
      },
      select: { studentId: true },
    }),
  ]);

  const listedIds = new Set(students.map((s) => s.id));
  const studyingIds = new Set(
    open.map((row) => row.studentId).filter((id) => listedIds.has(id)),
  );

  return {
    listed: listedIds.size,
    studying: studyingIds.size,
    withoutOpenEnrollment: listedIds.size - studyingIds.size,
  };
};

// ─────────────────────────────────────────────
// Ommaviy yo'llar
// ─────────────────────────────────────────────

/**
 * TO'LIQ HISOBOT — ekran ham, Word fayli ham AYNI shu obyektdan quriladi.
 *
 * Ikkita quruvchi bo'lsa, ekrandagi foiz bilan fayldagi foiz asta-sekin
 * uzoqlashardi (`invoiceBuilder.service.js` doktrinasi: summa mantig'i
 * bitta joyda).
 *
 * @param {object} query - `month` | `year` | `from`+`to`
 */
const getMovementReport = async (query = {}) => {
  const range = resolveRange(query);
  const months = monthsBetween(range.from, range.to);

  const branch = getBranch();

  const [rows, transfers] = await Promise.all([
    loadEnrollments(range.to),
    loadBranchMoves(range.from, range.to, branch?.id),
  ]);

  const moves = buildMoveIndex(transfers, branch?.id);
  const firstStart = firstStartByStudent(rows);
  const laterStarts = buildLaterStarts(rows);

  // Oy → kelganlar / ketganlar / ko'chib kelganlar / ko'chib ketganlar
  // (bitta o'tishda)
  const joinedByMonth = new Map(months.map((m) => [m, []]));
  const leftByMonth = new Map(months.map((m) => [m, []]));
  const movedInByMonth = new Map(months.map((m) => [m, []]));
  const movedOutByMonth = new Map(months.map((m) => [m, []]));

  for (const row of rows) {
    const startMonth = monthKeyOfDate(row.startDate);
    if (joinedByMonth.has(startMonth)) {
      const moveIn = moves.isIn(row);
      (moveIn ? movedInByMonth : joinedByMonth).get(startMonth).push(
        moveIn ? { row, move: moveIn } : row,
      );
    }

    if (row.endDate) {
      const endMonth = monthKeyOfDate(row.endDate);
      if (leftByMonth.has(endMonth)) {
        const moveOut = moves.isOut(row);
        (moveOut ? movedOutByMonth : leftByMonth).get(endMonth).push(
          moveOut ? { row, move: moveOut } : row,
        );
      }
    }
  }

  // Oy chegaralari bir marta hisoblanadi: closeCount(M) === openCount(M+1)
  const openByMonth = new Map();
  for (const month of months) openByMonth.set(month, openCountAt(rows, month));
  const closeOfLast = openCountAt(rows, nextMonth(range.to));

  const closeOf = (month) =>
    month === range.to ? closeOfLast : openByMonth.get(nextMonth(month));

  const byMonth = months.map((month) => {
    const joined = joinedByMonth.get(month);
    const left = leftByMonth.get(month);

    return {
      month,
      label: formatMonthKey(month),
      shortLabel: formatMonthShort(month),
      isCurrent: month === currentMonthKey(),
      ...buildMetrics({
        movedIn: movedInByMonth.get(month),
        movedOut: movedOutByMonth.get(month),
        openCount: openByMonth.get(month),
        closeCount: closeOf(month),
        joined,
        left,
        firstStart,
      }),
      byReason: groupByReason(left),
    };
  });

  const joinedRows = months.flatMap((m) => joinedByMonth.get(m));
  const leftRows = months.flatMap((m) => leftByMonth.get(m));
  const movedInRows = months.flatMap((m) => movedInByMonth.get(m));
  const movedOutRows = months.flatMap((m) => movedOutByMonth.get(m));

  const totals = buildMetrics({
    openCount: openByMonth.get(range.from),
    closeCount: closeOfLast,
    joined: joinedRows,
    left: leftRows,
    movedIn: movedInRows,
    movedOut: movedOutRows,
    firstStart,
  });

  // ⚠️ KO'CHGANLAR HAM RO'YXATDA: ular "keldi/ketdi" dan chiqarilgani
  // bilan YO'QOLMAYDI, alohida bo'limda turadi. Aks holda jadvaldagi
  // "ko'chish: 12" degan raqamning orqasida kim borligini bilib
  // bo'lmasdi (`wipedByDiscount` sanoqchisi bilan AYNI mulohaza:
  // sanoqchining butun mohiyati — jim qolmaslik).
  const moveRows = [...movedInRows, ...movedOutRows];

  const studentIds = [
    ...new Set(
      [...joinedRows, ...leftRows, ...moveRows.map((m) => m.row)].map(
        (row) => row.studentId,
      ),
    ),
  ];

  const [studentById, classByKey, context] = await Promise.all([
    loadStudents(studentIds),
    loadDepartureClasses(
      [...leftRows, ...movedOutRows.map((m) => m.row)].map((row) => ({
        studentId: row.studentId,
        endDate: row.endDate,
      })),
    ),
    buildContext(),
  ]);

  const todayMs = currentDayDate().getTime();
  const serializeCtx = { studentById, classByKey, firstStart, laterStarts, todayMs };

  return {
    range: {
      ...range,
      fromLabel: formatMonthKey(range.from),
      toLabel: formatMonthKey(range.to),
      label:
        range.from === range.to
          ? formatMonthKey(range.from)
          : `${formatMonthKey(range.from)} — ${formatMonthKey(range.to)}`,
      // ⚠️ `monthCount`, `months` EMAS: umumiy ko'rinishda sonlar
      // QO'SHILADI va "months" kaliti davr belgisi deb tanilmasdi —
      // 10 oylik hisobot ikki filialda "20 oy" bo'lib ko'rinardi
      // (`aggregateMerge.helpers.js` → `KEEP_SEGMENTS`, `month` bo'lagi).
      monthCount: months.length,
    },
    branch: branch ? { id: branch.id, name: branch.name } : null,
    // ⚠️ Ikkala hisobot ham (bitta filial / butun tarmoq) AYNI shaklda
    // bo'ladi va ekran ham, Word quruvchisi ham shu BITTA bayroqqa qaraydi
    // (`studentMovementNetwork.service.js`). "Maydon yo'q bo'lsa demak
    // filialniki" degan jim shart ikkinchi renderda unutilardi.
    isNetwork: false,
    generatedAt: new Date(),
    totals,
    byMonth,
    byReason: groupByReason(leftRows),
    joinedStudents: joinedRows
      .map((row) => serializeJoined(row, serializeCtx))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    leftStudents: leftRows
      .map((row) => serializeLeft(row, serializeCtx))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    movedStudents: [
      ...movedInRows.map((entry) => serializeMoved(entry, "in", serializeCtx)),
      ...movedOutRows.map((entry) => serializeMoved(entry, "out", serializeCtx)),
    ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    context,
  };
};

/**
 * BOSH SAHIFA KARTASI — joriy oy va joriy yil o'zgarishi.
 *
 * ⚠️ FORMULA HISOBOT BILAN AYNI (`buildMetrics`): karta "+2,7%" deb
 * turib, hujjat boshqa foiz ko'rsatsa, kartaga ishonch yo'qolardi.
 *
 * ⚠️ Lekin HISOBOTNING O'ZI chaqirilmaydi: u o'quvchilar ro'yxatini ham
 * quradi (ism, sinf, hisob-faktura surati), karta esa faqat uchta raqamni
 * ko'rsatadi — bosh sahifa har ochilganda ortiqcha so'rov bo'lardi. Davrlar
 * BIR MARTA o'qilib, undan ikki oraliq (oy va yil) hisoblanadi.
 */
const getMovementSummary = async () => {
  const month = currentMonthKey();
  const year = Math.trunc(month / 100);
  const branch = getBranch();

  const [rows, transfers] = await Promise.all([
    loadEnrollments(month),
    // ⚠️ Ko'chish KARTADA ham chiqariladi: aks holda bosh sahifadagi
    // "+39 / −15" hujjatdagi raqamdan farq qilardi.
    loadBranchMoves(year * 100 + 1, month, branch?.id),
  ]);

  const moves = buildMoveIndex(transfers, branch?.id);
  const firstStart = firstStartByStudent(rows);

  // ⚠️ `monthKey` / `yearKey` — oddiy `key` EMAS: umumiy ko'rinishda
  // `key` davr belgisi deb tanilmay QO'SHILARDI (202610 + 202610 =
  // 405220). Kalit ichida "month"/"year" bo'lagi bo'lsa, birlashtiruvchi
  // uni tegmasdan qoldiradi (`aggregateMerge.helpers.js`).
  return {
    month: {
      monthKey: month,
      label: formatMonthKey(month),
      ...metricsFor(rows, month, month, firstStart, moves),
    },
    year: {
      yearKey: year,
      label: `${year}-yil`,
      ...metricsFor(rows, year * 100 + 1, month, firstStart, moves),
    },
  };
};

module.exports = {
  MAX_MONTHS,
  UNKNOWN_REASON,
  getMovementReport,
  getMovementSummary,
  // Bazasiz sinaladigan sof qismlar (`test/studentMovement.test.js`).
  // Fayl boshidagi CHEGARA TA'RIFI shu testlar bilan qo'riqlanadi: u
  // buzilsa, hisobotdagi "farq" ustuni jimgina bir birlikka og'ib ketardi.
  openCountAt,
  collectRange,
  buildMoveIndex,
  buildMetrics,
  combineMetrics,
  combineReasons,
  metricsFor,
  groupByReason,
  firstStartByStudent,
  resolveRange,
};
