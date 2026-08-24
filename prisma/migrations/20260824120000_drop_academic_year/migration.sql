-- O'QUV YILI TUSHUNCHASINI OLIB TASHLASH
--
-- Yangi qoida: o'qish davri cheksiz deb qaraladi va o'quvchi maktabda bo'lgan
-- HAR OY uchun to'lov yoziladi. Yagona umumiy istisno — ta'til oyi.
--
-- Shu sababli quyidagilar keraksiz bo'ldi:
--   * sozlamadagi o'quv yili oynasi (boshlanish oyi + davomiyligi),
--   * ta'til oyining o'quv yiliga bog'lanishi,
--   * hisob-fakturadagi "9 oydan 3-si" yorlig'i uchun saqlangan snapshot.
--
-- MA'LUMOT YO'QOTILADI va bu ATAYLAB: bu ustunlar faqat o'quv yili
-- koordinatasini saqlaydi, pul summasiga aloqasi yo'q. Hisob-fakturaning
-- muhrlangan qiymatlari (base_amount, prorated_amount, discount_amount,
-- amount, paid_amount) va proratsiya izi (billable_days / month_days)
-- TEGILMAYDI.

-- 1. Sozlama: o'quv yili oynasi
ALTER TABLE "finance_settings" DROP COLUMN IF EXISTS "academic_start_month";
ALTER TABLE "finance_settings" DROP COLUMN IF EXISTS "academic_month_count";

-- 2. Ta'til oyi endi shunchaki YYYYMM — o'quv yiliga bog'lanmaydi
DROP INDEX IF EXISTS "vacation_months_academic_year_idx";
ALTER TABLE "vacation_months" DROP COLUMN IF EXISTS "academic_year";

-- 3. Hisob-fakturadagi akademik koordinata snapshot'i
ALTER TABLE "monthly_invoices" DROP COLUMN IF EXISTS "academic_year";
ALTER TABLE "monthly_invoices" DROP COLUMN IF EXISTS "academic_index";
ALTER TABLE "monthly_invoices" DROP COLUMN IF EXISTS "billable_index";
ALTER TABLE "monthly_invoices" DROP COLUMN IF EXISTS "billable_month_count";
