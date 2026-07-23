-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('male', 'female');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('present', 'late', 'absent', 'excused');

-- CreateEnum
CREATE TYPE "ExcuseRequestType" AS ENUM ('advance', 'after');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('pending', 'extended', 'pending_rejected', 'stopped', 'completed', 'pending_review');

-- CreateEnum
CREATE TYPE "PenaltyType" AS ENUM ('penalty', 'reduction');

-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "CoinTransactionType" AS ENUM ('daily', 'weekly_school_bonus', 'weekly_class_bonus', 'market_purchase', 'market_refund', 'holiday_bonus', 'manual_give', 'manual_take', 'premium_purchase', 'fine_reduction_purchase', 'season_absolute_reward', 'season_class_top_reward');

-- CreateEnum
CREATE TYPE "MarketOrderStatus" AS ENUM ('pending', 'delivering', 'approved', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('new', 'contacted', 'interested', 'visited', 'trial', 'negotiation', 'enrolled', 'rejected', 'lost', 'postponed');

-- CreateEnum
CREATE TYPE "LeadActivityType" AS ENUM ('call', 'meeting', 'note', 'status_change', 'visit');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('standard', 'open');

-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('easy', 'medium', 'hard');

-- CreateEnum
CREATE TYPE "TestBindingStatus" AS ENUM ('draft', 'published', 'closed');

-- CreateEnum
CREATE TYPE "TestSessionStatus" AS ENUM ('in_progress', 'submitted', 'expired');

-- CreateEnum
CREATE TYPE "TestResultStatus" AS ENUM ('pending', 'partially_graded', 'graded');

-- CreateEnum
CREATE TYPE "PerQuestionStatus" AS ENUM ('pending', 'graded');

-- CreateEnum
CREATE TYPE "TestSeasonStatus" AS ENUM ('draft', 'active', 'closed');

-- CreateEnum
CREATE TYPE "MessageRecipientType" AS ENUM ('all', 'class', 'student', 'season');

-- CreateEnum
CREATE TYPE "MessageDeliveryStatusEnum" AS ENUM ('pending', 'sent', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "MessageQueueStatus" AS ENUM ('pending', 'processing', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "MessageQueueFileType" AS ENUM ('photo', 'document');

-- CreateEnum
CREATE TYPE "HolidayType" AS ENUM ('single', 'range', 'recurring');

-- CreateEnum
CREATE TYPE "PremiumStatus" AS ENUM ('active', 'expired', 'revoked');

-- CreateEnum
CREATE TYPE "PremiumSource" AS ENUM ('purchase', 'admin_grant');

-- CreateEnum
CREATE TYPE "ScheduleDay" AS ENUM ('dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba');

-- CreateTable
CREATE TABLE "users" (
    "id" CHAR(24) NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "plain_password" TEXT,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT,
    "telegram_ids" TEXT[],
    "role" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "gender" "Gender",
    "coin_balance" INTEGER NOT NULL DEFAULT 0,
    "penalty_points" INTEGER NOT NULL DEFAULT 0,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    "archive_snapshot" JSONB,
    "work_start_time" TEXT,
    "work_end_time" TEXT,
    "work_days" INTEGER[],
    "weekly_schedule" JSONB NOT NULL DEFAULT '{}',
    "premium_is_active" BOOLEAN NOT NULL DEFAULT false,
    "premium_expires_at" TIMESTAMP(3),
    "profile_picture" CHAR(24),
    "emoji_badge_id" TEXT,
    "display_name" TEXT,
    "name_color" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_classes" (
    "user_id" CHAR(24) NOT NULL,
    "class_id" CHAR(24) NOT NULL,

    CONSTRAINT "user_classes_pkey" PRIMARY KEY ("user_id","class_id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "work_start_time" TEXT,
    "work_end_time" TEXT,
    "work_days" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "weekly_schedule" JSONB NOT NULL DEFAULT '{}',
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classes" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subjects" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topics" (
    "id" CHAR(24) NOT NULL,
    "subject_id" CHAR(24) NOT NULL,
    "order" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" CHAR(24) NOT NULL,
    "class_id" CHAR(24) NOT NULL,
    "day" "ScheduleDay" NOT NULL,
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_lessons" (
    "id" CHAR(24) NOT NULL,
    "schedule_id" CHAR(24) NOT NULL,
    "subject_id" CHAR(24) NOT NULL,
    "teacher_id" CHAR(24) NOT NULL,
    "order" INTEGER NOT NULL,
    "start_time" TEXT,
    "end_time" TEXT,
    "position" INTEGER NOT NULL,

    CONSTRAINT "schedule_lessons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT 'singleton',
    "periods" JSONB NOT NULL DEFAULT '[]',
    "updated_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teacher_assignments" (
    "id" CHAR(24) NOT NULL,
    "season_id" CHAR(24) NOT NULL,
    "class_id" CHAR(24) NOT NULL,
    "subject_id" CHAR(24) NOT NULL,
    "teacher_id" CHAR(24) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teacher_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "class_subject_progress" (
    "id" CHAR(24) NOT NULL,
    "class_id" CHAR(24) NOT NULL,
    "subject_id" CHAR(24) NOT NULL,
    "current_topic_number" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "class_subject_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendances" (
    "id" CHAR(24) NOT NULL,
    "user_id" CHAR(24) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "check_in" TIMESTAMP(3),
    "check_out" TIMESTAMP(3),
    "status" "AttendanceStatus" NOT NULL DEFAULT 'present',
    "is_late" BOOLEAN NOT NULL DEFAULT false,
    "late_minutes" INTEGER NOT NULL DEFAULT 0,
    "is_early_out" BOOLEAN NOT NULL DEFAULT false,
    "early_out_minutes" INTEGER NOT NULL DEFAULT 0,
    "check_in_location" JSONB,
    "check_out_location" JSONB,
    "location_warning" BOOLEAN NOT NULL DEFAULT false,
    "out_of_office" BOOLEAN NOT NULL DEFAULT false,
    "penalty_applied" BOOLEAN NOT NULL DEFAULT false,
    "penalty_ref" CHAR(24),
    "excuse_reason" TEXT,
    "absence_reason" CHAR(24),
    "auto_marked" BOOLEAN NOT NULL DEFAULT false,
    "created_by" CHAR(24),
    "last_modified_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT 'singleton',
    "office_location" JSONB,
    "office_radius" INTEGER NOT NULL DEFAULT 100,
    "late_arrival_penalty_points" INTEGER NOT NULL DEFAULT 1,
    "late_arrival_grace_minutes" INTEGER NOT NULL DEFAULT 10,
    "early_departure_penalty_points" INTEGER NOT NULL DEFAULT 1,
    "early_departure_grace_minutes" INTEGER NOT NULL DEFAULT 10,
    "absent_penalty_points" INTEGER NOT NULL DEFAULT 2,
    "penalty_paused" BOOLEAN NOT NULL DEFAULT false,
    "paused_roles" TEXT[],
    "paused_users" TEXT[],
    "updated_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "absence_reasons" (
    "id" CHAR(24) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "roles" TEXT[],
    "applies_to_all" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "absence_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_attendances" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "class_id" CHAR(24) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'absent',
    "marked_at" TIMESTAMP(3),
    "excuse_reason" TEXT,
    "absence_reason" CHAR(24),
    "auto_marked" BOOLEAN NOT NULL DEFAULT false,
    "created_by" CHAR(24),
    "last_modified_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_attendances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "excuse_requests" (
    "id" CHAR(24) NOT NULL,
    "user_id" CHAR(24) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "absence_reason" CHAR(24),
    "reason" TEXT,
    "type" "ExcuseRequestType" NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'pending',
    "reviewed_by" CHAR(24),
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "excuse_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grades" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "subject_id" CHAR(24) NOT NULL,
    "class_id" CHAR(24) NOT NULL,
    "teacher_id" CHAR(24) NOT NULL,
    "grade" INTEGER NOT NULL,
    "comment" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "lesson_order" INTEGER NOT NULL DEFAULT 1,
    "is_edited" BOOLEAN NOT NULL DEFAULT false,
    "edit_history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grade_penalty_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT 'singleton',
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "penalty_points" INTEGER NOT NULL DEFAULT 1,
    "missing_threshold_percent" INTEGER NOT NULL DEFAULT 40,
    "exempt_teachers" TEXT[],
    "updated_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grade_penalty_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" CHAR(24) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "assignee" CHAR(24) NOT NULL,
    "created_by" CHAR(24) NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'pending',
    "due_date" TIMESTAMP(3) NOT NULL,
    "penalty_points" INTEGER NOT NULL DEFAULT 1,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "completion_note" TEXT,
    "completion_attachments" JSONB NOT NULL DEFAULT '[]',
    "penalty_ref" CHAR(24),
    "autopenalized" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_status_history" (
    "id" CHAR(24) NOT NULL,
    "task_id" CHAR(24) NOT NULL,
    "status" "TaskStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "changed_by" CHAR(24),
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "position" INTEGER NOT NULL,

    CONSTRAINT "task_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_deadline_history" (
    "id" CHAR(24) NOT NULL,
    "task_id" CHAR(24) NOT NULL,
    "old_due_date" TIMESTAMP(3) NOT NULL,
    "new_due_date" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "changed_by" CHAR(24) NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "with_penalty" BOOLEAN NOT NULL DEFAULT false,
    "penalty_points" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL,

    CONSTRAINT "task_deadline_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "penalties" (
    "id" CHAR(24) NOT NULL,
    "user_id" CHAR(24) NOT NULL,
    "given_by" CHAR(24) NOT NULL,
    "category" CHAR(24),
    "type" "PenaltyType" NOT NULL DEFAULT 'penalty',
    "title" TEXT,
    "description" TEXT,
    "points" INTEGER NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'pending',
    "reviewed_by" CHAR(24),
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "is_custom" BOOLEAN NOT NULL DEFAULT false,
    "fine_amount" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "penalties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "penalty_categories" (
    "id" CHAR(24) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "points" INTEGER NOT NULL,
    "target_role" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "penalty_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "penalty_notification_queue" (
    "id" CHAR(24) NOT NULL,
    "penalty_id" CHAR(24) NOT NULL,
    "telegram_id" TEXT NOT NULL,
    "user_id" CHAR(24),
    "message_text" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "status" "QueueStatus" NOT NULL DEFAULT 'pending',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "error_message" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "penalty_notification_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "penalty_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT 'singleton',
    "fine_amounts" JSONB NOT NULL DEFAULT '{}',
    "student_fine_amount" INTEGER NOT NULL DEFAULT 2100000,
    "teacher_fine_amount" INTEGER NOT NULL DEFAULT 2100000,
    "premium_reduction_discount_percent" INTEGER NOT NULL DEFAULT 0,
    "updated_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "penalty_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fine_reduction_packages" (
    "id" CHAR(24) NOT NULL,
    "title" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "coin_cost" INTEGER NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fine_reduction_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT 'singleton',
    "daily_coin_percentage" INTEGER NOT NULL DEFAULT 60,
    "school_rank_bonus" INTEGER NOT NULL DEFAULT 100,
    "class_rank_bonus" INTEGER NOT NULL DEFAULT 20,
    "min_daily_grade_for_coin" INTEGER NOT NULL DEFAULT 10,
    "updated_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coin_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_transactions" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "amount" INTEGER NOT NULL,
    "type" "CoinTransactionType" NOT NULL,
    "description" TEXT NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "meta" JSONB,
    "date" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coin_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_coin_stats" (
    "id" CHAR(24) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "total_distributed" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_coin_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_products" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "price" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_by" CHAR(24) NOT NULL,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_product_images" (
    "product_id" CHAR(24) NOT NULL,
    "image_id" CHAR(24) NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "market_product_images_pkey" PRIMARY KEY ("product_id","image_id")
);

-- CreateTable
CREATE TABLE "market_orders" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "product_id" CHAR(24) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" INTEGER NOT NULL,
    "total_price" INTEGER NOT NULL,
    "product_snapshot" JSONB NOT NULL,
    "status" "MarketOrderStatus" NOT NULL DEFAULT 'pending',
    "delivery_image" CHAR(24),
    "reject_reason" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_order_status_history" (
    "id" CHAR(24) NOT NULL,
    "order_id" CHAR(24) NOT NULL,
    "status" "MarketOrderStatus" NOT NULL,
    "changed_by" CHAR(24) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "position" INTEGER NOT NULL,

    CONSTRAINT "market_order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" CHAR(24) NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "additional_phone" TEXT,
    "source" CHAR(24) NOT NULL,
    "direction" CHAR(24) NOT NULL,
    "category" CHAR(24) NOT NULL,
    "status" "LeadStatus" NOT NULL DEFAULT 'new',
    "class_interest" TEXT,
    "parent_name" TEXT,
    "parent_phone" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "expected_enroll_date" TIMESTAMP(3),
    "lost_reason" TEXT,
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_activities" (
    "id" CHAR(24) NOT NULL,
    "lead_id" CHAR(24) NOT NULL,
    "type" "LeadActivityType" NOT NULL,
    "description" TEXT NOT NULL,
    "previous_status" TEXT,
    "new_status" TEXT,
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_categories" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_directions" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_directions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_sources" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tests" (
    "id" CHAR(24) NOT NULL,
    "teacher_id" CHAR(24) NOT NULL,
    "title" TEXT NOT NULL,
    "question_count" INTEGER NOT NULL DEFAULT 30,
    "time_limit_minutes" INTEGER NOT NULL DEFAULT 30,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" CHAR(24) NOT NULL,
    "test_id" CHAR(24) NOT NULL,
    "type" "QuestionType" NOT NULL,
    "text" TEXT,
    "image" JSONB,
    "difficulty" "Difficulty" NOT NULL DEFAULT 'medium',
    "points" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_options" (
    "id" CHAR(24) NOT NULL,
    "question_id" CHAR(24) NOT NULL,
    "text" TEXT,
    "image" JSONB,
    "is_correct" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL,

    CONSTRAINT "question_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_bindings" (
    "id" CHAR(24) NOT NULL,
    "test_id" CHAR(24) NOT NULL,
    "teacher_id" CHAR(24) NOT NULL,
    "season_id" CHAR(24) NOT NULL,
    "subject_id" CHAR(24) NOT NULL,
    "status" "TestBindingStatus" NOT NULL DEFAULT 'draft',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_binding_classes" (
    "binding_id" CHAR(24) NOT NULL,
    "class_id" CHAR(24) NOT NULL,

    CONSTRAINT "test_binding_classes_pkey" PRIMARY KEY ("binding_id","class_id")
);

-- CreateTable
CREATE TABLE "test_binding_reopen_grants" (
    "id" CHAR(24) NOT NULL,
    "binding_id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "granted_by" CHAR(24) NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_binding_reopen_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_sessions" (
    "id" CHAR(24) NOT NULL,
    "binding_id" CHAR(24) NOT NULL,
    "test_id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "season_id" CHAR(24) NOT NULL,
    "attempt_number" INTEGER NOT NULL DEFAULT 1,
    "status" "TestSessionStatus" NOT NULL DEFAULT 'in_progress',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "submitted_at" TIMESTAMP(3),
    "grading_min" INTEGER,
    "grading_max" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_session_questions" (
    "id" CHAR(24) NOT NULL,
    "session_id" CHAR(24) NOT NULL,
    "question_id" CHAR(24) NOT NULL,
    "type" "QuestionType" NOT NULL,
    "text" TEXT,
    "image" JSONB,
    "difficulty" "Difficulty" NOT NULL DEFAULT 'medium',
    "points" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "correct_option_id" CHAR(24),
    "position" INTEGER NOT NULL,

    CONSTRAINT "test_session_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_session_question_options" (
    "id" CHAR(24) NOT NULL,
    "question_row_id" CHAR(24) NOT NULL,
    "option_id" CHAR(24) NOT NULL,
    "text" TEXT,
    "image" JSONB,
    "position" INTEGER NOT NULL,

    CONSTRAINT "test_session_question_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_session_answers" (
    "id" CHAR(24) NOT NULL,
    "session_id" CHAR(24) NOT NULL,
    "question_id" CHAR(24) NOT NULL,
    "selected_option_id" CHAR(24),
    "text_answer" TEXT,
    "answered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_session_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_results" (
    "id" CHAR(24) NOT NULL,
    "session_id" CHAR(24) NOT NULL,
    "binding_id" CHAR(24) NOT NULL,
    "test_id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "season_id" CHAR(24) NOT NULL,
    "class_id" CHAR(24),
    "subject_id" CHAR(24) NOT NULL,
    "auto_graded_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "manual_graded_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "final_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "grading_min" INTEGER,
    "grading_max" INTEGER,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "status" "TestResultStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_result_extra_points" (
    "id" CHAR(24) NOT NULL,
    "result_id" CHAR(24) NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "added_by" CHAR(24) NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "position" INTEGER NOT NULL,

    CONSTRAINT "test_result_extra_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_result_per_questions" (
    "id" CHAR(24) NOT NULL,
    "result_id" CHAR(24) NOT NULL,
    "question_id" CHAR(24) NOT NULL,
    "awarded_points" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "max_points" DOUBLE PRECISION NOT NULL,
    "graded_by" CHAR(24),
    "status" "PerQuestionStatus" NOT NULL DEFAULT 'graded',
    "feedback" TEXT,
    "position" INTEGER NOT NULL,

    CONSTRAINT "test_result_per_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_seasons" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "status" "TestSeasonStatus" NOT NULL DEFAULT 'draft',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" CHAR(24),
    "school_tiers" JSONB NOT NULL DEFAULT '[]',
    "class_tiers" JSONB NOT NULL DEFAULT '[]',
    "distributed_at" TIMESTAMP(3),
    "distributed_by" CHAR(24),
    "finalized_at" TIMESTAMP(3),
    "finalized_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_seasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT 'singleton',
    "min_score" INTEGER NOT NULL DEFAULT 56,
    "max_score" INTEGER NOT NULL DEFAULT 189,
    "updated_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" CHAR(24) NOT NULL,
    "message_text" TEXT NOT NULL,
    "sent_by" CHAR(24) NOT NULL,
    "recipient_type" "MessageRecipientType" NOT NULL,
    "recipient_ids" TEXT[],
    "class_id" CHAR(24),
    "season" CHAR(24),
    "student_id" CHAR(24),
    "total_recipients" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_delivery_status" (
    "id" CHAR(24) NOT NULL,
    "message_id" CHAR(24) NOT NULL,
    "telegram_id" TEXT NOT NULL,
    "user_id" CHAR(24),
    "status" "MessageDeliveryStatusEnum" NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "sent_at" TIMESTAMP(3),
    "position" INTEGER NOT NULL,

    CONSTRAINT "message_delivery_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_queue" (
    "id" CHAR(24) NOT NULL,
    "message_id" CHAR(24) NOT NULL,
    "telegram_id" TEXT NOT NULL,
    "user_id" CHAR(24),
    "message_text" TEXT NOT NULL,
    "file_path" TEXT,
    "file_name" TEXT,
    "file_content_type" TEXT,
    "file_type" "MessageQueueFileType",
    "reply_markup" JSONB,
    "status" "MessageQueueStatus" NOT NULL DEFAULT 'pending',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "error_message" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tg_users" (
    "id" CHAR(24) NOT NULL,
    "telegram_id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "student" CHAR(24) NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "username" TEXT,
    "notifications_enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_activity" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tg_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_networks" (
    "id" CHAR(24) NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'telegram',
    "name" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "username" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_networks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_stats" (
    "id" CHAR(24) NOT NULL,
    "student" CHAR(24) NOT NULL,
    "week_start" TIMESTAMP(3) NOT NULL,
    "week_end" TIMESTAMP(3) NOT NULL,
    "week_number" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "simple_stats" JSONB NOT NULL DEFAULT '{}',
    "total_sum" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_grades" INTEGER NOT NULL DEFAULT 0,
    "class_ranks" JSONB NOT NULL DEFAULT '[]',
    "school_rank" INTEGER,
    "school_total_students" INTEGER,
    "last_updated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_complete" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_stats_classes" (
    "weekly_stats_id" CHAR(24) NOT NULL,
    "class_id" CHAR(24) NOT NULL,

    CONSTRAINT "weekly_stats_classes_pkey" PRIMARY KEY ("weekly_stats_id","class_id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "HolidayType" NOT NULL,
    "date" TIMESTAMP(3),
    "start_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "recurring_date" JSONB,
    "recurring_start_date" JSONB,
    "recurring_end_date" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "images" (
    "id" CHAR(24) NOT NULL,
    "original_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "original_size_bytes" INTEGER NOT NULL,
    "variants" JSONB NOT NULL,
    "uploaded_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitors" (
    "id" CHAR(24) NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "premiums" (
    "id" CHAR(24) NOT NULL,
    "student" CHAR(24) NOT NULL,
    "duration_days" INTEGER NOT NULL DEFAULT 30,
    "coin_cost" INTEGER NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "status" "PremiumStatus" NOT NULL DEFAULT 'active',
    "coin_balance_after" INTEGER NOT NULL,
    "source" "PremiumSource" NOT NULL DEFAULT 'purchase',
    "granted_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "premiums_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "premium_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT 'singleton',
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "coin_cost" INTEGER NOT NULL DEFAULT 100,
    "duration_days" INTEGER NOT NULL DEFAULT 30,
    "allowed_name_colors" JSONB NOT NULL DEFAULT '[]',
    "updated_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "premium_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emoji_configs" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "animation_url" TEXT NOT NULL,
    "file_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "emoji_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_role_is_active_idx" ON "users"("role", "is_active");

-- CreateIndex
CREATE INDEX "users_role_is_archived_idx" ON "users"("role", "is_archived");

-- CreateIndex
CREATE INDEX "users_is_archived_idx" ON "users"("is_archived");

-- CreateIndex
CREATE INDEX "users_premium_is_active_idx" ON "users"("premium_is_active");

-- CreateIndex
CREATE INDEX "user_classes_class_id_idx" ON "user_classes"("class_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "roles_value_key" ON "roles"("value");

-- CreateIndex
CREATE UNIQUE INDEX "classes_name_key" ON "classes"("name");

-- CreateIndex
CREATE UNIQUE INDEX "subjects_name_key" ON "subjects"("name");

-- CreateIndex
CREATE INDEX "topics_subject_id_idx" ON "topics"("subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "topics_subject_id_order_key" ON "topics"("subject_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "schedules_class_id_day_key" ON "schedules"("class_id", "day");

-- CreateIndex
CREATE INDEX "schedule_lessons_schedule_id_idx" ON "schedule_lessons"("schedule_id");

-- CreateIndex
CREATE INDEX "schedule_lessons_teacher_id_idx" ON "schedule_lessons"("teacher_id");

-- CreateIndex
CREATE INDEX "teacher_assignments_teacher_id_season_id_idx" ON "teacher_assignments"("teacher_id", "season_id");

-- CreateIndex
CREATE INDEX "teacher_assignments_season_id_class_id_subject_id_idx" ON "teacher_assignments"("season_id", "class_id", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "teacher_assignments_season_id_class_id_subject_id_teacher_i_key" ON "teacher_assignments"("season_id", "class_id", "subject_id", "teacher_id");

-- CreateIndex
CREATE UNIQUE INDEX "class_subject_progress_class_id_subject_id_key" ON "class_subject_progress"("class_id", "subject_id");

-- CreateIndex
CREATE INDEX "attendances_date_status_idx" ON "attendances"("date", "status");

-- CreateIndex
CREATE INDEX "attendances_status_created_at_idx" ON "attendances"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "attendances_user_id_created_at_idx" ON "attendances"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "attendances_user_id_date_key" ON "attendances"("user_id", "date");

-- CreateIndex
CREATE INDEX "absence_reasons_is_active_idx" ON "absence_reasons"("is_active");

-- CreateIndex
CREATE INDEX "absence_reasons_applies_to_all_is_active_idx" ON "absence_reasons"("applies_to_all", "is_active");

-- CreateIndex
CREATE INDEX "student_attendances_class_id_date_idx" ON "student_attendances"("class_id", "date");

-- CreateIndex
CREATE INDEX "student_attendances_date_status_idx" ON "student_attendances"("date", "status");

-- CreateIndex
CREATE INDEX "student_attendances_student_id_created_at_idx" ON "student_attendances"("student_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "student_attendances_student_id_date_key" ON "student_attendances"("student_id", "date");

-- CreateIndex
CREATE INDEX "excuse_requests_user_id_date_idx" ON "excuse_requests"("user_id", "date");

-- CreateIndex
CREATE INDEX "excuse_requests_status_created_at_idx" ON "excuse_requests"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "excuse_requests_user_id_created_at_idx" ON "excuse_requests"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "grades_student_id_subject_id_date_lesson_order_idx" ON "grades"("student_id", "subject_id", "date", "lesson_order");

-- CreateIndex
CREATE INDEX "grades_class_id_date_idx" ON "grades"("class_id", "date");

-- CreateIndex
CREATE INDEX "grades_teacher_id_date_idx" ON "grades"("teacher_id", "date");

-- CreateIndex
CREATE INDEX "tasks_assignee_status_idx" ON "tasks"("assignee", "status");

-- CreateIndex
CREATE INDEX "tasks_assignee_created_at_idx" ON "tasks"("assignee", "created_at" DESC);

-- CreateIndex
CREATE INDEX "tasks_created_by_created_at_idx" ON "tasks"("created_by", "created_at" DESC);

-- CreateIndex
CREATE INDEX "tasks_status_due_date_idx" ON "tasks"("status", "due_date");

-- CreateIndex
CREATE INDEX "tasks_due_date_autopenalized_status_idx" ON "tasks"("due_date", "autopenalized", "status");

-- CreateIndex
CREATE INDEX "task_status_history_task_id_idx" ON "task_status_history"("task_id");

-- CreateIndex
CREATE INDEX "task_deadline_history_task_id_idx" ON "task_deadline_history"("task_id");

-- CreateIndex
CREATE INDEX "penalties_user_id_status_idx" ON "penalties"("user_id", "status");

-- CreateIndex
CREATE INDEX "penalties_user_id_created_at_idx" ON "penalties"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "penalties_status_created_at_idx" ON "penalties"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "penalties_given_by_idx" ON "penalties"("given_by");

-- CreateIndex
CREATE INDEX "penalties_type_status_created_at_idx" ON "penalties"("type", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "penalty_categories_target_role_is_active_idx" ON "penalty_categories"("target_role", "is_active");

-- CreateIndex
CREATE INDEX "penalty_notification_queue_status_priority_created_at_idx" ON "penalty_notification_queue"("status", "priority" DESC, "created_at");

-- CreateIndex
CREATE INDEX "penalty_notification_queue_penalty_id_idx" ON "penalty_notification_queue"("penalty_id");

-- CreateIndex
CREATE INDEX "fine_reduction_packages_is_active_order_idx" ON "fine_reduction_packages"("is_active", "order");

-- CreateIndex
CREATE INDEX "coin_transactions_student_id_date_idx" ON "coin_transactions"("student_id", "date" DESC);

-- CreateIndex
CREATE INDEX "coin_transactions_student_id_type_date_idx" ON "coin_transactions"("student_id", "type", "date" DESC);

-- CreateIndex
CREATE INDEX "coin_transactions_date_type_idx" ON "coin_transactions"("date" DESC, "type");

-- CreateIndex
CREATE UNIQUE INDEX "daily_coin_stats_date_key" ON "daily_coin_stats"("date");

-- CreateIndex
CREATE INDEX "market_products_is_archived_is_active_created_at_idx" ON "market_products"("is_archived", "is_active", "created_at" DESC);

-- CreateIndex
CREATE INDEX "market_products_quantity_created_at_idx" ON "market_products"("quantity", "created_at" DESC);

-- CreateIndex
CREATE INDEX "market_product_images_image_id_idx" ON "market_product_images"("image_id");

-- CreateIndex
CREATE INDEX "market_orders_student_id_created_at_idx" ON "market_orders"("student_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "market_orders_status_created_at_idx" ON "market_orders"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "market_order_status_history_order_id_idx" ON "market_order_status_history"("order_id");

-- CreateIndex
CREATE INDEX "leads_status_source_created_at_idx" ON "leads"("status", "source", "created_at" DESC);

-- CreateIndex
CREATE INDEX "leads_phone_idx" ON "leads"("phone");

-- CreateIndex
CREATE INDEX "leads_created_by_idx" ON "leads"("created_by");

-- CreateIndex
CREATE INDEX "leads_direction_idx" ON "leads"("direction");

-- CreateIndex
CREATE INDEX "leads_category_idx" ON "leads"("category");

-- CreateIndex
CREATE INDEX "lead_activities_lead_id_created_at_idx" ON "lead_activities"("lead_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "lead_categories_name_key" ON "lead_categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "lead_directions_name_key" ON "lead_directions"("name");

-- CreateIndex
CREATE UNIQUE INDEX "lead_sources_name_key" ON "lead_sources"("name");

-- CreateIndex
CREATE INDEX "tests_teacher_id_is_active_idx" ON "tests"("teacher_id", "is_active");

-- CreateIndex
CREATE INDEX "tests_created_at_idx" ON "tests"("created_at" DESC);

-- CreateIndex
CREATE INDEX "questions_test_id_order_idx" ON "questions"("test_id", "order");

-- CreateIndex
CREATE INDEX "questions_test_id_is_active_idx" ON "questions"("test_id", "is_active");

-- CreateIndex
CREATE INDEX "question_options_question_id_idx" ON "question_options"("question_id");

-- CreateIndex
CREATE INDEX "test_bindings_test_id_idx" ON "test_bindings"("test_id");

-- CreateIndex
CREATE INDEX "test_bindings_season_id_subject_id_idx" ON "test_bindings"("season_id", "subject_id");

-- CreateIndex
CREATE INDEX "test_bindings_teacher_id_season_id_idx" ON "test_bindings"("teacher_id", "season_id");

-- CreateIndex
CREATE INDEX "test_bindings_status_idx" ON "test_bindings"("status");

-- CreateIndex
CREATE INDEX "test_binding_classes_class_id_idx" ON "test_binding_classes"("class_id");

-- CreateIndex
CREATE INDEX "test_binding_reopen_grants_binding_id_student_id_idx" ON "test_binding_reopen_grants"("binding_id", "student_id");

-- CreateIndex
CREATE INDEX "test_sessions_student_id_season_id_idx" ON "test_sessions"("student_id", "season_id");

-- CreateIndex
CREATE INDEX "test_sessions_binding_id_idx" ON "test_sessions"("binding_id");

-- CreateIndex
CREATE INDEX "test_sessions_test_id_idx" ON "test_sessions"("test_id");

-- CreateIndex
CREATE INDEX "test_sessions_status_expires_at_idx" ON "test_sessions"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "test_sessions_binding_id_student_id_attempt_number_key" ON "test_sessions"("binding_id", "student_id", "attempt_number");

-- CreateIndex
CREATE INDEX "test_session_questions_session_id_idx" ON "test_session_questions"("session_id");

-- CreateIndex
CREATE INDEX "test_session_question_options_question_row_id_idx" ON "test_session_question_options"("question_row_id");

-- CreateIndex
CREATE INDEX "test_session_answers_session_id_idx" ON "test_session_answers"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "test_results_session_id_key" ON "test_results"("session_id");

-- CreateIndex
CREATE INDEX "test_results_test_id_idx" ON "test_results"("test_id");

-- CreateIndex
CREATE INDEX "test_results_binding_id_idx" ON "test_results"("binding_id");

-- CreateIndex
CREATE INDEX "test_results_student_id_season_id_idx" ON "test_results"("student_id", "season_id");

-- CreateIndex
CREATE INDEX "test_results_status_idx" ON "test_results"("status");

-- CreateIndex
CREATE INDEX "test_results_season_id_subject_id_idx" ON "test_results"("season_id", "subject_id");

-- CreateIndex
CREATE INDEX "test_result_extra_points_result_id_idx" ON "test_result_extra_points"("result_id");

-- CreateIndex
CREATE INDEX "test_result_per_questions_result_id_idx" ON "test_result_per_questions"("result_id");

-- CreateIndex
CREATE INDEX "test_seasons_status_start_date_idx" ON "test_seasons"("status", "start_date");

-- CreateIndex
CREATE INDEX "test_seasons_start_date_end_date_idx" ON "test_seasons"("start_date", "end_date");

-- CreateIndex
CREATE INDEX "messages_sent_by_created_at_idx" ON "messages"("sent_by", "created_at" DESC);

-- CreateIndex
CREATE INDEX "messages_class_id_created_at_idx" ON "messages"("class_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "messages_recipient_type_created_at_idx" ON "messages"("recipient_type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "message_delivery_status_message_id_idx" ON "message_delivery_status"("message_id");

-- CreateIndex
CREATE INDEX "message_queue_status_priority_created_at_idx" ON "message_queue"("status", "priority" DESC, "created_at");

-- CreateIndex
CREATE INDEX "message_queue_message_id_idx" ON "message_queue"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "tg_users_telegram_id_key" ON "tg_users"("telegram_id");

-- CreateIndex
CREATE INDEX "tg_users_student_idx" ON "tg_users"("student");

-- CreateIndex
CREATE INDEX "tg_users_notifications_enabled_is_active_idx" ON "tg_users"("notifications_enabled", "is_active");

-- CreateIndex
CREATE INDEX "social_networks_platform_is_active_idx" ON "social_networks"("platform", "is_active");

-- CreateIndex
CREATE INDEX "weekly_stats_student_idx" ON "weekly_stats"("student");

-- CreateIndex
CREATE INDEX "weekly_stats_week_start_idx" ON "weekly_stats"("week_start");

-- CreateIndex
CREATE INDEX "weekly_stats_year_idx" ON "weekly_stats"("year");

-- CreateIndex
CREATE INDEX "weekly_stats_week_start_week_end_idx" ON "weekly_stats"("week_start", "week_end");

-- CreateIndex
CREATE INDEX "weekly_stats_school_rank_idx" ON "weekly_stats"("school_rank");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_stats_student_year_week_number_key" ON "weekly_stats"("student", "year", "week_number");

-- CreateIndex
CREATE INDEX "weekly_stats_classes_class_id_idx" ON "weekly_stats_classes"("class_id");

-- CreateIndex
CREATE INDEX "images_uploaded_by_idx" ON "images"("uploaded_by");

-- CreateIndex
CREATE INDEX "images_created_at_idx" ON "images"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "monitors_code_key" ON "monitors"("code");

-- CreateIndex
CREATE INDEX "premiums_student_idx" ON "premiums"("student");

-- CreateIndex
CREATE INDEX "premiums_status_idx" ON "premiums"("status");

-- CreateIndex
CREATE INDEX "premiums_source_idx" ON "premiums"("source");

-- CreateIndex
CREATE INDEX "premiums_student_status_idx" ON "premiums"("student", "status");

-- CreateIndex
CREATE INDEX "premiums_end_date_status_idx" ON "premiums"("end_date", "status");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_profile_picture_fkey" FOREIGN KEY ("profile_picture") REFERENCES "images"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_classes" ADD CONSTRAINT "user_classes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_classes" ADD CONSTRAINT "user_classes_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topics" ADD CONSTRAINT "topics_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_lessons" ADD CONSTRAINT "schedule_lessons_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_status_history" ADD CONSTRAINT "task_status_history_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_deadline_history" ADD CONSTRAINT "task_deadline_history_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_product_images" ADD CONSTRAINT "market_product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "market_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_product_images" ADD CONSTRAINT "market_product_images_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_order_status_history" ADD CONSTRAINT "market_order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "market_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_test_id_fkey" FOREIGN KEY ("test_id") REFERENCES "tests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_options" ADD CONSTRAINT "question_options_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_binding_classes" ADD CONSTRAINT "test_binding_classes_binding_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "test_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_binding_classes" ADD CONSTRAINT "test_binding_classes_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_binding_reopen_grants" ADD CONSTRAINT "test_binding_reopen_grants_binding_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "test_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_session_questions" ADD CONSTRAINT "test_session_questions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "test_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_session_question_options" ADD CONSTRAINT "test_session_question_options_question_row_id_fkey" FOREIGN KEY ("question_row_id") REFERENCES "test_session_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_session_answers" ADD CONSTRAINT "test_session_answers_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "test_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_result_extra_points" ADD CONSTRAINT "test_result_extra_points_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "test_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_result_per_questions" ADD CONSTRAINT "test_result_per_questions_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "test_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_delivery_status" ADD CONSTRAINT "message_delivery_status_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_stats_classes" ADD CONSTRAINT "weekly_stats_classes_weekly_stats_id_fkey" FOREIGN KEY ("weekly_stats_id") REFERENCES "weekly_stats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_stats_classes" ADD CONSTRAINT "weekly_stats_classes_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
