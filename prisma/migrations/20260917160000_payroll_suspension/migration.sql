-- OYLIKNI TO'XTATISH.
--
-- `payroll_suspensions` — tanlangan oy(lar)da oylikning butuni yoki bir qismi
-- hisoblanmaydi. `staff_id = NULL` → barcha xodimlar. Davr ikkala tomondan
-- majburiy (muddatsiz to'xtatish yo'q).
--
-- `payroll_entries.suspended_amount` / `suspension_breakdown` — muhrlangan
-- oylikda to'xtatilgan qism ALOHIDA saqlanadi: yalpi qismlar o'zgarmaydi va
-- to'xtatish bekor qilinsa oylik to'liq tiklanadi.

-- CreateEnum
CREATE TYPE "PayrollSuspensionComponent" AS ENUM ('all', 'base', 'tutor', 'allowances', 'item');

-- AlterTable
ALTER TABLE "payroll_entries" ADD COLUMN     "suspended_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "suspension_breakdown" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "payroll_suspensions" (
    "id" CHAR(24) NOT NULL,
    "staff_id" CHAR(24),
    "batch_id" CHAR(24) NOT NULL,
    "component" "PayrollSuspensionComponent" NOT NULL,
    "item_key" TEXT NOT NULL DEFAULT '',
    "item_label" TEXT NOT NULL DEFAULT '',
    "start_month" INTEGER NOT NULL,
    "end_month" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "status" "DeductionStatus" NOT NULL DEFAULT 'active',
    "cancel_reason" TEXT NOT NULL DEFAULT '',
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by" CHAR(24),
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_suspensions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payroll_suspensions_staff_id_status_start_month_idx" ON "payroll_suspensions"("staff_id", "status", "start_month");

-- CreateIndex
CREATE INDEX "payroll_suspensions_status_start_month_idx" ON "payroll_suspensions"("status", "start_month");

-- CreateIndex
CREATE INDEX "payroll_suspensions_batch_id_idx" ON "payroll_suspensions"("batch_id");
