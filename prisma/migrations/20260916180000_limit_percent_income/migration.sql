-- Xarajat limitining foiz rejimi bazasi SOF FOYDA emas, UMUMIY KIRIM bo'ldi.
-- Mavjud "percentProfit" qatorlarni yangi nomga o'tkazamiz (idempotent —
-- qator bo'lmasa hech narsa o'zgarmaydi).
UPDATE "expense_budgets" SET "limit_kind" = 'percentIncome' WHERE "limit_kind" = 'percentProfit';
