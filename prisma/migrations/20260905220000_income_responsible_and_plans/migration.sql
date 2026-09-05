-- MAS'UL XODIM + YIG'ISH REJASI.
--
-- Ikkalasi ham QO'SHIMCHA: mavjud kirimlar tegilmaydi, `responsible_id`
-- ularda null bo'lib qoladi va hisobotda "Mas'ul belgilanmagan" qatoriga
-- tushadi.

ALTER TABLE "external_incomes"
  ADD COLUMN IF NOT EXISTS "responsible_id" CHAR(24);

ALTER TABLE "external_incomes"
  ADD COLUMN IF NOT EXISTS "responsible_name" TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS "external_incomes_responsible_id_occurred_at_idx"
  ON "external_incomes"("responsible_id", "occurred_at" DESC);

CREATE TABLE IF NOT EXISTS "income_plans" (
    "id" CHAR(24) NOT NULL,
    "month" INTEGER NOT NULL,
    "responsible_id" CHAR(24) NOT NULL,
    "category_id" CHAR(24) NOT NULL,
    "target_amount" DECIMAL(14,2) NOT NULL,
    "student_count" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "created_by" CHAR(24) NOT NULL,
    "updated_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "income_plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "income_plans_month_responsible_id_category_id_key"
  ON "income_plans"("month", "responsible_id", "category_id");

CREATE INDEX IF NOT EXISTS "income_plans_month_idx" ON "income_plans"("month");

DO $$
BEGIN
  ALTER TABLE "income_plans"
    ADD CONSTRAINT "income_plans_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "income_categories"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
