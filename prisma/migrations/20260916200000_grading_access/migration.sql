-- BAHO QO'YISH HUQUQI: o'tgan kunlar oynasi va "maktabda bo'lish" sharti.
--
-- 1) `grading_unlocks` — boshliq (`grades.unlock`) KUNLAR ORALIG'INI ochadi:
--    hammaga yoki tanlangan o'qituvchilarga, muddat bilan. Ochilgan kunda
--    baho bor dars davomatdan qat'i nazar o'tilgan hisoblanadi.
--    O'chirilmaydi — `revoked_at` bilan yopiladi.
-- 2) `attendance_settings.grading_requires_presence` — bugungi darsga baho
--    faqat kelgan va hali ketmagan o'qituvchiga (sukut: yoqilgan).

-- CreateEnum
CREATE TYPE "GradingUnlockScope" AS ENUM ('all', 'selected');

-- AlterTable
ALTER TABLE "attendance_settings" ADD COLUMN     "grading_requires_presence" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "grading_unlocks" (
    "id" CHAR(24) NOT NULL,
    "date_from" DATE NOT NULL,
    "date_to" DATE NOT NULL,
    "scope" "GradingUnlockScope" NOT NULL,
    "teacher_ids" TEXT[],
    "reason" TEXT NOT NULL DEFAULT '',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "granted_by" CHAR(24) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grading_unlocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "grading_unlocks_date_from_date_to_idx" ON "grading_unlocks"("date_from", "date_to");

-- CreateIndex
CREATE INDEX "grading_unlocks_expires_at_idx" ON "grading_unlocks"("expires_at");
