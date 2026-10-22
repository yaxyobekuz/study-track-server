/**
 * UMUMIY KO'RINISH — YO'LLAR REGISTRI ("bu so'rov qanday birlashtiriladi").
 *
 * Umumiy rejimda so'rov har filialda alohida bajariladi va javoblar
 * birlashtiriladi. Lekin HAR QANDAY javobni birlashtirib bo'lmaydi, shuning
 * uchun har yo'l to'rt holatdan birida bo'ladi:
 *
 *  | Rejim         | Ma'nosi                                                |
 *  |---------------|--------------------------------------------------------|
 *  | `auto`        | sukut: ro'yxat ulanadi, obyekt (sanoqchi) qo'shiladi,  |
 *  |               | bir xil javob o'zi qoladi, bitta filialdan topilgani   |
 *  |               | o'zi qaytadi                                           |
 *  | `anchor`      | AYNAN BITTA filialda bajariladi (uy filiali)           |
 *  | `list`/`object` | sukut bilan AYNI, faqat tartib (`sort`) yoki          |
 *  |               | "tegilmasin" (`keep`) e'lon qilingan                   |
 *  | `unsupported` | birlashtirilmaydi, toza 409 qaytadi                    |
 *
 * ⚠️ 2026-10-17: obyekt javoblar SUKUT BO'YICHA birlashtiriladi. Ilgari ular
 * e'lon qilinmaguncha 409 berardi va paneldagi sanoq kartalari "—" bo'lib
 * turardi — holbuki odam umumiy ko'rinishni aynan o'sha raqamlar uchun
 * ochadi. Xavfsizlik qoidalarda: sozlama va davr qiymatlari qo'shilmaydi,
 * foiz o'rtachalanadi, bir xil kalitli qatorlar guruhlanadi
 * (`helpers/aggregateMerge.helpers.js`).
 *
 * ⚠️ NIMA UCHUN `anchor` KERAK: platforma ma'lumoti (rol, tarif, chegirma,
 * o'zgarishlar tarixi) BARCHA filiallarda AYNI — fan-out qilinsa ro'yxat
 * filial soniga ko'payib ko'rinardi. Shaxsiy ekranlar (`/my`, `/me`) va
 * sozlamalar ham bitta filialga tegishli.
 *
 * ⚠️ NIMA UCHUN `unsupported` BOR VA U XATO EMAS: Excel eksporti ikkilik
 * fayl qaytaradi — ikkita faylni "birlashtirish" degan narsa yo'q. Jim
 * ravishda faqat bitta filialning faylini berish esa eng yomon variant:
 * odam uni "butun tarmoq" deb o'qib, qaroriga asos qilardi.
 *
 * ⚠️ YOZUV (`locate`): umumiy rejimda yozuv AYNAN BITTA filialda bajariladi.
 * Panel qatorning filialini `X-Branch-Id` bilan yuboradi; yubormasa server
 * yo'ldagi id ni filiallar bo'ylab qidirib topadi (`locate`). Model nomi
 * FAQAT shu registrdan keladi — so'rovdan hech qachon.
 */

/* ──────────────────────────── YO'L SHABLONI ──────────────────────────── */

/**
 * `"GET /users/:id/*"` → regex + parametr nomlari.
 *
 * `:param` bitta bo'lakni oladi, `*` esa qolgan yo'lni. Shablon TO'LIQ mos
 * kelishi kerak: `/users` shabloni `/users/stats` ga mos kelmaydi (aks holda
 * prefiks tasodifan butun bo'limni egallab olardi).
 *
 * ⚠️ `id` BILAN TUGAYDIGAN PARAMETR FAQAT 24-HEX ni oladi. Loyihada hamma
 * id `String @id @db.Char(24)`, shuning uchun bu aniqlik tekin keladi va
 * bitta jiddiy tuzoqni yopadi: `([^/]+)` bo'lsa `/users/export` ham
 * `"/users/:id"` ga mos kelib, "export" so'zi id deb filiallar bo'ylab
 * qidirilardi — eksport esa butunlay boshqa qoidaga (`unsupported`) tegishli.
 */
const ID_SEGMENT = "([0-9a-fA-F]{24})";

const compile = (pattern) => {
  const [rawMethod, rawPath] = pattern.split(" ");
  const names = [];

  const source = rawPath
    .split("/")
    .filter((part, index) => !(index === 0 && part === ""))
    .map((part) => {
      if (part === "*") return "(?:.*)";
      if (part.startsWith(":")) {
        const name = part.slice(1);
        names.push(name);
        return /id$/i.test(name) ? ID_SEGMENT : "([^/]+)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");

  return {
    method: rawMethod === "*" ? null : rawMethod.toUpperCase(),
    regex: new RegExp(`^/${source}/?$`),
    names,
  };
};

/* ─────────────────────────────── QOIDALAR ─────────────────────────────── */

/**
 * Tartib MUHIM — birinchi mos kelgani ishlaydi, shuning uchun aniq yo'llar
 * yuqorida, bo'lim shablonlari pastda turadi.
 */
const RULES = [
  /* ── Autentifikatsiya va infratuzilma: faqat uy filialida ───────────── */
  // `/auth/me` umumiy rejimni O'ZI xabar qiladi (`auth.service.getMe`),
  // shuning uchun u filiallar bo'ylab yugurmaydi.
  { pattern: "* /auth/*", mode: "anchor" },
  { pattern: "* /auth", mode: "anchor" },
  // FCM qurilma tokenlari platformada (`PushDevice`) — filialga bog'liq emas.
  { pattern: "* /push/*", mode: "anchor" },
  // Ota-ona nazorati: bola AYNAN BITTA filialda, umumiy ko'rinishning ma'nosi yo'q.
  { pattern: "* /parental/*", mode: "anchor" },
  // AI yordamchi: SSE oqimi (ikkilik emas, lekin oqim) va yozadigan amallar.
  { pattern: "* /ai-assistant/*", mode: "anchor" },

  /* ── Platforma kataloglari: barcha filiallarda AYNI ─────────────────── */
  // ⚠️ Ularni fan-out qilish ro'yxatni filial soniga ko'paytirardi, yozuvni
  // esa baribir platformaga yozardi — ya'ni fan-out bu yerda faqat zarar.
  { pattern: "* /branches", mode: "anchor" },
  { pattern: "* /branches/*", mode: "anchor" },
  { pattern: "* /roles", mode: "anchor" },
  { pattern: "* /roles/*", mode: "anchor" },
  { pattern: "* /permissions", mode: "anchor" },
  { pattern: "* /permissions/*", mode: "anchor" },
  { pattern: "* /tariffs", mode: "anchor" },
  { pattern: "* /tariffs/*", mode: "anchor" },
  { pattern: "* /discounts", mode: "anchor" },
  { pattern: "* /discounts/*", mode: "anchor" },
  { pattern: "* /changelogs", mode: "anchor" },
  { pattern: "* /changelogs/*", mode: "anchor" },

  /* ── Filiallararo ko'chirish: o'zi ikki filial bilan ishlaydi ───────── */
  // ⚠️ Fan-out qilinsa, ko'chirish rejasi har filialda qayta qurilib,
  // tasdiq xeshlari bir-biriga mos kelmasdi.
  { pattern: "* /branch-transfers/*", mode: "anchor" },
  { pattern: "* /branch-transfers", mode: "anchor" },

  /* ── Sanoqchilar: qo'shish TO'G'RI (tekshirilgan shakl) ─────────────── */
  // `{telegramUsers, workers, students, premiumUsers}` — sof sanoqchilar.
  { pattern: "GET /users/stats", mode: "object" },

  // ASL SINFLAR KESIMI — `{grades: [{grade, label, studentCount}], unset, total}`.
  // Qatorlar `grade` bo'yicha GURUHLANADI (filiallarning 5-sinflari bitta
  // qatorga qo'shiladi), sanoqchilar esa qo'shiladi.
  { pattern: "GET /users/actual-grades", mode: "object" },

  // ⚠️ Topshiriq sanoqchilari ichida "muddati yaqin" CHEGARASI (soatda)
  // ham keladi — u sozlama, sanoq emas. `SETTING_KEYS` da ham bor, bu
  // yerda esa yo'l darajasida QAYD etilgan: shakl o'zgarsa ko'rinib tursin.
  { pattern: "GET /tasks/stats", mode: "object", keep: ["dueSoonHours"] },
  { pattern: "GET /tasks/reports", mode: "object", keep: ["dueSoonHours"] },
  { pattern: "GET /tasks/dashboard", mode: "object", keep: ["dueSoonHours"] },

  /* ── Yirik ro'yxatlar: tartib ATAYLAB e'lon qilinadi ───────────────── */
  // Sahifalashning to'g'riligi shunga bog'liq: bu yerdagi tartib filialning
  // O'Z tartibi bilan mos bo'lishi kerak (`aggregateMerge.helpers.js`).
  {
    pattern: "GET /users",
    mode: "list",
    sort: [{ field: "createdAt", dir: "desc" }],
  },
  {
    pattern: "GET /invoices",
    mode: "list",
    sort: [
      { field: "month", dir: "desc" },
      { field: "createdAt", dir: "desc" },
    ],
  },
  {
    pattern: "GET /payments",
    mode: "list",
    sort: [
      { field: "paidAt", dir: "desc" },
      { field: "receiptNo", dir: "desc" },
    ],
  },
  {
    pattern: "GET /payroll/entries",
    mode: "list",
    sort: [
      { field: "month", dir: "desc" },
      { field: "createdAt", dir: "desc" },
    ],
  },

  /* ── Yozuv: qator qaysi filialda bo'lsa, o'sha filialda bajariladi ─── */
  // ⚠️ Faqat YO'LDAGI id bo'yicha. Ro'yxatga yangi model qo'shganda
  // model nomi `prisma/schema.prisma` dagi bilan mos bo'lishi SHART —
  // `test/aggregateRoute.registry.test.js` buni tekshiradi.
  { pattern: "* /users/:id", locate: { model: "user", param: "id" } },
  { pattern: "* /users/:id/*", locate: { model: "user", param: "id" } },
  { pattern: "* /classes/:id", locate: { model: "class", param: "id" } },
  { pattern: "* /classes/:id/*", locate: { model: "class", param: "id" } },
  { pattern: "* /subjects/:id", locate: { model: "subject", param: "id" } },
  { pattern: "* /subjects/:id/*", locate: { model: "subject", param: "id" } },
  { pattern: "* /topics/:id", locate: { model: "topic", param: "id" } },
  { pattern: "* /invoices/:id", locate: { model: "monthlyInvoice", param: "id" } },
  { pattern: "* /invoices/:id/*", locate: { model: "monthlyInvoice", param: "id" } },
  { pattern: "* /payments/:id", locate: { model: "payment", param: "id" } },
  { pattern: "* /payments/:id/*", locate: { model: "payment", param: "id" } },
  { pattern: "* /payment-accounts/:id", locate: { model: "paymentAccount", param: "id" } },
  { pattern: "* /payment-accounts/:id/*", locate: { model: "paymentAccount", param: "id" } },
  { pattern: "* /expenses/:id", locate: { model: "expense", param: "id" } },
  { pattern: "* /expenses/:id/*", locate: { model: "expense", param: "id" } },
  { pattern: "* /expense-categories/:id", locate: { model: "expenseCategory", param: "id" } },
  { pattern: "* /external-incomes/:id", locate: { model: "externalIncome", param: "id" } },
  { pattern: "* /income-categories/:id", locate: { model: "incomeCategory", param: "id" } },
  { pattern: "* /student-enrollments/:id", locate: { model: "studentEnrollment", param: "id" } },
  { pattern: "* /student-enrollments/:id/*", locate: { model: "studentEnrollment", param: "id" } },
  { pattern: "* /student-tariffs/:id", locate: { model: "studentTariff", param: "id" } },
  { pattern: "* /student-month-overrides/:id", locate: { model: "studentMonthOverride", param: "id" } },
  { pattern: "* /student-accounts/:studentId", locate: { model: "user", param: "studentId" } },
  { pattern: "* /student-accounts/:studentId/*", locate: { model: "user", param: "studentId" } },
  { pattern: "* /student-finance-statuses/:studentId", locate: { model: "user", param: "studentId" } },
  { pattern: "* /tasks/:id", locate: { model: "task", param: "id" } },
  { pattern: "* /tasks/:id/*", locate: { model: "task", param: "id" } },
  // ⚠️ "O'ziga o'zi belgilagan topshiriq" ALOHIDA jadval EMAS — u `Task`
  // ichida `self_assigned` ustuni bilan yashaydi (`selfTask.service.js`),
  // qoidalari esa `TaskSchedule` da.
  { pattern: "* /self-tasks/rules/:id", locate: { model: "taskSchedule", param: "id" } },
  { pattern: "* /self-tasks/rules/:id/*", locate: { model: "taskSchedule", param: "id" } },
  { pattern: "* /self-tasks/:id", locate: { model: "task", param: "id" } },
  { pattern: "* /self-tasks/:id/*", locate: { model: "task", param: "id" } },
  { pattern: "* /task-schedules/:id", locate: { model: "taskSchedule", param: "id" } },
  { pattern: "* /task-schedules/:id/*", locate: { model: "taskSchedule", param: "id" } },
  { pattern: "* /penalties/:id", locate: { model: "penalty", param: "id" } },
  { pattern: "* /penalties/:id/*", locate: { model: "penalty", param: "id" } },
  { pattern: "* /issues/:id", locate: { model: "issue", param: "id" } },
  { pattern: "* /issues/:id/*", locate: { model: "issue", param: "id" } },
  { pattern: "* /leads/:id", locate: { model: "lead", param: "id" } },
  { pattern: "* /leads/:id/*", locate: { model: "lead", param: "id" } },
  { pattern: "* /holidays/:id", locate: { model: "holiday", param: "id" } },
  { pattern: "* /vacation-months/:id", locate: { model: "vacationMonth", param: "id" } },
  { pattern: "* /tutor-groups/:id", locate: { model: "tutorGroup", param: "id" } },
  { pattern: "* /grades/:id", locate: { model: "grade", param: "id" } },
  { pattern: "* /messages/:id", locate: { model: "message", param: "id" } },
  { pattern: "* /messages/:id/*", locate: { model: "message", param: "id" } },
  { pattern: "* /monitor/:id", locate: { model: "monitor", param: "id" } },
  { pattern: "* /premium/:id", locate: { model: "premium", param: "id" } },
  { pattern: "* /test-seasons/:id", locate: { model: "testSeason", param: "id" } },
  { pattern: "* /questions/:id", locate: { model: "question", param: "id" } },
  { pattern: "* /tests/:id", locate: { model: "test", param: "id" } },
  { pattern: "* /devices/:id", locate: { model: "studentDevice", param: "id" } },
].map((rule) => ({ ...rule, compiled: compile(rule.pattern) }));

/* ─────────────────────── BO'LAK BO'YICHA QOIDALAR ─────────────────────── */

/** Yo'l bo'laklari. */
const segments = (path) => path.split("/").filter(Boolean);

/**
 * SHAXSIY EKRAN (`/payroll/my`, `/devices/me/status`, `/attendance/my-stats`).
 *
 * Shaxsiy ma'lumot bitta odamga va uning filialiga tegishli — birlashtirishga
 * narsa yo'q. Bo'lak bo'yicha tekshiriladi, aks holda "my" harflari boshqa
 * so'z ichida ham uchrab ketardi.
 */
const isPersonalPath = (path) =>
  segments(path).some(
    (part) => part === "my" || part === "me" || part.startsWith("my-"),
  );

/** Sozlamalar — filialga xos konfiguratsiya, yig'indisi yo'q. */
const isSettingsPath = (path) =>
  segments(path).some(
    (part) => part === "settings" || part.endsWith("-settings"),
  );

/**
 * Ikkilik javob (Excel / fayl) — birlashtirilmaydi.
 *
 * ⚠️ Jim ravishda bitta filialning faylini berish TAQIQLANADI: odam uni
 * "butun tarmoq" deb o'qiydi.
 */
const isDownloadPath = (path) =>
  segments(path).some(
    (part) => part === "export" || part === "excel" || part === "download",
  );

/* ───────────────────────────── HAL QILUVCHI ───────────────────────────── */

/**
 * So'rov uchun qoida.
 *
 * @param {string} method - "GET", "POST", ...
 * @param {string} path - `/api` prefiksisiz yo'l ("/users/abc")
 * @returns {{mode: string, sort?: Array, locate?: {model: string, id: string}, reason?: string}}
 */
const matchTable = (upper, path) => {
  for (const rule of RULES) {
    const { compiled } = rule;
    if (compiled.method && compiled.method !== upper) continue;

    const match = compiled.regex.exec(path);
    if (!match) continue;

    const resolved = { mode: rule.mode ?? "auto" };
    if (rule.sort) resolved.sort = rule.sort;
    if (rule.keep) resolved.keep = rule.keep;

    if (rule.locate) {
      const index = compiled.names.indexOf(rule.locate.param);
      const id = index >= 0 ? decodeURIComponent(match[index + 1]) : null;
      if (id) resolved.locate = { model: rule.locate.model, id };
    }

    return resolved;
  }
  return null;
};

const resolveRule = (method, path) => {
  const upper = String(method || "GET").toUpperCase();
  const table = matchTable(upper, path);

  // ⚠️ TARTIB: `anchor` eng ustun. Platforma katalogi va shaxsiy ekranlar
  // bitta filialda bajarilgani uchun ularning Excel eksporti ham bemalol
  // ishlaydi — "yuklab olish mumkin emas" qoidasi faqat BIRLASHTIRISH
  // kerak bo'lgan hollar uchun.
  if (table?.mode === "anchor") return table;

  if (isDownloadPath(path)) {
    return {
      mode: "unsupported",
      reason:
        "Fayl yuklab olish umumiy ko'rinishda mavjud emas — filialni tanlang",
    };
  }

  if (table) return table;

  if (isPersonalPath(path) || isSettingsPath(path)) return { mode: "anchor" };

  return { mode: "auto" };
};

module.exports = {
  resolveRule,
  isPersonalPath,
  isSettingsPath,
  isDownloadPath,
  // test uchun
  RULES,
  compile,
};
