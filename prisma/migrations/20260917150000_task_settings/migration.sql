-- TOPSHIRIQ SOZLAMALARI.
--
-- `task_settings` — filial singletoni: yaratish va yakunlash qoidalari
-- (minimal matn uzunligi, majburiy fayllar, jarima chegarasi va h.k.).
-- ⚠️ `min_completion_files` default 1: ijrochi kamida bitta fayl yuklamasdan
-- topshiriqni yakunlay olmaydi.

-- CreateTable
CREATE TABLE "task_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT 'singleton',
    "min_title_length" INTEGER NOT NULL DEFAULT 3,
    "min_description_length" INTEGER NOT NULL DEFAULT 10,
    "require_create_attachments" BOOLEAN NOT NULL DEFAULT false,
    "min_lead_hours" INTEGER NOT NULL DEFAULT 1,
    "default_penalty_points" INTEGER NOT NULL DEFAULT 1,
    "max_penalty_points" INTEGER NOT NULL DEFAULT 10,
    "min_completion_files" INTEGER NOT NULL DEFAULT 1,
    "max_completion_files" INTEGER NOT NULL DEFAULT 5,
    "require_completion_note" BOOLEAN NOT NULL DEFAULT false,
    "min_completion_note_length" INTEGER NOT NULL DEFAULT 0,
    "completion_file_types" TEXT[] DEFAULT ARRAY['image', 'video', 'document']::TEXT[],
    "allow_late_submission" BOOLEAN NOT NULL DEFAULT true,
    "require_approve_reason" BOOLEAN NOT NULL DEFAULT false,
    "auto_penalty_enabled" BOOLEAN NOT NULL DEFAULT true,
    "due_soon_hours" INTEGER NOT NULL DEFAULT 24,
    "updated_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_settings_pkey" PRIMARY KEY ("id")
);

-- TARIX YOZUVI TURI.
--
-- `kind` — "status" | "edit" | "deadline" | "penalty". Ilgari tahrir va
-- avtomatik jarima ham status yozuvi sifatida saqlanib, vaqt chizig'ida
-- "status o'zgardi" bo'lib ko'rinardi. `meta` — tahrirda o'zgargan maydonlar.

-- AlterTable
ALTER TABLE "task_status_history" ADD COLUMN     "kind" VARCHAR(16) NOT NULL DEFAULT 'status',
ADD COLUMN     "meta" JSONB;
