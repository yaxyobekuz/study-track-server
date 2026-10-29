/**
 * TELEFON RAQAMI — hisobotdagi "o'quvchi / ota-ona" katagi.
 *
 * Katakning butun ma'nosi QATOR TARTIBIDA: birinchi qator o'quvchining,
 * ikkinchisi ota-onasining raqami. Shuning uchun bu yerda aynan BO'SH
 * tomon sinaladi — agar raqami yo'q tomon tashlab ketilsa, qolgan yolg'iz
 * raqam kimniki ekani noma'lum bo'lib qoladi va qo'ng'iroq noto'g'ri
 * odamga ketardi.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizePhone,
  formatPhoneUz,
  phonePairText,
  PHONE_PAIR_LABEL,
} = require("../src/helpers/phone.helpers");

const DASH = "—";

test("ikkala raqam ham bor — ikki qator, tartibi: o'quvchi, ota-ona", () => {
  const text = phonePairText({
    phone: "+998901234567",
    parentPhone: "+998912345678",
  });

  assert.equal(text, "+998 90 123 45 67\n+998 91 234 56 78");
  assert.equal(text.split("\n").length, 2);
});

test("o'quvchining raqami yo'q — o'rni BO'SH QOLMAYDI", () => {
  const text = phonePairText({ parentPhone: "+998912345678" });

  assert.equal(text, `${DASH}\n+998 91 234 56 78`);
  assert.equal(
    text.split("\n")[1],
    formatPhoneUz("+998912345678"),
    "ota-onanikidir degan javob IKKINCHI qatorda turishi kerak",
  );
});

test("ota-onaning raqami yo'q — o'quvchiniki BIRINCHI qatorda qoladi", () => {
  assert.equal(
    phonePairText({ phone: "+998901234567" }),
    `+998 90 123 45 67\n${DASH}`,
  );
});

test("ikkalasi ham yo'q — bitta tire (bo'sh ikki qator emas)", () => {
  assert.equal(phonePairText({}), DASH);
  assert.equal(phonePairText(null), DASH);
  assert.equal(phonePairText(undefined), DASH);
  assert.equal(phonePairText({ phone: null, parentPhone: "" }), DASH);
});

test("formatlash YAGONA nuqtadan — katak o'z shaklini o'ylab topmaydi", () => {
  // Normalizatsiyadan o'tgan qiymat qanday ko'rinsa, katakda ham shunday.
  const stored = normalizePhone("90 123 45 67");

  assert.equal(stored, "+998901234567");
  assert.equal(phonePairText({ phone: stored }).split("\n")[0], formatPhoneUz(stored));
});

test("yaroqsiz uzunlikdagi eski qiymat yashirilmaydi", () => {
  // `formatPhoneUz` doktrinasi: tanimagan qiymatni borligicha ko'rsatadi —
  // yashirib qo'yish raqamni yo'qotgandek tuyulardi.
  assert.equal(phonePairText({ phone: "12345" }), `12345\n${DASH}`);
});

test("ustun sarlavhasi qator tartibini AYTADI", () => {
  // Katak o'zi "qaysi raqam kimniki" deb yozmaydi (joy yetmaydi), shuning
  // uchun javob sarlavhada turishi SHART.
  assert.match(PHONE_PAIR_LABEL, /o'quvchi/i);
  assert.match(PHONE_PAIR_LABEL, /ota-ona/i);
  assert.ok(
    PHONE_PAIR_LABEL.indexOf("o'quvchi") < PHONE_PAIR_LABEL.indexOf("ota-ona"),
    "sarlavhadagi tartib katakdagi tartib bilan bir xil bo'lishi kerak",
  );
});
