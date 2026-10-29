/**
 * DAVOMAT HISOBOTLARI — WORD HUJJATLARI (o'quvchilar va o'qituvchilar).
 *
 * ⚠️ RAQAMLARNI O'ZI HISOBLAMAYDI va hisobotni CHAQIRMAYDI ham — tayyor
 * obyektni qabul qiladi. Ekranda ko'rinadigan hujjat bilan bir xil manba:
 * ikkita quruvchi bo'lsa, rahbar ekranda bir foizni, faylda boshqasini
 * ko'rardi (`taskReportExport.service.js` bilan AYNI doktrina).
 *
 * ⚠️ IKKI HUJJAT, BITTA SHAKL. Umumiy ko'rsatkichlar, taqqoslash,
 * dinamika, hafta kunlari va filiallar kesimi ikkalasida ham AYNI
 * jadvallar: o'quvchi tomoni bilan o'qituvchi tomoni bir xil savolga
 * javob beradi va ularni ikki xil chizish hujjatni o'qishni
 * qiyinlashtirardi.
 *
 * Bu fayl faqat SHAKL bilan shug'ullanadi: bo'limlar, jadvallar, yorliqlar.
 */

const { buildDocx, sendDocx } = require("./word.service");
const { formatDateTimeUz } = require("../helpers/date.helpers");
const { phonePairText, PHONE_PAIR_LABEL } = require("../helpers/phone.helpers");

/** Hujjat ranglari — ekrandagi bilan AYNI ma'noda. */
const COLOR = {
  muted: "6B7280",
  ink: "111827",
  good: "047857",
  bad: "B91C1C",
  warn: "B45309",
};

/**
 * ⚠️ MINUS BELGISI — U+2212 (`−`), defis EMAS: qator boshidagi defisni
 * Word ro'yxat belgisiga aylantirib yuborishi mumkin.
 */
const MINUS = "−";

/** Qiymati yo'q katak — bo'sh joy "hisoblanmadi" bo'lib o'qilmasin. */
const DASH = { text: "—", align: "right", color: COLOR.muted };

const signed = (value) => {
  const number = Number(value) || 0;
  if (number > 0) return `+${number}`;
  if (number < 0) return `${MINUS}${Math.abs(number)}`;
  return "0";
};

/** Foiz: "94,3%" / "—". Kasr — VERGUL bilan (o'zbekcha yozuv). */
const percent = (value) =>
  value == null ? "—" : `${Math.abs(value).toFixed(1).replace(".", ",")}%`;

/**
 * FOIZ FARQI — PUNKTDA: "94% dan 96% ga" o'sish 2 punkt, 2,1% EMAS.
 * Foizning foizi rahbarni chalg'itardi.
 */
const points = (value) => {
  if (value == null) return "—";
  const abs = Math.abs(value).toFixed(1).replace(".", ",");
  if (value > 0) return `+${abs} punkt`;
  if (value < 0) return `${MINUS}${abs} punkt`;
  return "0,0 punkt";
};

const toneOf = (value) => (value > 0 ? COLOR.good : value < 0 ? COLOR.bad : COLOR.muted);

const text = (value) => {
  const trimmed = String(value ?? "").trim();
  return trimmed || "—";
};

/**
 * MINGLIK AJRATGICH — "32 611".
 *
 * ⚠️ `Intl` / `toLocaleString` ISHLATILMAYDI: ajratgich Node ICU
 * qurilishiga va brauzer locale'iga bog'liq bo'lib qoladi — serverda
 * "32 611", ekranda esa "32,611" chiqardi va bitta hujjatning ikki
 * nusxasi boshqacha ko'rinardi (`money.helpers.js` → `formatSum` va
 * `dates.md` §3 bilan AYNI sabab).
 *
 * ⚠️ Ajratgich — UZILMAS BO'SHLIQ (U+00A0): oddiy bo'shliq tor ustunda
 * raqamni ikki qatorga bo'lib yuborardi ("32" / "611").
 */
const grouped = (value) =>
  String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00A0");

const num = (value, { bold = false, color } = {}) => ({
  text: grouped(value),
  align: "right",
  bold,
  color: Number(value) ? color : color ? COLOR.muted : undefined,
});

const pct = (value, { bold = false, color } = {}) => ({
  text: percent(value),
  align: "right",
  bold,
  color,
});

/**
 * Daqiqa: "2 soat 15 daqiqa" / "45 daqiqa" / "—".
 *
 * ⚠️ SOAT ham minglik ajratgich bilan (`grouped`): yillik yig'indida
 * "46924 soat" degan raqamni o'qib bo'lmasdi.
 */
const minutes = (value) => {
  const total = Math.round(Number(value) || 0);
  if (!total) return "—";
  const hours = Math.floor(total / 60);
  const rest = total - hours * 60;
  if (!hours) return `${rest} daqiqa`;
  return rest ? `${grouped(hours)} soat ${rest} daqiqa` : `${grouped(hours)} soat`;
};

/* ───────────────────────── UMUMIY BO'LIMLAR ───────────────────────── */

const headerBlocks = (report, { title, subtitle }) => {
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
    { type: "heading", level: 1, text: title },
    {
      type: "paragraph",
      text: subtitle,
      align: "center",
      size: 22,
      color: COLOR.ink,
      after: 0,
    },
    {
      type: "paragraph",
      // ⚠️ PRESET NOMI (oylik / yillik) YONIDA ANIQ ORALIQ: "Oylik" degan
      // yozuvning o'zi hujjatni TUGAGAN oy hisoboti qilib ko'rsatardi.
      text: `${report.period.label} — ${report.period.rangeLabel}`,
      align: "center",
      size: 20,
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
 * OLDINGI DAVR BILAN TAQQOSLASH.
 *
 * ⚠️ FOIZ VA SONLAR BIRGA: faqat punkt ko'rsatilsa, davr qisqa bo'lgani
 * uchun tushgan sonlar ham "yomonlashdi" bo'lib o'qilardi; faqat sonlar
 * ko'rsatilsa, kattalashgan maktabdagi o'sish "yaxshilandi" bo'lib
 * ko'rinardi.
 */
const compareBlocks = (report, index, rows) => [
  { type: "heading", level: 2, text: `${index}. ${report.period.previous.title} bilan taqqoslash` },
  {
    type: "paragraph",
    text:
      `Joriy davr: ${report.period.rangeLabel}. ` +
      `Taqqoslanayotgan davr: ${report.period.previous.label}.`,
    size: 18,
    color: COLOR.muted,
  },
  {
    type: "table",
    columns: [
      { label: "Ko'rsatkich", width: 5 },
      { label: "Joriy", width: 2, align: "right" },
      { label: report.period.previous.title, width: 2, align: "right" },
      { label: "Farq", width: 2, align: "right" },
    ],
    rows,
  },
];

/**
 * Taqqoslash jadvalining bitta qatori.
 *
 * ⚠️ FARQNING RANGI `trend` DAN KELADI, sonning ishorasidan EMAS:
 *   · `good`    — o'sish yaxshi (kelganlar),
 *   · `bad`     — o'sish yomon (kelmaganlar, sababli, kechikish),
 *   · `neutral` — na yaxshi, na yomon (o'quv kunlari, kutilgan kunlar —
 *     ular shunchaki davrning uzunligini bildiradi).
 *
 * Busiz "sababli kelmaganlar +928" YASHIL bo'lib, yomonlashuv yaxshilanish
 * bo'lib ko'rinardi.
 */
const compareRow = (label, current, previous, { bold = false, color, trend = "neutral" } = {}) => {
  const diff = (Number(current) || 0) - (Number(previous) || 0);
  const tone =
    trend === "good" ? toneOf(diff) : trend === "bad" ? toneOf(-diff) : COLOR.muted;

  return [
    bold ? { text: label, bold: true } : label,
    num(current, { bold, color }),
    num(previous),
    { text: signed(diff), align: "right", color: tone },
  ];
};

/** Davomat foizi qatori — farqi PUNKTDA. */
const comparePercentRow = (report) => [
  { text: "Davomat foizi", bold: true },
  pct(report.totals.percent, { bold: true, color: COLOR.good }),
  pct(report.previous.percent),
  {
    text: points(report.change.percentPoints),
    align: "right",
    bold: true,
    color: toneOf(report.change.percentPoints),
  },
];

/**
 * FILIALLAR KESIMI — "qaysi filialda davomat past".
 *
 * ⚠️ Faqat umumiy ko'rinishda: bitta filialda bu jadval o'zini takrorlardi.
 */
const branchBlocks = (report, index) => [
  { type: "heading", level: 2, text: `${index}. Filiallar kesimi` },
  {
    type: "paragraph",
    text:
      "Foiz har filialning O'Z yig'indisidan hisoblangan, filiallar " +
      "o'rtachasi EMAS. Qator davomat foizi bo'yicha o'sish tartibida.",
    size: 18,
    color: COLOR.muted,
  },
  {
    type: "table",
    columns: [
      { label: "Filial", width: 4 },
      { label: "Kutilgan", width: 2, align: "right" },
      { label: "Keldi", width: 2, align: "right" },
      { label: "Kelmadi", width: 2, align: "right" },
      { label: "Davomat", width: 2, align: "right" },
      { label: "Farq", width: 2, align: "right" },
    ],
    rows: report.byBranch.map((row) => [
      { text: text(row.branchName), bold: true },
      num(row.expected),
      num(row.came, { color: COLOR.good }),
      num(row.expected - row.came, { color: COLOR.bad }),
      pct(row.percent, { bold: true }),
      {
        text: points(row.percentPoints),
        align: "right",
        color: toneOf(row.percentPoints),
      },
    ]),
  },
];

/** DINAMIKA — kun / hafta / oy bo'laklari. */
const trendBlocks = (report, index) => [
  { type: "heading", level: 2, text: `${index}. Dinamika` },
  {
    type: "table",
    columns: [
      { label: "Davr", width: 5 },
      { label: "O'quv kunlari", width: 2, align: "right" },
      { label: "Kutilgan", width: 2, align: "right" },
      { label: "Keldi", width: 2, align: "right" },
      { label: "Davomat", width: 2, align: "right" },
    ],
    rows: report.trend.map((row) => [
      text(row.label),
      num(row.days),
      num(row.expected),
      num(row.came),
      pct(row.percent, { bold: true }),
    ]),
  },
];

/** HAFTA KUNLARI — "qaysi kuni ko'proq qoldiriladi". */
const weekdayBlocks = (report, index) => [
  { type: "heading", level: 2, text: `${index}. Hafta kunlari kesimi` },
  {
    type: "table",
    columns: [
      { label: "Kun", width: 4 },
      { label: "Kunlar soni", width: 2, align: "right" },
      { label: "Kutilgan", width: 2, align: "right" },
      { label: "Keldi", width: 2, align: "right" },
      { label: "Davomat", width: 2, align: "right" },
    ],
    rows: report.weekday.map((row) => [
      text(row.label),
      num(row.days),
      num(row.expected),
      num(row.came),
      pct(row.percent, { bold: true }),
    ]),
  },
];

const footerBlocks = (report, lines) => [
  { type: "heading", level: 3, text: "Hisobot haqida" },
  ...lines.map((line) => ({
    type: "paragraph",
    text: line,
    size: 18,
    color: COLOR.muted,
  })),
  ...(report.partial?.length
    ? [
        {
          type: "paragraph",
          text: `Diqqat: ${report.partial.join(", ")} filial(lar) ma'lumoti olinmadi va bu hisobotga KIRMAGAN.`,
          size: 18,
          bold: true,
          color: COLOR.bad,
        },
      ]
    : []),
  {
    type: "paragraph",
    text: "Hujjat platformada avtomatik shakllantirilgan.",
    size: 18,
    color: COLOR.muted,
  },
];

/* ──────────────────────── O'QUVCHILAR HUJJATI ──────────────────────── */

const studentSummaryBlocks = (report, index) => {
  const t = report.totals;
  const share = (value) => (t.expected > 0 ? (value / t.expected) * 100 : null);

  const row = (label, value, color) => [
    label,
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
        [{ text: "O'quv kunlari", bold: true }, num(t.schoolDays, { bold: true }), DASH],
        [
          { text: "Kutilgan o'quvchi-kunlar", bold: true },
          num(t.expected, { bold: true }),
          DASH,
        ],
        row("Keldi", t.came, COLOR.good),
        row("shundan kech keldi", t.late, COLOR.warn),
        row("Kelmadi (sababsiz)", t.absent, COLOR.bad),
        row("Sababli", t.excused, COLOR.warn),
        row("Belgilanmagan", t.unmarked, COLOR.muted),
        [
          { text: "Davomat foizi", bold: true },
          pct(t.percent, { bold: true, color: COLOR.good }),
          DASH,
        ],
      ],
    },
  ];
};

const classBlocks = (report, index, net) => [
  { type: "heading", level: 2, text: `${index}. Sinflar kesimi`, pageBreakBefore: true },
  {
    type: "paragraph",
    text: "Davomat foizi bo'yicha o'sish tartibida — eng past sinf birinchi turadi.",
    size: 18,
    color: COLOR.muted,
  },
  {
    type: "table",
    columns: [
      { label: "№", width: 1, align: "center" },
      { label: "Sinf", width: 3 },
      ...(net ? [{ label: "Filial", width: 2 }] : []),
      { label: "Kutilgan", width: 2, align: "right" },
      { label: "Keldi", width: 2, align: "right" },
      { label: "Kelmadi", width: 2, align: "right" },
      { label: "Sababli", width: 2, align: "right" },
      { label: "Davomat", width: 2, align: "right" },
    ],
    rows: report.classes.map((row, i) => [
      { text: String(i + 1), align: "center", color: COLOR.muted },
      { text: text(row.className), bold: true },
      ...(net ? [text(row.branchName)] : []),
      num(row.expected),
      num(row.came, { color: COLOR.good }),
      num(row.absent, { color: COLOR.bad }),
      num(row.excused),
      pct(row.percent, { bold: true }),
    ]),
  },
];

const studentListBlocks = (report, index, net) => [
  {
    type: "heading",
    level: 2,
    text: `${index}. Eng ko'p qoldirgan o'quvchilar`,
    pageBreakBefore: true,
  },
  {
    type: "paragraph",
    text:
      "Qoldirilgan kunlar soni bo'yicha. Belgilanmagan kun ham qoldirilgan " +
      "hisoblanadi — davomat belgilanmagan bo'lsa, o'quvchi kelgani " +
      "tasdiqlanmagan.",
    size: 18,
    color: COLOR.muted,
  },
  {
    type: "table",
    columns: [
      { label: "№", width: 1, align: "center" },
      { label: "O'quvchi", width: 4 },
      // ⚠️ RO'YXAT QO'NG'IROQ UCHUN: raqamsiz u faqat "xabar" bo'lib
      // qolardi. Ikki raqam bitta ustunda, ikki qator — sababi
      // `phone.helpers.js` dagi izohda.
      { label: PHONE_PAIR_LABEL, width: 5 },
      ...(net ? [{ label: "Filial", width: 2 }] : []),
      { label: "Sinf", width: 2 },
      { label: "Kutilgan", width: 2, align: "right" },
      { label: "Keldi", width: 2, align: "right" },
      { label: "Qoldirdi", width: 2, align: "right" },
      { label: "Davomat", width: 2, align: "right" },
    ],
    rows: report.students.map((row, i) => [
      { text: String(i + 1), align: "center", color: COLOR.muted },
      { text: text(row.name), bold: true },
      { text: phonePairText(row) },
      ...(net ? [text(row.branchName)] : []),
      text(row.className),
      num(row.expected),
      num(row.came),
      num(row.expected - row.came, { bold: true, color: COLOR.bad }),
      pct(row.percent),
    ]),
  },
];

/* ─────────────────────── O'QITUVCHILAR HUJJATI ─────────────────────── */

const teacherSummaryBlocks = (report, index) => {
  const t = report.totals;
  const share = (value) => (t.expected > 0 ? (value / t.expected) * 100 : null);

  const row = (label, value, color) => [
    label,
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
        [{ text: "O'quv kunlari", bold: true }, num(t.schoolDays, { bold: true }), DASH],
        [{ text: "O'qituvchilar", bold: true }, num(report.staffCount, { bold: true }), DASH],
        [
          { text: "Kutilgan ish kunlari", bold: true },
          num(t.expected, { bold: true }),
          DASH,
        ],
        row("Keldi", t.came, COLOR.good),
        row("shundan kech keldi", t.late, COLOR.warn),
        row("Kelmadi (sababsiz)", t.absent, COLOR.bad),
        row("Sababli", t.excused, COLOR.warn),
        row("Belgilanmagan (bugun)", t.unmarked, COLOR.muted),
        [
          { text: "Davomat foizi", bold: true },
          pct(t.percent, { bold: true, color: COLOR.good }),
          DASH,
        ],
        [
          "Jami kechikish",
          { text: minutes(t.lateMinutes), align: "right", color: COLOR.warn },
          DASH,
        ],
        [
          "O'rtacha kechikish",
          { text: minutes(t.avgLateMinutes), align: "right", color: COLOR.muted },
          DASH,
        ],
        // ⚠️ "Keldi-ketti": faqat kelish VA ketish vaqti yozilgan kunlar
        [
          "Ishda bo'lgan vaqt",
          { text: minutes(t.workedMinutes), align: "right" },
          DASH,
        ],
        [
          `Kunlik o'rtacha (${grouped(t.timedDays)} kun)`,
          { text: minutes(t.avgWorkedMinutes), align: "right", color: COLOR.muted },
          DASH,
        ],
      ],
    },
  ];
};

const teacherListBlocks = (report, index, net) => [
  {
    type: "heading",
    level: 2,
    text: `${index}. O'qituvchilar kesimi`,
    pageBreakBefore: true,
  },
  {
    type: "paragraph",
    text: "Davomat foizi bo'yicha o'sish tartibida — e'tibor talab qiladigani birinchi turadi.",
    size: 18,
    color: COLOR.muted,
  },
  {
    type: "table",
    columns: [
      { label: "№", width: 1, align: "center" },
      { label: "O'qituvchi", width: 4 },
      ...(net ? [{ label: "Filial", width: 2 }] : []),
      { label: "Ish kunlari", width: 2, align: "right" },
      { label: "Keldi", width: 2, align: "right" },
      { label: "Kech", width: 1, align: "right" },
      { label: "Kelmadi", width: 2, align: "right" },
      { label: "Sababli", width: 2, align: "right" },
      { label: "Davomat", width: 2, align: "right" },
      { label: "Kunlik o'rtacha", width: 3, align: "right" },
    ],
    rows: report.teachers.map((row, i) => [
      { text: String(i + 1), align: "center", color: COLOR.muted },
      { text: text(row.name), bold: true },
      ...(net ? [text(row.branchName)] : []),
      num(row.expected),
      num(row.came, { color: COLOR.good }),
      num(row.late, { color: COLOR.warn }),
      num(row.absent, { color: COLOR.bad }),
      num(row.excused),
      pct(row.percent, { bold: true }),
      { text: minutes(row.avgWorkedMinutes), align: "right", color: COLOR.muted },
    ]),
  },
];

/**
 * BUGUNGI JONLI HOLAT — "dars bo'lyapti, o'qituvchi esa maktabda yo'q".
 *
 * ⚠️ Bu bo'lim DAVRGA bog'liq emas: u hujjat shakllantirilgan PAYTDAGI
 * holat. Shuning uchun sarlavhasida kun va soat yoziladi — ertaga
 * ochilgan hujjatda bu raqam boshqacha bo'ladi.
 */
const liveBlocks = (report, index, net) => {
  const live = report.live;
  const title = `${index}. Bugun darsga chiqmaganlar`;

  if (!live) {
    return [
      { type: "heading", level: 2, text: title },
      {
        type: "paragraph",
        text: "Tanlangan davr bugungi kunni qamramaydi — jonli holat ko'rsatilmaydi.",
        size: 18,
        color: COLOR.muted,
      },
    ];
  }

  const head = [
    { type: "heading", level: 2, text: title, pageBreakBefore: true },
    {
      type: "paragraph",
      text:
        `${live.dateLabel}${live.nowLabel ? `, soat ${live.nowLabel} holatiga` : ""}. ` +
        "Dars BOSHLANGAN, amaldagi o'qituvchi (o'rinbosarlik hisobga olingan) esa maktabda yo'q.",
      size: 18,
      color: COLOR.muted,
    },
  ];

  if (live.closed) {
    return [...head, { type: "paragraph", text: text(live.message), size: 20 }];
  }

  if (!live.teachers.length) {
    return [
      ...head,
      {
        type: "paragraph",
        text: "Hozircha darsga chiqmagan o'qituvchi yo'q.",
        size: 20,
        color: COLOR.good,
      },
    ];
  }

  return [
    ...head,
    {
      type: "table",
      columns: [
        { label: "O'qituvchi", width: 4 },
        ...(net ? [{ label: "Filial", width: 2 }] : []),
        { label: "Holat", width: 3 },
        { label: "Keldi", width: 2, align: "center" },
        { label: "Darslar", width: 5 },
      ],
      rows: live.teachers.map((row) => [
        { text: text(row.teacherName), bold: true },
        ...(net ? [text(row.branchName)] : []),
        {
          text: text(row.stateLabel),
          color: row.state === "absent" ? COLOR.bad : COLOR.warn,
        },
        { text: text(row.arrivedAtLabel), align: "center" },
        text(
          row.lessons
            .map(
              (lesson) =>
                `${lesson.className} — ${lesson.lessonOrder}-dars` +
                `${lesson.startTime ? ` (${lesson.startTime})` : ""}` +
                `${lesson.ongoing ? ", hozir davom etmoqda" : ""}`,
            )
            .join("\n"),
        ),
      ]),
    },
    ...(live.summary.untimedLessons
      ? [
          {
            type: "paragraph",
            text: `${live.summary.untimedLessons} ta darsning vaqti kiritilmagani uchun ro'yxatga kirmadi.`,
            size: 18,
            color: COLOR.muted,
          },
        ]
      : []),
  ];
};

/* ──────────────────────────── HUJJATLAR ──────────────────────────── */

/**
 * ⚠️ BO'LIM RAQAMLARI AVTOMAT: yangi bo'lim qo'shilganda qo'lda yozilgan
 * raqamlar surilib, hujjatda bitta raqam ikki marta chiqardi.
 */
const buildStudentAttendanceDocx = (report) => {
  const net = Boolean(report.isNetwork);
  let section = 0;
  const next = () => (section += 1);
  const t = report.totals;
  const p = report.previous;

  const blocks = [
    ...headerBlocks(report, {
      title: "O'QUVCHILAR DAVOMATI HISOBOTI",
      subtitle: "Kim keldi, kim qoldirdi va davomat qanday o'zgardi",
    }),
    ...studentSummaryBlocks(report, next()),
  ];

  if (net) blocks.push(...branchBlocks(report, next()));

  blocks.push(
    ...compareBlocks(report, next(), [
      comparePercentRow(report),
      compareRow("O'quv kunlari", t.schoolDays, p.schoolDays),
      compareRow("Kutilgan o'quvchi-kunlar", t.expected, p.expected),
      compareRow("Keldi", t.came, p.came, { bold: true, color: COLOR.good, trend: "good" }),
      compareRow("Kelmadi (sababsiz)", t.absent, p.absent, { color: COLOR.bad, trend: "bad" }),
      compareRow("Sababli", t.excused, p.excused, { color: COLOR.warn, trend: "bad" }),
    ]),
  );

  // Bitta bo'lakli davrda (bir kunlik hisobot) dinamika umumiy
  // ko'rsatkichlarni takrorlaydi.
  if (report.trend.length >= 2) blocks.push(...trendBlocks(report, next()));
  // Hafta kunlari faqat bir haftadan uzun davrda ma'noga ega.
  if (report.period.days >= 7 && report.weekday.length > 1) {
    blocks.push(...weekdayBlocks(report, next()));
  }
  if (report.classes.length) blocks.push(...classBlocks(report, next(), net));
  if (report.students.length) blocks.push(...studentListBlocks(report, next(), net));

  blocks.push(
    ...footerBlocks(report, [
      "Davomat foizi = (keldi + kech keldi) ÷ kutilgan o'quvchi-kunlar. " +
        "Kutilgan o'quvchi-kunlar dars jadvali va o'qish davridan hisoblanadi: " +
        "davri yopilgan o'quvchi kutilmaydi.",
      "Belgilanmagan o'quvchi KELMAGAN hisoblanadi — aks holda davomat " +
        "belgilanmagan kun 100% bo'lib ko'rinardi.",
      "O'quv kuni — maktab bo'ylab kamida bitta davomat yozuvi bor kun. " +
        "Yakshanba, bayram va ta'til kunlari hisobga kirmaydi.",
      "Arxivlangan o'quvchilar hisobotga kirmaydi.",
    ]),
  );

  return buildDocx({
    title: `O'quvchilar davomati — ${report.period.rangeLabel}`,
    author: net ? "Barcha filiallar" : report.branch?.name || "MBSI",
    blocks,
  });
};

const buildTeacherAttendanceDocx = (report) => {
  const net = Boolean(report.isNetwork);
  let section = 0;
  const next = () => (section += 1);
  const t = report.totals;
  const p = report.previous;

  const blocks = [
    ...headerBlocks(report, {
      title: "O'QITUVCHILAR DAVOMATI HISOBOTI",
      subtitle: "Kelish-ketish, kechikishlar va darsga chiqmaganlar",
    }),
    ...teacherSummaryBlocks(report, next()),
  ];

  if (net) blocks.push(...branchBlocks(report, next()));

  blocks.push(
    ...compareBlocks(report, next(), [
      comparePercentRow(report),
      compareRow("O'quv kunlari", t.schoolDays, p.schoolDays),
      compareRow("Kutilgan ish kunlari", t.expected, p.expected),
      compareRow("Keldi", t.came, p.came, { bold: true, color: COLOR.good, trend: "good" }),
      compareRow("Kech keldi", t.late, p.late, { color: COLOR.warn, trend: "bad" }),
      compareRow("Kelmadi (sababsiz)", t.absent, p.absent, { color: COLOR.bad, trend: "bad" }),
      compareRow("Sababli", t.excused, p.excused, { color: COLOR.warn, trend: "bad" }),
    ]),
  );

  if (report.trend.length >= 2) blocks.push(...trendBlocks(report, next()));
  if (report.period.days >= 7 && report.weekday.length > 1) {
    blocks.push(...weekdayBlocks(report, next()));
  }
  if (report.teachers.length) blocks.push(...teacherListBlocks(report, next(), net));

  blocks.push(
    ...liveBlocks(report, next(), net),
    ...footerBlocks(report, [
      "Davomat foizi = (keldi + kech keldi) ÷ kutilgan ish kunlari. " +
        "Kech kelgan ham KELGAN hisoblanadi, kechikish esa alohida ko'rsatiladi.",
      "Kutilgan ish kunlari — davomat yozuvi bor kunlar. Kun oxirida " +
        "belgilanmaganlar avtomatik \"kelmadi\" bo'lib yoziladi, shuning uchun " +
        "o'tgan kunlar to'liq; bugungi kun esa hali to'ldirilmoqda.",
      "«Ishda bo'lgan vaqt» faqat kelish VA ketish vaqti yozilgan kunlardan " +
        "hisoblanadi: «Men ketdim» bosilmagan kun o'rtachani tushirib " +
        "yubormasligi kerak.",
      "Hisobot faqat O'QITUVCHILARNI qamraydi (asosiy yoki qo'shimcha roli). " +
        "Arxivlangan xodimlar kirmaydi.",
      "\"Bugun darsga chiqmaganlar\" bo'limi hujjat shakllantirilgan paytdagi " +
        "holat: dars o'rinbosarga berilgan bo'lsa, o'rinbosar tekshiriladi.",
    ]),
  );

  return buildDocx({
    title: `O'qituvchilar davomati — ${report.period.rangeLabel}`,
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
 */
const sendAttendanceStatsDocx = async (res, report) => {
  const isStudents = report.kind === "students";
  const buffer = await (isStudents
    ? buildStudentAttendanceDocx(report)
    : buildTeacherAttendanceDocx(report));

  const scope = report.isNetwork ? " (barcha filiallar)" : "";
  const base = isStudents ? "O'quvchilar davomati" : "O'qituvchilar davomati";

  sendDocx(res, buffer, `${base}${scope} ${report.period.rangeLabel}`, {
    fallbackName: isStudents ? "oquvchilar-davomati" : "oqituvchilar-davomati",
  });
};

module.exports = {
  buildStudentAttendanceDocx,
  buildTeacherAttendanceDocx,
  sendAttendanceStatsDocx,
};
