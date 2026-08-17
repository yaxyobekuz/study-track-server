/*
  MOLIYA — KIRIM BO'LIMI (chegirma, depozit, kassa, ta'til).

  MA'LUMOT XAVFSIZLIGI. Uchta operator ma'lumot yo'qotishi mumkin edi:

    - DROP TABLE "invoice_payments"
    - monthly_invoices ga default'siz NOT NULL ustunlar
      (base_amount, billable_index, billable_month_count)

  Ishga tushirishdan oldin ikkala jadval ham BO'SH edi (0 qator) — tizim
  hali kirim bo'limisiz ishlayotgan edi va birorta hisob-faktura
  shakllantirilmagan edi. Shuning uchun bu operatorlar ma'lumot
  yo'qotmaydi. Saqlanadi: tariffs (3), tariff_versions (4),
  student_tariffs (14), finance_settings, student_finance_statuses.

  Bo'sh bo'lmagan bazada ishlatishdan OLDIN qatorlarni sanang.

  `invoice_payments` ikkiga bo'lindi: `payments` (kassa cheki — pulni bir
  marta qabul qilish akti) va `payment_allocations` (chekning bitta oyga
  tushgan ulushi). Kassir endi bitta summa kiritadi, tizim eng eski
  qarzdan boshlab taqsimlaydi. `PaymentMethod` enumi olib tashlandi —
  "naqdmi?" savoliga javob endi `payment_accounts.type` dan keladi.
*/
-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('percent', 'fixed');

-- CreateEnum
CREATE TYPE "PaymentAccountType" AS ENUM ('cash', 'card', 'bank', 'online', 'other');

-- CreateEnum
CREATE TYPE "AccountEntryType" AS ENUM ('payment', 'payment_void', 'transfer_in', 'transfer_out', 'refund', 'refund_void', 'adjustment');

-- CreateEnum
CREATE TYPE "AllocationSource" AS ENUM ('payment', 'deposit');

-- DropForeignKey
ALTER TABLE "invoice_payments" DROP CONSTRAINT "invoice_payments_invoice_id_fkey";

-- AlterTable
ALTER TABLE "finance_settings" ADD COLUMN     "deposit_auto_apply" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "max_discount_percent" INTEGER NOT NULL DEFAULT 100;

-- AlterTable
ALTER TABLE "monthly_invoices" ADD COLUMN     "base_amount" DECIMAL(14,2) NOT NULL,
ADD COLUMN     "billable_index" INTEGER NOT NULL,
ADD COLUMN     "billable_month_count" INTEGER NOT NULL,
ADD COLUMN     "discount_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "discount_snapshot" JSONB,
ADD COLUMN     "replaces_invoice_id" CHAR(24);

-- DropTable
DROP TABLE "invoice_payments";

-- DropEnum
DROP TYPE "PaymentMethod";

-- CreateTable
CREATE TABLE "discounts" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "type" "DiscountType" NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "is_exclusive" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_discounts" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "discount_id" CHAR(24) NOT NULL,
    "start_month" INTEGER NOT NULL,
    "end_month" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_discounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vacation_months" (
    "id" CHAR(24) NOT NULL,
    "month" INTEGER NOT NULL,
    "academic_year" INTEGER NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vacation_months_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_accounts" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PaymentAccountType" NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "opening_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_transfers" (
    "id" CHAR(24) NOT NULL,
    "from_account_id" CHAR(24) NOT NULL,
    "to_account_id" CHAR(24) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "fee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "is_voided" BOOLEAN NOT NULL DEFAULT false,
    "voided_at" TIMESTAMP(3),
    "voided_by" CHAR(24),
    "void_reason" TEXT NOT NULL DEFAULT '',
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_entries" (
    "id" CHAR(24) NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "account_id" CHAR(24) NOT NULL,
    "type" "AccountEntryType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "balance_after" DECIMAL(14,2) NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "payment_id" CHAR(24),
    "transfer_id" CHAR(24),
    "refund_id" CHAR(24),
    "note" TEXT NOT NULL DEFAULT '',
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" CHAR(24) NOT NULL,
    "receipt_no" SERIAL NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "account_id" CHAR(24) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "allocated_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deposit_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paid_at" TIMESTAMP(3) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "student_snapshot" JSONB NOT NULL,
    "is_voided" BOOLEAN NOT NULL DEFAULT false,
    "voided_at" TIMESTAMP(3),
    "voided_by" CHAR(24),
    "void_reason" TEXT NOT NULL DEFAULT '',
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" CHAR(24) NOT NULL,
    "payment_id" CHAR(24) NOT NULL,
    "invoice_id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "source" "AllocationSource" NOT NULL DEFAULT 'payment',
    "applied_at" TIMESTAMP(3) NOT NULL,
    "is_voided" BOOLEAN NOT NULL DEFAULT false,
    "voided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_accounts" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_balance_adjustments" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_balance_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "account_id" CHAR(24) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "refunded_at" TIMESTAMP(3) NOT NULL,
    "is_voided" BOOLEAN NOT NULL DEFAULT false,
    "voided_at" TIMESTAMP(3),
    "voided_by" CHAR(24),
    "void_reason" TEXT NOT NULL DEFAULT '',
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "discounts_name_key" ON "discounts"("name");

-- CreateIndex
CREATE INDEX "discounts_is_archived_is_active_name_idx" ON "discounts"("is_archived", "is_active", "name");

-- CreateIndex
CREATE INDEX "student_discounts_student_id_start_month_idx" ON "student_discounts"("student_id", "start_month" DESC);

-- CreateIndex
CREATE INDEX "student_discounts_start_month_end_month_idx" ON "student_discounts"("start_month", "end_month");

-- CreateIndex
CREATE INDEX "student_discounts_discount_id_idx" ON "student_discounts"("discount_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_discounts_student_id_discount_id_start_month_key" ON "student_discounts"("student_id", "discount_id", "start_month");

-- CreateIndex
CREATE UNIQUE INDEX "vacation_months_month_key" ON "vacation_months"("month");

-- CreateIndex
CREATE INDEX "vacation_months_academic_year_idx" ON "vacation_months"("academic_year");

-- CreateIndex
CREATE UNIQUE INDEX "payment_accounts_name_key" ON "payment_accounts"("name");

-- CreateIndex
CREATE INDEX "payment_accounts_is_archived_is_active_sort_order_idx" ON "payment_accounts"("is_archived", "is_active", "sort_order");

-- CreateIndex
CREATE INDEX "account_transfers_occurred_at_idx" ON "account_transfers"("occurred_at" DESC);

-- CreateIndex
CREATE INDEX "account_entries_account_id_seq_idx" ON "account_entries"("account_id", "seq" DESC);

-- CreateIndex
CREATE INDEX "account_entries_account_id_occurred_at_idx" ON "account_entries"("account_id", "occurred_at");

-- CreateIndex
CREATE INDEX "account_entries_occurred_at_idx" ON "account_entries"("occurred_at");

-- CreateIndex
CREATE INDEX "account_entries_transfer_id_idx" ON "account_entries"("transfer_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_receipt_no_key" ON "payments"("receipt_no");

-- CreateIndex
CREATE INDEX "payments_student_id_paid_at_idx" ON "payments"("student_id", "paid_at" DESC);

-- CreateIndex
CREATE INDEX "payments_account_id_paid_at_idx" ON "payments"("account_id", "paid_at" DESC);

-- CreateIndex
CREATE INDEX "payments_paid_at_idx" ON "payments"("paid_at");

-- CreateIndex
CREATE INDEX "payment_allocations_invoice_id_is_voided_idx" ON "payment_allocations"("invoice_id", "is_voided");

-- CreateIndex
CREATE INDEX "payment_allocations_payment_id_is_voided_idx" ON "payment_allocations"("payment_id", "is_voided");

-- CreateIndex
CREATE INDEX "payment_allocations_student_id_applied_at_idx" ON "payment_allocations"("student_id", "applied_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "student_accounts_student_id_key" ON "student_accounts"("student_id");

-- CreateIndex
CREATE INDEX "student_balance_adjustments_student_id_created_at_idx" ON "student_balance_adjustments"("student_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "refunds_student_id_refunded_at_idx" ON "refunds"("student_id", "refunded_at" DESC);

-- CreateIndex
CREATE INDEX "refunds_account_id_refunded_at_idx" ON "refunds"("account_id", "refunded_at" DESC);

-- AddForeignKey
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_from_account_id_fkey" FOREIGN KEY ("from_account_id") REFERENCES "payment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_to_account_id_fkey" FOREIGN KEY ("to_account_id") REFERENCES "payment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "payment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "account_transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "payment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "monthly_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "payment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
