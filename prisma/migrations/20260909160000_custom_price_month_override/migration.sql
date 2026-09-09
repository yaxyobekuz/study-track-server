-- Individual (maxsus) narx + oy summasi override'i (sabab bilan).
--   1. StudentTariff.customAmount — o'quvchining shu tarif davridagi doimiy
--      maxsus narxi (katalog o'rniga).
--   2. StudentMonthOverride — bitta oy uchun sababli summa (ommaviy grant ham).
--   3. MonthlyInvoice.overrideReason/overrideNote — override sababi snapshoti.

-- ── 1. Individual narx ────────────────────────
ALTER TABLE "student_tariffs" ADD COLUMN "custom_amount" DECIMAL(14,2);

-- ── 2. Oy summasi override'i ──────────────────
CREATE TYPE "MonthOverrideReason" AS ENUM ('late_join', 'sickness', 'family', 'other');

CREATE TABLE "student_month_overrides" (
  "id" CHAR(24) NOT NULL,
  "student_id" CHAR(24) NOT NULL,
  "month" INTEGER NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "reason_code" "MonthOverrideReason" NOT NULL,
  "note" TEXT NOT NULL DEFAULT '',
  "created_by" CHAR(24) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "student_month_overrides_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "student_month_overrides_student_id_month_key" ON "student_month_overrides"("student_id","month");
CREATE INDEX "student_month_overrides_month_idx" ON "student_month_overrides"("month");

-- ── 3. Invoice override snapshoti ─────────────
ALTER TABLE "monthly_invoices" ADD COLUMN "override_reason" TEXT;
ALTER TABLE "monthly_invoices" ADD COLUMN "override_note" TEXT;
