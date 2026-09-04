/**
 * KUNLIK MONITORING HISOBOTI.
 *
 * Mas'ul shaxs har kuni o'z xonasi bo'yicha "nima holatda" degan varaqni
 * to'ldirib yuboradi. Talabdagi misol aynan shu:
 *
 *     Parta va stol — Mavjud: 20 ta | Bugun singani: 1 ta
 *
 * ── IKKI BOSQICH VA NIMA UCHUN ───────────────
 *
 *   draft     — varaq ochildi, xatlovdan oldindan to'ldirildi. Hech narsa
 *               harakatlanmagan: mas'ul shaxs xonani aylanib chiqib,
 *               raqamlarni bosqichma-bosqich kiritadi.
 *   submitted — YUBORILDI va MUHRLANDI. Aynan shu paytda miqdor daftariga
 *               qatorlar yoziladi va zarar hodisalari tug'iladi.
 *
 * Bitta qadamga qo'shilsa, yarim to'ldirilgan varaq ham xatlovni
 * o'zgartirib yuborardi — mas'ul shaxs 40 ta stulni sanab bo'lgunicha
 * hisobot uch marta "yuborilgan" bo'lardi.
 *
 * ⚠️ YUBORILGANDAN KEYIN TAHRIRLANMAYDI. Daftarga qatorlar yozilib
 * bo'lgan; ularni qaytarish uchun TESKARI qator kerak, bu esa alohida,
 * ko'rinadigan amal (zararni bekor qilish). Bu `AccountEntry` ning
 * append-only qoidasining shu domendagi ko'rinishi.
 *
 * ⚠️ BIR KUNDA BIR XONAGA BITTA HISOBOT (`@@unique([locationId, date])`).
 * Ikkitasi bo'lsa "bugun nechta sindi" degan savol ikki xil javob berardi.
 * Ikkinchi marta ochilganda MAVJUD varaq qaytariladi — idempotent.
 *
 * ⚠️ SANA `@db.Date` — vaqt komponenti struktura bo'yicha yo'q va faqat
 * `getUTC*` bilan o'qiladi (`month.helpers.js`). `date.helpers.js` bu
 * domenda ISHLATILMAYDI.
 */

const prisma = require("../config/prisma");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
} = require("../utils/errors");
const logger = require("../utils/logger");
const { Decimal, formatAmount, sumAmounts } = require("../helpers/money.helpers");
const { parseDayDate, currentDayDate } = require("../helpers/month.helpers");
// ⚠️ Hisobot sanasi `@db.Date` — UTC yarim tunida yotadi, shuning uchun
// `{ utc: true }` MAJBURIY. Bayroqsiz `21:30Z` kabi instant ertangi kunga
// o'tib ketardi (`.claude/rules/dates.md` §4).
const { formatDateUz } = require("../helpers/date.helpers");
const {
  parseOptionalQuantity,
  damageAmountOf,
  locationSnapshotOf,
} = require("../helpers/inventory.helpers");
const { uploadAttachments, deleteAttachments } = require("./file.service");
const { assertActiveLocation, RESPONSIBLE_SELECT } = require("./inventoryLocation.service");
const { TX_OPTIONS, postMovement } = require("./inventoryStock.service");
const { createDamageInTx } = require("./inventoryDamage.service");

const serializeCheck = (row, { lines, reporter, location } = {}) => {
  const { location: included, ...rest } = row;
  const loc = location ?? included;

  return {
    ...rest,
    damageAmount: formatAmount(row.damageAmount),
    isDraft: row.status === "draft",
    isSubmitted: row.status === "submitted",
    locationName: loc?.name ?? row.locationSnapshot?.name ?? "Noma'lum",
    locationType: loc?.type ?? row.locationSnapshot?.type ?? null,
    reporter: reporter ?? null,
    reporterName: reporter
      ? `${reporter.firstName} ${reporter.lastName ?? ""}`.trim()
      : null,
    ...(lines ? { lines: lines.map(serializeLine) } : {}),
  };
};

const serializeLine = (row) => ({
  ...row,
  // Varaq ochilgandagi yaroqli miqdor — mas'ul shaxs shu raqamni ko'radi
  expectedServiceable: row.expectedQuantity - row.expectedBroken,
  hasChange:
    row.brokenQuantity > 0 || row.missingQuantity > 0 || row.repairedQuantity > 0,
});

/**
 * Hisobot sanasi — kelajakda bo'la olmaydi.
 *
 * Orqaga sanash QONUNIY: mas'ul shaxs kechagi hisobotni ertalab kiritishi
 * mumkin (to'lov sanasi bilan bir xil mulohaza).
 */
const parseCheckDate = (value) => {
  const date = value ? parseDayDate(value, "Sana") : currentDayDate();

  if (date.getTime() > currentDayDate().getTime()) {
    throw new BadRequestError("Kelajakdagi kun uchun hisobot ochib bo'lmaydi");
  }

  return date;
};

// ─────────────────────────────────────────────
// VARAQ OCHISH
// ─────────────────────────────────────────────

/**
 * Kunlik varaqni ochadi (yoki mavjudini qaytaradi).
 *
 * Satrlar XATLOVDAN oldindan to'ldiriladi: mas'ul shaxs 40 ta jihozni
 * qo'lda tanlashi shart emas, u faqat o'zgargan raqamlarni kiritadi.
 *
 * IDEMPOTENT: shu kun uchun varaq bo'lsa — o'sha qaytadi (yuborilgani ham).
 *
 * @param {object} data - { locationId, date }
 * @param {string} userId
 */
const openCheck = async (data, userId) => {
  const location = await assertActiveLocation(data.locationId);
  const date = parseCheckDate(data.date);

  const existing = await prisma.inventoryCheck.findUnique({
    where: { locationId_date: { locationId: location.id, date } },
  });
  if (existing) return getCheckById(existing.id);

  const stocks = await prisma.inventoryStock.findMany({
    where: { locationId: location.id, quantity: { gt: 0 } },
    orderBy: [{ item: { sortOrder: "asc" } }, { item: { name: "asc" } }],
    include: { item: { select: { name: true, unit: true } } },
  });

  if (stocks.length === 0) {
    throw new BadRequestError(
      `"${location.name}" xatlovi bo'sh — avval jihozlarni kiriting`,
    );
  }

  const check = await prisma.$transaction(async (tx) => {
    const created = await tx.inventoryCheck.create({
      data: {
        locationId: location.id,
        date,
        reportedBy: userId,
        linesCount: stocks.length,
        locationSnapshot: locationSnapshotOf(location),
        createdBy: userId,
      },
    });

    await tx.inventoryCheckLine.createMany({
      data: stocks.map((stock) => ({
        checkId: created.id,
        stockId: stock.id,
        itemId: stock.itemId,
        itemName: stock.item.name,
        unit: stock.item.unit,
        // Varaq OCHILGAN paytdagi surat — kiritilgan raqamlar shunga
        // nisbatan o'qiladi
        expectedQuantity: stock.quantity,
        expectedBroken: stock.brokenQuantity,
      })),
    });

    return created;
  }, TX_OPTIONS);

  logger.info(
    `[inventory] Kunlik varaq ochildi: ${location.name} · ` +
      `${formatDateUz(date, { utc: true })} · ${stocks.length} ta jihoz · actor=${userId}`,
  );

  return getCheckById(check.id);
};

// ─────────────────────────────────────────────
// O'QISH
// ─────────────────────────────────────────────

/** Hisobotlar registri (sahifalangan). */
const getChecks = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const where = {};
  if (query.locationId) where.locationId = query.locationId;
  if (query.status) where.status = query.status;
  if (query.reportedBy) where.reportedBy = query.reportedBy;

  if (query.date) {
    where.date = parseDayDate(query.date, "Sana");
  } else if (query.from || query.to) {
    where.date = {};
    if (query.from) where.date.gte = parseDayDate(query.from, "Boshlanish sanasi");
    if (query.to) where.date.lte = parseDayDate(query.to, "Tugash sanasi");
  }

  const [rows, total, agg] = await Promise.all([
    prisma.inventoryCheck.findMany({
      where,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
      include: { location: { select: { name: true, type: true } } },
    }),
    prisma.inventoryCheck.count({ where }),
    prisma.inventoryCheck.aggregate({
      where: { ...where, status: "submitted" },
      _sum: { brokenCount: true, missingCount: true, repairedCount: true, damageAmount: true },
      _count: { _all: true },
    }),
  ]);

  const reporters = rows.length
    ? await prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.reportedBy))] } },
        select: RESPONSIBLE_SELECT,
      })
    : [];
  const byId = new Map(reporters.map((r) => [r.id, r]));

  return {
    ...formatPaginationResponse(
      rows.map((row) => serializeCheck(row, { reporter: byId.get(row.reportedBy) })),
      total,
      page,
      limit,
    ),
    totals: {
      submittedCount: agg._count._all,
      brokenCount: agg._sum.brokenCount ?? 0,
      missingCount: agg._sum.missingCount ?? 0,
      repairedCount: agg._sum.repairedCount ?? 0,
      damageAmount: formatAmount(new Decimal(agg._sum.damageAmount ?? 0)),
    },
  };
};

/** Bitta hisobot + satrlari. */
const getCheckById = async (id) => {
  const check = await prisma.inventoryCheck.findUnique({
    where: { id },
    include: {
      location: { select: { name: true, type: true } },
      lines: { orderBy: { itemName: "asc" } },
    },
  });
  if (!check) throw new NotFoundError("Hisobot topilmadi");

  const { lines, ...rest } = check;

  const reporter = await prisma.user.findUnique({
    where: { id: check.reportedBy },
    select: RESPONSIBLE_SELECT,
  });

  return serializeCheck(rest, { lines, reporter });
};

/**
 * BUGUN HISOBOT BERMAGAN XONALAR.
 *
 * Ikkita chaqiruvchisi bor: eslatma job'i va admin paneldagi "bugun
 * kimlar hisobot bermadi" bloki. Bitta joyda, chunki ikkalasi bir xil
 * qoida bo'yicha ishlashi shart — aks holda eslatma ketgan-u panelda
 * "hammasi joyida" ko'rinardi.
 *
 * @param {string|Date} [dateInput] - standart: bugun
 */
const getPendingLocations = async (dateInput) => {
  const date = dateInput ? parseCheckDate(dateInput) : currentDayDate();

  const [locations, submitted] = await Promise.all([
    prisma.inventoryLocation.findMany({
      where: { isArchived: false },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.inventoryCheck.findMany({
      where: { date, status: "submitted" },
      select: { locationId: true },
    }),
  ]);

  const done = new Set(submitted.map((c) => c.locationId));
  const pending = locations.filter((l) => !done.has(l.id));

  const responsibleIds = [...new Set(pending.map((l) => l.responsibleId).filter(Boolean))];
  const people = responsibleIds.length
    ? await prisma.user.findMany({
        where: { id: { in: responsibleIds } },
        select: { ...RESPONSIBLE_SELECT, telegramIds: true },
      })
    : [];
  const peopleById = new Map(people.map((p) => [p.id, p]));

  return {
    date,
    dateLabel: formatDateUz(date, { utc: true }),
    totalLocations: locations.length,
    submittedCount: done.size,
    pendingCount: pending.length,
    locations: pending.map((l) => {
      const responsible = peopleById.get(l.responsibleId);
      return {
        id: l.id,
        name: l.name,
        type: l.type,
        responsible: responsible
          ? {
              id: responsible.id,
              firstName: responsible.firstName,
              lastName: responsible.lastName,
              telegramIds: responsible.telegramIds,
            }
          : null,
      };
    }),
  };
};

// ─────────────────────────────────────────────
// TAHRIRLASH VA YUBORISH
// ─────────────────────────────────────────────

/** Faqat qoralama tahrirlanadi — yuborilgani MUHRLANGAN. */
const assertDraft = async (id) => {
  const check = await prisma.inventoryCheck.findUnique({ where: { id } });
  if (!check) throw new NotFoundError("Hisobot topilmadi");

  if (check.status === "submitted") {
    throw new BadRequestError(
      "Hisobot yuborilgan va o'zgartirilmaydi. Xato bo'lsa — zarar yozuvini " +
        "bekor qiling yoki xatlovni qo'lda to'g'rilang.",
    );
  }

  return check;
};

/**
 * Satrlarni saqlaydi (qoralama).
 *
 * Faqat KIRITILGAN satrlar yangilanadi — varaqni bosqichma-bosqich
 * to'ldirish shu tufayli mumkin.
 *
 * @param {string} id
 * @param {object} data - { note, lines: [{ id, brokenQuantity, missingQuantity, repairedQuantity, note, attachments }] }
 */
const updateCheckLines = async (id, data, userId) => {
  const check = await assertDraft(id);

  const rawLines = Array.isArray(data.lines) ? data.lines : [];

  const existing = await prisma.inventoryCheckLine.findMany({ where: { checkId: id } });
  const byId = new Map(existing.map((l) => [l.id, l]));

  const updates = [];

  for (const raw of rawLines) {
    const line = byId.get(raw.id);
    if (!line) throw new NotFoundError("Hisobot satri topilmadi");

    const brokenQuantity = parseOptionalQuantity(
      raw.brokenQuantity,
      `"${line.itemName}" singan miqdori`,
    );
    const missingQuantity = parseOptionalQuantity(
      raw.missingQuantity,
      `"${line.itemName}" yo'qolgan miqdori`,
    );
    const repairedQuantity = parseOptionalQuantity(
      raw.repairedQuantity,
      `"${line.itemName}" ta'mirlangan miqdori`,
    );

    updates.push({
      id: line.id,
      data: {
        brokenQuantity,
        missingQuantity,
        repairedQuantity,
        ...(raw.note !== undefined ? { note: raw.note?.trim() || "" } : {}),
        ...(raw.attachments !== undefined
          ? { attachments: Array.isArray(raw.attachments) ? raw.attachments : [] }
          : {}),
      },
    });
  }

  await prisma.$transaction(async (tx) => {
    for (const update of updates) {
      await tx.inventoryCheckLine.update({ where: { id: update.id }, data: update.data });
    }

    if (data.note !== undefined || data.reportedBy !== undefined) {
      await tx.inventoryCheck.update({
        where: { id },
        data: {
          ...(data.note !== undefined ? { note: data.note?.trim() || "" } : {}),
          // Mas'ul ta'tilda bo'lsa o'rniga boshqa xodim yuborishi mumkin
          ...(data.reportedBy !== undefined ? { reportedBy: data.reportedBy || userId } : {}),
        },
      });
    }
  }, TX_OPTIONS);

  return getCheckById(id);
};

/**
 * Satrga rasm/hujjat biriktiradi (qoralama bosqichida).
 *
 * Alohida endpoint, chunki satrlarni saqlash JSON so'rovi bo'lib qolishi
 * kerak: 40 ta satrni har safar multipart bilan yuborish mas'ul shaxsning
 * telefonida sekin ishlardi. Rasm esa faqat sindirilgan bir-ikki satrga
 * qo'shiladi.
 *
 * @param {string} id - hisobot id
 * @param {string} lineId
 * @param {Array} files - multer fayllari
 * @param {string} userId
 */
const attachLineFiles = async (id, lineId, files, userId) => {
  await assertDraft(id);

  const line = await prisma.inventoryCheckLine.findUnique({ where: { id: lineId } });
  if (!line || line.checkId !== id) throw new NotFoundError("Hisobot satri topilmadi");

  if (!files?.length) throw new BadRequestError("Fayl yuborilmagan");

  // Tranzaksiyadan tashqarida — tashqi saqlash chaqiruvi DB lock'ini
  // ushlab turmasligi kerak
  const uploaded = await uploadAttachments(files);

  try {
    const updated = await prisma.inventoryCheckLine.update({
      where: { id: lineId },
      data: { attachments: [...(line.attachments ?? []), ...uploaded] },
    });

    logger.info(
      `[inventory] Satrga fayl biriktirildi: check=${id} line=${lineId} ` +
        `${uploaded.length} ta · actor=${userId}`,
    );

    return serializeLine(updated);
  } catch (error) {
    await deleteAttachments(uploaded);
    throw error;
  }
};

/**
 * HISOBOTNI YUBORISH — varaq muhrlanadi va xatlov o'zgaradi.
 *
 * Bitta tranzaksiyada uch narsa bo'ladi:
 *   1) ta'mirlanganlar yaroqsizlar safidan chiqadi (`repair`)
 *   2) singan/yo'qolganlar uchun ZARAR hodisasi tug'iladi va miqdor
 *      daftariga `damage` qatori yoziladi
 *   3) varaq `submitted` ga o'tadi, sanoqchilar va zarar summasi yoziladi
 *
 * Tartib MUHIM: avval ta'mirlash. Bir kunda "2 ta ta'mirlandi, 1 ta sindi"
 * bo'lsa, ta'mirlangani avval qaytarilmasa `brokenAfter > quantityAfter`
 * invariantiga tegib ketishi mumkin edi.
 *
 * @param {string} id
 * @param {object} data - { note, lines }
 * @param {string} userId
 */
const submitCheck = async (id, data, userId) => {
  // Yuborishdan oldin oxirgi tahrirlar saqlanadi — frontend ikki marta
  // so'rov yubormasligi uchun
  if (data?.lines || data?.note !== undefined) {
    await updateCheckLines(id, data, userId);
  }

  const check = await assertDraft(id);
  const location = await prisma.inventoryLocation.findUnique({
    where: { id: check.locationId },
  });
  if (!location) throw new NotFoundError("Xona topilmadi");

  const lines = await prisma.inventoryCheckLine.findMany({
    where: { checkId: id },
    orderBy: { itemId: "asc" }, // determinlashgan lock tartibi
  });

  // Hisobot sanasi @db.Date (UTC yarim tun); daftar esa INSTANT bilan
  // ishlaydi. Kun boshlanishi biznes sanasi sifatida yetarli va
  // aniq: "12-sentabr hisoboti" → 12-sentabr.
  const occurredAt = new Date(check.date);

  const result = await prisma.$transaction(async (tx) => {
    // Poyga: ikki xodim bir vaqtda "Yuborish" bosishi mumkin
    const claimed = await tx.inventoryCheck.updateMany({
      where: { id, status: "draft" },
      data: { status: "submitted", submittedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new ConflictError("Hisobot allaqachon yuborilgan");
    }

    let brokenCount = 0;
    let missingCount = 0;
    let repairedCount = 0;
    const damageAmounts = [];

    for (const line of lines) {
      if (
        line.brokenQuantity === 0 &&
        line.missingQuantity === 0 &&
        line.repairedQuantity === 0
      ) {
        continue;
      }

      const stock = await tx.inventoryStock.findUnique({
        where: { id: line.stockId },
        include: { item: true },
      });
      if (!stock) throw new NotFoundError(`"${line.itemName}" xatlovda topilmadi`);

      // ── 1) TA'MIRLASH (avval — yuqoridagi izohga qarang)
      if (line.repairedQuantity > 0) {
        if (line.repairedQuantity > stock.brokenQuantity) {
          throw new BadRequestError(
            `"${line.itemName}": ta'mirlangan (${line.repairedQuantity}) ` +
              `yaroqsizlar sonidan (${stock.brokenQuantity}) ko'p`,
          );
        }

        await postMovement(tx, {
          stock,
          type: "repair",
          quantityDelta: 0,
          brokenDelta: -line.repairedQuantity,
          occurredAt,
          itemName: line.itemName,
          checkId: id,
          note: line.note || "Kunlik hisobot",
          createdBy: userId,
        });

        repairedCount += line.repairedQuantity;
      }

      // ── 2) ZARAR. Ikki tur ALOHIDA hodisa: ularning xatlovga ta'siri
      //       ham, hisobotdagi kesimi ham boshqa.
      for (const [kind, quantity] of [
        ["broken", line.brokenQuantity],
        ["missing", line.missingQuantity],
      ]) {
        if (quantity <= 0) continue;

        const damage = await createDamageInTx(
          tx,
          {
            location,
            item: stock.item,
            stock,
            kind,
            quantity,
            occurredAt,
            description: line.note,
            attachments: line.attachments ?? [],
            checkId: id,
            reportedBy: check.reportedBy,
            // Narx varaq YUBORILGAN paytdagi katalogdan olinadi va
            // hodisaga muhrlanadi
            unitPrice: stock.item.unitPrice,
          },
          userId,
        );

        damageAmounts.push(damage.amount);
        if (kind === "broken") brokenCount += quantity;
        else missingCount += quantity;
      }
    }

    const damageAmount = sumAmounts(damageAmounts);

    // ── 3) Sanoqchilar — yuborish paytida BIR MARTA hisoblanadi va
    //       keyin o'zgarmaydi (hisobot muhrlangan)
    await tx.inventoryCheck.update({
      where: { id },
      data: {
        brokenCount,
        missingCount,
        repairedCount,
        damageAmount,
        linesCount: lines.length,
      },
    });

    return { brokenCount, missingCount, repairedCount, damageAmount };
  }, TX_OPTIONS);

  logger.info(
    `[inventory] Hisobot yuborildi: ${location.name} · ${formatDateUz(check.date, { utc: true })} · ` +
      `singan=${result.brokenCount} yo'qolgan=${result.missingCount} ` +
      `ta'mirlangan=${result.repairedCount} zarar=${formatAmount(result.damageAmount)} ` +
      `actor=${userId}`,
  );

  return getCheckById(id);
};

/**
 * Qoralamani o'chirish.
 *
 * ⚠️ Faqat QORALAMA o'chiriladi: yuborilgan hisobot daftarga qatorlar
 * yozgan va uni o'chirish tarixni buzardi (hisob-fakturasi bor o'qish
 * davrini o'chirib bo'lmagani bilan bir xil qoida).
 */
const deleteCheck = async (id, userId) => {
  const check = await assertDraft(id);

  // Satrlar Cascade bilan ketadi
  await prisma.inventoryCheck.delete({ where: { id } });

  logger.info(`[inventory] Qoralama o'chirildi: check=${id} actor=${userId}`);

  return { id: check.id, message: "Qoralama o'chirildi" };
};

module.exports = {
  serializeCheck,
  serializeLine,
  parseCheckDate,
  openCheck,
  getChecks,
  getCheckById,
  getPendingLocations,
  updateCheckLines,
  attachLineFiles,
  submitCheck,
  deleteCheck,
};
