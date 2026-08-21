-- CreateEnum
CREATE TYPE "BranchStatus" AS ENUM ('provisioning', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('percent', 'fixed');

-- CreateEnum
CREATE TYPE "ChangelogPanel" AS ENUM ('admin', 'teacher', 'student', 'server', 'bot');

-- CreateEnum
CREATE TYPE "ChangelogBump" AS ENUM ('major', 'minor', 'patch');

-- CreateEnum
CREATE TYPE "ChangelogNotificationKind" AS ENUM ('daily', 'weekly', 'manual');

-- CreateEnum
CREATE TYPE "ChangelogNotificationStatus" AS ENUM ('sent', 'failed');

-- CreateTable
CREATE TABLE "branches" (
    "id" CHAR(24) NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "schema_name" TEXT NOT NULL,
    "short_name" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "status" "BranchStatus" NOT NULL DEFAULT 'provisioning',
    "provision_error" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_directory" (
    "id" CHAR(24) NOT NULL,
    "username" TEXT NOT NULL,
    "branch_id" CHAR(24) NOT NULL,
    "role" TEXT NOT NULL,
    "first_name" TEXT NOT NULL DEFAULT '',
    "last_name" TEXT NOT NULL DEFAULT '',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_directory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_directory" (
    "telegram_id" TEXT NOT NULL,
    "branch_id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_directory_pkey" PRIMARY KEY ("telegram_id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
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
CREATE TABLE "tariffs" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "currency" CHAR(3) NOT NULL DEFAULT 'UZS',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tariffs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tariff_versions" (
    "id" CHAR(24) NOT NULL,
    "tariff_id" CHAR(24) NOT NULL,
    "start_month" INTEGER NOT NULL,
    "end_month" INTEGER,
    "monthly_amount" DECIMAL(14,2) NOT NULL,
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tariff_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discounts" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "type" "DiscountType" NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "is_exclusive" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "changelogs" (
    "id" CHAR(24) NOT NULL,
    "panel" "ChangelogPanel" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 1,
    "version" TEXT NOT NULL,
    "major" INTEGER NOT NULL,
    "minor" INTEGER NOT NULL,
    "patch" INTEGER NOT NULL,
    "bump" "ChangelogBump" NOT NULL DEFAULT 'patch',
    "title" TEXT NOT NULL DEFAULT '',
    "items" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT NOT NULL DEFAULT '',
    "source_file" TEXT,
    "created_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "changelogs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "changelog_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT 'singleton',
    "daily_enabled" BOOLEAN NOT NULL DEFAULT false,
    "send_time" TEXT NOT NULL DEFAULT '09:00',
    "weekly_enabled" BOOLEAN NOT NULL DEFAULT false,
    "recipients" JSONB NOT NULL DEFAULT '[]',
    "last_daily_sent_date" TIMESTAMP(3),
    "last_daily_sent_at" TIMESTAMP(3),
    "last_weekly_sent_at" TIMESTAMP(3),
    "updated_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "changelog_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "changelog_notifications" (
    "id" CHAR(24) NOT NULL,
    "kind" "ChangelogNotificationKind" NOT NULL DEFAULT 'daily',
    "status" "ChangelogNotificationStatus" NOT NULL,
    "coverage_date" TIMESTAMP(3),
    "coverage_from" TIMESTAMP(3),
    "coverage_to" TIMESTAMP(3),
    "chat_id" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "entry_count" INTEGER NOT NULL DEFAULT 0,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "sent_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "changelog_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "branches_code_key" ON "branches"("code");

-- CreateIndex
CREATE UNIQUE INDEX "branches_schema_name_key" ON "branches"("schema_name");

-- CreateIndex
CREATE INDEX "branches_is_archived_is_active_sort_order_idx" ON "branches"("is_archived", "is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "user_directory_username_key" ON "user_directory"("username");

-- CreateIndex
CREATE INDEX "user_directory_branch_id_role_idx" ON "user_directory"("branch_id", "role");

-- CreateIndex
CREATE INDEX "user_directory_branch_id_is_archived_idx" ON "user_directory"("branch_id", "is_archived");

-- CreateIndex
CREATE INDEX "telegram_directory_branch_id_idx" ON "telegram_directory"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "roles_value_key" ON "roles"("value");

-- CreateIndex
CREATE UNIQUE INDEX "tariffs_name_key" ON "tariffs"("name");

-- CreateIndex
CREATE INDEX "tariffs_is_archived_is_active_name_idx" ON "tariffs"("is_archived", "is_active", "name");

-- CreateIndex
CREATE INDEX "tariff_versions_tariff_id_start_month_idx" ON "tariff_versions"("tariff_id", "start_month" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tariff_versions_tariff_id_start_month_key" ON "tariff_versions"("tariff_id", "start_month");

-- CreateIndex
CREATE UNIQUE INDEX "discounts_name_key" ON "discounts"("name");

-- CreateIndex
CREATE INDEX "discounts_is_archived_is_active_name_idx" ON "discounts"("is_archived", "is_active", "name");

-- CreateIndex
CREATE INDEX "changelogs_panel_major_minor_patch_idx" ON "changelogs"("panel", "major" DESC, "minor" DESC, "patch" DESC);

-- CreateIndex
CREATE INDEX "changelogs_date_idx" ON "changelogs"("date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "changelogs_date_panel_seq_key" ON "changelogs"("date", "panel", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "changelogs_panel_version_key" ON "changelogs"("panel", "version");

-- CreateIndex
CREATE INDEX "changelog_notifications_created_at_idx" ON "changelog_notifications"("created_at" DESC);

-- CreateIndex
CREATE INDEX "changelog_notifications_kind_coverage_date_idx" ON "changelog_notifications"("kind", "coverage_date");

-- AddForeignKey
ALTER TABLE "user_directory" ADD CONSTRAINT "user_directory_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_directory" ADD CONSTRAINT "telegram_directory_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tariff_versions" ADD CONSTRAINT "tariff_versions_tariff_id_fkey" FOREIGN KEY ("tariff_id") REFERENCES "tariffs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

