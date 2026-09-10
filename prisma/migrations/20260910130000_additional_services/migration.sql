-- Qo'shimcha xizmatlar (yotoqxona, ovqat, transport, ...).
--   1. Service — xizmat katalogi (filialda, nom + oylik narx).
--   2. StudentService — o'quvchiga biriktirish (davr, oy aniqligida).
--   3. MonthlyInvoice.servicesAmount/servicesSnapshot — xizmatlar ulushi
--      snapshoti (baseAmount ichida, hisobot uchun alohida ko'rinadi).

-- ── 1. Xizmat katalogi ────────────────────────
CREATE TABLE "services" (
  "id" CHAR(24) NOT NULL,
  "name" TEXT NOT NULL,
  "monthly_amount" DECIMAL(14,2) NOT NULL,
  "note" TEXT NOT NULL DEFAULT '',
  "is_archived" BOOLEAN NOT NULL DEFAULT false,
  "created_by" CHAR(24) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "services_name_key" ON "services"("name");

-- ── 2. Biriktirmalar ──────────────────────────
CREATE TABLE "student_services" (
  "id" CHAR(24) NOT NULL,
  "student_id" CHAR(24) NOT NULL,
  "service_id" CHAR(24) NOT NULL,
  "start_month" INTEGER NOT NULL,
  "end_month" INTEGER,
  "custom_amount" DECIMAL(14,2),
  "note" TEXT NOT NULL DEFAULT '',
  "created_by" CHAR(24) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "student_services_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "student_services_student_id_service_id_start_month_key" ON "student_services"("student_id","service_id","start_month");
CREATE INDEX "student_services_student_id_start_month_idx" ON "student_services"("student_id","start_month" DESC);
CREATE INDEX "student_services_start_month_end_month_idx" ON "student_services"("start_month","end_month");
CREATE INDEX "student_services_service_id_idx" ON "student_services"("service_id");

-- ── 3. Invoice xizmatlar snapshoti ────────────
ALTER TABLE "monthly_invoices" ADD COLUMN "services_amount" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "monthly_invoices" ADD COLUMN "services_snapshot" JSONB;
