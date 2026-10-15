-- DARSGA MAVZU BIRIKTIRISH (ANKOR)
--
-- Mavzu raqami jadval katagiga yozilmaydi: jadval haftalik shablon (sanasiz),
-- mavzu esa sanaga bog'liq. Saqlanadigan narsa — ankor (bitta kundagi bitta
-- darsning mavzusi); qolgani o'sha ankordan sanab chiqariladi.
CREATE TABLE "lesson_topic_bindings" (
    "id" CHAR(24) NOT NULL,
    "class_id" CHAR(24) NOT NULL,
    "subject_id" CHAR(24) NOT NULL,
    "date" DATE NOT NULL,
    "lesson_order" INTEGER NOT NULL,
    "topic_order" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "snapshot" JSONB NOT NULL,
    "active_key" TEXT,
    "created_by" CHAR(24) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lesson_topic_bindings_pkey" PRIMARY KEY ("id")
);

-- Bitta darsga bitta FAOL ankor. Bekor qilinganida `active_key` NULL ga
-- tushadi va PostgreSQL da NULL lar teng emas — tarixdagi qatorlar
-- cheklanmaydi (`lesson_credits.active_key` bilan AYNI yechim).
CREATE UNIQUE INDEX "lesson_topic_bindings_active_key_key" ON "lesson_topic_bindings"("active_key");

CREATE INDEX "lesson_topic_bindings_class_id_subject_id_date_idx" ON "lesson_topic_bindings"("class_id", "subject_id", "date");

CREATE INDEX "lesson_topic_bindings_class_id_date_idx" ON "lesson_topic_bindings"("class_id", "date");
