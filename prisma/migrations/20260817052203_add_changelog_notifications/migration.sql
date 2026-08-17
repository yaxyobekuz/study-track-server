-- CreateEnum
CREATE TYPE "ChangelogNotificationKind" AS ENUM ('daily', 'weekly', 'manual');

-- CreateEnum
CREATE TYPE "ChangelogNotificationStatus" AS ENUM ('sent', 'failed');

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
CREATE INDEX "changelog_notifications_created_at_idx" ON "changelog_notifications"("created_at" DESC);

-- CreateIndex
CREATE INDEX "changelog_notifications_kind_coverage_date_idx" ON "changelog_notifications"("kind", "coverage_date");
