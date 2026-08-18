/*
  `StudentFinanceStatusEnum` dan `expelled` OLIB TASHLANADI.

  Maktabdan ketish endi `student_enrollments` davrini yopish bilan qayd
  etiladi — kun aniqligida va sababi toifasi bilan
  (`StudentEnrollmentEndReason.expelled`). Ikki joyda bir narsani belgilash
  "qaysi ekran ochilganiga qarab boshqa narx" degan holatga olib kelardi:
  muzlatish oy aniqligida va proratsiyasiz, davrni yopish esa kun
  aniqligida va qaytganda proratsiya bilan ishlaydi.

  MA'LUMOT XAVFSIZLIGI: Postgres enum'dan qiymat o'chira olmaydi, shuning
  uchun yangi tur yaratilib, ustun unga ko'chiriladi. Bu operator qatorda
  `expelled` qolgan bo'lsa QATTIQ YIQILADI — bu ataylab: jimgina
  ma'lumot yo'qotishdan ko'ra migratsiya to'xtagani yaxshi.

  Ishga tushirishdan oldin tekshirilgan: `student_finance_statuses` bo'sh
  (0 qator). Boshqa bazada qo'llashdan OLDIN quyidagini bajaring:

      SELECT count(*) FROM student_finance_statuses WHERE status = 'expelled';

  Natija 0 bo'lmasa, avval o'sha qatorlarni o'qish davriga ko'chiring.

  `status` ustunida DEFAULT yo'q, shuning uchun uni vaqtincha olib tashlash
  kerak emas.
*/

CREATE TYPE "StudentFinanceStatusEnum_new" AS ENUM ('active', 'frozen');

ALTER TABLE "student_finance_statuses"
  ALTER COLUMN "status" TYPE "StudentFinanceStatusEnum_new"
  USING ("status"::text::"StudentFinanceStatusEnum_new");

DROP TYPE "StudentFinanceStatusEnum";

ALTER TYPE "StudentFinanceStatusEnum_new" RENAME TO "StudentFinanceStatusEnum";
