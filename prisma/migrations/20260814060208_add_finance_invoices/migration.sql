-- CreateEnum
CREATE TYPE "StudentFinanceStatusEnum" AS ENUM ('active', 'frozen', 'expelled');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('unpaid', 'partial', 'paid', 'cancelled');

-- CreateEnum
CREATE TYPE "InvoiceSource" AS ENUM ('cron', 'manual');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'card', 'transfer', 'other');

-- CreateTable
CREATE TABLE "finance_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT 'singleton',
    "academic_start_month" INTEGER NOT NULL DEFAULT 9,
    "academic_month_count" INTEGER NOT NULL DEFAULT 9,
    "invoice_day_of_month" INTEGER NOT NULL DEFAULT 1,
    "auto_generate_enabled" BOOLEAN NOT NULL DEFAULT true,
    "catch_up_months" INTEGER NOT NULL DEFAULT 1,
    "first_invoice_month" INTEGER,
    "last_run_at" TIMESTAMP(3),
    "last_generated_month" INTEGER,
    "updated_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_finance_statuses" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "status" "StudentFinanceStatusEnum" NOT NULL,
    "start_month" INTEGER NOT NULL,
    "end_month" INTEGER,
    "reason" TEXT NOT NULL DEFAULT '',
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_finance_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_invoices" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "month" INTEGER NOT NULL,
    "academic_year" INTEGER NOT NULL,
    "academic_index" INTEGER NOT NULL,
    "tariff_id" CHAR(24),
    "tariff_version_id" CHAR(24),
    "tariff_name" TEXT NOT NULL DEFAULT '',
    "amount" DECIMAL(14,2) NOT NULL,
    "paid_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'unpaid',
    "source" "InvoiceSource" NOT NULL DEFAULT 'cron',
    "student_snapshot" JSONB NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "cancel_reason" TEXT NOT NULL DEFAULT '',
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by" CHAR(24),
    "paid_at" TIMESTAMP(3),
    "created_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monthly_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_payments" (
    "id" CHAR(24) NOT NULL,
    "invoice_id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paid_at" TIMESTAMP(3) NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'cash',
    "note" TEXT NOT NULL DEFAULT '',
    "is_voided" BOOLEAN NOT NULL DEFAULT false,
    "voided_at" TIMESTAMP(3),
    "voided_by" CHAR(24),
    "void_reason" TEXT NOT NULL DEFAULT '',
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "student_finance_statuses_student_id_start_month_idx" ON "student_finance_statuses"("student_id", "start_month" DESC);

-- CreateIndex
CREATE INDEX "student_finance_statuses_start_month_end_month_idx" ON "student_finance_statuses"("start_month", "end_month");

-- CreateIndex
CREATE UNIQUE INDEX "student_finance_statuses_student_id_start_month_key" ON "student_finance_statuses"("student_id", "start_month");

-- CreateIndex
CREATE INDEX "monthly_invoices_month_status_idx" ON "monthly_invoices"("month", "status");

-- CreateIndex
CREATE INDEX "monthly_invoices_student_id_month_idx" ON "monthly_invoices"("student_id", "month" DESC);

-- CreateIndex
CREATE INDEX "monthly_invoices_status_month_idx" ON "monthly_invoices"("status", "month");

-- CreateIndex
CREATE UNIQUE INDEX "monthly_invoices_student_id_month_key" ON "monthly_invoices"("student_id", "month");

-- CreateIndex
CREATE INDEX "invoice_payments_invoice_id_paid_at_idx" ON "invoice_payments"("invoice_id", "paid_at");

-- CreateIndex
CREATE INDEX "invoice_payments_student_id_paid_at_idx" ON "invoice_payments"("student_id", "paid_at" DESC);

-- CreateIndex
CREATE INDEX "invoice_payments_paid_at_idx" ON "invoice_payments"("paid_at");

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "monthly_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
