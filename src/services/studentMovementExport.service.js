/**
 * O'QUVCHILAR HARAKATI — WORD HUJJATI.
 *
 * ⚠️ RAQAMLARNI O'ZI HISOBLAMAYDI va hisobotni CHAQIRMAYDI ham — tayyor
 * obyektni qabul qiladi. Ekranda ko'rinadigan hisobot bilan bir xil manba:
 * ikkita quruvchi bo'lsa, rahbar ekranda bir foizni, faylda boshqasini
 * ko'rardi va hisobotning butun mohiyati (ishonch) yo'qolardi
 * (`invoiceBuilder.service.js` doktrinasi).
 *
 * ⚠️ BITTA FILIAL HAM, BUTUN TARMOQ HAM AYNI SHAKLDA keladi
 * (`studentMovement.service.js` / `studentMovementNetwork.service.js`),
 * farqi faqat `isNetwork` bayrog'ida: u filiallar kesimi bo'limini va
 * ro'yxatlardagi "Filial" ustunini yoqadi.
 *
 * Bu fayl faqat SHAKL bilan shug'ullanadi: bo'limlar, jadvallar, yorliqlar.
 */

const { buildDocx, sendDocx } = require("./word.service");
const { formatDateUz, formatDateTimeUz } = require("../helpers/date.helpers");

/** Hujjat ranglari — ekrandagi bilan AYNI ma'noda (o'sish yashil, tushish qizil). */
const COLOR = {
  muted: "6B7280",
  ink: "111827",
  up: "047857",
  down: "B91C1C",
  head: "F3F4F6",
  zebra: "FAFAFA",
};

/**
 * ⚠️ MINUS BELGISI — U+2212 (`−`), defis EMAS: hisobotda "−8" defis bilan
 * yozilsa, u qator boshida tire bo'lib ko'rinadi va Word uni ro'yxat
 * belgisiga aylantirib yuborishi mumkin.
 */
const MINUS = "−";

/** Foizi yo'q katak — bo'sh joy "hisoblanmadi" bo'lib o'qilmasin. */
const DASH = { text: "—", align: "right", color: COLOR.muted };

const signed = (value) => {
  const number = Number(value) || 0;
  if (number > 0) return `+${number}`;
  if (number < 0) return `${MINUS}${Math.abs(number)}`;
  return "0";
};

/** Foiz: "+2,7%" / "−1,8%" / "—" (maxraj nol bo'lsa). Kasr — VERGUL bilan. */
const percent = (value, { withSign = true } = {}) => {
  if (value == null) return "—";
  const abs = Math.abs(value).toFixed(1).replace(".", ",");
  if (!withSign) return `${abs}%`;
  if (value > 0) return `+${abs}%`;
  if (value < 0) return `${MINUS}${abs}%`;
  return `0,0%`;
};

const toneOf = (value) =>
  value > 0 ? COLOR.up : value < 0 ? COLOR.down : COLOR.muted;

const day = (value) => formatDateUz(value, { utc: true });

/** Bo'sh matn o'rniga "—": hujjatda bo'sh katak "ma'lumot yo'q" bo'lib o'qilmasin. */
const text = (value) => {
  const trimmed = String(value ?? "").trim();
  return trimmed || "—";
};

// ─────────────────────────────────────────────
// Bo'limlar
// ─────────────────────────────────────────────

const headerBlocks = (report) => {
  // ⚠️ Umumiy ko'rinishda sarlavhada FILIAL NOMI TURMAYDI: hujjat butun
  // tarmoqniki va bitta filial nomi bilan sarlavhalansa, u o'sha filialning
  // hisoboti deb o'qilardi. O'rniga qamrov ochiq yoziladi va filiallar
  // ro'yxati sarlavha ostida sanab o'tiladi.
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
    { type: "heading", level: 1, text: "O'QUVCHILAR HARAKATI HISOBOTI" },
    {
      type: "paragraph",
      text: `Davr: ${report.range.label}`,
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
 * UMUMIY KO'RSATKICHLAR — "davr boshida shuncha edi, shuncha keldi, shuncha ketdi,
 * davr oxirida shuncha bo'ldi". Jadvalning o'zi arifmetikani ko'rsatadi:
 * rahbar qo'shib-ayirib tekshira oladi (`studentMovement.service.js`
 * dagi chegara ta'rifi).
 */
const summaryBlocks = (report, index) => {
  const t = report.totals;
  const hasMoves = t.movedIn > 0 || t.movedOut > 0;

  const rows = [
    [
      "Davr boshida o'qiyotganlar",
      { text: String(t.openCount), bold: true, align: "right" },
      DASH,
    ],
    [
      "Yangi kelganlar",
      { text: signed(t.joined), color: COLOR.up, bold: true, align: "right" },
      { text: percent(t.joinedPercent), color: COLOR.up, align: "right" },
    ],
    [
      "   shundan birinchi marta kelgan",
      { text: String(t.joinedNew), color: COLOR.muted, align: "right" },
      DASH,
    ],
    [
      "   shundan qaytib kelgan",
      { text: String(t.joinedReturned), color: COLOR.muted, align: "right" },
      DASH,
    ],
    [
      "Chiqib ketganlar",
      { text: `${MINUS}${t.left}`, color: COLOR.down, bold: true, align: "right" },
      { text: percent(t.leftPercent == null ? null : -t.leftPercent), color: COLOR.down, align: "right" },
    ],
    [
      { text: "O'zgarish (o'sish / tushish)", bold: true },
      { text: signed(t.net), bold: true, color: toneOf(t.net), align: "right" },
      { text: percent(t.growthPercent), bold: true, color: toneOf(t.net), align: "right" },
    ],
    // ⚠️ KO'CHISH YUQORIDAGI UCH QATORGA KIRMAYDI, lekin davr oxiridagi
    // songa ta'sir qiladi — shuning uchun u "o'zgarish" bilan "davr
    // oxirida" ORASIDA turadi: jadval yuqoridan pastga o'qilganda
    // arifmetika ko'rinib boradi.
    ...(hasMoves
      ? [
          [
            "Boshqa filialdan ko'chib kelgan",
            { text: signed(t.movedIn), color: COLOR.muted, align: "right" },
            DASH,
          ],
          [
            "Boshqa filialga ko'chib ketgan",
            {
              text: t.movedOut ? `${MINUS}${t.movedOut}` : "0",
              color: COLOR.muted,
              align: "right",
            },
            DASH,
          ],
        ]
      : []),
    [
      "Davr oxirida o'qiyotganlar",
      { text: String(t.closeCount), bold: true, align: "right" },
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
        "Foiz davr boshidagi o'quvchilar soniga nisbatan hisoblangan: " +
        `(${t.joined} − ${t.left}) ÷ ${t.openCount || 0}.`,
      size: 17,
      color: COLOR.muted,
      after: hasMoves ? 40 : 160,
    },
    // ⚠️ IZOH MAJBURIY: "keldi 5, ketdi 2, lekin oxirida 20 ta ko'paydi"
    // degan jadval izohsiz hisob xatosi bo'lib o'qilardi.
    ...(hasMoves
      ? [
          {
            type: "paragraph",
            text:
              "Filiallararo ko'chish \"kelgan\" va \"ketgan\" soniga " +
              "KIRMAYDI: o'quvchi maktabni tashlab ketmagan, faqat boshqa " +
              "filialga o'tgan. Shuning uchun davr oxiridagi son = davr " +
              "boshi + kelgan − ketgan + ko'chib kelgan − ko'chib ketgan.",
            size: 17,
            color: COLOR.muted,
            after: 160,
          },
        ]
      : []),
  ];
};

/**
 * OYMA-OY. Bitta oylik hisobotda bu bo'lim UMUMAN chiqmaydi (chaqiruvchi
 * hal qiladi): bitta qatorli jadval umumiy ko'rsatkichlarni takrorlagan
 * bo'lardi.
 */
const monthlyBlocks = (report, index) => {

  // ⚠️ KO'CHISH USTUNI faqat haqiqatan ko'chish bo'lgan hisobotda
  // chiziladi: doimiy "0" ustuni jadvalni toraytirib, hech narsa
  // aytmasdi.
  const hasMoves = report.byMonth.some((item) => item.movedIn || item.movedOut);

  const rows = report.byMonth.map((item) => [
    { text: item.isCurrent ? `${item.label} (davom etmoqda)` : item.label },
    { text: String(item.openCount), align: "right" },
    { text: signed(item.joined), color: item.joined ? COLOR.up : COLOR.muted, align: "right" },
    {
      text: item.left ? `${MINUS}${item.left}` : "0",
      color: item.left ? COLOR.down : COLOR.muted,
      align: "right",
    },
    { text: signed(item.net), bold: true, color: toneOf(item.net), align: "right" },
    { text: percent(item.growthPercent), color: toneOf(item.net), align: "right" },
    ...(hasMoves
      ? [{ text: signed(item.moveNet), color: COLOR.muted, align: "right" }]
      : []),
    { text: String(item.closeCount), bold: true, align: "right" },
  ]);

  return [
    { type: "heading", level: 2, text: `${index}. Oylar kesimi` },
    {
      type: "table",
      columns: [
        { label: "Oy", width: 5 },
        { label: "Oy boshida", width: 2, align: "right" },
        { label: "Keldi", width: 2, align: "right" },
        { label: "Ketdi", width: 2, align: "right" },
        { label: "Farq", width: 2, align: "right" },
        { label: "Foiz", width: 2, align: "right" },
        ...(hasMoves ? [{ label: "Ko'chish", width: 2, align: "right" }] : []),
        { label: "Oy oxirida", width: 2, align: "right" },
      ],
      rows,
    },
  ];
};

/**
 * FILIALLAR KESIMI — faqat umumiy ko'rinishda.
 *
 * ⚠️ Tarmoq jamisi savolning faqat YARMIGA javob beradi: "+10" ning
 * orqasida bitta filial +40, boshqasi −30 bo'lishi mumkin va qaror aynan
 * shu farqqa qarab qabul qilinadi. Shuning uchun jadval har filialning o'z
 * qatorini ham, tarmoq yig'indisini ham ko'rsatadi.
 */
const branchBlocks = (report, index) => {
  // ⚠️ FILIAL KESIMIDA KO'CHISH ENG MUHIM USTUN: tarmoq jamisida u
  // o'zini yo'qotadi (biridan chiqib, boshqasiga kiradi), filial
  // darajasida esa aynan u "nega bu filial o'sdi" degan savolga javob
  // beradi.
  const hasMoves = report.byBranch.some((item) => item.movedIn || item.movedOut);

  const row = (label, item, bold) => [
    { text: label, bold },
    { text: String(item.openCount), bold, align: "right" },
    {
      text: signed(item.joined),
      bold,
      color: item.joined ? COLOR.up : COLOR.muted,
      align: "right",
    },
    {
      text: item.left ? `${MINUS}${item.left}` : "0",
      bold,
      color: item.left ? COLOR.down : COLOR.muted,
      align: "right",
    },
    { text: signed(item.net), bold: true, color: toneOf(item.net), align: "right" },
    { text: percent(item.growthPercent), bold, color: toneOf(item.net), align: "right" },
    ...(hasMoves
      ? [{ text: signed(item.moveNet), bold, color: COLOR.muted, align: "right" }]
      : []),
    { text: String(item.closeCount), bold: true, align: "right" },
  ];

  const rows = report.byBranch.map((item) => row(item.branchName, item, false));
  rows.push(row("Jami (tarmoq)", report.totals, true));

  return [
    { type: "heading", level: 2, text: `${index}. Filiallar kesimi` },
    {
      type: "table",
      columns: [
        { label: "Filial", width: 5 },
        { label: "Davr boshida", width: 2, align: "right" },
        { label: "Keldi", width: 2, align: "right" },
        { label: "Ketdi", width: 2, align: "right" },
        { label: "Farq", width: 2, align: "right" },
        { label: "Foiz", width: 2, align: "right" },
        ...(hasMoves ? [{ label: "Ko'chish", width: 2, align: "right" }] : []),
        { label: "Davr oxirida", width: 2, align: "right" },
      ],
      rows,
    },
    {
      // ⚠️ IZOH MAJBURIY: "Jami" qatoridagi foiz ustunlardagi foizlarning
      // o'rtachasi EMAS va buni yozib qo'ymasa, hujjatni o'qigan odam uni
      // hisob xatosi deb o'ylardi.
      type: "paragraph",
      text:
        "Har filialning foizi O'Z davr boshidagi soniga nisbatan hisoblangan. " +
        "Tarmoq foizi esa filiallar foizining o'rtachasi EMAS — u yig'indidan " +
        "qayta hisoblangan, ya'ni katta filial natijaga ko'proq ta'sir qiladi.",
      size: 17,
      color: COLOR.muted,
      after: 160,
    },
  ];
};

/** NEGA KETISHDI — sabab toifalari kesimi. */
const reasonBlocks = (report, index) => {
  const total = report.totals.left;

  const rows = report.byReason.map((item) => [
    item.label,
    { text: String(item.count), bold: true, align: "right" },
    { text: item.percent == null ? "—" : percent(item.percent, { withSign: false }), align: "right" },
  ]);

  rows.push([
    { text: "Jami", bold: true },
    { text: String(total), bold: true, align: "right" },
    { text: total ? "100,0%" : "—", bold: true, align: "right" },
  ]);

  return [
    { type: "heading", level: 2, text: `${index}. Chiqib ketish sabablari` },
    {
      type: "table",
      columns: [
        { label: "Sabab", width: 6 },
        { label: "Soni", width: 2, align: "right" },
        { label: "Ulushi", width: 2, align: "right" },
      ],
      rows,
    },
  ];
};

/** KIMLAR KELDI. */
const joinedBlocks = (report, index) => {
  const items = report.joinedStudents;

  if (items.length === 0) {
    return [
      {
        type: "heading",
        level: 2,
        text: `${index}. Yangi kelgan o'quvchilar`,
        pageBreakBefore: true,
      },
      {
        type: "paragraph",
        text: "Bu davrda yangi o'quvchi qabul qilinmagan.",
        color: COLOR.muted,
        after: 160,
      },
    ];
  }

  // ⚠️ UMUMIY KO'RINISHDA FILIAL USTUNI QO'SHILADI: tarmoq ro'yxatida
  // "kim keldi" degan savolning javobi "qayerga keldi" bilan birga
  // bo'lmasa, ism sinf nomi bilan yolg'iz qolib, qaysi filialniki ekani
  // yo'qolardi.
  const net = report.isNetwork;

  const rows = items.map((item, i) => [
    { text: String(i + 1), align: "center" },
    { text: item.name, bold: true },
    ...(net ? [{ text: text(item.branchName) }] : []),
    { text: text(item.className) },
    { text: day(item.date), align: "center" },
    { text: item.kindLabel, color: item.kind === "new" ? COLOR.up : COLOR.muted, align: "center" },
  ]);

  return [
    // ⚠️ RO'YXAT YANGI SAHIFADAN: u uzun bo'lishi mumkin va jadval
    // sarlavhasidan ajralib qolsa, hujjat varaqlaganda o'qilmas bo'lardi.
    {
      type: "heading",
      level: 2,
      text: `${index}. Yangi kelgan o'quvchilar (${items.length} ta)`,
      pageBreakBefore: true,
    },
    {
      type: "table",
      columns: [
        { label: "№", width: 1, align: "center" },
        { label: "F.I.Sh.", width: net ? 6 : 7 },
        ...(net ? [{ label: "Filial", width: 3 }] : []),
        { label: "Sinf", width: net ? 3 : 4 },
        { label: "Kelgan sana", width: 3, align: "center" },
        { label: "Holati", width: net ? 2 : 3, align: "center" },
      ],
      rows,
    },
  ];
};

/**
 * KIMLAR KETDI va NEGA.
 *
 * ⚠️ Toifa (`Ketish sababi`) va erkin IZOH ikkalasi ham yoziladi: toifa
 * faqat kesim uchun, "nega" degan savolning asl javobi esa izohda
 * (`studentEnrollment.service.js` → `reason`).
 */
const leftBlocks = (report, index) => {
  const items = report.leftStudents;

  if (items.length === 0) {
    return [
      { type: "heading", level: 2, text: `${index}. Chiqib ketgan o'quvchilar` },
      {
        type: "paragraph",
        text: "Bu davrda birorta o'quvchi maktabdan ketmagan.",
        color: COLOR.muted,
        after: 160,
      },
    ];
  }

  const net = report.isNetwork;

  const rows = items.map((item, i) => [
    { text: String(i + 1), align: "center" },
    { text: item.name, bold: true },
    ...(net ? [{ text: text(item.branchName) }] : []),
    { text: text(item.className) },
    { text: day(item.date), align: "center" },
    { text: item.reasonLabel, color: COLOR.down, align: "center" },
    { text: text([item.reasonNote, item.note].filter(Boolean).join(" · ")) },
  ]);

  return [
    {
      type: "heading",
      level: 2,
      text: `${index}. Chiqib ketgan o'quvchilar (${items.length} ta)`,
    },
    {
      type: "table",
      columns: [
        { label: "№", width: 1, align: "center" },
        { label: "F.I.Sh.", width: 5 },
        ...(net ? [{ label: "Filial", width: 3 }] : []),
        { label: "Sinf", width: 3 },
        { label: "Ketgan sana", width: 3, align: "center" },
        { label: "Sababi", width: 3, align: "center" },
        { label: "Izoh", width: net ? 4 : 5 },
      ],
      rows,
    },
  ];
};

/**
 * FILIALLARARO KO'CHGANLAR — "ko'chish: 12" raqamining orqasida kim bor.
 *
 * ⚠️ Bu bo'lim ULAR "keldi/ketdi" dan CHIQARILGANI UCHUN kerak: sanoqchi
 * jim qolmasligi kerak (`wipedByDiscount` bilan AYNI mulohaza). Ko'chish
 * bo'lmasa bo'lim umuman chizilmaydi.
 */
const movedBlocks = (report, index) => {
  const items = report.movedStudents ?? [];
  if (items.length === 0) return [];

  const rows = items.map((item, i) => [
    { text: String(i + 1), align: "center" },
    { text: item.name, bold: true },
    { text: text(item.className) },
    { text: text(item.fromBranch), align: "center" },
    { text: text(item.toBranch), align: "center", color: COLOR.up },
    { text: day(item.date), align: "center" },
  ]);

  return [
    {
      type: "heading",
      level: 2,
      text: `${index}. Filiallararo ko'chganlar (${items.length} ta)`,
    },
    {
      type: "table",
      columns: [
        { label: "№", width: 1, align: "center" },
        { label: "F.I.Sh.", width: 6 },
        { label: "Sinf", width: 3 },
        { label: "Qaysi filialdan", width: 4, align: "center" },
        { label: "Qaysi filialga", width: 4, align: "center" },
        { label: "Sana", width: 3, align: "center" },
      ],
      rows,
    },
    {
      type: "paragraph",
      text:
        "Bu o'quvchilar maktabni tashlab ketmagan — ular tarmoq ichida " +
        "boshqa filialga o'tgan, shuning uchun \"kelgan\" va \"ketgan\" " +
        "ro'yxatlariga kirmaydi.",
      size: 17,
      color: COLOR.muted,
      after: 160,
    },
  ];
};

/**
 * IZOH — ikki xil "o'quvchilar soni" farqi.
 *
 * Farq bo'lmasa yozilmaydi: "0 ta nomuvofiqlik" degan qator hujjatni
 * ma'nosiz to'ldirardi.
 */
const contextBlocks = (report) => {
  const { listed, studying, withoutOpenEnrollment } = report.context;

  const where = report.isNetwork ? " (barcha filiallar bo'yicha)" : "";

  const lines = [
    `Ro'yxatdagi o'quvchilar (arxivlanmagan)${where}: ${listed} ta.`,
    `O'qish davri ochiq o'quvchilar${where}: ${studying} ta.`,
  ];

  if (withoutOpenEnrollment > 0) {
    lines.push(
      `Farq: ${withoutOpenEnrollment} ta o'quvchining o'qish davri yopilgan yoki ` +
        "umuman yozilmagan — ular hisobotda \"o'qiyotgan\" deb sanalmaydi.",
    );
  }

  // ⚠️ TUSHIB QOLGAN FILIAL JIM QOLMAYDI. Bir filialga ulanib bo'lmasa
  // hisobot baribir quriladi (qolgani yo'qolmasligi kerak), lekin raqam
  // "tarmoq jamisi" bo'lib o'qiladi — shuning uchun qamrov ochiq yoziladi.
  if (report.partial?.length) {
    lines.push(
      `⚠️ Quyidagi filial(lar) ma'lumoti olinmadi va hisobotga KIRMAGAN: ` +
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
        "Ma'lumot manbai — o'quvchilarning o'qish davrlari: davrning ochilishi " +
        "\"keldi\", yopilishi esa \"ketdi\" degani. Hujjat platformada avtomatik " +
        "shakllantirilgan.",
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
 * ⚠️ BO'LIM RAQAMLARI AVTOMAT. Ilgari ular qo'lda yozilib, oxirgi ikkitasi
 * `hasMonthly ? 4 : 3` bilan hisoblanardi — yangi bo'lim ("Filiallar
 * kesimi") qo'shilishi bilan raqamlar surilib, hujjatda "3" ikki marta
 * chiqardi.
 *
 * @param {object} report - `getMovementReport` yoki
 *   `getNetworkMovementReport` natijasi (ikkalasi AYNI shaklda)
 * @returns {Promise<Buffer>}
 */
const buildMovementDocx = (report) => {
  let section = 0;
  const next = () => (section += 1);

  const blocks = [...headerBlocks(report), ...summaryBlocks(report, next())];

  // Faqat umumiy ko'rinishda: bitta filialda bu jadval o'zini takrorlardi.
  if (report.isNetwork) blocks.push(...branchBlocks(report, next()));

  // Bitta oylik hisobotda oylar kesimi umumiy ko'rsatkichlarni takrorlaydi.
  if (report.byMonth.length >= 2) blocks.push(...monthlyBlocks(report, next()));

  blocks.push(
    ...reasonBlocks(report, next()),
    ...joinedBlocks(report, next()),
    ...leftBlocks(report, next()),
  );

  // Faqat haqiqatan ko'chish bo'lgan hisobotda.
  if (report.movedStudents?.length) blocks.push(...movedBlocks(report, next()));

  blocks.push({ type: "spacer" }, ...contextBlocks(report));

  return buildDocx({
    title: `O'quvchilar harakati — ${report.range.label}`,
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
const sendMovementDocx = async (res, report) => {
  const buffer = await buildMovementDocx(report);

  const scope = report.isNetwork ? " (barcha filiallar)" : "";

  sendDocx(res, buffer, `O'quvchilar harakati${scope} ${report.range.label}`, {
    fallbackName: "oquvchilar-harakati",
  });
};

module.exports = { buildMovementDocx, sendMovementDocx };
