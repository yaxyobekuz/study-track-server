const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * SERTIFIKAT REJALARI — SANA VA ISM O'QISH.
 *
 * Qabul mezonlari:
 *   - Google Forms eksportidagi "Dec 1, 2026" va "9/29/2026 10:24:24"
 *     to'g'ri o'qiladi (timestamp TOSHKENT devor-soati deb olinadi)
 *   - `01.12.2026` ustun bo'yicha hal qilinadi, bitta qatorga qarab emas
 *   - xlsx bergan `Date` katak kunni BIR KUNGA SURMAYDI
 *   - imlo xatosi bor ism TAKLIF darajasida topiladi, begona ism esa yo'q
 */

process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db?schema=public";

const {
  DATE_ORDER,
  planActiveKey,
  normalizeName,
  nameSortKey,
  nameSimilarity,
  editDistance,
  detectDateOrder,
  parseSheetDay,
  parseSheetInstant,
  monthKeyOf,
  daysLeft,
} = require("../src/helpers/certificate.helpers");

const day = (value) => (value ? value.toISOString().slice(0, 10) : null);

/* ─────────────────────────── SANA ─────────────────────────── */

test("oy nomi bilan — inglizcha (Google Forms) va o'zbekcha", () => {
  assert.equal(day(parseSheetDay("Dec 1, 2026")), "2026-12-01");
  assert.equal(day(parseSheetDay("Mar 13, 2027")), "2027-03-13");
  assert.equal(day(parseSheetDay("September 5, 2026")), "2026-09-05");
  assert.equal(day(parseSheetDay("1-dekabr, 2026")), "2026-12-01");
  assert.equal(day(parseSheetDay("5 sentabr 2026")), "2026-09-05");
  // Imlo xatosi FORMAT sifatida taqiqlangan, lekin O'QISHDA qabul qilinadi
  assert.equal(day(parseSheetDay("5 sentyabr 2026")), "2026-09-05");
});

test("ISO qiymat — mashina formati", () => {
  assert.equal(day(parseSheetDay("2026-12-01")), "2026-12-01");
  assert.equal(day(parseSheetDay("2026-12-01T00:00:00.000Z")), "2026-12-01");
});

test("UTC yarim tunida saqlanadi — `@db.Date` uslubi", () => {
  const parsed = parseSheetDay("Dec 1, 2026");
  assert.equal(parsed.getUTCHours(), 0);
  assert.equal(parsed.getUTCMinutes(), 0);
  assert.equal(parsed.getUTCMilliseconds(), 0);
});

test("raqamli sana — TARTIB ustundan keladi", () => {
  // Kun oldin (o'zbekcha sukut)
  assert.equal(day(parseSheetDay("01.12.2026", DATE_ORDER.DMY)), "2026-12-01");
  // Oy oldin (Google Forms)
  assert.equal(day(parseSheetDay("01/12/2026", DATE_ORDER.MDY)), "2026-01-12");
});

test("qiymatning O'ZI tartibni inkor qilsa, qiymat yutadi", () => {
  // 29 oy bo'lolmaydi — tartib "oy oldin" bo'lsa ham kun deb o'qiladi
  assert.equal(day(parseSheetDay("29/09/2026", DATE_ORDER.MDY)), "2026-09-29");
  assert.equal(day(parseSheetDay("09/29/2026", DATE_ORDER.DMY)), "2026-09-29");
});

test("ustun bo'yicha tartib — bitta aniq qator butun ustunni hal qiladi", () => {
  const forms = detectDateOrder(["9/29/2026 10:24", "1/2/2026 11:00"], DATE_ORDER.DMY);
  assert.equal(forms.order, DATE_ORDER.MDY);
  assert.equal(forms.decided, true);

  const uz = detectDateOrder(["29.09.2026", "01.02.2026"], DATE_ORDER.MDY);
  assert.equal(uz.order, DATE_ORDER.DMY);
  assert.equal(uz.decided, true);

  // Hech narsa aniqlanmasa — `fallback`, lekin "hal qilindi" DEMAYDI
  const unknown = detectDateOrder(["01.02.2026"], DATE_ORDER.DMY);
  assert.equal(unknown.order, DATE_ORDER.DMY);
  assert.equal(unknown.decided, false);
  assert.equal(unknown.ambiguous, false);

  // Faylda IKKI XIL format — ogohlantiriladi
  const mixed = detectDateOrder(["29/09/2026", "9/29/2026"], DATE_ORDER.DMY);
  assert.equal(mixed.ambiguous, true);
  assert.equal(mixed.decided, false);
});

test("ISO qiymat tartib ovoziga KIRMAYDI", () => {
  // "2026-12-01" da birinchi qism — yil, u tartib haqida hech narsa demaydi
  const result = detectDateOrder(["2026-12-01", "2026-01-13"], DATE_ORDER.DMY);
  assert.equal(result.decided, false);
});

test("mavjud bo'lmagan kun RAD ETILADI (jim surilmaydi)", () => {
  assert.equal(parseSheetDay("31.02.2026"), null);
  assert.equal(parseSheetDay("Feb 31, 2026"), null);
  assert.equal(parseSheetDay("2026-13-01"), null);
});

test("bo'sh va yaroqsiz qiymat — `null`, xato EMAS", () => {
  // "Aniq sanani bilmayman" javobi ham shu yo'ldan o'tadi
  assert.equal(parseSheetDay(""), null);
  assert.equal(parseSheetDay(null), null);
  assert.equal(parseSheetDay(undefined), null);
  assert.equal(parseSheetDay("keyinroq aytaman"), null);
});

test("xlsx bergan `Date` katak — kun BIR KUNGA SURILMAYDI", () => {
  // `cellDates` sanani MAHALLIY yarim tun qilib quradi. UTC bo'yicha
  // o'qilsa 30-noyabr bo'lib qolardi.
  const local = new Date("2026-12-01T00:00:00+05:00");
  assert.equal(day(parseSheetDay(local)), "2026-12-01");

  // UTC yarim tuni ham o'z kunida qoladi
  assert.equal(day(parseSheetDay(new Date("2026-12-01T00:00:00Z"))), "2026-12-01");
});

test("Excel seriya raqami (CSV orqali kelganda)", () => {
  // 46023 → 2026-01-01 (1900 tizimi: 1 = 1900-01-01)
  assert.equal(day(parseSheetDay(46023)), "2026-01-01");
  assert.equal(parseSheetDay(0), null);
  assert.equal(parseSheetDay(-5), null);
});

test("forma timestamp'i — TOSHKENT devor-soati deb o'qiladi", () => {
  const stamp = parseSheetInstant("9/29/2026 10:24:24", DATE_ORDER.MDY);
  // 10:24 Toshkent = 05:24 UTC (+5, DST yo'q)
  assert.equal(stamp.toISOString(), "2026-09-29T05:24:24.000Z");
});

test("timestamp'siz qator — `null`, import to'xtamaydi", () => {
  assert.equal(parseSheetInstant(""), null);
  assert.equal(parseSheetInstant("Dec 1, 2026").toISOString(), "2026-11-30T19:00:00.000Z");
});

test("yaroqsiz vaqt RAD ETILADI", () => {
  assert.equal(parseSheetInstant("9/29/2026 25:00:00", DATE_ORDER.MDY), null);
  assert.equal(parseSheetInstant("9/29/2026 10:75:00", DATE_ORDER.MDY), null);
});

/* ─────────────────────────── MUDDAT ─────────────────────────── */

test("oy kaliti — `getUTC*` bilan", () => {
  assert.equal(monthKeyOf(parseSheetDay("Dec 1, 2026")), "2026-12");
  assert.equal(monthKeyOf(parseSheetDay("Jan 31, 2027")), "2027-01");
  assert.equal(monthKeyOf(null), null);
});

test("qolgan kunlar — bugun 0, o'tgan muddat MANFIY", () => {
  const today = new Date(Date.UTC(2026, 9, 19));
  assert.equal(daysLeft(new Date(Date.UTC(2026, 9, 19)), today), 0);
  assert.equal(daysLeft(new Date(Date.UTC(2026, 9, 20)), today), 1);
  assert.equal(daysLeft(new Date(Date.UTC(2026, 9, 18)), today), -1);
  assert.equal(daysLeft(null, today), null);
});

/* ─────────────────────────── ISM ─────────────────────────── */

test("normallashtirish — apostrof va bo'shliq", () => {
  assert.equal(normalizeName("  Po'latov   Muhammadjon "), "polatov muhammadjon");
  assert.equal(normalizeName("Po‘latov Muhammadjon"), "polatov muhammadjon");
  assert.equal(normalizeName("POʻLATOV"), "polatov");
  assert.equal(normalizeName(null), "");
});

test("so'z tartibi MUHIM EMAS — qat'iy moslik kaliti", () => {
  assert.equal(
    nameSortKey("Ummatillayev Halililloh"),
    nameSortKey("Halililloh Ummatillayev"),
  );
  assert.notEqual(nameSortKey("Ali Valiyev"), nameSortKey("Olim Valiyev"));
});

test("tahrir masofasi", () => {
  assert.equal(editDistance("suhrobbek", "suhrobbek"), 0);
  assert.equal(editDistance("suhrobbek", "suhrobbrk"), 1);
  assert.equal(editDistance("", "abc"), 3);
});

test("IMLO XATOSI bor ism — TAKLIF darajasida topiladi", () => {
  // Importdagi haqiqiy qatorlar
  assert.ok(nameSimilarity("Abdumalikov Suhrobbrk", "Abdumalikov Suhrobbek") > 0.9);
  assert.ok(nameSimilarity("Vosiyev Ahmaduloo", "Vosiyev Ahmadullo") > 0.9);
  assert.ok(nameSimilarity("Pulatov Muhammadjon", "Po'latov Muhammadjon") > 0.9);
});

test("teskari tartib — TO'LIQ moslik", () => {
  assert.equal(nameSimilarity("Nodirbek Xamdamov", "Xamdamov Nodirbek"), 1);
});

test("BEGONA ism — moslik YO'Q", () => {
  assert.equal(nameSimilarity("Qambarov Abdulaziz", "Anvarov Muhammadamin"), 0);
  assert.equal(nameSimilarity("", "Anvarov Muhammadamin"), 0);
});

test("qisqa so'zda bitta xato ham MOSLIK EMAS", () => {
  // "Ali" va "Olи" — uch harfli so'zda bitta farq boshqa ism bo'ladi
  assert.equal(nameSimilarity("Ali", "Oli"), 0);
});

test("faol reja kaliti", () => {
  assert.equal(planActiveKey("a".repeat(24), "b".repeat(24)), `${"a".repeat(24)}|${"b".repeat(24)}`);
});
