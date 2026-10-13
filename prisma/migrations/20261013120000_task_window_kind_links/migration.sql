-- LAVOZIMLAR MARKAZI — topshiriqqa VAQT ORALIG'I, TUR va HAVOLALAR.
--
-- `tasks.start_date` — oraliqning boshi. NULL bo'lsa topshiriq avvalgidek
-- "shu vaqtgacha bajaring" (faqat muddat) bo'lib qoladi, ya'ni mavjud
-- qatorlar va mavjud oqim o'zgarmaydi.
--
-- ⚠️ HAQIQIY MUDDAT BARIBIR `due_date` DA: jarima cron'i, hisobot, "Men
-- ketdim" darvozasi va FIFO faqat unga qaraydi. `start_date` — KO'RSATMA
-- (qachondan boshlash), ikkinchi muddat EMAS: aks holda "qaysi vaqt haqiqiy
-- muddat" degan savol ikki xil javob olardi.
--
-- `tasks.kind` — "main" (asosiy, lavozim bo'yicha doimiy ish) yoki "extra"
-- (qo'shimcha). ⚠️ Prisma enum EMAS, matn: enum har filial schema'sida
-- o'ziniki bo'lardi va yangi tur qo'shish har bir schema'ga migratsiya
-- talab qilardi (`task_status_history.kind` bilan AYNI qaror).
--
-- `tasks.links` — [{ url, label }]. Fayl yuklash bilan bir qatorda tashqi
-- manbaga ishora; faqat http(s), service tekshiradi.

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "start_date" TIMESTAMP(3);
ALTER TABLE "tasks" ADD COLUMN "kind" VARCHAR(16) NOT NULL DEFAULT 'main';
ALTER TABLE "tasks" ADD COLUMN "links" JSONB NOT NULL DEFAULT '[]';

-- CreateIndex
-- Ijrochining vaqt oynasi bo'yicha ro'yxati ("bugun nima qilaman")
CREATE INDEX "tasks_assignee_due_date_idx" ON "tasks"("assignee", "due_date");
