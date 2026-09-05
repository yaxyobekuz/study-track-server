-- TA'LIM DASHBOARDI — akademik reja, yutuqlar va to'garaklar.
--
-- Uchtasi ham YANGI jadval: mavjud birorta ustun o'zgarmaydi va birorta
-- qator ko'chirilmaydi. Yagona istisno — `users.created_by`, u ham NULL
-- bilan qo'shiladi (eski qatorlar "hech kim qo'shmagan" bo'lib qoladi).

-- ─────────────────────────────────────────────
-- 1. Kim qo'shgan (o'qituvchi faqat o'zinikini boshqaradi)
-- ─────────────────────────────────────────────
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "created_by" CHAR(24);

CREATE INDEX IF NOT EXISTS "users_created_by_idx" ON "users"("created_by");

-- ─────────────────────────────────────────────
-- 2. Akademik reja
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "academic_targets" (
  "id"         CHAR(24)       NOT NULL,
  "month"      INTEGER        NOT NULL,
  "metric"     VARCHAR(40)    NOT NULL,
  "plan_value" DECIMAL(14, 2) NOT NULL,
  "created_by" CHAR(24)       NOT NULL,
  "updated_by" CHAR(24),
  "created_at" TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3)   NOT NULL,

  CONSTRAINT "academic_targets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "academic_targets_month_metric_key"
  ON "academic_targets"("month", "metric");
CREATE INDEX IF NOT EXISTS "academic_targets_month_idx"
  ON "academic_targets"("month");

-- ─────────────────────────────────────────────
-- 3. Olimpiada va musobaqa yutuqlari
-- ─────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AchievementLevel') THEN
    CREATE TYPE "AchievementLevel" AS ENUM (
      'school', 'district', 'city', 'region', 'republic', 'international'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AchievementPlace') THEN
    CREATE TYPE "AchievementPlace" AS ENUM ('first', 'second', 'third', 'participant');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "student_achievements" (
  "id"         CHAR(24)           NOT NULL,
  "student_id" CHAR(24)           NOT NULL,
  "subject_id" CHAR(24),
  "title"      TEXT               NOT NULL,
  "level"      "AchievementLevel" NOT NULL,
  "place"      "AchievementPlace" NOT NULL DEFAULT 'participant',
  "date"       DATE               NOT NULL,
  "note"       TEXT,
  "created_by" CHAR(24)           NOT NULL,
  "created_at" TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3)       NOT NULL,

  CONSTRAINT "student_achievements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "student_achievements_date_idx"
  ON "student_achievements"("date" DESC);
CREATE INDEX IF NOT EXISTS "student_achievements_student_id_date_idx"
  ON "student_achievements"("student_id", "date" DESC);
CREATE INDEX IF NOT EXISTS "student_achievements_level_date_idx"
  ON "student_achievements"("level", "date" DESC);

ALTER TABLE "student_achievements"
  DROP CONSTRAINT IF EXISTS "student_achievements_student_id_fkey";
ALTER TABLE "student_achievements"
  ADD CONSTRAINT "student_achievements_student_id_fkey"
  FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "student_achievements"
  DROP CONSTRAINT IF EXISTS "student_achievements_subject_id_fkey";
ALTER TABLE "student_achievements"
  ADD CONSTRAINT "student_achievements_subject_id_fkey"
  FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- 4. To'garaklar
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "clubs" (
  "id"           CHAR(24)     NOT NULL,
  "name"         TEXT         NOT NULL,
  "description"  TEXT,
  "teacher_id"   CHAR(24),
  "subject_id"   CHAR(24),
  "weekly_hours" INTEGER      NOT NULL DEFAULT 0,
  "is_active"    BOOLEAN      NOT NULL DEFAULT true,
  "created_by"   CHAR(24)     NOT NULL,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "clubs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "clubs_name_key" ON "clubs"("name");
CREATE INDEX IF NOT EXISTS "clubs_is_active_idx" ON "clubs"("is_active");

ALTER TABLE "clubs" DROP CONSTRAINT IF EXISTS "clubs_subject_id_fkey";
ALTER TABLE "clubs"
  ADD CONSTRAINT "clubs_subject_id_fkey"
  FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "club_members" (
  "id"         CHAR(24)     NOT NULL,
  "club_id"    CHAR(24)     NOT NULL,
  "student_id" CHAR(24)     NOT NULL,
  "start_date" DATE         NOT NULL,
  "end_date"   DATE,
  "created_by" CHAR(24)     NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "club_members_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "club_members_club_id_start_date_idx"
  ON "club_members"("club_id", "start_date");
CREATE INDEX IF NOT EXISTS "club_members_student_id_start_date_idx"
  ON "club_members"("student_id", "start_date");

ALTER TABLE "club_members" DROP CONSTRAINT IF EXISTS "club_members_club_id_fkey";
ALTER TABLE "club_members"
  ADD CONSTRAINT "club_members_club_id_fkey"
  FOREIGN KEY ("club_id") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "club_members" DROP CONSTRAINT IF EXISTS "club_members_student_id_fkey";
ALTER TABLE "club_members"
  ADD CONSTRAINT "club_members_student_id_fkey"
  FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
