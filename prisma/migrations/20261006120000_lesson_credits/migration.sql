-- "O'TILDI" BELGISI — rahbariyat o'tilmagan darsni o'tilgan deb belgilaydi.
--
-- `lesson_credits` — bitta qator = bitta dars (o'qituvchi + sinf + fan +
-- tartib + kun). Faol belgi oylik soat hisobida darsni "o'tilgan" qiladi va
-- soati (puli) oylikka qaytadi (`lessonCredit.service.js`). O'chirilmaydi —
-- `revoked_at` bilan bekor qilinadi.
--
-- ⚠️ `active_key` — faqat FAOL qatorda to'ldiriladi (bekor qilinganda NULL):
-- yagona indeks bitta darsga ikkita faol belgi tushishiga yo'l qo'ymaydi,
-- tarixdagi bekor qilinganlar esa cheklanmaydi.
-- `attendance_restore` — belgi kun davomatini "keldi" qilgan bo'lsa, avvalgi
-- holat (bekor qilinganda aynan qaytariladi).
--
-- Mavjud jadvallarga tegilmaydi.

-- CreateTable
CREATE TABLE "lesson_credits" (
    "id" CHAR(24) NOT NULL,
    "teacher_id" CHAR(24) NOT NULL,
    "date" DATE NOT NULL,
    "class_id" CHAR(24) NOT NULL,
    "subject_id" CHAR(24) NOT NULL,
    "lesson_order" INTEGER NOT NULL,
    "miss_reason" TEXT NOT NULL,
    "substituted" BOOLEAN NOT NULL DEFAULT false,
    "snapshot" JSONB NOT NULL,
    "active_key" TEXT,
    "batch_id" CHAR(24) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" CHAR(24) NOT NULL,
    "penalty_id" CHAR(24),
    "penalty_points" INTEGER NOT NULL DEFAULT 0,
    "attendance_restore" JSONB,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" CHAR(24),
    "revoke_reason" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lesson_credits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lesson_credits_active_key_key" ON "lesson_credits"("active_key");

-- CreateIndex
CREATE INDEX "lesson_credits_teacher_id_date_idx" ON "lesson_credits"("teacher_id", "date");

-- CreateIndex
CREATE INDEX "lesson_credits_date_idx" ON "lesson_credits"("date");

-- CreateIndex
CREATE INDEX "lesson_credits_batch_id_idx" ON "lesson_credits"("batch_id");

-- CreateIndex
CREATE INDEX "lesson_credits_created_at_idx" ON "lesson_credits"("created_at");

