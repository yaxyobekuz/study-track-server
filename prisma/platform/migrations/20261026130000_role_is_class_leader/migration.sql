-- SINF RAHBARI ROLI BELGISI.
--
-- `roles.is_class_leader` — bu rol egasiga sinf biriktiriladi va u o'z
-- sinfining KUNLIK davomatini belgilaydi (`classLeader.service.js`).
--
-- ⚠️ `is_tutor` BILAN CHALKASHMASIN: tyutor belgisi PULGA olib keladi (sinf
-- uchun qo'shimcha oylik), bu esa faqat HUQUQ beradi. Bir odam ikkalasi ham
-- bo'lishi mumkin, shuning uchun ustun ham ALOHIDA.
--
-- Rollar dinamik, shuning uchun mavjud "Sinf rahbari" roli nomi yoki kaliti
-- bo'yicha BIR MARTA belgilanadi — aks holda yangilanishdan keyin hech kimga
-- sinf biriktirib bo'lmasdi va admin belgini qo'lda qidirib yurardi. Keyin
-- belgi faqat Rollar sahifasidan o'zgaradi.

ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "is_class_leader" BOOLEAN NOT NULL DEFAULT false;

UPDATE "roles"
SET "is_class_leader" = true
WHERE "is_system" = false
  AND ("name" ILIKE '%sinf rahbar%' OR "value" ILIKE '%sinf_rahbar%'
       OR "value" ILIKE '%sinfrahbar%' OR "value" ILIKE '%class_leader%'
       OR "value" ILIKE '%classleader%');
