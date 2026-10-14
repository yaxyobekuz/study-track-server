-- XODIM O'ZIGA O'ZI BELGILAGAN TOPSHIRIQ ("o'zim belgilagan topshiriq").
--
-- Lavozimlar markazining AYNI dvigateli: bitta jadval, bitta vaqt holati,
-- bitta yakunlash qoidasi va bitta hisobot dvigateli. Farqi UCHTA va
-- hammasi biznes qarori:
--
--   1. JARIMA YO'Q      — `penalty_points` 0 bo'lib yoziladi, soatlik jarima
--                          cron'i bu qatorlarni umuman ko'rmaydi, to'xtatish
--                          va muddat surishda ham jarima yozilmaydi.
--   2. IKKINCHI TOMON YO'Q — "Tekshiruvda" bosqichi yo'q: xodim topshirgani
--                          darhol "Yakunlangan" bo'ladi. Rahbar statistikani
--                          ko'radi, lekin tasdiqlash navbatiga olmaydi.
--   3. FAQAT O'ZIGA     — ijrochi har doim yaratuvchining O'ZI.
--
-- ⚠️ NEGA ALOHIDA JADVAL EMAS: alohida bo'lsa vaqt holati, yakunlash
-- qoidalari, fayl yuklash va hisobot dvigateli IKKI NUSXADA bo'lardi va
-- biri ikkinchisidan asta-sekin uzoqlashardi (`finance.md` — "formula
-- bitta joyda" doktrinasi).
--
-- ⚠️ NEGA HAR SO'ROVDA FILTR: ikki oqim bir jadvalda yashaydi, lekin
-- HECH QAYERDA ARALASHMAYDI. Aralashsa, jarimasiz va o'zi yopiladigan
-- shaxsiy topshiriqlar rahbar bergan ishning bajarilish foizini jimgina
-- ko'tarib yuborardi — shuning uchun mavjud ro'yxat, sanoqchi, hisobot va
-- "Men ketdim" darvozasi `self_assigned = false` ni ANIQ so'raydi.

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "self_assigned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "task_schedules" ADD COLUMN "self_assigned" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "tasks_self_assigned_created_at_idx" ON "tasks"("self_assigned", "created_at" DESC);
CREATE INDEX "task_schedules_self_assigned_created_at_idx" ON "task_schedules"("self_assigned", "created_at" DESC);
