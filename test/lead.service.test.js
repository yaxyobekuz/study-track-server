const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * LIDLAR (Sotuvlar) — kiritish, zinapoya va funnel.
 *
 * `lead.service` haqiqiy kodi, baza soxta. Eng muhim qoidalar:
 * kiritishda FAQAT ism+familiya+telefon majburiy, pog'onaga yetish
 * MONOTON yoziladi, chiqib ketishda sabab majburiy va funnel
 * "YETGANLAR" ni sanaydi (joriy holatni emas).
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const STAFF = "a".repeat(24);
const TEACHER = "b".repeat(24);
const STUDENT = "c".repeat(24);

const USERS = [
  { id: STAFF, firstName: "Qabulxona", lastName: "Xodimi", role: "reception", isArchived: false },
  { id: TEACHER, firstName: "Dildora", lastName: "Nurmatova", role: "teacher", isArchived: false },
  { id: STUDENT, firstName: "O'quvchi", lastName: "Bir", role: "student", isArchived: false },
];

const cmp = (value, cond) => {
  if (cond === undefined) return true;
  if (cond === null) return value == null;
  if (cond instanceof Date) return value?.getTime() === cond.getTime();
  if (typeof cond !== "object") return value === cond;
  if ("not" in cond) return cond.not === null ? value != null : value !== cond.not;
  if ("in" in cond) return cond.in.includes(value);
  if ("contains" in cond) {
    return String(value ?? "").toLowerCase().includes(String(cond.contains).toLowerCase());
  }
  const num = (v) => (v instanceof Date ? v.getTime() : v);
  return (
    (cond.gt === undefined || num(value) > num(cond.gt)) &&
    (cond.gte === undefined || num(value) >= num(cond.gte)) &&
    (cond.lt === undefined || num(value) < num(cond.lt)) &&
    (cond.lte === undefined || num(value) <= num(cond.lte))
  );
};
const matches = (row, where = {}) =>
  Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return cond.some((c) => matches(row, c));
    return cmp(row[key], cond);
  });

let db;
let seq;
const resetDb = () => {
  db = { leads: [], events: [], activities: [] };
  seq = 0;
};
const nextId = () => String(++seq).padStart(24, "0");

const groupCount = (rows, key) => {
  const byKey = new Map();
  for (const row of rows) {
    const k = row[key] ?? null;
    byKey.set(k, (byKey.get(k) ?? 0) + 1);
  }
  return [...byKey.entries()].map(([value, count]) => ({
    [key]: value,
    _count: { _all: count },
  }));
};

const prisma = {
  lead: {
    findUnique: async ({ where }) => db.leads.find((l) => l.id === where.id) ?? null,
    findFirst: async ({ where }) => db.leads.find((l) => matches(l, where)) ?? null,
    findMany: async ({ where = {} }) => {
      // `stageEvents: { some: { stage } }` — relation filtri
      const stageCond = where.stageEvents?.some?.stage;
      const plain = { ...where };
      delete plain.stageEvents;
      return db.leads.filter(
        (l) =>
          matches(l, plain) &&
          (stageCond === undefined ||
            db.events.some((e) => e.leadId === l.id && e.stage === stageCond)),
      );
    },
    count: async ({ where = {} }) => (await prisma.lead.findMany({ where })).length,
    create: async ({ data }) => {
      const row = { id: nextId(), createdAt: new Date(), lostReason: null, ...data };
      db.leads.push(row);
      return { ...row };
    },
    update: async ({ where, data }) => {
      const row = db.leads.find((l) => l.id === where.id);
      Object.assign(row, data);
      return { ...row };
    },
    delete: async ({ where }) => {
      db.leads = db.leads.filter((l) => l.id !== where.id);
      // FK `onDelete: Cascade` — bolalar ham ketadi
      db.events = db.events.filter((e) => e.leadId !== where.id);
      db.activities = db.activities.filter((a) => a.leadId !== where.id);
    },
    deleteMany: async () => ({ count: 0 }),
    groupBy: async ({ by, where = {} }) => {
      const rows = await prisma.lead.findMany({ where });
      return groupCount(rows, by[0]);
    },
  },
  leadStageEvent: {
    findMany: async ({ where, orderBy }) => {
      let rows = db.events.filter((e) => matches(e, where));
      if (orderBy?.stage === "asc") rows = [...rows].sort((a, b) => a.stage - b.stage);
      return rows.map((r) => ({ ...r }));
    },
    createMany: async ({ data, skipDuplicates }) => {
      let count = 0;
      for (const row of data) {
        const exists = db.events.some((e) => e.leadId === row.leadId && e.stage === row.stage);
        if (exists) {
          // `(leadId, stage)` unique — bir pog'onaga bir marta yetiladi
          if (skipDuplicates) continue;
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        db.events.push({ backfilled: false, note: "", ...row });
        count += 1;
      }
      return { count };
    },
    groupBy: async ({ by, where = {} }) => {
      const leadWhere = where.lead ?? {};
      const leads = await prisma.lead.findMany({ where: leadWhere });
      const ids = new Set(leads.map((l) => l.id));
      const rows = db.events.filter((e) => ids.has(e.leadId));
      return groupCount(rows, by[0]);
    },
  },
  leadActivity: {
    create: async ({ data }) => {
      const row = { id: nextId(), createdAt: new Date(), ...data };
      db.activities.push(row);
      return row;
    },
    findMany: async ({ where }) => db.activities.filter((a) => matches(a, where)),
  },
  // Kataloglar: `attachLeadRefs` `findMany` bilan, tekshiruv `findUnique` bilan
  leadSource: {
    findUnique: async ({ where }) => (where.id === "src" ? { id: "src", name: "Instagram" } : null),
    findMany: async ({ where }) =>
      (where.id?.in ?? []).includes("src") ? [{ id: "src", name: "Instagram" }] : [],
  },
  leadDirection: { findUnique: async () => null, findMany: async () => [] },
  leadCategory: { findUnique: async () => null, findMany: async () => [] },
  user: {
    findMany: async ({ where }) => USERS.filter((u) => matches(u, where)),
  },
  $transaction: async (arg) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg)),
  $queryRawUnsafe: async () => [],
};

fakeModule("../src/config/prisma", prisma);

const svc = require("../src/services/lead.service");

const create = (overrides = {}) =>
  svc.createLead(
    { firstName: "Ali", lastName: "Valiyev", phone: "901112233", ...overrides },
    STAFF,
  );

/* ───────────────────────────── KIRITISH ───────────────────────────── */

test("kiritish: FAQAT ism + familiya + telefon majburiy", async () => {
  resetDb();

  // ⚠️ Ilgari manba/yo'nalish/toifa ham talab qilinardi va qabulxona
  // formasi ularni yubormagani uchun yaratish 400 bilan yiqilardi.
  const lead = await create();
  assert.equal(lead.firstName, "Ali");
  assert.equal(lead.source, null);
  assert.equal(lead.direction, null);
  assert.equal(lead.status, "new");

  for (const bad of [{ firstName: "" }, { lastName: "" }, { phone: "" }, { phone: "   " }]) {
    await assert.rejects(() => create(bad), /majburiy/);
  }
});

test("kiritish: kelgan maktabi va ikkita qo'shimcha raqam saqlanadi", async () => {
  resetDb();
  const lead = await create({
    previousSchema: "e'tiborsiz",
    previousSchool: "12-maktab",
    additionalPhone: "935550001",
    parentPhone: "+998 93 555 00 02",
  });

  assert.equal(lead.previousSchool, "12-maktab");
  // ⚠️ RAQAM BITTA SHAKLDA saqlanadi, aks holda qidiruv ishonchsiz bo'lardi
  assert.equal(lead.additionalPhone, "+998935550001");
  assert.equal(lead.parentPhone, "+998935550002");
  assert.equal(lead.phone, "+998901112233");
});

test("kiritish: tanilmagan raqam RAD ETILMAYDI, borligicha saqlanadi", async () => {
  resetDb();
  // ⚠️ Chet el raqami (998 bilan boshlanmaydi) TANILMAYDI — lekin lid
  // baribir ro'yxatga olinadi, aks holda bola shu bilan yo'qolardi.
  const foreign = await create({ phone: "+7 495 123 45 67" });
  assert.equal(foreign.phone, "+7 495 123 45 67");

  // Toshkent shahar raqami esa 9 raqam — u TANILADI va bir shaklga keladi
  const landline = await create({ phone: "71 200 00 00" });
  assert.equal(landline.phone, "+998712000000");
});

test("kiritish: 'kim olib keldi' sukut bo'yicha kiritgan odam", async () => {
  resetDb();
  const auto = await create();
  assert.equal(auto.broughtBy?.id, STAFF);

  const explicit = await create({ broughtBy: TEACHER, assignedTo: TEACHER });
  assert.equal(explicit.broughtBy?.id, TEACHER);
  assert.equal(explicit.assignedTo?.id, TEACHER);
});

test("kiritish: O'QUVCHI 'olib keldi' yoki 'mas'ul' bo'lolmaydi", async () => {
  resetDb();
  await assert.rejects(() => create({ assignedTo: STUDENT }), /Xodim topilmadi/);
  await assert.rejects(() => create({ broughtBy: STUDENT }), /Xodim topilmadi/);
  await assert.rejects(() => create({ assignedTo: "qisqa" }), /yaroqsiz/);
  assert.equal(db.leads.length, 0, "xato kiritishda lid yozilmaydi");
});

test("kiritish: yo'q manba rad etiladi, bo'sh manba — yo'q", async () => {
  resetDb();
  await assert.rejects(() => create({ source: "f".repeat(24) }), /Manba topilmadi/);
  const ok = await create({ source: "src" });
  assert.equal(ok.source?.name, "Instagram");
});

/* ───────────────────────────── ZINAPOYA ───────────────────────────── */

test("zinapoya: pog'ona belgilanganda ostidagilari ham yoziladi", async () => {
  resetDb();
  const lead = await create();

  // Bir qadam: 3-pog'ona → 1, 2, 3 yoziladi
  const visited = await svc.updateLeadStatus(lead.id, "visited", null, null, STAFF);
  assert.equal(visited.stage, 3);
  assert.equal(db.events.filter((e) => e.leadId === lead.id).length, 3);

  // Yana oldinga: faqat yangi pog'onalar qo'shiladi (takror yo'q)
  const enrolled = await svc.updateLeadStatus(lead.id, "enrolled", null, null, STAFF);
  assert.equal(enrolled.stage, 6);
  assert.equal(enrolled.isEnrolled, true);
  const stages = db.events.filter((e) => e.leadId === lead.id).map((e) => e.stage).sort();
  assert.deepEqual(stages, [1, 2, 3, 4, 5, 6]);
});

test("zinapoya: ortga qaytish TARIXNI O'CHIRMAYDI", async () => {
  resetDb();
  const lead = await create();
  await svc.updateLeadStatus(lead.id, "attended", null, null, STAFF);

  // Chiqib ketdi — yetgan pog'onalar joyida qoladi
  const lost = await svc.updateLeadStatus(lead.id, "lost", null, "Kelmay qo'ydi", STAFF);
  assert.equal(lost.isExited, true);
  assert.equal(lost.lostReason, "Kelmay qo'ydi");
  assert.equal(db.events.filter((e) => e.leadId === lead.id).length, 4);

  // Qaytib kelsa "yo'qoldi" izi tozalanadi
  const back = await svc.updateLeadStatus(lead.id, "liked", null, null, STAFF);
  assert.equal(back.lostReason, null);
  assert.equal(back.stage, 5);
});

test("zinapoya: chiqib ketishda SABAB majburiy, noto'g'ri holat rad etiladi", async () => {
  resetDb();
  const lead = await create();
  for (const status of ["lost", "rejected", "postponed"]) {
    await assert.rejects(() => svc.updateLeadStatus(lead.id, status, null, "  ", STAFF), /sababi majburiy/);
  }
  await assert.rejects(() => svc.updateLeadStatus(lead.id, "allaqanday", null, null, STAFF), /Noto'g'ri holat/);
  await assert.rejects(() => svc.updateLeadStatus(lead.id, null, null, null, STAFF), /majburiy/);
});

test("zinapoya tarixi: yetmagan pog'ona 'yetgan, vaqti noma'lum' dan ajratiladi", async () => {
  resetDb();
  const lead = await create();
  await svc.updateLeadStatus(lead.id, "trial", null, null, STAFF);

  const detail = await svc.getLeadById(lead.id);
  assert.equal(detail.stageTimeline.length, 6);
  assert.deepEqual(
    detail.stageTimeline.map((t) => t.reached),
    [true, true, false, false, false, false],
  );
  assert.ok(detail.stageTimeline[0].reachedAt instanceof Date);
  assert.equal(detail.stageTimeline[2].reachedAt, null);
  assert.equal(detail.stageTimeline[2].approximate, false);
});

/* ───────────────────────────── FUNNEL ───────────────────────────── */

test("funnel: YETGANLAR sanaladi, joriy holat EMAS", async () => {
  resetDb();

  // 4 lid: biri qabul qilindi, biri darsga kirib yo'qoldi,
  // biri sinovga yozildi, biri hali yangi
  const a = await create({ firstName: "Qabul" });
  await svc.updateLeadStatus(a.id, "enrolled", null, null, STAFF);

  const b = await create({ firstName: "Yo'qoldi", assignedTo: TEACHER });
  await svc.updateLeadStatus(b.id, "attended", null, null, STAFF);
  await svc.updateLeadStatus(b.id, "lost", null, "Kelmay qo'ydi", STAFF);

  const c = await create({ firstName: "Yozildi" });
  await svc.updateLeadStatus(c.id, "trial", null, null, STAFF);

  await create({ firstName: "Yangi" });

  const funnel = await svc.getConversionFunnel({});

  assert.equal(funnel.totalLeads, 4);
  assert.equal(funnel.enrolled, 1);
  assert.equal(funnel.conversion, 25);

  // ⚠️ To'lov qilgan lid 1-pog'onada ham sanaladi (monotonlik), ya'ni
  // raqamlar pastga qarab faqat KAMAYADI
  const reached = funnel.pipeline.map((r) => r.reached);
  assert.deepEqual(reached, [3, 3, 2, 2, 1, 1]);
  for (let i = 1; i < reached.length; i += 1) {
    assert.ok(reached[i] <= reached[i - 1], "funnel teskari bo'lib ketdi");
  }

  // Yo'qotish aynan qaysi qadamda bo'lgani
  assert.equal(funnel.pipeline[0].lostCount, 1, "1 ta lid hali qiziqish bildirmagan");
  assert.equal(funnel.pipeline[2].lostCount, 1, "1 tasi sinovga yozilib kelmagan");
  assert.equal(funnel.pipeline[4].lostCount, 1, "1 tasi darsga kirib yo'qolgan");

  // Chiqishlar va hozirgi navbat alohida
  assert.equal(funnel.exits.find((e) => e.status === "lost").count, 1);
  assert.equal(funnel.current.find((r) => r.stage === 0).count, 1);
  assert.equal(funnel.current.find((r) => r.stage === 2).count, 1);
});

test("funnel: 'kim olib keldi' bo'yicha toraytiriladi", async () => {
  resetDb();
  const mine = await create({ broughtBy: STAFF });
  await svc.updateLeadStatus(mine.id, "enrolled", null, null, STAFF);
  await create({ broughtBy: TEACHER });

  const forStaff = await svc.getConversionFunnel({ broughtBy: STAFF });
  assert.equal(forStaff.totalLeads, 1);
  assert.equal(forStaff.conversion, 100);

  const forTeacher = await svc.getConversionFunnel({ broughtBy: TEACHER });
  assert.equal(forTeacher.totalLeads, 1);
  assert.equal(forTeacher.enrolled, 0);
});

test("funnel: lid yo'q bo'lsa nolga bo'linmaydi", async () => {
  resetDb();
  const funnel = await svc.getConversionFunnel({});
  assert.equal(funnel.totalLeads, 0);
  assert.equal(funnel.conversion, 0);
  assert.deepEqual(funnel.pipeline.map((r) => r.reached), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(funnel.pipeline.map((r) => r.dropOff), [0, 0, 0, 0, 0, 0]);
});

/* ───────────────────────── RO'YXAT VA FILTR ───────────────────────── */

test("ro'yxat: pog'ona filtri 'YETGANLAR' bo'yicha", async () => {
  resetDb();
  const a = await create({ firstName: "Qabul" });
  await svc.updateLeadStatus(a.id, "enrolled", null, null, STAFF);
  const b = await create({ firstName: "Yozildi" });
  await svc.updateLeadStatus(b.id, "trial", null, null, STAFF);

  // 3-pog'onaga (keldi) faqat qabul qilingani yetgan
  const reachedVisited = await svc.getAllLeads({ stage: 3 });
  assert.deepEqual(reachedVisited.leads.map((l) => l.firstName), ["Qabul"]);

  // 2-pog'onaga ikkisi ham
  const reachedTrial = await svc.getAllLeads({ stage: 2 });
  assert.equal(reachedTrial.leads.length, 2);

  // Holat filtri BOSHQA savol: hozir "trial" da turgan bittasi
  const nowTrial = await svc.getAllLeads({ status: "trial" });
  assert.deepEqual(nowTrial.leads.map((l) => l.firstName), ["Yozildi"]);
});

test("qidiruv: maktab va formatlangan raqam bo'yicha topiladi", async () => {
  resetDb();
  await create({ firstName: "Olim", previousSchool: "12-maktab", additionalPhone: "935550001" });

  assert.equal((await svc.getAllLeads({ search: "12-maktab" })).leads.length, 1);
  assert.equal((await svc.getAllLeads({ search: "935550001" })).leads.length, 1);
  // Formatlangan holda ko'chirib qo'yilgan raqam ham topiladi
  assert.equal((await svc.getAllLeads({ search: "+998 93 555 00 01" })).leads.length, 1);
  assert.equal((await svc.getAllLeads({ search: "Olim" })).leads.length, 1);
  assert.equal((await svc.getAllLeads({ search: "yo'q" })).leads.length, 0);
});

test("o'chirish: pog'ona tarixi ham ketadi (cascade)", async () => {
  resetDb();
  const lead = await create();
  await svc.updateLeadStatus(lead.id, "visited", null, null, STAFF);
  assert.equal(db.events.length, 3);

  await svc.deleteLead(lead.id);
  assert.equal(db.leads.length, 0);
  assert.equal(db.events.length, 0);
  await assert.rejects(() => svc.deleteLead(lead.id), /topilmadi/);
});

test("tahrirlash: bo'sh satr maydonni TOZALAYDI", async () => {
  resetDb();
  const lead = await create({ previousSchool: "12-maktab" });
  const cleared = await svc.updateLead(lead.id, { previousSchool: "" });
  assert.equal(cleared.previousSchool, null);

  // Holat `updateLead` orqali O'ZGARMAYDI (faqat `updateLeadStatus`)
  await svc.updateLead(lead.id, { status: "enrolled" });
  assert.equal((await prisma.lead.findUnique({ where: { id: lead.id } })).status, "new");
});
