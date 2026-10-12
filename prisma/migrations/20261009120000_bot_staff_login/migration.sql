-- BOTGA XODIM LOGINI — `tg_users` endi faqat ota-onaning jadvali emas.
--
-- Ilgari botga faqat o'quvchi logini bilan kirish mumkin edi va `student`
-- ustuni MAJBURIY edi. Endi xodim ham o'z logini bilan kiradi, lekin uning
-- ortida o'quvchi yo'q — shuning uchun:
--
--   user_id    — BOG'LANGAN ODAM (o'quvchi yoki xodim). Yangi kod shuni o'qiydi.
--   link_kind  — "student" | "staff". Bog'lanish TURI, ROL EMAS: rol keyin
--                o'zgarsa muhrlangan qiymat eskirib, botda noto'g'ri menyu
--                ko'rsatardi — menyu `users.role` dan jonli o'qiladi.
--   student    — nullable bo'ldi va faqat link_kind='student' da to'ladi.
--
-- ⚠️ `student` ATAYLAB SAQLANDI. O'quvchiga xabar yuboradigan barcha joylar
-- (`penalty`, `debtReminder`, `premiumNotification`) shu ustun bo'yicha
-- qidiradi; xodim qatorida u NULL, ya'ni eski oqimlar xodimga hech qachon
-- urilmaydi va ularga tegish kerak emas.
--
-- Backfill: mavjud har bir qator — ota-onaning bog'lanishi, ya'ni
-- user_id = student va link_kind = 'student' (ustun default'i).

-- AlterTable
ALTER TABLE "tg_users" ADD COLUMN "user_id" CHAR(24);
ALTER TABLE "tg_users" ADD COLUMN "link_kind" TEXT NOT NULL DEFAULT 'student';

-- Backfill (NOT NULL qo'yishdan OLDIN)
UPDATE "tg_users" SET "user_id" = "student" WHERE "user_id" IS NULL;

ALTER TABLE "tg_users" ALTER COLUMN "user_id" SET NOT NULL;
ALTER TABLE "tg_users" ALTER COLUMN "student" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "tg_users_user_id_idx" ON "tg_users"("user_id");
CREATE INDEX "tg_users_link_kind_is_active_idx" ON "tg_users"("link_kind", "is_active");
