-- ─────────────────────────────────────────────
-- DIAGNOSTIKA — AI asosidagi bilim diagnostikasi
-- ─────────────────────────────────────────────
--
-- FAQAT QO'SHADI: 8 ta enum, 11 ta jadval va ularning tashqi kalitlari.
-- Mavjud test tizimining (tests / questions / test_sessions / ...) birorta
-- ustuniga TEGMAYDI — diagnostika alohida modul (`prisma/schema.prisma`
-- dagi bo'lim izohiga qarang).

-- CreateEnum
CREATE TYPE "DiagnosticQuestionType" AS ENUM ('single', 'multiple', 'truefalse', 'gap', 'short', 'essay');

-- CreateEnum
CREATE TYPE "DiagnosticLevel" AS ENUM ('easy', 'medium', 'hard', 'expert');

-- CreateEnum
CREATE TYPE "DiagnosticQuestionStatus" AS ENUM ('draft', 'review', 'approved', 'archived');

-- CreateEnum
CREATE TYPE "DiagnosticMode" AS ENUM ('adaptive', 'practice', 'timed', 'section');

-- CreateEnum
CREATE TYPE "DiagnosticTestStatus" AS ENUM ('draft', 'scheduled', 'active', 'archived');

-- CreateEnum
CREATE TYPE "DiagnosticAttemptStatus" AS ENUM ('in_progress', 'submitted', 'evaluated', 'expired');

-- CreateEnum
CREATE TYPE "DiagnosticInsightKind" AS ENUM ('feedback', 'explain', 'plan', 'roadmap');

-- CreateEnum
CREATE TYPE "DiagnosticInsightStatus" AS ENUM ('queued', 'processing', 'done', 'failed');

-- CreateTable
CREATE TABLE "diagnostic_questions" (
    "id" CHAR(24) NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "subject_id" CHAR(24) NOT NULL,
    "topic_id" CHAR(24),
    "grade" INTEGER,
    "text" TEXT NOT NULL,
    "type" "DiagnosticQuestionType" NOT NULL DEFAULT 'single',
    "difficulty" "DiagnosticLevel" NOT NULL DEFAULT 'medium',
    "bloom" VARCHAR(24),
    "image" JSONB,
    "estimated_time" INTEGER NOT NULL DEFAULT 60,
    "points" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "accepted_answers" TEXT[],
    "explanation" TEXT,
    "solution" TEXT,
    "status" "DiagnosticQuestionStatus" NOT NULL DEFAULT 'draft',
    "language" VARCHAR(4) NOT NULL DEFAULT 'uz',
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "correct_count" INTEGER NOT NULL DEFAULT 0,
    "accuracy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "author_id" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "diagnostic_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnostic_question_options" (
    "id" CHAR(24) NOT NULL,
    "question_id" CHAR(24) NOT NULL,
    "text" TEXT,
    "image" JSONB,
    "is_correct" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL,

    CONSTRAINT "diagnostic_question_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnostic_tests" (
    "id" CHAR(24) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "subject_id" CHAR(24),
    "grade" INTEGER,
    "mode" "DiagnosticMode" NOT NULL DEFAULT 'practice',
    "level" "DiagnosticLevel",
    "question_count" INTEGER NOT NULL DEFAULT 20,
    "duration_min" INTEGER NOT NULL DEFAULT 30,
    "status" "DiagnosticTestStatus" NOT NULL DEFAULT 'draft',
    "available_from" TIMESTAMP(3),
    "available_to" TIMESTAMP(3),
    "attempts_allowed" INTEGER NOT NULL DEFAULT 1,
    "shuffle_questions" BOOLEAN NOT NULL DEFAULT true,
    "shuffle_options" BOOLEAN NOT NULL DEFAULT true,
    "show_answers" BOOLEAN NOT NULL DEFAULT true,
    "created_by" CHAR(24) NOT NULL,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "diagnostic_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnostic_test_classes" (
    "test_id" CHAR(24) NOT NULL,
    "class_id" CHAR(24) NOT NULL,

    CONSTRAINT "diagnostic_test_classes_pkey" PRIMARY KEY ("test_id","class_id")
);

-- CreateTable
CREATE TABLE "diagnostic_test_questions" (
    "test_id" CHAR(24) NOT NULL,
    "question_id" CHAR(24) NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "diagnostic_test_questions_pkey" PRIMARY KEY ("test_id","question_id")
);

-- CreateTable
CREATE TABLE "diagnostic_attempts" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "test_id" CHAR(24),
    "subject_id" CHAR(24),
    "school_grade" INTEGER,
    "topic_id" CHAR(24),
    "mode" "DiagnosticMode" NOT NULL DEFAULT 'practice',
    "level" "DiagnosticLevel",
    "status" "DiagnosticAttemptStatus" NOT NULL DEFAULT 'in_progress',
    "attempt_number" INTEGER NOT NULL DEFAULT 1,
    "student_snapshot" JSONB NOT NULL,
    "total_questions" INTEGER NOT NULL DEFAULT 0,
    "correct_count" INTEGER,
    "wrong_count" INTEGER,
    "skipped_count" INTEGER,
    "score" DOUBLE PRECISION,
    "earned_points" DOUBLE PRECISION,
    "max_points" DOUBLE PRECISION,
    "accuracy" DOUBLE PRECISION,
    "grade" VARCHAR(8),
    "se_score" DOUBLE PRECISION,
    "time_spent_sec" INTEGER,
    "ability" DOUBLE PRECISION DEFAULT 0,
    "ability_se" DOUBLE PRECISION DEFAULT 1,
    "breakdown" JSONB,
    "error_patterns" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "diagnostic_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnostic_attempt_questions" (
    "id" CHAR(24) NOT NULL,
    "attempt_id" CHAR(24) NOT NULL,
    "question_id" CHAR(24) NOT NULL,
    "type" "DiagnosticQuestionType" NOT NULL,
    "difficulty" "DiagnosticLevel" NOT NULL,
    "text" TEXT NOT NULL,
    "image" JSONB,
    "points" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "topic_id" CHAR(24),
    "topic_name" TEXT,
    "subject_id" CHAR(24),
    "subject_name" TEXT,
    "estimated_time" INTEGER NOT NULL DEFAULT 60,
    "explanation" TEXT,
    "solution" TEXT,
    "accepted_answers" TEXT[],
    "position" INTEGER NOT NULL,

    CONSTRAINT "diagnostic_attempt_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnostic_attempt_options" (
    "id" CHAR(24) NOT NULL,
    "attempt_question_id" CHAR(24) NOT NULL,
    "option_id" CHAR(24),
    "text" TEXT,
    "image" JSONB,
    "is_correct" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL,

    CONSTRAINT "diagnostic_attempt_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnostic_answers" (
    "id" CHAR(24) NOT NULL,
    "attempt_id" CHAR(24) NOT NULL,
    "attempt_question_id" CHAR(24) NOT NULL,
    "selected_option_ids" TEXT[],
    "text_answer" TEXT,
    "isCorrect" BOOLEAN,
    "is_skipped" BOOLEAN NOT NULL DEFAULT false,
    "points_earned" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "error_reason" VARCHAR(16),
    "confidence" VARCHAR(8),
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "time_spent_sec" INTEGER,
    "change_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "diagnostic_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnostic_insights" (
    "id" CHAR(24) NOT NULL,
    "attempt_id" CHAR(24),
    "student_id" CHAR(24),
    "target_id" VARCHAR(24) NOT NULL DEFAULT '-',
    "kind" "DiagnosticInsightKind" NOT NULL,
    "status" "DiagnosticInsightStatus" NOT NULL DEFAULT 'queued',
    "model" VARCHAR(64),
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "diagnostic_insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnostic_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT 'singleton',
    "ai_enabled" BOOLEAN NOT NULL DEFAULT true,
    "default_question_count" INTEGER NOT NULL DEFAULT 20,
    "default_duration_min" INTEGER NOT NULL DEFAULT 30,
    "default_attempts" INTEGER NOT NULL DEFAULT 1,
    "good_score" INTEGER NOT NULL DEFAULT 70,
    "medium_score" INTEGER NOT NULL DEFAULT 40,
    "weak_topic_score" INTEGER NOT NULL DEFAULT 80,
    "level_tiers" JSONB,
    "updated_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "diagnostic_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "diagnostic_questions_code_key" ON "diagnostic_questions"("code");

-- CreateIndex
CREATE INDEX "diagnostic_questions_subject_id_status_idx" ON "diagnostic_questions"("subject_id", "status");

-- CreateIndex
CREATE INDEX "diagnostic_questions_topic_id_idx" ON "diagnostic_questions"("topic_id");

-- CreateIndex
CREATE INDEX "diagnostic_questions_subject_id_difficulty_status_idx" ON "diagnostic_questions"("subject_id", "difficulty", "status");

-- CreateIndex
CREATE INDEX "diagnostic_questions_grade_subject_id_status_idx" ON "diagnostic_questions"("grade", "subject_id", "status");

-- CreateIndex
CREATE INDEX "diagnostic_questions_status_usage_count_idx" ON "diagnostic_questions"("status", "usage_count");

-- CreateIndex
CREATE INDEX "diagnostic_question_options_question_id_idx" ON "diagnostic_question_options"("question_id");

-- CreateIndex
CREATE INDEX "diagnostic_tests_status_available_from_idx" ON "diagnostic_tests"("status", "available_from");

-- CreateIndex
CREATE INDEX "diagnostic_tests_subject_id_status_idx" ON "diagnostic_tests"("subject_id", "status");

-- CreateIndex
CREATE INDEX "diagnostic_tests_created_at_idx" ON "diagnostic_tests"("created_at" DESC);

-- CreateIndex
CREATE INDEX "diagnostic_test_classes_class_id_idx" ON "diagnostic_test_classes"("class_id");

-- CreateIndex
CREATE INDEX "diagnostic_test_questions_question_id_idx" ON "diagnostic_test_questions"("question_id");

-- CreateIndex
CREATE INDEX "diagnostic_attempts_student_id_created_at_idx" ON "diagnostic_attempts"("student_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "diagnostic_attempts_status_expires_at_idx" ON "diagnostic_attempts"("status", "expires_at");

-- CreateIndex
CREATE INDEX "diagnostic_attempts_test_id_idx" ON "diagnostic_attempts"("test_id");

-- CreateIndex
CREATE INDEX "diagnostic_attempts_subject_id_submitted_at_idx" ON "diagnostic_attempts"("subject_id", "submitted_at" DESC);

-- CreateIndex
CREATE INDEX "diagnostic_attempts_submitted_at_idx" ON "diagnostic_attempts"("submitted_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "diagnostic_attempts_test_id_student_id_attempt_number_key" ON "diagnostic_attempts"("test_id", "student_id", "attempt_number");

-- CreateIndex
CREATE INDEX "diagnostic_attempt_questions_attempt_id_position_idx" ON "diagnostic_attempt_questions"("attempt_id", "position");

-- CreateIndex
CREATE INDEX "diagnostic_attempt_questions_question_id_idx" ON "diagnostic_attempt_questions"("question_id");

-- CreateIndex
CREATE INDEX "diagnostic_attempt_options_attempt_question_id_idx" ON "diagnostic_attempt_options"("attempt_question_id");

-- CreateIndex
CREATE UNIQUE INDEX "diagnostic_answers_attempt_question_id_key" ON "diagnostic_answers"("attempt_question_id");

-- CreateIndex
CREATE INDEX "diagnostic_answers_attempt_id_idx" ON "diagnostic_answers"("attempt_id");

-- CreateIndex
CREATE INDEX "diagnostic_insights_student_id_created_at_idx" ON "diagnostic_insights"("student_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "diagnostic_insights_status_idx" ON "diagnostic_insights"("status");

-- CreateIndex
CREATE UNIQUE INDEX "diagnostic_insights_attempt_id_kind_target_id_key" ON "diagnostic_insights"("attempt_id", "kind", "target_id");

-- AddForeignKey
ALTER TABLE "diagnostic_questions" ADD CONSTRAINT "diagnostic_questions_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_questions" ADD CONSTRAINT "diagnostic_questions_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_question_options" ADD CONSTRAINT "diagnostic_question_options_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "diagnostic_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_test_classes" ADD CONSTRAINT "diagnostic_test_classes_test_id_fkey" FOREIGN KEY ("test_id") REFERENCES "diagnostic_tests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_test_classes" ADD CONSTRAINT "diagnostic_test_classes_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_test_questions" ADD CONSTRAINT "diagnostic_test_questions_test_id_fkey" FOREIGN KEY ("test_id") REFERENCES "diagnostic_tests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_test_questions" ADD CONSTRAINT "diagnostic_test_questions_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "diagnostic_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_attempts" ADD CONSTRAINT "diagnostic_attempts_test_id_fkey" FOREIGN KEY ("test_id") REFERENCES "diagnostic_tests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_attempt_questions" ADD CONSTRAINT "diagnostic_attempt_questions_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "diagnostic_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_attempt_options" ADD CONSTRAINT "diagnostic_attempt_options_attempt_question_id_fkey" FOREIGN KEY ("attempt_question_id") REFERENCES "diagnostic_attempt_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_answers" ADD CONSTRAINT "diagnostic_answers_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "diagnostic_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_answers" ADD CONSTRAINT "diagnostic_answers_attempt_question_id_fkey" FOREIGN KEY ("attempt_question_id") REFERENCES "diagnostic_attempt_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_insights" ADD CONSTRAINT "diagnostic_insights_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "diagnostic_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

