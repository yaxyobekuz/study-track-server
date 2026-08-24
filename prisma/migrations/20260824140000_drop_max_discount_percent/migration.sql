-- CHEGIRMA CHEKLOVI SOZLAMASINI OLIB TASHLASH
--
-- Foizlar yig'indisi 100 dan oshmasligi ARIFMETIKA (aks holda summa manfiy
-- bo'lardi), siyosat emas. Shu sababli sozlanadigan chegara keraksiz:
-- `discount.helpers.js` dagi MAX_PERCENT = 100 doimiysi zaxira bo'lib qoladi.
--
-- Chiqarilgan hisob-fakturalar summasi MUHRLANGAN — bu o'zgarish ularga
-- ta'sir qilmaydi.
ALTER TABLE "finance_settings" DROP COLUMN IF EXISTS "max_discount_percent";
