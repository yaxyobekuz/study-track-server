/**
 * DARS SOATLARI — SOF HISOB, DB'siz.
 *
 * Domenda dars jadvali HAFTALIK SHABLON: `Schedule` (sinf + hafta kuni) va
 * uning ichidagi `ScheduleLesson`. Kalendar sanasiga bog'langan dars yozuvi
 * BUTUN BAZADA YO'Q. Ya'ni "bu oyda necha soat o'tildi" degan savolga javob
 * berish uchun shablonni oyning kunlariga YOYISH kerak.
 *
 * ⚠️ SOAT = DARS. Butun domenda "soat" har doim dars sonini bildiradi
 * (`teacherWorkload.service.js`, `PlannerLoad.weeklyHours` bilan bir xil
 * o'lchov), astronomik soat EMAS. Ikkinchi o'lchov kiritilsa reja, jadval va
 * oylik raqamlari bir-biriga taqqoslanmay qolardi.
 *
 * ── NIMA UCHUN AYNAN SHU FAYL ────────────────
 *
 * Bu yerda FAQAT arifmetika turadi: kirim — oy kaliti, bayram kunlari
 * to'plami va hafta kuni bo'yicha darslar; chiqim — sonlar. DB so'rovi ham,
 * Prisma ham, taymzona hiylasi ham yo'q. Sabab `allocation.helpers.js`
 * bilan bir xil: chaqiruvchisi ikkita (jonli dashboard va oylik
 * shakllantirish) va ular BIR XIL raqam berishi SHART. Ikkita mustaqil
 * hisoblagich bo'lsa, "panelda 84 soat, oylikda 82 soat" degan tushuntirib
 * bo'lmas holat chiqardi.
 *
 * ⚠️ DARS BO'LMAYDIGAN KUNLAR IKKI XIL: yakshanba (`ScheduleDay` enumida
 * umuman yo'q) va bayram (alohida to'plam bilan keladi). Ikkalasi ham
 * `teachingDaysOfMonth` da filtrlanadi — ro'yxatning UZUNLIGI "oyda necha
 * dars kuni bor" degan raqam sifatida ishlatilgani uchun (pastdagi izohga
 * qarang).
 */

const { Decimal } = require("./money.helpers");
const { daysInMonth } = require("./month.helpers");

/**
 * Sanani kun kaliti ("2026-09-21") ga aylantiradi.
 *
 * ⚠️ FAQAT `getUTC*`. Sana `@db.Date` va UTC yarim tunida yotadi; lokal
 * getter'lar UTC−5 hostda bir kun orqaga o'qib, oy chegarasidagi kunni
 * boshqa oyga tashlab yuborardi (`month.helpers.js` bilan bir xil qoida).
 *
 * @param {Date} date
 * @returns {string} "YYYY-MM-DD"
 */
function dayKey(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * INSTANT ning TOSHKENT kalendar kuni kaliti.
 *
 * ⚠️ `Grade.date` — `@db.Date` EMAS, baho qo'yilgan ONning o'zi
 * (`grade.controller.js` → `date: now`). 08:00 Toshkentdagi baho UTC da
 * 03:00 bo'ladi va `dayKey` bilan o'qilsa to'g'ri, lekin 00:30 Toshkent
 * (UTC da kechagi 19:30) kechagi kunga tushib qolardi. Toshkentda DST yo'q —
 * +5 soat doimiy (`education.md` §9).
 *
 * @param {Date} instant
 * @returns {string} "YYYY-MM-DD"
 */
function tashkentDayKey(instant) {
  return dayKey(new Date(instant.getTime() + 5 * 3600000));
}

/* ─────────────────────── DARS O'TILDIMI ─────────────────────── */

/**
 * O'TILMAGAN DARS SABABLARI.
 *
 * Sabab AYNAN qaysi tuzatish kerakligini aytadi: "kelmagan" — davomatni
 * yoki kunni ochib baho qo'ydirishni, "sababli" va "baho qo'yilmagan" —
 * baho qo'yishni ochib berish (`GradingUnlock`).
 */
const LESSON_MISS_REASONS = {
  absent: "Kelmagan",
  excused: "Sababli kelmagan",
  noGrade: "Baho qo'yilmagan",
};

/** Bitta darsning baho kaliti: sinf + fan + tartib + Toshkent kuni. */
const lessonGradeKey = (classId, subjectId, lessonOrder, day) =>
  `${classId}|${subjectId}|${lessonOrder}|${day}`;

/** O'qituvchi + kun kaliti (davomat uchun). */
const teacherDayKey = (teacherId, day) => `${teacherId}|${day}`;

/**
 * Qaysi kungacha darslar TEKSHIRILADI (INKLYUZIV kun raqami).
 *
 * ⚠️ BUGUN TEKSHIRILMAYDI. Baho odatda o'sha kuni qo'yiladi
 * (`grade.controller.js`), davomat esa kun oxirida avtomat yopiladi —
 * kunning o'rtasida "baho yo'q" degani hali "o'tilmagan" degani emas.
 * Bugungi dars ertasiga yakuniy baholanadi.
 *
 * @param {number} month - YYYYMM
 * @param {number} currentMonth - YYYYMM (Toshkent)
 * @param {number} today - joriy oy kuni (Toshkent)
 * @returns {number|null} `null` — oy to'liq tekshiriladi; `0` — hech kun
 */
function judgedThroughDay(month, currentMonth, today) {
  if (month < currentMonth) return null;
  if (month > currentMonth) return 0;
  return today - 1;
}

/**
 * Bitta dars O'TILDIMI — sof qaror (biznes qarori):
 *
 *   · kun OCHILGAN (`GradingUnlock`) → baho bo'lsa O'TILGAN, davomatdan
 *                                      qat'i nazar;
 *   · "kelmadi" (sababsiz)            → O'TILMAGAN, baho bo'lsa ham;
 *   · "sababli"                       → baho bo'lsa O'TILGAN, bo'lmasa o'tilmagan;
 *   · davomat muammosiz               → baho bo'lsa O'TILGAN, bo'lmasa o'tilmagan.
 *
 * Baho — KAMIDA BITTA o'quvchiga. Istisno yo'q (baho jarimasidan ozod
 * qilinganlar uchun ham).
 *
 * ⚠️ OCHILGAN KUN DAVOMATNI USTIDAN YOZADI: boshliq platforma sababli baho
 * qo'yilmay qolgan kunlarni ochadi va bu "shu kunlar bahosiga ishonaman"
 * degani — o'sha kunlarning davomati ham (kelish tugmasi ishlamagan,
 * avtomat "kelmadi") noto'g'ri bo'lishi mumkin. Oyna yopilgani yoki muddati
 * o'tgani qarorni o'zgartirmaydi: qo'yilgan baho o'z kuchida qoladi.
 *
 * @param {object} lesson - { teacherId, classId, subjectId, lessonOrder, day }
 * @param {object} facts
 * @param {Set<string>} facts.gradedKeys - `lessonGradeKey` to'plami
 * @param {Map<string, {status: string, autoMarked: boolean}>} facts.absences -
 *   `teacherDayKey` → davomat (faqat absent/excused)
 * @param {Set<string>} [facts.unlockedDays] - `teacherDayKey` → ochilgan kunlar
 * @returns {null | {reason: "absent"|"excused"|"noGrade", autoMarked: boolean}}
 */
function judgeLesson(lesson, { gradedKeys, absences, unlockedDays }) {
  const dayKeyOfTeacher = teacherDayKey(lesson.teacherId, lesson.day);
  const graded = gradedKeys.has(
    lessonGradeKey(lesson.classId, lesson.subjectId, lesson.lessonOrder, lesson.day),
  );
  if (graded && unlockedDays?.has(dayKeyOfTeacher)) return null;

  const absence = absences.get(dayKeyOfTeacher);
  if (absence?.status === "absent") {
    return { reason: "absent", autoMarked: Boolean(absence.autoMarked) };
  }

  if (graded) return null;

  return absence
    ? { reason: "excused", autoMarked: Boolean(absence.autoMarked) }
    : { reason: "noGrade", autoMarked: false };
}

/**
 * OCHILGAN KUNLAR — `GradingUnlock` oynalari → `teacherDayKey` to'plami.
 *
 * `scope = all` oyna chaqiruvchi bergan HAMMA o'qituvchini qamraydi
 * (oyna ochilgandan keyin qo'shilganini ham), `selected` — faqat
 * ro'yxatdagilarni. Holat (yopilgan, muddati o'tgan) ATAYLAB
 * tekshirilmaydi — `judgeLesson` izohiga qarang.
 *
 * @param {Array<{dateFrom: Date, dateTo: Date, scope: string, teacherIds: string[]}>} unlocks
 * @param {string[]} teacherIds
 * @param {Array<{date: Date, key: string}>} days
 * @returns {Set<string>}
 */
function unlockedTeacherDays(unlocks, teacherIds, days) {
  const result = new Set();
  const wanted = new Set(teacherIds);

  for (const unlock of unlocks) {
    const targets =
      unlock.scope === "all"
        ? teacherIds
        : (unlock.teacherIds ?? []).filter((id) => wanted.has(id));
    if (targets.length === 0) continue;

    const from = unlock.dateFrom.getTime();
    const to = unlock.dateTo.getTime();
    for (const day of days) {
      const time = day.date.getTime();
      if (time < from || time > to) continue;
      for (const teacherId of targets) result.add(teacherDayKey(teacherId, day.key));
    }
  }

  return result;
}

/**
 * Oyning barcha kunlari — UTC yarim tunidagi `Date` va hafta kuni raqami.
 *
 * Hafta kuni `getUTCDay()` bilan olinadi (0 = yakshanba), ya'ni
 * `DAYS_UZ` / `DAY_TO_NUMBER` bilan AYNAN bir xil koordinatada.
 *
 * @param {number} monthKey - YYYYMM
 * @returns {Array<{date: Date, key: string, dayNumber: number, dayOfMonth: number}>}
 */
function eachDayOfMonth(monthKey) {
  const year = Math.trunc(monthKey / 100);
  const month = monthKey % 100;
  const total = daysInMonth(monthKey);
  const days = [];

  for (let day = 1; day <= total; day += 1) {
    const date = new Date(Date.UTC(year, month - 1, day));
    days.push({
      date,
      key: dayKey(date),
      dayNumber: date.getUTCDay(),
      dayOfMonth: day,
    });
  }

  return days;
}

/**
 * Oyning DARS O'TILADIGAN kunlari — yakshanba va bayramlar chiqarilgan.
 *
 * ⚠️ YAKSHANBA HAM FILTRLANADI. Soat hisobiga u baribir ta'sir qilmasdi
 * (`ScheduleDay` enumida yakshanba yo'q, ya'ni `weeklyByDay` da 0 kaliti
 * hech qachon bo'lmaydi), LEKIN bu ro'yxatning UZUNLIGI "oyda necha dars
 * kuni bor" degan raqam sifatida ishlatiladi va u panelda ko'rsatiladi,
 * `hoursSnapshot` ga esa muhrlanadi. Yakshanbani qoldirish o'sha raqamni
 * o'z-o'ziga zid qilardi: bayram (dars bo'lmaydigan kun) chiqarilgan-u,
 * yakshanba (u ham dars bo'lmaydigan kun) qolgan bo'lardi.
 *
 * @param {number} monthKey - YYYYMM
 * @param {object} [options]
 * @param {Set<string>} [options.holidaySet] - "YYYY-MM-DD" bayram kunlari
 * @param {number} [options.untilDayOfMonth] - shu kungacha (INKLYUZIV).
 *   Joriy oy uchun "bugungacha o'tilgani" ni ajratishga kerak.
 * @returns {Array<{date, key, dayNumber, dayOfMonth}>}
 */
function teachingDaysOfMonth(monthKey, { holidaySet, untilDayOfMonth } = {}) {
  return eachDayOfMonth(monthKey).filter((day) => {
    if (day.dayNumber === 0) return false; // yakshanba — dars yo'q
    if (untilDayOfMonth != null && day.dayOfMonth > untilDayOfMonth) return false;
    if (holidaySet && holidaySet.has(day.key)) return false;
    return true;
  });
}

/**
 * Haftalik shablonni oy kunlariga yoyadi.
 *
 * @param {Array<{dayNumber: number}>} days - `teachingDaysOfMonth` natijasi
 * @param {Map<number, number>} weeklyByDay - hafta kuni raqami → dars soni
 * @returns {number} oydagi jami soat
 */
function expandWeeklyHours(days, weeklyByDay) {
  let total = 0;
  for (const day of days) total += weeklyByDay.get(day.dayNumber) ?? 0;
  return total;
}

/**
 * MAOSH FORMULASI — uch rejim bitta joyda.
 *
 * ⚠️ Bu funksiya PULNI hisoblaydigan YAGONA nuqta. Oylik shakllantirish ham,
 * paneldagi jonli hisob ham shuni chaqiradi. Ikkita nusxa bo'lsa,
 * o'qituvchi panelda bir raqam, vedomostda boshqa raqam ko'rardi — bu esa
 * modulning butun mohiyatini (shaffoflik) yo'qqa chiqarardi.
 *
 *   fixed  → amount
 *   hourly → hours × hourlyRate
 *   mixed  → amount + max(0, hours − norm) × hourlyRate
 *
 * ⚠️ `mixed` da normadan KAM ishlangani uchun BAZAVIY summa KAMAYTIRILMAYDI.
 * Bu biznes qarori: fiksa — kelishilgan minimal kafolat, jarima emas. Kam
 * o'tilgan soat uchun ushlab qolish kerak bo'lsa, u alohida jarima
 * mexanizmi bilan yechiladi (`Penalty`), oylik formulasi bilan emas.
 *
 * @param {object} rule - { type, amount, hourlyRate, monthlyHourNorm }
 * @param {number} hours - o'tilgan akademik soat (butun son)
 * @returns {{
 *   baseAmount: Prisma.Decimal,
 *   hoursAmount: Prisma.Decimal,
 *   amount: Prisma.Decimal,
 *   payableHours: number,
 *   extraHours: number
 * }}
 */
function computeSalary(rule, hours) {
  const worked = Number.isFinite(hours) && hours > 0 ? Math.trunc(hours) : 0;
  const base = new Decimal(rule.amount ?? 0);
  const rate = rule.hourlyRate != null ? new Decimal(rule.hourlyRate) : null;

  if (rule.type === "hourly") {
    const payable = worked;
    const hoursAmount = rate ? rate.times(payable) : new Decimal(0);

    return {
      baseAmount: new Decimal(0),
      hoursAmount,
      amount: hoursAmount,
      payableHours: payable,
      extraHours: 0,
    };
  }

  if (rule.type === "mixed") {
    const norm = Number.isFinite(rule.monthlyHourNorm) ? rule.monthlyHourNorm : 0;
    const extra = Math.max(0, worked - norm);
    const hoursAmount = rate ? rate.times(extra) : new Decimal(0);

    return {
      baseAmount: base,
      hoursAmount,
      amount: base.plus(hoursAmount),
      payableHours: extra,
      extraHours: extra,
    };
  }

  // fixed — dars soati summaga TA'SIR QILMAYDI (soat baribir ko'rsatiladi:
  // "shu oyda 96 soat o'tdi" degan ma'lumot fiksadagi odam uchun ham kerak).
  return {
    baseAmount: base,
    hoursAmount: new Decimal(0),
    amount: base,
    payableHours: 0,
    extraHours: 0,
  };
}

/**
 * Normaning bajarilgan ulushi — faqat KO'RSATISH uchun (progress halqasi).
 * `hourly` da norma yo'q, shuning uchun `null`.
 *
 * @param {object} rule
 * @param {number} hours
 * @returns {number|null} 0..100+ (oshib ketishi MUMKIN va shunday ko'rsatiladi)
 */
function normProgress(rule, hours) {
  if (rule?.type !== "mixed" || !rule.monthlyHourNorm) return null;
  return Math.round((hours / rule.monthlyHourNorm) * 100);
}

module.exports = {
  dayKey,
  tashkentDayKey,
  LESSON_MISS_REASONS,
  lessonGradeKey,
  teacherDayKey,
  judgedThroughDay,
  judgeLesson,
  unlockedTeacherDays,
  eachDayOfMonth,
  teachingDaysOfMonth,
  expandWeeklyHours,
  computeSalary,
  normProgress,
};
