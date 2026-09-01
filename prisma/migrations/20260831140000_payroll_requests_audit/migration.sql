-- Payroll zayavkalari (PayrollRequest) + oylik strukturasi audit qaydlari
-- (PayrollAudit). O'qituvchi/xodim toifa yoki ustama so'raydi; admin tasdiqlaydi.

-- ── Zayavka turi ─────────────────────────────
CREATE TYPE "PayrollRequestKind" AS ENUM ('category', 'bonus');

-- ── Zayavkalar ───────────────────────────────
CREATE TABLE "payroll_requests" (
  "id" CHAR(24) NOT NULL,
  "staff_id" CHAR(24) NOT NULL,
  "kind" "PayrollRequestKind" NOT NULL,
  "status" "ReviewStatus" NOT NULL DEFAULT 'pending',
  "reason" TEXT,
  "requested_category_id" CHAR(24),
  "bonus_label" TEXT,
  "bonus_type" "AllowanceKind",
  "bonus_value" DECIMAL(14,2),
  "bonus_start_month" INTEGER,
  "bonus_end_month" INTEGER,
  "attachments" JSONB NOT NULL DEFAULT '[]',
  "reviewed_by" CHAR(24),
  "reviewed_at" TIMESTAMP(3),
  "rejection_reason" TEXT,
  "result_bonus_id" CHAR(24),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payroll_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "payroll_requests_staff_id_created_at_idx" ON "payroll_requests"("staff_id","created_at" DESC);
CREATE INDEX "payroll_requests_status_created_at_idx" ON "payroll_requests"("status","created_at" DESC);

-- ── Audit qaydlari ───────────────────────────
CREATE TABLE "payroll_audits" (
  "id" CHAR(24) NOT NULL,
  "actor_id" CHAR(24) NOT NULL,
  "action" TEXT NOT NULL,
  "target_type" TEXT NOT NULL,
  "target_id" CHAR(24) NOT NULL,
  "summary" TEXT NOT NULL DEFAULT '',
  "old_value" JSONB,
  "new_value" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payroll_audits_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "payroll_audits_target_type_target_id_created_at_idx" ON "payroll_audits"("target_type","target_id","created_at" DESC);
CREATE INDEX "payroll_audits_created_at_idx" ON "payroll_audits"("created_at" DESC);
