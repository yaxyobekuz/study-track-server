-- DARS SOATLARI VA MAOSH REJIMLARI + DARS O'RINBOSARLIGI
--
-- 1. `SalaryType` ga `hourly` va `mixed` qo'shiladi. Mavjud qatorlar
--    `fixed` bo'lib qoladi — hech kimning oyligi o'zgarmaydi.
-- 2. `staff_salaries` ga stavka va oylik soat normasi.
-- 3. `payroll_entries` ga summa QANDAY chiqqanini saqlaydigan ustunlar.
--    Hammasi DEFAULT bilan — muhrlangan eski majburiyatlar o'qilaveradi.
-- 4. Dars o'rinbosarligi jadvallari.
--
-- ⚠️ Yangi enum qiymatlari SHU faylda ISHLATILMAYDI (default ham, backfill
--    ham yo'q): PostgreSQL bitta tranzaksiyada qo'shilgan qiymatni o'sha
--    tranzaksiyada ishlatishga ruxsat bermaydi.

ALTER TYPE "SalaryType" ADD VALUE IF NOT EXISTS 'hourly';
ALTER TYPE "SalaryType" ADD VALUE IF NOT EXISTS 'mixed';

CREATE TYPE "SubstitutionStatus" AS ENUM ('active', 'cancelled');

CREATE TYPE "SubstitutionReason" AS ENUM ('illness', 'business_trip', 'personal', 'training', 'other');

-- ── Oylik qoidasi: stavka va norma ──────────
ALTER TABLE "staff_salaries"
  ADD COLUMN "hourly_rate"        DECIMAL(14,2),
  ADD COLUMN "monthly_hour_norm"  INTEGER;

-- ── Majburiyat: summa qanday chiqqani ───────
ALTER TABLE "payroll_entries"
  ADD COLUMN "base_amount"    DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "hours_amount"   DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "hours_worked"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "extra_hours"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "hourly_rate"    DECIMAL(14,2),
  ADD COLUMN "hour_norm"      INTEGER,
  ADD COLUMN "hours_snapshot" JSONB;

-- Mavjud majburiyatlar `fixed` edi: butun summa bazaviy qism.
UPDATE "payroll_entries" SET "base_amount" = "amount";

-- ── Dars o'rinbosarligi ─────────────────────
CREATE TABLE "lesson_substitutions" (
    "id"                    CHAR(24) NOT NULL,
    "original_teacher_id"   CHAR(24) NOT NULL,
    "substitute_teacher_id" CHAR(24) NOT NULL,
    "from_date"             DATE NOT NULL,
    "to_date"               DATE NOT NULL,
    "reason"                "SubstitutionReason" NOT NULL DEFAULT 'other',
    "note"                  TEXT NOT NULL DEFAULT '',
    "status"                "SubstitutionStatus" NOT NULL DEFAULT 'active',
    "cancel_reason"         TEXT NOT NULL DEFAULT '',
    "cancelled_at"          TIMESTAMP(3),
    "cancelled_by"          CHAR(24),
    "teacher_snapshot"      JSONB NOT NULL,
    "created_by"            CHAR(24) NOT NULL,
    "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lesson_substitutions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lesson_substitutions_substitute_teacher_id_status_from_date_idx"
  ON "lesson_substitutions"("substitute_teacher_id", "status", "from_date");

CREATE INDEX "lesson_substitutions_original_teacher_id_status_from_date_idx"
  ON "lesson_substitutions"("original_teacher_id", "status", "from_date");

CREATE INDEX "lesson_substitutions_status_from_date_to_date_idx"
  ON "lesson_substitutions"("status", "from_date", "to_date");

CREATE TABLE "lesson_substitution_items" (
    "id"              CHAR(24) NOT NULL,
    "substitution_id" CHAR(24) NOT NULL,
    "class_id"        CHAR(24) NOT NULL,
    "subject_id"      CHAR(24) NOT NULL,
    "day"             "ScheduleDay" NOT NULL,
    "lesson_order"    INTEGER NOT NULL,
    "snapshot"        JSONB NOT NULL,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lesson_substitution_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lesson_substitution_items_substitution_id_class_id_day_lesso_key"
  ON "lesson_substitution_items"("substitution_id", "class_id", "day", "lesson_order");

CREATE INDEX "lesson_substitution_items_class_id_day_lesson_order_idx"
  ON "lesson_substitution_items"("class_id", "day", "lesson_order");

ALTER TABLE "lesson_substitution_items"
  ADD CONSTRAINT "lesson_substitution_items_substitution_id_fkey"
  FOREIGN KEY ("substitution_id") REFERENCES "lesson_substitutions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
