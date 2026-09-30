-- FANGA BAHO QO'YISH RUXSATI.
--
-- 1) `grading_grants` — boshliq (`gradeGrants.manage`) o'qituvchiga O'ZINIKI
--    BO'LMAGAN sinf + fan darslariga baho qo'yishni ochadi: muddat bilan
--    (davrdagi barcha darslar, `lesson_order` NULL) yoki bitta darsga
--    (`date_from = date_to`, `lesson_order`). O'chirilmaydi — `revoked_at`
--    bilan yopiladi.
-- 2) `grades.grading_grant_id` — shu ruxsat bilan qo'yilgan baho. U dars
--    egasining oyligida darsni "o'tilgan" qilmaydi.
--
-- ⚠️ Mavjud qatorlar o'zgarmaydi: eski baholarda `grading_grant_id` NULL —
-- ular ruxsatdan oldin, faqat o'z darsi / o'rinbosarlik bilan qo'yilgan.

-- AlterTable
ALTER TABLE "grades" ADD COLUMN "grading_grant_id" CHAR(24);

-- CreateTable
CREATE TABLE "grading_grants" (
    "id" CHAR(24) NOT NULL,
    "teacher_id" CHAR(24) NOT NULL,
    "class_id" CHAR(24) NOT NULL,
    "subject_id" CHAR(24) NOT NULL,
    "date_from" DATE NOT NULL,
    "date_to" DATE NOT NULL,
    "lesson_order" INTEGER,
    "reason" TEXT NOT NULL DEFAULT '',
    "snapshot" JSONB NOT NULL,
    "granted_by" CHAR(24) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" CHAR(24),
    "revoke_reason" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grading_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "grading_grants_teacher_id_date_from_date_to_idx" ON "grading_grants"("teacher_id", "date_from", "date_to");

-- CreateIndex
CREATE INDEX "grading_grants_class_id_subject_id_idx" ON "grading_grants"("class_id", "subject_id");

-- CreateIndex
CREATE INDEX "grading_grants_created_at_idx" ON "grading_grants"("created_at");
