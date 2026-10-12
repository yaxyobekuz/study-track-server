/**
 * FILIALLARARO KO'CHIRISH — O'QUVCHINING MOLIYAVIY HOLATI.
 *
 * ═════════════════════════════════════════════
 * NIMA KO'CHADI VA NIMA UCHUN AYNAN SHU
 *
 *   KO'CHADI — OCHIQ HOLAT:
 *     • QARZ: to'lanmagan va qisman to'langan oylar. Manbada bittalik bekor
 *       qilish doktrinasi bilan yopiladi (to'langan qismi depozitga
 *       qaytadi), maqsadda AYNI oy AYNI muhrlangan tarkib bilan qaytadan
 *       ochiladi. Qarz yangi filialning qarzdorlar registriga tushadi.
 *     • DEPOZIT: o'quvchining sarflanmagan puli — HAQIQIY PUL sifatida.
 *       Manba kassasidan chiqadi (`branch_transfer_out`), maqsad kassasiga
 *       kiradi (`branch_transfer_in`), ikkala tomonda o'quvchi hisobiga
 *       to'g'rilash yoziladi. Maqsadda depozit yadrosi uni darhol yangi
 *       qarzga yechadi ("qarz va depozit birga turmaydi", `finance.md` §6).
 *
 *   QOLADI — YOPILGAN FAKT:
 *     • To'langan oylar va ularning CHEKLARI. Bu pul manba filialda
 *       allaqachon olingan va sarflangan (oylik, xarajat) — uni ko'chirish
 *       manba kassasini minusga tushirardi va maqsad filial hech qachon
 *       olmagan tushumni ko'rsatardi.
 *     • Daftar (`account_entries`) — QAT'IY append-only (`finance.md` §7),
 *       `PaymentAccount.balance = openingBalance + Σ entries` invarianti
 *       aynan unga tayanadi. Chek qatori ham shu sababdan manbada qoladi:
 *       daftar unga FK bilan ishora qiladi (`onDelete: Restrict`).
 *
 *   KO'RINADI: o'quvchining boshqa filiallardagi to'liq moliya tarixi
 *     `getStudentFinanceAcrossBranches` orqali JONLI o'qiladi — nusxa
 *     olinmaydi, shuning uchun bitta to'lov ikki filialda ikki marta
 *     sanalmaydi (`getStaffPayrollAcrossBranches` bilan AYNI naqsh).
 * ═════════════════════════════════════════════
 *
 * ⚠️ TO'RTALA INVARIANT (`finance.md` §9) IKKALA FILIALDA HAM SAQLANADI:
 *   1) kassa qoldig'i = ochilish + Σ daftar — har ikki tomonga yozuv;
 *   2) o'quvchi depoziti = Σ chek qoldig'i + Σ to'g'rilash — manbada −D,
 *      maqsadda +D to'g'rilash;
 *   3) oy to'langani = Σ bekor qilinmagan taqsimot — bekor qilishda
 *      taqsimotlar bo'shatiladi, maqsaddagi yangi oy esa 0 dan boshlanadi;
 *   4) oy summasi = proratsiya − chegirma — tarkib MUHRDAGICHA nusxalanadi.
 *
 * ⚠️ HAMMASI XOM SQL BILAN va CHAQIRUVCHINING filiallararo tranzaksiyasida:
 * `cancelInvoice` filialga bog'langan Prisma proxy'si bilan ishlaydi, uni
 * bu tranzaksiyadan chaqirib bo'lmaydi. Shuning uchun uning TA'SIRI shu
 * yerda qadam-baqadam takrorlanadi (taqsimotni bo'shatish → chek qoldig'ini
 * tiklash → oyni nolga tushirish → `cancelled`), ikkinchi mustaqil mantiq
 * emas.
 */

const { generateId } = require("../utils/idGenerator");
const { ConflictError } = require("../utils/errors");
const {
  qualified,
  schemaType,
  copyRowsWithNewIds,
} = require("../helpers/crossSchema.helpers");
const { formatMonthKey } = require("../helpers/month.helpers");
const { Decimal, formatAmount, sumAmounts } = require("../helpers/money.helpers");
const { mapPaymentAccounts } = require("./branchTransferCatalog.service");

/** Ochiq (pul kutilayotgan) oylar. */
const OPEN_STATUSES = ["unpaid", "partial"];

const byStudent = (rows) => {
  const map = new Map();
  for (const row of rows) {
    const key = String(row.studentId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
};

/**
 * O'QUVCHINING MOLIYAVIY REJASI.
 *
 * `boundaryOf` — har o'quvchi uchun maqsad filial hisoblay boshlaydigan oy
 * (`branchTransferStudent` → `planSourcePeriods`). Undan boshlab manbada
 * o'quvchi o'qimaydi: o'sha oylar bekor qilinadi va maqsad filial ularni
 * O'ZI shakllantiradi (tarif u yerda boshqa bo'lishi mumkin). Chegaradan
 * OLDINGI ochiq oylar esa haqiqiy QARZ — ular muhrlangan summa bilan
 * ko'chadi.
 *
 * @param {object} db - filiallararo tranzaksiya yoki platforma client'i
 * @param {object} ctx
 * @param {string[]} studentIds
 * @param {Map<string, number>} boundaryOf - studentId → chegara oyi (YYYYMM)
 * @returns {Promise<Map<string, object>>} studentId → reja (xeshga kiradi)
 */
const planStudentFinance = async (db, ctx, studentIds, boundaryOf) => {
  const ids = [...new Set(studentIds)].sort();
  const src = (t) => qualified(ctx.source.schemaName, t);
  const tgt = (t) => qualified(ctx.target.schemaName, t);
  const q = (sql, ...params) => db.$queryRawUnsafe(sql, ...params);
  const plans = new Map();
  if (ids.length === 0) return plans;

  const invoices = await q(
    `SELECT id, student_id AS "studentId", month, status::text AS status,
            amount::text AS amount, paid_amount::text AS "paidAmount"
     FROM ${src("monthly_invoices")}
     WHERE student_id = ANY($1::text[]) AND status <> 'cancelled'
     ORDER BY student_id, month, id`,
    ids,
  );
  // ⚠️ BEKOR QILINGANI HAM: `(student_id, month)` yagona kalit holatga
  // qaramaydi. Maqsadda bekor qilingan qator bo'lsa, qarz AYNAN O'SHA
  // QATORDA tiklanadi (`finance.md` §5: "bekor qilingan hisob-faktura
  // shakllantirishni to'smaydi"), yangi qator yozilmaydi.
  const targetInvoices = await q(
    `SELECT id, student_id AS "studentId", month, status::text AS status,
            paid_amount::text AS "paidAmount"
     FROM ${tgt("monthly_invoices")} WHERE student_id = ANY($1::text[])`,
    ids,
  );
  const accounts = await q(
    `SELECT student_id AS "studentId", balance::text AS balance
     FROM ${src("student_accounts")} WHERE student_id = ANY($1::text[])`,
    ids,
  );
  // Chekka BOG'LANGAN depozit — hisob kesimida. Faqat shu pul HAQIQIY pul:
  // qo'lda to'g'rilash (`adjustBalance`) kassaga tegmagan, shuning uchun
  // uni kassadan chiqarib bo'lmaydi (`finance.md` §6: byudjet =
  // min(balans, cheklar qoldig'i)).
  const receiptDeposits = await q(
    `SELECT student_id AS "studentId", account_id AS "accountId",
            SUM(deposit_amount)::text AS amount
     FROM ${src("payments")}
     WHERE student_id = ANY($1::text[]) AND is_voided = false
     GROUP BY student_id, account_id ORDER BY student_id, account_id`,
    ids,
  );
  // Bekor qilinadigan oydan chekka QAYTADIGAN pul — u ham o'sha chekning
  // hisobiga tushadi (`releaseInvoiceAllocations`). Oy kesimida olinadi:
  // qaysi oy bekor qilinishi har o'quvchida boshqacha.
  const releasing = await q(
    `SELECT a.student_id AS "studentId", a.invoice_id AS "invoiceId",
            p.account_id AS "accountId", SUM(a.amount)::text AS amount
     FROM ${src("payment_allocations")} a
     JOIN ${src("payments")} p ON p.id = a.payment_id
     WHERE a.student_id = ANY($1::text[]) AND a.is_voided = false
     GROUP BY a.student_id, a.invoice_id, p.account_id
     ORDER BY a.student_id, a.invoice_id, p.account_id`,
    ids,
  );

  const accountMap = await mapPaymentAccounts(
    db,
    ctx,
    [...new Set([...receiptDeposits, ...releasing].map((r) => r.accountId))],
  );

  const invoicesOf = byStudent(invoices);
  const receiptsOf = byStudent(receiptDeposits);
  const releasingOf = byStudent(releasing);
  const balanceOf = new Map(accounts.map((r) => [String(r.studentId), new Decimal(r.balance)]));
  const targetOf = byStudent(targetInvoices);

  for (const id of ids) {
    const boundary = boundaryOf.get(id);
    const rows = invoicesOf.get(id) ?? [];
    const targetByMonth = new Map((targetOf.get(id) ?? []).map((row) => [row.month, row]));

    // Chegaradan boshlangan oylar: o'quvchi bu filialda o'qimaydi → bekor.
    // Maqsad filial ularni o'z tarifi bilan O'ZI shakllantiradi.
    const vacating = rows.filter((row) => row.month >= boundary);
    // Chegaradan oldingi OCHIQ oylar — haqiqiy QARZ, muhrdagi tarkib bilan
    // ko'chadi
    const open = rows.filter(
      (row) => row.month < boundary && OPEN_STATUSES.includes(row.status),
    );

    const moving = [];
    const blocked = [];
    for (const row of open) {
      const existing = targetByMonth.get(row.month);
      if (!existing) {
        moving.push({ ...row, targetInvoiceId: null });
      } else if (existing.status === "cancelled" && new Decimal(existing.paidAmount).isZero()) {
        // Bekor qilingan qator — BO'SH O'RIN: o'sha qatorning o'zida tiklanadi
        moving.push({ ...row, targetInvoiceId: existing.id });
      } else {
        // Maqsadda shu oy ALLAQACHON hisoblangan (o'quvchi ilgari o'sha
        // filialda o'qigan): ikkinchi marta yozish qarzni ikki barobar
        // qilardi
        blocked.push(row);
      }
    }

    const settled = rows.filter(
      (row) => row.month < boundary && !OPEN_STATUSES.includes(row.status),
    );

    // Bekor qilinadigan HAMMA oy (bo'shatilganda puli depozitga qaytadi).
    // ⚠️ Maqsadda band bo'lgani BEKOR QILINMAYDI: qarz u yerga ko'chmasa,
    // u shu filialda qolishi kerak — aks holda pul izsiz yo'qolardi.
    const cancelling = [...vacating, ...moving];
    const cancellingIds = new Set(cancelling.map((row) => row.id));
    const released = sumAmounts(cancelling.map((row) => row.paidAmount));
    const depositAfter = (balanceOf.get(id) ?? new Decimal(0)).plus(released);

    // Hisob kesimidagi chekka bog'langan pul: hozirgi qoldiq + aynan shu
    // bekor qilishdan bo'shaydigani
    const perAccount = new Map();
    const add = (accountId, value) => {
      const amount = new Decimal(value);
      if (!amount.greaterThan(0)) return;
      perAccount.set(accountId, (perAccount.get(accountId) ?? new Decimal(0)).plus(amount));
    };
    for (const row of receiptsOf.get(id) ?? []) add(row.accountId, row.amount);
    for (const row of releasingOf.get(id) ?? []) {
      if (cancellingIds.has(row.invoiceId)) add(row.accountId, row.amount);
    }

    const receiptTotal = sumAmounts([...perAccount.values()]);
    // Kassadan chiqadigan pul chekka bog'langandan OSHMAYDI
    const cashTotal = Decimal.min(depositAfter, receiptTotal);

    // Hisoblar bo'yicha taqsimot — `id` o'sish tartibida (deadlock tartibi
    // va reja xeshining barqarorligi uchun)
    const cashLines = [];
    let left = cashTotal;
    for (const accountId of [...perAccount.keys()].sort()) {
      if (!left.greaterThan(0)) break;
      const take = Decimal.min(left, perAccount.get(accountId));
      if (!take.greaterThan(0)) continue;
      cashLines.push({
        sourceAccountId: accountId,
        targetAccountId: accountMap.map.get(accountId) ?? null,
        amount: formatAmount(take),
      });
      left = left.minus(take);
    }

    plans.set(id, {
      boundary,
      cancelInvoiceIds: cancelling.map((row) => row.id),
      vacatingMonths: vacating.map((row) => row.month),
      // [manba id, maqsaddagi bekor qilingan qator id (bo'lsa)]
      debtPairs: moving.map((row) => [row.id, row.targetInvoiceId]),
      debtMonths: moving.map((row) => row.month),
      debtAmount: formatAmount(
        sumAmounts(moving.map((row) => new Decimal(row.amount).minus(row.paidAmount))),
      ),
      debtTotalAmount: formatAmount(sumAmounts(moving.map((row) => row.amount))),
      blockedMonths: blocked.map((row) => row.month),
      settledMonths: settled.map((row) => row.month),
      settledAmount: formatAmount(sumAmounts(settled.map((row) => row.paidAmount))),
      deposit: formatAmount(depositAfter),
      cashTotal: formatAmount(cashTotal),
      // Kassaga tegmaydigan qism (qo'lda to'g'rilash puli) — balans bilan
      // ko'chadi, daftarga yozilmaydi
      nonCashTotal: formatAmount(depositAfter.minus(cashTotal)),
      cashLines,
      missingTargetAccount: cashLines.some((line) => !line.targetAccountId),
    });
  }

  return plans;
};

/**
 * Bekor qilinadigan oylarning taqsimotlarini bo'shatadi va oylarni
 * `cancelled` qiladi — `releaseInvoiceAllocations` + `cancelInvoice` ning
 * AYNI ketma-ketligi, faqat filiallararo tranzaksiyada.
 *
 * ⚠️ `settleDepositInTx` ATAYLAB chaqirilmaydi: depozit shu yerda boshqa
 * filialga olib chiqiladi va manbada yechadigan ochiq oy qolmaydi.
 *
 * @returns {Promise<Decimal>} depozitga qaytgan jami summa
 */
const releaseAndCancel = async (db, ctx, studentId, invoiceIds, reason) => {
  if (invoiceIds.length === 0) return new Decimal(0);
  const src = (t) => qualified(ctx.source.schemaName, t);

  // 1) Taqsimotlarni bo'shatish va chek qoldiqlarini tiklash
  const [released] = await db.$queryRawUnsafe(
    `WITH live AS (
       SELECT a.id, a.payment_id, a.amount
       FROM ${src("payment_allocations")} a
       WHERE a.invoice_id = ANY($1::text[]) AND a.is_voided = false
     ), voided AS (
       UPDATE ${src("payment_allocations")} a
       SET is_voided = true, voided_at = NOW()
       WHERE a.id IN (SELECT id FROM live) RETURNING 1
     ), per_payment AS (
       SELECT payment_id, SUM(amount) AS amount FROM live GROUP BY payment_id
     ), touched AS (
       UPDATE ${src("payments")} p
       SET allocated_amount = p.allocated_amount - pp.amount,
           deposit_amount = p.deposit_amount + pp.amount,
           updated_at = NOW()
       FROM per_payment pp WHERE p.id = pp.payment_id RETURNING 1
     )
     SELECT COALESCE((SELECT SUM(amount) FROM live), 0)::text AS total,
            (SELECT COUNT(*) FROM voided)::int AS "voidedCount",
            (SELECT COUNT(*) FROM touched)::int AS "paymentCount"`,
    invoiceIds,
  );
  const total = new Decimal(released?.total ?? 0);

  // 2) Oylarni nolga tushirib bekor qilish
  const count = await db.$executeRawUnsafe(
    `UPDATE ${src("monthly_invoices")}
     SET paid_amount = 0, paid_at = NULL, deposit_hold = false,
         status = 'cancelled'::${schemaType(ctx.source.schemaName, "InvoiceStatus")},
         cancel_reason = $2, cancelled_at = NOW(), cancelled_by = $3, updated_at = NOW()
     WHERE id = ANY($1::text[]) AND status <> 'cancelled'`,
    invoiceIds,
    reason,
    ctx.actor.id,
  );
  // Reja tranzaksiya ICHIDA, qulf ostida qurilgan — mos kelmaslik faqat kod
  // xatosi bo'lishi mumkin va jim o'tkazib yuborilmaydi
  if (count !== invoiceIds.length) {
    throw new Error(
      `Hisob-faktura bekor qilinmadi: kutilgan ${invoiceIds.length}, yozilgan ${count}`,
    );
  }

  // 3) Depozit qoldig'i
  if (total.greaterThan(0)) {
    await db.$executeRawUnsafe(
      `UPDATE ${src("student_accounts")} SET balance = balance + $2::numeric, updated_at = NOW()
       WHERE student_id = $1`,
      studentId,
      total.toFixed(2),
    );
  }
  return total;
};

/**
 * Moliyaviy holatni YOZADI. Chaqiruvchi rejani shu tranzaksiyada qayta
 * qurgan va xeshini tekshirgan; har `item.plan.finance` — shu rejaning
 * moliya qismi.
 *
 * LOCK TARTIBI (`finance.md` §8) saqlanadi:
 *   StudentAccount → MonthlyInvoice (month asc, id asc) → PaymentAccount
 * va `PaymentAccount` HAR IKKALA filialda ham ENG OXIRIDA.
 *
 * @param {object} db
 * @param {object} ctx
 * @param {Array} items - `ready` qatorlar (`item.plan.finance` bilan)
 * @returns {Promise<Map<string, object>>} studentId → nima bo'ldi
 */
const writeStudentFinance = async (db, ctx, items) => {
  const from = ctx.source.schemaName;
  const to = ctx.target.schemaName;
  const src = (t) => qualified(from, t);
  const tgt = (t) => qualified(to, t);
  const exec = (sql, ...params) => db.$executeRawUnsafe(sql, ...params);
  const result = new Map();
  const live = items.filter((item) => item.plan?.finance);
  if (live.length === 0) return result;

  const ids = live.map((item) => item.id);
  const reasonBase = `"${ctx.target.name}" filialiga ko'chirildi: ${ctx.reason}`;

  // ── 1. O'QUVCHI HISOBLARI (lock tartibida BIRINCHI) ───────────
  // "Pulga tegadigan har qanday tranzaksiyaning birinchi operatori" —
  // ikkala filialda ham qator borligi kafolatlanadi va versiya oshadi.
  for (const schema of [from, to]) {
    await exec(
      `INSERT INTO ${qualified(schema, "student_accounts")} AS sa
         (id, student_id, balance, version, created_at, updated_at)
       SELECT i, s, 0, 0, NOW(), NOW() FROM unnest($1::text[], $2::text[]) AS t(i, s)
       ON CONFLICT (student_id)
       DO UPDATE SET version = sa.version + 1, updated_at = NOW()`,
      ids.map(() => generateId()),
      ids,
    );
  }

  // ── 2. MANBA: ochiq oylarni bekor qilish (pul depozitga qaytadi) ──
  for (const item of live) {
    const finance = item.plan.finance;
    await releaseAndCancel(
      db,
      ctx,
      item.id,
      finance.cancelInvoiceIds,
      `${reasonBase} — oy yangi filialda hisoblanadi`,
    );
  }

  // ── 3. MAQSAD: qarz oylarini AYNI muhrlangan tarkib bilan ochish ──
  //
  // Bekor qilingan qator bo'lsa — O'SHA QATORNING O'ZIDA tiklanadi
  // (`finance.md` §5), aks holda yangi `id` bilan yoziladi.
  const invoiceOverride = (schema) => ({
    paid_amount: "0",
    paid_at: "NULL",
    status: `'unpaid'::${schemaType(schema, "InvoiceStatus")}`,
    source: `'manual'::${schemaType(schema, "InvoiceSource")}`,
    cancel_reason: "''",
    cancelled_at: "NULL",
    cancelled_by: "NULL",
    deposit_hold: "false",
    // Manbadagi qatorga ishora QILINMAYDI: `replaces_invoice_id` filial
    // ichidagi qayta shakllantirish zanjiri, boshqa schema'dagi `id` u
    // yerda osilib qolardi
    replaces_invoice_id: "NULL",
    note: "$3",
    created_by: "$4",
    created_at: "NOW()",
    updated_at: "NOW()",
  });
  const invoiceNote = `"${ctx.source.name}" filialidan ko'chirilgan qarz. ${ctx.reason}`;

  for (const item of live) {
    const pairs = item.plan.finance.debtPairs;
    if (!pairs.length) continue;

    // Tiklanadiganlar: maqsaddagi bekor qilingan qator O'SHA JOYIDA qayta
    // yoziladi. O'chirib qayta yozish EMAS — bekor qilingan oyning
    // taqsimotlari (`onDelete: Cascade`) bilan birga tarix ham o'chardi.
    const restoring = pairs.filter(([, targetId]) => targetId);
    if (restoring.length) {
      await copyRowsWithNewIds(db, ctx.cache, {
        from,
        to,
        table: "monthly_invoices",
        pairs: restoring.map(([sourceId, targetId]) => [targetId, sourceId]),
        override: invoiceOverride(to),
        params: [invoiceNote, ctx.actor.id],
        onConflict: "update",
      });
    }

    const fresh = pairs.filter(([, targetId]) => !targetId);
    if (fresh.length) {
      await copyRowsWithNewIds(db, ctx.cache, {
        from,
        to,
        table: "monthly_invoices",
        pairs: fresh.map(([sourceId]) => [generateId(), sourceId]),
        override: invoiceOverride(to),
        params: [invoiceNote, ctx.actor.id],
      });
    }
  }

  // ── 4. DEPOZIT ───────────────────────────────────────────────
  const movingMoney = live.filter((item) =>
    new Decimal(item.plan.finance.deposit).greaterThan(0),
  );

  // ⚠️ REJA BAZA BILAN SOLISHTIRILADI. Bekor qilishdan keyingi haqiqiy
  // qoldiq rejadagidan farq qilsa (ya'ni `invoice.paidAmount` taqsimotlar
  // yig'indisiga teng emas — §9 invariant 3 buzilgan), pul noto'g'ri
  // summada ko'chardi va IKKALA filial hisobi buzilardi. Bunday holatda
  // butun tranzaksiya orqaga qaytadi.
  // Tekshiruv HAR BIR qator uchun, faqat puli borlar uchun emas: reja "0"
  // deb hisoblagan joyda haqiqatda pul turgan bo'lsa, u manbada izohsiz
  // qolib ketardi.
  for (const item of live) {
    const [row] = await db.$queryRawUnsafe(
      `SELECT balance::text AS balance FROM ${src("student_accounts")} WHERE student_id = $1`,
      item.id,
    );
    const actual = new Decimal(row?.balance ?? 0);
    if (!actual.equals(item.plan.finance.deposit)) {
      throw new ConflictError(
        `"${item.label}" depoziti ko'rib chiqilgandan keyin o'zgardi ` +
          `(${formatAmount(item.plan.finance.deposit)} → ${formatAmount(actual)}) — qayta ko'rib chiqing`,
        { reason: "stale_plan" },
      );
    }
  }

  for (const item of movingMoney) {
    const { deposit } = item.plan.finance;
    // MANBA: qoldiq nolga tushadi. Cheklardagi `deposit_amount` o'z
    // joyida qoladi (chek — manba kassasining fakti), shuning uchun
    // invariant 2 aynan shu to'g'rilash bilan saqlanadi:
    //   Σ chek qoldig'i + (eski to'g'rilashlar − D) = 0
    await exec(
      `INSERT INTO ${src("student_balance_adjustments")}
         (id, student_id, amount, reason, created_by, created_at)
       VALUES ($1, $2, -$3::numeric, $4, $5, NOW())`,
      generateId(),
      item.id,
      deposit,
      `${reasonBase} — depozit yangi filialga o'tkazildi`,
      ctx.actor.id,
    );
    await exec(
      `UPDATE ${src("student_accounts")} SET balance = balance - $2::numeric, updated_at = NOW()
       WHERE student_id = $1`,
      item.id,
      deposit,
    );
  }

  // MAQSAD: pul CHEK bilan keladi, quruq to'g'rilash bilan emas.
  //
  // ⚠️ BU SHART, QULAYLIK EMAS. Depozitni avtomat yechish byudjeti —
  // `min(balans, CHEKLAR qoldig'i)` (`finance.md` §6): chekka bog'lanmagan
  // pul (`adjustBalance`) yechilmaydi. Faqat to'g'rilash bilan ko'chirilgan
  // depozit yangi filialda qarzga yechilmay, jimgina o'lik qolib ketardi.
  //
  // Chek kassaga ikkinchi marta pul qo'shmaydi: daftarga `payment` emas,
  // `branch_transfer_in` yoziladi (5-qadam) — kassa qoldig'i bir marta,
  // kunlik hisobotda esa "boshqa" ustunida ko'rinadi.
  const receiptsByStudent = new Map();
  for (const item of movingMoney) {
    for (const line of item.plan.finance.cashLines) {
      if (!line.targetAccountId) continue;
      const id = generateId();
      const written = await exec(
        `INSERT INTO ${tgt("payments")}
           (id, student_id, account_id, amount, allocated_amount, deposit_amount, paid_at,
            note, student_snapshot, is_voided, created_by, created_at, updated_at)
         SELECT $1, u.id, $2, $3::numeric, 0, $3::numeric, NOW(), $4,
                jsonb_build_object(
                  'firstName', u.first_name, 'lastName', u.last_name,
                  'username', u.username, 'classId', NULL, 'className', ''),
                false, $5, NOW(), NOW()
         FROM ${tgt("users")} u WHERE u.id = $6`,
        id,
        line.targetAccountId,
        line.amount,
        `"${ctx.source.name}" filialidan ko'chirilgan depozit. ${ctx.reason}`,
        ctx.actor.id,
        item.id,
      );
      // `INSERT … SELECT` maqsadda o'quvchi qatori bo'lmasa JIM 0 qator
      // yozardi va pul izsiz yo'qolardi (balans oshgan, cheki yo'q)
      if (written !== 1) {
        throw new ConflictError(
          `"${item.label}" uchun yangi filialda chek yozilmadi — profil ko'chmagan bo'lishi mumkin`,
          { reason: "transfer_failed" },
        );
      }
      receiptsByStudent.set(item.id, (receiptsByStudent.get(item.id) ?? []).concat(id));
    }

    // Chekka bog'lanmagan qism (manbadagi qo'lda to'g'rilash puli) —
    // maqsadda ham to'g'rilash bo'lib qoladi: u yerda ham yechilmaydi,
    // qoida ikkala filialda AYNI
    const nonCash = new Decimal(item.plan.finance.nonCashTotal);
    if (nonCash.greaterThan(0)) {
      await exec(
        `INSERT INTO ${tgt("student_balance_adjustments")}
           (id, student_id, amount, reason, created_by, created_at)
         VALUES ($1, $2, $3::numeric, $4, $5, NOW())`,
        generateId(),
        item.id,
        nonCash.toFixed(2),
        `"${ctx.source.name}" filialidan ko'chirilgan depozit (qo'lda to'g'rilash qismi). ${ctx.reason}`,
        ctx.actor.id,
      );
    }

    await exec(
      `UPDATE ${tgt("student_accounts")} SET balance = balance + $2::numeric, updated_at = NOW()
       WHERE student_id = $1`,
      item.id,
      item.plan.finance.deposit,
    );
  }

  // ── 5. KASSA (lock tartibida ENG OXIRIDA, `id` o'sish tartibida) ──
  //
  // Daftarga yozishning yagona shakli: `UPDATE ... balance + X RETURNING`
  // → qaytgan qiymat `balanceAfter` (`postEntry` doktrinasi; "o'qi →
  // hisobla → yoz" aynan yo'qolgan yangilanish shakli).
  const cashBySource = new Map();
  const cashByTarget = new Map();
  for (const item of movingMoney) {
    for (const line of item.plan.finance.cashLines) {
      const push = (map, accountId) => {
        if (!accountId) return;
        if (!map.has(accountId)) map.set(accountId, []);
        map.get(accountId).push({ item, line });
      };
      push(cashBySource, line.sourceAccountId);
      push(cashByTarget, line.targetAccountId);
    }
  }

  const names = (lines) => [...new Set(lines.map(({ item }) => item.label))].join(", ");
  const postEntries = async (schema, map, { income, type, noteOf }) => {
    for (const accountId of [...map.keys()].sort()) {
      const lines = map.get(accountId);
      const total = sumAmounts(lines.map(({ line }) => line.amount));
      if (!total.greaterThan(0)) continue;
      const delta = income ? total : total.negated();
      const [account] = await db.$queryRawUnsafe(
        `UPDATE ${qualified(schema, "payment_accounts")}
         SET balance = balance + $2::numeric, updated_at = NOW()
         WHERE id = $1 RETURNING balance::text AS balance`,
        accountId,
        delta.toFixed(2),
      );
      if (!account) throw new Error(`To'lov turi topilmadi: ${accountId}`);
      await exec(
        `INSERT INTO ${qualified(schema, "account_entries")}
           (id, account_id, type, amount, balance_after, occurred_at, note, created_by, created_at)
         VALUES ($1, $2, $3::text::${schemaType(schema, "AccountEntryType")},
                 $4::numeric, $5::numeric, NOW(), $6, $7, NOW())`,
        generateId(),
        accountId,
        type,
        delta.toFixed(2),
        account.balance,
        noteOf(lines),
        ctx.actor.id,
      );
    }
  };

  await postEntries(from, cashBySource, {
    income: false,
    type: "branch_transfer_out",
    noteOf: (lines) =>
      `"${ctx.target.name}" filialiga ko'chirilgan depozit: ${names(lines)} (${ctx.transferId})`,
  });
  await postEntries(to, cashByTarget, {
    income: true,
    type: "branch_transfer_in",
    noteOf: (lines) =>
      `"${ctx.source.name}" filialidan ko'chirilgan depozit: ${names(lines)} (${ctx.transferId})`,
  });

  for (const item of live) {
    const finance = item.plan.finance;
    result.set(item.id, {
      debtMonths: finance.debtMonths.map(formatMonthKey),
      debtAmount: finance.debtTotalAmount,
      vacatedMonths: finance.vacatingMonths.map(formatMonthKey),
      settledMonths: finance.settledMonths.length,
      deposit: finance.deposit,
      cash: finance.cashTotal,
      // Maqsadda yozilgan chek(lar) — jurnalda "pul qayerga tushdi"
      // degan savolga javob
      targetReceiptIds: receiptsByStudent.get(item.id) ?? [],
    });
  }
  return result;
};

module.exports = {
  OPEN_STATUSES,
  planStudentFinance,
  releaseAndCancel,
  writeStudentFinance,
};
