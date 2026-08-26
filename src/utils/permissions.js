// ─────────────────────────────────────────────
// RUXSATLAR (bo'lim + amal darajasi)
// ─────────────────────────────────────────────
// Har bir bo'lim amallarga bo'lingan. Ruxsat kaliti — `<bo'lim>.<amal>`
// (masalan "users.create"). Owner'dan tashqari xodimlarga shu kalitlar
// beriladi/olib qo'yiladi. Owner doim hammasiga ega.
//
// `view` amali — bo'limga kirishning asosi. Boshqa amal berilganda u avtomatik
// qo'shiladi (`normalizePermissions`).
//
// DIQQAT: bu katalog admin frontend'dagi
// `admin/src/features/permissions/data/permissions.data.js` bilan bir xil
// bo'lishi shart (ikki alohida repo — qo'lda sinxron saqlanadi).

// Bo'lim kalitlari — route fayllarida `authorizeSection` uchun.
const SECTIONS = {
  BRANCHES: "branches",
  USERS: "users",
  ENROLLMENT: "enrollment",
  STATISTICS: "statistics",
  ATTENDANCE: "attendance",
  GRADES: "grades",
  SCHEDULES: "schedules",
  TOPICS: "topics",
  CLASSES: "classes",
  SUBJECTS: "subjects",
  TESTS: "tests",
  MARKET: "market",
  TASKS: "tasks",
  PENALTIES: "penalties",
  PREMIUM: "premium",
  COINS: "coins",
  TARIFFS: "tariffs",
  DISCOUNTS: "discounts",
  FINANCE: "finance",
  DEBTORS: "debtors",
  REPORTS: "reports",
  INCOME: "income",
  PAYROLL: "payroll",
  EXPENSES: "expenses",
  HOLIDAYS: "holidays",
  MONITORS: "monitors",
  CHANGELOG: "changelog",
  MESSAGES: "messages",
  SOCIAL: "social",
  LEADS: "leads",
};

// Tez-tez takrorlanadigan amal nomlari (qisqartma uchun).
const A = {
  view: { key: "view", label: "Ko'rish" },
  create: { key: "create", label: "Qo'shish" },
  update: { key: "update", label: "Tahrirlash" },
  delete: { key: "delete", label: "O'chirish" },
  export: { key: "export", label: "Eksport qilish" },
  settings: { key: "settings", label: "Sozlamalar" },
};

// Katalog — bo'lim → amallar. Admin UI shu ro'yxatdan chiziladi.
const PERMISSION_SECTIONS = [
  {
    // Filiallar — `branches.create` PostgreSQL schema'si yaratadi va
    // migratsiya yugurtiradi, `branches.assign` esa odamni butun BOSHQA
    // bazaga kiritadi. Ikkalasi ham amalda owner darajasidagi huquq, lekin
    // katalogda turishi kerak — aks holda ularni hech kimga berib bo'lmasdi.
    //
    // ⚠️ "Filial almashtirish" ruxsat EMAS: xodim o'zi biriktirilgan
    // filiallar orasida erkin harakatlanadi. Ro'yxatning o'zi — grant
    // (`platform.user_branch_access`), shuning uchun alohida kalit ortiqcha
    // bo'lardi va ikkita haqiqat manbai paydo bo'lardi.
    key: SECTIONS.BRANCHES,
    label: "Filiallar",
    group: "Asosiy",
    actions: [
      A.view,
      A.create,
      A.update,
      { key: "archive", label: "Arxivlash" },
      { key: "assign", label: "Xodimni filialga biriktirish" },
    ],
  },
  {
    key: SECTIONS.USERS,
    label: "Foydalanuvchilar",
    group: "Asosiy",
    actions: [
      A.view,
      A.create,
      A.update,
      A.delete,
      { key: "archive", label: "Arxivlash" },
      { key: "restore", label: "Arxivdan qaytarish" },
      { key: "password", label: "Parolni ko'rish / tiklash" },
      A.export,
    ],
  },
  {
    // O'qish davri PULNI harakatlantiradi (proratsiya va hisob-fakturaning
    // bor-yo'qligi), lekin uni qabulxona kiritadi — moliyachi emas. Shuning
    // uchun tariflardan ham, hisob-fakturalardan ham ALOHIDA bo'lim.
    key: SECTIONS.ENROLLMENT,
    label: "O'qish davrlari",
    group: "Asosiy",
    actions: [A.view, A.create, A.update, A.delete],
  },
  {
    key: SECTIONS.STATISTICS,
    label: "Statistika",
    group: "Asosiy",
    actions: [A.view, A.export],
  },
  {
    key: SECTIONS.ATTENDANCE,
    label: "Davomat",
    group: "Ta'lim",
    actions: [
      A.view,
      { key: "mark", label: "Davomat belgilash" },
      A.update,
      { key: "review", label: "Sababnomalarni ko'rib chiqish" },
      { key: "reasons", label: "Sabab turlarini boshqarish" },
      { key: "reports", label: "Hisobotlar" },
      A.settings,
    ],
  },
  {
    key: SECTIONS.GRADES,
    label: "Baholar jurnali",
    group: "Ta'lim",
    actions: [A.view, A.create, A.update, A.delete, A.export],
  },
  {
    key: SECTIONS.SCHEDULES,
    label: "Dars jadvali",
    group: "Ta'lim",
    actions: [A.view, A.create, A.update, A.delete, A.export, A.settings],
  },
  {
    key: SECTIONS.TOPICS,
    label: "Dars mavzulari",
    group: "Ta'lim",
    actions: [
      A.view,
      { key: "import", label: "Fayldan yuklash" },
      A.delete,
    ],
  },
  {
    key: SECTIONS.CLASSES,
    label: "Sinflar",
    group: "Ta'lim",
    actions: [
      A.view,
      A.create,
      A.update,
      A.delete,
      { key: "students", label: "O'quvchi qo'shish / chiqarish" },
      { key: "transfer", label: "O'quvchilarni ko'chirish" },
      A.export,
    ],
  },
  {
    key: SECTIONS.SUBJECTS,
    label: "Fanlar",
    group: "Ta'lim",
    actions: [A.view, A.create, A.update, A.delete, A.export],
  },
  {
    key: SECTIONS.TESTS,
    label: "Testlar",
    group: "Ta'lim",
    actions: [
      A.view,
      A.create,
      A.update,
      A.delete,
      { key: "announce", label: "E'lon qilish" },
      { key: "distribute", label: "Tanga taqsimlash" },
      { key: "finalize", label: "Mavsumni yakunlash" },
      A.settings,
    ],
  },
  {
    key: SECTIONS.MARKET,
    label: "Do'kon",
    group: "Do'kon",
    actions: [
      A.view,
      A.create,
      A.update,
      A.delete,
      { key: "orders", label: "Buyurtmalarni ko'rish" },
      { key: "fulfill", label: "Buyurtma holatini o'zgartirish" },
    ],
  },
  {
    key: SECTIONS.TASKS,
    label: "Topshiriqlar",
    group: "Topshiriqlar",
    actions: [
      A.view,
      A.create,
      { key: "review", label: "Tasdiqlash / rad etish" },
      { key: "stop", label: "To'xtatish" },
      { key: "extend", label: "Muddatni uzaytirish" },
    ],
  },
  {
    key: SECTIONS.PENALTIES,
    label: "Jarimalar",
    group: "Jarimalar",
    actions: [
      A.view,
      A.create,
      { key: "review", label: "Ko'rib chiqish" },
      A.delete,
      { key: "reduce", label: "Jarimani kamaytirish" },
      { key: "categories", label: "Kategoriyalarni boshqarish" },
      { key: "packages", label: "Kamaytirish paketlari" },
      A.settings,
    ],
  },
  {
    key: SECTIONS.PREMIUM,
    label: "MBSI Premium",
    group: "Premium",
    actions: [
      A.view,
      { key: "grant", label: "Premium berish" },
      { key: "revoke", label: "Premiumni bekor qilish" },
      { key: "emojis", label: "Emojilarni boshqarish" },
      A.export,
      A.settings,
    ],
  },
  {
    key: SECTIONS.COINS,
    label: "Tangalar",
    group: "Tangalar",
    actions: [
      A.view,
      { key: "distribute", label: "Tanga taqsimlash" },
      A.settings,
    ],
  },
  {
    key: SECTIONS.TARIFFS,
    label: "Tariflar va narxlar",
    group: "Moliya",
    actions: [
      A.view,
      A.create,
      A.update,
      A.delete,
      { key: "versions", label: "Narx versiyalari" },
      { key: "assign", label: "O'quvchiga biriktirish" },
      { key: "adjust", label: "Amaldagi yozuvni to'g'rilash" },
      A.export,
    ],
  },
  {
    // Chegirmalar tariflardan alohida: narx katalogini boshqaradigan xodim
    // "kimga qancha chegirma" degan qarorni ham qabul qila olmasligi kerak.
    key: SECTIONS.DISCOUNTS,
    label: "Chegirmalar",
    group: "Moliya",
    actions: [
      A.view,
      A.create,
      A.update,
      A.delete,
      { key: "assign", label: "O'quvchiga biriktirish" },
    ],
  },
  {
    // Tariflardan ALOHIDA bo'lim: narxlarni ko'rish huquqi butun qarzdorlik
    // registrini ochib bermasligi, kassir esa tarif katalogini boshqarish
    // huquqini olmasligi kerak.
    //
    // Amallar ATAYLAB mayda: kassir `pay` oladi, lekin `void`/`refund`/
    // `transfer`/`accounts` OLMAYDI — bularning har biri pulni ota-onasiz
    // harakatlantiradi.
    key: SECTIONS.FINANCE,
    label: "Hisob-fakturalar va to'lovlar",
    group: "Moliya",
    actions: [
      A.view,
      { key: "generate", label: "Hisob-faktura shakllantirish" },
      { key: "pay", label: "To'lov qabul qilish" },
      { key: "void", label: "To'lovni bekor qilish" },
      { key: "refund", label: "Depozitni qaytarish" },
      { key: "status", label: "O'quvchi moliyaviy holati" },
      { key: "cancel", label: "Hisob-fakturani bekor qilish" },
      { key: "adjust", label: "Amaldagi yozuvni to'g'rilash" },
      { key: "accounts", label: "To'lov turlarini boshqarish" },
      { key: "transfer", label: "To'lov turlari orasida o'tkazma" },
      A.export,
      A.settings,
    ],
  },
  {
    // Qarzdorlar registri — moliyaning eng nozik KESIMI: bitta ekranda butun
    // maktabning qarzi va har bir o'quvchining necha oydan beri to'lamagani
    // ko'rinadi. Shuning uchun u `finance.view` dan ALOHIDA: undiruv bilan
    // shug'ullanadigan odamga ro'yxatni ochish uchun hisob-faktura registrini
    // va to'lov cheklarini ham berish shart emas.
    //
    // Bitta amal — bu ATAYLAB. To'lov qabul qilish `finance.pay` da qoladi:
    // ro'yxatni ko'rish va pulni harakatlantirish boshqa-boshqa mas'uliyat.
    key: SECTIONS.DEBTORS,
    label: "Qarzdorlar",
    group: "Moliya",
    actions: [
      A.view,
      // Eslatma maktabdan TASHQARIGA chiqadi — ota-onaning telefoniga.
      // Ro'yxatni ko'rish ichki ish, xabar yuborish esa maktab nomidan
      // gapirish: shuning uchun alohida amal.
      { key: "remind", label: "Eslatma yuborish" },
    ],
  },
  {
    // Hisobotlar — moliyaning eng KENG kesimi: bitta ekranda butun maktabning
    // tushumi, qarzi, sinf va tarif bo'yicha taqsimoti ko'rinadi. Registrni
    // ko'rish huquqi (`finance.view`) bilan birga berilmaydi: kassirga kunlik
    // ish uchun registr kerak, butun maktabning moliyaviy manzarasi emas.
    key: SECTIONS.REPORTS,
    label: "Moliya hisobotlari",
    group: "Moliya",
    actions: [A.view],
  },
  {
    // Tashqi kirim — o'quvchi to'lovi BO'LMAGAN pul (ijara, sotuv, homiylik).
    // Amallar ATAYLAB mayda: kirim qo'sha oladigan xodim uni BEKOR QILA
    // olmasligi kerak — bekor qilish kassa qoldig'ini kamaytiradi va
    // to'lovni bekor qilish bilan bir xil og'irlikdagi amal.
    key: SECTIONS.INCOME,
    label: "Tashqi kirimlar",
    group: "Moliya",
    actions: [
      A.view,
      A.create,
      { key: "void", label: "Bekor qilish" },
      { key: "categories", label: "Kategoriyalarni boshqarish" },
    ],
  },
  {
    // XODIMLAR OYLIGI — chiqim tomonining o'quvchi registriga o'xshashi.
    // Amallar ATAYLAB mayda: qoida biriktirish (kimga qancha oylik) va
    // to'lash (pulni kassadan chiqarish) — ikki xil mas'uliyat. Buxgalter
    // to'laydi, lekin oylik miqdorini o'zi belgilay olmasligi kerak.
    key: SECTIONS.PAYROLL,
    label: "Xodimlar oyligi",
    group: "Moliya",
    actions: [
      A.view,
      { key: "assign", label: "Oylik belgilash" },
      { key: "generate", label: "Oylik shakllantirish" },
      { key: "pay", label: "To'lash" },
      { key: "void", label: "To'lovni bekor qilish" },
      { key: "cancel", label: "Majburiyatni bekor qilish" },
    ],
  },
  {
    // XARAJATLAR — kommunal, ta'mirlash, jihoz. Oylik BU YERDA EMAS.
    key: SECTIONS.EXPENSES,
    label: "Xarajatlar",
    group: "Moliya",
    actions: [
      A.view,
      A.create,
      { key: "void", label: "Bekor qilish" },
      { key: "categories", label: "Kategoriyalarni boshqarish" },
    ],
  },
  {
    key: SECTIONS.HOLIDAYS,
    label: "Dam olish kunlari",
    group: "Boshqaruv",
    actions: [A.view, A.create, A.update, A.delete],
  },
  {
    key: SECTIONS.MONITORS,
    label: "Monitorlar",
    group: "Boshqaruv",
    actions: [A.view, A.update],
  },
  {
    key: SECTIONS.CHANGELOG,
    label: "O'zgarishlar tarixi",
    group: "Boshqaruv",
    actions: [
      A.view,
      A.create,
      A.update,
      A.delete,
      { key: "send", label: "Qo'lda yuborish" },
      A.settings,
    ],
  },
  {
    key: SECTIONS.MESSAGES,
    label: "Xabarlar",
    group: "Ijtimoiy",
    actions: [
      A.view,
      { key: "create", label: "Xabar yuborish" },
      { key: "cancel", label: "Yuborishni bekor qilish" },
    ],
  },
  {
    key: SECTIONS.SOCIAL,
    label: "Ijtimoiy tarmoqlar",
    group: "Ijtimoiy",
    actions: [A.view, A.create, A.update, A.delete],
  },
  {
    key: SECTIONS.LEADS,
    label: "Sotuvlar",
    group: "Sotuvlar",
    actions: [
      A.view,
      A.create,
      A.update,
      A.delete,
      { key: "status", label: "Holatni o'zgartirish" },
      { key: "activities", label: "Faoliyatlar" },
      { key: "analytics", label: "Analitika" },
      { key: "taxonomy", label: "Manba / yo'nalish / kategoriya" },
    ],
  },
];

const SECTION_KEYS = PERMISSION_SECTIONS.map((s) => s.key);

// Barcha ruxsat kalitlari: ["users.view", "users.create", ...]
const PERMISSION_KEYS = PERMISSION_SECTIONS.flatMap((s) =>
  s.actions.map((a) => `${s.key}.${a.key}`),
);

// Bo'lim kaliti → o'sha bo'limning barcha kalitlari (tez qidiruv uchun).
const KEYS_BY_SECTION = PERMISSION_SECTIONS.reduce((acc, s) => {
  acc[s.key] = s.actions.map((a) => `${s.key}.${a.key}`);
  return acc;
}, {});

// Katalogdan avtomatik generatsiya: PERMISSIONS.USERS_ARCHIVE === "users.archive".
// Qo'lda yozilmaydi — katalog bilan hech qachon farq qilmaydi.
const PERMISSIONS = PERMISSION_SECTIONS.reduce((acc, s) => {
  for (const a of s.actions) {
    acc[`${s.key}_${a.key}`.toUpperCase()] = `${s.key}.${a.key}`;
  }
  return acc;
}, {});

/**
 * Foydalanuvchida berilgan ruxsat bormi?
 * Yagona manba — middleware ham, service ham shu funksiyani ishlatadi.
 *
 * Eski (amal darajasiga migratsiya qilinmagan) yozuvlar uchun bare bo'lim
 * kaliti ham qabul qilinadi: `["users"]` → `users.*` ning hammasi.
 *
 * @param {string[]} userPermissions - foydalanuvchining ruxsat kalitlari
 * @param {string} key - talab qilinadigan kalit ("users.create")
 * @returns {boolean}
 */
function hasPermission(userPermissions = [], key) {
  if (!key) return true;
  if (userPermissions.includes(key)) return true;
  return userPermissions.includes(key.split(".")[0]);
}

/**
 * Bo'limda hech bo'lmasa bitta amali bormi?
 * @param {string[]} userPermissions
 * @param {string} section - bo'lim kaliti ("users")
 * @returns {boolean}
 */
function hasSection(userPermissions = [], section) {
  if (!section) return true;
  if (userPermissions.includes(section)) return true;
  const prefix = `${section}.`;
  return userPermissions.some((p) => p.startsWith(prefix));
}

/**
 * Eski bare bo'lim kalitlarini o'sha bo'limning barcha amallariga yoyadi.
 * Nuqtali kalitlar o'zgarishsiz qoladi, noma'lumlari ham saqlanadi
 * (validatsiya alohida bosqichda).
 *
 * @param {string[]} keys
 * @returns {string[]}
 */
function expandLegacyKeys(keys = []) {
  const out = [];
  for (const key of keys) {
    if (KEYS_BY_SECTION[key]) out.push(...KEYS_BY_SECTION[key]);
    else out.push(key);
  }
  return [...new Set(out)];
}

/**
 * Dedupe + har bir bo'lim uchun `.view` ni avtomatik qo'shadi (bo'limda biror
 * amal bo'lsa, uni ko'ra olishi ham kerak). Natija katalog tartibida qaytadi.
 *
 * @param {string[]} keys
 * @returns {string[]}
 */
function normalizePermissions(keys = []) {
  const set = new Set(keys);

  for (const section of SECTION_KEYS) {
    const prefix = `${section}.`;
    const hasAny = [...set].some((k) => k.startsWith(prefix));
    if (hasAny) set.add(`${section}.view`);
  }

  // Katalog tartibi — javob va DB yozuvi barqaror bo'lishi uchun
  return PERMISSION_KEYS.filter((k) => set.has(k));
}

module.exports = {
  SECTIONS,
  SECTION_KEYS,
  PERMISSIONS,
  PERMISSION_SECTIONS,
  PERMISSION_KEYS,
  KEYS_BY_SECTION,
  hasPermission,
  hasSection,
  expandLegacyKeys,
  normalizePermissions,
};
