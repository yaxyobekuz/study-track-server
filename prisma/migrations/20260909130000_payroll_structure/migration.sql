-- OYLIK STRUKTURASI (bo'lim / lavozim / toifa) — tashkiliy qatlam.
-- StaffSalary oylik-hisobidan ALOHIDA ishlaydi (coexist): xodimlar bo'lim va
-- lavozim/toifa bo'yicha tashkil etiladi, hisoblangan oylik ko'rsatiladi.

CREATE TYPE "DepartmentKind" AS ENUM ('staff', 'teaching');

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

-- ── Malaka toifalari (teaching) ──────────────
CREATE TABLE "salary_categories" (
  "id" CHAR(24) NOT NULL,
  "department_id" CHAR(24),
  "name" TEXT NOT NULL,
  "per_hour_rate" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "monthly_per_hour" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "hours_per_stavka" INTEGER NOT NULL DEFAULT 0,
  "base_salary" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "description" TEXT NOT NULL DEFAULT '',
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "is_archived" BOOLEAN NOT NULL DEFAULT false,
  "archived_at" TIMESTAMP(3),
  "created_by" CHAR(24) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "salary_categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "salary_categories_department_id_name_key" ON "salary_categories"("department_id","name");
CREATE INDEX "salary_categories_dept_status_idx" ON "salary_categories"("department_id","is_archived","is_active","sort_order");
ALTER TABLE "salary_categories" ADD CONSTRAINT "salary_categories_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── User biriktirmalari ──────────────────────
ALTER TABLE "users" ADD COLUMN "position_id" CHAR(24);
ALTER TABLE "users" ADD COLUMN "salary_category_id" CHAR(24);
