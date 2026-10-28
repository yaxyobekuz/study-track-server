/**
 * XODIMLAR TOPSHIRIQLARI — WORD HUJJATI.
 *
 * ⚠️ RAQAMLARNI O'ZI HISOBLAMAYDI va hisobotni CHAQIRMAYDI ham — tayyor
 * obyektni qabul qiladi. Ekranda ko'rinadigan hujjat bilan bir xil manba:
 * ikkita quruvchi bo'lsa, rahbar ekranda bir foizni, faylda boshqasini
 * ko'rardi va hisobotning butun mohiyati (ishonch) yo'qolardi
 * (`studentMovementExport.service.js` bilan AYNI doktrina).
 *
 * Bu fayl faqat SHAKL bilan shug'ullanadi: bo'limlar, jadvallar, yorliqlar.
 */

const { buildDocx, sendDocx } = require("./word.service");
const { formatDateTimeUz, formatDateUz } = require("../helpers/date.helpers");

/** Hujjat ranglari — ekrandagi bilan AYNI ma'noda. */
const COLOR = {
  muted: "6B7280",
  ink: "111827",
  good: "047857",
  bad: "B91C1C",
  warn: "B45309",
  head: "F3F4F6",
};

/** Foizi yo'q katak — bo'sh joy "hisoblanmadi" bo'lib o'qilmasin. */
const DASH = { text: "—", align: "right", color: COLOR.muted };

/** Holat yorliqlari — panel bilan AYNI so'zlar (`tasks.data.js`). */
const STATUS_LABEL = {
  completed: "Bajarildi",
  review: "Tekshiruvda",
  inProgress: "Jarayonda",
  overdue: "Muddati o'tgan",
  stopped: "To'xtatilgan",
};

const KIND_LABEL = { main: "Asosiy", extra: "Qo'shimcha" };

const TIMING_LABEL = {
  early: "Muddatdan oldin",
  lastDay: "Oxirgi kuni",
  late: "Kech topshirilgan",
};

const WEEKDAY_FULL = [
  "Dushanba",
  "Seshanba",
  "Chorshanba",
  "Payshanba",
  "Juma",
  "Shanba",
  "Yakshanba",
];

/** Foiz: "80,0%" / "—". Kasr — VERGUL bilan (o'zbekcha yozuv). */
const percent = (value) =>
  value == null ? "—" : `${Math.abs(value).toFixed(1).replace(".", ",")}%`;

/**
 * Davomiylik: "2 kun 3 soat" / "5 soat" / "45 daqiqa".
 *
 * ⚠️ Panel tomonida AYNI qoida `tasks.data.js` dagi `durationText` da —
 * sana formatlovchilari kabi (`.claude/rules/dates.md` §2) har muhitning
 * o'z manbasi bor, lekin natija matni BIR XIL bo'lishi shart.
 */
const duration = (minutes) => {
  if (minutes == null) return "—";

  const days = Math.floor(minutes / 1440);
  if (days >= 1) {
    const hours = Math.round((minutes - days * 1440) / 60);
    return hours ? `${days} kun ${hours} soat` : `${days} kun`;
  }

  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes - hours * 60);
  if (hours >= 1) return rest ? `${hours} soat ${rest} daqiqa` : `${hours} soat`;
  return `${Math.max(0, Math.round(minutes))} daqiqa`;
};

/** Bo'sh matn o'rniga "—": hujjatda bo'sh katak "ma'lumot yo'q" bo'lib o'qilmasin. */
const text = (value) => {
  const trimmed = String(value ?? "").trim();
  return trimmed || "—";
};

const num = (value, { bold = false, color } = {}) => ({
  text: String(value ?? 0),
  align: "right",
  bold,
  color: Number(value) ? color : color ? COLOR.muted : undefined,
});

// ─────────────────────────────────────────────
// Bo'limlar
// ─────────────────────────────────────────────

const headerBlocks = (report) => {
  // ⚠️ Umumiy ko'rinishda sarlavhada FILIAL NOMI TURMAYDI: hujjat butun
  // tarmoqniki va bitta filial nomi bilan sarlavhalansa, u o'sha filialning
  // hisoboti deb o'qilardi.
  const scopeLine = report.isNetwork
    ? `BARCHA FILIALLAR (${report.branches.length} ta)`
    : report.branch?.name;

  return [
    ...(scopeLine
      ? [
          {
            type: "paragraph",
            text: scopeLine,
            align: "center",
            bold: true,
            size: 20,
            color: COLOR.muted,
            after: 0,
          },
        ]
      : []),
    { type: "heading", level: 1, text: "XODIMLAR TOPSHIRIQLARI HISOBOTI" },
    {
      type: "paragraph",
      text: `Davr: ${report.period.label}`,
      align: "center",
      size: 22,
      color: COLOR.ink,
      after: report.isNetwork ? 10 : 20,
    },
    ...(report.isNetwork
      ? [
          {
            type: "paragraph",
            text: report.branches.map((item) => item.name).join("  ·  "),
            align: "center",
            size: 17,
            color: COLOR.muted,
            after: 20,
          },
        ]
      : []),
    {
      type: "paragraph",
      text: `Hisobot shakllantirilgan vaqt: ${formatDateTimeUz(report.generatedAt)}`,
      align: "center",
      size: 18,
      color: COLOR.muted,
      after: 200,
    },
  ];
};

/**
 * UMUMIY KO'RSATKICHLAR — jadvalning o'zi arifmetikani ko'rsatadi: rahbar
 * holatlarni qo'shib, jamiga tenglashtira oladi.
 */
const summaryBlocks = (report, index) => {
  const k = report.kpis;
  const share = (value) => (k.total > 0 ? (value / k.total) * 100 : null);

  const statusRow = (key, value, color) => [
    STATUS_LABEL[key],
    num(value, { bold: true, color }),
    { text: percent(share(value)), align: "right", color: COLOR.muted },
  ];

  return [
    { type: "heading", level: 2, text: `${index}. Umumiy ko'rsatkichlar` },
    {
      type: "table",
      columns: [
        { label: "Ko'rsatkich", width: 6 },
        { label: "Soni", width: 2, align: "right" },
        { label: "Ulushi", width: 2, align: "right" },
      ],
      rows: [
        [
          { text: "Davrda berilgan topshiriqlar", bold: true },
          num(k.total, { bold: true }),
          DASH,
        ],
        statusRow("completed", k.completed, COLOR.good),
        statusRow("review", k.review, COLOR.warn),
        statusRow("inProgress", k.inProgress),
        statusRow("overdue", k.overdue, COLOR.bad),
        statusRow("stopped", k.stopped),
        [
          { text: "Bajarilish darajasi", bold: true },
          {
            text: percent(k.completionRate),
            align: "right",
            bold: true,
            color: COLOR.good,
          },
          DASH,
        ],
        [
          "O'z vaqtida topshirilgani",
          { text: percent(k.onTimeRate), align: "right", color: COLOR.good },
          DASH,
        ],
        ["Ijrochilar (xodimlar)", num(k.assignees), DASH],
        ["Muddati uzaytirilgan", num(k.extended), DASH],
        ["Rad etilib qayta topshirilgan", num(k.rejected), DASH],
        [
          "Jarima yozilgan topshiriqlar",
          num(k.penalized, { color: COLOR.bad }),
          { text: `${k.penaltyPoints} ball`, align: "right", color: COLOR.muted },
        ],
        [
          "O'rtacha bajarish vaqti",
          { text: duration(k.avgCompletionMinutes), align: "right" },
          DASH,
        ],
        [
          "O'rtacha tekshirish vaqti",
          { text: duration(k.avgReviewMinutes), align: "right" },
          DASH,
        ],
      ],
    },
    {
      type: "paragraph",
      text:
        "Topshiriqlar BERILGAN sanasi bo'yicha olingan: \"shu davrda " +
        "berilgan ishning qanchasi bajarildi\". Bajarilish darajasi " +
        `to'xtatilganlarsiz hisoblanadi: ${k.completed} ÷ ` +
        `${Math.max(0, k.total - k.stopped)}.`,
      size: 17,
      color: COLOR.muted,
      after: 160,
    },
  ];
};

/**
 * FILIALLAR KESIMI — "qaysi filialda ish qolib ketyapti".
 *
 * ⚠️ Tarmoq jamisi savolning faqat yarmiga javob beradi: "28 ta muddati
 * o'tgan" ning hammasi bitta filialda bo'lishi mumkin.
 */
const branchBlocks = (report, index) => [
    { type: "heading", level: 2, text: `${index}. Filiallar kesimi` },
    {
      type: "table",
      columns: [
        { label: "Filial", width: 5 },
        { label: "Berildi", width: 2, align: "right" },
        { label: "Bajarildi", width: 2, align: "right" },
        { label: "Jarayonda", width: 2, align: "right" },
        { label: "Muddati o'tgan", width: 2, align: "right" },
        { label: "Bajarilish", width: 2, align: "right" },
      ],
      rows: [
        ...report.byBranch.map((row) => [
          text(row.branchName),
          num(row.total),
          num(row.completed, { color: COLOR.good }),
          num(row.inProgress + row.review),
          num(row.overdue, { bold: true, color: COLOR.bad }),
          { text: percent(row.completionRate), align: "right" },
        ]),
        [
          { text: "Jami (tarmoq)", bold: true, fill: COLOR.head },
          { ...num(report.kpis.total, { bold: true }), fill: COLOR.head },
          { ...num(report.kpis.completed, { bold: true }), fill: COLOR.head },
          {
            ...num(report.kpis.inProgress + report.kpis.review, { bold: true }),
            fill: COLOR.head,
          },
          { ...num(report.kpis.overdue, { bold: true }), fill: COLOR.head },
          {
            text: percent(report.kpis.completionRate),
            align: "right",
            bold: true,
            fill: COLOR.head,
          },
        ],
      ],
    },
    {
      type: "paragraph",
      text:
        "Ro'yxat muddati o'tgan topshiriqlar soni bo'yicha kamayish " +
        "tartibida: eng ko'p ish qolgan filial yuqorida turadi. " +
        "Foiz har filialning O'Z yig'indisidan hisoblangan, " +
        "\"Jami\" esa tarmoq yig'indisidan — ya'ni u filiallar " +
        "foizlarining o'rtachasi EMAS.",
      size: 17,
      color: COLOR.muted,
      after: 160,
    },
];

/** Topshiriq turlari va muddatga nisbatan topshirish — ikkita kichik jadval. */
const shapeBlocks = (report, index) => {
  const timingTotal =
    report.timing.early + report.timing.lastDay + report.timing.late;

  return [
    {
      type: "heading",
      level: 2,
      text: `${index}. Topshiriq turlari va topshirish vaqti`,
    },
    {
      type: "table",
      columns: [
        { label: "Tur", width: 4 },
        { label: "Berildi", width: 2, align: "right" },
        { label: "Bajarildi", width: 2, align: "right" },
        { label: "Muddati o'tgan", width: 2, align: "right" },
        { label: "Bajarilish", width: 2, align: "right" },
      ],
      rows: report.kinds.map((row) => [
        KIND_LABEL[row.key] || row.key,
        num(row.total),
        num(row.completed, { color: COLOR.good }),
        num(row.overdue, { color: COLOR.bad }),
        { text: percent(row.rate), align: "right" },
      ]),
    },
    {
      type: "paragraph",
      text:
        "\"Asosiy\" — lavozim bo'yicha doimiy ish, \"Qo'shimcha\" — bir " +
        "martalik vazifa. Qo'shimcha ishning ulushi o'sib borsa, asosiy " +
        "ish siqib chiqarilayotgan bo'ladi.",
      size: 17,
      color: COLOR.muted,
      after: 120,
    },
    {
      type: "table",
      columns: [
        { label: "Topshirish vaqti", width: 6 },
        { label: "Soni", width: 2, align: "right" },
        { label: "Ulushi", width: 2, align: "right" },
      ],
      rows: ["early", "lastDay", "late"].map((key) => [
        TIMING_LABEL[key],
        num(report.timing[key], {
          color: key === "late" ? COLOR.bad : COLOR.good,
        }),
        {
          text: percent(
            timingTotal > 0 ? (report.timing[key] / timingTotal) * 100 : null,
          ),
          align: "right",
          color: COLOR.muted,
        },
      ]),
    },
    {
      type: "paragraph",
      text:
        "Faqat YAKUNLANGAN topshiriqlar: ish muddatdan qancha oldin " +
        "topshirilgani. \"Oxirgi kuni\" — muddatga bir kundan kam qolganda.",
      size: 17,
      color: COLOR.muted,
      after: 160,
    },
  ];
};

/** Dinamika — har kun / hafta / oyda nechta ish berildi va nechtasi bitdi. */
const trendBlocks = (report, index) => [
  { type: "heading", level: 2, text: `${index}. Dinamika`, pageBreakBefore: true },
  {
    type: "table",
    columns: [
      { label: "Davr", width: 6 },
      { label: "Berildi", width: 2, align: "right" },
      { label: "Bajarildi", width: 2, align: "right" },
      { label: "Farq", width: 2, align: "right" },
    ],
    rows: report.trend.map((row) => {
      const diff = row.completed - row.created;
      return [
        text(row.label || row.key),
        num(row.created),
        num(row.completed, { color: COLOR.good }),
        {
          text: diff > 0 ? `+${diff}` : diff < 0 ? `−${Math.abs(diff)}` : "0",
          align: "right",
          color: diff < 0 ? COLOR.bad : diff > 0 ? COLOR.good : COLOR.muted,
        },
      ];
    }),
  },
  {
    type: "paragraph",
    text:
      "\"Berildi\" — o'sha davrda yozilgan topshiriqlar, \"Bajarildi\" — " +
      "o'sha davrda YAKUNLANGANLARI (qachon berilganidan qat'i nazar). " +
      "Farq manfiy bo'lsa, ish to'planib boryapti.",
    size: 17,
    color: COLOR.muted,
    after: 160,
  },
];

/** Hafta kunlari — qaysi kuni ish ko'proq yakunlanadi. */
const weekdayBlocks = (report, index) => [
  { type: "heading", level: 2, text: `${index}. Hafta kunlari kesimi` },
  {
    type: "table",
    columns: [
      { label: "Kun", width: 6 },
      { label: "Berildi", width: 2, align: "right" },
      { label: "Bajarildi", width: 2, align: "right" },
    ],
    rows: report.weekday.map((row) => [
      WEEKDAY_FULL[row.index] || String(row.index),
      num(row.created),
      num(row.completed, { color: COLOR.good }),
    ]),
  },
  { type: "spacer" },
];

/** Rollar kesimi — qaysi toifadagi xodimlarda ish qolyapti. */
const roleBlocks = (report, index) => [
  { type: "heading", level: 2, text: `${index}. Rollar kesimi` },
  {
    type: "table",
    columns: [
      { label: "Rol", width: 5 },
      { label: "Xodim", width: 2, align: "right" },
      { label: "Berildi", width: 2, align: "right" },
      { label: "Bajarildi", width: 2, align: "right" },
      { label: "Muddati o'tgan", width: 2, align: "right" },
      { label: "Bajarilish", width: 2, align: "right" },
    ],
    rows: report.byRole.map((row) => [
      text(row.roleName || row.role),
      num(row.people),
      num(row.assigned),
      num(row.completed, { color: COLOR.good }),
      num(row.overdue, { color: COLOR.bad }),
      { text: percent(row.rate), align: "right" },
    ]),
  },
  {
    type: "paragraph",
    text:
      "⚠️ \"Xodim\" ustuni QATORLAR sonini sanaydi: bir nechta filialda " +
      "ishlaydigan odam har filialda alohida qator bo'lgani uchun bu " +
      "yerda ham alohida sanaladi.",
    size: 17,
    color: COLOR.muted,
    after: 160,
  },
];

/** Yetakchilar va e'tibor talab qiladiganlar — ikkita qisqa ro'yxat. */
const rankingBlocks = (report, next, showBranch) => {
  const columns = [
    { label: "№", width: 1, align: "center" },
    { label: "F.I.Sh.", width: 6 },
    ...(showBranch ? [{ label: "Filial", width: 3 }] : []),
    { label: "Berildi", width: 2, align: "right" },
    { label: "Bajarildi", width: 2, align: "right" },
    { label: "Muddati o'tgan", width: 2, align: "right" },
    { label: "Bajarilish", width: 2, align: "right" },
  ];

  const row = (item, i) => [
    { text: String(i + 1), align: "center", color: COLOR.muted },
    text(item.name),
    ...(showBranch ? [{ text: text(item.branchName), color: COLOR.muted }] : []),
    num(item.assigned),
    num(item.completed, { color: COLOR.good }),
    num(item.overdue, { color: COLOR.bad }),
    { text: percent(item.rate), align: "right" },
  ];

  const blocks = [
    { type: "heading", level: 2, text: `${next()}. Yetakchilar` },
  ];

  if (report.leaders.length) {
    blocks.push({ type: "table", columns, rows: report.leaders.map(row) });
  } else {
    blocks.push({
      type: "paragraph",
      text: "Davrda yakunlangan topshiriq yo'q.",
      size: 19,
      color: COLOR.muted,
    });
  }

  blocks.push({
    type: "heading",
    level: 2,
    text: `${next()}. E'tibor talab qiladi`,
  });

  if (report.attention.length) {
    blocks.push(
      { type: "table", columns, rows: report.attention.map(row) },
      {
        type: "paragraph",
        text:
          "Ro'yxatga muddati o'tgan ishi bor yoki kamida ikkita " +
          "topshiriqdan yarmidan kamini bajargan xodimlar tushadi.",
        size: 17,
        color: COLOR.muted,
        after: 160,
      },
    );
  } else {
    blocks.push({
      type: "paragraph",
      text: "Muddati o'tgan ishi bor xodim yo'q.",
      size: 19,
      color: COLOR.good,
      after: 160,
    });
  }

  return blocks;
};

/** Xodimlar kesimi — to'liq jadval. */
const peopleBlocks = (report, index, showBranch) => [
  {
    type: "heading",
    level: 2,
    text: `${index}. Xodimlar kesimi (${report.people.length} ta qator)`,
    pageBreakBefore: true,
  },
  {
    type: "table",
    columns: [
      { label: "№", width: 1, align: "center" },
      { label: "F.I.Sh.", width: 5 },
      ...(showBranch ? [{ label: "Filial", width: 3 }] : []),
      { label: "Berildi", width: 2, align: "right" },
      { label: "Bajarildi", width: 2, align: "right" },
      { label: "Jarayonda", width: 2, align: "right" },
      { label: "Muddati o'tgan", width: 2, align: "right" },
      { label: "Bajarilish", width: 2, align: "right" },
      { label: "O'z vaqtida", width: 2, align: "right" },
    ],
    rows: report.people.map((item, i) => [
      { text: String(i + 1), align: "center", color: COLOR.muted },
      text(item.name),
      ...(showBranch ? [{ text: text(item.branchName), color: COLOR.muted }] : []),
      num(item.assigned),
      num(item.completed, { color: COLOR.good }),
      num(item.inProgress + item.review),
      num(item.overdue, { color: COLOR.bad }),
      { text: percent(item.rate), align: "right" },
      { text: percent(item.onTimeRate), align: "right", color: COLOR.muted },
    ]),
  },
  {
    type: "paragraph",
    text: showBranch
      ? "⚠️ Bir nechta filialda ishlaydigan xodim HAR FILIAL uchun " +
        "alohida qatorda turadi: topshiriqni kim bergan, kim tekshirgan " +
        "va jarimasi qayerda yozilgani — hammasi o'sha filialga tegishli. " +
        "Yuqoridagi \"Ijrochilar\" soni esa odamlarni TAKRORSIZ sanaydi."
      : "Ro'yxat berilgan topshiriqlar soni bo'yicha kamayish tartibida.",
    size: 17,
    color: COLOR.muted,
    after: 160,
  },
];

/**
 * HOZIRGI HOLAT — davrga bog'liq EMAS.
 *
 * ⚠️ Yuqoridagi jadvallar "shu davrda berilgan ish" haqida, bu bo'lim esa
 * "hozir nima qolgan" haqida: muddati o'tgan topshiriq o'tgan oyda
 * berilgan bo'lishi mumkin. Ikkalasini bir jadvalga qo'shish "davr"
 * so'zini ikki ma'noda ishlatardi.
 */
const liveBlocks = (report, index, showBranch) => {
  const columns = [
    { label: "№", width: 1, align: "center" },
    { label: "Topshiriq", width: 6 },
    { label: "Ijrochi", width: 4 },
    ...(showBranch ? [{ label: "Filial", width: 3 }] : []),
    { label: "Muddat", width: 3, align: "right" },
  ];

  const rows = (items) =>
    items.map((item, i) => [
      { text: String(i + 1), align: "center", color: COLOR.muted },
      text(item.title),
      text(item.assignee?.name),
      ...(showBranch ? [{ text: text(item.branchName), color: COLOR.muted }] : []),
      { text: formatDateUz(item.dueDate), align: "right" },
    ]);

  const blocks = [
    {
      type: "heading",
      level: 2,
      text: `${index}. Hozirgi holat`,
      pageBreakBefore: true,
    },
    {
      type: "table",
      columns: [
        { label: "Ko'rsatkich", width: 6 },
        { label: "Soni", width: 2, align: "right" },
      ],
      rows: [
        [
          { text: "Muddati o'tgan, hali bajarilmagan", bold: true },
          num(report.live.counts.overdue, { bold: true, color: COLOR.bad }),
        ],
        [
          `Muddati yaqin (${report.live.dueSoonHours} soat ichida)`,
          num(report.live.counts.dueSoon, { color: COLOR.warn }),
        ],
        [
          "Tekshiruv navbatida",
          num(report.live.counts.review, { color: COLOR.warn }),
        ],
      ],
    },
    {
      type: "paragraph",
      text:
        "Bu uch raqam DAVRGA BOG'LIQ EMAS — ular hisobot " +
        "shakllantirilgan ondagi holat. Quyidagi ro'yxatlarda eng " +
        "kechikkan topshiriqlardan boshlab bir nechtasi keltirilgan.",
      size: 17,
      color: COLOR.muted,
      after: 120,
    },
  ];

  if (report.live.overdue.length) {
    blocks.push(
      { type: "heading", level: 3, text: "Eng ko'p kechikkan topshiriqlar" },
      { type: "table", columns, rows: rows(report.live.overdue) },
    );
  }

  if (report.live.review.length) {
    blocks.push(
      { type: "heading", level: 3, text: "Tekshiruv navbati" },
      { type: "table", columns, rows: rows(report.live.review) },
    );
  }

  return blocks;
};

const footerBlocks = (report) => [
  { type: "spacer" },
  { type: "heading", level: 3, text: "Hisobot haqida" },
  {
    type: "paragraph",
    text:
      "Hisobot topshiriq BERILGAN sana bo'yicha quriladi: shu davrda " +
      "berilgan ishning qanchasi bajarilgani ko'rsatiladi va bitta " +
      "topshiriq ikki davrda ikki marta sanalmaydi. Xodim O'ZIGA O'ZI " +
      "belgilagan topshiriqlar hisobotga KIRMAYDI — ular jarimasiz va " +
      "tasdiqlashsiz yopiladi, ya'ni rahbar bergan ishning intizomini " +
      "ko'rsatmaydi.",
    size: 18,
    color: COLOR.muted,
  },
  ...(report.partial?.length
    ? [
        {
          type: "paragraph",
          text:
            `Diqqat: ${report.partial.join(", ")} filial(lar) ma'lumoti ` +
            "olinmadi va bu hisobotga KIRMAGAN.",
          size: 18,
          bold: true,
          color: COLOR.bad,
        },
      ]
    : []),
  {
    type: "paragraph",
    text: "Ma'lumot manbai — platformadagi \"Lavozimlar markazi\" bo'limi. Hujjat avtomatik shakllantirilgan.",
    size: 18,
    color: COLOR.muted,
  },
];

/**
 * ⚠️ BO'LIM RAQAMLARI AVTOMAT: yangi bo'lim qo'shilganda qo'lda yozilgan
 * raqamlar surilib, hujjatda bitta raqam ikki marta chiqardi
 * (`studentMovementExport.service.js` dagi AYNI tuzoq).
 *
 * @param {object} report - `getNetworkTaskReport` natijasi
 * @returns {Promise<Buffer>}
 */
const buildTaskReportDocx = (report) => {
  const net = Boolean(report.isNetwork);
  let section = 0;
  const next = () => (section += 1);

  const blocks = [...headerBlocks(report), ...summaryBlocks(report, next())];

  // Faqat umumiy ko'rinishda: bitta filialda bu jadval o'zini takrorlardi.
  if (net) blocks.push(...branchBlocks(report, next()));

  blocks.push(...shapeBlocks(report, next()));

  // Bitta bo'lakli davrda (bir kunlik hisobot) dinamika umumiy
  // ko'rsatkichlarni takrorlaydi.
  if (report.trend.length >= 2) blocks.push(...trendBlocks(report, next()));

  // Hafta kunlari faqat bir haftadan uzun davrda ma'noga ega.
  if (report.period.days >= 7) blocks.push(...weekdayBlocks(report, next()));

  if (report.byRole.length) blocks.push(...roleBlocks(report, next()));

  // ⚠️ IKKI BO'LIM: raqamni funksiyaning O'ZI oladi, chaqiruvchi esa
  // ularni sanab o'tirmaydi — bo'lim qo'shilsa raqamlar o'zi suriladi.
  blocks.push(...rankingBlocks(report, next, net));

  if (report.people.length) blocks.push(...peopleBlocks(report, next(), net));

  blocks.push(...liveBlocks(report, next(), net), ...footerBlocks(report));

  return buildDocx({
    title: `Xodimlar topshiriqlari — ${report.period.label}`,
    author: net ? "Barcha filiallar" : report.branch?.name || "MBSI",
    blocks,
  });
};

/**
 * TAYYOR HISOBOTDAN faylga — controller uchun.
 *
 * ⚠️ Hisobotni O'ZI CHAQIRMAYDI: controller uni bir marta quradi va shu
 * yerga beradi. Aks holda bir so'rovda ikki marta hisoblanardi (umumiy
 * ko'rinishda — har filialda ikki marta).
 *
 * @param {import("express").Response} res
 * @param {object} report
 */
const sendTaskReportDocx = async (res, report) => {
  const buffer = await buildTaskReportDocx(report);
  const scope = report.isNetwork ? " (barcha filiallar)" : "";

  sendDocx(res, buffer, `Xodimlar topshiriqlari${scope} ${report.period.label}`, {
    fallbackName: "xodimlar-topshiriqlari",
  });
};

module.exports = { buildTaskReportDocx, sendTaskReportDocx };
