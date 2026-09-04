/**
 * JIHOZLARNI O'TKAZISH — TOPSHIRISH-QABUL QILISH AKTI.
 *
 * `accountTransfer.service.js` ning aynan ko'zgusi: u yerda pul bir
 * kassadan ikkinchisiga, bu yerda jihoz bir xonadan ikkinchisiga o'tadi.
 *
 * ── NIMA UCHUN HUJJAT, IKKITA DAFTAR QATORI EMAS ──
 *
 * O'tkazma miqdor daftarida allaqachon ifodalanardi: `transfer_out` va
 * `transfer_in` juftligi. Lekin daftar qatori faqat MIQDORNI biladi va
 * bu uchta savolni javobsiz qoldirardi:
 *
 *   1) "Bir aktda nima ko'chirilgan?" — 10 ta parta va 20 ta stul bitta
 *      hodisa, lekin daftarda to'rtta bog'lanmagan qator bo'lib turardi.
 *   2) "KIMGA topshirilgan?" — daftarda odam degan tushuncha yo'q.
 *   3) "Nima uchun?" — izoh har bir qatorda alohida takrorlanardi.
 *
 * Shuning uchun hujjat: `AccountEntry` ustiga `AccountTransfer` qo'yilgani
 * bilan bir xil qaror. Daftar HAQIQAT manbai bo'lib qoladi (miqdor faqat
 * `postMovement` orqali o'zgaradi), hujjat esa uning KONTEKSTI.
 *
 * ⚠️ DEADLOCK. transfer(A→B) va transfer(B→A) bir vaqtda kelsa, har biri
 * o'z manbasini lock qilib ikkinchisining manzilini kutardi. Shuning uchun
 * xatlov qatorlari HAR DOIM `id` bo'yicha O'SISH tartibida lock qilinadi —
 * yo'nalishdan va satrlar tartibidan qat'i nazar.
 *
 * ⚠️ BEKOR QILISH YO'Q va bu ATAYLAB. `AccountTransfer` da u bor, chunki
 * u yerda pul qoldig'i bekor qilish bilan tiklanadi. Bu yerda esa daftar
 * append-only: xato o'tkazmani "bekor qilish" baribir ikkita yangi qator
 * yozardi, ya'ni tugma faqat asl aktni ko'rinmas qilardi. To'g'ri yo'l —
 * TESKARI o'tkazma, izohida sababi bilan (`adjustStock` da sabab majburiy
 * bo'lgani bilan bir xil mulohaza).
 */

const prisma = require("../config/prisma");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const logger = require("../utils/logger");
const { ROLES } = require("../utils/constants");
const { parseQuantity, locationSnapshotOf } = require("../helpers/inventory.helpers");
const { assertActiveItem } = require("./inventoryItem.service");
const {
  assertActiveLocation,
  RESPONSIBLE_SELECT,
} = require("./inventoryLocation.service");
const {
  TX_OPTIONS,
  postMovement,
  ensureStock,
  parseOccurredAt,
} = require("./inventoryStock.service");

// Bitta aktda ko'chiriladigan jihoz turlari soni. Chegara bo'lmasa
// tranzaksiya ichidagi lock'lar soni cheksiz o'sib, `TX_OPTIONS.timeout`
// ga tegib ketardi (`addStock` bilan bir xil mulohaza).
const MAX_TRANSFER_LINES = 100;

const serializeTransfer = (row, { lines, person } = {}) => {
  const { fromLocation, toLocation, lines: included, ...rest } = row;

  const rows = lines ?? included;

  return {
    ...rest,
    fromLocationName: fromLocation?.name ?? row.fromSnapshot?.name ?? "Noma'lum",
    toLocationName: toLocation?.name ?? row.toSnapshot?.name ?? "Noma'lum",
    // Xodim arxivlansa ham akt o'z matnini saqlaydi — surat birinchi
    // navbatda emas, JORIY yozuv birinchi (`displayNameOf` bilan bir xil
    // tartib: joriy nom to'g'riroq, surat esa zaxira)
    toPersonName: row.toPersonId
      ? person
        ? `${person.firstName} ${person.lastName ?? ""}`.trim()
        : `${row.personSnapshot?.firstName ?? ""} ${row.personSnapshot?.lastName ?? ""}`.trim() ||
          "Noma'lum"
      : null,
    toPerson: person ?? null,
    ...(rows ? { lines: rows.map(serializeTransferLine) } : {}),
  };
};

const serializeTransferLine = (row) => ({
  ...row,
  // Yaroqli qismi — HOSILA (`InventoryStock.serviceableQuantity` bilan
  // bir xil qaror: ustun emas, hisoblanadi)
  serviceableQuantity: row.quantity - row.brokenQuantity,
});

/**
 * Qabul qiluvchi xodim — IXTIYORIY, lekin ko'rsatilsa TEKSHIRILADI.
 *
 * ⚠️ O'QUVCHIGA TOPSHIRIB BO'LMAYDI. Jihoz uchun javobgarlik xodimning
 * mehnat munosabatidan kelib chiqadi; o'quvchi zarar uchun javob beradi
 * (`DamageCharge`), lekin maktab mulkini saqlash uchun emas. Ikkalasini
 * chalkashtirsak, "10 ta parta 7-B sinf o'quvchisiga topshirildi" degan
 * hujjat paydo bo'lardi (`payroll.service.js` da oylik o'quvchiga
 * biriktirilmagani bilan aynan bir xil mulohaza).
 *
 * ⚠️ ARXIVLANGAN XODIMGA HAM TOPSHIRIB BO'LMAYDI: u endi maktabda ishlamaydi.
 */
const assertRecipient = async (personId) => {
  if (!personId) return null;

  const person = await prisma.user.findUnique({
    where: { id: personId },
    select: RESPONSIBLE_SELECT,
  });
  if (!person) throw new NotFoundError("Qabul qiluvchi xodim topilmadi");

  if (person.role === ROLES.STUDENT) {
    throw new BadRequestError("Jihozni o'quvchiga topshirib bo'lmaydi");
  }
  if (person.isArchived) {
    throw new BadRequestError(
      `${person.firstName} ${person.lastName ?? ""}`.trim() + " arxivlangan",
    );
  }

  return person;
};

const personSnapshotOfStaff = (person) => ({
  firstName: person.firstName,
  lastName: person.lastName ?? "",
  username: person.username,
  role: person.role,
});

/**
 * Kirish ma'lumotidan satrlarni o'qiydi.
 *
 * IKKI SHAKLNI ham qabul qiladi:
 *   - yangi: `lines: [{ itemId, quantity, brokenQuantity, note }]`
 *   - eski:  `{ itemId, quantity, brokenQuantity }` — bitta jihoz
 *
 * Eski shakl saqlangan, chunki `POST /stocks/transfer` allaqachon
 * ishlatilyapti va uni birdaniga sindirish mijozni yangilanmaguncha
 * ishlamaydigan qilib qo'yardi.
 */
const parseTransferLines = async (data) => {
  const raw = Array.isArray(data.lines) && data.lines.length > 0
    ? data.lines
    : data.itemId
      ? [
          {
            itemId: data.itemId,
            quantity: data.quantity,
            brokenQuantity: data.brokenQuantity,
            // ⚠️ `data.note` bu yerda ATAYLAB uzatilmaydi: u AKT izohi.
            // Satrga ham qo'yilsa, bitta matn hujjatda ham, daftar
            // qatorida ham takrorlanib ko'rinardi.
          },
        ]
      : [];

  if (raw.length === 0) {
    throw new BadRequestError("Kamida bitta jihoz tanlanishi kerak");
  }
  if (raw.length > MAX_TRANSFER_LINES) {
    throw new BadRequestError(
      `Bitta aktda ${MAX_TRANSFER_LINES} tadan ko'p jihoz turi bo'lishi mumkin emas`,
    );
  }

  // Bitta aktda bitta jihoz BIR MARTA: ikkita qator bir-birini "to'ldirib",
  // nima ko'chirilgani noaniq bo'lib qolardi (`@@unique([transferId, itemId])`
  // buni baribir rad etardi, lekin xato xabari tushunarsiz bo'lardi).
  const seen = new Set();
  const lines = [];

  for (const entry of raw) {
    const item = await assertActiveItem(entry.itemId);
    if (seen.has(item.id)) {
      throw new BadRequestError(`"${item.name}" ro'yxatda ikki marta kelgan`);
    }
    seen.add(item.id);

    const quantity = parseQuantity(entry.quantity, `"${item.name}" miqdori`);
    if (quantity <= 0) {
      throw new BadRequestError(`"${item.name}" miqdori noldan katta bo'lishi kerak`);
    }

    // Yaroqsizini ham ko'chirish mumkin ("singan partalar omborga").
    // U `quantity` ICHIDA: jami 10 ta, shundan 3 tasi singan.
    const brokenQuantity = parseQuantity(
      entry.brokenQuantity ?? 0,
      `"${item.name}" yaroqsiz miqdori`,
    );
    if (brokenQuantity > quantity) {
      throw new BadRequestError(
        `"${item.name}": yaroqsizlar soni ko'chirilayotgan miqdordan ko'p`,
      );
    }

    lines.push({ item, quantity, brokenQuantity, note: entry.note?.trim() || "" });
  }

  return lines;
};

// ─────────────────────────────────────────────
// YARATISH
// ─────────────────────────────────────────────

/**
 * O'TKAZMA AKTI — bitta hodisa, har bir jihoz uchun ikkita daftar qatori.
 *
 * @param {object} data - { fromLocationId, toLocationId, toPersonId,
 *                          occurredAt, note, lines: [{ itemId, quantity,
 *                          brokenQuantity, note }] }
 * @param {string} userId
 */
const createTransfer = async (data, userId) => {
  if (!data.fromLocationId || !data.toLocationId) {
    throw new BadRequestError("Qaysi xonadan qaysi xonaga — ikkalasi ham kerak");
  }
  if (data.fromLocationId === data.toLocationId) {
    throw new BadRequestError("Bir xonaning o'ziga ko'chirib bo'lmaydi");
  }

  const [fromLocation, toLocation, recipient] = await Promise.all([
    assertActiveLocation(data.fromLocationId),
    assertActiveLocation(data.toLocationId),
    assertRecipient(data.toPersonId),
  ]);

  const lines = await parseTransferLines(data);
  const occurredAt = parseOccurredAt(data.occurredAt);
  const note = data.note?.trim() || "";

  const transfer = await prisma.$transaction(async (tx) => {
    const created = await tx.inventoryTransfer.create({
      data: {
        fromLocationId: fromLocation.id,
        toLocationId: toLocation.id,
        toPersonId: recipient?.id ?? null,
        personSnapshot: recipient ? personSnapshotOfStaff(recipient) : null,
        occurredAt,
        note,
        linesCount: lines.length,
        totalQuantity: lines.reduce((sum, l) => sum + l.quantity, 0),
        fromSnapshot: locationSnapshotOf(fromLocation),
        toSnapshot: locationSnapshotOf(toLocation),
        createdBy: userId,
      },
    });

    // Satrlar — jihoz `id` bo'yicha tartiblangan holda, ya'ni xatlov
    // qatorlari ham shu tartibda ochiladi. Lock tartibi quyida yana bir
    // marta `id` bo'yicha saralanadi (xatlov qatori id'si jihoz id'sidan
    // farq qiladi), lekin satrlarni ham determinlashtirish akt matnini
    // barqaror qiladi.
    const ordered = [...lines].sort((a, b) => a.item.id.localeCompare(b.item.id));

    for (const line of ordered) {
      const fromStock = await tx.inventoryStock.findUnique({
        where: {
          locationId_itemId: { locationId: fromLocation.id, itemId: line.item.id },
        },
      });
      if (!fromStock) {
        throw new BadRequestError(
          `"${fromLocation.name}" xatlovida "${line.item.name}" yo'q`,
        );
      }

      const toStock = await ensureStock(tx, toLocation.id, line.item.id, userId);

      await tx.inventoryTransferLine.create({
        data: {
          transferId: created.id,
          itemId: line.item.id,
          itemName: line.item.name,
          unit: line.item.unit,
          quantity: line.quantity,
          brokenQuantity: line.brokenQuantity,
          note: line.note,
        },
      });

      // ⚠️ LOCK TARTIBI — HAR DOIM xatlov qatori `id` si bo'yicha o'sish
      // tartibida, yo'nalishdan qat'i nazar (fayl sarlavhasidagi izoh).
      const postings = [
        { stock: fromStock, out: true },
        { stock: toStock, out: false },
      ].sort((a, b) => a.stock.id.localeCompare(b.stock.id));

      for (const { stock, out } of postings) {
        await postMovement(tx, {
          stock,
          type: out ? "transfer_out" : "transfer_in",
          quantityDelta: out ? -line.quantity : line.quantity,
          brokenDelta: out ? -line.brokenQuantity : line.brokenQuantity,
          occurredAt,
          itemName: line.item.name,
          transferId: created.id,
          counterpartLocationId: out ? toLocation.id : fromLocation.id,
          note:
            line.note ||
            note ||
            (out ? `→ ${toLocation.name}` : `← ${fromLocation.name}`),
          createdBy: userId,
        });
      }
    }

    return created;
  }, TX_OPTIONS);

  logger.info(
    `[inventory] O'tkazma: ${fromLocation.name} → ${toLocation.name} · ` +
      `${lines.length} ta jihoz turi · ` +
      `${recipient ? `qabul qildi=${recipient.username}` : "qabul qiluvchisiz"} · ` +
      `actor=${userId}`,
  );

  return getTransferById(transfer.id);
};

// ─────────────────────────────────────────────
// O'QISH
// ─────────────────────────────────────────────

/** Qabul qiluvchilarni bitta so'rovda o'qiydi (N+1 bo'lmasin). */
const loadRecipients = async (rows) => {
  const ids = [...new Set(rows.map((r) => r.toPersonId).filter(Boolean))];
  if (ids.length === 0) return new Map();

  const people = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: RESPONSIBLE_SELECT,
  });

  return new Map(people.map((p) => [p.id, p]));
};

/**
 * O'tkazmalar registri (sahifalangan).
 *
 * `locationId` — IKKALA tomonni ham qamraydi: "shu xonaga tegishli
 * o'tkazmalar" degan savol odatda kelgan-ketganning ikkalasini ham
 * bildiradi. Faqat bir tomon kerak bo'lsa `fromLocationId`/`toLocationId`.
 *
 * @param {object} req - query: { locationId, fromLocationId, toLocationId,
 *                                toPersonId, itemId, from, to, page, limit }
 */
const getTransfers = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const where = {};
  if (query.fromLocationId) where.fromLocationId = query.fromLocationId;
  if (query.toLocationId) where.toLocationId = query.toLocationId;
  if (query.locationId) {
    where.OR = [
      { fromLocationId: query.locationId },
      { toLocationId: query.locationId },
    ];
  }
  if (query.toPersonId) where.toPersonId = query.toPersonId;
  if (query.itemId) where.lines = { some: { itemId: query.itemId } };

  if (query.from || query.to) {
    where.occurredAt = {};
    if (query.from) where.occurredAt.gte = new Date(`${query.from}T00:00:00+05:00`);
    if (query.to) where.occurredAt.lte = new Date(`${query.to}T23:59:59.999+05:00`);
  }

  const [rows, total, agg] = await Promise.all([
    prisma.inventoryTransfer.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
      include: {
        fromLocation: { select: { name: true } },
        toLocation: { select: { name: true } },
        lines: { orderBy: { itemName: "asc" } },
      },
    }),
    prisma.inventoryTransfer.count({ where }),
    // Jami — SAHIFA bo'yicha emas, butun filtr bo'yicha
    prisma.inventoryTransfer.aggregate({
      where,
      _sum: { totalQuantity: true, linesCount: true },
    }),
  ]);

  const peopleById = await loadRecipients(rows);

  return {
    ...formatPaginationResponse(
      rows.map((row) => serializeTransfer(row, { person: peopleById.get(row.toPersonId) })),
      total,
      page,
      limit,
    ),
    totals: {
      transfers: total,
      quantity: agg._sum.totalQuantity ?? 0,
      lines: agg._sum.linesCount ?? 0,
    },
  };
};

/** Bitta o'tkazma akti + satrlari. */
const getTransferById = async (id) => {
  const transfer = await prisma.inventoryTransfer.findUnique({
    where: { id },
    include: {
      fromLocation: { select: { name: true, type: true } },
      toLocation: { select: { name: true, type: true } },
      lines: { orderBy: { itemName: "asc" } },
    },
  });
  if (!transfer) throw new NotFoundError("O'tkazma topilmadi");

  const person = transfer.toPersonId
    ? await prisma.user.findUnique({
        where: { id: transfer.toPersonId },
        select: RESPONSIBLE_SELECT,
      })
    : null;

  return serializeTransfer(transfer, { person });
};

module.exports = {
  MAX_TRANSFER_LINES,
  serializeTransfer,
  serializeTransferLine,
  assertRecipient,
  createTransfer,
  getTransfers,
  getTransferById,
};
