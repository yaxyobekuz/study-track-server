const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * TANGA HAFTASI — O'quvchilar ro'yxatidagi haftalik kesim oynasi.
 *
 * Qabul mezonlari:
 *   - hafta DUSHANBA 00:00 dan YAKSHANBA 23:59:59.999 gacha
 *   - yakshanba oyna ICHIDA: haftalik bonus (yakshanba 00:01) o'zi mukofot
 *     bo'lgan haftada ko'rinadi, hech qayerda yo'qolmaydi
 *   - kelajak hafta so'ralsa — joriy haftaga qaytariladi
 *   - yaroqsiz sana ro'yxatni yiqitmaydi — joriy hafta
 */

process.env.JWT_SECRET = "test-secret-for-coin-week";
process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db?schema=public";

const { resolveCoinPeriod } = require("../src/services/coin.service");

/** Hafta ichidagi kun → o'sha haftaning oynasi. */
const weekOf = (day) => resolveCoinPeriod("week", day);

test("davr so'ralmasa — umumiy qoldiq ko'rinishi (null)", () => {
  assert.equal(resolveCoinPeriod(undefined), null);
  assert.equal(resolveCoinPeriod("total"), null);
  assert.equal(resolveCoinPeriod("month"), null);
});

test("hafta — dushanbadan yakshanbagacha", () => {
  // 2026-10-14 — chorshanba
  const range = weekOf("2026-10-14");

  assert.equal(range.from.getDay(), 1, "boshi dushanba");
  assert.equal(range.to.getDay(), 0, "oxiri yakshanba");
  assert.equal(range.from.getDate(), 12);
  assert.equal(range.to.getDate(), 18);
  assert.equal(range.from.getHours(), 0);
  assert.equal(range.to.getHours(), 23);
  assert.equal(range.to.getMinutes(), 59);
});

test("hafta chegarasidagi kunlar AYNI oynani beradi", () => {
  const monday = weekOf("2026-10-12");
  const sunday = weekOf("2026-10-18");

  assert.equal(monday.from.getTime(), sunday.from.getTime());
  assert.equal(monday.to.getTime(), sunday.to.getTime());
});

test("qo'shni haftalar — tutashgan, kesishmagan", () => {
  const first = weekOf("2026-10-12");
  const next = weekOf("2026-10-19");

  assert.equal(next.from.getTime() - first.to.getTime(), 1, "orada bo'shliq yo'q");
});

test("⚠️ yakshanba 00:01 dagi haftalik bonus O'SHA haftada qoladi", () => {
  // Bonus `weeklystats.job.js` da yakshanba 00:01 da yoziladi va
  // endigina tugagan (dushanba–shanba) haftaning mukofoti.
  const bonusAt = new Date(2026, 9, 18, 0, 1, 0); // 18-oktabr, yakshanba 00:01
  const rewardedWeek = weekOf("2026-10-16"); // o'sha haftaning jumasi

  assert.ok(bonusAt >= rewardedWeek.from && bonusAt <= rewardedWeek.to);

  // Keyingi haftaga TUSHMAYDI — ikki marta sanalmaydi
  const nextWeek = weekOf("2026-10-19");
  assert.ok(bonusAt < nextWeek.from);
});

test("kelajak hafta — joriy haftaga qaytariladi", () => {
  const future = new Date();
  future.setDate(future.getDate() + 60);
  const iso = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`;

  const range = weekOf(iso);
  const now = new Date();

  assert.equal(range.isCurrent, true);
  assert.ok(range.from <= now && now <= range.to, "joriy hafta bugunni qamraydi");
});

test("yaroqsiz yoki bo'sh sana — joriy hafta", () => {
  for (const value of [undefined, "", "bugun", "2026-13-40", "12.10.2026"]) {
    const range = resolveCoinPeriod("week", value);
    assert.equal(range.isCurrent, true, String(value));
  }
});

test("o'tgan hafta — isCurrent: false", () => {
  const past = new Date();
  past.setDate(past.getDate() - 14);
  const iso = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, "0")}-${String(past.getDate()).padStart(2, "0")}`;

  assert.equal(weekOf(iso).isCurrent, false);
});

test("qo'shni haftalarning langari serverdan keladi (panel sana hisoblamaydi)", () => {
  const range = weekOf("2026-10-14"); // chorshanba

  assert.equal(range.fromDay, "2026-10-12");
  assert.equal(range.toDay, "2026-10-18");
  assert.equal(range.prevWeek, "2026-10-05");
  assert.equal(range.nextWeek, "2026-10-19");

  // Langarlar O'ZI ko'rsatgan haftani ochadi — navigator sakrab ketmaydi
  assert.equal(weekOf(range.prevWeek).fromDay, "2026-10-05");
  assert.equal(weekOf(range.nextWeek).fromDay, "2026-10-19");
});

test("joriy haftada 'keyingi hafta' YO'Q", () => {
  const current = resolveCoinPeriod("week");

  assert.equal(current.nextWeek, null);
  // Orqaga qaytish esa har doim ochiq va bir haftaga suradi
  const back = weekOf(current.prevWeek);
  assert.equal(back.isCurrent, false);
  assert.equal(back.nextWeek, current.fromDay);
});
