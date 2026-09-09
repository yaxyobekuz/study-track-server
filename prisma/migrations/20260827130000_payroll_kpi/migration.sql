-- Xodim oyligiga KPI (dars soatlari bo'yicha) komponentini qo'shish.
-- Oylik endi: fixed (qat'iy) + kpi (perHourRate × oylik dars soati) = mixed.

-- SalaryType enum: yangi qiymatlar
ALTER TYPE "SalaryType" ADD VALUE IF NOT EXISTS 'kpi';
ALTER TYPE "SalaryType" ADD VALUE IF NOT EXISTS 'mixed';

-- StaffSalary: `amount` -> `fixed_amount` (fiksa komponent), + `per_hour_rate` (KPI stavka)
ALTER TABLE "staff_salaries" RENAME COLUMN "amount" TO "fixed_amount";
ALTER TABLE "staff_salaries" ALTER COLUMN "fixed_amount" SET DEFAULT 0;
ALTER TABLE "staff_salaries" ADD COLUMN "per_hour_rate" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- PayrollEntry: muhrlangan summa breakdown
ALTER TABLE "payroll_entries" ADD COLUMN "fixed_amount" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "payroll_entries" ADD COLUMN "kpi_amount" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "payroll_entries" ADD COLUMN "lesson_hours" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "payroll_entries" ADD COLUMN "per_hour_rate" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- Mavjud majburiyatlar to'liq fiksa edi
UPDATE "payroll_entries" SET "fixed_amount" = "amount";
