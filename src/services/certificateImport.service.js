/**
 * SERTIFIKAT REJALARINI EXCEL / CSV DAN YUKLASH.
 *
 * Manba — Google Forms javoblari jadvali: har qatorda o'quvchining ismi,
 * guruhi, bir yoki ikki sertifikat yo'nalishi va muddatlari, hamda forma
 * to'ldirilgan vaqt (timestamp).
 *
 * Qoida bitta jumlada:
 *
 * > Import IKKI QADAM: `preview` hech narsa YOZMAYDI va o'quvchi
 * > moslashtirishni ko'rsatadi, `confirm` esa ODAM KO'RGAN qatorlarni
 * > yozadi.
 *
 * ⚠️ MOSLASHTIRISH TAXMIN QILMAYDI. Faylda ism QO'LDA yozilgan va xato
 * bor ("Suhrobbrk", "Ahmaduloo"). Avtomatik ulanadigan yagona holat —
 * guruh ichida QAT'IY TENG va YAGONA nom. Qolgani TAKLIF bo'lib chiqadi va
 * odam tasdiqlaydi. Aks holda import begona o'quvchiga reja yozib, u
 * ekranida o'ziga tegishli bo'lmagan muddatni ko'rardi
 * (`education.md` §10 — sheet moslashtirishdagi AYNI doktrina).
 *
 * ⚠️ MOSLASHTIRISH XOTIRASI — REGISTRNING O'ZI. Admin bir marta
 * tasdiqlagan xom ism `CertificatePlan.sourceName` da qoladi va keyingi
 * import uni QAYTA so'ramaydi. Alohida moslashtirish jadvali shu sababdan
 * qo'shilmadi.
 *
 * ⚠️ HAR QATOR ALOHIDA TRANZAKSIYADA: bitta buzuq qator butun faylni
 * orqaga qaytarmasligi kerak (`applyDefaultToAll` va `cancelMonth` bilan
 * AYNI qoida, `finance.md` §5).
 */

const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const { BadRequestError } = require("../utils/errors");
const { isValidId } = require("../utils/objectId");
const { readSheet } = require("../helpers/sheetReader.helpers");
const { ROLES } = require("../utils/constants");
const { formatDateUz } = require("../helpers/date.helpers");
const {
  PLAN_SOURCE,
  ACTIVE_STATUS,
  DATE_ORDER,
  normalizeName,
  nameSortKey,
  nameSimilarity,
  detectDateOrder,
  parseSheetDay,
  parseSheetInstant,
} = require("../helpers/certificate.helpers");
const trackService = require("./certificateTrack.service");
const planService = require("./certificatePlan.service");

/** Bir faylda o'qiladigan qatorlar chegarasi. */
const ROWS_MAX = 2000;

/** Bir qatordagi sertifikat ustunlari chegarasi (forma 2 ta so'raydi). */
const ENTRIES_PER_ROW_MAX = 10;

/** Bir tasdiqda yoziladigan qatorlar chegarasi. */
const CONFIRM_ROWS_MAX = 1000;

/**
 * TAKLIF chegarasi — bundan pastdagi o'xshashlik ko'rsatilmaydi.
 *
 * 0.5 — "Ibrohimov Behruz" ↔ "Ibrohimov Behruzbek" (ismning qisqa shakli)
 * ro'yxatga tushadigan daraja. Past chegara XAVFSIZ, chunki taklif
 * TASDIQLANADI; yuqori chegara esa aynan shu holatni yashirib, adminni
 * 153 qatordan qo'lda qidirishga majbur qilardi.
 */
const SUGGEST_MIN = 0.5;

/** Bir qatorga ko'rsatiladigan takliflar soni. */
const SUGGEST_MAX = 5;

/** Moslashtirish natijasi. */
const MATCH = Object.freeze({
  AUTO: "auto",          // guruh ichida qat'iy teng va yagona nom
  AUTO_SCHOOL: "school", // guruh mos kelmadi, maktab bo'yicha yagona
  LEARNED: "learned",    // avvalgi import tasdig'idan
  SUGGESTED: "suggested",// taklif — odam tanlaydi
  AMBIGUOUS: "ambiguous",// bir xil nomli bir nechta o'quvchi
  NONE: "none",          // topilmadi
});

/* ───────────────────────── USTUNLARNI ANIQLASH ───────────────────────── */

/**
 * USTUNLARNI SARLAVHA MA'NOSI BO'YICHA TOPADI.
 *
 * ⚠️ Sarlavha matni QOTIRILMAYDI. Forma savoli istalgan payt
 * tahrirlanadi ("Topshirmoqchi bolgan sertifikatingiz 1-fan" — imlo xatosi
 * bilan, qavs yopilmagan holda keldi). Qat'iy tenglik talab qilinsa, savol
 * nomidagi bitta harf import ni butunlay yiqitardi.
 *
 * ⚠️ MUDDAT ustuni SERTIFIKAT ustunidan OLDIN tekshiriladi: "Sertifikatga
 * topshiriladigan muddat 1-fan" ichida "sertifikat" ham, "fan" ham bor.
 * Tartib almashtirilsa muddat ustuni yo'nalish deb o'qilardi.
 *
 * Yo'nalish va muddat ustunlari JADVALDAGI TARTIB bo'yicha juftlanadi
 * (1-fan ↔ 1-muddat), nomidagi raqam bo'yicha emas: raqam yozilmagan
 * shablon ham ishlashi kerak.
 *
 * @param {string[]} headers - normallashtirilgan sarlavhalar (tartibda)
 * @returns {{timestamp: string|null, name: string|null, group: string|null,
 *   tracks: string[], dues: string[], note: string|null}}
 */
function detectColumns(headers) {
  const result = { timestamp: null, name: null, group: null, tracks: [], dues: [], note: null };

  for (const header of headers || []) {
    if (!header) continue;

    if (!result.timestamp && /timestamp|vaqt|sana_vaqt/.test(header)) {
      result.timestamp = header;
      continue;
    }
    if (!result.name && /(ism|familiya|fio|f_i_o|oquvchi|talaba)/.test(header)) {
      result.name = header;
      continue;
    }
    if (!result.group && /(guruh|sinf|group)/.test(header)) {
      result.group = header;
      continue;
    }
    // ⚠️ MUDDAT — sertifikatdan OLDIN
    if (/(muddat|deadline|topshirish_sanasi)/.test(header)) {
      result.dues.push(header);
      continue;
    }
    if (/(sertifikat|yonalish|imtihon|fan|subject)/.test(header)) {
      result.tracks.push(header);
      continue;
    }
    if (!result.note && /(fikr|izoh|comment|qoshimcha)/.test(header)) {
      result.note = header;
    }
  }

  return result;
}

/* ───────────────────────── FAYLNI O'QISH ───────────────────────── */

const cell = (row, key) => (key ? row[key] : undefined);
const text = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * FAYLNI QATORLARGA AYLANTIRADI (bazaga tegmaydi).
 *
 * @param {object} file - multer fayli
 * @returns {{columns: object, rows: object[], warnings: string[]}}
 */
function parseImportFile(file) {
  // ⚠️ `cellDates` — SANA ustunlari bor import: Excel sanasini xom seriya
  // raqami o'rniga `Date` bo'lib olish ishonchliroq. Mavjud importlar
  // (diagnostika savollari) buni YOQMAYDI — ularda sana ustuni yo'q va
  // bayroq butun varaqqa ta'sir qiladi.
  const { rows: raw, headers } = readSheet(file, { cellDates: true });

  if (raw.length === 0) throw new BadRequestError("Faylda ma'lumot topilmadi");
  if (raw.length > ROWS_MAX) {
    throw new BadRequestError(`Faylda ${raw.length} qator bor — ${ROWS_MAX} tadan oshmasligi kerak`);
  }

  const columns = detectColumns(headers);
  const warnings = [];

  if (!columns.name) {
    throw new BadRequestError(
      "Ism-familiya ustuni topilmadi. Sarlavhada \"Ism familiya\" bo'lishi kerak",
    );
  }
  if (columns.tracks.length === 0) {
    throw new BadRequestError(
      "Sertifikat yo'nalishi ustuni topilmadi. Sarlavhada \"sertifikat\" yoki \"yo'nalish\" so'zi bo'lishi kerak",
    );
  }
  if (columns.tracks.length > ENTRIES_PER_ROW_MAX) {
    throw new BadRequestError("Faylda sertifikat ustunlari juda ko'p — ustunlarni tekshiring");
  }
  if (!columns.group) {
    warnings.push(
      "Guruh ustuni topilmadi — o'quvchilar butun maktab bo'yicha moslashtiriladi",
    );
  }
  if (columns.dues.length === 0) {
    warnings.push("Muddat ustuni topilmadi — rejalar muddatsiz yoziladi");
  }

  // ⚠️ SANA TARTIBI BUTUN USTUN BO'YICHA hal qilinadi: "01.12.2026" bitta
  // qatorda ikki xil o'qilishi mumkin (`certificate.helpers.js`).
  const dueOrder = detectDateOrder(
    columns.dues.flatMap((key) => raw.map((row) => cell(row, key))),
    DATE_ORDER.DMY, // o'zbekcha sukut: kun oldin
  );
  const stampOrder = detectDateOrder(
    raw.map((row) => cell(row, columns.timestamp)),
    DATE_ORDER.MDY, // Google Forms sukuti: oy oldin
  );

  if (dueOrder.ambiguous) {
    warnings.push(
      "Muddat ustunida sana formati aralash — muddatlarni tasdiqlashdan oldin tekshiring",
    );
  }

  const rows = [];
  raw.forEach((row, index) => {
    const sourceName = text(cell(row, columns.name));
    const sourceGroup = text(cell(row, columns.group));
    const note = text(cell(row, columns.note)) || null;
    const submittedAt = parseSheetInstant(cell(row, columns.timestamp), stampOrder.order);

    const entries = [];
    const seenTracks = new Set();
    columns.tracks.forEach((trackKey, position) => {
      const trackName = text(cell(row, trackKey));
      if (!trackName) return;

      const dueKey = columns.dues[position];
      const dueRaw = dueKey ? cell(row, dueKey) : null;
      const dueDate = parseSheetDay(dueRaw, dueOrder.order);

      // ⚠️ BITTA QATORDA BIR YO'NALISH IKKI MARTA bo'lishi mumkin: o'quvchi
      // "1-fan" va "2-fan" ga bir xil fanni, lekin BOSHQA muddat yozgan
      // (ma'lumotda bor). Ikkalasini yozib bo'lmaydi — bitta sertifikatga
      // ikki muddat ma'nosiz. Shuning uchun takrori BELGILANADI va panelda
      // sukut bo'yicha tanlanmaydi: qaysi muddat to'g'ri ekanini admin
      // hal qiladi, tizim esa jimgina birini tashlab ketmaydi.
      const key = normalizeName(trackName);
      const duplicateInRow = seenTracks.has(key);
      seenTracks.add(key);

      entries.push({
        trackName,
        dueRaw: dueRaw instanceof Date ? dueRaw.toISOString() : text(dueRaw) || null,
        dueDate,
        // Muddat yozilgan-u, o'qib bo'lmagan bo'lsa — JIM qoldirilmaydi
        dueUnreadable: Boolean(text(dueRaw)) && !dueDate,
        duplicateInRow,
      });
    });

    rows.push({
      // Sarlavha qatori 1-chi, ma'lumot 2-chidan boshlanadi — foydalanuvchi
      // faylda aynan shu raqamni ko'radi
      rowNumber: index + 2,
      sourceName,
      sourceGroup: sourceGroup || null,
      submittedAt,
      note,
      entries,
    });
  });

  return { columns, rows, warnings };
}

/* ───────────────────────── MOSLASHTIRISH ───────────────────────── */

/**
 * Moslashtirish uchun ma'lumot bazasi: joriy o'quvchilar, sinflar va
 * avvalgi importlardan o'rganilgan nomlar.
 */
async function loadMatchContext() {
  const [students, classes, learnedRows] = await Promise.all([
    prisma.user.findMany({
      where: { role: ROLES.STUDENT, isArchived: false },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        username: true,
        classes: { select: { classId: true, class: { select: { id: true, name: true } } } },
      },
    }),
    prisma.class.findMany({ select: { id: true, name: true, isActive: true } }),
    // ⚠️ XOTIRA: admin avval tasdiqlagan xom ism → o'quvchi. `distinct`
    // bilan: bitta ism yuzlab qatorda bo'lishi mumkin.
    prisma.certificatePlan.findMany({
      where: { sourceName: { not: null } },
      select: { sourceName: true, studentId: true },
      distinct: ["sourceName", "studentId"],
    }),
  ]);

  const shaped = students.map((student) => ({
    id: student.id,
    fullName: `${student.lastName ?? ""} ${student.firstName ?? ""}`.trim(),
    username: student.username,
    classIds: student.classes.map((uc) => uc.classId),
    classNames: student.classes.map((uc) => uc.class?.name).filter(Boolean),
  }));

  const byClass = new Map();
  for (const student of shaped) {
    for (const classId of student.classIds) {
      if (!byClass.has(classId)) byClass.set(classId, []);
      byClass.get(classId).push(student);
    }
  }

  const classByName = new Map(classes.map((cls) => [normalizeName(cls.name), cls]));

  // Bitta xom ism IKKI o'quvchiga tegishli bo'lsa, xotira ISHLATILMAYDI:
  // qaysi biri ekani ma'lum emas va jim tanlov begona rejani yozardi.
  const learnedCount = new Map();
  for (const row of learnedRows) {
    const key = normalizeName(row.sourceName);
    if (!key) continue;
    if (!learnedCount.has(key)) learnedCount.set(key, new Set());
    learnedCount.get(key).add(row.studentId);
  }
  const learned = new Map();
  for (const [key, ids] of learnedCount) {
    if (ids.size === 1) learned.set(key, [...ids][0]);
  }

  return { students: shaped, byClass, classByName, learned };
}

const publicStudent = (student) => ({
  id: student.id,
  fullName: student.fullName,
  username: student.username,
  classNames: student.classNames,
});

/**
 * BITTA QATORNI O'QUVCHIGA MOSLASHTIRADI.
 *
 * Ustunlik tartibi (yuqoridan pastga):
 *   1. XOTIRA — admin avval shu xom ismni tasdiqlagan
 *   2. GURUH ICHIDA qat'iy teng va yagona nom
 *   3. MAKTAB bo'yicha qat'iy teng va yagona nom (guruh yozilmagan/xato)
 *   4. TAKLIF — o'xshash nomlar, odam tanlaydi
 *
 * ⚠️ "Qat'iy teng" — `nameSortKey` tengligi: registr, apostrof va SO'ZLAR
 * TARTIBI hisobga olinmaydi ("Familiya Ism" ham, "Ism Familiya" ham mos
 * keladi). IMLO XATOSI avtomatik ulanmaydi, u faqat TAKLIFga chiqadi:
 * "Karimov Aziz" bilan "Karimov Azizbek" aka-uka bo'lishi ham mumkin va
 * jim tanlov begona o'quvchiga reja yozardi.
 *
 * @returns {{status: string, student: object|null, candidates: object[],
 *   classId: string|null, className: string|null, groupMatched: boolean}}
 */
function matchRow(row, context) {
  const { byClass, classByName, learned, students } = context;

  const groupKey = row.sourceGroup ? normalizeName(row.sourceGroup) : "";
  const cls = groupKey ? classByName.get(groupKey) ?? null : null;
  const pool = cls ? byClass.get(cls.id) ?? [] : students;

  const base = {
    classId: cls?.id ?? null,
    className: cls?.name ?? null,
    groupMatched: Boolean(cls),
  };

  if (!row.sourceName) {
    return { ...base, status: MATCH.NONE, student: null, candidates: [] };
  }

  // 1) XOTIRA
  const learnedId = learned.get(normalizeName(row.sourceName));
  if (learnedId) {
    const student = students.find((s) => s.id === learnedId);
    if (student) {
      return { ...base, status: MATCH.LEARNED, student: publicStudent(student), candidates: [] };
    }
  }

  const wantedKey = nameSortKey(row.sourceName);

  // 2) GURUH ICHIDA qat'iy teng
  const exactInPool = pool.filter((s) => nameSortKey(s.fullName) === wantedKey);
  if (exactInPool.length === 1) {
    return {
      ...base,
      status: cls ? MATCH.AUTO : MATCH.AUTO_SCHOOL,
      student: publicStudent(exactInPool[0]),
      candidates: [],
    };
  }
  if (exactInPool.length > 1) {
    return {
      ...base,
      status: MATCH.AMBIGUOUS,
      student: null,
      candidates: exactInPool.slice(0, SUGGEST_MAX).map(publicStudent),
    };
  }

  // 3) MAKTAB bo'yicha qat'iy teng (guruh xato yozilgan bo'lsa ham topiladi)
  if (cls) {
    const exactInSchool = students.filter((s) => nameSortKey(s.fullName) === wantedKey);
    if (exactInSchool.length === 1) {
      return {
        ...base,
        status: MATCH.AUTO_SCHOOL,
        student: publicStudent(exactInSchool[0]),
        candidates: [],
      };
    }
    if (exactInSchool.length > 1) {
      return {
        ...base,
        status: MATCH.AMBIGUOUS,
        student: null,
        candidates: exactInSchool.slice(0, SUGGEST_MAX).map(publicStudent),
      };
    }
  }

  // 4) TAKLIF — avval guruh ichida, topilmasa maktab bo'yicha
  const rank = (list) =>
    list
      .map((student) => ({ student, score: nameSimilarity(row.sourceName, student.fullName) }))
      .filter((entry) => entry.score >= SUGGEST_MIN)
      .sort((a, b) => b.score - a.score)
      .slice(0, SUGGEST_MAX);

  let ranked = cls ? rank(pool) : [];
  if (ranked.length === 0) ranked = rank(students);

  if (ranked.length > 0) {
    return {
      ...base,
      status: MATCH.SUGGESTED,
      student: null,
      candidates: ranked.map((entry) => ({
        ...publicStudent(entry.student),
        score: Math.round(entry.score * 100),
      })),
    };
  }

  return { ...base, status: MATCH.NONE, student: null, candidates: [] };
}

/* ───────────────────────── PREVIEW ───────────────────────── */

/** Avtomatik ulanadigan holatlar — admin tasdiqlashi shart emas. */
const RESOLVED_STATUSES = new Set([MATCH.AUTO, MATCH.AUTO_SCHOOL, MATCH.LEARNED]);

/**
 * KO'RIB CHIQISH — hech narsa YOZMAYDI.
 *
 * Javobda admin ekranda ko'radigan hamma narsa bor: moslashtirish holati,
 * takliflar, o'qilgan muddatlar va yangi yaratiladigan yo'nalishlar.
 *
 * ⚠️ FAYL SERVERDA SAQLANMAYDI. Tasdiqlash qadami qatorlarni O'ZI qaytarib
 * yuboradi, ya'ni yoziladigan narsa — AYNAN odam ekranda ko'rgani. Draft
 * jadval ochilsa, uni tozalaydigan cron ham kerak bo'lardi, eng muhimi —
 * ekrandagi va bazadagi qator bir-biridan ajralib ketishi mumkin edi.
 */
async function previewImport(file, { actorId }) {
  const { columns, rows, warnings } = parseImportFile(file);
  const context = await loadMatchContext();

  // Yo'nalishlar — faqat MAVJUDLARI o'qiladi, yangisi preview'da
  // YARATILMAYDI: ko'rib chiqish yozmasligi kerak.
  const trackNames = [
    ...new Set(rows.flatMap((row) => row.entries.map((entry) => entry.trackName))),
  ];
  const existingTracks = await prisma.certificateTrack.findMany({
    select: { id: true, name: true, isActive: true, subjectId: true },
  });
  const trackByKey = new Map(existingTracks.map((t) => [normalizeName(t.name), t]));

  const newTracks = [];
  const archivedTracks = [];
  for (const name of trackNames) {
    const found = trackByKey.get(normalizeName(name));
    if (!found) newTracks.push(name);
    else if (!found.isActive) archivedTracks.push(found.name);
  }

  if (archivedTracks.length > 0) {
    warnings.push(
      `Arxivlangan yo'nalish(lar): ${archivedTracks.join(", ")} — ular yozilmaydi, avval arxivdan qaytaring`,
    );
  }

  const groupsNotFound = new Set();
  const matched = rows.map((row) => {
    const match = matchRow(row, context);
    if (row.sourceGroup && !match.groupMatched) groupsNotFound.add(row.sourceGroup);
    return { row, match };
  });

  // ⚠️ MAVJUD FAOL REJALAR OLDINDAN KO'RSATILADI. "Oxirgi topshirish
  // yutadi" qoidasi tufayli yangi qator eskisini almashtiradi — va
  // ma'lumotda MUDDATSIZ keyingi topshirish ham bor ("aniq sanasini
  // bilmiman"), ya'ni yozuv to'ldirilgan muddatni bo'shi bilan almashtirib
  // yuborishi mumkin. Admin buni YOZISHDAN OLDIN ko'rishi kerak, aks holda
  // qoida "ma'lumotni yo'qotdi" bo'lib ko'rinardi.
  const resolvedPairs = matched
    .filter(({ match }) => match.student)
    .flatMap(({ row, match }) =>
      row.entries
        .map((entry) => {
          const track = trackByKey.get(normalizeName(entry.trackName));
          return track ? { studentId: match.student.id, trackId: track.id } : null;
        })
        .filter(Boolean),
    );

  const existingPlans = resolvedPairs.length
    ? await prisma.certificatePlan.findMany({
        where: {
          status: ACTIVE_STATUS,
          studentId: { in: [...new Set(resolvedPairs.map((p) => p.studentId))] },
          trackId: { in: [...new Set(resolvedPairs.map((p) => p.trackId))] },
        },
        select: { studentId: true, trackId: true, dueDate: true, submittedAt: true },
      })
    : [];
  const existingByPair = new Map(
    existingPlans.map((plan) => [`${plan.studentId}|${plan.trackId}`, plan]),
  );

  // Faylda bir necha marta uchraydigan xom ismlar — oxirgisi yutadi
  const nameCount = new Map();
  for (const { row } of matched) {
    if (!row.sourceName) continue;
    const key = normalizeName(row.sourceName);
    nameCount.set(key, (nameCount.get(key) ?? 0) + 1);
  }

  const shaped = matched.map(({ row, match }) => ({
    ...row,
    repeatedInFile: row.sourceName ? (nameCount.get(normalizeName(row.sourceName)) ?? 0) > 1 : false,
    entries: row.entries.map((entry) => {
      const track = trackByKey.get(normalizeName(entry.trackName));
      const existing =
        match.student && track
          ? existingByPair.get(`${match.student.id}|${track.id}`) ?? null
          : null;

      return {
        ...entry,
        trackExists: Boolean(track),
        trackArchived: track?.isActive === false,
        existing: existing
          ? {
              dueDate: existing.dueDate,
              dueDateLabel: formatDateUz(existing.dueDate, { utc: true }),
              submittedAt: existing.submittedAt,
            }
          : null,
      };
    }),
    match,
  }));

  if (groupsNotFound.size > 0) {
    warnings.push(
      `Sinf topilmadi: ${[...groupsNotFound].join(", ")} — bu qatorlar maktab bo'yicha moslashtirildi`,
    );
  }

  const emptyRows = shaped.filter((row) => row.entries.length === 0).length;
  if (emptyRows > 0) {
    warnings.push(`${emptyRows} qatorda sertifikat ko'rsatilmagan — ular yozilmaydi`);
  }

  const repeated = shaped.filter((row) => row.repeatedInFile).length;
  if (repeated > 0) {
    warnings.push(
      `${repeated} qator bir xil o'quvchiga tegishli (forma ikki marta to'ldirilgan) — ` +
        "OXIRGI topshirish amalda qoladi, muddati bo'sh bo'lsa ham",
    );
  }

  const duplicateTracks = shaped.reduce(
    (sum, row) => sum + row.entries.filter((entry) => entry.duplicateInRow).length,
    0,
  );
  if (duplicateTracks > 0) {
    warnings.push(
      `${duplicateTracks} qatorda bir yo'nalish ikki marta ko'rsatilgan — ` +
        "ikkinchisi sukut bo'yicha tanlanmaydi, muddatni tekshiring",
    );
  }

  const resolved = shaped.filter(
    (row) => row.entries.length > 0 && RESOLVED_STATUSES.has(row.match.status),
  );

  return {
    columns: {
      timestamp: columns.timestamp,
      name: columns.name,
      group: columns.group,
      tracks: columns.tracks,
      dues: columns.dues,
      note: columns.note,
    },
    summary: {
      total: shaped.length,
      withEntries: shaped.length - emptyRows,
      plans: shaped.reduce((sum, row) => sum + row.entries.length, 0),
      resolved: resolved.length,
      needsReview: shaped.length - emptyRows - resolved.length,
      newTracks: newTracks.length,
      // Diqqat talab qiladigan holatlar — panel ularni ALOHIDA ko'rsatadi
      duplicateTracks,
      willReplace: shaped.reduce(
        (sum, row) => sum + row.entries.filter((entry) => entry.existing).length,
        0,
      ),
      repeatedStudents: shaped.filter((row) => row.repeatedInFile).length,
      unreadableDues: shaped.reduce(
        (sum, row) => sum + row.entries.filter((entry) => entry.dueUnreadable).length,
        0,
      ),
    },
    newTracks,
    rows: shaped,
    warnings,
  };
}

/* ───────────────────────── CONFIRM ───────────────────────── */

/**
 * Tasdiqlangan qatorni tekshiradi (panel yuborgan shakl).
 *
 * @returns {{studentId: string, submittedAt: Date|null, note: string|null,
 *   sourceName: string|null, sourceGroup: string|null,
 *   entries: {trackName: string, dueDate: Date|null}[]}}
 */
function parseConfirmRow(row, index) {
  const at = `Qator ${row?.rowNumber ?? index + 1}`;

  if (!row || typeof row !== "object") throw new BadRequestError(`${at}: ma'lumot buzuq`);
  if (!isValidId(row.studentId)) throw new BadRequestError(`${at}: o'quvchi tanlanmagan`);

  const entries = Array.isArray(row.entries) ? row.entries : [];
  if (entries.length === 0) throw new BadRequestError(`${at}: sertifikat yo'nalishi yo'q`);
  if (entries.length > ENTRIES_PER_ROW_MAX) {
    throw new BadRequestError(`${at}: sertifikat yo'nalishlari juda ko'p`);
  }

  const submittedAt = row.submittedAt ? new Date(row.submittedAt) : null;
  if (submittedAt && Number.isNaN(submittedAt.getTime())) {
    throw new BadRequestError(`${at}: forma vaqti noto'g'ri`);
  }

  return {
    // Hisobotdagi "qator N" foydalanuvchi FAYLDA ko'radigan raqam
    rowNumber: Number.isInteger(row.rowNumber) ? row.rowNumber : index + 2,
    studentId: row.studentId,
    submittedAt,
    note: row.note ? String(row.note).slice(0, planService.NOTE_MAX) : null,
    sourceName: row.sourceName ? String(row.sourceName).slice(0, 120) : null,
    sourceGroup: row.sourceGroup ? String(row.sourceGroup).slice(0, 60) : null,
    entries: entries.map((entry) => {
      const trackName = String(entry?.trackName ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!trackName) throw new BadRequestError(`${at}: yo'nalish nomi bo'sh`);

      return {
        trackName,
        // Muddat o'qilmagan bo'lsa reja MUDDATSIZ yoziladi, qator
        // tashlanmaydi: "aniq sanani bilmayman" ham javob
        // (`parseDueDate` ni ataylab chaqiramiz — qo'lda kiritish bilan
        // AYNI tekshiruv).
        dueDate: entry?.dueDate ? planService.parseDueDate(entry.dueDate) : null,
      };
    }),
  };
}

/**
 * TASDIQLASH — rejalarni yozadi.
 *
 * ⚠️ HAR REJA ALOHIDA TRANZAKSIYADA. Bitta buzuq qator (masalan arxivlangan
 * o'quvchi) butun faylni orqaga qaytarmaydi; natija qator-qator hisobotda
 * qaytadi.
 *
 * @param {{rows: object[]}} payload
 * @param {{actorId: string}} options
 */
async function confirmImport({ rows }, { actorId }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new BadRequestError("Yozish uchun qator tanlanmagan");
  }
  if (rows.length > CONFIRM_ROWS_MAX) {
    throw new BadRequestError(`Bir vaqtda ${CONFIRM_ROWS_MAX} qatordan ko'p yozib bo'lmaydi`);
  }

  const parsed = rows.map(parseConfirmRow);

  // O'quvchilar BIR MARTA tekshiriladi: arxivlangan yoki o'quvchi bo'lmagan
  // id panelda eskirgan ro'yxatdan kelishi mumkin.
  const studentIds = [...new Set(parsed.map((row) => row.studentId))];
  const students = await prisma.user.findMany({
    where: { id: { in: studentIds }, role: ROLES.STUDENT, isArchived: false },
    select: { id: true },
  });
  const allowed = new Set(students.map((s) => s.id));

  const { byName, created: createdTracks, archived: archivedTracks } =
    await trackService.ensureTracksByName(
      parsed.flatMap((row) => row.entries.map((entry) => entry.trackName)),
      { actorId },
    );

  const report = {
    created: 0,
    replaced: 0,
    duplicate: 0,
    older: 0,
    failed: [],
    createdTracks,
    archivedTracks,
  };

  for (const row of parsed) {
    if (!allowed.has(row.studentId)) {
      report.failed.push({
        rowNumber: row.rowNumber,
        sourceName: row.sourceName,
        message: "O'quvchi topilmadi yoki arxivlangan",
      });
      continue;
    }

    for (const entry of row.entries) {
      const track = byName.get(normalizeName(entry.trackName));
      if (!track) {
        report.failed.push({
          rowNumber: row.rowNumber,
          sourceName: row.sourceName,
          trackName: entry.trackName,
          message: archivedTracks.some((name) => normalizeName(name) === normalizeName(entry.trackName))
            ? "Yo'nalish arxivlangan"
            : "Yo'nalish yaratilmadi",
        });
        continue;
      }

      try {
        const result = await prisma.$transaction((tx) =>
          planService.writePlanInTx(
            tx,
            {
              studentId: row.studentId,
              trackId: track.id,
              dueDate: entry.dueDate,
              submittedAt: row.submittedAt,
              note: row.note,
              source: PLAN_SOURCE.IMPORT,
              sourceName: row.sourceName,
              sourceGroup: row.sourceGroup,
            },
            { actorId, supersede: true },
          ),
        );

        if (result.action === "created") report.created += 1;
        else if (result.action === "replaced") report.replaced += 1;
        else if (result.action === "duplicate") report.duplicate += 1;
        else if (result.action === "older") report.older += 1;
      } catch (error) {
        logger.warn(
          `[Certificate] Import qatori yozilmadi (${row.sourceName} / ${entry.trackName}): ${error.message}`,
        );
        report.failed.push({
          rowNumber: row.rowNumber,
          sourceName: row.sourceName,
          trackName: entry.trackName,
          message: error.message,
        });
      }
    }
  }

  return report;
}

module.exports = {
  ROWS_MAX,
  CONFIRM_ROWS_MAX,
  ENTRIES_PER_ROW_MAX,
  SUGGEST_MIN,
  MATCH,
  RESOLVED_STATUSES,
  detectColumns,
  parseImportFile,
  loadMatchContext,
  matchRow,
  previewImport,
  confirmImport,
};
