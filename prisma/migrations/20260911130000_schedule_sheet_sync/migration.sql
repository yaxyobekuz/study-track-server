-- DARS JADVALI MANBAI: PLATFORMA YOKI GOOGLE SHEETS
--
-- ⚠️ Amaldagi jadval avvalgidek FAQAT `schedules` / `schedule_lessons` da.
-- Bu yerdagi jadvallar: rejim sozlamasi, sheet'dan o'qilgan tahrirlar,
-- amaldagi jadvalning arxiv nusxalari va nom moslash qoidalari.
-- Mavjud ma'lumotga TEGILMAYDI: rejim sukut bo'yicha `platform` — tizim
-- avvalgidek ishlaydi, sheet rejimi faqat qo'lda yoqiladi.

-- Tur tekshiruvi `current_schema()` bilan cheklanadi: `pg_type` butun bazaga
-- umumiy, cheklanmasa ikkinchi filialda tur yaratilmay qolardi
-- (`20260906090000_academic_dashboard` dagi izohga qarang).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'ScheduleSourceMode' AND n.nspname = current_schema()
  ) THEN
    CREATE TYPE "ScheduleSourceMode" AS ENUM ('platform', 'sheet');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'ScheduleSheetRevisionStatus' AND n.nspname = current_schema()
  ) THEN
    CREATE TYPE "ScheduleSheetRevisionStatus" AS ENUM ('pending', 'applied', 'rejected', 'superseded');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'ScheduleSnapshotKind' AND n.nspname = current_schema()
  ) THEN
    CREATE TYPE "ScheduleSnapshotKind" AS ENUM ('platform_archive', 'sheet_archive', 'before_apply', 'before_restore');
  END IF;
END
$$;

-- Rejim sozlamasi (singleton)
CREATE TABLE IF NOT EXISTS "schedule_sync_settings" (
  "id"                   VARCHAR(24)          NOT NULL DEFAULT 'singleton',
  "mode"                 "ScheduleSourceMode" NOT NULL DEFAULT 'platform',
  "sheet_url"            TEXT,
  "spreadsheet_id"       VARCHAR(128),
  "sheet_tab"            VARCHAR(200),
  "auto_check"           BOOLEAN              NOT NULL DEFAULT true,
  "config_changed_at"    TIMESTAMP(3),
  "last_checked_at"      TIMESTAMP(3),
  "last_check_ok"        BOOLEAN,
  "last_check_error"     TEXT,
  "check_failure_count"  INTEGER              NOT NULL DEFAULT 0,
  "failure_notified_at"  TIMESTAMP(3),
  "applied_state_hash"   VARCHAR(64),
  "platform_snapshot_id" CHAR(24),
  "mode_changed_at"      TIMESTAMP(3),
  "mode_changed_by"      CHAR(24),
  "updated_by"           CHAR(24),
  "created_at"           TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3)         NOT NULL,

  CONSTRAINT "schedule_sync_settings_pkey" PRIMARY KEY ("id")
);

-- Sheet'dan o'qilgan tahrirlar
CREATE TABLE IF NOT EXISTS "schedule_sheet_revisions" (
  "id"             CHAR(24)                      NOT NULL,
  "spreadsheet_id" VARCHAR(128)                  NOT NULL,
  "sheet_tab"      VARCHAR(200)                  NOT NULL,
  "content_hash"   VARCHAR(64)                   NOT NULL,
  "data"           JSONB                         NOT NULL,
  "lesson_count"   INTEGER                       NOT NULL,
  "class_count"    INTEGER                       NOT NULL,
  "issue_count"    INTEGER                       NOT NULL,
  "status"         "ScheduleSheetRevisionStatus" NOT NULL DEFAULT 'pending',
  "fetched_by"     CHAR(24),
  "reviewed_by"    CHAR(24),
  "reviewed_at"    TIMESTAMP(3),
  "reject_reason"  TEXT,
  "resolution"     JSONB,
  "snapshot_id"    CHAR(24),
  "notified_at"    TIMESTAMP(3),
  "created_at"     TIMESTAMP(3)                  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3)                  NOT NULL,

  CONSTRAINT "schedule_sheet_revisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "schedule_sheet_revisions_created_at_idx"
  ON "schedule_sheet_revisions"("created_at");
CREATE INDEX IF NOT EXISTS "schedule_sheet_revisions_status_idx"
  ON "schedule_sheet_revisions"("status");

-- Amaldagi jadvalning arxiv nusxalari (o'chirilmaydi)
CREATE TABLE IF NOT EXISTS "schedule_snapshots" (
  "id"           CHAR(24)               NOT NULL,
  "kind"         "ScheduleSnapshotKind" NOT NULL,
  "mode"         "ScheduleSourceMode"   NOT NULL,
  "data"         JSONB                  NOT NULL,
  "content_hash" VARCHAR(64)            NOT NULL,
  "class_count"  INTEGER                NOT NULL,
  "lesson_count" INTEGER                NOT NULL,
  "note"         TEXT,
  "revision_id"  CHAR(24),
  "created_by"   CHAR(24),
  "created_at"   TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "schedule_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "schedule_snapshots_created_at_idx"
  ON "schedule_snapshots"("created_at");

-- Sheet'dagi nom → tizimdagi yozuv (faqat odam qarori)
CREATE TABLE IF NOT EXISTS "schedule_sheet_mappings" (
  "id"         CHAR(24)     NOT NULL,
  "kind"       VARCHAR(16)  NOT NULL,
  "key"        VARCHAR(300) NOT NULL,
  "label"      VARCHAR(300) NOT NULL,
  "target_id"  CHAR(24)     NOT NULL,
  "updated_by" CHAR(24),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "schedule_sheet_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "schedule_sheet_mappings_kind_key_key"
  ON "schedule_sheet_mappings"("kind", "key");
