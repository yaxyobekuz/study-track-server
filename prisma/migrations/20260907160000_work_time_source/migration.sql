-- ISH VAQTI MANBAI: qo'lda kiritilgan vaqt yoki dars jadvalidan hisoblangan oyna.
-- Standart qiymat `manual` — mavjud xodimlarning davomati o'zgarmaydi.

CREATE TYPE "WorkTimeSource" AS ENUM ('manual', 'schedule');

ALTER TABLE "users"
  ADD COLUMN "work_time_source" "WorkTimeSource" NOT NULL DEFAULT 'manual';
