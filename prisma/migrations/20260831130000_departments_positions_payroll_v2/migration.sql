-- Payroll v2: BO'LIM (Department) + LAVOZIM (Position) + toifa kengaytmasi +
-- tasdiqlangan ustama (PayrollBonus). Maosh xodimga emas — lavozimga (staff)
-- yoki toifaga (teaching) biriktiriladi.

-- ── Enumlar ──────────────────────────────────
CREATE TYPE "DepartmentKind" AS ENUM ('staff', 'teaching');
CREATE TYPE "AllowanceKind" AS ENUM ('fixed', 'percent');

-- ── Bo'limlar ────────────────────────────────
CREATE TABLE "departments" (
  "id" CHAR(24) NOT NULL,
  "name" TEXT NOT NULL,
  "kind" "DepartmentKind" NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_by" CHAR(24) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "departments_name_key" ON "departments"("name");
CREATE INDEX "departments_kind_is_active_sort_order_idx" ON "departments"("kind","is_active","sort_order");

-- ── Lavozimlar ───────────────────────────────
CREATE TABLE "positions" (
  "id" CHAR(24) NOT NULL,
  "department_id" CHAR(24) NOT NULL,
  "name" TEXT NOT NULL,
  "base_salary" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_by" CHAR(24) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "positions_department_id_name_key" ON "positions"("department_id","name");
CREATE INDEX "positions_department_id_is_active_idx" ON "positions"("department_id","is_active");
ALTER TABLE "positions" ADD CONSTRAINT "positions_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Tasdiqlangan ustamalar ───────────────────
CREATE TABLE "payroll_bonuses" (
  "id" CHAR(24) NOT NULL,
  "staff_id" CHAR(24) NOT NULL,
  "label" TEXT NOT NULL DEFAULT '',
  "type" "AllowanceKind" NOT NULL DEFAULT 'fixed',
  "value" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "start_month" INTEGER NOT NULL,
  "end_month" INTEGER,
  "source_request_id" CHAR(24),
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_by" CHAR(24) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payroll_bonuses_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "payroll_bonuses_staff_id_is_active_start_month_idx" ON "payroll_bonuses"("staff_id","is_active","start_month");

-- ── SalaryCategory kengaytmasi ───────────────
ALTER TABLE "salary_categories" ADD COLUMN "department_id" CHAR(24);
ALTER TABLE "salary_categories" ADD COLUMN "monthly_per_hour" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "salary_categories" ADD COLUMN "hours_per_stavka" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "salary_categories" ADD COLUMN "base_salary" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "salary_categories" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;
DROP INDEX IF EXISTS "salary_categories_name_key";
DROP INDEX IF EXISTS "salary_categories_is_archived_is_active_name_idx";
CREATE UNIQUE INDEX "salary_categories_department_id_name_key" ON "salary_categories"("department_id","name");
CREATE INDEX "salary_categories_dept_status_idx" ON "salary_categories"("department_id","is_archived","is_active","sort_order");
ALTER TABLE "salary_categories" ADD CONSTRAINT "salary_categories_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── User biriktirmalari ──────────────────────
ALTER TABLE "users" ADD COLUMN "position_id" CHAR(24);
ALTER TABLE "users" ADD COLUMN "salary_category_id" CHAR(24);

-- ── PayrollEntry snapshotlari ────────────────
ALTER TABLE "payroll_entries" ADD COLUMN "position_name" TEXT NOT NULL DEFAULT '';
ALTER TABLE "payroll_entries" ADD COLUMN "department_name" TEXT NOT NULL DEFAULT '';
