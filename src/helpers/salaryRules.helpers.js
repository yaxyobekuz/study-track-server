/**
 * XODIM OYLIGI — USTAMA QOIDALARI (sof matematika, DB'siz).
 *
 * Ustama qoidalari: [{ label, type: 'fixed' | 'percent', value }].
 *   fixed   — qat'iy summa qo'shiladi
 *   percent — FIKSA maoshdan foiz qo'shiladi (ustamali oylikdan EMAS)
 *
 * ⚠️ Foizlar QO'SHILADI (kompaund emas): 10% + 5% = fiksa'ning 15% i.
 *    Chunki har qoida mustaqil, ketma-ket bir-birining ustiga chiqmaydi.
 */

const { Decimal, formatAmount } = require("./money.helpers");
const { BadRequestError } = require("../utils/errors");

const ALLOWANCE_TYPES = ["fixed", "percent"];

/**
 * Kiritilgan ustamalar ro'yxatini tekshiradi va tozalaydi.
 * @param {Array} list
 * @returns {Array<{label:string, type:string, value:number}>}
 */
const normalizeAllowances = (list) => {
  if (list == null) return [];
  if (!Array.isArray(list)) {
    throw new BadRequestError("Ustama qoidalari ro'yxat bo'lishi kerak");
  }

  return list.map((item, index) => {
    const label = String(item?.label ?? "").trim();
    const type = String(item?.type ?? "").trim();
    if (!ALLOWANCE_TYPES.includes(type)) {
      throw new BadRequestError(
        `${index + 1}-qoida: tur "fixed" yoki "percent" bo'lishi kerak`,
      );
    }

    const value = Number(item?.value);
    if (!Number.isFinite(value) || value <= 0) {
      throw new BadRequestError(`${index + 1}-qoida: qiymat noldan katta bo'lishi kerak`);
    }
    if (type === "percent" && value > 1000) {
      throw new BadRequestError(`${index + 1}-qoida: foiz juda katta`);
    }

    return { label: label || (type === "percent" ? "Ustama" : "Qo'shimcha"), type, value };
  });
};

/**
 * Ustamalar summasini FIKSA maoshdan hisoblaydi.
 * @param {Decimal|string|number} fixedAmount - fiksa maosh
 * @param {Array} allowances - normalizeAllowances natijasi
 * @returns {{ total: Decimal, breakdown: Array }}
 */
const computeAllowances = (fixedAmount, allowances = []) => {
  const fixed = new Decimal(fixedAmount || 0);
  let total = new Decimal(0);
  const breakdown = [];

  for (const rule of allowances) {
    let amount;
    if (rule.type === "percent") {
      amount = fixed.times(rule.value).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    } else {
      amount = new Decimal(rule.value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }
    total = total.plus(amount);
    breakdown.push({
      label: rule.label,
      type: rule.type,
      value: rule.value,
      amount: formatAmount(amount),
    });
  }

  return { total, breakdown };
};

/**
 * OYLIKDAN USHLAB QOLISH — YALPI oylikdan (fiksa + soat + ustamalar).
 *
 * Qoidalar (biznes qarori):
 *   · percent — YALPIDAN foiz; bir nechta foiz QO'SHILADI (kompaund emas:
 *     10% + 5% = yalpining 15%), ustama foizlari bilan bir xil qoida;
 *   · fixed   — qat'iy summa;
 *   · hours   — dars soati × xodimning SOAT NARXI (toifa yoki qo'lda).
 *     Narx yo'q (faqat fiksa) xodimdan USHLANMAYDI — `noRate: true` bilan
 *     qaytadi: fiksadan "soat narxi" o'ylab topilsa, bu yangi siyosat bo'lardi;
 *   · jami ushlab qolish YALPIDAN OSHMAYDI — oylik manfiy bo'lolmaydi.
 *     Chegaraga urilgan qator `capped: true` bilan qaytadi: jim qolsa,
 *     "10% yozgan edim, nega 3% ushlandi" degan savolga javob bo'lmasdi.
 *
 * ⚠️ Chegara YARATILISH TARTIBIDA qo'llanadi (chaqiruvchi `createdAt asc`
 * beradi): avval yozilgan ushlab qolish avval to'liq olinadi.
 *
 * @param {Decimal|string|number} gross - yalpi oylik
 * @param {Array<{id: string, reason: string, type: string, value: *}>} items
 * @param {object} [options]
 * @param {Decimal|string|number} [options.perHourRate] - `hours` uchun soat narxi
 * @returns {{ total: Decimal, breakdown: Array<{id, reason, type, value, amount, capped, rate?, noRate?}> }}
 */
const computeDeductions = (gross, items = [], { perHourRate = 0 } = {}) => {
  const base = Decimal.max(new Decimal(gross || 0), 0);
  const rate = Decimal.max(new Decimal(perHourRate || 0), 0);
  let remaining = base;
  let total = new Decimal(0);
  const breakdown = [];

  for (const item of items) {
    const value = new Decimal(item.value);
    const raw = (
      item.type === "percent"
        ? base.times(value).div(100)
        : item.type === "hours"
          ? rate.times(value)
          : value
    ).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const applied = Decimal.min(raw, remaining);

    remaining = remaining.minus(applied);
    total = total.plus(applied);
    breakdown.push({
      id: item.id,
      reason: item.reason,
      type: item.type,
      value: Number(value),
      amount: formatAmount(applied),
      // Shu ushlab qolishdan KEYIN qolgan oylik — oynada "qoldi" qatori.
      // Panelda qayta hisoblanmasligi uchun shu yerda (tartib va chegara
      // aynan shu tsiklda).
      remainingAfter: formatAmount(remaining),
      capped: applied.lessThan(raw),
      ...(item.type === "hours"
        ? { rate: formatAmount(rate), noRate: rate.isZero() }
        : {}),
    });
  }

  return { total, breakdown };
};

/**
 * TYUTOR QO'SHIMCHA OYLIGI — bitta biriktirilgan guruh (sinf) uchun.
 *
 *   summa = groupAmount + perStudentAmount × o'quvchilar soni
 *
 * ⚠️ FORMULA FAQAT SHU YERDA. Oylik dvigateli ham (muhrlash), tyutor kartasi
 * ham (jonli ko'rinish) shuni chaqiradi — aks holda kartada bir raqam,
 * vedomostda boshqa raqam chiqardi.
 *
 * Foizli ustamalar bazasiga KIRMAYDI: u fiksa + soatdan hisoblanadi
 * (`payrollEngine`), tyutor summasi esa ustiga qo'shiladi.
 *
 * @param {{perStudentAmount: *, groupAmount: *}} group
 * @param {number} studentCount
 * @returns {Decimal}
 */
const computeTutorGroupAmount = (group, studentCount) =>
  new Decimal(group.groupAmount || 0)
    .plus(new Decimal(group.perStudentAmount || 0).times(Math.max(0, Number(studentCount) || 0)))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/* ─────────────────────── Kelmagan kunlar ─────────────────────── */

// Kelmagan kun deb sanaladigan davomat holatlari (biznes qarori, 2026-10-02):
// sababsiz HAM, sababli HAM. Kech kelgan — kelgan, ayirilmaydi.
const ABSENCE_STATUSES = ["absent", "excused"];

const ABSENCE_STATUS_LABELS = {
  absent: "Kelmagan",
  excused: "Sababli kelmagan",
};

/**
 * KELMAGAN KUNLAR — FIKSA oylikdan kunlik ayirma.
 *
 *   ish kunlari  = oy kunlari − yakshanbalar − bayramlar
 *   kunlik summa = fiksa ÷ ish kunlari, BUTUN SO'MGACHA PASTGA
 *   ayirma       = Σ kunlik summa har kelmagan ISH kuni uchun, fiksadan oshmaydi
 *
 * ⚠️ FORMULA FAQAT SHU YERDA: dvigatel (jonli hisob, vedomost, shakllantirish)
 * ham, muhrlangan oylikni qayta hisoblash (`recomputeSealedEntry`) ham shuni
 * chaqiradi — xodim profilida bir raqam, moliyada boshqa raqam chiqmasin.
 *
 * Qoidalar:
 *   · faqat FIKSA qism (lavozim maoshi + qo'shimcha fiksa). Soatbay qism
 *     o'tilmagan dars orqali allaqachon kamayadi, ustamalar — mustaqil qism;
 *   · yakshanba yoki bayramdagi belgi SANALMAYDI — u kun maxrajda yo'q;
 *   · bir kun bir marta (davomat `@@unique([userId, date])`, himoya qavati);
 *   · kunlik summa butun so'mgacha PASTGA yaxlitlanadi — ataylab maktab
 *     zarariga (kirish proratsiyasi `roundingUnit` bilan bir xil ruh):
 *     "kuniga 231 629,63 so'm" tushuntirib bo'lmaydigan raqam, yo'qotish esa
 *     kuniga 1 so'mdan kam. Fiksa ish kunlaridan kichik bo'lsa (kunlik 0
 *     chiqardi) 2 xonali summa olinadi — aks holda ayirma jimgina yo'qolardi;
 *   · ayirma fiksadan oshmaydi — oxirgi kun qoldiqqacha qisqaradi.
 *
 * @param {Decimal|string|number} fixedAmount - fiksa (lavozim maoshi + qo'shimcha)
 * @param {object} facts
 * @param {string[]} facts.workDays - oyning ish kunlari, "YYYY-MM-DD"
 * @param {Array<{day: string, status: string}>} facts.absences - shu xodimning
 *   kelmagan kunlari (`ABSENCE_STATUSES`)
 * @returns {{ total: Decimal, breakdown: {workDays: number, dailyRate: string,
 *   days: Array<{date: string, status: string, amount: string}>} }}
 */
const computeAbsenceDeduction = (fixedAmount, { workDays = [], absences = [] } = {}) => {
  const fixed = Decimal.max(new Decimal(fixedAmount || 0), 0);
  const workDaySet = new Set(workDays);
  let dailyRate = new Decimal(0);
  if (workDaySet.size > 0) {
    const exact = fixed.div(workDaySet.size);
    dailyRate = exact.toDecimalPlaces(0, Decimal.ROUND_DOWN);
    if (dailyRate.isZero()) dailyRate = exact.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  const counted = new Map();
  for (const row of absences) {
    if (!workDaySet.has(row.day) || !ABSENCE_STATUSES.includes(row.status)) continue;
    if (!counted.has(row.day)) counted.set(row.day, row.status);
  }

  let remaining = fixed;
  let total = new Decimal(0);
  const days = [];
  for (const day of [...counted.keys()].sort()) {
    const applied = Decimal.min(dailyRate, remaining);
    remaining = remaining.minus(applied);
    total = total.plus(applied);
    days.push({ date: day, status: counted.get(day), amount: formatAmount(applied) });
  }

  return {
    total,
    breakdown: { workDays: workDaySet.size, dailyRate: formatAmount(dailyRate), days },
  };
};

/** Ayirma tafsilotini taqqoslash kaliti — muhrni qayta yozish kerakmi. */
const absenceBreakdownKey = (breakdown) => {
  if (!breakdown || typeof breakdown !== "object" || !Array.isArray(breakdown.days)) return "";
  return JSON.stringify([
    breakdown.workDays,
    breakdown.dailyRate,
    breakdown.days.map((d) => [d.date, d.status, d.amount]),
  ]);
};

/* ─────────────────────── Oylikni to'xtatish ─────────────────────── */

const SUSPENSION_COMPONENTS = ["all", "base", "tutor", "allowances", "item"];

const SUSPENSION_COMPONENT_LABELS = {
  all: "Butun oylik",
  base: "Asosiy oylik",
  tutor: "Tyutorlik",
  allowances: "Barcha qo'shimchalar",
  item: "Qo'shimcha",
};

/**
 * Ustama qatorining BARQAROR kaliti — aniq bitta qo'shimchani to'xtatish uchun.
 *
 *   tutor  → `tutor:<classId>` (guruh id si summa o'zgarganda almashadi, sinf esa
 *            bir oyda bir tyutorda bitta — `finance.md` §10)
 *   bonus  → `bonus:<PayrollBonus.id>`
 *   qoida  → `rule:<label>` (StaffSalary.allowances da id yo'q)
 *   eski muhrdagi manbasiz qator → `label:<label>`
 */
const payUnitKeyOf = (line) => {
  if (line?.type === "tutor" && line.classId) return `tutor:${line.classId}`;
  if (line?.bonusId) return `bonus:${line.bonusId}`;
  if (line?.source === "rule") return `rule:${line.label ?? ""}`;
  return `label:${line?.label ?? ""}`;
};

/**
 * Oylik BIRLIKLARI — to'xtatish nimani nishonga olishi mumkin:
 * asosiy oylik (lavozim maoshi + dars soati) va har bir ustama qatori.
 *
 * @param {{fixedAmount:*, kpiAmount:*, allowanceBreakdown:Array}} parts
 * @returns {Array<{key:string, kind:"base"|"tutor"|"allowance", label:string, amount:Decimal}>}
 */
const buildPayUnits = ({ fixedAmount, kpiAmount, allowanceBreakdown }) => [
  {
    key: "base",
    kind: "base",
    label: SUSPENSION_COMPONENT_LABELS.base,
    amount: new Decimal(fixedAmount || 0).plus(kpiAmount || 0),
  },
  ...(Array.isArray(allowanceBreakdown) ? allowanceBreakdown : []).map((line) => ({
    key: payUnitKeyOf(line),
    kind: line?.type === "tutor" ? "tutor" : "allowance",
    label: line?.label ?? "",
    amount: new Decimal(line?.amount || 0),
  })),
];

const suspensionTargets = (suspension, unit) => {
  switch (suspension.component) {
    case "all":
      return true;
    case "base":
      return unit.kind === "base";
    case "tutor":
      return unit.kind === "tutor";
    case "allowances":
      return unit.kind === "allowance";
    case "item":
      if (unit.kind === "base") return false;
      if (unit.key === suspension.itemKey) return true;
      // Eski muhrda manba yo'q — nomi bo'yicha (faqat tyutor bo'lmagan qator)
      return unit.key.startsWith("label:") && Boolean(suspension.itemLabel) &&
        unit.label === suspension.itemLabel && !String(suspension.itemKey).startsWith("tutor:");
    default:
      return false;
  }
};

/**
 * OYLIKNI TO'XTATISH — qaysi qismlar hisoblanmaydi va qancha.
 *
 * ⚠️ FORMULA FAQAT SHU YERDA: dvigatel (jonli hisob va muhrlash) ham, muhrlangan
 * oylikni qayta hisoblash ham shuni chaqiradi.
 *
 *   to'xtatilgan = Σ nishonlangan birliklar (har birlik BIR MARTA sanaladi)
 *   to'lanadigan yalpi = yalpi − to'xtatilgan
 *
 * Qoidalar:
 *   · qismlar MUSTAQIL: foizli ustama (masalan "asosiy oylikdan 60%") asosiy
 *     oylikdan hisoblanadi va asosiy oylik to'xtatilsa ham o'zi to'xtamaydi —
 *     uni alohida to'xtatish kerak (qaysi qism to'xtashini admin tanlaydi);
 *   · bir birlikni ikki to'xtatish qamrasa, u yaratilish tartibida BIRINCHISIGA
 *     yoziladi — summa ikki marta ayirilmaydi;
 *   · ushlab qolish TO'LANADIGAN yalpidan olinadi (`computeDeductions`).
 *
 * @param {{fixedAmount:*, kpiAmount:*, allowanceBreakdown:Array}} parts
 * @param {Array<{id, component, itemKey, itemLabel, reason}>} suspensions - yaratilish tartibida
 * @returns {{ total: Decimal, breakdown: Array<{id, component, itemKey, label, reason, amount}> }}
 */
const computeSuspensions = (parts, suspensions = []) => {
  const units = buildPayUnits(parts);
  const covered = new Set();
  let total = new Decimal(0);
  const breakdown = [];

  for (const suspension of suspensions) {
    let amount = new Decimal(0);
    units.forEach((unit, index) => {
      if (covered.has(index) || !suspensionTargets(suspension, unit)) return;
      covered.add(index);
      amount = amount.plus(unit.amount);
    });
    amount = Decimal.max(amount, 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    total = total.plus(amount);
    breakdown.push({
      id: suspension.id,
      component: suspension.component,
      itemKey: suspension.itemKey || "",
      label:
        suspension.component === "item"
          ? suspension.itemLabel || SUSPENSION_COMPONENT_LABELS.item
          : SUSPENSION_COMPONENT_LABELS[suspension.component] ?? suspension.component,
      reason: suspension.reason ?? "",
      amount: formatAmount(amount),
    });
  }

  return { total, breakdown };
};

module.exports = {
  ALLOWANCE_TYPES,
  normalizeAllowances,
  computeAllowances,
  computeDeductions,
  computeTutorGroupAmount,
  ABSENCE_STATUSES,
  ABSENCE_STATUS_LABELS,
  computeAbsenceDeduction,
  absenceBreakdownKey,
  SUSPENSION_COMPONENTS,
  SUSPENSION_COMPONENT_LABELS,
  payUnitKeyOf,
  buildPayUnits,
  computeSuspensions,
};
