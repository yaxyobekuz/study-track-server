-- Xarajat limiti ikki xil: qat'iy summa (money) yoki sof foyda foizi
-- (percentProfit). Foiz rejimida amaldagi limit jonli hisoblanadi.
ALTER TABLE "expense_budgets" ADD COLUMN "limit_kind" VARCHAR(16) NOT NULL DEFAULT 'money';
ALTER TABLE "expense_budgets" ADD COLUMN "limit_percent" DECIMAL(5, 2);
