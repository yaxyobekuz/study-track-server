-- OYLIKDAN USHLAB QOLISH.
-- `payroll_deductions` — har xodimga alohida qator ("hammaga" amali ham `batch_id`
-- bilan guruhlangan alohida qatorlar). O'chirilmaydi — `status = cancelled`.
-- `payroll_entries` ga muhrlangan ushlab qolish summasi va tafsiloti qo'shiladi:
-- amount = fixed + allowance + kpi − deduction. Eski qatorlarda 0 / [] (o'zgarmaydi).
-- Turi: fixed (so'm) / percent (yalpidan foiz) / hours (dars soati × soat narxi).

-- CreateEnum
CREATE TYPE "DeductionStatus" AS ENUM ('active', 'cancelled');

-- CreateEnum
CREATE TYPE "DeductionKind" AS ENUM ('fixed', 'percent', 'hours');

-- AlterTable
ALTER TABLE "payroll_entries" ADD COLUMN     "deduction_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "deduction_breakdown" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "payroll_deductions" (
    "id" CHAR(24) NOT NULL,
    "staff_id" CHAR(24) NOT NULL,
    "batch_id" CHAR(24) NOT NULL,
    "reason" TEXT NOT NULL,
    "type" "DeductionKind" NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "start_month" INTEGER NOT NULL,
    "end_month" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',
    "status" "DeductionStatus" NOT NULL DEFAULT 'active',
    "cancel_reason" TEXT NOT NULL DEFAULT '',
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by" CHAR(24),
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_deductions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payroll_deductions_staff_id_status_start_month_idx" ON "payroll_deductions"("staff_id", "status", "start_month");

-- CreateIndex
CREATE INDEX "payroll_deductions_batch_id_idx" ON "payroll_deductions"("batch_id");

-- CreateIndex
CREATE INDEX "payroll_deductions_status_start_month_idx" ON "payroll_deductions"("status", "start_month");
