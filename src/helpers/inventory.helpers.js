/**
 * Inventar domenining primitivlari — MIQDOR bilan ishlash.
 *
 * Moliya domenida o'lchov PUL (`money.helpers.js`), bu yerda esa MIQDOR:
 * butun son, dona. Ikkalasi bir faylga qo'shilmagan, chunki ularning
 * invariantlari boshqa — pulda ishora tipdan kelib chiqadi, miqdorda esa
 * IKKI ustun (jami va yaroqsiz) bir vaqtda o'zgaradi va ular orasidagi
 * munosabat ham tekshirilishi kerak.
 *
 * ── NIMA UCHUN KASR YO'Q ─────────────────────
 *
 * Xatlov SANALADIGAN buyumlar haqida: parta, piyola, proyektor. "2.5 kg un"
 * bu domenda yo'q va bo'lmasligi kerak — u ombor/oziq-ovqat domeni, o'z
 * o'lchov birligi va o'z hisobi bilan. Shu sababli miqdor `Int`, ya'ni
 * yaxlitlash xatosi STRUKTURA BO'YICHA imkonsiz.
 */

const { BadRequestError, InternalServerError } = require("../utils/errors");
const { Decimal, toDecimal } = require("./money.helpers");

// Bitta harakatda o'zgarishi mumkin bo'lgan maksimal miqdor. Chegara
// bo'lmasa "20" o'rniga "200000" yozilgan xato faqat inventarizatsiyada
// topilardi.
const MAX_QUANTITY = 1_000_000;

// ─────────────────────────────────────────────
// ISHORA INVARIANTLARI
// ─────────────────────────────────────────────

/**
 * Har bir harakat turi uchun kutilayotgan ishoralar.
 *
 * `assertSignMatchesType` (money.helpers) bilan bir xil mulohaza: ishora
 * KELISHUV emas, INVARIANT. Teskarisi yozilsa xatlov jimgina buziladi va
 * buni faqat yillik inventarizatsiya topardi.
 *
 * Belgilar:
 *   "+"   — noldan katta bo'lishi SHART
 *   "-"   — noldan kichik bo'lishi SHART
 *   "0"   — aynan nol
 *   "0+"  — nol yoki musbat
 *   "0-"  — nol yoki manfiy
 *   "any" — ikkala tomon ham qonuniy
 */
const MOVEMENT_RULES = {
  // Boshlang'ich xatlov: jihoz tizimga birinchi marta kiritildi.
  // Yaroqsizi ham bo'lishi mumkin ("20 ta parta, 3 tasi allaqachon singan").
  initial: { quantity: "+", broken: "0+" },

  // Yangi jihoz sotib olindi — yaroqsiz holda kelmaydi
  purchase: { quantity: "+", broken: "0" },

  // ZARAR. Ikki xil ta'sir, `InventoryDamageKind` ga qarab:
  //   broken  → jami o'zgarmaydi (buyum xonada turibdi), yaroqsiz ORTADI
  //   missing → jami KAMAYADI (buyum yo'q), yaroqsiz o'zgarmaydi
  // Shuning uchun bitta tipda ikkala shakl ham qonuniy.
  damage: { quantity: "0-", broken: "0+" },

  // Ta'mirlandi — yaroqsizlar safidan chiqdi, jami o'zgarmaydi
  repair: { quantity: "0", broken: "-" },

  // Hisobdan chiqarildi — jami kamayadi; agar yaroqsiz bo'lgani
  // chiqarilsa, yaroqsizlar soni ham kamayadi
  write_off: { quantity: "-", broken: "0-" },

  transfer_in: { quantity: "+", broken: "0+" },
  transfer_out: { quantity: "-", broken: "0-" },

  // Sanoq farqi — YAGONA ikki tomonlama tip (`adjustment` daftarda ham
  // shunday: money.helpers.js → ENTRY_SIGNS)
  adjustment: { quantity: "any", broken: "any" },

  // Zarar bekor qilindi — `damage` ning aynan teskarisi
  damage_revert: { quantity: "0+", broken: "0-" },
};

/** Bitta qiymat qoidaga mos keladimi. */
const matchesRule = (value, rule) => {
  switch (rule) {
    case "+":
      return value > 0;
    case "-":
      return value < 0;
    case "0":
      return value === 0;
    case "0+":
      return value >= 0;
    case "0-":
      return value <= 0;
    case "any":
      return true;
    default:
      return false;
  }
};

/**
 * Harakatning ishoralari turiga mos kelishini tekshiradi.
 *
 * `InternalServerError` — bu foydalanuvchi xatosi emas, KOD xatosi
 * (`assertSignMatchesType` bilan bir xil qaror).
 *
 * @param {string} type - InventoryMovementType
 * @param {number} quantityDelta - ishorali
 * @param {number} brokenDelta - ishorali
 * @throws {InternalServerError}
 */
function assertMovementSigns(type, quantityDelta, brokenDelta) {
  const rule = MOVEMENT_RULES[type];

  if (!rule) {
    throw new InternalServerError(`Miqdor daftari turi noma'lum: ${type}`);
  }
  if (!Number.isInteger(quantityDelta) || !Number.isInteger(brokenDelta)) {
    throw new InternalServerError("Miqdor o'zgarishi butun son bo'lishi kerak");
  }

  // Bo'sh qator daftarni faqat shovqin bilan to'ldirardi
  if (quantityDelta === 0 && brokenDelta === 0) {
    throw new InternalServerError(
      `Miqdor daftariga bo'sh qator yozib bo'lmaydi: ${type}`,
    );
  }

  if (!matchesRule(quantityDelta, rule.quantity)) {
    throw new InternalServerError(
      `Miqdor o'zgarishi turiga mos emas: ${type} → quantityDelta=${quantityDelta}`,
    );
  }
  if (!matchesRule(brokenDelta, rule.broken)) {
    throw new InternalServerError(
      `Yaroqsiz miqdor o'zgarishi turiga mos emas: ${type} → brokenDelta=${brokenDelta}`,
    );
  }
}

/**
 * Xatlov qatorining O'ZI mantiqan to'g'rimi — harakat YOZILGANDAN KEYIN.
 *
 * Ikki invariant, ikkalasi ham "manfiy balans" ning miqdordagi ko'rinishi:
 *   1) jami manfiy bo'la olmaydi;
 *   2) yaroqsizlar soni jamidan ko'p bo'la olmaydi ("20 ta partaning
 *      25 tasi singan" — ma'nosiz).
 *
 * ⚠️ Kassadan farqli o'laroq bu yerda manfiy qoldiq TAQIQLANADI. Kassada
 * u qonuniy edi (daftar haqiqatni yozadi, xodim xarajatni kirita olishi
 * kerak); xatlovda esa manfiy miqdor haqiqat EMAS — u har doim kiritish
 * xatosi, chunki mavjud bo'lmagan partani sindirib bo'lmaydi.
 *
 * @param {number} quantityAfter
 * @param {number} brokenAfter
 * @param {string} label - xato xabaridagi jihoz nomi
 * @throws {BadRequestError}
 */
function assertStockConsistency(quantityAfter, brokenAfter, label = "Jihoz") {
  if (quantityAfter < 0) {
    throw new BadRequestError(
      `${label}: xatlovda mavjud miqdordan ko'pini chiqarib bo'lmaydi`,
    );
  }
  if (brokenAfter < 0) {
    throw new BadRequestError(
      `${label}: yaroqsizlar soni manfiy bo'lib qoladi`,
    );
  }
  if (brokenAfter > quantityAfter) {
    throw new BadRequestError(
      `${label}: yaroqsizlar soni (${brokenAfter}) jami miqdordan ` +
        `(${quantityAfter}) ko'p bo'lishi mumkin emas`,
    );
  }
}

// ─────────────────────────────────────────────
// MIQDORNI O'QISH
// ─────────────────────────────────────────────

/**
 * Manfiy bo'lmagan butun miqdor.
 * @param {*} value
 * @param {string} label
 * @returns {number}
 * @throws {BadRequestError}
 */
function parseQuantity(value, label = "Miqdor") {
  if (value === "" || value == null) {
    throw new BadRequestError(`${label} kiritilmagan`);
  }

  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new BadRequestError(`${label} butun son bo'lishi kerak`);
  }
  if (num < 0) {
    throw new BadRequestError(`${label} manfiy bo'lishi mumkin emas`);
  }
  if (num > MAX_QUANTITY) {
    throw new BadRequestError(`${label} juda katta`);
  }

  return num;
}

/**
 * Ixtiyoriy miqdor — berilmagan bo'lsa 0.
 * Kunlik hisobot satrida uchta maydonning aksari bo'sh keladi.
 */
function parseOptionalQuantity(value, label = "Miqdor") {
  if (value === "" || value == null) return 0;
  return parseQuantity(value, label);
}

/** Ishorali miqdor — faqat `adjustment` uchun. */
function parseSignedQuantity(value, label = "Miqdor") {
  if (value === "" || value == null) {
    throw new BadRequestError(`${label} kiritilmagan`);
  }

  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new BadRequestError(`${label} butun son bo'lishi kerak`);
  }
  if (Math.abs(num) > MAX_QUANTITY) {
    throw new BadRequestError(`${label} juda katta`);
  }

  return num;
}

// ─────────────────────────────────────────────
// ZARAR SABABI
// ─────────────────────────────────────────────

/**
 * Sababni o'qiydi va TURGA mosligini tekshiradi.
 *
 * @param {*} value - InventoryDamageReason yoki bo'sh
 * @param {string} kind - InventoryDamageKind ("broken" | "missing")
 * @param {object} [options]
 * @param {string} [options.note] - erkin izoh ("boshqa" uchun tekshiriladi)
 * @param {boolean} [options.required=false] - berilmasa xato beriladimi
 * @param {boolean} [options.requireNote=true] - "boshqa" uchun izoh talab qilinsinmi.
 *   QORALAMA bosqichida `false`: xodim avval sababni tanlab, izohni keyin
 *   yozishi mumkin. Yuborishda esa `true` — muhrlangan hodisa izohsiz
 *   "boshqa" bo'lib qolmasin.
 * @param {boolean} [options.allowEmpty=false] - bo'sh qiymatda standart
 *   O'RNIGA `null` qaytarilsinmi (qoralama satri uchun)
 * @param {string} [options.label="Sabab"] - xato xabaridagi kontekst
 * @returns {string|null} InventoryDamageReason
 * @throws {BadRequestError}
 */
function parseDamageReason(value, kind, options = {}) {
  const {
    note,
    required = false,
    requireNote = true,
    allowEmpty = false,
    label = "Sabab",
  } = options;

  const allowed = REASONS_BY_KIND[kind];
  if (!allowed) {
    throw new InternalServerError(`Zarar turi noma'lum: ${kind}`);
  }

  const raw = value == null || value === "" ? null : String(value);

  if (raw === null) {
    if (required) throw new BadRequestError(`${label} tanlanishi kerak`);
    return allowEmpty ? null : DEFAULT_REASON_BY_KIND[kind];
  }

  if (!DAMAGE_REASON_LABELS[raw]) {
    throw new BadRequestError(`${label} noto'g'ri`);
  }
  if (!allowed.includes(raw)) {
    throw new BadRequestError(
      `${label}: "${DAMAGE_REASON_LABELS[raw]}" ` +
        `"${DAMAGE_KIND_LABELS[kind]}" turiga mos kelmaydi`,
    );
  }

  // "Boshqa" — izohsiz ma'nosiz
  if (requireNote && REASONS_REQUIRING_NOTE.includes(raw) && !String(note ?? "").trim()) {
    throw new BadRequestError(
      `${label}: "${DAMAGE_REASON_LABELS[raw]}" tanlanganda izoh yozilishi shart`,
    );
  }

  return raw;
}

// ─────────────────────────────────────────────
// ZARAR SUMMASI
// ─────────────────────────────────────────────

/**
 * Zarar summasi — `quantity × unitPrice`, MUHRLANADIGAN qiymat.
 *
 * Bitta joyda, chunki chaqiruvchisi ikkita: kunlik hisobotdan tug'ilgan
 * zarar va qo'lda kiritilgan zarar. Ikkita mustaqil hisob bo'lsa,
 * yaxlitlash qoidasi faqat bittasiga qo'shilib qolardi
 * (`invoiceBuilder.service.js` bilan bir xil mulohaza).
 *
 * @param {number} quantity
 * @param {Prisma.Decimal|string|number} unitPrice
 * @returns {Prisma.Decimal}
 */
function damageAmountOf(quantity, unitPrice) {
  return toDecimal(unitPrice).times(quantity).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

// ─────────────────────────────────────────────
// YORLIQLAR (foydalanuvchi matni — server javobida ham kerak)
// ─────────────────────────────────────────────

const LOCATION_TYPE_LABELS = {
  classroom: "Sinf xonasi",
  canteen: "Oshxona",
  gym: "Sport zali",
  library: "Kutubxona",
  lab: "Laboratoriya",
  office: "Xodim xonasi",
  corridor: "Umumiy joy",
  dorm: "Yotoqxona",
  warehouse: "Ombor",
  other: "Boshqa",
};

const MOVEMENT_TYPE_LABELS = {
  initial: "Boshlang'ich xatlov",
  purchase: "Yangi jihoz",
  damage: "Zarar",
  repair: "Ta'mirlandi",
  write_off: "Hisobdan chiqarildi",
  transfer_in: "Ko'chirildi (kirim)",
  transfer_out: "Ko'chirildi (chiqim)",
  adjustment: "Qo'lda to'g'rilash",
  damage_revert: "Zarar bekor qilindi",
};

const DAMAGE_KIND_LABELS = {
  broken: "Singan / yaroqsiz",
  missing: "Yo'qolgan",
};

// ZARAR SABABI — `kind` dan MUSTAQIL ikkinchi o'lchov (`schema.prisma`
// dagi `InventoryDamageReason` izohiga qarang).
const DAMAGE_REASON_LABELS = {
  broken: "Sindi",
  expired: "Yaroqlilik muddati tugadi",
  worn_out: "Eskirdi",
  misused: "Noto'g'ri foydalanildi",
  lost: "Yo'qoldi",
  stolen: "O'g'irlandi",
  other: "Boshqa",
};

/**
 * Qaysi sabab qaysi TURDA qonuniy.
 *
 * Ro'yxat kesishmaydigan emas: `expired` va `other` IKKALASIDA ham bor va
 * bu ataylab — yaroqlilik muddati tugagan piyola xonada turaveradi
 * (`broken`), tugagan sut esa tashlab yuboriladi (`missing`). Qolganlari
 * esa faqat bitta turda ma'noli: "yo'qoldi" degan sabab bilan xonada
 * turgan buyumni belgilash mumkin emas.
 *
 * ⚠️ Bu tekshiruv MAJBURIY: sabab bilan tur mos kelmasa, hisobotdagi
 * "nechta jihoz yo'qoldi" va "nechta jihoz yaroqsiz" kesimlari bir-birini
 * inkor qilardi.
 */
const REASONS_BY_KIND = {
  broken: ["broken", "expired", "worn_out", "misused", "other"],
  missing: ["lost", "stolen", "expired", "other"],
};

/**
 * Sabab ko'rsatilmaganda ishlatiladigan qiymat.
 *
 * Faqat ESKI mijozlar uchun murosa: kunlik hisobotda sabab MAJBURIY
 * (`inventoryCheck.service.js`), qo'lda zarar kiritishda esa berilmasa
 * turdan kelib chiqadi — aks holda `POST /damages` ning eski shakli
 * birdaniga ishlamay qolardi.
 */
const DEFAULT_REASON_BY_KIND = {
  broken: "broken",
  missing: "lost",
};

// Erkin izoh MAJBURIY bo'ladigan sabablar. "Boshqa" deb belgilab izoh
// yozmaslik — hisobotni "boshqa: 47 ta" degan javobsiz qatorga aylantirardi.
const REASONS_REQUIRING_NOTE = ["other"];

const DAMAGE_STATUS_LABELS = {
  pending: "Aybdor aniqlanmagan",
  charged: "Aybdorga yozilgan",
  waived: "Maktab hisobidan",
  cancelled: "Bekor qilingan",
};

const CHARGE_STATUS_LABELS = {
  unpaid: "To'lanmagan",
  partial: "Qisman to'langan",
  paid: "To'langan",
  cancelled: "Bekor qilingan",
};

// ─────────────────────────────────────────────
// SURATLAR (snapshot)
// ─────────────────────────────────────────────

/**
 * Aybdor shaxsning surati — arxivlansa ham registr o'qilishi kerak
 * (`PayrollEntry.staffSnapshot` bilan bir xil qaror).
 *
 * @param {object} user
 * @param {string} [className]
 */
const personSnapshotOf = (user, className) => ({
  firstName: user.firstName,
  lastName: user.lastName ?? "",
  username: user.username,
  role: user.role,
  className: className ?? null,
});

const itemSnapshotOf = (item) => ({
  name: item.name,
  unit: item.unit,
  categoryName: item.category?.name ?? null,
});

const locationSnapshotOf = (location) => ({
  name: location.name,
  type: location.type,
  typeLabel: LOCATION_TYPE_LABELS[location.type] ?? location.type,
});

/** Ism — surat va joriy yozuvdan, shu tartibda. */
const displayNameOf = (person, snapshot) => {
  if (person) return `${person.firstName} ${person.lastName ?? ""}`.trim();
  const full = `${snapshot?.firstName ?? ""} ${snapshot?.lastName ?? ""}`.trim();
  return full || "Noma'lum";
};

module.exports = {
  MAX_QUANTITY,
  MOVEMENT_RULES,
  assertMovementSigns,
  assertStockConsistency,
  parseQuantity,
  parseOptionalQuantity,
  parseSignedQuantity,
  damageAmountOf,
  LOCATION_TYPE_LABELS,
  MOVEMENT_TYPE_LABELS,
  DAMAGE_KIND_LABELS,
  DAMAGE_REASON_LABELS,
  REASONS_BY_KIND,
  DEFAULT_REASON_BY_KIND,
  REASONS_REQUIRING_NOTE,
  parseDamageReason,
  DAMAGE_STATUS_LABELS,
  CHARGE_STATUS_LABELS,
  personSnapshotOf,
  itemSnapshotOf,
  locationSnapshotOf,
  displayNameOf,
};
