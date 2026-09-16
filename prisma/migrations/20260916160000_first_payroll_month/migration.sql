-- Qattiq pol: xodim oyligi shu oydan oldin shakllanmaydi. `firstInvoiceMonth`
-- ning chiqim tomonidagi ko'zgusi — "hamma xodim shu oydan ish boshladi".
ALTER TABLE "finance_settings" ADD COLUMN "first_payroll_month" INTEGER;
