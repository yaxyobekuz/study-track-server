-- XARAJAT LIMITI — kategoriya bo'yicha oylik shift.
--
-- QO'SHIMCHA jadval: mavjud birorta ustun o'zgarmaydi. Limit hech narsani
-- to'smaydi — u faqat hisobotda "rejadan oshdi" degan belgini beradi.

CREATE TABLE IF NOT EXISTS "expense_budgets" (
    "id" CHAR(24) NOT NULL,
    "month" INTEGER NOT NULL,
    "category_id" CHAR(24) NOT NULL,
    "limit_amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "created_by" CHAR(24) NOT NULL,
    "updated_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_budgets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "expense_budgets_month_category_id_key"
  ON "expense_budgets"("month", "category_id");

CREATE INDEX IF NOT EXISTS "expense_budgets_month_idx"
  ON "expense_budgets"("month");

DO $$
BEGIN
  ALTER TABLE "expense_budgets"
    ADD CONSTRAINT "expense_budgets_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "expense_categories"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
