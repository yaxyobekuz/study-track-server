-- CHIQIM: XODIMLAR OYLIGI VA XARAJATLAR
--
-- Kirim tomonining ko'zgusi:
--   StudentTariff     → StaffSalary       (qoida, davr bilan)
--   MonthlyInvoice    → PayrollEntry      (oylik majburiyat, MUHRLANGAN)
--   Payment           → SalaryPayment     (to'lov, LEKIN depozitsiz)
--   PaymentAllocation → SalaryAllocation
--   IncomeCategory    → ExpenseCategory
--   ExternalIncome    → Expense
--
-- ⚠️ LOCK TARTIBI: PayrollEntry (month asc, id asc) → PaymentAccount.
-- Kassa har ikkala yo'lda ham OXIRGI — deadlock shu sababli bo'lmaydi.

-- 1. Daftar turlari (pul CHIQADI → manfiy)
ALTER TYPE "AccountEntryType" ADD VALUE IF NOT EXISTS 'salary_payment';
ALTER TYPE "AccountEntryType" ADD VALUE IF NOT EXISTS 'salary_payment_void';
ALTER TYPE "AccountEntryType" ADD VALUE IF NOT EXISTS 'expense';
ALTER TYPE "AccountEntryType" ADD VALUE IF NOT EXISTS 'expense_void';

-- 2. Yangi enumlar
DO $$ BEGIN
    CREATE TYPE "SalaryType" AS ENUM ('fixed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "PayrollStatus" AS ENUM ('unpaid', 'partial', 'paid', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. Oylik qoidasi
CREATE TABLE "staff_salaries" (
    "id"          CHAR(24) NOT NULL,
    "staff_id"    CHAR(24) NOT NULL,
    "type"        "SalaryType" NOT NULL DEFAULT 'fixed',
    "amount"      DECIMAL(14,2) NOT NULL,
    "start_month" INTEGER NOT NULL,
    "end_month"   INTEGER,
    "note"        TEXT NOT NULL DEFAULT '',
    "created_by"  CHAR(24) NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "staff_salaries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "staff_salaries_staff_id_start_month_key" ON "staff_salaries"("staff_id", "start_month");
CREATE INDEX "staff_salaries_staff_id_start_month_idx" ON "staff_salaries"("staff_id", "start_month" DESC);

-- 4. Oylik majburiyat
CREATE TABLE "payroll_entries" (
    "id"             CHAR(24) NOT NULL,
    "staff_id"       CHAR(24) NOT NULL,
    "month"          INTEGER NOT NULL,
    "amount"         DECIMAL(14,2) NOT NULL,
    "paid_amount"    DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status"         "PayrollStatus" NOT NULL DEFAULT 'unpaid',
    "salary_type"    "SalaryType" NOT NULL DEFAULT 'fixed',
    "staff_snapshot" JSONB NOT NULL,
    "note"           TEXT NOT NULL DEFAULT '',
    "cancel_reason"  TEXT NOT NULL DEFAULT '',
    "cancelled_at"   TIMESTAMP(3),
    "cancelled_by"   CHAR(24),
    "paid_at"        TIMESTAMP(3),
    "created_by"     CHAR(24) NOT NULL,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "payroll_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payroll_entries_staff_id_month_key" ON "payroll_entries"("staff_id", "month");
CREATE INDEX "payroll_entries_month_status_idx" ON "payroll_entries"("month", "status");
CREATE INDEX "payroll_entries_staff_id_month_idx" ON "payroll_entries"("staff_id", "month" DESC);

-- 5. Oylik to'lovi
CREATE TABLE "salary_payments" (
    "id"             CHAR(24) NOT NULL,
    "staff_id"       CHAR(24) NOT NULL,
    "account_id"     CHAR(24) NOT NULL,
    "amount"         DECIMAL(14,2) NOT NULL,
    "paid_at"        TIMESTAMP(3) NOT NULL,
    "note"           TEXT NOT NULL DEFAULT '',
    "staff_snapshot" JSONB NOT NULL,
    "is_voided"      BOOLEAN NOT NULL DEFAULT false,
    "voided_at"      TIMESTAMP(3),
    "voided_by"      CHAR(24),
    "void_reason"    TEXT NOT NULL DEFAULT '',
    "created_by"     CHAR(24) NOT NULL,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "salary_payments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "salary_payments_staff_id_paid_at_idx" ON "salary_payments"("staff_id", "paid_at" DESC);
CREATE INDEX "salary_payments_account_id_paid_at_idx" ON "salary_payments"("account_id", "paid_at" DESC);
CREATE INDEX "salary_payments_paid_at_idx" ON "salary_payments"("paid_at");
ALTER TABLE "salary_payments" ADD CONSTRAINT "salary_payments_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "payment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. Taqsimot
CREATE TABLE "salary_allocations" (
    "id"               CHAR(24) NOT NULL,
    "payment_id"       CHAR(24) NOT NULL,
    "payroll_entry_id" CHAR(24) NOT NULL,
    "staff_id"         CHAR(24) NOT NULL,
    "amount"           DECIMAL(14,2) NOT NULL,
    "applied_at"       TIMESTAMP(3) NOT NULL,
    "is_voided"        BOOLEAN NOT NULL DEFAULT false,
    "voided_at"        TIMESTAMP(3),
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "salary_allocations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "salary_allocations_payroll_entry_id_is_voided_idx" ON "salary_allocations"("payroll_entry_id", "is_voided");
CREATE INDEX "salary_allocations_payment_id_idx" ON "salary_allocations"("payment_id");
ALTER TABLE "salary_allocations" ADD CONSTRAINT "salary_allocations_payment_id_fkey"
    FOREIGN KEY ("payment_id") REFERENCES "salary_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "salary_allocations" ADD CONSTRAINT "salary_allocations_payroll_entry_id_fkey"
    FOREIGN KEY ("payroll_entry_id") REFERENCES "payroll_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 7. Xarajat kategoriyalari
CREATE TABLE "expense_categories" (
    "id"          CHAR(24) NOT NULL,
    "name"        TEXT NOT NULL,
    "is_active"   BOOLEAN NOT NULL DEFAULT true,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "sort_order"  INTEGER NOT NULL DEFAULT 0,
    "created_by"  CHAR(24) NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "expense_categories_name_key" ON "expense_categories"("name");
CREATE INDEX "expense_categories_is_archived_is_active_sort_order_idx"
    ON "expense_categories"("is_archived", "is_active", "sort_order");

-- 8. Xarajatlar
CREATE TABLE "expenses" (
    "id"            CHAR(24) NOT NULL,
    "category_id"   CHAR(24) NOT NULL,
    "account_id"    CHAR(24) NOT NULL,
    "amount"        DECIMAL(14,2) NOT NULL,
    "category_name" TEXT NOT NULL DEFAULT '',
    "payee"         TEXT NOT NULL DEFAULT '',
    "note"          TEXT NOT NULL DEFAULT '',
    "occurred_at"   TIMESTAMP(3) NOT NULL,
    "is_voided"     BOOLEAN NOT NULL DEFAULT false,
    "voided_at"     TIMESTAMP(3),
    "voided_by"     CHAR(24),
    "void_reason"   TEXT NOT NULL DEFAULT '',
    "created_by"    CHAR(24) NOT NULL,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "expenses_occurred_at_idx" ON "expenses"("occurred_at" DESC);
CREATE INDEX "expenses_category_id_occurred_at_idx" ON "expenses"("category_id", "occurred_at" DESC);
CREATE INDEX "expenses_account_id_occurred_at_idx" ON "expenses"("account_id", "occurred_at" DESC);
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "payment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 9. Daftar yozuvi hujjatga ishora qiladi
ALTER TABLE "account_entries" ADD COLUMN "salary_payment_id" CHAR(24);
ALTER TABLE "account_entries" ADD COLUMN "expense_id" CHAR(24);
CREATE INDEX "account_entries_salary_payment_id_idx" ON "account_entries"("salary_payment_id");
CREATE INDEX "account_entries_expense_id_idx" ON "account_entries"("expense_id");
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_salary_payment_id_fkey"
    FOREIGN KEY ("salary_payment_id") REFERENCES "salary_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_expense_id_fkey"
    FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
