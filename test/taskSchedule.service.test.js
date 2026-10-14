const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * DOIMIY TOPSHIRIQ PASSI — qoidadan topshiriq yozish.
 *
 * Qamrov aynan "jim buziladigan" qoidalarga qaratilgan:
 *
 *   · topshiriq VAQTIDAN OLDIN yoziladi (`leadDays`) — shu yaratilish
 *     xodim uchun eslatma;
 *   · O'TGAN hodisa YOZILMAYDI: server bir kun o'chiq tursa ham, xodimga
 *     darhol "bajarilmadi" topshiriq va jarima tushmasligi kerak;
 *   · pass IDEMPOTENT: kuniga necha marta ishlasa ham takror yozilmaydi
 *     va buning uchun xatoga tayanilmaydi (log toza qoladi);
 *   · to'xtatilgan qoida hech narsa yozmaydi;
 *   · bitta buzuq qoida butun passni to'xtatmaydi.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const day = (iso) => new Date(`${iso}T00:00:00.000Z`);
const id = (ch) => ch.repeat(24);

const db = { tasks: [], schedules: [], archived: new Set() };

fakeModule("../src/config/prisma", {
  task: {
    findMany: async ({ where }) =>
      db.tasks.filter(
        (t) =>
          t.scheduleId === where.scheduleId &&
          where.occurrenceDate.in.some((d) => d.getTime() === t.occurrenceDate.getTime()),
      ),
  },
  taskSchedule: {
    findMany: async () => db.schedules.filter((s) => s.isActive),
    update: async ({ where, data }) => {
      const row = db.schedules.find((s) => s.id === where.id);
      // Testda qoida `db.schedules` ga qo'yilmagan bo'lishi mumkin —
      // `lastRunDate` ni yangilash passni yiqitmasligi kerak
      if (row) Object.assign(row, data);
      return row ?? { ...where, ...data };
    },
  },
  // Qoidadagi ijrochilar — sukut bo'yicha hammasi FAOL (arxivlanmagan).
  // `db.archived` ga qo'shilgani `isArchived: false` filtriga tushmaydi.
  user: {
    findMany: async ({ where }) =>
      where.id.in.filter((id) => !db.archived.has(id)).map((id) => ({ id })),
  },
});

// Qator yozuvchisi — haqiqiy `task.service` o'rniga (u bazaga yozadi)
const written = [];
fakeModule("../src/services/task.service", {
  writeTaskRows: async ({ assigneeIds, fields }) => {
    const rows = assigneeIds.map((assignee) => ({ ...fields, assignee, id: `t${db.tasks.length}` }));
    db.tasks.push(...rows);
    written.push(...rows);
    return rows;
  },
  notifyAssignees: () => {},
});

const { materializeSchedule, runSchedulePass } = require("../src/services/taskSchedule.service");
const { getTashkentDateUtc } = require("../src/helpers/date.helpers");

const SCHEDULE = {
  id: id("s"),
  title: "Jurnalni to'ldirish",
  description: "Har hafta boshida",
  assignees: [id("a"), id("b")],
  attachments: [],
  links: [],
  penaltyPoints: 2,
  frequency: "weekly",
  weekdays: [1], // dushanba
  monthDays: [],
  intervalDays: null,
  intervalMonths: null,
  slots: [{ start: "08:10", due: "09:00", offsetDays: 0 }],
  leadDays: 1,
  startDate: day("2026-10-01"),
  endDate: null,
  isActive: true,
  createdBy: id("o"),
};

test.beforeEach(() => {
  db.tasks = [];
  db.schedules = [];
  db.archived = new Set();
  written.length = 0;
});

test("topshiriq VAQTIDAN OLDIN yoziladi (leadDays)", async () => {
  // Yakshanba 2026-10-18 → ertangi dushanba oynaga tushadi
  const result = await materializeSchedule({ ...SCHEDULE }, day("2026-10-18"));

  assert.equal(result.created, 2, "ikkala ijrochiga ham");
  assert.equal(written[0].occurrenceDate.toISOString().slice(0, 10), "2026-10-19");
  // Vaqt oynasi Toshkent devor-soatidan
  assert.equal(written[0].startDate.toISOString(), "2026-10-19T03:10:00.000Z");
  assert.equal(written[0].dueDate.toISOString(), "2026-10-19T04:00:00.000Z");
  assert.equal(written[0].kind, "main", "doimiy topshiriq — ASOSIY tur");
  assert.equal(written[0].scheduleId, SCHEDULE.id);
  assert.equal(written[0].occurrenceSlot, "09:00", "qaysi vaqt uchun yozilgani");
});

test("BIR KUNDA BIR NECHTA VAQT — har biriga alohida topshiriq", async () => {
  // "Har dushanba ertalab 09:00 da va tushdan keyin 15:00 da"
  const result = await materializeSchedule(
    {
      ...SCHEDULE,
      slots: [
        { start: null, due: "09:00", offsetDays: 0 },
        { start: "14:30", due: "15:00", offsetDays: 0 },
      ],
    },
    day("2026-10-18"),
  );

  assert.equal(result.created, 4, "2 vaqt × 2 ijrochi");
  assert.deepEqual(
    [...new Set(written.map((t) => t.occurrenceSlot))].sort(),
    ["09:00", "15:00"],
  );
  // Ikkala topshiriq ham AYNI kunga, lekin boshqa muddatga
  assert.equal(
    new Set(written.map((t) => t.occurrenceDate.toISOString())).size,
    1,
    "bitta kun",
  );
  assert.equal(new Set(written.map((t) => t.dueDate.toISOString())).size, 2, "ikki muddat");
});

test("bir kunning o'tgan vaqti tashlanadi, keyingisi YOZILADI", async () => {
  // Kun ichida 00:00 allaqachon o'tgan, 23:59 esa hali oldinda
  const today = getTashkentDateUtc(0);
  const result = await materializeSchedule(
    {
      ...SCHEDULE,
      frequency: "days",
      intervalDays: 1,
      weekdays: [],
      startDate: today,
      leadDays: 0,
      slots: [
        { start: null, due: "00:00", offsetDays: 0 },
        { start: null, due: "23:59", offsetDays: 0 },
      ],
    },
    today,
  );

  assert.equal(result.created, 2, "faqat kechki vaqt, ikkala ijrochiga");
  assert.deepEqual([...new Set(written.map((t) => t.occurrenceSlot))], ["23:59"]);
});

test("hodisadan uzoq kunda hech narsa yozilmaydi", async () => {
  // Seshanba: keyingi dushanbagacha 6 kun, `leadDays` esa 1
  const result = await materializeSchedule({ ...SCHEDULE }, day("2026-10-13"));
  assert.deepEqual(result, { created: 0, skipped: 0 });
});

test("O'TGAN hodisa yozilmaydi", async () => {
  // Chorshanba — dushanba allaqachon o'tib ketgan
  const result = await materializeSchedule({ ...SCHEDULE }, day("2026-10-21"));
  assert.equal(result.created, 0);
  assert.ok(
    !written.some((t) => t.occurrenceDate.toISOString().startsWith("2026-10-19")),
    "o'tgan dushanba uchun topshiriq yozilmadi",
  );
});

test("pass IDEMPOTENT — takror yozmaydi va xatoga tayanmaydi", async () => {
  const schedule = { ...SCHEDULE };
  const first = await materializeSchedule(schedule, day("2026-10-18"));
  const second = await materializeSchedule(schedule, day("2026-10-18"));

  assert.equal(first.created, 2);
  assert.equal(second.created, 0, "ikkinchi pass hech narsa yozmaydi");
  assert.equal(second.skipped, 2, "allaqachon borlar sanaladi");
  assert.equal(db.tasks.length, 2);
});

test("qo'shilgan ijrochiga keyingi passda yoziladi", async () => {
  const schedule = { ...SCHEDULE };
  await materializeSchedule(schedule, day("2026-10-18"));

  schedule.assignees = [...schedule.assignees, id("c")];
  const result = await materializeSchedule(schedule, day("2026-10-18"));

  assert.equal(result.created, 1, "faqat yangi odamga");
  assert.equal(written[written.length - 1].assignee, id("c"));
});

test("ARXIVLANGAN ijrochiga topshiriq yozilmaydi", async () => {
  // Qoida yaratilganda odam faol edi, keyin ketdi: tekshiruvsiz qoida unga
  // har hafta topshiriq va JARIMA yozib turardi, u esa tizimga kira
  // olmagani uchun uni yopa ham olmasdi.
  db.archived.add(id("b"));

  const result = await materializeSchedule({ ...SCHEDULE }, day("2026-10-18"));

  assert.equal(result.created, 1, "faqat faol ijrochiga");
  assert.equal(written[0].assignee, id("a"));
});

test("hamma ijrochisi arxivlangan qoida hech narsa yozmaydi", async () => {
  db.archived.add(id("a"));
  db.archived.add(id("b"));

  const result = await materializeSchedule({ ...SCHEDULE }, day("2026-10-18"));
  assert.deepEqual(result, { created: 0, skipped: 0 });
});

test("MUDDATI ALLAQACHON O'TGAN hodisa yozilmaydi (darhol jarima bo'lardi)", async () => {
  // Bugungi kun oynaga kiradi, lekin soati o'tib ketgan bo'lishi mumkin:
  // "har kuni 00:00" qoidasi kun davomida yaratilsa, xodim o'sha zahoti
  // muddati o'tgan topshiriq va soatlik cron'dan avtomat jarima olardi.
  const today = getTashkentDateUtc(0);
  const result = await materializeSchedule(
    {
      ...SCHEDULE,
      frequency: "days",
      intervalDays: 1,
      weekdays: [],
      startDate: today,
      slots: [{ start: null, due: "00:00", offsetDays: 0 }],
      leadDays: 0,
    },
    today,
  );

  assert.equal(result.created, 0, "o'tgan soat uchun topshiriq yozilmadi");
  assert.equal(result.skipped, 2, "ikkala ijrochi ham o'tkazib yuborildi");
});

test("to'xtatilgan qoida hech narsa yozmaydi", async () => {
  const result = await materializeSchedule({ ...SCHEDULE, isActive: false }, day("2026-10-18"));
  assert.deepEqual(result, { created: 0, skipped: 0 });
});

test("davr tugagan qoida hech narsa yozmaydi", async () => {
  const result = await materializeSchedule(
    { ...SCHEDULE, endDate: day("2026-10-15") },
    day("2026-10-18"),
  );
  assert.equal(result.created, 0);
});

test("bitta buzuq qoida butun passni to'xtatmaydi", async () => {
  db.schedules = [
    { ...SCHEDULE, id: id("1"), frequency: "weekly", weekdays: [1] },
    // Buzuq: `assignees` yo'q → yozuvchi yiqiladi
    { ...SCHEDULE, id: id("2"), assignees: null },
    { ...SCHEDULE, id: id("3"), assignees: [id("d")] },
  ];

  const result = await runSchedulePass(day("2026-10-18"));

  assert.equal(result.failed, 1, "faqat bittasi yiqildi");
  assert.ok(result.created >= 1, "qolganlari yozildi");
});
