/**
 * "AI TAHLIL VA TAVSIYALAR" — dashboarddagi xulosalar bloki.
 *
 * ⚠️ BU YERDA LLM CHAQIRUVI YO'Q va bo'lmaydi. Xulosalar shu oyning
 * HAQIQIY raqamlaridan qoida asosida tug'iladi: deterministik (bir xil
 * raqam → bir xil matn), xarajatsiz va tarmoq uzilganda ham mavjud.
 * Model chaqirilsa, bitta ekran uchun har yangilanishda pul to'lanardi va
 * xulosa oyma-oy taqqoslab bo'lmaydigan bo'lib qolardi.
 *
 * ⚠️ SOF FUNKSIYA: bazaga bormaydi, `Date` o'qimaydi, hech narsani
 * yozmaydi. `getOverview` yig'gan bloklarni kirish sifatida oladi —
 * shuning uchun har bir qoidani sinovda tekshirib bo'ladi.
 *
 * ⚠️ MATN SERVERDA TO'LIQ YIG'ILADI. Frontendga tayyor o'zbekcha jumla
 * ketadi: shablonni ikki joyda (server + panel) saqlash "sinflarda"
 * qo'shimchasi bir panelda yo'qolishi bilan tugardi.
 */

// ─────────────────────────────────────────────
// Chegaralar — har biri NIMA UCHUN shundayligi bilan
// ─────────────────────────────────────────────

/**
 * Fan o'rtachasi umumiy o'rtachadan shuncha BALL uzoqlashsagina "yuqori"
 * yoki "past" deb ataladi.
 *
 * ⚠️ Absolyut chegara (masalan "4.5 dan past") ishlatilmaydi: maktabning
 * umumiy darajasi 4.7 bo'lsa, 4.6 lik fan "past" bo'lib qolardi; 3.8 bo'lsa
 * hech qaysi fan "yuqori" bo'lolmasdi. Farq HAR DOIM shu oyning o'z
 * o'rtachasiga nisbatan o'lchanadi.
 */
const SUBJECT_SPREAD_GAP = 0.15;

/**
 * Ikkinchi fan birinchisidan shuncha ball ichida bo'lsa, ikkalasi BIRGA
 * aytiladi ("Matematika va Informatika"). Aks holda faqat birinchisi:
 * 4.61 va 4.20 ni bitta jumlada maqtash ikkinchisiga qo'shib qo'yish bo'lardi.
 */
const SUBJECT_PEER_GAP = 0.1;

/**
 * Fan xulosaga tushishi uchun kamida shuncha baho bo'lishi kerak.
 * Uchta "5" bilan fan reyting boshiga chiqib qolmasligi uchun.
 */
const MIN_SUBJECT_GRADES = 10;

/** Xulosa "eng yuqori/eng past" deyishi uchun kamida shuncha fan kerak. */
const MIN_RANKED_SUBJECTS = 2;

/**
 * Sinf darajasi ayblanishi uchun o'sha darajada shu fandan kamida shuncha
 * baho bo'lishi kerak — ikkita bahodan "7-8 sinflarda muammo" degan xulosa
 * chiqarib bo'lmaydi.
 */
const MIN_LEVEL_GRADES = 10;

/** Davomat shu foizdan yuqori bo'lsa "yaxshi", pastda "past" deb ataladi. */
const GOOD_ATTENDANCE_RATE = 90;

/**
 * Sinf darajasi umumiy davomatdan shuncha PUNKT past bo'lsagina alohida
 * tilga olinadi. Bir punktlik farq har oy tebranadi va uni "pasayish" deb
 * aytish har oy bir xil ogohlantirish chiqarardi.
 */
const LEVEL_ATTENDANCE_GAP = 2;

/** Davomat xulosasi uchun kamida shuncha belgi — bitta kun statistika emas. */
const MIN_ATTENDANCE_MARKS = 20;

/**
 * Topshiriq bajarilishi shu foizdan past bo'lsa ogohlantiriladi.
 * Beshdan bittasi muddatida bajarilmayotgani intizom muammosi hisoblanadi.
 */
const LOW_TASK_COMPLETION = 85;

/** Topshiriq xulosasi uchun kamida shuncha topshiriq bo'lishi kerak. */
const MIN_TASKS = 5;

/**
 * To'garak qamrovi shu foizdan past bo'lsa tavsiya beriladi: har uchinchi
 * o'quvchi darsdan tashqari mashg'ulotda bo'lishi — maktab uchun minimal me'yor.
 */
const LOW_CLUB_COVERAGE = 30;

/**
 * Reja bajarilishi shu koridor ichida bo'lsa ("100% ± 2") xulosa
 * chiqarilmaydi: rejaga aynan tushish shov-shuv emas, u normal holat.
 */
const PLAN_TOLERANCE = 2;

/**
 * Ro'yxatdagi maksimal xulosa soni. Ettita tavsiya "diqqat qiling" degan
 * ma'noni yo'qotadi — blok e'tibor talab qiladigan bir nechta gapdan iborat.
 */
const MAX_INSIGHTS = 6;

/**
 * Ohang bo'yicha muhimlik tartibi: avval muammo, keyin yutuq, so'ng
 * kuzatuv va tavsiya. Ro'yxat kesilganda birinchi bo'lib TAVSIYA tushib
 * qoladi, OGOHLANTIRISH esa hech qachon tushmaydi.
 */
const TONE_ORDER = ["warning", "positive", "info", "tip"];

// ─────────────────────────────────────────────
// Formatlash — raqam ko'rinishi butun blokda bir xil
// ─────────────────────────────────────────────

/** Baho — doim 2 xona: "4.05" (4.1 emas, 4 emas). */
const grade = (value) => Number(value).toFixed(2);

/** Foiz — doim 1 xona, belgisi bilan: "93.7%". */
const percent = (value) => `${Number(value).toFixed(1)}%`;

/** Sanoq — "12 ta". */
const count = (value) => `${Number(value)} ta`;

/** Fan nomlari ro'yxati: 1 ta → "Matematika", 2 ta → "Matematika va Fizika". */
const joinNames = (names) => names.join(" va ");

/** Bir nechta fan bo'lsa "fanlaridan", bittasi bo'lsa "fanidan". */
const subjectSuffix = (names) => (names.length > 1 ? "fanlaridan" : "fanidan");

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

// ─────────────────────────────────────────────
// Qoidalar
// ─────────────────────────────────────────────

/**
 * Xulosaga tushishi mumkin bo'lgan fanlar: bahosi hisoblangan va
 * ma'lumoti yetarli bo'lganlari.
 */
const rankableSubjects = (subjects) =>
  (subjects ?? [])
    .filter((row) => isNumber(row?.average) && (row.gradeCount ?? 0) >= MIN_SUBJECT_GRADES)
    .sort((a, b) => b.average - a.average);

/**
 * Umumiy o'rtacha — taqqoslash asosi. KPI dagi qiymat afzal (u butun
 * jurnalni sanaydi); bo'lmasa ro'yxatdagi fanlardan baho soniga qarab
 * vaznlangan o'rtacha olinadi (oddiy o'rtacha 3 bahodan iborat fanni
 * 900 bahodan iborat fan bilan tenglashtirib qo'yardi).
 */
const overallAverageOf = (kpi, ranked) => {
  const fromKpi = kpi?.averageGrade?.value;
  if (isNumber(fromKpi)) return fromKpi;

  let sum = 0;
  let total = 0;
  for (const row of ranked) {
    sum += row.average * row.gradeCount;
    total += row.gradeCount;
  }

  return total > 0 ? sum / total : null;
};

/** 1-qoida: eng yuqori o'rtachaga ega 1-2 fan. */
const topSubjectsRule = (ranked, overall) => {
  if (ranked.length < MIN_RANKED_SUBJECTS || !isNumber(overall)) return null;

  const best = ranked[0];
  if (best.average - overall < SUBJECT_SPREAD_GAP) return null;

  // Ikkinchisi birinchisiga yaqin bo'lsagina qo'shiladi
  const second = ranked[1];
  const chosen =
    second && best.average - second.average <= SUBJECT_PEER_GAP ? [best, second] : [best];

  const names = chosen.map((row) => row.name);
  // Ko'rsatiladigan raqam — tanlangan fanlarning baho soniga qarab
  // vaznlangan o'rtachasi: ikki fan aytilib, bittasining raqami turishi
  // "qaysi biriniki?" degan savolni tug'dirardi.
  const sum = chosen.reduce((acc, row) => acc + row.average * row.gradeCount, 0);
  const total = chosen.reduce((acc, row) => acc + row.gradeCount, 0);

  return {
    id: "subject-top",
    tone: "positive",
    text: `${joinNames(names)} ${subjectSuffix(names)} o'rtacha baho yuqori (${grade(
      sum / total,
    )}). Bu natijani saqlab qolinsin.`,
  };
};

/** 2-qoida: eng past o'rtachaga ega fan + qaysi sinf darajasida. */
const weakSubjectRule = (ranked, overall) => {
  if (ranked.length < MIN_RANKED_SUBJECTS || !isNumber(overall)) return null;

  const worst = ranked[ranked.length - 1];
  if (overall - worst.average < SUBJECT_SPREAD_GAP) return null;

  // Daraja FANNING O'ZI bo'yicha eng past guruh (`buildSubjects` beradi).
  // Umumiy eng past daraja bilan almashtirilsa, ikkita bog'liq bo'lmagan
  // fakt bitta jumlada sabab-oqibatdek ko'rinib qolardi.
  const level = worst.weakestLevel;
  const prefix =
    level && (level.gradeCount ?? 0) >= MIN_LEVEL_GRADES ? `${level.label}da ` : "";

  return {
    id: "subject-low",
    tone: "warning",
    text: `${prefix}${worst.name} fanidan o'rtacha baho past (${grade(
      worst.average,
    )}). Qo'shimcha darslar tavsiya etiladi.`,
  };
};

/** 3-qoida: umumiy davomat + eng past sinf darajasi. */
const attendanceRule = (kpi, levels, totals) => {
  const value = kpi?.attendanceRate?.value;
  if (!isNumber(value)) return null;
  if ((totals?.attendanceMarks ?? 0) < MIN_ATTENDANCE_MARKS) return null;

  // "Boshqa sinflar" — raqami o'qilmagan sinflar chelagi. Uni ayblash
  // hech qanday harakatga olib bormaydi, shuning uchun tilga olinmaydi.
  const named = (levels ?? []).filter(
    (row) => row?.key !== "other" && isNumber(row?.attendanceRate),
  );
  const lowest = named.reduce(
    (acc, row) => (acc == null || row.attendanceRate < acc.attendanceRate ? row : acc),
    null,
  );
  const gap = lowest ? value - lowest.attendanceRate : 0;
  const weakLevel = lowest && gap >= LEVEL_ATTENDANCE_GAP ? lowest : null;

  if (value >= GOOD_ATTENDANCE_RATE) {
    return {
      id: "attendance",
      tone: "info",
      text: weakLevel
        ? `Davomat ko'rsatkichi yaxshi (${percent(value)}), lekin ${
            weakLevel.label
          }da biroz pasayish mavjud.`
        : `Davomat ko'rsatkichi yaxshi (${percent(
            value,
          )}) va barcha sinf darajalarida barqaror.`,
    };
  }

  return {
    id: "attendance",
    tone: "info",
    text: weakLevel
      ? `Davomat ko'rsatkichi past (${percent(value)}), ayniqsa ${
          weakLevel.label
        }da. Sinf rahbarlari bilan ishlash kerak.`
      : `Davomat ko'rsatkichi past (${percent(
          value,
        )}). Sinf rahbarlari bilan ishlash kerak.`,
  };
};

/**
 * 4-qoida: olimpiada — taqqoslash oyiga nisbatan harakat va ishtirok
 * tavsiyasi.
 *
 * ⚠️ Matn "o'tgan oy" DEB YOZILMAYDI. Taqqoslash oyini foydalanuvchi
 * tanlaydi va u 23 oygacha orqada bo'lishi mumkin — "o'tgan oyga nisbatan
 * kamaydi" degan jumla o'sha holatda shunchaki yolg'on bo'lardi. Yorliq
 * `getOverview` dan tayyor holda keladi (`formatMonthKey`), shu sababli
 * bu yerda oy nomlari massivi ham, formatlash ham yo'q.
 */
const achievementRule = (achievements, compareLabel) => {
  const total = achievements?.total;
  const previous = achievements?.previousTotal;
  const since = compareLabel ? `${compareLabel} da` : "o'tgan oyda";
  if (!isNumber(total)) return null;

  if (total === 0) {
    return {
      id: "achievements",
      tone: "tip",
      text: "Shu oyda olimpiada va musobaqa yutug'i qayd etilmagan. O'quvchilarni tanlovlarga jalb qilish tavsiya etiladi.",
    };
  }

  if (!isNumber(previous)) {
    return {
      id: "achievements",
      tone: "tip",
      text: `Shu oyda ${count(
        total,
      )} olimpiada yutug'i qayd etilgan. Ishtirokchilar doirasini kengaytirish mumkin.`,
    };
  }

  if (total > previous) {
    return {
      id: "achievements",
      tone: "tip",
      text: `Olimpiada yutuqlari oshdi: shu oyda ${count(total)}, ${since} ${count(
        previous,
      )} edi. Ishtirokchilar doirasini yanada kengaytirish mumkin.`,
    };
  }

  if (total < previous) {
    return {
      id: "achievements",
      tone: "tip",
      text: `Olimpiada yutuqlari kamaydi: shu oyda ${count(total)}, ${since} ${count(
        previous,
      )} edi. O'quvchilarni ko'proq tanlovlarga jalb qilish tavsiya etiladi.`,
    };
  }

  return {
    id: "achievements",
    tone: "tip",
    text: `Olimpiada yutuqlari ${since}gi daraja bilan bir xil (${count(
      total,
    )}). Ishtirokchilar doirasini kengaytirish mumkin.`,
  };
};

/** 5-qoida: o'quvchilar soni rejaga nisbatan. */
const studentPlanRule = (kpi) => {
  const card = kpi?.students;
  if (!card || !isNumber(card.planRate) || !isNumber(card.value) || !isNumber(card.plan)) {
    return null;
  }

  if (Math.abs(card.planRate - 100) <= PLAN_TOLERANCE) return null;

  if (card.planRate < 100) {
    return {
      id: "plan-students",
      tone: "warning",
      text: `O'quvchilar soni rejadan orqada: ${count(card.value)}, reja ${count(
        card.plan,
      )} (bajarilish ${percent(card.planRate)}).`,
    };
  }

  return {
    id: "plan-students",
    tone: "positive",
    text: `O'quvchilar soni rejadan oshdi: ${count(card.value)}, reja ${count(
      card.plan,
    )} (bajarilish ${percent(card.planRate)}).`,
  };
};

/** 6-qoida: topshiriq bajarilishi past. */
const taskRule = (kpi, totals) => {
  const value = kpi?.taskCompletion?.value;
  const total = totals?.taskTotal ?? 0;

  if (!isNumber(value) || total < MIN_TASKS || value >= LOW_TASK_COMPLETION) return null;

  return {
    id: "task-completion",
    tone: "warning",
    text: `Topshiriqlarning ${percent(value)} i muddatida bajarilgan (jami ${count(
      total,
    )}). Ijro nazoratini kuchaytirish tavsiya etiladi.`,
  };
};

/** 7-qoida: to'garak qamrovi past. */
const clubRule = (clubs) => {
  const coverage = clubs?.coverage;
  if (!isNumber(coverage) || coverage >= LOW_CLUB_COVERAGE) return null;

  return {
    id: "club-coverage",
    tone: "tip",
    text: `To'garaklarga o'quvchilarning atigi ${percent(
      coverage,
    )} i qatnashadi. Qamrovni kengaytirish uchun yangi to'garaklar ochish tavsiya etiladi.`,
  };
};

// ─────────────────────────────────────────────
// Kirish nuqtasi
// ─────────────────────────────────────────────

/**
 * Oyning raqamlaridan xulosalar ro'yxati.
 *
 * Har bir qoida MA'LUMOT YETARLI bo'lgandagina qator qaytaradi — yetarli
 * bo'lmasa `null`. "Ma'lumot yo'q" ni "ko'rsatkich nol" deb ko'rsatish
 * bo'sh maktabni "davomat 0%" deb ayblab qo'yardi.
 *
 * ⚠️ `getOverview` BUTUN javobni uzatadi (`distribution`,
 * `attendanceTrend`, `teachers` ham) — quyida faqat hozirgi qoidalarga
 * kerak bo'lgan bloklar ochib olinadi. Yangi qoida qo'shilganda chaqiruv
 * joyiga tegilmaydi, faqat shu destrukturizatsiya kengayadi.
 *
 * @param {object} overview `getOverview` yig'gan bloklar
 * @returns {Array<{id: string, tone: "positive"|"warning"|"info"|"tip", text: string}>}
 */
const buildInsights = ({
  kpi,
  subjects,
  levels,
  achievements,
  clubs,
  totals,
  compareMonthLabel,
} = {}) => {
  const ranked = rankableSubjects(subjects);
  const overall = overallAverageOf(kpi, ranked);

  const rules = [
    topSubjectsRule(ranked, overall),
    weakSubjectRule(ranked, overall),
    attendanceRule(kpi, levels, totals),
    achievementRule(achievements, compareMonthLabel),
    studentPlanRule(kpi),
    taskRule(kpi, totals),
    clubRule(clubs),
  ].filter(Boolean);

  // Ohang bo'yicha saralanadi, ohang ichida esa yuqoridagi tartib saqlanadi
  // (`sort` barqaror) — ya'ni ikkita ogohlantirishdan fan bo'yichasi
  // rejadan oldin turadi, chunki qoidalar shu tartibda yozilgan.
  return rules
    .sort((a, b) => TONE_ORDER.indexOf(a.tone) - TONE_ORDER.indexOf(b.tone))
    .slice(0, MAX_INSIGHTS);
};

module.exports = {
  buildInsights,
  // Sinov uchun ochiladi
  SUBJECT_SPREAD_GAP,
  SUBJECT_PEER_GAP,
  MIN_SUBJECT_GRADES,
  MIN_LEVEL_GRADES,
  MIN_ATTENDANCE_MARKS,
  MIN_TASKS,
  GOOD_ATTENDANCE_RATE,
  LEVEL_ATTENDANCE_GAP,
  LOW_TASK_COMPLETION,
  LOW_CLUB_COVERAGE,
  PLAN_TOLERANCE,
  MAX_INSIGHTS,
};
