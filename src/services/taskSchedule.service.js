/**
 * DOIMIY (TAKRORLANUVCHI) TOPSHIRIQLAR — "har dushanba 08:10 da",
 * "har 10 kunda bir", "3 oyda bir, oyning 1-kuni".
 *
 * ⚠️ QOIDA TOPSHIRIQ EMAS. Bu servis faqat qoidani saqlaydi; haqiqiy
 * topshiriqlarni undan `runSchedulePass()` VAQTIDAN OLDIN yaratadi
 * (`leadDays`, sukut 1 kun). Yaratilishning O'ZI xodim uchun eslatma:
 * topshiriq ro'yxatida paydo bo'ladi va unga push boradi.
 *
 * ⚠️ IKKINCHI "ESLATMA" MEXANIZMI QO'SHILMAYDI. U holda bitta hodisa ikki
 * joydan boshqarilardi va biri ikkinchisidan orqada qolib, xodim
 * eslatmani olib, topshiriqni ko'rmaydigan holat chiqardi.
 *
 * ⚠️ TOPSHIRIQ QATORINI SHU SERVIS YOZMAYDI — `task.service.js` dagi
 * `writeTaskRows` yozadi: qator shakli, boshlang'ich holat va vaqt
 * chizig'ining birinchi qatori qo'lda berilgan topshiriq bilan AYNI
 * bo'lishi kerak.
 *
 * ⚠️ IDEMPOTENT: `(scheduleId, assignee, occurrenceDate)` yagona indeks.
 * Pass kuniga bir necha marta ishlasa ham (cron + startup) bitta kunga
 * ikkita topshiriq yozilmaydi.
 */

const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const taskService = require("./task.service");
const taskScopeService = require("./taskScope.service");
const { getTaskSettings } = require("./settings.service");
const { deleteAttachments, uploadAttachments } = require("./file.service");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { BadRequestError, NotFoundError, ForbiddenError } = require("../utils/errors");
const { getTashkentDateUtc } = require("../helpers/date.helpers");
const { TASK_PUSH_EVENTS } = require("../helpers/taskPush.helpers");
const { normalizeLinks } = require("../helpers/taskWindow.helpers");
const {
  FREQUENCIES,
  MAX_SLOTS,
  slotsOf,
  MAX_LEAD_DAYS,
  MAX_DUE_OFFSET_DAYS,
  MAX_INTERVAL_DAYS,
  MAX_INTERVAL_MONTHS,
  addDays,
  occurrencesInRange,
  nextOccurrence,
  buildWindow,
  describeSchedule,
  parseClock,
} = require("../helpers/taskSchedule.helpers");

const TITLE_MAX = 300;
const DESCRIPTION_MAX = 5000;
const ATTACHMENTS_MAX = 10;
const MAX_ASSIGNEES = 500;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── YORDAMCHILAR ─────────────────────────────────────────────────

const _day = (value, label) => {
  const text = String(value ?? "").slice(0, 10);
  if (!DATE_RE.test(text)) throw new BadRequestError(`${label} noto'g'ri`);
  return new Date(`${text}T00:00:00.000Z`);
};

const _clock = (value, label, { required = false } = {}) => {
  if (value === undefined || value === null || value === "") {
    if (required) throw new BadRequestError(`${label} majburiy`);
    return null;
  }
  const minute = parseClock(value);
  if (minute === null) throw new BadRequestError(`${label} noto'g'ri (masalan 08:10)`);
  // Normalizatsiya: "8:5" ham "08:05" bo'lib saqlanadi
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
};

const _int = (value, { min, max, label, fallback }) => {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    throw new BadRequestError(`${label} majburiy`);
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num < min || num > max) {
    throw new BadRequestError(`${label} ${min} dan ${max} gacha butun son bo'lishi kerak`);
  }
  return num;
};

const _intList = (value, { min, max, label }) => {
  const list = Array.isArray(value) ? value : [];
  const unique = [...new Set(list.map(Number))].sort((a, b) => a - b);
  if (unique.length === 0) throw new BadRequestError(`${label} tanlanishi kerak`);
  if (unique.some((n) => !Number.isInteger(n) || n < min || n > max)) {
    throw new BadRequestError(`${label} noto'g'ri`);
  }
  return unique;
};

const _text = (value, { label, min, max }) => {
  const text = String(value ?? "").trim();
  if (text.length < min) {
    throw new BadRequestError(
      text.length === 0 ? `${label} majburiy` : `${label} kamida ${min} ta belgi bo'lishi kerak`,
    );
  }
  if (text.length > max) throw new BadRequestError(`${label} ${max} ta belgidan oshmasligi kerak`);
  return text;
};

/**
 * Qoidaning takrorlanish qismini tekshiradi va normallashtiradi.
 * ⚠️ Faqat TANLANGAN rejimning maydonlari saqlanadi: "haftalik" dan
 * "oylik" ga o'tganda eski kunlar qolib ketsa, keyingi tahrirda ular
 * jimgina qayta yoqilardi.
 */
const _assertRecurrence = (body) => {
  const frequency = String(body.frequency || "");
  if (!FREQUENCIES.includes(frequency)) {
    throw new BadRequestError("Takrorlanish turi noto'g'ri");
  }

  const rule = {
    frequency,
    weekdays: [],
    monthDays: [],
    intervalDays: null,
    intervalMonths: null,
  };

  if (frequency === "weekly") {
    rule.weekdays = _intList(body.weekdays, { min: 0, max: 6, label: "Hafta kunlari" });
  } else if (frequency === "days") {
    rule.intervalDays = _int(body.intervalDays, {
      min: 1,
      max: MAX_INTERVAL_DAYS,
      label: "Kunlar oralig'i",
    });
  } else {
    rule.intervalMonths = _int(body.intervalMonths, {
      min: 1,
      max: MAX_INTERVAL_MONTHS,
      label: "Oylar oralig'i",
    });
    rule.monthDays = _intList(body.monthDays, { min: 1, max: 31, label: "Oy kunlari" });
  }

  return rule;
};

/**
 * VAQT OYNALARI — bir kunda bir nechta bo'lishi mumkin.
 *
 * Shakl: `[{ start: "08:10"|null, due: "09:00", offsetDays: 0 }]`.
 *
 * ⚠️ BIR XIL TUGASH VAQTI IKKI MARTA BO'LMAYDI: topshiriqlarning
 * yagonalik kaliti aynan shu vaqt (`tasks.occurrence_slot`), ya'ni takror
 * vaqt ikkita boshqa topshiriqni baza uchun bitta qilib qo'yardi.
 *
 * @param {unknown} value - massiv yoki JSON satri (multipart forma)
 * @returns {Array<{ start: string|null, due: string, offsetDays: number }>}
 */
const _assertSlots = (value) => {
  let list = value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      throw new BadRequestError("Vaqt oynalari formati noto'g'ri");
    }
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new BadRequestError("Kamida bitta vaqt belgilanishi kerak");
  }
  if (list.length > MAX_SLOTS) {
    throw new BadRequestError(`Bir kunda ko'pi bilan ${MAX_SLOTS} ta vaqt bo'lishi mumkin`);
  }

  const seen = new Set();
  const slots = list.map((raw, index) => {
    const label = list.length > 1 ? `${index + 1}-vaqt` : "Vaqt";
    const due = _clock(raw?.due, `${label}: tugash vaqti`, { required: true });
    const start = _clock(raw?.start, `${label}: boshlanish vaqti`);
    const offsetDays = _int(raw?.offsetDays, {
      min: 0,
      max: MAX_DUE_OFFSET_DAYS,
      label: `${label}: muddat kunlari`,
      fallback: 0,
    });

    // Bir kunlik oynada boshlanish tugashdan oldin bo'lishi SHART; muddat
    // boshqa kunga surilgan bo'lsa bu shart o'z-o'zidan bajariladi.
    if (start && offsetDays === 0 && parseClock(start) >= parseClock(due)) {
      throw new BadRequestError(`${label}: boshlanish vaqti tugash vaqtidan oldin bo'lishi kerak`);
    }

    if (seen.has(due)) {
      throw new BadRequestError(`Bir xil tugash vaqti ikki marta berilgan: ${due}`);
    }
    seen.add(due);

    return { start, due, offsetDays };
  });

  // Tartiblangan holda saqlanadi — panel va matn har doim bir xil ko'rinadi
  return slots.sort((a, b) => parseClock(a.due) - parseClock(b.due));
};

const _assertAssignees = async (ids, scope) => {
  const list = [...new Set((ids || []).map(String))].filter(Boolean);
  if (list.length === 0) throw new BadRequestError("Kamida bitta ijrochi tanlash kerak");
  if (list.length > MAX_ASSIGNEES) {
    throw new BadRequestError(`Ko'pi bilan ${MAX_ASSIGNEES} ta ijrochi tanlash mumkin`);
  }

  const users = await prisma.user.findMany({
    where: { id: { in: list } },
    select: { id: true, role: true, isArchived: true },
  });
  if (users.length !== list.length) throw new BadRequestError("Ba'zi foydalanuvchilar topilmadi");
  if (users.some((u) => u.role === "owner")) {
    throw new BadRequestError("Tizim egasiga topshiriq berib bo'lmaydi");
  }
  if (users.some((u) => u.isArchived)) {
    throw new BadRequestError("Arxivlangan foydalanuvchiga topshiriq berib bo'lmaydi");
  }

  if (scope) taskScopeService.assertCanAssign(list, scope);
  return list;
};

/** Qoidani panelga tayyorlaydi: matn, keyingi hodisa va yaratilganlar soni. */
const _serialize = (schedule, extra = {}) => {
  const today = getTashkentDateUtc(0);
  const next = nextOccurrence(schedule, today);

  return {
    ...schedule,
    ruleLabel: describeSchedule(schedule),
    nextOccurrence: next,
    // Keyingi topshiriq AYNAN qachon yoziladi (hodisadan `leadDays` oldin)
    nextGenerationDate: next ? addDays(next, -schedule.leadDays) : null,
    ...extra,
  };
};

// ─── CRUD ─────────────────────────────────────────────────────────

/**
 * Qoida yaratadi va darhol "oldinga qarab" topshiriqlarni yozadi: qoida
 * bugun yaratilib, hodisa ertaga bo'lsa, topshiriq SHU ZAHOTI chiqadi —
 * foydalanuvchi "yaratdim, lekin hech narsa ko'rinmayapti" holatiga
 * tushmasligi kerak.
 */
/**
 * @param {object} body
 * @param {string} createdBy
 * @param {object} [scope]
 * @param {{ selfAssigned?: boolean }} [options] - `selfAssigned: true` —
 *   xodim O'ZIGA doimiy ish yozyapti (`selfTask.service.js`): ijrochi
 *   yaratuvchining o'zi, jarima bali 0.
 */
const createSchedule = async (body, createdBy, scope, { selfAssigned = false } = {}) => {
  const settings = await getTaskSettings();

  const title = _text(body.title, {
    label: "Sarlavha",
    min: Math.max(1, settings.minTitleLength),
    max: TITLE_MAX,
  });
  const description = _text(body.description, {
    label: "Tavsif",
    min: settings.minDescriptionLength,
    max: DESCRIPTION_MAX,
  });

  const rule = _assertRecurrence(body);
  const slots = _assertSlots(body.slots);
  const leadDays = _int(body.leadDays, {
    min: 0,
    max: MAX_LEAD_DAYS,
    label: "Eslatma kunlari",
    fallback: 1,
  });

  const startDate = body.startDate
    ? _day(body.startDate, "Boshlanish sanasi")
    : getTashkentDateUtc(0);
  const endDate = body.endDate ? _day(body.endDate, "Tugash sanasi") : null;
  if (endDate && endDate.getTime() < startDate.getTime()) {
    throw new BadRequestError("Tugash sanasi boshlanish sanasidan oldin bo'lmasligi kerak");
  }

  // ⚠️ SHAXSIY QOIDADA JARIMA BALI 0 (`task.service.js` bilan AYNI qoida):
  // `_int` kamida 1 ni talab qiladi, shuning uchun u umuman chaqirilmaydi.
  const penaltyPoints = selfAssigned
    ? 0
    : _int(body.penaltyPoints, {
        min: 1,
        max: settings.maxPenaltyPoints,
        label: "Jarima bali",
        fallback: settings.defaultPenaltyPoints,
      });

  // ⚠️ SHAXSIY QOIDA — FAQAT O'ZIGA: ro'yxat bitta va u yaratuvchining
  // o'zi. Aks holda "o'ziga belgilash" yo'li birovga jarimasiz DOIMIY
  // topshiriq yozib qo'yish yo'liga aylanardi.
  const assignees = selfAssigned
    ? [String(createdBy)]
    : await _assertAssignees(body.assigneeIds, scope);
  const links = normalizeLinks(body.links, (msg) => new BadRequestError(msg));

  const files = body.files || [];
  if (files.length > ATTACHMENTS_MAX) {
    throw new BadRequestError(`Ko'pi bilan ${ATTACHMENTS_MAX} ta fayl biriktirish mumkin`);
  }
  if (settings.requireCreateAttachments && files.length === 0) {
    throw new BadRequestError("Topshiriqqa kamida bitta fayl biriktirish kerak");
  }
  const attachments = files.length ? await uploadAttachments(files) : [];

  let schedule;
  try {
    schedule = await prisma.taskSchedule.create({
      data: {
        title,
        description,
        assignees,
        attachments,
        links,
        penaltyPoints,
        ...rule,
        slots,
        leadDays,
        startDate,
        endDate,
        createdBy,
        selfAssigned,
      },
    });
  } catch (error) {
    await deleteAttachments(attachments);
    throw error;
  }

  // Darhol oldinga qarab yozamiz — natijasi javobda qaytadi
  const generated = await materializeSchedule(schedule);

  return _serialize(schedule, { generatedCount: generated.created });
};

/**
 * Tahrir. ⚠️ ALLAQACHON YARATILGAN TOPSHIRIQLAR O'ZGARMAYDI: ular mustaqil
 * fakt (`MonthlyInvoice` doktrinasi) — odam ularni ko'rgan, boshlagan
 * bo'lishi mumkin. Tahrir faqat KELAJAKDAGI hodisalarga ta'sir qiladi.
 */
const updateSchedule = async (id, body, userId, scope) => {
  const current = await prisma.taskSchedule.findUnique({ where: { id } });
  if (!current) throw new NotFoundError("Doimiy topshiriq topilmadi");
  _assertScheduleScope(current, scope, userId);

  // ⚠️ SHAXSIY DOIRADA IJROCHI VA JARIMA BALI YOPIQ (`updateTask` bilan
  // AYNI qoida): tahrir orqali qoida birovga o'tib ketmasin va 0 ball
  // o'z joyida qolsin.
  if (scope?.mode === taskScopeService.SCOPE_SELF) {
    if (body.assigneeIds !== undefined) {
      throw new ForbiddenError("O'ziga belgilagan doimiy ishning ijrochisini o'zgartirib bo'lmaydi");
    }
    if (body.penaltyPoints !== undefined) {
      throw new ForbiddenError("O'ziga belgilagan doimiy ishda jarima bali bo'lmaydi");
    }
  }

  const merged = {
    frequency: body.frequency ?? current.frequency,
    weekdays: body.weekdays ?? current.weekdays,
    monthDays: body.monthDays ?? current.monthDays,
    intervalDays: body.intervalDays ?? current.intervalDays,
    intervalMonths: body.intervalMonths ?? current.intervalMonths,
  };

  const settings = await getTaskSettings();
  const data = { ...(_assertRecurrence(merged)) };

  if (body.title !== undefined) {
    data.title = _text(body.title, {
      label: "Sarlavha",
      min: Math.max(1, settings.minTitleLength),
      max: TITLE_MAX,
    });
  }
  if (body.description !== undefined) {
    data.description = _text(body.description, {
      label: "Tavsif",
      min: settings.minDescriptionLength,
      max: DESCRIPTION_MAX,
    });
  }
  if (body.slots !== undefined) data.slots = _assertSlots(body.slots);
  if (body.leadDays !== undefined) {
    data.leadDays = _int(body.leadDays, { min: 0, max: MAX_LEAD_DAYS, label: "Eslatma kunlari" });
  }
  if (body.penaltyPoints !== undefined) {
    data.penaltyPoints = _int(body.penaltyPoints, {
      min: 1,
      max: settings.maxPenaltyPoints,
      label: "Jarima bali",
    });
  }
  if (body.startDate !== undefined) data.startDate = _day(body.startDate, "Boshlanish sanasi");
  if (body.endDate !== undefined) {
    data.endDate = body.endDate ? _day(body.endDate, "Tugash sanasi") : null;
  }
  if (body.links !== undefined) {
    data.links = normalizeLinks(body.links, (msg) => new BadRequestError(msg));
  }
  if (body.assigneeIds !== undefined) {
    data.assignees = await _assertAssignees(body.assigneeIds, scope);
  }

  // ⚠️ YANGI FAYLLAR QO'SHILADI (mavjudlari ustiga yozilmaydi): route
  // ularni qabul qilib, service e'tiborsiz qoldirsa, foydalanuvchi fayl
  // yukladim deb o'ylab, qoidada hech narsa o'zgarmagan bo'lardi.
  const files = body.files || [];
  let addedAttachments = [];
  if (files.length > 0) {
    const kept = Array.isArray(current.attachments) ? current.attachments : [];
    if (kept.length + files.length > ATTACHMENTS_MAX) {
      throw new BadRequestError(
        `Ko'pi bilan ${ATTACHMENTS_MAX} ta fayl biriktirish mumkin`,
      );
    }
    addedAttachments = await uploadAttachments(files);
    data.attachments = [...kept, ...addedAttachments];
  }

  const startDate = data.startDate ?? current.startDate;
  const endDate = data.endDate !== undefined ? data.endDate : current.endDate;
  if (endDate && endDate.getTime() < startDate.getTime()) {
    throw new BadRequestError("Tugash sanasi boshlanish sanasidan oldin bo'lmasligi kerak");
  }

  let updated;
  try {
    updated = await prisma.taskSchedule.update({ where: { id }, data });
  } catch (error) {
    // Yozuv bo'lmadi — yangi yuklangan fayllar yetim qolmasin
    await deleteAttachments(addedAttachments);
    throw error;
  }
  const generated = await materializeSchedule(updated);

  return _serialize(updated, { generatedCount: generated.created });
};

/** To'xtatish — o'chirish EMAS: yaratilgan topshiriqlar va sabab qoladi. */
const stopSchedule = async (id, { reason, userId }, scope) => {
  const schedule = await prisma.taskSchedule.findUnique({ where: { id } });
  if (!schedule) throw new NotFoundError("Doimiy topshiriq topilmadi");
  _assertScheduleScope(schedule, scope, userId);
  if (!schedule.isActive) throw new BadRequestError("Bu qoida allaqachon to'xtatilgan");

  const text = _text(reason, { label: "Sabab", min: 3, max: 500 });

  const updated = await prisma.taskSchedule.update({
    where: { id },
    data: { isActive: false, stoppedBy: userId, stopReason: text, stoppedAt: new Date() },
  });
  return _serialize(updated);
};

const resumeSchedule = async (id, userId, scope) => {
  const schedule = await prisma.taskSchedule.findUnique({ where: { id } });
  if (!schedule) throw new NotFoundError("Doimiy topshiriq topilmadi");
  _assertScheduleScope(schedule, scope, userId);
  if (schedule.isActive) throw new BadRequestError("Bu qoida allaqachon faol");

  const updated = await prisma.taskSchedule.update({
    where: { id },
    data: { isActive: true, stoppedBy: null, stopReason: null, stoppedAt: null },
  });
  const generated = await materializeSchedule(updated);
  return _serialize(updated, { generatedCount: generated.created });
};

/**
 * O'chirish — FAQAT hali birorta topshiriq yaratilmagan qoida uchun.
 *
 * ⚠️ Topshiriq yaratilgan bo'lsa qoida TO'XTATILADI: yozuvlar unga ishora
 * qiladi va "qaysi qoidadan keldi" degan savol javobsiz qolmasligi kerak
 * (`LessonSubstitution` bilan AYNI qaror: boshlanmagan reja o'chiriladi,
 * boshlangani bekor qilinadi).
 */
const deleteSchedule = async (id, userId, scope) => {
  const schedule = await prisma.taskSchedule.findUnique({ where: { id } });
  if (!schedule) throw new NotFoundError("Doimiy topshiriq topilmadi");
  _assertScheduleScope(schedule, scope, userId);

  const used = await prisma.task.count({ where: { scheduleId: id } });
  if (used > 0) {
    throw new BadRequestError(
      `Bu qoida bo'yicha ${used} ta topshiriq yaratilgan — uni o'chirib bo'lmaydi, to'xtating`,
    );
  }

  await prisma.taskSchedule.delete({ where: { id } });
  await deleteAttachments(schedule.attachments || []);
  return { id };
};

// ─── O'QISH ───────────────────────────────────────────────────────

const _assertScheduleScope = (schedule, scope, userId) => {
  if (!scope) return;

  // SHAXSIY YO'L: qoida shu odamning O'ZIGA belgilagani bo'lishi shart.
  // ⚠️ IKKI SHART BIRGA (`taskScope.service.js` dagi `isInScope` bilan
  // AYNI mulohaza): faqat `createdBy` bo'yicha tekshirilsa, rahbar o'zi
  // yaratgan ODDIY qoidani shaxsiy yo'ldan tahrirlab, jarima balini
  // chetlab o'tib yuborardi.
  if (scope.mode === taskScopeService.SCOPE_SELF) {
    const mine =
      schedule.selfAssigned === true && String(schedule.createdBy) === String(userId);
    if (!mine) {
      throw new ForbiddenError("Bu sizning o'zingizga belgilagan doimiy ishingiz emas");
    }
    return;
  }

  if (scope.mode !== taskScopeService.SCOPE_TEAM) return;
  const mine =
    String(schedule.createdBy) === String(userId) ||
    schedule.assignees.some((a) => scope.memberIds.includes(String(a)));
  if (!mine) {
    throw new BadRequestError("Bu qoida sizning bo'limingizga tegishli emas");
  }
};

const listSchedules = async (req, scope, { selfAssigned = false } = {}) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { status, search } = req.query;

  // ⚠️ IKKI OQIM ARALASHMAYDI (`task.service.js` dagi `_buildListFilter`
  // bilan AYNI sabab): rahbar bergan doimiy ishlar va xodim o'ziga
  // belgilagan doimiy ishlari har doim alohida ro'yxat.
  const filter = { selfAssigned };
  if (status === "active") filter.isActive = true;
  if (status === "stopped") filter.isActive = false;
  if (search && String(search).trim()) {
    filter.title = { contains: String(search).trim(), mode: "insensitive" };
  }

  // Shaxsiy yo'l: faqat o'zi yaratganlari (oqim filtri allaqachon
  // `selfAssigned: true` ni qo'ygan)
  if (scope?.mode === taskScopeService.SCOPE_SELF) {
    filter.createdBy = String(req.user.id);
  }

  // Rahbar — o'z bo'limi: o'zi yaratgan yoki a'zolariga berilgan qoidalar
  const where =
    scope?.mode === taskScopeService.SCOPE_TEAM
      ? {
          AND: [
            filter,
            {
              OR: [
                { createdBy: req.user.id },
                ...(scope.memberIds.length
                  ? [{ assignees: { hasSome: scope.memberIds } }]
                  : []),
              ],
            },
          ],
        }
      : filter;

  const [rows, total] = await Promise.all([
    prisma.taskSchedule.findMany({
      where,
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
      include: { _count: { select: { tasks: true } } },
    }),
    prisma.taskSchedule.count({ where }),
  ]);

  // Ijrochi va yaratuvchi ismlari — soft ref, qo'lda yuklanadi
  const userIds = [...new Set(rows.flatMap((r) => [...r.assignees, r.createdBy]))];
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, firstName: true, lastName: true, role: true },
      })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));

  const data = rows.map(({ _count, ...row }) =>
    _serialize(row, {
      generatedCount: _count.tasks,
      assigneeUsers: row.assignees.map((id) => byId.get(id) || null).filter(Boolean),
      createdByUser: byId.get(row.createdBy) || null,
    }),
  );

  return formatPaginationResponse(data, total, page, limit);
};

// ─── TOPSHIRIQ YARATISH (pass) ────────────────────────────────────

/**
 * Bitta qoida bo'yicha oldinga qarab topshiriq yozadi.
 *
 * Oyna: BUGUNDAN `leadDays` keyingacha. ⚠️ O'TGAN hodisalar yozilmaydi:
 * server bir kun o'chiq turgan bo'lsa, kechagi hodisani bugun yozish
 * xodimga darhol muddati o'tgan ("bajarilmadi") topshiriq va jarima
 * berardi — holbuki u aybdor emas.
 *
 * @param {object} schedule
 * @param {Date} [today]
 * @returns {Promise<{ created: number, skipped: number }>}
 */
const materializeSchedule = async (schedule, today = getTashkentDateUtc(0)) => {
  if (!schedule.isActive) return { created: 0, skipped: 0 };

  const until = addDays(today, schedule.leadDays);
  const days = occurrencesInRange(schedule, today, until);
  if (days.length === 0) return { created: 0, skipped: 0 };

  // ⚠️ ARXIVLANGANGA YOZILMAYDI. Ro'yxat qoida yaratilganda tekshirilgan,
  // lekin odam keyin ketishi mumkin: tekshiruvsiz qoida arxivlangan
  // xodimga har hafta topshiriq va JARIMA yozib turardi — u esa tizimga
  // kira olmaydi, ya'ni uni yopa ham olmaydi.
  const liveAssignees = schedule.assignees.length
    ? (
        await prisma.user.findMany({
          where: { id: { in: schedule.assignees }, isArchived: false },
          select: { id: true },
        })
      ).map((u) => u.id)
    : [];
  if (liveAssignees.length === 0) return { created: 0, skipped: 0 };

  // ⚠️ ALLAQACHON YOZILGANLARINI OLDINDAN O'QIYMIZ. Yagona indeksga
  // tayanib xatoni ushlash ham ishlardi, lekin Prisma har bunday urinishni
  // XATO deb logga yozadi: kunlik pass log'ni kutilgan "xato"lar bilan
  // to'ldirib, haqiqiy muammoni ko'rinmas qilib qo'yardi.
  const existing = await prisma.task.findMany({
    where: { scheduleId: schedule.id, occurrenceDate: { in: days } },
    select: { assignee: true, occurrenceDate: true, occurrenceSlot: true },
  });
  // Kalit — KUN + VAQT + ODAM: bir kunda bir nechta oyna bo'lishi mumkin
  const done = new Set(
    existing.map(
      (t) => `${t.occurrenceDate.toISOString().slice(0, 10)}|${t.occurrenceSlot}|${t.assignee}`,
    ),
  );

  let created = 0;
  let skipped = 0;
  const now = new Date();

  const slots = slotsOf(schedule);

  for (const day of days) {
    const dayKey = day.toISOString().slice(0, 10);

    // ⚠️ HAR OYNA O'Z TOPSHIRIG'INI BERADI: "har kuni 09:00 va 15:00"
    // qoidasida bir kunga ikkita alohida topshiriq yoziladi, har birining
    // o'z muddati, natijasi va jarimasi bilan.
    for (const slot of slots) {
      const pending = liveAssignees.filter((id) => !done.has(`${dayKey}|${slot.due}|${id}`));
      skipped += liveAssignees.length - pending.length;
      if (pending.length === 0) continue;

      const window = buildWindow(slot, day);

      // ⚠️ MUDDATI ALLAQACHON O'TGAN OYNA YOZILMAYDI. Bugungi kun oynaga
      // kiradi, lekin uning soati o'tib ketgan bo'lishi mumkin: "har kuni
      // 09:00" qoidasi soat 14:00 da yaratilsa (yoki qayta yoqilsa), xodim
      // o'sha zahoti MUDDATI O'TGAN topshiriq va soatlik cron'dan AVTOMAT
      // JARIMA olardi — ko'rmagan ishi uchun. Kun ichidagi keyingi oyna
      // (masalan 15:00) baribir yoziladi.
      if (window.dueDate.getTime() <= now.getTime()) {
        skipped += pending.length;
        continue;
      }

      const rows = await taskService.writeTaskRows({
        assigneeIds: pending,
      createdBy: schedule.createdBy,
        // ⚠️ Har qator ALOHIDA: pass kuniga bir necha marta ishlashi mumkin
        // (cron + startup) va bitta buzuq qator qolganlarini to'smasligi
        // kerak. `skipDuplicates` — poyga uchun ZAXIRA qavat: ikki pass bir
        // vaqtda ishlasa, yagona indeks ikkinchisini to'xtatadi.
        atomic: false,
        skipDuplicates: true,
        fields: {
          title: schedule.title,
          description: schedule.description,
          startDate: window.startDate,
          dueDate: window.dueDate,
          // Doimiy topshiriq — ASOSIY tur (biznes qarori)
          kind: "main",
          links: schedule.links,
          attachments: schedule.attachments,
          penaltyPoints: schedule.penaltyPoints,
          scheduleId: schedule.id,
          occurrenceDate: day,
          occurrenceSlot: slot.due,
          // ⚠️ OQIM QOIDADAN TOPSHIRIQQA KO'CHADI: shaxsiy qoidadan
          // yozilgan topshiriq ham shaxsiy oqimda qoladi — jarimasiz,
          // o'zi yopiladigan va Lavozimlar markazi ro'yxatiga
          // tushmaydigan.
          selfAssigned: schedule.selfAssigned,
        },
      });

      if (rows.length > 0) {
        created += rows.length;
        // Yaratilishning O'ZI eslatma — xodimga push boradi.
        // ⚠️ SHAXSIY QOIDADA PUSH BOR va bu to'g'ri: odam qoidani bir
        // marta yozgan, topshiriq esa keyin — ertalab paydo bo'lgan ishni
        // u boshqa yo'l bilan bilmaydi. Qo'lda yozilgan shaxsiy topshiriqda
        // esa push yo'q (`task.service.js` — odam shu zahoti formadan
        // chiqdi).
        taskService.notifyAssignees(TASK_PUSH_EVENTS.CREATED, rows);
      }
    }
  }

  if (created > 0) {
    await prisma.taskSchedule.update({
      where: { id: schedule.id },
      data: { lastRunDate: days[days.length - 1] },
    });
  }

  return { created, skipped };
};

/**
 * KUNLIK PASS — barcha faol qoidalar bo'yicha oldinga qarab topshiriq
 * yozadi. Cron ham, server startupi ham shuni chaqiradi.
 *
 * @param {Date} [today] - sinov va qo'lda qayta ishga tushirish uchun;
 *   odatda berilmaydi va bugungi Toshkent kuni olinadi.
 */
const runSchedulePass = async (today = getTashkentDateUtc(0)) => {
  const schedules = await prisma.taskSchedule.findMany({
    where: {
      isActive: true,
      startDate: { lte: addDays(today, MAX_LEAD_DAYS) },
      OR: [{ endDate: null }, { endDate: { gte: today } }],
    },
  });

  let created = 0;
  let failed = 0;

  for (const schedule of schedules) {
    try {
      const result = await materializeSchedule(schedule, today);
      created += result.created;
    } catch (error) {
      failed += 1;
      // ⚠️ Bitta buzuq qoida butun passni to'xtatmaydi
      logger.error(
        `[TaskSchedule] "${schedule.title}" (${schedule.id}) bo'yicha yozib bo'lmadi: ${error.message}`,
      );
    }
  }

  return { schedules: schedules.length, created, failed };
};

module.exports = {
  createSchedule,
  updateSchedule,
  stopSchedule,
  resumeSchedule,
  deleteSchedule,
  listSchedules,
  materializeSchedule,
  runSchedulePass,
};
