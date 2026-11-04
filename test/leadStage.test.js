const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * QABUL ZINAPOYASI — 6 pog'ona (`helpers/leadStage.helpers.js`).
 *
 * Eng muhim qoidalar: tartib enumdan EMAS, zinapoya MONOTON, chiqish
 * holati pog'ona yozmaydi va eski holatlar yo'qolmaydi (moslanadi —
 * migratsiyadagi backfill bilan AYNI).
 */

const h = require("../src/helpers/leadStage.helpers");

test("zinapoya: 6 pog'ona, qat'iy tartibda", () => {
  assert.equal(h.LEAD_STAGES.length, 6);
  assert.deepEqual(
    h.LEAD_STAGES.map((s) => s.status),
    ["interested", "trial", "visited", "attended", "liked", "enrolled"],
  );
  // Raqamlar 1..6 va bo'shliq yo'q — grafik va filtr shunga tayanadi
  assert.deepEqual(
    h.LEAD_STAGES.map((s) => s.stage),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(h.FINAL_STAGE, 6);
  // Har pog'onada odam o'qiydigan yorliq bor (panel shundan chizadi)
  for (const stage of h.LEAD_STAGES) {
    assert.ok(stage.label && stage.short, `${stage.status} yorliqsiz`);
  }
});

test("pog'ona raqami: zinapoya, chiqish va eski holatlar", () => {
  assert.equal(h.rungOf("interested"), 1);
  assert.equal(h.rungOf("trial"), 2);
  assert.equal(h.rungOf("visited"), 3);
  assert.equal(h.rungOf("attended"), 4);
  assert.equal(h.rungOf("liked"), 5);
  assert.equal(h.rungOf("enrolled"), 6);

  // Hali zinapoyaga chiqmagan
  assert.equal(h.rungOf("new"), 0);
  assert.equal(h.rungOf("contacted"), 0);

  // ⚠️ ESKI "Muzokara" — to'lovdan oldingi suhbat, ya'ni dars yoqqan
  // holat (5). Migratsiyadagi backfill bilan AYNI moslash.
  assert.equal(h.rungOf("negotiation"), 5);

  // Chiqib ketish — zinapoyada emas
  for (const status of ["rejected", "lost", "postponed"]) {
    assert.equal(h.rungOf(status), -1, status);
    assert.equal(h.isExitStatus(status), true);
  }
  assert.equal(h.isExitStatus("enrolled"), false);

  // Noma'lum qiymat jim 1-pog'ona bo'lib ketmaydi
  assert.equal(h.rungOf("allaqanday"), 0);
});

test("MONOTONLIK: pog'onaga yetish ostidagilarni ham yozadi", () => {
  assert.deepEqual(h.stagesUpTo("interested").map((s) => s.stage), [1]);
  assert.deepEqual(h.stagesUpTo("visited").map((s) => s.stage), [1, 2, 3]);
  // To'lov qilgan bola "keldi" da ham sanaladi — funnel teskari bo'lmasin
  assert.deepEqual(h.stagesUpTo("enrolled").map((s) => s.stage), [1, 2, 3, 4, 5, 6]);

  // Eski holat ham zinapoyaga tushadi
  assert.deepEqual(h.stagesUpTo("negotiation").map((s) => s.stage), [1, 2, 3, 4, 5]);

  // Ro'yxatga olish va chiqib ketish pog'ona YOZMAYDI
  assert.deepEqual(h.stagesUpTo("new"), []);
  assert.deepEqual(h.stagesUpTo("lost"), []);
  assert.deepEqual(h.stagesUpTo("rejected"), []);

  // Har qator holat nomini ham olib yuradi (muhr: nom o'zgarsa tarix qoladi)
  for (const row of h.stagesUpTo("enrolled")) {
    assert.equal(typeof row.status, "string");
  }
});

test("holatlar ro'yxati Prisma enumi bilan AYNI", () => {
  const fs = require("node:fs");
  const schema = fs.readFileSync(require.resolve("../prisma/schema.prisma"), "utf8");
  const block = schema.match(/enum LeadStatus \{([\s\S]*?)\n\}/)[1];
  const enumValues = block
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line && !line.startsWith("//"));

  assert.deepEqual(
    [...h.LEAD_STATUSES].sort(),
    [...enumValues].sort(),
    "yordamchidagi ro'yxat va enum bir-biridan uzoqlashgan",
  );
});

test("yorliq: har holatda bor va zinapoya nomlari bilan bir xil", () => {
  for (const status of h.LEAD_STATUSES) {
    const label = h.statusLabel(status);
    assert.ok(label && label !== status, `${status} yorliqsiz`);
  }
  assert.equal(h.statusLabel("enrolled"), "To'lov qildi");
  assert.equal(h.statusLabel("attended"), "Darsga kirdi");
  // Noma'lum qiymat yashirilmaydi — borligicha qaytadi
  assert.equal(h.statusLabel("xyz"), "xyz");
});

test("pog'ona ma'lumoti raqam bo'yicha olinadi", () => {
  assert.equal(h.stageMeta(4).status, "attended");
  assert.equal(h.stageMeta(6).label, "To'lov qildi");
  assert.equal(h.stageMeta(0), null);
  assert.equal(h.stageMeta(7), null);
});
