/**
 * TANGA CHEKLOVI — QARZDOR O'QUVCHIGA TANGA BERILMAYDI (`StudentCoinBlock`).
 *
 * Biznes qarori (2026-11-04): oylik to'lovini to'lamagan o'quvchi tanga
 * olmaydi. Cheklov qo'yilgan o'quvchiga tanga HECH QAYERDAN tushmaydi:
 *
 *   · kunlik baho uchun avtomat tanga (`distributeDailyCoins`) — ya'ni
 *     o'qituvchi baho qo'ysa ham tanga yozilmaydi;
 *   · haftalik reyting bonusi (`distributeWeeklyBonusCoins`);
 *   · test mavsumi mukofoti (`seasonReward.service.js`);
 *   · qo'lda tanga berish (`distributeManualCoins`, admin paneldagi
 *     "Tanga taqsimlash" va AI yordamchisining o'sha amali).
 *
 * ⚠️ DARVOZA BITTA JOYDA va u SHU FAYL. Har bir tanga yozadigan yo'l
 * `getBlockedStudentIds()` / `assertCoinsAllowed()` dan o'tadi. Ikkita
 * nusxa bo'lsa, keyin qo'shilgan yo'l (masalan yangi mukofot turi) jimgina
 * cheklovni chetlab o'tardi — "hech qayerda berib bo'lmaydi" kafolati esa
 * aynan shunda yo'qoladi.
 *
 * ⚠️ TANGA SARFLASH VA QAYTARIM CHEKLANMAYDI. Market buyurtmasi bekor
 * qilinganda pul o'quvchining O'ZIGA qaytadi (`market_refund`) — bu yangi
 * tanga emas, allaqachon sarflangan tanganing qaytishi. Uni to'sish
 * o'quvchidan tangasini tortib olish bo'lardi, holbuki cheklov "yangi tanga
 * yozilmaydi" degani. Premium/jarima paketi xaridi ham tegilmaydi: cheklov
 * tangani muzlatmaydi, faqat yangisini bermaydi.
 *
 * ⚠️ QO'LDA QO'YILADI, QO'LDA OLINADI. Qarzdorlar registri faqat TANLOV
 * ro'yxatini beradi; cheklash va ochish — odamning qarori (`coins.block`,
 * owner'da doim bor). Avtomat qo'yilsa bir kunlik kechikish ham bolani
 * tangadan mahrum qilardi; avtomat olinsa "qarzini to'ladi, lekin cheklov
 * sababi boshqa" degan holat boshqarilmay qolardi. Registr har qator yonida
 * JORIY qarzni ko'rsatadi (`debtNow`) va qarzi yo'qolganini alohida
 * belgilaydi (`debtCleared`) — kimni ochish kerakligi shundan ko'rinadi.
 *
 * ⚠️ BU KECHIKTIRISH EMAS: cheklov davridagi tangalar keyin ham berilmaydi.
 * Kunlik pass har kun uchun bir marta ishlaydi; o'tkazib yuborilgan kun
 * qaytarilmaydi. Aynan shu sababli darvoza VAQTGA bog'liq tekshiradi
 * (`at`): kunlik pass o'tgan kun uchun qayta ishlasa (`coinDaily.job.js`
 * dagi startup recovery — kechagi kun), cheklov O'SHA KUNI amalda bo'lgani
 * bo'yicha hal qilinadi, bugungi holat bo'yicha emas. Busiz cheklovni
 * bugun olib tashlash server qayta ishga tushganda kechagi tangani
 * qaytarib berardi.
 *
 * ⚠️ O'CHIRILMAYDI — BEKOR QILINADI (sabab + aktyor): "nega bu bola uch
 * hafta tanga olmadi" degan savolga javob registrda qoladi.
 */

const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const { ROLES } = require("../utils/constants");
const { BadRequestError, ConflictError, NotFoundError } = require("../utils/errors");
const { generateId } = require("../utils/idGenerator");
const { Decimal, formatAmount, formatSum } = require("../helpers/money.helpers");
const { formatMonthKey } = require("../helpers/month.helpers");
const { formatDateUz, formatDateTimeUz } = require("../helpers/date.helpers");
const { formatPaginationResponse } = require("../utils/pagination");

const REASON_MAX = 300;
const NOTE_MAX = 500;
/** Bir amalda ko'pi bilan — butun maktab bitta tanlovga sig'adi. */
const MAX_STUDENTS = 500;
const STATUSES = ["active", "revoked"];
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

/**
 * QARZ MANBAI — qarzdorlar registri bilan AYNI
 * (`invoice.service.js` → `getDebtors`, `debtReminder.service.js`):
 * ochiq (`unpaid` / `partial`) hisob-fakturalar va `amount − paidAmount > 0`.
 * Bekor qilingan oy qarz emas, to'liq to'langani ham.
 */
const OPEN_INVOICE_STATUSES = ["unpaid", "partial"];

const fullNameOf = (user) =>
  user ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || "Noma'lum" : "Noma'lum";

const classNameOf = (user) =>
  (user?.classes || [])
    .map((uc) => uc.class?.name)
    .filter(Boolean)
    .join(", ");

/* ───────────────────────── Kirish tekshiruvlari ───────────────────────── */

/** Sabab — MAJBURIY: cheklov o'quvchiga ta'sir qiladi va "nega" so'raladi. */
const parseReason = (value, label = "Sabab") => {
  const reason = typeof value === "string" ? value.trim() : "";
  if (!reason) throw new BadRequestError(`${label} majburiy`);
  if (reason.length > REASON_MAX) {
    throw new BadRequestError(`${label} ${REASON_MAX} belgidan oshmasin`);
  }
  return reason;
};

const parseNote = (value) => {
  const note = typeof value === "string" ? value.trim() : "";
  if (note.length > NOTE_MAX) {
    throw new BadRequestError(`Izoh ${NOTE_MAX} belgidan oshmasin`);
  }
  return note;
};

/**
 * O'quvchilar ro'yxati — takrorlar olib tashlanadi, shakl tekshiriladi.
 * BIR NECHTA O'QUVCHI BIRDANIGA: "bittalab emas" talabi shu yerda.
 */
const parseStudentIds = (value, label = "O'quvchilar") => {
  const list = Array.isArray(value) ? value : [value];
  const ids = [...new Set(list.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean))];

  if (ids.length === 0) throw new BadRequestError(`${label} tanlanmadi`);
  if (ids.length > MAX_STUDENTS) {
    throw new BadRequestError(`Bir amalda ${MAX_STUDENTS} tagacha o'quvchi tanlanadi`);
  }
  for (const id of ids) {
    if (!OBJECT_ID_RE.test(id)) throw new BadRequestError("O'quvchi identifikatori yaroqsiz");
  }
  return ids;
};

/* ──────────────────────────── QARZ O'QISH ──────────────────────────── */

/**
 * Tanlangan o'quvchilarning OCHIQ qarzi — qarzdorlar registri bilan
 * AYNI manbadan. Qarzi nolga teng o'quvchi natijaga KIRMAYDI.
 *
 * @param {string[]} studentIds
 * @returns {Promise<Map<string, { debt: import("decimal.js").Decimal, monthCount: number, oldestMonth: number }>>}
 */
async function getOpenDebtByStudents(studentIds) {
  const result = new Map();
  if (!studentIds?.length) return result;

  const grouped = await prisma.monthlyInvoice.groupBy({
    by: ["studentId"],
    where: { studentId: { in: studentIds }, status: { in: OPEN_INVOICE_STATUSES } },
    _sum: { amount: true, paidAmount: true },
    _min: { month: true },
    _count: { _all: true },
  });

  for (const row of grouped) {
    const debt = new Decimal(row._sum.amount ?? 0).minus(row._sum.paidAmount ?? 0);
    if (debt.lessThanOrEqualTo(0)) continue;
    result.set(row.studentId, {
      debt,
      monthCount: row._count._all,
      oldestMonth: row._min.month,
    });
  }

  return result;
}

/* ───────────────────────────── DARVOZA ───────────────────────────── */

/**
 * CHEKLANGAN O'QUVCHILAR — tanga yozadigan HAR BIR yo'l shu yerdan o'tadi.
 *
 * Cheklov `at` paytida amalda bo'lgan bo'lsa hisobga olinadi:
 * `createdAt <= at` va (hali bekor qilinmagan YOKI `revokedAt > at`).
 * Shu sababli o'tgan kun uchun qayta ishlangan kunlik pass o'sha kundagi
 * holatni ko'radi (yuqoridagi izoh).
 *
 * @param {string[]} [studentIds] - tekshirilayotganlar; berilmasa barcha cheklovlar
 * @param {{ at?: Date }} [options] - qaysi paytdagi holat (sukut: hozir)
 * @returns {Promise<Set<string>>} cheklangan o'quvchilar id'lari
 */
async function getBlockedStudentIds(studentIds, { at } = {}) {
  if (studentIds && studentIds.length === 0) return new Set();

  const moment = at instanceof Date ? at : new Date();

  const rows = await prisma.studentCoinBlock.findMany({
    where: {
      ...(studentIds ? { studentId: { in: studentIds } } : {}),
      createdAt: { lte: moment },
      OR: [{ revokedAt: null }, { revokedAt: { gt: moment } }],
    },
    select: { studentId: true },
    distinct: ["studentId"],
  });

  return new Set(rows.map((r) => r.studentId));
}

/**
 * BITTA O'QUVCHI uchun darvoza — aniq nishonli amallar uchun (jim
 * o'tkazib yuborish emas, OCHIQ xato: kassir/admin nega bo'lmaganini
 * bilishi kerak).
 *
 * @param {string} studentId
 * @param {{ at?: Date }} [options]
 * @throws {ConflictError} cheklov bo'lsa
 */
async function assertCoinsAllowed(studentId, { at } = {}) {
  const block = await getActiveBlock(studentId, { at });
  if (!block) return;

  throw new ConflictError(
    `Bu o'quvchiga tanga berish taqiqlangan (${block.reason}). ` +
      "Avval cheklov olib tashlanishi kerak: Tangalar → Tanga cheklovi.",
    { reason: "coin_blocked", blockId: block.id, blockReason: block.reason },
  );
}

/**
 * O'quvchining `at` paytidagi faol cheklovi (bo'lmasa `null`).
 *
 * @param {string} studentId
 * @param {{ at?: Date }} [options]
 */
async function getActiveBlock(studentId, { at } = {}) {
  if (!studentId) return null;
  const moment = at instanceof Date ? at : new Date();

  return prisma.studentCoinBlock.findFirst({
    where: {
      studentId,
      createdAt: { lte: moment },
      OR: [{ revokedAt: null }, { revokedAt: { gt: moment } }],
    },
    orderBy: { createdAt: "desc" },
  });
}

/* ──────────────────────────── CHEKLASH ──────────────────────────── */

/**
 * BIR NECHTA O'QUVCHINI BIR AMALDA CHEKLASH.
 *
 * Har o'quvchiga ALOHIDA QATOR (`PayrollDeduction` doktrinasi): registr,
 * bekor qilish va o'quvchining o'z ekrani qator bilan ishlaydi. Bitta
 * amalda yozilganlar `batchId` bilan guruhlanadi.
 *
 * ⚠️ ALLAQACHON CHEKLANGANIGA TEGILMAYDI — u `skipped` da qaytadi, xato
 * sifatida emas: ro'yxatni ikki marta yuborish (yoki eskirgan ekran)
 * tarixga ma'nosiz ikkinchi qator qo'shmasligi kerak. Yozuv qulf ichida
 * qayta tekshiriladi va `active_key` unique indeksi poygani
 * STRUKTURAVIY imkonsiz qiladi.
 *
 * ⚠️ FAQAT O'QUVCHI cheklanadi: xodimda tanga balansi ham, hisob-faktura
 * ham boshqa ma'noga ega.
 *
 * @param {object} params
 * @param {string[]} params.studentIds
 * @param {string} params.reason - MAJBURIY
 * @param {string} [params.note]
 * @param {string} params.createdBy
 */
async function blockStudents({ studentIds, reason, note, createdBy }) {
  const ids = parseStudentIds(studentIds);
  const parsedReason = parseReason(reason);
  const parsedNote = parseNote(note);

  const students = await prisma.user.findMany({
    where: { id: { in: ids }, role: ROLES.STUDENT },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      username: true,
      isArchived: true,
      classes: { select: { class: { select: { id: true, name: true } } } },
    },
  });

  const studentMap = new Map(students.map((s) => [s.id, s]));
  // Birorta o'quvchi topilmasa — bu so'rovning xatosi (eskirgan ekran yoki
  // xodim tanlangan), har qatorni `failed` ga yozib "bajarildi" demaslik kerak
  if (studentMap.size === 0) {
    throw new BadRequestError("Tanlangan o'quvchilar topilmadi");
  }

  const debts = await getOpenDebtByStudents([...studentMap.keys()]);
  const batchId = generateId();

  const created = [];
  const skipped = [];
  const failed = [];

  // Har o'quvchi ALOHIDA tranzaksiyada: bittasi yiqilsa qolganlari baribir
  // yoziladi (`applyDefaultToAll` / `cancelMonth` doktrinasi).
  for (const id of ids) {
    const student = studentMap.get(id);
    if (!student) {
      // Xodim yoki o'chirilgan foydalanuvchi: faqat o'quvchi cheklanadi
      failed.push({ studentId: id, reason: "Faqat o'quvchi cheklanadi" });
      continue;
    }

    const debt = debts.get(id);

    try {
      const row = await prisma.$transaction(async (tx) => {
        // Qulf o'quvchi bo'yicha: ayni o'quvchini cheklash va ochish
        // parallel kelganda ketma-ket bajariladi.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`coin_block:${id}`}))`;

        const existing = await tx.studentCoinBlock.findFirst({
          where: { studentId: id, revokedAt: null },
          select: { id: true },
        });
        if (existing) return null;

        return tx.studentCoinBlock.create({
          data: {
            studentId: id,
            batchId,
            activeKey: id,
            reason: parsedReason,
            note: parsedNote,
            debtSnapshot: debt ? debt.debt : new Decimal(0),
            debtMonthCount: debt ? debt.monthCount : 0,
            oldestDebtMonth: debt ? debt.oldestMonth : null,
            snapshot: {
              fullName: fullNameOf(student),
              username: student.username ?? "",
              className: classNameOf(student),
            },
            createdBy,
          },
        });
      });

      if (row) created.push(row);
      else skipped.push({ studentId: id, fullName: fullNameOf(student), reason: "Allaqachon cheklangan" });
    } catch (err) {
      // Unique indeks poygada ushlagan bo'lsa — bu ham "allaqachon cheklangan"
      if (err?.code === "P2002") {
        skipped.push({ studentId: id, fullName: fullNameOf(student), reason: "Allaqachon cheklangan" });
        continue;
      }
      logger.error(`[CoinBlock] block xatosi (student=${id}): ${err.message}`);
      failed.push({ studentId: id, fullName: fullNameOf(student), reason: err.message });
    }
  }

  const blockedDebt = created.reduce(
    (sum, row) => sum.plus(new Decimal(row.debtSnapshot ?? 0)),
    new Decimal(0),
  );

  logger.info(
    `[CoinBlock] ${created.length} ta o'quvchiga tanga cheklovi qo'yildi ` +
      `(o'tkazildi: ${skipped.length}, xato: ${failed.length}, batch=${batchId})`,
  );

  return {
    batchId,
    blockedCount: created.length,
    skippedCount: skipped.length,
    failedCount: failed.length,
    totalDebt: formatAmount(blockedDebt),
    blocked: created.map((row) => ({
      id: row.id,
      studentId: row.studentId,
      fullName: row.snapshot?.fullName ?? "",
      debt: formatAmount(new Decimal(row.debtSnapshot ?? 0)),
    })),
    skipped,
    failed,
  };
}

/* ────────────────────────────── OCHISH ────────────────────────────── */

/**
 * CHEKLOVNI OLIB TASHLASH (bir nechta o'quvchi birdaniga).
 *
 * Qator O'CHIRILMAYDI — bekor qilinadi: sabab, aktyor va vaqt yoziladi,
 * `activeKey` NULL ga tushadi (ya'ni keyin yana cheklash mumkin).
 * Ochilgandan keyin tanga ODATDAGIDEK yozila boshlaydi, lekin cheklov
 * davridagi tangalar QAYTARILMAYDI (yuqoridagi izoh).
 *
 * @param {object} params
 * @param {string[]} [params.studentIds] - o'quvchi bo'yicha (ro'yxatdagi tanlov)
 * @param {string[]} [params.blockIds] - aniq qator bo'yicha
 * @param {string} params.reason - MAJBURIY ("qarzini to'ladi")
 * @param {string} params.revokedBy
 */
async function unblockStudents({ studentIds, blockIds, reason, revokedBy }) {
  const parsedReason = parseReason(reason, "Ochish sababi");

  let ids = null;
  if (blockIds !== undefined && blockIds !== null) {
    ids = parseStudentIds(blockIds, "Cheklov qatorlari");
  }
  let students = null;
  if (studentIds !== undefined && studentIds !== null) {
    students = parseStudentIds(studentIds);
  }
  if (!ids && !students) throw new BadRequestError("O'quvchilar tanlanmadi");

  const rows = await prisma.studentCoinBlock.findMany({
    where: {
      revokedAt: null,
      ...(ids ? { id: { in: ids } } : {}),
      ...(students ? { studentId: { in: students } } : {}),
    },
    select: { id: true, studentId: true, snapshot: true },
  });

  if (rows.length === 0) {
    throw new NotFoundError("Ochiladigan faol cheklov topilmadi");
  }

  const revokedAt = new Date();
  const unblocked = [];
  const failed = [];

  for (const row of rows) {
    try {
      // Compare-and-swap: oraliqda boshqa odam ochib qo'ygan bo'lsa
      // ikkinchi yozuv o'tmaydi va aktyor/sabab birinchisining nomida qoladi.
      const result = await prisma.studentCoinBlock.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { activeKey: null, revokedAt, revokedBy, revokeReason: parsedReason },
      });
      if (result.count === 1) {
        unblocked.push({
          id: row.id,
          studentId: row.studentId,
          fullName: row.snapshot?.fullName ?? "",
        });
      } else {
        failed.push({
          studentId: row.studentId,
          fullName: row.snapshot?.fullName ?? "",
          reason: "Cheklov allaqachon olib tashlangan",
        });
      }
    } catch (err) {
      logger.error(`[CoinBlock] unblock xatosi (block=${row.id}): ${err.message}`);
      failed.push({
        studentId: row.studentId,
        fullName: row.snapshot?.fullName ?? "",
        reason: err.message,
      });
    }
  }

  logger.info(
    `[CoinBlock] ${unblocked.length} ta o'quvchining tanga cheklovi olib tashlandi ` +
      `(xato: ${failed.length})`,
  );

  return {
    unblockedCount: unblocked.length,
    failedCount: failed.length,
    unblocked,
    failed,
  };
}

/* ───────────────────────────── REGISTR ───────────────────────────── */

/**
 * Qator → panel ko'rinishi. JORIY qarz (`debtNow`) har safar qayta
 * o'qiladi: cheklash paytidagi muhrlangan summa tushuntirish uchun,
 * "kimni ochish kerak" degan savolga esa faqat joriy qarz javob beradi.
 */
const toRegistryRow = (row, { student, debtNow }) => {
  const snapshotDebt = new Decimal(row.debtSnapshot ?? 0);
  const current = debtNow ? debtNow.debt : new Decimal(0);
  const isActive = row.revokedAt == null;

  return {
    id: row.id,
    studentId: row.studentId,
    status: isActive ? "active" : "revoked",
    // Ism joriy profildan, bo'lmasa muhrdan (o'quvchi butunlay o'chirilgan hol)
    fullName: student ? fullNameOf(student) : row.snapshot?.fullName ?? "Noma'lum",
    username: student?.username ?? row.snapshot?.username ?? "",
    className: student ? classNameOf(student) : row.snapshot?.className ?? "",
    isArchived: student?.isArchived ?? false,
    coinBalance: student?.coinBalance ?? 0,

    reason: row.reason,
    note: row.note,

    debtAtBlock: formatAmount(snapshotDebt),
    debtAtBlockLabel: formatSum(snapshotDebt),
    debtMonthCount: row.debtMonthCount,
    oldestDebtMonth: row.oldestDebtMonth,
    oldestDebtMonthLabel: row.oldestDebtMonth ? formatMonthKey(row.oldestDebtMonth) : null,

    debtNow: formatAmount(current),
    debtNowLabel: formatSum(current),
    debtNowMonthCount: debtNow ? debtNow.monthCount : 0,
    // ⚠️ FAQAT FAOL cheklovda ma'noli: qarzi yopilgan o'quvchi ro'yxatda
    // alohida belgilanadi — tanga cheklovi "esdan chiqib" qolmasin.
    debtCleared: isActive && current.lessThanOrEqualTo(0),

    createdBy: row.createdBy,
    createdAt: row.createdAt,
    createdAtLabel: formatDateTimeUz(row.createdAt),
    revokedAt: row.revokedAt,
    revokedAtLabel: row.revokedAt ? formatDateTimeUz(row.revokedAt) : null,
    revokedBy: row.revokedBy,
    revokeReason: row.revokeReason,
    batchId: row.batchId,
  };
};

/**
 * CHEKLOVLAR REGISTRI — faol ro'yxat va tarix bitta yo'ldan.
 *
 * @param {object} req - Express request (`query`: status, search, classId, page, limit)
 */
async function listBlocks(req) {
  const { query } = req;
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
  const skip = (page - 1) * limit;

  const status = STATUSES.includes(query.status) ? query.status : "active";
  const search = query.search?.trim();
  const classId = query.classId?.trim();

  // Qidiruv/sinf filtri — avval o'quvchilar aniqlanadi (`getDebtors` naqshi)
  let studentFilter = null;
  if (search || classId) {
    const matched = await prisma.user.findMany({
      where: {
        role: ROLES.STUDENT,
        ...(classId ? { classes: { some: { classId } } } : {}),
        ...(search
          ? {
              OR: [
                { firstName: { contains: search, mode: "insensitive" } },
                { lastName: { contains: search, mode: "insensitive" } },
                { username: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      select: { id: true },
    });
    studentFilter = matched.map((s) => s.id);
    if (studentFilter.length === 0) {
      return formatPaginationResponse([], 0, page, limit);
    }
  }

  const where = {
    ...(status === "active" ? { revokedAt: null } : { revokedAt: { not: null } }),
    ...(studentFilter ? { studentId: { in: studentFilter } } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.studentCoinBlock.findMany({
      where,
      orderBy: status === "active" ? { createdAt: "desc" } : { revokedAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.studentCoinBlock.count({ where }),
  ]);

  if (rows.length === 0) return formatPaginationResponse([], total, page, limit);

  const ids = [...new Set(rows.map((r) => r.studentId))];
  const [students, debts] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        username: true,
        isArchived: true,
        coinBalance: true,
        classes: { select: { class: { select: { id: true, name: true } } } },
      },
    }),
    getOpenDebtByStudents(ids),
  ]);

  const studentMap = new Map(students.map((s) => [s.id, s]));
  const data = rows.map((row) =>
    toRegistryRow(row, { student: studentMap.get(row.studentId), debtNow: debts.get(row.studentId) }),
  );

  return formatPaginationResponse(data, total, page, limit);
}

/**
 * KARTALAR: nechta o'quvchi cheklangan, jami qancha qarz, qanchasining
 * qarzi allaqachon yopilgan (ya'ni ochish kutib turgan).
 */
async function getBlockSummary() {
  const active = await prisma.studentCoinBlock.findMany({
    where: { revokedAt: null },
    select: { studentId: true, debtSnapshot: true },
  });

  if (active.length === 0) {
    return {
      blockedCount: 0,
      debtNow: formatAmount(new Decimal(0)),
      debtNowLabel: formatSum(new Decimal(0)),
      debtAtBlock: formatAmount(new Decimal(0)),
      clearedCount: 0,
    };
  }

  const ids = active.map((r) => r.studentId);
  const debts = await getOpenDebtByStudents(ids);

  let debtNow = new Decimal(0);
  let clearedCount = 0;
  for (const id of ids) {
    const row = debts.get(id);
    if (row) debtNow = debtNow.plus(row.debt);
    else clearedCount += 1;
  }

  const debtAtBlock = active.reduce(
    (sum, r) => sum.plus(new Decimal(r.debtSnapshot ?? 0)),
    new Decimal(0),
  );

  return {
    blockedCount: active.length,
    debtNow: formatAmount(debtNow),
    debtNowLabel: formatSum(debtNow),
    debtAtBlock: formatAmount(debtAtBlock),
    // Qarzi yopilgani — "ochish kutib turganlar"
    clearedCount,
  };
}

/**
 * CHEKLASH UCHUN TANLOV RO'YXATI — sukut bo'yicha QARZDORLAR.
 *
 * Panel bu ro'yxatdan bir nechta o'quvchini belgilaydi ("Hammasini
 * belgilash" ham). Allaqachon cheklanganlar ro'yxatda `isBlocked` bilan
 * keladi va belgilanmaydi — ikki marta cheklash ma'nosiz.
 *
 * ⚠️ ARXIVLANGAN O'QUVCHI CHIQARILMAYDI (moliya istisnosi,
 * `education.md` §4): qarz arxivlash bilan yo'qolmaydi, demak cheklov ham
 * ma'noli bo'lib qolaveradi.
 *
 * @param {object} req - `query`: debtorsOnly ("false" — hammasi), search, classId, page, limit
 */
async function getBlockCandidates(req) {
  const { query } = req;
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
  const debtorsOnly = query.debtorsOnly !== "false";
  const search = query.search?.trim();
  const classId = query.classId?.trim();

  const studentWhere = {
    role: ROLES.STUDENT,
    ...(classId ? { classes: { some: { classId } } } : {}),
    ...(search
      ? {
          OR: [
            { firstName: { contains: search, mode: "insensitive" } },
            { lastName: { contains: search, mode: "insensitive" } },
            { username: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  if (debtorsOnly) {
    // ⚠️ QARZDAN BOSHLANADI, o'quvchilar ro'yxatidan EMAS (`getDebtors`
    // naqshi): butun maktabni o'qib keyin filtrlash har bosishda minglab
    // qator ko'targan bo'lardi. Qidiruv yoki sinf berilganda esa avval
    // o'quvchilar toraytiriladi — qarzdorlar registridagi AYNI tartib.
    let studentFilter = null;
    if (search || classId) {
      const matched = await prisma.user.findMany({ where: studentWhere, select: { id: true } });
      studentFilter = matched.map((s) => s.id);
      if (studentFilter.length === 0) return formatPaginationResponse([], 0, page, limit);
    }

    const grouped = await prisma.monthlyInvoice.groupBy({
      by: ["studentId"],
      where: {
        status: { in: OPEN_INVOICE_STATUSES },
        ...(studentFilter ? { studentId: { in: studentFilter } } : {}),
      },
      _sum: { amount: true, paidAmount: true },
      _min: { month: true },
      _count: { _all: true },
    });

    const withDebt = grouped
      .map((row) => ({
        studentId: row.studentId,
        debt: new Decimal(row._sum.amount ?? 0).minus(row._sum.paidAmount ?? 0),
        monthCount: row._count._all,
        oldestMonth: row._min.month,
      }))
      // Bekor qilingan / tuzatilgan oyda ayirma nolga tushishi mumkin
      .filter((row) => row.debt.greaterThan(0))
      .sort((a, b) => b.debt.comparedTo(a.debt) || a.oldestMonth - b.oldestMonth);

    const total = withDebt.length;
    const pageRows = withDebt.slice((page - 1) * limit, (page - 1) * limit + limit);
    if (pageRows.length === 0) return formatPaginationResponse([], total, page, limit);

    const ids = pageRows.map((r) => r.studentId);
    const [students, blocked] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: ids }, role: ROLES.STUDENT },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          username: true,
          coinBalance: true,
          isArchived: true,
          classes: { select: { class: { select: { id: true, name: true } } } },
        },
      }),
      getBlockedStudentIds(ids),
    ]);

    const studentMap = new Map(students.map((s) => [s.id, s]));

    return formatPaginationResponse(
      pageRows
        // Qarzi bor, lekin o'quvchi emas — chetda qoladi
        .filter((row) => studentMap.has(row.studentId))
        .map((row) => {
          const student = studentMap.get(row.studentId);
          return {
            studentId: student.id,
            fullName: fullNameOf(student),
            username: student.username ?? "",
            className: classNameOf(student),
            isArchived: student.isArchived,
            coinBalance: student.coinBalance ?? 0,
            debt: formatAmount(row.debt),
            debtLabel: formatSum(row.debt),
            debtMonthCount: row.monthCount,
            oldestMonth: row.oldestMonth,
            oldestMonthLabel: formatMonthKey(row.oldestMonth),
            isBlocked: blocked.has(student.id),
          };
        }),
      total,
      page,
      limit,
    );
  }

  // Qarzi yo'q o'quvchini ham cheklash mumkin (sabab boshqa bo'lishi mumkin),
  // lekin bu ONGLI tanlov: panel "faqat qarzdorlar" belgisini oldin so'raydi.
  const [students, total] = await Promise.all([
    prisma.user.findMany({
      where: studentWhere,
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        username: true,
        coinBalance: true,
        isArchived: true,
        classes: { select: { class: { select: { id: true, name: true } } } },
      },
    }),
    prisma.user.count({ where: studentWhere }),
  ]);

  const ids = students.map((s) => s.id);
  const [debts, blocked] = await Promise.all([
    getOpenDebtByStudents(ids),
    getBlockedStudentIds(ids),
  ]);

  return formatPaginationResponse(
    students.map((student) => {
      const debt = debts.get(student.id);
      return {
        studentId: student.id,
        fullName: fullNameOf(student),
        username: student.username ?? "",
        className: classNameOf(student),
        isArchived: student.isArchived,
        coinBalance: student.coinBalance ?? 0,
        debt: formatAmount(debt ? debt.debt : new Decimal(0)),
        debtLabel: formatSum(debt ? debt.debt : new Decimal(0)),
        debtMonthCount: debt ? debt.monthCount : 0,
        oldestMonth: debt ? debt.oldestMonth : null,
        oldestMonthLabel: debt ? formatMonthKey(debt.oldestMonth) : null,
        isBlocked: blocked.has(student.id),
      };
    }),
    total,
    page,
    limit,
  );
}

/**
 * O'QUVCHI O'ZI KO'RADI — nima uchun va qachondan (ruxsat kaliti yo'q, id
 * tokendan). Cheklov YASHIRIN EMAS: tangasi to'xtagan o'quvchi sababini
 * ekranda ko'rishi kerak, aks holda u buni tizim nosozligi deb o'ylardi
 * (`devices.md` §0.1 va oylik ushlab qolishdagi AYNI mulohaza).
 *
 * @param {string} studentId
 */
async function getMyBlock(studentId) {
  const block = await getActiveBlock(studentId);
  if (!block) return { isBlocked: false };

  return {
    isBlocked: true,
    reason: block.reason,
    note: block.note,
    since: block.createdAt,
    sinceLabel: formatDateUz(block.createdAt),
    debtAtBlock: formatAmount(new Decimal(block.debtSnapshot ?? 0)),
    debtAtBlockLabel: formatSum(new Decimal(block.debtSnapshot ?? 0)),
    oldestDebtMonthLabel: block.oldestDebtMonth ? formatMonthKey(block.oldestDebtMonth) : null,
  };
}

module.exports = {
  // darvoza
  getBlockedStudentIds,
  assertCoinsAllowed,
  getActiveBlock,
  // qarz manbai (registr va nomzodlar bilan AYNI)
  getOpenDebtByStudents,
  OPEN_INVOICE_STATUSES,
  // amallar
  blockStudents,
  unblockStudents,
  // o'qish
  listBlocks,
  getBlockSummary,
  getBlockCandidates,
  getMyBlock,
  MAX_STUDENTS,
};
