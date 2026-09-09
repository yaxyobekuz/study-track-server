-- To'lov boshlanadigan oy — birinchi oy summasi aynan shu oyga biriktiriladi.
-- Kirgan sana (startDate) undan oldin bo'lishi mumkin (avgustda kelib
-- sentyabrdan to'lash): tarif shu oydan boshlanadi, oldingi oylar hisob-
-- fakturaga tushmaydi. null bo'lsa — kirgan sana oyi ishlatiladi.

ALTER TABLE "student_enrollments" ADD COLUMN "first_month_key" INTEGER;
