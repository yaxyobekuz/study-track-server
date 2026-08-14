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
  USERS: "users",
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
  FINANCE: "finance",
  HOLIDAYS: "holidays",
  MONITORS: "monitors",
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
    // Tariflardan ALOHIDA bo'lim: narxlarni ko'rish huquqi butun qarzdorlik
    // registrini ochib bermasligi, kassir esa tarif katalogini boshqarish
    // huquqini olmasligi kerak.
    key: SECTIONS.FINANCE,
    label: "Hisob-fakturalar va to'lovlar",
    group: "Moliya",
    actions: [
      A.view,
      { key: "generate", label: "Hisob-faktura shakllantirish" },
      { key: "pay", label: "To'lov qabul qilish" },
      { key: "status", label: "O'quvchi moliyaviy holati" },
      { key: "cancel", label: "Hisob-fakturani bekor qilish" },
      { key: "adjust", label: "Amaldagi yozuvni to'g'rilash" },
      A.export,
      A.settings,
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
