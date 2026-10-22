-- ASL SINF — SINF EMAS, MAKTAB DARAJASI (1-sinf … 11-sinf).
--
-- Biznes qarori (2026-10-22, o'sha kungi `..._student_actual_class` ni
-- almashtiradi): "o'quvchi aslida kimniki" degan savolning javobi sinflar
-- KATALOGI emas — katalogda "IT 1", "Union 2", "Bog'cha — katta guruh"
-- bor va ulardagi raqam guruh tartibi, daraja emas. Javob — 1 dan 11
-- gacha bo'lgan DARAJA.
--
-- Shuning uchun ustun FK emas, oddiy son: daraja na katalogga, na filialga
-- bog'liq va "nechanchi sinfda nechta o'quvchi bor" hisobi son bo'yicha
-- tabiiy chiqadi.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "actual_grade" SMALLINT;

-- ── ESKI USTUNDAN KO'CHIRISH ──
-- Oldingi migratsiya har o'quvchiga uning JORIY sinfini belgilagan edi.
-- Nomi AYNAN daraja bilan boshlanadigan sinflardan (`5-A`, `3-sinf o'zbek`)
-- daraja chiqariladi, qolganidan — YO'Q.
--
-- ⚠️ TAXMIN QILINMAYDI (`education.md` §10 moslash doktrinasi): "IT 1" ni
-- 1-sinf deb yozish hisobotga jimgina yolg'on raqam qo'shardi. Mos
-- kelmaganlar bo'sh qoladi va admin qo'lda belgilaydi.
-- ⚠️ `helpers/grade.helpers.js` dagi `gradeFromClassName` bilan AYNI naqsh.
UPDATE "users" u
SET "actual_grade" = g."grade"
FROM (
  SELECT c."id",
         (substring(c."name" from '^([0-9]{1,2})-'))::int AS "grade"
  FROM "classes" c
  WHERE substring(c."name" from '^([0-9]{1,2})-') IS NOT NULL
) g
WHERE u."actual_class_id" = g."id"
  AND g."grade" BETWEEN 1 AND 11
  AND u."actual_grade" IS NULL;

-- Eski ustun, uning FK va indeksi olib tashlanadi
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_actual_class_id_fkey";
DROP INDEX IF EXISTS "users_actual_class_id_idx";
ALTER TABLE "users" DROP COLUMN IF EXISTS "actual_class_id";

-- "Asl sinfi X bo'lganlar" filtri va daraja kesimidagi sanoq
CREATE INDEX IF NOT EXISTS "users_actual_grade_idx" ON "users"("actual_grade");
