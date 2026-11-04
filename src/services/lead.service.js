const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { generateId } = require("../utils/idGenerator");
// Telefon raqami — SAQLASH SHAKLI BITTA (`+998XXXXXXXXX`), aks holda bir
// xil raqam uch xil yozilib, qidiruv ham, `tel:` havola ham ishonchsiz
// bo'lib qolardi (`helpers/phone.helpers.js` izohi).
const { normalizePhone } = require("../helpers/phone.helpers");
// QABUL ZINAPOYASI — pog'onalar, tartib va holat bilan bog'lanishi YAGONA
// joyda (`helpers/leadStage.helpers.js`). Shu fayl ham, tahlil ham, panel
// ham o'sha ro'yxatdan o'qiydi.
const {
  LEAD_STAGES,
  LEAD_STATUSES,
  FINAL_STAGE,
  EXIT_STATUSES,
  rungOf,
  isExitStatus,
  stagesUpTo,
  statusLabel,
} = require("../helpers/leadStage.helpers");

// Klient o'zgartira oladigan maydonlar. `status`/`lostReason` faqat
// updateLeadStatus orqali, `createdBy`/`id`/`updatedAt` esa server tomonidan
// belgilanadi. Mongoose ortiqcha maydonlarni jimgina tashlab yuborardi —
// Prisma esa "Unknown argument" bilan yiqiladi, shuning uchun whitelist shart.
const LEAD_EDITABLE_FIELDS = [
  "firstName",
  "lastName",
  "phone",
  "additionalPhone",
  // KELGAN MAKTABI — erkin matn (katalog emas: bola istalgan maktabdan keladi)
  "previousSchool",
  // KIM OLIB KELDI / KIM MAS'UL — tahlilning ikki kesimi (`createdBy` dan
  // farqi: u tizimga kim kiritgani)
  "broughtBy",
  "assignedTo",
  "source",
  "direction",
  "category",
  "classInterest",
  "parentName",
  "parentPhone",
  "address",
  "notes",
  "expectedEnrollDate",
];

/** Ro'yxatga olishda MAJBURIY maydonlar — faqat shu uchtasi (pastdagi izoh). */
const REQUIRED_ON_CREATE = ["firstName", "lastName", "phone"];

const PHONE_MAX = 30;
const NAME_MAX = 60;
const SCHOOL_MAX = 120;
const NOTE_MAX = 1000;
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

/**
 * `data`dan faqat ruxsat etilgan Lead maydonlarini ajratib oladi.
 * Berilmagan (undefined) maydonlar tushirib qoldiriladi.
 */
/** Lidda telefon yozilgan maydonlar — hammasi bir xil shaklga keltiriladi. */
const PHONE_FIELDS = Object.freeze(["phone", "additionalPhone", "parentPhone"]);

/**
 * LIDDA TELEFON — YUMSHOQ normallashtirish.
 *
 * ⚠️ `normalizePhone` ni to'g'ridan-to'g'ri ishlatmaymiz: u tanimagan
 * raqamda XATO tashlaydi va ota-ona chet el / shahar raqamini aytganda
 * lidni umuman ro'yxatga olib bo'lmasdi — bola esa shu bilan yo'qolardi.
 * Shuning uchun tanilgani bitta shaklga keltiriladi (qidiruv shunda
 * ishlaydi), tanilmagani esa BORLIGICHA saqlanadi.
 */
function leadPhone(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === "") return null;
  try {
    return normalizePhone(raw);
  } catch {
    return raw;
  }
}

const FIELD_LIMITS = Object.freeze({
  firstName: NAME_MAX,
  lastName: NAME_MAX,
  phone: PHONE_MAX,
  additionalPhone: PHONE_MAX,
  parentPhone: PHONE_MAX,
  parentName: NAME_MAX,
  previousSchool: SCHOOL_MAX,
  notes: NOTE_MAX,
  address: NOTE_MAX,
  classInterest: NAME_MAX,
});

function pickLeadFields(data) {
  const fields = {};

  for (const key of LEAD_EDITABLE_FIELDS) {
    if (data[key] === undefined) continue;

    if (key === "expectedEnrollDate") {
      fields[key] = data[key] ? new Date(data[key]) : null;
      continue;
    }

    const raw = data[key];
    const value = typeof raw === "string" ? raw.trim() : raw;

    const limit = FIELD_LIMITS[key];
    if (limit && typeof value === "string" && value.length > limit) {
      throw new BadRequestError(`"${key}" ${limit} belgidan oshmasin`);
    }

    if (PHONE_FIELDS.includes(key)) {
      fields[key] = leadPhone(value);
      continue;
    }

    // ⚠️ BO'SH SATR → `null` (majburiylaridan tashqari): maydonni
    // TOZALASH ham amal. Bo'sh satr qoldirilsa, "kelgan maktabi" ni
    // o'chirib bo'lmasdi va tahlilda bo'sh matnli kesim paydo bo'lardi.
    fields[key] =
      value === "" && !REQUIRED_ON_CREATE.includes(key) ? null : value;
  }

  return fields;
}

/**
 * source/direction/category/createdBy — Lead'da scalar ref (FK emas, populate yo'q).
 * Ularni qo'lda yuklab, populate shaklida ({ id, name } yoki { firstName, lastName })
 * lead(lar)ga biriktiradi. Bitta lead yoki lead massivi qabul qiladi.
 */
async function attachLeadRefs(leadsInput) {
  const isArray = Array.isArray(leadsInput);
  const leads = isArray ? leadsInput : [leadsInput];

  const sourceIds = [...new Set(leads.map((l) => l.source).filter(Boolean))];
  const directionIds = [...new Set(leads.map((l) => l.direction).filter(Boolean))];
  const categoryIds = [...new Set(leads.map((l) => l.category).filter(Boolean))];
  // Xodimlar UCHTA maydonda uchraydi va ular BOSHQA-BOSHQA odam bo'lishi
  // mumkin: kim kiritdi (`createdBy`), kim olib keldi (`broughtBy`), kim
  // mas'ul (`assignedTo`). Hammasi bitta so'rovda yuklanadi.
  const staffIds = [
    ...new Set(
      leads
        .flatMap((l) => [l.createdBy, l.broughtBy, l.assignedTo])
        .filter(Boolean),
    ),
  ];

  const [sources, directions, categories, staff] = await Promise.all([
    prisma.leadSource.findMany({ where: { id: { in: sourceIds } }, select: { id: true, name: true } }),
    prisma.leadDirection.findMany({ where: { id: { in: directionIds } }, select: { id: true, name: true } }),
    prisma.leadCategory.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } }),
    prisma.user.findMany({
      where: { id: { in: staffIds } },
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);

  const sourceMap = new Map(sources.map((s) => [s.id, s]));
  const directionMap = new Map(directions.map((d) => [d.id, d]));
  const categoryMap = new Map(categories.map((c) => [c.id, c]));
  const staffMap = new Map(staff.map((c) => [c.id, c]));

  const mapped = leads.map((lead) => ({
    ...lead,
    source: sourceMap.get(lead.source) || null,
    direction: directionMap.get(lead.direction) || null,
    category: categoryMap.get(lead.category) || null,
    createdBy: staffMap.get(lead.createdBy) || null,
    broughtBy: staffMap.get(lead.broughtBy) || null,
    assignedTo: staffMap.get(lead.assignedTo) || null,
    // ZINAPOYA holati — panel har joyda shundan o'qiydi, holat nomini
    // o'zi talqin qilmaydi (`helpers/leadStage.helpers.js`)
    stage: rungOf(lead.status),
    statusLabel: statusLabel(lead.status),
    isEnrolled: lead.status === "enrolled",
    isExited: isExitStatus(lead.status),
  }));

  return isArray ? mapped : mapped[0];
}

/**
 * createdBy'ni ({ firstName, lastName }) aktivliklarga biriktiradi (scalar ref).
 */
async function attachActivityCreators(activities) {
  const creatorIds = [...new Set(activities.map((a) => a.createdBy).filter(Boolean))];
  const creators = await prisma.user.findMany({
    where: { id: { in: creatorIds } },
    select: { id: true, firstName: true, lastName: true },
  });
  const creatorMap = new Map(creators.map((c) => [c.id, c]));

  return activities.map((a) => ({ ...a, createdBy: creatorMap.get(a.createdBy) || null }));
}

/**
 * Sana oralig'i filtri qurish (createdAt gte/lte).
 */
function buildDateFilter(startDate, endDate) {
  const createdAt = {};
  if (startDate) createdAt.gte = new Date(startDate);
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    createdAt.lte = end;
  }
  return Object.keys(createdAt).length ? { createdAt } : {};
}

/**
 * Barcha leadlarni sahifalangan holda olish.
 * @param {object} query - { status, source, search, startDate, endDate, page, limit }
 * @returns {Promise<{leads: Array, pagination: object}>}
 */
async function getAllLeads(query) {
  const {
    status,
    stage,
    source,
    direction,
    category,
    broughtBy,
    assignedTo,
    search,
    startDate,
    endDate,
    page = 1,
    limit = 24,
  } = query;

  const filter = {};
  if (status) filter.status = status;
  if (source) filter.source = source;
  if (direction) filter.direction = direction;
  if (category) filter.category = category;
  if (broughtBy) filter.broughtBy = broughtBy;
  if (assignedTo) filter.assignedTo = assignedTo;

  // POG'ONA FILTRI — "shu pog'onaga YETGANLAR" (holat filtri bilan
  // chalkashmasin: u "hozir shu holatda turganlar"). Ikkisi birga
  // berilsa shart KESISHADI — "keldi pog'onasiga yetgan, lekin
  // hozir yo'qolgan" degan ma'noli savol.
  const stageNum = Number.parseInt(stage, 10);
  if (Number.isInteger(stageNum) && stageNum >= 1 && stageNum <= FINAL_STAGE) {
    filter.stageEvents = { some: { stage: stageNum } };
  }

  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.createdAt.lte = end;
    }
  }

  if (search && search.trim()) {
    const term = search.trim();
    // ⚠️ RAQAM BO'YICHA QIDIRUV ALOHIDA: raqamlar `+998901234567` shaklida
    // saqlanadi (`leadPhone`), foydalanuvchi esa "+998 90 123 45 67" deb
    // ko'chirib qo'yishi mumkin. Faqat matn bo'yicha qidirilsa, aynan
    // o'sha raqam topilmay qolardi.
    const digits = term.replace(/\D/g, "");
    const phoneTerms = digits.length >= 4 ? [digits] : [];

    filter.OR = [
      ...phoneTerms.flatMap((value) => [
        { phone: { contains: value } },
        { additionalPhone: { contains: value } },
        { parentPhone: { contains: value } },
      ]),
      { firstName: { contains: term, mode: "insensitive" } },
      { lastName: { contains: term, mode: "insensitive" } },
      { phone: { contains: term, mode: "insensitive" } },
      // Ikkala qo'shimcha raqam ham qidiriladi: ota-ona o'z raqamini
      // aytib qo'ng'iroq qiladi va qabulxona bolani SHU raqam bo'yicha
      // topishi kerak
      { additionalPhone: { contains: term, mode: "insensitive" } },
      { parentPhone: { contains: term, mode: "insensitive" } },
      { parentName: { contains: term, mode: "insensitive" } },
      { previousSchool: { contains: term, mode: "insensitive" } },
    ];
  }

  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);
  const skip = (pageNum - 1) * limitNum;

  const [total, rawLeads] = await Promise.all([
    prisma.lead.count({ where: filter }),
    prisma.lead.findMany({
      where: filter,
      orderBy: { createdAt: "desc" },
      skip,
      take: limitNum,
    }),
  ]);

  const leads = await attachLeadRefs(rawLeads);

  const totalPages = Math.ceil(total / limitNum);

  return {
    leads,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages,
      hasNextPage: pageNum < totalPages,
      hasPrevPage: pageNum > 1,
    },
  };
}

/**
 * Leadni ID bo'yicha olish.
 * @param {string} id - lead ID
 * @returns {Promise<object>}
 */
async function getLeadById(id) {
  const rawLead = await prisma.lead.findUnique({ where: { id } });

  if (!rawLead) {
    throw new NotFoundError("Lead topilmadi");
  }

  const lead = await attachLeadRefs(rawLead);

  const rawActivities = await prisma.leadActivity.findMany({
    where: { leadId: id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const recentActivities = await attachActivityCreators(rawActivities);

  // ZINAPOYA TARIXI — "qaysi pog'onaga qachon yetdi". Panel shu ro'yxatdan
  // qadamlarni chizadi; yetilmagan pog'ona `reachedAt: null` bilan keladi,
  // ya'ni "hali yetmagan" va "yetgan, lekin vaqti noma'lum" aralashmaydi.
  const events = await prisma.leadStageEvent.findMany({
    where: { leadId: id },
    orderBy: { stage: "asc" },
  });
  const eventByStage = new Map(events.map((e) => [e.stage, e]));

  const stageTimeline = LEAD_STAGES.map((meta) => {
    const event = eventByStage.get(meta.stage) ?? null;
    return {
      stage: meta.stage,
      status: meta.status,
      label: meta.label,
      hint: meta.hint,
      reached: Boolean(event),
      reachedAt: event?.reachedAt ?? null,
      // Eski ma'lumotdan tiklangan vaqt TAXMINIY — panel buni aytadi
      approximate: event?.backfilled ?? false,
      note: event?.note ?? "",
    };
  });

  return { lead, activities: recentActivities, stageTimeline };
}

/**
 * Yangi lead yaratish.
 * @param {object} data - lead ma'lumotlari
 * @param {string} userId - yaratuvchi foydalanuvchi ID
 * @returns {Promise<object>}
 */
async function createLead(data, userId) {
  const fields = pickLeadFields(data);

  // ⚠️ FAQAT UCH MAYDON MAJBURIY (biznes qarori): ism, familiya, telefon.
  // Ilgari manba + yo'nalish + toifa ham talab qilinardi, lekin qabulxona
  // formasi yo'nalish va toifani umuman yubormaydi — ya'ni lead yaratish
  // 400 bilan YIQILARDI. Bola kelganda birinchi yoziladigan narsa uning
  // ismi va raqami; qolganini keyin to'ldirish mumkin.
  for (const key of REQUIRED_ON_CREATE) {
    if (!String(fields[key] ?? "").trim()) {
      throw new BadRequestError("Ism, familiya va telefon raqami majburiy");
    }
  }

  await assertLeadRefs(fields);

  const leadData = {
    ...fields,
    createdBy: userId,
    // KIM OLIB KELDI sukut bo'yicha kiritgan odam: tahlilda "muallifsiz"
    // qator qolmasin. Boshqa odam olib kelgan bo'lsa formada tanlanadi.
    broughtBy: fields.broughtBy ?? userId,
  };
  if (data.createdAt) leadData.createdAt = new Date(data.createdAt);

  // Boshlang'ich holat — odatda "yangi", lekin bola darhol qiziqish
  // bildirgan bo'lsa qabulxona o'sha pog'onadan boshlashi mumkin.
  const status = data.status ? parseStatus(data.status) : "new";
  leadData.status = status;

  // ⚠️ BITTA TRANZAKSIYADA: lead, uning birinchi yozuvi va pog'ona tarixi.
  // Ilgari uchta alohida so'rov edi — ikkinchisi yiqilsa lead tarixsiz
  // qolib, tahlilda "hech qaysi pog'onaga yetmagan" bo'lib ko'rinardi.
  const lead = await prisma.$transaction(async (tx) => {
    const created = await tx.lead.create({ data: leadData });

    await tx.leadActivity.create({
      data: {
        leadId: created.id,
        type: "note",
        description: "Ro'yxatga olindi",
        newStatus: status,
        createdBy: userId,
      },
    });

    await recordStagesInTx(tx, {
      leadId: created.id,
      status,
      userId,
      reachedAt: created.createdAt,
      note: "Ro'yxatga olishda",
    });

    return created;
  });

  return attachLeadRefs(lead);
}

/**
 * Holatni tekshiradi (enum bilan AYNI ro'yxat — `leadStage.helpers.js`).
 */
function parseStatus(status) {
  if (!status) throw new BadRequestError("Yangi holat majburiy");
  if (!LEAD_STATUSES.includes(status)) {
    throw new BadRequestError("Noto'g'ri holat");
  }
  return status;
}

/**
 * Katalog va xodim havolalarini tekshiradi — BERILGANLARINI.
 *
 * ⚠️ Bo'sh qoldirish XATO EMAS: manba/yo'nalish/toifa keyin to'ldiriladi.
 * Lekin berilgani mavjud bo'lishi shart, aks holda tahlilda nomsiz kesim
 * paydo bo'lardi.
 *
 * ⚠️ "Kim olib keldi" va "mas'ul" — XODIM bo'lishi shart: o'quvchi
 * tanlansa, "kim nechta olib keldi" hisoboti ma'nosini yo'qotardi.
 */
async function assertLeadRefs(fields) {
  const checks = [];

  if (fields.source) {
    checks.push(
      prisma.leadSource
        .findUnique({ where: { id: fields.source }, select: { id: true } })
        .then((row) => {
          if (!row) throw new NotFoundError("Manba topilmadi");
        }),
    );
  }
  if (fields.direction) {
    checks.push(
      prisma.leadDirection
        .findUnique({ where: { id: fields.direction }, select: { id: true } })
        .then((row) => {
          if (!row) throw new NotFoundError("Yo'nalish topilmadi");
        }),
    );
  }
  if (fields.category) {
    checks.push(
      prisma.leadCategory
        .findUnique({ where: { id: fields.category }, select: { id: true } })
        .then((row) => {
          if (!row) throw new NotFoundError("Toifa topilmadi");
        }),
    );
  }

  const staffIds = [fields.broughtBy, fields.assignedTo].filter(Boolean);
  if (staffIds.length) {
    for (const id of staffIds) {
      if (!OBJECT_ID_RE.test(id)) throw new BadRequestError("Xodim identifikatori yaroqsiz");
    }
    checks.push(
      prisma.user
        .findMany({
          where: { id: { in: [...new Set(staffIds)] }, role: { not: "student" } },
          select: { id: true },
        })
        .then((rows) => {
          const found = new Set(rows.map((r) => r.id));
          for (const id of staffIds) {
            if (!found.has(id)) throw new NotFoundError("Xodim topilmadi");
          }
        }),
    );
  }

  await Promise.all(checks);
}

/**
 * POG'ONAGA YETISH FAKTINI YOZADI (zinapoya monoton — 1 dan shu
 * pog'onagacha hammasi).
 *
 * ⚠️ `skipDuplicates`: bir pog'onaga bir marta yetiladi. Ortga qaytib
 * qayta ko'tarilgan lead BIRINCHI yetgan vaqtini saqlab qoladi — "qachon
 * yetdi" degan savolga javob o'zgarmasligi kerak.
 *
 * ⚠️ Chiqib ketish holati (`lost` / `rejected` / `postponed`) hech qanday
 * pog'ona yozmaydi: u zinapoyadan chiqish, undagi qadam emas. Yetilgan
 * pog'onalar esa JOYIDA qoladi — "qaysi pog'onada yo'qotdik" degan savol
 * aynan shu bilan javob topadi.
 *
 * @returns {Promise<number>} yangi yozilgan pog'onalar soni
 */
async function recordStagesInTx(tx, { leadId, status, userId, reachedAt, note = "" }) {
  const stages = stagesUpTo(status);
  if (stages.length === 0) return 0;

  const result = await tx.leadStageEvent.createMany({
    data: stages.map((s) => ({
      id: generateId(),
      leadId,
      stage: s.stage,
      status: s.status,
      reachedAt: reachedAt ?? new Date(),
      createdBy: userId ?? null,
      note,
    })),
    skipDuplicates: true,
  });

  return result.count;
}

/**
 * Leadni yangilash.
 * @param {string} id - lead ID
 * @param {object} data - yangilanadigan ma'lumotlar
 * @returns {Promise<object>}
 */
async function updateLead(id, data) {
  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead) {
    throw new NotFoundError("Lead topilmadi");
  }

  // status faqat updateLeadStatus orqali o'zgaradi; createdBy — server maydoni.
  // Whitelist ikkalasini ham avtomatik chetlab o'tadi.
  const leadData = pickLeadFields(data);
  if (data.createdAt) leadData.createdAt = new Date(data.createdAt);

  // Havolalar BITTA joyda tekshiriladi (yaratish bilan AYNI qoida):
  // ikki nusxa bo'lsa, biriga qo'shilgan shart ikkinchisida tushib qolardi.
  await assertLeadRefs(leadData);

  await prisma.lead.update({ where: { id }, data: leadData });

  const updated = await prisma.lead.findUnique({ where: { id } });
  return attachLeadRefs(updated);
}

/**
 * Lead statusini yangilash.
 * @param {string} id - lead ID
 * @param {string} status - yangi status
 * @param {string} description - izoh
 * @param {string} lostReason - rad/yo'qolish sababi
 * @param {string} userId - o'zgartiruvchi foydalanuvchi ID
 * @returns {Promise<object>}
 */
async function updateLeadStatus(id, status, description, lostReason, userId) {
  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead) {
    throw new NotFoundError("Lead topilmadi");
  }

  const nextStatus = parseStatus(status);
  const previousStatus = lead.status;

  // ⚠️ CHIQIB KETISHDA SABAB MAJBURIY: "yo'qoldi" degan yozuv sababsiz
  // bo'lsa, tahlil "nega yo'qotdik" degan savolga javob bermaydi — modul
  // esa aynan shu savol uchun bor.
  const reason = String(lostReason ?? "").trim();
  if (isExitStatus(nextStatus) && !reason) {
    throw new BadRequestError("Chiqib ketish sababi majburiy");
  }
  if (reason.length > NOTE_MAX) {
    throw new BadRequestError(`Sabab ${NOTE_MAX} belgidan oshmasin`);
  }

  const note = String(description ?? "").trim();
  if (note.length > NOTE_MAX) {
    throw new BadRequestError(`Izoh ${NOTE_MAX} belgidan oshmasin`);
  }

  const update = { status: nextStatus };
  if (isExitStatus(nextStatus)) update.lostReason = reason;
  // Zinapoyaga qaytgan lead "yo'qolgan" bo'lib qolmasin
  if (!isExitStatus(nextStatus) && lead.lostReason) update.lostReason = null;

  // ⚠️ BITTA TRANZAKSIYADA: holat, yozuv va pog'ona tarixi. Ilgari ular
  // ketma-ket edi va ikkinchisi yiqilsa holat o'zgarib, tarixda iz
  // qolmasdi — ya'ni funnel va "kim yo'qotdi" hisoboti jimgina
  // xato ko'rsatardi.
  const reached = await prisma.$transaction(async (tx) => {
    await tx.lead.update({ where: { id }, data: update });

    await tx.leadActivity.create({
      data: {
        leadId: lead.id,
        type: "status_change",
        description:
          note ||
          `Holat "${statusLabel(previousStatus)}" dan "${statusLabel(nextStatus)}" ga o'zgartirildi`,
        previousStatus,
        newStatus: nextStatus,
        createdBy: userId,
      },
    });

    return recordStagesInTx(tx, {
      leadId: lead.id,
      status: nextStatus,
      userId,
      note: note || statusLabel(nextStatus),
    });
  });

  const updated = await prisma.lead.findUnique({ where: { id } });
  const result = await attachLeadRefs(updated);
  return { ...result, stagesRecorded: reached };
}

/**
 * Leadni o'chirish.
 * @param {string} id - lead ID
 * @returns {Promise<void>}
 */
async function deleteLead(id) {
  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead) {
    throw new NotFoundError("Lead topilmadi");
  }

  // ⚠️ `Promise.all` EMAS: ikkala yozuv parallel ketganda o'chirish va
  // bolalarni tozalash bir-birini kutib qolishi mumkin edi. Bolalar
  // jadvallari `onDelete: Cascade` bilan bog'langan (`lead_activities`,
  // `lead_stage_events`), ya'ni bitta `delete` yetarli.
  await prisma.lead.delete({ where: { id } });
}

/**
 * Lead analitikasi - umumiy ko'rinish.
 * @param {object} query - { startDate, endDate }
 * @returns {Promise<object>}
 */
async function getAnalyticsOverview(query) {
  const { startDate, endDate } = query;

  const dateFilter = buildDateFilter(startDate, endDate);

  const [
    totalLeads,
    newLeads,
    enrolledLeads,
    rejectedLeads,
    lostLeads,
    contactedLeads,
    interestedLeads,
    visitedLeads,
    trialLeads,
    negotiationLeads,
    postponedLeads,
  ] = await Promise.all([
    prisma.lead.count({ where: dateFilter }),
    prisma.lead.count({ where: { ...dateFilter, status: "new" } }),
    prisma.lead.count({ where: { ...dateFilter, status: "enrolled" } }),
    prisma.lead.count({ where: { ...dateFilter, status: "rejected" } }),
    prisma.lead.count({ where: { ...dateFilter, status: "lost" } }),
    prisma.lead.count({ where: { ...dateFilter, status: "contacted" } }),
    prisma.lead.count({ where: { ...dateFilter, status: "interested" } }),
    prisma.lead.count({ where: { ...dateFilter, status: "visited" } }),
    prisma.lead.count({ where: { ...dateFilter, status: "trial" } }),
    prisma.lead.count({ where: { ...dateFilter, status: "negotiation" } }),
    prisma.lead.count({ where: { ...dateFilter, status: "postponed" } }),
  ]);

  const conversionRate = totalLeads > 0 ? ((enrolledLeads / totalLeads) * 100).toFixed(1) : 0;
  const lossRate = totalLeads > 0 ? (((rejectedLeads + lostLeads) / totalLeads) * 100).toFixed(1) : 0;

  return {
    totalLeads,
    newLeads,
    enrolledLeads,
    rejectedLeads,
    lostLeads,
    contactedLeads,
    interestedLeads,
    visitedLeads,
    trialLeads,
    negotiationLeads,
    postponedLeads,
    conversionRate: Number(conversionRate),
    lossRate: Number(lossRate),
    byStatus: {
      new: newLeads,
      contacted: contactedLeads,
      interested: interestedLeads,
      visited: visitedLeads,
      trial: trialLeads,
      negotiation: negotiationLeads,
      enrolled: enrolledLeads,
      rejected: rejectedLeads,
      lost: lostLeads,
      postponed: postponedLeads,
    },
  };
}

/**
 * Lead analitikasi - manba bo'yicha.
 * @param {object} query - { startDate, endDate }
 * @returns {Promise<Array>}
 */
async function getSourceAnalytics(query) {
  const { startDate, endDate } = query;

  const conditions = [];
  const params = [];
  if (startDate) {
    params.push(new Date(startDate));
    conditions.push(`l.created_at >= $${params.length}`);
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    params.push(end);
    conditions.push(`l.created_at <= $${params.length}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await prisma.$queryRawUnsafe(
    `
    SELECT
      l.source AS id,
      s.name AS "sourceName",
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE l.status = 'enrolled')::int AS enrolled,
      COUNT(*) FILTER (WHERE l.status = 'rejected')::int AS rejected,
      COUNT(*) FILTER (WHERE l.status = 'lost')::int AS lost,
      COUNT(*) FILTER (WHERE l.status IN ('new','contacted','interested','visited','trial','negotiation','postponed'))::int AS active,
      CASE WHEN COUNT(*) > 0
        THEN ROUND(COUNT(*) FILTER (WHERE l.status = 'enrolled')::numeric / COUNT(*) * 100, 1)
        ELSE 0 END AS "conversionRate"
    FROM leads l
    JOIN lead_sources s ON s.id = l.source
    ${whereClause}
    GROUP BY l.source, s.name
    ORDER BY total DESC
    `,
    ...params,
  );

  return rows.map((r) => ({ ...r, conversionRate: Number(r.conversionRate) }));
}

/**
 * Lead analitikasi - konversiya funnel.
 * Har bir active bosqichda hozir qancha lead turganini ko'rsatadi.
 * Shuningdek rejected/lost/postponed ham alohida ko'rsatiladi.
 * @param {object} query - { startDate, endDate }
 * @returns {Promise<object>}
 */
async function getConversionFunnel(query) {
  const { startDate, endDate, broughtBy, assignedTo } = query;

  // ⚠️ KOGORTA — lead QACHON ro'yxatga olingani bo'yicha, pog'onaga qachon
  // yetgani bo'yicha EMAS. "Oktabrda kelgan 40 ta boladan nechtasi qabul
  // qilindi" degan savol faqat shunday javob topadi: aks holda oktabrda
  // kelgan bola noyabrda to'lasa, u ikki oyning ikkisida ham yarim
  // ko'rinib, hech qaysi oyning haqiqiy natijasi chiqmasdi.
  const leadWhere = {
    ...buildDateFilter(startDate, endDate),
    ...(broughtBy ? { broughtBy } : {}),
    ...(assignedTo ? { assignedTo } : {}),
  };

  const [totalLeads, statusCounts, stageCounts] = await Promise.all([
    prisma.lead.count({ where: leadWhere }),
    prisma.lead.groupBy({
      by: ["status"],
      where: leadWhere,
      _count: { _all: true },
    }),
    // ⚠️ POG'ONAGA YETGANLAR, o'sha pog'onada TURGANLAR emas: zinapoya
    // monoton yozilgani uchun (`recordStagesInTx`) to'lov qilgan bola
    // "keldi" da ham sanaladi. Ilgari funnel joriy holatdan hisoblanardi
    // va har pog'ona faqat o'sha yerda QOTIB QOLGANLARNI ko'rsatardi —
    // "10 tadan 2 tasi qoldi" degan savolga javob bermasdi.
    prisma.leadStageEvent.groupBy({
      by: ["stage"],
      where: { lead: leadWhere },
      _count: { _all: true },
    }),
  ]);

  const reachedByStage = new Map(stageCounts.map((r) => [r.stage, r._count._all]));
  const countByStatus = new Map(statusCounts.map((r) => [r.status, r._count._all]));

  const pct = (part, whole) =>
    whole > 0 ? Number(((part / whole) * 100).toFixed(1)) : 0;

  let previous = totalLeads;
  const pipeline = LEAD_STAGES.map((meta) => {
    const reached = reachedByStage.get(meta.stage) ?? 0;
    const row = {
      stage: meta.stage,
      status: meta.status,
      label: meta.label,
      hint: meta.hint,
      reached,
      // Boshidan (ro'yxatga olingandan) konversiya
      conversion: pct(reached, totalLeads),
      // Oldingi pog'onadan konversiya — yo'qotish AYNAN shu yerda ko'rinadi
      fromPrevious: pct(reached, previous),
      lostCount: Math.max(previous - reached, 0),
      dropOff: previous > 0 ? pct(Math.max(previous - reached, 0), previous) : 0,
    };
    previous = reached;
    return row;
  });

  const exits = EXIT_STATUSES.map((status) => ({
    status,
    label: statusLabel(status),
    count: countByStatus.get(status) ?? 0,
    percentage: pct(countByStatus.get(status) ?? 0, totalLeads),
  }));

  // HOZIR QAYSI POG'ONADA TURIBDI — funnel bilan CHALKASHMASIN: bu
  // "ishlash kerak bo'lgan navbat", funnel esa "necha tasi o'tdi".
  const current = [
    {
      stage: 0,
      label: "Ro'yxatda (hali qiziqish bildirmagan)",
      count: (countByStatus.get("new") ?? 0) + (countByStatus.get("contacted") ?? 0),
    },
    ...LEAD_STAGES.map((meta) => ({
      stage: meta.stage,
      label: meta.label,
      count:
        (countByStatus.get(meta.status) ?? 0) +
        // Eski "Muzokara" holati 5-pog'onaga moslanadi (backfill bilan AYNI)
        (meta.stage === 5 ? countByStatus.get("negotiation") ?? 0 : 0),
    })),
  ];

  const enrolled = reachedByStage.get(FINAL_STAGE) ?? 0;

  return {
    totalLeads,
    enrolled,
    conversion: pct(enrolled, totalLeads),
    pipeline,
    exits,
    current,
  };
}

/**
 * XODIMLAR KESIMIDA KONVERSIYA — "kim nechta olib keldi va nechtasi qoldi".
 *
 * ⚠️ IKKI KESIM va ular BOSHQA-BOSHQA savol:
 *   · `brought` — kim olib keldi (`Lead.broughtBy`): "men 10 ta olib keldim";
 *   · `assigned` — kim mas'ul bo'ldi (`Lead.assignedTo`): "10 tadan 8 tasini
 *     ushlab qololmadingiz".
 * Bitta kesim bilan ayblov bir tomonga qarab qolardi: olib kelgan odam
 * bilan sinov darsini o'tgan odam ko'pincha boshqa-boshqa.
 *
 * ⚠️ Har pog'ona uchun YETGANLAR soni beriladi, shuning uchun yo'qotish
 * aynan qaysi qadamda bo'lgani ko'rinadi.
 *
 * @param {object} query - { startDate, endDate }
 */
async function getStaffConversion(query) {
  const { startDate, endDate } = query;
  const leadWhere = buildDateFilter(startDate, endDate);

  const [broughtGroups, assignedGroups] = await Promise.all([
    prisma.lead.groupBy({
      by: ["broughtBy"],
      where: leadWhere,
      _count: { _all: true },
    }),
    prisma.lead.groupBy({
      by: ["assignedTo"],
      where: leadWhere,
      _count: { _all: true },
    }),
  ]);

  const staffIds = [
    ...new Set(
      [...broughtGroups.map((g) => g.broughtBy), ...assignedGroups.map((g) => g.assignedTo)].filter(
        Boolean,
      ),
    ),
  ];

  const staff = staffIds.length
    ? await prisma.user.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, firstName: true, lastName: true, role: true, isArchived: true },
      })
    : [];
  const staffMap = new Map(staff.map((u) => [u.id, u]));

  /**
   * Xodim × pog'ona sanoqlari — BITTA so'rovda.
   *
   * ⚠️ XOM SQL ataylab: Prisma `groupBy` ikki jadvalning ustunini birga
   * guruhlay olmaydi (xodim `leads` da, pog'ona `lead_stage_events` da),
   * ya'ni har xodimga alohida so'rov ketardi — 30 xodimda 30 so'rov.
   * Ustun nomi KODDAN keladi (whitelist), foydalanuvchi kiritmaydi.
   *
   * ⚠️ Jadval nomlari qo'shimchasiz: filial schema'si ulanish satrida
   * (`config/prisma.js`), shuning uchun `search_path` o'zi to'g'ri
   * schema'ga ishora qiladi (`financeReport.service.js` bilan AYNI naqsh).
   */
  const loadStageCounts = async (column) => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT l."${column}"                  AS staff_id,
              e."stage"                      AS stage,
              COUNT(DISTINCT e."lead_id")::int AS reached
         FROM lead_stage_events e
         JOIN leads l ON l."id" = e."lead_id"
        WHERE l."${column}" IS NOT NULL
          AND ($1::timestamp IS NULL OR l."created_at" >= $1)
          AND ($2::timestamp IS NULL OR l."created_at" <= $2)
        GROUP BY 1, 2`,
      leadWhere.createdAt?.gte ?? null,
      leadWhere.createdAt?.lte ?? null,
    );

    const byStaff = new Map();
    for (const row of rows) {
      if (!byStaff.has(row.staff_id)) byStaff.set(row.staff_id, new Map());
      byStaff.get(row.staff_id).set(Number(row.stage), Number(row.reached));
    }
    return byStaff;
  };

  const buildRows = (field, column, groups, byStaff) =>
    groups
      .filter((g) => g[field])
      .map((group) => {
        const id = group[field];
        const person = staffMap.get(id);
        const reached = byStaff.get(id) ?? new Map();
        const total = group._count._all;
        const enrolled = reached.get(FINAL_STAGE) ?? 0;

        return {
          staffId: id,
          fullName: person
            ? `${person.firstName ?? ""} ${person.lastName ?? ""}`.trim() || "Noma'lum"
            : "Noma'lum",
          role: person?.role ?? null,
          isArchived: person?.isArchived ?? false,
          total,
          enrolled,
          conversion: total > 0 ? Number(((enrolled / total) * 100).toFixed(1)) : 0,
          // Yo'qotilganlar = olib kelingan − qabul qilingan
          lost: Math.max(total - enrolled, 0),
          stages: LEAD_STAGES.map((meta) => ({
            stage: meta.stage,
            label: meta.label,
            reached: reached.get(meta.stage) ?? 0,
          })),
        };
      })
      .sort((a, b) => b.total - a.total || b.enrolled - a.enrolled);

  const [broughtCounts, assignedCounts] = await Promise.all([
    loadStageCounts("brought_by"),
    loadStageCounts("assigned_to"),
  ]);

  const brought = buildRows("broughtBy", "brought_by", broughtGroups, broughtCounts);
  const assigned = buildRows("assignedTo", "assigned_to", assignedGroups, assignedCounts);

  // Mas'ul belgilanmagan leadlar — ayblovni hech kimga yozmaslik uchun
  // alohida qator sifatida aytiladi (jim yashirilmaydi).
  const unassigned = assignedGroups.find((g) => !g.assignedTo)?._count._all ?? 0;

  return { brought, assigned, unassigned };
}

/**
 * Lead analitikasi - vaqt bo'yicha trendlar.
 * @param {object} query - { days, startDate, endDate, groupBy }
 * groupBy: "day" | "week" | "month" (default: auto based on range)
 * @returns {Promise<Array>}
 */
async function getTrendAnalytics(query) {
  const { days, startDate: qStartDate, endDate: qEndDate, groupBy } = query;

  let rangeStart;
  let rangeEnd = new Date();
  rangeEnd.setHours(23, 59, 59, 999);

  if (qStartDate) {
    rangeStart = new Date(qStartDate);
    rangeStart.setHours(0, 0, 0, 0);
  } else {
    const daysNum = parseInt(days, 10) || 30;
    rangeStart = new Date();
    rangeStart.setDate(rangeStart.getDate() - daysNum);
    rangeStart.setHours(0, 0, 0, 0);
  }

  if (qEndDate) {
    rangeEnd = new Date(qEndDate);
    rangeEnd.setHours(23, 59, 59, 999);
  }

  const diffDays = Math.ceil((rangeEnd - rangeStart) / (1000 * 60 * 60 * 24));

  // Auto-select grouping based on range size
  let group = groupBy;
  if (!group) {
    if (diffDays <= 90) group = "day";
    else if (diffDays <= 365) group = "week";
    else group = "month";
  }

  let dateFormat;
  if (group === "month") dateFormat = "YYYY-MM";
  else if (group === "week") dateFormat = 'IYYY-"W"IW'; // ISO week (e.g. 2026-W03)
  else dateFormat = "YYYY-MM-DD";

  const trends = await prisma.$queryRawUnsafe(
    `
    SELECT
      TO_CHAR(l.created_at, $1) AS date,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE l.status = 'enrolled')::int AS enrolled,
      COUNT(*) FILTER (WHERE l.status IN ('rejected','lost'))::int AS lost,
      COUNT(*) FILTER (WHERE l.status IN ('new','contacted','interested','visited','trial','negotiation','postponed'))::int AS active
    FROM leads l
    WHERE l.created_at >= $2 AND l.created_at <= $3
    GROUP BY date
    ORDER BY date ASC
    `,
    dateFormat,
    rangeStart,
    rangeEnd,
  );

  return { trends, groupBy: group, diffDays };
}

/**
 * Lead analitikasi - yo'nalish bo'yicha.
 * @param {object} query - { startDate, endDate }
 * @returns {Promise<Array>}
 */
async function getDirectionAnalytics(query) {
  const { startDate, endDate } = query;

  const conditions = [];
  const params = [];
  if (startDate) {
    params.push(new Date(startDate));
    conditions.push(`l.created_at >= $${params.length}`);
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    params.push(end);
    conditions.push(`l.created_at <= $${params.length}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await prisma.$queryRawUnsafe(
    `
    SELECT
      l.direction AS id,
      d.name AS "directionName",
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE l.status = 'enrolled')::int AS enrolled,
      COUNT(*) FILTER (WHERE l.status IN ('new','contacted','interested','visited','trial','negotiation','postponed'))::int AS active,
      COUNT(*) FILTER (WHERE l.status IN ('rejected','lost'))::int AS lost,
      CASE WHEN COUNT(*) > 0
        THEN ROUND(COUNT(*) FILTER (WHERE l.status = 'enrolled')::numeric / COUNT(*) * 100, 1)
        ELSE 0 END AS "conversionRate"
    FROM leads l
    JOIN lead_directions d ON d.id = l.direction
    ${whereClause}
    GROUP BY l.direction, d.name
    ORDER BY total DESC
    `,
    ...params,
  );

  return rows.map((r) => ({ ...r, conversionRate: Number(r.conversionRate) }));
}

/**
 * Lead analitikasi - toifa bo'yicha.
 * @param {object} query - { startDate, endDate }
 * @returns {Promise<Array>}
 */
async function getCategoryAnalytics(query) {
  const { startDate, endDate } = query;

  const conditions = [];
  const params = [];
  if (startDate) {
    params.push(new Date(startDate));
    conditions.push(`l.created_at >= $${params.length}`);
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    params.push(end);
    conditions.push(`l.created_at <= $${params.length}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await prisma.$queryRawUnsafe(
    `
    SELECT
      l.category AS id,
      c.name AS "categoryName",
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE l.status = 'enrolled')::int AS enrolled,
      COUNT(*) FILTER (WHERE l.status IN ('new','contacted','interested','visited','trial','negotiation','postponed'))::int AS active,
      COUNT(*) FILTER (WHERE l.status IN ('rejected','lost'))::int AS lost,
      CASE WHEN COUNT(*) > 0
        THEN ROUND(COUNT(*) FILTER (WHERE l.status = 'enrolled')::numeric / COUNT(*) * 100, 1)
        ELSE 0 END AS "conversionRate"
    FROM leads l
    JOIN lead_categories c ON c.id = l.category
    ${whereClause}
    GROUP BY l.category, c.name
    ORDER BY total DESC
    `,
    ...params,
  );

  return rows.map((r) => ({ ...r, conversionRate: Number(r.conversionRate) }));
}

module.exports = {
  getAllLeads,
  getLeadById,
  createLead,
  updateLead,
  updateLeadStatus,
  deleteLead,
  getAnalyticsOverview,
  getSourceAnalytics,
  getConversionFunnel,
  getStaffConversion,
  getTrendAnalytics,
  getDirectionAnalytics,
  getCategoryAnalytics,
};
