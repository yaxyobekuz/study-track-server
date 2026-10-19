const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * SERTIFIKAT REJASINI TAHRIRLASH — MUDDAT va YO'NALISH.
 *
 * Qamrov aynan "jim buziladigan" qoidalarga qaratilgan:
 *
 *   · muddat O'SHA QATORDA o'zgaradi (id saqlanadi) — tarix shishmaydi;
 *   · yo'nalish o'zgarganda ALMASHTIRISH bo'ladi: eski qator
 *     `superseded` bo'lib qoladi, yangisi yoziladi;
 *   · ⚠️ ESKI QATORDA FORMA VAQTI QOLADI — importning idempotentlik
 *     kaliti `(o'quvchi, yo'nalish, forma vaqti)`. Qator JOYIDA
 *     ko'chirilsa eski kalit bo'shab, ayni faylni qayta yuklash admin
 *     tuzatgan yo'nalishni QAYTA TIKLARDI;
 *   · yangi qatorda forma vaqti YO'Q va manba "qo'lda" — u endi forma
 *     javobi emas, odamning qarori;
 *   · band yo'nalishga ko'chirish RAD ETILADI (aks holda o'sha slotdagi
 *     ikkinchi reja jimgina almashtirilib yo'qolardi);
 *   · bekor qilingan / topshirilgan rejani tahrirlab bo'lmaydi.
 */

process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db?schema=public";

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

// ⚠️ 24-hex ObjectId: prefiks ham HEX bo'lishi kerak, aks holda
// `isValidId` qatorni "noto'g'ri tanlov" deb rad etadi
const id = (prefix) => prefix.padEnd(24, "0");

const STUDENT = id("51");
const ACTOR = id("a1");
const TRACK_A = id("1a");
const TRACK_B = id("1b");
const PLAN = id("e1");
const OTHER_PLAN = id("e2");

const SUBMITTED = new Date("2026-09-29T05:24:24.000Z");

const db = { plans: [], tracks: [], created: [] };

const trackOf = (trackId) => db.tracks.find((t) => t.id === trackId) ?? null;

const shapeTrack = (trackId) => {
  const track = trackOf(trackId);
  return track
    ? { id: track.id, name: track.name, subjectId: null, isActive: track.isActive, subject: null }
    : null;
};

const withTrack = (plan) => (plan ? { ...plan, track: shapeTrack(plan.trackId) } : null);

const tx = {
  certificatePlan: {
    findUnique: async ({ where }) => {
      if (where.activeKey !== undefined) {
        return withTrack(db.plans.find((p) => p.activeKey === where.activeKey) ?? null);
      }
      return withTrack(db.plans.find((p) => p.id === where.id) ?? null);
    },
    updateMany: async ({ where, data }) => {
      const rows = db.plans.filter(
        (p) => p.id === where.id && (!where.status || p.status === where.status),
      );
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    },
    update: async ({ where, data }) => {
      const row = db.plans.find((p) => p.id === where.id);
      Object.assign(row, data);
      return withTrack(row);
    },
    create: async ({ data }) => {
      const row = { id: id("beef"), ...data };
      db.plans.push(row);
      db.created.push(row);
      return { id: row.id };
    },
  },
};

fakeModule("../src/config/prisma", {
  ...tx,
  $transaction: async (fn) => fn(tx),
  certificateTrack: {
    findUnique: async ({ where }) => trackOf(where.id),
  },
  user: {
    findUnique: async () => ({
      id: STUDENT,
      firstName: "Ali",
      lastName: "Valiyev",
      username: "ali",
      classes: [],
    }),
  },
  userClass: { findMany: async () => [] },
  topic: { findMany: async () => [] },
});

// Mavzu progressi — alohida test mavzusi; bu yerda hisobdan chiqariladi
fakeModule("../src/services/certificateProgress.service", {
  loadProgressForPlans: async () => new Map(),
  progressKey: (studentId, subjectId) => `${studentId}|${subjectId ?? ""}`,
});

fakeModule("../src/services/tutorGroup.service", {
  assertMyGroupClass: async () => [],
});

const planService = require("../src/services/certificatePlan.service");

function reset() {
  db.tracks = [
    { id: TRACK_A, name: "Ona tili", isActive: true },
    { id: TRACK_B, name: "Matematika", isActive: true },
  ];
  db.plans = [
    {
      id: PLAN,
      studentId: STUDENT,
      trackId: TRACK_A,
      dueDate: new Date("2026-12-01T00:00:00.000Z"),
      status: "planned",
      submittedAt: SUBMITTED,
      note: "O'quvchining izohi",
      source: "import",
      sourceName: "Valiyev Ali",
      sourceGroup: "IT 1",
      activeKey: `${STUDENT}|${TRACK_A}`,
    },
  ];
  db.created = [];
}

/* ─────────────────── MUDDAT — O'SHA QATORDA ─────────────────── */

test("muddat surilganda AYNI qator yangilanadi, tarix shishmaydi", async () => {
  reset();

  const result = await planService.updatePlan(
    PLAN,
    { dueDate: "2027-05-10" },
    { actorId: ACTOR },
  );

  assert.equal(result.id, PLAN, "id o'zgarmaydi");
  assert.equal(db.plans.length, 1, "yangi qator yozilmaydi");
  assert.equal(db.plans[0].dueDate.toISOString().slice(0, 10), "2027-05-10");
  assert.equal(db.plans[0].status, "planned");
  assert.equal(db.plans[0].submittedAt, SUBMITTED, "forma vaqti joyida");
});

test("muddatni BO'SHATISH mumkin — \"aniq sanani bilmayman\"", async () => {
  reset();

  await planService.updatePlan(PLAN, { dueDate: null }, { actorId: ACTOR });

  assert.equal(db.plans[0].dueDate, null);
  assert.equal(db.plans.length, 1);
});

test("AYNI yo'nalish yuborilsa almashtirish BO'LMAYDI", async () => {
  reset();

  const result = await planService.updatePlan(
    PLAN,
    { trackId: TRACK_A, dueDate: "2027-01-15" },
    { actorId: ACTOR },
  );

  assert.equal(result.id, PLAN);
  assert.equal(db.plans.length, 1, "bekordan-bekor yangi qator yozilmaydi");
});

/* ─────────────────── YO'NALISH — ALMASHTIRISH ─────────────────── */

test("yo'nalish o'zgarganda eski qator SUPERSEDED bo'lib QOLADI", async () => {
  reset();

  const result = await planService.updatePlan(
    PLAN,
    { trackId: TRACK_B },
    { actorId: ACTOR },
  );

  const old = db.plans.find((p) => p.id === PLAN);
  assert.equal(old.status, "superseded");
  assert.equal(old.activeKey, null, "faol kalit bo'shaydi");
  assert.ok(old.supersededAt instanceof Date);
  assert.equal(old.trackId, TRACK_A, "eski qator o'z yo'nalishida qoladi");

  assert.equal(db.created.length, 1, "yangi qator yoziladi");
  assert.notEqual(result.id, PLAN, "javobda YANGI qator");
});

test("⚠️ ESKI QATORDA FORMA VAQTI QOLADI — import idempotentligi", async () => {
  reset();

  await planService.updatePlan(PLAN, { trackId: TRACK_B }, { actorId: ACTOR });

  const old = db.plans.find((p) => p.id === PLAN);
  // Importning kaliti `(o'quvchi, yo'nalish, forma vaqti)`. Shu uchlik eski
  // qatorda qolgani uchun ayni faylni qayta yuklash "Ona tili" ni QAYTA
  // TIKLAMAYDI — qator JOYIDA ko'chirilsa aynan shunday bo'lardi.
  assert.equal(old.submittedAt, SUBMITTED);
  assert.equal(old.trackId, TRACK_A);
});

test("yangi qatorda forma vaqti YO'Q, manba — qo'lda", async () => {
  reset();

  await planService.updatePlan(PLAN, { trackId: TRACK_B }, { actorId: ACTOR });

  const [fresh] = db.created;
  assert.equal(fresh.submittedAt, null, "forma javobi emas, odamning qarori");
  assert.equal(fresh.source, "manual");
  assert.equal(fresh.status, "planned");
  assert.equal(fresh.activeKey, `${STUDENT}|${TRACK_B}`);
  assert.equal(fresh.createdBy, ACTOR);
});

test("moslashtirish XOTIRASI yangi qatorga ko'chadi", async () => {
  reset();

  await planService.updatePlan(PLAN, { trackId: TRACK_B }, { actorId: ACTOR });

  const [fresh] = db.created;
  // Keyingi import o'sha xato yozilgan ismni qayta so'ramasligi kerak
  assert.equal(fresh.sourceName, "Valiyev Ali");
  assert.equal(fresh.sourceGroup, "IT 1");
});

test("muddat va izoh yo'nalish bilan BIRGA ko'chadi", async () => {
  reset();

  await planService.updatePlan(
    PLAN,
    { trackId: TRACK_B, dueDate: "2027-03-01" },
    { actorId: ACTOR },
  );

  const [fresh] = db.created;
  assert.equal(fresh.dueDate.toISOString().slice(0, 10), "2027-03-01");
  assert.equal(fresh.note, "O'quvchining izohi", "tegilmagan izoh saqlanadi");
});

/* ─────────────────── CHEGARALAR ─────────────────── */

test("BAND yo'nalishga ko'chirish RAD ETILADI", async () => {
  reset();
  db.plans.push({
    id: OTHER_PLAN,
    studentId: STUDENT,
    trackId: TRACK_B,
    status: "planned",
    activeKey: `${STUDENT}|${TRACK_B}`,
    submittedAt: null,
  });

  await assert.rejects(
    () => planService.updatePlan(PLAN, { trackId: TRACK_B }, { actorId: ACTOR }),
    /allaqachon faol reja bor/,
  );

  // ⚠️ Eng muhimi: hech narsa o'zgarmagan bo'lishi kerak
  assert.equal(db.plans.find((p) => p.id === PLAN).status, "planned");
  assert.equal(db.plans.find((p) => p.id === OTHER_PLAN).status, "planned");
  assert.equal(db.created.length, 0);
});

test("arxivlangan yo'nalishga ko'chirilmaydi", async () => {
  reset();
  db.tracks.push({ id: id("1c"), name: "Eski", isActive: false });

  await assert.rejects(
    () => planService.updatePlan(PLAN, { trackId: id("1c") }, { actorId: ACTOR }),
    /Arxivlangan yo'nalishga/,
  );
  assert.equal(db.created.length, 0);
});

test("bekor qilingan rejani tahrirlab bo'lmaydi", async () => {
  reset();
  db.plans[0].status = "cancelled";
  db.plans[0].activeKey = null;

  await assert.rejects(
    () => planService.updatePlan(PLAN, { dueDate: "2027-01-01" }, { actorId: ACTOR }),
    /Faqat faol rejani/,
  );
});

test("topshirilgan rejani tahrirlab bo'lmaydi", async () => {
  reset();
  db.plans[0].status = "passed";
  db.plans[0].activeKey = null;

  await assert.rejects(
    () => planService.updatePlan(PLAN, { trackId: TRACK_B }, { actorId: ACTOR }),
    /Faqat faol rejani/,
  );
  assert.equal(db.created.length, 0);
});

test("yo'q reja — topilmadi", async () => {
  reset();

  await assert.rejects(
    () => planService.updatePlan(id("ff"), { dueDate: "2027-01-01" }, { actorId: ACTOR }),
    /Reja topilmadi/,
  );
});
