-- QURILMA NAZORATI — O'QUVCHI TELEFONI.
--
-- Faqat QO'SHADI: mavjud jadvallardan hech narsa o'chirilmaydi va
-- o'zgartirilmaydi. To'liq qoidalar — `.claude/rules/devices.md`.
--
--  1) `device_apps`               — ilovalar katalogi (bitta ilova, ikkala
--                                   identifikator: android paketi + iOS bundle).
--  2) `device_policies`           — siyosat (oq/qora ro'yxat, kunlik limit).
--  3) `device_policy_apps`        — siyosatdagi ilova qoidasi (rejim + daqiqa).
--  4) `device_policy_windows`     — vaqt oynalari (hafta kuni + daqiqa oralig'i).
--  5) `device_policy_assignments` — kimga (maktab / sinf / o'quvchi).
--  6) `student_devices`           — biriktirilgan qurilma va uning holati.
--  7) `device_enrollment_codes`   — bir martalik biriktirish kodi.
--  8) `device_usage_days`         — KUNLIK YIG'MA foydalanish.
--  9) `device_unlocks`            — vaqtinchalik ochish.
-- 10) `device_audits`             — kim nima qildi.
-- 11) `device_settings`           — filial singletoni (sukut: `enabled=false`).
--
-- ⚠️ `device_policy_assignments.target_key` YAGONA ("school" | "class:<id>" |
--    "student:<id>"). PostgreSQL da NULL lar teng emas, ya'ni
--    `(scope, class_id, student_id)` yagona indeksi maktab qamrovida takrorni
--    TO'SMASDI — ikkita "hammaga" biriktirish yozilib qolardi.
--
-- ⚠️ `device_usage_days` da `(device_id, day, app_key)` YAGONA: qurilma
--    tarmoq uzilganda kun yakunini qayta yuboradi va u USTIGA yozilishi kerak.
--
-- ⚠️ `device_settings.enabled` sukut bo'yicha FALSE — migratsiya birorta
--    o'quvchining telefonini cheklamaydi. Modul admin paneldan ongli
--    ravishda yoqiladi.
--
-- ⚠️ Bu migratsiya sxemadagi AVVALGI farqlarni (oylik v2 ustunlari,
--    `schedule_revisions`, indeks nomlari) ATAYLAB o'z ichiga OLMAYDI:
--    ular boshqa ishning qarzi va ularni bu yerga qo'shish qurilma
--    modulini deploy qilishni ma'lumot yo'qotish xavfiga bog'lab qo'yardi.

-- CreateEnum
CREATE TYPE "DeviceAppMode" AS ENUM ('always', 'allowed', 'limited', 'blocked');

-- CreateEnum
CREATE TYPE "DevicePolicyDefaultMode" AS ENUM ('block', 'allow');

-- CreateEnum
CREATE TYPE "DeviceOfflinePolicy" AS ENUM ('keepLast', 'lockDown');

-- CreateEnum
CREATE TYPE "DevicePolicyScope" AS ENUM ('student', 'class', 'school');

-- CreateEnum
CREATE TYPE "StudentDeviceStatus" AS ENUM ('active', 'paused', 'removed');

-- CreateEnum
CREATE TYPE "DeviceUnlockKind" AS ENUM ('full', 'app');

-- CreateEnum
CREATE TYPE "DeviceUnlockStatus" AS ENUM ('active', 'cancelled', 'expired');

-- CreateTable
CREATE TABLE "device_apps" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'boshqa',
    "android_package" TEXT,
    "ios_bundle_id" TEXT,
    "is_essential" BOOLEAN NOT NULL DEFAULT false,
    "is_discovered" BOOLEAN NOT NULL DEFAULT false,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_policies" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "color" TEXT,
    "default_mode" "DevicePolicyDefaultMode" NOT NULL DEFAULT 'block',
    "daily_limit_minutes" INTEGER,
    "offline_policy" "DeviceOfflinePolicy" NOT NULL DEFAULT 'keepLast',
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_policy_apps" (
    "id" CHAR(24) NOT NULL,
    "policy_id" CHAR(24) NOT NULL,
    "app_id" CHAR(24) NOT NULL,
    "mode" "DeviceAppMode" NOT NULL DEFAULT 'allowed',
    "daily_minutes" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_policy_apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_policy_windows" (
    "id" CHAR(24) NOT NULL,
    "policy_id" CHAR(24) NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_policy_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_policy_assignments" (
    "id" CHAR(24) NOT NULL,
    "policy_id" CHAR(24) NOT NULL,
    "scope" "DevicePolicyScope" NOT NULL,
    "class_id" CHAR(24),
    "student_id" CHAR(24),
    "target_key" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT NOT NULL DEFAULT '',
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_policy_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_devices" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "device_uid" VARCHAR(64) NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "platform" VARCHAR(16) NOT NULL DEFAULT 'android',
    "manufacturer" VARCHAR(64),
    "model" VARCHAR(64),
    "os_version" VARCHAR(32),
    "app_version" VARCHAR(32),
    "status" "StudentDeviceStatus" NOT NULL DEFAULT 'active',
    "enforcing" BOOLEAN NOT NULL DEFAULT false,
    "enforcement_note" TEXT NOT NULL DEFAULT '',
    "last_seen_at" TIMESTAMP(3),
    "last_sync_at" TIMESTAMP(3),
    "applied_policy_version" INTEGER,
    "battery_level" INTEGER,
    "enrolled_by" CHAR(24),
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),
    "removed_by" CHAR(24),
    "remove_reason" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_enrollment_codes" (
    "id" CHAR(24) NOT NULL,
    "code" VARCHAR(12) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "used_by" CHAR(24),
    "revoked_at" TIMESTAMP(3),
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_enrollment_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_usage_days" (
    "id" CHAR(24) NOT NULL,
    "device_id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "day" DATE NOT NULL,
    "app_key" VARCHAR(180) NOT NULL,
    "app_id" CHAR(24),
    "minutes" INTEGER NOT NULL DEFAULT 0,
    "opens" INTEGER NOT NULL DEFAULT 0,
    "blocked" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_usage_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_unlocks" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "device_id" CHAR(24),
    "kind" "DeviceUnlockKind" NOT NULL DEFAULT 'full',
    "app_id" CHAR(24),
    "extra_minutes" INTEGER,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "status" "DeviceUnlockStatus" NOT NULL DEFAULT 'active',
    "cancel_reason" TEXT NOT NULL DEFAULT '',
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by" CHAR(24),
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_unlocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_audits" (
    "id" CHAR(24) NOT NULL,
    "action" VARCHAR(40) NOT NULL,
    "student_id" CHAR(24),
    "device_id" CHAR(24),
    "policy_id" CHAR(24),
    "summary" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT '',
    "meta" JSONB,
    "actor_id" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enrollment_code_ttl_minutes" INTEGER NOT NULL DEFAULT 15,
    "offline_grace_minutes" INTEGER NOT NULL DEFAULT 120,
    "offline_policy" "DeviceOfflinePolicy" NOT NULL DEFAULT 'keepLast',
    "usage_retention_days" INTEGER NOT NULL DEFAULT 180,
    "sync_interval_minutes" INTEGER NOT NULL DEFAULT 30,
    "updated_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_apps_is_archived_category_name_idx" ON "device_apps"("is_archived", "category", "name");

-- CreateIndex
CREATE INDEX "device_apps_is_discovered_idx" ON "device_apps"("is_discovered");

-- CreateIndex
CREATE UNIQUE INDEX "device_apps_android_package_key" ON "device_apps"("android_package");

-- CreateIndex
CREATE UNIQUE INDEX "device_apps_ios_bundle_id_key" ON "device_apps"("ios_bundle_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_policies_name_key" ON "device_policies"("name");

-- CreateIndex
CREATE INDEX "device_policies_is_archived_name_idx" ON "device_policies"("is_archived", "name");

-- CreateIndex
CREATE INDEX "device_policy_apps_app_id_idx" ON "device_policy_apps"("app_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_policy_apps_policy_id_app_id_key" ON "device_policy_apps"("policy_id", "app_id");

-- CreateIndex
CREATE INDEX "device_policy_windows_policy_id_weekday_idx" ON "device_policy_windows"("policy_id", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "device_policy_assignments_target_key_key" ON "device_policy_assignments"("target_key");

-- CreateIndex
CREATE INDEX "device_policy_assignments_scope_is_active_idx" ON "device_policy_assignments"("scope", "is_active");

-- CreateIndex
CREATE INDEX "device_policy_assignments_class_id_idx" ON "device_policy_assignments"("class_id");

-- CreateIndex
CREATE INDEX "device_policy_assignments_student_id_idx" ON "device_policy_assignments"("student_id");

-- CreateIndex
CREATE INDEX "device_policy_assignments_policy_id_idx" ON "device_policy_assignments"("policy_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_devices_device_uid_key" ON "student_devices"("device_uid");

-- CreateIndex
CREATE INDEX "student_devices_student_id_status_idx" ON "student_devices"("student_id", "status");

-- CreateIndex
CREATE INDEX "student_devices_status_last_seen_at_idx" ON "student_devices"("status", "last_seen_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "device_enrollment_codes_code_key" ON "device_enrollment_codes"("code");

-- CreateIndex
CREATE INDEX "device_enrollment_codes_student_id_created_at_idx" ON "device_enrollment_codes"("student_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "device_enrollment_codes_expires_at_idx" ON "device_enrollment_codes"("expires_at");

-- CreateIndex
CREATE INDEX "device_usage_days_student_id_day_idx" ON "device_usage_days"("student_id", "day");

-- CreateIndex
CREATE INDEX "device_usage_days_day_idx" ON "device_usage_days"("day");

-- CreateIndex
CREATE UNIQUE INDEX "device_usage_days_device_id_day_app_key_key" ON "device_usage_days"("device_id", "day", "app_key");

-- CreateIndex
CREATE INDEX "device_unlocks_student_id_status_ends_at_idx" ON "device_unlocks"("student_id", "status", "ends_at");

-- CreateIndex
CREATE INDEX "device_unlocks_status_ends_at_idx" ON "device_unlocks"("status", "ends_at");

-- CreateIndex
CREATE INDEX "device_audits_created_at_idx" ON "device_audits"("created_at" DESC);

-- CreateIndex
CREATE INDEX "device_audits_student_id_created_at_idx" ON "device_audits"("student_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "device_audits_action_created_at_idx" ON "device_audits"("action", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "device_policy_apps" ADD CONSTRAINT "device_policy_apps_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "device_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_policy_apps" ADD CONSTRAINT "device_policy_apps_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "device_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_policy_windows" ADD CONSTRAINT "device_policy_windows_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "device_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_policy_assignments" ADD CONSTRAINT "device_policy_assignments_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "device_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_usage_days" ADD CONSTRAINT "device_usage_days_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "student_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_unlocks" ADD CONSTRAINT "device_unlocks_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "student_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_unlocks" ADD CONSTRAINT "device_unlocks_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "device_apps"("id") ON DELETE SET NULL ON UPDATE CASCADE;
