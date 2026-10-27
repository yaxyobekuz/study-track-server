/**
 * ERP VA KUNDALIK.COM — WORD HUJJATI.
 *
 * ⚠️ RAQAMLARNI O'ZI HISOBLAMAYDI va hisobotni CHAQIRMAYDI ham — tayyor
 * obyektni qabul qiladi. Ekranda ko'rinadigan hisobot bilan bir xil
 * manba: ikkita quruvchi bo'lsa, mas'ul xodim ekranda bir raqamni,
 * faylda boshqasini ko'rardi (`studentMovementExport.service.js`
 * doktrinasi).
 *
 * ⚠️ BITTA FILIAL HAM, BUTUN TARMOQ HAM AYNI SHAKLDA keladi
 * (`studentSystemReport` / `studentSystemNetwork`), farqi faqat
 * `isNetwork` bayrog'ida: u filiallar kesimi bo'limini va jadvallardagi
 * "Filial" ustunini yoqadi.
 *
 * Bu fayl faqat SHAKL bilan shug'ullanadi: bo'limlar, jadvallar, yorliqlar.
 */

const { buildDocx, sendDocx } = require("./word.service");
const { formatDateTimeUz } = require("../helpers/date.helpers");
const { SYSTEMS, SYSTEM_LABELS } = require("./studentSystem.service");

/** Hujjat ranglari — ekrandagi bilan AYNI ma'noda (bor — yashil, yo'q — qizil). */
const COLOR = {
  muted: "6B7280",
  ink: "111827",
  yes: "047857",
  no: "B91C1C",
};

/** Foizi yo'q katak — bo'sh joy "hisoblanmadi" bo'lib o'qilmasin. */
const DASH = { text: "—", align: "right", color: COLOR.muted };

/** Foiz: "82,4%" / "—" (maxraj nol bo'lsa). Kasr — VERGUL bilan. */
const percent = (value) =>
  value == null ? "—" : `${Math.abs(value).toFixed(1).replace(".", ",")}%`;

/** Bo'sh matn o'rniga "—": hujjatda bo'sh katak "ma'lumot yo'q" bo'lib o'qilmasin. */
const text = (value) => {
  const trimmed = String(value ?? "").trim();
  return trimmed || "—";
};

/** "Bor" / "Yo'q" katagi — rangi bilan. */
const mark = (present) =>
  present
    ? { text: "Bor", color: COLOR.yes, align: "center" }
    : { text: "Yo'q", color: COLOR.no, align: "center", bold: true };

/** Sanoq katagi: nol — kulrang (hech narsa qolmagan joy ko'zga tashlanmasin). */
const count = (value, { tone = null, bold = false } = {}) => ({
  text: String(value ?? 0),
  align: "right",
  bold,
  color: value ? tone ?? COLOR.ink : COLOR.muted,
});

// ─────────────────────────────────────────────
// Bo'limlar
// ─────────────────────────────────────────────

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
    { type: "heading", level: 1, text: "ERP VA KUNDALIK.COM HISOBOTI" },
    {
      type: "paragraph",
      text: "O'quvchilar tashqi tizimlarga kiritilganmi",
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
 * UMUMIY KO'RSATKICHLAR.
 *
 * ⚠️ "Kiritilmagan" qatorlari ALOHIDA turadi va bu ataylab: "bor" raqami
 * bajarilgan ishni, "yo'q" esa QOLGAN ishni ko'rsatadi — hisobot aynan
 * ikkinchisi uchun ochiladi.
 */
const summaryBlocks = (report, index) => {
  const t = report.totals;

  const rows = [
    [
      { text: "Jami o'quvchilar", bold: true },
      count(t.students, { bold: true }),
      DASH,
    ],
    ...SYSTEMS.flatMap((system) => [
      [
        `${SYSTEM_LABELS[system]} da bor`,
        count(t.systems[system].yes, { tone: COLOR.yes, bold: true }),
        { text: percent(t.systems[system].percent), color: COLOR.yes, align: "right" },
      ],
      [
        `${SYSTEM_LABELS[system]} da yo'q`,
        count(t.systems[system].no, { tone: COLOR.no, bold: true }),
        {
          text: percent(
            t.systems[system].percent == null ? null : 100 - t.systems[system].percent,
          ),
          color: COLOR.no,
          align: "right",
        },
      ],
    ]),
    [
      { text: "Ikkala tizimda ham bor", bold: true },
      count(t.inBoth, { tone: COLOR.yes, bold: true }),
      { text: percent(t.inBothPercent), color: COLOR.yes, align: "right" },
    ],
    [
      { text: "Kamida bitta tizimga kiritilmagan", bold: true },
      count(t.missingAny, { tone: COLOR.no, bold: true }),
      { text: percent(t.missingAnyPercent), color: COLOR.no, align: "right" },
    ],
    [
      "   shundan ikkala tizimga ham kiritilmagan",
      count(t.missingBoth, { tone: COLOR.muted }),
      DASH,
    ],
  ];

  return [
    { type: "heading", level: 2, text: `${index}. Umumiy ko'rsatkichlar` },
    {
      type: "table",
      columns: [
        { label: "Ko'rsatkich", width: 6 },
        { label: "Soni", width: 2, align: "right" },
        { label: "Foiz", width: 2, align: "right" },
      ],
      rows,
    },
    {
      type: "paragraph",
      text:
        "Foiz jami o'quvchilar soniga nisbatan hisoblangan. Hisobotda faqat " +
        "JORIY (arxivlanmagan) o'quvchilar bor: arxivlangan o'quvchining " +
        "belgisi o'chirilmaydi, lekin u sanoqqa kirmaydi.",
      size: 17,
      color: COLOR.muted,
      after: 160,
    },
  ];
};

/**
 * FILIALLAR KESIMI — faqat umumiy ko'rinishda.
 *
 * ⚠️ "82 ta kiritilmagan" degan tarmoq raqamining hammasi bitta filialda
 * bo'lishi mumkin va ish aynan o'sha filialda bajariladi — shuning uchun
 * jadval har filialning o'z qatorini ham, tarmoq yig'indisini ham
 * ko'rsatadi.
 */
const branchBlocks = (report, index) => {
  const row = (label, item, bold) => [
    { text: label, bold },
    count(item.students, { bold }),
    ...SYSTEMS.flatMap((system) => [
      count(item.systems[system].yes, { tone: COLOR.yes, bold }),
      count(item.systems[system].no, { tone: COLOR.no, bold }),
    ]),
    count(item.missingAny, { tone: COLOR.no, bold: true }),
  ];

  const rows = report.byBranch.map((item) => row(item.branchName, item, false));
  rows.push(row("Jami (tarmoq)", report.totals, true));

  return [
    { type: "heading", level: 2, text: `${index}. Filiallar kesimi` },
    {
      type: "table",
      columns: [
        { label: "Filial", width: 5 },
        { label: "O'quvchi", width: 2, align: "right" },
        ...SYSTEMS.flatMap((system) => [
          { label: `${SYSTEM_LABELS[system]}: bor`, width: 2, align: "right" },
          { label: `${SYSTEM_LABELS[system]}: yo'q`, width: 2, align: "right" },
        ]),
        { label: "Kiritilmagan", width: 2, align: "right" },
      ],
      rows,
    },
    {
      type: "paragraph",
      text:
        "\"Kiritilmagan\" — kamida bitta tizimga kiritilmagan o'quvchilar. " +
        "Ro'yxat shu raqam bo'yicha kamayish tartibida: eng ko'p ish qolgan " +
        "filial yuqorida turadi.",
      size: 17,
      color: COLOR.muted,
      after: 160,
    },
  ];
};

/** SINFLAR KESIMI — "qaysi sinf qoldi". */
const classBlocks = (report, index) => {
  const net = report.isNetwork;

  const rows = report.byClass.map((item) => [
    { text: text(item.name) },
    ...(net ? [{ text: text(item.branchName) }] : []),
    count(item.students),
    ...SYSTEMS.flatMap((system) => [
      count(item.systems[system].yes, { tone: COLOR.yes }),
      count(item.systems[system].no, { tone: COLOR.no }),
    ]),
    { text: percent(item.inBothPercent), align: "right", color: COLOR.muted },
  ]);

  return [
    {
      type: "heading",
      level: 2,
      text: `${index}. Sinflar kesimi`,
      pageBreakBefore: true,
    },
    {
      type: "table",
      columns: [
        { label: "Sinf", width: net ? 3 : 4 },
        ...(net ? [{ label: "Filial", width: 3 }] : []),
        { label: "O'quvchi", width: 2, align: "right" },
        ...SYSTEMS.flatMap((system) => [
          { label: `${SYSTEM_LABELS[system]}: bor`, width: 2, align: "right" },
          { label: `${SYSTEM_LABELS[system]}: yo'q`, width: 2, align: "right" },
        ]),
        { label: "To'liq", width: 2, align: "right" },
      ],
      rows,
    },
    {
      type: "paragraph",
      text:
        "\"To'liq\" — sinfning qancha qismi IKKALA tizimga ham kiritilgan. " +
        "⚠️ Ikki sinfda o'qiydigan o'quvchi HAR IKKI qatorda sanaladi, " +
        "\"Jami\" da esa bir marta — shuning uchun sinflar yig'indisi umumiy " +
        "sondan katta bo'lishi mumkin.",
      size: 17,
      color: COLOR.muted,
      after: 160,
    },
  ];
};

/**
 * KIMLAR KIRITILMAGAN — har tizim uchun alohida ro'yxat.
 *
 * ⚠️ IKKI ALOHIDA RO'YXAT va bu ataylab takror: ERP ro'yxati ERP ga
 * kirituvchi xodimga, Kundalik ro'yxati esa boshqasiga beriladi. Bitta
 * jadvalda ikkala ustun bilan berilsa, har bir xodim o'ziga keraklisini
 * qo'lda ajratib olardi.
 *
 * Qolgan tizim(lar) holati yonida turadi: "bu bolani ikkalasiga ham
 * kiritish kerakmi" degan savol ro'yxatning o'zida javob topsin.
 */
const missingBlocks = (report, system, index) => {
  const items = report.missing[system] ?? [];
  const label = SYSTEM_LABELS[system];
  const others = SYSTEMS.filter((key) => key !== system);
  const net = report.isNetwork;

  if (items.length === 0) {
    return [
      {
        type: "heading",
        level: 2,
        text: `${index}. ${label} ga kiritilmagan o'quvchilar`,
        pageBreakBefore: true,
      },
      {
        type: "paragraph",
        text: `Hamma o'quvchi ${label} ga kiritilgan.`,
        color: COLOR.muted,
        after: 160,
      },
    ];
  }

  const rows = items.map((item, i) => [
    { text: String(i + 1), align: "center" },
    { text: item.name, bold: true },
    ...(net ? [{ text: text(item.branchName) }] : []),
    { text: text(item.className) },
    ...others.map((key) => mark(item[key])),
  ]);

  return [
    // ⚠️ RO'YXAT YANGI SAHIFADAN: u uzun bo'lishi mumkin va jadval
    // sarlavhasidan ajralib qolsa, hujjat varaqlaganda o'qilmas bo'lardi.
    {
      type: "heading",
      level: 2,
      text: `${index}. ${label} ga kiritilmagan o'quvchilar (${items.length} ta)`,
      pageBreakBefore: true,
    },
    {
      type: "table",
      columns: [
        { label: "№", width: 1, align: "center" },
        { label: "F.I.Sh.", width: net ? 6 : 7 },
        ...(net ? [{ label: "Filial", width: 3 }] : []),
        { label: "Sinf", width: net ? 3 : 4 },
        ...others.map((key) => ({
          label: SYSTEM_LABELS[key],
          width: 2,
          align: "center",
        })),
      ],
      rows,
    },
  ];
};

/** IZOH — belgi nimani anglatadi va ma'lumot qayerdan keladi. */
const contextBlocks = (report) => {
  const lines = [
    "Belgi qo'lda qo'yiladi: mas'ul xodim o'quvchini tashqi tizimga " +
      "kiritgandan keyin platformada \"bor\" deb belgilaydi. Belgi yo'q " +
      "bo'lsa, o'quvchi \"yo'q\" lar ro'yxatida turadi.",
  ];

  if (report.partial?.length) {
    lines.push(
      "⚠️ Quyidagi filial(lar) ma'lumoti olinmadi va hisobotga KIRMAGAN: " +
        `${report.partial.join(", ")}.`,
    );
  }

  return [
    { type: "heading", level: 3, text: "Hisobot haqida" },
    {
      type: "paragraph",
      text: lines.join("\n"),
      size: 18,
      color: COLOR.muted,
      after: 40,
    },
    {
      type: "paragraph",
      text:
        "Ma'lumot manbai — platformadagi \"ERP va Kundalik.com\" bo'limi. " +
        "Hujjat avtomatik shakllantirilgan.",
      size: 17,
      color: COLOR.muted,
    },
  ];
};

// ─────────────────────────────────────────────
// Ommaviy yo'l
// ─────────────────────────────────────────────

/**
 * Hisobotdan Word hujjatini quradi.
 *
 * ⚠️ BO'LIM RAQAMLARI AVTOMAT (`next()`): bo'limlar shartli
 * (filiallar kesimi faqat umumiy ko'rinishda), qo'lda raqamlansa
 * birinchi o'zgarishda hujjatda ikkita "3" paydo bo'lardi.
 *
 * @param {object} report - `getSystemsReport` yoki
 *   `getNetworkSystemsReport` natijasi (ikkalasi AYNI shaklda)
 * @returns {Promise<Buffer>}
 */
const buildSystemsDocx = (report) => {
  let section = 0;
  const next = () => (section += 1);

  const blocks = [...headerBlocks(report), ...summaryBlocks(report, next())];

  // Faqat umumiy ko'rinishda: bitta filialda bu jadval o'zini takrorlardi.
  if (report.isNetwork) blocks.push(...branchBlocks(report, next()));

  blocks.push(...classBlocks(report, next()));

  for (const system of SYSTEMS) {
    blocks.push(...missingBlocks(report, system, next()));
  }

  blocks.push({ type: "spacer" }, ...contextBlocks(report));

  return buildDocx({
    title: "ERP va Kundalik.com hisoboti",
    author: report.isNetwork ? "Barcha filiallar" : report.branch?.name || "MBSI",
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
const sendSystemsDocx = async (res, report) => {
  const buffer = await buildSystemsDocx(report);

  const scope = report.isNetwork ? " (barcha filiallar)" : "";

  sendDocx(res, buffer, `ERP va Kundalik.com${scope}`, {
    fallbackName: "erp-kundalik",
  });
};

module.exports = { buildSystemsDocx, sendSystemsDocx };
