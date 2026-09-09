-- Birinchi oy summasi qo'lda + kun-proratsiyasi o'chirildi.
-- Yangi o'quvchida birinchi oy qarzi qo'lda belgilanadi (student_enrollments.
-- first_month_amount); keyingi oylar to'liq tarif bo'yicha. Proratsiya default
-- o'chiq va mavjud sozlama ham o'chiriladi.

ALTER TABLE "student_enrollments" ADD COLUMN "first_month_amount" DECIMAL(14,2);

ALTER TABLE "finance_settings" ALTER COLUMN "proration_enabled" SET DEFAULT false;
UPDATE "finance_settings" SET "proration_enabled" = false;
