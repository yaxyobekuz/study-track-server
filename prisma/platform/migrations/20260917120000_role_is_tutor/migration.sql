-- TYUTOR ROLI BELGISI.
--
-- `roles.is_tutor` — bu rol egasiga sinf (guruh) biriktiriladi va o'quvchilar
-- soniga qarab qo'shimcha oylik hisoblanadi.
--
-- Rollar dinamik, shuning uchun mavjud "Tyutor" roli nomi yoki kaliti bo'yicha
-- BIR MARTA belgilanadi — aks holda yangilanishdan keyin hech kimga guruh
-- biriktirib bo'lmasdi. Keyin belgi faqat Rollar sahifasidan o'zgaradi.

ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "is_tutor" BOOLEAN NOT NULL DEFAULT false;

UPDATE "roles"
SET "is_tutor" = true
WHERE "is_system" = false
  AND ("name" ILIKE '%tyutor%' OR "name" ILIKE '%tutor%'
       OR "value" ILIKE '%tyutor%' OR "value" ILIKE '%tutor%');
