-- MUAMMONI TOPSHIRIQ BILAN HAL QILISH.
--
-- Botdan kelgan muammoni hal qilish uchun ma'muriyat bir yoki bir nechta
-- xodimga TOPSHIRIQ biriktiradi. Topshiriq tasdiqlanganda muammo ham
-- avtomatik yopiladi va yuborgan odamga botdan javob ketadi
-- (`issueTask.service.js`).
--
-- `tasks.issue_id` — MANBA MUAMMO. Oddiy topshiriqda NULL, ya'ni
-- topshiriqlar bo'limining o'zi o'zgarmadi va mavjud qatorlar tegilmaydi.
--
-- ⚠️ ON DELETE SET NULL — muammo o'chirilsa TOPSHIRIQ QOLADI. Odam
-- allaqachon ish qilyapti va topshiriqda jarima bali ham bo'lishi mumkin:
-- kaskad o'chirish birovning bajarilgan ishini izsiz yo'q qilardi.
--
-- ⚠️ `issues.closed_by_task` — muammoni TOPSHIRIQ yopganini qo'lda
-- yopilganidan farqlaydi. Topshiriq qayta ochilsa muammo ham qayta
-- ochiladi, lekin ma'muriyatning qo'lda qo'ygan "hal qilindi"/"rad etildi"
-- qarorini topshiriq bekor qila olmaydi.
--
-- HAR BIR IJROCHIGA ALOHIDA topshiriq yaratiladi (mavjud
-- `createTasks` qoidasi), shuning uchun bitta muammoda bir nechta
-- topshiriq bo'lishi mumkin — bog'lanish `tasks` tomonida turadi.

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "issue_id" CHAR(24);

-- AlterTable
ALTER TABLE "issues" ADD COLUMN "closed_by_task" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "tasks_issue_id_idx" ON "tasks"("issue_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE SET NULL ON UPDATE CASCADE;
