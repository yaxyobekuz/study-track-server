// ─────────────────────────────────────────────
// RUXSATLAR (bo'lim darajasi)
// ─────────────────────────────────────────────
// Admin paneldagi har bir bo'lim = bitta ruxsat kaliti. Owner'dan tashqari
// xodimlarga shu kalitlar beriladi/olib qo'yiladi. Owner doim hammasiga ega.
//
// DIQQAT: bu kalitlar admin frontend'dagi
// `admin/src/features/permissions/data/permissions.data.js` bilan bir xil
// bo'lishi shart (ikki alohida repo — qo'lda sinxron saqlanadi).

const PERMISSIONS = {
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
  HOLIDAYS: "holidays",
  MONITORS: "monitors",
  MESSAGES: "messages",
  SOCIAL: "social",
  LEADS: "leads",
};

// Katalog — admin UI checkbox'larini guruhlab ko'rsatish uchun (label + group).
// Faqat grant qilinadigan (owner bo'lmaganlarga beriladigan) ruxsatlar.
const PERMISSION_CATALOG = [
  { key: PERMISSIONS.USERS, label: "Foydalanuvchilar", group: "Asosiy" },
  { key: PERMISSIONS.STATISTICS, label: "Statistika", group: "Asosiy" },
  { key: PERMISSIONS.ATTENDANCE, label: "Davomat", group: "Ta'lim" },
  { key: PERMISSIONS.GRADES, label: "Baholar jurnali", group: "Ta'lim" },
  { key: PERMISSIONS.SCHEDULES, label: "Dars jadvali", group: "Ta'lim" },
  { key: PERMISSIONS.TOPICS, label: "Dars mavzulari", group: "Ta'lim" },
  { key: PERMISSIONS.CLASSES, label: "Sinflar", group: "Ta'lim" },
  { key: PERMISSIONS.SUBJECTS, label: "Fanlar", group: "Ta'lim" },
  { key: PERMISSIONS.TESTS, label: "Testlar", group: "Ta'lim" },
  { key: PERMISSIONS.MARKET, label: "Do'kon", group: "Do'kon" },
  { key: PERMISSIONS.TASKS, label: "Topshiriqlar", group: "Topshiriqlar" },
  { key: PERMISSIONS.PENALTIES, label: "Jarimalar", group: "Jarimalar" },
  { key: PERMISSIONS.PREMIUM, label: "MBSI Premium", group: "Premium" },
  { key: PERMISSIONS.COINS, label: "Tangalar", group: "Tangalar" },
  { key: PERMISSIONS.HOLIDAYS, label: "Dam olish kunlari", group: "Boshqaruv" },
  { key: PERMISSIONS.MONITORS, label: "Monitorlar", group: "Boshqaruv" },
  { key: PERMISSIONS.MESSAGES, label: "Xabarlar", group: "Ijtimoiy" },
  { key: PERMISSIONS.SOCIAL, label: "Ijtimoiy tarmoqlar", group: "Ijtimoiy" },
  { key: PERMISSIONS.LEADS, label: "Sotuvlar", group: "Sotuvlar" },
];

const PERMISSION_KEYS = PERMISSION_CATALOG.map((p) => p.key);

module.exports = { PERMISSIONS, PERMISSION_CATALOG, PERMISSION_KEYS };
