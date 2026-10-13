const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * TOPSHIRIQNING VAQT HOLATI — "hozir nima bo'lyapti" degan savolning
 * YAGONA javobi (`taskWindow.helpers.js`). Ro'yxat, dashboard, ijrochi
 * paneli va "Men ketdim" darvozasi AYNI shu funksiyadan o'qiydi, shuning
 * uchun qamrov aynan shu qoidalarga qaratilgan:
 *
 *   · "bajarilmadi" (✗) — SAQLANMAYDI, hosila: muddat o'tdi-yu topshirilmadi;
 *   · muddat uzaytirilsa ✗ o'z-o'zidan yo'qoladi;
 *   · "hozir bajarilish vaqti" faqat ORALIQ ichida (qizil);
 *   · tasdiqlangan/to'xtatilgan topshiriqda vaqt holati muddatdan ustun;
 *   · havolada faqat http(s) — `javascript:` saqlangan XSS yo'li bo'lardi.
 */

const {
  resolveTimeState,
  buildStateWhere,
  normalizeKind,
  normalizeLinks,
} = require("../src/helpers/taskWindow.helpers");

const NOW = new Date("2026-10-13T09:00:00.000Z");
const ago = (ms) => new Date(NOW.getTime() - ms);
const ahead = (ms) => new Date(NOW.getTime() + ms);
const HOUR = 60 * 60 * 1000;

const badRequest = (msg) => new Error(msg);

// ─── Vaqt holati ──────────────────────────────────────────────────

test("oraliq ichida — 'hozir bajarilish vaqti'", () => {
  const state = resolveTimeState(
    { status: "pending", startDate: ago(HOUR), dueDate: ahead(HOUR) },
    NOW,
  );
  assert.equal(state, "active");
});

test("oraliq boshlanmagan — 'upcoming'", () => {
  const state = resolveTimeState(
    { status: "pending", startDate: ahead(HOUR), dueDate: ahead(3 * HOUR) },
    NOW,
  );
  assert.equal(state, "upcoming");
});

test("oraliqsiz, muddat oldinda — 'open'", () => {
  const state = resolveTimeState(
    { status: "pending", startDate: null, dueDate: ahead(HOUR) },
    NOW,
  );
  assert.equal(state, "open");
});

test("muddat o'tdi va topshirilmadi — 'missed' (✗)", () => {
  for (const status of ["pending", "extended", "pending_rejected"]) {
    assert.equal(
      resolveTimeState({ status, startDate: ago(3 * HOUR), dueDate: ago(HOUR) }, NOW),
      "missed",
      status,
    );
  }
});

test("MUDDAT UZAYTIRILSA ✗ o'z-o'zidan yo'qoladi", () => {
  const task = { status: "extended", startDate: ago(3 * HOUR), dueDate: ago(HOUR) };
  assert.equal(resolveTimeState(task, NOW), "missed");

  // Rahbar muddatni uzaytirdi — hech narsa qo'lda qaytarilmaydi
  task.dueDate = ahead(2 * HOUR);
  assert.equal(resolveTimeState(task, NOW), "active");
});

test("topshirilgan ish muddati o'tgan bo'lsa ham 'review'", () => {
  const state = resolveTimeState(
    { status: "pending_review", startDate: ago(3 * HOUR), dueDate: ago(HOUR) },
    NOW,
  );
  assert.equal(state, "review");
});

test("tasdiqlangan — 'done', to'xtatilgan — 'stopped'", () => {
  assert.equal(resolveTimeState({ status: "completed", dueDate: ago(HOUR) }, NOW), "done");
  assert.equal(resolveTimeState({ status: "stopped", dueDate: ago(HOUR) }, NOW), "stopped");
});

// ─── SQL kesimi ───────────────────────────────────────────────────

test("kesim SQL darajasida quriladi (xotirada filtrlanmaydi)", () => {
  assert.deepEqual(buildStateWhere("done", NOW), { status: "completed" });
  assert.deepEqual(buildStateWhere("missed", NOW), {
    status: { in: ["pending", "extended", "pending_rejected"] },
    dueDate: { lt: NOW },
  });
  // "Hozir vaqti" — oraliqsiz topshiriqni QAMRAMAYDI (startDate shart)
  assert.ok(buildStateWhere("active", NOW).startDate);
  assert.equal(buildStateWhere("boshqa", NOW), null);
});

// ─── Tur ──────────────────────────────────────────────────────────

test("noma'lum tur — 'asosiy' (tur ko'rsatkich, to'siq emas)", () => {
  assert.equal(normalizeKind("extra"), "extra");
  assert.equal(normalizeKind("main"), "main");
  assert.equal(normalizeKind("nimadir"), "main");
  assert.equal(normalizeKind(undefined), "main");
});

// ─── Havolalar ────────────────────────────────────────────────────

test("havola faqat http(s)", () => {
  assert.throws(
    () => normalizeLinks([{ url: "javascript:alert(1)" }], badRequest),
    /http/,
  );
  assert.throws(() => normalizeLinks([{ url: "data:text/html,x" }], badRequest), /http/);
  assert.throws(() => normalizeLinks(["shunchaki matn"], badRequest), /noto'g'ri/);
});

test("takror havola bir marta, yorliq bo'sh bo'lsa domen", () => {
  const links = normalizeLinks(
    [
      { url: "https://example.com/a", label: " Hisobot " },
      { url: "https://example.com/a" },
      { url: "https://docs.example.com/b", label: "" },
    ],
    badRequest,
  );
  assert.equal(links.length, 2);
  assert.equal(links[0].label, "Hisobot");
  assert.equal(links[1].label, "docs.example.com");
});

test("JSON satri ham qabul qilinadi (multipart forma)", () => {
  const links = normalizeLinks('[{"url":"https://a.uz/x","label":"Namuna"}]', badRequest);
  assert.deepEqual(links, [{ url: "https://a.uz/x", label: "Namuna" }]);
  assert.deepEqual(normalizeLinks("", badRequest), []);
  assert.deepEqual(normalizeLinks(undefined, badRequest), []);
});

test("havolalar soni cheklangan", () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ url: `https://a.uz/${i}` }));
  assert.throws(() => normalizeLinks(many, badRequest), /10/);
});
