-- BOTGA XODIM LOGINI — yo'naltirgich ham o'quvchidan kengroq.
--
-- `telegram_directory` botga "bu telegramId qaysi filialda" deb javob beradi.
-- Xodim bog'lanishida ortda o'quvchi yo'q, shuning uchun filial
-- schema'sidagi `tg_users` bilan AYNI ikkita ustun qo'shiladi
-- (izoh: prisma/migrations/20261009120000_bot_staff_login).
--
-- Backfill: mavjud har bir qator — ota-onaning bog'lanishi.

-- AlterTable
ALTER TABLE "telegram_directory" ADD COLUMN "user_id" CHAR(24);
ALTER TABLE "telegram_directory" ADD COLUMN "link_kind" TEXT NOT NULL DEFAULT 'student';

-- Backfill (NOT NULL qo'yishdan OLDIN)
UPDATE "telegram_directory" SET "user_id" = "student_id" WHERE "user_id" IS NULL;

ALTER TABLE "telegram_directory" ALTER COLUMN "user_id" SET NOT NULL;
ALTER TABLE "telegram_directory" ALTER COLUMN "student_id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "telegram_directory_user_id_idx" ON "telegram_directory"("user_id");
