-- DAVOMAT JOYLASHUVI — AUDIT USTUNLARI
--
-- Ilgari qayd etishdagi joylashuv haqida faqat ikkita bayroq qolardi
-- (out_of_office, location_warning) va ular kelish bilan ketishni bitta
-- qiymatga siqib qo'yardi: ketish tashqarida bo'lsa, kelish ham
-- "tashqarida" bo'lib yozilardi. Masofa esa umuman saqlanmasdi —
-- "12 m narida" va "5 km narida" bir xil ko'rinardi.
--
-- Endi har bir qayd (kelish va ketish) o'z qarorini va o'z masofasini
-- saqlaydi; bayroqlar esa kun yakuni uchun qoladi.

ALTER TABLE "attendances" ADD COLUMN "check_in_location_status" TEXT;
ALTER TABLE "attendances" ADD COLUMN "check_out_location_status" TEXT;
ALTER TABLE "attendances" ADD COLUMN "check_in_distance" INTEGER;
ALTER TABLE "attendances" ADD COLUMN "check_out_distance" INTEGER;

-- Eski yozuvlar uchun FAQAT ISHONCHLI FAKT to'ldiriladi: qayd etilgan-u
-- joylashuvi umuman kelmagan qatorlar. Qolganining haqiqiy holati
-- (ichkarida / chegarada / tashqarida) eski ma'lumotdan tiklab bo'lmaydi
-- va uni taxmin qilib yozish soxta tarix bo'lardi — ular NULL qoladi.
UPDATE "attendances"
   SET "check_in_location_status" = 'missing'
 WHERE "check_in" IS NOT NULL
   AND "check_in_location" IS NULL;

UPDATE "attendances"
   SET "check_out_location_status" = 'missing'
 WHERE "check_out" IS NOT NULL
   AND "check_out_location" IS NULL;
