-- FILIALLARARO KO'CHIRISH — TO'LIQ KO'CHIRISH.
--
-- Ko'chirish endi odamning HOLATINI emas, uning TO'LIQ HOLATI VA TARIXINI
-- olib o'tadi: qarz, depozit (haqiqiy pul), baho, davomat va sinf jadvali.
-- Bu migratsiya shu uchun kerak bo'lgan to'rt narsani qo'shadi.
--
-- Mavjud birorta qator o'zgarmaydi: hamma ustun NULL bilan qo'shiladi,
-- enum qiymatlari esa faqat yangi yozuvlarda ishlatiladi.

-- ── 1. DAFTAR: FILIALLARARO PUL ────────────────────────────────
--
-- Depozit (o'quvchining sarflanmagan puli) manba kassasidan chiqadi va
-- maqsad kassasiga kiradi. `transfer_in`/`transfer_out` ishlatilmaydi —
-- ular BITTA filial ichidagi hisoblararo o'tkazma va `AccountTransfer` ga
-- bog'langan; hisobotda ikkisi aralashsa "pul qayerga ketdi" degan savol
-- javobsiz qolardi.
ALTER TYPE "AccountEntryType" ADD VALUE IF NOT EXISTS 'branch_transfer_in';
ALTER TYPE "AccountEntryType" ADD VALUE IF NOT EXISTS 'branch_transfer_out';

-- ── 2. BAHO: KO'CHIRILGAN BELGISI ──────────────────────────────
--
-- ⚠️ PUL XAVFSIZLIGI. `loadLessonFacts` bahoni sinf + fan + dars tartibi +
-- kun bo'yicha o'qiydi, o'qituvchi bo'yicha EMAS. Ko'chirilgan baho maqsad
-- filialdagi o'sha katakdagi darsni "o'tilgan" qilib, uni hech qachon
-- o'tmagan o'qituvchiga soat (demak pul) yozib yuborardi. Shu ustun
-- to'ldirilgan baho oylik hisobidan CHETLAB O'TILADI (`gradingGrantId`
-- bilan AYNI mulohaza).
ALTER TABLE "grades" ADD COLUMN IF NOT EXISTS "transferred_from_branch_id" CHAR(24);

-- ⚠️ Indeks QO'SHILMAYDI va bu ataylab: so'rov baribir `(class_id, date)`
-- indeksi bilan tanlanadi, bu ustun esa faqat FILTR (`gradingGrantId` bilan
-- AYNI holat). Bu yerda e'lon qilinmagan indeks `schema.prisma` da ham
-- bo'lmaydi va keyingi migratsiya uni JIM O'CHIRIB yuborardi.

-- ── 3. O'QUVCHI DAVOMATI: KO'CHIRILGAN BELGISI ────────────────
--
-- O'quvchi davomati pulga ta'sir qilmaydi (`education.md` §6) — bu ustun
-- faqat manbani ko'rsatadi, hisobotda "bu kun boshqa filialda belgilangan"
-- degan javob bo'lsin.
ALTER TABLE "student_attendances" ADD COLUMN IF NOT EXISTS "transferred_from_branch_id" CHAR(24);

-- ── 4. KECHIKTIRILGAN JADVAL O'CHIRISH ────────────────────────
--
-- Sinf ko'chganda jadval maqsadga nusxalanadi, manbadagisi KEYINGI OY
-- BOSHIDAN o'chiriladi: jadval sanasiz shablon, uni oy o'rtasida o'chirish
-- shu oy allaqachon o'tilgan darslarni ham o'qituvchi oyligidan olib
-- tashlardi (`education.md` §8).
-- CreateEnum
CREATE TYPE "PendingScheduleRemovalStatus" AS ENUM ('pending', 'done', 'cancelled');

CREATE TABLE IF NOT EXISTS "pending_schedule_removals" (
  "id"               CHAR(24) NOT NULL,
  "class_id"         CHAR(24) NOT NULL,
  "class_name"       TEXT NOT NULL,
  "effective_month"  INTEGER NOT NULL,
  "reason"           TEXT NOT NULL,
  "target_branch_id" CHAR(24),
  "transfer_id"      CHAR(24),
  "status"           "PendingScheduleRemovalStatus" NOT NULL DEFAULT 'pending',
  "processed_at"     TIMESTAMP(3),
  "fail_reason"      TEXT NOT NULL DEFAULT '',
  "lesson_count"     INTEGER NOT NULL DEFAULT 0,
  "created_by"       CHAR(24) NOT NULL,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pending_schedule_removals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pending_schedule_removals_class_id_effective_month_key"
  ON "pending_schedule_removals" ("class_id", "effective_month");

CREATE INDEX IF NOT EXISTS "pending_schedule_removals_status_effective_month_idx"
  ON "pending_schedule_removals" ("status", "effective_month");
