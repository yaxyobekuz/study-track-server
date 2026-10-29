/**
 * BOT FOYDALANUVCHILARI — WORD HUJJATI.
 *
 * ⚠️ RAQAMLARNI O'ZI HISOBLAMAYDI va hisobotni CHAQIRMAYDI ham — tayyor
 * obyektni qabul qiladi. Ekranda ko'rinadigan hujjat bilan bir xil
 * manba: ikkita quruvchi bo'lsa, rahbar ekranda bir foizni, faylda
 * boshqasini ko'rardi (`attendanceStatsExport.service.js` bilan AYNI
 * doktrina).
 *
 * Bu fayl faqat SHAKL bilan shug'ullanadi: bo'limlar, jadvallar, yorliqlar.
 */

const { buildDocx, sendDocx } = require("./word.service");
const { formatDateTimeUz } = require("../helpers/date.helpers");

const COLOR = {
  muted: "6B7280",
  ink: "111827",
  good: "047857",
  bad: "B91C1C",
  warn: "B45309",
};

/** Qiymati yo'q katak — bo'sh joy "hisoblanmadi" bo'lib o'qilmasin. */
const DASH = { text: "—", align: "right", color: COLOR.muted };

/**
 * MINGLIK AJRATGICH — "1 250".
 *
 * ⚠️ `Intl` / `toLocaleString` ISHLATILMAYDI: ajratgich Node ICU
 * qurilishiga va brauzer locale'iga bog'liq bo'lib qoladi — serverda
 * "1 250", ekranda esa "1,250" chiqardi va bitta hujjatning ikki nusxasi
 * boshqacha ko'rinardi (`dates.md` §3 bilan AYNI sabab).
 *
 * ⚠️ Ajratgich — UZILMAS BO'SHLIQ (U+00A0): oddiy bo'shliq tor ustunda
 * raqamni ikki qatorga bo'lib yuborardi.
 */
const grouped = (value) =>
  String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/** Foiz: "94,3%" / "—". Kasr — VERGUL bilan (o'zbekcha yozuv). */
const percent = (value) =>
  value == null ? "—" : `${Math.abs(value).toFixed(1).replace(".", ",")}%`;

const text = (value) => {
  const trimmed = String(value ?? "").trim();
  return trimmed || "—";
};

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

/* ───────────────────────────── BO'LIMLAR ───────────────────────────── */

const headerBlocks = (report) => {
  // ⚠️ Umumiy ko'rinishda sarlavhada FILIAL NOMI TURMAYDI: hujjat butun
  // tarmoqniki va bitta filial nomi bilan sarlavhalansa, u o'sha
  // filialning hisoboti deb o'qilardi.
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
    { type: "heading", level: 1, text: "BOT FOYDALANUVCHILARI HISOBOTI" },
    {
      type: "paragraph",
      text: "Ota-onalar botga qanchalik ulangan va uni qanchalik ishlatmoqda",
      align: "center",
      size: 22,
      color: COLOR.ink,
      after: 0,
    },
    {
      type: "paragraph",
      text: `Faollik davri: ${report.period.days} kun (${report.period.rangeLabel})`,
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
 * UMUMIY KO'RSATKICHLAR.
 *
 * ⚠️ IKKI MAXRAJ ARALASHMAYDI: qamrov O'QUVCHILARGA nisbatan
 * (nechta bolaning ota-onasi ulangan), faollik esa BOG'LANGAN
 * HISOBLARGA nisbatan (ulanganlarning qanchasi ishlatadi). Bitta
 * maxrajga keltirilsa, ulanmagan ota-ona "foydalanmadi" bo'lib
 * sanalardi — holbuki u botdan umuman xabardor emas.
 */
const summaryBlocks = (report, index) => {
  const t = report.totals;

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
          { text: "O'qiyotgan o'quvchilar", bold: true },
          num(t.students, { bold: true }),
          DASH,
        ],
        [
          { text: "Qamrab olingan o'quvchilar", bold: true },
          num(t.linkedStudents, { bold: true, color: COLOR.good }),
          pct(t.coverage, { bold: true, color: COLOR.good }),
        ],
        [
          "Qamrab olinmaganlar",
          num(t.unlinked, { color: COLOR.bad }),
          pct(t.coverage == null ? null : 100 - t.coverage, { color: COLOR.bad }),
        ],
        [
          { text: "Bog'langan hisoblar", bold: true },
          num(t.linked, { bold: true }),
          DASH,
        ],
        [
          `Bugun faol (${text(report.todayLabel)})`,
          num(t.todayActive),
          pct(t.todayRate),
        ],
        [
          `Davr ichida faol (${report.period.days} kun)`,
          num(t.activeInPeriod, { color: COLOR.good }),
          pct(t.activeRate, { color: COLOR.good }),
        ],
        ["Jim turganlar", num(t.silent, { color: COLOR.warn }), DASH],
        [
          "Bildirishnoma o'chirganlar",
          num(t.notificationsOff, { color: COLOR.warn }),
          DASH,
        ],
        ["Davrda yangi bog'lanish", num(t.newLinks, { color: COLOR.good }), DASH],
      ],
    },
  ];
};

const branchBlocks = (report, index) => [
  { type: "heading", level: 2, text: `${index}. Filiallar kesimi` },
  {
    type: "paragraph",
    text:
      "Foiz har filialning O'Z yig'indisidan hisoblangan, filiallar " +
      "o'rtachasi EMAS. Qator qamrov foizi bo'yicha o'sish tartibida.",
    size: 18,
    color: COLOR.muted,
  },
  {
    type: "table",
    columns: [
      { label: "Filial", width: 4 },
      { label: "O'quvchi", width: 2, align: "right" },
      { label: "Qamralgan", width: 2, align: "right" },
      { label: "Qamrov", width: 2, align: "right" },
      { label: "Hisoblar", width: 2, align: "right" },
      { label: "Bugun faol", width: 2, align: "right" },
    ],
    rows: report.byBranch.map((row) => [
      { text: text(row.branchName), bold: true },
      num(row.students),
      num(row.linkedStudents, { color: COLOR.good }),
      pct(row.coverage, { bold: true }),
      num(row.linked),
      num(row.todayActive),
    ]),
  },
];

const trendBlocks = (report, index) => [
  { type: "heading", level: 2, text: `${index}. Faollik dinamikasi` },
  {
    type: "paragraph",
    text: "Har bo'lakda botni ochgan noyob ota-onalar soni.",
    size: 18,
    color: COLOR.muted,
  },
  {
    type: "table",
    columns: [
      { label: "Davr", width: 6 },
      { label: "Faol ota-onalar", width: 3, align: "right" },
    ],
    rows: report.trend.map((row) => [text(row.label), num(row.bot)]),
  },
];

const classBlocks = (report, index, net) => [
  { type: "heading", level: 2, text: `${index}. Sinflar kesimi`, pageBreakBefore: true },
  {
    type: "paragraph",
    text:
      "Foydalanish foizi bo'yicha o'sish tartibida. QAMROV — nechta " +
      "o'quvchining ota-onasi ulangan; FOYDALANISH — ulanganlarning " +
      "qanchasi davr ichida botni ochgan.",
    size: 18,
    color: COLOR.muted,
  },
  {
    type: "table",
    columns: [
      { label: "№", width: 1, align: "center" },
      { label: "Sinf", width: 3 },
      ...(net ? [{ label: "Filial", width: 2 }] : []),
      { label: "O'quvchi", width: 2, align: "right" },
      { label: "Qamralgan", width: 2, align: "right" },
      { label: "Qamrov", width: 2, align: "right" },
      { label: "Faol", width: 2, align: "right" },
      { label: "Foydalanish", width: 2, align: "right" },
    ],
    rows: report.classes.map((row, i) => [
      { text: String(i + 1), align: "center", color: COLOR.muted },
      { text: text(row.name), bold: true },
      ...(net ? [text(row.branchName)] : []),
      num(row.students),
      num(row.linkedStudents, { color: COLOR.good }),
      pct(row.linkRate),
      num(row.active),
      pct(row.rate, { bold: true }),
    ]),
  },
];

const unlinkedBlocks = (report, index, net) => [
  {
    type: "heading",
    level: 2,
    text: `${index}. Botga ulanmagan o'quvchilar`,
    pageBreakBefore: true,
  },
  {
    type: "paragraph",
    text:
      `Jami ${grouped(report.unlinkedTotal)} ta` +
      (report.unlinkedTotal > report.unlinkedStudents.length
        ? `, ro'yxatda birinchi ${grouped(report.unlinkedStudents.length)} tasi.`
        : "."),
    size: 18,
    color: COLOR.muted,
  },
  {
    type: "table",
    columns: [
      { label: "№", width: 1, align: "center" },
      { label: "O'quvchi", width: 5 },
      ...(net ? [{ label: "Filial", width: 3 }] : []),
      { label: "Sinf", width: 3 },
    ],
    rows: report.unlinkedStudents.map((row, i) => [
      { text: String(i + 1), align: "center", color: COLOR.muted },
      { text: text(row.name), bold: true },
      ...(net ? [text(row.branchName)] : []),
      text(row.className),
    ]),
  },
];

const silentBlocks = (report, index, net) => [
  {
    type: "heading",
    level: 2,
    text: `${index}. Ulangan, lekin ishlatmayotganlar`,
    pageBreakBefore: true,
  },
  {
    type: "paragraph",
    text:
      `Davr ichida botni birorta ham ochmagan ota-onalar. Jami ` +
      `${grouped(report.silentTotal)} ta` +
      (report.silentTotal > report.silentParents.length
        ? `, ro'yxatda birinchi ${grouped(report.silentParents.length)} tasi.`
        : "."),
    size: 18,
    color: COLOR.muted,
  },
  {
    type: "table",
    columns: [
      { label: "№", width: 1, align: "center" },
      { label: "O'quvchi", width: 4 },
      ...(net ? [{ label: "Filial", width: 3 }] : []),
      { label: "Oxirgi marta", width: 4 },
    ],
    rows: report.silentParents.map((row, i) => [
      { text: String(i + 1), align: "center", color: COLOR.muted },
      { text: text(row.studentName), bold: true },
      ...(net ? [text(row.branchName)] : []),
      row.lastSeenLabel
        ? `${row.lastSeenLabel}${row.daysSince != null ? ` (${grouped(row.daysSince)} kun oldin)` : ""}`
        : { text: "Hech qachon kirmagan", color: COLOR.bad },
    ]),
  },
];

const deliveryBlocks = (report, index) => {
  const d = report.delivery;

  return [
    { type: "heading", level: 2, text: `${index}. Xabar yetkazish` },
    {
      type: "table",
      columns: [
        { label: "Ko'rsatkich", width: 6 },
        { label: "Soni", width: 2, align: "right" },
        { label: "Ulushi", width: 2, align: "right" },
      ],
      rows: [
        [
          { text: "Ommaviy xabarlar — jami", bold: true },
          num(d.broadcast.total, { bold: true }),
          DASH,
        ],
        ["Yetkazildi", num(d.broadcast.sent, { color: COLOR.good }), pct(d.broadcast.rate)],
        ["Yetkazilmadi", num(d.broadcast.failed, { color: COLOR.bad }), DASH],
        ["Navbatda", num(d.broadcast.pending), DASH],
        [
          { text: "Kunlik baho hisoboti — yetkazildi", bold: true },
          num(d.reports.sent, { bold: true, color: COLOR.good }),
          pct(d.reports.rate),
        ],
        ["Yetkazilmadi", num(d.reports.failed, { color: COLOR.bad }), DASH],
      ],
    },
  ];
};

const footerBlocks = (report) => [
  { type: "heading", level: 3, text: "Hisobot haqida" },
  ...[
    "QAMROV — o'qiyotgan o'quvchilarning qanchasida kamida bitta ota-ona botga ulangan. Maktabdan ketgan o'quvchi maxrajga kirmaydi.",
    "FOYDALANISH — bog'langan hisoblarning qanchasi davr ichida botni ochgan. Ulanmagan ota-ona bu foizga KIRMAYDI: u botdan umuman xabardor emas.",
    "Bir o'quvchiga ikkita hisob ulangan bo'lishi mumkin (ona va ota), shuning uchun «bog'langan hisoblar» «qamrab olingan o'quvchilar» dan ko'p bo'lishi mumkin.",
    ...(report.isNetwork
      ? [
          "Umumiy ko'rinishda sonlar qo'shilgan, foiz esa yig'indidan qayta hisoblangan — filiallar o'rtachasi EMAS.",
        ]
      : []),
    ...(report.withRoster
      ? []
      : [
          "Ism ro'yxatlari (ulanmaganlar va jim turganlar) bu hisobotda yo'q: ular alohida ruxsat ortida (Faollik → ro'yxat).",
        ]),
    ...(report.collecting
      ? [
          `Faollik tarixi hali to'liq yig'ilmagan${report.sinceLabel ? ` — ${report.sinceLabel} dan boshlab yozilmoqda` : ""}. Nol raqam "hech kim ishlatmayapti" degani emas.`,
        ]
      : []),
  ].map((line) => ({ type: "paragraph", text: line, size: 18, color: COLOR.muted })),
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

/* ──────────────────────────── HUJJAT ──────────────────────────── */

/**
 * ⚠️ BO'LIM RAQAMLARI AVTOMAT: yangi bo'lim qo'shilganda qo'lda yozilgan
 * raqamlar surilib, hujjatda bitta raqam ikki marta chiqardi.
 */
const buildBotReportDocx = (report) => {
  const net = Boolean(report.isNetwork);
  let section = 0;
  const next = () => (section += 1);

  const blocks = [...headerBlocks(report), ...summaryBlocks(report, next())];

  // Faqat umumiy ko'rinishda: bitta filialda bu jadval o'zini takrorlardi.
  if (net) blocks.push(...branchBlocks(report, next()));

  if (report.trend.length >= 2) blocks.push(...trendBlocks(report, next()));
  if (report.classes.length) blocks.push(...classBlocks(report, next(), net));
  if (report.unlinkedStudents.length) {
    blocks.push(...unlinkedBlocks(report, next(), net));
  }
  if (report.silentParents.length) blocks.push(...silentBlocks(report, next(), net));

  blocks.push(...deliveryBlocks(report, next()), ...footerBlocks(report));

  return buildDocx({
    title: `Bot foydalanuvchilari — ${report.period.rangeLabel}`,
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
const sendBotReportDocx = async (res, report) => {
  const buffer = await buildBotReportDocx(report);
  const scope = report.isNetwork ? " (barcha filiallar)" : "";

  sendDocx(res, buffer, `Bot foydalanuvchilari${scope} ${report.period.rangeLabel}`, {
    fallbackName: "bot-foydalanuvchilari",
  });
};

module.exports = { buildBotReportDocx, sendBotReportDocx };
