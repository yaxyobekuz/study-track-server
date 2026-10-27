/**
 * ERP VA KUNDALIK.COM — HISOBOT ("kim kiritilgan, kim yo'q").
 *
 * Belgilarning O'ZI `studentSystem.service.js` da: mas'ul xodim har
 * o'quvchi uchun "bor" qatorini qo'yadi, qator yo'qligi esa "yo'q"
 * degani (`education.md` §11). Bu modul o'sha BITTA faktdan ikki javob
 * quradi:
 *
 *  1. BOSH SAHIFADAGI KARTA (`getSystemsSummary`) — yengil sanoqchi:
 *     nechtasi ERP da bor, nechtasi Kundalik.com da, nechtasi kamida
 *     bitta tizimga kiritilmagan.
 *  2. HUJJAT (`getSystemsReport`) — chop etish va Word uchun: umumiy
 *     ko'rsatkichlar, sinflar kesimi va "kimlar" degan savolning javobi
 *     (ro'yxatlar).
 *
 * ⚠️ RO'YXAT VA SANOQ EXCEL BILAN AYNI MANBADAN (`loadExportData`).
 * Ikkinchi quruvchi yozilsa, Excel'dagi "ERP da yo'q: 82" bilan Word'dagi
 * raqam asta-sekin uzoqlashardi — holbuki ikkala fayl ham bitta mas'ul
 * xodimning qo'lida turadi (`invoiceBuilder.service.js` doktrinasi).
 *
 * ⚠️ KARTA SANOQCHISI ALOHIDA va bu ataylab: u har bosh sahifa
 * ochilganda so'raladi, hujjat esa butun maktabning o'quvchilarini
 * ro'yxati bilan yuklaydi. Sanoqchi uchun beshta `count` yetarli —
 * raqamlar esa AYNI shartlardan chiqadi (`presentWhere`).
 *
 * ⚠️ FAQAT JORIY O'QUVCHILAR (`CURRENT_STUDENTS`): arxivlangani
 * ro'yxatda ham, sanoqda ham yo'q (`education.md` §4). Belgisi esa
 * o'chirilmaydi — arxivdan qaytsa o'z holati bilan qaytadi.
 */

const prisma = require("../config/prisma");
const {
  SYSTEMS,
  SYSTEM_LABELS,
  CURRENT_STUDENTS,
  NO_CLASS,
  NO_CLASS_LABEL,
  loadExportData,
} = require("./studentSystem.service");

/** Sinf nomlari "tabiiy" tartibda: 5-A, 9-B, 10-A. */
const classCollator = new Intl.Collator("uz", { numeric: true, sensitivity: "base" });
const nameCollator = new Intl.Collator("uz", { sensitivity: "base" });

/**
 * Foiz — bitta kasr bilan, maxraj nol bo'lsa `null`.
 *
 * ⚠️ `null` NOL EMAS: o'quvchisi yo'q sinfda "0% kiritilgan" degan yozuv
 * "hech kim kiritilmagan" bo'lib o'qilardi. Ekran ham, hujjat ham uni
 * "—" qilib ko'rsatadi.
 */
const percentOf = (part, total) =>
  total > 0 ? Math.round((part / total) * 1000) / 10 : null;

/* ── Sanoqchi (bosh sahifadagi karta) ───────────────────────────────── */

const presentWhere = (system) => ({ systemMarks: { some: { system } } });

/**
 * BOSH SAHIFADAGI KARTA — tizimlar bo'yicha "bor / yo'q".
 *
 * ⚠️ FOIZ QAYTARILMAYDI. Umumiy ko'rinishda javob filiallar bo'ylab
 * birlashtiriladi: sanoqchi QO'SHILADI, foiz esa OG'IRLIKSIZ
 * o'rtachalanardi (root `CLAUDE.md`) — 344 o'quvchili filial bilan 12
 * o'quvchili filial teng hissa qo'shib, karta "tarmoqning qancha qismi
 * kiritilgan" degan savolga noto'g'ri javob berardi. Foiz kerak bo'lsa u
 * hisobotda (`getSystemsReport`), u yerda yig'indidan QAYTA hisoblanadi.
 *
 * @returns {Promise<{students: number, systems: Record<string, {yes: number, no: number}>,
 *   inBoth: number, missingAny: number, missingBoth: number}>}
 */
const getSystemsSummary = async () => {
  const [students, inBoth, missingBoth, ...presentCounts] = await Promise.all([
    prisma.user.count({ where: CURRENT_STUDENTS }),
    // Hamma tizimda bor
    prisma.user.count({
      where: { ...CURRENT_STUDENTS, AND: SYSTEMS.map(presentWhere) },
    }),
    // Birorta tizimda ham yo'q — belgi qatori umuman yo'q
    prisma.user.count({
      where: { ...CURRENT_STUDENTS, systemMarks: { none: {} } },
    }),
    ...SYSTEMS.map((system) =>
      prisma.user.count({ where: { ...CURRENT_STUDENTS, ...presentWhere(system) } }),
    ),
  ]);

  return {
    students,
    systems: Object.fromEntries(
      SYSTEMS.map((system, index) => [
        system,
        { yes: presentCounts[index], no: students - presentCounts[index] },
      ]),
    ),
    inBoth,
    // ⚠️ KARTANING ASOSIY RAQAMI: "kamida bitta tizimga kiritilmagan".
    // Aynan u ish talab qiladi — "ikkalasida ham bor" esa allaqachon
    // bajarilgan ish.
    missingAny: students - inBoth,
    missingBoth,
  };
};

/* ── Hisobot ─────────────────────────────────────────────────────────── */

/**
 * Qatorlardan ko'rsatkichlar. `rows` — `loadExportData` qatorlari
 * (`{ erp: boolean, kundalik: boolean, ... }`).
 */
const buildTotals = (rows) => {
  const students = rows.length;

  const systems = Object.fromEntries(
    SYSTEMS.map((system) => {
      const yes = rows.reduce((acc, row) => acc + (row[system] ? 1 : 0), 0);
      return [
        system,
        { yes, no: students - yes, percent: percentOf(yes, students) },
      ];
    }),
  );

  const inBoth = rows.filter((row) => SYSTEMS.every((key) => row[key])).length;
  const missingBoth = rows.filter((row) => SYSTEMS.every((key) => !row[key])).length;

  return {
    students,
    systems,
    inBoth,
    inBothPercent: percentOf(inBoth, students),
    missingAny: students - inBoth,
    missingAnyPercent: percentOf(students - inBoth, students),
    missingBoth,
  };
};

/**
 * Filiallar bo'ylab birlashtirish — YIG'INDIDAN QAYTA hisoblanadi.
 *
 * ⚠️ Foiz filiallar foizining o'rtachasi EMAS: katta filial natijaga
 * ko'proq ta'sir qilishi kerak (`combineMetrics` bilan AYNI mulohaza,
 * `studentMovement.service.js`).
 *
 * @param {Array<ReturnType<typeof buildTotals>>} parts
 */
const combineTotals = (parts) => {
  const sum = (pick) => parts.reduce((acc, part) => acc + pick(part), 0);

  const students = sum((part) => part.students);
  const inBoth = sum((part) => part.inBoth);

  return {
    students,
    systems: Object.fromEntries(
      SYSTEMS.map((system) => {
        const yes = sum((part) => part.systems[system].yes);
        return [
          system,
          { yes, no: students - yes, percent: percentOf(yes, students) },
        ];
      }),
    ),
    inBoth,
    inBothPercent: percentOf(inBoth, students),
    missingAny: students - inBoth,
    missingAnyPercent: percentOf(students - inBoth, students),
    missingBoth: sum((part) => part.missingBoth),
  };
};

/** Sinf qatori: sanoq + har tizim bo'yicha "bor / yo'q". */
const classRow = (bucket) => ({
  id: bucket.id,
  name: bucket.name,
  ...buildTotals(bucket.rows),
});

/**
 * SINFLAR KESIMI — "qaysi sinf qoldi".
 *
 * ⚠️ Ikki sinfdagi o'quvchi IKKALA sinf qatorida sanaladi, jamida esa bir
 * marta (`buildTotals(rows)`) — Excel hisoboti bilan AYNI qoida
 * (`studentSystem.service.js` → `buildClassSummary`). Yig'indi jamidan
 * katta chiqishi mumkin va buning sababi hujjatda yozib qo'yiladi.
 */
const buildClassBreakdown = (rows, students) => {
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const buckets = new Map();

  const bucketOf = (id, name) => {
    if (!buckets.has(id)) buckets.set(id, { id, name, rows: [] });
    return buckets.get(id);
  };

  for (const student of students) {
    const row = rowById.get(student.id);
    if (!row) continue;

    if (student.classes.length === 0) {
      bucketOf(NO_CLASS, NO_CLASS_LABEL).rows.push(row);
      continue;
    }
    for (const cls of student.classes) bucketOf(cls.id, cls.name).rows.push(row);
  }

  return [...buckets.values()]
    .sort((a, b) => {
      // ⚠️ Sinfsizlar ENG OXIRIDA — Excel qatorlari bilan AYNI qoida
      // (`buildExportRows`), tarmoq ro'yxatida ham shunday
      // (`studentSystemNetwork.service.js`).
      if (a.id === NO_CLASS) return 1;
      if (b.id === NO_CLASS) return -1;
      return classCollator.compare(a.name, b.name);
    })
    .map(classRow);
};

/** Hujjatdagi ro'yxat qatori — "kimlar" degan savolning javobi. */
const studentLine = (row) => ({
  id: row.id,
  name: row.name,
  className: row.classNames,
  ...Object.fromEntries(SYSTEMS.map((system) => [system, row[system]])),
});

/**
 * BITTA FILIAL UCHUN HISOBOT.
 *
 * ⚠️ Shakli tarmoq hisoboti bilan BIR XIL (`studentSystemNetwork.service.js`),
 * farqi faqat `isNetwork` bayrog'ida: ekran ham, Word quruvchisi ham
 * qo'shimcha shoxlanishsiz ishlaydi.
 *
 * @param {{branch?: {id: string, name: string}|null}} [options]
 */
const getSystemsReport = async ({ branch = null } = {}) => {
  // ⚠️ EXCEL BILAN AYNI YUKLOVCHI: qatorlar, tartib va "bor / yo'q"
  // ta'rifi bitta joyda qoladi. Sinf a'zoligi (`students`) ham o'shandan
  // keladi — kesim uchun sinf KIMLIGI kerak, qatorlarda esa u faqat
  // matn bo'lib bor ("5-A, 9-B").
  const { rows, students } = await loadExportData({ classIds: null });

  const totals = buildTotals(rows);

  return {
    isNetwork: false,
    branch,
    branches: branch ? [branch] : [],
    partial: [],
    generatedAt: new Date(),
    totals,
    byBranch: [],
    byClass: buildClassBreakdown(rows, students),
    missing: Object.fromEntries(
      SYSTEMS.map((system) => [
        system,
        rows.filter((row) => !row[system]).map(studentLine),
      ]),
    ),
  };
};

module.exports = {
  SYSTEMS,
  SYSTEM_LABELS,
  percentOf,
  buildTotals,
  combineTotals,
  buildClassBreakdown,
  studentLine,
  classCollator,
  nameCollator,
  getSystemsSummary,
  getSystemsReport,
};
