-- BIR KUNDA BIR NECHTA TAKRORLANISH.
--
-- Ilgari qoidada bitta vaqt bor edi (`start_time`/`due_time`/
-- `due_offset_days`) va bazadagi yagonalik kaliti "bitta qoida + bitta
-- odam + bitta KUN" edi — ya'ni "har kuni 09:00 DA va 15:00 DA" degan
-- qoidani umuman ifodalab bo'lmasdi.
--
-- Endi qoidada VAQT OYNALARI massivi bor:
--   [{ "start": "08:10"|null, "due": "09:00", "offsetDays": 0 }, ...]
-- va har bir topshiriq o'zi qaysi oyna uchun yozilganini saqlaydi
-- (`tasks.occurrence_slot` — o'sha oynaning tugash vaqti).
--
-- ⚠️ YAGONALIK KALITI SHUNGA QARAB KENGAYTIRILADI. Avval mavjud qatorlar
-- to'ldiriladi, KEYIN eski indeks almashtiriladi: aks holda `occurrence_slot`
-- NULL bo'lgan qatorlar PostgreSQL'da bir-biriga TENG EMAS deb qaraladi va
-- kunlik pass allaqachon yozilgan topshiriqni qayta yozib ketardi.

-- 1) Yangi ustunlar
ALTER TABLE "task_schedules" ADD COLUMN "slots" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "tasks" ADD COLUMN "occurrence_slot" VARCHAR(5);

-- 2) Mavjud qoidalarni bitta oynaga ko'chiramiz
UPDATE "task_schedules"
SET "slots" = jsonb_build_array(
  jsonb_build_object(
    'start', CASE WHEN "start_time" IS NULL THEN NULL ELSE to_jsonb("start_time") END,
    'due', to_jsonb("due_time"),
    'offsetDays', to_jsonb("due_offset_days")
  )
)
WHERE jsonb_array_length("slots") = 0;

-- 3) Yaratilgan topshiriqlarga o'z oynasini yozamiz (indeksdan OLDIN)
UPDATE "tasks" t
SET "occurrence_slot" = s."due_time"
FROM "task_schedules" s
WHERE t."schedule_id" = s."id" AND t."occurrence_slot" IS NULL;

-- 4) Yagonalik kalitini almashtiramiz
DROP INDEX IF EXISTS "tasks_schedule_id_assignee_occurrence_date_key";
CREATE UNIQUE INDEX "tasks_schedule_id_assignee_occurrence_date_occurrence_slot_key"
  ON "tasks"("schedule_id", "assignee", "occurrence_date", "occurrence_slot");

-- 5) Eski ustunlar endi keraksiz
ALTER TABLE "task_schedules" DROP COLUMN "start_time";
ALTER TABLE "task_schedules" DROP COLUMN "due_time";
ALTER TABLE "task_schedules" DROP COLUMN "due_offset_days";
