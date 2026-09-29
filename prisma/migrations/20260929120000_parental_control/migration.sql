-- OTA-ONA NAZORATI — PIN, bloklash qoidalari, foydalanish statistikasi,
-- hodisalar va bolaning "ruxsat bering" so'rovlari.
--
-- ⚠️ Mavjud birorta qator o'zgarmaydi: 6 ta yangi jadval, 2 ta yangi enum
-- va `ActivityChannel` ga bitta qiymat (`parent` — ota-ona mobil ilovasi).
--
-- ⚠️ Maktabning "Qurilma nazorati" (`device_*` jadvallari) bilan
-- ARALASHMAYDI — u yerda qoidani maktab yozadi, bu yerda ota-ona.
--
-- ⚠️ `ADD VALUE IF NOT EXISTS`: yangi qiymat shu migratsiyada ISHLATILMAYDI
-- (PostgreSQL bir tranzaksiya ichida qo'shilgan enum qiymatini ishlatishga
-- ruxsat bermaydi).

-- CreateEnum
-- CreateEnum
CREATE TYPE "ParentalPlatform" AS ENUM ('android', 'ios');

-- CreateEnum
CREATE TYPE "ParentalRequestStatus" AS ENUM ('pending', 'approved', 'denied', 'expired');

-- AlterEnum
ALTER TYPE "ActivityChannel" ADD VALUE IF NOT EXISTS 'parent';

-- CreateTable
CREATE TABLE "parental_settings" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "pin_hash" VARCHAR(64),
    "pin_salt" VARCHAR(32),
    "pin_iterations" INTEGER NOT NULL DEFAULT 100000,
    "pin_updated_at" TIMESTAMP(3),
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "lock_all" BOOLEAN NOT NULL DEFAULT false,
    "lock_all_until" TIMESTAMP(3),
    "unlock_minutes" INTEGER NOT NULL DEFAULT 30,
    "policy_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parental_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parental_devices" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "device_id" VARCHAR(64) NOT NULL,
    "platform" "ParentalPlatform" NOT NULL,
    "model" VARCHAR(120),
    "os_version" VARCHAR(40),
    "app_version" VARCHAR(40),
    "health" JSONB NOT NULL DEFAULT '{}',
    "protected" BOOLEAN NOT NULL DEFAULT false,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "offline_alert_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parental_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parental_apps" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "platform" "ParentalPlatform" NOT NULL,
    "app_key" VARCHAR(2048) NOT NULL,
    "app_key_hash" CHAR(64) NOT NULL,
    "app_name" VARCHAR(200),
    "icon_url" VARCHAR(500),
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "daily_limit_min" INTEGER,
    "installed" BOOLEAN NOT NULL DEFAULT true,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parental_apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_usage_daily" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "device_id" VARCHAR(64) NOT NULL,
    "date" DATE NOT NULL,
    "app_key_hash" CHAR(64) NOT NULL,
    "minutes" INTEGER NOT NULL DEFAULT 0,
    "min_minutes" BOOLEAN NOT NULL DEFAULT false,
    "open_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_usage_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parental_events" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "device_id" VARCHAR(64),
    "type" VARCHAR(40) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "alerted" BOOLEAN NOT NULL DEFAULT false,
    "client_event_id" VARCHAR(64),
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parental_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parental_unlock_requests" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "device_id" VARCHAR(64) NOT NULL,
    "app_key_hash" CHAR(64),
    "minutes" INTEGER NOT NULL,
    "status" "ParentalRequestStatus" NOT NULL DEFAULT 'pending',
    "decided_at" TIMESTAMP(3),
    "approved_minutes" INTEGER,
    "unlock_until" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parental_unlock_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "parental_settings_student_id_key" ON "parental_settings"("student_id");

-- CreateIndex
CREATE INDEX "parental_settings_lock_all_lock_all_until_idx" ON "parental_settings"("lock_all", "lock_all_until");

-- CreateIndex
CREATE INDEX "parental_devices_last_seen_at_idx" ON "parental_devices"("last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "parental_devices_student_id_device_id_key" ON "parental_devices"("student_id", "device_id");

-- CreateIndex
CREATE UNIQUE INDEX "parental_apps_student_id_app_key_hash_key" ON "parental_apps"("student_id", "app_key_hash");

-- CreateIndex
CREATE INDEX "app_usage_daily_student_id_date_idx" ON "app_usage_daily"("student_id", "date");

-- CreateIndex
CREATE INDEX "app_usage_daily_date_idx" ON "app_usage_daily"("date");

-- CreateIndex
CREATE UNIQUE INDEX "app_usage_daily_student_id_device_id_date_app_key_hash_key" ON "app_usage_daily"("student_id", "device_id", "date", "app_key_hash");

-- CreateIndex
CREATE INDEX "parental_events_student_id_occurred_at_idx" ON "parental_events"("student_id", "occurred_at");

-- CreateIndex
CREATE INDEX "parental_events_student_id_type_created_at_idx" ON "parental_events"("student_id", "type", "created_at");

-- CreateIndex
CREATE INDEX "parental_events_created_at_idx" ON "parental_events"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "parental_events_student_id_client_event_id_key" ON "parental_events"("student_id", "client_event_id");

-- CreateIndex
CREATE INDEX "parental_unlock_requests_student_id_status_idx" ON "parental_unlock_requests"("student_id", "status");

-- CreateIndex
CREATE INDEX "parental_unlock_requests_student_id_created_at_idx" ON "parental_unlock_requests"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "parental_unlock_requests_status_expires_at_idx" ON "parental_unlock_requests"("status", "expires_at");

-- AddForeignKey
ALTER TABLE "parental_settings" ADD CONSTRAINT "parental_settings_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

