-- TYUTOR GURUHLARI.
--
-- `tutor_groups` — tyutorga biriktirilgan sinf va SHU biriktirish uchun
-- qo'shimcha oylik stavkalari: bitta o'quvchi uchun (`per_student_amount`)
-- va butun guruh uchun (`group_amount`). Davr oy aniqligida
-- (`start_month`/`end_month`).
--
-- Yangi jadval, mavjud birorta qatorga tegilmaydi.

CREATE TABLE IF NOT EXISTS "tutor_groups" (
    "id" CHAR(24) NOT NULL,
    "tutor_id" CHAR(24) NOT NULL,
    "class_id" CHAR(24) NOT NULL,
    "per_student_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "group_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "start_month" INTEGER NOT NULL,
    "end_month" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tutor_groups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "tutor_groups_tutor_id_start_month_idx"
  ON "tutor_groups"("tutor_id", "start_month");
CREATE INDEX IF NOT EXISTS "tutor_groups_class_id_start_month_idx"
  ON "tutor_groups"("class_id", "start_month");

ALTER TABLE "tutor_groups" DROP CONSTRAINT IF EXISTS "tutor_groups_class_id_fkey";
ALTER TABLE "tutor_groups"
  ADD CONSTRAINT "tutor_groups_class_id_fkey"
  FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
