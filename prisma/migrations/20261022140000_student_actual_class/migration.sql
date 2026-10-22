-- HAQIQIY SINF — o'quvchining O'Z sinfi (`users.actual_class_id`).
--
-- Biznes qarori (2026-10-22): o'quvchi bilimi yaxshi bo'lgani uchun katta
-- guruhda o'qishi mumkin (IT 2 ning o'quvchisi IT 1 da). Shu paytgacha
-- platformada faqat U O'QIYOTGAN guruh (`user_classes`) yozilardi va
-- "aslida qaysi sinfniki" degan savolga javob yo'q edi.
--
-- ⚠️ A'ZOLIK EMAS, BELGI: bu ustun o'quvchini sinfga QO'SHMAYDI. Davomat,
-- jurnal, baho va hisobotlar avvalgidek `user_classes` dan o'qiydi —
-- shuning uchun bu yerdagi o'zgarish `student_class_changes` jurnaliga ham
-- yozilmaydi.
--
-- Katalog AYNI (`classes`) — ikkinchi sinflar ro'yxati yaratilmaydi.
-- Sinf o'chirilsa belgi NULL bo'ladi (SET NULL): o'quvchi qatori
-- o'chirilmasligi kerak.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "actual_class_id" CHAR(24);

-- "Haqiqiy sinfi X bo'lganlar" filtri (o'quvchilar ro'yxati)
CREATE INDEX IF NOT EXISTS "users_actual_class_id_idx" ON "users"("actual_class_id");

ALTER TABLE "users"
  DROP CONSTRAINT IF EXISTS "users_actual_class_id_fkey";
ALTER TABLE "users"
  ADD CONSTRAINT "users_actual_class_id_fkey" FOREIGN KEY ("actual_class_id")
  REFERENCES "classes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── BIR MARTALIK TO'LDIRISH ──
-- Har bir o'quvchining HOZIRGI sinfi haqiqiy sinfi bo'lib qo'yiladi — admin
-- keyin faqat FARQ QILADIGANLARINI to'g'rilaydi (bo'sh ustunni qo'lda
-- to'ldirish esa butun maktabni qayta kiritish degani bo'lardi).
--
-- Bir nechta sinfdagi o'quvchiga nomi bo'yicha BIRINCHISI tushadi: tanlov
-- baribir bitta va u barqaror bo'lishi kerak (`DISTINCT ON` tasodifiy
-- qator qaytarmasin).
UPDATE "users" u
SET "actual_class_id" = sub."class_id"
FROM (
  SELECT DISTINCT ON (uc."user_id") uc."user_id", uc."class_id"
  FROM "user_classes" uc
  JOIN "classes" c ON c."id" = uc."class_id"
  ORDER BY uc."user_id", c."name" ASC, c."id" ASC
) sub
WHERE u."id" = sub."user_id"
  AND u."role" = 'student'
  AND u."actual_class_id" IS NULL;
