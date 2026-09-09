-- Oylik so'rovlari (SalaryRequest) — o'qituvchi/xodim oyligini ko'rib chiqishni
-- so'raydi (hujjat + izoh + ixtiyoriy taklif). Admin tasdiqlaydi/rad etadi.
-- Tasdiq oylikni AVTOMAT o'zgartirmaydi (StaffSalary doktrinasi): sof additive.

CREATE TYPE "SalaryRequestType" AS ENUM ('raise', 'bonus', 'other');

CREATE TABLE "salary_requests" (
  "id" CHAR(24) NOT NULL,
  "staff_id" CHAR(24) NOT NULL,
  "type" "SalaryRequestType" NOT NULL DEFAULT 'raise',
  "status" "ReviewStatus" NOT NULL DEFAULT 'pending',
  "reason" TEXT,
  "proposed_amount" DECIMAL(14,2),
  "proposed_hourly_rate" DECIMAL(14,2),
  "proposed_start_month" INTEGER,
  "attachments" JSONB NOT NULL DEFAULT '[]',
  "reviewed_by" CHAR(24),
  "reviewed_at" TIMESTAMP(3),
  "rejection_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "salary_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "salary_requests_staff_id_created_at_idx" ON "salary_requests"("staff_id","created_at" DESC);
CREATE INDEX "salary_requests_status_created_at_idx" ON "salary_requests"("status","created_at" DESC);
