/**
 * O'QUVCHILAR HARAKATI — chegara ta'rifi va arifmetika.
 *
 * Butun hisobotning ishonchi BITTA tenglikka tayanadi:
 *
 *   oy oxiridagi son = oy boshidagi son + kelganlar − ketganlar
 *
 * U tasodifan emas, `openCountAt` dagi qat'iy chegaradan kelib chiqadi
 * (`startDate < oy boshi`, `endDate >= oy boshi`). Shuning uchun bu yerda
 * aynan CHEGARA holatlari sinaladi: oyning 1-kuni kelgan va oyning oxirgi
 * kuni ketgan o'quvchi. Ikkalasi ham "o'z joyida" sanalmasa, jadvaldagi
 * "farq" ustuni jimgina bir birlikka og'ib ketadi.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  openCountAt,
  collectRange,
  buildMoveIndex,
  buildMetrics,
  combineMetrics,
  combineReasons,
  metricsFor,
  groupByReason,
  firstStartByStudent,
  resolveRange,
} = require("../src/services/studentMovement.service");

const { currentMonthKey, nextMonth, prevMonth } = require("../src/helpers/month.helpers");

/** `@db.Date` — UTC yarim tuni (domendagi yagona o'qish usuli). */
const day = (iso) => new Date(`${iso}T00:00:00.000Z`);

const row = (studentId, start, end = null) => ({
  id: `${studentId}-${start}`,
  studentId,
  startDate: day(start),
  endDate: end ? day(end) : null,
  endReason: end ? "left" : null,
  reason: "",
  note: "",
});

test("oy boshidagi son — oldin kelgan va hali ketmaganlar", () => {
  const rows = [
    row("s1", "2025-12-10"), // oldin kelgan, ochiq
    row("s2", "2026-01-01"), // AYNAN 1-kuni kelgan → "kelganlar" da
    row("s3", "2025-11-05", "2025-12-31"), // oldingi oy oxirida ketgan
    row("s4", "2025-11-05", "2026-01-20"), // shu oy ichida ketadi
  ];

  // s1 va s4 — oy boshida bor; s2 "keldi", s3 oldingi oyda ketgan
  assert.equal(openCountAt(rows, 202601), 2);
});

test("TAKRORSIZ o'quvchi: ikki davri bor bola bir marta sanaladi", () => {
  const rows = [
    row("s1", "2025-01-10", "2025-06-30"),
    row("s1", "2025-09-01"),
  ];

  assert.equal(openCountAt(rows, 202601), 1);
});

test("TENGLIK: oy oxiri = oy boshi + keldi − ketdi", () => {
  const rows = [
    row("s1", "2025-10-01"), // davom etadi
    row("s2", "2025-10-01", "2026-01-31"), // oyning OXIRGI kuni ketdi
    row("s3", "2026-01-01"), // oyning BIRINCHI kuni keldi
    row("s4", "2026-01-10", "2026-01-20"), // keldi-yu, o'sha oyda ketdi
    row("s5", "2026-01-15"), // oy o'rtasida keldi
  ];

  const firstStart = firstStartByStudent(rows);
  const metrics = metricsFor(rows, 202601, 202601, firstStart);

  assert.equal(metrics.openCount, 2, "oy boshida s1 va s2");
  assert.equal(metrics.joined, 3, "s3, s4, s5");
  assert.equal(metrics.left, 2, "s2 va s4");
  assert.equal(metrics.net, 1);
  assert.equal(metrics.closeCount, 3, "s1, s3, s5");
  assert.equal(
    metrics.openCount + metrics.joined - metrics.left,
    metrics.closeCount,
    "tenglik buzilmasligi kerak",
  );
});

test("OYLAR ZANJIRI uzilmaydi: oy oxiri = keyingi oy boshi", () => {
  const rows = [
    row("s1", "2025-12-05"),
    row("s2", "2026-01-10"),
    row("s3", "2026-02-01", "2026-02-28"),
    row("s4", "2026-01-31", "2026-02-15"),
  ];

  const firstStart = firstStartByStudent(rows);

  for (const month of [202601, 202602]) {
    const metrics = metricsFor(rows, month, month, firstStart);
    assert.equal(
      metrics.closeCount,
      openCountAt(rows, nextMonth(month)),
      `${month}: oy oxiri keyingi oy boshi bilan mos emas`,
    );
    assert.equal(
      metrics.openCount + metrics.joined - metrics.left,
      metrics.closeCount,
      `${month}: tenglik buzilgan`,
    );
  }
});

test("YANGI va QAYTIB KELGAN ajratiladi", () => {
  const rows = [
    row("s1", "2025-03-01", "2025-09-30"),
    row("s1", "2026-01-10"), // qaytib kelgan
    row("s2", "2026-01-12"), // birinchi marta
  ];

  const metrics = metricsFor(rows, 202601, 202601, firstStartByStudent(rows));

  assert.equal(metrics.joined, 2);
  assert.equal(metrics.joinedNew, 1);
  assert.equal(metrics.joinedReturned, 1);
});

test("FOIZ maxraji — davr BOSHIDAGI son; maxraj nol bo'lsa null", () => {
  const rows = [row("s1", "2025-06-01"), row("s2", "2025-06-01"), row("s3", "2026-01-05")];
  const metrics = metricsFor(rows, 202601, 202601, firstStartByStudent(rows));

  assert.equal(metrics.openCount, 2);
  assert.equal(metrics.growthPercent, 50, "1 / 2 = 50%");

  const empty = buildMetrics({
    openCount: 0,
    closeCount: 3,
    joined: [],
    left: [],
    firstStart: new Map(),
  });
  assert.equal(empty.growthPercent, null, "nol maxraj 0% EMAS");
});

test("SABABSIZ ketish ham sanaladi — aks holda tenglik buzilardi", () => {
  const legacy = {
    ...row("s1", "2025-05-01", "2026-01-10"),
    endReason: null, // eski ma'lumot
  };

  const { left } = collectRange([legacy], 202601, 202601);
  assert.equal(left.length, 1);

  const grouped = groupByReason(left);
  const unknown = grouped.find((item) => item.key === "unknown");
  assert.ok(unknown, "sababsiz qator alohida toifada ko'rinishi kerak");
  assert.equal(unknown.count, 1);
});

test("SABAB KESIMI — nol toifalar ham qatorda qoladi", () => {
  const grouped = groupByReason([]);
  assert.equal(grouped.length, 4, "to'rtta toifa har doim bor");
  assert.ok(grouped.every((item) => item.count === 0));
  assert.ok(grouped.every((item) => item.percent === null), "maxraj nol → foiz yo'q");
});

test("ORALIQ: kelgusi oylar kesiladi, kelajakdagi davr esa xato", () => {
  const thisMonth = currentMonthKey();
  const thisYear = Math.trunc(thisMonth / 100);

  const year = resolveRange({ year: String(thisYear) });
  assert.equal(year.from, thisYear * 100 + 1);
  assert.equal(year.to, thisMonth, "yuqori chegara joriy oydan oshmaydi");

  assert.throws(() => resolveRange({ month: String(nextMonth(thisMonth)) }), /Kelgusi/);
  assert.throws(
    () => resolveRange({ from: String(thisMonth), to: String(prevMonth(thisMonth)) }),
    /Boshlanish oyi/,
  );
  assert.throws(() => resolveRange({ year: "1800" }), /Yil/);
});

test("ORALIQ: sukut — joriy yil, bitta oy — `month` qamrovi", () => {
  const thisMonth = currentMonthKey();

  assert.equal(resolveRange({}).scope, "year");
  assert.equal(resolveRange({ month: String(thisMonth) }).scope, "month");
  assert.equal(resolveRange({ month: String(thisMonth) }).from, thisMonth);
  assert.equal(resolveRange({ from: String(thisMonth) }).scope, "range");
});

/* ───────────────── UMUMIY KO'RINISH (barcha filiallar) ───────────────── */

/**
 * ⚠️ BU TESTLAR ENG QIMMAT XATONI QO'RIQLAYDI.
 *
 * Umumiy birlashtiruvchi (`aggregateMerge.helpers.js`) har `*Percent`
 * kalitini filiallar bo'yicha OG'IRLIKSIZ o'rtachalaydi. Agar o'sha yo'l
 * ishlatilsa yoki `combineMetrics` "soddalashtirilsa", tarmoq foizi
 * JIMGINA yolg'on raqam bo'lib qoladi: ekranda ham, hujjatda ham xato
 * ko'rinmaydi, chunki u mantiqan to'g'ri sondek turadi.
 */
test("TARMOQ FOIZI — yig'indidan, filiallar O'RTACHASIDAN emas", () => {
  // Katta filial: 400 tadan +20 (o'sish 5%), kichik filial: 4 tadan +2 (50%).
  const big = buildMetrics({
    openCount: 400,
    closeCount: 420,
    joined: Array.from({ length: 20 }, (_, i) => ({ studentId: `b${i}`, startDate: day("2026-03-05") })),
    left: [],
    firstStart: new Map(),
  });
  const small = buildMetrics({
    openCount: 4,
    closeCount: 6,
    joined: Array.from({ length: 2 }, (_, i) => ({ studentId: `s${i}`, startDate: day("2026-03-05") })),
    left: [],
    firstStart: new Map(),
  });

  assert.equal(big.growthPercent, 5);
  assert.equal(small.growthPercent, 50);

  const network = combineMetrics([big, small]);

  assert.equal(network.openCount, 404);
  assert.equal(network.joined, 22);
  assert.equal(network.closeCount, 426);
  // 22 ÷ 404 = 5,4% — og'irliksiz o'rtacha bo'lsa 27,5% chiqardi.
  assert.equal(network.growthPercent, 5.4);
  assert.notEqual(network.growthPercent, (5 + 50) / 2);
});

test("TARMOQ: bo'sh filial jamini ham, foizni ham BUZMAYDI", () => {
  // Endi ochilgan filial: 0 o'quvchi, foizi `null` ("—").
  const empty = buildMetrics({
    openCount: 0,
    closeCount: 0,
    joined: [],
    left: [],
    firstStart: new Map(),
  });
  const live = buildMetrics({
    openCount: 100,
    closeCount: 95,
    joined: [],
    left: Array.from({ length: 5 }, (_, i) => ({ studentId: `l${i}` })),
    firstStart: new Map(),
  });

  assert.equal(empty.growthPercent, null);

  const network = combineMetrics([empty, live]);

  assert.equal(network.openCount, 100);
  assert.equal(network.left, 5);
  assert.equal(network.net, -5);
  assert.equal(network.growthPercent, -5, "nol filial maxrajni o'zgartirmaydi");

  // Maxraj umuman nol bo'lsa — `null`, 0% EMAS.
  assert.equal(combineMetrics([empty, empty]).growthPercent, null);
  assert.equal(combineMetrics([]).growthPercent, null);
});

test("TARMOQ: oy zanjiri filiallar yig'indisida ham uzilmaydi", () => {
  const branch = (open, joined, left) =>
    buildMetrics({
      openCount: open,
      closeCount: open + joined - left,
      joined: Array.from({ length: joined }, (_, i) => ({ studentId: `j${i}`, startDate: day("2026-03-05") })),
      left: Array.from({ length: left }, (_, i) => ({ studentId: `x${i}` })),
      firstStart: new Map(),
    });

  const network = combineMetrics([branch(344, 12, 3), branch(118, 5, 1), branch(0, 0, 0)]);

  assert.equal(
    network.closeCount,
    network.openCount + network.joined - network.left,
    "tarmoq darajasida ham: oxiri = boshi + keldi − ketdi",
  );
});

test("TARMOQ SABABLARI — ulush JAMIGA nisbatan qayta hisoblanadi", () => {
  const a = groupByReason([
    { endReason: "left" },
    { endReason: "left" },
    { endReason: "graduated" },
  ]);
  const b = groupByReason([{ endReason: "left" }, { endReason: null }]);

  const merged = combineReasons([a, b]);
  const find = (key) => merged.find((item) => item.key === key);

  assert.equal(find("left").count, 3);
  assert.equal(find("graduated").count, 1);
  assert.equal(find("unknown").count, 1, "sababsiz ketish tarmoqda ham yo'qolmaydi");

  // 3 ÷ 5 = 60% (filial ulushlarining o'rtachasi 66,7+50 bo'lardi)
  assert.equal(find("left").percent, 60);

  const total = merged.reduce((acc, item) => acc + item.count, 0);
  assert.equal(total, 5);

  // Toifalar TARTIBI bittalik kesim bilan bir xil bo'lishi shart.
  assert.deepEqual(
    merged.filter((item) => item.key !== "unknown").map((item) => item.key),
    a.map((item) => item.key),
  );
});

test("TARMOQ SABABLARI: hech kim ketmasa ulush `null` (0% EMAS)", () => {
  const merged = combineReasons([groupByReason([]), groupByReason([])]);

  assert.ok(merged.length > 0, "toifalar qatori nollari bilan qoladi");
  assert.ok(merged.every((item) => item.count === 0 && item.percent === null));
  assert.ok(!merged.some((item) => item.key === "unknown"));
});

/* ───────────── FILIALLARARO KO'CHISH — "keldi/ketdi" EMAS ───────────── */

/** Platformadagi ko'chirish jurnalining qatori. */
const transfer = (effective, sourceId, targetId, studentIds) => ({
  effectiveDate: day(effective),
  sourceBranchId: sourceId,
  targetBranchId: targetId,
  sourceBranch: { name: `Filial ${sourceId}` },
  targetBranch: { name: `Filial ${targetId}` },
  items: studentIds.map((id) => ({ subjectId: id })),
});

/**
 * ⚠️ ENG MUHIM TUZOQ SHU TESTDA.
 *
 * Ko'chirish manbada `endReason = "transferred"` yozadi — LEKIN o'sha
 * toifani admin qo'lda ham qo'yadi ("boshqa maktabga o'tdi"), va u
 * HAQIQIY ketish. Toifaga tayangan kod maktabni butunlay tashlab ketgan
 * bolani "ichki ko'chish" deb jimgina yo'qotardi, ya'ni "nechta o'quvchi
 * ketdi" degan savolga KAM raqam qaytarardi.
 */
test("KO'CHISH jurnal bo'yicha aniqlanadi, `endReason` bo'yicha EMAS", () => {
  const moves = buildMoveIndex(
    [transfer("2026-03-01", "A", "B", ["s1"])],
    "A",
  );

  // s1 — HAQIQATAN ko'chgan: manbada oxirgi kun 28-fevral (1-mart − 1)
  const moved = row("s1", "2025-09-01", "2026-02-28");
  // s2 — admin qo'lda "transferred" qo'ygan (boshqa MAKTABGA ketdi)
  const reallyLeft = row("s2", "2025-09-01", "2026-02-28");

  assert.ok(moves.isOut(moved), "jurnalda bor — ko'chish");
  assert.equal(moves.isOut(reallyLeft), null, "jurnalda yo'q — haqiqiy ketish");

  // Ikkalasining ham `endReason` i bir xil bo'lishi mumkin.
  assert.equal(moved.endReason, reallyLeft.endReason);
});

test("KO'CHISH: manba va maqsad kunlari BIR KUN farq qiladi", () => {
  const log = [transfer("2026-03-01", "A", "B", ["s1"])];

  const source = buildMoveIndex(log, "A");
  const target = buildMoveIndex(log, "B");

  // Manbada oxirgi kun — ko'chish kunidan BIR KUN oldin
  assert.ok(source.isOut(row("s1", "2025-09-01", "2026-02-28")));
  assert.equal(source.isOut(row("s1", "2025-09-01", "2026-03-01")), null);

  // Maqsadda davr AYNAN ko'chish kunidan boshlanadi
  assert.ok(target.isIn(row("s1", "2026-03-01")));
  assert.equal(target.isIn(row("s1", "2026-03-02")), null);

  // ⚠️ YO'NALISH ALMASHMAYDI: manba filial uchun bu "ketish", maqsad
  // uchun "kelish" — ikkalasi bir xil ko'rinsa, bitta bola ikki marta
  // sanalardi.
  assert.equal(source.isIn(row("s1", "2026-03-01")), null);
  assert.equal(target.isOut(row("s1", "2025-09-01", "2026-02-28")), null);

  assert.equal(source.isOut(row("s1", "2025-09-01", "2026-02-28")).toBranch, "Filial B");
});

test("KO'CHGANLAR `keldi`/`ketdi` ro'yxatidan CHIQARILADI", () => {
  const rows = [
    row("moved", "2025-09-01", "2026-02-28"), // ko'chib ketdi
    row("left", "2025-09-01", "2026-02-28"), // haqiqatan ketdi
    row("new", "2026-02-10"), // haqiqatan keldi
    row("in", "2026-03-01"), // ko'chib keldi
  ];

  const moves = buildMoveIndex(
    [
      transfer("2026-03-01", "A", "B", ["moved"]),
      transfer("2026-03-01", "B", "A", ["in"]),
    ],
    "A",
  );

  const split = collectRange(rows, 202602, 202603, moves);

  assert.deepEqual(split.left.map((r) => r.studentId), ["left"]);
  assert.deepEqual(split.movedOut.map((r) => r.studentId), ["moved"]);
  assert.deepEqual(split.joined.map((r) => r.studentId), ["new"]);
  assert.deepEqual(split.movedIn.map((r) => r.studentId), ["in"]);
});

/**
 * ⚠️ TENGLIK KO'CHISH BILAN HAM BAJARILADI va bu shunchaki chiroyli
 * emas — aynan shu sabab ko'chish "keldi/ketdi" dan chiqarilgani bilan
 * jadvaldan YO'QOLMAYDI, o'z hadi bo'lib qoladi:
 *
 *   oxiri = boshi + keldi − ketdi + ko'chib kelgan − ko'chib ketgan
 */
test("TENGLIK: ko'chish o'z hadi bilan saqlanadi", () => {
  const m = buildMetrics({
    openCount: 100,
    closeCount: 103,
    joined: [{ studentId: "a", startDate: day("2026-03-05") }],
    left: [{ studentId: "b" }],
    movedIn: [{ studentId: "c" }, { studentId: "d" }, { studentId: "e" }, { studentId: "f" }],
    movedOut: [{ studentId: "g" }],
    firstStart: new Map(),
  });

  assert.equal(m.joined, 1);
  assert.equal(m.left, 1);
  assert.equal(m.movedIn, 4);
  assert.equal(m.movedOut, 1);
  assert.equal(m.moveNet, 3);

  // ⚠️ `net` — MAKTABNING o'sishi; ko'chish unga KIRMAYDI.
  assert.equal(m.net, 0);
  assert.equal(m.growthPercent, 0, "ko'chish o'sish foizini ko'tarmaydi");

  assert.equal(
    m.closeCount,
    m.openCount + m.joined - m.left + m.movedIn - m.movedOut,
  );
});

test("TARMOQ: ko'chish qo'shiladi va odatda o'zini yo'qotadi", () => {
  const branch = (movedIn, movedOut) =>
    buildMetrics({
      openCount: 50,
      closeCount: 50 + movedIn - movedOut,
      joined: [],
      left: [],
      movedIn: Array.from({ length: movedIn }, (_, i) => ({ studentId: `i${i}` })),
      movedOut: Array.from({ length: movedOut }, (_, i) => ({ studentId: `o${i}` })),
      firstStart: new Map(),
    });

  // Bitta bola A dan B ga o'tdi: A da −1, B da +1
  const network = combineMetrics([branch(0, 1), branch(1, 0)]);

  assert.equal(network.movedIn, 1);
  assert.equal(network.movedOut, 1);
  assert.equal(network.moveNet, 0, "tarmoqda ko'chish o'zini yo'qotadi");
  assert.equal(network.net, 0);
  assert.equal(
    network.closeCount,
    network.openCount + network.joined - network.left + network.moveNet,
  );
});
