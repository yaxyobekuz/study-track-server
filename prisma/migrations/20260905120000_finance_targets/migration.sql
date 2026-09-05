-- MOLIYAVIY REJA (byudjet) + EBITDA bayrog'i.
--
-- Ikkalasi ham QO'SHIMCHA: mavjud birorta ustun o'zgarmaydi, birorta qator
-- ko'chirilmaydi. `exclude_from_ebitda` sukut bo'yicha false — ya'ni
-- migratsiyadan keyin EBITDA sof foydaga teng bo'lib turadi va buxgalter
-- "Soliqlar"/"Amortizatsiya" kategoriyalarini belgilagach haqiqiy qiymatga
-- keladi.

ALTER TABLE "expense_categories"
  ADD COLUMN IF NOT EXISTS "exclude_from_ebitda" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "finance_targets" (
    "id" CHAR(24) NOT NULL,
    "month" INTEGER NOT NULL,
    "metric" VARCHAR(40) NOT NULL,
    "plan_value" DECIMAL(14,2) NOT NULL,
    "actual_value" DECIMAL(14,2),
    "note" TEXT NOT NULL DEFAULT '',
    "created_by" CHAR(24) NOT NULL,
    "updated_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_targets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "finance_targets_month_metric_key"
  ON "finance_targets"("month", "metric");

CREATE INDEX IF NOT EXISTS "finance_targets_month_idx"
  ON "finance_targets"("month");
