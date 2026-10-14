const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * DOIMIY TOPSHIRIQ QOIDASI — "qaysi kunlarda" va "soat nechada".
 *
 * Cron ham, paneldagi "keyingi topshiriq" ham shu funksiyalardan o'qiydi,
 * shuning uchun qamrov aynan tuzoqli joylarga qaratilgan:
 *
 *   · haftaning BIR NECHTA kuni ("har dushanba VA chorshanba");
 *   · "har N kunda" qoida BOSHLANGAN kundan sanaladi;
 *   · "31-kuni" fevralda tushib qolmaydi — oxirgi kunga suriladi;
 *   · davr chekkalari (`startDate` / `endDate`) ikkala tomondan ham amal qiladi;
 *   · soat TOSHKENT devor-soati bo'lib instantga aylanadi;
 *   · muddat `dueOffsetDays` bilan boshqa kunga surilishi mumkin.
 */

const {
  occursOn,
  occurrencesInRange,
  nextOccurrence,
  buildWindow,
  describeSchedule,
} = require("../src/helpers/taskSchedule.helpers");

const day = (iso) => new Date(`${iso}T00:00:00.000Z`);

const base = {
  isActive: true,
  startDate: day("2026-10-01"),
  endDate: null,
  slots: [{ start: null, due: "18:00", offsetDays: 0 }],
  weekdays: [],
  monthDays: [],
};

const slot = (due, start = null, offsetDays = 0) => ({ start, due, offsetDays });

// 2026-10-12 — dushanba, 2026-10-14 — chorshanba

// ─── Haftalik ─────────────────────────────────────────────────────

test("haftalik: bir nechta kun tanlanadi", () => {
  const s = { ...base, frequency: "weekly", weekdays: [1, 3] };

  assert.ok(occursOn(s, day("2026-10-12")), "dushanba");
  assert.ok(occursOn(s, day("2026-10-14")), "chorshanba");
  assert.ok(!occursOn(s, day("2026-10-13")), "seshanba");
  assert.ok(!occursOn(s, day("2026-10-18")), "yakshanba");
});

test("haftalik: qoida boshlanishidan OLDIN hodisa yo'q", () => {
  const s = { ...base, frequency: "weekly", weekdays: [1], startDate: day("2026-10-13") };
  assert.ok(!occursOn(s, day("2026-10-12")), "boshlanishdan oldingi dushanba");
  assert.ok(occursOn(s, day("2026-10-19")), "keyingi dushanba");
});

test("davr oxiri INKLYUZIV, undan keyin to'xtaydi", () => {
  const s = {
    ...base,
    frequency: "weekly",
    weekdays: [1],
    endDate: day("2026-10-19"),
  };
  assert.ok(occursOn(s, day("2026-10-19")), "oxirgi kun");
  assert.ok(!occursOn(s, day("2026-10-26")), "davrdan keyin");
});

// ─── Har N kunda ──────────────────────────────────────────────────

test("har 10 kunda — boshlangan kundan sanaladi", () => {
  const s = { ...base, frequency: "days", intervalDays: 10 };

  assert.ok(occursOn(s, day("2026-10-01")), "birinchi kun");
  assert.ok(occursOn(s, day("2026-10-11")));
  assert.ok(occursOn(s, day("2026-10-21")));
  assert.ok(!occursOn(s, day("2026-10-20")));
});

test("har kuni (interval 1)", () => {
  const s = { ...base, frequency: "days", intervalDays: 1 };
  assert.ok(occursOn(s, day("2026-10-07")));
  assert.ok(occursOn(s, day("2026-10-08")));
});

// ─── Oylik ────────────────────────────────────────────────────────

test("3 oyda bir, oyning tanlangan kunlari", () => {
  const s = { ...base, frequency: "months", intervalMonths: 3, monthDays: [1, 15] };

  assert.ok(occursOn(s, day("2026-10-01")));
  assert.ok(occursOn(s, day("2026-10-15")));
  assert.ok(!occursOn(s, day("2026-11-01")), "oraliq oy");
  assert.ok(!occursOn(s, day("2026-12-01")), "oraliq oy");
  assert.ok(occursOn(s, day("2027-01-15")), "3 oydan keyin");
});

test("OYDA YO'Q KUN oxirgi kunga suriladi (31-fevral)", () => {
  const s = {
    ...base,
    frequency: "months",
    intervalMonths: 1,
    monthDays: [31],
    startDate: day("2027-01-01"),
  };

  assert.ok(occursOn(s, day("2027-01-31")), "yanvar — 31");
  assert.ok(occursOn(s, day("2027-02-28")), "fevral — oxirgi kun");
  assert.ok(!occursOn(s, day("2027-02-27")));
  assert.ok(occursOn(s, day("2027-04-30")), "aprel — oxirgi kun");
});

// ─── Oraliq va keyingisi ──────────────────────────────────────────

test("oraliqdagi hodisalar va keyingisi", () => {
  const s = { ...base, frequency: "weekly", weekdays: [1] };

  const list = occurrencesInRange(s, day("2026-10-05"), day("2026-10-26"));
  assert.deepEqual(
    list.map((d) => d.toISOString().slice(0, 10)),
    ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"],
  );

  assert.equal(
    nextOccurrence(s, day("2026-10-13"))?.toISOString().slice(0, 10),
    "2026-10-19",
  );
  // To'xtatilgan qoidada keyingi hodisa yo'q
  assert.equal(nextOccurrence({ ...s, isActive: false }, day("2026-10-13")), null);
});

// ─── Vaqt oynasi ──────────────────────────────────────────────────

test("soat TOSHKENT devor-soati bo'lib instantga aylanadi", () => {
  const w = buildWindow(slot("09:30", "08:10"), day("2026-10-12"));

  // 08:10 Toshkent = 03:10 UTC
  assert.equal(w.startDate.toISOString(), "2026-10-12T03:10:00.000Z");
  assert.equal(w.dueDate.toISOString(), "2026-10-12T04:30:00.000Z");
});

test("BIR KUNDA BIR NECHTA VAQT — har biri o'z oynasini beradi", () => {
  // "Har kuni ertalab 09:00 da va tushdan keyin 15:00 da"
  const morning = buildWindow(slot("09:00"), day("2026-10-12"));
  const afternoon = buildWindow(slot("15:00", "14:30"), day("2026-10-12"));

  assert.equal(morning.dueDate.toISOString(), "2026-10-12T04:00:00.000Z");
  assert.equal(afternoon.startDate.toISOString(), "2026-10-12T09:30:00.000Z");
  assert.equal(afternoon.dueDate.toISOString(), "2026-10-12T10:00:00.000Z");
  assert.ok(morning.dueDate < afternoon.dueDate, "ertalabki oldin tugaydi");
});

test("muddat boshqa kunga surilishi mumkin (bir necha kunlik ish)", () => {
  const w = buildWindow(slot("18:00", "08:10", 2), day("2026-10-12"));

  assert.equal(w.startDate.toISOString(), "2026-10-12T03:10:00.000Z", "dushanba 08:10");
  assert.equal(w.dueDate.toISOString(), "2026-10-14T13:00:00.000Z", "chorshanba 18:00");
});

test("boshlanish vaqti berilmasa oyna yo'q — faqat muddat", () => {
  assert.equal(buildWindow(slot("18:00"), day("2026-10-12")).startDate, null);
});

// ─── Matn ─────────────────────────────────────────────────────────

test("qoida matni odam o'qiydigan ko'rinishda", () => {
  assert.equal(
    describeSchedule({
      ...base,
      frequency: "weekly",
      weekdays: [1, 3],
      slots: [slot("18:00", "08:10")],
    }),
    "Har dushanba, chorshanba · 08:10–18:00",
  );

  // Bir kunda bir nechta vaqt — hammasi matnda ko'rinadi
  assert.equal(
    describeSchedule({
      ...base,
      frequency: "days",
      intervalDays: 1,
      slots: [slot("09:00"), slot("15:00", "14:30")],
    }),
    "Har kuni · 09:00, 14:30–15:00",
  );
  assert.equal(
    describeSchedule({ ...base, frequency: "days", intervalDays: 10 }),
    "Har 10 kunda · 18:00",
  );
  assert.equal(
    describeSchedule({ ...base, frequency: "months", intervalMonths: 3, monthDays: [15, 1] }),
    "Har 3 oyda ning 1, 15-kuni · 18:00".replace("oyda ning", "oydaning"),
  );
  // Yakshanba hafta OXIRIDA turadi
  assert.equal(
    describeSchedule({ ...base, frequency: "weekly", weekdays: [0, 1] }),
    "Har dushanba, yakshanba · 18:00",
  );
});
