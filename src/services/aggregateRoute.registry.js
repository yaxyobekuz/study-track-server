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
  // O'qituvchining O'Z darsiga davomati: shaxsiy ekran, huquq shu filialning
  // dars jadvalidan keladi. Yo'lda "my" bo'lagi yo'q, shuning uchun
  // `isPersonalPath` uni ushlamaydi va qoida ATAYLAB yozilgan.
  { pattern: "* /student-attendance/teacher/*", mode: "anchor" },

  /* ── FACE ID: kiosk yo'llari umumiy rejimga TUSHMAYDI ──────────────── */
  //
  // `/kiosk/*` qurilma tokeni bilan ishlaydi (`X-Kiosk-Token`), ya'ni
  // dispatcher ularni ko'rmaydi (u faqat `Bearer` ni tekshiradi). Qoida
  // shunga qaramay yozilgan: kelgusida kimdir kiosk yo'liga odam tokeni
  // bilan murojaat qilsa, so'rov FILIALLAR BO'YLAB TARQALMASLIGI kerak —
  // bitta skaner N ta filialda N ta davomat yozib yuborardi.
  { pattern: "* /kiosk/*", mode: "anchor" },
  { pattern: "* /kiosk", mode: "anchor" },

  // KADR RASMI — IKKILIK javob (`image/jpeg`). Ikki rasmni
  // "birlashtirish" degan narsa yo'q, jim ravishda bittasini berish esa
  // noto'g'ri odamning yuzini ko'rsatardi: toza 409 va "filialni
  // tanlang" (Excel eksporti bilan AYNI mulohaza).
  {
    pattern: "GET /face-id/events/:id/snapshot",
    mode: "unsupported",
    reason: "Kadr rasmini umumiy ko'rinishda ochib bo'lmaydi — filialni tanlang",
  },
  {
    pattern: "GET /face-id/samples/:id/snapshot",
    mode: "unsupported",
    reason: "Kadr rasmini umumiy ko'rinishda ochib bo'lmaydi — filialni tanlang",
  },

  // Chegaralar va maxfiylik sozlamasi — FILIALGA XOS (`isSettingsPath`
  // o'zi ham ushlaydi, lekin model almashtirish yo'li `/settings/model`
  // bo'lgani uchun aniq yozilgan: u MIGRATSIYA va uni fan-out qilish
  // barcha filiallarning galereyasini birdan yaroqsiz qilardi).
  { pattern: "* /face-id/settings", mode: "anchor" },
  { pattern: "* /face-id/settings/*", mode: "anchor" },

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

  /* ── Sanoqchilar ──────────────────────────────────────────────────── */
  // ⚠️ `GET /users/stats` QO'SHILMAYDI — u o'zi filiallar bo'ylab yig'adi.
  // Xodim bir nechta filialda ishlashi mumkin va har filialda AYNI `id`
  // bilan turadi: sanoqlar qo'shilsa, o'sha odam "ikki xodim" bo'lib
  // ko'rinardi. Shuning uchun yo'l langar filialda bajariladi, controller
  // esa kimliklarni birlashtiradi va javobni AYNI `meta.aggregate` shakli
  // bilan qaytaradi (`user.controller.js` → `getStats`).
  { pattern: "GET /users/stats", mode: "anchor" },

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

  // XODIMLAR TOPSHIRIQLARI — TARMOQ HISOBOTI (`taskNetwork.service.js`).
  //
  // ⚠️ `anchor`: yo'l filiallar bo'ylab O'ZI aylanadi. Umumiy
  // birlashtiruvchi yaramaydi — u foizni og'irliksiz o'rtachalaydi
  // (400 topshiriqli filial 3 topshiriqli filial bilan teng vazn
  // olardi), reytinglarni esa qayta saralamaydi: har filialning
  // birinchi beshtasini ulab qo'yish tarmoq beshtaligini bermaydi.
  // Word fayli ham birlashtirilmaydi (`unsupported` bo'lsa tugma
  // o'chiq qolardi) — `studentMovementNetwork.service.js` bilan AYNI
  // uch sabab.
  { pattern: "GET /tasks/network/report/export", mode: "anchor" },
  { pattern: "GET /tasks/network/report", mode: "anchor" },
  { pattern: "GET /tasks/network/pulse", mode: "anchor" },

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
  /* ── Chiqib ketganlar registri ────────────────────────────────────── */
  // ⚠️ `windowDays` — OYNA UZUNLIGI (30 kun), sanoq EMAS: qo'shilsa ikki
  // filialda 60 kun bo'lib, kartaning sarlavhasi butunlay boshqa davrni
  // ko'rsatardi (`dueSoonHours` bilan AYNI sabab).
  { pattern: "GET /student-enrollments/departures/summary", mode: "object", keep: ["windowDays"] },
  {
    pattern: "GET /student-enrollments/departures",
    mode: "list",
    sort: [
      { field: "endDate", dir: "desc" },
      { field: "createdAt", dir: "desc" },
    ],
  },

  /* ── ERP va Kundalik.com hisoboti ────────────────────────────────── */
  // ⚠️ HISOBOT — `anchor`, ya'ni BIRLASHTIRUVCHI TEGMAYDI: filiallar
  // bo'ylab aylanishni servisning O'ZI bajaradi
  // (`studentSystemNetwork.service.js`). Sabab o'quvchilar harakati bilan
  // AYNI — foiz og'irliksiz o'rtachalanardi va Word fayli
  // birlashtirilmas edi.
  //
  // ⚠️ `summary` esa ATAYLAB `object`: u faqat SANOQCHI (foizsiz), ya'ni
  // qo'shilishi to'g'ri natija beradi va bosh sahifadagi karta ostidagi
  // filiallar kesimi (`BranchSplit`) o'z-o'zidan ishlaydi.
  { pattern: "GET /student-systems/report/export", mode: "anchor" },
  { pattern: "GET /student-systems/report", mode: "anchor" },
  { pattern: "GET /student-systems/summary", mode: "object" },

  /* ── Bot foydalanuvchilari hisoboti ──────────────────────────────── */
  // ⚠️ `anchor`: filiallar bo'ylab aylanishni servisning O'ZI bajaradi
  // (`botReportNetwork.service.js`). Sabab davomat hisoboti bilan AYNI —
  // qamrov foizi og'irliksiz o'rtachalanardi, sinflar reytingi esa
  // ulanib qolardi; Word fayli ham birlashtirilmaydi.
  //
  // ⚠️ `GET /activity/overview` esa AVVALGICHA umumiy birlashtiruvchidan
  // o'tadi: u karta uchun sanoqchi beradi va `BranchSplit` o'sha yerdan
  // oziqlanadi.
  { pattern: "GET /activity/bot-report/export", mode: "anchor" },
  { pattern: "GET /activity/bot-report", mode: "anchor" },

  /* ── Baho reytingi (Statistika) ───────────────────────────────────── */
  // ⚠️ REYTING `anchor`, ya'ni BIRLASHTIRUVCHI TEGMAYDI: o'rinlar butun
  // tarmoq bo'yicha QAYTA hisoblanadi (`statisticsNetwork.service.js`).
  //
  // Sabab: har filial O'Z ro'yxatini o'z 1-o'rni bilan qaytaradi.
  // Qatorlar shunchaki ulanganda ekranda "...49, 49, 1, 1, 3..." degan
  // ketma-ketlik chiqardi — o'rin qatorning KIMLIGI emas, ro'yxatdagi
  // O'RNI, ya'ni u faqat yakuniy ro'yxat yig'ilgandan keyin beriladi.
  // Sahifalash ham shu sababdan: filiallar o'z ellik qatorini alohida
  // kessa, 2-sahifada boshqa filialning eng yaxshilari turardi.
  //
  // ⚠️ Eksport ham shu yerda — ikkilik fayl birlashtirilmaydi; umumiy
  // ko'rinishda u "Filial" ustuni bilan BITTA tarmoq faylini beradi.
  //
  // ⚠️ SINF reytingi (`/class/:id/rankings`) BU YERDA EMAS: sinf bitta
  // filialniki, ya'ni javob ham o'sha filialdan keladi (yo'ldagi id
  // bo'yicha topiladi) va qayta saralash kerak emas.
  { pattern: "GET /statistics/weekly/school/rankings", mode: "anchor" },
  { pattern: "GET /statistics/weekly/export", mode: "anchor" },
  // Bosh sahifadagi karta — AYNI sabab: beshtalik butun tarmoq ro'yxati
  // yig'ilgandan KEYIN kesiladi, aks holda u langar filialning beshtaligi
  // bo'lib qolardi.
  { pattern: "GET /statistics/weekly/school/top", mode: "anchor" },

  /* ── Davomat statistikasi (bosh sahifa kartalari + hujjat) ───────── */
  // ⚠️ `anchor`, ya'ni BIRLASHTIRUVCHI TEGMAYDI: filiallar bo'ylab
  // aylanishni servisning O'ZI bajaradi
  // (`attendanceStatsNetwork.service.js`). Sabablar yuqoridagilar bilan
  // AYNI va bu yerda uchtasi ham bor:
  //
  //  1. FOIZ. Davomat foizi og'irliksiz o'rtachalanardi: 12 o'quvchili
  //     filial 344 o'quvchili filial bilan teng tortardi.
  //  2. REYTING. "Eng past sinflar" va "eng ko'p qoldirganlar" ro'yxati
  //     butun tarmoq bo'yicha QAYTA saralanishi kerak.
  //  3. WORD FAYLI. Ikkilik hujjat birlashtirilmaydi.
  //
  // ⚠️ `pulse` ham shu yerda: u sanoqchidan tashqari FOIZ va oldingi davr
  // bilan farqni ham qaytaradi, ya'ni `object` rejimi uni o'rtachalab
  // yuborardi (ERP kartasidan farqi aynan shunda).
  //
  // ⚠️ Filialni tanlab turgan odam bu yo'llarga 403 oladi (darvoza
  // `attendanceStats.controller.js` da) — registr buni ifodalamaydi.
  { pattern: "GET /attendance-reports/students/report/export", mode: "anchor" },
  { pattern: "GET /attendance-reports/students/report", mode: "anchor" },
  { pattern: "GET /attendance-reports/students/pulse", mode: "anchor" },
  { pattern: "GET /attendance-reports/teachers/report/export", mode: "anchor" },
  { pattern: "GET /attendance-reports/teachers/report", mode: "anchor" },
  { pattern: "GET /attendance-reports/teachers/pulse", mode: "anchor" },

  /* ── O'quvchilar harakati (keldi / ketdi) ─────────────────────────── */
  // ⚠️ O'QUVCHILAR HARAKATI — `anchor`, ya'ni BIRLASHTIRUVCHI TEGMAYDI.
  // Bu yo'llar FAQAT umumiy ko'rinishda ochiladi va filiallar bo'ylab
  // aylanishni O'ZLARI bajaradi (`studentMovementNetwork.service.js`).
  // Sabab ikkita, ikkalasi ham jim xato edi:
  //
  //  1. FOIZ. Birlashtiruvchi `*Percent` ni filiallar bo'yicha OG'IRLIKSIZ
  //     o'rtachalaydi; 344 o'quvchili filial bilan 0 o'quvchili filial teng
  //     hissa qo'shsa "tarmoq o'sishi" ma'nosiz raqam bo'lardi. Tarmoq
  //     foizi yig'indidan QAYTA hisoblanadi.
  //  2. WORD FAYLI. Ikkilik hujjat birlashtirilmaydi, shuning uchun eksport
  //     `unsupported` bo'lib turardi va aynan o'sha ekranda tugma O'CHIQ
  //     edi — holbuki "butun tarmoq bo'yicha bitta hujjat" bo'limning
  //     maqsadi. `anchor` da javob haqiqiy `res` ga yoziladi, ya'ni fayl
  //     ushlab olinmaydi.
  //
  // ⚠️ Filialni tanlab turgan odam bu yo'llarga 403 oladi (darvoza
  // `studentEnrollment.controller.js` da) — registr buni ifodalamaydi.
  { pattern: "GET /student-enrollments/movement/export", mode: "anchor" },
  { pattern: "GET /student-enrollments/movement/summary", mode: "anchor" },
  { pattern: "GET /student-enrollments/movement", mode: "anchor" },

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
  { pattern: "* /class-leaders/:id", locate: { model: "classLeader", param: "id" } },
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
