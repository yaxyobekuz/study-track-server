const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * MOS KELISH QARORI VA KELISH/KETISH TANLOVI.
 *
 * ⚠️ Bu ikki qoida butun modulning xatti-harakatini belgilaydi va
 * ikkalasining ham buzilishi JIM bo'ladi:
 *
 *   · `margin` ishlamasa — aka-uka (yoki egizak) navbatma-navbat
 *     bir-birining davomatini belgilab ketadi va hisobot to'g'ri
 *     ko'rinib turadi;
 *   · `decideStaffAction` buzilsa — eshikdan kirgan xodim darhol
 *     "ketdi" bo'lib, ish kuni yarimlaydi va erta ketish jarimasi
 *     yoziladi.
 */

const { findNearest } = require("../src/services/faceGallery.service");
const { decideStaffAction } = require("../src/services/faceAttendance.service");
const { normalizeEmbedding } = require("../src/helpers/faceEmbedding.helpers");

const DIM = 128;

/** Berilgan "urug'" bo'yicha barqaror vektor — test takrorlanadigan bo'lsin. */
const vectorOf = (seed) =>
  normalizeEmbedding(Array.from({ length: DIM }, (_, i) => Math.sin((i + 1) * seed)));

/** Vektorni ozgina "buzadi" — o'xshash, lekin aynan emas. */
const nudge = (vector, amount) =>
  normalizeEmbedding(Array.from(vector, (value, i) => value + (i % 2 ? amount : -amount)));

const personOf = (userId, name, vectors) => ({
  profileId: `p-${userId}`,
  userId,
  name,
  role: "teacher",
  isActive: true,
  photo: null,
  vectors,
});

/* ═══════════════════════ MOS KELISH ═══════════════════════ */

test("findNearest: eng yaxshi NAMUNA bo'yicha topadi (eng yaxshi odam emas)", () => {
  // ⚠️ Odamning bir nechta namunasi bor (ko'zoynakli/ko'zoynaksiz) va
  // taqqoslash ularning ENG YAXSHISI bo'yicha ketadi. O'rtacha
  // olinsa, ko'zoynak kiygan odam har kuni "tanilmadi" bo'lardi.
  const target = vectorOf(0.3);
  const gallery = {
    entries: [
      personOf("u1", "Birinchi", [vectorOf(1.1), target, vectorOf(2.7)]),
      personOf("u2", "Ikkinchi", [vectorOf(3.3)]),
    ],
  };

  const { best, score } = findNearest(target, gallery);

  assert.equal(best.userId, "u1");
  assert.ok(score > 0.999999, "aynan mos namuna topilishi kerak");
});

test("findNearest: `margin` IKKINCHI ODAM bo'yicha hisoblanadi", () => {
  // ⚠️ Bu modulning eng muhim invarianti. Aka-uka: ikkalasining
  // vektori juda yaqin, demak `margin` KICHIK bo'lishi va chaqiruvchi
  // (`faceAttendance`) javobni `ambiguous` qilishi kerak.
  const base = vectorOf(0.9);
  const twin = nudge(base, 0.02);

  const gallery = {
    entries: [personOf("u1", "Aka", [base]), personOf("u2", "Uka", [twin])],
  };

  const { best, score, margin } = findNearest(base, gallery);

  assert.equal(best.userId, "u1", "aynan mos keluvchi birinchi");
  assert.ok(score > margin, "margin — farq, ballning o'zi emas");
  assert.ok(margin < 0.05, `egizaklarda margin kichik bo'lishi kerak, keldi: ${margin}`);
});

test("findNearest: AYNI ODAMNING ikkinchi namunasi `margin` ni PASAYTIRMAYDI", () => {
  // ⚠️ Odamning ikkita o'xshash namunasi bo'lishi NORMAL. Agar
  // `margin` ular orasida hisoblansa, har kimning davomati
  // "noaniq" bo'lib to'silib qolardi — ya'ni modul umuman
  // ishlamasdi.
  const base = vectorOf(1.7);
  const almost = nudge(base, 0.01);

  const gallery = {
    entries: [
      personOf("u1", "Yolg'iz", [base, almost]),
      personOf("u2", "Boshqa", [vectorOf(4.2)]),
    ],
  };

  const { best, margin } = findNearest(base, gallery);

  assert.equal(best.userId, "u1");
  assert.ok(margin > 0.5, `o'z namunasi margin ga kirmasligi kerak, keldi: ${margin}`);
});

test("findNearest: raqobatchi BO'LMASA margin to'liq ball", () => {
  const target = vectorOf(2.1);
  const gallery = { entries: [personOf("u1", "Yagona", [target])] };

  const { margin, score, runnerUp } = findNearest(target, gallery);

  assert.equal(runnerUp, null);
  assert.equal(margin, score, "raqobatchi yo'q — butun ball farq");
});

test("findNearest: BO'SH galereya — `best: null`", () => {
  // Hali hech kim ro'yxatga olinmagan holat: chaqiruvchi buni
  // "tanilmadi" dan ajratib, boshqa xabar ko'rsatadi.
  const { best, score } = findNearest(vectorOf(1), { entries: [] });

  assert.equal(best, null);
  assert.equal(score, -1);
});

test("findNearest: MOS KELMAYDIGAN o'lchamli namuna o'tkazib yuboriladi", () => {
  // ⚠️ Galereya qurilishida modeli mos kelmaganlar filtrlanadi, lekin
  // taqqoslovchining o'zi ham yiqilmasligi kerak: `cosineSimilarity`
  // bunday juftlikka `-1` beradi.
  const target = vectorOf(0.5);
  const wrongDim = normalizeEmbedding(Array.from({ length: 256 }, (_, i) => i + 1));

  const gallery = {
    entries: [personOf("u1", "Eski model", [wrongDim]), personOf("u2", "Yangi", [target])],
  };

  const { best } = findNearest(target, gallery);
  assert.equal(best.userId, "u2");
});

/* ═══════════════════ KELISH / KETISH ═══════════════════ */

const SETTINGS = { checkoutMinMinutes: 60 };

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000);

test("decideStaffAction: qayd YO'Q → kelish", () => {
  assert.equal(decideStaffAction(null, "auto", SETTINGS).kind, "checkIn");
  assert.equal(decideStaffAction({ id: "a" }, "auto", SETTINGS).kind, "checkIn");
});

test("decideStaffAction: kelish bor, vaqt O'TMAGAN → `already` (ketish EMAS)", () => {
  // ⚠️ MODULNING ENG MUHIM HIMOYASI. Eshikdan kirib ikkinchi marta
  // kameraga tushgan xodim darhol "ketdi" bo'lib qolmasligi kerak:
  // xato kelish zarariz, xato ketish esa ish kunini yarimlatadi va
  // erta ketish jarimasini yozadi.
  const record = { id: "a", checkIn: minutesAgo(5), checkOut: null };
  const action = decideStaffAction(record, "auto", SETTINGS);

  assert.equal(action.kind, "checkIn");
  assert.equal(action.already, true);
  assert.match(action.message, /allaqachon qayd etilgan/);
});

test("decideStaffAction: kelish bor, vaqt O'TGAN → ketish", () => {
  const record = { id: "a", checkIn: minutesAgo(120), checkOut: null };
  assert.equal(decideStaffAction(record, "auto", SETTINGS).kind, "checkOut");
});

test("decideStaffAction: `intent: checkOut` VAQTNI KUTMAYDI", () => {
  // Odam "Ishdan ketyapman" tugmasini ataylab bosgan — u nima
  // qilayotganini biladi va `checkoutGate` baribir tekshiradi.
  const record = { id: "a", checkIn: minutesAgo(3), checkOut: null };
  assert.equal(decideStaffAction(record, "checkOut", SETTINGS).kind, "checkOut");
});

test("decideStaffAction: ketish ALLAQACHON bor → `already`", () => {
  const record = { id: "a", checkIn: minutesAgo(400), checkOut: minutesAgo(10) };
  const action = decideStaffAction(record, "auto", SETTINGS);

  assert.equal(action.kind, "checkOut");
  assert.equal(action.already, true);
  assert.match(action.message, /kelish .* va ketish/);
});

test("decideStaffAction: `checkoutMinMinutes = 0` → darhol ketishga ruxsat", () => {
  // Sozlamadagi 0 "cheklov yo'q" degani va u 60 ga aylanib
  // ketmasligi kerak (`??` emas, `|| 0` tuzog'i).
  const record = { id: "a", checkIn: minutesAgo(1), checkOut: null };
  assert.equal(
    decideStaffAction(record, "auto", { checkoutMinMinutes: 0 }).kind,
    "checkOut",
  );
});
