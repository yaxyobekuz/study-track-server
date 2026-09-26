-- BAHOLAR TAHLILI.
--
-- Faqat QO'SHADI: mavjud jadvallardan hech narsa o'chirilmaydi va
-- o'zgartirilmaydi.
--
-- 1) `grades.topic_id` — bugungi darsga qo'yilgan bahoning mavzusi (soft
--    ref → topics). NULL ustun default'siz qo'shiladi: PostgreSQL buni
--    faqat katalogda yozadi, jadval qayta yozilmaydi (katta `grades`
--    jadvali uchun ham bir zumda). Eski baholar NULL bo'lib qoladi —
--    mavzu tarixi saqlanmagan, taxmin bilan to'ldirilmaydi.
--
-- 2) `grade_analysis_runs` — tahlil (davr + qamrov + holat + yig'ma natija).
-- 3) `grade_analysis_reports` — tahlildagi har bir o'quvchi hisoboti
--    (o'quvchi / ota-ona / xodim uchun alohida matn). `(run_id, student_id)`
--    yagona: to'xtab qolib tiklangan tahlil ikkinchi qator yoza olmaydi.
-- 4) `grade_analysis_settings` — filial singletoni (haftalik avtomat tahlil).

-- CreateEnum
CREATE TYPE "GradeAnalysisStatus" AS ENUM ('queued', 'running', 'completed', 'failed', 'cancelled');

-- AlterTable
ALTER TABLE "grades" ADD COLUMN     "topic_id" CHAR(24);

-- CreateTable
CREATE TABLE "grade_analysis_runs" (
    "id" CHAR(24) NOT NULL,
    "period" VARCHAR(10) NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "scope" VARCHAR(10) NOT NULL,
    "class_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "student_id" CHAR(24),
    "trigger" VARCHAR(10) NOT NULL DEFAULT 'manual',
    "use_ai" BOOLEAN NOT NULL DEFAULT true,
    "notify" BOOLEAN NOT NULL DEFAULT true,
    "status" "GradeAnalysisStatus" NOT NULL DEFAULT 'queued',
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "ai_count" INTEGER NOT NULL DEFAULT 0,
    "overview" JSONB,
    "narrative" JSONB,
    "error" TEXT,
    "published_at" TIMESTAMP(3),
    "published_by" VARCHAR(24) NOT NULL DEFAULT '',
    "push_sent" INTEGER NOT NULL DEFAULT 0,
    "created_by" VARCHAR(24) NOT NULL DEFAULT '',
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "heartbeat_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grade_analysis_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grade_analysis_reports" (
    "id" CHAR(24) NOT NULL,
    "run_id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "student_snapshot" JSONB NOT NULL,
    "class_id" CHAR(24),
    "period" VARCHAR(10) NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "level" VARCHAR(16) NOT NULL,
    "average" DOUBLE PRECISION,
    "previous_average" DOUBLE PRECISION,
    "grade_count" INTEGER NOT NULL DEFAULT 0,
    "risk_score" INTEGER NOT NULL DEFAULT 0,
    "facts" JSONB NOT NULL,
    "findings" JSONB NOT NULL,
    "student_view" JSONB NOT NULL,
    "parent_view" JSONB NOT NULL,
    "staff_view" JSONB NOT NULL,
    "source" VARCHAR(10) NOT NULL DEFAULT 'rules',
    "model" VARCHAR(60) NOT NULL DEFAULT '',
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMP(3),
    "student_seen_at" TIMESTAMP(3),
    "parent_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grade_analysis_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grade_analysis_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT 'singleton',
    "weekly_enabled" BOOLEAN NOT NULL DEFAULT true,
    "weekly_notify" BOOLEAN NOT NULL DEFAULT true,
    "use_ai" BOOLEAN NOT NULL DEFAULT true,
    "updated_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grade_analysis_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "grade_analysis_runs_created_at_idx" ON "grade_analysis_runs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "grade_analysis_runs_status_created_at_idx" ON "grade_analysis_runs"("status", "created_at");

-- CreateIndex
CREATE INDEX "grade_analysis_reports_student_id_is_published_published_at_idx" ON "grade_analysis_reports"("student_id", "is_published", "published_at" DESC);

-- CreateIndex
CREATE INDEX "grade_analysis_reports_run_id_level_idx" ON "grade_analysis_reports"("run_id", "level");

-- CreateIndex
CREATE UNIQUE INDEX "grade_analysis_reports_run_id_student_id_key" ON "grade_analysis_reports"("run_id", "student_id");

-- AddForeignKey
ALTER TABLE "grade_analysis_reports" ADD CONSTRAINT "grade_analysis_reports_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "grade_analysis_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
