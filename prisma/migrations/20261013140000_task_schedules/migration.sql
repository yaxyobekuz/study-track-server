-- DOIMIY (TAKRORLANUVCHI) TOPSHIRIQLAR.
--
-- `task_schedules` — QOIDA: "har dushanba 08:10 da", "har 10 kunda bir",
-- "3 oyda bir, oyning 1-kuni". Qoidaning o'zi topshiriq EMAS: cron undan
-- haqiqiy topshiriqlarni VAQTIDAN OLDIN yaratadi (`lead_days`, sukut 1
-- kun) va shu yaratilishning o'zi xodim uchun eslatma bo'ladi.
--
-- `tasks.schedule_id` + `tasks.occurrence_date` — topshiriq qaysi qoidadan
-- va qaysi kun uchun yaratilgani.
--
-- ⚠️ `(schedule_id, assignee, occurrence_date)` YAGONA: cron ikki marta
-- ishga tushsa ham (startup + kunlik) bitta kunga ikkita topshiriq
-- yozilmaydi. PostgreSQL'da NULL lar bir-biriga teng emas, shuning uchun
-- qo'lda berilgan bir martalik topshiriqlar (uchala ustun ham NULL) bu
-- indeksga umuman tushmaydi.
--
-- ⚠️ ON DELETE SET NULL — qoida o'chirilsa YARATILGAN TOPSHIRIQLAR QOLADI:
-- odam allaqachon ish qilgan, natijasi va jarimasi bor. Qoidani o'chirish
-- faqat kelajakka ta'sir qiladi (`tasks.issue_id` bilan AYNI qaror).

-- CreateTable
CREATE TABLE "task_schedules" (
    "id" CHAR(24) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "assignees" CHAR(24)[],
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "links" JSONB NOT NULL DEFAULT '[]',
    "penalty_points" INTEGER NOT NULL DEFAULT 1,
    "frequency" VARCHAR(16) NOT NULL,
    "weekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "month_days" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "interval_days" INTEGER,
    "interval_months" INTEGER,
    "start_time" VARCHAR(5),
    "due_time" VARCHAR(5) NOT NULL,
    "due_offset_days" INTEGER NOT NULL DEFAULT 0,
    "lead_days" INTEGER NOT NULL DEFAULT 1,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_run_date" DATE,
    "created_by" CHAR(24) NOT NULL,
    "stopped_by" CHAR(24),
    "stop_reason" TEXT,
    "stopped_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_schedules_is_active_start_date_idx" ON "task_schedules"("is_active", "start_date");
CREATE INDEX "task_schedules_created_by_created_at_idx" ON "task_schedules"("created_by", "created_at" DESC);

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "schedule_id" CHAR(24);
ALTER TABLE "tasks" ADD COLUMN "occurrence_date" DATE;

-- CreateIndex
CREATE UNIQUE INDEX "tasks_schedule_id_assignee_occurrence_date_key" ON "tasks"("schedule_id", "assignee", "occurrence_date");
CREATE INDEX "tasks_schedule_id_idx" ON "tasks"("schedule_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "task_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
