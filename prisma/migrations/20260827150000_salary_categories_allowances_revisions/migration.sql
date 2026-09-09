-- Xodim oyligi: malaka TOIFASI katalogi (soatlik KPI stavka), USTAMA qoidalari,
-- payroll breakdown; hamda dars jadvali TAHRIRLAR TARIXI (revision).

-- ── Malaka toifasi katalogi ──────────────────
CREATE TABLE "salary_categories" (
  "id" CHAR(24) NOT NULL,
  "name" TEXT NOT NULL,
  "per_hour_rate" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "description" TEXT NOT NULL DEFAULT '',
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "is_archived" BOOLEAN NOT NULL DEFAULT false,
  "archived_at" TIMESTAMP(3),
  "created_by" CHAR(24) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "salary_categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "salary_categories_name_key" ON "salary_categories"("name");
CREATE INDEX "salary_categories_is_archived_is_active_name_idx"
  ON "salary_categories"("is_archived","is_active","name");

-- ── StaffSalary: toifa + ustama qoidalari ────
ALTER TABLE "staff_salaries" ADD COLUMN "category_id" CHAR(24);
ALTER TABLE "staff_salaries" ADD COLUMN "allowances" JSONB NOT NULL DEFAULT '[]';

-- ── PayrollEntry: muhrlangan breakdown ───────
ALTER TABLE "payroll_entries" ADD COLUMN "allowance_amount" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "payroll_entries" ADD COLUMN "allowance_breakdown" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "payroll_entries" ADD COLUMN "category_name" TEXT NOT NULL DEFAULT '';

-- ── Dars jadvali tahrirlar tarixi ────────────
CREATE TABLE "schedule_revisions" (
  "id" CHAR(24) NOT NULL,
  "class_id" CHAR(24) NOT NULL,
  "edited_by" CHAR(24),
  "edited_by_name" TEXT NOT NULL DEFAULT '',
  "edited_by_role" TEXT NOT NULL DEFAULT '',
  "ip" TEXT NOT NULL DEFAULT '',
  "summary" TEXT NOT NULL DEFAULT '',
  "action" TEXT NOT NULL DEFAULT 'edit',
  "snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "schedule_revisions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "schedule_revisions_class_id_created_at_idx"
  ON "schedule_revisions"("class_id","created_at" DESC);
