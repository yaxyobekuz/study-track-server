-- FAOLLIK + KO'P ROLLILIK — filial schema'si.
--
-- Xavfsizlik jadvallari (seans, kirish urinishi, ogohlantirish) BU YERDA
-- EMAS: ular platformada (`prisma/platform/migrations/..._security`).
-- Sababi schema izohida — mavjud bo'lmagan login bilan urinishda filial
-- konteksti umuman bo'lmaydi.
--
-- Mavjud birorta qator ko'chirilmaydi. Faollik BUGUNDAN boshlab yozadi:
-- kim qachon botga kirgani ilgari hech qayerda saqlanmagan va uni
-- tiklab bo'lmaydi — ekran shuning uchun "ma'lumot yig'ilmoqda"
-- holatini biladi.

-- ─────────────────────────────────────────────
-- 1. KO'P ROLLILIK
-- ─────────────────────────────────────────────
-- ⚠️ BO'SH MASSIV bilan: mavjud xodimlarning huquqi zarracha
-- o'zgarmaydi. `hasRole()` avval `role` skalyarini tekshiradi, ya'ni
-- eski mantiq butunlay saqlanadi va `extra_roles` faqat QO'SHADI.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "extra_roles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- ⚠️ GIN INDEKS: "shu rol kimlarda bor" savoli (`extra_roles @> ARRAY[..]`)
-- rolni o'chirishdan oldingi tekshiruvda ishlatiladi. B-tree massivga
-- xizmat qilmaydi.
CREATE INDEX IF NOT EXISTS "users_extra_roles_idx" ON "users" USING GIN ("extra_roles");

-- ─────────────────────────────────────────────
-- 2. FAOLLIK KANALI
-- ─────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "ActivityChannel" AS ENUM ('bot', 'admin', 'teacher', 'student', 'reception', 'worker');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────
-- 3. FAOLLIK HODISASI
-- ─────────────────────────────────────────────
-- ⚠️ `day` — DATE (kun koordinatasi, UTC yarim tunida). Yig'ma so'rov
-- aynan shu ustun bo'yicha guruhlanadi: `occurred_at` ustidagi
-- `date_trunc` indeksdan foydalana olmasdi.
--
-- ⚠️ `actor_key` ("user:<id>" | "tg:<telegramId>") — "nechta noyob odam"
-- savoli bitta COUNT(DISTINCT) bo'lishi uchun. Ikki ustunni COALESCE
-- qilish indeksni ishlatmay qo'yardi.
CREATE TABLE IF NOT EXISTS "activity_events" (
  "id"          CHAR(24)          NOT NULL,
  "channel"     "ActivityChannel" NOT NULL,
  "action"      VARCHAR(48)       NOT NULL,
  "actor_key"   VARCHAR(40)       NOT NULL,
  "user_id"     CHAR(24),
  "telegram_id" TEXT,
  "student_id"  CHAR(24),
  "occurred_at" TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "day"         DATE              NOT NULL,
  "meta"        JSONB,

  CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "activity_events_day_channel_idx"      ON "activity_events"("day", "channel");
CREATE INDEX IF NOT EXISTS "activity_events_channel_occurred_idx" ON "activity_events"("channel", "occurred_at" DESC);
CREATE INDEX IF NOT EXISTS "activity_events_user_id_day_idx"      ON "activity_events"("user_id", "day");
CREATE INDEX IF NOT EXISTS "activity_events_telegram_id_day_idx"  ON "activity_events"("telegram_id", "day");
CREATE INDEX IF NOT EXISTS "activity_events_student_id_day_idx"   ON "activity_events"("student_id", "day");
CREATE INDEX IF NOT EXISTS "activity_events_actor_key_day_idx"    ON "activity_events"("actor_key", "day");
