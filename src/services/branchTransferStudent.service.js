/**
 * O'QUVCHINI BOSHQA FILIALGA KO'CHIRISH — reja, yozuv va keyingi qadamlar.
 *
 * O'quvchi bir vaqtda faqat BITTA filialda bo'ladi: ko'chirish har doim
 * to'liq (`move`). Umumiy oqim va tranzaksiya — `branchTransfer.service.js`;
 * bu fayl faqat o'quvchiga xos qism.
 *
 * ═════════════════════════════════════════════
 * NIMA KO'CHADI, NIMA QOLADI
 *
 *   KO'CHADI (odamning hozirgi holati):
 *     login va profil (AYNI `id`), profil rasmi, sinf, o'qish davri,
 *     tarif va chegirma (kelajak oylari uchun), muzlatish va oy override'i
 *     (kelajak oylari), tanga qoldig'i (ikki tomonda yozuv bilan),
 *     faol premium, ota-ona nazorati (PIN, qurilmalar, statistika),
 *     Telegram bog'lanishi.
 *
 *   QOLADI (manba filialning FAKTI):
 *     baholar, davomat, testlar — baho o'qituvchi oyligiga bog'langan
 *     (dars "o'tildimi"), ko'chirilsa manba filial o'qituvchisining soati
 *     jimgina kamayardi; hisob-faktura, to'lov, depozit, qaytarish — kassa
 *     qoldig'iga bog'langan, ko'chirilsa manba filial kassasi buzilardi.
 *     Qarz va depozit manba filialda qoladi va oldindan ko'rishda aytiladi.
 *
 *   MANBA FILIALDA: profil ARXIVLANADI (qatori o'chirilmaydi — tarix unga
 *     ishora qiladi), arxivdan qaytarib bo'lmaydi (uy filiali boshqa).
 * ═════════════════════════════════════════════
 *
 * ⚠️ OY BITTA FILIALDA HISOBLANADI. Ko'chish sanasi T — maqsad filialdagi
 * birinchi kun, manbada oxirgi kun T−1. "Chiqishda proratsiya yo'q"
 * (`finance.md` §3): manba T oyining birorta kunini qamragan bo'lsa, o'sha
 * oyni TO'LIQ hisoblaydi va maqsad filial to'lovni KEYINGI oydan boshlaydi.
 * T oyning 1-kuni bo'lsa — oyni maqsad hisoblaydi, manbadagi o'sha oy
 * hisob-fakturasi bekor qilinadi (to'langani manba depozitiga qaytadi).
 * Shu tufayli bitta oy ikki filialda ikki marta yozilmaydi.
 */

const { generateId } = require("../utils/idGenerator");
const { ROLES } = require("../utils/constants");
const logger = require("../utils/logger");
const { runWithBranch } = require("../config/branchContext");
const {
  qualified,
  schemaType,
  copyRows,
  copyRowsWithNewIds,
  deleteRows,
  moveRows,
} = require("../helpers/crossSchema.helpers");
const {
  monthKeyOfDate,
  monthStartDate,
  nextMonth,
  prevMonth,
  formatMonthKey,
} = require("../helpers/month.helpers");
const { Decimal, formatAmount, formatSum, sumAmounts } = require("../helpers/money.helpers");
const { formatDateUz } = require("../helpers/date.helpers");
const {
  planStudentFinance,
  writeStudentFinance,
} = require("./branchTransferFinance.service");
const {
  planStudentHistory,
  writeStudentHistory,
} = require("./branchTransferHistory.service");
const {
  snapshotMissedLessons,
  creditLostLessons,
} = require("./branchTransferSchedule.service");

/** Ota-ona nazorati jadvallari — hammasi `student_id` bilan, filial ma'lumotiga ishora qilmaydi. */
const PARENTAL_TABLES = [
  "parental_settings",
  "parental_devices",
  "parental_apps",
  "app_usage_daily",
  "parental_events",
  "parental_unlock_requests",
];

const dayLabel = (date) => formatDateUz(date, { utc: true });

/**
 * O'qish davrlarining ko'chirishdan KEYINGI holati (manba filialda).
 *
 *   T dan oldin boshlangan va T yoki undan keyin tugaydigan (yoki ochiq) davr
 *   → T−1 da yopiladi; T yoki undan keyin boshlangan davr → o'chiriladi
 *   (u manba filialda hech qachon boshlanmagan — masalan, xato filialga
 *   qo'shilgan o'quvchi shu kuni ko'chirilmoqda).
 *
 * @returns {{kept: Array, closing: Array, deleting: Array, coversTransferMonth: boolean}}
 */
const planSourcePeriods = (periods, day) => {
  const lastDay = new Date(day.getTime() - 86400000);
  const monthStart = monthStartDate(monthKeyOfDate(day));
  const kept = [];
  const closing = [];
  const deleting = [];

  for (const period of periods) {
    if (period.startDate >= day) {
      deleting.push(period);
      continue;
    }
    if (period.endDate == null || period.endDate >= day) {
      closing.push(period);
      kept.push({ ...period, endDate: lastDay });
    } else {
      kept.push(period);
    }
  }

  // Manba T oyining birorta kunini qamraydimi (T−1 ≥ oy boshi)?
  const coversTransferMonth = kept.some(
    (p) => p.endDate != null && p.endDate >= monthStart && p.startDate <= p.endDate,
  );

  return { kept, closing, deleting, coversTransferMonth };
};

/** Davr qatori `boundary` va undan keyingi oylarni qamraydimi? */
const coversFrom = (row, boundary) => row.endMonth == null || row.endMonth >= boundary;

/** Nusxa qatorlari maqsadda qamraydigan birinchi oy (`null` — nusxa yo'q). */
const firstCoveredMonth = (rows, boundary) =>
  rows.length ? Math.max(boundary, Math.min(...rows.map((r) => r.startMonth))) : null;

/**
 * Chegaradan boshlab amal qiladigan qatorlar — kesishuv HAL QILINADIGAN
 * jadvallar uchun (tarif: "eng kech boshlangani yutadi").
 *
 * Chegarani qamragan bir nechta qatordan faqat G'OLIB olinadi: nusxada
 * hammasi chegaradan boshlanadi va `(student_id, start_month)` yagona
 * kalitida to'qnashardi. Chegaradan keyin boshlanganlar o'z holicha.
 */
const effectiveFrom = (rows, boundary) => {
  const live = rows.filter((r) => coversFrom(r, boundary));
  const covering = live
    .filter((r) => r.startMonth <= boundary)
    .sort((a, b) => b.startMonth - a.startMonth);
  return [...covering.slice(0, 1), ...live.filter((r) => r.startMonth > boundary)];
};

/**
 * O'quvchilar rejasi. `db` — platforma client'i (oldindan ko'rish) yoki
 * filiallararo tranzaksiya (yozish oldidan AYNI reja qayta quriladi va
 * xeshi solishtiriladi).
 *
 * @param {object} db
 * @param {object} ctx - `branchTransfer.service.js` → `buildContext`
 * @param {string[]} studentIds
 * @param {object} options
 * @param {Map<string, string[]>} [options.targetClassIds] - studentId → maqsad sinflar
 * @param {"keep"|"targetDefault"} options.tariffMode
 * @param {boolean} options.keepDiscounts
 * @returns {Promise<{items: Array, acknowledgements: Array}>}
 */
const planStudents = async (db, ctx, studentIds, options) => {
  const ids = [...new Set(studentIds)].sort();
  const src = (t) => qualified(ctx.source.schemaName, t);
  const tgt = (t) => qualified(ctx.target.schemaName, t);
  const plat = (t) => qualified(ctx.platformSchema, t);
  const q = (sql, ...params) => db.$queryRawUnsafe(sql, ...params);
  const byStudent = (rows, key = "studentId") => {
    const map = new Map();
    for (const row of rows) {
      const id = String(row[key]);
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(row);
    }
    return map;
  };

  const month = ctx.month;

  // Ketma-ket o'qiladi: tranzaksiya bitta ulanishda, parallel so'rov bermaydi
  const users = await q(
    `SELECT id, username, first_name AS "firstName", last_name AS "lastName", role,
            is_archived AS "isArchived", coin_balance AS "coinBalance",
            profile_picture AS "profilePicture"
     FROM ${src("users")} WHERE id = ANY($1::text[]) ORDER BY id`,
    ids,
  );
  const directory = await q(
    `SELECT id, branch_id AS "branchId" FROM ${plat("user_directory")} WHERE id = ANY($1::text[])`,
    ids,
  );
  const targetRows = await q(
    `SELECT id, is_archived AS "isArchived", role FROM ${tgt("users")} WHERE id = ANY($1::text[])`,
    ids,
  );
  const usernameClashes = await q(
    `SELECT id, username FROM ${tgt("users")}
     WHERE username = ANY($1::text[]) AND NOT (id = ANY($2::text[]))`,
    users.map((u) => u.username),
    ids,
  );
  const periods = await q(
    `SELECT id, student_id AS "studentId", start_date AS "startDate", end_date AS "endDate"
     FROM ${src("student_enrollments")} WHERE student_id = ANY($1::text[])
     ORDER BY student_id, start_date`,
    ids,
  );
  const targetPeriods = await q(
    `SELECT student_id AS "studentId", start_date AS "startDate", end_date AS "endDate"
     FROM ${tgt("student_enrollments")}
     WHERE student_id = ANY($1::text[]) AND (end_date IS NULL OR end_date >= $2::date)`,
    ids,
    ctx.dayIso,
  );
  const memberships = await q(
    `SELECT uc.user_id AS "studentId", c.id, c.name
     FROM ${src("user_classes")} uc JOIN ${src("classes")} c ON c.id = uc.class_id
     WHERE uc.user_id = ANY($1::text[]) ORDER BY c.name`,
    ids,
  );
  const tariffs = await q(
    `SELECT id, student_id AS "studentId", tariff_id AS "tariffId", start_month AS "startMonth",
            end_month AS "endMonth"
     FROM ${src("student_tariffs")}
     WHERE student_id = ANY($1::text[]) AND (end_month IS NULL OR end_month >= $2)
     ORDER BY student_id, start_month`,
    ids,
    month,
  );
  const discounts = await q(
    `SELECT id, student_id AS "studentId", discount_id AS "discountId", start_month AS "startMonth",
            end_month AS "endMonth"
     FROM ${src("student_discounts")}
     WHERE student_id = ANY($1::text[]) AND (end_month IS NULL OR end_month >= $2)
     ORDER BY student_id, start_month, discount_id`,
    ids,
    month,
  );
  const statuses = await q(
    `SELECT id, student_id AS "studentId", status::text AS status, start_month AS "startMonth",
            end_month AS "endMonth"
     FROM ${src("student_finance_statuses")}
     WHERE student_id = ANY($1::text[]) AND (end_month IS NULL OR end_month >= $2)
     ORDER BY student_id, start_month`,
    ids,
    month,
  );
  const services = await q(
    `SELECT ss.id, ss.student_id AS "studentId", sv.name, ss.start_month AS "startMonth",
            ss.end_month AS "endMonth"
     FROM ${src("student_services")} ss JOIN ${src("services")} sv ON sv.id = ss.service_id
     WHERE ss.student_id = ANY($1::text[]) AND (ss.end_month IS NULL OR ss.end_month >= $2)
     ORDER BY ss.student_id, ss.start_month`,
    ids,
    month,
  );
  const overrides = await q(
    `SELECT id, student_id AS "studentId", month FROM ${src("student_month_overrides")}
     WHERE student_id = ANY($1::text[]) AND month >= $2 ORDER BY student_id, month`,
    ids,
    month,
  );
  // ⚠️ Hisob-faktura va depozit bu yerda O'QILMAYDI: ular moliyaviy
  // holat yadrosida (`planStudentFinance`) — bitta joyda o'qilib, bitta
  // joyda hal qilinadi. Ikkita o'quvchi bo'lsa, biri qarzni "qoladi", biri
  // "ko'chadi" deb hisoblab qo'yishi mumkin edi.
  const openOrders = await q(
    `SELECT student_id AS "studentId", COUNT(*)::int AS n FROM ${src("market_orders")}
     WHERE student_id = ANY($1::text[]) AND status IN ('pending', 'delivering')
     GROUP BY student_id`,
    ids,
  );
  const liveTests = await q(
    `SELECT student_id AS "studentId", COUNT(*)::int AS n FROM ${src("test_sessions")}
     WHERE student_id = ANY($1::text[]) AND status = 'in_progress' AND expires_at > NOW()
     GROUP BY student_id`,
    ids,
  );
  const damages = await q(
    `SELECT person_id AS "studentId", SUM(amount - paid_amount)::text AS due
     FROM ${src("damage_charges")}
     WHERE person_id = ANY($1::text[]) AND status IN ('unpaid', 'partial')
     GROUP BY person_id`,
    ids,
  );
  const devices = await q(
    `SELECT student_id AS "studentId", COUNT(*)::int AS n FROM ${src("student_devices")}
     WHERE student_id = ANY($1::text[]) AND status <> 'removed' GROUP BY student_id`,
    ids,
  );
  const parental = await q(
    `SELECT student_id AS "studentId" FROM ${src("parental_settings")}
     WHERE student_id = ANY($1::text[])`,
    ids,
  );
  const telegram = await q(
    `SELECT s.student AS "studentId", COUNT(*)::int AS n,
            COUNT(t.id)::int AS clashes
     FROM ${src("tg_users")} s
     LEFT JOIN ${tgt("tg_users")} t ON t.telegram_id = s.telegram_id AND t.student <> s.student
     WHERE s.student = ANY($1::text[]) GROUP BY s.student`,
    ids,
  );
  const premiums = await q(
    `SELECT student AS "studentId", COUNT(*)::int AS n FROM ${src("premiums")}
     WHERE student = ANY($1::text[]) AND status = 'active' AND end_date > NOW()
     GROUP BY student`,
    ids,
  );
  const [targetSettings] = await q(
    `SELECT default_tariff_id AS "defaultTariffId" FROM ${tgt("finance_settings")} LIMIT 1`,
  );

  const catalogIds = [...new Set([
    ...tariffs.map((r) => r.tariffId),
    ...(targetSettings?.defaultTariffId ? [targetSettings.defaultTariffId] : []),
  ])];
  const tariffNames = new Map(
    (catalogIds.length
      ? await q(`SELECT id, name FROM ${plat("tariffs")} WHERE id = ANY($1::text[])`, catalogIds)
      : []
    ).map((r) => [r.id, r.name]),
  );
  const discountNames = new Map(
    (discounts.length
      ? await q(
          `SELECT id, name FROM ${plat("discounts")} WHERE id = ANY($1::text[])`,
          [...new Set(discounts.map((r) => r.discountId))],
        )
      : []
    ).map((r) => [r.id, r.name]),
  );

  const userById = new Map(users.map((u) => [u.id, u]));
  const homeOf = new Map(directory.map((d) => [d.id, d.branchId]));
  const targetRowOf = new Map(targetRows.map((r) => [r.id, r]));
  const clashByUsername = new Map(usernameClashes.map((r) => [r.username, r]));
  const periodsOf = byStudent(periods);
  const targetPeriodsOf = byStudent(targetPeriods);
  const classesOf = byStudent(memberships);
  const tariffsOf = byStudent(tariffs);
  const discountsOf = byStudent(discounts);
  const statusesOf = byStudent(statuses);
  const servicesOf = byStudent(services);
  const overridesOf = byStudent(overrides);
  const count = (rows) => new Map(rows.map((r) => [String(r.studentId), r]));
  const ordersOf = count(openOrders);
  const testsOf = count(liveTests);
  const damageOf = count(damages);
  const devicesOf = count(devices);
  const telegramOf = count(telegram);
  const premiumOf = count(premiums);
  const parentalSet = new Set(parental.map((r) => String(r.studentId)));

  const defaultTariffId = targetSettings?.defaultTariffId ?? null;

  // ── O'qish davri → CHEGARA OYI (maqsad filial hisoblay boshlaydigan oy) ──
  //
  // Chegara moliya va tarix rejalaridan OLDIN kerak, shuning uchun u alohida
  // o'tishda hisoblanadi: `planSourcePeriods` sof funksiya (faqat davrlar va
  // ko'chish kuni), ya'ni ikki marta chaqirish xavfsiz emas — bir marta
  // chaqirilib, natijasi quyidagi tsiklda ham ishlatiladi.
  const periodPlanOf = new Map(
    ids.map((id) => [id, planSourcePeriods(periodsOf.get(id) ?? [], ctx.day)]),
  );
  const boundaryOf = new Map(
    ids.map((id) => [id, periodPlanOf.get(id).coversTransferMonth ? nextMonth(month) : month]),
  );

  // Moliyaviy holat (qarz + depozit) va ta'lim tarixi — alohida yadrolar
  const financeOf = await planStudentFinance(db, ctx, ids, boundaryOf);
  const historyOf = await planStudentHistory(db, ctx, ids);
  const historyCatalog = historyOf.get("__catalog__");

  const items = [];

  for (const id of ids) {
    const user = userById.get(id);
    const blockers = [];
    const warnings = [];
    const notes = [];

    if (!user) {
      items.push({
        id,
        label: "Noma'lum",
        status: "blocked",
        blockers: ["Bu filialda bunday o'quvchi topilmadi"],
        warnings,
        notes,
      });
      continue;
    }

    const label = `${user.firstName} ${user.lastName ?? ""}`.trim();

    if (user.role !== ROLES.STUDENT) blockers.push("Bu o'quvchi emas — xodimlar alohida ko'chiriladi");
    if (user.isArchived) blockers.push("O'quvchi arxivlangan");
    if (homeOf.has(id) && homeOf.get(id) !== ctx.source.id) {
      blockers.push("O'quvchi bu filialda o'qimaydi (u boshqa filialga ko'chirilgan)");
    }
    const clash = clashByUsername.get(user.username);
    if (clash) {
      blockers.push(
        `"${ctx.target.name}" filialida "${user.username}" logini bilan boshqa (eski) yozuv bor — ` +
          "avval uni o'sha filialda hal qiling",
      );
    }
    if ((targetPeriodsOf.get(id) ?? []).length > 0) {
      blockers.push(
        `"${ctx.target.name}" filialida bu o'quvchining ochiq yoki ko'chish sanasidan keyin ` +
          "tugaydigan o'qish davri bor — ma'lumot noto'g'ri, avval uni tuzating",
      );
    }
    const orders = ordersOf.get(id)?.n ?? 0;
    if (orders > 0) {
      blockers.push(
        `Do'konda ${orders} ta yakunlanmagan buyurtmasi bor (tangalar band) — avval yakunlang yoki bekor qiling`,
      );
    }
    const tests = testsOf.get(id)?.n ?? 0;
    if (tests > 0) blockers.push("Hozir test yechyapti — test tugagach ko'chiring");

    // ── O'qish davri va oylar ──
    const sourcePeriods = periodsOf.get(id) ?? [];
    const plan = periodPlanOf.get(id);
    const boundary = boundaryOf.get(id);

    if (sourcePeriods.length === 0) {
      notes.push("Bu filialda o'qish davri yo'q edi — yangi filialda davr ochiladi");
    }
    if (plan.deleting.length > 0) {
      notes.push(
        `O'qish davri ${dayLabel(plan.deleting[0].startDate)} dan boshlangan — bu filialda ` +
          "hech bir kun o'qimagan, davr olib tashlanadi",
      );
    }
    notes.push(
      plan.coversTransferMonth
        ? `${formatMonthKey(month)} — bu filialda to'liq hisoblanadi; yangi filialda to'lov ` +
            `${formatMonthKey(boundary)} dan boshlanadi`
        : `${formatMonthKey(month)} — yangi filialda hisoblanadi`,
    );

    // ── MOLIYAVIY HOLAT: qarz va depozit O'QUVCHI BILAN KETADI ──
    //
    // Qarz — bekor qilinib, maqsadda AYNI muhrlangan tarkib bilan qayta
    // ochiladi. Depozit — HAQIQIY PUL sifatida kassadan kassaga.
    // Yadro: `branchTransferFinance.service.js`.
    const finance = financeOf.get(id);
    const damageDue = new Decimal(damageOf.get(id)?.due ?? 0);

    if (finance.debtMonths.length > 0) {
      notes.push(
        `Qarz ko'chadi: ${finance.debtMonths.map(formatMonthKey).join(", ")} ` +
          `(${formatSum(finance.debtAmount)}) — yangi filial qarzdorlar ro'yxatiga o'tadi`,
      );
    }
    if (finance.blockedMonths.length > 0) {
      warnings.push(
        `${finance.blockedMonths.map(formatMonthKey).join(", ")} yangi filialda ALLAQACHON ` +
          "hisoblangan — o'sha oy(lar)ning qarzi shu filialda qoladi (ikki marta yozilmasligi uchun)",
      );
    }
    if (new Decimal(finance.deposit).greaterThan(0)) {
      notes.push(
        `Depozit ko'chadi: ${formatSum(finance.deposit)}` +
          (new Decimal(finance.nonCashTotal).greaterThan(0)
            ? ` (shundan ${formatSum(finance.cashTotal)} kassadan kassaga o'tadi, ` +
              `${formatSum(finance.nonCashTotal)} — qo'lda to'g'rilash puli, faqat balans)`
            : " — manba kassasidan chiqib, yangi filial kassasiga kiradi"),
      );
    }
    if (finance.missingTargetAccount) {
      blockers.push(
        `"${ctx.target.name}" filialida faol to'lov turi yo'q — depozitni o'tkazib bo'lmaydi; ` +
          "avval o'sha filialda to'lov turi oching",
      );
    }
    if (finance.settledMonths.length > 0) {
      notes.push(
        `To'langan ${finance.settledMonths.length} ta oy va ularning cheklari shu filial ` +
          "tarixi bo'lib qoladi (pul allaqachon shu kassaga tushgan)",
      );
    }
    if (finance.vacatingMonths.length > 0) {
      notes.push(
        `${finance.vacatingMonths.map(formatMonthKey).join(", ")} — bu filialda bekor ` +
          "qilinadi, o'sha oy yangi filialda hisoblanadi",
      );
    }

    // ── TA'LIM TARIXI ──
    const history = historyOf.get(id);
    if (history.grades > 0 || history.attendance > 0) {
      notes.push(
        `Tarix ko'chadi: ${history.grades} ta baho, ${history.attendance} ta davomat` +
          (history.achievements ? `, ${history.achievements} ta yutuq` : "") +
          (history.penalties ? `, ${history.penalties} ta jarima/rag'bat` : ""),
      );
    }
    if (history.testsStaying > 0) {
      warnings.push(
        `${history.testsStaying} ta test natijasi KO'CHMAYDI — ular shu filialning test ` +
          "mavsumi va savollar bazasiga bog'langan, o'sha filial tarixida qoladi",
      );
    }

    // ── Kelajak qoidalari ──
    const carryTariffs = effectiveFrom(tariffsOf.get(id) ?? [], boundary);
    let tariffPlan;
    if (options.tariffMode === "targetDefault" && defaultTariffId) {
      tariffPlan = { mode: "default", tariffId: defaultTariffId, rows: [] };
      notes.push(`Tarif: "${tariffNames.get(defaultTariffId) ?? "standart"}" (yangi filial standarti)`);
    } else {
      if (options.tariffMode === "targetDefault") {
        warnings.push("Yangi filialda standart tarif belgilanmagan — joriy tarif saqlanadi");
      }
      if (carryTariffs.length > 0) {
        tariffPlan = { mode: "keep", rows: carryTariffs };
        notes.push(
          `Tarif: ${[...new Set(carryTariffs.map((r) => tariffNames.get(r.tariffId) ?? "tarif"))]
            .map((n) => `"${n}"`).join(", ")} saqlanadi`,
        );
      } else if (defaultTariffId) {
        tariffPlan = { mode: "default", tariffId: defaultTariffId, rows: [] };
        notes.push(
          `Tarifi yo'q edi — yangi filial standarti "${tariffNames.get(defaultTariffId) ?? "standart"}" biriktiriladi`,
        );
      } else {
        tariffPlan = { mode: "none", rows: [] };
        warnings.push("Tarifi yo'q — yangi filialda tarif biriktirilmaguncha hisob-faktura yozilmaydi");
      }
    }

    const carryDiscounts = options.keepDiscounts
      ? (discountsOf.get(id) ?? []).filter((r) => coversFrom(r, boundary))
      : [];
    if (carryDiscounts.length > 0) {
      notes.push(
        `Chegirma: ${[...new Set(carryDiscounts.map((r) => discountNames.get(r.discountId) ?? "chegirma"))]
          .map((n) => `"${n}"`).join(", ")} saqlanadi`,
      );
    }
    const carryStatuses = effectiveFrom(statusesOf.get(id) ?? [], boundary);
    const carryOverrides = (overridesOf.get(id) ?? []).filter((r) => r.month >= boundary);
    const droppedServices = (servicesOf.get(id) ?? []).filter((r) => coversFrom(r, boundary));
    if (droppedServices.length > 0) {
      warnings.push(
        `Qo'shimcha xizmatlar (${[...new Set(droppedServices.map((r) => r.name))].join(", ")}) ` +
          "ko'chmaydi — ular filialning o'z katalogi, yangi filialda qayta biriktiriladi",
      );
    }

    // ── Shaxsiy holat ──
    const coins = Number(user.coinBalance ?? 0);
    if (coins !== 0) notes.push(`Tanga qoldig'i: ${coins} — yozuv bilan ko'chadi`);
    if (parentalSet.has(id)) notes.push("Ota-ona nazorati (PIN, qurilmalar) ko'chadi");
    const tg = telegramOf.get(id);
    if (tg?.n) {
      notes.push(`Telegram bog'lanishi (${tg.n} ta) ko'chadi`);
      if (tg.clashes > 0) {
        warnings.push(
          `${tg.clashes} ta Telegram akkaunt yangi filialda boshqa o'quvchiga bog'langan — u ko'chmaydi`,
        );
      }
    }
    if (premiumOf.get(id)?.n) notes.push("Faol premium ko'chadi");
    const deviceCount = devicesOf.get(id)?.n ?? 0;
    if (deviceCount > 0) {
      warnings.push(
        `${deviceCount} ta qurilma chekovdan chiqariladi — yangi filialda o'quvchi qurilmani kod bilan qayta ulaydi`,
      );
    }

    const classes = (classesOf.get(id) ?? []).map((c) => ({ id: c.id, name: c.name }));
    const targetClassIds = options.targetClassIds?.get(id) ?? [];
    if (targetClassIds.length === 0) {
      notes.push("Yangi filialda sinfga biriktirilmaydi — keyin qo'lda belgilanadi");
    }

    items.push({
      id,
      label,
      username: user.username,
      role: user.role,
      status: blockers.length ? "blocked" : "ready",
      blockers,
      warnings,
      notes,
      classes,
      // ── Ekranda ko'rinadigan hisob ──
      finance: {
        // Ko'chadigan qarz (manbada qoladigan qarz endi YO'Q: ochiq oylar
        // yo ko'chadi, yo — maqsadda band bo'lsa — shu yerda qoladi)
        debt: finance.debtAmount,
        debtMonths: finance.debtMonths.map(formatMonthKey),
        stayingDebtMonths: finance.blockedMonths.map(formatMonthKey),
        deposit: finance.deposit,
        cash: finance.cashTotal,
        settledMonths: finance.settledMonths.length,
        settledAmount: finance.settledAmount,
        damageDue: formatAmount(damageDue),
      },
      history: {
        grades: history.grades,
        attendance: history.attendance,
        achievements: history.achievements,
        penalties: history.penalties,
        testsStaying: history.testsStaying,
      },
      // ── Yozuv uchun (mijozga ham ketadi — hisob shaffof bo'lsin) ──
      plan: {
        boundary,
        boundaryLabel: formatMonthKey(boundary),
        coversTransferMonth: plan.coversTransferMonth,
        closingPeriodIds: plan.closing.map((p) => p.id),
        deletingPeriodIds: plan.deleting.map((p) => p.id),
        // Moliyaviy holat rejasi — yozuv AYNAN shundan boradi va u reja
        // XESHIGA kiradi: oraliqda to'lov tushsa yoki oy yopilsa 409
        finance,
        tariff: {
          mode: tariffPlan.mode,
          tariffId: tariffPlan.tariffId ?? null,
          rowIds: tariffPlan.rows.map((r) => r.id),
          // Maqsadda nusxa qamraydigan birinchi oy (eski qoidalar shundan kesiladi)
          from:
            tariffPlan.mode === "keep"
              ? firstCoveredMonth(tariffPlan.rows, boundary)
              : tariffPlan.mode === "default"
                ? boundary
                : null,
        },
        discountIds: carryDiscounts.map((r) => r.id),
        discountFrom: firstCoveredMonth(carryDiscounts, boundary),
        statusIds: carryStatuses.map((r) => r.id),
        statusFrom: firstCoveredMonth(carryStatuses, boundary),
        overrideIds: carryOverrides.map((r) => r.id),
        overrideMonths: carryOverrides.map((r) => r.month),
        serviceIds: droppedServices.map((r) => r.id),
        targetClassIds,
        coins,
        profilePicture: user.profilePicture ?? null,
        returning: targetRowOf.has(id),
        deviceCount,
      },
    });
  }

  // ── Tasdiqlanishi SHART bo'lgan oqibatlar (server ham tekshiradi) ──
  const ready = items.filter((item) => item.status === "ready");
  const acknowledgements = [];

  const debtors = ready.filter((item) => new Decimal(item.finance.debt).greaterThan(0));
  if (debtors.length) {
    acknowledgements.push({
      code: "debt_moves",
      title: "Qarz yangi filialga o'tadi",
      message:
        `${debtors.length} ta o'quvchining to'lanmagan oylari (jami ` +
        `${formatSum(sumAmounts(debtors.map((i) => i.finance.debt)))}) shu filialda bekor ` +
        "qilinadi va yangi filialda AYNI summa bilan qayta ochiladi: endi u yangi filial " +
        "qarzdorlar ro'yxatida turadi va o'sha filial kassasiga to'lanadi.",
    });
  }

  const depositors = ready.filter((item) => new Decimal(item.finance.deposit).greaterThan(0));
  if (depositors.length) {
    const cash = sumAmounts(depositors.map((i) => i.finance.cash));
    acknowledgements.push({
      code: "deposit_moves",
      title: "Depozit haqiqiy pul bilan o'tadi",
      message:
        `${depositors.length} ta o'quvchining depoziti (jami ` +
        `${formatSum(sumAmounts(depositors.map((i) => i.finance.deposit)))}) yangi filialga ` +
        `o'tkaziladi. Shundan ${formatSum(cash)} KASSADAN CHIQADI va yangi filial kassasiga ` +
        "kiradi (\"Boshqa filialga ko'chib ketdi\" yozuvi bilan) — ya'ni shu filialning " +
        "qoldig'i shuncha kamayadi. Yangi filialda pul darhol o'sha o'quvchining qarziga yechiladi.",
    });
  }

  const withSettled = ready.filter((item) => item.finance.settledMonths > 0);
  if (withSettled.length) {
    acknowledgements.push({
      code: "receipts_stay",
      title: "To'langan oylar va cheklar shu filialda qoladi",
      message:
        "To'lab bo'lingan oylar va ularning cheklari shu filial tarixi bo'lib qoladi: o'sha " +
        "pul shu kassaga tushgan va allaqachon sarflangan (oylik, xarajat), uni ko'chirish " +
        "shu filial kassasini minusga tushirardi. Ular yangi filialda o'quvchining " +
        "\"Boshqa filiallardagi moliya tarixi\" bo'limida to'liq ko'rinadi.",
    });
  }

  const withHistory = ready.filter(
    (item) => item.history.grades > 0 || item.history.attendance > 0,
  );
  if (withHistory.length) {
    acknowledgements.push({
      code: "academic_history_moves",
      title: "Baho va davomat yangi filialga ko'chadi",
      message:
        `${withHistory.length} ta o'quvchining baholari, davomati, yutuq va jarimalari yangi ` +
        "filialga o'tadi (sinf va fan NOMI bo'yicha moslanadi, yo'q bo'lsa ochiladi). " +
        "⚠️ Shu filialning o'tgan davrlar bo'yicha o'rtacha baho va davomat hisobotlari " +
        "shunga mos ravishda o'zgaradi. Ko'chgan baho yangi filialda hech kimning dars " +
        "soatiga (oyligiga) qo'shilmaydi.",
    });
  }

  const catalogNotes = [];
  if (historyCatalog?.newSubjects.length) {
    catalogNotes.push(`fan: ${historyCatalog.newSubjects.join(", ")}`);
  }
  if (historyCatalog?.newClasses.length) {
    catalogNotes.push(`sinf: ${historyCatalog.newClasses.join(", ")}`);
  }
  if (catalogNotes.length && withHistory.length) {
    acknowledgements.push({
      code: "catalog_created",
      title: "Yangi filialda katalog qatorlari ochiladi",
      message:
        `Tarix joylashishi uchun yangi filialda quyidagilar ochiladi — ${catalogNotes.join("; ")}. ` +
        "Sinflar NOFAOL holda ochiladi: ular faqat ko'chgan tarixni ushlab turadi, joriy " +
        "sinflar ro'yxatiga va jurnalga kirmaydi.",
    });
  }

  const withTests = ready.filter((item) => item.history.testsStaying > 0);
  if (withTests.length) {
    acknowledgements.push({
      code: "tests_stay",
      title: "Test natijalari ko'chmaydi",
      message:
        `${withTests.length} ta o'quvchining test natijalari shu filialda qoladi: ular shu ` +
        "filialning test mavsumi, savollar bazasi va biriktirishlariga bog'langan — bitta " +
        "o'quvchi bilan ajratib ko'chirib bo'lmaydi.",
    });
  }

  if (ready.some((item) => item.plan.finance.vacatingMonths.length > 0)) {
    acknowledgements.push({
      code: "invoices_cancelled",
      title: "Ortiqcha hisob-faktura bekor qilinadi",
      message:
        "O'quvchi bu filialda o'qimaydigan oylarning hisob-fakturasi bekor qilinadi — " +
        "o'sha oy yangi filialda hisoblanadi.",
    });
  }
  if (ready.some((item) => item.plan.deviceCount > 0)) {
    acknowledgements.push({
      code: "devices_released",
      title: "Qurilmalar chekovdan chiqadi",
      message:
        "O'quvchi telefonidagi maktab cheklovi olib tashlanadi. Yangi filialda u qurilmasini " +
        "o'z hisobidan, bir martalik kod bilan qayta ulaydi (rozilik qoidasi).",
    });
  }

  return { items, acknowledgements, historyCatalog };
};

/**
 * Davr jadvalini chegaraga moslaydi: `boundary` dan boshlanadiganlar
 * o'chiriladi (reja), uni qamraganlari oldingi oyda yopiladi (o'tgan oylar
 * muhrlangan) — `applyDefaultToAll` doktrinasi.
 */
const trimPeriods = async (db, schema, table, studentIds, boundary) => {
  if (studentIds.length === 0) return;
  await deleteRows(db, {
    schema,
    table,
    where: `s."student_id" = ANY($1::text[]) AND s."start_month" >= $2`,
    params: [studentIds, boundary],
  });
  await db.$executeRawUnsafe(
    `UPDATE ${qualified(schema, table)} SET end_month = $3, updated_at = NOW()
     WHERE student_id = ANY($1::text[]) AND start_month < $2
       AND (end_month IS NULL OR end_month >= $2)`,
    studentIds,
    boundary,
    prevMonth(boundary),
  );
};

/**
 * Rejani BITTA tranzaksiyada yozadi. Chaqiruvchi rejani shu tranzaksiyada
 * qayta qurgan va xeshini tekshirgan.
 *
 * @param {object} db - filiallararo tranzaksiya
 * @param {object} ctx
 * @param {Array} items - faqat `ready` qatorlar
 * @returns {Promise<Map<string, object>>} studentId → nima ko'chdi (jadval → qator soni)
 */
const writeStudents = async (db, ctx, items, historyCatalog = null) => {
  const from = ctx.source.schemaName;
  const to = ctx.target.schemaName;
  const src = (t) => qualified(from, t);
  const tgt = (t) => qualified(to, t);
  const plat = (t) => qualified(ctx.platformSchema, t);
  const exec = (sql, ...params) => db.$executeRawUnsafe(sql, ...params);
  const ids = items.map((item) => item.id);
  const moved = new Map(ids.map((id) => [id, {}]));
  const note = (key, value) => {
    for (const id of ids) moved.get(id)[key] = value;
  };

  // 1 ── Profil rasmi (FK `users.profile_picture` → `images`) — profildan OLDIN
  const pictureIds = [...new Set(items.map((i) => i.plan.profilePicture).filter(Boolean))];
  if (pictureIds.length) {
    await copyRows(db, ctx.cache, {
      from,
      to,
      table: "images",
      where: `s."id" = ANY($1::text[])`,
      params: [pictureIds],
      onConflict: "nothing",
    });
  }

  // 2 ── Profil: AYNI `id` bilan. Odam ilgari maqsad filialda bo'lgan bo'lsa
  // (qaytib kelyapti) — o'sha qator joriy holat bilan almashtiriladi.
  await copyRows(db, ctx.cache, {
    from,
    to,
    table: "users",
    where: `s."id" = ANY($1::text[])`,
    params: [ids],
    override: {
      is_archived: "false",
      archived_at: "NULL",
      archive_snapshot: "NULL",
      archive_note: "NULL",
      updated_at: "NOW()",
      // ⚠️ HAQIQIY SINF — manbadagi sinf ID si MAQSADDA MAVJUD EMAS
      // (`classes` har filialda o'ziniki): nusxa ko'chirilsa FK buzilib,
      // butun ko'chirish yiqilardi. Shuning uchun avval tozalanadi, keyin
      // NOMI bo'yicha moslanadi (pastda).
      actual_class_id: "NULL",
    },
    onConflict: "update",
  });

  // 2a ── Haqiqiy sinf: maqsadda AYNI NOMLI sinf bo'lsa tiklanadi.
  //
  // Moslash TAXMIN QILMAYDI (`education.md` §10 doktrinasi): faqat qat'iy
  // teng nom. Mos sinf bo'lmasa belgi bo'sh qoladi va admin uni qo'lda
  // qo'yadi — noto'g'ri sinfni "taxmin qilib" yozishdan ko'ra yaxshiroq.
  await exec(
    `UPDATE ${tgt("users")} u
     SET actual_class_id = tc.id
     FROM ${src("users")} su
     JOIN ${src("classes")} sc ON sc.id = su.actual_class_id
     JOIN ${tgt("classes")} tc ON tc.name = sc.name
     WHERE u.id = su.id AND u.id = ANY($1::text[])`,
    ids,
  );

  // 3 ── Sinf: manbadan chiqish JURNALGA (sabab majburiy — `education.md` §5)
  const reasonText = `"${ctx.target.name}" filialiga ko'chirildi. ${ctx.reason}`;
  for (const item of items) {
    if (item.classes.length === 0) continue;
    await exec(
      `INSERT INTO ${src("student_class_changes")}
         (id, student_id, type, source, from_class_ids, from_class_names, to_class_ids,
          to_class_names, reason, created_by, created_at)
       VALUES ($1, $2, 'removed'::${schemaType(from, "StudentClassChangeType")},
               'branch_transfer'::${schemaType(from, "StudentClassChangeSource")},
               $3::text[], $4::text[], '{}'::text[], '{}'::text[], $5, $6, NOW())`,
      generateId(),
      item.id,
      item.classes.map((c) => c.id),
      item.classes.map((c) => c.name),
      reasonText,
      ctx.actor.id,
    );
  }
  await deleteRows(db, { schema: from, table: "user_classes", where: `s."user_id" = ANY($1::text[])`, params: [ids] });
  const pairs = items.flatMap((item) => item.plan.targetClassIds.map((classId) => [item.id, classId]));
  if (pairs.length) {
    await exec(
      `INSERT INTO ${tgt("user_classes")} (user_id, class_id)
       SELECT u, c FROM unnest($1::text[], $2::text[]) AS t(u, c) ON CONFLICT DO NOTHING`,
      pairs.map(([u]) => u),
      pairs.map(([, c]) => c),
    );
  }

  // 4 ── O'qish davri: manbada T−1 da yopiladi (T dan boshlangani o'chiriladi),
  // maqsadda T dan ochiladi. To'lov oyi — chegaradan.
  await deleteRows(db, {
    schema: from,
    table: "student_enrollments",
    where: `s."student_id" = ANY($1::text[]) AND s."start_date" >= $2::date`,
    params: [ids, ctx.dayIso],
  });
  await exec(
    `UPDATE ${src("student_enrollments")}
     SET end_date = $2::date - 1, end_reason = 'transferred', reason = $3, updated_at = NOW()
     WHERE student_id = ANY($1::text[]) AND start_date < $2::date
       AND (end_date IS NULL OR end_date >= $2::date)`,
    ids,
    ctx.dayIso,
    reasonText,
  );
  await exec(
    `INSERT INTO ${tgt("student_enrollments")}
       (id, student_id, start_date, end_date, end_reason, reason, note, created_by,
        created_at, updated_at, first_month_amount, first_month_key)
     SELECT i, s, $3::date, NULL, NULL, $4, '', $5, NOW(), NOW(), NULL, k
     FROM unnest($1::text[], $2::text[], $6::int[]) AS t(i, s, k)`,
    items.map(() => generateId()),
    ids,
    ctx.dayIso,
    `"${ctx.source.name}" filialidan ko'chirildi. ${ctx.reason}`,
    ctx.actor.id,
    items.map((item) => (item.plan.boundary === ctx.month ? null : item.plan.boundary)),
  );

  // 5 ── Kelajak qoidalari (har o'quvchi o'z chegarasi bilan)
  //
  // ⚠️ MAQSADDAGI eski qoidalar CHEGARADAN emas, NUSXA QAMRAYDIGAN BIRINCHI
  // OYDAN kesiladi. Odam qaytib kelganda (A → B → A) maqsadda o'zining eski,
  // yopilgan qoidasi bor: B hech qachon hisoblamagan oy (masalan, ko'chish
  // oyi) uchun u AMALDA. Chegaradan kesilsa, o'sha oy tarifsiz qolib, hisob-
  // faktura umuman yozilmasdi.
  const copyPeriodRows = (table, rowIds, boundary) =>
    copyRowsWithNewIds(db, ctx.cache, {
      from,
      to,
      table,
      pairs: rowIds.map((rowId) => [generateId(), rowId]),
      override: {
        // Chegarani qamragan qator chegaradan boshlanadi, keyingilari o'z oyidan
        start_month: `GREATEST(s."start_month", $3)`,
        created_by: "$4",
        created_at: "NOW()",
        updated_at: "NOW()",
      },
      params: [boundary, ctx.actor.id],
    });

  for (const item of items) {
    const { plan } = item;
    const boundary = plan.boundary;
    const one = [item.id];

    if (plan.tariff.from != null) await trimPeriods(db, to, "student_tariffs", one, plan.tariff.from);
    if (plan.discountFrom != null) await trimPeriods(db, to, "student_discounts", one, plan.discountFrom);
    if (plan.statusFrom != null) await trimPeriods(db, to, "student_finance_statuses", one, plan.statusFrom);
    if (plan.overrideMonths.length) {
      await deleteRows(db, {
        schema: to,
        table: "student_month_overrides",
        where: `s."student_id" = $1 AND s."month" = ANY($2::int[])`,
        params: [item.id, plan.overrideMonths],
      });
    }

    await copyPeriodRows("student_tariffs", plan.tariff.rowIds, boundary);
    await copyPeriodRows("student_discounts", plan.discountIds, boundary);
    await copyPeriodRows("student_finance_statuses", plan.statusIds, boundary);

    if (plan.tariff.mode === "default") {
      await exec(
        `INSERT INTO ${tgt("student_tariffs")}
           (id, student_id, tariff_id, start_month, end_month, note, created_by, created_at,
            updated_at, custom_amount)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, NOW(), NOW(), NULL)`,
        generateId(),
        item.id,
        plan.tariff.tariffId,
        boundary,
        "Filialga ko'chganda standart tarif",
        ctx.actor.id,
      );
    }

    if (plan.overrideIds.length) {
      await copyRowsWithNewIds(db, ctx.cache, {
        from,
        to,
        table: "student_month_overrides",
        pairs: plan.overrideIds.map((rowId) => [generateId(), rowId]),
        override: { created_at: "NOW()", updated_at: "NOW()" },
      });
    }

    // Manbada: chegaradan boshlab qoida yo'q (o'quvchi u yerda o'qimaydi) —
    // qaytib kelsa maqsaddagi bilan kesishmasin
    for (const table of ["student_tariffs", "student_discounts", "student_finance_statuses", "student_services"]) {
      await trimPeriods(db, from, table, one, boundary);
    }
    await deleteRows(db, {
      schema: from,
      table: "student_month_overrides",
      where: `s."student_id" = $1 AND s."month" >= $2`,
      params: [item.id, boundary],
    });

    Object.assign(moved.get(item.id), {
      boundary,
      tariffs: plan.tariff.mode === "default" ? 1 : plan.tariff.rowIds.length,
      discounts: plan.discountIds.length,
      financeStatuses: plan.statusIds.length,
      monthOverrides: plan.overrideIds.length,
    });
  }

  // 5b ── MOLIYAVIY HOLAT: qarz ko'chadi, depozit haqiqiy pul bilan o'tadi
  //
  // Lock tartibi (`finance.md` §8) yadroning ICHIDA saqlanadi:
  // StudentAccount → MonthlyInvoice → PaymentAccount, ikkala filialda ham.
  const financeMoved = await writeStudentFinance(db, ctx, items);
  for (const [studentId, info] of financeMoved) {
    if (moved.has(studentId)) moved.get(studentId).finance = info;
  }

  // 5c ── TA'LIM TARIXI: baho, davomat, yutuq, jarima
  //
  // ⚠️ `users` nusxasidan KEYIN: `student_achievements.student_id` —
  // haqiqiy FK (`onDelete: Cascade`), maqsadda o'quvchi qatori bo'lmasa
  // yozuv yiqilardi.
  if (historyCatalog) {
    // ⚠️ BAHO KETISHIDAN OLDIN SURAT. Baholar o'quvchilar bilan ko'chadi,
    // oylik esa "dars o'tildimi" degan savolga aynan bahodan javob oladi:
    // surat bo'lmasa, shu oyda allaqachon o'tilgan dars jimgina
    // "o'tilmagan" bo'lib qolardi (`creditLostLessons` uni qaytaradi).
    ctx.lessonSnapshot = await snapshotMissedLessons(
      ctx,
      [...new Set(items.flatMap((item) => item.classes.map((c) => c.id)))],
    );

    const history = await writeStudentHistory(db, ctx, ids, historyCatalog);
    note("history", history.moved);
    if (history.createdSubjects.length) note("createdSubjects", history.createdSubjects);
    if (history.createdClasses.length) note("createdClasses", history.createdClasses);
  }

  // 6 ── Tanga qoldig'i — ikki tomonda yozuv bilan (tarix o'z filialida)
  const withCoins = items.filter((item) => item.plan.coins !== 0);
  if (withCoins.length) {
    const insertCoins = (schema, sign, description) =>
      exec(
        `INSERT INTO ${qualified(schema, "coin_transactions")}
           (id, student_id, amount, type, description, balance_after, meta, date, created_at, updated_at)
         SELECT i, s, a * $5, 'branch_transfer'::${schemaType(schema, "CoinTransactionType")}, $4,
                CASE WHEN $5 > 0 THEN a ELSE 0 END, $6::jsonb, NOW(), NOW(), NOW()
         FROM unnest($1::text[], $2::text[], $3::int[]) AS t(i, s, a)`,
        withCoins.map(() => generateId()),
        withCoins.map((i) => i.id),
        withCoins.map((i) => i.plan.coins),
        description,
        sign,
        JSON.stringify({ fromBranchId: ctx.source.id, toBranchId: ctx.target.id, transferId: ctx.transferId }),
      );
    await insertCoins(from, -1, `"${ctx.target.name}" filialiga ko'chirildi`);
    await insertCoins(to, 1, `"${ctx.source.name}" filialidan o'tkazilgan qoldiq`);
  }

  // 7 ── Ota-ona nazorati, faol premium — ko'chadi (maqsaddagi eskisi almashtiriladi)
  for (const table of PARENTAL_TABLES) {
    const count = await moveRows(db, ctx.cache, {
      from,
      to,
      table,
      where: `s."student_id" = ANY($1::text[])`,
      params: [ids],
    });
    if (count) note(`parental:${table}`, true);
  }
  await moveRows(db, ctx.cache, {
    from,
    to,
    table: "premiums",
    where: `s."student" = ANY($1::text[]) AND s."status" = 'active' AND s."end_date" > NOW()`,
    params: [ids],
  });

  // 8 ── Telegram: boshqa o'quvchiga bog'langan akkaunt ko'chmaydi (yagona
  // `telegram_id`), qolgani ko'chadi va bot yo'naltirgichi yangilanadi
  await deleteRows(db, { schema: to, table: "tg_users", where: `s."student" = ANY($1::text[])`, params: [ids] });
  await copyRows(db, ctx.cache, {
    from,
    to,
    table: "tg_users",
    where: `s."student" = ANY($1::text[])`,
    params: [ids],
    onConflict: "nothing",
  });
  await exec(
    `DELETE FROM ${src("tg_users")} s WHERE s.student = ANY($1::text[])
       AND EXISTS (SELECT 1 FROM ${tgt("tg_users")} t WHERE t.id = s.id)`,
    ids,
  );
  await exec(
    `UPDATE ${plat("telegram_directory")} SET branch_id = $2, updated_at = NOW()
     WHERE student_id = ANY($1::text[])
       AND telegram_id IN (SELECT telegram_id FROM ${tgt("tg_users")} WHERE student = ANY($1::text[]))`,
    ids,
    ctx.target.id,
  );

  // 9 ── Manbadagi profil: ARXIV (tarix unga ishora qiladi), qoldiq yozuvda
  await exec(
    `UPDATE ${src("users")}
     SET is_archived = true, archived_at = NOW(), archive_note = $2,
         archive_snapshot = jsonb_build_object(
           'coinBalance', coin_balance, 'penaltyPoints', penalty_points,
           'transferredToBranchId', $3::text, 'transferId', $4::text),
         coin_balance = 0, premium_is_active = false, updated_at = NOW()
     WHERE id = ANY($1::text[])`,
    ids,
    `"${ctx.target.name}" filialiga ko'chirildi: ${ctx.reason}`,
    ctx.target.id,
    ctx.transferId,
  );

  // 10 ── Login yo'naltirgichi: endi maqsad filialga
  await exec(
    `UPDATE ${plat("user_directory")} SET branch_id = $2, is_archived = false, updated_at = NOW()
     WHERE id = ANY($1::text[])`,
    ids,
    ctx.target.id,
  );
  await exec(`DELETE FROM ${plat("user_branch_access")} WHERE user_id = ANY($1::text[])`, ids);
  await exec(
    `INSERT INTO ${plat("user_branch_access")}
       (user_id, branch_id, role, is_home, created_by, created_at, updated_at)
     SELECT u, $2, 'student', true, $3, NOW(), NOW() FROM unnest($1::text[]) AS t(u)`,
    ids,
    ctx.target.id,
    ctx.actor.id,
  );
  await exec(
    `UPDATE ${plat("push_devices")} SET branch_id = $2, updated_at = NOW() WHERE user_id = ANY($1::text[])`,
    ids,
    ctx.target.id,
  );

  for (const item of items) {
    Object.assign(moved.get(item.id), {
      classesLeft: item.classes.map((c) => c.name),
      targetClassIds: item.plan.targetClassIds,
      coins: item.plan.coins,
      periodsClosed: item.plan.closingPeriodIds.length,
      periodsRemoved: item.plan.deletingPeriodIds.length,
    });
  }

  return moved;
};

/**
 * Tranzaksiyadan KEYINGI qadamlar — har biri o'z servisi orqali:
 *   - manba filialda o'quvchi o'qimaydigan oylarning hisob-fakturasi
 *     BITTALIK `cancelInvoice` bilan (pul depozitga qaytadi, lock tartibi) —
 *     `cancelUncoveredInvoices` doktrinasi, mustaqil SQL emas;
 *   - qurilmalar chekovdan chiqariladi (`releaseForStudent`);
 *   - manba filialdagi seanslar yopiladi;
 *   - maqsad filial shu oyni hisoblasa — hisob-faktura darhol yoziladi.
 *
 * Har biri yiqilsa ham qolganlari bajariladi; yiqilgani ogohlantirish bo'lib
 * jurnalga yoziladi (ko'chirish holati — "e'tibor talab").
 *
 * @returns {Promise<Map<string, string[]>>} studentId → ogohlantirishlar
 */
const afterStudents = async (ctx, items) => {
  const warnings = new Map(items.map((item) => [item.id, []]));
  const ids = items.map((item) => item.id);

  await runWithBranch(ctx.source, async () => {
    const { cancelInvoice } = require("./invoice.service");
    const prisma = require("../config/prisma");

    for (const item of items) {
      // Reja emas, BAZA: oraliqda yangi oy yozilgan bo'lishi mumkin
      const invoices = await prisma.monthlyInvoice.findMany({
        where: { studentId: item.id, status: { not: "cancelled" }, month: { gte: item.plan.boundary } },
        select: { id: true, month: true },
        orderBy: [{ month: "asc" }, { id: "asc" }],
      });
      for (const invoice of invoices) {
        try {
          await cancelInvoice(
            invoice.id,
            `"${ctx.target.name}" filialiga ko'chirildi — o'quvchi bu oyda bu filialda o'qimaydi`,
            ctx.actor.id,
          );
        } catch (error) {
          warnings
            .get(item.id)
            .push(
              `"${ctx.source.name}" filialidagi ${formatMonthKey(invoice.month)} hisob-fakturasi ` +
                `bekor qilinmadi — qo'lda bekor qiling (${error.message})`,
            );
        }
      }

      if (item.plan.deviceCount > 0) {
        try {
          const { releaseForStudent } = require("./deviceEnrollment.service");
          await releaseForStudent(item.id, ctx.actor.id, "O'quvchi boshqa filialga ko'chirildi");
        } catch (error) {
          warnings.get(item.id).push(`Qurilmalar chekovdan chiqarilmadi: ${error.message}`);
        }
      }
    }
  });

  // ── O'TILGAN DARSLARNI QAYTARISH (baho ko'chgani uchun yo'qolganlari) ──
  const sourceClassIds = [...new Set(items.flatMap((item) => item.classes.map((c) => c.id)))];
  if (ctx.lessonSnapshot?.teacherIds?.length) {
    try {
      const credited = await creditLostLessons(ctx, sourceClassIds, ctx.lessonSnapshot);
      if (credited.credited > 0) {
        logger.info(
          `[branchTransfer] "${ctx.source.name}": ${credited.credited} ta o'tilgan dars ` +
            `${credited.days} kunda "o'tildi" deb belgilandi (baho ko'chdi)`,
        );
      }
      for (const message of credited.warnings) {
        const anchor = items[0]?.id;
        if (anchor && warnings.has(anchor)) warnings.get(anchor).push(message);
      }
    } catch (error) {
      logger.error(`[branchTransfer] o'tilgan darslar belgilanmadi: ${error.message}`);
      const anchor = items[0]?.id;
      if (anchor && warnings.has(anchor)) {
        warnings
          .get(anchor)
          .push(
            `Eski filialdagi o'tilgan darslar belgilanmadi — o'qituvchilar soati kam ` +
              `chiqishi mumkin, "O'tilmagan darslar" dan qo'lda belgilang (${error.message})`,
          );
      }
    }
  }

  await closeSessions(ids, ctx.source.id);

  // Maqsad filial ko'chish oyini o'zi hisoblasa — hisob-faktura darhol
  // (`finance.md` §3: davr ochilganda o'sha oy shakllanadi, catch-up'ga
  // tayanilmaydi). Idempotent.
  const billedNow = items.filter((item) => item.plan.boundary === ctx.month).map((item) => item.id);
  if (billedNow.length) {
    try {
      await runWithBranch(ctx.target, () =>
        require("./invoiceGeneration.service").generateForMonth(ctx.month, {
          studentIds: billedNow,
          source: "manual",
          actorId: ctx.actor.id,
        }),
      );
    } catch (error) {
      for (const id of billedNow) {
        warnings
          .get(id)
          .push(
            `"${ctx.target.name}" filialida ${formatMonthKey(ctx.month)} hisob-fakturasi hozir yozilmadi — ` +
              `kunlik hisoblash uni yozadi (${error.message})`,
          );
      }
    }
  }

  // ── KO'CHGAN DEPOZITNI YANGI FILIALDA DARHOL QARZGA YECHISH ──
  //
  // "Qarz va depozit birga turmaydi" (`finance.md` §6): pul kelgan zahoti
  // eng eski ochiq oydan boshlab yechiladi. Bu yerda ATAYLAB chaqiriladi —
  // `settleDepositInTx` har pul amalining O'Z tranzaksiyasi oxirida
  // chaqilishi kerak, filiallararo tranzaksiya esa filialga bog'langan
  // Prisma proxy'sini ishlata olmaydi.
  //
  // Yiqilsa ham pul yo'qolmaydi: u depozitda turadi, kunlik zaxira pass
  // (`runDepositSettlementPass`, 06:00) va kechki invariant tekshiruvi
  // (`deposit_unapplied`) uni baribir topadi.
  const withDeposit = items.filter((item) =>
    new Decimal(item.plan.finance?.deposit ?? 0).greaterThan(0),
  );
  if (withDeposit.length) {
    await runWithBranch(ctx.target, async () => {
      const { applyDepositsForStudent } = require("./studentAccount.service");
      for (const item of withDeposit) {
        try {
          await applyDepositsForStudent(item.id);
        } catch (error) {
          warnings
            .get(item.id)
            .push(
              `Ko'chgan depozit yangi filialda qarzga yechilmadi — u depozitda turadi va ` +
                `kunlik hisoblash uni yechadi (${error.message})`,
            );
        }
      }
    });
  }

  return warnings;
};

/**
 * Manba filialdagi ochiq seanslarni yopadi (`revoked`). Profil arxivlangani
 * uchun ular baribir rad etiladi — bu tozalash va "ko'rindi" oynasini
 * bo'shatish.
 */
const closeSessions = async (userIds, branchId) => {
  try {
    const platformPrisma = require("../config/platformPrisma");
    const securityService = require("./security.service");
    const rows = await platformPrisma.userSession.findMany({
      where: { userId: { in: userIds }, branchId, endReason: "active" },
      select: { id: true },
    });
    await securityService.closeSessions(rows.map((r) => r.id), "revoked");
  } catch (error) {
    logger.warn(`[branchTransfer] seanslar yopilmadi: ${error.message}`);
  }
};

module.exports = {
  planStudents,
  writeStudents,
  afterStudents,
  closeSessions,
  // test uchun
  planSourcePeriods,
  effectiveFrom,
};
